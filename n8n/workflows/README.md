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

## receipt-ocr-classification.json

Recebe o payload acima, roteia por `normalized.message_type` (OCR via
`gpt-4o` para `image`/`document`, classificacao textual via `gpt-4o-mini`
para `text`), grava o resultado em `recibos_evidencias` e responde ao
usuario no WhatsApp. Usa o prompt de `backend/prompts/taxmind_system_prompt.js`
embutido no node `Preparar Contexto` (mantenha os dois arquivos em sincronia
manualmente ao editar o prompt).

Variaveis de ambiente esperadas no processo do n8n (configuradas fora do
JSON do workflow, nunca commitadas):

- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
- `OPENAI_API_KEY`
- `SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`

O node `Supabase - Buscar usuario_id da Sessao` falha propositalmente se a
sessao ainda nao tiver `usuario_id` vinculado (usuario nao concluiu o
onboarding via `bootstrap-identity`). Upload do arquivo original para bucket
seguro (ver `AGENTS.md`) ainda nao esta implementado neste workflow.
