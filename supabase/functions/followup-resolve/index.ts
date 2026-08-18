// Fase 13 - resolucao do follow-up conversacional.
//
// Chamada pelo n8n (consulta-e-dossie) quando uma mensagem de texto chega com
// uma pendencia aberta anotada pela whatsapp-webhook. Recebe a mensagem crua e
// decide sozinha entre os dois modos:
//
//   CAMPO_PREENCHIDO — a mensagem e o documento pedido (CNPJ/CPF com digito
//     verificador). Patch local deterministico: preenche o campo, remove-o de
//     campos_bloqueantes e promove o recibo SE a lista esvaziar. Sem chamada de
//     IA: o que faltava era campo estruturado, e reprocessar o mesmo texto
//     mudaria uma classificacao ja auditada por variacao do modelo.
//
//   RECLASSIFICADO — a mensagem e texto livre ("foi na clinica X, nao tenho o
//     CNPJ, foi consulta com psicologo"). Isso e evidencia nova, nao
//     preenchimento de campo, e ai reclassificar e o caminho honesto. A analise
//     nova entra AO LADO da original em metadados_ia, nunca no lugar dela.
//
// Regra que atravessa as duas: promocao nunca rebaixa, e valor e data nunca sao
// reescritos por texto de follow-up — a evidencia deles foi a mensagem original.
//
// Fase 16 — encadeamento reativo. Ate aqui os tres modos terminavam no mesmo par
// de linhas (patch no recibo, return) e NADA reavaliava o recibo depois. Como o
// unico componente que abre pendencia e o workflow de recibo, no insert, uma
// despesa que precisava de duas respostas so recebia a primeira pergunta:
//
//   "Paguei 500 na consulta e com convenio" -> pergunta de reembolso
//   "Nao teve reembolso"                    -> reembolso gravado, pendencia fecha
//   "o cnpj e 11.222.333/0001-81"           -> sem pendencia aberta, o
//       classificador de intencao le a mensagem como despesa nova (medido
//       registro_despesa 3/3), o prompt fiscal devolve valor 0 e o usuario recebe
//       "Nao consegui identificar o valor dessa despesa".
//
// Continua sendo UMA pergunta por vez — o que muda e que a seguinte nasce no
// turno seguinte, em vez de nunca. Ver proximaPergunta() la embaixo.
//
// Toda a decisao vive aqui, e nao em Code node do n8n, por testabilidade:
// tests/followup_resolve_test.ts exercita a function real com Supabase e Gemini
// em memoria, e tests/followup_test.ts cobre a logica pura de _shared.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  CAMPO_REEMBOLSO,
  type CampoFollowup,
  campoRespondivel,
  derivarCamposBloqueantes,
  destinoSeDesbloqueado,
  destinoSeSemReembolso,
  deveperguntarReembolso,
  documentoConferido,
  extrairRespostaDeCampo,
  extrairRespostaDeReembolso,
  followupExpirado,
  formatarDocumento,
  mensagemDocumentoNaoConfere,
  mensagemPerguntaSegueAberta,
  mensagemReembolsoMaiorQueDespesa,
  mensagemReembolsoSemValor,
  montarContextoReclassificacao,
  type PendenciaFollowup,
  perguntaParaCampo,
  respostaDocumentoInvalido,
  respostaSemConteudo,
} from "../_shared/followup.ts";
import { TAXMIND_SYSTEM_PROMPT } from "../_shared/prompt_fiscal.ts";
import { rotuloEnum } from "../_shared/rotulos.ts";

type ResolveRequest = {
  followup_id?: string;
  usuario_id?: string;
  texto?: string;
};

type Recibo = {
  id: string;
  usuario_id: string;
  descricao: string;
  valor: number | string;
  // NULL e 0 sao estados diferentes (migration 010): NULL = nunca perguntado,
  // 0 = o titular confirmou que nao houve. E por isso que ele serve de guarda
  // contra reperguntar o reembolso — ver proximaPergunta().
  valor_reembolsado: number | string | null;
  data_despesa: string | null;
  estabelecimento: string | null;
  documento_prestador: string | null;
  categoria: string;
  deducibilidade: string;
  justificativa_deducibilidade: string | null;
  confidence_score: number | string;
  status: string;
  requer_revisao_humana: boolean;
  metadados_ia: Record<string, unknown>;
};

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

// A frase e a mesma regra do resumo e do dossie, na voz do WhatsApp: deducao
// reduz a BASE DE CALCULO, nao o imposto devido.
const FRASE_DEDUCAO =
  "Esse valor reduz sua base de cálculo do IR — a economia real depende da sua faixa de tributação, não é o valor que você recebe de volta.";

serve(async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    // Mesma postura da generate-dossier: a anon key e publica, e esta function
    // altera classificacao fiscal de recibo alheio se o chamador nao for
    // conferido. Server-to-server (n8n) exige a service_role key.
    if (!isServiceRoleCaller(request)) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = await request.json() as ResolveRequest;
    const followupId = body?.followup_id?.trim();
    const usuarioId = body?.usuario_id?.trim();
    if (!followupId || !usuarioId) {
      return json({ error: "missing_followup_or_usuario" }, 400);
    }

    return json(await resolver(followupId, usuarioId, body?.texto ?? ""));
  } catch (error) {
    console.error("followup-resolve error", error);
    return json({ error: "internal_error" }, 500);
  }
});

