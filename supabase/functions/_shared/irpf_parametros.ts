// Parametros do IRPF por ANO-CALENDARIO.
//
// ESTE ARQUIVO E DADO, NAO LOGICA. A conta fica em irpf_calculo.ts.
//
// POR QUE PARAMETRIZADO POR ANO, E NAO CONSTANTE
//
// Desde a Lei 15.270/2025 o imposto tem DUAS camadas aplicadas em sequencia —
// tabela progressiva e, depois dela, um redutor — e as duas comecam em anos
// diferentes. Como o produto compara declaracao passada (baseline importado)
// com projecao futura, os dois lados da comparacao podem cair em regimes
// diferentes. Hardcodar "os valores de 2026" produziria numero errado no lado
// do baseline sem nenhum sintoma visivel.
//
// REGIME POR ANO (verificado na lei, nao inferido):
//
//   AC 2024, 2025 -> so tabela progressiva. Sem redutor.
//   AC 2026       -> tabela progressiva + redutor MENSAL (Lei 9.250/1995,
//                    art. 3o-A, incluido pela Lei 15.270/2025: "a partir do mes
//                    de janeiro do ano-calendario de 2026") + redutor ANUAL
//                    (art. 11-A: "a partir do exercicio de 2027, ano-calendario
//                    de 2026").
//
// Atencao ao numero do artigo: o redutor MENSAL e o art. 3o-A e o ANUAL e o
// art. 11-A. Sao dispositivos distintos, com vigencias declaradas
// separadamente, e o anual so aparece na declaracao entregue em 2027.
//
// PROVENIENCIA DE CADA NUMERO
//
// Nada aqui veio de fonte secundaria. Cada bloco declara sua origem em `fonte`:
//
//   "api-simulador"  -> https://www27.receita.fazenda.gov.br/api/simulador/tabela/{ano},
//                       o servico de parametros que alimenta o Simulador de
//                       Aliquotas Efetivas da propria Receita. Copia dos
//                       payloads em tests/fixtures/simulador-irpf/, e
//                       tests/irpf_parametros_test.ts compara campo a campo.
//   "lei-15270"      -> texto do Planalto (redutores e desconto simplificado).
//   "pagina-tabelas" -> https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/2026
//
// ARMADILHA MEDIDA NA API DA RECEITA (16/08/2026)
//
// `GET /api/simulador/tabela/2026` devolve, no bloco ANUAL, a tabela do
// ano-calendario 2025 (isento ate 28.467,20; parcela a deduzir 10.853,78) e nao
// a de 2026 (29.145,60 / 10.904,66, publicada na propria pagina de tabelas da
// Receita). O bloco MENSAL do mesmo payload esta correto para 2026, e o redutor
// mensal aparece nele.
//
// A explicacao esta na interface do simulador: a aba mensal pergunta
// "Ano-calendario" e a aba anual pergunta "Exercicio", e as duas consultam o
// mesmo endpoint com o mesmo numero. Como o exercicio 2027 ainda nao existe
// (lista do simulador vai ate 2026), os parametros anuais de AC2026 nunca
// foram carregados no servico. Consequencia pratica: quem puxar o bloco anual
// de /tabela/2026 achando que e AC2026 usa a tabela do ano passado e
// SUBESTIMA a deducao — silenciosamente. Por isso o anual de 2026 aqui vem da
// pagina de tabelas, e o teste de proveniencia trata 2026 como excecao
// declarada em vez de comparar cegamente.
//
// COMO ATUALIZAR QUANDO SAIR O ANO NOVO
//
// 1. Rodar `deno test --allow-net --allow-read tests/irpf_parametros_test.ts`
//    com rede: ele rebaixa as fixtures e acusa divergencia.
// 2. Conferir vigencia na lei antes de copiar valor de qualquer lugar.
// 3. Subir `PARAMETROS_VERSAO` — ele viaja junto com o calculo gravado, do
//    mesmo jeito que `versao_prompt` viaja com a analise fiscal.

/** Versao deste conjunto de parametros. Gravada junto com todo numero
 *  calculado a partir daqui, para uma conta antiga continuar explicavel depois
 *  de a tabela mudar. Formato: AAAA-MM-DD.vN. */
export const PARAMETROS_VERSAO = "2026-08-16.v1";

export type FaixaProgressiva = {
  /** Aliquota em pontos percentuais (7.5 = 7,5%). */
  aliquota: number;
  /** Teto da faixa. `null` na ultima faixa. */
  limite: number | null;
  /** "Parcela a deduzir" da tabela — o atalho que a Receita publica para nao
   *  precisar somar faixa a faixa. */
  parcelaDeduzir: number;
};

/** Faixa do redutor. `coeficiente` null = redução fixa (primeira faixa, a que
 *  zera o imposto). */
export type FaixaRedutor = {
  /** Teto de RENDIMENTOS TRIBUTAVEIS (nao da base de calculo) desta faixa. */
  limiteRendimentos: number;
  maximo: number;
  coeficiente: number | null;
};

