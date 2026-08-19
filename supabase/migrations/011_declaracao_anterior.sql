-- Fase 17 - Import da declaracao de IRPF do ano anterior.
--
-- Estado encontrado antes desta migration (conferido na 001, 009 e 010, nao
-- assumido):
--   - followups_pendentes existe com campo_alvo restrito por
--     followups_campo_alvo_chk aos tres campos de recibo
--     ('documento_prestador', 'estabelecimento', 'valor_reembolso');
--   - followups_pendentes.recibo_id e NOT NULL e referencia
--     recibos_evidencias(id);
--   - public.set_atualizado_em() existe (001) e e reaproveitada aqui;
--   - o schema tem ALTER DEFAULT PRIVILEGES concedendo ALL em tabela nova a
--     anon e authenticated (ver AGENTS.md), entao toda tabela nova precisa de
--     revoke explicito.
--
-- Duas mudancas.
--
-- 1. campo_alvo aceita 'declaracao_anterior'.
--
-- Mesma tabela followups_pendentes, e nao uma segunda nocao de pendencia. O
-- raciocinio e o mesmo que a 010 registrou para valor_reembolso: TTL, orcamento
-- de mensagens, SUPERSEDIDA, exclusao mutua e a anotacao que a whatsapp-webhook
-- poe em toda mensagem sao por PENDENCIA, nao por tipo de campo. Uma tabela
-- separada duplicaria as seis coisas e criaria a pergunta insoluvel "qual das
-- duas tem a pendencia aberta?".
--
-- DIFERENCA IMPORTANTE em relacao aos outros tres campos: este nao pergunta
-- sobre um recibo, pergunta sobre um ARQUIVO que o usuario vai enviar. Como
-- recibo_id e NOT NULL e o import nao tem recibo, a coluna passa a aceitar NULL
-- exatamente neste caso — e a constraint abaixo amarra os dois estados para que
-- "pendencia de recibo sem recibo" continue impossivel.
--
-- 2. declaracoes_anteriores, com chave (usuario_id, ano_calendario).
--
-- Por que tabela propria e nao colunas em usuarios:
--   a) a chave natural e (usuario_id, ano_calendario) — da para importar 2024 e
--      2025. Coluna em usuarios forcaria uma linha so e a segunda importacao
--      apagaria a primeira em silencio;
--   b) e dado derivado de EVIDENCIA, e o AGENTS.md exige trilha de auditoria e
--      hash para isso. Em usuarios o dado fiscal se misturaria com identidade e
--      a politica de retencao ficaria sem lugar para morar;
--   c) RLS e revoke proprios.
--
-- O PDF NAO e guardado. Ele carrega renda, dependentes e bens — muito alem dos
-- campos que usamos. Guardamos o hash SHA-256 (prova de que a extracao veio de
-- um arquivo especifico) e descartamos o arquivo, que e uma politica mais
-- restritiva que a de midia de recibo e proposital.

-- 1 -------------------------------------------------------------------------

alter table public.followups_pendentes
  alter column recibo_id drop not null;

alter table public.followups_pendentes
  drop constraint if exists followups_campo_alvo_chk;
alter table public.followups_pendentes
  add constraint followups_campo_alvo_chk
  check (
    campo_alvo in (
      'documento_prestador', 'estabelecimento', 'valor_reembolso',
      'declaracao_anterior'
    )
  );

-- Amarra os dois mundos: pendencia de recibo EXIGE recibo, pendencia de
-- declaracao NAO pode ter recibo. Sem isto, afrouxar o NOT NULL acima abriria a
-- porta para pendencia de CNPJ orfa, que e justamente o que a 009 evitava.
alter table public.followups_pendentes
  drop constraint if exists followups_recibo_conforme_campo_chk;
alter table public.followups_pendentes
  add constraint followups_recibo_conforme_campo_chk
  check (
    (campo_alvo = 'declaracao_anterior' and recibo_id is null)
    or (campo_alvo <> 'declaracao_anterior' and recibo_id is not null)
  );

comment on column public.followups_pendentes.campo_alvo is
  'O que foi perguntado. documento_prestador e estabelecimento identificam o prestador; valor_reembolso pergunta se um plano devolveu parte da despesa de saude; declaracao_anterior aguarda o PDF da declaracao do ano anterior e nao tem recibo associado.';

comment on column public.followups_pendentes.recibo_id is
  'Recibo a que a pergunta se refere. NULL apenas quando campo_alvo = declaracao_anterior, que pergunta por um arquivo e nao por um lancamento (followups_recibo_conforme_campo_chk amarra os dois casos).';

-- 2 -------------------------------------------------------------------------

