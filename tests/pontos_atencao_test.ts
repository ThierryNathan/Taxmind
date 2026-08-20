// Fase 18 - pontos de atencao antes de declarar.
//
// O modulo testado nao toca banco nem IA: le contagens e escreve texto. Por
// isso tudo aqui roda sem rede.
//
// Tres grupos de teste, e o primeiro e o mais importante:
//   1. as REGRAS DE LINGUAGEM. O produto nao tem acesso ao algoritmo da Receita
//      e nao pode sugerir que tem. Um percentual que vaze para o texto quebra a
//      promessa central da fase, e e o tipo de coisa que passa despercebida numa
//      revisao de codigo;
//   2. o criterio de salto ano a ano, contra os fixtures de declaracao que ja
//      existem no repositorio e contra a FORMA da unica declaracao real
//      importada em producao;
//   3. as marcas por item, que alimentam a coluna do export do contador.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  celulaPontosAtencao,
  type ContagensAtencao,
  DIAS_REVISAO_PARADA,
  linhasPontosAtencao,
  MARCA_REEMBOLSO_ABERTO,
  MARCA_REVISAO_PARADA,
  MARCA_SEM_IDENTIFICACAO,
  MARCA_USO_MISTO,
  pontosAtencaoDoRecibo,
  RESSALVA_BLOCO,
} from "../supabase/functions/_shared/pontos_atencao.ts";
// A comparacao ano a ano mora junto das outras comparacoes com a declaracao:
// pontos_atencao.ts nao pode importar este modulo, que arrasta o motor de IRPF
// para o bundle da export-contador.
import {
  type BaselineDeclaracao,
  detectarSaltos,
  FATOR_SALTO,
  fichaPreenchida,
  FRACAO_RENDA_MATERIAL,
  itensDeSaltoAnoAAno,
  valorDeclaradoPorCategoria,
} from "../supabase/functions/_shared/declaracao_anterior.ts";

const AGORA = new Date("2026-08-20T12:00:00.000Z");

function contagens(over: Partial<ContagensAtencao> = {}): ContagensAtencao {
  return {
    ano_referencia: 2026,
    sem_identificacao: 0,
    saude_sem_reembolso: 0,
    uso_misto: 0,
    revisao_parada: 0,
    revisao_parada_desde: null,
    totais_categoria: [],
    ...over,
  };
}

// Fixtures de declaracao. Os tres primeiros espelham os modelos de
// tests/fixtures/gerar_declaracao_sintetica.ts, que sao os PDFs sinteticos que a
// extracao ja usa — os codigos e valores da ficha sao os de la.
//
// O quarto reproduz a FORMA da unica declaracao real importada em producao:
// SIMPLIFICADO com ficha vazia. Os numeros sao neutros de proposito (o repo nao
// guarda dado financeiro de pessoa real); o que importa para o teste e a forma,
// e e ela que silencia o braco "sem historico".
const COMPLETO: BaselineDeclaracao = {
  ano_calendario: 2025,
  categorias_pagamentos: ["SAUDE", "EDUCACAO", "SERVICOS_PROFISSIONAIS", "OUTROS"],
  pagamentos_detalhados: [
    { codigo: "10", descricao: "Despesas medicas no Brasil", valor: 12900 },
    { codigo: "01", descricao: "Instrucao no Brasil", valor: 3561.5 },
    { codigo: "13", descricao: "Advogados", valor: 8400 },
    { codigo: "99", descricao: "Outros", valor: 1220 },
  ],
  rendimentos_tributaveis: 142800,
  base_calculo: 104288,
};

const SIMPLIFICADO_COM_FICHA: BaselineDeclaracao = {
  ano_calendario: 2025,
  categorias_pagamentos: ["SAUDE", "EDUCACAO", "PREVIDENCIA"],
  pagamentos_detalhados: [
    { codigo: "10", descricao: "Despesas medicas no Brasil", valor: 3480 },
    { codigo: "11", descricao: "Plano de saude no Brasil", valor: 6240 },
    { codigo: "01", descricao: "Instrucao no Brasil", valor: 4150 },
    { codigo: "60", descricao: "Previdencia complementar", valor: 2400 },
  ],
  rendimentos_tributaveis: 96400,
  base_calculo: 79645.66,
};

