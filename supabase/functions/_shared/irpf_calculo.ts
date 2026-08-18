// Calculo do IRPF em DUAS CAMADAS, e a economia gerada por uma deducao.
//
// POR QUE NAO BASTA "imposto(base) - imposto(base - deducao)" COM A TABELA
//
// Desde a Lei 15.270/2025 o imposto devido nao e mais o resultado da tabela
// progressiva: e o resultado da tabela MENOS um redutor aplicado depois dela.
// E o redutor tem duas propriedades que quebram a subtracao ingenua:
//
//   1. Ele incide sobre RENDIMENTOS TRIBUTAVEIS, nao sobre a base de calculo.
//      Deduzir mais nao muda o redutor — o rendimento continua o mesmo.
//   2. Ele e limitado ao proprio imposto da tabela (art. 3o-A, §1o, e art.
//      11-A, §1o). Quando a deducao derruba o imposto para baixo do redutor, o
//      excedente do redutor simplesmente se perde.
//
// Junto, isso significa que a economia de uma deducao pode ser MENOR que
// "deducao x aliquota da faixa", e pode ser ZERO para quem ja estava zerado
// pelo redutor. Medido em irpf_calculo_test.ts: R$ 3.000 deduzidos valem
// R$ 675,00 para um rendimento de R$ 65.000 e R$ 550,07 para um de R$ 62.000 —
// o segundo perde parte do redutor no caminho.
//
// A conta certa e sempre: apurar o imposto devido COMPLETO nos dois cenarios e
// subtrair os dois resultados. E o que `economiaPorDeducao` faz.
//
// Este modulo nao conhece ano nenhum: tudo vem de irpf_parametros.ts.

import {
  type FaixaProgressiva,
  type FaixaRedutor,
  PARAMETROS_VERSAO,
  type ParametrosAno,
  parametrosDoAno,
} from "./irpf_parametros.ts";

/**
 * TRUNCA em centavos — nao arredonda.
 *
 * Nao e escolha nossa: e o que o Simulador de Aliquotas Efetivas da Receita
 * faz. O bundle publico do simulador traz
 *
 *     trunc(e,t){return Math.trunc(e*Math.pow(10,t))/Math.pow(10,t)}
 *
 * e aplica `trunc(valor_imposto - parcelaReduzir, 2)` no fim da apuracao.
 *
 * A diferenca nao e teorica. No exemplo 5 da propria Receita (rendimento de
 * R$ 7.607,20, base de R$ 7.000,00) a soma faixa a faixa da 1.016,27875:
 * truncando sai R$ 1.016,27, que e o numero publicado; arredondando sairia
 * R$ 1.016,28. So a truncagem reproduz o resultado oficial.
 *
 * O `toFixed(9)` antes do Math.trunc corrige erro de representacao binaria —
 * sem ele, um valor exato como 562.6385 pode chegar como 562.63849999999996 e
 * a truncagem come um centavo que a Receita nao come.
 */
function truncarCentavos(valor: number): number {
  const centavos = Number((valor * 100).toFixed(9));
  return Math.trunc(centavos) / 100;
}

/**
 * Imposto pela tabela progressiva, SOMANDO FAIXA A FAIXA, sem truncar.
 *
 * A Receita publica dois caminhos para o mesmo numero: a soma das faixas e o
 * atalho "base x aliquota - parcela a deduzir". Em aritmetica exata eles
 * coincidem, mas a parcela publicada e arredondada ao centavo, entao o atalho
 * carrega um erro de ate meio centavo — na tabela anual de 2026 a parcela
 * exata seria 10.904,658 e a publicada e 10.904,66.
 *
 * O simulador oficial soma as faixas (metodo `calculaFaixa`, uma chamada por
 * faixa, acumulando em `valor_imposto`), e e por isso que este modulo faz o
 * mesmo. O atalho continua conferido em `impostoPelaParcelaDeduzir`, que o
 * teste usa para cobrar que os dois caminhos concordem — e assim valida cada
 * parcela publicada.
 *
 * Devolve valor NAO truncado de proposito: a truncagem acontece uma vez so, no
 * fim da apuracao, depois de descontado o redutor. Truncar aqui tambem faria a
 * conta divergir do oficial.
 */
export function impostoPelaTabela(base: number, faixas: FaixaProgressiva[]): number {
  if (!(base > 0)) return 0;

  let imposto = 0;
  for (let i = 0; i < faixas.length; i++) {
    const piso = i === 0 ? 0 : faixas[i - 1].limite!;
    if (base <= piso) break;

    const teto = faixas[i].limite;
    const tributavelNaFaixa = (teto === null ? base : Math.min(base, teto)) - piso;
    imposto += tributavelNaFaixa * (faixas[i].aliquota / 100);
  }

  return Math.max(0, imposto);
}

