// Helpers de resposta HTTP compartilhados pelas functions da Fase 10.
//
// A origem do CORS e derivada de ONBOARDING_BASE_URL, igual a bootstrap-identity:
// as functions chamadas pelo navegador so aceitam a origem da pagina de
// onboarding, nao "*".

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

export function corsHeaders() {
  const onboardingOrigin = new URL(env("ONBOARDING_BASE_URL", "http://localhost:5173")).origin;
  return {
    ...jsonHeaders,
    "access-control-allow-origin": onboardingOrigin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = corsHeaders()) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function plainJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
