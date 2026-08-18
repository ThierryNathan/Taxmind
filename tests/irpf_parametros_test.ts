// Proveniencia dos parametros do IRPF.
//
// Rodar (offline):  deno test --allow-read tests/irpf_parametros_test.ts
// Rodar com rede:   deno test --allow-read --allow-net tests/irpf_parametros_test.ts
//
// O irpf_calculo_test.ts prova que a CONTA esta certa. Este arquivo prova que
// os NUMEROS vieram de onde dizem que vieram — que e o risco de outra natureza
// num produto fiscal: uma conta impecavel sobre a tabela do ano errado.
//
// A fonte e o servico de parametros que alimenta o Simulador de Aliquotas
// Efetivas da propria Receita:
//   GET https://www27.receita.fazenda.gov.br/api/simulador/tabela/{ano}
//
// Os payloads estao copiados em tests/fixtures/simulador-irpf/. A comparacao
// roda sempre contra a copia; com --allow-net, roda TAMBEM contra o servico ao
// vivo, e ai a copia e conferida. Sem rede o teste nao falha: a CI nao tem
// acesso, e o objetivo aqui e travar deriva, nao exigir internet.
//
// A EXCECAO DECLARADA DE 2026
//
// /tabela/2026 devolve, no bloco anual, a tabela de 2025. Nao e engano de
// leitura: a aba anual do simulador pergunta "Exercicio" (2026 = ano-calendario
// 2025) e a mensal pergunta "Ano-calendario", e as duas batem no mesmo
// endpoint. Como o exercicio 2027 ainda nao existe, os valores anuais de AC2026
// nunca entraram no servico. Por isso o ano de 2026 e comparado so no MENSAL, e
// o anual dele tem asserssao propria contra os valores publicados na pagina de
// tabelas. Se um dia a Receita publicar o anual de 2026 no servico, o teste de
// rede acusa — que e o comportamento desejado.

import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PARAMETROS_POR_ANO } from "../supabase/functions/_shared/irpf_parametros.ts";

type PayloadSimulador = {
  anoCalendario: string;
  mensagemRetorno: string;
  deducoesDependentes: number;
  deducoesDespInstrucao: number;
  vaDedDependenteMe: number[];
  vaDeducSimpMe: number[];
  gpFaixasTblProg: Array<{
    peFaixa: number;
    vaAjDescontoAnual: number;
    vaAjLimiteAnual: number;
    vaAjDescontoMe: number[];
    vaAjLimiteMe: number[];
  }>;
  gpFaixasTblIsencao?: Array<{
    limiteRendTributavel: number[];
    vaMaximoReducao: number[];
    coeficienteReducao: number[];
  }>;
};

async function fixture(ano: number): Promise<PayloadSimulador> {
  return JSON.parse(
    await Deno.readTextFile(`tests/fixtures/simulador-irpf/tabela-${ano}.json`),
  );
}

/** Mes 1-12 -> indice 0-11 dos arrays do payload. */
const MES = (m: number) => m - 1;

// --- bloco anual ----------------------------------------------------------

for (const ano of [2024, 2025]) {
  Deno.test(`parametros anuais de ${ano} batem com o servico da Receita`, async () => {
    const oficial = await fixture(ano);
    const nossos = PARAMETROS_POR_ANO[ano];

    assertEquals(oficial.anoCalendario, String(ano));
    assertEquals(nossos.anual.faixas.length, oficial.gpFaixasTblProg.length);

    nossos.anual.faixas.forEach((faixa, i) => {
      const ref = oficial.gpFaixasTblProg[i];
      assertEquals(faixa.aliquota, ref.peFaixa, `aliquota da faixa ${i} em ${ano}`);
      assertEquals(
        faixa.parcelaDeduzir,
        ref.vaAjDescontoAnual,
        `parcela a deduzir anual da faixa ${i} em ${ano}`,
      );
      // A ultima faixa nao tem teto do nosso lado; o servico repete o teto da
      // anterior nessa posicao.
      if (faixa.limite !== null) {
        assertEquals(faixa.limite, ref.vaAjLimiteAnual, `limite anual da faixa ${i} em ${ano}`);
      }
    });

    assertEquals(nossos.anual.dependente, oficial.deducoesDependentes);
    assertEquals(nossos.anual.limiteInstrucao, oficial.deducoesDespInstrucao);
    // Ate AC2025 nao existe redutor, e o payload nao traz o bloco.
    assertEquals(nossos.anual.redutor, null);
    assertEquals(oficial.gpFaixasTblIsencao, undefined);
  });
}

Deno.test("o servico ainda nao publicou o anual de 2026 — excecao declarada", async () => {
  const oficial = await fixture(2026);
  const de2025 = await fixture(2025);

  // O que o servico devolve em /tabela/2026 no bloco anual E a tabela de 2025.
  // Este teste existe para a excecao ser um fato verificado, e nao uma nota de
  // rodape que envelhece: no dia em que a Receita corrigir, ele falha e alguem
  // vai ter que reavaliar a fonte do bloco anual de 2026.
  oficial.gpFaixasTblProg.forEach((faixa, i) => {
    assertEquals(
      faixa.vaAjDescontoAnual,
      de2025.gpFaixasTblProg[i].vaAjDescontoAnual,
      "o servico mudou: /tabela/2026 nao repete mais o anual de 2025",
    );
  });

  // E os nossos numeros de 2026 sao propositalmente DIFERENTES do que o
  // servico devolve — vem da pagina de tabelas da Receita.
  const nossaUltima = PARAMETROS_POR_ANO[2026].anual.faixas[4];
  assertEquals(nossaUltima.parcelaDeduzir, 10904.66);
  assert(
    nossaUltima.parcelaDeduzir !== oficial.gpFaixasTblProg[4].vaAjDescontoAnual,
    "se estes dois coincidirem, alguem copiou o anual errado para 2026",
  );
  assertEquals(PARAMETROS_POR_ANO[2026].validadoContraSimulador, false);
});

