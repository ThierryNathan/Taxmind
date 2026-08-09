// Fase 15 - o follow-up de reembolso dentro dos workflows.
//
// Rodar:  deno test --allow-read --allow-run tests/n8n_fase15_test.ts
//
// Mesmo harness das fases 12 a 14: o jsCode e as expressoes saem do export real
// e rodam num arremedo do runtime do n8n, entao o que se exercita aqui e o
// artefato que vai ser importado na instancia, nao uma copia dele.
//
// Duas copias vivas nascem nesta fase, e as duas sao comparadas aqui contra a
// fonte em supabase/functions/_shared/followup.ts:
//   - a derivacao do campo (n8n nao importa arquivo do repositorio);
//   - o texto da pergunta.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAMPO_REEMBOLSO,
  derivarCampoFollowup,
  perguntaParaCampo,
} from "../supabase/functions/_shared/followup.ts";

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

async function rodarCodeNode(
  codigo: string,
  ctx: { entrada: unknown; nodes?: Record<string, unknown> },
): Promise<any> {
  const pareado = (nome: string) => {
    if (!ctx.nodes || !(nome in ctx.nodes)) throw new Error(`o teste nao expos "${nome}"`);
    const json = (ctx.nodes as Record<string, unknown>)[nome];
    return { item: { json }, first: () => ({ json }) };
  };
  const itens = Array.isArray(ctx.entrada) ? ctx.entrada : [ctx.entrada];
  const fn = new AsyncFunction("$input", "$", codigo);
  return await fn.call({}, {
    item: { json: itens[0] },
    all: () => itens.map((json) => ({ json })),
  }, pareado);
}

const CONTEXTO_RECIBO = {
  session_id: "22222222-2222-4222-8222-222222222222",
  origem: "WHATSAPP_TEXTO",
  wa_id: "5511999990000",
  data_recebimento: "2026-08-09",
  media_sha256: null,
  followup_anterior_id: null,
};

async function montarPayload(parsed: Record<string, unknown>) {
  return await rodarCodeNode(node(RECEIPT, "Montar Payload do Recibo").parameters.jsCode, {
    entrada: [{ usuario_id: "11111111-1111-4111-8111-111111111111" }],
    nodes: {
      "Preparar Contexto": CONTEXTO_RECIBO,
      "Extrair Bloco Expense": {
        expense: parsed,
        mensagem_usuario: "Registrei sua despesa de saúde.",
      },
    },
  });
}

function analise(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Consulta com dermatologista",
    valor: 400,
    data_despesa: "2026-08-09",
    data_inferida: false,
    estabelecimento: null,
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    confidence_score: 0.8,
    requer_revisao_humana: true,
    motivos_revisao: ["Necessario confirmar ausencia de reembolso"],
    campos_ausentes: [],
    deducibilidade_se_desbloqueado: null,
    possui_indicio_reembolso: false,
    deducibilidade_se_sem_reembolso: null,
    ...overrides,
  };
}

// A tabela e a mesma para as duas implementacoes: se uma mudar sozinha, o
// arquivo quebra. E a razao de existir do teste.
const CASOS: Array<{ nome: string; parsed: Record<string, unknown>; campo: string | null }> = [
  {
    nome: "indicio de reembolso pergunta reembolso",
    parsed: analise({
      possui_indicio_reembolso: true,
      deducibilidade_se_sem_reembolso: "DEDUTIVEL",
      estabelecimento: "Clinica Vida",
    }),
    campo: CAMPO_REEMBOLSO,
  },
  {
    nome: "reembolso sem destino declarado ainda pergunta",
    parsed: analise({
      possui_indicio_reembolso: true,
      deducibilidade_se_sem_reembolso: null,
    }),
    campo: CAMPO_REEMBOLSO,
  },
  {
    nome: "IA contraditoria: reembolso ganha a vaga",
    parsed: analise({
      possui_indicio_reembolso: true,
      deducibilidade_se_sem_reembolso: "DEDUTIVEL",
      deducibilidade_se_desbloqueado: "DEDUTIVEL",
    }),
    campo: CAMPO_REEMBOLSO,
  },
  {
    nome: "sem reembolso, documento continua sendo a pergunta",
    parsed: analise({ deducibilidade_se_desbloqueado: "DEDUTIVEL" }),
    campo: "documento_prestador",
  },
  {
    nome: "sem reembolso, com documento, pergunta o estabelecimento",
    parsed: analise({
      deducibilidade_se_desbloqueado: "DEDUTIVEL",
      documento_prestador: "11.222.333/0001-81",
    }),
    campo: "estabelecimento",
  },
  {
    nome: "nada declarado, nenhuma pergunta",
    parsed: analise(),
    campo: null,
  },
  {
    nome: "possui_indicio_reembolso false explicito nao pergunta",
    parsed: analise({ possui_indicio_reembolso: false }),
    campo: null,
  },
];