async function resolver(followupId: string, usuarioId: string, texto: string) {
  const pendencia = await buscarPendencia(followupId);

  // Pendencia inexistente, ja fechada por outra execucao ou de outro dono. O
  // par usuario_id vem do n8n (resolvido por session_id) e precisa bater com o
  // dono da linha: sem isso, um followup_id vazado resolveria recibo alheio.
  if (!pendencia || pendencia.usuario_id !== usuarioId) {
    return { resolvido: false, motivo: "PENDENCIA_INDISPONIVEL" as const, mensagem: null };
  }

  if (followupExpirado(pendencia.expira_em)) {
    await descartar(pendencia.id, "EXPIRADA");
    return { resolvido: false, motivo: "PENDENCIA_EXPIRADA" as const, mensagem: null };
  }

  if (!campoRespondivel(pendencia.campo_alvo)) {
    // Mesmo rotulo que a whatsapp-webhook grava para a mesma condicao. Antes
    // eram dois nomes ("CAMPO_INVALIDO" aqui, "EXPIRADA" la) para o mesmo fato
    // — pendencia criada com um campo que esta versao do codigo nao conhece —,
    // e reconstruir um incidente a partir da tabela exigia adivinhar qual
    // componente tinha escrito a linha.
    await descartar(pendencia.id, "CAMPO_DESCONHECIDO");
    return { resolvido: false, motivo: "PENDENCIA_INDISPONIVEL" as const, mensagem: null };
  }

  const campo = pendencia.campo_alvo as CampoFollowup;
  const recibo = await buscarRecibo(pendencia.recibo_id);
  if (!recibo || recibo.usuario_id !== usuarioId) {
    await descartar(pendencia.id, "RECIBO_INDISPONIVEL");
    return { resolvido: false, motivo: "RECIBO_INDISPONIVEL" as const, mensagem: null };
  }

  // O reembolso tem caminho proprio e 100% deterministico, sem passar pela
  // reclassificacao por IA. Nao e economia de chamada: o espaco de respostas
  // aqui e minusculo e fechado (nao / um valor / sim sem valor), e mandar o
  // texto para o modelo abriria a porta que a fase inteira existe para fechar —
  // uma analise nova poderia promover a despesa para DEDUTIVEL com o reembolso
  // ainda em aberto, que e exatamente a inconsistencia com a DMED.
  if (campo === CAMPO_REEMBOLSO) {
    return await resolverReembolso(pendencia, recibo, texto);
  }

  const documento = extrairRespostaDeCampo(campo, texto);
  return documento
    ? await preencherCampo(pendencia, recibo, campo, documento)
    : await reclassificar(pendencia, recibo, campo, texto);
}

// --- modo REEMBOLSO_INFORMADO --------------------------------------------