const FICHA_VAZIA: BaselineDeclaracao = {
  ano_calendario: 2025,
  categorias_pagamentos: [],
  pagamentos_detalhados: [],
  rendimentos_tributaveis: 60000,
  base_calculo: 48000,
};

const SEM_RENDA: BaselineDeclaracao = {
  ano_calendario: 2025,
  categorias_pagamentos: ["SAUDE"],
  pagamentos_detalhados: [{ codigo: "10", descricao: "Despesas medicas", valor: 5000 }],
  rendimentos_tributaveis: null,
  base_calculo: null,
};

/** Reproduz exatamente o que a Edge Function faz: renderiza os itens de salto
 *  no modulo da declaracao e passa os textos para o bloco. */
function bloco(
  c: ContagensAtencao | null,
  baseline: BaselineDeclaracao | null = null,
): string[] {
  return linhasPontosAtencao(c, itensDeSaltoAnoAAno(baseline, c?.totais_categoria ?? []));
}

function saude(total: number) {
  return [{ categoria: "SAUDE", total_dedutivel: total }];
}

// --- 1. regras de linguagem ------------------------------------------------

Deno.test("o bloco nunca apresenta percentual, probabilidade ou risco", () => {
  // Com TODOS os sinais ligados de uma vez, para nenhuma frase escapar da
  // varredura por estar num ramo raro.
  const texto = bloco(
    contagens({
      sem_identificacao: 11,
      saude_sem_reembolso: 18,
      uso_misto: 3,
      revisao_parada: 2,
      revisao_parada_desde: "2026-06-01",
      totais_categoria: saude(30000),
    }),
    COMPLETO,
  ).join("\n");

  assert(texto.length > 0, "o bloco deveria ter saido preenchido");

  // Nenhum numero seguido de %: seria lido como probabilidade de fiscalizacao,
  // que e exatamente o que o produto nao pode afirmar.
  assert(!/\d\s*%/.test(texto), `percentual no texto: ${texto}`);

  for (const proibido of ["risco", "probabilidade", "chance", "score"]) {
    assert(
      !new RegExp(proibido, "i").test(texto),
      `a palavra "${proibido}" aparece no bloco: ${texto}`,
    );
  }

  // "malha" so pode aparecer negada. Hoje nao aparece de forma nenhuma, e o
  // teste cobra as duas coisas: se alguem introduzir a expressao, ela tem que
  // vir na frase que a nega.
  for (const ocorrencia of texto.split("\n").filter((l) => /malha/i.test(l))) {
    assert(/n[aã]o/i.test(ocorrencia), `"malha" sem negacao: ${ocorrencia}`);
  }
});

Deno.test("a ressalva acompanha o bloco sempre, mesmo com um sinal so", () => {
  for (
    const so of [
      { sem_identificacao: 1 },
      { saude_sem_reembolso: 1 },
      { uso_misto: 1 },
      { revisao_parada: 1 },
    ]
  ) {
    const linhas = bloco(contagens(so));
    assert(linhas.includes(RESSALVA_BLOCO), `ressalva ausente com ${JSON.stringify(so)}`);
  }

  assert(
    /não é previsão de fiscalização/i.test(RESSALVA_BLOCO),
    "a ressalva parou de dizer que isto nao e previsao",
  );
});

Deno.test("sem nenhum sinal o bloco some inteiro, e nao vira 'esta tudo certo'", () => {
  assertEquals(bloco(contagens()), []);
  assertEquals(bloco(contagens(), COMPLETO), []);
  assertEquals(bloco(null, COMPLETO), []);

  // A afirmacao de conformidade seria uma garantia que o sistema nao tem como
  // dar: ele so ve o que recebeu.
  const texto = bloco(contagens(), COMPLETO).join(" ");
  assert(!/tudo certo|nenhum ponto|est[aá] em ordem/i.test(texto));
});

