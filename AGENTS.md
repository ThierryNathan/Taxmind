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
- Os exports sao byte a byte `JSON.stringify(obj, null, 2)` **sem newline final** (conferido nos tres arquivos). Isso permite edicao programatica cirurgica — ler, trocar so o campo alvo, reserializar — com diff minimo e sem perder id, `webhookId`, `position`, `connections` nem `active`. Continua valendo: nao regenerar o workflow, e conferir o diff.
- O prompt fiscal tem **tres** copias vivas: `backend/prompts/taxmind_system_prompt.js` (fonte de edicao), `supabase/functions/_shared/prompt_fiscal.ts` (o bundle da Edge Function nao atravessa a fronteira de `supabase/functions/`) e o literal embutido no node "Preparar Contexto" (o n8n nao importa arquivo do repositorio). `tests/n8n_fase12_test.ts` compara as tres e falha se alguem editar so uma.
- Code node de teste roda fora do n8n com um arremedo de `$input` / `$("Node")` (`new AsyncFunction("$input", "$", jsCode)`), lendo o jsCode do proprio export. Ver `tests/n8n_fase12_test.ts` — testa o artefato que vai ser importado, nao uma copia.

### Data da despesa

- Mensagem sem nenhuma referencia temporal **nao gera pergunta de volta**: a maioria das mensagens nao cita data mesmo sendo do dia, e perguntar criaria atrito em quase todo lancamento. A data cai no recebimento e fica marcada em `metadados_ia.data_inferida`.
- `data_inferida` e rastro de auditoria, nao pendencia: nao entra em `campos_ausentes`, nao vira motivo de revisao e **nao pode** ser lida pela decisao de status. A decisao continua sendo so `parsed.requer_revisao_humana`.
- A data de referencia e o dia em **America/Sao_Paulo**, nao em UTC: mensagem das 22h de Sao Paulo ja e o dia seguinte em UTC, e a despesa e de hoje para quem mandou.
- Deducao reduz a BASE DE CALCULO do IRPF, nao o imposto devido. Confirmacao no WhatsApp, resumo e cabecalho do dossie nunca apresentam o valor dedutivel como dinheiro que volta.

### Follow-up conversacional

Passo a passo em `docs/06 - Follow-up Conversacional.md`.

- A despesa e gravada e confirmada **antes** de a pergunta existir. Todo caminho novo desta fase e opcional: `onError: continueRegularOutput` nos nodes de follow-up e fail open em toda consulta da `whatsapp-webhook`. Se algum dia um deles virar bloqueante, a fase perdeu o proposito.
- Pergunta so quando a IA declara `campos_bloqueantes` — o campo que **sozinho** destravaria a aprovacao. Uso misto, reembolso, OCR ruim e ambiguidade de categoria devolvem lista vazia: nenhuma resposta objetiva resolve.
- `deducibilidade_se_desbloqueado` e o que torna a promocao deterministica. Sem ela a promocao adivinharia dedutibilidade fiscal; o fallback e manter o que estava.
- So `documento_prestador` tem resposta reconhecivel sem IA (CNPJ/CPF tem digito verificador). `estabelecimento` e texto livre e cai na reclassificacao de proposito: adivinhar nome de lugar roubaria lancamento ("mercado 50 reais" e nome ou despesa?).
- Resposta reconhecida **nao** consome orcamento de mensagens: senao a propria resposta poderia fechar a pendencia que ela veio responder.
- `valor` e `data_despesa` nunca sao reescritos por follow-up, nos dois modos. A analise original fica inteira em `metadados_ia`; a nova entra em `followups`/`reclassificacoes`, ao lado.
- A `whatsapp-webhook` e o unico componente que ve toda mensagem (texto vai para `consulta-e-dossie`, midia para `receipt-ocr-classification`), entao o orcamento e contado la, e nao no n8n.
- Teste de concorrencia com mock sincrono **passa sem testar nada**: a segunda execucao ja encontra a linha reivindicada no SELECT e nem chega ao UPDATE. Para exercitar a exclusao mutua de verdade, segurar o PATCH da primeira ate a segunda ter lido — ver a barreira em `tests/followup_resolve_test.ts`.
- Fixture de reclassificacao precisa de `valor`/`data` **diferentes** dos gravados. Com os mesmos valores, um `valor: analise.valor ?? recibo.valor` passa despercebido pelo teste.

### Gemini

- Modelos 3.x usam `generationConfig.thinkingConfig.thinkingLevel` (`minimal`/`low`/`medium`/`high`). O `thinkingBudget` e da geracao 2.5 e nao vale aqui.
- Gemini 3 Flash nao permite desligar thinking. Com `maxOutputTokens` baixo o thinking consome o orcamento e a resposta volta **vazia** — deixar folga no teto e tratar resposta vazia no parser.

### Supabase

