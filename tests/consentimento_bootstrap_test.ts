// Fase 12 - gate de consentimento LGPD na bootstrap-identity.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/consentimento_bootstrap_test.ts
//
// Mesmo padrao de tests/reverificacao_webhook_test.ts: sobe a Edge Function
// REAL (import do index.ts, que chama serve()) com globalThis.fetch stubado
// ANTES do import, porque o createClient no topo do modulo captura a referencia
// de fetch naquele momento. O PostgREST e o endpoint admin do GoTrue sao
// servidos em memoria aqui.
//
// Esta suite sobe serve() na porta 8000 e por isso NAO roda no mesmo processo
// que as outras suites de Edge Function.
//
// O que este teste NAO cobre: RLS, grants e a unique real de
// consentimentos_lgpd (isso e a validacao da migration em postgres) e o
// comportamento do GoTrue de verdade.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signBootstrapToken } from "../supabase/functions/_shared/bootstrap_token.ts";
import {
  CONSENTIMENTO_ATUAL,
  hashTextoConsentimento,
} from "../supabase/functions/_shared/consentimento.ts";

const SUPABASE_ORIGIN = "http://supabase.test";
const FUNCTION_ORIGIN = "http://localhost:8000";
const WA_ID = "5511999990000";
const TELEFONE = "+5511999990000";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSAO_ID = "44444444-4444-4444-8444-444444444444";

Deno.env.set("SUPABASE_URL", SUPABASE_ORIGIN);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_de_teste");
Deno.env.set("TAXMIND_BOOTSTRAP_SECRET", "bootstrap_de_teste_com_mais_de_32_chars");
Deno.env.set("CPF_HASH_PEPPER", "pepper_de_teste_com_mais_de_32_caracteres_ok");
Deno.env.set("ONBOARDING_BASE_URL", "http://localhost:5173/onboarding");
Deno.env.set("SUPABASE_AUTH_REDIRECT_TO", "http://localhost:5173/auth/callback");

// --- mini-PostgREST + GoTrue admin em memoria ----------------------------

type Linha = Record<string, any>;
const db: Record<string, Linha[]> = {
  usuarios: [],
  sessoes_whatsapp: [],
  consentimentos_lgpd: [],
};

const agoraIso = () => new Date().toISOString();

const defaults: Record<string, () => Linha> = {
  usuarios: () => ({ criado_em: agoraIso() }),
  consentimentos_lgpd: () => ({ canal: "ONBOARDING_WEB", criado_em: agoraIso() }),
  sessoes_whatsapp: () => ({ contexto: {}, criado_em: agoraIso() }),
};

function resetEstado() {
  for (const tabela of Object.keys(db)) db[tabela] = [];
  db.sessoes_whatsapp.push({
    id: SESSAO_ID,
    usuario_id: null,
    telefone_whatsapp: TELEFONE,
    wa_id: WA_ID,
    status: "ABERTA",
    contexto: {},
    ultima_interacao_em: agoraIso(),
    expira_em: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    criado_em: agoraIso(),
  });
}

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

function respostaJson(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Emula on_conflict + Prefer: resolution=..., que e o que o .upsert() do
// supabase-js manda. ignore-duplicates precisa mesmo preservar a linha antiga:
// e disso que depende o aceite ORIGINAL sobreviver a um reonboarding.
function upsert(tabela: string, registro: Linha, params: URLSearchParams, prefer: string) {
  const conflito = params.get("on_conflict")?.split(",") ?? [];
  const existente = conflito.length > 0
    ? db[tabela].find((linha) => conflito.every((coluna) => linha[coluna] === registro[coluna]))
    : undefined;

  if (existente) {
    if (prefer.includes("resolution=ignore-duplicates")) return existente;
    Object.assign(existente, registro);
    return existente;
  }

  const novo = { id: crypto.randomUUID(), ...(defaults[tabela]?.() ?? {}), ...registro };
  db[tabela].push(novo);
  return novo;
}

function postgrest(url: URL, init?: RequestInit): Response {
  const tabela = url.pathname.replace("/rest/v1/", "");
  if (!(tabela in db)) throw new Error(`tabela inesperada no teste: ${tabela}`);

  const metodo = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? {});
  const prefer = headers.get("prefer") ?? "";
  const querObjeto = (headers.get("accept") ?? "").includes("pgrst.object+json");

  if (metodo === "GET") {
    const linhas = aplicarFiltros(db[tabela], url.searchParams);
    const limite = url.searchParams.get("limit");
    const recorte = limite ? linhas.slice(0, Number(limite)) : linhas;
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
    const gravados = registros.map((registro) =>
      upsert(tabela, registro, url.searchParams, prefer)
    );
    return respostaJson(prefer.includes("return=minimal") ? null : gravados, 201);
  }

  if (metodo === "PATCH") {
    const alteracoes = JSON.parse(String(init?.body ?? "{}"));
    const alvos = aplicarFiltros(db[tabela], url.searchParams);
    for (const linha of alvos) Object.assign(linha, alteracoes);
    return respostaJson(alvos);
  }

  throw new Error(`metodo nao emulado: ${metodo}`);
}

