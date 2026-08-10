// Fase 13 - a Edge Function followup-resolve.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/followup_resolve_test.ts
//
// Mesmo padrao das outras suites de function: stub de globalThis.fetch ANTES do
// import (o createClient no topo do modulo captura a referencia naquele
// momento), PostgREST em memoria, e a function real respondendo em :8000 —
// portanto NAO roda no mesmo processo das outras suites de Edge Function.
//
// O Gemini tambem e servido daqui, com resposta programavel: o que interessa
// testar e a decisao da function (o que ela grava, o que ela recusa a gravar, o
// que ela promove), nao a redacao do modelo. A qualidade do prompt de
// reclassificacao e testada contra a API real em tests/prompt_gemini_test.ts.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
// Modulo puro, sem efeito colateral no import: pode entrar antes do stub de
// fetch sem interferir no que a function captura.
import {
  CAMPO_REEMBOLSO,
  mensagemPerguntaSegueAberta,
  perguntaParaCampo,
} from "../supabase/functions/_shared/followup.ts";

const SUPABASE_ORIGIN = "http://supabase.test";
const FUNCTION_ORIGIN = "http://localhost:8000";
const SERVICE_ROLE = "service_role_de_teste";

const USUARIO_ID = "11111111-1111-4111-8111-111111111111";
const OUTRO_USUARIO = "99999999-9999-4999-8999-999999999999";
const RECIBO_ID = "22222222-2222-4222-8222-222222222222";
const FOLLOWUP_ID = "33333333-3333-4333-8333-333333333333";
const SESSAO_ID = "55555555-5555-4555-8555-555555555555";

const CNPJ = "11222333000181";
const MINUTO = 60 * 1000;

// A pergunta semeada sai da fonte canonica, e nao de um literal copiado: e a
// mesma string que a mensagem de SEM_CONTEUDO devolve ao usuario, entao um
// literal aqui esconderia divergencia entre a pergunta feita e a repetida.
const PERGUNTA = perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" });

Deno.env.set("SUPABASE_URL", SUPABASE_ORIGIN);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
Deno.env.set("GEMINI_API_KEY", "chave_de_teste");

// --- mini-PostgREST -------------------------------------------------------

type Linha = Record<string, any>;
const db: Record<string, Linha[]> = {
  followups_pendentes: [],
  recibos_evidencias: [],
};

let respostaGemini: string | null = null;
let chamadasGemini = 0;

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
      if (operador === "eq") return String(valor) === alvo;
      throw new Error(`operador PostgREST nao emulado: ${expressao}`);
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

// Barreira para reproduzir concorrencia real: sem ela, a segunda execucao ja
// encontra a linha reivindicada no SELECT e o teste nao chega a exercitar o
// filtro do UPDATE. Segurando o PATCH da primeira ate a segunda ter lido, as
// duas passam do SELECT e a disputa acontece de fato no UPDATE — que e onde a
// exclusao mutua precisa valer.
let segurarProximoPatch = false;
let liberarPatch: (() => void) | null = null;
let leituraFeita: (() => void) | null = null;

/**
 * Espelho de registrar_followup_pendente (migration 009).
 *
 * Sem isto o encadeamento da Fase 16 nao e testavel: a chamada estoura no mock,
 * cai no fail-open de proximaPergunta e a suite passa sem exercitar nada — foi
 * exatamente o que aconteceu na primeira execucao depois da implementacao.
 *
 * Reproduz as duas operacoes da funcao SQL na ordem dela: encerrar a pendencia
 * aberta do usuario como SUPERSEDIDA e inserir a nova. A ordem importa para o
 * teste ter alguma chance de pegar violacao da unique parcial
 * idx_followups_pendentes_aberto_por_usuario, conferida em pendenciaAberta().
 */
let sequenciaEncadeada = 0;
let falharRpc = false;

function rpcRegistrarFollowupPendente(corpo: Record<string, any>): string {
  for (const linha of db.followups_pendentes) {
    if (
      linha.usuario_id === corpo.p_usuario_id && !linha.respondida_em && !linha.descartada_em
    ) {
      linha.descartada_em = new Date().toISOString();
      linha.descartada_motivo = "SUPERSEDIDA";
    }
  }

  sequenciaEncadeada += 1;
  const id = `44444444-4444-4444-8444-${String(sequenciaEncadeada).padStart(12, "0")}`;
  db.followups_pendentes.push({
    id,
    usuario_id: corpo.p_usuario_id,
    recibo_id: corpo.p_recibo_id,
    sessao_whatsapp_id: corpo.p_sessao_whatsapp_id ?? null,
    campo_alvo: corpo.p_campo_alvo,
    pergunta: corpo.p_pergunta,
    mensagens_restantes: corpo.p_mensagens ?? 2,
    expira_em: new Date(Date.now() + (corpo.p_ttl_minutos ?? 30) * MINUTO).toISOString(),
    respondida_em: null,
    resolucao: null,
    descartada_em: null,
    descartada_motivo: null,
    criado_em: new Date().toISOString(),
  });
  return id;
}

