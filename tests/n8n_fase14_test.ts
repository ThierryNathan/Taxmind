// Fase 14 - tres ajustes de conversa nos workflows.
//
// Rodar:  deno test --allow-read tests/n8n_fase14_test.ts
//
// Mesmo harness das fases 12 e 13: o jsCode e as expressoes saem do export real
// e rodam num arremedo do runtime do n8n, entao o que este arquivo exercita e o
// artefato que vai ser importado na instancia, nao uma copia dele.
//
// Os tres ajustes:
//
//   1.1 pendencia substituida em silencio — despesa nova que tambem precisa de
//       follow-up encerra a anterior (SUPERSEDIDA, dentro da
//       registrar_followup_pendente) e ate agora nao dizia nada a quem tinha
//       perguntado. Agora a confirmacao carrega um aviso.
//
//   1.2 resposta sem conteudo ("sim", "ok") caia no texto de ajuda generico do
//       consulta-e-dossie, que nao dizia que a pergunta seguia de pe.
//
//   1.3 "quem e voce / o que voce faz" caia em `outro`.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AVISO_PENDENCIA_SUBSTITUIDA,
  mensagemPerguntaSegueAberta,
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

/** Avalia o corpo de um node HTTP fora do n8n, so para ler o texto que sairia. */
function avaliarJsonBody(expressao: string, json: Record<string, unknown>): any {
  const interno = expressao.slice(expressao.indexOf("{{") + 2, expressao.lastIndexOf("}}"));
  return JSON.parse(new Function("$json", `return (${interno})`)(json));
}

// ==========================================================================
// 1.1 - pendencia anterior substituida
// ==========================================================================

const MENSAGEM_BASE = "Registrei sua consulta de R$ 450,00.";
const PENDENCIA_ANTERIOR = {
  id: "f0000000-0000-4000-8000-000000000001",
  recibo_id: "a0000000-0000-4000-8000-000000000001",
  campo_alvo: "documento_prestador",
  valor_detectado: null,
};

function contextoReceipt(followupAnterior: unknown = null) {
  return {
    session_id: "22222222-2222-4222-8222-222222222222",
    origem: "WHATSAPP_TEXTO",
    wa_id: "5511999990000",
    data_recebimento: "2026-08-08",
    media_sha256: null,
    followup_anterior_id: (followupAnterior as any)?.id ?? null,
    followup_anterior_campo: (followupAnterior as any)?.campo_alvo ?? null,
  };
}

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
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
    ...overrides,
  };
}

async function montarPayload(
  parsed: Record<string, unknown>,
  followupAnterior: unknown = null,
) {
  return await rodarCodeNode(node(RECEIPT, "Montar Payload do Recibo").parameters.jsCode, {
    entrada: [{ usuario_id: "11111111-1111-4111-8111-111111111111" }],
    nodes: {
      "Preparar Contexto": contextoReceipt(followupAnterior),
      "Extrair Bloco Expense": { expense: parsed, mensagem_usuario: MENSAGEM_BASE },
    },
  });
}

Deno.test("Preparar Contexto do recibo carrega a anotacao da pendencia anterior", async () => {
  // A anotacao ja chegava no payload (a whatsapp-webhook a poe em toda
  // mensagem, e o node de encaminhamento do consulta-e-dossie repassa o body
  // inteiro); o node e que a descartava. Sem ela, saber que houve substituicao
  // exigiria uma consulta a mais — e uma consulta que correria com a propria
  // RPC que substitui.
  const saida = await rodarCodeNode(node(RECEIPT, "Preparar Contexto").parameters.jsCode, {
    entrada: {
      body: {
        session_id: "22222222-2222-4222-8222-222222222222",
        normalized: {
          message_type: "text",
          text_body: "paguei 90 na farmacia",
          wa_id: "5511999990000",
          phone: "+5511999990000",
          received_at: "2026-08-08T12:00:00.000Z",
        },
        followup: PENDENCIA_ANTERIOR,
      },
    },
  });

  assertEquals(saida.json.followup_anterior_id, PENDENCIA_ANTERIOR.id);
  assertEquals(saida.json.followup_anterior_campo, "documento_prestador");
});

