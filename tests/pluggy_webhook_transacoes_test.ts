// Teste de integracao dos eventos transactions/* da pluggy-webhook (Fase 10).
//
// Rodar (precisa das credenciais reais do Pluggy no ambiente):
//   deno test --allow-env --allow-net tests/pluggy_webhook_transacoes_test.ts
//
// Sobe a pluggy-webhook REAL (import do index.ts, que chama serve()) e
// intercepta globalThis.fetch antes do import — o createClient no topo do
// modulo captura a referencia de fetch nesse momento, entao stubbar depois nao
// pegaria as chamadas ao PostgREST. Com o gancho no lugar:
//
//   - api.pluggy.ai passa direto para a API REAL, com o item sandbox de
//     verdade. E o ponto do teste: contas e transacoes de cartao vem do
//     agregador, nao de fixture escrita a mao, que sempre acaba confirmando a
//     hipotese errada de quem escreveu.
//   - o PostgREST do Supabase e servido por um mini-PostgREST em memoria, para
//     nao escrever no projeto de producao.
//   - o webhook do n8n e capturado em vez de chamado.
//
// O que este teste NAO cobre: entrega real do webhook pelo Pluggy e o
// processamento downstream no n8n. Isso e o teste ponta a ponta, feito
// separadamente com a function deployada.
//
// Pula sozinho quando PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET nao estao no
// ambiente, para nao quebrar em maquina sem credencial.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const TEM_CREDENCIAIS = Boolean(
  Deno.env.get("PLUGGY_CLIENT_ID") && Deno.env.get("PLUGGY_CLIENT_SECRET"),
);

// Item sandbox real, com conta corrente, poupanca e cartao Dinners.
const ITEM_ID = Deno.env.get("PLUGGY_TEST_ITEM_ID") ??
  "50c167a8-6217-4f33-9a17-37d22a282c7b";

const SUPABASE_ORIGIN = "http://supabase.test";
const N8N_URL = "http://n8n.test/webhook/openfinance-transacoes";
// serve() do std sobe na 8000. O teste da whatsapp-webhook usa a mesma porta,
// entao os dois arquivos nao podem rodar no mesmo processo do `deno test`.
const FUNCTION_ORIGIN = "http://localhost:8000";
const USUARIO_ID = "77c9bea5-9ea4-48a0-97f4-a1047eb3b5f7";
const SEGREDO = "segredo_de_webhook_para_teste";

Deno.env.set("SUPABASE_URL", SUPABASE_ORIGIN);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_de_teste");
Deno.env.set("N8N_OPENFINANCE_WEBHOOK_URL", N8N_URL);
Deno.env.set("PLUGGY_WEBHOOK_SECRET", SEGREDO);

// --- mini-PostgREST em memoria -------------------------------------------

type Linha = Record<string, unknown>;
const db: Record<string, Linha[]> = {
  open_finance_items: [
    {
      usuario_id: USUARIO_ID,
      pluggy_item_id: ITEM_ID,
      connector_nome: "Sandbox Open Finance",
      status: "UPDATED",
      ultima_sincronizacao_em: null,
    },
  ],
  usuarios: [{ id: USUARIO_ID }],
};

const capturado = { n8n: [] as Array<Record<string, any>> };

function resetCaptura() {
  capturado.n8n = [];
  db.open_finance_items[0].ultima_sincronizacao_em = null;
}

function filtrar(tabela: string, url: URL): Linha[] {
  let linhas = db[tabela] ?? [];
  for (const [chave, bruto] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(chave)) continue;
    const [op, ...resto] = String(bruto).split(".");
    const valor = resto.join(".");
    if (op === "eq") linhas = linhas.filter((l) => String(l[chave]) === valor);
  }
  return linhas;
}