Deno.test("cada sinal ligado produz a sua linha, no singular e no plural", () => {
  const um = bloco(
    contagens({ sem_identificacao: 1, saude_sem_reembolso: 1, uso_misto: 1, revisao_parada: 1 }),
  ).join("\n");

  assert(/1 lançamento sem CNPJ/.test(um), um);
  assert(/1 despesa de saúde sem confirmação/.test(um), um);
  assert(/1 lançamento de uso misto aguarda/.test(um), um);
  assert(new RegExp(`1 lançamento em revisão há mais de ${DIAS_REVISAO_PARADA} dias`).test(um), um);

  const varios = bloco(
    contagens({ sem_identificacao: 11, saude_sem_reembolso: 18, uso_misto: 3, revisao_parada: 2 }),
  ).join("\n");

  assert(/11 lançamentos sem CNPJ/.test(varios), varios);
  assert(/18 despesas de saúde/.test(varios), varios);
  assert(/3 lançamentos de uso misto aguardam/.test(varios), varios);
  assert(/2 lançamentos em revisão/.test(varios), varios);
});

Deno.test("o texto do uso misto assume que o percentual NAO existe no sistema", () => {
  const texto = bloco(contagens({ uso_misto: 2 }), null).join("\n");

  // O schema nao guarda percentual de rateio em lugar nenhum, entao o texto nao
  // pode sugerir que alguns lancamentos ja teriam a informacao ("sem percentual
  // informado" implicaria que outros tem). Ele manda definir com o contador.
  assert(/percentual profissional/.test(texto), texto);
  assert(/contador/.test(texto), texto);
});

// --- 2. salto ano a ano ----------------------------------------------------

Deno.test("a ficha do ano-base e lida por codigo, com a descricao de reserva", () => {
  const mapa = valorDeclaradoPorCategoria(SIMPLIFICADO_COM_FICHA);
  // 10 (despesas medicas) + 11 (plano de saude) somam na mesma categoria.
  assertEquals(mapa.get("SAUDE"), 3480 + 6240);
  assertEquals(mapa.get("EDUCACAO"), 4150);
  // Previdencia nao e categoria acompanhada e nao entra no mapa.
  assertEquals(mapa.get("PREVIDENCIA" as never), undefined);

  // O codigo sozinho basta, e este caso e o unico que PROVA isso: a descricao
  // e o nome comercial da operadora e nao casa com nenhum termo do fallback.
  // Sem ele, desligar o mapa de codigos passaria despercebido — as descricoes
  // dos fixtures ("Despesas medicas", "Instrucao") sao reconhecidas pelos dois
  // caminhos, e a mutacao sobrevivia.
  const soPeloCodigo = valorDeclaradoPorCategoria({
    ...FICHA_VAZIA,
    pagamentos_detalhados: [
      { codigo: "11", descricao: "Unimed Central Nacional", valor: 6000 },
      { codigo: "02", descricao: "Colegio Santa Cruz LTDA", valor: 4000 },
    ],
  });
  assertEquals(soPeloCodigo.get("SAUDE"), 6000);
  assertEquals(soPeloCodigo.get("EDUCACAO"), 4000);

  // Codigo desconhecido cai na descricao.
  const porDescricao = valorDeclaradoPorCategoria({
    ...FICHA_VAZIA,
    pagamentos_detalhados: [
      { codigo: "77", descricao: "Despesas odontologicas", valor: 900 },
      { codigo: "78", descricao: "Mensalidade da faculdade", valor: 800 },
      { codigo: "79", descricao: "Pensao alimenticia", valor: 700 },
    ],
  });
  assertEquals(porDescricao.get("SAUDE"), 900);
  assertEquals(porDescricao.get("EDUCACAO"), 800);
  assertEquals(porDescricao.size, 2, "pensao alimenticia nao devia ter sido mapeada");
});

