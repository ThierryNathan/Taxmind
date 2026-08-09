// Fase 15 - logica pura do follow-up de reembolso.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/followup_reembolso_test.ts
//
// Sem I/O: derivacao do campo, precedencia contra a pergunta de identificacao,
// reconhecimento deterministico da resposta e serializacao para o payload da
// whatsapp-webhook. O comportamento do modelo que alimenta possui_indicio_reembolso
// e medido contra o Gemini real (varredura registrada em docs/08).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAMPO_REEMBOLSO,
  campoRespondivel,
  derivarCampoFollowup,
  derivarCamposBloqueantes,
  destinoSeSemReembolso,
  deveperguntarReembolso,
  extrairDocumento,
  extrairRespostaDeCampo,
  extrairRespostaDeReembolso,
  perguntaParaCampo,
  respostaSemConteudo,
  serializarRespostaReembolso,
} from "../supabase/functions/_shared/followup.ts";

const CNPJ = "11222333000181";

// --- derivacao e precedencia ---------------------------------------------

Deno.test("indicio de reembolso vira pergunta de reembolso", () => {
  assertEquals(
    derivarCampoFollowup({
      possui_indicio_reembolso: true,
      deducibilidade_se_sem_reembolso: "DEDUTIVEL",
      deducibilidade_se_desbloqueado: null,
      documento_prestador: null,
      estabelecimento: "Clinica Vida",
    }),
    CAMPO_REEMBOLSO,
  );
});

Deno.test("o gate da pergunta e possui_indicio_reembolso SOZINHO", () => {
  // Divergencia deliberada em relacao ao gate da identificacao. A pergunta de
  // reembolso corrige o numero declarado, e isso vale mesmo quando a despesa
  // continua em revisao por outro motivo: a Receita cruza a deducao com a DMED
  // da operadora, e o contador que revisa precisa do dado.
  assertEquals(
    derivarCampoFollowup({
      possui_indicio_reembolso: true,
      deducibilidade_se_sem_reembolso: null,
      deducibilidade_se_desbloqueado: null,
      documento_prestador: null,
      estabelecimento: null,
    }),
    CAMPO_REEMBOLSO,
  );

  assertEquals(deveperguntarReembolso({ possui_indicio_reembolso: true }), true);
  assertEquals(deveperguntarReembolso({ possui_indicio_reembolso: false }), false);
  // Ausente e diferente de true: campo que a IA nao devolveu nao vira pergunta.
  assertEquals(deveperguntarReembolso({}), false);
  assertEquals(deveperguntarReembolso(null), false);
  // Sem coercao: "true" string nao e declaracao.
  assertEquals(deveperguntarReembolso({ possui_indicio_reembolso: "true" }), false);
});

Deno.test("reembolso ganha a vaga quando a IA se contradiz", () => {
  // Observado na varredura contra o Gemini real: "a guia foi autorizada" volta
  // com indicio de reembolso E deducibilidade_se_desbloqueado preenchido na
  // mesma resposta. Uma vaga so (unique parcial da 009), entao a precedencia
  // precisa estar escrita. Reembolso ganha por assimetria de risco: numero
  // errado contra a DMED e pior do que registro incompleto.
  const analise = {
    possui_indicio_reembolso: true,
    deducibilidade_se_sem_reembolso: "DEDUTIVEL",
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
    documento_prestador: null,
    estabelecimento: null,
  };

  assertEquals(derivarCampoFollowup(analise), CAMPO_REEMBOLSO);
  // E a derivacao antiga continua enxergando o que sempre enxergou: ela nao foi
  // tocada, so deixou de ser a unica fonte da vaga.
  assertEquals(derivarCamposBloqueantes(analise), ["documento_prestador"]);
});

Deno.test("sem indicio de reembolso, a pergunta de identificacao continua a de ontem", () => {
  // A garantia mais importante desta fase: o caminho validado ontem nao muda.
  const casos: Array<[Record<string, unknown>, string | null]> = [
    [{
      deducibilidade_se_desbloqueado: "DEDUTIVEL",
      documento_prestador: null,
      estabelecimento: null,
    }, "documento_prestador"],
    [{
      deducibilidade_se_desbloqueado: "DEDUTIVEL",
      documento_prestador: "11.222.333/0001-81",
      estabelecimento: null,
    }, "estabelecimento"],
    [{
      deducibilidade_se_desbloqueado: null,
      documento_prestador: null,
      estabelecimento: null,
    }, null],
    [{
      deducibilidade_se_desbloqueado: "PARCIALMENTE_DEDUTIVEL",
      documento_prestador: "  ",
      estabelecimento: "Clinica Vida",
    }, "documento_prestador"],
  ];

  for (const [analise, esperado] of casos) {
    assertEquals(derivarCampoFollowup(analise), esperado, JSON.stringify(analise));
    assertEquals(derivarCampoFollowup({ ...analise, possui_indicio_reembolso: false }), esperado);
    // E o resultado e identico ao da funcao antiga chamada sozinha.
    assertEquals(derivarCamposBloqueantes(analise)[0] ?? null, esperado);
  }
});

