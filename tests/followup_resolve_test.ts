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

async function postgrest(url: URL, init?: RequestInit): Promise<Response> {
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
