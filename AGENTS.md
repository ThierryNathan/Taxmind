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
- `apps/onboarding/` guarda o app real de onboarding (Vite/React), separado do `Mockup/`.
- `tests/` guarda testes de Deno das Edge Functions, alem das pastas de fixtures, prompts e SQL. Rodar com `deno test --allow-env --allow-net tests/`. **A CI ainda nao executa esses testes** — `.github/workflows/ci.yml` so valida JSON dos workflows e existencia de migrations.

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
- Node HTTP roda **uma vez por item de entrada**. Consulta que vale para o lote inteiro (resolver dono, buscar ids ja gravados) tem que acontecer enquanto ainda ha um item so; fanar para N itens antes viraria N consultas identicas.
- Merge em modo `append` **dispara mesmo quando um dos ramos de entrada nunca executou** (verificado no 1.99.1). Isso deixa usar `IF -> dois ramos -> Merge` sem sentinela, e o caso importa de verdade: no sandbox do Pluggy 100% das transacoes caem no pre-filtro e o ramo da IA fica vazio.
- `import:workflow` respeita o campo `active` do JSON: importar um arquivo com `active: false` **desativa** o webhook que estava ativo. E `update:workflow --active=true` so vale depois de reiniciar o n8n.
- Terceiro webhook da casa: `N8N_OPENFINANCE_WEBHOOK_URL` (transacao bancaria -> `openfinance-transacoes`), sem relacao com os outros dois.

### Gemini

- Modelos 3.x usam `generationConfig.thinkingConfig.thinkingLevel` (`minimal`/`low`/`medium`/`high`). O `thinkingBudget` e da geracao 2.5 e nao vale aqui.
- Gemini 3 Flash nao permite desligar thinking. Com `maxOutputTokens` baixo o thinking consome o orcamento e a resposta volta **vazia** — deixar folga no teto e tratar resposta vazia no parser.

### Supabase

- Funcao Postgres que agrega dado sensivel recebendo `usuario_id` por parametro deve ser `SECURITY INVOKER`. Com `SECURITY DEFINER` a RLS e ignorada e qualquer `authenticated` le o dado de outro usuario passando o uuid alheio.
- O runtime das Edge Functions injeta `SUPABASE_SERVICE_ROLE_KEY` ja no formato novo (`sb_secret_...`), enquanto secrets do Supabase e variaveis do n8n podem estar no JWT antigo (`eyJ...`). Ao comparar chave byte a byte (validacao de chamador interno), confirmar que os dois lados usam o mesmo formato.
- `.env.example` e separado por fronteira de seguranca: raiz = backend, com segredos; `apps/onboarding/.env.example` = so variaveis `VITE_*` publicas, que vao no bundle. O `.gitignore` fica centralizado na raiz e ja cobre subpastas.
- O projeto tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, service_role` no schema `public`: **tabela nova nasce com privilegio total para o anon key**. RLS habilitada sem policy ja nega tudo, mas quem cria tabela que guarda credencial (hash de codigo, token) deve tambem `revoke all ... from anon, authenticated` — senao um `disable row level security` acidental no futuro expoe a tabela inteira. Mesmo raciocinio para log append-only: sem revoke, `authenticated` tem INSERT/UPDATE/DELETE no proprio registro de auditoria.
- `SET LOCAL role` fora de bloco de transacao e ignorado com apenas um WARNING, e o psql segue como superusuario. Teste de RLS que use `set local` sem `begin/rollback` passa achando que testou isolamento quando na verdade nao testou nada.
- Migration validada de graca em `postgres:15` puro com um shim de ~10 linhas (roles `anon`/`authenticated`/`service_role`, schema `auth`, `auth.users`, `auth.uid()`, e o `alter default privileges` acima). Mais rapido que `supabase start` e suficiente para constraint, trigger, RLS e idempotencia.

### Resend / Re-verificacao por e-mail

- Dois canais de e-mail que **nao se substituem**: o SMTP customizado do dashboard (Authentication -> Emails) serve os e-mails do proprio Auth (magic link do onboarding); a `RESEND_API_KEY` serve a chamada direta que a `whatsapp-webhook` faz a `https://api.resend.com/emails` para o codigo de re-verificacao. Passo a passo em `docs/04 - Re-verificacao por E-mail (Resend).md`.
- `supabase.auth.admin.generateLink` **nao despacha e-mail** — devolve `action_link`/`email_otp` para quem chama enviar. E o `email_otp` do Auth so se valida via `verifyOtp`, que cria sessao autenticada: nao serve para reconfirmar identidade no WhatsApp, so para login.
- No painel do Resend, o usuario de SMTP e a string literal `resend` e a senha e a propria API key. Errar isso da `535 Authentication failed`, que parece problema de key.
- `sessoes_whatsapp.verificado_em` existe, mas a janela de confianca **nao pode ser lida da sessao atual**: sessao expira em 24h e sessao nova nasce sem contexto, entao a janela de 30 dias viraria 24 horas. Ler o maior `verificado_em` entre as sessoes do usuario, com fallback em `usuarios.criado_em`.
- Codigo esgotado por tentativas nao gera codigo novo automaticamente: exige outra mensagem do usuario. Renovar na hora deixaria um chute em rajada renovando codigo para sempre e enchendo a caixa de entrada do dono.
- Nao ha como validar o fluxo com Supabase e Meta reais em dev, mas da para importar o `index.ts` num teste de Deno e stubbar `globalThis.fetch` **antes** do import (o `createClient` no topo do modulo captura a referencia de fetch nesse momento). Um mini-PostgREST em memoria de ~100 linhas cobre `eq/gt/is.null/not.is.null/order/limit`, que e tudo o que as functions usam. Ver `tests/reverificacao_webhook_test.ts`.