export type TabelaMensalVigencia = {
  /** Meses (1-12) em que esta tabela vale. Existe porque a tabela mudou no meio
   *  de 2025: janeiro a abril numa, maio a dezembro noutra. */
  meses: number[];
  faixas: FaixaProgressiva[];
  descontoSimplificado: number;
  dependente: number;
};

export type ParametrosAno = {
  anoCalendario: number;
  fonte: string;
  /** Os numeros anuais foram conferidos contra o servico de parametros da
   *  Receita? Falso quando o servico ainda nao publicou o ano (ver a armadilha
   *  no cabecalho). Viaja para a mensagem ao usuario como motivo extra de
   *  cautela. */
  validadoContraSimulador: boolean;
  anual: {
    faixas: FaixaProgressiva[];
    descontoSimplificado: number;
    dependente: number;
    limiteInstrucao: number;
    /** `null` = o ano nao tem redutor anual. Nao e "redutor de valor zero": e a
     *  ausencia do dispositivo, e a mensagem ao usuario muda por causa disso. */
    redutor: FaixaRedutor[] | null;
  };
  /** Ausente nos anos em que o produto nao precisa de conta mensal. */
  mensal?: {
    vigencias: TabelaMensalVigencia[];
    redutor: FaixaRedutor[] | null;
  };
};

// Faixas anuais de AC2024. Fonte: api-simulador/tabela/2024.
const ANUAL_2024: FaixaProgressiva[] = [
  { aliquota: 0, limite: 26963.20, parcelaDeduzir: 0 },
  { aliquota: 7.5, limite: 33919.80, parcelaDeduzir: 2022.24 },
  { aliquota: 15, limite: 45012.60, parcelaDeduzir: 4566.23 },
  { aliquota: 22.5, limite: 55976.16, parcelaDeduzir: 7942.17 },
  { aliquota: 27.5, limite: null, parcelaDeduzir: 10740.98 },
];

// Faixas anuais de AC2025. Fonte: api-simulador/tabela/2025.
const ANUAL_2025: FaixaProgressiva[] = [
  { aliquota: 0, limite: 28467.20, parcelaDeduzir: 0 },
  { aliquota: 7.5, limite: 33919.80, parcelaDeduzir: 2135.04 },
  { aliquota: 15, limite: 45012.60, parcelaDeduzir: 4679.03 },
  { aliquota: 22.5, limite: 55976.16, parcelaDeduzir: 8054.97 },
  { aliquota: 27.5, limite: null, parcelaDeduzir: 10853.78 },
];

// Faixas anuais de AC2026. Fonte: pagina-tabelas (a API ainda devolve as de
// 2025 neste ano — ver a armadilha no cabecalho).
//
// Conferencia aritmetica que nao depende de nenhuma fonte: a tabela anual e a
// mensal vezes 12. 2.428,80 x 12 = 29.145,60, e 908,73 x 12 = 10.904,76 contra
// os 10.904,66 publicados — a diferenca de 10 centavos vem de a Receita
// derivar a parcela anual da soma exata das faixas, e nao do arredondamento
// mensal. O teste de continuidade usa o valor publicado, que e o que a Receita
// aplica.
const ANUAL_2026: FaixaProgressiva[] = [
  { aliquota: 0, limite: 29145.60, parcelaDeduzir: 0 },
  { aliquota: 7.5, limite: 33919.80, parcelaDeduzir: 2185.92 },
  { aliquota: 15, limite: 45012.60, parcelaDeduzir: 4729.91 },
  { aliquota: 22.5, limite: 55976.16, parcelaDeduzir: 8105.85 },
  { aliquota: 27.5, limite: null, parcelaDeduzir: 10904.66 },
];

// Tabela mensal vigente de maio/2025 em diante, inclusive 2026 inteiro.
// Fonte: api-simulador (arrays por mes de /tabela/2025 e /tabela/2026).
const MENSAL_DESDE_MAIO_2025: FaixaProgressiva[] = [
  { aliquota: 0, limite: 2428.80, parcelaDeduzir: 0 },
  { aliquota: 7.5, limite: 2826.65, parcelaDeduzir: 182.16 },
  { aliquota: 15, limite: 3751.05, parcelaDeduzir: 394.16 },
  { aliquota: 22.5, limite: 4664.68, parcelaDeduzir: 675.49 },
  { aliquota: 27.5, limite: null, parcelaDeduzir: 908.73 },
];

// Janeiro a abril de 2025. E daqui que sai a divergencia mais provavel em
// fonte secundaria: quem cita "parcela a deduzir de R$ 896,00" para 2025 esta
// citando esta tabela, que valeu 4 meses; de maio em diante e 908,73, e e essa
// que vale em 2026.
const MENSAL_ATE_ABRIL_2025: FaixaProgressiva[] = [
  { aliquota: 0, limite: 2259.20, parcelaDeduzir: 0 },
  { aliquota: 7.5, limite: 2826.65, parcelaDeduzir: 169.44 },
  { aliquota: 15, limite: 3751.05, parcelaDeduzir: 381.44 },
  { aliquota: 22.5, limite: 4664.68, parcelaDeduzir: 662.77 },
  { aliquota: 27.5, limite: null, parcelaDeduzir: 896.00 },
];

