# n8n

Workflows exportados do n8n para o MVP TaxMind.

## Versao fixada

- n8n: definir a versao usada na Oracle Cloud VM antes do primeiro deploy produtivo.

## Convencao

- Exporte workflows como JSON para `n8n/workflows/`.
- Nao versionar credenciais reais.
- Use `credentials.example.json` apenas como referencia estrutural.

## Escopo

O webhook publico da Meta fica em `supabase/functions/whatsapp-webhook`.
Essa Edge Function e responsavel por:

- validar assinatura da Meta;
- responder ao desafio de verificacao do webhook;
- tratar o primeiro "Oi" e iniciar onboarding seguro;
- manter a sessao de WhatsApp dentro da janela de 24h;
- normalizar mensagens de texto, imagem e documento antes de encaminhar ao n8n.

O n8n nao deve repetir validacao de assinatura da Meta nem recriar a sessao de
WhatsApp. Ele deve receber eventos ja normalizados pela Edge Function.

Workflows previstos:

- `whatsapp-webhook-ingest.json`: roteador interno para eventos normalizados,
  retry/fallback e distribuicao para OCR ou classificacao textual.
- `receipt-ocr-classification.json`: baixa midia do WhatsApp, executa OCR/visao,
  aplica prompt fiscal e grava evidencias no Supabase.
- `daily-session-cleanup.json`: expira sessoes abertas fora da janela de 24h.
