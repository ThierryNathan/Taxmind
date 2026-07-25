# TaxMind - Contexto Persistente Da IA

## Produto

TaxMind e um copiloto fiscal B2B2C integrado ao WhatsApp para profissionais autonomos, pequenos empreendedores e contadores parceiros.

O MVP automatiza captura, OCR, classificacao fiscal, trilha de auditoria e consolidacao de evidencias dedutiveis ao longo do ano.

## Stack Principal

- Interface conversacional: WhatsApp Cloud API via webhooks oficiais da Meta.
- Orquestracao: n8n em Docker, previsto para Oracle Cloud VM Linux Ampere A1.
- IA: Google Gemini (`gemini-3-flash-preview`) para classificacao textual, visual e de intencao.
- Persistencia e autenticacao: Supabase/PostgreSQL com RLS.
- Backend auxiliar: Python/Node.js para relatorios, consolidacao e scripts operacionais.

## Convencoes Do Repositorio

- `supabase/` segue a convencao nativa do Supabase CLI.
- `supabase/migrations/` guarda migrations executaveis por `supabase db push`, `supabase migration up` e fluxos equivalentes.
- `supabase/functions/` guarda Edge Functions deployaveis por `supabase functions deploy`.
- `n8n/workflows/` guarda exports JSON versionados dos workflows.
- `backend/prompts/` guarda prompts de producao.
- `docs/` guarda notas Markdown compativeis com Obsidian usando links internos.
- `scripts/` guarda utilitarios repetiveis de setup e seed.
- `Mockup/` guarda o prototipo visual em Vite/React.

## Decisoes Arquiteturais

- RLS deve isolar dados por `auth.uid()`.
- Webhooks e automacoes backend podem usar `service_role`, mas a chave nunca deve aparecer em frontend, app mobile, mockup ou workflow publico.
- Midias recebidas pelo WhatsApp devem ser processadas, gravadas em bucket seguro e expurgadas do contexto temporario assim que possivel.
- Despesas com baixa confianca, conflito fiscal ou alto risco de glosa devem entrar em fila de revisao humana.
- O prompt fiscal deve devolver saida estruturada e rastreavel, separando dados extraidos, inferencias, nivel de confianca e motivos de revisao.

## Ordem Recomendada De Implementacao

1. Manter `AGENTS.md` atualizado como fonte compartilhada de contexto para IA.
2. Implementar `backend/prompts/taxmind_system_prompt.js`.
3. Implementar `supabase/functions/whatsapp-webhook/index.ts`.
4. Implementar `supabase/functions/bootstrap-identity/index.ts`.
5. Desenhar workflows reais em `n8n/workflows/`.
6. Fortalecer CI, testes locais e deploy depois que a logica central estiver validada.

## Aprendizados Operacionais

Armadilhas ja encontradas na pratica. Ler antes de mexer nas areas citadas.

### n8n

- Os `.json` em `n8n/workflows/` sao exports vivos da instancia real: carregam IDs de node, `webhookId`, `meta.instanceId`, `active` e ajustes feitos direto na UI. **Nunca regenerar por script.** Editar cirurgicamente o arquivo como esta e conferir o diff antes de fechar — regenerar sobrescreve ajuste manual e faz o import criar um workflow novo em vez de atualizar o existente.
- Code node em `runOnceForAllItems` nao tem item pareado: usar `$('No').first().json`. O `$('No').item.json` so funciona em `runOnceForEachItem`.
- Resposta `[]` do PostgREST pode fazer o node HTTP nao emitir item nenhum, e o node seguinte simplesmente nao executa. Marcar `alwaysOutputData: true` quando o branch precisa responder mesmo com resultado vazio.
- Existem dois webhooks separados e **nao intercambiaveis**: `N8N_WEBHOOK_URL` (midia -> `receipt-ocr-classification`) e `N8N_TEXT_WEBHOOK_URL` (texto -> `consulta-e-dossie`).
- O `usuario_id` de uma mensagem se resolve por `session_id` contra `sessoes_whatsapp.id`, **nao** por `wa_id`. Reaproveitar esse padrao em qualquer node ou function nova.