Deno.test("payload sem anotacao mantem os campos novos nulos", async () => {
  const saida = await rodarCodeNode(node(RECEIPT, "Preparar Contexto").parameters.jsCode, {
    entrada: {
      body: {
        session_id: "22222222-2222-4222-8222-222222222222",
        normalized: {
          message_type: "image",
          media_id: "MID.1",
          wa_id: "5511999990000",
          phone: "+5511999990000",
          received_at: "2026-08-08T12:00:00.000Z",
        },
      },
    },
  });

  assertEquals(saida.json.followup_anterior_id, null);
  assertEquals(saida.json.followup_anterior_campo, null);
  // E o resto do contexto continua igual ao de antes.
  assertEquals(saida.json.origem, "WHATSAPP_IMAGEM");
  assertEquals(saida.json.data_recebimento, "2026-08-08");
});

Deno.test("o aviso do n8n e a mesma string de AVISO_PENDENCIA_SUBSTITUIDA", async () => {
  // Duas copias vivas, pelo motivo de sempre: o n8n nao importa arquivo do
  // repositorio. Este e o teste que impede editar uma e esquecer a outra.
  //
  // A comparacao sai da EXECUCAO do node, e nao do jsCode cru: no jsCode o
  // texto esta dentro de um literal, e um grep ali passaria por cima de
  // diferenca de escape sem perceber.
  const saida = await montarPayload(expense(), PENDENCIA_ANTERIOR);

  assertEquals(saida.json.followup_substituiu_anterior, true);
  assert(
    saida.json.mensagem_usuario.includes(AVISO_PENDENCIA_SUBSTITUIDA),
    `o aviso do node divergiu da constante canonica:\n${saida.json.mensagem_usuario}`,
  );
});

Deno.test("a ordem e confirmacao, aviso e pergunta por ultimo", async () => {
  const saida = await montarPayload(expense(), PENDENCIA_ANTERIOR);
  const pergunta = perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" });

  assertEquals(
    saida.json.mensagem_usuario,
    [MENSAGEM_BASE, AVISO_PENDENCIA_SUBSTITUIDA, pergunta].join("\n\n"),
  );

  // A pergunta fica em ultimo de proposito: e o lugar natural da resposta. Com
  // o aviso depois dela, a mensagem terminaria falando de outra despesa e a
  // ambiguidade de "a qual delas isto responde" voltaria pela porta dos fundos.
  assert(saida.json.mensagem_usuario.endsWith(pergunta));
  assert(
    saida.json.mensagem_usuario.indexOf(AVISO_PENDENCIA_SUBSTITUIDA) <
      saida.json.mensagem_usuario.indexOf(pergunta),
  );
});

