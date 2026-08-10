// Fase 12 - comportamento dos Code nodes editados nos workflows do n8n.
//
// Rodar:  deno test --allow-read tests/n8n_fase12_test.ts
//
// O teste carrega os EXPORTS reais de n8n/workflows/ e executa o jsCode dos
// nodes num arremedo minimo do runtime do n8n ($input, $("Node"), retorno
// { json }). Nao ha copia do codigo aqui de proposito: e o arquivo que sera
// importado na instancia que esta sob teste, entao editar o node e esquecer o
// teste quebra o teste, e nao o contrario.
//
// O que este teste NAO cobre: a chamada ao Gemini e a resposta do modelo (isso
// e tests/prompt_gemini_test.ts, que fala com a API de verdade) e o
// encadeamento real entre nodes dentro do n8n.

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RECEIPT = JSON.parse(
  await Deno.readTextFile("n8n/workflows/receipt-ocr-classification.json"),
);
const CONSULTA = JSON.parse(
  await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"),
);

function node(workflow: any, nome: string) {
  const alvo = workflow.nodes.find((n: any) => n.name === nome);
  if (!alvo) throw new Error(`node nao encontrado no export: ${nome}`);
  return alvo;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

type Contexto = {
  entrada: unknown;
  nodes?: Record<string, unknown>;
  self?: unknown;
};

async function rodarCodeNode(codigo: string, ctx: Contexto): Promise<any> {
  const pareado = (nome: string) => {
    if (!ctx.nodes || !(nome in ctx.nodes)) {
      throw new Error(`o node do teste nao expos "${nome}"`);
    }
    const json = (ctx.nodes as Record<string, unknown>)[nome];
    return { item: { json }, first: () => ({ json }) };
  };

  const itens = Array.isArray(ctx.entrada) ? ctx.entrada : [ctx.entrada];
  const $input = {
    item: { json: itens[0] },
    all: () => itens.map((json) => ({ json })),
  };

  const fn = new AsyncFunction("$input", "$", codigo);
  return await fn.call(ctx.self ?? {}, $input, pareado);
}

// --- Preparar Contexto ----------------------------------------------------

const corpoWebhook = (normalized: Record<string, unknown>) => ({
  body: {
    session_id: "22222222-2222-4222-8222-222222222222",
    normalized: {
      message_type: "text",
      wa_id: "5511999990000",
      phone: "+5511999990000",
      ...normalized,
    },
  },
});

Deno.test("Preparar Contexto: data de referencia e o dia em Sao Paulo, nao em UTC", async () => {
  const saida = await rodarCodeNode(node(RECEIPT, "Preparar Contexto").parameters.jsCode, {
    // 01:30 UTC de 09/08 e 22:30 de 08/08 em Sao Paulo. Para quem mandou a
    // mensagem, a despesa e de dia 8.
    entrada: corpoWebhook({ text_body: "gastei 45 no estacionamento", received_at: "2026-08-09T01:30:00.000Z" }),
  });

  assertEquals(saida.json.data_recebimento, "2026-08-08");
  assertEquals(saida.json.received_at, "2026-08-09T01:30:00.000Z");
});

Deno.test("Preparar Contexto: mensagem sem received_at cai no relogio do momento", async () => {
  const saida = await rodarCodeNode(node(RECEIPT, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoWebhook({ text_body: "gastei 45 no estacionamento" }),
  });

  assert(/^\d{4}-\d{2}-\d{2}$/.test(saida.json.data_recebimento), saida.json.data_recebimento);
});

Deno.test("as tres copias do prompt de producao dizem a mesma coisa", async () => {
  // backend/prompts e a fonte de edicao; a copia em _shared existe porque o
  // bundle da Edge Function nao atravessa essa fronteira, e a embutida no node
  // existe porque o n8n nao importa arquivo do repositorio.
  const fonte = await Deno.readTextFile("backend/prompts/taxmind_system_prompt.js");
  const esperado = eval(fonte.replace("export const", "var") + ";TAXMIND_SYSTEM_PROMPT").trim();

  const { TAXMIND_SYSTEM_PROMPT } = await import(
    "../supabase/functions/_shared/prompt_fiscal.ts"
  );
  assertEquals(TAXMIND_SYSTEM_PROMPT.trim(), esperado);

  const saida = await rodarCodeNode(node(RECEIPT, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoWebhook({ text_body: "oi" }),
  });

  assertEquals(saida.json.system_prompt, esperado);
  assert(saida.json.system_prompt.includes("DATA DA DESPESA"));
  assert(saida.json.system_prompt.includes("COMO FALAR DE VALOR DEDUTIVEL"));
  assert(saida.json.system_prompt.includes("CAMPOS BLOQUEANTES"));
});

Deno.test("Gemini textual e visual recebem a data de recebimento", () => {
  assert(
    node(RECEIPT, "Gemini - Classificação Textual").parameters.jsonBody
      .includes("Data de recebimento da mensagem"),
  );
  assert(
    node(RECEIPT, "Gemini - Classificação Visual").parameters.jsonBody
      .includes("Data de recebimento da mensagem"),
  );
  // O ramo visual so tem a data se o node anterior a carregar.
  assert(
    node(RECEIPT, "Converter Mídia em Base64").parameters.jsCode
      .includes("data_recebimento: contexto.data_recebimento"),
  );
});

// --- Montar Payload do Recibo --------------------------------------------

const DATA_RECEBIMENTO = "2026-08-08";

const contextoDoRecibo: Record<string, Record<string, unknown>> = {
  "Preparar Contexto": {
    session_id: "22222222-2222-4222-8222-222222222222",
    origem: "WHATSAPP_TEXTO",
    wa_id: "5511999990000",
    data_recebimento: DATA_RECEBIMENTO,
    media_sha256: null,
  },
};

function expense(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Mensalidade da faculdade",
    valor: 320,
    data_despesa: null,
    estabelecimento: "Universidade Exemplo",
    documento_prestador: "12.345.678/0001-90",
    categoria: "EDUCACAO",
    deducibilidade: "DEDUTIVEL",
    justificativa_deducibilidade: "Instituicao de ensino formal identificada.",
    confidence_score: 0.93,
    requer_revisao_humana: false,
    motivos_revisao: [],
    campos_ausentes: [],
    ...overrides,
  };
}

