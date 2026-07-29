# Workflows n8n

Diretorio para exports JSON dos workflows.

Versao n8n alvo: a definir no primeiro ambiente Docker da Oracle Cloud VM.

## Contrato de entrada

Os workflows recebem eventos encaminhados por `supabase/functions/whatsapp-webhook` (deprecado)
com o formato:

```json
{
  "source": "whatsapp-cloud-api",
  "event_type": "inbound_message",
  "session_id": "uuid da linha em sessoes_whatsapp ou null",
  "normalized": {
    "message_id": "wamid...",
    "wa_id": "5511999999999",
    "phone": "+5511999999999",
    "profile_name": "Nome",
    "message_type": "text|image|document",
    "text_body": "texto ou null",
    "media_id": "id da midia ou null",
    "media_mime_type": "image/jpeg ou application/pdf",
    "media_sha256": "hash enviado pela Meta ou null",
    "media_filename": "arquivo.pdf ou null",
    "media_caption": "legenda ou null",
    "received_at": "2026-07-09T12:00:00.000Z"
  },
  "raw_value": {}
}
```

## Roteamento na origem

A `whatsapp-webhook` (deprecado) escolhe o workflow de destino por `message_type`:

| message_type | Variavel de ambiente | Workflow |
| --- | --- | --- |
| `image`, `document` | `N8N_WEBHOOK_URL` | `receipt-ocr-classification` |
| `text` | `N8N_TEXT_WEBHOOK_URL` | `consulta-e-dossie` |

O contrato de payload e identico nos dois casos.

### Terceira origem: Open Finance (Fase 10)

A `pluggy-webhook` encaminha transacoes bancarias para
`N8N_OPENFINANCE_WEBHOOK_URL`, uma variavel separada das duas acima, consumida
por `openfinance-transacoes.json`.

Por que nao reaproveitar `N8N_TEXT_WEBHOOK_URL`: o `consulta-e-dossie` resolve
`usuario_id` consultando `sessoes_whatsapp` por `session_id` e le
`normalized.text_body` para achar a intencao. Uma transacao bancaria nao tem
sessao de WhatsApp nem texto de usuario, entao o node `Montar Contexto` falharia
com "sessao sem usuario_id vinculado" em toda transacao. Alem disso o payload
ja chega com `usuario_id` resolvido e sem intencao a classificar — o que falta
e classificacao fiscal, trabalho do fluxo de recibo, nao do roteador de texto.

Formato encaminhado (um POST por sincronizacao, com todas as transacoes novas):

```json
{
  "source": "pluggy-open-finance",
  "event_type": "transacoes_sincronizadas",
  "usuario_id": "uuid do usuario TaxMind",
  "item_id": "id do item no Pluggy",
  "sincronizado_desde": "2026-06-25",
  "total": 2,
  "transacoes": [
    {
      "usuario_id": "uuid",
      "item_id": "...",
      "transaction_id": "...",
      "account_id": "...",
      "conta_nome": "Conta Corrente",
      "conta_tipo": "BANK",
      "status_pluggy": "POSTED",
      "descricao": "FARMACIA EXEMPLO",
      "descricao_original": "COMPRA CARTAO FARMACIA EXEMPLO",
      "valor": 87.4,
      "moeda": "BRL",
      "data_despesa": "2026-07-20",
      "categoria_pluggy": "Pharmacy",
      "categoria_pluggy_id": "18020000",
      "estabelecimento": "Farmacia Exemplo",
      "documento_prestador": "00000000000000"
    }
  ]
}
```

`valor` ja vem positivo e so transacoes `DEBIT` sao encaminhadas: entrada de
dinheiro nao e despesa dedutivel. Em conta CREDIT o `DEBIT` tambem chega com
`amount` positivo, ao contrario de conta BANK — a Edge Function normaliza o
sinal antes de mandar.

`status_pluggy` distingue `POSTED` de `PENDING`, e a regra de PENDING depende do
tipo da conta:

| `conta_tipo` | PENDING | Por que |
| --- | --- | --- |
| `BANK` | descartada | dura minutos e ainda pode mudar de valor; esperar o POSTED e barato |
| `CREDIT` | **encaminhada** | numa fatura de cartao a compra fica PENDING ate o ciclo fechar; descartar apagaria a maior parte das compras do mes |

Consequencia pratica para quem le `recibos_evidencias`: uma linha de cartao com
`status_pluggy = "PENDING"` tem valor provisorio. Quando ela vira POSTED, o
Pluggy dispara `transactions/updated` e a transacao e reenviada — mas a
deduplicacao a trata como ja gravada e **o valor no banco nao e atualizado**.
Ver limitacoes conhecidas no fim desta secao.

### Eventos que produzem este payload

A `pluggy-webhook` monta o **mesmo envelope** para quatro eventos do Pluggy, de
proposito: assim o workflow nao precisa saber qual deles disparou.

| Evento do Pluggy | Escopo | Como as transacoes sao buscadas |
| --- | --- | --- |
| `item/updated` | item inteiro | todas as contas do item, `dateFrom` = `ultima_sincronizacao_em` |
| `transactions/created` | uma conta | `/v2/transactions` com `createdAtFrom` = `transactionsCreatedAtFrom` do evento |
| `transactions/updated` | uma conta | `GET /transactions/{id}` para cada id de `transactionIds` |
| `transactions/deleted` | uma conta | **nao implementado** (ver abaixo) |

Nos eventos por conta, `sincronizado_desde` e a `data_despesa` mais antiga do
proprio lote — nao existe janela de item ali, e esse valor e o piso correto para
a consulta de deduplicacao. `ultima_sincronizacao_em` **nao** e avancada por
evento de conta: ela e a janela do item inteiro, e move-la a partir de uma conta
so faria as demais pularem transacao.

### Janela de agregacao: N contas, UMA mensagem

Os eventos `transactions/*` sao por **conta**. Uma conexao com conta corrente,
poupanca e cartao dispara tres webhooks em ~1s a ~2s, e cada um cai numa
invocacao **isolada** da Edge Function. Como o workflow manda uma mensagem de
WhatsApp por execucao, isso produzia tres confirmacoes seguidas — "25 despesas",
"25 despesas", "23 despesas" — em vez de uma dizendo 73.

A `pluggy-webhook` agora agrega antes de encaminhar, usando a tabela
`open_finance_lotes_pendentes` (migration 007) como ponto de encontro entre as
invocacoes:

1. cada evento grava seu lote ja normalizado no buffer;
2. espera ~5s e depois observa a **contagem** de lotes pendentes do item ate ela
   parar de crescer (contagem, e nao timestamp: o `criado_em` e do relogio do
   Postgres e a espera roda no relogio do runtime da Edge Function);
3. todas disputam um `UPDATE ... WHERE consumido_em IS NULL RETURNING`. O
   Postgres serializa os UPDATEs concorrentes e reavalia o predicado, entao
   exatamente uma invocacao leva as linhas e encaminha; as demais levam zero
   linhas e saem em silencio.

**Do lado do n8n nao muda nada:** o envelope entregue e o mesmo, so que com as
transacoes das N contas juntas e `total` somado. Conexao de uma conta so
continua gerando um encaminhamento, apenas ~5s mais tarde.

Efeito colateral util: transacao repetida entre `transactions/created` e
`transactions/updated` da mesma janela e desduplicada por `transaction_id`
**antes** do POST, entao o pre-filtro e o Gemini nao veem a mesma transacao
duas vezes no mesmo lote.

Se o buffer falhar (erro de insert), a function encaminha direto, sem agregar —
degradacao para o comportamento antigo. Tres mensagens e um problema de UX;
transacao perdida e um problema de dado.