async function resolverReembolso(
  pendencia: PendenciaComDono,
  recibo: Recibo,
  texto: string,
) {
  const resposta = extrairRespostaDeReembolso(texto);

  // Nao reconhecida. Duas saidas separadas so para observabilidade; as duas
  // deixam a pendencia intacta e repetem a pergunta, que ja pede o valor.
  // "ok" e "o plano cobriu metade" caem aqui, e nenhuma das duas pode fechar
  // uma pendencia sem ter dito quanto.
  if (!resposta) {
    return {
      resolvido: false,
      motivo: respostaSemConteudo(texto)
        ? ("SEM_CONTEUDO" as const)
        : ("REEMBOLSO_NAO_RECONHECIDO" as const),
      mensagem: mensagemPerguntaSegueAberta(pendencia.pergunta),
    };
  }

  // "Sim" sem valor. A pergunta continua de pe, como no documento com digito
  // errado: quem confirmou o reembolso quase sempre sabe de quanto foi.
  if (resposta.houve && resposta.valor === null) {
    return {
      resolvido: false,
      motivo: "REEMBOLSO_SEM_VALOR" as const,
      mensagem: mensagemReembolsoSemValor(),
    };
  }

  const valorDespesa = Number(recibo.valor);
  const reembolso = resposta.houve ? (resposta.valor as number) : 0;

  // Teto: reembolso maior que a despesa nao e reembolso. A constraint
  // recibos_valor_reembolsado_chk barraria o insert de qualquer jeito, e a
  // execucao morreria depois de reivindicar a pendencia — sem resposta ao
  // usuario e sem pendencia para tentar de novo. Mesma licao do IF
  // "Valor Válido?" do outro workflow: nada que pode falhar antes do unico node
  // que responde.
  if (!Number.isFinite(valorDespesa) || reembolso > valorDespesa) {
    return {
      resolvido: false,
      motivo: "REEMBOLSO_MAIOR_QUE_DESPESA" as const,
      mensagem: mensagemReembolsoMaiorQueDespesa(formatarReais(valorDespesa)),
    };
  }

  if (!await reivindicar(pendencia.id, "REEMBOLSO_INFORMADO")) {
    return { resolvido: false, motivo: "JA_RESOLVIDA" as const, mensagem: null };
  }

  const integral = reembolso > 0 && reembolso === valorDespesa;
  const liquido = valorDespesa - reembolso;

  // Reembolso integral rebaixa para NAO_DEDUTIVEL, e isso NAO contradiz a regra
  // de "promocao nunca rebaixa": aquela regra protege uma classificacao
  // auditada contra variacao do modelo, e aqui nao ha modelo nenhum no caminho.
  // Quem afirmou que o plano devolveu tudo foi o titular, e nao sobra base de
  // calculo para deduzir.
  //
  // Promocao exige identificacao no recibo, alem do destino declarado. A
  // varredura mostrou o modelo devolvendo deducibilidade_se_sem_reembolso
  // "DEDUTIVEL" em despesa sem prestador nenhum ("consulta 400 reais, usei o
  // convenio"): sem esta checagem, responder "nao" aprovaria automaticamente
  // uma despesa de saude sem prestador, que e o oposto do que o follow-up de
  // identificacao existe para garantir.
  const destino = destinoSeSemReembolso(recibo.metadados_ia);
  const promover = !integral &&
    Boolean(destino) &&
    recibo.requer_revisao_humana &&
    temIdentificacao(recibo);

  const patch: Record<string, unknown> = {
    // valor continua sendo o BRUTO pago, aqui como em todo o resto do
    // follow-up. O liquido e derivado na leitura (resumo_fiscal_usuario e
    // dossie), nunca gravado por cima da evidencia.
    valor_reembolsado: reembolso,
    metadados_ia: {
      ...recibo.metadados_ia,
      followups: [
        ...historicoFollowups(recibo),
        {
          followup_id: pendencia.id,
          campo: CAMPO_REEMBOLSO,
          modo: "REEMBOLSO_INFORMADO",
          houve_reembolso: resposta.houve,
          valor_reembolsado: reembolso,
          valor_bruto: valorDespesa,
          valor_liquido_dedutivel: liquido,
          integral,
          promovido: promover,
          deducibilidade_anterior: recibo.deducibilidade,
          resolvido_em: new Date().toISOString(),
        },
      ],
    },
  };

  if (integral) {
    patch.deducibilidade = "NAO_DEDUTIVEL";
    patch.requer_revisao_humana = false;
    patch.status = "APROVADO_AUTOMATICAMENTE";
  } else if (promover) {
    patch.deducibilidade = destino;
    patch.requer_revisao_humana = false;
    patch.status = "APROVADO_AUTOMATICAMENTE";
  }

  await atualizarRecibo(recibo.id, patch);

  // Aqui esta a sequencia 1: reembolso respondido, mas a despesa segue em revisao
  // porque nao ha prestador identificado (temIdentificacao acima). Ate a Fase 16
  // a conversa morria neste ponto e o CNPJ que o usuario mandava em seguida
  // virava tentativa de despesa nova.
  const seguinte = await proximaPergunta(pendencia, recibo, patch);
  const confirmacao = mensagemReembolso({
    houve: resposta.houve,
    integral,
    promovido: promover,
    bruto: valorDespesa,
    reembolso,
    liquido,
    deducibilidade: String(patch.deducibilidade ?? recibo.deducibilidade),
  });

  return {
    resolvido: true,
    modo: "REEMBOLSO_INFORMADO" as const,
    promovido: promover,
    recibo_id: recibo.id,
    mensagem: comPerguntaSeguinte(confirmacao, seguinte),
  };
}

/** Uma mensagem so, com a pergunta no fim. Mesma juncao que o Code node
 *  "Montar Payload do Recibo" usa para colar a pergunta na confirmacao. */
function comPerguntaSeguinte(mensagem: string, pergunta: string | null): string {
  return pergunta ? `${mensagem}\n\n${pergunta}` : mensagem;
}

/**
 * Confirmacao do reembolso, na voz do WhatsApp.
 *
 * Bruto, reembolso e liquido aparecem os tres quando houve desconto: o numero
 * que muda e o dedutivel, e esconder a conta faria o usuario achar que perdeu
 * parte da despesa. E a FRASE_DEDUCAO continua obrigatoria em toda frase que
 * afirma dedutibilidade — reduz base de calculo, nao e dinheiro de volta.
 */
function mensagemReembolso(dados: {
  houve: boolean;
  integral: boolean;
  promovido: boolean;
  bruto: number;
  reembolso: number;
  liquido: number;
  deducibilidade: string;
}): string {
  if (!dados.houve) {
    return dados.promovido
      ? [
        "Anotei que não houve reembolso nessa despesa.",
        `Com isso ela fica classificada como ${humanizar(dados.deducibilidade)}. ${FRASE_DEDUCAO}`,
      ].join("\n\n")
      : [
        "Anotei que não houve reembolso nessa despesa.",
        "Ela continua marcada para revisão do contador, mas agora com essa informação registrada.",
      ].join("\n\n");
  }

  if (dados.integral) {
    return [
      `Anotei: o plano devolveu os ${formatarReais(dados.bruto)} integralmente.`,
      "Como o valor voltou por inteiro, ele não entra na dedução — deduzir despesa reembolsada é o que a Receita cruza com a DMED do plano.",
    ].join("\n\n");
  }

  const conta = `${formatarReais(dados.bruto)} menos ${formatarReais(dados.reembolso)} de reembolso = ` +
    `${formatarReais(dados.liquido)} dedutíveis.`;

  return dados.promovido
    ? [`Anotei o reembolso: ${conta}`, `${FRASE_DEDUCAO}`].join("\n\n")
    : [
      `Anotei o reembolso: ${conta}`,
      "Ela continua marcada para revisão do contador, mas agora com o valor certo.",
    ].join("\n\n");
}

