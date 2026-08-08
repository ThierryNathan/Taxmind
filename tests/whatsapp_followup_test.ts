// Fase 13 - ciclo de vida da pendencia na whatsapp-webhook.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/whatsapp_followup_test.ts
//
// A webhook e o unico componente que ve TODA mensagem — texto vai para o
// consulta-e-dossie e midia para o receipt-ocr-classification —, entao e ela
// que conta o orcamento e expira a pendencia. O teste sobe a function real com
// fetch stubado (mesmo padrao de tests/reverificacao_webhook_test.ts) e olha
// duas coisas: o que foi anotado no payload que segue para o n8n, e o que
// sobrou na tabela.
//
// A propriedade mais importante aqui e negativa: NENHUM caminho pode impedir a
// mensagem de chegar ao n8n. Follow-up e opcional.
//
// Sobe serve() na porta 8000: nao roda no mesmo processo das outras suites.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hmacSha256Hex } from "../supabase/functions/_shared/bootstrap_token.ts";

const APP_SECRET = "segredo_de_app_meta_para_teste";
const SUPABASE_ORIGIN = "http://supabase.test";
const N8N_MIDIA = "http://n8n.test/webhook/receipt-ocr-classification";
const N8N_TEXTO = "http://n8n.test/webhook/consulta-dossie";
const FUNCTION_ORIGIN = "http://localhost:8000";

const WA_ID = "5511999990000";
const TELEFONE = "+5511999990000";
const USUARIO_ID = "11111111-1111-4111-8111-111111111111";
const SESSAO_ID = "22222222-2222-4222-8222-222222222222";
const RECIBO_ID = "33333333-3333-4333-8333-333333333333";
const FOLLOWUP_ID = "44444444-4444-4444-8444-444444444444";

const CNPJ = "11222333000181";
const MINUTO = 60 * 1000;

Deno.env.set("SUPABASE_URL", SUPABASE_ORIGIN);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_de_teste");
Deno.env.set("WHATSAPP_APP_SECRET", APP_SECRET);
Deno.env.set("WHATSAPP_ACCESS_TOKEN", "token_de_teste");
Deno.env.set("WHATSAPP_PHONE_NUMBER_ID", "1234567890");
Deno.env.set("CPF_HASH_PEPPER", "pepper_de_teste_com_mais_de_32_caracteres_ok");
Deno.env.set("TAXMIND_BOOTSTRAP_SECRET", "bootstrap_de_teste_com_mais_de_32_chars");
Deno.env.set("ONBOARDING_BASE_URL", "http://localhost:5173/onboarding");
Deno.env.set("N8N_WEBHOOK_URL", N8N_MIDIA);
Deno.env.set("N8N_TEXT_WEBHOOK_URL", N8N_TEXTO);

type Linha = Record<string, any>;
const db: Record<string, Linha[]> = {
  usuarios: [],
  sessoes_whatsapp: [],
  followups_pendentes: [],
  codigos_verificacao: [],
  eventos_acesso: [],
};

const capturado = { n8n: [] as Array<{ url: string; payload: any }>, whatsapp: [] as string[] };
let falharConsultaFollowup = false;

const agoraIso = () => new Date().toISOString();

function aplicarFiltros(linhas: Linha[], params: URLSearchParams): Linha[] {
  const reservados = new Set(["select", "order", "limit", "offset", "on_conflict"]);
  let resultado = linhas;

  for (const [coluna, expressao] of params) {
    if (reservados.has(coluna)) continue;
    resultado = resultado.filter((linha) => {
      const valor = linha[coluna];
      if (expressao === "is.null") return valor === null || valor === undefined;
      if (expressao === "not.is.null") return valor !== null && valor !== undefined;

      const [operador, ...resto] = expressao.split(".");
      const alvo = resto.join(".");
      switch (operador) {
        case "eq":
          return String(valor) === alvo;
        case "gt":
          return new Date(valor).getTime() > new Date(alvo).getTime();
        default:
          throw new Error(`operador PostgREST nao emulado: ${expressao}`);
      }
    });
  }
  return resultado;
}

function ordenarELimitar(linhas: Linha[], params: URLSearchParams): Linha[] {
  const ordem = params.get("order");
  let resultado = [...linhas];
  if (ordem) {
    const [coluna, direcao] = ordem.split(".");
    const fator = direcao === "desc" ? -1 : 1;
    resultado.sort((a, b) =>
      (new Date(a[coluna] ?? 0).getTime() - new Date(b[coluna] ?? 0).getTime()) * fator
    );
  }
  const limite = params.get("limit");
  return limite ? resultado.slice(0, Number(limite)) : resultado;
}

