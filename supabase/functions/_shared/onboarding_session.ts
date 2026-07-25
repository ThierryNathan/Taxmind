// Resolucao de usuario a partir do token HMAC de sessao.
//
// Usada pelas functions da Fase 10 que sao chamadas pelo navegador
// (pluggy-connect-token e pluggy-item-link). Ambas emitem/gravam algo que
// autoriza acesso a conta bancaria do usuario, entao a checagem e a mesma e
// vive num lugar so.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { type BootstrapTokenPayload, verifyBootstrapToken } from "./bootstrap_token.ts";

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

export const supabaseAdmin = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

export type UsuarioSessao = {
  usuarioId: string;
  nome: string | null;
  payload: BootstrapTokenPayload;
};

/**
 * Valida o token HMAC e devolve o usuario correspondente.
 *
 * Lanca:
 *   invalid_or_expired_token — assinatura invalida ou token vencido;
 *   onboarding_incompleto    — token valido, mas o telefone nao tem cadastro
 *                              concluido.
 *
 * O segundo caso e o que impede que um link de onboarding recem-emitido (que
 * qualquer primeiro contato no WhatsApp recebe, antes de existir cadastro)
 * sirva para conectar uma conta bancaria. Sem essa checagem, o token de quem
 * ainda nao se cadastrou geraria um Connect Token do Pluggy.
 *
 * A resolucao e por `phone` de proposito: `session_id` no payload e um
 * crypto.randomUUID() criado pela whatsapp-webhook a cada link, nao um id de
 * sessoes_whatsapp. Ver comentario em _shared/bootstrap_token.ts.
 */
export async function resolveUsuarioFromSessionToken(token: string): Promise<UsuarioSessao> {
  const payload = await verifyBootstrapToken(token);

  const { data, error } = await supabaseAdmin
    .from("usuarios")
    .select("id, nome, onboarding_concluido")
    .eq("telefone_whatsapp", payload.phone)
    .maybeSingle();

  if (error) {
    console.error("failed to lookup usuario by phone", error);
    throw new Error("usuario_lookup_failed");
  }

  if (!data?.id || data.onboarding_concluido !== true) {
    throw new Error("onboarding_incompleto");
  }

  return { usuarioId: data.id, nome: data.nome ?? null, payload };
}

export function statusForError(message: string): number {
  if (message === "invalid_or_expired_token") return 401;
  if (message === "onboarding_incompleto") return 403;
  return 500;
}