/** A regra fiscal de SAUDE pede identificacao do prestador OU do
 *  estabelecimento. E fato da linha, nao juizo — por isso e conferido aqui e
 *  nao perguntado ao modelo.
 *
 *  Aceita tanto o recibo quanto a visao pos-patch de estadoAposPatch: os dois
 *  carregam os mesmos dois campos, e a regra tem que ser a mesma nos dois usos
 *  (decidir promocao do reembolso e decidir se ainda vale perguntar). */
function temIdentificacao(
  origem: { documento_prestador?: unknown; estabelecimento?: unknown },
): boolean {
  const preenchido = (valor: unknown) =>
    valor !== null && valor !== undefined && String(valor).trim() !== "";
  return preenchido(origem.documento_prestador) || preenchido(origem.estabelecimento);
}

function formatarReais(valor: number): string {
  return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

// --- modo CAMPO_PREENCHIDO -----------------------------------------------

async function preencherCampo(
  pendencia: PendenciaComDono,
  recibo: Recibo,
  campo: CampoFollowup,
  valor: string,
) {
  const formatado = campo === "documento_prestador" ? formatarDocumento(valor) : valor;

  // Reivindica ANTES de escrever no recibo. O predicado e reavaliado pelo
  // Postgres no READ COMMITTED, entao duas execucoes concorrentes nao
  // conseguem as duas: a segunda atualiza zero linhas e desiste sem patch.
  if (!await reivindicar(pendencia.id, "CAMPO_PREENCHIDO")) {
    return { resolvido: false, motivo: "JA_RESOLVIDA" as const, mensagem: null };
  }

  const bloqueantes = camposBloqueantes(recibo).filter((item) => item !== campo);
  const promover = bloqueantes.length === 0 && recibo.requer_revisao_humana;
  const novaDeducibilidade = promover
    ? promoverDeducibilidade(recibo)
    : recibo.deducibilidade;

  const patch: Record<string, unknown> = {
    [campo]: formatado,
    metadados_ia: {
      ...recibo.metadados_ia,
      campos_bloqueantes: bloqueantes,
      followups: [
        ...historicoFollowups(recibo),
        {
          followup_id: pendencia.id,
          campo,
          valor: formatado,
          modo: "CAMPO_PREENCHIDO",
          promovido: promover,
          deducibilidade_anterior: recibo.deducibilidade,
          resolvido_em: new Date().toISOString(),
        },
      ],
    },
  };

  if (promover) {
    patch.requer_revisao_humana = false;
    patch.status = "APROVADO_AUTOMATICAMENTE";
    patch.deducibilidade = novaDeducibilidade;
  }

  await atualizarRecibo(recibo.id, patch);

  const seguinte = await proximaPergunta(pendencia, recibo, patch);

  const rotulo = campo === "documento_prestador" ? "documento" : "estabelecimento";
  const mensagem = promover
    ? [
      `Anotei o ${rotulo} ${formatado} nessa despesa.`,
      `Com ele, ela fica classificada como ${humanizar(novaDeducibilidade)}. ${FRASE_DEDUCAO}`,
    ].join("\n\n")
    : [
      `Anotei o ${rotulo} ${formatado} nessa despesa.`,
      `Ela continua marcada para revisão${motivoRestante(recibo)}, mas agora com a evidência completa.`,
    ].join("\n\n");

  return {
    resolvido: true,
    modo: "CAMPO_PREENCHIDO" as const,
    promovido: promover,
    recibo_id: recibo.id,
    mensagem: comPerguntaSeguinte(mensagem, seguinte),
  };
}

// --- modo RECLASSIFICADO --------------------------------------------------

async function reclassificar(
  pendencia: PendenciaComDono,
  recibo: Recibo,
  campo: CampoFollowup,
  texto: string,
) {
  // Antes de qualquer coisa: a resposta carrega alguma informacao?
  //
  // "Sim" e a resposta natural para "voce tem o CNPJ?", e ela nao responde
  // nada. Sem esta guarda a mensagem ia para a reclassificacao, voltava com
  // uma analise identica a original — estabelecimento e documento vazios do
  // mesmo jeito — e mesmo assim fechava a pendencia com "anotei essa
  // informacao". O CNPJ que viesse na mensagem seguinte ja nao teria pendencia
  // aberta para responder.
  //
  // Fica ANTES de reivindicar: pendencia que nao foi respondida nao pode ser
  // consumida. O orcamento de mensagens segue sendo debitado la na
  // whatsapp-webhook, como em qualquer mensagem que nao e resposta — entao isto
  // nao vira pendencia imortal.
  //
  // A mensagem de volta e a unica coisa que mudou na Fase 14: `resolvido:
  // false` continua igual, e o n8n continua caindo no mesmo node de saida. Sem
  // ela o usuario recebia o texto de ajuda generico ("posso registrar
  // despesas, mostrar seu resumo...") depois de responder "sim" a uma pergunta
  // — nada ali dizia que a pergunta seguia de pe.
  if (respostaSemConteudo(texto)) {
    return {
      resolvido: false,
      motivo: "SEM_CONTEUDO" as const,
      mensagem: mensagemPerguntaSegueAberta(pendencia.pergunta),
    };
  }

  // Documento digitado errado (Fase 14, varredura). Medido: `11.222.333/0001-82`
  // — um digito trocado — passava reto pela reclassificacao, que gravava o
  // numero invalido em documento_prestador e promovia a despesa para DEDUTIVEL
  // sem revisao, 3/3 no Gemini real. O caminho deterministico valida digito
  // verificador exatamente para isso nao acontecer; sem esta guarda, o caminho
  // de IA desfazia a validacao.
  //
  // So vale quando a pergunta era pelo documento: numero em resposta a "onde
  // foi essa despesa?" nao e documento digitado errado.
  //
  // Fica antes de reivindicar, como a guarda de conteudo: a pergunta continua
  // aberta, porque quem trocou um digito quase sempre tem o numero em maos.
  if (campo === "documento_prestador" && respostaDocumentoInvalido(texto)) {
    return {
      resolvido: false,
      motivo: "DOCUMENTO_INVALIDO" as const,
      mensagem: mensagemDocumentoNaoConfere(),
    };
  }

  const analise = await pedirReclassificacao(recibo, pendencia.pergunta, texto);

  if (!analise) {
    // Mensagem sem relacao com a despesa, ou IA indisponivel. A pendencia fica
    // aberta e expira sozinha; o n8n cai no texto de ajuda de sempre. Nao
    // bloquear e mais importante do que resolver.
    return { resolvido: false, motivo: "SEM_RELACAO" as const, mensagem: null };
  }

  if (!await reivindicar(pendencia.id, "RECLASSIFICADO")) {
    return { resolvido: false, motivo: "JA_RESOLVIDA" as const, mensagem: null };
  }

  // Mesma derivacao deterministica do primeiro lancamento: a analise nova
  // tambem nao declara campos_bloqueantes, ela declara o destino.
  const bloqueantes = derivarCamposBloqueantes(analise);
  // Promocao exige a IA nova dizer explicitamente que nao precisa de revisao.
  // Na duvida a despesa continua onde estava: promocao nunca rebaixa nem
  // aprova no susto.
  const promover = analise.requer_revisao_humana === false && bloqueantes.length === 0;

  const patch: Record<string, unknown> = {
    // valor e data_despesa ficam de fora de proposito: a evidencia deles foi a
    // mensagem original, e texto de follow-up nao pode reescrever quanto e
    // quando em silencio.
    categoria: analise.categoria ?? recibo.categoria,
    deducibilidade: analise.deducibilidade ?? recibo.deducibilidade,
    justificativa_deducibilidade: analise.justificativa_deducibilidade ??
      recibo.justificativa_deducibilidade,
    estabelecimento: analise.estabelecimento ?? recibo.estabelecimento,
    // Segunda camada da guarda acima: mesmo com ela, a analise pode devolver um
    // documento que ninguem digitou. Documento nao conferido nao entra — ele
    // viraria evidencia no dossie que o contador revisa.
    documento_prestador: documentoConferido(analise.documento_prestador) ??
      recibo.documento_prestador,
    metadados_ia: {
      ...recibo.metadados_ia,
      campos_bloqueantes: bloqueantes,
      // A analise original continua inteira acima; a nova entra na lista.
      reclassificacoes: [
        ...historicoReclassificacoes(recibo),
        {
          followup_id: pendencia.id,
          modo: "RECLASSIFICADO",
          promovido: promover,
          resolvido_em: new Date().toISOString(),
          analise,
        },
      ],
    },
  };

  if (promover) {
    patch.requer_revisao_humana = false;
    patch.status = "APROVADO_AUTOMATICAMENTE";
  }

  await atualizarRecibo(recibo.id, patch);

  // Aqui esta a sequencia 2. "Foi do convenio" reclassifica, e a analise NOVA
  // declara possui_indicio_reembolso true (medido no Gemini real: 6/6 quando o
  // recibo ainda nao tem estabelecimento) — sinal que ate a Fase 16 era gravado
  // na trilha e descartado, porque so a classificacao original abria pendencia.
  const seguinte = await proximaPergunta(pendencia, recibo, patch, analise);

  const mensagem = promover
    ? [
      "Obrigado, isso resolve a pendência dessa despesa.",
      `Ela fica classificada como ${humanizar(String(patch.deducibilidade))}. ${FRASE_DEDUCAO}`,
    ].join("\n\n")
    : [
      "Obrigado, anotei essa informação na despesa.",
      "Ela continua marcada para revisão do contador, mas agora com mais contexto.",
    ].join("\n\n");

  return {
    resolvido: true,
    modo: "RECLASSIFICADO" as const,
    promovido: promover,
    recibo_id: recibo.id,
    mensagem: comPerguntaSeguinte(mensagem, seguinte),
  };
}

/**
 * Reclassificacao com a evidencia original mais o texto novo.
 *
 * O prompt de producao vai inteiro, para a analise nova nascer sob as mesmas
 * regras da original. A instrucao SEM_RELACAO existe porque a mensagem pode
 * simplesmente nao ter nada a ver com a pergunta — e ai o certo e nao mexer no
 * recibo, nao "aproveitar" o texto.
 */
async function pedirReclassificacao(
  recibo: Recibo,
  pergunta: string,
  texto: string,
): Promise<Record<string, any> | null> {
  const chave = env("GEMINI_API_KEY");
  if (!chave) {
    console.error("GEMINI_API_KEY nao configurada; reclassificacao indisponivel");
    return null;
  }

  const contexto = montarContextoReclassificacao(
    { ...recibo, motivos_revisao: motivosRevisao(recibo) },
    pergunta,
    texto,
  );

  try {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${chave}`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${TAXMIND_SYSTEM_PROMPT.trim()}\n\n${contexto}` }] }],
          generationConfig: {
            temperature: 0.2,
            // Folga no teto: o thinking do Gemini 3 Flash nao pode ser
            // desligado e consome o orcamento antes da resposta.
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      },
    );

    if (!resposta.ok) {
      console.error("gemini respondeu erro na reclassificacao", resposta.status);
      return null;
    }

    const corpo = await resposta.json();
    const bruto: string = corpo?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (/SEM_RELACAO/.test(bruto)) return null;

    const bloco = bruto.match(/<expense>([\s\S]*?)<\/expense>/);
    if (!bloco) {
      console.error("reclassificacao sem bloco <expense>");
      return null;
    }

    return JSON.parse(bloco[1].trim());
  } catch (error) {
    console.error("falha na reclassificacao", error);
    return null;
  }
}