Deno.test("sem pendencia anterior a confirmacao nao ganha aviso nenhum", async () => {
  const saida = await montarPayload(expense(), null);

  assertEquals(saida.json.followup_substituiu_anterior, false);
  assert(!saida.json.mensagem_usuario.includes(AVISO_PENDENCIA_SUBSTITUIDA));
  assertEquals(
    saida.json.mensagem_usuario,
    [MENSAGEM_BASE, perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" })]
      .join("\n\n"),
  );
});

Deno.test("despesa que nao pergunta nada nao avisa substituicao", async () => {
  // Este e o caso que um aviso solto na presenca da anotacao erraria. Sem
  // followup_campo a RPC nem e chamada, ninguem e substituido e a pergunta
  // antiga continua viva — avisar aqui seria matar de mentira uma pendencia
  // que segue aberta e ainda pode ser respondida.
  const aprovada = await montarPayload(
    expense({
      requer_revisao_humana: false,
      motivos_revisao: [],
      deducibilidade: "DEDUTIVEL",
      deducibilidade_se_desbloqueado: null,
    }),
    PENDENCIA_ANTERIOR,
  );

  assertEquals(aprovada.json.followup_campo, null);
  assertEquals(aprovada.json.followup_substituiu_anterior, false);
  assertEquals(aprovada.json.mensagem_usuario, MENSAGEM_BASE);

  // Mesma coisa quando a revisao existe mas o motivo e subjetivo (uso misto,
  // reembolso): destino nulo, nenhuma pergunta, nenhuma substituicao.
  const subjetiva = await montarPayload(
    expense({
      motivos_revisao: ["Uso misto pessoal e profissional"],
      deducibilidade_se_desbloqueado: null,
    }),
    PENDENCIA_ANTERIOR,
  );

  assertEquals(subjetiva.json.followup_substituiu_anterior, false);
  assertEquals(subjetiva.json.mensagem_usuario, MENSAGEM_BASE);
});

Deno.test("o aviso nao convida a responder a despesa anterior", async () => {
  // Regressao de redacao, e nao de estilo: a pendencia antiga esta fechada e a
  // unica aberta passa a ser a desta despesa. Um convite a "mandar o documento
  // dela depois" faria o documento seguinte ser gravado no recibo NOVO —
  // evidencia colada no lugar errado, pior do que o silencio que isto corrige.
  const saida = await montarPayload(expense(), PENDENCIA_ANTERIOR);
  const texto = saida.json.mensagem_usuario
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  const aviso = texto.slice(
    texto.indexOf(
      AVISO_PENDENCIA_SUBSTITUIDA.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
    ),
  );
  for (const convite of ["depois", "mais tarde", "quando quiser", "se quiser completar"]) {
    assert(!aviso.includes(convite), `o aviso voltou a prometer um canal: "${convite}"`);
  }
});

Deno.test("o valor invalido continua sendo barrado antes do insert", async () => {
  // A mudanca mexeu na montagem da mensagem, que e vizinha da guarda de valor.
  const saida = await montarPayload(expense({ valor: 0 }), PENDENCIA_ANTERIOR);

  assertEquals(saida.json.valor_valido, false);
  assertEquals(saida.json.valor, null);
  assert(saida.json.mensagem_valor_invalido.includes("não registrei nada"));
});

// ==========================================================================
// 1.2 - a resposta sem conteudo deixou de cair no texto de ajuda
// ==========================================================================

Deno.test("a ajuda usa a mensagem da followup-resolve quando ela vem", () => {
  const corpo = node(CONSULTA, "WhatsApp - Enviar Ajuda").parameters.jsonBody;
  const pergunta = perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" });

  // O desfecho SEM_CONTEUDO e o unico que preenche `mensagem` com resolvido
  // false. O texto vem pronto da Edge Function, que e quem tem a pergunta
  // original em maos.
  const comMensagem = avaliarJsonBody(corpo.replace(
    '$("Montar Contexto").item.json.phone',
    "$json.phone",
  ), {
    phone: "+5511999990000",
    resolvido: false,
    motivo: "SEM_CONTEUDO",
    mensagem: mensagemPerguntaSegueAberta(pergunta),
  });

  assertEquals(comMensagem.text.body, mensagemPerguntaSegueAberta(pergunta));
  assert(comMensagem.text.body.endsWith(pergunta), "a pergunta original nao foi repetida");
});

Deno.test("os outros caminhos que chegam na ajuda continuam com o texto de sempre", () => {
  const corpo = node(CONSULTA, "WhatsApp - Enviar Ajuda").parameters.jsonBody.replace(
    '$("Montar Contexto").item.json.phone',
    "$json.phone",
  );

  const casos: Array<[string, Record<string, unknown>]> = [
    // intent "outro" sem pendencia aberta: $json e o item de contexto.
    ["intent outro", { phone: "+55" }],
    // SEM_RELACAO e os demais motivos devolvem mensagem null.
    ["SEM_RELACAO", { phone: "+55", resolvido: false, motivo: "SEM_RELACAO", mensagem: null }],
    ["PENDENCIA_EXPIRADA", { phone: "+55", resolvido: false, mensagem: null }],
    // onError: continueRegularOutput deixa passar o objeto de erro da function.
    ["falha da function", { phone: "+55", error: "connect ECONNREFUSED" }],
  ];

  for (const [nome, json] of casos) {
    const saida = avaliarJsonBody(corpo, json);
    assert(saida.text.body.startsWith("Posso registrar despesas"), `${nome}: ${saida.text.body}`);
  }
});

Deno.test("o desfecho SEM_CONTEUDO nao mudou de rota", () => {
  // A correcao e de texto, nao de topologia: `resolvido: false` continua
  // caindo no mesmo node. Se algum dia isto virar um ramo proprio, e aqui que
  // o teste avisa.
  assertEquals(destinos(CONSULTA, "Follow-up Resolvido?", 1), ["WhatsApp - Enviar Ajuda"]);
  assertEquals(destinos(CONSULTA, "Follow-up Aberto?", 1), ["WhatsApp - Enviar Ajuda"]);
  assertEquals(node(CONSULTA, "Edge - Resolver Follow-up").onError, "continueRegularOutput");
});

// ==========================================================================
// 1.3 - "quem e voce / o que voce faz"
// ==========================================================================

const corpoTexto = (texto: string) => ({
  body: {
    session_id: "22222222-2222-4222-8222-222222222222",
    normalized: {
      message_type: "text",
      text_body: texto,
      wa_id: "5511999990000",
      phone: "+5511999990000",
    },
    followup: null,
  },
});

const intentPorPalavraChave = async (texto: string) =>
  (await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto(texto),
  })).json.intent;

