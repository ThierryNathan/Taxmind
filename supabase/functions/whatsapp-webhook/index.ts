import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
// A assinatura do token HMAC saiu daqui para _shared na Fase 10, quando a
// pluggy-connect-link passou a emitir o mesmo tipo de link (agora com
// modo=conectar-banco). Mesmo codigo, um lugar so.
import {
  type BootstrapTokenPayload,
  hmacSha256Hex,
  signBootstrapToken,
  timingSafeEqual,
} from "../_shared/bootstrap_token.ts";
// Fase 7: a logica deterministica da re-verificacao (geracao, hash, janela de
// 30 dias, expiracao, avaliacao do palpite) vive em _shared para ser testavel
// sem subir esta function. Ver tests/verificacao_test.ts.
import {
  avaliarCodigo,
  calcularExpiracaoCodigo,
  type CodigoArmazenado,
  CODIGO_DIGITOS,
  CODIGO_TTL_MINUTOS,
  codigoExpirado,
  extrairCodigo,
  gerarCodigoVerificacao,
  hashCodigoVerificacao,
  JANELA_CONFIANCA_DIAS,
  mascararEmail,
  MAX_TENTATIVAS,
  precisaReverificar,
} from "../_shared/verificacao.ts";
// Fase 13: o ciclo de vida da pendencia de follow-up (expiracao por tempo,
// orcamento de mensagens, deteccao de resposta) mora em _shared por
// testabilidade. Esta function e o unico componente que ve TODA mensagem que
// entra — texto e midia vao para workflows diferentes —, entao e aqui que o
// orcamento e contado.
import {
  decidirFollowup,
  type PendenciaFollowup,
} from "../_shared/followup.ts";

type WhatsAppMedia = {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
};

type WhatsAppInboundMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: "text" | "image" | "document" | string;
  text?: { body?: string };
  image?: WhatsAppMedia;
  document?: WhatsAppMedia;
};

type WhatsAppChangeValue = {
  messaging_product?: string;
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WhatsAppInboundMessage[];
};

type InboundEvent = {
  value: WhatsAppChangeValue;
  message: WhatsAppInboundMessage;
  waId: string;
  profileName?: string;
  normalized: {
    message_id: string;
    wa_id: string;
    phone: string;
    profile_name: string | null;
    message_type: string;
    text_body: string | null;
    media_id: string | null;
    media_mime_type: string | null;
    media_sha256: string | null;
    media_filename: string | null;
    media_caption: string | null;
    received_at: string;
  };
};

// "error" existe separado de "not_found" de proposito: so "not_found" dispara
// o onboarding. Falha de consulta cai no fluxo normal (n8n), porque mandar
// link de onboarding para quem ja tem cadastro confunde o usuario e permite
// reescrever o cadastro existente.
type UsuarioLookup =
  | { status: "found"; usuarioId: string; email: string | null; criadoEm: string | null }
  | { status: "not_found" }
  | { status: "error" };

// Resultado do portao de re-verificacao (Fase 7). "liberado" segue para o
// roteamento existente; "bloqueado" para nesta mensagem, porque ela virou uma
// etapa da conversa de verificacao.
type PortaoVerificacao = "liberado" | "bloqueado";

const TIPOS_EVENTO_ACESSO = {
  codigoGerado: "CODIGO_VERIFICACAO_GERADO",
  envioFalhou: "CODIGO_VERIFICACAO_ENVIO_FALHOU",
  sucesso: "VERIFICACAO_SUCESSO",
  falha: "VERIFICACAO_FALHA",
  indisponivel: "VERIFICACAO_INDISPONIVEL",
} as const;

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