// --- Fase 16: encadeamento reativo ----------------------------------------

/**
 * A pergunta seguinte, se o recibo recem-patchado ainda tiver campo respondivel.
 *
 * Devolve o TEXTO da pergunta (ja com a pendencia criada no banco) ou null.
 * Quem chama anexa esse texto a propria confirmacao: uma mensagem so, com a
 * pergunta no fim, exatamente como o workflow de recibo monta a dele.
 *
 * FAIL OPEN, e isso nao e detalhe. A resposta ao usuario ja esta pronta quando
 * esta funcao roda, e o recibo ja foi patchado: uma falha aqui nao pode derrubar
 * nem uma coisa nem outra. O pior caso e a segunda pergunta nao ser feita, que e
 * exatamente o comportamento de antes desta fase.
 */
async function proximaPergunta(
  pendencia: PendenciaComDono,
  recibo: Recibo,
  patch: Record<string, unknown>,
  analiseNova: Record<string, unknown> | null = null,
): Promise<string | null> {
  try {
    // Recibo que saiu da revisao nao tem o que desbloquear. Cobre a promocao dos
    // tres modos e tambem o reembolso integral, que fecha em NAO_DEDUTIVEL: em
    // nenhum dos dois casos existe pergunta que mude o desfecho, e faze-la seria
    // atrito puro sobre uma despesa ja resolvida.
    const requerRevisao = "requer_revisao_humana" in patch
      ? patch.requer_revisao_humana === true
      : recibo.requer_revisao_humana === true;
    if (!requerRevisao) return null;

    const estado = estadoAposPatch(recibo, patch, analiseNova);
    const jaPerguntados = await camposJaPerguntados(recibo.id);

    // A precedencia e a mesma de derivarCampoFollowup (reembolso primeiro, por
    // assimetria de risco contra a DMED), mas aqui ela precisa ser uma LISTA e
    // nao um campo so: se o reembolso ja foi perguntado, a vaga passa para a
    // identificacao em vez de ficar vazia. E o caso da sequencia 1 inteira.
    const candidatos: CampoFollowup[] = [];
    if (deveperguntarReembolso(estado)) candidatos.push(CAMPO_REEMBOLSO);

    // Identificacao ja satisfeita nao vira pergunta. A regra fiscal de SAUDE
    // pede prestador OU estabelecimento, entao um CNPJ conferido fecha o
    // requisito inteiro — e derivarCamposBloqueantes, que olha campo a campo,
    // devolveria "estabelecimento" para um recibo que acabou de receber o
    // documento. Num lancamento novo isso nunca aparecia (a pendencia nascia
    // uma vez so); com encadeamento, apareceria em todo CAMPO_PREENCHIDO.
    if (!temIdentificacao(estado)) candidatos.push(...derivarCamposBloqueantes(estado));

    const proximo = candidatos.find((campo) => !jaPerguntados.has(campo));
    if (!proximo) return null;

    const pergunta = perguntaParaCampo(proximo, {
      estabelecimento: valorAposPatch(recibo, patch, "estabelecimento") as string | null,
    });

    const { error } = await supabase.rpc("registrar_followup_pendente", {
      p_usuario_id: recibo.usuario_id,
      p_recibo_id: recibo.id,
      p_sessao_whatsapp_id: pendencia.sessao_whatsapp_id,
      p_campo_alvo: proximo,
      p_pergunta: pergunta,
    });

    if (error) {
      console.error("failed to chain followup", error);
      return null;
    }
    return pergunta;
  } catch (error) {
    console.error("failed to chain followup", error);
    return null;
  }
}