Deno.test("a tabela anual de 2026 e a mensal vezes doze", () => {
  // Conferencia que nao depende de fonte nenhuma, e a unica disponivel para o
  // bloco que o servico nao publica: a tabela anual e a soma dos doze meses.
  const anual = PARAMETROS_POR_ANO[2026].anual.faixas;
  const mensal = PARAMETROS_POR_ANO[2026].mensal!.vigencias[0].faixas;

  anual.forEach((faixa, i) => {
    if (faixa.limite !== null) {
      assertAlmostEquals(
        faixa.limite,
        mensal[i].limite! * 12,
        0.01,
        `limite da faixa ${i}`,
      );
    }
    // Dez centavos de folga: a Receita deriva a parcela anual da soma exata das
    // faixas, nao do arredondamento mensal (908,73 x 12 = 10.904,76 contra os
    // 10.904,66 publicados).
    assertAlmostEquals(
      faixa.parcelaDeduzir,
      mensal[i].parcelaDeduzir * 12,
      0.11,
      `parcela a deduzir da faixa ${i}`,
    );
  });
});

// --- bloco mensal ---------------------------------------------------------

Deno.test("as tabelas mensais de 2025 e 2026 batem com o servico da Receita", async () => {
  for (const ano of [2025, 2026]) {
    const oficial = await fixture(ano);
    const nossas = PARAMETROS_POR_ANO[ano].mensal!;

    for (const vigencia of nossas.vigencias) {
      for (const mes of vigencia.meses) {
        vigencia.faixas.forEach((faixa, i) => {
          const ref = oficial.gpFaixasTblProg[i];
          assertEquals(
            faixa.parcelaDeduzir,
            ref.vaAjDescontoMe[MES(mes)],
            `parcela mensal da faixa ${i}, mes ${mes}/${ano}`,
          );
          if (faixa.limite !== null) {
            assertEquals(
              faixa.limite,
              ref.vaAjLimiteMe[MES(mes)],
              `limite mensal da faixa ${i}, mes ${mes}/${ano}`,
            );
          }
        });
        assertEquals(
          vigencia.descontoSimplificado,
          oficial.vaDeducSimpMe[MES(mes)],
          `desconto simplificado mensal em ${mes}/${ano}`,
        );
        assertEquals(vigencia.dependente, oficial.vaDedDependenteMe[MES(mes)]);
      }
    }
  }
});

Deno.test("o redutor mensal de 2026 bate com o servico da Receita", async () => {
  const oficial = await fixture(2026);
  const nosso = PARAMETROS_POR_ANO[2026].mensal!.redutor!;
  const referencia = oficial.gpFaixasTblIsencao!;

  assertEquals(nosso.length, referencia.length);
  nosso.forEach((faixa, i) => {
    assertEquals(faixa.limiteRendimentos, referencia[i].limiteRendTributavel[0]);
    assertEquals(faixa.maximo, referencia[i].vaMaximoReducao[0]);
    assertEquals(faixa.coeficiente, referencia[i].coeficienteReducao[0] ?? null);
  });
});

Deno.test("o redutor anual nao existe no servico — so na lei", async () => {
  // O art. 11-A so vale a partir do exercicio 2027, e o servico nao tem
  // exercicio 2027. Os valores aqui vieram do texto do Planalto e da pagina de
  // tabelas, e esta asserssao documenta que a diferenca e esperada.
  const oficial = await fixture(2026);
  const anual = PARAMETROS_POR_ANO[2026].anual.redutor!;

  assertEquals(anual[0].limiteRendimentos, 60000.00);
  assertEquals(anual[0].maximo, 2694.15);
  assertEquals(anual[1].limiteRendimentos, 88200.00);
  assertEquals(anual[1].maximo, 8429.73);
  assertEquals(anual[1].coeficiente, 0.095575);

  // O bloco que o servico traz e o MENSAL: limites de 5.000 e 7.350.
  assertEquals(oficial.gpFaixasTblIsencao![0].limiteRendTributavel[0], 5000.00);
});

// --- deriva contra o servico ao vivo (so com --allow-net) ------------------

const TEM_REDE = (await Deno.permissions.query({ name: "net" })).state === "granted";

Deno.test({
  name: "as fixtures continuam iguais ao servico ao vivo",
  ignore: !TEM_REDE,
  fn: async () => {
    for (const ano of [2024, 2025, 2026]) {
      const resposta = await fetch(
        `https://www27.receita.fazenda.gov.br/api/simulador/tabela/${ano}`,
      );
      assertEquals(resposta.status, 200, `servico respondeu ${resposta.status} para ${ano}`);

      const aoVivo = await resposta.json();
      // Os dois campos de carimbo mudam a cada consulta e nao entram na copia.
      delete aoVivo.dataConsulta;
      delete aoVivo.horaConsulta;

      assertEquals(
        aoVivo,
        await fixture(ano),
        `o servico da Receita mudou os parametros de ${ano}: reconferir a lei ` +
          `antes de atualizar a fixture e PARAMETROS_VERSAO`,
      );
    }
  },
});
