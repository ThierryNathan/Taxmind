# Workflows n8n

Diretorio para exports JSON dos workflows.

Versao n8n alvo: a definir no primeiro ambiente Docker da Oracle Cloud VM.

## Contrato de entrada

Os workflows recebem eventos encaminhados por `supabase/functions/whatsapp-webhook`
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

A `whatsapp-webhook` escolhe o workflow de destino por `message_type`:

| message_type | Variavel de ambiente | Workflow |
| --- | --- | --- |
| `image`, `document` | `N8N_WEBHOOK_URL` | `receipt-ocr-classification` |
| `text` | `N8N_TEXT_WEBHOOK_URL` | `consulta-e-dossie` |

O contrato de payload e identico nos dois casos.

### Terceira origem: Open Finance (Fase 10)

A `pluggy-webhook` encaminha transacoes bancarias para
`N8N_OPENFINANCE_WEBHOOK_URL`, uma variavel separada das duas acima. O
workflow consumidor **ainda nao existe** — a Edge Function ja publica, mas o
proximo passo da fase e desenhar o workflow que classifica e grava essas
transacoes em `recibos_evidencias` com `origem = 'OPEN_FINANCE'`.

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
      "descricao": "FARMACIA EXEMPLO",
      "descricao_original": "COMPRA CARTAO FARMACIA EXEMPLO",
      "valor": 87.4,
      "moeda": "BRL",
      "data_despesa": "2026-07-20",
      "categoria_pluggy": "Pharmacy",
      "estabelecimento": "Farmacia Exemplo",
      "documento_prestador": "00000000000000"
    }
  ]
}
```

`valor` ja vem positivo e so transacoes `DEBIT` e nao pendentes sao
encaminhadas: entrada de dinheiro nao e despesa dedutivel, e transacao pendente
ainda pode mudar de valor depois de gravada.

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