Deno.test("as duas copias da derivacao concordam caso a caso", async () => {
  for (const caso of CASOS) {
    const saida = await montarPayload(caso.parsed);
    assertEquals(saida.json.followup_campo, caso.campo, `n8n: ${caso.nome}`);
    assertEquals(derivarCampoFollowup(caso.parsed), caso.campo, `_shared: ${caso.nome}`);
  }
});

Deno.test("a pergunta de reembolso e a mesma nas duas copias", async () => {
  const saida = await montarPayload(analise({
    possui_indicio_reembolso: true,
    estabelecimento: "Clinica Vida",
  }));

  assertEquals(saida.json.followup_pergunta, perguntaParaCampo(CAMPO_REEMBOLSO));
  // A pergunta e anexada a confirmacao, nao a substitui: a despesa ja foi
  // gravada antes de a pergunta existir.
  assert(saida.json.mensagem_usuario.startsWith("Registrei sua despesa de saúde."));
  assert(saida.json.mensagem_usuario.includes(perguntaParaCampo(CAMPO_REEMBOLSO)));
});

Deno.test("despesa aprovada automaticamente nao ganha pergunta de reembolso", async () => {
  // O gate de status nao mudou: a pergunta so existe para despesa que ficou em
  // revisao. Sem isso, uma despesa ja aprovada receberia pergunta e a resposta
  // poderia rebaixa-la.
  const saida = await montarPayload(analise({
    possui_indicio_reembolso: true,
    requer_revisao_humana: false,
    motivos_revisao: [],
  }));

  assertEquals(saida.json.status, "RECEBIDO");
  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.followup_pergunta, null);
});

Deno.test("campos_bloqueantes nos metadados continua sendo so identificacao", async () => {
  // A followup-resolve le metadados_ia.campos_bloqueantes no modo
  // CAMPO_PREENCHIDO para decidir promocao. Se valor_reembolso vazasse para
  // essa lista, ela nunca esvaziaria e a promocao do documento morreria
  // esperando resposta que ninguem pediu.
  const saida = await montarPayload(analise({
    possui_indicio_reembolso: true,
    deducibilidade_se_sem_reembolso: "DEDUTIVEL",
  }));

  assertEquals(saida.json.metadados_ia.campos_bloqueantes, []);
  assertEquals(saida.json.followup_campo, CAMPO_REEMBOLSO);
});

Deno.test("o valor gravado continua sendo o bruto", async () => {
  // Nenhum caminho do workflow pode gravar liquido: o desconto acontece na
  // leitura (resumo_fiscal_usuario e dossie), a partir de valor_reembolsado.
  const saida = await montarPayload(analise({
    possui_indicio_reembolso: true,
    valor: 400,
  }));

  assertEquals(saida.json.valor, 400);
  assertEquals(saida.json.valor_valido, true);
  assert(!("valor_reembolsado" in saida.json));
});

// --- consulta-e-dossie ----------------------------------------------------

function corpoTexto(texto: string, followup: Record<string, unknown> | null = null) {
  return {
    body: {
      session_id: "22222222-2222-4222-8222-222222222222",
      normalized: {
        message_type: "text",
        text_body: texto,
        wa_id: "5511999990000",
        phone: "+5511999990000",
      },
      followup,
    },
  };
}

const PENDENCIA_REEMBOLSO = {
  id: "33333333-3333-4333-8333-333333333333",
  recibo_id: "44444444-4444-4444-8444-444444444444",
  campo_alvo: CAMPO_REEMBOLSO,
  valor_detectado: null,
};

Deno.test("pendencia de reembolso deriva contexto e instrucao proprios", async () => {
  const saida = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("o plano cobriu metade", PENDENCIA_REEMBOLSO),
  });

  assertEquals(saida.json.followup_campo, CAMPO_REEMBOLSO);
  assert(saida.json.followup_contexto.includes("reembolsada pelo plano"));
  assert(saida.json.followup_instrucao.includes("nao houve reembolso"));
});

