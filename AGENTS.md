# TaxMind - Contexto Persistente Da IA

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

## Regras De Seguranca

- Nunca commitar credenciais reais.
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` fora de ambientes backend controlados.
- Evitar dados pessoais reais em seeds, fixtures, prints, logs e exemplos.
- CPF deve ser armazenado apenas como hash quando nao houver necessidade legal de guardar o valor bruto.
- Artefatos de OCR e midia devem ter trilha de auditoria, hash e politica de retencao clara.