/**
 * O recibo como ele ficou, na forma que as derivacoes entendem.
 *
 * Duas correcoes sobre "ler metadados_ia cru", e as duas sao o motivo de esta
 * funcao existir:
 *
 * 1. Os campos de identificacao vem das COLUNAS pos-patch, nao da analise
 *    gravada. metadados_ia guarda a extracao original e continua com o documento
 *    vazio depois de um CAMPO_PREENCHIDO — reperguntar o que acabou de ser
 *    respondido seria o resultado direto de ler dali.
 *
 * 2. Depois de o reembolso ser respondido, quem governa "identificar o prestador
 *    desbloqueia?" passa a ser deducibilidade_se_sem_reembolso. O prompt manda
 *    declarar deducibilidade_se_desbloqueado NULL justamente quando ha indicio de
 *    reembolso (medido no Gemini real: 3/3 em "Paguei 500 na consulta e com
 *    convenio"), e derivarCamposBloqueantes faz gate nesse campo. Sem esta
 *    promocao do destino residual, a reavaliacao devolveria lista vazia e a
 *    sequencia 1 continuaria sem nunca pedir o CNPJ — o bug que esta fase existe
 *    para corrigir.
 *
 * A analise original NAO e reescrita: isto e uma visao derivada, montada na hora
 * e jogada fora em seguida.
 */
