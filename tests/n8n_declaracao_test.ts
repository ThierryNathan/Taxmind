// Fase 17 - import da declaracao do ano anterior, nos artefatos que vao ser
// importados no n8n e no modulo que os alimenta.
//
// Rodar:  deno test --allow-read tests/n8n_declaracao_test.ts
//
// Cobre as quatro coisas que quebram em silencio:
//
//  1. o texto da instrucao, que vive em duas copias (modulo + Code node);
//  2. a POSICAO do branch de palavra-chave, que decide quem ganha frases
//     ambiguas — erro de ordem aqui e deterministico e nunca se corrige sozinho;
//  3. o desvio do documento no workflow de recibo, incluindo a volta para o
//     fluxo de despesa quando o arquivo nao e declaracao;
//  4. a interpretacao da resposta do modelo, que decide o que vira linha no
//     banco.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAMPO_DECLARACAO,
  categoriasSemRegistroEsteAno,
  complementoDoResumo,
  DECLARACAO_MENSAGENS_TOLERADAS,
  DECLARACAO_TTL_MINUTOS,
  estimarEconomia,
  interpretarExtracao,
  mensagemDeclaracaoImportada,
  MENSAGEM_PEDIR_DECLARACAO,
  rotuloAnoDeclaracao,
} from "../supabase/functions/_shared/declaracao_anterior.ts";
import { campoRespondivel, extrairRespostaDeCampo } from "../supabase/functions/_shared/followup.ts";