/** O atalho publicado pela Receita. Existe para o teste cruzar os dois
 *  caminhos; a apuracao usa a soma das faixas. */
export function impostoPelaParcelaDeduzir(base: number, faixas: FaixaProgressiva[]): number {
  if (!(base > 0)) return 0;
  const faixa = faixas.find((f) => f.limite === null || base <= f.limite) ??
    faixas[faixas.length - 1];
  return Math.max(0, base * (faixa.aliquota / 100) - faixa.parcelaDeduzir);
}

/**
 * Redutor bruto, antes do teto do §1o.
 *
 * O argumento e RENDIMENTOS TRIBUTAVEIS, e nao a base: a lei escreve
 * "0,133145 x rendimentos tributaveis sujeitos a incidencia mensal" e
 * "0,095575 x rendimentos tributaveis sujeitos ao ajuste anual". Passar a base
 * aqui inflaria o redutor de quem tem muita deducao — exatamente o publico que
 * este produto atende.
 */
export function redutorBruto(
  rendimentosTributaveis: number,
  redutor: FaixaRedutor[] | null,
): number {
  if (!redutor || !(rendimentosTributaveis > 0)) return 0;

  for (const faixa of redutor) {
    if (rendimentosTributaveis > faixa.limiteRendimentos) continue;
    const bruto = faixa.coeficiente === null
      ? faixa.maximo
      : faixa.maximo - faixa.coeficiente * rendimentosTributaveis;
    return Math.max(0, bruto);
  }

  // Acima da ultima faixa nao ha reducao (art. 3o-A, §2o; art. 11-A, §2o).
  return 0;
}

/** Base de calculo em centavos exatos. O simulador oficial escreve
 *  `(100*rendimentos - 100*deducoes)/100` pelo mesmo motivo: subtrair reais em
 *  ponto flutuante deixa residuo que reaparece na fronteira de faixa. */
function baseDeCalculo(rendimentos: number, deducoes: number): number {
  const centavos = Math.round(rendimentos * 100) - Math.round(Math.max(0, deducoes) * 100);
  return centavos > 0 ? centavos / 100 : 0;
}

export type ApuracaoIrpf = {
  anoCalendario: number;
  rendimentosTributaveis: number;
  deducoes: number;
  baseCalculo: number;
  impostoTabela: number;
  /** Ja limitado ao imposto da tabela. */
  reducao: number;
  impostoDevido: number;
  /** impostoDevido / rendimentosTributaveis, em pontos percentuais. */
  aliquotaEfetiva: number;
  /** Havia dispositivo de redutor neste ano? Diferente de "reducao = 0", que
   *  tambem acontece quando o dispositivo existe e a renda esta acima do teto. */
  temRedutor: boolean;
  parametrosVersao: string;
  validadoContraSimulador: boolean;
};

/**
 * Apuracao anual completa: tabela, redutor e imposto devido.
 *
 * `deducoes` e o total JA escolhido (deducoes legais ou desconto simplificado,
 * o que for mais vantajoso). A escolha nao acontece aqui de proposito: ela
 * depende do total de deducoes legais do ano inteiro, que o TaxMind so conhece
 * em parte — ele ve as despesas que o titular registrou, nao a previdencia
 * oficial nem os dependentes. Quem chama decide com o que tem em maos.
 */
export function apurarAnual(
  anoCalendario: number,
  rendimentosTributaveis: number,
  deducoes: number,
): ApuracaoIrpf | null {
  const parametros = parametrosDoAno(anoCalendario);
  if (!parametros) return null;

  return apurar(parametros, rendimentosTributaveis, deducoes);
}

function apurar(
  parametros: ParametrosAno,
  rendimentosTributaveis: number,
  deducoes: number,
): ApuracaoIrpf {
  const rendimentos = Math.max(0, rendimentosTributaveis);
  const base = baseDeCalculo(rendimentos, deducoes);

  // Tudo em precisao cheia ate a ultima linha: a truncagem acontece UMA vez, no
  // imposto ja liquido do redutor, como no simulador oficial.
  const impostoExato = impostoPelaTabela(base, parametros.anual.faixas);
  const bruto = redutorBruto(rendimentos, parametros.anual.redutor);
  // §1o dos dois artigos: a reducao nao pode passar do imposto apurado. E este
  // teto que faz a economia de uma deducao deixar de ser linear.
  const reducaoExata = Math.min(bruto, impostoExato);
  const impostoDevido = truncarCentavos(impostoExato - reducaoExata);
  const impostoTabela = truncarCentavos(impostoExato);
  const reducao = truncarCentavos(reducaoExata);

  return {
    anoCalendario: parametros.anoCalendario,
    rendimentosTributaveis: rendimentos,
    deducoes: Math.max(0, deducoes),
    baseCalculo: base,
    impostoTabela,
    reducao,
    impostoDevido,
    aliquotaEfetiva: rendimentos > 0
      ? truncarCentavos((impostoDevido / rendimentos) * 100)
      : 0,
    temRedutor: parametros.anual.redutor !== null,
    parametrosVersao: PARAMETROS_VERSAO,
    validadoContraSimulador: parametros.validadoContraSimulador,
  };
}

