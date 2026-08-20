// Export estruturado para o contador — classificacao fiscal e planilha gerada.
//
// Rodar: deno test --allow-env --allow-net --allow-read --allow-write tests/export_contador_test.ts
//
// O QUE ESTE ARQUIVO PROTEGE
//
// A parte que erra caro nao e a geracao do xlsx, e a tabela de "qual categoria
// vai para qual mecanismo de deducao". Um erro ali nao quebra nada: gera um
// arquivo bonito que manda o contador deduzir o que a Receita glosa, ou esconde
// dele uma deducao real. Por isso o primeiro bloco cobre os DOZE membros do
// enum, um a um, e ha uma guarda que falha se a migration ganhar um membro
// novo sem passar por aqui.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

import {
  CATEGORIAS_LIVRO_CAIXA,
  CATEGORIAS_PAGAMENTOS_EFETUADOS,
  CATEGORIAS_PESSOAIS_COM_NEXO,
  CATEGORIAS_SEMPRE_FORA,
  secaoDoRecibo,
  valorLiquido,
} from "../supabase/functions/_shared/export_contador.ts";

/** Comparacao insensivel a acento.
 *
 * As asserssoes deste arquivo cobram CONTEUDO ("a nota fala de base de
 * calculo?"), nao ortografia — e a varredura de acentuacao de 2026-08-16
 * mostrou que cravar a grafia aqui transforma correcao de texto em quebra de
 * teste. A grafia tem dono proprio: os testes de espelho comparam texto a
 * texto entre as copias vivas.
 */
