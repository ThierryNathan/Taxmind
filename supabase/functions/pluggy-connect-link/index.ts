// Gera o link assinado que leva o usuario a pagina de conexao bancaria.
//
// Chamada server-to-server pelo n8n (branch conectar_banco do workflow
// consulta-e-dossie), no mesmo padrao do node "Edge - Gerar Dossie": exige a
// service_role key no Authorization.
//
// Por que existe, em vez de assinar o token direto num Code node do n8n: a
// assinatura usa TAXMIND_BOOTSTRAP_SECRET, que hoje NAO esta no container do
// n8n (so GEMINI_API_KEY, SUPABASE_*, WHATSAPP_* e RECEIPT_WORKFLOW_WEBHOOK_URL
// estao). Levar o segredo de assinatura de identidade para mais um container —
// e manter uma segunda implementacao de HMAC + base64url la dentro — e preco
// alto para economizar uma chamada HTTP interna. Aqui a logica e exatamente a
// mesma da whatsapp-webhook, importada de _shared/bootstrap_token.ts.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { plainJson } from "../_shared/http.ts";
import { type BootstrapTokenPayload, signBootstrapToken, timingSafeEqual } from "../_shared/bootstrap_token.ts";

type ConnectLinkRequest = {
  wa_id?: string;
  phone?: string;
};

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const TOKEN_TTL_SEGUNDOS = 15 * 60;

serve(async (request) => {
  try {
    if (request.method !== "POST") {
      return plainJson({ error: "method_not_allowed" }, 405);
    }

    if (!isServiceRoleCaller(request)) {
      return plainJson({ error: "unauthorized" }, 401);
    }

    const body = await request.json() as ConnectLinkRequest;
    const waId = body?.wa_id?.trim();
    const phone = body?.phone?.trim();
    if (!waId || !phone) {
      return plainJson({ error: "missing_wa_id_or_phone" }, 400);
    }

    const payload: BootstrapTokenPayload = {
      wa_id: waId,
      phone,
      session_id: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEGUNDOS,
      nonce: crypto.randomUUID(),
    };

    const token = await signBootstrapToken(payload);

    const url = new URL(env("ONBOARDING_BASE_URL", "http://localhost:5173/onboarding"));
    url.searchParams.set("token", token);
    url.searchParams.set("wa_id", waId);
    url.searchParams.set("modo", "conectar-banco");

    return plainJson({ url: url.toString(), expira_em_segundos: TOKEN_TTL_SEGUNDOS });
  } catch (error) {
    console.error("pluggy-connect-link error", error);
    return plainJson({ error: "internal_error" }, 500);
  }
});

// Mesma checagem da generate-dossier, inclusive a ressalva de formato: o
// runtime injeta SUPABASE_SERVICE_ROLE_KEY como sb_secret_..., entao o n8n
// precisa mandar SUPABASE_SECRET_KEY_SB_FORMAT, nao o JWT eyJ... antigo.
function isServiceRoleCaller(request: Request) {
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; refusing request");
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(token, serviceRoleKey);
}
