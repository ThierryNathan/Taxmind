// Emite o Connect Token do Pluggy para o widget de conexao bancaria.
//
// Chamada pelo navegador (pagina de onboarding em modo=conectar-banco) com a
// anon key + o token HMAC de sessao recebido pelo WhatsApp.
//
// Cuidado com o nome das coisas: o `token` da requisicao e o token HMAC de
// SESSAO do TaxMind; o `accessToken` da resposta e o Connect Token do PLUGGY.
// Sao credenciais diferentes, com emissores diferentes.
//
// Usa o pluggy-sdk oficial (npm:pluggy-sdk@0.90.0) — validado dentro da imagem
// real do edge-runtime do Supabase (v1.74.2 / Deno 2.1.4), nao so em Deno local.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { PluggyClient } from "npm:pluggy-sdk@0.90.0";
import { corsHeaders, json } from "../_shared/http.ts";
import { resolveUsuarioFromSessionToken, statusForError } from "../_shared/onboarding_session.ts";

type ConnectTokenRequest = {
  token?: string;
};

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

serve(async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const body = await request.json() as ConnectTokenRequest;
    if (!body?.token) {
      return json({ error: "missing_token" }, 400);
    }

    // Porta de seguranca desta function: o Connect Token autoriza vincular uma
    // conta bancaria de verdade. So sai para token valido, nao expirado, de um
    // telefone com onboarding_concluido = true.
    const { usuarioId } = await resolveUsuarioFromSessionToken(body.token);

    const clientId = env("PLUGGY_CLIENT_ID");
    const clientSecret = env("PLUGGY_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      console.error("PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET nao configurados");
      return json({ error: "pluggy_not_configured" }, 500);
    }

    const pluggy = new PluggyClient({ clientId, clientSecret });

    // clientUserId fica gravado no item criado a partir deste token. E o que
    // permite a pluggy-webhook recuperar o dono de um item que, por qualquer
    // motivo, nao chegou a ser gravado em open_finance_items.
    const { accessToken } = await pluggy.createConnectToken(undefined, {
      clientUserId: usuarioId,
      avoidDuplicates: true,
    });

    return json({ accessToken });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = statusForError(message);
    if (status === 500) {
      console.error("pluggy-connect-token error", error);
    }
    return json({ error: message }, status);
  }
});