function semAcento(valor: string): string {
  return valor.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_de_teste");

const {
  ABA_LIVRO_CAIXA,
  ABA_PAGAMENTOS,
  buildExportXlsx,
  CABECALHO_TABELA,
  COLUNAS_MOEDA,
  NOTA_LIVRO_CAIXA,
  NOTA_PAGAMENTOS,
  NOTA_TRANSPORTE_FORA,
} = await import("../supabase/functions/export-contador/index.ts");

const APROVADO = "APROVADO_AUTOMATICAMENTE";

function recibo(over: Record<string, unknown> = {}) {
  return {
    data_despesa: "2026-03-10",
    criado_em: "2026-03-10T12:00:00.000Z",
    descricao: "Despesa de teste",
    estabelecimento: "Estabelecimento Teste",
    documento_prestador: "12.345.678/0001-95",
    categoria: "SAUDE",
    valor: 100,
    valor_reembolsado: null,
    deducibilidade: "DEDUTIVEL",
    status: APROVADO,
    // Nenhum componente escreve esta coluna hoje (nao ha painel de revisao no
    // MVP), entao null e o estado real de toda linha do banco.
    revisado_em: null,
    ...over,
  };
}

// --- 1. a tabela fiscal, membro a membro do enum -------------------------

Deno.test("cada categoria do enum cai na secao certa", () => {
  // deducibilidade DEDUTIVEL em todas de proposito: assim o teste isola o
  // efeito da CATEGORIA. O efeito da dedutibilidade tem bloco proprio abaixo.
  const esperado: Record<string, string | null> = {
    // Ficha "Pagamentos Efetuados" — deducao pessoal universal.
    SAUDE: "PAGAMENTOS_EFETUADOS",
    EDUCACAO: "PAGAMENTOS_EFETUADOS",
    // Livro-Caixa por natureza da categoria.
    ESCRITORIO: "LIVRO_CAIXA",
    EQUIPAMENTOS: "LIVRO_CAIXA",
    SOFTWARE: "LIVRO_CAIXA",
    INTERNET_TELEFONIA: "LIVRO_CAIXA",
    SERVICOS_PROFISSIONAIS: "LIVRO_CAIXA",
    // Conselho profissional (CRM/CRO/OAB) e ISS caem aqui pelo proprio prompt
    // fiscal, e sao despesa de custeio classica do livro-caixa.
    IMPOSTOS_TAXAS: "LIVRO_CAIXA",
    // Pessoais que passam quando a IA declarou nexo profissional.
    MORADIA: "LIVRO_CAIXA",
    ALIMENTACAO: "LIVRO_CAIXA",
    OUTROS: "LIVRO_CAIXA",
    // Vedacao do art. 68 do RIR/2018: nem com nexo declarado.
    TRANSPORTE: null,
  };

  for (const [categoria, secao] of Object.entries(esperado)) {
    assertEquals(
      secaoDoRecibo({ categoria, deducibilidade: "DEDUTIVEL", status: APROVADO }),
      secao,
      `categoria ${categoria}`,
    );
  }
});

Deno.test("a tabela cobre exatamente o enum da migration 001", async () => {
  // Guarda contra a falha silenciosa: um decimo terceiro membro no enum entraria
  // no schema, cairia no default do secaoDoRecibo (null) e sumiria do export sem
  // ninguem notar. Aqui ele quebra o teste.
  const sql = await Deno.readTextFile(
    "supabase/migrations/001_init_taxmind_schema.sql",
  );
  const bloco = sql.match(
    /create type public\.categoria_fiscal as enum \(([^)]*)\)/,
  );
  assert(bloco, "enum categoria_fiscal nao encontrado na migration 001");

  const doEnum = [...bloco[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  const cobertas = [
    ...CATEGORIAS_PAGAMENTOS_EFETUADOS,
    ...CATEGORIAS_LIVRO_CAIXA,
    ...CATEGORIAS_PESSOAIS_COM_NEXO,
    ...CATEGORIAS_SEMPRE_FORA,
  ].sort();

  assertEquals(doEnum.length, 12, "o enum deixou de ter 12 membros");
  assertEquals(cobertas, doEnum);
});

// --- 2. o escape das categorias pessoais ----------------------------------

Deno.test("categoria pessoal so entra com nexo profissional ja julgado", () => {
  // O caso concreto: aluguel de consultorio e rateio de home office sao gravados
  // como MORADIA, e o proprio prompt manda marca-los PARCIALMENTE_DEDUTIVEL.
  // Um filtro so por categoria descartaria exatamente essa despesa.
  for (const deducibilidade of ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"]) {
    assertEquals(
      secaoDoRecibo({ categoria: "MORADIA", deducibilidade, status: APROVADO }),
      "LIVRO_CAIXA",
      deducibilidade,
    );
  }

  // INDETERMINADO e a AUSENCIA de julgamento. Promover por ausencia levaria
  // toda conta de luz residencial para a planilha do contador.
  for (const deducibilidade of ["INDETERMINADO", "NAO_DEDUTIVEL"]) {
    assertEquals(
      secaoDoRecibo({ categoria: "MORADIA", deducibilidade, status: APROVADO }),
      null,
      deducibilidade,
    );
  }
});

Deno.test("categoria profissional entra mesmo sem julgamento de dedutibilidade", () => {
  // Assimetria proposital com o bloco acima: a natureza da categoria ja e o
  // nexo. Uma nota fiscal de software marcada INDETERMINADO e exatamente o
  // material que o contador precisa ver para decidir, e nao um descarte.
  for (const deducibilidade of ["INDETERMINADO", "DEDUTIVEL"]) {
    assertEquals(
      secaoDoRecibo({ categoria: "SOFTWARE", deducibilidade, status: APROVADO }),
      "LIVRO_CAIXA",
      deducibilidade,
    );
  }
});

Deno.test("a vedacao legal do transporte vence o nexo declarado", () => {
  // Se a ordem dos testes em secaoDoRecibo inverter, TRANSPORTE + DEDUTIVEL
  // passa a cair no escape das categorias pessoais e vira deducao vedada.
  for (const deducibilidade of ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"]) {
    assertEquals(
      secaoDoRecibo({ categoria: "TRANSPORTE", deducibilidade, status: APROVADO }),
      null,
      deducibilidade,
    );
  }
});

Deno.test("recibo rejeitado ou arquivado nunca vai para o contador", () => {
  for (const status of ["REJEITADO", "ARQUIVADO"]) {
    assertEquals(
      secaoDoRecibo({ categoria: "SAUDE", deducibilidade: "DEDUTIVEL", status }),
      null,
      status,
    );
  }

  // Os demais status seguem: REVISAO_HUMANA e justamente o que o contador
  // precisa ver.
  for (const status of ["RECEBIDO", "PROCESSANDO", "REVISAO_HUMANA", APROVADO]) {
    assertEquals(
      secaoDoRecibo({ categoria: "SAUDE", deducibilidade: "DEDUTIVEL", status }),
      "PAGAMENTOS_EFETUADOS",
      status,
    );
  }
});

// --- 3. valor liquido -----------------------------------------------------

Deno.test("valor liquido desconta so o reembolso informado", () => {
  assertEquals(valorLiquido(400, null), 400, "NULL = nunca perguntado");
  assertEquals(valorLiquido(400, 0), 400, "0 = titular confirmou que nao houve");
  assertEquals(valorLiquido(400, 150), 250, "reembolso parcial");
  assertEquals(valorLiquido(400, 400), 0, "reembolso integral");
  // PostgREST devolve numeric como string.
  assertEquals(valorLiquido("400.00", "150.50"), 249.5, "numeric como string");
});

// --- 4. a planilha gerada -------------------------------------------------

const RECIBOS = [
  recibo({
    data_despesa: "2026-02-05",
    descricao: "Consulta medica",
    categoria: "SAUDE",
    valor: 400,
    valor_reembolsado: 150,
  }),
  recibo({
    data_despesa: "2026-03-01",
    descricao: "Mensalidade da faculdade",
    categoria: "EDUCACAO",
    valor: 900,
    valor_reembolsado: null,
  }),
  recibo({
    data_despesa: "2026-04-02",
    descricao: "Exame de sangue",
    categoria: "SAUDE",
    valor: 200,
    valor_reembolsado: 0,
  }),
  recibo({
    data_despesa: "2026-05-03",
    descricao: "Anuidade do conselho",
    categoria: "IMPOSTOS_TAXAS",
    valor: 700,
    deducibilidade: "INDETERMINADO",
    status: "REVISAO_HUMANA",
  }),
  recibo({
    data_despesa: "2026-06-04",
    descricao: "Aluguel do consultorio",
    categoria: "MORADIA",
    valor: 1500,
    deducibilidade: "PARCIALMENTE_DEDUTIVEL",
  }),
  // As tres abaixo NAO podem aparecer em aba nenhuma.
  recibo({ descricao: "Uber para o cliente", categoria: "TRANSPORTE", valor: 30 }),
  recibo({
    descricao: "Conta de luz de casa",
    categoria: "MORADIA",
    valor: 250,
    deducibilidade: "INDETERMINADO",
  }),
  recibo({
    descricao: "Consulta cancelada",
    categoria: "SAUDE",
    valor: 999,
    status: "REJEITADO",
  }),
];

// cellNF: true nao e detalhe — sem ele o XLSX.read simplesmente NAO popula
// celula.z, e a assercao de formato de moeda falha com o arquivo correto na mao.
function abrir(bytes: Uint8Array) {
  return XLSX.read(bytes, { type: "array", cellDates: true, cellNF: true });
}

/** Todo o texto de uma aba, para busca de frase. */
function textoDaAba(wb: XLSX.WorkBook, aba: string): string {
  return XLSX.utils
    .sheet_to_json(wb.Sheets[aba], { header: 1, raw: false })
    .map((linha) => (linha as unknown[]).join(" | "))
    .join("\n");
}

/** As linhas de dados de uma aba, ja sem cabecalho, notas e total. */
function linhasDeDados(wb: XLSX.WorkBook, aba: string): unknown[][] {
  const todas = XLSX.utils.sheet_to_json(wb.Sheets[aba], {
    header: 1,
    raw: true,
  }) as unknown[][];
  const inicio = todas.findIndex((l) => l[0] === CABECALHO_TABELA[0]);
  return todas
    .slice(inicio + 1)
    .filter((l) => l.length > 1 && l[0] !== "TOTAL");
}

Deno.test("o arquivo tem as duas abas, rotuladas e separadas", () => {
  const { bytes, totalPagamentos, totalLivroCaixa } = buildExportXlsx(
    "Maria Teste",
    RECIBOS,
  );

  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "nao e um zip (xlsx valido)");

  const wb = abrir(bytes);
  assertEquals(wb.SheetNames, [ABA_PAGAMENTOS, ABA_LIVRO_CAIXA]);
  // Limite do Excel; passar disso corrompe o arquivo ao abrir.
  for (const nome of wb.SheetNames) {
    assert(nome.length <= 31, `nome de aba longo demais: ${nome}`);
  }

  assertEquals(totalPagamentos, 3, "2 SAUDE validas + 1 EDUCACAO");
  assertEquals(totalLivroCaixa, 2, "IMPOSTOS_TAXAS + MORADIA com nexo");
});

Deno.test("a nota do carne-leao esta na aba de Livro-Caixa, acima do cabecalho", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);

  const texto = textoDaAba(wb, ABA_LIVRO_CAIXA);
  assert(texto.includes(NOTA_LIVRO_CAIXA), "nota do carne-leao ausente");
  assert(texto.includes(NOTA_TRANSPORTE_FORA), "aviso sobre transporte ausente");

  // Acima do cabecalho, e nao como rodape: um "ordenar por valor" na faixa de
  // dados levaria embora uma nota de rodape, e essa nota e a unica coisa que
  // impede um assalariado de usar a aba.
  const linhas = texto.split("\n");
  const posNota = linhas.findIndex((l) => l.includes(NOTA_LIVRO_CAIXA));
  const posCabecalho = linhas.findIndex((l) => l.startsWith(CABECALHO_TABELA[0]));
  assert(posNota < posCabecalho, "a nota caiu abaixo do cabecalho da tabela");

  // E a nota do carne-leao NAO pode vazar para a aba de deducao universal: ela
  // diria a um assalariado que suas despesas de saude dependem de carne-leao.
  const textoPagamentos = textoDaAba(wb, ABA_PAGAMENTOS);
  assert(
    !textoPagamentos.includes(NOTA_LIVRO_CAIXA),
    "nota do carne-leao vazou para Pagamentos Efetuados",
  );
  assert(textoPagamentos.includes(NOTA_PAGAMENTOS), "nota do limite de educacao ausente");
});

