// Derivacao deterministica dos campos bloqueantes.
//
// Rodar:  deno test --allow-read tests/n8n_campos_bloqueantes_test.ts
//
// Contexto: `campos_bloqueantes` era um campo da resposta da IA, definido como
// "o subconjunto de campos_ausentes que, se fosse preenchido, SOZINHO removeria
// a necessidade de revisao humana". A definicao e irrealizavel quando faltam os
// dois campos de identificacao ao mesmo tempo — "Paguei 600 no proctologista"
// nao tem documento nem estabelecimento —, porque ai nenhum dos dois sozinho
// satisfaz. O modelo devolvia [] obedecendo a regra, o node "Tem Campo
// Bloqueante?" nao criava pendencia e o follow-up nunca disparava, apesar de
// campos_ausentes, motivos_revisao e pergunta_de_followup apontarem o problema.
//
// Medido contra o Gemini real antes da mudanca, temperatura de producao (0.2):
// 10/10 execucoes de "Paguei 600 no proctologista" com campos_bloqueantes
// vazio, contra 6/6 preenchido na mesma despesa com o estabelecimento citado.
// Erro sistematico do desenho, nao variacao do modelo.
//
// Hoje o campo saiu do schema do prompt e a lista e derivada do que ficou vazio
// na extracao, com um unico juizo vindo da IA: deducibilidade_se_desbloqueado,
// que a promocao ja precisava consultar.
//
// Este arquivo cobre as duas implementacoes vivas da derivacao — a de
// _shared/followup.ts (Edge Function) e o espelho dentro do Code node do n8n —
// e exige que as duas concordem caso a caso.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { derivarCamposBloqueantes } from "../supabase/functions/_shared/followup.ts";

const RECEIPT = JSON.parse(
  await Deno.readTextFile("n8n/workflows/receipt-ocr-classification.json"),
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function node(nome: string) {
  const alvo = RECEIPT.nodes.find((n: any) => n.name === nome);
  if (!alvo) throw new Error(`node nao encontrado no export: ${nome}`);
  return alvo;
}

const CONTEXTO = {
  "Preparar Contexto": {
    session_id: "22222222-2222-4222-8222-222222222222",
    origem: "WHATSAPP_TEXTO",
    wa_id: "5511999990000",
    data_recebimento: "2026-08-08",
    media_sha256: null,
  },
};

/** Roda o jsCode que sera importado na instancia, nao uma copia dele. */
async function montarPayload(parsed: Record<string, unknown>) {
  const pareado = (nome: string) => {
    const tabela: Record<string, unknown> = {
      ...CONTEXTO,
      "Extrair Bloco Expense": { expense: parsed, mensagem_usuario: "Registrei sua despesa." },
    };
    if (!(nome in tabela)) throw new Error(`o teste nao expos "${nome}"`);
    return { item: { json: tabela[nome] }, first: () => ({ json: tabela[nome] }) };
  };

  const entrada = [{ usuario_id: "11111111-1111-4111-8111-111111111111" }];
  const fn = new AsyncFunction("$input", "$", node("Montar Payload do Recibo").parameters.jsCode);
  return await fn.call({}, {
    item: { json: entrada[0] },
    all: () => entrada.map((json) => ({ json })),
  }, pareado);
}

function analise(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Consulta medica",
    valor: 600,
    data_despesa: "2026-08-08",
    estabelecimento: null,
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    confidence_score: 0.7,
    requer_revisao_humana: true,
    motivos_revisao: ["Falta identificacao do prestador"],
    campos_ausentes: ["documento_prestador", "estabelecimento"],
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
    ...overrides,
  };
}

// --- o caso que originou a mudanca ----------------------------------------