function estadoAposPatch(
  recibo: Recibo,
  patch: Record<string, unknown>,
  analiseNova: Record<string, unknown> | null,
): Record<string, unknown> {
  // Na reclassificacao o juizo mais recente e o da analise nova; nos outros dois
  // modos nao houve analise nova, e o que vale continua sendo a original.
  const declaracoes = analiseNova ?? recibo.metadados_ia ?? {};

  return {
    ...declaracoes,
    documento_prestador: valorAposPatch(recibo, patch, "documento_prestador"),
    estabelecimento: valorAposPatch(recibo, patch, "estabelecimento"),
    possui_indicio_reembolso: reembolsoRespondido(recibo, patch)
      ? false
      : declaracoes.possui_indicio_reembolso,
    deducibilidade_se_desbloqueado: destinoSeDesbloqueado(declaracoes) ??
      (reembolsoRespondido(recibo, patch) ? destinoSeSemReembolso(declaracoes) : null),
  };
}

/** NULL = nunca perguntado; qualquer numero (inclusive 0) = respondido. E a
 *  distincao que a migration 010 preserva de proposito, e ela e o sinal
 *  principal contra repetir a pergunta de reembolso. */
function reembolsoRespondido(recibo: Recibo, patch: Record<string, unknown>): boolean {
  const valor = valorAposPatch(recibo, patch, "valor_reembolsado");
  return valor !== null && valor !== undefined;
}

function valorAposPatch(recibo: Recibo, patch: Record<string, unknown>, coluna: string): unknown {
  return coluna in patch ? patch[coluna] : (recibo as unknown as Record<string, unknown>)[coluna];
}

/**
 * Campos que ja foram perguntados neste recibo, com qualquer desfecho.
 *
 * Perguntado e perguntado: uma pendencia respondida, descartada ou fechada sem o
 * dado nao volta a fila. Sem isto, uma reclassificacao que nao preencheu o
 * documento reabriria a MESMA pergunta que acabou de fechar, e a resposta
 * seguinte reabriria de novo — laco limitado so pelo TTL e pelo orcamento de
 * mensagens. E o que torna verdadeira a invariante de que a cadeia tem no maximo
 * dois passos: sao dois campos possiveis, e cada um sai da fila ao ser feito.
 */
async function camposJaPerguntados(reciboId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("followups_pendentes")
    .select("campo_alvo")
    .eq("recibo_id", reciboId);

  if (error) {
    // Fail closed SO nesta consulta, e de proposito: sem saber o que ja foi
    // perguntado, o risco e repetir a pergunta em laco. Nao perguntar e o
    // comportamento de antes desta fase; repetir seria pior do que ela.
    console.error("failed to load followup history", error);
    throw new Error("followup_history_unavailable");
  }

  return new Set((data ?? []).map((linha) => String(linha.campo_alvo)));
}

// --- acesso a dados -------------------------------------------------------

// sessao_whatsapp_id e carregado so para ser repassado a pendencia encadeada.
// A coluna e write-only no projeto inteiro (ninguem le), mas herdar o valor
// mantem a trilha coerente de graca — a alternativa seria gravar null numa
// pendencia que nasceu da mesma conversa.
type PendenciaComDono = PendenciaFollowup & {
  usuario_id: string;
  pergunta: string;
  sessao_whatsapp_id: string | null;
};

async function buscarPendencia(followupId: string): Promise<PendenciaComDono | null> {
  const { data, error } = await supabase
    .from("followups_pendentes")
    .select(
      "id, usuario_id, recibo_id, sessao_whatsapp_id, campo_alvo, pergunta, expira_em, " +
        "mensagens_restantes",
    )
    .eq("id", followupId)
    .is("respondida_em", null)
    .is("descartada_em", null)
    .maybeSingle();

  if (error) {
    console.error("failed to load followup", error);
    return null;
  }
  return (data as PendenciaComDono | null) ?? null;
}

/**
 * Exclusao mutua entre execucoes concorrentes.
 *
 * O padrao e o mesmo do lote do Open Finance: `update ... where respondida_em
 * is null returning`. O Postgres serializa os UPDATEs na mesma linha e
 * reavalia o predicado no READ COMMITTED, entao a segunda transacao atualiza
 * zero linhas — e e isso que impede o recibo de ser promovido duas vezes.
 */