async function montarPayload(parsed: Record<string, unknown>, contexto = contextoDoRecibo) {
  return await rodarCodeNode(node(RECEIPT, "Montar Payload do Recibo").parameters.jsCode, {
    entrada: [{ usuario_id: "11111111-1111-4111-8111-111111111111" }],
    nodes: {
      ...contexto,
      "Extrair Bloco Expense": { expense: parsed, mensagem_usuario: "ok" },
    },
  });
}

Deno.test("data inferida sozinha NAO manda a despesa para revisao humana", async () => {
  const saida = await montarPayload(expense({ data_despesa: null }));

  assertEquals(saida.json.data_despesa, DATA_RECEBIMENTO);
  assertEquals(saida.json.metadados_ia.data_inferida, true);
  // O ponto do teste: marcacao de auditoria nao vira pendencia.
  assertEquals(saida.json.requer_revisao_humana, false);
  assertEquals(saida.json.status, "RECEBIDO");
  assertEquals(saida.json.metadados_ia.campos_ausentes, []);
});

Deno.test("a decisao de status le requer_revisao_humana, nunca data_inferida", async () => {
  // Mesmo caso do teste anterior, virando so a flag da IA: se o status mudasse
  // junto, a decisao estaria lendo a marcacao de auditoria.
  const comFlag = await montarPayload(expense({ data_despesa: null, data_inferida: true }));
  const semFlag = await montarPayload(expense({ data_despesa: "2026-08-01", data_inferida: false }));
  assertEquals(comFlag.json.status, semFlag.json.status);

  const emRevisao = await montarPayload(expense({
    data_despesa: null,
    requer_revisao_humana: true,
    motivos_revisao: ["Falta documento do prestador"],
  }));
  assertEquals(emRevisao.json.status, "REVISAO_HUMANA");
  assertEquals(emRevisao.json.metadados_ia.data_inferida, true);

  // E a leitura estatica do node, que e o que de fato vai rodar na instancia.
  const linhasDoNode = node(RECEIPT, "Montar Payload do Recibo").parameters.jsCode.split("\n");
  const linhaStatus = linhasDoNode.find((linha: string) => linha.trimStart().startsWith("const status ="));
  const linhaRevisao = linhasDoNode.find((linha: string) =>
    linha.trimStart().startsWith("const requerRevisaoHumana =")
  );
  assert(linhaStatus, "linha de decisao de status nao encontrada");
  assert(linhaRevisao, "linha de derivacao de revisao nao encontrada");
  assert(linhaStatus!.includes("requerRevisaoHumana"));
  assert(linhaRevisao!.includes("parsed.requer_revisao_humana"));
  assertFalse((linhaStatus! + linhaRevisao!).includes("data_inferida"));
});