/** Redutor MENSAL (art. 3o-A). Fonte: lei-15270 e api-simulador
 *  (gpFaixasTblIsencao de /tabela/2026). */
const REDUTOR_MENSAL_2026: FaixaRedutor[] = [
  { limiteRendimentos: 5000.00, maximo: 312.89, coeficiente: null },
  { limiteRendimentos: 7350.00, maximo: 978.62, coeficiente: 0.133145 },
];

/** Redutor ANUAL (art. 11-A). Fonte: lei-15270, confirmado na pagina de
 *  tabelas. NAO existe no servico de parametros da Receita ainda, porque ele
 *  so aparece no exercicio 2027. */
const REDUTOR_ANUAL_2026: FaixaRedutor[] = [
  { limiteRendimentos: 60000.00, maximo: 2694.15, coeficiente: null },
  { limiteRendimentos: 88200.00, maximo: 8429.73, coeficiente: 0.095575 },
];

const DEPENDENTE_ANUAL = 2275.08;
const DEPENDENTE_MENSAL = 189.59;
const LIMITE_INSTRUCAO = 3561.50;

// Art. 10, IX e X da Lei 9.250/1995 na redacao da Lei 15.270/2025:
// R$ 16.754,34 do AC2015 ao AC2025, e R$ 17.640,00 a partir do AC2026.
const SIMPLIFICADO_ATE_2025 = 16754.34;
const SIMPLIFICADO_DESDE_2026 = 17640.00;

export const PARAMETROS_POR_ANO: Readonly<Record<number, ParametrosAno>> = {
  2024: {
    anoCalendario: 2024,
    fonte: "api-simulador",
    validadoContraSimulador: true,
    anual: {
      faixas: ANUAL_2024,
      descontoSimplificado: SIMPLIFICADO_ATE_2025,
      dependente: DEPENDENTE_ANUAL,
      limiteInstrucao: LIMITE_INSTRUCAO,
      redutor: null,
    },
  },
  2025: {
    anoCalendario: 2025,
    fonte: "api-simulador",
    validadoContraSimulador: true,
    anual: {
      faixas: ANUAL_2025,
      descontoSimplificado: SIMPLIFICADO_ATE_2025,
      dependente: DEPENDENTE_ANUAL,
      limiteInstrucao: LIMITE_INSTRUCAO,
      redutor: null,
    },
    mensal: {
      vigencias: [
        {
          meses: [1, 2, 3, 4],
          faixas: MENSAL_ATE_ABRIL_2025,
          descontoSimplificado: 564.80,
          dependente: DEPENDENTE_MENSAL,
        },
        {
          meses: [5, 6, 7, 8, 9, 10, 11, 12],
          faixas: MENSAL_DESDE_MAIO_2025,
          descontoSimplificado: 607.20,
          dependente: DEPENDENTE_MENSAL,
        },
      ],
      redutor: null,
    },
  },
  2026: {
    anoCalendario: 2026,
    fonte: "pagina-tabelas + lei-15270 (anual); api-simulador (mensal)",
    // O bloco anual de 2026 NAO pode ser conferido contra o servico da Receita
    // hoje: ele ainda devolve a tabela de 2025 no anual. Ver o cabecalho.
    validadoContraSimulador: false,
    anual: {
      faixas: ANUAL_2026,
      descontoSimplificado: SIMPLIFICADO_DESDE_2026,
      dependente: DEPENDENTE_ANUAL,
      limiteInstrucao: LIMITE_INSTRUCAO,
      redutor: REDUTOR_ANUAL_2026,
    },
    mensal: {
      vigencias: [
        {
          meses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          faixas: MENSAL_DESDE_MAIO_2025,
          descontoSimplificado: 607.20,
          dependente: DEPENDENTE_MENSAL,
        },
      ],
      redutor: REDUTOR_MENSAL_2026,
    },
  },
};

export const ANOS_SUPORTADOS = Object.keys(PARAMETROS_POR_ANO)
  .map(Number)
  .sort((a, b) => a - b);

/** Parametros do ano, ou `null` quando o ano nao esta na tabela.
 *
 *  Devolve null em vez de cair no ano mais proximo de proposito: aplicar a
 *  tabela do ano errado e o erro que este arquivo inteiro existe para impedir,
 *  e quem chama precisa decidir explicitamente o que fazer sem parametro
 *  (no nosso caso, nao exibir estimativa nenhuma). */
export function parametrosDoAno(ano: number): ParametrosAno | null {
  return PARAMETROS_POR_ANO[ano] ?? null;
}