Deno.test("o salto exige as DUAS condicoes: o multiplo e o aumento material", () => {
  // Ano-base: saude 12.900, renda 142.800 -> material = 7.140.
  const material = 142800 * FRACAO_RENDA_MATERIAL;
  assertEquals(material, 7140);

  // Dispara: 30.000 e 2,33x e o aumento (17.100) passa dos 7.140.
  assertEquals(detectarSaltos(COMPLETO, saude(30000)).length, 1);

  // Nao dispara: abaixo do multiplo, mesmo com aumento grande em valor
  // absoluto. 20.000 e 1,55x.
  assertEquals(detectarSaltos(COMPLETO, saude(20000)).length, 0);

  // Nao dispara: no limite do multiplo mas com aumento pequeno demais. Educacao
  // 3.561,50 -> 8.000 e 2,25x, e o aumento (4.438,50) nao chega a 7.140.
  assertEquals(
    detectarSaltos(COMPLETO, [{ categoria: "EDUCACAO", total_dedutivel: 8000 }]).length,
    0,
  );

  // A borda exata do multiplo entra.
  assertEquals(detectarSaltos(COMPLETO, saude(12900 * FATOR_SALTO)).length, 1);
  assertEquals(detectarSaltos(COMPLETO, saude(12900 * FATOR_SALTO - 0.01)).length, 0);
});

Deno.test("o salto tambem vale sobre declaracao simplificada com ficha preenchida", () => {
  // Ficha preenchida informa o NIVEL do gasto mesmo quando ela nao foi usada
  // para deduzir — e o nivel e o que a comparacao mede.
  // Saude 9.720, renda 96.400 -> material 4.820.
  const salto = detectarSaltos(SIMPLIFICADO_COM_FICHA, saude(20000));
  assertEquals(salto.length, 1);
  assertEquals(salto[0].tipo, "SALTO");
  assertEquals(salto[0].valorAnoBase, 9720);
});

Deno.test("ficha vazia silencia o braco 'sem historico' — o caso real de producao", () => {
  // A unica declaracao importada em producao e SIMPLIFICADO com
  // categorias_pagamentos e pagamentos_detalhados vazios. Ausencia de categoria
  // ali NAO e evidencia de ausencia de gasto: e ausencia de itemizacao. Sem este
  // gate, toda despesa de saude de quem usou o desconto simplificado no ano
  // passado viraria ponto de atencao.
  assertEquals(fichaPreenchida(FICHA_VAZIA), false);
  assertEquals(detectarSaltos(FICHA_VAZIA, saude(10000)).length, 0);

  // Controle: a MESMA renda e o MESMO valor deste ano, com a ficha preenchida e
  // sem saude nela, disparam.
  const comFicha: BaselineDeclaracao = {
    ...FICHA_VAZIA,
    categorias_pagamentos: ["EDUCACAO"],
    pagamentos_detalhados: [{ codigo: "01", descricao: "Instrucao no Brasil", valor: 5000 }],
  };
  assertEquals(fichaPreenchida(comFicha), true);
  const saltos = detectarSaltos(comFicha, saude(10000));
  assertEquals(saltos.length, 1);
  assertEquals(saltos[0].tipo, "SEM_HISTORICO");
  assertEquals(saltos[0].valorAnoBase, null);
});

Deno.test("categoria nova de valor pequeno nao vira ponto de atencao", () => {
  const comFicha: BaselineDeclaracao = {
    ...FICHA_VAZIA,
    categorias_pagamentos: ["EDUCACAO"],
    pagamentos_detalhados: [{ codigo: "01", descricao: "Instrucao no Brasil", valor: 5000 }],
  };
  // Renda 60.000 -> material 3.000. Saude de 500 este ano nao e desproporcao.
  assertEquals(detectarSaltos(comFicha, saude(500)).length, 0);
});

Deno.test("sem renda no ano-base o sinal fica em silencio, e nao chuta", () => {
  // Sem denominador nao ha teste de materialidade possivel, e um limiar
  // inventado seria pior do que nao dizer nada — a mesma postura de
  // estimarEconomia.
  assertEquals(detectarSaltos(SEM_RENDA, saude(50000)).length, 0);
  assertEquals(detectarSaltos(null, saude(50000)).length, 0);
});

Deno.test("so SAUDE e EDUCACAO entram na comparacao", () => {
  // As outras categorias do enum nao mapeiam 1 para 1 na ficha de Pagamentos
  // (o raciocinio esta em declaracao_anterior.ts). Comparar seria confrontar
  // rotulos parecidos com significados diferentes.
  const saltos = detectarSaltos(COMPLETO, [
    { categoria: "SERVICOS_PROFISSIONAIS", total_dedutivel: 90000 },
    { categoria: "MORADIA", total_dedutivel: 90000 },
    { categoria: "OUTROS", total_dedutivel: 90000 },
  ]);
  assertEquals(saltos, []);
});