async function postgrest(url: URL, init?: RequestInit): Promise<Response> {
  if (url.pathname === "/rest/v1/rpc/registrar_followup_pendente") {
    if (falharRpc) return respostaJson({ code: "42501", message: "permission denied" }, 403);
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    return respostaJson(rpcRegistrarFollowupPendente(corpo));
  }

  const tabela = url.pathname.replace("/rest/v1/", "");
  if (!(tabela in db)) throw new Error(`tabela inesperada no teste: ${tabela}`);

  const metodo = (init?.method ?? "GET").toUpperCase();

  if (tabela === "followups_pendentes") {
    if (metodo === "GET") leituraFeita?.();
    if (metodo === "PATCH" && segurarProximoPatch) {
      segurarProximoPatch = false;
      await new Promise<void>((resolve) => {
        liberarPatch = resolve;
      });
    }
  }

  const headers = new Headers(init?.headers ?? {});
  const querObjeto = (headers.get("accept") ?? "").includes("pgrst.object+json");
  const alvos = aplicarFiltros(db[tabela], url.searchParams);

  if (metodo === "GET") {
    if (querObjeto) {
      return alvos.length === 1
        ? respostaJson(alvos[0])
        : respostaJson({ code: "PGRST116", message: "0 rows" }, 406);
    }
    return respostaJson(alvos);
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
  if (url.origin === SUPABASE_ORIGIN) return await postgrest(url, init);

  if (url.hostname === "generativelanguage.googleapis.com") {
    chamadasGemini += 1;
    if (respostaGemini === null) return respostaJson({ error: "indisponivel" }, 500);
    return respostaJson({
      candidates: [{ content: { parts: [{ text: respostaGemini }] } }],
    });
  }

  throw new Error(`fetch inesperado no teste: ${bruto}`);
};

await import("../supabase/functions/followup-resolve/index.ts");

async function aguardarFunction() {
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    try {
      await fetchReal(FUNCTION_ORIGIN, { method: "GET" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("followup-resolve nao subiu");
}

// --- cenario --------------------------------------------------------------

function semear(opcoes: {
  camposBloqueantes?: string[];
  deducibilidadeSeDesbloqueado?: string | null;
  expiraEmMinutos?: number;
  motivos?: string[];
} = {}) {
  db.followups_pendentes = [{
    id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    recibo_id: RECIBO_ID,
    sessao_whatsapp_id: SESSAO_ID,
    campo_alvo: "documento_prestador",
    pergunta: PERGUNTA,
    mensagens_restantes: 2,
    expira_em: new Date(Date.now() + (opcoes.expiraEmMinutos ?? 20) * MINUTO).toISOString(),
    respondida_em: null,
    resolucao: null,
    descartada_em: null,
    descartada_motivo: null,
    criado_em: new Date().toISOString(),
  }];

  db.recibos_evidencias = [{
    id: RECIBO_ID,
    usuario_id: USUARIO_ID,
    descricao: "Consulta medica",
    valor: 450,
    valor_reembolsado: null,
    data_despesa: "2026-08-08",
    estabelecimento: "Clinica Vida",
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    justificativa_deducibilidade: "Falta documento do prestador.",
    confidence_score: 0.78,
    status: "REVISAO_HUMANA",
    requer_revisao_humana: true,
    metadados_ia: {
      motivos_revisao: opcoes.motivos ?? ["Falta documento do prestador"],
      campos_ausentes: ["documento_prestador"],
      campos_bloqueantes: opcoes.camposBloqueantes ?? ["documento_prestador"],
      deducibilidade_se_desbloqueado: opcoes.deducibilidadeSeDesbloqueado === undefined
        ? "DEDUTIVEL"
        : opcoes.deducibilidadeSeDesbloqueado,
      confidence_score: 0.78,
    },
  }];

  respostaGemini = null;
  chamadasGemini = 0;
}

const recibo = () => db.recibos_evidencias[0];
const followup = () => db.followups_pendentes[0];

/**
 * A pendencia aberta, com a unique parcial conferida no caminho.
 *
 * idx_followups_pendentes_aberto_por_usuario garante no maximo uma por usuario,
 * e o encadeamento e o primeiro codigo que cria pendencia FORA do insert de
 * recibo — se ele algum dia abrir a segunda sem encerrar a primeira, o mock em
 * memoria aceitaria em silencio e o estouro so apareceria em producao.
 */
function pendenciaAberta() {
  const abertas = db.followups_pendentes.filter((f) => !f.respondida_em && !f.descartada_em);
  assert(abertas.length <= 1, `mais de uma pendencia aberta: ${JSON.stringify(abertas)}`);
  return abertas[0] ?? null;
}

async function resolver(corpo: Record<string, unknown>, token = SERVICE_ROLE) {
  const resposta = await fetchReal(FUNCTION_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

const comDocumento = (texto = `cnpj ${CNPJ}`) => ({
  followup_id: FOLLOWUP_ID,
  usuario_id: USUARIO_ID,
  texto,
});

// --- testes ---------------------------------------------------------------

Deno.test("chamador sem service_role nao resolve nada", async () => {
  semear();
  await aguardarFunction();

  const { status } = await resolver(comDocumento(), "anon_key_publica");

  assertEquals(status, 401);
  assertEquals(recibo().documento_prestador, null);
});

Deno.test("documento respondido preenche o campo e promove a despesa", async () => {
  semear();
  const { status, corpo } = await resolver(comDocumento());

  assertEquals(status, 200);
  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(corpo.promovido, true);

  // Patch local: nenhuma chamada de IA para preencher campo estruturado.
  assertEquals(chamadasGemini, 0);

  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(recibo().requer_revisao_humana, false);
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
  // A deducibilidade vem do que a IA ja tinha declarado, nao de palpite.
  assertEquals(recibo().deducibilidade, "DEDUTIVEL");
  assertEquals(recibo().metadados_ia.campos_bloqueantes, []);

  // Trilha: a analise original continua inteira, com o follow-up ao lado.
  assertEquals(recibo().metadados_ia.motivos_revisao, ["Falta documento do prestador"]);
  assertEquals(recibo().metadados_ia.followups.length, 1);
  assertEquals(recibo().metadados_ia.followups[0].modo, "CAMPO_PREENCHIDO");
  assertEquals(recibo().metadados_ia.followups[0].deducibilidade_anterior, "INDETERMINADO");

  assertEquals(followup().resolucao, "CAMPO_PREENCHIDO");
  assert(followup().respondida_em);

  const mensagem: string = corpo.mensagem;
  assert(mensagem.includes("11.222.333/0001-81"), mensagem);
  assert(mensagem.includes("base de cálculo"), mensagem);
  assert(mensagem.includes("não é o valor que você recebe de volta"), mensagem);
});

Deno.test("resposta em linguagem natural resolve pelo patch local, sem IA", async () => {
  // A frase (com o CNPJ trocado pelo sintetico) veio de uma conversa real em
  // que a resposta NAO foi reconhecida: a mensagem seguiu para o classificador
  // de intencao, virou "despesa nova", o Gemini devolveu valor 0 e o insert
  // bateu na constraint recibos_valor_positivo_chk. Nenhum recibo, nenhuma
  // resposta ao usuario.
  semear();
  const { corpo } = await resolver(comDocumento(`cnpj dele é ${CNPJ}`));

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(corpo.promovido, true);
  // O que sustenta a promocao deterministica: nenhuma reclassificacao, nenhum
  // risco de reescrever uma analise ja auditada.
  assertEquals(chamadasGemini, 0);
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
});

Deno.test("sobrando outro campo bloqueante, preenche mas nao promove", async () => {
  semear({ camposBloqueantes: ["documento_prestador", "estabelecimento"] });
  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(recibo().requer_revisao_humana, true);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(recibo().deducibilidade, "INDETERMINADO");
  assertEquals(recibo().metadados_ia.campos_bloqueantes, ["estabelecimento"]);
});

Deno.test("sem deducibilidade_se_desbloqueado declarada, promocao nao inventa", async () => {
  semear({ deducibilidadeSeDesbloqueado: null });
  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.promovido, true);
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
  // Afirmar DEDUTIVEL sem ninguem ter analisado seria pior do que manter.
  assertEquals(recibo().deducibilidade, "INDETERMINADO");
});

Deno.test("duas execucoes que leem a mesma pendencia: so uma resolve", async () => {
  semear();

  // A segunda so comeca depois de a primeira ter LIDO a pendencia e ficado
  // presa antes do UPDATE. As duas passaram do SELECT; a disputa e no claim.
  const leu = new Promise<void>((resolve) => {
    leituraFeita = resolve;
  });
  segurarProximoPatch = true;

  const primeira = resolver(comDocumento());
  await leu;
  leituraFeita = null;

  const segunda = await resolver(comDocumento());
  liberarPatch?.();
  const resultadoPrimeira = await primeira;

  const resolvidas = [resultadoPrimeira, segunda].filter((r) => r.corpo.resolvido);
  assertEquals(resolvidas.length, 1, JSON.stringify([resultadoPrimeira.corpo, segunda.corpo]));
  // E o recibo foi promovido uma vez so.
  assertEquals(recibo().metadados_ia.followups.length, 1);
  assertEquals(followup().resolucao, "CAMPO_PREENCHIDO");
});

Deno.test("pendencia vencida e descartada sem tocar no recibo", async () => {
  semear({ expiraEmMinutos: -1 });
  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "PENDENCIA_EXPIRADA");
  assertEquals(followup().descartada_motivo, "EXPIRADA");
  assertEquals(recibo().documento_prestador, null);
  assertEquals(recibo().status, "REVISAO_HUMANA");
});

Deno.test("followup de outro dono nao resolve", async () => {
  semear();
  const { corpo } = await resolver({ ...comDocumento(), usuario_id: OUTRO_USUARIO });

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "PENDENCIA_INDISPONIVEL");
  assertEquals(recibo().documento_prestador, null);
  // Nao foi descartada: a pendencia legitima do dono continua valendo.
  assertEquals(followup().descartada_em, null);
});

// --- modo reclassificacao -------------------------------------------------

const blocoExpense = (expense: Record<string, unknown>) =>
  `Anotado.\n<expense>${JSON.stringify(expense)}</expense>`;

Deno.test("texto livre vira reclassificacao, ao lado da analise original", async () => {
  semear();
  // valor e data DIFERENTES dos gravados de proposito: se a function copiasse
  // esses campos da analise nova, o teste veria. Com os mesmos valores do
  // recibo, um "valor: analise.valor ?? recibo.valor" passaria despercebido.
  respostaGemini = blocoExpense({
    descricao: "Consulta com psicologo",
    valor: 999,
    data_despesa: "2020-01-01",
    estabelecimento: "Clinica Vida",
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "DEDUTIVEL",
    justificativa_deducibilidade: "Servico de psicologia identificado.",
    confidence_score: 0.9,
    requer_revisao_humana: false,
    motivos_revisao: [],
    campos_bloqueantes: [],
  });

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "nao tenho o cnpj, mas foi consulta com psicologo na clinica",
  });

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "RECLASSIFICADO");
  assertEquals(corpo.promovido, true);
  assertEquals(chamadasGemini, 1);

  assertEquals(recibo().deducibilidade, "DEDUTIVEL");
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");

  // Valor e data nao sao reescritos por texto de follow-up.
  assertEquals(Number(recibo().valor), 450);
  assertEquals(recibo().data_despesa, "2026-08-08");

  // A analise original permanece; a nova entra na lista.
  assertEquals(recibo().metadados_ia.motivos_revisao, ["Falta documento do prestador"]);
  assertEquals(recibo().metadados_ia.reclassificacoes.length, 1);
  assertEquals(
    recibo().metadados_ia.reclassificacoes[0].analise.descricao,
    "Consulta com psicologo",
  );
  assertEquals(followup().resolucao, "RECLASSIFICADO");
});