Deno.test("destinoSeSemReembolso so aceita destino de promocao declarado", () => {
  assertEquals(destinoSeSemReembolso({ deducibilidade_se_sem_reembolso: "DEDUTIVEL" }), "DEDUTIVEL");
  assertEquals(
    destinoSeSemReembolso({ deducibilidade_se_sem_reembolso: "PARCIALMENTE_DEDUTIVEL" }),
    "PARCIALMENTE_DEDUTIVEL",
  );
  // NAO_DEDUTIVEL e INDETERMINADO nao sao destinos de promocao.
  assertEquals(destinoSeSemReembolso({ deducibilidade_se_sem_reembolso: "NAO_DEDUTIVEL" }), null);
  assertEquals(destinoSeSemReembolso({ deducibilidade_se_sem_reembolso: "INDETERMINADO" }), null);
  assertEquals(destinoSeSemReembolso({}), null);
  assertEquals(destinoSeSemReembolso(null), null);
});

Deno.test("valor_reembolso e campo respondivel e tem pergunta propria", () => {
  assert(campoRespondivel(CAMPO_REEMBOLSO));
  assert(campoRespondivel("documento_prestador"));
  assert(campoRespondivel("estabelecimento"));
  assert(!campoRespondivel("categoria"));
  assert(!campoRespondivel("valor"));

  const pergunta = perguntaParaCampo(CAMPO_REEMBOLSO);
  assert(pergunta.includes("reembolsado"));
  // A pergunta ensina como negar, e e isso que torna a negacao reconhecivel sem
  // IA: sem a instrucao, a resposta mais comum viraria texto livre.
  assert(pergunta.includes('"não"'));
  // Nunca prometer dinheiro de volta pela deducao (regra do prompt e do dossie).
  for (const proibido of ["recebe de volta", "vai receber", "restituicao", "economiza"]) {
    assert(!pergunta.toLowerCase().includes(proibido), proibido);
  }
});

// --- reconhecimento da resposta -------------------------------------------

Deno.test("negacao e reconhecida sem IA", () => {
  const negacoes = [
    "não",
    "nao",
    "Não!",
    "não houve",
    "nao houve reembolso",
    "nenhum",
    "nada",
    "não, foi particular",
    "particular",
    "zero",
    "não teve reembolso do plano",
    "nao, o plano nao cobriu nada",
  ];

  for (const texto of negacoes) {
    assertEquals(extrairRespostaDeReembolso(texto), { houve: false, valor: 0 }, texto);
    assertEquals(serializarRespostaReembolso(texto), "NAO", texto);
  }
});

Deno.test("valor de reembolso e reconhecido nas formas que a pessoa escreve", () => {
  const casos: Array<[string, number]> = [
    ["300", 300],
    ["R$ 300", 300],
    ["r$300,50", 300.5],
    ["300,50", 300.5],
    ["foi 250 de reembolso", 250],
    ["o plano cobriu 300 reais", 300],
    ["reembolsaram 180", 180],
    ["sim, 220", 220],
    ["1.200,00", 1200],
    ["1200.50", 1200.5],
    ["1.500", 1500],
    ["voltou 75,25 do convenio", 75.25],
  ];

  for (const [texto, valor] of casos) {
    assertEquals(extrairRespostaDeReembolso(texto), { houve: true, valor }, texto);
    assertEquals(serializarRespostaReembolso(texto), valor.toFixed(2), texto);
  }
});

Deno.test("reembolso de zero e negacao escrita com numero", () => {
  assertEquals(extrairRespostaDeReembolso("0"), { houve: false, valor: 0 });
  assertEquals(extrairRespostaDeReembolso("R$ 0,00"), { houve: false, valor: 0 });
  assertEquals(serializarRespostaReembolso("0"), "NAO");
});

Deno.test("afirmacao sem valor nao inventa numero", () => {
  for (const texto of ["sim", "Sim!", "houve sim", "teve", "o plano cobriu", "reembolsaram"]) {
    assertEquals(extrairRespostaDeReembolso(texto), { houve: true, valor: null }, texto);
    assertEquals(serializarRespostaReembolso(texto), "SIM", texto);
  }
});

Deno.test("despesa nova nao vira resposta de reembolso", () => {
  // Mesmo vies do extrairDocumento: na duvida, isto e mensagem nova. O verbo de
  // gasto e o sinal, e ele derruba a leitura mesmo com um numero so.
  const lancamentos = [
    "paguei 300 no mercado",
    "gastei 50 na farmacia",
    "comprei um monitor por 900",
    "custou 120",
    "transferi 400 pro dentista",
  ];

  for (const texto of lancamentos) {
    assertEquals(extrairRespostaDeReembolso(texto), null, texto);
    assertEquals(serializarRespostaReembolso(texto), null, texto);
  }
});

