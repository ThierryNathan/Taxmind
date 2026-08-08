// Fase 13 - o que os workflows fazem com o follow-up.
//
// Rodar:  deno test --allow-read tests/n8n_fase13_test.ts
//
// Mesmo harness da fase 12: o jsCode sai do export real e roda num arremedo do
// runtime do n8n. Alem do comportamento dos Code nodes, este arquivo verifica a
// TOPOLOGIA — quem liga em quem e quais nodes toleram falha —, porque e a
// topologia que garante a promessa central da fase: o follow-up nunca bloqueia
// nem atrasa a confirmacao da despesa.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { perguntaParaCampo } from "../supabase/functions/_shared/followup.ts";

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

const destinos = (workflow: any, nome: string, saida = 0) =>
  (workflow.connections[nome]?.main?.[saida] ?? []).map((c: any) => c.node);

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

// --- Montar Payload: candidato a follow-up --------------------------------

const MENSAGEM_BASE = "Registrei sua consulta de R$ 450,00.";

const contexto = {
  "Preparar Contexto": {
    session_id: "22222222-2222-4222-8222-222222222222",
    origem: "WHATSAPP_TEXTO",
    wa_id: "5511999990000",
    data_recebimento: "2026-08-08",
    media_sha256: null,
  },
};

function expense(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Consulta medica",
    valor: 450,
    data_despesa: "2026-08-08",
    estabelecimento: "Clinica Vida",
    documento_prestador: null,
    categoria: "SAUDE",
    deducibilidade: "INDETERMINADO",
    confidence_score: 0.78,
    requer_revisao_humana: true,
    motivos_revisao: ["Falta documento do prestador"],
    campos_ausentes: ["documento_prestador"],
    campos_bloqueantes: ["documento_prestador"],
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
    ...overrides,
  };
}

async function montarPayload(parsed: Record<string, unknown>) {
  return await rodarCodeNode(node(RECEIPT, "Montar Payload do Recibo").parameters.jsCode, {
    entrada: [{ usuario_id: "11111111-1111-4111-8111-111111111111" }],
    nodes: {
      ...contexto,
      "Extrair Bloco Expense": { expense: parsed, mensagem_usuario: MENSAGEM_BASE },
    },
  });
}

Deno.test("campo bloqueante vira pergunta anexada a confirmacao", async () => {
  const saida = await montarPayload(expense());

  assertEquals(saida.json.followup_campo, "documento_prestador");
  // O texto e o mesmo que a Edge Function usaria: espelho conferido, nao
  // reescrito de memoria.
  assertEquals(
    saida.json.followup_pergunta,
    perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" }),
  );

  // A confirmacao vem primeiro; a pergunta e um acrescimo.
  assert(saida.json.mensagem_usuario.startsWith(MENSAGEM_BASE));
  assert(saida.json.mensagem_usuario.endsWith(saida.json.followup_pergunta));

  // E o lancamento existe do mesmo jeito, com o status de sempre.
  assertEquals(saida.json.status, "REVISAO_HUMANA");
  assertEquals(saida.json.requer_revisao_humana, true);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, ["documento_prestador"]);
});

Deno.test("pergunta sem estabelecimento conhecido cai na forma generica", async () => {
  const saida = await montarPayload(expense({ estabelecimento: null }));

  assertEquals(saida.json.followup_pergunta, perguntaParaCampo("documento_prestador", {}));
  assert(saida.json.followup_pergunta.includes("do prestador"));
});

Deno.test("despesa aprovada automaticamente nao ganha pergunta", async () => {
  const saida = await montarPayload(expense({
    requer_revisao_humana: false,
    motivos_revisao: [],
    campos_bloqueantes: [],
    deducibilidade: "DEDUTIVEL",
    deducibilidade_se_desbloqueado: null,
  }));

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.followup_pergunta, null);
  assertEquals(saida.json.mensagem_usuario, MENSAGEM_BASE);
  assertEquals(saida.json.status, "RECEBIDO");
});

Deno.test("revisao por motivo nao respondivel nao vira pergunta", async () => {
  // Uso misto, reembolso, ambiguidade de categoria: nenhuma resposta objetiva
  // do usuario resolve, entao a IA deixa campos_bloqueantes vazio.
  const saida = await montarPayload(expense({
    motivos_revisao: ["Uso misto pessoal e profissional"],
    campos_bloqueantes: [],
    deducibilidade_se_desbloqueado: null,
  }));

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.mensagem_usuario, MENSAGEM_BASE);
});

Deno.test("campo fora da lista de respondiveis e descartado", async () => {
  const saida = await montarPayload(expense({
    campos_bloqueantes: ["categoria", "valor"],
  }));

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, []);
});

Deno.test("IA antiga sem campos_bloqueantes nao quebra o node", async () => {
  const parsed = expense();
  delete (parsed as Record<string, unknown>).campos_bloqueantes;
  const saida = await montarPayload(parsed);

  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.metadados_ia.campos_bloqueantes, []);
});

// --- consulta-e-dossie: leitura da anotacao -------------------------------

