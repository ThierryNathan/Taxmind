// Recebe os webhooks do Pluggy e encaminha as transacoes novas para o n8n.
//
// Requisito do Pluggy: responder 2XX em menos de 5s. Por isso o handler faz
// so o minimo sincrono (validar o segredo e ler o corpo) e devolve 200
// imediatamente; buscar contas, paginar transacoes e chamar o n8n roda depois
// da resposta, dentro de EdgeRuntime.waitUntil.
//
// Sobre o destino no n8n: usa N8N_OPENFINANCE_WEBHOOK_URL, nao o
// N8N_TEXT_WEBHOOK_URL. Ver README desta pasta para o porque.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { plainJson } from "../_shared/http.ts";
import { supabaseAdmin } from "../_shared/onboarding_session.ts";
import {
  fetchAccount,
  fetchAccounts,
  fetchItem,
  fetchTransactions,
  fetchTransactionsByIds,
  type PluggyAccount,
  type PluggyTransaction,
} from "../_shared/pluggy_api.ts";
import { timingSafeEqual } from "../_shared/bootstrap_token.ts";

type PluggyWebhookPayload = {
  event?: string;
  eventId?: string;
  itemId?: string;
  error?: { code?: string; message?: string };
  triggeredBy?: string | null;
  // Campos dos eventos transactions/*: eles sao por conta, nao por item.
  accountId?: string;
  transactionsCreatedAtFrom?: string;
  transactionIds?: string[];
  createdTransactionsLink?: string;
};

// EdgeRuntime e injetado pelo runtime do Supabase e nao existe no lib padrao
// do Deno. Sem waitUntil, o processamento pos-resposta seria morto junto com
// a requisicao.
declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const JANELA_INICIAL_DIAS = 30;

serve(async (request) => {
  if (request.method !== "POST") {
    return plainJson({ error: "method_not_allowed" }, 405);
  }

  if (!isAuthorizedCaller(request)) {
    return plainJson({ error: "unauthorized" }, 401);
  }

  let payload: PluggyWebhookPayload;
  try {
    payload = await request.json() as PluggyWebhookPayload;
  } catch {
    return plainJson({ error: "invalid_json" }, 400);
  }

  const event = payload?.event ?? "";
  const itemId = payload?.itemId ?? "";

  if (!itemId) {
    // 200 de proposito: sem itemId nao ha o que fazer, e devolver erro so faria
    // o Pluggy reenviar um evento que nunca vai dar certo.
    console.warn("webhook do pluggy sem itemId", { event });
    return plainJson({ ok: true, ignored: "missing_item_id" });
  }

  runInBackground(handleEvent(event, itemId, payload));

  return plainJson({ ok: true, event, item_id: itemId });
});

function runInBackground(work: Promise<unknown>) {
  const guarded = work.catch((error) => {
    console.error("processamento assincrono do webhook falhou", error);
  });

  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(guarded);
    return;
  }

  // Fallback para execucao local (deno run / edge-runtime sem waitUntil): a
  // promise fica solta mesmo, ja com catch anexado.
  void guarded;
}

// O Pluggy permite configurar headers customizados no cadastro do webhook
// (campo `headers` de CreateWebhook), entao da para exigir um segredo proprio.
// Quando PLUGGY_WEBHOOK_SECRET nao esta configurado, a chamada passa com aviso:
// um evento forjado no maximo dispara uma re-sincronizacao das transacoes do
// proprio dono do item — todo dado gravado vem de uma consulta autenticada
// nossa a API do Pluggy, nunca do corpo do webhook.
function isAuthorizedCaller(request: Request) {
  const expected = env("PLUGGY_WEBHOOK_SECRET");
  if (!expected) {
    console.warn("PLUGGY_WEBHOOK_SECRET nao configurado; aceitando webhook sem validacao de segredo");
    return true;
  }

  const received = request.headers.get("x-taxmind-webhook-secret") ?? "";
  return timingSafeEqual(received, expected);
}