function respostaSupabase(url: URL, init?: RequestInit): Response {
  const tabela = url.pathname.replace("/rest/v1/", "");
  if (!(tabela in db)) throw new Error(`tabela inesperada no teste: ${tabela}`);

  const metodo = (init?.method ?? "GET").toUpperCase();
  // .maybeSingle() pede o objeto pelo Accept; devolver array ali faz o
  // supabase-js entregar um array onde a function espera uma linha.
  const querObjeto = (new Headers(init?.headers ?? {}).get("accept") ?? "")
    .includes("pgrst.object+json");

  if (metodo === "GET") {
    const linhas = filtrar(tabela, url);
    if (querObjeto) {
      return linhas.length === 1
        ? Response.json(linhas[0])
        : Response.json({ code: "PGRST116", message: "0 rows" }, { status: 406 });
    }
    return Response.json(linhas);
  }

  const corpo = init?.body ? JSON.parse(String(init.body)) : {};

  if (metodo === "PATCH") {
    const alvos = filtrar(tabela, url);
    for (const linha of alvos) Object.assign(linha, corpo);
    return Response.json(alvos);
  }

  if (metodo === "POST") {
    // upsert de open_finance_items com onConflict: pluggy_item_id
    for (const nova of (Array.isArray(corpo) ? corpo : [corpo]) as Linha[]) {
      const existente = db[tabela].find((l) => l.pluggy_item_id === nova.pluggy_item_id);
      if (existente) Object.assign(existente, nova);
      else db[tabela].push(nova);
    }
    return Response.json([]);
  }

  throw new Error(`metodo nao emulado: ${metodo}`);
}

// --- gancho no fetch, antes do import da function -------------------------

const fetchReal = globalThis.fetch;

globalThis.fetch = ((entrada: string | URL | Request, init?: RequestInit) => {
  const bruto = entrada instanceof Request ? entrada.url : String(entrada);
  const url = new URL(bruto);

  if (bruto.startsWith(SUPABASE_ORIGIN)) {
    return Promise.resolve(respostaSupabase(url, init));
  }

  if (bruto.startsWith(N8N_URL)) {
    capturado.n8n.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(Response.json({ ok: true }));
  }

  // api.pluggy.ai e o proprio servidor da function: chamada real.
  return fetchReal(entrada as Request, init);
}) as typeof fetch;

await import("../supabase/functions/pluggy-webhook/index.ts");

// --- utilitarios ----------------------------------------------------------

async function pluggyGet<T>(path: string): Promise<T> {
  const auth = await fetchReal("https://api.pluggy.ai/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: Deno.env.get("PLUGGY_CLIENT_ID"),
      clientSecret: Deno.env.get("PLUGGY_CLIENT_SECRET"),
    }),
  });
  const { apiKey } = await auth.json();
  const r = await fetchReal(`https://api.pluggy.ai${path}`, {
    headers: { "X-API-KEY": apiKey },
  });
  return await r.json() as T;
}

async function enviarEvento(
  payload: Record<string, unknown>,
  // `undefined` manda o header correto; `null` omite o header por completo.
  segredo: string | null | undefined = undefined,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (segredo !== null) headers["x-taxmind-webhook-secret"] = segredo ?? SEGREDO;

  const resposta = await fetchReal(FUNCTION_ORIGIN, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  await resposta.text();
  return resposta.status;
}

// O processamento roda fora da resposta (waitUntil em producao, promise solta
// aqui). Espera o efeito observavel em vez de dormir um tempo fixo.
async function esperar(condicao: () => boolean, ms = 45000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicao()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return condicao();
}

type Conta = { id: string; type: string; subtype: string; name: string };

// Carregado sob demanda, e nao num teste de setup: teste que depende de estado
// deixado por outro passa a falhar por motivo errado quando se roda um so com
// --filter, que e exatamente como se investiga uma falha.
let contasCache: Conta[] | null = null;

async function contasDoItem(): Promise<Conta[]> {
  if (!contasCache) {
    const dados = await pluggyGet<{ results: Conta[] }>(`/accounts?itemId=${ITEM_ID}`);
    contasCache = dados.results;
  }
  return contasCache;
}

async function contaCartao(): Promise<Conta> {
  const conta = (await contasDoItem()).find((c) => c.type === "CREDIT");
  assert(conta, "item sandbox precisa ter uma conta CREDIT");
  return conta;
}

Deno.test({
  name: "contexto: o item sandbox tem conta de cartao de credito",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const contas = await contasDoItem();
    console.log("  contas do item:", contas.map((c) => `${c.type}/${c.subtype}`).join(", "));
    assert(contas.some((c) => c.type === "CREDIT"), "item sandbox precisa ter conta CREDIT");
    assert(
      contas.some((c) => c.subtype === "CHECKING_ACCOUNT"),
      "item sandbox precisa ter conta corrente",
    );
  },
});