Deno.test("as formas comuns de perguntar quem somos casam sem IA", async () => {
  const mensagens = [
    "quem é você?",
    "Quem e vc",
    "o que você faz?",
    "o que vc faz",
    "o que você pode fazer por mim",
    "me explica pra que serve isso",
    "como você funciona?",
    "o que é o TaxMind?",
    "você é um robô?",
    "quero saber sobre o taxmind",
  ];

  for (const mensagem of mensagens) {
    assertEquals(await intentPorPalavraChave(mensagem), "sobre_o_taxmind", mensagem);
  }
});

Deno.test("a palavra-chave nova nao rouba nenhum intent que ja funcionava", async () => {
  // O risco de um pre-filtro novo e sempre este: casar dentro de mensagem que
  // ja tinha dono. As frases sao longas de proposito, e a checagem entra por
  // ultimo na cascata.
  const casos: Array<[string, string | null]> = [
    ["paguei 50 no mercado", null],
    ["comprei um robo aspirador por 1200", null],
    ["dentista 500 reais", null],
    ["me manda o resumo", "consulta_resumo"],
    ["quero meu dossiê em pdf", "exportar_dossie"],
    ["quero conectar meu banco", "conectar_banco"],
    ["como funciona o dossiê?", "exportar_dossie"],
    ["11.222.333/0001-81", null],
  ];

  for (const [mensagem, esperado] of casos) {
    assertEquals(await intentPorPalavraChave(mensagem), esperado, mensagem);
  }
});

Deno.test("o classificador de IA tambem conhece a categoria", async () => {
  // A palavra-chave cobre a forma escrita; o modelo cobre o resto ("vc serve
  // pra que", "que bot e esse"). Sem a categoria no prompt, o modelo nao teria
  // como devolver o rotulo que o switch espera.
  const prompt = node(CONSULTA, "Gemini - Classificar Intent").parameters.jsonBody;
  assert(prompt.includes("sobre_o_taxmind:"), "a categoria nao entrou no prompt do classificador");

  const saida = await rodarCodeNode(node(CONSULTA, "Aplicar Intent da IA").parameters.jsCode, {
    entrada: { candidates: [{ content: { parts: [{ text: "sobre_o_taxmind" }] } }] },
    nodes: { "Montar Contexto": { phone: "+5511999990000", usuario_id: "u1" } },
  });
  assertEquals(saida.json.intent, "sobre_o_taxmind");

  // E o fallback continua sendo "outro" quando o modelo devolve vazio — o que
  // acontece de verdade quando o thinking come o maxOutputTokens.
  const vazia = await rodarCodeNode(node(CONSULTA, "Aplicar Intent da IA").parameters.jsCode, {
    entrada: { candidates: [] },
    nodes: { "Montar Contexto": { phone: "+5511999990000", usuario_id: "u1" } },
  });
  assertEquals(vazia.json.intent, "outro");
});