async function handleEvent(event: string, itemId: string, payload: PluggyWebhookPayload) {
  switch (event) {
    case "item/created":
      // O vinculo normal ja foi gravado pela pluggy-item-link no onSuccess do
      // widget. Aqui so garantimos o backfill de quem fechou o navegador antes.
      await resolveUsuarioIdDoItem(itemId);
      return;

    case "item/updated":
      await sincronizarTransacoes(itemId);
      return;

    case "item/error":
      await registrarErroDoItem(itemId, payload.error ?? {});
      return;

    case "transactions/created":
      await sincronizarTransacoesCriadas(itemId, payload);
      return;

    case "transactions/updated":
      await sincronizarTransacoesAtualizadas(itemId, payload);
      return;

    case "transactions/deleted":
      // Exclusao nao esta implementada: nao ha caminho de delete em
      // recibos_evidencias e apagar evidencia fiscal e operacao com trilha de
      // auditoria propria, nao efeito colateral de webhook. Registrado como
      // limitacao conhecida no README de n8n/workflows.
      console.warn("transactions/deleted recebido; exclusao nao implementada", {
        itemId,
        account_id: payload.accountId ?? null,
        total: payload.transactionIds?.length ?? 0,
      });
      return;

    default:
      console.log("evento do pluggy ignorado", { event, itemId });
  }
}

/**
 * transactions/created: o Pluggy avisa que chegaram transacoes novas numa conta
 * especifica, com `transactionsCreatedAtFrom` e um `createdTransactionsLink`
 * pronto.
 *
 * Por que nao usar o `createdTransactionsLink` direto: ele aponta para a
 * colecao `/transactions`, que foi desativada e responde 410
 * ENDPOINT_DEPRECATED. Remontar a consulta em /v2/transactions com o mesmo
 * `accountId` + `createdAtFrom` da o mesmo resultado, reaproveita a paginacao
 * ja escrita e nao segue URL vinda de fora com a X-API-KEY no header.
 */
async function sincronizarTransacoesCriadas(itemId: string, payload: PluggyWebhookPayload) {
  const desde = payload.transactionsCreatedAtFrom;
  if (!desde) {
    console.warn("transactions/created sem transactionsCreatedAtFrom", { itemId });
    return;
  }

  await processarTransacoesDaConta(
    itemId,
    payload.accountId ?? "",
    "transactions/created",
    (conta) => fetchTransactions(conta.id, undefined, undefined, desde),
  );
}

/**
 * transactions/updated: mesmo formato, porem com `transactionIds` no lugar da
 * janela de criacao. O caso que mais importa aqui e a transacao de cartao que
 * sai de PENDING para POSTED e pode ter mudado de valor.
 */
async function sincronizarTransacoesAtualizadas(itemId: string, payload: PluggyWebhookPayload) {
  const ids = payload.transactionIds ?? [];
  if (ids.length === 0) {
    console.warn("transactions/updated sem transactionIds", { itemId });
    return;
  }

  await processarTransacoesDaConta(
    itemId,
    payload.accountId ?? "",
    "transactions/updated",
    () => fetchTransactionsByIds(ids),
  );
}

/**
 * Tronco comum dos eventos transactions/*: resolve dono e conta, normaliza e
 * entrega ao n8n **no mesmo envelope que item/updated ja usa**, para nao exigir
 * mudanca no workflow openfinance-transacoes.
 *
 * `ultima_sincronizacao_em` de proposito nao e tocada aqui: ela e a janela do
 * item inteiro e quem a move e o item/updated. Avanca-la a partir de um evento
 * de uma conta so deixaria as outras contas com a janela adiantada, pulando
 * transacao que ainda nao tinha chegado.
 */
async function processarTransacoesDaConta(
  itemId: string,
  accountId: string,
  origem: string,
  buscar: (conta: PluggyAccount) => Promise<PluggyTransaction[]>,
) {
  if (!accountId) {
    console.warn("evento de transacoes sem accountId", { itemId, origem });
    return;
  }

  const usuarioId = await resolveUsuarioIdDoItem(itemId);
  if (!usuarioId) return;

  const conta = await fetchAccount(accountId);

  // A conta chega pelo corpo do webhook, que e forjavel quando
  // PLUGGY_WEBHOOK_SECRET nao esta configurado. Sem esta conferencia, um evento
  // com o item de um usuario e a conta de outro gravaria transacao alheia sob o
  // usuario errado: o dono sai do itemId, os dados saem do accountId.
  if (conta.itemId !== itemId) {
    console.warn("accountId do evento nao pertence ao itemId; evento descartado", {
      itemId,
      account_id: accountId,
      origem,
    });
    return;
  }

  const transacoes = await buscar(conta);
  const normalizadas = [];
  for (const transacao of transacoes) {
    const normalizada = normalizarTransacao(transacao, itemId, usuarioId, conta);
    if (normalizada) normalizadas.push(normalizada);
  }

  if (normalizadas.length === 0) {
    console.log("evento de transacoes sem nada a encaminhar", {
      itemId,
      account_id: accountId,
      origem,
      recebidas: transacoes.length,
    });
    return;
  }

  console.log("transacoes encaminhadas ao n8n", {
    itemId,
    account_id: accountId,
    conta_tipo: conta.type,
    origem,
    recebidas: transacoes.length,
    encaminhadas: normalizadas.length,
  });

  await encaminharParaN8n({
    source: "pluggy-open-finance",
    event_type: "transacoes_sincronizadas",
    usuario_id: usuarioId,
    item_id: itemId,
    // O workflow usa este campo como piso da consulta de deduplicacao e para o
    // texto do periodo, e le como YYYY-MM-DD. Aqui nao existe janela de item,
    // entao a data mais antiga do proprio lote e o piso correto: nao adianta
    // procurar duplicata antes da transacao mais velha que chegou.
    sincronizado_desde: pisoDeData(normalizadas),
    total: normalizadas.length,
    transacoes: normalizadas,
  });
}

