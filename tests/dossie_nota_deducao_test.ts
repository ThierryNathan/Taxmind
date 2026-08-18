// Fase 12 - a nota sobre base de calculo no cabecalho do dossie.
//
// Rodar:  deno test --allow-env --allow-net --allow-read --allow-write tests/dossie_nota_deducao_test.ts
//
// buildDossierPdf e exportada justamente para permitir gerar o PDF sem subir a
// function. O teste confere tres coisas que so falhariam em producao:
//   1. o texto cabe na largura util (o cabecalho nao tem quebra automatica);
//   2. sanitize nao come nada do texto (o travessao vira hifen, o resto fica);
//   3. o PDF gerado realmente carrega as frases.
// Ele tambem grava uma copia do PDF num arquivo temporario para inspecao visual.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { inflateSync } from "node:zlib";

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

const { buildDossierPdf, NOTA_DEDUCAO } = await import(
  "../supabase/functions/generate-dossier/index.ts"
);

const LARGURA_UTIL = 595 - 2 * 40;

const RECIBOS = [
  {
    data_despesa: "2026-07-15",
    criado_em: "2026-07-15T12:00:00.000Z",
    descricao: "Consulta medica",
    categoria: "SAUDE",
    valor: 450,
    deducibilidade: "DEDUTIVEL",
    status: "APROVADO_AUTOMATICAMENTE",
  },
  {
    data_despesa: null,
    criado_em: "2026-08-08T12:00:00.000Z",
    descricao: "Mensalidade da faculdade",
    categoria: "EDUCACAO",
    valor: 320,
    deducibilidade: "DEDUTIVEL",
    status: "RECEBIDO",
  },
];

Deno.test("cada linha da nota cabe na largura util da pagina", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const linha of NOTA_DEDUCAO) {
    const largura = font.widthOfTextAtSize(linha.replace("—", "-"), 8);
    assert(largura <= LARGURA_UTIL, `linha estourou a largura (${largura}pt): ${linha}`);
  }
});

Deno.test("a nota diz o que deducao faz e o que ela nao e", () => {
  const texto = semAcento(NOTA_DEDUCAO.join(" ").toLowerCase());
  assert(texto.includes("base de calculo do ir"), texto);
  assert(texto.includes("faixa de tributacao"), texto);
  assert(texto.includes("nao e o valor que voce recebe de volta"), texto);
});

/**
 * Texto desenhado no PDF.
 *
 * Duas armadilhas que fizeram este teste falhar antes de funcionar, e por isso
 * ficam registradas: (1) pdf-lib salva os streams comprimidos, entao procurar a
 * frase nos bytes crus nao acha nada; (2) mesmo inflado, drawText emite string
 * hexadecimal ("<5461784D...> Tj"), nao texto literal. O "nao achei" das duas
 * vezes parece bug do cabecalho e nao e.
 */
function textoDoPdf(bytes: Uint8Array): string {
  const bruto = new TextDecoder("latin1").decode(bytes);
  const pedacos: string[] = [];

  const marcador = /stream\r?\n/g;
  let achado: RegExpExecArray | null;
  while ((achado = marcador.exec(bruto)) !== null) {
    const inicio = achado.index + achado[0].length;
    const fim = bruto.indexOf("endstream", inicio);
    if (fim < 0) continue;

    const comprimido = bytes.slice(inicio, fim);
    try {
      // node:zlib e nao DecompressionStream: o Web API recusa os bytes de
      // sobra que o PDF deixa depois do fim do fluxo zlib ("failed to write
      // whole buffer"), enquanto o inflateSync ignora, que e o comportamento
      // que os leitores de PDF tambem tem.
      pedacos.push(new TextDecoder("latin1").decode(inflateSync(comprimido)));
    } catch {
      // Nem todo stream do arquivo e Flate (xref, por exemplo).
      pedacos.push(new TextDecoder("latin1").decode(comprimido));
    }
  }

  // Os bytes sao WinAnsi, que coincide com Latin-1 no range que o sanitize
  // deixa passar.
  return pedacos.join("\n").replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_todo, hex: string) =>
    hex.replace(/../g, (par) => String.fromCharCode(parseInt(par, 16))));
}

Deno.test("o PDF gerado carrega a nota no cabecalho", async () => {
  const bytes = await buildDossierPdf("Contribuinte de Teste", RECIBOS as never);

  // Copia em disco para inspecao visual, fora do repositorio: o PDF e artefato
  // gerado, nao fixture versionada.
  const arquivo = await Deno.makeTempFile({ prefix: "dossie-fase12-", suffix: ".pdf" });
  await Deno.writeFile(arquivo, bytes);
  console.log(`dossie gerado para inspecao: ${arquivo}`);

  assertEquals(new TextDecoder("latin1").decode(bytes.slice(0, 5)), "%PDF-");

  const texto = semAcento(textoDoPdf(bytes));
  assert(texto.includes("TaxMind - Dossie Fiscal"), "cabecalho nao encontrado no PDF");
  for (const linha of NOTA_DEDUCAO) {
    // sanitize troca o travessao por hifen antes de desenhar.
    const esperado = semAcento(linha.replace("—", "-"));
    assert(texto.includes(esperado), `nao encontrei no PDF: ${esperado}`);
  }
  // A tabela continua sendo desenhada: a nota nao empurrou o conteudo para fora.
  assert(texto.includes("Consulta medica"));
  assert(texto.includes("Total geral: R$ 770,00"));
});

// --- Fase 15: reembolso no dossie -----------------------------------------