Deno.test({
  name: "item/updated: as transacoes do cartao agora chegam ao n8n",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    assertEquals(await enviarEvento({ event: "item/updated", itemId: ITEM_ID }), 200);
    assert(await esperar(() => capturado.n8n.length > 0), "n8n nao recebeu nada");

    const envelope = capturado.n8n[0];
    const doCartao = envelope.transacoes.filter(
      (t: { account_id: string }) => t.account_id === cartao.id,
    );

    console.log(
      `  total=${envelope.total} | do cartao=${doCartao.length}` +
        ` | PENDING no cartao=${doCartao.filter((t: any) => t.status_pluggy === "PENDING").length}`,
    );

    assert(doCartao.length > 0, "nenhuma transacao da conta CREDIT foi encaminhada");
    assert(
      doCartao.every((t: { conta_tipo: string }) => t.conta_tipo === "CREDIT"),
      "conta_tipo do cartao veio errado",
    );
    // Compra de cartao fica PENDING ate a fatura fechar: se so POSTED passasse,
    // o ciclo corrente inteiro sumia do dossie.
    assert(
      doCartao.some((t: { status_pluggy: string }) => t.status_pluggy === "PENDING"),
      "nenhuma compra PENDING do cartao passou — o filtro de PENDING voltou",
    );
    // Em conta CREDIT o DEBIT vem com amount positivo e em BANK, negativo.
    assert(
      envelope.transacoes.every((t: { valor: number }) => t.valor > 0),
      "valor deveria vir sempre positivo",
    );
  },
});

Deno.test({
  name: "item/updated: conta corrente segue descartando PENDING",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    await enviarEvento({ event: "item/updated", itemId: ITEM_ID });
    assert(await esperar(() => capturado.n8n.length > 0));

    const doBanco = capturado.n8n[0].transacoes.filter(
      (t: { conta_tipo: string }) => t.conta_tipo === "BANK",
    );
    assert(doBanco.length > 0, "nenhuma transacao BANK encaminhada");
    assert(
      doBanco.every((t: { status_pluggy: string }) => t.status_pluggy !== "PENDING"),
      "PENDING de conta BANK nao deveria passar",
    );
  },
});

Deno.test({
  name: "transactions/created: busca por createdAtFrom e encaminha no envelope de sempre",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    const status = await enviarEvento({
      event: "transactions/created",
      itemId: ITEM_ID,
      accountId: cartao.id,
      transactionsCreatedAtFrom: "2020-01-01T00:00:00.000Z",
      createdTransactionsLink:
        `https://api.pluggy.ai/transactions?accountId=${cartao.id}&createdAtFrom=2020-01-01T00:00:00.000Z`,
    });
    assertEquals(status, 200);
    assert(await esperar(() => capturado.n8n.length > 0), "transactions/created nao chegou ao n8n");

    const envelope = capturado.n8n[0];
    console.log(`  transactions/created -> total=${envelope.total}`);

    // Mesmo contrato que item/updated: o workflow n8n nao muda.
    assertEquals(envelope.source, "pluggy-open-finance");
    assertEquals(envelope.event_type, "transacoes_sincronizadas");
    assertEquals(envelope.usuario_id, USUARIO_ID);
    assertEquals(envelope.item_id, ITEM_ID);
    assertEquals(envelope.total, envelope.transacoes.length);
    assert(envelope.total > 0, "nenhuma transacao encaminhada");
    // O workflow le sincronizado_desde como YYYY-MM-DD.
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(envelope.sincronizado_desde),
      `sincronizado_desde fora do formato: ${envelope.sincronizado_desde}`,
    );
    assert(
      envelope.transacoes.every((t: { account_id: string }) => t.account_id === cartao.id),
      "evento por conta trouxe transacao de outra conta",
    );

    // ultima_sincronizacao_em e a janela do item inteiro: evento de uma conta
    // so nao pode adianta-la, senao as outras contas pulam transacao.
    assertEquals(db.open_finance_items[0].ultima_sincronizacao_em, null);
  },
});