create table if not exists public.declaracoes_anteriores (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  ano_calendario smallint not null,
  -- SIMPLIFICADO ou COMPLETO: a opcao pela qual a declaracao FOI APRESENTADA,
  -- e nao o outro bloco que o PDF mostra ao lado para comparacao.
  modelo text not null,
  -- Em pontos percentuais (11.74 = 11,74%), como o PDF exibe. NULL quando o
  -- documento nao trouxe o campo: e melhor nao ter estimativa do que ter uma
  -- estimativa inventada.
  aliquota_efetiva numeric(5, 2),
  -- Quando o proprio PDF traz o imposto ja calculado pela Receita, ele entra
  -- aqui e vira o baseline, sem risco de erro de calculo nosso.
  imposto_devido numeric(14, 2),
  base_calculo numeric(14, 2),
  rendimentos_tributaveis numeric(14, 2),
  -- Categorias da ficha "Pagamentos Efetuados" que apareceram com valor. Lista
  -- vazia = ficha vazia (fato), e nao "nao sabemos".
  categorias_pagamentos text[] not null default '{}',
  -- Detalhe por codigo da ficha, para o contador conferir. Fica em jsonb porque
  -- o conjunto de codigos muda por ano e nao vale uma tabela filha.
  pagamentos_detalhados jsonb not null default '[]'::jsonb,
  confianca text not null default 'MEDIA',
  motivos_revisao text[] not null default '{}',
  -- Prova de qual arquivo gerou esta linha, sem guardar o arquivo.
  arquivo_hash_sha256 text not null,
  arquivo_nome text,
  versao_prompt text,
  extraido_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint declaracoes_modelo_chk check (modelo in ('SIMPLIFICADO', 'COMPLETO')),
  constraint declaracoes_confianca_chk check (confianca in ('ALTA', 'MEDIA', 'BAIXA')),
  -- 1900 nao e paranoia de data: e o piso que impede um OCR ruim gravar ano 3
  -- ou 20260. O teto acompanha o ano corrente com folga de um ano.
  constraint declaracoes_ano_chk
    check (ano_calendario between 1900 and (extract(year from now())::int + 1)),
  constraint declaracoes_aliquota_chk
    check (aliquota_efetiva is null or (aliquota_efetiva >= 0 and aliquota_efetiva <= 100)),
  constraint declaracoes_valores_nao_negativos_chk
    check (
      (imposto_devido is null or imposto_devido >= 0)
      and (base_calculo is null or base_calculo >= 0)
      and (rendimentos_tributaveis is null or rendimentos_tributaveis >= 0)
    )
);

comment on table public.declaracoes_anteriores is
  'Baseline extraido do PDF da declaracao de IRPF de um ano anterior, enviado pelo proprio titular. O PDF NAO e guardado: fica so o hash SHA-256 do arquivo que gerou a linha. Uma linha por (usuario, ano-calendario); reimportar o mesmo ano substitui a linha.';

comment on column public.declaracoes_anteriores.aliquota_efetiva is
  'Aliquota efetiva sobre os rendimentos tributaveis, em pontos percentuais, como o PDF exibe. Usada para ESTIMAR economia no resumo, sempre com ressalva de dado historico.';

comment on column public.declaracoes_anteriores.arquivo_hash_sha256 is
  'SHA-256 do PDF recebido. Existe para a trilha de auditoria responder "de qual arquivo saiu este numero" sem reter o documento, que carrega renda, dependentes e bens.';

-- Reimportar o mesmo ano substitui: o dado mais novo veio de um arquivo mais
-- novo. O upsert da Edge Function depende deste indice.
create unique index if not exists idx_declaracoes_usuario_ano
  on public.declaracoes_anteriores (usuario_id, ano_calendario);

drop trigger if exists trg_declaracoes_anteriores_atualizado_em on public.declaracoes_anteriores;
create trigger trg_declaracoes_anteriores_atualizado_em before update on public.declaracoes_anteriores
for each row execute function public.set_atualizado_em();

alter table public.declaracoes_anteriores enable row level security;

-- Ler a propria declaracao e transparencia. Escrita e exclusiva das Edge
-- Functions via service_role: o titular editar a propria aliquota efetiva
-- mudaria a estimativa que o produto apresenta.
drop policy if exists "declaracoes_select_proprias" on public.declaracoes_anteriores;
create policy "declaracoes_select_proprias" on public.declaracoes_anteriores
for select to authenticated using (usuario_id = auth.uid());

-- Mesmo motivo dos revokes em 006, 008 e 009: tabela nova nasce com ALL para
-- anon e authenticated por causa do ALTER DEFAULT PRIVILEGES do projeto.
revoke all on public.declaracoes_anteriores from anon, authenticated;
grant select on public.declaracoes_anteriores to authenticated;
grant select, insert, update, delete on public.declaracoes_anteriores to service_role;