Deno.test("dois numeros na mensagem recusam a leitura", () => {
  // "valor + alguma coisa" e mensagem nova, nao resposta. Sem digito verificador
  // para apoiar, a exigencia de um numero so e o que segura o falso positivo.
  for (const texto of ["50 e 30", "consulta 400 reembolso 200", "dia 15 foram 300"]) {
    assertEquals(extrairRespostaDeReembolso(texto), null, texto);
  }

  // Estes sao os que provam a guarda: com uma palavra de negacao ou afirmacao na
  // frase, dois numeros passariam direto pelos ramos de palavra e a mensagem
  // seria lida como resposta seca — "nao 200 300" gravaria reembolso zero tendo
  // dois valores escritos, e "sim 150 250" viraria "sim, sem valor" com dois
  // valores na tela. Sem estes casos a recusa por contagem nao e observavel.
  assertEquals(extrairRespostaDeReembolso("nao 200 300"), null);
  assertEquals(extrairRespostaDeReembolso("sim 150 250"), null);
  assertEquals(extrairRespostaDeReembolso("nao, foi 200 de 300"), null);
});

Deno.test("documento colado nao vira valor de reembolso", () => {
  // Sem o corte por tamanho, um CPF/CNPJ que chegasse nesta pendencia viraria
  // um reembolso de bilhoes — barrado depois pelo teto, mas ja com a pendencia
  // consumida.
  for (const texto of [CNPJ, "11.222.333/0001-81", "529.982.247-25", "52998224725"]) {
    assertEquals(extrairRespostaDeReembolso(texto), null, texto);
  }
});

Deno.test("promessa de resposta futura nao e negacao", () => {
  // "nao vou pedir reembolso ainda" nao e "nao houve reembolso", e gravar 0 ali
  // criaria exatamente a inconsistencia com a DMED que a fase existe para
  // evitar. Palavra fora do vocabulario segue para a IA.
  for (
    const texto of [
      "nao vou pedir reembolso ainda",
      "ainda nao sei",
      "nao lembro se o plano cobriu",
      "o plano cobriu metade",
      "acho que sim",
    ]
  ) {
    assertEquals(extrairRespostaDeReembolso(texto), null, texto);
  }
});

Deno.test("mensagem vazia ou sem relacao nao e resposta", () => {
  for (const texto of ["", "   ", null, undefined, "bom dia", "me manda o resumo"]) {
    assertEquals(extrairRespostaDeReembolso(texto), null, String(texto));
  }
});

// --- fronteiras com o que ja existia --------------------------------------

Deno.test("extrairRespostaDeCampo roteia por campo, sem cruzar caminhos", () => {
  // Documento respondido a pergunta de reembolso nao vira reembolso, e valor
  // respondido a pergunta de documento nao vira documento.
  assertEquals(extrairRespostaDeCampo(CAMPO_REEMBOLSO, `cnpj ${CNPJ}`), null);
  assertEquals(extrairRespostaDeCampo("documento_prestador", "300"), null);
  assertEquals(extrairRespostaDeCampo("documento_prestador", `cnpj ${CNPJ}`), CNPJ);
  assertEquals(extrairRespostaDeCampo(CAMPO_REEMBOLSO, "300"), "300.00");
  // estabelecimento continua sem reconhecimento deterministico, de proposito.
  assertEquals(extrairRespostaDeCampo("estabelecimento", "Clinica Vida"), null);
});

Deno.test("a guarda de conteudo vazio de ontem nao foi tocada", () => {
  // "nao" continua sendo mensagem sem conteudo para a pergunta de CNPJ — e a
  // funcao segue byte a byte a de ontem. O que muda e a ORDEM no chamador: para
  // a pergunta de reembolso, o reconhecimento roda antes e "nao" e resposta
  // completa. As duas leituras convivem porque nunca sao consultadas juntas.
  assertEquals(respostaSemConteudo("nao"), true);
  assertEquals(respostaSemConteudo("sim"), true);
  assertEquals(respostaSemConteudo("ok"), true);

  assertEquals(extrairRespostaDeReembolso("nao"), { houve: false, valor: 0 });
  assertEquals(extrairRespostaDeReembolso("sim"), { houve: true, valor: null });
  // "ok" nao afirma nem nega reembolso: continua sem conteudo nos dois campos.
  assertEquals(extrairRespostaDeReembolso("ok"), null);
});

Deno.test("os dois reconhecedores nunca aceitam o mesmo texto", () => {
  const textos = [
    CNPJ,
    `cnpj ${CNPJ}`,
    "11.222.333/0001-81",
    "300",
    "R$ 300",
    "nao",
    "sim",
    "paguei 300 no mercado",
    "o plano cobriu 250",
    "52998224725",
  ];

  for (const texto of textos) {
    const documento = extrairDocumento(texto);
    const reembolso = extrairRespostaDeReembolso(texto);
    assert(
      !(documento && reembolso),
      `"${texto}" foi aceito pelos dois: ${documento} / ${JSON.stringify(reembolso)}`,
    );
  }
});