Deno.test("o salto aparece no bloco com os dois anos escritos por extenso", () => {
  const texto = bloco(contagens({ totais_categoria: saude(30000) }), COMPLETO)
    .join("\n");

  // rotuloAnoDeclaracao evita a ambiguidade de "declaracao de 2025": o texto tem
  // que trazer ano-calendario E exercicio.
  assert(/ano-calendário 2025, exercício 2026/.test(texto), texto);
  assert(/R\$ 30\.000,00/.test(texto), texto);
  assert(/R\$ 12\.900,00/.test(texto), texto);
});

// --- 3. marcas por item ----------------------------------------------------

function reciboBase(over: Record<string, unknown> = {}) {
  return {
    categoria: "ESCRITORIO",
    deducibilidade: "DEDUTIVEL",
    status: "APROVADO_AUTOMATICAMENTE",
    documento_prestador: "12.345.678/0001-95",
    estabelecimento: "Papelaria Teste",
    valor_reembolsado: null,
    revisado_em: null,
    criado_em: "2026-08-01T12:00:00.000Z",
    ...over,
  };
}

Deno.test("a marca de identificacao exige os DOIS campos vazios", () => {
  assertEquals(
    pontosAtencaoDoRecibo(reciboBase({ documento_prestador: null, estabelecimento: null }), AGORA),
    [MARCA_SEM_IDENTIFICACAO],
  );
  // Um dos dois basta para identificar o prestador — e a mesma regra que faz o
  // follow-up perguntar um campo so.
  assertEquals(pontosAtencaoDoRecibo(reciboBase({ documento_prestador: null }), AGORA), []);
  assertEquals(pontosAtencaoDoRecibo(reciboBase({ estabelecimento: null }), AGORA), []);
  // String em branco conta como vazio.
  assertEquals(
    pontosAtencaoDoRecibo(reciboBase({ documento_prestador: "  ", estabelecimento: "" }), AGORA),
    [MARCA_SEM_IDENTIFICACAO],
  );
  // Nao dedutivel nao e marcado: falta de prestador nao muda nada no que nao vai
  // ser deduzido.
  assertEquals(
    pontosAtencaoDoRecibo(
      reciboBase({
        documento_prestador: null,
        estabelecimento: null,
        deducibilidade: "NAO_DEDUTIVEL",
      }),
      AGORA,
    ),
    [],
  );
});

Deno.test("reembolso: NULL e lacuna, 0 e resposta", () => {
  assertEquals(
    pontosAtencaoDoRecibo(reciboBase({ categoria: "SAUDE" }), AGORA),
    [MARCA_REEMBOLSO_ABERTO],
  );
  // 0 = o titular confirmou que nao houve. A distincao da migration 010
  // sobrevive ate aqui.
  assertEquals(
    pontosAtencaoDoRecibo(reciboBase({ categoria: "SAUDE", valor_reembolsado: 0 }), AGORA),
    [],
  );
  // Saude nao dedutivel nao precisa de confirmacao: o cruzamento da DMED e com o
  // que foi deduzido.
  assertEquals(
    pontosAtencaoDoRecibo(
      reciboBase({ categoria: "SAUDE", deducibilidade: "NAO_DEDUTIVEL" }),
      AGORA,
    ),
    [],
  );
  // Fora de saude a pergunta nem existe.
  assertEquals(pontosAtencaoDoRecibo(reciboBase({ categoria: "EDUCACAO" }), AGORA), []);
});

Deno.test("uso misto e marcado, e nao acumula a marca de identificacao", () => {
  // PARCIALMENTE_DEDUTIVEL fica fora do sinal de identificacao de proposito: a
  // linha ja aparece no sinal de uso misto, e contar duas vezes inflaria a lista.
  assertEquals(
    pontosAtencaoDoRecibo(
      reciboBase({
        deducibilidade: "PARCIALMENTE_DEDUTIVEL",
        documento_prestador: null,
        estabelecimento: null,
      }),
      AGORA,
    ),
    [MARCA_USO_MISTO],
  );
});