- Funcao Postgres que agrega dado sensivel recebendo `usuario_id` por parametro deve ser `SECURITY INVOKER`. Com `SECURITY DEFINER` a RLS e ignorada e qualquer `authenticated` le o dado de outro usuario passando o uuid alheio.
- O runtime das Edge Functions injeta `SUPABASE_SERVICE_ROLE_KEY` ja no formato novo (`sb_secret_...`), enquanto secrets do Supabase e variaveis do n8n podem estar no JWT antigo (`eyJ...`). Ao comparar chave byte a byte (validacao de chamador interno), confirmar que os dois lados usam o mesmo formato.
- `.env.example` e separado por fronteira de seguranca: raiz = backend, com segredos; `apps/onboarding/.env.example` = so variaveis `VITE_*` publicas, que vao no bundle. O `.gitignore` fica centralizado na raiz e ja cobre subpastas.
- O projeto tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, service_role` no schema `public`: **tabela nova nasce com privilegio total para o anon key**. RLS habilitada sem policy ja nega tudo, mas quem cria tabela que guarda credencial (hash de codigo, token) deve tambem `revoke all ... from anon, authenticated` — senao um `disable row level security` acidental no futuro expoe a tabela inteira. Mesmo raciocinio para log append-only: sem revoke, `authenticated` tem INSERT/UPDATE/DELETE no proprio registro de auditoria.
- `SET LOCAL role` fora de bloco de transacao e ignorado com apenas um WARNING, e o psql segue como superusuario. Teste de RLS que use `set local` sem `begin/rollback` passa achando que testou isolamento quando na verdade nao testou nada.
- Migration validada de graca em `postgres:15` puro com um shim de ~10 linhas (roles `anon`/`authenticated`/`service_role`, schema `auth`, `auth.users`, `auth.uid()`, e o `alter default privileges` acima). Mais rapido que `supabase start` e suficiente para constraint, trigger, RLS e idempotencia. O shim e o runner viraram arquivo: `tests/sql/shim_supabase.sql` e `bash tests/sql/run_migrations_docker.sh` (aplica 001..N e roda todo `tests/sql/*_test.sql`).

### Resend / Re-verificacao por e-mail

- Dois canais de e-mail que **nao se substituem**: o SMTP customizado do dashboard (Authentication -> Emails) serve os e-mails do proprio Auth (magic link do onboarding); a `RESEND_API_KEY` serve a chamada direta que a `whatsapp-webhook` faz a `https://api.resend.com/emails` para o codigo de re-verificacao. Passo a passo em `docs/04 - Re-verificacao por E-mail (Resend).md`.
- `supabase.auth.admin.generateLink` **nao despacha e-mail** — devolve `action_link`/`email_otp` para quem chama enviar. E o `email_otp` do Auth so se valida via `verifyOtp`, que cria sessao autenticada: nao serve para reconfirmar identidade no WhatsApp, so para login.
- No painel do Resend, o usuario de SMTP e a string literal `resend` e a senha e a propria API key. Errar isso da `535 Authentication failed`, que parece problema de key.
- `sessoes_whatsapp.verificado_em` existe, mas a janela de confianca **nao pode ser lida da sessao atual**: sessao expira em 24h e sessao nova nasce sem contexto, entao a janela de 30 dias viraria 24 horas. Ler o maior `verificado_em` entre as sessoes do usuario, com fallback em `usuarios.criado_em`.
- Codigo esgotado por tentativas nao gera codigo novo automaticamente: exige outra mensagem do usuario. Renovar na hora deixaria um chute em rajada renovando codigo para sempre e enchendo a caixa de entrada do dono.
- Nao ha como validar o fluxo com Supabase e Meta reais em dev, mas da para importar o `index.ts` num teste de Deno e stubbar `globalThis.fetch` **antes** do import (o `createClient` no topo do modulo captura a referencia de fetch nesse momento). Um mini-PostgREST em memoria de ~100 linhas cobre `eq/gt/is.null/not.is.null/order/limit`, que e tudo o que as functions usam. Ver `tests/reverificacao_webhook_test.ts`.

### PDF

- As `StandardFonts` do pdf-lib usam WinAnsi: acento latino passa, mas emoji e simbolos fora de Latin-1 lancam excecao e derrubam a geracao inteira. Como `descricao` vem de OCR, sanear o texto antes de cada `drawText`.
- O cabecalho nao tem quebra automatica de linha: texto novo entra como array de linhas ja quebradas, com o teste medindo `widthOfTextAtSize` contra a largura util (515pt).
- Procurar a frase desenhada nos bytes do PDF **nao acha nada**, por dois motivos somados: o `save()` comprime os streams e o `drawText` emite string hexadecimal (`<5461...> Tj`), nao texto literal. Nos dois casos o "nao achei" parece bug do cabecalho. Ver o extrator em `tests/dossie_nota_deducao_test.ts`.
- `DecompressionStream("deflate")` recusa os bytes de sobra que o PDF deixa depois do fim do fluxo zlib (`failed to write whole buffer`); `inflateSync` de `node:zlib` ignora, como os leitores de PDF.

### Consentimento LGPD

- O texto vive em duas copias — `supabase/functions/_shared/consentimento.ts` (canonica) e `apps/onboarding/src/lib/consentimento.js` (espelho da tela) — porque o bundle da Edge Function so enxerga `supabase/functions/` e o Vite so enxerga `apps/onboarding/`. `tests/consentimento_espelho_test.ts` compara o texto canonico dos dois e falha se so um lado mudar. Detalhes em `docs/05 - Consentimento LGPD no Onboarding.md`.
- O checkbox e a interface do gate, nao o gate: a `bootstrap-identity` recusa `consentimento_aceito !== true` e versao desconhecida, **depois** da checagem do token — se essa ordem inverter, o `probeBootstrapToken` do frontend para de distinguir 401 de 400 e a tela passa a dizer "link expirado" para todo mundo.
- O `texto_hash` e calculado no servidor. Hash recebido do navegador provaria so o que o navegador quis afirmar.

### Frontend do onboarding

- `apps/onboarding/src/index.css` tem um reset `* { margin: 0; padding: 0 }` **fora de `@layer`**, e CSS sem camada vence `@layer utilities` do Tailwind v4: todo `py-2.5` computa `padding-block: 0` e os botoes saem achatados (~24px em vez de ~42px). Vale para as telas antigas tambem — nao e regressao de tela nova.

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
- Item de sandbox **tem vida curta**: tres ja viraram `404 ITEM_NOT_FOUND` depois de alguns dias, e `GET /accounts?itemId=` de item apagado responde **200 com lista vazia**, nao 404 — teste sem guarda falha com "esperado 3, recebido 0" e parece bug de codigo. O id fica em `PLUGGY_TEST_ITEM_ID`, com default no arquivo.
- `PATCH /items/{id}` (forcar atualizacao) e limitado a **1 por hora** por item: `409 CLIENT_IS_UPDATING_BEFORE_ALLOWED_FREQUENCY`. Planejar o teste ponta a ponta em torno disso, ou criar item novo.
- `POST /items` no connector 600 (Sandbox Open Finance) exige CPF com **digito verificador valido** — `12345678900` e recusado com `CONNECTOR_VALIDATION_ERROR`. Mas passar na validacao de formato nao basta: CPF sintetico qualquer volta `LOGIN_ERROR / INVALID_CREDENTIALS`. Reconectar pelo widget e mais rapido que descobrir o CPF que o sandbox aceita.
- Os eventos `transactions/*` sao por conta e caem em invocacoes **isoladas** da Edge Function (um `booted` por evento no log): nao ha estado em memoria que enxergue os irmaos. Agregar exige ponto de encontro externo — hoje a tabela `open_finance_lotes_pendentes` (migration 007). Sem isso, conexao com 3 contas gerava 3 mensagens de WhatsApp.
- O padrao de exclusao mutua entre invocacoes concorrentes e `UPDATE ... WHERE consumido_em IS NULL RETURNING`: o Postgres serializa os UPDATEs na mesma linha e **reavalia o predicado** no READ COMMITTED, entao a segunda transacao atualiza zero linhas. Verificado com duas sessoes psql concorrentes, nao inferido.
- Para decidir "o lote parou de crescer", comparar **contagem** entre duas leituras, nao `now() - criado_em`: o `criado_em` vem do relogio do Postgres e a espera roda no relogio do runtime da Edge Function.
- Migration pode ser aplicada em producao pela Management API (`POST /v1/projects/{ref}/database/query`) com o token de `~/.supabase/access-token`, sem precisar da senha do banco que o `supabase db push` pede. Lembrar de inserir a linha em `supabase_migrations.schema_migrations` na mao, que e o que o `db push` faria.

### Windows / Git Bash

- `MSYS_NO_PATHCONV=1` resolve o destino dentro do container e quebra a origem no host: `docker cp /c/Users/... container:/destino` vira `CreateFile C:\c: file not found`, porque o docker e binario Windows e o caminho MSYS chega cru. Origem no host passa por `cygpath -w`, destino no container fica POSIX. Ver `tests/sql/run_migrations_docker.sh`.
- Argumento com barra inicial e reescrito pelo MSYS para `C:/Program Files/Git/...` em **qualquer** subcomando do docker, nao so no `docker run`: `docker exec ... psql -f /arquivo.sql` vira `psql: error: C:/Program Files/Git/arquivo.sql: No such file or directory`, e `docker cp origem container:/destino` erra o destino. A mensagem sempre parece problema do arquivo, nunca do path. Fazer `export MSYS_NO_PATHCONV=1` uma vez no inicio do script, em vez de prefixar comando a comando e esquecer um.

## Regras De Seguranca

- Nunca commitar credenciais reais.
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` fora de ambientes backend controlados.
- Evitar dados pessoais reais em seeds, fixtures, prints, logs e exemplos.
- CPF deve ser armazenado apenas como hash quando nao houver necessidade legal de guardar o valor bruto.
- Artefatos de OCR e midia devem ter trilha de auditoria, hash e politica de retencao clara.