Deno.test("data afirmada pela IA e preservada e nao vira inferida", async () => {
  const saida = await montarPayload(expense({ data_despesa: "2026-07-15", data_inferida: false }));

  assertEquals(saida.json.data_despesa, "2026-07-15");
  assertEquals(saida.json.metadados_ia.data_inferida, false);
  assertEquals(saida.json.metadados_ia.data_despesa_original_ia, "2026-07-15");
});

Deno.test("data ausente sai de campos_ausentes, o resto das pendencias fica", async () => {
  const saida = await montarPayload(expense({
    data_despesa: null,
    requer_revisao_humana: true,
    campos_ausentes: ["data_despesa", "data", "documento_prestador"],
  }));

  assertEquals(saida.json.metadados_ia.campos_ausentes, ["documento_prestador"]);
});

Deno.test("sem data da IA e sem data de recebimento, nada e inventado", async () => {
  const saida = await montarPayload(expense({ data_despesa: null }), {
    "Preparar Contexto": { ...contextoDoRecibo["Preparar Contexto"], data_recebimento: undefined },
  });

  assertEquals(saida.json.data_despesa, null);
  assertEquals(saida.json.metadados_ia.data_inferida, false);
});

Deno.test("metadados_ia preserva a saida bruta da IA junto do rastro", async () => {
  const bruto = expense({ data_despesa: null, motivos_revisao: [], evidencias_extraidas: ["R$ 320,00"] });
  const saida = await montarPayload(bruto);

  assertEquals(saida.json.metadados_ia.evidencias_extraidas, ["R$ 320,00"]);
  assertEquals(saida.json.metadados_ia.confidence_score, 0.93);
  assertEquals(saida.json.metadados_ia.data_despesa_original_ia, null);
  assertEquals(saida.json.metadados_ia.data_recebimento_mensagem, DATA_RECEBIMENTO);
});

// --- Formatar Resumo (consulta-e-dossie) ---------------------------------

async function formatarResumo(linhas: Array<Record<string, unknown>>) {
  return await rodarCodeNode(node(CONSULTA, "Formatar Resumo").parameters.jsCode, {
    entrada: linhas,
    nodes: { "Montar Contexto": { phone: "+5511999990000", usuario_id: "u" } },
  });
}

Deno.test("resumo explica que dedutivel reduz a base de calculo, nao o imposto", async () => {
  const saida = await formatarResumo([
    { categoria: "SAUDE", total: 450, total_dedutivel: 450, pendente_revisao: 0, quantidade: 1 },
  ]);

  const mensagem: string = saida.json.mensagem;
  assert(mensagem.includes("base de calculo do IR"), mensagem);
  assert(mensagem.includes("nao e o valor que voce recebe de volta"), mensagem);
  assert(mensagem.includes("faixa de tributacao"), mensagem);
});

Deno.test("resumo sem valor dedutivel nao carrega a explicacao", async () => {
  const saida = await formatarResumo([
    { categoria: "ALIMENTACAO", total: 90, total_dedutivel: 0, pendente_revisao: 0, quantidade: 2 },
  ]);

  assertFalse(saida.json.mensagem.includes("base de calculo"));
});

Deno.test("resumo vazio continua com a mensagem de primeiro uso", async () => {
  const saida = await formatarResumo([]);
  assert(saida.json.mensagem.includes("ainda nao tem despesas registradas"));
});