function pisoDeData(normalizadas: Array<{ data_despesa: string }>) {
  return normalizadas
    .map((t) => t.data_despesa)
    .filter(Boolean)
    .sort()[0] ?? null;
}

/**
 * Descobre de quem e o item.
 *
 * Caminho 1: open_finance_items, gravada pela pluggy-item-link no onSuccess.
 * Caminho 2 (backfill): o clientUserId que a pluggy-connect-token gravou no
 * proprio item do Pluggy. Sem ele, uma conexao concluida cujo onSuccess nao
 * chegou a rodar (usuario fechou o navegador, rede caiu) viraria transacao
 * orfa descartada em silencio para sempre.
 */
async function resolveUsuarioIdDoItem(itemId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("open_finance_items")
    .select("usuario_id")
    .eq("pluggy_item_id", itemId)
    .maybeSingle();

  if (error) {
    console.error("falha ao consultar open_finance_items", error);
    return null;
  }

  if (data?.usuario_id) {
    return data.usuario_id;
  }

  const item = await fetchItem(itemId);
  const usuarioId = item.clientUserId;
  if (!usuarioId) {
    console.warn("item do pluggy sem clientUserId; sem como atribuir dono", { itemId });
    return null;
  }

  // Confere que o clientUserId e mesmo um usuario nosso antes de gravar: o
  // campo e livre do lado do Pluggy.
  const { data: usuario, error: usuarioError } = await supabaseAdmin
    .from("usuarios")
    .select("id")
    .eq("id", usuarioId)
    .maybeSingle();

  if (usuarioError || !usuario?.id) {
    console.warn("clientUserId do item nao corresponde a um usuario do TaxMind", { itemId });
    return null;
  }

  const { error: upsertError } = await supabaseAdmin
    .from("open_finance_items")
    .upsert({
      usuario_id: usuario.id,
      pluggy_item_id: itemId,
      connector_id: item.connector?.id ? String(item.connector.id) : null,
      connector_nome: item.connector?.name ?? null,
      status: item.status ?? null,
      status_detalhe: { origem_do_vinculo: "backfill_via_client_user_id" },
    }, { onConflict: "pluggy_item_id" });

  if (upsertError) {
    console.error("falha no backfill de open_finance_items", upsertError);
  }

  return usuario.id;
}

async function sincronizarTransacoes(itemId: string) {
  const usuarioId = await resolveUsuarioIdDoItem(itemId);
  if (!usuarioId) return;

  const { data: vinculo } = await supabaseAdmin
    .from("open_finance_items")
    .select("ultima_sincronizacao_em")
    .eq("pluggy_item_id", itemId)
    .maybeSingle();

  const desde = vinculo?.ultima_sincronizacao_em
    ? new Date(vinculo.ultima_sincronizacao_em)
    : new Date(Date.now() - JANELA_INICIAL_DIAS * 24 * 60 * 60 * 1000);
  const from = desde.toISOString().slice(0, 10);

  const contas = await fetchAccounts(itemId);
  const normalizadas = [];

  for (const conta of contas) {
    const transacoes = await fetchTransactions(conta.id, from);
    for (const transacao of transacoes) {
      const normalizada = normalizarTransacao(transacao, itemId, usuarioId, conta);
      if (normalizada) normalizadas.push(normalizada);
    }
  }

  if (normalizadas.length === 0) {
    console.log("nenhuma transacao nova para o item", { itemId, from });
    await marcarSincronizacao(itemId);
    return;
  }

  await encaminharParaN8n({
    source: "pluggy-open-finance",
    event_type: "transacoes_sincronizadas",
    usuario_id: usuarioId,
    item_id: itemId,
    sincronizado_desde: from,
    total: normalizadas.length,
    transacoes: normalizadas,
  });

  await marcarSincronizacao(itemId);
}