Nota sobre `transactions/created`: o evento traz um `createdTransactionsLink`
pronto, que a Edge Function **nao** usa. O link aponta para a colecao
`/transactions`, desativada (410 `ENDPOINT_DEPRECATED`); a consulta e remontada
em `/v2/transactions` com o mesmo `accountId` + `createdAtFrom`. Detalhe que nao
da para trocar por conta propria: `createdAtFrom` filtra por quando o registro
entrou na base do Pluggy, enquanto `dateFrom` filtra pela data da compra. Numa
fatura de cartao as duas diferem por dias, e usar `dateFrom` com a janela do
evento descarta exatamente a transacao que acabou de chegar.

### Limitacoes conhecidas

- **`transactions/deleted` nao remove nada.** O evento e recebido e registrado
  em log, mas nao ha caminho de exclusao em `recibos_evidencias`. Uma transacao
  que o banco estorne ou cancele depois de sincronizada **continua no dossie**.
  Implementar exige decidir antes se a evidencia e apagada ou marcada como
  cancelada — apagar registro fiscal e operacao com trilha de auditoria propria,
  nao efeito colateral de webhook.
- **`transactions/updated` nao atualiza valor.** O reenvio chega ao workflow,
  mas a deduplicacao por `transaction_id` descarta a transacao como ja gravada.
  Uma compra de cartao gravada em PENDING e depois ajustada pelo banco fica com
  o valor antigo. Resolver isso exige trocar o insert
  `resolution=ignore-duplicates` por um upsert, e ha o efeito colateral de
  sobrescrever a classificacao ja revisada por humano.

## receipt-ocr-classification.json

Recebe o payload acima, roteia por `normalized.message_type` (classificacao
visual e textual via `gemini-3-flash-preview`), grava o resultado em
`recibos_evidencias` e responde ao usuario no WhatsApp. Usa o prompt de
`backend/prompts/taxmind_system_prompt.js` embutido no node `Preparar Contexto`
(mantenha os dois arquivos em sincronia manualmente ao editar o prompt).

Webhook path: `receipt-ocr-classification`.

Variaveis de ambiente esperadas no processo do n8n (configuradas fora do
JSON do workflow, nunca commitadas):

- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- `GEMINI_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

O node `Supabase - Buscar usuario_id da Sessao` falha propositalmente se a
sessao ainda nao tiver `usuario_id` vinculado (usuario nao concluiu o
onboarding via `bootstrap-identity`). Upload do arquivo original para bucket
seguro (ver `AGENTS.md`) ainda nao esta implementado neste workflow.

## consulta-e-dossie.json

Webhook path: `consulta-dossie`. Recebe apenas mensagens de texto e resolve a
intencao em duas etapas, da mais barata para a mais cara:

1. `Preparar Contexto` tenta casar palavra-chave sem acento e sem caixa
   (`resumo`/`extrato`/`quanto tenho` e `dossie`/`relatorio`/`pdf`/`exportar`).
   Termos de dossie tem precedencia, porque "resumo" tambem aparece em
   "manda o resumo em pdf", onde a intencao real e o arquivo.
2. So quando nada casa, `Gemini - Classificar Intent` decide entre
   `registro_despesa`, `consulta_resumo`, `exportar_dossie` e `outro`.

Sobre a config do Gemini neste workflow: `gemini-3-flash-preview` nao aceita
`thinkingBudget` (parametro da geracao 2.5) e nao permite desligar thinking,
so reduzir via `thinkingLevel`. Usamos `thinkingLevel: "low"` com
`maxOutputTokens: 512` — com teto muito baixo os tokens de thinking consomem
o orcamento e a resposta volta vazia. `Aplicar Intent da IA` trata esse caso
caindo em `outro`, que responde a mensagem de ajuda em vez de derrubar a
execucao.

Destinos do `Switch por Intent`:

| intent | Acao |
| --- | --- |
| `registro_despesa` | Reencaminha o payload original para `RECEIPT_WORKFLOW_WEBHOOK_URL`. A classificacao fiscal nao e duplicada aqui. |
| `consulta_resumo` | RPC `resumo_fiscal_usuario`, formata com emoji por categoria e envia texto. |
| `exportar_dossie` | Chama a Edge Function `generate-dossier` e envia o PDF como `type: "document"` com a signed URL em `document.link`. |
| `outro` | Mensagem de ajuda fixa. |
| `fora_do_escopo_financeiro` | Mensagem fixa delimitando o escopo do produto. |
| `conectar_banco` | Chama a Edge Function `pluggy-connect-link` e envia o link assinado de conexao bancaria. |

O matcher de palavra-chave do `conectar_banco` exige **dois eixos** na mesma
mensagem: um verbo de conexao (`conect`, `vincul`, `sincroniz`) e um
substantivo de conta/banco (`banco`, `conta`, `bancari`, `cartao`), ou o termo
`open finance` sozinho. Casar so "conta" ou so "banco" roubaria mensagens que
pertencem a outros branches — "me manda o resumo da minha conta" e "quanto
rende o CDB do meu banco". Ha ainda uma guarda para `desconect`/`desvincul`,
porque `conect` casa dentro de "desconectar" e desconexao nao esta
implementada (cai na IA).

Variaveis de ambiente adicionais no processo do n8n:

- `RECEIPT_WORKFLOW_WEBHOOK_URL` (webhook do `receipt-ocr-classification`)
- `SUPABASE_SECRET_KEY_SB_FORMAT` (ja usada pelo node do dossie; o node
  `Edge - Gerar Link Conectar Banco` usa a mesma chave, no mesmo formato
  `sb_secret_...`)

O lookup de `usuario_id` segue o mesmo padrao do outro workflow: consulta
`sessoes_whatsapp` por `session_id` (nao por `wa_id`) e falha explicitamente
quando o vinculo nao existe.

## openfinance-transacoes.json

Webhook path: `openfinance-transacoes`. Consome o payload da `pluggy-webhook`,
classifica fiscalmente e grava em `recibos_evidencias` com
`origem = 'OPEN_FINANCE'` e **sem** `sessao_whatsapp_id` — nao existe conversa
de WhatsApp nesta origem.

> **Este arquivo ainda nao e um export vivo.** Ele foi escrito fora do n8n para
> o primeiro import. A partir do momento em que for importado e salvo na
> instancia, passa a carregar id de node, `webhookId`, `versionId` e ajustes de
> UI, e vale a regra do `AGENTS.md`: **editar cirurgicamente, nunca regenerar
> por script**. Regenerar depois do primeiro import descarta ajuste manual e faz
> o import criar um workflow novo em vez de atualizar o existente.

### Entrada

Aceita as tres formas sem mudanca de logica downstream: o envelope com
`transacoes: [...]` (o que a `pluggy-webhook` manda hoje), um array cru de
transacoes, ou uma transacao solta no corpo. O node `Preparar Lote` normaliza
os tres num item unico — de proposito, porque node HTTP roda uma vez por item
de entrada e fanar antes dos lookups viraria N consultas identicas ao Supabase.

### Resolucao de usuario_id

O payload **ja chega com `usuario_id` resolvido**: a `pluggy-webhook` faz esse
trabalho antes de encaminhar (`open_finance_items`, com backfill pelo
`clientUserId` do item). O node `Supabase - Resolver Item e Usuario` existe por
dois outros motivos: e o fallback quando o campo nao vem (payload montado a
mao, replay de evento antigo) e e de onde saem o `connector_nome` e o
`telefone_whatsapp` — o payload nao carrega telefone e sem ele nao ha para onde
mandar o resumo. Usa recurso embutido do PostgREST
(`select=usuario_id,connector_nome,usuarios(telefone_whatsapp)`) para resolver
tudo numa consulta so.

### Pre-filtro por categoria da Pluggy

Antes de chamar o Gemini, o node `Montar Fila de Transacoes` tenta resolver a
transacao so pela categoria do agregador. O que casa vira `NAO_DEDUTIVEL` com
`confidence_score` 0.95 e `requer_revisao_humana` false, sem chamada de IA.

O casamento e por **`categoria_pluggy_id`** (ex.: `18020000`), nao pelo rotulo
em ingles: o id e hierarquico (2 primeiros digitos = categoria de topo, 4
primeiros = subcategoria) e estavel, enquanto `category` e texto de exibicao
que a Pluggy pode renomear sem quebrar contrato. A taxonomia completa (130
categorias) sai de `GET https://api.pluggy.ai/categories`.