Deno.test("reclassificacao que continua pedindo revisao nao promove", async () => {
  semear();
  respostaGemini = blocoExpense({
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    requer_revisao_humana: true,
    motivos_revisao: ["Possivel reembolso pelo plano"],
    campos_bloqueantes: [],
  });

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "acho que o plano reembolsa parte",
  });

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(recibo().requer_revisao_humana, true);
});

Deno.test("reclassificacao contraditoria nao promove: quem manda e a derivacao", async () => {
  // A analise nova diz que nao precisa de revisao E ao mesmo tempo declara para
  // onde iria se o prestador fosse identificado — que continua sem documento e
  // sem estabelecimento. Sao afirmacoes incompativeis, e a leitura conservadora
  // e a segunda: ainda falta identificar.
  //
  // A distincao so existe porque a lista deixou de vir da IA. Com o
  // campos_bloqueantes vazio abaixo, o codigo anterior teria promovido.
  semear();
  respostaGemini = blocoExpense({
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    estabelecimento: null,
    documento_prestador: null,
    requer_revisao_humana: false,
    motivos_revisao: [],
    campos_bloqueantes: [],
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
  });

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "foi uma consulta mesmo, mas nao tenho papel nenhum aqui",
  });

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(recibo().metadados_ia.campos_bloqueantes, ["documento_prestador"]);
});

// --- resposta sem conteudo extraivel --------------------------------------

Deno.test('"Sim" nao fecha a pendencia, e o CNPJ seguinte ainda resolve', async () => {
  // A sequencia inteira do bug real: perguntamos o CNPJ do proctologista, a
  // pessoa respondeu "Sim", e a reclassificacao fechou a pendencia com
  // "Obrigado, anotei essa informacao na despesa" — sem ter anotado nada. O
  // CNPJ que veio depois nao tinha mais pendencia aberta para responder.
  semear();

  // Se a reclassificacao for chamada, o mock devolve uma analise que fecharia
  // a pendencia. E de proposito: o teste tem que provar que a function nao
  // chega ate ela, e nao que o Gemini se comportou bem.
  respostaGemini = blocoExpense({
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    estabelecimento: null,
    documento_prestador: null,
    requer_revisao_humana: true,
    motivos_revisao: ["Falta documento do prestador"],
  });

  const primeira = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "Sim",
  });

  assertEquals(primeira.corpo.resolvido, false);
  assertEquals(primeira.corpo.motivo, "SEM_CONTEUDO");
  // Nao ha o que reclassificar: a guarda vem antes da chamada de IA.
  assertEquals(chamadasGemini, 0);

  // A mensagem de volta e o que mudou na Fase 14. `resolvido: false` continua
  // igual — o n8n cai no mesmo node de saida —, mas o texto deixou de ser a
  // ajuda generica ("posso registrar despesas, mostrar seu resumo...") e passou
  // a dizer a unica coisa que importa aqui: a pergunta continua de pe. Ela
  // carrega a pergunta ORIGINAL, e nao um resumo dela, para nao existir uma
  // segunda versao da pergunta para manter em dia.
  assertEquals(primeira.corpo.mensagem, mensagemPerguntaSegueAberta(PERGUNTA));
  assert(String(primeira.corpo.mensagem).endsWith(PERGUNTA));

  // A pendencia continua aberta e o recibo intacto.
  assertEquals(followup().respondida_em, null);
  assertEquals(followup().descartada_em, null);
  assertEquals(followup().resolucao, null);
  assertEquals(recibo().documento_prestador, null);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(recibo().metadados_ia.reclassificacoes, undefined);

  // E a mensagem seguinte, agora com o documento, resolve normalmente.
  const segunda = await resolver(comDocumento(`o cnpj é ${CNPJ}`));

  assertEquals(segunda.corpo.resolvido, true);
  assertEquals(segunda.corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(segunda.corpo.promovido, true);
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
  assertEquals(followup().resolucao, "CAMPO_PREENCHIDO");
});