serve(async (request) => {
  try {
    if (request.method === "GET") {
      return handleWebhookVerification(request);
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const rawBody = await request.text();
    const signatureOk = await verifyMetaSignature(request, rawBody);
    if (!signatureOk) {
      return json({ error: "invalid_signature" }, 401);
    }

    const payload = JSON.parse(rawBody);
    const events = extractInboundMessages(payload);

    for (const event of events) {
      // O roteamento depende de existir cadastro para o telefone, nao de
      // detectar saudacao: o primeiro contato pode ser uma foto de recibo.
      const usuario = await findUsuarioByWhatsAppPhone(event.normalized.phone);
      const sessionId = await upsertWhatsAppSession(event, usuario);

      if (usuario.status === "not_found") {
        const onboardingUrl = await createOnboardingUrl(event);
        await sendWhatsAppText(
          event.message.from,
          [
            `Oi, ${event.profileName ?? "tudo bem"}! Sou o TaxMind.`,
            "Para proteger seus dados fiscais, preciso confirmar seu e-mail e CPF em um ambiente seguro antes de guardar qualquer recibo.",
            `Comece por aqui: ${onboardingUrl}`,
            "Assim que terminar, e so voltar aqui e me mandar seus recibos.",
          ].join("\n\n"),
        );
        continue;
      }

      // Fase 7: camada adicional ANTES do roteamento, nao substituicao dele.
      // Se a janela de confianca de 30 dias venceu, esta mensagem vira etapa
      // da re-verificacao e nao segue para o n8n. Falha de infraestrutura aqui
      // libera a mensagem (mesma logica do status "error" do lookup): perder
      // recibo por indisponibilidade nossa e pior do que uma janela de
      // confianca esticada.
      if (usuario.status === "found") {
        const portao = await aplicarPortaoDeVerificacao(event, usuario, sessionId);
        if (portao === "bloqueado") {
          continue;
        }
      }

      // Anotacao, nunca portao: o follow-up e opcional e jamais interrompe o
      // fluxo. O maximo que acontece aqui e a mensagem seguir com um campo a
      // mais, que o n8n usa ou ignora.
      const followup = await anotarFollowupPendente(event, usuario);

      await forwardToN8n(
        {
          source: "whatsapp-cloud-api",
          event_type: "inbound_message",
          session_id: sessionId,
          normalized: event.normalized,
          followup,
          raw_value: event.value,
        },
        resolveN8nWebhookUrl(event.normalized.message_type),
      );
    }

    return json({ ok: true, processed: events.length });
  } catch (error) {
    console.error("whatsapp-webhook error", error);
    return json({ error: "internal_error" }, 500);
  }
});

function handleWebhookVerification(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env("WHATSAPP_VERIFY_TOKEN") && challenge) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

function extractInboundMessages(payload: any) {
  const entries = payload?.entry ?? [];
  const events: InboundEvent[] = [];

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value as WhatsAppChangeValue;
      for (const message of value?.messages ?? []) {
        if (!["text", "image", "document"].includes(message.type)) continue;

        const contact = value.contacts?.find((item) => item.wa_id === message.from);
        const waId = contact?.wa_id ?? message.from;
        const profileName = contact?.profile?.name;
        const media = getMedia(message);

        events.push({
          value,
          message,
          waId,
          profileName,
          normalized: {
            message_id: message.id,
            wa_id: waId,
            phone: normalizeBrazilianPhone(message.from),
            profile_name: profileName ?? null,
            message_type: message.type,
            text_body: message.text?.body ?? null,
            media_id: media?.id ?? null,
            media_mime_type: media?.mime_type ?? null,
            media_sha256: media?.sha256 ?? null,
            media_filename: media?.filename ?? null,
            media_caption: media?.caption ?? null,
            received_at: message.timestamp
              ? new Date(Number(message.timestamp) * 1000).toISOString()
              : new Date().toISOString(),
          },
        });
      }
    }
  }

  return events;
}