Deno.test("o cabecalho traz preparo, nome e periodo coberto", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);

  for (const aba of [ABA_PAGAMENTOS, ABA_LIVRO_CAIXA]) {
    const texto = textoDaAba(wb, aba);
    assert(semAcento(texto).includes("Preparado para revisao contabil"), aba);
    assert(texto.includes("Maria Teste"), `nome ausente em ${aba}`);
    // Periodo das linhas EXPORTADAS: 05/02 (primeira saude) a 04/06 (moradia).
    // As descartadas usam 10/03 e nao podem esticar nem encurtar a faixa.
    assert(texto.includes("05/02/2026"), `inicio do periodo errado em ${aba}`);
    assert(texto.includes("04/06/2026"), `fim do periodo errado em ${aba}`);
  }

  // Sem nome de contador em lugar nenhum: nao ha registro real para citar.
  const tudo = wb.SheetNames.map((n) => textoDaAba(wb, n)).join("\n").toLowerCase();
  assert(!tudo.includes("contador_responsavel"), "vazou contador_responsavel_id");
});

Deno.test("as despesas descartadas nao aparecem em aba nenhuma", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);
  const tudo = wb.SheetNames.map((n) => textoDaAba(wb, n)).join("\n");

  for (const descricao of [
    "Uber para o cliente", // vedacao do art. 68
    "Conta de luz de casa", // pessoal sem nexo declarado
    "Consulta cancelada", // REJEITADO
  ]) {
    assert(!tudo.includes(descricao), `vazou para o export: ${descricao}`);
  }

  // E as que devem aparecer, aparecem — senao o teste acima passaria com um
  // arquivo vazio.
  for (const descricao of ["Consulta medica", "Anuidade do conselho", "Aluguel do consultorio"]) {
    assert(tudo.includes(descricao), `faltou no export: ${descricao}`);
  }
});