Deno.test({
  name: "transactions/created filtra por createdAt, nao pela data da transacao",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();

    // As duas dimensoes sao diferentes e a diferenca e o bug que este teste
    // guarda: `date` e quando a compra aconteceu, `createdAt` e quando o Pluggy
    // passou a ter o registro. Numa fatura de cartao a segunda vem dias depois
    // da primeira, entao filtrar por `dateFrom` com a janela de um evento
    // transactions/created descarta justamente a compra que acabou de chegar.
    const tx = await pluggyGet<{ results: Array<{ date: string; createdAt: string }> }>(
      `/v2/transactions?accountId=${cartao.id}`,
    );
    const maiorData = tx.results.map((t) => t.date).sort().at(-1)!;
    const menorCriacao = tx.results.map((t) => t.createdAt).sort()[0];
    console.log(`  maior date=${maiorData} | menor createdAt=${menorCriacao}`);

    // O corte tem que cair num DIA posterior ao da ultima transacao, e nao
    // apenas alguns segundos depois: `dateFrom` e truncado em dia pela API, e
    // um corte no mesmo dia seria aceito pelos dois filtros — o teste passaria
    // mesmo com a consulta errada.
    const diaSeguinte = new Date(new Date(maiorData).getTime() + 24 * 60 * 60 * 1000);
    const corte = diaSeguinte.toISOString().slice(0, 10) + "T00:00:00.000Z";

    if (!(menorCriacao > corte)) {
      console.log("  sandbox sem um dia inteiro de folga entre date e createdAt; nada a discriminar");
      return;
    }

    resetCaptura();
    await enviarEvento({
      event: "transactions/created",
      itemId: ITEM_ID,
      accountId: cartao.id,
      transactionsCreatedAtFrom: corte,
    });
    assert(
      await esperar(() => capturado.n8n.length > 0, 20000),
      `nada encaminhado com createdAtFrom=${corte}: a consulta esta filtrando por dateFrom`,
    );
    assert(capturado.n8n[0].total > 0);
  },
});

Deno.test({
  name: "transactions/created com janela no futuro nao encaminha nada",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    await enviarEvento({
      event: "transactions/created",
      itemId: ITEM_ID,
      accountId: cartao.id,
      transactionsCreatedAtFrom: new Date(Date.now() + 60_000).toISOString(),
    });
    // Prova que a janela do evento e mesmo aplicada: sem filtro nenhum viriam
    // as 25 transacoes da conta.
    await esperar(() => capturado.n8n.length > 0, 8000);
    assertEquals(capturado.n8n.length, 0);
  },
});

Deno.test({
  name: "transactions/updated: busca por lista de ids",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    const tx = await pluggyGet<{ results: Array<{ id: string; type: string }> }>(
      `/v2/transactions?accountId=${cartao.id}`,
    );
    const ids = tx.results.filter((t) => t.type === "DEBIT").slice(0, 3).map((t) => t.id);
    assertEquals(ids.length, 3);

    await enviarEvento({
      event: "transactions/updated",
      itemId: ITEM_ID,
      accountId: cartao.id,
      transactionIds: ids,
    });
    assert(await esperar(() => capturado.n8n.length > 0), "transactions/updated nao chegou ao n8n");

    const envelope = capturado.n8n[0];
    console.log(`  transactions/updated -> total=${envelope.total} de ${ids.length} ids`);
    assertEquals(envelope.event_type, "transacoes_sincronizadas");
    assertEquals(
      envelope.transacoes.map((t: { transaction_id: string }) => t.transaction_id).sort(),
      ids.sort(),
    );
  },
});

Deno.test({
  name: "transactions/deleted nao encaminha nada (limitacao conhecida)",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    assertEquals(
      await enviarEvento({
        event: "transactions/deleted",
        itemId: ITEM_ID,
        accountId: cartao.id,
        transactionIds: ["f618c51c-45fc-4733-8e7c-5ff7d292b97e"],
      }),
      200,
    );
    await esperar(() => capturado.n8n.length > 0, 5000);
    assertEquals(capturado.n8n.length, 0);
  },
});