const corpoTexto = (texto: string, followup: unknown) => ({
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
});

Deno.test("Preparar Contexto carrega a anotacao da whatsapp-webhook", async () => {
  const saida = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("11.222.333/0001-81", {
      id: "f0000000-0000-4000-8000-000000000001",
      recibo_id: "r0000000-0000-4000-8000-000000000001",
      campo_alvo: "documento_prestador",
      valor_detectado: "11222333000181",
    }),
  });

  assertEquals(saida.json.followup_id, "f0000000-0000-4000-8000-000000000001");
  assertEquals(saida.json.followup_campo, "documento_prestador");
  assertEquals(saida.json.followup_valor_detectado, "11222333000181");
});

Deno.test("payload sem anotacao mantem os campos nulos e o intent de sempre", async () => {
  const saida = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("me manda o resumo", null),
  });

  assertEquals(saida.json.followup_id, null);
  assertEquals(saida.json.followup_valor_detectado, null);
  // O pre-filtro de palavra-chave continua funcionando como antes.
  assertEquals(saida.json.intent, "consulta_resumo");
});

// --- topologia ------------------------------------------------------------

Deno.test("ramo de revisao passa pelo follow-up e sempre chega ao WhatsApp", () => {
  // Saida 1 do IF = requer revisao humana.
  assertEquals(destinos(RECEIPT, "Requer Revisão Humana", 1), ["Tem Campo Bloqueante?"]);

  // Com campo: registra a pendencia e segue. Sem campo: vai direto.
  assertEquals(destinos(RECEIPT, "Tem Campo Bloqueante?", 0), ["Supabase - Registrar Follow-up"]);
  assertEquals(
    destinos(RECEIPT, "Tem Campo Bloqueante?", 1),
    ["WhatsApp - Enviar Resposta ao Usuário"],
  );
  assertEquals(
    destinos(RECEIPT, "Supabase - Registrar Follow-up", 0),
    ["WhatsApp - Enviar Resposta ao Usuário"],
  );

  // O caminho de aprovacao automatica nao foi tocado.
  assertEquals(destinos(RECEIPT, "Requer Revisão Humana", 0), ["Supabase - Atualizar Status Aprovado"]);
});

Deno.test("falha ao registrar a pendencia nao derruba a confirmacao", () => {
  // Estrutural e nao cosmetico: sem isto, um erro do PostgREST faria a
  // execucao parar e a pessoa nunca receberia a confirmacao da despesa que ja
  // foi gravada.
  assertEquals(node(RECEIPT, "Supabase - Registrar Follow-up").onError, "continueRegularOutput");
  assertEquals(node(CONSULTA, "Edge - Resolver Follow-up").onError, "continueRegularOutput");
});

Deno.test("resposta reconhecida atalha o classificador de intencao", () => {
  assertEquals(destinos(CONSULTA, "Montar Contexto"), ["Resposta de Follow-up?"]);
  assertEquals(destinos(CONSULTA, "Resposta de Follow-up?", 0), ["Edge - Resolver Follow-up"]);
  // Sem resposta detectada, o fluxo de intencao continua identico ao de antes.
  assertEquals(destinos(CONSULTA, "Resposta de Follow-up?", 1), ["Intent Detectado?"]);
});

Deno.test("intent 'outro' com pendencia aberta tenta texto livre antes da ajuda", () => {
  // Saida 3 do switch = outro.
  assertEquals(destinos(CONSULTA, "Switch por Intent", 3), ["Follow-up Aberto?"]);
  assertEquals(destinos(CONSULTA, "Follow-up Aberto?", 0), ["Edge - Resolver Follow-up"]);
  assertEquals(destinos(CONSULTA, "Follow-up Aberto?", 1), ["WhatsApp - Enviar Ajuda"]);

  // Nao resolvido (inclusive por falha da function) cai na ajuda de sempre.
  assertEquals(
    destinos(CONSULTA, "Follow-up Resolvido?", 0),
    ["WhatsApp - Enviar Resposta do Follow-up"],
  );
  assertEquals(destinos(CONSULTA, "Follow-up Resolvido?", 1), ["WhatsApp - Enviar Ajuda"]);
});

Deno.test("os outros ramos do switch continuam onde estavam", () => {
  assertEquals(destinos(CONSULTA, "Switch por Intent", 0), ["HTTP - Encaminhar para Fluxo de Recibo"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 1), ["Supabase - RPC Resumo Fiscal"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 2), ["Edge - Gerar Dossiê"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 4), ["WhatsApp - Enviar Fora de Escopo"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 5), ["Edge - Gerar Link Conectar Banco"]);
});

Deno.test("a ajuda le o telefone do contexto, nao do item que chegou", () => {
  // Ela agora tambem e alcancada pelo ramo do follow-up, onde $json e a
  // resposta da Edge Function e nao tem phone.
  const corpo = node(CONSULTA, "WhatsApp - Enviar Ajuda").parameters.jsonBody;
  assert(corpo.includes('$("Montar Contexto").item.json.phone'), corpo);
  assert(!corpo.includes("to: $json.phone"), corpo);
});