Deno.test("o switch tem saida propria e os ramos antigos nao andaram", () => {
  assertEquals(destinos(CONSULTA, "Switch por Intent", 6), ["WhatsApp - Enviar Sobre o TaxMind"]);

  const regras = node(CONSULTA, "Switch por Intent").parameters.rules.values;
  assertEquals(regras[6].outputKey, "sobre_o_taxmind");
  assertEquals(regras[6].conditions.conditions[0].rightValue, "sobre_o_taxmind");

  // Indice de saida do switch e posicional: um ramo novo no meio remeteria
  // dossie para a mensagem de fora de escopo sem nenhum erro visivel.
  assertEquals(destinos(CONSULTA, "Switch por Intent", 0), ["HTTP - Encaminhar para Fluxo de Recibo"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 1), ["Supabase - RPC Resumo Fiscal"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 2), ["Edge - Gerar Dossiê"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 3), ["Follow-up Aberto?"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 4), ["WhatsApp - Enviar Fora de Escopo"]);
  assertEquals(destinos(CONSULTA, "Switch por Intent", 5), ["Edge - Gerar Link Conectar Banco"]);
});

Deno.test("a resposta descreve o que o produto faz hoje, incluindo Open Finance", () => {
  const saida = avaliarJsonBody(
    node(CONSULTA, "WhatsApp - Enviar Sobre o TaxMind").parameters.jsonBody,
    { phone: "+5511999990000" },
  );

  assertEquals(saida.to, "+5511999990000");
  assertEquals(saida.messaging_product, "whatsapp");

  const texto = saida.text.body.toLowerCase();
  for (const capacidade of ["foto", "texto", "irpf", "resumo", "dossiê", "open finance"]) {
    assert(texto.includes(capacidade), `a descricao nao cita ${capacidade}: ${saida.text.body}`);
  }

  // A mesma regra do resumo e do dossie: nunca prometer dinheiro de volta.
  for (const proibido of ["recebe de volta", "restitui", "economiza r$"]) {
    assert(!texto.includes(proibido), `promessa indevida na descricao: ${proibido}`);
  }

  // E a fronteira que o produto sempre declara.
  assert(texto.includes("não substituo"), saida.text.body);
});

// ==========================================================================
// Varredura (bloco 2) - o classificador nao sabia que havia pergunta aberta
// ==========================================================================
//
// Medido contra o Gemini real: 9 de 9 respostas em texto livre a pergunta do
// CNPJ ("foi na clinica vida", "nao tenho o documento, foi consulta particular
// mesmo") voltavam como registro_despesa. Como so o intent "outro" chega no
// Edge - Resolver Follow-up, o modo RECLASSIFICADO — que existe exatamente
// para essas frases — era inalcancavel na pratica: cada resposta virava uma
// despesa nova, sem valor, que morria na guarda de valor invalido.

Deno.test("a pendencia aberta e descrita para o classificador", async () => {
  const comPendencia = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: {
      body: {
        session_id: "s",
        normalized: {
          message_type: "text",
          text_body: "foi na clinica vida",
          wa_id: "5511999990000",
          phone: "+5511999990000",
        },
        followup: { id: "f1", recibo_id: "r1", campo_alvo: "documento_prestador", valor_detectado: null },
      },
    },
  });
  assert(String(comPendencia.json.followup_contexto).includes("CNPJ ou CPF"));

  const estabelecimento = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: {
      body: {
        session_id: "s",
        normalized: {
          message_type: "text",
          text_body: "foi na clinica vida",
          wa_id: "5511999990000",
          phone: "+5511999990000",
        },
        followup: { id: "f1", recibo_id: "r1", campo_alvo: "estabelecimento", valor_detectado: null },
      },
    },
  });
  assert(String(estabelecimento.json.followup_contexto).includes("onde foi"));

  // Sem pendencia o campo e nulo, e e isso que mantem o prompt de sempre.
  const sem = await rodarCodeNode(node(CONSULTA, "Preparar Contexto").parameters.jsCode, {
    entrada: corpoTexto("me manda o resumo"),
  });
  assertEquals(sem.json.followup_contexto, null);
});