**Principio da lista: falso negativo e pior que chamada de IA desperdicada.**
Descartar algo dedutivel some em silencio do dossie do usuario; uma chamada
extra ao Gemini custa centavos. Por isso **o default e mandar para a IA** —
categoria nula, id ausente, categoria ambigua ou categoria nova que a Pluggy
venha a criar caem todas no caminho da IA. So o que esta na tabela abaixo e
descartado.

| Prefixo do id | Categoria Pluggy | Motivo |
| --- | --- | --- |
| `04` | Same person transfer (CASH/PIX/TED) | transferencia entre contas do proprio titular: nao e despesa |
| `05060000` | Transfer - Internal | idem |
| `05100000` | Credit card payment | pagamento de fatura; as compras do cartao ja entram uma a uma, contar a fatura duplicaria |
| `01` | Income | entrada de dinheiro |
| `03` | Investments | aplicacao ou resgate, nao despesa |
| `08090000` | Cashback | bonificacao recebida |
| `08` (menos `08080000`) | Shopping | consumo pessoal |
| `09` | Digital services | jogo e streaming |
| `10` | Groceries | supermercado |
| `11` | Food and drinks | restaurante, bar, delivery |
| `12030000` | Mileage programs | pontuacao, nao despesa |
| `14` | Gambling | nunca dedutivel |
| `21` | Leisure | nunca dedutivel |
| `0703` | Wellness and fitness | academia nao e dedutivel no IRPF |
| `0704` | Tickets | estadio, museu, cinema, teatro |

Excecao explicita: **`08080000` Office supplies** fica dentro de `08` mas vai
para a IA — material de escritorio pode entrar no livro-caixa do autonomo.

Vao **sempre** para o Gemini, entre outras: `18` Healthcare inteiro,
`200300000` Health insurance, `0702` Education, `02030003` Student loan,
`06020000` Alimony, `15` Taxes, `16` Bank fees, `0701` Telecommunications,
`17` Housing, `19` Transportation, `12` Travel (viagem a trabalho e
livro-caixa), `0509` transferencias a terceiros (PIX para medico e despesa
dedutivel comum) e `13` Donations.

Tres entradas da tabela sao deliberadamente discutiveis e faceis de mover:
**`08020000` Electronics** (notebook de autonomo e EQUIPAMENTOS),
**`08060000` Bookstore** (literatura profissional) e **`0703` Gyms** — nesta
ultima o workflow diverge de proposito do `TAXMIND_SYSTEM_PROMPT`, que manda
academia para revisao humana; aqui descarta, para nao inundar a fila de revisao.

**Para ajustar a lista:** edite `CATEGORIAS_SEM_IA` / `EXCECOES_PARA_IA` no node
`Montar Fila de Transacoes` e replique a mudanca nesta tabela.

Degradacao segura: se a `pluggy-webhook` nao estiver redeployada e nao mandar
`categoria_pluggy_id`, o pre-filtro nao casa nada e tudo vai para o Gemini.
Custa mais, nunca classifica errado.

### Lote e rate limit