### PDF

- As `StandardFonts` do pdf-lib usam WinAnsi: acento latino passa, mas emoji e simbolos fora de Latin-1 lancam excecao e derrubam a geracao inteira. Como `descricao` vem de OCR, sanear o texto antes de cada `drawText`.

### Pluggy / Open Finance

- `npm:pluggy-sdk@0.90.0` roda dentro do edge-runtime real do Supabase (testado na imagem `public.ecr.aws/supabase/edge-runtime:v1.74.2`, Deno 2.1.4), com chamada HTTPS de saida funcionando. A versao `latest` e **0.90.0**, nao 1.x — pedir `@1.x` quebra a resolucao do `npm:`.
- O `session_id` do token HMAC de onboarding **nao** e um id de `sessoes_whatsapp`: a `whatsapp-webhook` gera um `crypto.randomUUID()` novo a cada link. Quem precisa do usuario a partir do token resolve por `phone` contra `usuarios.telefone_whatsapp` — o padrao de resolver por `session_id` vale para as mensagens que chegam ao n8n, nao para o token.
- O item do Pluggy guarda o `clientUserId` que passamos no `createConnectToken`. Isso permite recuperar o dono de um item pelo `GET /items/{id}` quando o vinculo local nao chegou a ser gravado — sem esse fallback, uma conexao concluida com o navegador fechado antes do `onSuccess` viraria transacao orfa para sempre.
- O webhook do Pluggy aceita headers customizados no cadastro (campo `headers` de `CreateWebhook`), entao da para exigir um segredo proprio em vez de deixar o endpoint aberto.
- Processamento pos-resposta em Edge Function precisa de `EdgeRuntime.waitUntil`; sem isso o trabalho e morto junto com a requisicao e o webhook responde rapido sem nunca terminar o servico.
- `GET /transactions` **foi desativado** e responde `410 ENDPOINT_DEPRECATED`. O substituto e `GET /v2/transactions`, e nao basta trocar o path: `from`, `to`, `page` e `pageSize` sao todos rejeitados com `400 property X should not exist`. Os nomes validos sao `dateFrom`, `dateTo`, `createdAtFrom` e `after` (cursor). Envelope `{ results, next }`, pagina fixa em 500 sem parametro para reduzir — o que impede exercitar a paginacao no sandbox, que tem 25 transacoes por conta.
- O sandbox devolve `category`/`categoryId` preenchidos em 100% das transacoes, mas isso **nao diz nada** sobre a conta real: no sandbox o dado ja vem categorizado de fabrica, e a categorizacao e addon pago depois do trial. Qualquer logica que dependa da categoria tem que tratar `null` como caminho normal, nao como excecao.
- Sandbox nao serve para avaliar qualidade de classificacao: `merchant` vem `null` em 100% dos casos e a descricao e literalmente `PAGAMENTO`/`PGTO`. Da para validar encanamento, nao a IA.
- Filtrar por `categoryId` (hierarquico e estavel, 2 primeiros digitos = categoria de topo) em vez do rotulo `category`, que e texto de exibicao. Taxonomia completa em `GET /categories` (130 categorias).
- `GET /accounts?itemId=` ja devolve conta corrente, poupanca **e cartao de credito** na mesma lista: nao ha filtro por tipo a corrigir ali. Quando transacao de cartao some, procurar o descarte depois da busca, nao antes.
- Convencoes de conta CREDIT que invertem o que vale em conta BANK, e sao a causa real de transacao de cartao sumir: (1) `DEBIT` chega com `amount` **positivo** (em BANK vem negativo) — daí o `Math.abs` na normalizacao nao ser redundante; (2) `PENDING` nao e estado transitorio, e o estado da compra ate a fatura fechar. Descartar PENDING derrubava 12 das 23 compras do cartao no item sandbox, e elas nao voltavam: a sincronizacao seguinte usa um `dateFrom` mais recente que a data da compra.
- `GET /transactions` (colecao) responde 410, mas `GET /transactions/{id}` continua respondendo 200 com o objeto completo. E o unico caminho para o `transactionIds` do `transactions/updated`: `/v2/transactions?ids=` responde 400 exigindo `accountId`.
- `dateFrom` e truncado em dia. Teste que pretenda distinguir `dateFrom` de `createdAtFrom` precisa de um corte em **outro dia**, senao passa com os dois e nao prova nada.
- `createdAtFrom` (quando o registro entrou na base do Pluggy) e `dateFrom` (quando a compra aconteceu) diferem por dias em fatura de cartao. O evento `transactions/created` manda a janela na primeira dimensao; filtrar por `dateFrom` ali descarta justamente a transacao que acabou de chegar.
- O `createdTransactionsLink` do evento `transactions/created` aponta para a colecao `/transactions`, ja desativada. Remontar a consulta em `/v2/transactions` — e evita seguir URL de fora carregando a `X-API-KEY`.
- Os eventos `transactions/*` sao por **conta**, nao por item, e o `accountId` vem do corpo forjavel do webhook. Conferir `account.itemId === payload.itemId` antes de usar: sem isso, um evento com item de um usuario e conta de outro grava transacao alheia sob o usuario errado.
- Teste da `pluggy-webhook` com Pluggy real e Supabase mockado: `tests/pluggy_webhook_transacoes_test.ts`. Mesmo padrao do `reverificacao_webhook_test.ts` (stub de `globalThis.fetch` **antes** do import), mas deixando `api.pluggy.ai` passar direto. As duas suites sobem `serve()` na porta 8000 e por isso **nao rodam no mesmo processo** do `deno test`.

### Windows / Git Bash

- Argumento com barra inicial e reescrito pelo MSYS para `C:/Program Files/Git/...` em **qualquer** subcomando do docker, nao so no `docker run`: `docker exec ... psql -f /arquivo.sql` vira `psql: error: C:/Program Files/Git/arquivo.sql: No such file or directory`, e `docker cp origem container:/destino` erra o destino. A mensagem sempre parece problema do arquivo, nunca do path. Fazer `export MSYS_NO_PATHCONV=1` uma vez no inicio do script, em vez de prefixar comando a comando e esquecer um.

## Regras De Seguranca

- Nunca commitar credenciais reais.
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` fora de ambientes backend controlados.
- Evitar dados pessoais reais em seeds, fixtures, prints, logs e exemplos.
- CPF deve ser armazenado apenas como hash quando nao houver necessidade legal de guardar o valor bruto.
- Artefatos de OCR e midia devem ter trilha de auditoria, hash e politica de retencao clara.