Deno.test("confirmacao e negacao secas nunca fecham a pendencia", async () => {
  // As dez respostas medidas contra o Gemini real, onde 22 de 30 execucoes
  // reclassificaram — de forma instavel, com "Sim" fechando 1/3 e "sim" 2/3.
  // A guarda deterministica tira o desfecho do sorteio.
  for (const texto of [
    "Sim",
    "sim",
    "ok",
    "beleza",
    "tenho sim",
    "com certeza",
    "claro",
    "isso",
    "aham",
    "nao tenho",
    "não tenho",
    "obrigado",
    "já mando",
  ]) {
    semear();
    // Qualquer chamada de IA aqui ja seria falha: nao ha o que reclassificar.
    respostaGemini = null;

    const { corpo } = await resolver({
      followup_id: FOLLOWUP_ID,
      usuario_id: USUARIO_ID,
      texto,
    });

    assertEquals(corpo.resolvido, false, texto);
    assertEquals(corpo.motivo, "SEM_CONTEUDO", texto);
    assertEquals(chamadasGemini, 0, texto);
    assertEquals(followup().respondida_em, null, texto);
    assertEquals(recibo().status, "REVISAO_HUMANA", texto);
  }
});

Deno.test("texto com conteudo continua chegando a reclassificacao", async () => {
  // O contrapeso do teste acima: a guarda nao pode engolir resposta de
  // verdade. "nao tenho o papel" comeca igual a uma negacao seca e termina
  // dizendo o que foi a despesa.
  semear();
  respostaGemini = blocoExpense({
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    estabelecimento: "Clinica Vida",
    documento_prestador: null,
    requer_revisao_humana: true,
    motivos_revisao: ["Falta documento do prestador"],
  });

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "nao tenho o papel, mas foi na Clinica Vida",
  });

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "RECLASSIFICADO");
  assertEquals(chamadasGemini, 1);
  assertEquals(recibo().estabelecimento, "Clinica Vida");
});

Deno.test("mensagem sem relacao nao mexe no recibo nem fecha a pendencia", async () => {
  semear();
  respostaGemini = "SEM_RELACAO";

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "qual o horario de atendimento de voces?",
  });

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "SEM_RELACAO");
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(followup().respondida_em, null);
  assertEquals(followup().descartada_em, null);
});

Deno.test("IA indisponivel nao derruba nem fecha a pendencia", async () => {
  semear();
  respostaGemini = null; // o stub responde 500

  const { status, corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "foi na clinica da esquina",
  });

  assertEquals(status, 200);
  assertEquals(corpo.resolvido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(followup().respondida_em, null);
});

// --- documento digitado errado (Fase 14, varredura) -----------------------

Deno.test("CNPJ com digito trocado nao chega na IA e nao fecha a pendencia", async () => {
  // O caso medido contra o Gemini real: `11.222.333/0001-82`, um digito fora
  // do lugar. A extracao deterministica recusa (certo), e sem esta guarda a
  // mensagem ia para a reclassificacao — que gravava o numero invalido em
  // documento_prestador e promovia a despesa para DEDUTIVEL sem revisao, em
  // 3 de 3 execucoes. O caminho de IA desfazia a validacao de digito
  // verificador que o caminho deterministico existe para fazer.
  semear();

  // Se a IA for chamada, o mock devolve uma analise que fecharia a pendencia.
  // De proposito: o teste tem que provar que a function nao chega ate ela.
  respostaGemini = blocoExpense({
    categoria: "SAUDE",
    deducibilidade: "DEDUTIVEL",
    documento_prestador: "11.222.333/0001-82",
    requer_revisao_humana: false,
    motivos_revisao: [],
  });

  const { corpo } = await resolver(comDocumento("o cnpj é 11.222.333/0001-82"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "DOCUMENTO_INVALIDO");
  assertEquals(chamadasGemini, 0);

  // A pendencia continua aberta: quem trocou um digito tem o numero em maos.
  assertEquals(followup().respondida_em, null);
  assertEquals(followup().descartada_em, null);
  assertEquals(recibo().documento_prestador, null);
  assertEquals(recibo().status, "REVISAO_HUMANA");

  // E a mensagem diz o que aconteceu, em vez do texto de ajuda generico.
  const mensagem: string = corpo.mensagem;
  assert(mensagem.includes("não fecha"), mensagem);

  // Corrigido o digito, a mesma pendencia resolve normalmente.
  const segunda = await resolver(comDocumento(`o cnpj é ${CNPJ}`));
  assertEquals(segunda.corpo.resolvido, true);
  assertEquals(segunda.corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
});

Deno.test("pergunta de estabelecimento nao trata numero como documento errado", async () => {
  // A guarda so vale quando a pergunta era pelo documento. Numero em resposta
  // a "onde foi essa despesa?" nao e documento digitado errado.
  semear();
  db.followups_pendentes[0].campo_alvo = "estabelecimento";
  db.followups_pendentes[0].pergunta = perguntaParaCampo("estabelecimento");
  respostaGemini = null;

  const { corpo } = await resolver(comDocumento("11.222.333/0001-82"));

  assertEquals(corpo.motivo, "SEM_RELACAO");
  assertEquals(chamadasGemini, 1);
});

Deno.test("documento nao conferido vindo da IA nao entra no recibo", async () => {
  // Segunda camada: mesmo com a guarda, a analise pode devolver um documento
  // que ninguem digitou. Gravar documento nao conferido e pior do que nao
  // gravar nada — ele viraria evidencia no dossie do contador.
  semear();
  respostaGemini = blocoExpense({
    descricao: "Consulta com psicologo",
    estabelecimento: "Clinica Vida",
    documento_prestador: "11.222.333/0001-82",
    categoria: "SAUDE",
    deducibilidade: "DEDUTIVEL",
    requer_revisao_humana: false,
    motivos_revisao: [],
  });

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "foi na clinica vida, consulta com psicologo",
  });

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "RECLASSIFICADO");
  // O estabelecimento entra; o documento invalido, nao.
  assertEquals(recibo().estabelecimento, "Clinica Vida");
  assertEquals(recibo().documento_prestador, null);
  // A analise crua fica na trilha, com o documento que a IA propos — o que foi
  // recusado foi a promocao dele a campo do recibo.
  assertEquals(
    recibo().metadados_ia.reclassificacoes[0].analise.documento_prestador,
    "11.222.333/0001-82",
  );
});

// --- Fase 15: modo REEMBOLSO_INFORMADO ------------------------------------
//
// Este modo nao passa pela IA em nenhum caminho, e os testes conferem isso em
// cada cenario (chamadasGemini === 0). Nao e detalhe de implementacao: mandar a
// resposta para o modelo abriria a porta de promover a despesa com o reembolso
// ainda em aberto, que e a inconsistencia com a DMED que a fase existe para
// impedir.

const PERGUNTA_REEMBOLSO = perguntaParaCampo(CAMPO_REEMBOLSO);