function respostaJson(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function postgrest(url: URL, init?: RequestInit): Response {
  const tabela = url.pathname.replace("/rest/v1/", "");
  if (!(tabela in db)) throw new Error(`tabela inesperada no teste: ${tabela}`);

  if (tabela === "followups_pendentes" && falharConsultaFollowup) {
    return respostaJson({ code: "57014", message: "statement timeout" }, 500);
  }

  const metodo = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? {});
  const querObjeto = (headers.get("accept") ?? "").includes("pgrst.object+json");
  const alvos = aplicarFiltros(db[tabela], url.searchParams);

  if (metodo === "GET") {
    const recorte = ordenarELimitar(alvos, url.searchParams);
    if (querObjeto) {
      return recorte.length === 1
        ? respostaJson(recorte[0])
        : respostaJson({ code: "PGRST116", message: "0 rows" }, 406);
    }
    return respostaJson(recorte);
  }

  if (metodo === "POST") {
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    const registros = Array.isArray(corpo) ? corpo : [corpo];
    const inseridos = registros.map((registro) => {
      const novo = { id: crypto.randomUUID(), criado_em: agoraIso(), ...registro };
      db[tabela].push(novo);
      return novo;
    });
    return querObjeto ? respostaJson(inseridos[0], 201) : respostaJson(inseridos, 201);
  }

  if (metodo === "PATCH") {
    const alteracoes = JSON.parse(String(init?.body ?? "{}"));
    for (const linha of alvos) Object.assign(linha, alteracoes);
    return respostaJson(alvos);
  }

  throw new Error(`metodo nao emulado: ${metodo}`);
}

const fetchReal = globalThis.fetch;

globalThis.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
  const bruto = typeof input === "string" ? input : input?.url ?? String(input);
  const url = new URL(bruto);

  if (url.origin === FUNCTION_ORIGIN) return await fetchReal(input, init);
  if (url.origin === SUPABASE_ORIGIN) return postgrest(url, init);

  if (url.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    capturado.whatsapp.push(String(corpo?.text?.body ?? ""));
    return respostaJson({ messages: [{ id: "wamid.mock" }] });
  }

  if (url.hostname === "n8n.test") {
    capturado.n8n.push({ url: bruto, payload: JSON.parse(String(init?.body ?? "{}")) });
    return respostaJson({ ok: true });
  }

  throw new Error(`fetch inesperado no teste: ${bruto}`);
};

await import("../supabase/functions/whatsapp-webhook/index.ts");

async function aguardarFunction() {
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    try {
      await fetchReal(`${FUNCTION_ORIGIN}/?hub.mode=ping`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("whatsapp-webhook nao subiu");
}

function semear(pendencia: Partial<Linha> | null = {}) {
  db.usuarios = [{
    id: USUARIO_ID,
    email: "contribuinte@exemplo.test",
    telefone_whatsapp: TELEFONE,
    criado_em: agoraIso(),
  }];
  db.sessoes_whatsapp = [{
    id: SESSAO_ID,
    usuario_id: USUARIO_ID,
    telefone_whatsapp: TELEFONE,
    wa_id: WA_ID,
    status: "ABERTA",
    contexto: {},
    ultima_interacao_em: agoraIso(),
    expira_em: new Date(Date.now() + 12 * 60 * MINUTO).toISOString(),
    // Dentro da janela de confianca: a re-verificacao nao entra no caminho.
    verificado_em: agoraIso(),
    criado_em: agoraIso(),
  }];
  db.followups_pendentes = pendencia
    ? [{
      id: FOLLOWUP_ID,
      usuario_id: USUARIO_ID,
      recibo_id: RECIBO_ID,
      campo_alvo: "documento_prestador",
      pergunta: "Voce tem o CNPJ?",
      mensagens_restantes: 2,
      expira_em: new Date(Date.now() + 20 * MINUTO).toISOString(),
      respondida_em: null,
      descartada_em: null,
      descartada_motivo: null,
      criado_em: agoraIso(),
      ...pendencia,
    }]
    : [];
  capturado.n8n = [];
  capturado.whatsapp = [];
  falharConsultaFollowup = false;
}

async function enviar(conteudo: { texto?: string; imagem?: boolean }) {
  const mensagem: Linha = {
    from: WA_ID,
    id: `wamid.${crypto.randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: conteudo.imagem ? "image" : "text",
  };
  if (conteudo.imagem) mensagem.image = { id: "midia-1", mime_type: "image/jpeg", sha256: "abc" };
  else mensagem.text = { body: conteudo.texto ?? "" };

  const payload = {
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: WA_ID, profile: { name: "Contribuinte" } }],
          messages: [mensagem],
        },
      }],
    }],
  };

  const corpo = JSON.stringify(payload);
  const resposta = await fetchReal(FUNCTION_ORIGIN, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${await hmacSha256Hex(APP_SECRET, corpo)}`,
    },
    body: corpo,
  });
  return resposta;
}