Deno.test("valor e data sao dados tipados, nao texto", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);
  const aba = wb.Sheets[ABA_PAGAMENTOS];

  // O ponto de gerar xlsx em vez de csv: o contador soma e filtra sem
  // reimportar. Se o valor virar string, a planilha parece certa e a soma nao
  // funciona.
  const linhas = linhasDeDados(wb, ABA_PAGAMENTOS);
  const primeira = linhas[0];
  assertEquals(typeof primeira[5], "number", "valor bruto deveria ser numero");
  assertEquals(primeira[5], 400);
  assertEquals(primeira[7], 250, "liquido = 400 - 150");
  assert(primeira[0] instanceof Date, "data deveria ser data de verdade");

  // Formato de exibicao aplicado por indice de coluna.
  let achouMoeda = false;
  let achouData = false;
  for (const ref of Object.keys(aba)) {
    if (ref.startsWith("!")) continue;
    if (aba[ref].z === '"R$" #,##0.00') achouMoeda = true;
    if (aba[ref].z === "dd/mm/yyyy") achouData = true;
  }
  assert(achouMoeda, "nenhuma celula recebeu formato de moeda");
  assert(achouData, "nenhuma celula recebeu formato de data");
});

Deno.test("reembolso NULL fica vazio e 0 fica zero", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);
  const linhas = linhasDeDados(wb, ABA_PAGAMENTOS);

  // Ordem por data: 05/02 saude (reembolso 150), 01/03 educacao (NULL),
  // 02/04 exame (0).
  const educacao = linhas.find((l) => l[1] === "Mensalidade da faculdade");
  const exame = linhas.find((l) => l[1] === "Exame de sangue");
  assert(educacao && exame);

  // A distincao vem da migration 010 e precisa sobreviver ate a celula: vazio e
  // uma lacuna que o contador pode preencher, 0 e uma resposta que ja foi dada.
  assertEquals(educacao[6], undefined, "NULL deveria virar celula vazia");
  assertEquals(exame[6], 0, "0 deveria virar zero, e nao vazio");
  assertEquals(educacao[7], 900, "liquido sem reembolso = bruto");
  assertEquals(exame[7], 200);
});

