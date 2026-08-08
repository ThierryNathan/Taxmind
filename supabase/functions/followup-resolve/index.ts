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
// Toda a decisao vive aqui, e nao em Code node do n8n, por testabilidade:
// tests/followup_resolve_test.ts exercita a function real com Supabase e Gemini
// em memoria, e tests/followup_test.ts cobre a logica pura de _shared.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  type CampoFollowup,
  campoRespondivel,
  derivarCamposBloqueantes,
  destinoSeDesbloqueado,
  documentoConferido,
  extrairRespostaDeCampo,
  followupExpirado,
  formatarDocumento,
  mensagemDocumentoNaoConfere,
  mensagemPerguntaSegueAberta,
  montarContextoReclassificacao,
  type PendenciaFollowup,
  respostaDocumentoInvalido,
  respostaSemConteudo,
} from "../_shared/followup.ts";
import { TAXMIND_SYSTEM_PROMPT } from "../_shared/prompt_fiscal.ts";

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
    await descartar(pendencia.id, "CAMPO_INVALIDO");
    return { resolvido: false, motivo: "PENDENCIA_INDISPONIVEL" as const, mensagem: null };
  }

  const campo = pendencia.campo_alvo as CampoFollowup;
  const recibo = await buscarRecibo(pendencia.recibo_id);
  if (!recibo || recibo.usuario_id !== usuarioId) {
    await descartar(pendencia.id, "RECIBO_INDISPONIVEL");
    return { resolvido: false, motivo: "RECIBO_INDISPONIVEL" as const, mensagem: null };
  }

  const documento = extrairRespostaDeCampo(campo, texto);
  return documento
    ? await preencherCampo(pendencia, recibo, campo, documento)
    : await reclassificar(pendencia, recibo, campo, texto);
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
    mensagem,
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
    mensagem,
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

// --- acesso a dados -------------------------------------------------------

type PendenciaComDono = PendenciaFollowup & { usuario_id: string; pergunta: string };

async function buscarPendencia(followupId: string): Promise<PendenciaComDono | null> {
  const { data, error } = await supabase
    .from("followups_pendentes")
    .select("id, usuario_id, recibo_id, campo_alvo, pergunta, expira_em, mensagens_restantes")
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
      "id, usuario_id, descricao, valor, data_despesa, estabelecimento, documento_prestador, " +
        "categoria, deducibilidade, justificativa_deducibilidade, confidence_score, status, " +
        "requer_revisao_humana, metadados_ia",
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
 */
function promoverDeducibilidade(recibo: Recibo): string {
  return destinoSeDesbloqueado(recibo.metadados_ia) ?? recibo.deducibilidade;
}

function motivoRestante(recibo: Recibo): string {
  const [primeiro] = motivosRevisao(recibo);
  return primeiro ? ` (${primeiro.toLowerCase()})` : "";
}

function humanizar(valor: string): string {
  return valor.toLowerCase().replaceAll("_", " ");
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