function semearReembolso(opcoes: {
  valor?: number;
  deducibilidadeSeSemReembolso?: string | null;
  estabelecimento?: string | null;
  documento?: string | null;
  requerRevisao?: boolean;
  deducibilidade?: string;
} = {}) {
  db.followups_pendentes = [{
    id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    recibo_id: RECIBO_ID,
    sessao_whatsapp_id: SESSAO_ID,
    campo_alvo: CAMPO_REEMBOLSO,
    pergunta: PERGUNTA_REEMBOLSO,
    mensagens_restantes: 2,
    expira_em: new Date(Date.now() + 20 * MINUTO).toISOString(),
    respondida_em: null,
    resolucao: null,
    descartada_em: null,
    descartada_motivo: null,
    criado_em: new Date().toISOString(),
  }];

  db.recibos_evidencias = [{
    id: RECIBO_ID,
    usuario_id: USUARIO_ID,
    descricao: "Consulta com dermatologista",
    valor: opcoes.valor ?? 400,
    data_despesa: "2026-08-08",
    estabelecimento: opcoes.estabelecimento === undefined ? "Clinica Vida" : opcoes.estabelecimento,
    documento_prestador: opcoes.documento ?? null,
    categoria: "SAUDE",
    deducibilidade: opcoes.deducibilidade ?? "INDETERMINADO",
    justificativa_deducibilidade: "Possivel reembolso pelo plano.",
    confidence_score: 0.8,
    status: "REVISAO_HUMANA",
    requer_revisao_humana: opcoes.requerRevisao ?? true,
    valor_reembolsado: null,
    metadados_ia: {
      motivos_revisao: ["Necessario confirmar ausencia de reembolso"],
      campos_ausentes: [],
      campos_bloqueantes: [],
      possui_indicio_reembolso: true,
      deducibilidade_se_desbloqueado: null,
      deducibilidade_se_sem_reembolso: opcoes.deducibilidadeSeSemReembolso === undefined
        ? "DEDUTIVEL"
        : opcoes.deducibilidadeSeSemReembolso,
    },
  }];

  respostaGemini = null;
  chamadasGemini = 0;
}

const comReembolso = (texto: string) => ({
  followup_id: FOLLOWUP_ID,
  usuario_id: USUARIO_ID,
  texto,
});

Deno.test("reembolso negado grava zero e promove a despesa", async () => {
  semearReembolso();
  await aguardarFunction();

  const { corpo } = await resolver(comReembolso("não"));

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "REEMBOLSO_INFORMADO");
  assertEquals(corpo.promovido, true);
  assertEquals(chamadasGemini, 0);

  // Zero e resposta, nao ausencia: e o que prova ao contador que a pergunta foi
  // feita e respondida.
  assertEquals(recibo().valor_reembolsado, 0);
  assertEquals(recibo().valor, 400);
  assertEquals(recibo().deducibilidade, "DEDUTIVEL");
  assertEquals(recibo().requer_revisao_humana, false);
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
  assertEquals(followup().resolucao, "REEMBOLSO_INFORMADO");
});

Deno.test("reembolso parcial mantem o bruto e grava o abatimento ao lado", async () => {
  semearReembolso({ valor: 400 });

  const { corpo } = await resolver(comReembolso("o plano cobriu 150"));

  assertEquals(corpo.resolvido, true);
  assertEquals(chamadasGemini, 0);

  // A regra que nao pode cair: valor continua sendo o bruto que a nota comprova.
  assertEquals(recibo().valor, 400);
  assertEquals(recibo().valor_reembolsado, 150);

  // Reembolso parcial NAO e PARCIALMENTE_DEDUTIVEL: aquele status e uso misto
  // pessoal/profissional. O liquido de 250 e integralmente dedutivel.
  assertEquals(recibo().deducibilidade, "DEDUTIVEL");

  const trilha = recibo().metadados_ia.followups[0];
  assertEquals(trilha.modo, "REEMBOLSO_INFORMADO");
  assertEquals(trilha.valor_bruto, 400);
  assertEquals(trilha.valor_reembolsado, 150);
  assertEquals(trilha.valor_liquido_dedutivel, 250);
  assertEquals(trilha.integral, false);

  // A conta aparece inteira na mensagem: esconder o bruto faria a pessoa achar
  // que perdeu parte da despesa.
  assert(corpo.mensagem.includes("R$ 400,00"), corpo.mensagem);
  assert(corpo.mensagem.includes("R$ 150,00"), corpo.mensagem);
  assert(corpo.mensagem.includes("R$ 250,00"), corpo.mensagem);
});

Deno.test("reembolso integral zera a deducao sem passar por IA", async () => {
  semearReembolso({ valor: 300, deducibilidade: "DEDUTIVEL" });

  const { corpo } = await resolver(comReembolso("300"));

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(chamadasGemini, 0);

  assertEquals(recibo().valor, 300);
  assertEquals(recibo().valor_reembolsado, 300);
  // Rebaixamento legitimo: quem afirmou que voltou tudo foi o titular, e nao
  // sobra base de calculo. A regra de "promocao nunca rebaixa" protege contra
  // variacao do modelo, e aqui nao ha modelo no caminho.
  assertEquals(recibo().deducibilidade, "NAO_DEDUTIVEL");
  assertEquals(recibo().requer_revisao_humana, false);
  assertEquals(recibo().metadados_ia.followups[0].integral, true);
});