Deno.test("saude sem documento E sem estabelecimento gera pergunta", async () => {
  // A forma exata de "Paguei 600 no proctologista": categoria clara, valor
  // claro, nenhuma identificacao do prestador. Antes: campos_bloqueantes []
  // vindo da IA, followup_campo null, nenhuma pendencia criada.
  const saida = await montarPayload(analise());

  assertEquals(saida.json.followup_campo, "documento_prestador");
  assert(saida.json.followup_pergunta.includes("do prestador"), saida.json.followup_pergunta);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, ["documento_prestador"]);

  // A pergunta e um acrescimo a confirmacao, nunca um substituto: a despesa ja
  // foi gravada quando ela aparece.
  assert(saida.json.mensagem_usuario.startsWith("Registrei sua despesa."));
  assertEquals(saida.json.status, "REVISAO_HUMANA");
});

Deno.test("documento tem precedencia sobre estabelecimento", async () => {
  // Faltando os dois, pergunta-se o documento: e o unico campo cuja resposta e
  // reconhecivel sem IA (digito verificador). Nome de lugar e texto livre e cai
  // na reclassificacao.
  assertEquals(derivarCamposBloqueantes(analise()), ["documento_prestador"]);

  // E a ordem nao depende de como a IA listou campos_ausentes — que, medido,
  // sai nas duas ordens entre execucoes da mesma mensagem.
  assertEquals(
    derivarCamposBloqueantes(analise({
      campos_ausentes: ["estabelecimento", "documento_prestador"],
    })),
    ["documento_prestador"],
  );
});

Deno.test("com o documento extraido, sobra o estabelecimento", async () => {
  const saida = await montarPayload(analise({ documento_prestador: "11.222.333/0001-81" }));

  assertEquals(saida.json.followup_campo, "estabelecimento");
  assert(saida.json.followup_pergunta.includes("onde foi essa despesa"));
});

Deno.test("identificacao completa nao gera pergunta nenhuma", async () => {
  const saida = await montarPayload(analise({
    documento_prestador: "11.222.333/0001-81",
    estabelecimento: "Clinica Vida",
  }));

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, []);
});

// --- o que segura a pergunta ----------------------------------------------

Deno.test("destino nulo cala a pergunta mesmo com campo vazio", async () => {
  // Este e o unico freio contra perguntar em caso subjetivo: uso misto,
  // reembolso, OCR ruim e ambiguidade de categoria deixam o documento vazio do
  // mesmo jeito. Uma intersecao crua com campos_ausentes perguntaria o CNPJ da
  // Vivo numa conta de internet residencial — atrito sem desfecho possivel.
  const saida = await montarPayload(analise({
    categoria: "INTERNET_TELEFONIA",
    estabelecimento: "Vivo",
    deducibilidade: "PARCIALMENTE_DEDUTIVEL",
    motivos_revisao: ["Uso misto pessoal e profissional"],
    campos_ausentes: ["documento_prestador"],
    deducibilidade_se_desbloqueado: null,
  }));

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, []);
});

Deno.test("string vazia conta como campo vazio", async () => {
  // OCR devolve "" e "   " com a mesma facilidade com que devolve null, e um
  // estabelecimento em branco nao identifica prestador nenhum.
  for (const vazio of ["", "   "]) {
    assertEquals(
      derivarCamposBloqueantes(analise({ documento_prestador: vazio })),
      ["documento_prestador"],
      JSON.stringify(vazio),
    );
  }
});

Deno.test("analise ausente ou sem destino nao quebra a derivacao", () => {
  assertEquals(derivarCamposBloqueantes(null), []);
  assertEquals(derivarCamposBloqueantes(undefined), []);
  assertEquals(derivarCamposBloqueantes({}), []);
});

// --- paridade entre as duas implementacoes --------------------------------