// usuarios.telefone_whatsapp e a fonte da verdade do cadastro: so a
// bootstrap-identity escreve nela, e exatamente quando o onboarding conclui.
// Nao usamos sessoes_whatsapp.usuario_id para essa deteccao porque sessao
// expira em 24h e a sessao nova nasce sem vinculo, o que faria um usuario
// cadastrado ser tratado como novo a cada dia.
// email e criado_em entraram no select na Fase 7: o primeiro e o destino do
// codigo de re-verificacao, o segundo e o fallback da janela de confianca para
// quem concluiu o onboarding depois desta fase e ainda nao tem nenhuma sessao
// com verificado_em gravado.
async function findUsuarioByWhatsAppPhone(phone: string): Promise<UsuarioLookup> {
  const { data, error } = await supabase
    .from("usuarios")
    .select("id, email, criado_em")
    .eq("telefone_whatsapp", phone)
    .maybeSingle();

  if (error) {
    console.error("failed to lookup usuario by phone", error);
    return { status: "error" };
  }

  return data?.id
    ? {
      status: "found",
      usuarioId: data.id,
      email: data.email ?? null,
      criadoEm: data.criado_em ?? null,
    }
    : { status: "not_found" };
}

async function upsertWhatsAppSession(
  event: InboundEvent,
  usuario: UsuarioLookup,
): Promise<string | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const phone = normalizeBrazilianPhone(event.message.from);
  const usuarioId = usuario.status === "found" ? usuario.usuarioId : null;
  const incomingContext = {
    profile_name: event.profileName ?? null,
    last_message_id: event.message.id,
    last_message_type: event.message.type,
    last_inbound_text: event.message.text?.body ?? null,
    last_media_id: event.normalized.media_id,
    onboarding_pendente: usuario.status === "not_found",
  };

  const { data: sessions, error: selectError } = await supabase
    .from("sessoes_whatsapp")
    .select("id, contexto")
    .eq("wa_id", event.waId)
    .eq("status", "ABERTA")
    .gt("expira_em", now.toISOString())
    .order("ultima_interacao_em", { ascending: false })
    .limit(1);

  if (selectError) {
    console.error("failed to lookup whatsapp session", selectError);
  }

  const existingSession = sessions?.[0];
  if (existingSession) {
    const updatePayload: Record<string, unknown> = {
      telefone_whatsapp: phone,
      ultima_mensagem_id: event.message.id,
      ultima_interacao_em: now.toISOString(),
      expira_em: expiresAt.toISOString(),
      contexto: {
        ...(existingSession.contexto ?? {}),
        ...incomingContext,
      },
    };

    // O n8n le sessoes_whatsapp.usuario_id para gravar o recibo, entao o
    // vinculo precisa existir na sessao. So gravamos quando temos um id de
    // fato: escrever null aqui apagaria o vinculo feito pela bootstrap-identity.
    if (usuarioId) {
      updatePayload.usuario_id = usuarioId;
    }

    const { error: updateError } = await supabase
      .from("sessoes_whatsapp")
      .update(updatePayload)
      .eq("id", existingSession.id);

    if (updateError) {
      console.error("failed to update whatsapp session", updateError);
      return null;
    }
    return existingSession.id;
  }

  const { data: inserted, error } = await supabase
    .from("sessoes_whatsapp")
    .insert({
      usuario_id: usuarioId,
      telefone_whatsapp: phone,
      wa_id: event.waId,
      ultima_mensagem_id: event.message.id,
      status: "ABERTA",
      aberta_em: now.toISOString(),
      ultima_interacao_em: now.toISOString(),
      expira_em: expiresAt.toISOString(),
      contexto: incomingContext,
    })
    .select("id")
    .single();

  if (error) {
    console.error("failed to insert whatsapp session", error);
    return null;
  }

  return inserted?.id ?? null;
}

async function createOnboardingUrl(event: InboundEvent) {
  const sessionId = crypto.randomUUID();
  const payload: BootstrapTokenPayload = {
    wa_id: event.waId,
    phone: normalizeBrazilianPhone(event.message.from),
    session_id: sessionId,
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
    nonce: crypto.randomUUID(),
  };

  const token = await signBootstrapToken(payload);
  const onboardingUrl = new URL(env("ONBOARDING_BASE_URL", "http://localhost:5173/onboarding"));
  onboardingUrl.searchParams.set("token", token);
  onboardingUrl.searchParams.set("wa_id", event.waId);
  return onboardingUrl.toString();
}