`Precisa de Classificacao IA?` separa os dois ramos. So o ramo da IA passa pelo
`Lotes para o Gemini` (Split in Batches, 8 por lote) com `Aguardar Entre Lotes`
(Wait, 2s) na volta — o ramo do pre-filtro, que numa conta real e a maioria,
pula o loop inteiro. O node do Gemini tem `retryOnFail` com 3 tentativas e 5s
de intervalo, para o 429 que escapar do espacamento.

Os dois ramos se juntam em `Juntar Classificacoes` (Merge, append).

### Deduplicacao

Em duas camadas, e a principal e a **primeira**:

1. `Supabase - Transacoes Ja Gravadas` consulta os `transaction_id` que ja
   existem para aquele item na janela sincronizada, e `Montar Fila de
   Transacoes` tira do lote o que ja esta gravado — assim tambem **nao se paga
   IA por transacao repetida**. Isso importa mais do que parece: o `from` da
   `pluggy-webhook` e truncado em dia, entao todo `item/updated` reenvia o dia
   corrente inteiro. Duplicata e o caminho normal, nao caso de borda.
2. `Prefer: resolution=ignore-duplicates` no insert e a rede de seguranca para
   a corrida entre dois webhooks do mesmo item. Note que o indice unico da
   migration 005 e **parcial e sobre expressao**
   (`(usuario_id, dados_open_finance->>'transaction_id')`), e o `on_conflict` do
   PostgREST so nomeia colunas — nao da para apontar esse indice. Se um
   conflito escapar da camada 1, o insert falha e a execucao aparece com erro
   no n8n, que e o comportamento desejado: melhor barulho do que gravacao
   silenciosamente perdida.

### Gravacao

Um unico POST com o array inteiro, nao uma requisicao por transacao.

`valor` e `data_despesa` vem **do extrato, nunca da IA**: o banco e a fonte de
verdade e o modelo so foi chamado para classificar. Deixar o numero do LLM
entrar ali abriria espaco para valor alucinado num dossie que vai para a
Receita. `categoria` e `deducibilidade` sao validados contra os enums do
Postgres antes do insert — valor fora da lista derrubaria o lote inteiro com
22P02.

### Notificacao

**UMA** mensagem por sincronizacao, montada em `Montar Resumo`. Mensagem por
transacao numa carga inicial de 200 seria uma enchente no WhatsApp do usuario e
provavelmente um bloqueio do numero pela Meta.

O texto do periodo e derivado de `sincronizado_desde`, nao fixo: a janela
inicial hoje e `JANELA_INICIAL_DIAS = 30` na `pluggy-webhook`, e sincronizacao
incremental cobre so alguns dias. Cravar "ultimos 12 meses" viraria mentira na
primeira vez que alguem mexesse nessa constante.

Quando nao sobra nada novo depois da deduplicacao, o workflow **para sem
mandar mensagem** — avisar "classifiquei 0 despesas" a cada re-sincronizacao do
dia seria exatamente o spam que o fluxo evita.

Caveat operacional conhecido: a mensagem e texto livre, entao depende da janela
de 24h da Meta estar aberta. Uma sincronizacao que caia fora da janela vai
falhar no envio. Resolver isso exige template aprovado, que ainda nao existe.

### Verificacao ja feita

Rodado no n8n 1.99.1 (a versao fixada no `docker-compose.yml`), em instancia
descartavel, com Supabase e Graph API mockados e Gemini real:

- payload misto: os dois ramos ativos, Merge devolvendo os itens dos dois;
- **payload 100% pre-filtrado** (o caso do sandbox): `Lotes para o Gemini` com
  zero execucoes e o Merge disparando assim mesmo — era o risco de desenho;
- payload 100% IA: espelho do anterior;
- transacao solta sem envelope;
- 20 transacoes: 3 lotes de 8/8/4, 3 esperas, **1** insert.

Nao exercitado ainda: conflito real no indice unico, e a janela de 24h da Meta.

Variaveis de ambiente esperadas no processo do n8n: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID` — todas ja usadas pelos outros workflows. Nenhuma
variavel nova.
