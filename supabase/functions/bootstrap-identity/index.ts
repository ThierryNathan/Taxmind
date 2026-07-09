import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type BootstrapRequest = {
  token: string;
  email: string;
  cpf: string;
  nome?: string;
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
    if (userId) {
      await upsertUsuario({
        userId,
        email,
        nome: body.nome,
        cpfHash,
        telefoneWhatsapp: tokenPayload.phone,
      });
    }

    await recordSessionContext(tokenPayload, email, cpfHash, userId);

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
}) {
  const { error } = await supabase
    .from("usuarios")
    .upsert({
      id: input.userId,
      nome: input.nome ?? null,
      email: input.email,
      telefone_whatsapp: input.telefoneWhatsapp,
      cpf_hash: input.cpfHash,
      onboarding_concluido: false,
      consentimento_lgpd_em: null,
    }, { onConflict: "id" });

  if (error) {
    console.error("failed to upsert usuario", error);
    throw new Error("usuario_link_failed");
  }
}

async function verifyBootstrapToken(token: string): Promise<BootstrapTokenPayload> {
  const [encodedPayload, signature] = token?.split(".") ?? [];
  if (!encodedPayload || !signature) {
    throw new Error("invalid_or_expired_token");
  }

  const expected = await hmacSha256(env("TAXMIND_BOOTSTRAP_SECRET"), encodedPayload);
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid_or_expired_token");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as BootstrapTokenPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("invalid_or_expired_token");
  }

  return payload;
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

async function hmacSha256(secret: string, message: string) {
  if (!secret) {
    throw new Error("missing_bootstrap_secret");
  }

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

function base64UrlEncode(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
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