// --- Fase 7: re-verificacao por e-mail -----------------------------------
//
// Portao aplicado a mensagem de usuario JA cadastrado. Devolve "liberado" para
// seguir ao roteamento existente e "bloqueado" quando a mensagem foi consumida
// pela conversa de verificacao.
//
// Fail open e proposital em toda falha de infraestrutura (consulta que erra,
// insert que erra, usuario sem e-mail cadastrado): o pior caso de liberar e
// uma janela de confianca esticada; o pior caso de bloquear e o usuario perder
// o recibo e ficar sem caminho de saida no WhatsApp.
type UsuarioVerificavel = Extract<UsuarioLookup, { status: "found" }>;

async function aplicarPortaoDeVerificacao(
  event: InboundEvent,
  usuario: UsuarioVerificavel,
  sessionId: string | null,
): Promise<PortaoVerificacao> {
  const ultima = await resolverUltimaVerificacao(usuario);
  if (ultima.status === "error") {
    return "liberado";
  }

  // Caminho da esmagadora maioria das mensagens: dentro da janela, nada muda.
  if (!precisaReverificar(ultima.verificadoEm)) {
    return "liberado";
  }

  const pendente = await buscarCodigoPendente(usuario.usuarioId);
  if (pendente.status === "error") {
    return "liberado";
  }

  if (pendente.codigo) {
    const desfecho = await tratarCodigoPendente(event, usuario, pendente.codigo, sessionId);
    if (desfecho !== "gerar_novo") {
      return desfecho;
    }
  }

  return await iniciarReverificacao(event, usuario, sessionId);
}

/**
 * Ultima verificacao do USUARIO, nao da sessao atual.
 *
 * Ler verificado_em da sessao corrente daria falso negativo todo dia: sessao
 * expira em 24h e a sessao nova nasce sem contexto (ver comentario de
 * findUsuarioByWhatsAppPhone), entao a coluna viria null e a janela de 30 dias
 * viraria uma janela de 24 horas. Por isso o maior verificado_em entre as
 * sessoes do usuario, com fallback em usuarios.criado_em — que cobre quem
 * concluiu o onboarding sem nenhuma sessao carimbada, sem exigir mudanca na
 * bootstrap-identity.
 */
async function resolverUltimaVerificacao(
  usuario: UsuarioVerificavel,
): Promise<{ status: "ok"; verificadoEm: string | null } | { status: "error" }> {
  const { data, error } = await supabase
    .from("sessoes_whatsapp")
    .select("verificado_em")
    .eq("usuario_id", usuario.usuarioId)
    .not("verificado_em", "is", null)
    .order("verificado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.error("failed to resolve ultima verificacao", error);
    return { status: "error" };
  }

  return { status: "ok", verificadoEm: data?.[0]?.verificado_em ?? usuario.criadoEm };
}

type CodigoPendente = CodigoArmazenado & { id: string };

async function buscarCodigoPendente(
  usuarioId: string,
): Promise<{ status: "ok"; codigo: CodigoPendente | null } | { status: "error" }> {
  const { data, error } = await supabase
    .from("codigos_verificacao")
    .select("id, codigo_hash, expira_em, tentativas, max_tentativas, consumido_em, invalidado_em")
    .eq("usuario_id", usuarioId)
    .is("consumido_em", null)
    .is("invalidado_em", null)
    .order("criado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.error("failed to lookup codigo de verificacao", error);
    return { status: "error" };
  }

  return { status: "ok", codigo: (data?.[0] as CodigoPendente | undefined) ?? null };
}

