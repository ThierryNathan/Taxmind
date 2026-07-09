import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type WhatsAppTextMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
};

type WhatsAppChangeValue = {
  messaging_product?: string;
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WhatsAppTextMessage[];
};

type BootstrapTokenPayload = {
  wa_id: string;
  phone: string;
  session_id: string;
  exp: number;
  nonce: string;
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
    const events = extractTextMessages(payload);

    for (const event of events) {
      await upsertWhatsAppSession(event);

      if (isGreeting(event.message.text?.body ?? "")) {
        const onboardingUrl = await createOnboardingUrl(event);
        await sendWhatsAppText(
          event.message.from,
          [
            `Oi, ${event.profileName ?? "tudo bem"}! Sou o TaxMind.`,
            "Para proteger seus dados fiscais, preciso confirmar seu e-mail e CPF em um ambiente seguro.",
            `Comece por aqui: ${onboardingUrl}`,
          ].join("\n\n"),
        );
        continue;
      }

      await forwardToN8n(payload);
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

function extractTextMessages(payload: any) {
  const entries = payload?.entry ?? [];
  const events: Array<{
    value: WhatsAppChangeValue;
    message: WhatsAppTextMessage;
    waId: string;
    profileName?: string;
  }> = [];

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value as WhatsAppChangeValue;
      for (const message of value?.messages ?? []) {
        if (message.type !== "text") continue;
        const contact = value.contacts?.find((item) => item.wa_id === message.from);
        events.push({
          value,
          message,
          waId: contact?.wa_id ?? message.from,
          profileName: contact?.profile?.name,
        });
      }
    }
  }

  return events;
}

async function upsertWhatsAppSession(event: {
  message: WhatsAppTextMessage;
  waId: string;
  profileName?: string;
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { error } = await supabase.from("sessoes_whatsapp").insert({
    telefone_whatsapp: normalizeBrazilianPhone(event.message.from),
    wa_id: event.waId,
    ultima_mensagem_id: event.message.id,
    status: "ABERTA",
    aberta_em: now.toISOString(),
    ultima_interacao_em: now.toISOString(),
    expira_em: expiresAt.toISOString(),
    contexto: {
      profile_name: event.profileName ?? null,
      last_inbound_text: event.message.text?.body ?? null,
      onboarding_started: isGreeting(event.message.text?.body ?? ""),
    },
  });

  if (error) {
    console.error("failed to insert whatsapp session", error);
  }
}

async function createOnboardingUrl(event: {
  message: WhatsAppTextMessage;
  waId: string;
}) {
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

async function signBootstrapToken(payload: BootstrapTokenPayload) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const secret = env("TAXMIND_BOOTSTRAP_SECRET");
  if (!secret) {
    throw new Error("missing_bootstrap_secret");
  }
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
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

async function forwardToN8n(payload: unknown) {
  const n8nWebhookUrl = env("N8N_WEBHOOK_URL");
  if (!n8nWebhookUrl) return;

  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("failed to forward payload to n8n", await response.text());
  }
}

function isGreeting(text: string) {
  return /^(oi|ola|olá|hello|hi|bom dia|boa tarde|boa noite)\b/i.test(text.trim());
}

function normalizeBrazilianPhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return base64UrlEncode(signature);
}

async function hmacSha256Hex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(value: string | ArrayBuffer) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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