### Gemini

- Modelos 3.x usam `generationConfig.thinkingConfig.thinkingLevel` (`minimal`/`low`/`medium`/`high`). O `thinkingBudget` e da geracao 2.5 e nao vale aqui.
- Gemini 3 Flash nao permite desligar thinking. Com `maxOutputTokens` baixo o thinking consome o orcamento e a resposta volta **vazia** — deixar folga no teto e tratar resposta vazia no parser.

### Supabase

- Funcao Postgres que agrega dado sensivel recebendo `usuario_id` por parametro deve ser `SECURITY INVOKER`. Com `SECURITY DEFINER` a RLS e ignorada e qualquer `authenticated` le o dado de outro usuario passando o uuid alheio.
- O runtime das Edge Functions injeta `SUPABASE_SERVICE_ROLE_KEY` ja no formato novo (`sb_secret_...`), enquanto secrets do Supabase e variaveis do n8n podem estar no JWT antigo (`eyJ...`). Ao comparar chave byte a byte (validacao de chamador interno), confirmar que os dois lados usam o mesmo formato.
- `.env.example` e separado por fronteira de seguranca: raiz = backend, com segredos; `apps/onboarding/.env.example` = so variaveis `VITE_*` publicas, que vao no bundle. O `.gitignore` fica centralizado na raiz e ja cobre subpastas.

### PDF

- As `StandardFonts` do pdf-lib usam WinAnsi: acento latino passa, mas emoji e simbolos fora de Latin-1 lancam excecao e derrubam a geracao inteira. Como `descricao` vem de OCR, sanear o texto antes de cada `drawText`.

### Pluggy / Open Finance

- `npm:pluggy-sdk@0.90.0` roda dentro do edge-runtime real do Supabase (testado na imagem `public.ecr.aws/supabase/edge-runtime:v1.74.2`, Deno 2.1.4), com chamada HTTPS de saida funcionando. A versao `latest` e **0.90.0**, nao 1.x — pedir `@1.x` quebra a resolucao do `npm:`.
- O `session_id` do token HMAC de onboarding **nao** e um id de `sessoes_whatsapp`: a `whatsapp-webhook` gera um `crypto.randomUUID()` novo a cada link. Quem precisa do usuario a partir do token resolve por `phone` contra `usuarios.telefone_whatsapp` — o padrao de resolver por `session_id` vale para as mensagens que chegam ao n8n, nao para o token.
- O item do Pluggy guarda o `clientUserId` que passamos no `createConnectToken`. Isso permite recuperar o dono de um item pelo `GET /items/{id}` quando o vinculo local nao chegou a ser gravado — sem esse fallback, uma conexao concluida com o navegador fechado antes do `onSuccess` viraria transacao orfa para sempre.
- O webhook do Pluggy aceita headers customizados no cadastro (campo `headers` de `CreateWebhook`), entao da para exigir um segredo proprio em vez de deixar o endpoint aberto.
- Processamento pos-resposta em Edge Function precisa de `EdgeRuntime.waitUntil`; sem isso o trabalho e morto junto com a requisicao e o webhook responde rapido sem nunca terminar o servico.

### Windows / Git Bash

- Argumento com barra inicial em `docker run` (`--main-service /home/deno/main`) e reescrito pelo MSYS para `C:/Program Files/Git/...`, e o erro que aparece e enganoso (`could not find an appropriate entrypoint`, como se o arquivo estivesse errado). Prefixar com `MSYS_NO_PATHCONV=1`.

## Regras De Seguranca

- Nunca commitar credenciais reais.
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` fora de ambientes backend controlados.
- Evitar dados pessoais reais em seeds, fixtures, prints, logs e exemplos.
- CPF deve ser armazenado apenas como hash quando nao houver necessidade legal de guardar o valor bruto.
- Artefatos de OCR e midia devem ter trilha de auditoria, hash e politica de retencao clara.

