// Gerador do PDF sintetico de declaracao usado nos testes de extracao.
//
// Nao ha (e nao pode haver) PDF real de declaracao de ninguem no repositorio:
// o arquivo do portal MIR carrega nome, CPF, renda e dependentes de uma pessoa
// fisica. Este gerador reproduz a ESTRUTURA que a extracao precisa enxergar —
// cabecalho de exercicio, o bloco "RESUMO — TRIBUTACAO UTILIZANDO O DESCONTO
// SIMPLIFICADO" com a aliquota efetiva, e a ficha "PAGAMENTOS EFETUADOS" com os
// codigos de deducao — com dados inventados.
//
// Duas paginas de proposito: o bloco do resumo e a ficha de pagamentos caem em
// paginas diferentes no arquivo real, e um extrator que so olhasse a primeira
// pagina passaria num fixture de pagina unica.
//
// Rodar: deno run --allow-net --allow-write tests/fixtures/gerar_declaracao_sintetica.ts

import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

type Linha = { texto: string; negrito?: boolean; tamanho?: number; espaco?: number };

export type ModeloDeclaracao = {
  slug: string;
  paginas: Linha[][];
};

const CABECALHO_COMUM: Linha[] = [
  { texto: "MINISTERIO DA FAZENDA", tamanho: 8 },
  { texto: "SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL", tamanho: 8 },
  { texto: "IMPOSTO SOBRE A RENDA DA PESSOA FISICA", negrito: true, tamanho: 12 },
  { texto: "DECLARACAO DE AJUSTE ANUAL", negrito: true, tamanho: 12, espaco: 18 },
];

const IDENTIFICACAO: Linha[] = [
  { texto: "IDENTIFICACAO DO CONTRIBUINTE", negrito: true, tamanho: 10 },
  { texto: "Nome: CONTRIBUINTE SINTETICO DE TESTE" },
  { texto: "CPF: ***.***.***-**" },
  { texto: "Natureza da ocupacao: 61 - Profissional autonomo", espaco: 18 },
];

/** Simplificado: a aliquota efetiva aparece no bloco do desconto simplificado e
 *  a ficha de pagamentos existe, mas nao foi usada para deduzir. */
const SIMPLIFICADO: ModeloDeclaracao = {
  slug: "simplificado",
  paginas: [
    [
      ...CABECALHO_COMUM,
      { texto: "Exercicio 2026 - Ano-calendario 2025", negrito: true, espaco: 18 },
      ...IDENTIFICACAO,
      { texto: "RESUMO - TRIBUTACAO UTILIZANDO O DESCONTO SIMPLIFICADO", negrito: true, tamanho: 10 },
      { texto: "Esta e a opcao pela qual a declaracao foi apresentada." },
      { texto: "Rendimentos tributaveis recebidos de PF/exterior .......... 96.400,00" },
      { texto: "Desconto simplificado ..................................... 16.754,34" },
      { texto: "Base de calculo do imposto ................................ 79.645,66" },
      { texto: "Imposto sobre a renda apurado ............................. 11.320,42" },
      { texto: "Aliquota efetiva sobre os rendimentos tributaveis ......... 11,74%" },
      { texto: "Imposto a pagar ...........................................  2.118,00", espaco: 18 },
      { texto: "RESUMO - TRIBUTACAO UTILIZANDO TODAS AS DEDUCOES", negrito: true, tamanho: 10 },
      { texto: "Base de calculo do imposto ................................ 82.918,50" },
      { texto: "Imposto sobre a renda apurado ............................. 12.220,54" },
      { texto: "Aliquota efetiva sobre os rendimentos tributaveis ......... 12,67%" },
    ],
    [
      { texto: "PAGAMENTOS EFETUADOS", negrito: true, tamanho: 10 },
      { texto: "Codigo  Descricao                                    Valor pago" },
      { texto: "10      Despesas medicas no Brasil                     3.480,00" },
      { texto: "        Beneficiario: o proprio contribuinte" },
      { texto: "11      Plano de saude no Brasil                       6.240,00" },
      { texto: "01      Instrucao no Brasil                            4.150,00" },
      { texto: "        Beneficiario: dependente" },
      { texto: "60      Previdencia complementar                       2.400,00", espaco: 18 },
      { texto: "DOACOES EFETUADAS", negrito: true, tamanho: 10 },
      { texto: "Nao ha valores informados nesta ficha." },
    ],
  ],
};

/** Completo: a mesma estrutura, com o bloco de todas as deducoes marcado como a
 *  opcao apresentada. Serve para provar que a extracao le a MARCACAO, e nao a
 *  simples presenca do bloco do desconto simplificado — que existe nos dois. */