// "gerar_novo" devolve o controle para aplicarPortaoDeVerificacao, que emite um
// codigo novo. Codigo esgotado NAO gera novo aqui de proposito: quem erra tres
// vezes precisa mandar outra mensagem para pedir, senao um chute em rajada
// renovaria codigo indefinidamente e encheria a caixa de entrada do dono.
async function tratarCodigoPendente(
  event: InboundEvent,
  usuario: UsuarioVerificavel,
  codigo: CodigoPendente,
  sessionId: string | null,
): Promise<PortaoVerificacao | "gerar_novo"> {
  const destino = mascararEmail(usuario.email);
  const informado = event.normalized.message_type === "text"
    ? extrairCodigo(event.normalized.text_body)
    : null;

  if (!informado) {
    if (codigoExpirado(codigo.expira_em)) {
      await invalidarCodigo(codigo.id, "EXPIRADO");
      return "gerar_novo";
    }

    // Mensagem comum durante a verificacao: relembra sem gastar outro e-mail.
    await sendWhatsAppText(event.message.from, [
      `Antes de continuar, preciso confirmar que e voce mesmo: enviei um codigo de ${CODIGO_DIGITOS} digitos para ${destino}.`,
      "Digite so o codigo aqui para eu liberar seu historico.",
    ].join("\n\n"));
    return "bloqueado";
  }

  const resultado = avaliarCodigo(codigo, await hashCodigoVerificacao(informado));

  switch (resultado.status) {
    case "valido": {
      await consumirCodigo(codigo.id);
      await marcarSessaoVerificada(sessionId);
      await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.sucesso, {
        canal: "EMAIL",
        destino_mascarado: destino,
        sessao_whatsapp_id: sessionId,
        codigo_id: codigo.id,
        tentativas: codigo.tentativas,
      });
      await sendWhatsAppText(event.message.from, [
        "Identidade confirmada, obrigado!",
        "Pode seguir normalmente: me manda o recibo ou a pergunta que voce quer resolver agora.",
      ].join("\n\n"));
      // A mensagem que trouxe o codigo nao e despesa nem consulta: nada a
      // encaminhar. A partir da proxima, o fluxo volta ao normal.
      return "bloqueado";
    }

    case "invalido": {
      await registrarTentativa(codigo.id, resultado.tentativas);
      await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.falha, {
        motivo: "CODIGO_INCORRETO",
        sessao_whatsapp_id: sessionId,
        codigo_id: codigo.id,
        tentativas: resultado.tentativas,
        tentativas_restantes: resultado.tentativasRestantes,
      });
      await sendWhatsAppText(event.message.from, [
        "Esse codigo nao confere.",
        `Confira o e-mail enviado para ${destino} e tente de novo — voce tem ${resultado.tentativasRestantes} tentativa(s) restante(s).`,
      ].join("\n\n"));
      return "bloqueado";
    }

    case "esgotado": {
      await invalidarCodigo(codigo.id, "TENTATIVAS_ESGOTADAS");
      await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.falha, {
        motivo: "TENTATIVAS_ESGOTADAS",
        sessao_whatsapp_id: sessionId,
        codigo_id: codigo.id,
      });
      await sendWhatsAppText(event.message.from, [
        "Esse codigo foi bloqueado por excesso de tentativas.",
        "Me manda qualquer mensagem que eu envio um codigo novo para o seu e-mail.",
      ].join("\n\n"));
      return "bloqueado";
    }

    case "expirado": {
      await invalidarCodigo(codigo.id, "EXPIRADO");
      await sendWhatsAppText(
        event.message.from,
        `Esse codigo expirou (ele vale ${CODIGO_TTL_MINUTOS} minutos). Estou enviando um novo agora.`,
      );
      return "gerar_novo";
    }

    default:
      // "indisponivel": o registro foi consumido ou invalidado por outra
      // execucao entre a leitura e a avaliacao. Emite um codigo novo.
      return "gerar_novo";
  }
}

