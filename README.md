# TaxMind

Copiloto fiscal integrado ao WhatsApp para captura, classificacao e auditoria de despesas dedutiveis.

## Estrutura

- `supabase/`: migrations, seeds, config e edge functions no padrao Supabase CLI.
- `n8n/`: workflows de automacao e documentacao operacional.
- `backend/`: prompts, scripts auxiliares e geracao de dossies.
- `docs/`: notas tecnicas em Markdown para Obsidian.
- `AGENTS.md`: contexto persistente compartilhado para sessoes futuras de IA.
- `CLAUDE.md`: ponte de compatibilidade para Claude Code via import de `AGENTS.md`.

## Limitacoes Conhecidas

Comportamentos decididos, e nao bugs em aberto. Detalhes em
`docs/06 - Follow-up Conversacional.md`.

- **Referencia a despesa antiga sem pendencia aberta.** O bot so sabe a qual
  despesa uma mensagem se refere enquanto existe uma pergunta aberta em
  `followups_pendentes` — a janela e de 30 minutos ou 2 mensagens. Fora dela,
  "corrige a consulta de ontem" ou "o cnpj daquela clinica e X" nao encontra o
  lancamento e cai na mensagem de ajuda. Resolver isso e feature nova
  (identificar a despesa alvo em linguagem natural), nao conserto do follow-up.
- **Midia nunca responde a uma pergunta.** Foto do recibo com o CNPJ pedido
  entra como lancamento novo, e nao como resposta. E deliberado: tratar imagem
  como resposta transformaria um recibo legitimo em patch de outra despesa, e o
  custo do erro e assimetrico — a pendencia ignorada expira sozinha, o
  lancamento perdido nao volta.
