# TaxMind - Contexto Persistente da IA

## Produto

TaxMind e um copiloto fiscal B2B2C integrado ao WhatsApp para profissionais autonomos, pequenos empreendedores e contadores parceiros.

O MVP automatiza captura, OCR, classificacao fiscal, trilha de auditoria e consolidacao de evidencias dedutiveis ao longo do ano.

## Stack Principal

- Interface conversacional: WhatsApp Cloud API via webhooks oficiais da Meta.
- Orquestracao: n8n em Docker, previsto para Oracle Cloud VM Linux Ampere A1.
- IA: OpenAI API, com modelo leve para texto/classificacao e modelo com visao para OCR inteligente.
- Persistencia e autenticacao: Supabase/PostgreSQL com RLS.
- Backend auxiliar: Python/Node.js para relatorios, consolidacao e scripts operacionais.

## Convencoes Do Repositorio

- `supabase/` segue a convencao nativa do Supabase CLI.
- `n8n/workflows/` guarda exports JSON versionados dos workflows.
- `backend/prompts/` guarda prompts de producao.
- `docs/` guarda notas Markdown compatíveis com Obsidian usando links internos.
- `scripts/` guarda utilitarios repetiveis de setup e seed.

## Decisoes Arquiteturais

- RLS deve isolar dados por `auth.uid()`.
- Webhooks e automacoes backend podem usar `service_role`, mas a chave nunca deve aparecer em frontend, app mobile, mockup ou workflow publico.
- Midias recebidas pelo WhatsApp devem ser processadas, gravadas em bucket seguro e expurgadas do contexto temporario assim que possivel.
- Despesas com baixa confianca ou alto risco fiscal devem entrar em fila de revisao humana.