Deno.test("reembolso maior que a despesa nao consome a pendencia", async () => {
  semearReembolso({ valor: 400 });

  const { corpo } = await resolver(comReembolso("4000"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "REEMBOLSO_MAIOR_QUE_DESPESA");
  assert(corpo.mensagem.includes("R$ 400,00"), corpo.mensagem);

  // Nada gravado e pendencia intacta: a constraint da migration 010 barraria o
  // update, e a execucao morreria DEPOIS de reivindicar — sem resposta ao
  // usuario e sem pendencia para tentar de novo.
  assertEquals(recibo().valor_reembolsado, null);
  assertEquals(followup().respondida_em, null);
  assertEquals(followup().descartada_em, null);
});

Deno.test("sim sem valor pede o valor e deixa a pergunta de pe", async () => {
  semearReembolso();

  const { corpo } = await resolver(comReembolso("sim"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "REEMBOLSO_SEM_VALOR");
  assert(corpo.mensagem.includes("quanto"), corpo.mensagem);
  assertEquals(chamadasGemini, 0);

  assertEquals(recibo().valor_reembolsado, null);
  assertEquals(followup().respondida_em, null);
});

Deno.test("resposta nao reconhecida repete a pergunta sem fechar nada", async () => {
  semearReembolso();

  const { corpo } = await resolver(comReembolso("o plano cobriu metade"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "REEMBOLSO_NAO_RECONHECIDO");
  assertEquals(corpo.mensagem, mensagemPerguntaSegueAberta(PERGUNTA_REEMBOLSO));
  // Nenhuma chamada de IA: o espaco de respostas aqui e fechado, e mandar o
  // texto ao modelo poderia promover a despesa com o reembolso em aberto.
  assertEquals(chamadasGemini, 0);
  assertEquals(recibo().valor_reembolsado, null);
  assertEquals(followup().respondida_em, null);
});

Deno.test("mensagem sem conteudo cai na guarda de ontem, nao na de reembolso", async () => {
  semearReembolso();

  const { corpo } = await resolver(comReembolso("ok"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "SEM_CONTEUDO");
  assertEquals(corpo.mensagem, mensagemPerguntaSegueAberta(PERGUNTA_REEMBOLSO));
  assertEquals(followup().respondida_em, null);
});

Deno.test("promocao exige identificacao no recibo, alem do destino declarado", async () => {
  // Medido na varredura: o Gemini devolve deducibilidade_se_sem_reembolso
  // "DEDUTIVEL" em despesa sem prestador nenhum ("consulta 400 reais, usei o
  // convenio"). Sem esta checagem, responder "nao" aprovaria automaticamente
  // uma despesa de saude sem prestador — o oposto do que o follow-up de
  // identificacao existe para garantir.
  semearReembolso({ estabelecimento: null, documento: null });

  const { corpo } = await resolver(comReembolso("não"));

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().valor_reembolsado, 0);
  assertEquals(recibo().requer_revisao_humana, true);
  assertEquals(recibo().status, "REVISAO_HUMANA");
});

Deno.test("sem destino declarado a despesa fica onde estava", async () => {
  semearReembolso({ deducibilidadeSeSemReembolso: null });

  const { corpo } = await resolver(comReembolso("nao houve"));

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().valor_reembolsado, 0);
  assertEquals(recibo().deducibilidade, "INDETERMINADO");
  assertEquals(recibo().requer_revisao_humana, true);
});

Deno.test("despesa nova nao fecha a pendencia de reembolso", async () => {
  semearReembolso();

  const { corpo } = await resolver(comReembolso("paguei 300 no mercado"));

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "REEMBOLSO_NAO_RECONHECIDO");
  assertEquals(recibo().valor_reembolsado, null);
  assertEquals(followup().respondida_em, null);
});

Deno.test("duas respostas concorrentes gravam o reembolso uma vez so", async () => {
  semearReembolso({ valor: 400 });

  // Mesma barreira do teste de concorrencia do documento: sem segurar o PATCH
  // da primeira ate a segunda ter lido, a segunda ja encontra a linha
  // reivindicada no SELECT e o UPDATE nem e exercitado.
  segurarProximoPatch = true;
  const segundaLeu = new Promise<void>((resolve) => {
    leituraFeita = resolve;
  });

  const primeira = resolver(comReembolso("120"));
  await segundaLeu;
  leituraFeita = null;

  const segunda = resolver(comReembolso("200"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  liberarPatch?.();

  const [a, b] = await Promise.all([primeira, segunda]);
  const resolvidos = [a, b].filter((r) => r.corpo.resolvido);
  assertEquals(resolvidos.length, 1);

  // Um valor so gravado, e um registro so na trilha.
  assertEquals(recibo().valor_reembolsado, 120);
  assertEquals(recibo().metadados_ia.followups.length, 1);
});

// --- Fase 16: encadeamento reativo ----------------------------------------
//
// Teste de aceite das DUAS sequencias reais de WhatsApp que abriram a fase. Os
// numeros de cada analise foram medidos contra o Gemini de producao antes de
// qualquer codigo ser escrito, e estao anotados em cada fixture: o que se testa
// aqui e a decisao da function sobre aquela analise, nao a redacao do modelo.

const PERGUNTA_CNPJ_SEM_LUGAR = perguntaParaCampo("documento_prestador");

/**
 * Sequencia 1, passo 1 — "Paguei 500 na consulta e com convenio".
 *
 * Medido 3/3 no Gemini real. Os dois campos que importam:
 *   possui_indicio_reembolso: true  -> a vaga vai para a pergunta de reembolso
 *   deducibilidade_se_desbloqueado: null -> o prompt manda anular quando ha
 *     indicio de reembolso, e e por isso que a reavaliacao precisa do destino
 *     RESIDUAL (deducibilidade_se_sem_reembolso). Lendo o campo cru, a
 *     derivacao devolveria [] e a sequencia 1 continuaria quebrada.
 */
function semearSequencia1() {
  db.followups_pendentes = [{
    id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    recibo_id: RECIBO_ID,
    sessao_whatsapp_id: SESSAO_ID,
    campo_alvo: CAMPO_REEMBOLSO,
    pergunta: PERGUNTA_REEMBOLSO,
    mensagens_restantes: 2,
    expira_em: new Date(Date.now() + 20 * MINUTO).toISOString(),
    respondida_em: null,
    resolucao: null,
    descartada_em: null,
    descartada_motivo: null,
    criado_em: new Date().toISOString(),
  }];

  db.recibos_evidencias = [{
    id: RECIBO_ID,
    usuario_id: USUARIO_ID,
    descricao: "Consulta medica",
    valor: 500,
    valor_reembolsado: null,
    data_despesa: "2026-08-10",
    estabelecimento: null,
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    justificativa_deducibilidade: "Possivel reembolso pelo convenio.",
    confidence_score: 0.8,
    status: "REVISAO_HUMANA",
    requer_revisao_humana: true,
    metadados_ia: {
      motivos_revisao: ["Indicio de reembolso pelo convenio", "Falta identificacao do prestador"],
      campos_ausentes: ["documento_prestador"],
      campos_bloqueantes: [],
      possui_indicio_reembolso: true,
      deducibilidade_se_desbloqueado: null,
      deducibilidade_se_sem_reembolso: "DEDUTIVEL",
    },
  }];

  respostaGemini = null;
  chamadasGemini = 0;
}

Deno.test("ACEITE seq1: reembolso respondido encadeia a pergunta do CNPJ", async () => {
  semearSequencia1();
  await aguardarFunction();

  // Passo 2 do transcript: "Não teve reembolso".
  const passo2 = await resolver(comReembolso("Não teve reembolso"));

  assertEquals(passo2.corpo.resolvido, true);
  assertEquals(passo2.corpo.modo, "REEMBOLSO_INFORMADO");
  // Sem identificacao no recibo a promocao continua barrada, como antes.
  assertEquals(passo2.corpo.promovido, false);
  assertEquals(recibo().valor_reembolsado, 0);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  // O modo de reembolso nao chama IA em caminho nenhum, e o encadeamento nao
  // podia mudar isso: a pergunta seguinte e derivada, nao redigida pelo modelo.
  assertEquals(chamadasGemini, 0);

  // O que a fase adiciona: a pergunta seguinte existe.
  const aberta = pendenciaAberta();
  assert(aberta, "nenhuma pendencia encadeada foi aberta");
  assertEquals(aberta.campo_alvo, "documento_prestador");
  assertEquals(aberta.recibo_id, RECIBO_ID);
  // Herdada da pendencia que acabou de resolver (ponto 6 do desenho).
  assertEquals(aberta.sessao_whatsapp_id, SESSAO_ID);
  // Orcamento e TTL novos: a pergunta e nova, e o relogio da anterior ja correu.
  assertEquals(aberta.mensagens_restantes, 2);

  // Uma mensagem so, com a pergunta colada no fim.
  const mensagem: string = passo2.corpo.mensagem;
  assert(mensagem.startsWith("Anotei que não houve reembolso"), mensagem);
  assert(mensagem.endsWith(PERGUNTA_CNPJ_SEM_LUGAR), mensagem);

  // Passo 3 do transcript: o CNPJ que antes virava "não consegui identificar o
  // valor dessa despesa". Agora ha pendencia aberta para ele responder.
  const passo3 = await resolver({
    followup_id: aberta.id,
    usuario_id: USUARIO_ID,
    texto: `o cnpj é ${CNPJ}`,
  });

  assertEquals(passo3.corpo.resolvido, true);
  assertEquals(passo3.corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(passo3.corpo.promovido, true);
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");

  // O destino residual em acao. Sem ele a promocao cairia no fallback "mantem o
  // que estava" e a despesa terminaria APROVADO_AUTOMATICAMENTE com
  // INDETERMINADO — nem chega ao contador, nem conta como dedutivel.
  assertEquals(recibo().deducibilidade, "DEDUTIVEL");

  // As invariantes de sempre continuam de pe.
  assertEquals(Number(recibo().valor), 500);
  assertEquals(recibo().valor_reembolsado, 0);
  assertEquals(recibo().data_despesa, "2026-08-10");

  // A cadeia termina: nao ha terceiro campo, e nada reabre os dois ja feitos.
  assertEquals(pendenciaAberta(), null);
});

/**
 * Sequencia 2, passo 1 — "Paguei 799 no dentista".
 *
 * estabelecimento NULL de proposito, e nao pela media das execucoes: medido
 * 1/3 no passo 1, e e o UNICO ramo em que o passo 2 reproduz o bug relatado.
 * Com estabelecimento preenchido, "Foi do convenio" volta SEM_RELACAO 6/6 e a
 * pendencia nem chega a fechar. Testar a media esconderia o caso.
 */
function semearSequencia2() {
  db.followups_pendentes = [{
    id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    recibo_id: RECIBO_ID,
    sessao_whatsapp_id: SESSAO_ID,
    campo_alvo: "documento_prestador",
    pergunta: PERGUNTA_CNPJ_SEM_LUGAR,
    mensagens_restantes: 2,
    expira_em: new Date(Date.now() + 20 * MINUTO).toISOString(),
    respondida_em: null,
    resolucao: null,
    descartada_em: null,
    descartada_motivo: null,
    criado_em: new Date().toISOString(),
  }];

  db.recibos_evidencias = [{
    id: RECIBO_ID,
    usuario_id: USUARIO_ID,
    descricao: "Consulta odontologica",
    valor: 799,
    valor_reembolsado: null,
    data_despesa: "2026-08-10",
    estabelecimento: null,
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    justificativa_deducibilidade: "Falta identificacao do prestador.",
    confidence_score: 0.8,
    status: "REVISAO_HUMANA",
    requer_revisao_humana: true,
    metadados_ia: {
      motivos_revisao: ["Falta identificacao do prestador"],
      campos_ausentes: ["documento_prestador"],
      campos_bloqueantes: [],
      possui_indicio_reembolso: false,
      deducibilidade_se_desbloqueado: "DEDUTIVEL",
      deducibilidade_se_sem_reembolso: null,
    },
  }];

  // A analise que o Gemini real devolveu para "Foi do convenio" neste recibo,
  // 6/6: reclassifica, nao identifica ninguem, e acende o indicio de reembolso.
  // Era exatamente este booleano que a Fase 15 gravava na trilha e descartava.
  respostaGemini = blocoExpense({
    descricao: "Consulta odontologica",
    estabelecimento: null,
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    requer_revisao_humana: true,
    motivos_revisao: ["Falta identificacao do prestador", "Indicio de reembolso pelo convenio"],
    possui_indicio_reembolso: true,
    deducibilidade_se_desbloqueado: null,
    deducibilidade_se_sem_reembolso: "DEDUTIVEL",
  });
  chamadasGemini = 0;
}

Deno.test("ACEITE seq2: reclassificacao acende o reembolso e ele vira pergunta", async () => {
  semearSequencia2();

  // Passo 2 do transcript: "Foi do convênio".
  const passo2 = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "Foi do convênio",
  });

  assertEquals(passo2.corpo.resolvido, true);
  assertEquals(passo2.corpo.modo, "RECLASSIFICADO");
  assertEquals(passo2.corpo.promovido, false);
  assertEquals(chamadasGemini, 1);

  // O sinal que antes morria na trilha agora vira pergunta.
  const aberta = pendenciaAberta();
  assert(aberta, "o indicio de reembolso da analise nova nao virou pendencia");
  assertEquals(aberta.campo_alvo, CAMPO_REEMBOLSO);
  assertEquals(aberta.recibo_id, RECIBO_ID);

  const mensagem: string = passo2.corpo.mensagem;
  assert(mensagem.startsWith("Obrigado, anotei essa informação"), mensagem);
  assert(mensagem.endsWith(PERGUNTA_REEMBOLSO), mensagem);

  // E a analise crua continua inteira na trilha, ao lado da original.
  assertEquals(
    recibo().metadados_ia.reclassificacoes[0].analise.possui_indicio_reembolso,
    true,
  );

  // Passo 3: a resposta ao reembolso fecha o que dava para fechar.
  const passo3 = await resolver({
    followup_id: aberta.id,
    usuario_id: USUARIO_ID,
    texto: "não",
  });

  assertEquals(passo3.corpo.resolvido, true);
  assertEquals(passo3.corpo.modo, "REEMBOLSO_INFORMADO");
  assertEquals(recibo().valor_reembolsado, 0);
  // Sem identificacao, continua em revisao — correto, e o mesmo freio da Fase 15.
  assertEquals(passo3.corpo.promovido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
});

Deno.test("a cadeia nunca repete um campo ja perguntado", async () => {
  // O freio que torna verdadeira a invariante "no maximo dois passos". Sem ele,
  // uma reclassificacao que nao preencheu o documento reabriria a MESMA pergunta
  // que acabou de fechar, e a resposta seguinte reabriria de novo — laco
  // limitado so pelo TTL e pelo orcamento de mensagens.
  semearSequencia2();

  await resolver({ followup_id: FOLLOWUP_ID, usuario_id: USUARIO_ID, texto: "Foi do convênio" });
  const reembolso = pendenciaAberta()!;
  assertEquals(reembolso.campo_alvo, CAMPO_REEMBOLSO);

  await resolver({ followup_id: reembolso.id, usuario_id: USUARIO_ID, texto: "não" });

  // documento_prestador ja foi perguntado no passo 1 e nao voltou a fila, mesmo
  // com o recibo ainda sem identificacao e com destino residual declarado.
  assertEquals(pendenciaAberta(), null);
  const perguntados = db.followups_pendentes.map((f) => f.campo_alvo);
  assertEquals(perguntados, ["documento_prestador", CAMPO_REEMBOLSO]);
});

Deno.test("recibo promovido nao ganha pergunta nova", async () => {
  // O caso mais comum de todos: o documento chegou, a despesa foi promovida e
  // nao ha mais nada a desbloquear. Perguntar ali seria atrito puro sobre uma
  // despesa ja resolvida.
  semear();

  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.promovido, true);
  assertEquals(recibo().status, "APROVADO_AUTOMATICAMENTE");
  assertEquals(pendenciaAberta(), null);
  // E a mensagem termina na confirmacao, sem pergunta colada.
  assert(!String(corpo.mensagem).includes("Para confirmar se é dedutível"), corpo.mensagem);
});

Deno.test("reembolso ja gravado nao vira pergunta, mesmo sem tê-lo perguntado", async () => {
  // As duas guardas do encadeamento respondem perguntas DIFERENTES, e este e o
  // unico teste que as separa:
  //
  //   camposJaPerguntados   -> "eu ja perguntei isso?"   (conversacional)
  //   valor_reembolsado !== null -> "eu ja sei a resposta?" (factual)
  //
  // Em toda sequencia alcancavel hoje as duas coincidem, porque a unica forma de
  // valor_reembolsado ser preenchido e respondendo a pergunta de reembolso — e
  // por isso remover a segunda nao quebrava teste nenhum. A factual e a mais
  // robusta das duas: se algum caminho futuro gravar a coluna sem ter conversado
  // (correcao do contador, importacao do plano), so ela segura a pergunta.
  //
  // O cenario: pendencia de documento_prestador, reembolso JA registrado, e a
  // analise ainda declarando possui_indicio_reembolso true.
  //
  // O recibo precisa continuar em revisao depois do patch, senao a execucao para
  // no primeiro freio de proximaPergunta ("recibo promovido nao ganha pergunta")
  // e a guarda de reembolso nem chega a ser consultada — foi assim que a
  // primeira versao deste teste passou com a guarda arrancada.
  semear({ camposBloqueantes: ["documento_prestador", "estabelecimento"] });
  db.recibos_evidencias[0].valor_reembolsado = 120;
  db.recibos_evidencias[0].estabelecimento = null;
  db.recibos_evidencias[0].metadados_ia.possui_indicio_reembolso = true;
  db.recibos_evidencias[0].metadados_ia.deducibilidade_se_sem_reembolso = "DEDUTIVEL";
  // Historico limpo: nenhuma pendencia de reembolso jamais existiu neste recibo,
  // entao camposJaPerguntados nao tem como ajudar.
  respostaGemini = null;

  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.resolvido, true);
  assertEquals(corpo.modo, "CAMPO_PREENCHIDO");
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  // Nenhuma pergunta: o numero ja esta na coluna, e nenhuma IA foi chamada.
  assertEquals(pendenciaAberta(), null);
  assertEquals(chamadasGemini, 0);
});

Deno.test("documento preenchido nao gera pergunta de estabelecimento", async () => {
  // A regra fiscal de SAUDE pede prestador OU estabelecimento, entao o CNPJ
  // fecha o requisito inteiro. derivarCamposBloqueantes olha campo a campo e
  // devolveria "estabelecimento" aqui — num lancamento novo isso nunca aparecia,
  // porque a pendencia nascia uma vez so; com encadeamento, apareceria em todo
  // CAMPO_PREENCHIDO de recibo sem nome de lugar.
  semear({ camposBloqueantes: ["documento_prestador", "estabelecimento"] });
  db.recibos_evidencias[0].estabelecimento = null;

  const { corpo } = await resolver(comDocumento());

  assertEquals(corpo.resolvido, true);
  // Continua em revisao (sobrou bloqueante na lista semeada), entao o freio nao
  // e o "recibo promovido" — e a identificacao ja satisfeita.
  assertEquals(corpo.promovido, false);
  assertEquals(recibo().status, "REVISAO_HUMANA");
  assertEquals(recibo().documento_prestador, "11.222.333/0001-81");
  assertEquals(pendenciaAberta(), null);
});

Deno.test("reembolso integral nao encadeia: nao ha o que desbloquear", async () => {
  // Fecha em NAO_DEDUTIVEL com requer_revisao_humana false. Mesmo sem
  // identificacao no recibo, nenhum CNPJ mudaria o desfecho.
  semearReembolso({ valor: 300, deducibilidade: "DEDUTIVEL", estabelecimento: null });

  const { corpo } = await resolver(comReembolso("300"));

  assertEquals(corpo.resolvido, true);
  assertEquals(recibo().deducibilidade, "NAO_DEDUTIVEL");
  assertEquals(pendenciaAberta(), null);
});

Deno.test("falha ao encadear nao derruba a resolucao que ja aconteceu", async () => {
  // Fail open, o principio que atravessa a fase inteira: a resposta ao usuario e
  // o patch no recibo ja existem quando o encadeamento roda. O pior caso e a
  // segunda pergunta nao ser feita, que e o comportamento de antes desta fase.
  semearSequencia1();
  falharRpc = true;

  try {
    const { status, corpo } = await resolver(comReembolso("não"));

    assertEquals(status, 200);
    assertEquals(corpo.resolvido, true);
    assertEquals(corpo.modo, "REEMBOLSO_INFORMADO");
    assertEquals(recibo().valor_reembolsado, 0);
    assertEquals(followup().resolucao, "REEMBOLSO_INFORMADO");
    // Mensagem sem pergunta colada, e nenhuma pendencia aberta — mas a
    // resolucao valeu e o usuario recebeu a confirmacao.
    assertEquals(corpo.mensagem, mensagemReembolsoNegadoSemPromocao());
    assertEquals(pendenciaAberta(), null);
  } finally {
    falharRpc = false;
  }
});

/** A confirmacao de "nao houve reembolso" sem promocao, exatamente como a
 *  function a monta. Literal aqui provaria so que eu sei copiar string. */
function mensagemReembolsoNegadoSemPromocao(): string {
  return [
    "Anotei que não houve reembolso nessa despesa.",
    "Ela continua marcada para revisão do contador, mas agora com essa informação registrada.",
  ].join("\n\n");
}

Deno.test("campo desconhecido na resolucao grava o mesmo rotulo da webhook", async () => {
  // Os dois componentes agora nomeiam a mesma condicao do mesmo jeito. Antes
  // eram "CAMPO_INVALIDO" aqui e "EXPIRADA" la, e reconstruir um incidente pela
  // tabela exigia adivinhar qual dos dois tinha escrito a linha.
  semear();
  db.followups_pendentes[0].campo_alvo = "campo_que_ainda_nao_existe";

  const { corpo } = await resolver({
    followup_id: FOLLOWUP_ID,
    usuario_id: USUARIO_ID,
    texto: "150 reais",
  });

  assertEquals(corpo.resolvido, false);
  assertEquals(corpo.motivo, "PENDENCIA_INDISPONIVEL");
  assertEquals(followup().descartada_motivo, "CAMPO_DESCONHECIDO");
  assertEquals(chamadasGemini, 0);
});