async function iniciarReverificacao(
  event: InboundEvent,
  usuario: UsuarioVerificavel,
  sessionId: string | null,
): Promise<PortaoVerificacao> {
  if (!usuario.email) {
    // Cadastro sem e-mail nao tem como ser re-verificado por este canal.
    // Bloquear deixaria a conta inutilizavel sem saida pelo WhatsApp, entao
    // libera e registra — o evento e o gancho para o motor de risco futuro.
    console.warn("usuario sem e-mail cadastrado; re-verificacao indisponivel", {
      usuario_id: usuario.usuarioId,
    });
    await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.indisponivel, {
      motivo: "SEM_EMAIL_CADASTRADO",
      sessao_whatsapp_id: sessionId,
    });
    return "liberado";
  }

  const codigo = gerarCodigoVerificacao();
  const expiraEm = calcularExpiracaoCodigo();
  const destino = mascararEmail(usuario.email);

  const { data: inserido, error } = await supabase
    .from("codigos_verificacao")
    .insert({
      usuario_id: usuario.usuarioId,
      sessao_whatsapp_id: sessionId,
      canal: "EMAIL",
      codigo_hash: await hashCodigoVerificacao(codigo),
      destino_mascarado: destino,
      tentativas: 0,
      max_tentativas: MAX_TENTATIVAS,
      expira_em: expiraEm.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // 23505 e a unique parcial de "um codigo ativo por usuario": duas
    // mensagens chegaram juntas e a outra execucao ja emitiu o codigo. Nao
    // manda segundo e-mail, so relembra.
    if (error.code === "23505") {
      await sendWhatsAppText(event.message.from, [
        `Ja enviei um codigo de ${CODIGO_DIGITOS} digitos para ${destino}.`,
        "Digite so o codigo aqui para continuar.",
      ].join("\n\n"));
      return "bloqueado";
    }

    console.error("failed to persist codigo de verificacao", error);
    return "liberado";
  }

  const enviado = await enviarCodigoPorEmail(usuario.email, codigo);
  if (!enviado) {
    // Sem e-mail entregue o usuario nao tem como adivinhar o codigo: invalida
    // para que a proxima mensagem gere outro em vez de cair na unique.
    await invalidarCodigo(inserido.id, "ENVIO_FALHOU");
    await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.envioFalhou, {
      canal: "EMAIL",
      destino_mascarado: destino,
      sessao_whatsapp_id: sessionId,
      codigo_id: inserido.id,
    });
    await sendWhatsAppText(event.message.from, [
      "Preciso confirmar sua identidade por e-mail, mas nao consegui enviar o codigo agora.",
      "Tente novamente em alguns minutos — se persistir, fale com o suporte.",
    ].join("\n\n"));
    return "bloqueado";
  }

  await registrarEventoAcesso(usuario.usuarioId, TIPOS_EVENTO_ACESSO.codigoGerado, {
    canal: "EMAIL",
    destino_mascarado: destino,
    sessao_whatsapp_id: sessionId,
    codigo_id: inserido.id,
    expira_em: expiraEm.toISOString(),
    motivo: "JANELA_CONFIANCA_EXPIRADA",
    janela_dias: JANELA_CONFIANCA_DIAS,
  });

  await sendWhatsAppText(event.message.from, [
    `Faz mais de ${JANELA_CONFIANCA_DIAS} dias desde a ultima vez que confirmamos sua identidade, e seus dados fiscais ficam protegidos por essa checagem.`,
    `Enviei um codigo de ${CODIGO_DIGITOS} digitos para ${destino}. Ele vale ${CODIGO_TTL_MINUTOS} minutos.`,
    "Digite o codigo aqui e eu sigo com o que voce me mandou.",
  ].join("\n\n"));

  return "bloqueado";
}

// --- Fase 13: follow-up conversacional -----------------------------------
//
// Anotacao passada ao n8n. `valor_detectado` preenchido significa "esta
// mensagem E a resposta" (documento com digito verificador conferido); null
// significa "ha pendencia aberta, mas esta mensagem nao parece resposta" — o
// classificador de intencao la no n8n decide se e evidencia nova em texto livre
// ou assunto novo.
type AnotacaoFollowup = {
  id: string;
  recibo_id: string;
  campo_alvo: string;
  valor_detectado: string | null;
};

