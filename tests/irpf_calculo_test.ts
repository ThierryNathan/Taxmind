// Calculo do IRPF em duas camadas — tabela progressiva e redutor.
//
// Rodar:  deno test --allow-read tests/irpf_calculo_test.ts
//
// O que este arquivo prova, em ordem de forca da evidencia:
//
//  1. Os cinco EXEMPLOS NUMERICOS OFICIAIS da Receita para o redutor mensal
//     (pagina "Exemplos de Aplicacao da Lei 15.270/2025"). E a unica base de
//     verdade numerica publicada com entrada e saida, e cobre os quatro casos
//     que importam: isento, zerado pelo redutor, exatamente no teto de
//     R$ 5.000, redutor parcial e acima do teto de R$ 7.350.
//  2. CONTINUIDADE das tabelas. Numa tabela progressiva correta, as duas
//     formulas vizinhas dao o mesmo imposto no limite da faixa. Isso valida a
//     "parcela a deduzir" de TODAS as faixas sem depender de fonte nenhuma —
//     inclusive a de 27,5%, que foi onde a divergencia entre fontes apareceu.
//  3. Os pontos de ancoragem do redutor: rendimento no teto da primeira faixa
//     zera o imposto, e no fim da segunda a reducao chega a zero.
//  4. Regime por ano: 2025 nao tem redutor, 2026 tem os dois.
//  5. O comportamento que motivou a correcao: a economia de uma deducao NAO e
//     linear quando o redutor entra.

import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  apurarAnual,
  apurarMensal,
  economiaPorDeducao,
  impostoPelaParcelaDeduzir,
  impostoPelaTabela,
  redutorBruto,
} from "../supabase/functions/_shared/irpf_calculo.ts";
import {
  ANOS_SUPORTADOS,
  PARAMETROS_POR_ANO,
  parametrosDoAno,
} from "../supabase/functions/_shared/irpf_parametros.ts";

// --- 1. exemplos oficiais da Receita (redutor mensal, janeiro/2026) --------
//
// Fonte: https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/
//        tabelas/exemplos-de-aplicacao-da-lei-15-191-2025
//
// Cada caso traz o que a Receita publicou: rendimento, deducao, base, imposto
// da tabela e imposto final depois do redutor.

const EXEMPLOS_OFICIAIS = [
  {
    id: "1-isento",
    rendimentos: 3036.00,
    deducoes: 607.20,
    base: 2428.80,
    impostoTabela: 0,
    impostoDevido: 0,
  },
  {
    id: "2-zerado-pelo-redutor",
    rendimentos: 4000.00,
    deducoes: 607.20,
    base: 3392.80,
    impostoTabela: 114.76,
    impostoDevido: 0,
  },
  {
    id: "3-teto-de-5000",
    rendimentos: 5000.00,
    deducoes: 607.20,
    base: 4392.80,
    impostoTabela: 312.89,
    impostoDevido: 0,
  },
  {
    id: "4-redutor-parcial",
    rendimentos: 6000.00,
    deducoes: 649.60,
    base: 5350.40,
    impostoTabela: 562.63,
    impostoDevido: 382.88,
  },
  {
    id: "5-acima-do-teto",
    rendimentos: 7607.20,
    deducoes: 607.20,
    base: 7000.00,
    impostoTabela: 1016.27,
    impostoDevido: 1016.27,
  },
];

Deno.test("os cinco exemplos oficiais da Receita batem centavo a centavo", () => {
  for (const caso of EXEMPLOS_OFICIAIS) {
    const r = apurarMensal(2026, 1, caso.rendimentos, caso.deducoes);
    assert(r, `sem parametros mensais para 2026 no caso ${caso.id}`);
    assertEquals(r!.baseCalculo, caso.base, `base do caso ${caso.id}`);
    assertEquals(r!.impostoTabela, caso.impostoTabela, `imposto da tabela no caso ${caso.id}`);
    assertEquals(r!.impostoDevido, caso.impostoDevido, `imposto devido no caso ${caso.id}`);
  }
});