Deno.test("sem pendencia, o prompt do classificador e o mesmo de antes", async () => {
  // A garantia mais importante desta correcao: a esmagadora maioria das
  // mensagens nao tem pergunta pendente, e para elas nada pode mudar. O
  // comando compara com a versao commitada do proprio export.
  const comando = new Deno.Command("git", {
    args: ["show", "HEAD:n8n/workflows/consulta-e-dossie.json"],
    stdout: "piped",
  });
  const { stdout } = await comando.output();
  const anterior = JSON.parse(new TextDecoder().decode(stdout));

  const promptDe = (workflow: any, json: Record<string, unknown>) => {
    const expr = workflow.nodes.find((n: any) => n.name === "Gemini - Classificar Intent")
      .parameters.jsonBody;
    const interno = expr.slice(expr.indexOf("{{") + 2, expr.lastIndexOf("}}"));
    return JSON.parse(new Function("$json", `return (${interno})`)(json))
      .contents[0].parts[0].text;
  };

  const mensagem = { text_body: "foi na clinica vida" };
  // A categoria sobre_o_taxmind entrou nesta mesma sessao (item 1.3),
  // export_contador entrou na fase do export estruturado e importar_declaracao
  // na fase 17. As tres sao adicoes deliberadas ao prompt base, entao a
  // comparacao ignora essas linhas e cobra o resto: qualquer OUTRA deriva
  // continua quebrando o teste.
  const semLinhaNova = (texto: string) =>
    texto
      .split("\n")
      .filter((l) =>
        !l.startsWith("sobre_o_taxmind:") && !l.startsWith("export_contador:") &&
        !l.startsWith("importar_declaracao:")
      )
      .join("\n");

  assertEquals(
    semLinhaNova(promptDe(CONSULTA, mensagem)),
    semLinhaNova(promptDe(anterior, mensagem)),
  );

  // E a categoria nova NAO aparece quando nao ha pendencia: o modelo nem tem a
  // opcao de escolher resposta_de_followup para quem nao foi perguntado nada.
  assert(!promptDe(CONSULTA, mensagem).includes("resposta_de_followup"));
  assert(
    promptDe(CONSULTA, { ...mensagem, followup_contexto: "o CNPJ ou CPF do prestador" })
      .includes("resposta_de_followup"),
  );
});

Deno.test("resposta_de_followup vai para o resolvedor que ja existe", async () => {
  assertEquals(destinos(CONSULTA, "Switch por Intent", 7), ["Edge - Resolver Follow-up"]);

  const regras = node(CONSULTA, "Switch por Intent").parameters.rules.values;
  assertEquals(regras[7].outputKey, "resposta_de_followup");

  // O Code node precisa aceitar o rotulo, senao ele cai em "outro" — que
  // funciona, mas so quando ha pendencia aberta, e por acidente.
  const saida = await rodarCodeNode(node(CONSULTA, "Aplicar Intent da IA").parameters.jsCode, {
    entrada: { candidates: [{ content: { parts: [{ text: "resposta_de_followup" }] } }] },
    nodes: { "Montar Contexto": { phone: "+55", usuario_id: "u1", followup_id: "f1" } },
  });
  assertEquals(saida.json.intent, "resposta_de_followup");
  // O contexto inteiro segue adiante: o node de resolucao le followup_id e
  // usuario_id do proprio item.
  assertEquals(saida.json.followup_id, "f1");
});