Deno.test("a linha de TOTAL soma so o que esta na aba", () => {
  const { bytes } = buildExportXlsx("Maria Teste", RECIBOS);
  const wb = abrir(bytes);

  const todas = XLSX.utils.sheet_to_json(wb.Sheets[ABA_PAGAMENTOS], {
    header: 1,
    raw: true,
  }) as unknown[][];
  const total = todas.find((l) => l[0] === "TOTAL");
  assert(total, "linha de TOTAL ausente");

  assertEquals(total[5], 1500, "bruto: 400 + 900 + 200");
  assertEquals(total[6], 150, "reembolso: 150 + 0, e NULL nao conta");
  assertEquals(total[7], 1350, "liquido: 1500 - 150");

  const totalLc = (XLSX.utils.sheet_to_json(wb.Sheets[ABA_LIVRO_CAIXA], {
    header: 1,
    raw: true,
  }) as unknown[][]).find((l) => l[0] === "TOTAL");
  assert(totalLc);
  assertEquals(totalLc[5], 2200, "livro-caixa: 700 + 1500, sem tocar em saude");
});

Deno.test("usuario sem despesa exportavel ainda recebe as duas abas", () => {
  // O caminho vazio precisa gerar arquivo valido: cair aqui com excecao deixaria
  // o usuario sem resposta nenhuma no WhatsApp.
  const { bytes, totalPagamentos, totalLivroCaixa } = buildExportXlsx("Joao Novo", []);
  const wb = abrir(bytes);

  assertEquals(wb.SheetNames, [ABA_PAGAMENTOS, ABA_LIVRO_CAIXA]);
  assertEquals(totalPagamentos, 0);
  assertEquals(totalLivroCaixa, 0);

  for (const aba of wb.SheetNames) {
    const texto = textoDaAba(wb, aba);
    assert(semAcento(texto).includes("Nenhuma despesa desta natureza"), aba);
    assert(semAcento(texto).includes("sem lancamentos"), `periodo vazio errado em ${aba}`);
  }
  // A nota do carne-leao vale mesmo com a aba vazia: ela explica o mecanismo,
  // nao as linhas.
  assert(textoDaAba(wb, ABA_LIVRO_CAIXA).includes(NOTA_LIVRO_CAIXA));
});

