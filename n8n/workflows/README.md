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
