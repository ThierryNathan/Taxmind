// Fase 13 - logica pura do follow-up conversacional.
//
// Rodar:  deno test tests/followup_test.ts
//
// Aqui mora a parte que decide se uma mensagem responde a pergunta. O vies do
// arquivo inteiro e o mesmo do codigo: na duvida, NAO e resposta — tratar um
// lancamento legitimo como resposta apaga uma despesa, e deixar a pendencia
// expirar nao custa nada.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calcularExpiracaoFollowup,
  campoRespondivel,
  cnpjValido,
  cpfValido,
  decidirFollowup,
  documentoConferido,
  extrairDocumento,
  extrairRespostaDeCampo,
  FOLLOWUP_MENSAGENS_TOLERADAS,
  FOLLOWUP_TTL_MINUTOS,
  followupExpirado,
  formatarDocumento,
  perguntaParaCampo,
  type PendenciaFollowup,
  respostaDocumentoInvalido,
  respostaSemConteudo,
} from "../supabase/functions/_shared/followup.ts";

// CNPJ e CPF sinteticos com digito verificador coerente.
const CNPJ = "11222333000181";
const CPF = "39053344705";
const MINUTO = 60 * 1000;

Deno.test("digito verificador separa documento de numero qualquer", () => {
  assert(cnpjValido(CNPJ));
  assert(cnpjValido("11.222.333/0001-81"));
  assert(!cnpjValido("11222333000182"), "digito errado passou");
  assert(!cnpjValido("11111111111111"), "sequencia repetida passou");
  assert(!cnpjValido("1122233300018"));

  assert(cpfValido(CPF));
  assert(cpfValido("390.533.447-05"));
  assert(!cpfValido("39053344704"));
  assert(!cpfValido("00000000000"));
});