Deno.test("a coluna de pontos de atencao e a ultima, e marca linha a linha", () => {
  // Fase 18. A coluna e a ULTIMA de proposito: acrescentar no meio deslocaria
  // COLUNAS_MOEDA e a formatacao de dinheiro cairia na coluna errada.
  const iAtencao = CABECALHO_TABELA.length - 1;
  assertEquals(CABECALHO_TABELA[iAtencao], "Pontos de atenção");
  for (const indice of COLUNAS_MOEDA) assert(indice < iAtencao);

  const agora = new Date("2026-08-20T12:00:00.000Z");
  const { bytes } = buildExportXlsx("Maria Teste", [
    recibo({
      descricao: "Consulta sem prestador",
      categoria: "SAUDE",
      documento_prestador: null,
      estabelecimento: null,
      valor_reembolsado: null,
      status: "REVISAO_HUMANA",
      criado_em: "2026-06-01T12:00:00.000Z",
      data_despesa: "2026-06-01",
    }),
    recibo({
      descricao: "Consulta completa",
      categoria: "SAUDE",
      valor_reembolsado: 0,
      data_despesa: "2026-06-02",
    }),
  ], agora);

  const linhas = linhasDeDados(abrir(bytes), ABA_PAGAMENTOS);
  const marcada = linhas.find((l) => l[1] === "Consulta sem prestador");
  const limpa = linhas.find((l) => l[1] === "Consulta completa");
  assert(marcada && limpa);

  // As tres marcas aplicaveis, na ordem em que o modulo as produz.
  assertEquals(
    marcada[iAtencao],
    "sem identificação do prestador; reembolso não confirmado; em revisão há mais de 30 dias",
  );
  // Linha sem nenhuma marca fica com a celula em branco: um "-" ou um "ok"
  // sugeriria conformidade verificada, que o sistema nao tem como afirmar.
  //
  // String vazia, e nao celula ausente como no reembolso: la o vazio CARREGA
  // significado (lacuna contra resposta) e por isso a celula nao existe; aqui
  // ausencia de marca e so ausencia, e manter todas as linhas com a mesma
  // largura preserva a faixa de dados para o autofiltro do Excel.
  assertEquals(limpa[iAtencao], "");
});

Deno.test("COLUNAS_MOEDA aponta para as colunas de dinheiro do cabecalho", () => {
  // O formato de moeda e aplicado por INDICE. Inserir uma coluna no meio do
  // CABECALHO_TABELA sem mexer aqui formataria a coluna errada — e a planilha
  // continuaria abrindo, so que com "R$ Consulta medica".
  for (const indice of COLUNAS_MOEDA) {
    assert(
      CABECALHO_TABELA[indice].includes("R$"),
      `coluna ${indice} (${CABECALHO_TABELA[indice]}) nao e de dinheiro`,
    );
  }
  const deDinheiro = CABECALHO_TABELA
    .map((rotulo, i) => (rotulo.includes("R$") ? i : -1))
    .filter((i) => i >= 0);
  assertEquals(COLUNAS_MOEDA, deDinheiro, "ha coluna de dinheiro sem formato");
});