/**
 * Avanca o ciclo de vida da pendencia diante desta mensagem.
 *
 * Fail open em toda falha de infraestrutura, pelo mesmo motivo do portao de
 * verificacao: o pior caso de nao anotar e uma pergunta que expira sem
 * resposta; o pior caso de estourar aqui seria a mensagem nao chegar ao n8n, e
 * o usuario perder o recibo por causa de um recurso opcional.
 */
async function anotarFollowupPendente(
  event: InboundEvent,
  usuario: UsuarioLookup,
): Promise<AnotacaoFollowup | null> {
  if (usuario.status !== "found") return null;

  const { data, error } = await supabase
    .from("followups_pendentes")
    .select("id, recibo_id, campo_alvo, expira_em, mensagens_restantes")
    .eq("usuario_id", usuario.usuarioId)
    .is("respondida_em", null)
    .is("descartada_em", null)
    .order("criado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.error("failed to lookup followup pendente", error);
    return null;
  }

  const pendencia = (data?.[0] as PendenciaFollowup | undefined) ?? null;
  const decisao = decidirFollowup(pendencia, {
    tipo: event.normalized.message_type,
    texto: event.normalized.text_body,
  });

  if (decisao.acao === "ignorar") return null;

  if (decisao.acao === "descartar") {
    await descartarFollowup(pendencia!.id, decisao.motivo);
    return null;
  }

  if (decisao.mensagensRestantes !== pendencia!.mensagens_restantes) {
    await consumirOrcamentoFollowup(pendencia!.id, decisao.mensagensRestantes);
  }

  return {
    id: pendencia!.id,
    recibo_id: pendencia!.recibo_id,
    campo_alvo: pendencia!.campo_alvo,
    valor_detectado: decisao.valorDetectado,
  };
}

async function descartarFollowup(followupId: string, motivo: string) {
  const { error } = await supabase
    .from("followups_pendentes")
    .update({ descartada_em: new Date().toISOString(), descartada_motivo: motivo })
    .eq("id", followupId)
    .is("respondida_em", null)
    .is("descartada_em", null);

  if (error) console.error("failed to discard followup", error);
}

async function consumirOrcamentoFollowup(followupId: string, restantes: number) {
  const { error } = await supabase
    .from("followups_pendentes")
    .update({ mensagens_restantes: restantes })
    .eq("id", followupId)
    .is("respondida_em", null)
    .is("descartada_em", null);

  if (error) console.error("failed to consume followup budget", error);
}

async function marcarSessaoVerificada(sessionId: string | null) {
  if (!sessionId) {
    // Sessao nao gravada e falha de banco anterior. A verificacao ja foi
    // consumida e registrada em eventos_acesso; o custo e a proxima mensagem
    // pedir verificacao de novo.
    console.error("verificacao aprovada sem sessao para carimbar verificado_em");
    return;
  }

  const { error } = await supabase
    .from("sessoes_whatsapp")
    .update({ verificado_em: new Date().toISOString() })
    .eq("id", sessionId);

  if (error) {
    console.error("failed to stamp verificado_em", error);
  }
}

async function consumirCodigo(codigoId: string) {
  const { error } = await supabase
    .from("codigos_verificacao")
    .update({ consumido_em: new Date().toISOString() })
    .eq("id", codigoId);

  if (error) {
    console.error("failed to consume codigo de verificacao", error);
  }
}

async function invalidarCodigo(codigoId: string, motivo: string) {
  const { error } = await supabase
    .from("codigos_verificacao")
    .update({ invalidado_em: new Date().toISOString(), invalidado_motivo: motivo })
    .eq("id", codigoId);

  if (error) {
    console.error("failed to invalidate codigo de verificacao", error);
  }
}

async function registrarTentativa(codigoId: string, tentativas: number) {
  const { error } = await supabase
    .from("codigos_verificacao")
    .update({ tentativas })
    .eq("id", codigoId);

  if (error) {
    console.error("failed to record tentativa de verificacao", error);
  }
}