async function reivindicar(followupId: string, resolucao: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("followups_pendentes")
    .update({ respondida_em: new Date().toISOString(), resolucao })
    .eq("id", followupId)
    .is("respondida_em", null)
    .is("descartada_em", null)
    .select("id");

  if (error) {
    console.error("failed to claim followup", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function descartar(followupId: string, motivo: string) {
  const { error } = await supabase
    .from("followups_pendentes")
    .update({ descartada_em: new Date().toISOString(), descartada_motivo: motivo })
    .eq("id", followupId)
    .is("respondida_em", null)
    .is("descartada_em", null);

  if (error) console.error("failed to discard followup", error);
}

async function buscarRecibo(reciboId: string): Promise<Recibo | null> {
  const { data, error } = await supabase
    .from("recibos_evidencias")
    .select(
      "id, usuario_id, descricao, valor, valor_reembolsado, data_despesa, estabelecimento, " +
        "documento_prestador, categoria, deducibilidade, justificativa_deducibilidade, " +
        "confidence_score, status, requer_revisao_humana, metadados_ia",
    )
    .eq("id", reciboId)
    .maybeSingle();

  if (error) {
    console.error("failed to load recibo", error);
    return null;
  }
  return (data as Recibo | null) ?? null;
}

async function atualizarRecibo(reciboId: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("recibos_evidencias")
    .update(patch)
    .eq("id", reciboId);

  if (error) {
    console.error("failed to patch recibo", error);
    throw new Error("recibo_update_failed");
  }
}

// --- helpers --------------------------------------------------------------

function camposBloqueantes(recibo: Recibo): string[] {
  const lista = (recibo.metadados_ia as { campos_bloqueantes?: unknown })?.campos_bloqueantes;
  return Array.isArray(lista) ? lista.map(String) : [];
}

function motivosRevisao(recibo: Recibo): string[] {
  const lista = (recibo.metadados_ia as { motivos_revisao?: unknown })?.motivos_revisao;
  return Array.isArray(lista) ? lista.map(String) : [];
}

function historicoFollowups(recibo: Recibo): unknown[] {
  const lista = (recibo.metadados_ia as { followups?: unknown })?.followups;
  return Array.isArray(lista) ? lista : [];
}

function historicoReclassificacoes(recibo: Recibo): unknown[] {
  const lista = (recibo.metadados_ia as { reclassificacoes?: unknown })?.reclassificacoes;
  return Array.isArray(lista) ? lista : [];
}

/**
 * Para onde a deducibilidade vai quando o ultimo campo bloqueante e preenchido.
 *
 * Sai de deducibilidade_se_desbloqueado, que a propria IA declarou na analise
 * original. Sem esse campo a promocao teria que adivinhar, e adivinhar aqui
 * significa afirmar dedutibilidade fiscal que ninguem analisou — entao o
 * fallback e manter o que ja estava.
 *
 * O destino residual (Fase 16) e a mesma regra de estadoAposPatch, e ela precisa
 * valer nos DOIS lugares: quando o reembolso ja foi respondido, o prompt tinha
 * anulado deducibilidade_se_desbloqueado e quem responde "identificar o prestador
 * desbloqueia para onde?" e deducibilidade_se_sem_reembolso. Sem isto, o CNPJ
 * encadeado da sequencia 1 promoveria o recibo para APROVADO_AUTOMATICAMENTE
 * mantendo INDETERMINADO — uma despesa que nao chega ao contador e tambem nao
 * conta como dedutivel.
 *
 * Este caminho so e alcancavel via encadeamento: antes da Fase 16 nao existia
 * recibo com valor_reembolsado preenchido E pendencia de identificacao aberta,
 * porque a unica pendencia nascia no insert e era uma so.
 */
function promoverDeducibilidade(recibo: Recibo): string {
  const declarado = destinoSeDesbloqueado(recibo.metadados_ia);
  if (declarado) return declarado;

  const residual = recibo.valor_reembolsado !== null && recibo.valor_reembolsado !== undefined
    ? destinoSeSemReembolso(recibo.metadados_ia)
    : null;

  return residual ?? recibo.deducibilidade;
}

function motivoRestante(recibo: Recibo): string {
  const [primeiro] = motivosRevisao(recibo);
  return primeiro ? ` (${primeiro.toLowerCase()})` : "";
}

// Rotulo minusculo para encaixar na frase ("fica classificada como parcialmente
// dedutível"). Vive em _shared/rotulos.ts junto com o do dossie e o do export:
// os tres rendiam o mesmo enum ASCII e entregavam texto sem acento.
function humanizar(valor: string): string {
  return rotuloEnum(valor);
}

function isServiceRoleCaller(request: Request) {
  // Ver o comentario longo na generate-dossier: o runtime injeta
  // SUPABASE_SERVICE_ROLE_KEY no formato novo (sb_secret_...), e o n8n precisa
  // mandar essa mesma versao, guardada em SUPABASE_SECRET_KEY_SB_FORMAT.
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; refusing request");
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(token, serviceRoleKey);
}

function timingSafeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