const RECIBOS_COM_REEMBOLSO = [
  {
    data_despesa: "2026-08-01",
    criado_em: "2026-08-01T12:00:00.000Z",
    descricao: "Consulta com dermatologista",
    categoria: "SAUDE",
    valor: 400,
    valor_reembolsado: 150,
    deducibilidade: "DEDUTIVEL",
    status: "APROVADO_AUTOMATICAMENTE",
  },
  {
    data_despesa: "2026-08-02",
    criado_em: "2026-08-02T12:00:00.000Z",
    descricao: "Consulta odontologica",
    categoria: "SAUDE",
    valor: 250,
    // 0 e resposta do titular: ele confirmou que nao houve reembolso.
    valor_reembolsado: 0,
    deducibilidade: "DEDUTIVEL",
    status: "APROVADO_AUTOMATICAMENTE",
  },
  {
    data_despesa: "2026-08-03",
    criado_em: "2026-08-03T12:00:00.000Z",
    descricao: "Exame de imagem",
    categoria: "SAUDE",
    valor: 300,
    valor_reembolsado: 300,
    deducibilidade: "NAO_DEDUTIVEL",
    status: "APROVADO_AUTOMATICAMENTE",
  },
  {
    data_despesa: "2026-08-04",
    criado_em: "2026-08-04T12:00:00.000Z",
    descricao: "Mensalidade da faculdade",
    categoria: "EDUCACAO",
    valor: 320,
    // null e lacuna: a pergunta nunca foi feita nesta despesa.
    valor_reembolsado: null,
    deducibilidade: "DEDUTIVEL",
    status: "RECEBIDO",
  },
];

Deno.test("as colunas somam exatamente a largura util", async () => {
  // A tabela nao tem quebra: se a soma passar de 515pt, a ultima coluna vaza a
  // margem direita silenciosamente. A coluna Reembolso entrou tirando espaco
  // das outras, e este teste e o que garante que continuou assim.
  const { COLUMNS } = await import("../supabase/functions/generate-dossier/index.ts");
  const soma = COLUMNS.reduce((total: number, c: { width: number }) => total + c.width, 0);
  assertEquals(soma, LARGURA_UTIL);

  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const coluna of COLUMNS) {
    const largura = bold.widthOfTextAtSize(coluna.label, 9);
    assert(
      largura <= coluna.width,
      `o titulo "${coluna.label}" (${largura}pt) nao cabe em ${coluna.width}pt`,
    );
  }
});

Deno.test("o dossie mostra bruto, reembolso e liquido sem apagar nenhum", async () => {
  const bytes = await buildDossierPdf("Contribuinte de Teste", RECIBOS_COM_REEMBOLSO as never);
  const texto = semAcento(textoDoPdf(bytes));

  // O bruto continua na linha: e ele que a nota fiscal comprova, e e sobre ele
  // que o cruzamento da DMED acontece.
  assert(texto.includes("R$ 400,00"), "valor bruto sumiu da linha");
  assert(texto.includes("R$ 150,00"), "reembolso nao aparece na linha");

  // Total geral e o bruto gasto: reembolso nao desfaz o desembolso.
  assert(texto.includes("Total geral: R$ 1270,00"), texto.slice(-400));
  assert(texto.includes("Total reembolsado: R$ 450,00"), "total reembolsado ausente");

  // Dedutivel liquido: (400 - 150) + (250 - 0) + (320 - 0) = 820. O exame de
  // 300 esta NAO_DEDUTIVEL e fica de fora, como no resumo_fiscal_usuario — e a
  // mensalidade com valor_reembolsado null entra pelo bruto, que e o que o
  // coalesce da RPC tambem faz.
  assert(
    texto.includes("Total dedutivel (liquido do reembolso): R$ 820,00"),
    "total dedutivel liquido ausente ou errado",
  );
});

Deno.test("despesa sem pergunta de reembolso mostra traco, nao zero", async () => {
  // A distincao NULL x 0 chega ate o papel: traco e lacuna que o contador pode
  // querer preencher, R$ 0,00 e resposta que o titular ja deu. Uma linha so em
  // cada PDF, para que "R$ 0,00" so possa ter vindo da coluna de reembolso.
  const semPergunta = textoDoPdf(
    await buildDossierPdf("Contribuinte de Teste", [RECIBOS_COM_REEMBOLSO[3]] as never),
  );
  assert(semPergunta.includes("Mensalidade da faculdade"));
  assert(
    !semPergunta.includes("R$ 0,00"),
    "lacuna de reembolso foi desenhada como zero: NULL e 0 viraram a mesma coisa no papel",
  );
  assert(!semPergunta.includes("Total reembolsado"), "rodape apareceu sem reembolso informado");

  // A mesma tabela com a resposta "nao houve" precisa mostrar o zero.
  const respondida = textoDoPdf(
    await buildDossierPdf("Contribuinte de Teste", [RECIBOS_COM_REEMBOLSO[1]] as never),
  );
  assert(respondida.includes("Consulta odontologica"));
  assert(respondida.includes("R$ 0,00"), "reembolso zero confirmado nao aparece no papel");
});

Deno.test("dossie sem reembolso nenhum continua identico ao de antes", async () => {
  // As duas linhas novas do rodape sao condicionais de proposito: um
  // "Total reembolsado: R$ 0,00" em todo dossie sugeriria uma pergunta que
  // nunca foi feita.
  const bytes = await buildDossierPdf("Contribuinte de Teste", RECIBOS as never);
  const texto = textoDoPdf(bytes);

  assert(texto.includes("Total geral: R$ 770,00"));
  assert(!texto.includes("Total reembolsado"));
  assert(!texto.includes("Total dedutivel"));
});
