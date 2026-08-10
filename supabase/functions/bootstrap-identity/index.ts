import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
// A verificacao do token HMAC saiu daqui para _shared na Fase 10, quando a
// pluggy-connect-token e a pluggy-item-link passaram a precisar da mesma
// checagem. Mesmo codigo, um lugar so.
import { type BootstrapTokenPayload, verifyBootstrapToken } from "../_shared/bootstrap_token.ts";
// Fase 12: o texto de consentimento e a validacao da versao ficam em _shared
// para que a Edge Function nunca confie na versao que o navegador afirma, e
// para que o hash gravado seja sempre calculado aqui.
import {
  CONSENTIMENTO_ATUAL,
  hashTextoConsentimento,
  versaoConsentimentoAceita,
} from "../_shared/consentimento.ts";
// Boas-vindas pelo WhatsApp assim que o cadastro conclui. O texto fica em
// _shared porque ha uma segunda lista de capacidades no node "Sobre o TaxMind"
// do n8n, e tests/n8n_export_contador_test.ts compara a cobertura das duas.
import { mensagemBoasVindas } from "../_shared/boas_vindas.ts";

type BootstrapRequest = {
  token: string;
  email: string;
  cpf: string;
  nome?: string;
  consentimento_aceito?: boolean;
  consentimento_versao?: string;
};

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

serve(async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const body = await request.json() as BootstrapRequest;
    const email = normalizeEmail(body.email);
    const cpfHash = await hashCpf(normalizeCpf(body.cpf));
    const tokenPayload = await verifyBootstrapToken(body.token);

    if (!email || !isValidCpfShape(body.cpf)) {
      return json({ error: "invalid_identity_fields" }, 400);
    }

    // O consentimento e o unico ponto de bloqueio desta fase, e ele e checado
    // no servidor porque o checkbox da tela e apenas a interface do gate: uma
    // chamada direta a esta function sem consentimento criaria conta com dado
    // sensivel de saude e sem base legal. Versao desconhecida tambem e recusa
    // — ver versaoConsentimentoAceita.
    if (body.consentimento_aceito !== true) {
      return json({ error: "consentimento_obrigatorio" }, 400);
    }

    if (!versaoConsentimentoAceita(body.consentimento_versao)) {
      return json({
        error: "consentimento_versao_invalida",
        versao_atual: CONSENTIMENTO_ATUAL.versao,
      }, 400);
    }

    const redirectTo = new URL(env("SUPABASE_AUTH_REDIRECT_TO", "http://localhost:5173/auth/callback"));
    redirectTo.searchParams.set("wa_id", tokenPayload.wa_id);

    const { data, error } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: redirectTo.toString(),
        data: {
          nome: body.nome ?? null,
          telefone_whatsapp: tokenPayload.phone,
          wa_id: tokenPayload.wa_id,
          cpf_hash: cpfHash,
          onboarding_source: "whatsapp",
        },
      },
    });

    if (error) {
      console.error("failed to generate supabase magic link", error);
      return json({ error: "magic_link_failed" }, 500);
    }

    const userId = data?.user?.id ?? null;
    const consentimentoEm = new Date().toISOString();
    // Lido ANTES do upsert: depois dele todo mundo tem onboarding_concluido
    // true, e nao haveria mais como distinguir cadastro novo de refacao. Sem
    // isso, quem repete o link recebe as boas-vindas de novo.
    const jaCadastrado = userId ? await onboardingJaConcluido(userId) : false;
    if (userId) {
      await upsertUsuario({
        userId,
        email,
        nome: body.nome,
        cpfHash,
        telefoneWhatsapp: tokenPayload.phone,
        consentimentoEm,
      });
      // Depois do upsert de proposito: a FK aponta para usuarios, e falhar aqui
      // com o cadastro ja criado e melhor do que o inverso — a linha de
      // consentimento e recuperavel, um usuario sem cadastro nao tem como
      // voltar sem novo link.
      await registrarConsentimento(userId, consentimentoEm);
    }

    await recordSessionContext(tokenPayload, email, cpfHash, userId);

    // Depois de tudo que persiste, e sem poder derrubar nada: a mensagem e
    // cortesia, o cadastro e o produto. Mesma postura de registrarConsentimento.
    if (userId && !jaCadastrado) {
      await enviarBoasVindas(tokenPayload.phone, body.nome ?? null);
    }

    return json({
      ok: true,
      email,
      expires_in_seconds: Math.max(tokenPayload.exp - Math.floor(Date.now() / 1000), 0),
      action_link: data?.properties?.action_link ?? null,
      email_otp: data?.properties?.email_otp ?? null,
      hashed_token: data?.properties?.hashed_token ?? null,
      user_id: userId,
    });
  } catch (error) {
    console.error("bootstrap-identity error", error);
    const message = error instanceof Error ? error.message : "internal_error";
    const status = message === "invalid_or_expired_token" ? 401 : 500;
    return json({ error: message }, status);
  }
});

