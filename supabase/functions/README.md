# Edge Functions

Cada pasta e uma function deployavel por `supabase functions deploy <nome>`.
A pasta `_shared/` nao e uma function: sao modulos importados pelas outras e
empacotados junto no deploy.

## Modulos compartilhados

| Modulo | Responsabilidade |
| --- | --- |
| `_shared/bootstrap_token.ts` | Assinatura e verificacao do token HMAC de sessao. Fonte unica: a `whatsapp-webhook` assina, a `bootstrap-identity`, a `pluggy-connect-token` e a `pluggy-item-link` verificam. |
| `_shared/onboarding_session.ts` | Client `service_role` + `resolveUsuarioFromSessionToken`, que valida o token e exige `onboarding_concluido = true`. |
| `_shared/pluggy_api.ts` | Cliente REST minimo do Pluggy (`/auth`, `/items`, `/accounts`, `/transactions`) com cache da apiKey. |
| `_shared/http.ts` | `corsHeaders` (origem fixa em `ONBOARDING_BASE_URL`) e helpers de resposta JSON. |

Atencao ao mexer no `bootstrap_token.ts`: o formato do token e compativel com
os links ja emitidos (TTL de 15 min). Mudar o encoding ou o payload invalida
todo link em transito.

## Functions

| Function | Chamador | Autenticacao |
| --- | --- | --- |
| `whatsapp-webhook` | Meta / WhatsApp Cloud API | Assinatura `x-hub-signature-256` com `WHATSAPP_APP_SECRET` |
| `bootstrap-identity` | Navegador (pagina de onboarding) | Token HMAC de sessao + anon key |
| `generate-dossier` | n8n | `service_role` key no `Authorization` |
| `pluggy-connect-token` | Navegador (`?modo=conectar-banco`) | Token HMAC de sessao + cadastro concluido |
| `pluggy-item-link` | Navegador (`onSuccess` do widget) | Token HMAC de sessao + confirmacao do `clientUserId` no Pluggy |
| `pluggy-webhook` | Pluggy | Header `x-taxmind-webhook-secret` (quando `PLUGGY_WEBHOOK_SECRET` configurado) |
| `pluggy-connect-link` | n8n | `service_role` key no `Authorization` |

## Fase 10 — fluxo Open Finance ponta a ponta

1. Usuario manda "conectar banco" no WhatsApp.
2. `consulta-e-dossie` (n8n) classifica como `conectar_banco` e chama
   `pluggy-connect-link`, que assina um token e devolve
   `ONBOARDING_BASE_URL?token=...&wa_id=...&modo=conectar-banco`.
3. n8n envia o link pelo WhatsApp.
4. A pagina em `modo=conectar-banco` chama `pluggy-connect-token`, que valida
   o token, confirma o cadastro e emite o Connect Token do Pluggy com
   `clientUserId = usuario_id`.
5. O widget conecta o banco. No `onSuccess`, a pagina chama `pluggy-item-link`,
   que confere o `clientUserId` do item e grava `open_finance_items`.
6. O Pluggy dispara `item/updated` para `pluggy-webhook`, que responde 200 na
   hora e, em background, busca as transacoes e as encaminha normalizadas para
   `N8N_OPENFINANCE_WEBHOOK_URL`.

Por que `pluggy-item-link` e uma function separada, e nao um evento sintetico
na `pluggy-webhook`: a `pluggy-webhook` e publica e nao tem como exigir o token
de sessao do usuario. Aceitar um evento forjavel ali permitiria amarrar um
`item_id` qualquer a um `usuario_id` qualquer — sao dois modelos de confianca
que nao cabem no mesmo handler.

Por que `pluggy-connect-link` existe, em vez de assinar o token num Code node
do n8n: a assinatura usa `TAXMIND_BOOTSTRAP_SECRET`, que hoje **nao** esta no
container do n8n. Levar o segredo de identidade para mais um container — e
manter uma segunda implementacao de HMAC la — e preco alto para economizar uma
chamada HTTP interna.

## Variaveis de ambiente da Fase 10

`PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_WEBHOOK_SECRET`,
`N8N_OPENFINANCE_WEBHOOK_URL`. As demais (`SUPABASE_*`, `ONBOARDING_BASE_URL`,
`TAXMIND_BOOTSTRAP_SECRET`) ja existiam. Ver `.env.example` na raiz.