/**
 * Equivalente ao extractInboundMessages da whatsapp-webhook: entrega ao n8n um
 * formato estavel, sem obrigar o workflow a conhecer o payload do Pluggy.
 *
 * Duas filtragens acontecem aqui:
 *   - `type: CREDIT` fora. Entrada de dinheiro (salario, transferencia
 *     recebida, pagamento de fatura) nao e despesa dedutivel. Vale igual para
 *     cartao: ali o `CREDIT` e o pagamento da fatura ou o estorno, e as compras
 *     ja entram uma a uma.
 *   - PENDING fora, **exceto em conta de cartao de credito**. Ver abaixo.
 *
 * Sobre PENDING e cartao. Em conta BANK, PENDING dura minutos e a transacao
 * ainda pode mudar de valor, entao esperar o POSTED e barato. Em conta CREDIT e
 * o oposto: a compra fica PENDING ate a fatura fechar, ou seja o ciclo inteiro
 * corrente. Descartar PENDING ali apagava a maior parte das compras de cartao,
 * e elas nao voltavam depois: a sincronizacao seguinte usa um `dateFrom` mais
 * recente que a data da compra, entao a janela ja tinha passado por cima. No
 * item sandbox isso derrubava 12 das 23 compras do cartao Dinners.
 *
 * O preco de aceitar PENDING e o valor poder ser ajustado depois da gravacao. O
 * evento transactions/updated cobre esse caso reenviando a transacao ao n8n, e
 * o registro sai daqui com `status_pluggy` para que a origem provisoria fique
 * na trilha de auditoria.
 *
 * Nao ha normalizacao de sinal a fazer alem do Math.abs, mas convem saber por
 * que ele nao e redundante: em conta BANK o DEBIT vem com `amount` negativo, em
 * conta CREDIT o DEBIT vem positivo.
 */
function normalizarTransacao(
  transacao: PluggyTransaction,
  itemId: string,
  usuarioId: string,
  conta: PluggyAccount | null,
) {
  if (transacao.type !== "DEBIT") return null;

  const ehCartao = conta?.type === "CREDIT";
  if (!ehCartao && transacao.status === "PENDING") return null;

  const valor = Math.abs(Number(transacao.amount));
  if (!Number.isFinite(valor) || valor <= 0) return null;

  return {
    usuario_id: usuarioId,
    item_id: itemId,
    transaction_id: transacao.id,
    account_id: transacao.accountId,
    conta_nome: conta?.name ?? null,
    conta_tipo: conta?.type ?? null,
    status_pluggy: transacao.status ?? null,
    descricao: transacao.description || transacao.descriptionRaw || "Transacao bancaria",
    descricao_original: transacao.descriptionRaw ?? null,
    valor,
    moeda: transacao.currencyCode ?? "BRL",
    // O Pluggy devolve ISO completo; o schema guarda data_despesa como date.
    data_despesa: String(transacao.date).slice(0, 10),
    categoria_pluggy: transacao.category ?? null,
    // O pre-filtro do workflow decide por este codigo, nao pelo rotulo acima:
    // `categoryId` e hierarquico (os 2 primeiros digitos sao a categoria de
    // topo) e estavel, enquanto `category` e texto de exibicao que a Pluggy
    // pode renomear sem quebrar contrato nenhum.
    categoria_pluggy_id: transacao.categoryId ?? null,
    estabelecimento: transacao.merchant?.name ?? transacao.merchant?.businessName ?? null,
    documento_prestador: transacao.merchant?.cnpj ?? null,
  };
}

async function marcarSincronizacao(itemId: string) {
  const { error } = await supabaseAdmin
    .from("open_finance_items")
    .update({ ultima_sincronizacao_em: new Date().toISOString() })
    .eq("pluggy_item_id", itemId);

  if (error) {
    console.error("falha ao marcar ultima_sincronizacao_em", error);
  }
}

async function registrarErroDoItem(itemId: string, erro: { code?: string; message?: string }) {
  const { error } = await supabaseAdmin
    .from("open_finance_items")
    .update({
      status: "ERROR",
      status_detalhe: {
        code: erro.code ?? null,
        message: erro.message ?? null,
        registrado_em: new Date().toISOString(),
      },
    })
    .eq("pluggy_item_id", itemId);

  if (error) {
    console.error("falha ao registrar erro do item", error);
  }
}

async function encaminharParaN8n(payload: unknown) {
  const url = env("N8N_OPENFINANCE_WEBHOOK_URL");
  if (!url) {
    console.warn("N8N_OPENFINANCE_WEBHOOK_URL nao configurada; transacoes nao encaminhadas");
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("falha ao encaminhar transacoes ao n8n", response.status, await response.text());
  }
}