Deno.test("em 2025 os mesmos rendimentos pagam mais, porque nao ha redutor", () => {
  // Mesmo caso 4, um ano antes: o redutor nao existia, entao o imposto da
  // tabela e o imposto devido. E a assimetria de regime que motivou toda a
  // parametrizacao por ano.
  const em2026 = apurarMensal(2026, 6, 6000.00, 649.60)!;
  const em2025 = apurarMensal(2025, 6, 6000.00, 649.60)!;

  assertEquals(em2025.impostoTabela, em2026.impostoTabela, "a tabela de mai/2025 e a mesma de 2026");
  assertEquals(em2025.reducao, 0);
  assertEquals(em2025.temRedutor, false);
  assertEquals(em2026.temRedutor, true);
  assert(em2025.impostoDevido > em2026.impostoDevido);
});

Deno.test("a tabela mensal de 2025 muda no meio do ano", () => {
  // Janeiro a abril usam a tabela antiga (parcela a deduzir 896,00 na ultima
  // faixa); maio em diante, a nova (908,73). Fonte secundaria que cite so uma
  // delas para "2025" esta certa em quatro meses e errada em oito.
  const abril = apurarMensal(2025, 4, 6000.00, 607.20)!;
  const maio = apurarMensal(2025, 5, 6000.00, 607.20)!;
  assert(abril.impostoTabela > maio.impostoTabela, "abril deveria pagar mais que maio");
  assertAlmostEquals(abril.impostoTabela - maio.impostoTabela, 908.73 - 896.00, 0.01);
});

// --- 2. continuidade: valida toda parcela a deduzir sem fonte externa ------

Deno.test("as tabelas sao continuas no limite de cada faixa", () => {
  for (const ano of ANOS_SUPORTADOS) {
    const p = parametrosDoAno(ano)!;

    const conferir = (faixas: typeof p.anual.faixas, rotulo: string) => {
      for (let i = 0; i < faixas.length - 1; i++) {
        const limite = faixas[i].limite!;
        const porBaixo = limite * (faixas[i].aliquota / 100) - faixas[i].parcelaDeduzir;
        const porCima = limite * (faixas[i + 1].aliquota / 100) - faixas[i + 1].parcelaDeduzir;
        // Um centavo de folga: a Receita publica a parcela arredondada.
        assertAlmostEquals(
          porBaixo,
          porCima,
          0.01,
          `${rotulo} ${ano}: descontinuidade no limite ${limite} (faixa ${faixas[i].aliquota}%)`,
        );
      }
    };

    conferir(p.anual.faixas, "anual");
    for (const vigencia of p.mensal?.vigencias ?? []) {
      conferir(vigencia.faixas, `mensal (meses ${vigencia.meses[0]}+)`);
    }
  }
});

Deno.test("os dois caminhos oficiais de calculo concordam", () => {
  // A Receita publica a soma das faixas E o atalho "base x aliquota - parcela a
  // deduzir". Cobrar que os dois deem o mesmo numero valida cada parcela
  // publicada sem depender de fonte externa — inclusive a de 27,5%, que foi
  // onde as fontes secundarias divergiram.
  for (const ano of ANOS_SUPORTADOS) {
    const p = parametrosDoAno(ano)!;
    const bases = [0, 1000, 25000, 29145.60, 34000, 46000, 55976.16, 60000, 96400, 250000];

    for (const base of bases) {
      assertAlmostEquals(
        impostoPelaTabela(base, p.anual.faixas),
        impostoPelaParcelaDeduzir(base, p.anual.faixas),
        0.01,
        `anual ${ano}, base ${base}`,
      );
    }
  }
});

Deno.test("truncar e arredondar dao respostas diferentes, e a oficial e truncar", () => {
  // Exemplo 5 da Receita: a soma faixa a faixa da 1.016,2785 e o valor
  // publicado e R$ 1.016,27. Arredondar daria 1.016,28. Este teste existe para
  // a escolha nao ser desfeita sem querer por alguem "consertando" o
  // arredondamento — o simulador oficial usa Math.trunc.
  const p = parametrosDoAno(2026)!;
  const exato = impostoPelaTabela(7000.00, p.mensal!.vigencias[0].faixas);

  assertAlmostEquals(exato, 1016.2785, 0.00001);
  assert(Math.round(exato * 100) / 100 !== 1016.27, "o caso perdeu a capacidade de distinguir");
  assertEquals(apurarMensal(2026, 1, 7607.20, 607.20)!.impostoDevido, 1016.27);
});

