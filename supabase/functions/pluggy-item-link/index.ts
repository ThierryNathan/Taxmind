// Persiste o vinculo item do Pluggy -> usuario do TaxMind.
//
// Chamada pelo navegador no onSuccess do widget PluggyConnect, com o mesmo
// token HMAC de sessao usado na pluggy-connect-token.
//
// Por que uma function separada, e nao um "evento sintetico" na pluggy-webhook:
// a pluggy-webhook e um endpoint publico que aceita POST do Pluggy e nao tem
// como exigir o token de sessao do usuario. Aceitar tambem um evento forjavel
// ali significaria que qualquer um poderia amarrar um item_id arbitrario a um
// usuario_id arbitrario — os dois modelos de confianca nao cabem no mesmo
// handler. Aqui a escrita exige token de sessao valido E confirmacao junto ao
// Pluggy de que o item realmente pertence aquele usuario.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import {
  resolveUsuarioFromSessionToken,
  statusForError,
  supabaseAdmin,
} from "../_shared/onboarding_session.ts";
import { fetchItem } from "../_shared/pluggy_api.ts";

type ItemLinkRequest = {
  token?: string;
  item_id?: string;
};

serve(async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const body = await request.json() as ItemLinkRequest;
    const itemId = body?.item_id?.trim();
    if (!body?.token || !itemId) {
      return json({ error: "missing_token_or_item_id" }, 400);
    }

    const { usuarioId } = await resolveUsuarioFromSessionToken(body.token);

    // Sem esta confirmacao, um usuario cadastrado poderia mandar o item_id de
    // outra pessoa e passar a receber as transacoes bancarias dela. O
    // clientUserId foi gravado no item pelo Connect Token que a
    // pluggy-connect-token emitiu para este mesmo usuario.
    const item = await fetchItem(itemId);
    if (item.clientUserId !== usuarioId) {
      console.warn("item_id nao pertence ao usuario do token", { itemId });
      return json({ error: "item_nao_pertence_ao_usuario" }, 403);
    }

    const { error } = await supabaseAdmin
      .from("open_finance_items")
      .upsert({
        usuario_id: usuarioId,
        pluggy_item_id: itemId,
        connector_id: item.connector?.id ? String(item.connector.id) : null,
        connector_nome: item.connector?.name ?? null,
        status: item.status ?? null,
        status_detalhe: {
          execution_status: item.executionStatus ?? null,
          last_updated_at: item.lastUpdatedAt ?? null,
        },
      }, { onConflict: "pluggy_item_id" });

    if (error) {
      console.error("failed to upsert open_finance_item", error);
      return json({ error: "vinculo_nao_persistido" }, 500);
    }

    return json({ ok: true, item_id: itemId, connector: item.connector?.name ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const status = statusForError(message);
    if (status === 500) {
      console.error("pluggy-item-link error", error);
    }
    return json({ error: message }, status);
  }
});