/** Apuracao mensal, na mesma forma da anual. Existe por dois motivos: e a
 *  unica camada com exemplos numericos oficiais publicados (usados no teste), e
 *  o redutor mensal ja esta em vigor desde janeiro de 2026. */
export function apurarMensal(
  anoCalendario: number,
  mes: number,
  rendimentosTributaveis: number,
  deducoes: number,
): ApuracaoIrpf | null {
  const parametros = parametrosDoAno(anoCalendario);
  if (!parametros?.mensal) return null;

  const vigencia = parametros.mensal.vigencias.find((v) => v.meses.includes(mes));
  if (!vigencia) return null;

  const rendimentos = Math.max(0, rendimentosTributaveis);
  const base = baseDeCalculo(rendimentos, deducoes);
  const impostoExato = impostoPelaTabela(base, vigencia.faixas);
  const reducaoExata = Math.min(
    redutorBruto(rendimentos, parametros.mensal.redutor),
    impostoExato,
  );
  const impostoDevido = truncarCentavos(impostoExato - reducaoExata);
  const impostoTabela = truncarCentavos(impostoExato);
  const reducao = truncarCentavos(reducaoExata);

  return {
    anoCalendario: parametros.anoCalendario,
    rendimentosTributaveis: rendimentos,
    deducoes: Math.max(0, deducoes),
    baseCalculo: base,
    impostoTabela,
    reducao,
    impostoDevido,
    aliquotaEfetiva: rendimentos > 0
      ? truncarCentavos((impostoDevido / rendimentos) * 100)
      : 0,
    temRedutor: parametros.mensal.redutor !== null,
    parametrosVersao: PARAMETROS_VERSAO,
    validadoContraSimulador: parametros.validadoContraSimulador,
  };
}

export type EconomiaEstimada = {
  anoCalendario: number;
  deducaoAdicional: number;
  semDeducao: ApuracaoIrpf;
  comDeducao: ApuracaoIrpf;
  /** Quanto de imposto a deducao adicional deixa de fazer pagar. */
  economia: number;
  /** economia / deducaoAdicional, em pontos percentuais. E o numero que muita
   *  gente confunde com "a minha aliquota": ele pode ser menor que a aliquota
   *  da faixa por causa do teto do redutor, e pode ser zero. */
  aproveitamentoPercentual: number;
  /** A deducao rendeu menos do que a aliquota da faixa renderia, porque parte
   *  do redutor se perdeu no caminho. Motivo para a mensagem ao usuario nao
   *  prometer "27,5% de volta". */
  limitadaPeloRedutor: boolean;
  parametrosVersao: string;
  validadoContraSimulador: boolean;
};

/**
 * Economia de uma deducao adicional, apurada nos dois cenarios completos.
 *
 * NAO subtraia faixas: ver o cabecalho do arquivo. Aqui a conta e sempre
 * imposto devido com a deducao contra imposto devido sem ela, cada um passando
 * pelas duas camadas.
 */
export function economiaPorDeducao(
  anoCalendario: number,
  rendimentosTributaveis: number,
  deducoesJaConsideradas: number,
  deducaoAdicional: number,
): EconomiaEstimada | null {
  const semDeducao = apurarAnual(
    anoCalendario,
    rendimentosTributaveis,
    deducoesJaConsideradas,
  );
  const comDeducao = apurarAnual(
    anoCalendario,
    rendimentosTributaveis,
    deducoesJaConsideradas + Math.max(0, deducaoAdicional),
  );
  if (!semDeducao || !comDeducao) return null;

  const economia = truncarCentavos(semDeducao.impostoDevido - comDeducao.impostoDevido);
  const adicional = Math.max(0, deducaoAdicional);

  // Referencia: quanto renderia se so a tabela existisse. A diferenca entre as
  // duas denuncia o redutor comendo parte do beneficio.
  const semRedutor = truncarCentavos(semDeducao.impostoTabela - comDeducao.impostoTabela);

  return {
    anoCalendario,
    deducaoAdicional: adicional,
    semDeducao,
    comDeducao,
    economia,
    aproveitamentoPercentual: adicional > 0
      ? truncarCentavos((economia / adicional) * 100)
      : 0,
    limitadaPeloRedutor: economia < semRedutor,
    parametrosVersao: semDeducao.parametrosVersao,
    validadoContraSimulador: semDeducao.validadoContraSimulador &&
      comDeducao.validadoContraSimulador,
  };
}