Deno.test("a instrucao de identificacao nao vaza para a pergunta de reembolso", async () => {
  // Esta e a armadilha da fase: o discriminador da pergunta de identificacao
  // termina em "NAO use esta categoria quando a mensagem trouxer o VALOR em
  // dinheiro". Na pergunta de reembolso o valor em dinheiro E a resposta certa,
  // e herdar aquela frase empurraria a resposta de volta para registro_despesa
  // — o bug 9/9 da fase anterior com outra roupa.
  const reembolso = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("o plano cobriu metade", PENDENCIA_REEMBOLSO),
  });
  assert(!reembolso.json.followup_instrucao.includes("VALOR em dinheiro de um gasto novo"));

  const documento = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("foi na clinica vida", {
      ...PENDENCIA_REEMBOLSO,
      campo_alvo: "documento_prestador",
    }),
  });
  assert(documento.json.followup_instrucao.includes("VALOR em dinheiro de um gasto novo"));
});

/** Renderiza o prompt do classificador exatamente como o node o montaria. */
function promptDe(workflow: any, json: Record<string, unknown>): string {
  const expr = node(workflow, "Gemini - Classificar Intent").parameters.jsonBody;
  const interno = expr.slice(expr.indexOf("{{") + 2, expr.lastIndexOf("}}"));
  return JSON.parse(new Function("$json", `return (${interno})`)(json))
    .contents[0].parts[0].text;
}

Deno.test("o prompt do classificador recebe a instrucao do campo certo", async () => {
  const contexto = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("o plano cobriu metade", PENDENCIA_REEMBOLSO),
  });

  const prompt = promptDe(CONSULTA, {
    text_body: "o plano cobriu metade",
    followup_contexto: contexto.json.followup_contexto,
    followup_instrucao: contexto.json.followup_instrucao,
  });

  assert(prompt.includes("resposta_de_followup:"));
  assert(prompt.includes("reembolsada pelo plano"));
  assert(prompt.includes("quanto o plano cobriu"));
  assert(!prompt.includes("VALOR em dinheiro de um gasto novo"));
});

Deno.test("sem pendencia, o prompt do classificador continua o de antes", async () => {
  // A garantia que atravessa as duas fases: a esmagadora maioria das mensagens
  // nao tem pergunta pendente, e para elas nada pode mudar. A comparacao e com
  // a versao commitada do proprio export, e nao com um literal aqui.
  const comando = new Deno.Command("git", {
    args: ["show", "HEAD:n8n/workflows/consulta-e-dossie.json"],
    stdout: "piped",
  });
  const { stdout } = await comando.output();
  const anterior = JSON.parse(new TextDecoder().decode(stdout));

  const mensagem = { text_body: "me manda o resumo" };
  assertEquals(promptDe(CONSULTA, mensagem), promptDe(anterior, mensagem));
  assert(!promptDe(CONSULTA, mensagem).includes("resposta_de_followup"));

  // E a mensagem que chega sem pendencia nao ganha nem contexto nem instrucao.
  const sem = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("me manda o resumo"),
  });
  assertEquals(sem.json.followup_contexto, null);
  assertEquals(sem.json.followup_instrucao, null);
});

Deno.test("resposta de reembolso reconhecida atalha o classificador", async () => {
  // valor_detectado preenchido pela whatsapp-webhook manda a mensagem direto
  // para a followup-resolve, sem passar por IA nenhuma. E o mesmo caminho do
  // CNPJ reconhecido — o que muda e so a forma do valor serializado.
  const saida = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("150", { ...PENDENCIA_REEMBOLSO, valor_detectado: "150.00" }),
  });

  assertEquals(saida.json.followup_valor_detectado, "150.00");

  const ifResposta = node(CONSULTA, "Resposta de Follow-up?").parameters.conditions
    .conditions[0];
  assertEquals(ifResposta.leftValue, "={{ $json.followup_valor_detectado }}");
  assertEquals(ifResposta.operator.operation, "notEmpty");
  assertEquals(
    (CONSULTA.connections["Resposta de Follow-up?"]?.main?.[0] ?? []).map((c: any) => c.node),
    ["Edge - Resolver Follow-up"],
  );
});