const COMPLETO: ModeloDeclaracao = {
  slug: "completo",
  paginas: [
    [
      ...CABECALHO_COMUM,
      { texto: "Exercicio 2026 - Ano-calendario 2025", negrito: true, espaco: 18 },
      ...IDENTIFICACAO,
      { texto: "RESUMO - TRIBUTACAO UTILIZANDO TODAS AS DEDUCOES", negrito: true, tamanho: 10 },
      { texto: "Esta e a opcao pela qual a declaracao foi apresentada." },
      { texto: "Rendimentos tributaveis recebidos de PF/exterior ......... 142.800,00" },
      { texto: "Deducoes .................................................. 38.512,00" },
      { texto: "Base de calculo do imposto ............................... 104.288,00" },
      { texto: "Imposto sobre a renda apurado ............................. 17.905,60" },
      { texto: "Aliquota efetiva sobre os rendimentos tributaveis .......... 8,32%" },
      { texto: "Imposto a restituir .......................................  1.940,00", espaco: 18 },
      { texto: "RESUMO - TRIBUTACAO UTILIZANDO O DESCONTO SIMPLIFICADO", negrito: true, tamanho: 10 },
      { texto: "Base de calculo do imposto ............................... 126.045,66" },
      { texto: "Imposto sobre a renda apurado ............................. 23.887,20" },
      { texto: "Aliquota efetiva sobre os rendimentos tributaveis ......... 16,73%" },
    ],
    [
      { texto: "PAGAMENTOS EFETUADOS", negrito: true, tamanho: 10 },
      { texto: "Codigo  Descricao                                    Valor pago" },
      { texto: "10      Despesas medicas no Brasil                    12.900,00" },
      { texto: "01      Instrucao no Brasil                            3.561,50" },
      { texto: "13      Advogados                                      8.400,00" },
      { texto: "99      Outros                                         1.220,00", espaco: 18 },
      { texto: "DOACOES EFETUADAS", negrito: true, tamanho: 10 },
      { texto: "Nao ha valores informados nesta ficha." },
    ],
  ],
};

/** Simplificado sem nenhuma ficha de pagamentos preenchida — o caso mais comum
 *  de quem so tem renda assalariada e nunca informou deducao. */
const SEM_PAGAMENTOS: ModeloDeclaracao = {
  slug: "sem-pagamentos",
  paginas: [
    [
      ...CABECALHO_COMUM,
      { texto: "Exercicio 2026 - Ano-calendario 2025", negrito: true, espaco: 18 },
      ...IDENTIFICACAO,
      { texto: "RESUMO - TRIBUTACAO UTILIZANDO O DESCONTO SIMPLIFICADO", negrito: true, tamanho: 10 },
      { texto: "Esta e a opcao pela qual a declaracao foi apresentada." },
      { texto: "Rendimentos tributaveis recebidos de PJ .................. 58.200,00" },
      { texto: "Desconto simplificado ..................................... 11.640,00" },
      { texto: "Base de calculo do imposto ................................ 46.560,00" },
      { texto: "Imposto sobre a renda apurado .............................. 4.982,10" },
      { texto: "Aliquota efetiva sobre os rendimentos tributaveis .......... 8,56%" },
    ],
    [
      { texto: "PAGAMENTOS EFETUADOS", negrito: true, tamanho: 10 },
      { texto: "Nao ha valores informados nesta ficha.", espaco: 18 },
      { texto: "DOACOES EFETUADAS", negrito: true, tamanho: 10 },
      { texto: "Nao ha valores informados nesta ficha." },
    ],
  ],
};

export const MODELOS: ModeloDeclaracao[] = [SIMPLIFICADO, COMPLETO, SEM_PAGAMENTOS];

export async function gerarPdf(modelo: ModeloDeclaracao): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const linhas of modelo.paginas) {
    const pagina = doc.addPage([595, 842]);
    let y = 792;
    for (const linha of linhas) {
      const tamanho = linha.tamanho ?? 9;
      pagina.drawText(linha.texto, {
        x: 48,
        y,
        size: tamanho,
        font: linha.negrito ? negrito : fonte,
        color: rgb(0, 0, 0),
      });
      y -= (linha.espaco ?? tamanho + 5);
    }
  }

  return await doc.save();
}

if (import.meta.main) {
  for (const modelo of MODELOS) {
    const bytes = await gerarPdf(modelo);
    const caminho = `tests/fixtures/declaracao-${modelo.slug}.pdf`;
    await Deno.writeFile(caminho, bytes);
    console.log(`${caminho} (${bytes.length} bytes)`);
  }
}
