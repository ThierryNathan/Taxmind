// Fonte unica do token HMAC de sessao do TaxMind.
//
// O token e emitido pela whatsapp-webhook (createOnboardingUrl) e consumido
// pela bootstrap-identity, pela pluggy-connect-token e pela pluggy-item-link.
// Antes da Fase 10 a assinatura e a verificacao viviam duplicadas nas duas
// primeiras functions; qualquer function nova seria uma terceira copia de um
// primitivo de seguranca, entao o codigo foi extraido para ca sem mudanca de
// comportamento. O `supabase functions deploy` empacota _shared junto com a
// function que importa daqui.
//
// IMPORTANTE: `session_id` no payload NAO e um id de sessoes_whatsapp. A
// whatsapp-webhook gera um crypto.randomUUID() novo por link. Quem precisa do
// usuario a partir do token deve resolver por `phone` contra
// usuarios.telefone_whatsapp, nao por session_id.

export type BootstrapTokenPayload = {
  wa_id: string;
  phone: string;
  session_id: string;
  exp: number;
  nonce: string;
};

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

export async function signBootstrapToken(
  payload: BootstrapTokenPayload,
  secret = env("TAXMIND_BOOTSTRAP_SECRET"),
): Promise<string> {
  if (!secret) {
    throw new Error("missing_bootstrap_secret");
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyBootstrapToken(
  token: string,
  secret = env("TAXMIND_BOOTSTRAP_SECRET"),
): Promise<BootstrapTokenPayload> {
  const [encodedPayload, signature] = token?.split(".") ?? [];
  if (!encodedPayload || !signature) {
    throw new Error("invalid_or_expired_token");
  }

  const expected = await hmacSha256(secret, encodedPayload);
  if (!timingSafeEqual(signature, expected)) {
    throw new Error("invalid_or_expired_token");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as BootstrapTokenPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("invalid_or_expired_token");
  }

  return payload;
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
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

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

export function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}
