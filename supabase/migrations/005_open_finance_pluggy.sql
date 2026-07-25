-- Fase 10 - Open Finance via Pluggy.
--
-- Estado encontrado antes desta migration (conferido na 001, nao assumido):
--   - public.origem_evidencia JA contem 'OPEN_FINANCE'. O ADD VALUE abaixo e
--     idempotente e existe so para o caso de um banco divergente do repo.
--   - arquivo_bucket, arquivo_path e arquivo_hash_sha256 JA nascem nullable na
--     001. Os DROP NOT NULL abaixo sao no-op no schema atual; ficam explicitos
--     porque a garantia importa para esta fase (transacao bancaria nao tem
--     cupom fotografado) e um banco remoto pode ter divergido.
--   - Nao existe coluna media_id em recibos_evidencias. O media_id do WhatsApp
--     vive em metadados_ocr, entao nao ha o que afrouxar aqui.
--
-- O que de fato muda:
--   1. dados_open_finance jsonb, para o payload da transacao do Pluggy.
--   2. Indices de consulta por origem e de deduplicacao por transacao.
--   3. Tabela open_finance_items, que liga um item do Pluggy a um usuario.

-- 1. Enum de origem -------------------------------------------------------

alter type public.origem_evidencia add value if not exists 'OPEN_FINANCE';

-- 2. recibos_evidencias ---------------------------------------------------

alter table public.recibos_evidencias
  alter column arquivo_bucket drop not null,
  alter column arquivo_path drop not null,
  alter column arquivo_hash_sha256 drop not null;

-- Guarda o payload relevante da transacao (transaction_id, account_id,
-- item_id, connector, moeda, tipo) sem exigir uma coluna nova por campo. Segue
-- a mesma convencao de metadados_ocr/metadados_ia: not null com default '{}'.
alter table public.recibos_evidencias
  add column if not exists dados_open_finance jsonb not null default '{}'::jsonb;

comment on column public.recibos_evidencias.dados_open_finance is
  'Payload estruturado da transacao Open Finance (Pluggy): transaction_id, account_id, item_id, connector e afins. Vazio para evidencias de outras origens.';

-- Consulta futura do tipo "todas as despesas que vieram do banco, mais
-- recentes primeiro". Sem literal de enum no predicado de proposito: um
-- ADD VALUE e o uso do mesmo valor nao podem coexistir na mesma transacao,
-- e migration do Supabase roda em transacao.
create index if not exists idx_recibos_usuario_origem_data
  on public.recibos_evidencias (usuario_id, origem, data_despesa desc);

-- Deduplicacao. O Pluggy reenvia webhook em caso de falha, e o mesmo
-- item/updated pode trazer uma transacao ja importada. Sem esta unique, cada
-- retry viraria uma despesa duplicada no dossie do usuario.
create unique index if not exists idx_recibos_open_finance_transacao
  on public.recibos_evidencias (usuario_id, (dados_open_finance ->> 'transaction_id'))
  where (dados_open_finance ->> 'transaction_id') is not null;

create index if not exists idx_recibos_dados_open_finance_gin
  on public.recibos_evidencias using gin (dados_open_finance);

-- 3. open_finance_items ---------------------------------------------------

-- Um "item" no Pluggy e uma conexao entre um usuario e uma instituicao
-- financeira. O webhook do Pluggy chega identificando apenas o item, entao sem
-- esta tabela nao ha como saber de quem e a transacao que acabou de sincronizar.
create table if not exists public.open_finance_items (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  pluggy_item_id text not null unique,
  connector_id text,
  connector_nome text,
  status text,
  status_detalhe jsonb not null default '{}'::jsonb,
  ultima_sincronizacao_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table public.open_finance_items is
  'Vinculo entre um item (conexao bancaria) do Pluggy e um usuario do TaxMind. Escrita pela Edge Function pluggy-item-link no onSuccess do widget, com backfill pela pluggy-webhook via clientUserId quando o vinculo nao chegou a ser gravado.';

drop trigger if exists trg_open_finance_items_atualizado_em on public.open_finance_items;
create trigger trg_open_finance_items_atualizado_em before update on public.open_finance_items
for each row execute function public.set_atualizado_em();

create index if not exists idx_open_finance_items_usuario on public.open_finance_items (usuario_id);
create index if not exists idx_open_finance_items_status on public.open_finance_items (status);

alter table public.open_finance_items enable row level security;

-- Somente leitura para authenticated: o usuario pode ver quais bancos conectou.
-- A escrita e exclusiva das Edge Functions (service_role), porque quem conecta
-- a conta segura um token HMAC de sessao, nao uma sessao autenticada do
-- Supabase Auth — nao existe auth.uid() no navegador nesse momento do fluxo.
drop policy if exists "open_finance_items_select_proprios" on public.open_finance_items;
create policy "open_finance_items_select_proprios" on public.open_finance_items
for select to authenticated using (usuario_id = auth.uid());

grant select, insert, update on public.open_finance_items to service_role;