const CASOS: Array<{ nome: string; parsed: Record<string, unknown>; esperado: string[] }> = [
  { nome: "saude sem identificacao", parsed: analise(), esperado: ["documento_prestador"] },
  {
    nome: "so o documento faltando",
    parsed: analise({ estabelecimento: "Clinica Vida" }),
    esperado: ["documento_prestador"],
  },
  {
    nome: "so o estabelecimento faltando",
    parsed: analise({ documento_prestador: "11.222.333/0001-81" }),
    esperado: ["estabelecimento"],
  },
  {
    nome: "identificacao completa",
    parsed: analise({ documento_prestador: "11.222.333/0001-81", estabelecimento: "Clinica Vida" }),
    esperado: [],
  },
  { nome: "destino nulo", parsed: analise({ deducibilidade_se_desbloqueado: null }), esperado: [] },
  {
    nome: "destino nao promovel",
    parsed: analise({ deducibilidade_se_desbloqueado: "NAO_DEDUTIVEL" }),
    esperado: [],
  },
  {
    nome: "destino parcialmente dedutivel",
    parsed: analise({ deducibilidade_se_desbloqueado: "PARCIALMENTE_DEDUTIVEL" }),
    esperado: ["documento_prestador"],
  },
  {
    nome: "campos_bloqueantes legado da IA e ignorado",
    parsed: analise({ campos_bloqueantes: ["categoria"] }),
    esperado: ["documento_prestador"],
  },
];

Deno.test("Code node do n8n e _shared derivam a mesma lista", async () => {
  // As duas copias existem porque o n8n nao importa arquivo do repositorio.
  // Sem este teste, corrigir uma e esquecer a outra deixa a Edge Function
  // promovendo com um criterio e o workflow perguntando com outro.
  for (const caso of CASOS) {
    const doNode = (await montarPayload(caso.parsed)).json.metadados_ia.campos_bloqueantes;
    const doShared = derivarCamposBloqueantes(caso.parsed);

    assertEquals(doShared, caso.esperado, `_shared / ${caso.nome}`);
    assertEquals(doNode, caso.esperado, `n8n / ${caso.nome}`);
  }
});

// --- o prompt nao pode voltar a pedir o campo -----------------------------

Deno.test("as tres copias do prompt nao declaram mais campos_bloqueantes no schema", async () => {
  const fonte = await Deno.readTextFile("backend/prompts/taxmind_system_prompt.js");
  const prompt: string = eval(fonte.replace("export const", "var") + ";TAXMIND_SYSTEM_PROMPT");

  const { TAXMIND_SYSTEM_PROMPT } = await import(
    "../supabase/functions/_shared/prompt_fiscal.ts"
  );

  // O texto embutido no n8n sai da execucao do node, e nao do jsCode cru: no
  // jsCode as aspas estao escapadas, e procurar '"campos_bloqueantes":' ali
  // passaria sem encostar em nada.
  const fn = new AsyncFunction("$input", "$", node("Preparar Contexto").parameters.jsCode);
  const preparado = await fn.call({}, {
    item: {
      json: {
        body: {
          session_id: "22222222-2222-4222-8222-222222222222",
          normalized: {
            message_type: "text",
            text_body: "Paguei 600 no proctologista",
            wa_id: "5511999990000",
            phone: "+5511999990000",
            received_at: "2026-08-08T12:00:00.000Z",
          },
        },
      },
    },
    all: () => [],
  }, () => {
    throw new Error("Preparar Contexto nao le outro node");
  });

  for (const [onde, texto] of [
    ["backend/prompts", prompt],
    ["_shared/prompt_fiscal", TAXMIND_SYSTEM_PROMPT],
    ["node Preparar Contexto", preparado.json.system_prompt],
  ] as Array<[string, string]>) {
    // A mencao explicativa continua permitida ("nao existe campo
    // campos_bloqueantes na sua resposta"); o que nao pode voltar e a linha de
    // schema que faz o modelo emitir a lista.
    assert(
      !texto.includes('"campos_bloqueantes":'),
      `${onde} voltou a pedir campos_bloqueantes no JSON`,
    );
    assert(texto.includes("deducibilidade_se_desbloqueado"), onde);
  }
});