let geracoesDeLink = 0;

// GoTrue devolve o link e o usuario num objeto plano; o supabase-js reparte em
// { properties, user }.
function gotruleAdminGenerateLink(init?: RequestInit): Response {
  geracoesDeLink += 1;
  const corpo = JSON.parse(String(init?.body ?? "{}"));
  return respostaJson({
    id: USER_ID,
    email: corpo.email,
    action_link: "http://localhost:5173/auth/callback#token=mock",
    email_otp: "123456",
    hashed_token: "hashed-mock",
    verification_type: "magiclink",
    redirect_to: corpo.redirect_to ?? null,
  });
}

const fetchReal = globalThis.fetch;

globalThis.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
  const bruto = typeof input === "string" ? input : input?.url ?? String(input);
  const url = new URL(bruto);

  if (url.origin === FUNCTION_ORIGIN) return await fetchReal(input, init);
  if (url.origin === SUPABASE_ORIGIN) {
    if (url.pathname.startsWith("/auth/v1/admin/generate_link")) {
      return gotruleAdminGenerateLink(init);
    }
    return postgrest(url, init);
  }

  throw new Error(`fetch inesperado no teste: ${bruto}`);
};

await import("../supabase/functions/bootstrap-identity/index.ts");

async function aguardarFunction() {
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    try {
      await fetchReal(FUNCTION_ORIGIN, { method: "OPTIONS" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("bootstrap-identity nao subiu");
}

// --- helpers de cenario ---------------------------------------------------

async function tokenValido(expEmSegundos = 15 * 60) {
  return await signBootstrapToken({
    wa_id: WA_ID,
    phone: TELEFONE,
    session_id: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + expEmSegundos,
    nonce: crypto.randomUUID(),
  });
}

// CPF sintetico com digito verificador coerente com a mascara do frontend; o
// backend so confere o formato de 11 digitos.
const CPF = "39053344705";

async function chamar(corpo: Record<string, unknown>) {
  const resposta = await fetchReal(FUNCTION_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

async function cadastroCompleto(overrides: Record<string, unknown> = {}) {
  return await chamar({
    token: await tokenValido(),
    nome: "Contribuinte de Teste",
    email: "contribuinte@exemplo.test",
    cpf: CPF,
    consentimento_aceito: true,
    consentimento_versao: CONSENTIMENTO_ATUAL.versao,
    ...overrides,
  });
}

// --- testes ---------------------------------------------------------------

Deno.test("sem consentimento nao ha cadastro", async () => {
  resetEstado();
  geracoesDeLink = 0;
  await aguardarFunction();

  const { status, corpo } = await cadastroCompleto({ consentimento_aceito: undefined });

  assertEquals(status, 400);
  assertEquals(corpo.error, "consentimento_obrigatorio");
  // O gate corta antes de qualquer efeito colateral: nem magic link, nem conta.
  assertEquals(geracoesDeLink, 0);
  assertEquals(db.usuarios.length, 0);
  assertEquals(db.consentimentos_lgpd.length, 0);
});

Deno.test("consentimento recusado explicitamente tambem bloqueia", async () => {
  resetEstado();
  const { status, corpo } = await cadastroCompleto({ consentimento_aceito: false });

  assertEquals(status, 400);
  assertEquals(corpo.error, "consentimento_obrigatorio");
  assertEquals(db.usuarios.length, 0);
});

Deno.test("versao de texto desconhecida e recusada", async () => {
  resetEstado();
  const { status, corpo } = await cadastroCompleto({ consentimento_versao: "2020-01-01.v0" });

  assertEquals(status, 400);
  assertEquals(corpo.error, "consentimento_versao_invalida");
  // A resposta diz qual e a atual para o frontend saber que esta desatualizado.
  assertEquals(corpo.versao_atual, CONSENTIMENTO_ATUAL.versao);
  assertEquals(db.usuarios.length, 0);
});

Deno.test("consentimento aceito grava evidencia com versao, hash e timestamp", async () => {
  resetEstado();
  const antes = Date.now();
  const { status, corpo } = await cadastroCompleto();

  assertEquals(status, 200);
  assertEquals(corpo.ok, true);

  assertEquals(db.consentimentos_lgpd.length, 1);
  const registro = db.consentimentos_lgpd[0];
  assertEquals(registro.usuario_id, USER_ID);
  assertEquals(registro.versao, CONSENTIMENTO_ATUAL.versao);
  assertEquals(registro.canal, "ONBOARDING_WEB");
  // Hash calculado no servidor a partir do texto canonico, nao recebido do
  // navegador.
  assertEquals(registro.texto_hash, await hashTextoConsentimento());
  assert(/^[0-9a-f]{64}$/.test(registro.texto_hash));

  const aceite = new Date(registro.aceito_em).getTime();
  assert(aceite >= antes && aceite <= Date.now(), registro.aceito_em);

  // Ponteiro em usuarios deixa de ser null (era gravado assim antes da fase).
  assertEquals(db.usuarios.length, 1);
  assertEquals(db.usuarios[0].consentimento_lgpd_em, registro.aceito_em);
  assertEquals(db.usuarios[0].onboarding_concluido, true);
});

Deno.test("reonboarding com o mesmo texto preserva o aceite original", async () => {
  resetEstado();
  await cadastroCompleto();
  const primeiro = { ...db.consentimentos_lgpd[0] };

  await new Promise((resolve) => setTimeout(resolve, 20));
  const segunda = await cadastroCompleto();

  assertEquals(segunda.status, 200);
  assertEquals(db.consentimentos_lgpd.length, 1);
  assertEquals(db.consentimentos_lgpd[0].aceito_em, primeiro.aceito_em);
});

Deno.test("token invalido continua sendo 401, antes de olhar consentimento", async () => {
  resetEstado();
  const { status, corpo } = await chamar({
    token: "payload_falso.assinatura_falsa",
    email: "contribuinte@exemplo.test",
    cpf: CPF,
    consentimento_aceito: true,
    consentimento_versao: CONSENTIMENTO_ATUAL.versao,
  });

  assertEquals(status, 401);
  assertEquals(corpo.error, "invalid_or_expired_token");
});

Deno.test("a sonda de token do frontend continua distinguindo 401 de 400", async () => {
  resetEstado();
  // probeBootstrapToken manda corpo vazio de proposito: 401 significa token
  // invalido, qualquer outro status significa "token ok, mostre o formulario".
  // O gate novo nao pode ter empurrado essa checagem para antes do token.
  const sonda = await chamar({ token: await tokenValido(), email: "", cpf: "" });
  assertEquals(sonda.status, 400);
  assertEquals(sonda.corpo.error, "invalid_identity_fields");

  const sondaTokenRuim = await chamar({ token: "quebrado", email: "", cpf: "" });
  assertEquals(sondaTokenRuim.status, 401);
});

Deno.test("token expirado nao cria cadastro nem consentimento", async () => {
  resetEstado();
  const { status } = await cadastroCompleto({ token: await tokenValido(-60) });

  assertEquals(status, 401);
  assertEquals(db.usuarios.length, 0);
  assertEquals(db.consentimentos_lgpd.length, 0);
});
