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

Variaveis de ambiente adicionais no processo do n8n:

- `RECEIPT_WORKFLOW_WEBHOOK_URL` (webhook do `receipt-ocr-classification`)

O lookup de `usuario_id` segue o mesmo padrao do outro workflow: consulta
`sessoes_whatsapp` por `session_id` (nao por `wa_id`) e falha explicitamente
quando o vinculo nao existe.