const CONSULTA = JSON.parse(await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"));
const RECIBO = JSON.parse(await Deno.readTextFile("n8n/workflows/receipt-ocr-classification.json"));

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function node(workflow: any, nome: string) {
  const alvo = workflow.nodes.find((n: any) => n.name === nome);
  assert(alvo, `node nao encontrado no export: ${nome}`);
  return alvo;
}

/** Roda o jsCode do export, e nao uma copia dele. */
async function prepararContexto(texto: string, followup: unknown = null) {
  const body = {
    session_id: "11111111-1111-4111-8111-111111111111",
    normalized: {
      message_type: "text",
      text_body: texto,
      wa_id: "5511999990000",
      phone: "+5511999990000",
      profile_name: null,
    },
    followup,
  };
  const fn = new AsyncFunction("$input", "$", node(CONSULTA, "Preparar Contexto").parameters.jsCode);
  const saida = await fn({ item: { json: { body } } }, () => ({ item: { json: {} } }));
  return saida.json;
}

// --- 1. espelho do texto ----------------------------------------------------

Deno.test("o texto que pede o PDF e identico nas duas copias vivas", async () => {
  const saida = await prepararContexto("importar declaracao anterior");
  assertEquals(
    saida.pergunta_declaracao,
    MENSAGEM_PEDIR_DECLARACAO,
    "o Code node e _shared/declaracao_anterior.ts divergiram",
  );
});

Deno.test("a instrucao cita o caminho real do e-CAC, com nome de menu", () => {
  // O caminho foi conferido na documentacao da Receita. Se alguem reescrever a
  // mensagem "melhorando" o texto e apagar o nome exato da opcao, a instrucao
  // deixa de ser seguivel — a pessoa nao acha o arquivo por descricao vaga.
  for (
    const marco of [
      "e-CAC",
      "Meu Imposto de Renda",
      "Declaração do IRPF",
      "Serviços Disponíveis",
      "Documentos e Arquivos (Cópia da Declaração)",
      "prata ou ouro",
    ]
  ) {
    assert(
      MENSAGEM_PEDIR_DECLARACAO.includes(marco),
      `a instrucao perdeu a referencia a "${marco}"`,
    );
  }

  // E o aviso de que o arquivo nao fica guardado: o PDF traz renda, bens e
  // dependentes, e a pessoa decide enviar sabendo disso.
  assert(/n[ãa]o fica guardado/i.test(MENSAGEM_PEDIR_DECLARACAO));
});

Deno.test("a instrucao tem saida para quem nao acha Meu Imposto de Renda", () => {
  // O menu novo do e-CAC nem sempre mostra a opcao, e sem esta linha o passo a
  // passo termina em beco sem saida logo no passo 2 — a pessoa nao tem como
  // saber que existe outro layout com o mesmo item.
  assert(
    /vers[ãa]o cl[áa]ssica/i.test(MENSAGEM_PEDIR_DECLARACAO),
    "falta a alternativa da versao classica do e-CAC",
  );
  // E precisa dizer ONDE trocar, senao a alternativa nao e seguivel.
  assert(/canto da tela/i.test(MENSAGEM_PEDIR_DECLARACAO), "falta onde fica o botao");
});

// --- 2. palavra-chave e posicao do branch -----------------------------------

Deno.test("as frases de import caem no intent novo", async () => {
  for (
    const frase of [
      "importar declaração anterior",
      "importar declaracao anterior",
      "quero importar minha declaração do ano passado",
      "declaração anterior",
      "tenho o pdf da declaracao passada, quero enviar",
      "exportar a declaração do ano passado",
    ]
  ) {
    assertEquals((await prepararContexto(frase)).intent, "importar_declaracao", frase);
  }
});

Deno.test("o branch novo nao rouba frases dos branches vizinhos", async () => {
  // Cada uma destas ja tinha dono antes da fase 17, e o branch novo passa perto
  // de todas: as duas primeiras tem "declaracao" e um verbo de envio.
  const casos: Array<[string, string | null]> = [
    ["mandar minha declaração para o contador", "export_contador"],
    ["quero enviar a planilha da declaração para o contador", "export_contador"],
    ["me manda o dossie em pdf", "exportar_dossie"],
    ["resumo", "consulta_resumo"],
    ["conectar meu banco", "conectar_banco"],
    // Sem verbo nem marcador temporal: e pergunta fiscal, nao pedido de import.
    ["isso entra na minha declaração?", null],
    ["quanto vou pagar na declaração de 2026?", null],
    ["paguei 200 reais no dentista", null],
  ];

  for (const [frase, esperado] of casos) {
    assertEquals((await prepararContexto(frase)).intent, esperado, frase);
  }
});

Deno.test("o branch de import e checado antes do de dossie e depois do de contador", () => {
  // Teste POSICIONAL, e nao so comportamental: as duas fronteiras existem por
  // causa de frases especificas, e uma reordenacao futura as inverteria sem
  // quebrar nenhum dos casos acima se eles mudassem de redacao.
  const js: string = node(CONSULTA, "Preparar Contexto").parameters.jsCode;
  const contador = js.indexOf('intent = "export_contador"');
  const importar = js.indexOf('intent = "importar_declaracao"');
  const dossie = js.indexOf('intent = "exportar_dossie"');

  assert(contador > 0 && importar > 0 && dossie > 0, "algum branch sumiu do Code node");
  assert(contador < importar, "export_contador precisa ser checado antes do import");
  assert(importar < dossie, "o import precisa ser checado antes do dossie");
});

// --- 3. roteamento -----------------------------------------------------------

Deno.test("o intent novo tem saida propria no Switch e leva a abrir pendencia", () => {
  const sw = node(CONSULTA, "Switch por Intent").parameters;
  const chaves = sw.rules.values.map((r: any) => r.outputKey);
  assertEquals(chaves.filter((k: string) => k === "importar_declaracao").length, 1);

  const indice = chaves.indexOf("importar_declaracao");
  const destino = CONSULTA.connections["Switch por Intent"].main[indice];
  assertEquals(destino.map((d: any) => d.node), ["Supabase - Abrir Pendência de Declaração"]);

  const seguinte = CONSULTA.connections["Supabase - Abrir Pendência de Declaração"].main[0];
  assertEquals(seguinte.map((d: any) => d.node), ["WhatsApp - Pedir Declaração"]);
});

Deno.test("a pendencia nasce sem recibo e com a janela maior desta fase", () => {
  const corpo: string = node(CONSULTA, "Supabase - Abrir Pendência de Declaração")
    .parameters.jsonBody;

  // recibo nulo: a migration 011 recusa declaracao_anterior COM recibo.
  assert(/p_recibo_id:\s*null/.test(corpo), "p_recibo_id precisa ir nulo");
  assert(corpo.includes(`p_campo_alvo: "${CAMPO_DECLARACAO}"`));
  assert(
    corpo.includes(`p_ttl_minutos: ${DECLARACAO_TTL_MINUTOS}`),
    "o TTL do node divergiu de DECLARACAO_TTL_MINUTOS",
  );
  assert(
    corpo.includes(`p_mensagens: ${DECLARACAO_MENSAGENS_TOLERADAS}`),
    "o orcamento do node divergiu de DECLARACAO_MENSAGENS_TOLERADAS",
  );
});

Deno.test("o documento so desvia para o import quando ha pendencia de declaracao", () => {
  const cond = node(RECIBO, "Aguardando Declaração?").parameters.conditions.conditions[0];
  assert(String(cond.leftValue).includes("followup_anterior_campo"));
  assertEquals(cond.rightValue, CAMPO_DECLARACAO);

  // A saida FALSA precisa continuar entregando o arquivo ao classificador
  // fiscal: e o caminho de toda foto de cupom, que e a esmagadora maioria.
  const saidas = RECIBO.connections["Aguardando Declaração?"].main;
  assertEquals(saidas[0].map((d: any) => d.node), ["Edge - Importar Declaração"]);
  assertEquals(saidas[1].map((d: any) => d.node), ["Gemini - Classificação Visual"]);
});

Deno.test("arquivo que nao e declaracao volta para o fluxo de despesa", () => {
  // O freio que impede uma pendencia aberta de sequestrar a foto do cupom.
  const saidas = RECIBO.connections["Não Era Declaração?"].main;
  const destinosVerdadeiro = saidas[0].map((d: any) => d.node);

  assert(
    destinosVerdadeiro.includes("Gemini - Classificação Visual"),
    "o arquivo precisa seguir para o fluxo de recibo quando nao e declaracao",
  );
  assert(
    destinosVerdadeiro.includes("WhatsApp - Avisar Que Não Era Declaração"),
    "o usuario precisa saber que o arquivo nao virou baseline",
  );
  assertEquals(saidas[1].map((d: any) => d.node), ["WhatsApp - Resultado da Declaração"]);
});

Deno.test("o node de resposta do import tem fallback de texto", () => {
  // Regra que vale para todo ramo novo (AGENTS.md): nenhum caminho pode ter o
  // unico node de resposta dependendo de um campo que pode nao existir.
  const corpo: string = node(RECIBO, "WhatsApp - Resultado da Declaração").parameters.jsonBody;
  assert(corpo.includes("$json.mensagem ||"), "falta o fallback de mensagem");
});

Deno.test("o complemento do resumo entra sem quebrar o resumo existente", () => {
  // Formatar Resumo continua consumindo a RPC direto (ele usa $input.all()),
  // e o complemento entra DEPOIS dele.
  assertEquals(
    CONSULTA.connections["Formatar Resumo"].main[0].map((d: any) => d.node),
    ["Edge - Complemento do Resumo"],
  );
  // A fase 18 pos o bloco de pontos de atencao entre o complemento e o envio.
  // O que este teste garante continua valendo: o complemento vem DEPOIS do
  // Formatar Resumo e o ramo termina no envio — quem cobre a corrente nova em
  // detalhe e tests/n8n_pontos_atencao_test.ts.
  assertEquals(
    CONSULTA.connections["Edge - Complemento do Resumo"].main[0].map((d: any) => d.node),
    ["Edge - Pontos de Atenção"],
  );
  assertEquals(
    CONSULTA.connections["Edge - Pontos de Atenção"].main[0].map((d: any) => d.node),
    ["WhatsApp - Enviar Resumo"],
  );

  const edge = node(CONSULTA, "Edge - Complemento do Resumo");
  assertEquals(edge.onError, "continueRegularOutput", "o complemento nao pode derrubar o resumo");
  assertEquals(edge.alwaysOutputData, true);

  // E o envio tolera a ausencia de linhas.
  const envio: string = node(CONSULTA, "WhatsApp - Enviar Resumo").parameters.jsonBody;
  // O complemento deixou de ser o node imediatamente anterior ao envio, entao
  // as linhas dele passaram a ser lidas por nome. A guarda de tipo continua.
  assert(
    envio.includes('Array.isArray($("Edge - Complemento do Resumo").first().json.linhas)'),
    "o envio precisa tolerar complemento vazio",
  );
  assert(envio.includes('$("Formatar Resumo").first().json.mensagem'));
});

// --- 3b. paired item no ramo do resumo (fase 18) ----------------------------

Deno.test("nenhum node depois do Formatar Resumo usa .item", () => {
  // O BUG QUE ISTO IMPEDE
  //
  // Formatar Resumo agrega N linhas da RPC em UMA mensagem. Code node em
  // runOnceForAllItems nao declara paired item sozinho, e o n8n so consegue
  // adivinhar a origem quando a entrada tem UM item. Enquanto o envio vinha
  // logo depois do Code node isso nao aparecia (ele usava $json). A fase 17
  // meteu o complemento da declaracao no meio e trocou $json por
  // $("...").item — e a partir de DUAS categorias de despesa o resumo passou a
  // morrer com "Paired item data for item from node 'Formatar Resumo' is
  // unavailable", sem nenhuma mensagem chegando ao usuario.
  //
  // Medido no n8n 1.99.1 real: 1 categoria passava, 3 categorias nao.
  for (
    const nome of [
      "Edge - Complemento do Resumo",
      "Edge - Pontos de Atenção",
      "WhatsApp - Enviar Resumo",
    ]
  ) {
    const corpo: string = node(CONSULTA, nome).parameters.jsonBody;
    assert(
      !/\$\("[^"]+"\)\.item/.test(corpo),
      `${nome} usa .item, que nao resolve depois de um node que agrega`,
    );
  }
});

Deno.test("Formatar Resumo declara paired item nas duas saidas", () => {
  // Defesa em profundidade, e ela e carregada de verdade: com o pairedItem
  // declarado, o ramo volta a funcionar MESMO com .item nas expressoes
  // (verificado por mutacao contra o n8n real). Sem ele, so o .first() segura.
  const js: string = node(CONSULTA, "Formatar Resumo").parameters.jsCode;
  assert(js.includes("const pairedItem = entrada.map("), "falta a declaracao de pairedItem");
  assertEquals(
    js.split("pairedItem,").length - 1,
    2,
    "os dois returns (lista vazia e resumo montado) precisam declarar pairedItem",
  );
});

Deno.test("toda falha do ramo do resumo tem resposta ao usuario", () => {
  // Fail open, mesmo padrao do resto do projeto: o comando "resumo" nunca pode
  // terminar em silencio. Sao tres pontos de falha, e os tres desaguam no mesmo
  // aviso.
  const FALLBACK = "WhatsApp - Enviar Falha do Resumo";
  assert(node(CONSULTA, FALLBACK), "falta o node de aviso de falha");

  // 1. RPC fora do ar: volta pela saida NORMAL (alwaysOutputData continua
  //    necessario para o [] legitimo, e uma saida de erro separada faria o
  //    mesmo erro sair pelos dois lados, contradizendo a si mesmo).
  const rpc = node(CONSULTA, "Supabase - RPC Resumo Fiscal");
  assertEquals(rpc.onError, "continueRegularOutput");
  assertEquals(rpc.alwaysOutputData, true);
  assertEquals(CONSULTA.connections["Supabase - RPC Resumo Fiscal"].main.length, 1);
  assert(
    node(CONSULTA, "Formatar Resumo").parameters.jsCode.includes("l.error !== undefined"),
    "Formatar Resumo precisa distinguir RPC quebrada de lista vazia",
  );

  // 2. Formatar Resumo lanca (inclusive pela linha acima) e 3. o envio falha.
  for (const origem of ["Formatar Resumo", "WhatsApp - Enviar Resumo"]) {
    assertEquals(node(CONSULTA, origem).onError, "continueErrorOutput", origem);
    const saidas = CONSULTA.connections[origem].main;
    assertEquals(
      saidas[saidas.length - 1].map((d: any) => d.node),
      [FALLBACK],
      `a saida de erro de ${origem} precisa chegar ao aviso`,
    );
  }

  // O aviso e a ultima linha de defesa: nao pode depender de paired item, que e
  // exatamente o que falhou no ramo normal.
  const corpo: string = node(CONSULTA, FALLBACK).parameters.jsonBody;
  assert(!/\$\("[^"]+"\)\.item/.test(corpo), "o aviso de falha nao pode usar .item");
  assert(/n[ãa]o consegui/i.test(corpo), "o aviso precisa dizer que o resumo nao saiu");
});

// --- 4. campo na infraestrutura de follow-up --------------------------------

Deno.test("o campo e reconhecido, e nunca se responde por texto", () => {
  assert(campoRespondivel(CAMPO_DECLARACAO), "a webhook descartaria a pendencia");

  // Nenhuma frase pode fechar esta pendencia: a resposta e um arquivo.
  for (const texto of ["ja mandei", "25.255.628/0001-69", "nao", "300", "declaracao 2025"]) {
    assertEquals(extrairRespostaDeCampo(CAMPO_DECLARACAO as never, texto), null, texto);
  }
});

// --- 5. interpretacao da resposta do modelo ---------------------------------

const RESPOSTA_OK = {
  e_declaracao_irpf: true,
  ano_calendario: 2025,
  modelo: "SIMPLIFICADO",
  aliquota_efetiva: 11.74,
  imposto_devido: 11320.42,
  base_calculo: 79645.66,
  rendimentos_tributaveis: 96400,
  categorias_pagamentos: ["SAUDE", "EDUCACAO", "PREVIDENCIA"],
  pagamentos_detalhados: [{ codigo: "10", descricao: "Despesas medicas", valor: 3480 }],
  confianca: "ALTA",
  motivos_revisao: [],
};

Deno.test("extracao valida vira dados", () => {
  const r = interpretarExtracao(`<declaracao>${JSON.stringify(RESPOSTA_OK)}</declaracao>`);
  assertEquals(r.status, "ok");
  if (r.status !== "ok") return;
  assertEquals(r.dados.ano_calendario, 2025);
  assertEquals(r.dados.modelo, "SIMPLIFICADO");
  assertEquals(r.dados.aliquota_efetiva, 11.74);
  assertEquals(r.dados.categorias_pagamentos, ["SAUDE", "EDUCACAO", "PREVIDENCIA"]);
});

Deno.test("cerca de codigo tambem e aceita", () => {
  // A tag e o formato pedido, mas um desvio de formato do modelo nao pode virar
  // falha de produto — o conteudo esta la.
  const r = interpretarExtracao("```json\n" + JSON.stringify(RESPOSTA_OK) + "\n```");
  assertEquals(r.status, "ok");
});

Deno.test("documento que nao e declaracao tem status proprio", () => {
  const r = interpretarExtracao(
    `<declaracao>${JSON.stringify({ e_declaracao_irpf: false })}</declaracao>`,
  );
  assertEquals(r.status, "nao_e_declaracao");
});

Deno.test("sem ano ou sem modelo nao grava nada", () => {
  const semAno = interpretarExtracao(
    `<declaracao>${JSON.stringify({ ...RESPOSTA_OK, ano_calendario: null })}</declaracao>`,
  );
  assertEquals(semAno.status, "invalida");

  const semModelo = interpretarExtracao(
    `<declaracao>${JSON.stringify({ ...RESPOSTA_OK, modelo: null })}</declaracao>`,
  );
  assertEquals(semModelo.status, "invalida");

  // Ano implausivel e leitura errada, nao dado.
  const anoAbsurdo = interpretarExtracao(
    `<declaracao>${JSON.stringify({ ...RESPOSTA_OK, ano_calendario: 20260 })}</declaracao>`,
  );
  assertEquals(anoAbsurdo.status, "invalida");
});

Deno.test("aliquota fora da faixa vira null em vez de derrubar o import", () => {
  const r = interpretarExtracao(
    `<declaracao>${JSON.stringify({ ...RESPOSTA_OK, aliquota_efetiva: 150 })}</declaracao>`,
  );
  assertEquals(r.status, "ok");
  if (r.status !== "ok") return;
  // A constraint da migration recusaria 150 e derrubaria a linha inteira; o
  // registro sem aliquota ainda serve para a pergunta de categoria.
  assertEquals(r.dados.aliquota_efetiva, null);
});

// --- 6. complemento do resumo ------------------------------------------------

Deno.test("sem declaracao importada o resumo nao ganha nada", () => {
  assertEquals(complementoDoResumo(null, [], 1000), []);
});

Deno.test("a comparacao de categoria sai como pergunta, nunca como afirmacao", () => {
  const linhas = complementoDoResumo(
    {
      ano_calendario: 2025,
      aliquota_efetiva: 11.74,
      rendimentos_tributaveis: null,
      base_calculo: null,
      categorias_pagamentos: ["SAUDE", "EDUCACAO"],
    },
    [{ categoria: "SAUDE", total: 500, total_dedutivel: 500 }],
    500,
  );

  const pergunta = linhas.find((l) => l.includes("educação"));
  assert(pergunta, "a categoria sem registro deveria aparecer");
  assert(pergunta!.includes("?"), "a comparacao precisa ser pergunta");
  // Nunca afirmar que a pessoa esqueceu: o sistema nao sabe se houve gasto.
  assert(!/esqueceu|faltou|voc[êe] deixou/i.test(pergunta!), pergunta!);

  // SAUDE tem registro este ano e por isso nao entra.
  assert(!linhas.some((l) => l.includes("saúde")), "categoria com registro nao deveria virar pergunta");
});

Deno.test("a estimativa sempre carrega a ressalva de dado historico", () => {
  const linhas = complementoDoResumo(
    {
      ano_calendario: 2025,
      aliquota_efetiva: 11.74,
      rendimentos_tributaveis: null,
      base_calculo: null,
      categorias_pagamentos: [],
    },
    [],
    2000,
  );

  const estimativa = linhas.find((l) => l.includes("R$"));
  assert(estimativa, "deveria haver estimativa");
  assert(/estimativa/i.test(estimativa!), estimativa!);
  assert(/n[ãa]o [ée] uma garantia|n[ãa]o uma garantia/i.test(estimativa!), estimativa!);
});

Deno.test("todo ano de declaracao aparece com ano-calendario E exercicio", () => {
  // "Declaracao de 2025" e ambiguo: pode ser o ano dos gastos ou o ano da
  // entrega. E a mesma ambiguidade que faz o simulador oficial da Receita
  // devolver a tabela do ano errado (AGENTS.md, secao do calculo do IRPF), e
  // aqui ela levaria a pessoa a achar que importamos o arquivo errado.
  assertEquals(rotuloAnoDeclaracao(2025), "ano-calendário 2025, exercício 2026");

  const cenarios: string[][] = [
    // 1. estimativa com economia > 0
    complementoDoResumo(
      {
        ano_calendario: 2025,
        aliquota_efetiva: 11.74,
        rendimentos_tributaveis: null,
        base_calculo: null,
        categorias_pagamentos: ["EDUCACAO"],
      },
      [],
      2000,
    ),
    // 2. quem ja estava isento
    complementoDoResumo(
      {
        ano_calendario: 2025,
        aliquota_efetiva: 0,
        rendimentos_tributaveis: 30000,
        base_calculo: 24000,
        categorias_pagamentos: [],
      },
      [],
      2000,
    ),
  ];

  for (const linhas of cenarios) {
    assert(linhas.length > 0);
    for (const linha of linhas) {
      // Nenhuma linha pode citar o ano sozinho.
      assert(
        !/(declaração|em) (de )?20\d\d(?!\d)/.test(linha.replace(/ano-calendário 20\d\d/g, "")) ||
          linha.includes("exercício"),
        `ano solto na linha: ${linha}`,
      );
      if (/20\d\d/.test(linha)) {
        assert(linha.includes("ano-calendário"), `falta ano-calendario: ${linha}`);
        assert(linha.includes("exercício"), `falta exercicio: ${linha}`);
      }
    }
  }

  // E a confirmacao do import, que e onde a pessoa confere contra o PDF.
  const confirmacao = mensagemDeclaracaoImportada({
    ...RESPOSTA_OK,
    modelo: "SIMPLIFICADO",
    confianca: "ALTA",
  } as never);
  assert(
    confirmacao.includes("ano-calendário 2025, exercício 2026"),
    confirmacao.split("\n")[0],
  );
});

Deno.test("categoriasSemRegistroEsteAno so acompanha saude e educacao", () => {
  const ausentes = categoriasSemRegistroEsteAno(
    ["SAUDE", "EDUCACAO", "PREVIDENCIA", "SERVICOS_PROFISSIONAIS", "OUTROS"],
    [],
  );
  // Previdencia nao chega por recibo no WhatsApp, e SERVICOS_PROFISSIONAIS da
  // ficha de Pagamentos nao e a mesma coisa que a categoria homonima do enum.
  assertEquals(ausentes, ["SAUDE", "EDUCACAO"]);
});

Deno.test("a estimativa usa o motor quando o PDF trouxe rendimento", () => {
  const comRendimento = estimarEconomia(
    {
      ano_calendario: 2025,
      aliquota_efetiva: 11.74,
      rendimentos_tributaveis: 96400,
      base_calculo: 79645.66,
    },
    3000,
  );
  assertEquals(comRendimento?.metodo, "MOTOR_IRPF");

  // Sem rendimento cai no metodo da especificacao: dedutivel x aliquota.
  const semRendimento = estimarEconomia(
    { ano_calendario: 2025, aliquota_efetiva: 11.74, rendimentos_tributaveis: null, base_calculo: null },
    3000,
  );
  assertEquals(semRendimento?.metodo, "ALIQUOTA_EFETIVA");
  assertEquals(semRendimento?.valor, 352.20);

  // Ano sem parametro tambem cai no fallback, em vez de errar a conta.
  const anoDesconhecido = estimarEconomia(
    { ano_calendario: 2019, aliquota_efetiva: 10, rendimentos_tributaveis: 80000, base_calculo: 60000 },
    1000,
  );
  assertEquals(anoDesconhecido?.metodo, "ALIQUOTA_EFETIVA");
});

Deno.test("quem ja estava isento nao recebe promessa de economia", () => {
  // O motor sabe que o imposto era zero; a mensagem diz isso em vez de
  // prometer um retorno que nao existe.
  const linhas = complementoDoResumo(
    {
      ano_calendario: 2025,
      aliquota_efetiva: 0,
      rendimentos_tributaveis: 30000,
      base_calculo: 24000,
      categorias_pagamentos: [],
    },
    [],
    2000,
  );

  assert(linhas.length > 0, "o caso isento precisa dizer algo");
  assert(/j[áa] ficava zerado/i.test(linhas[0]), linhas[0]);
  assert(!linhas[0].includes("a menos de imposto"), "nao pode prometer economia");
});