const ultimoEncaminhado = () => capturado.n8n[capturado.n8n.length - 1];
const pendencia = () => db.followups_pendentes[0];

Deno.test("sem pendencia aberta, o payload segue com followup null", async () => {
  semear(null);
  await aguardarFunction();

  await enviar({ texto: "gastei 40 no almoco" });

  assertEquals(capturado.n8n.length, 1);
  assertEquals(ultimoEncaminhado().payload.followup, null);
  assertEquals(ultimoEncaminhado().url, N8N_TEXTO);
});

Deno.test("documento reconhecido e anotado sem gastar orcamento", async () => {
  semear();
  await enviar({ texto: `cnpj ${CNPJ}` });

  const anotacao = ultimoEncaminhado().payload.followup;
  assertEquals(anotacao.id, FOLLOWUP_ID);
  assertEquals(anotacao.recibo_id, RECIBO_ID);
  assertEquals(anotacao.campo_alvo, "documento_prestador");
  assertEquals(anotacao.valor_detectado, CNPJ);

  // A resposta nao pode consumir a propria janela que ela veio fechar.
  assertEquals(pendencia().mensagens_restantes, 2);
  assertEquals(pendencia().respondida_em, null);
});

Deno.test("mensagem que nao responde segue normal e gasta uma mensagem", async () => {
  semear();
  await enviar({ texto: "quanto tenho de despesa esse mes?" });

  const anotacao = ultimoEncaminhado().payload.followup;
  // Anotada com valor null: o classificador de intencao decide se e texto
  // livre respondendo a pergunta ou assunto novo.
  assertEquals(anotacao.valor_detectado, null);
  assertEquals(anotacao.id, FOLLOWUP_ID);
  assertEquals(pendencia().mensagens_restantes, 1);
  // E, acima de tudo, a mensagem chegou ao n8n.
  assertEquals(ultimoEncaminhado().url, N8N_TEXTO);
});

Deno.test("duas mensagens sem resposta encerram a pendencia, sem travar nada", async () => {
  semear();
  await enviar({ texto: "bom dia" });
  await enviar({ texto: "tudo certo por ai?" });
  await enviar({ texto: "gastei 25 no estacionamento" });

  assertEquals(capturado.n8n.length, 3);
  assertEquals(pendencia().descartada_motivo, "ORCAMENTO_ESGOTADO");
  assertEquals(ultimoEncaminhado().payload.followup, null);
  // Nenhuma cobranca foi enviada ao usuario em nenhum momento.
  assertEquals(capturado.whatsapp, []);
});

Deno.test("foto e lancamento novo: gasta orcamento e vai para o fluxo de midia", async () => {
  semear();
  await enviar({ imagem: true });

  assertEquals(ultimoEncaminhado().url, N8N_MIDIA);
  assertEquals(ultimoEncaminhado().payload.followup.valor_detectado, null);
  assertEquals(pendencia().mensagens_restantes, 1);
});

Deno.test("pendencia vencida por tempo e descartada na proxima mensagem", async () => {
  semear({ expira_em: new Date(Date.now() - MINUTO).toISOString() });
  await enviar({ texto: `cnpj ${CNPJ}` });

  assertEquals(ultimoEncaminhado().payload.followup, null);
  assertEquals(pendencia().descartada_motivo, "EXPIRADA");
  assertEquals(capturado.n8n.length, 1);
});

Deno.test("falha ao consultar a pendencia nao impede a mensagem de seguir", async () => {
  semear();
  falharConsultaFollowup = true;

  const resposta = await enviar({ texto: `cnpj ${CNPJ}` });

  assertEquals(resposta.status, 200);
  assertEquals(capturado.n8n.length, 1);
  assertEquals(ultimoEncaminhado().payload.followup, null);
  // A mensagem original chegou inteira ao n8n.
  assertEquals(ultimoEncaminhado().payload.normalized.text_body, `cnpj ${CNPJ}`);
});

Deno.test("pendencia de outro usuario nunca e anotada nesta conversa", async () => {
  semear({ usuario_id: "99999999-9999-4999-8999-999999999999" });
  await enviar({ texto: `cnpj ${CNPJ}` });

  assertEquals(ultimoEncaminhado().payload.followup, null);
  assertEquals(pendencia().mensagens_restantes, 2);
});

Deno.test("usuario sem cadastro nao ganha follow-up nenhum", async () => {
  semear();
  db.usuarios = [];
  await enviar({ texto: `cnpj ${CNPJ}` });

  // Cai no onboarding, como antes da fase.
  assertEquals(capturado.n8n.length, 0);
  assert(capturado.whatsapp[0]?.includes("TaxMind"));
  assertEquals(pendencia().mensagens_restantes, 2);
});