Deno.test("a primeira faixa nao cobra imposto ate o proprio limite", () => {
  for (const ano of ANOS_SUPORTADOS) {
    const p = parametrosDoAno(ano)!;
    const limite = p.anual.faixas[0].limite!;
    assertEquals(impostoPelaTabela(limite, p.anual.faixas), 0, `anual ${ano}`);
    assert(impostoPelaTabela(limite + 1000, p.anual.faixas) > 0, `anual ${ano} acima do limite`);
  }
});

// --- 3. ancoragem do redutor ----------------------------------------------

Deno.test("redutor mensal zera o imposto em 5.000 e some em 7.350", () => {
  const p = parametrosDoAno(2026)!;

  // No teto da primeira faixa, com desconto simplificado, imposto = reducao.
  const noTeto = apurarMensal(2026, 1, 5000.00, p.mensal!.vigencias[0].descontoSimplificado)!;
  assertEquals(noTeto.impostoTabela, 312.89);
  assertEquals(noTeto.impostoDevido, 0);

  // No fim da segunda faixa a reducao chega a zero — e e por isso que o teto de
  // 7.350 nao cria degrau.
  assertAlmostEquals(redutorBruto(7350.00, p.mensal!.redutor), 0, 0.01);
  assertEquals(redutorBruto(7350.01, p.mensal!.redutor), 0);
});

Deno.test("redutor anual zera o imposto em 60.000 e some em 88.200", () => {
  const p = parametrosDoAno(2026)!;

  // 60.000 com desconto simplificado de 20% (12.000, abaixo do teto de
  // 17.640): base 48.000, imposto 2.694,15 — exatamente a reducao maxima.
  const noTeto = apurarAnual(2026, 60000.00, 12000.00)!;
  assertEquals(noTeto.impostoTabela, 2694.15);
  assertEquals(noTeto.impostoDevido, 0);
  assertEquals(noTeto.aliquotaEfetiva, 0);

  // `redutorBruto` devolve valor EXATO, sem truncar: a truncagem acontece uma
  // vez so, no fim da apuracao. Por isso a comparacao aqui e por proximidade.
  //
  // A formula publicada nao chega a zero exato no teto — 8.429,73 - 0,095575 x
  // 88.200 = 0,015 — e a implementacao segue a formula em vez de forcar zero:
  // inventar um clamp seria sobrepor o texto legal por estetica. O que zera de
  // verdade e o art. 11-A, §2o, um centavo acima do teto. Em dinheiro
  // entregue ao contribuinte o residuo desaparece na truncagem final.
  assertAlmostEquals(redutorBruto(88200.00, p.anual.redutor), 0, 0.02);
  assertEquals(redutorBruto(88200.01, p.anual.redutor), 0);
  assertAlmostEquals(redutorBruto(7350.00, p.mensal!.redutor), 0, 0.01);
  assertEquals(redutorBruto(7350.01, p.mensal!.redutor), 0);
});

Deno.test("o redutor incide sobre rendimentos, nao sobre a base", () => {
  // Duas pessoas com o MESMO rendimento e deducoes diferentes recebem o mesmo
  // redutor bruto. Se a implementacao passasse a base, quem deduz mais ganharia
  // redutor maior — e o erro seria invisivel, porque o imposto cairia mesmo.
  const p = parametrosDoAno(2026)!;
  const pouco = apurarAnual(2026, 70000.00, 14000.00)!;
  const muito = apurarAnual(2026, 70000.00, 25000.00)!;
  // Comparacao em centavos porque `reducao` ja vem truncada da apuracao e
  // `redutorBruto` nao.
  const esperado = redutorBruto(70000.00, p.anual.redutor);

  assertAlmostEquals(pouco.reducao, Math.min(esperado, pouco.impostoTabela), 0.01);
  assertAlmostEquals(muito.reducao, Math.min(esperado, muito.impostoTabela), 0.01);
  assertEquals(pouco.reducao, muito.reducao, "o redutor nao pode mudar com a deducao");
});

// --- 4. regime por ano ----------------------------------------------------

Deno.test("2024 e 2025 nao tem redutor; 2026 tem o mensal e o anual", () => {
  assertEquals(PARAMETROS_POR_ANO[2024].anual.redutor, null);
  assertEquals(PARAMETROS_POR_ANO[2025].anual.redutor, null);
  assertEquals(PARAMETROS_POR_ANO[2025].mensal!.redutor, null);
  assert(PARAMETROS_POR_ANO[2026].anual.redutor !== null);
  assert(PARAMETROS_POR_ANO[2026].mensal!.redutor !== null);
});