async function recordSessionContext(
  tokenPayload: BootstrapTokenPayload,
  email: string,
  cpfHash: string,
  userId: string | null,
) {
  const { data: sessions, error: selectError } = await supabase
    .from("sessoes_whatsapp")
    .select("id, contexto")
    .eq("wa_id", tokenPayload.wa_id)
    .eq("status", "ABERTA")
    .gt("expira_em", new Date().toISOString())
    .order("ultima_interacao_em", { ascending: false })
    .limit(1);

  if (selectError || !sessions?.[0]) {
    console.error("failed to locate whatsapp session", selectError);
    return;
  }

  const session = sessions[0];
  const contexto = {
    ...(session.contexto ?? {}),
    onboarding_email: email,
    onboarding_cpf_hash: cpfHash,
    onboarding_token_nonce: tokenPayload.nonce,
    onboarding_magic_link_created_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabase
    .from("sessoes_whatsapp")
    .update({ contexto, usuario_id: userId })
    .eq("id", session.id);

  if (updateError) {
    console.error("failed to update session context", updateError);
  }
}

async function upsertUsuario(input: {
  userId: string;
  email: string;
  nome?: string;
  cpfHash: string;
  telefoneWhatsapp: string;
  consentimentoEm: string;
}) {
  const { error } = await supabase
    .from("usuarios")
    .upsert({
      id: input.userId,
      nome: input.nome ?? null,
      email: input.email,
      telefone_whatsapp: input.telefoneWhatsapp,
      cpf_hash: input.cpfHash,
      onboarding_concluido: true,
      consentimento_lgpd_em: input.consentimentoEm,
    }, { onConflict: "id" });

  if (error) {
    console.error("failed to upsert usuario", error);
    throw new Error("usuario_link_failed");
  }
}

/**
 * Evidencia do consentimento (migration 008).
 *
 * O hash e calculado aqui, a partir do texto canonico desta versao, e nao lido
 * do corpo da requisicao: hash enviado pelo cliente provaria so o que o cliente
 * quis afirmar. ignoreDuplicates preserva o aceite original quando a mesma
 * pessoa refaz o onboarding com o mesmo texto — a data que importa e a do
 * primeiro sim.
 *
 * Falha aqui nao derruba o cadastro ja criado: o erro fica no log e o
 * ponteiro usuarios.consentimento_lgpd_em ja registra que houve aceite.
 */
async function registrarConsentimento(userId: string, aceitoEm: string) {
  const { error } = await supabase
    .from("consentimentos_lgpd")
    .upsert({
      usuario_id: userId,
      versao: CONSENTIMENTO_ATUAL.versao,
      texto_hash: await hashTextoConsentimento(),
      canal: "ONBOARDING_WEB",
      aceito_em: aceitoEm,
    }, { onConflict: "usuario_id,versao", ignoreDuplicates: true });

  if (error) {
    console.error("failed to record consentimento lgpd", error);
  }
}

/**
 * O cadastro deste usuario ja estava concluido antes desta chamada?
 *
 * Serve so para nao repetir as boas-vindas quando a mesma pessoa refaz o
 * onboarding com um link novo. Erro de consulta responde `true` de proposito:
 * na duvida, calar. Mandar de novo a mensagem inteira para quem ja usa o
 * produto e mais estranho do que nao manda-la.
 */
async function onboardingJaConcluido(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("usuarios")
    .select("onboarding_concluido")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("failed to check onboarding state", error);
    return true;
  }

  return data?.onboarding_concluido === true;
}

/**
 * Boas-vindas pelo WhatsApp.
 *
 * Nunca lanca: o cadastro ja esta gravado quando esta funcao roda, e uma falha
 * do Graph API nao pode virar erro de cadastro para quem acabou de se cadastrar
 * com sucesso. Credencial ausente tambem so registra aviso — e o mesmo
 * comportamento do sendWhatsAppText da whatsapp-webhook.
 */
async function enviarBoasVindas(to: string, nome: string | null) {
  const accessToken = env("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");

  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp credentials missing; skipping welcome message");
    return;
  }

  try {
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
          text: { preview_url: false, body: mensagemBoasVindas(nome) },
        }),
      },
    );

    if (!response.ok) {
      console.error("failed to send welcome message", await response.text());
    }
  } catch (error) {
    console.error("welcome message request failed", error);
  }
}

function normalizeEmail(email: string) {
  return email?.trim().toLowerCase() ?? "";
}

function normalizeCpf(cpf: string) {
  return cpf.replace(/\D/g, "");
}

function isValidCpfShape(cpf: string) {
  return normalizeCpf(cpf).length === 11;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashCpf(normalizedCpf: string) {
  const pepper = env("CPF_HASH_PEPPER") || env("TAXMIND_BOOTSTRAP_SECRET");
  if (!pepper) {
    throw new Error("missing_cpf_hash_pepper");
  }
  return await sha256(`${pepper}:${normalizedCpf}`);
}

function corsHeaders() {
  const onboardingOrigin = new URL(env("ONBOARDING_BASE_URL", "http://localhost:5173")).origin;
  return {
    ...jsonHeaders,
    "access-control-allow-origin": onboardingOrigin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}