// Trilha LGPD e insumo do motor de risco futuro. Nunca recebe codigo em claro
// nem conteudo de mensagem: so identificadores, motivo e contadores. Falha de
// gravacao aqui nao interrompe o fluxo — o log e observacional.
async function registrarEventoAcesso(
  usuarioId: string,
  tipoEvento: string,
  detalhes: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("eventos_acesso")
    .insert({ usuario_id: usuarioId, tipo_evento: tipoEvento, detalhes });

  if (error) {
    console.error("failed to record evento de acesso", error);
  }
}

/**
 * Envia o codigo pela API do Resend.
 *
 * Chamada direta, e nao supabase.auth.admin: o generateLink da
 * bootstrap-identity nao despacha e-mail (ele devolve action_link/email_otp
 * para quem chama enviar), e o email_otp do Auth so se valida via verifyOtp,
 * que cria sessao autenticada — semantica de login, nao de "confirme que ainda
 * e voce neste WhatsApp". O codigo validado aqui e o nosso, guardado em
 * codigos_verificacao. A configuracao de SMTP no dashboard continua servindo
 * aos e-mails do proprio Auth (magic link do onboarding).
 *
 * O codigo nunca vai para log, nem em caso de erro.
 */
async function enviarCodigoPorEmail(email: string, codigo: string): Promise<boolean> {
  const apiKey = env("RESEND_API_KEY");
  const remetente = env("RESEND_FROM_EMAIL");

  if (!apiKey || !remetente) {
    console.error("RESEND_API_KEY ou RESEND_FROM_EMAIL nao configurados; codigo nao enviado");
    return false;
  }

  const linhas = [
    "Recebemos uma mensagem sua no WhatsApp do TaxMind.",
    `Seu codigo de verificacao e: ${codigo}`,
    `O codigo vale ${CODIGO_TTL_MINUTOS} minutos e serve apenas para confirmar sua identidade no WhatsApp.`,
    "Se nao foi voce, ignore este e-mail e nao compartilhe o codigo com ninguem.",
  ];

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: remetente,
        to: [email],
        subject: "TaxMind - codigo de verificacao",
        text: linhas.join("\n\n"),
        html: `<p>${linhas.join("</p><p>")}</p>`,
      }),
    });

    if (!response.ok) {
      console.error("failed to send verification email", {
        status: response.status,
        body: await response.text(),
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("verification email request failed", error);
    return false;
  }
}

async function verifyMetaSignature(request: Request, rawBody: string) {
  const appSecret = env("WHATSAPP_APP_SECRET");
  if (!appSecret) {
    console.warn("WHATSAPP_APP_SECRET not configured; rejecting webhook");
    return false;
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${await hmacSha256Hex(appSecret, rawBody)}`;
  return timingSafeEqual(signature, expected);
}

async function sendWhatsAppText(to: string, body: string) {
  const accessToken = env("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");

  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp credentials missing; skipping outbound message");
    return;
  }

  const response = await fetch(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: true, body },
      }),
    },
  );

  if (!response.ok) {
    console.error("failed to send whatsapp message", await response.text());
  }
}

// Midia continua indo para o workflow de OCR/classificacao em N8N_WEBHOOK_URL,
// exatamente como antes. Texto passa a ir para o workflow consulta-e-dossie,
// que decide entre registro por texto, resumo e dossie — e reencaminha o
// registro de despesa de volta para o workflow de recibo quando for o caso.
function resolveN8nWebhookUrl(messageType: string) {
  if (messageType === "image" || messageType === "document") {
    return env("N8N_WEBHOOK_URL");
  }
  return env("N8N_TEXT_WEBHOOK_URL");
}

async function forwardToN8n(payload: unknown, n8nWebhookUrl: string) {
  if (!n8nWebhookUrl) {
    console.warn("n8n webhook url not configured for this message type; skipping forward");
    return;
  }

  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("failed to forward payload to n8n", await response.text());
  }
}

function getMedia(message: WhatsAppInboundMessage) {
  if (message.type === "image") return message.image;
  if (message.type === "document") return message.document;
  return null;
}

function normalizeBrazilianPhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
