# TaxMind

Copiloto fiscal integrado ao WhatsApp para captura, classificacao e auditoria de despesas dedutiveis.

## Estrutura

- `supabase/`: migrations, seeds, config e edge functions no padrao Supabase CLI.
- `n8n/`: workflows de automacao e documentacao operacional.
- `backend/`: prompts, scripts auxiliares e geracao de dossies.
- `docs/`: notas tecnicas em Markdown para Obsidian.
- `AGENTS.md`: contexto persistente compartilhado para sessoes futuras de IA.
- `CLAUDE.md`: ponte de compatibilidade para Claude Code via import de `AGENTS.md`.