Deno.test({
  name: "accountId de outro item e descartado",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    db.open_finance_items.push({
      usuario_id: "99999999-9999-4999-8999-999999999999",
      pluggy_item_id: "11111111-1111-4111-8111-111111111111",
    });

    await enviarEvento({
      event: "transactions/created",
      itemId: "11111111-1111-4111-8111-111111111111",
      // conta que pertence ao item sandbox, nao ao item do payload
      accountId: cartao.id,
      transactionsCreatedAtFrom: "2020-01-01T00:00:00.000Z",
    });

    await esperar(() => capturado.n8n.length > 0, 8000);
    assertEquals(capturado.n8n.length, 0, "conta de outro item nao pode ser encaminhada");
    db.open_finance_items.pop();
  },
});

Deno.test({
  name: "evento sem accountId ou sem janela nao quebra o handler",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    assertEquals(await enviarEvento({ event: "transactions/created", itemId: ITEM_ID }), 200);
    assertEquals(
      await enviarEvento({
        event: "transactions/updated",
        itemId: ITEM_ID,
        accountId: cartao.id,
        transactionIds: [],
      }),
      200,
    );
    await esperar(() => capturado.n8n.length > 0, 5000);
    assertEquals(capturado.n8n.length, 0);
  },
});

// --- portao de autenticacao do webhook ------------------------------------
//
// Estes casos so passaram a valer quando PLUGGY_WEBHOOK_SECRET foi configurado
// de verdade: ate entao a function caia no ramo "aceitando webhook sem
// validacao de segredo" e o caminho de comparacao nunca rodava. O que importa
// aqui nao e so o 401 — e que a requisicao recusada **nao processe dado
// nenhum**, ou seja, que a rejeicao aconteca antes do handleEvent.

Deno.test({
  name: "auth: header correto e aceito e o evento e processado",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    assertEquals(
      await enviarEvento({
        event: "transactions/created",
        itemId: ITEM_ID,
        accountId: cartao.id,
        transactionsCreatedAtFrom: "2020-01-01T00:00:00.000Z",
      }),
      200,
    );
    assert(await esperar(() => capturado.n8n.length > 0), "header correto deveria processar");
  },
});

Deno.test({
  name: "auth: sem header e recusado e nada e processado",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    resetCaptura();
    assertEquals(
      await enviarEvento({
        event: "transactions/created",
        itemId: ITEM_ID,
        accountId: cartao.id,
        transactionsCreatedAtFrom: "2020-01-01T00:00:00.000Z",
      }, null),
      401,
    );
    await esperar(() => capturado.n8n.length > 0, 8000);
    assertEquals(capturado.n8n.length, 0, "evento sem header nao pode chegar ao n8n");
  },
});

Deno.test({
  name: "auth: header errado e recusado e nada e processado",
  ignore: !TEM_CREDENCIAIS,
  fn: async () => {
    const cartao = await contaCartao();
    // Mesmo comprimento do segredo real e prefixo correto: header mais curto
    // sairia pelo length mismatch do timingSafeEqual e nao exercitaria a
    // comparacao byte a byte, que e onde mora o erro sutil.
    const quaseCerto = SEGREDO.slice(0, -1) + (SEGREDO.endsWith("a") ? "b" : "a");

    for (const errado of ["", "errado", "X".repeat(SEGREDO.length), quaseCerto]) {
      resetCaptura();
      assertEquals(
        await enviarEvento({
          event: "transactions/created",
          itemId: ITEM_ID,
          accountId: cartao.id,
          transactionsCreatedAtFrom: "2020-01-01T00:00:00.000Z",
        }, errado),
        401,
        `header "${errado.slice(0, 6)}…" deveria ser recusado`,
      );
      await esperar(() => capturado.n8n.length > 0, 4000);
      assertEquals(capturado.n8n.length, 0, "evento com header errado nao pode chegar ao n8n");
    }
  },
});
