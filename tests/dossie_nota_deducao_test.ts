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
  const texto = NOTA_DEDUCAO.join(" ").toLowerCase();
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

  const texto = textoDoPdf(bytes);
  assert(texto.includes("TaxMind - Dossie Fiscal"), "cabecalho nao encontrado no PDF");
  for (const linha of NOTA_DEDUCAO) {
    // sanitize troca o travessao por hifen antes de desenhar.
    const esperado = linha.replace("—", "-");
    assert(texto.includes(esperado), `nao encontrei no PDF: ${esperado}`);
  }
  // A tabela continua sendo desenhada: a nota nao empurrou o conteudo para fora.
  assert(texto.includes("Consulta medica"));
  assert(texto.includes("Total geral: R$ 770,00"));
});