Deno.test("ano fora da tabela devolve null, e nao o ano mais proximo", () => {
  assertEquals(parametrosDoAno(2027), null);
  assertEquals(apurarAnual(2027, 80000, 16000), null);
  assertEquals(economiaPorDeducao(2027, 80000, 16000, 3000), null);
});

Deno.test("o desconto simplificado anual muda em 2026", () => {
  assertEquals(PARAMETROS_POR_ANO[2025].anual.descontoSimplificado, 16754.34);
  assertEquals(PARAMETROS_POR_ANO[2026].anual.descontoSimplificado, 17640.00);
});

// --- 5. economia de uma deducao -------------------------------------------

Deno.test("a economia e linear quando o redutor nao esta no caminho", () => {
  // 65.000 de rendimento: o redutor (2.217,36) e menor que o imposto nos dois
  // cenarios, entao a deducao vale a aliquota cheia da faixa.
  const r = economiaPorDeducao(2026, 65000.00, 13000.00, 3000.00)!;
  assertEquals(r.semDeducao.impostoDevido, 1376.79);
  assertEquals(r.comDeducao.impostoDevido, 701.79);
  assertEquals(r.economia, 675.00);
  assertEquals(r.aproveitamentoPercentual, 22.50);
  assertEquals(r.limitadaPeloRedutor, false);
});

Deno.test("a economia encolhe quando a deducao derruba o imposto abaixo do redutor", () => {
  // Mesmo tamanho de deducao, rendimento um pouco menor: o redutor (2.504,08)
  // passa a ser maior que o imposto no segundo cenario e o excedente se perde.
  // Pela subtracao ingenua daria os mesmos R$ 675,00.
  const r = economiaPorDeducao(2026, 62000.00, 12400.00, 3000.00)!;
  assertEquals(r.semDeducao.impostoDevido, 550.07);
  assertEquals(r.comDeducao.impostoDevido, 0);
  assertEquals(r.economia, 550.07);
  assert(r.economia < 675.00, "a economia nao pode ser a da faixa cheia aqui");
  assertEquals(r.limitadaPeloRedutor, true);
});

Deno.test("quem ja esta zerado pelo redutor nao economiza nada deduzindo", () => {
  // O caso que uma mensagem otimista estragaria: prometer economia a quem ja
  // nao paga imposto. 55.000 de rendimento em 2026 zera pelo redutor.
  const r = economiaPorDeducao(2026, 55000.00, 11000.00, 5000.00)!;
  assertEquals(r.semDeducao.impostoDevido, 0);
  assertEquals(r.comDeducao.impostoDevido, 0);
  assertEquals(r.economia, 0);
  assertEquals(r.aproveitamentoPercentual, 0);
});

Deno.test("o mesmo caso em 2025 economiza mais que em 2026", () => {
  // Nao e erro: em 2025 essa pessoa PAGAVA imposto, entao a deducao tinha o que
  // abater. Comparar os dois anos com a mesma formula esconderia isso — e e o
  // motivo de o baseline importado e a projecao nao poderem compartilhar
  // parametro.
  const em2025 = economiaPorDeducao(2025, 55000.00, 11000.00, 5000.00)!;
  const em2026 = economiaPorDeducao(2026, 55000.00, 11000.00, 5000.00)!;
  assert(em2025.economia > 0);
  assertEquals(em2026.economia, 0);
});

Deno.test("toda apuracao carrega a versao dos parametros e o selo de validacao", () => {
  const em2025 = apurarAnual(2025, 96400.00, 16754.34)!;
  const em2026 = apurarAnual(2026, 96400.00, 17640.00)!;

  assertEquals(em2025.parametrosVersao, em2026.parametrosVersao);
  assert(/^\d{4}-\d{2}-\d{2}\.v\d+$/.test(em2025.parametrosVersao));

  // 2025 foi conferido contra o servico da Receita; o anual de 2026 nao pode
  // ser, porque o servico ainda devolve a tabela de 2025 no bloco anual.
  assertEquals(em2025.validadoContraSimulador, true);
  assertEquals(em2026.validadoContraSimulador, false);
});