Deno.test("extrai o documento do jeito que a pessoa escreve", () => {
  assertEquals(extrairDocumento(CNPJ), CNPJ);
  assertEquals(extrairDocumento("11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("  11 222 333 0001 81 "), CNPJ);
  assertEquals(extrairDocumento("CNPJ 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("e o cnpj 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("aqui esta: 390.533.447-05"), CPF);
});

Deno.test("regressao: linguagem natural em volta do documento e resposta", () => {
  // "cnpj dele e <CNPJ>" foi digitado numa conversa real e NAO foi reconhecido:
  // a versao antiga exigia que toda palavra estivesse numa lista fechada de
  // prefixos, e morreu em "dele". A mensagem virou despesa nova no
  // classificador de intencao, o Gemini gravou valor 0 e o insert bateu na
  // constraint recibos_valor_positivo_chk — nenhum recibo, nenhuma resposta.
  //
  // O CNPJ da conversa real foi trocado pelo sintetico de propósito: e de uma
  // clinica de verdade.
  assertEquals(extrairDocumento(`cnpj dele é ${CNPJ}`), CNPJ);
  assertEquals(extrairDocumento("cnpj dele é 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("o cnpj é 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("cnpj da clinica: 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("é esse aqui: 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("achei o papel, o cnpj do dentista e 11.222.333/0001-81"), CNPJ);
  assertEquals(extrairDocumento("o cpf da profissional e 390.533.447-05, obrigado"), CPF);
});

Deno.test("mensagem com qualquer outro conteudo NAO e resposta", () => {
  // O caso que justifica a checagem toda: isto e uma despesa nova, e trata-la
  // como resposta faria o lancamento sumir. Continua recusado depois de a
  // extracao ficar tolerante — quem segura agora e o vocabulario de gasto.
  assertEquals(extrairDocumento("paguei 11222333000181 no mercado"), null);
  assertEquals(extrairDocumento("paguei 123456 no mercado"), null);
  assertEquals(extrairDocumento("gastei 450 na consulta"), null);
  assertEquals(extrairDocumento("nao tenho o cnpj"), null);
  assertEquals(extrairDocumento("clinica vida"), null);
  assertEquals(extrairDocumento(""), null);
  assertEquals(extrairDocumento(null), null);
  // Numero com a quantidade certa de digitos mas invalido tambem nao passa.
  assertEquals(extrairDocumento("11222333000182"), null);
});

Deno.test("documento valido no meio de uma despesa continua sendo despesa", () => {
  // Os tres filtros, um por vez, com o MESMO documento valido da conversa que
  // deve ser aceita sozinha. Sem eles a tolerancia nova roubaria lancamento.

  // 1. vocabulario de gasto
  assertEquals(extrairDocumento(`comprei material na papelaria ${CNPJ}`), null);
  assertEquals(extrairDocumento(`consulta custou caro, cnpj ${CNPJ}`), null);

  // 2. numero sobrando (quase sempre o valor)
  assertEquals(extrairDocumento(`450 clinica ${CNPJ}`), null);
  assertEquals(extrairDocumento(`${CNPJ} 450`), null);

  // 3. simbolo de moeda, mesmo grudado no numero
  assertEquals(extrairDocumento(`clinica ${CNPJ} R$500`), null);

  // Ambiguidade tambem recusa: dois documentos validos, nenhum jeito de saber
  // qual e o do prestador.
  assertEquals(extrairDocumento(`cnpj ${CNPJ} cpf ${CPF}`), null);
});

Deno.test("estabelecimento nao tem resposta reconhecivel sem IA", () => {
  // De proposito: adivinhar nome de lugar em texto livre roubaria lancamentos
  // ("mercado 50 reais" e nome ou despesa?). Esse campo cai na reclassificacao.
  assertEquals(extrairRespostaDeCampo("estabelecimento", "Clinica Vida"), null);
  assertEquals(extrairRespostaDeCampo("documento_prestador", CNPJ), CNPJ);
});

Deno.test("mascara so na exibicao", () => {
  assertEquals(formatarDocumento(CNPJ), "11.222.333/0001-81");
  assertEquals(formatarDocumento(CPF), "390.533.447-05");
  assertEquals(formatarDocumento("123"), "123");
});

Deno.test("resposta sem conteudo extraivel e reconhecida como tal", () => {
  // "Sim" e a resposta natural para "voce tem o CNPJ?" — e nao responde nada.
  // Era o caso do bug: seguia para a reclassificacao, voltava com uma analise
  // sem estabelecimento e sem documento, e mesmo assim fechava a pendencia.
  for (
    const texto of [
      "Sim",
      "sim",
      "SIM!",
      "ok",
      "Ok.",
      "beleza",
      "blz",
      "tenho sim",
      "com certeza",
      "claro",
      "isso",
      "aham",
      "uhum",
      "nao tenho",
      "não tenho",
      "sim, eu tenho",
      "já mando",
      "deixa eu ver",
      "só um minuto",
      "vou procurar",
      "obrigado",
      "tudo bem",
      "",
      "   ",
      "...",
    ]
  ) {
    assert(respostaSemConteudo(texto), `deveria ser sem conteudo: ${JSON.stringify(texto)}`);
  }
});

Deno.test("resposta com qualquer dado real passa pela guarda", () => {
  // O contrapeso: a lista e negra e de mensagem INTEIRA. Basta uma palavra de
  // fora — nome de lugar, tipo de servico — para a mensagem seguir para a
  // reclassificacao, que e quem sabe ler evidencia.
  for (
    const texto of [
      "foi na clinica Vida",
      "clinica Vida",
      "consulta com psicologo",
      "dr souza",
      "foi no hospital sirio",
      "tenho sim, e a clinica vida",
      "nao tenho o papel mas foi consulta com dentista",
      "voces atendem no sabado?",
    ]
  ) {
    assert(!respostaSemConteudo(texto), `engoliu resposta real: ${JSON.stringify(texto)}`);
  }
});

Deno.test("qualquer digito na mensagem desliga a guarda", () => {
  // Documento e valor sao digitos. Nenhuma mensagem com numero pode ser
  // descartada aqui, nem quando o resto do texto e so confirmacao.
  assert(!respostaSemConteudo(`sim, ${CNPJ}`));
  assert(!respostaSemConteudo("tenho sim 11.222.333/0001-81"));
  assert(!respostaSemConteudo("ok 600"));
});

Deno.test("pergunta cita o estabelecimento quando ele e conhecido", () => {
  assertEquals(
    perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" }),
    "Para confirmar se é dedutível, você tem o CNPJ ou CPF de Clinica Vida?",
  );
  assert(
    perguntaParaCampo("documento_prestador", {}).includes("do prestador"),
  );
  assert(perguntaParaCampo("estabelecimento").includes("onde foi essa despesa"));
});

Deno.test("janela de 30 minutos", () => {
  const agora = new Date("2026-08-08T12:00:00.000Z");
  assertEquals(FOLLOWUP_TTL_MINUTOS, 30);
  assertEquals(
    calcularExpiracaoFollowup(agora).toISOString(),
    "2026-08-08T12:30:00.000Z",
  );

  assert(!followupExpirado("2026-08-08T12:29:59.000Z", agora));
  assert(followupExpirado("2026-08-08T12:00:00.000Z", agora), "limite exato deve expirar");
  assert(followupExpirado(null, agora));
  assert(followupExpirado("data invalida", agora));
});

const pendencia = (overrides: Partial<PendenciaFollowup> = {}): PendenciaFollowup => ({
  id: "f0000000-0000-4000-8000-000000000001",
  recibo_id: "r0000000-0000-4000-8000-000000000001",
  campo_alvo: "documento_prestador",
  expira_em: new Date(Date.now() + 10 * MINUTO).toISOString(),
  mensagens_restantes: FOLLOWUP_MENSAGENS_TOLERADAS,
  ...overrides,
});

Deno.test("sem pendencia, nada acontece", () => {
  assertEquals(decidirFollowup(null, { tipo: "text", texto: "oi" }).acao, "ignorar");
});

Deno.test("resposta reconhecida nao gasta orcamento", () => {
  const decisao = decidirFollowup(pendencia(), { tipo: "text", texto: `cnpj ${CNPJ}` });

  assertEquals(decisao.acao, "anotar");
  if (decisao.acao !== "anotar") throw new Error("tipo");
  assertEquals(decisao.valorDetectado, CNPJ);
  // A propria resposta nao pode ser a mensagem que fecha a pendencia que ela
  // veio responder.
  assertEquals(decisao.mensagensRestantes, FOLLOWUP_MENSAGENS_TOLERADAS);
});

Deno.test("mensagem que nao responde consome uma das duas mensagens", () => {
  const primeira = decidirFollowup(pendencia(), { tipo: "text", texto: "gastei 30 no uber" });
  assertEquals(primeira.acao, "anotar");
  if (primeira.acao !== "anotar") throw new Error("tipo");
  assertEquals(primeira.valorDetectado, null);
  assertEquals(primeira.mensagensRestantes, 1);

  const segunda = decidirFollowup(
    pendencia({ mensagens_restantes: 1 }),
    { tipo: "text", texto: "e o resumo?" },
  );
  assertEquals(segunda.acao, "anotar");
  if (segunda.acao !== "anotar") throw new Error("tipo");
  // Ultima chance: ainda anotada, para o ramo de texto livre poder usar.
  assertEquals(segunda.mensagensRestantes, 0);

  const terceira = decidirFollowup(
    pendencia({ mensagens_restantes: 0 }),
    { tipo: "text", texto: "bom dia" },
  );
  assertEquals(terceira.acao, "descartar");
  if (terceira.acao !== "descartar") throw new Error("tipo");
  assertEquals(terceira.motivo, "ORCAMENTO_ESGOTADO");
});

Deno.test("midia nunca responde, so gasta orcamento", () => {
  const decisao = decidirFollowup(pendencia(), { tipo: "image", texto: null });

  assertEquals(decisao.acao, "anotar");
  if (decisao.acao !== "anotar") throw new Error("tipo");
  assertEquals(decisao.valorDetectado, null);
  assertEquals(decisao.mensagensRestantes, 1);
});

Deno.test("pendencia vencida e descartada antes de qualquer avaliacao", () => {
  const vencida = pendencia({ expira_em: new Date(Date.now() - MINUTO).toISOString() });
  const decisao = decidirFollowup(vencida, { tipo: "text", texto: `cnpj ${CNPJ}` });

  assertEquals(decisao.acao, "descartar");
  if (decisao.acao !== "descartar") throw new Error("tipo");
  assertEquals(decisao.motivo, "EXPIRADA");
});

Deno.test("campo fora da lista de respondiveis nao vira pergunta", () => {
  assert(campoRespondivel("documento_prestador"));
  assert(campoRespondivel("estabelecimento"));
  assert(!campoRespondivel("categoria"));
  assert(!campoRespondivel(undefined));

  const decisao = decidirFollowup(
    pendencia({ campo_alvo: "categoria" }),
    { tipo: "text", texto: "saude" },
  );
  assertEquals(decisao.acao, "descartar");
});

// --- documento digitado errado (Fase 14, varredura) -----------------------

Deno.test("documento com digito verificador errado e reconhecido como erro de digitacao", () => {
  // O caso medido: um digito trocado no CNPJ da pergunta. A extracao recusa (e
  // deve recusar), e ate a Fase 14 a mensagem seguia para a reclassificacao,
  // onde o Gemini gravava o numero invalido e promovia a despesa — 3/3.
  assert(respostaDocumentoInvalido("11.222.333/0001-82"));
  assert(respostaDocumentoInvalido("o cnpj é 11.222.333/0001-82"));
  assert(respostaDocumentoInvalido("cpf dele é 111.444.777-36"));
  assert(respostaDocumentoInvalido("11222333000182"));
});

Deno.test("as duas leituras do documento sao mutuamente exclusivas", () => {
  // extrairDocumento nao foi tocado; respostaDocumentoInvalido e a irma dele.
  // Nenhum texto pode acionar as duas, e nenhuma resposta valida pode virar
  // "digitou errado".
  const textos = [
    CNPJ,
    CPF,
    "11.222.333/0001-81",
    "cnpj dele e 11.222.333/0001-81",
    "11.222.333/0001-82",
    "o cnpj é 11.222.333/0001-82",
    "paguei 450 na clinica 11.222.333/0001-81",
    "paguei 450 na clinica 11.222.333/0001-82",
    "foi na clinica vida",
    "sim",
    "11.222.333/0001-81 ou 25.255.628/0001-69",
    "meu telefone é 11999998888",
    "gastei 82 reais",
  ];

  for (const texto of textos) {
    const valido = extrairDocumento(texto) !== null;
    const invalido = respostaDocumentoInvalido(texto);
    assert(!(valido && invalido), `os dois responderam sim: ${texto}`);
  }
});

Deno.test("numero solto com vocabulario de gasto continua sendo despesa nova", () => {
  // Mesmo vies do irmao: numero sobrando ou termo de gasto significa
  // lancamento, e nao documento digitado errado. Errar para este lado custa uma
  // pergunta repetida; errar para o outro rouba um lancamento.
  assert(!respostaDocumentoInvalido("paguei 450 na clinica 11.222.333/0001-82"));
  assert(!respostaDocumentoInvalido("gastei 11222333000182 reais"));
  assert(!respostaDocumentoInvalido("R$ 11222333000182"));
  assert(!respostaDocumentoInvalido("11.222.333/0001-82 e 80 de uber"));
  // Sem documento nenhum tambem nao e erro de digitacao.
  assert(!respostaDocumentoInvalido("foi na clinica vida"));
  assert(!respostaDocumentoInvalido("sim"));
  assert(!respostaDocumentoInvalido(""));
  assert(!respostaDocumentoInvalido(null));
});

Deno.test("documentoConferido so deixa passar o que fecha o digito verificador", () => {
  assertEquals(documentoConferido("11.222.333/0001-81"), "11.222.333/0001-81");
  assertEquals(documentoConferido(CNPJ), CNPJ);
  assertEquals(documentoConferido(CPF), CPF);
  assertEquals(documentoConferido("11.222.333/0001-82"), null);
  assertEquals(documentoConferido("nao informado"), null);
  assertEquals(documentoConferido(null), null);
  assertEquals(documentoConferido(""), null);
  assertEquals(documentoConferido(12345), null);
});