Deno.test("a marca de revisao parada conta os dias a partir de criado_em", () => {
  const emRevisao = (criadoEm: string) =>
    pontosAtencaoDoRecibo(reciboBase({ status: "REVISAO_HUMANA", criado_em: criadoEm }), AGORA);

  // 20/08 menos 31 dias.
  assertEquals(emRevisao("2026-07-20T12:00:00.000Z"), [MARCA_REVISAO_PARADA]);
  // Exatamente no limiar nao marca: a condicao e "mais de".
  assertEquals(emRevisao("2026-07-21T12:00:00.000Z"), []);
  assertEquals(emRevisao("2026-08-19T12:00:00.000Z"), []);

  // Revisado deixa de ser pendencia mesmo velho. A coluna nao e escrita por
  // nenhum componente hoje, e a clausula existe para o sinal continuar certo no
  // dia em que a revisao existir.
  assertEquals(
    pontosAtencaoDoRecibo(
      reciboBase({
        status: "REVISAO_HUMANA",
        criado_em: "2026-01-01T12:00:00.000Z",
        revisado_em: "2026-01-05T12:00:00.000Z",
      }),
      AGORA,
    ),
    [],
  );
});

Deno.test("a celula junta as marcas da linha e fica vazia quando nao ha nenhuma", () => {
  assertEquals(celulaPontosAtencao(reciboBase(), AGORA), "");

  const varias = celulaPontosAtencao(
    reciboBase({
      categoria: "SAUDE",
      documento_prestador: null,
      estabelecimento: null,
      status: "REVISAO_HUMANA",
      criado_em: "2026-06-01T12:00:00.000Z",
    }),
    AGORA,
  );
  assertEquals(
    varias,
    [MARCA_SEM_IDENTIFICACAO, MARCA_REEMBOLSO_ABERTO, MARCA_REVISAO_PARADA].join("; "),
  );
});

// --- 4. o limiar nao pode divergir entre TypeScript e SQL -------------------

Deno.test("o default de p_dias_revisao na migration 012 e o mesmo do modulo", async () => {
  // Sao duas copias do mesmo numero: o texto do bloco diz "ha mais de N dias" e
  // quem conta as linhas e o SQL. Divergirem faria a mensagem afirmar um prazo e
  // a contagem usar outro, sem erro nenhum.
  const sql = await Deno.readTextFile("supabase/migrations/012_pontos_atencao.sql");
  const match = sql.match(/p_dias_revisao\s+int\s+default\s+(\d+)/);
  assert(match, "default de p_dias_revisao nao encontrado na migration 012");
  assertEquals(Number(match[1]), DIAS_REVISAO_PARADA);
});

// --- 5. a fronteira de modulo que o bundle enxerga -------------------------

Deno.test("pontos_atencao.ts nao importa nada, para nao inchar o bundle do export", async () => {
  // A export-contador importa este modulo so pelas marcas por item. Se ele
  // passar a importar declaracao_anterior.ts, a planilha do contador carrega o
  // motor de IRPF e o modulo de follow-up junto, e o deploy_drift_test passa a
  // exigir redeploy da export-contador a cada mudanca de parametro fiscal.
  //
  // E o mesmo tipo de dependencia invisivel do incidente de docs/09: o diff de
  // diretorio nao mostra, o bundle carrega.
  const fonte = await Deno.readTextFile(
    "supabase/functions/_shared/pontos_atencao.ts",
  );
  const imports = [...fonte.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)]
    .map((m) => m[1]);

  assertEquals(imports, [], `pontos_atencao.ts ganhou import: ${imports.join(", ")}`);
});

Deno.test("a export-contador nao alcanca o motor de IRPF pelo caminho novo", async () => {
  const fonte = await Deno.readTextFile("supabase/functions/export-contador/index.ts");
  const locais = [...fonte.matchAll(/from\s+"\.\.\/_shared\/([a-z_]+)\.ts"/g)].map((m) => m[1]);

  assert(locais.includes("pontos_atencao"), "a coluna de pontos de atencao sumiu do export");
  for (const proibido of ["declaracao_anterior", "irpf_calculo", "irpf_parametros", "followup"]) {
    assert(!locais.includes(proibido), `export-contador passou a importar ${proibido}`);
  }
});
