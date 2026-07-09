create extension if not exists "pgcrypto";
create extension if not exists "citext";

create type public.categoria_fiscal as enum (
  'SAUDE',
  'EDUCACAO',
  'ALIMENTACAO',
  'TRANSPORTE',
  'MORADIA',
  'ESCRITORIO',
  'EQUIPAMENTOS',
  'SOFTWARE',
  'INTERNET_TELEFONIA',
  'SERVICOS_PROFISSIONAIS',
  'IMPOSTOS_TAXAS',
  'OUTROS'
);

create type public.status_deducibilidade as enum (
  'DEDUTIVEL',
  'NAO_DEDUTIVEL',
  'PARCIALMENTE_DEDUTIVEL',
  'INDETERMINADO'
);

create type public.status_processamento as enum (
  'RECEBIDO',
  'PROCESSANDO',
  'APROVADO_AUTOMATICAMENTE',
  'REVISAO_HUMANA',
  'REJEITADO',
  'ARQUIVADO'
);

create type public.origem_evidencia as enum (
  'WHATSAPP_TEXTO',
  'WHATSAPP_IMAGEM',
  'WHATSAPP_DOCUMENTO',
  'OPEN_FINANCE',
  'IMPORTACAO_MANUAL'
);

create type public.status_sessao_whatsapp as enum (
  'ABERTA',
  'EXPIRADA',
  'AGUARDANDO_TEMPLATE',
  'ENCERRADA'
);

create table public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text,
  email citext unique,
  telefone_whatsapp text unique not null,
  cpf_hash text unique,
  contador_responsavel_id uuid references public.usuarios(id) on delete set null,
  onboarding_concluido boolean not null default false,
  termos_aceitos_em timestamptz,
  consentimento_lgpd_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint usuarios_telefone_formato_chk check (telefone_whatsapp ~ '^\+[1-9][0-9]{7,14}$')
);

create table public.sessoes_whatsapp (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references public.usuarios(id) on delete cascade,
  telefone_whatsapp text not null,
  wa_id text,
  ultima_mensagem_id text,
  status public.status_sessao_whatsapp not null default 'ABERTA',
  aberta_em timestamptz not null default now(),
  ultima_interacao_em timestamptz not null default now(),
  expira_em timestamptz not null default (now() + interval '24 hours'),
  contexto jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint sessoes_whatsapp_telefone_formato_chk check (telefone_whatsapp ~ '^\+[1-9][0-9]{7,14}$')
);

create table public.recibos_evidencias (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  sessao_whatsapp_id uuid references public.sessoes_whatsapp(id) on delete set null,
  origem public.origem_evidencia not null,
  status public.status_processamento not null default 'RECEBIDO',
  descricao text not null,
  estabelecimento text,
  documento_prestador text,
  data_despesa date,
  valor numeric(12, 2) not null,
  categoria public.categoria_fiscal not null default 'OUTROS',
  deducibilidade public.status_deducibilidade not null default 'INDETERMINADO',
  justificativa_deducibilidade text,
  confidence_score numeric(5, 4) not null default 0,
  requer_revisao_humana boolean not null default true,
  possui_indicio_tuss_cbhpm boolean not null default false,
  codigos_medicos_identificados text[] not null default '{}',
  termos_auditoria_identificados text[] not null default '{}',
  arquivo_bucket text,
  arquivo_path text,
  arquivo_hash_sha256 text,
  metadados_ocr jsonb not null default '{}'::jsonb,
  metadados_ia jsonb not null default '{}'::jsonb,
  revisado_por uuid references public.usuarios(id) on delete set null,
  revisado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint recibos_valor_positivo_chk check (valor > 0),
  constraint recibos_confidence_score_chk check (confidence_score >= 0 and confidence_score <= 1)
);

create or replace function public.set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

create trigger trg_usuarios_atualizado_em before update on public.usuarios
for each row execute function public.set_atualizado_em();

create trigger trg_sessoes_whatsapp_atualizado_em before update on public.sessoes_whatsapp
for each row execute function public.set_atualizado_em();

create trigger trg_recibos_evidencias_atualizado_em before update on public.recibos_evidencias
for each row execute function public.set_atualizado_em();

create index idx_usuarios_telefone_whatsapp on public.usuarios (telefone_whatsapp);
create index idx_sessoes_whatsapp_usuario_id on public.sessoes_whatsapp (usuario_id);
create index idx_sessoes_whatsapp_telefone_status on public.sessoes_whatsapp (telefone_whatsapp, status);
create index idx_sessoes_whatsapp_expira_em on public.sessoes_whatsapp (expira_em);
create index idx_recibos_usuario_data on public.recibos_evidencias (usuario_id, data_despesa desc);
create index idx_recibos_usuario_categoria on public.recibos_evidencias (usuario_id, categoria);
create index idx_recibos_usuario_status on public.recibos_evidencias (usuario_id, status);
create index idx_recibos_revisao_humana on public.recibos_evidencias (requer_revisao_humana, status)
where requer_revisao_humana = true;
create index idx_recibos_metadados_ocr_gin on public.recibos_evidencias using gin (metadados_ocr);
create index idx_recibos_metadados_ia_gin on public.recibos_evidencias using gin (metadados_ia);

alter table public.usuarios enable row level security;
alter table public.sessoes_whatsapp enable row level security;
alter table public.recibos_evidencias enable row level security;

create policy "usuarios_select_proprio_registro" on public.usuarios
for select to authenticated using (id = auth.uid());

create policy "usuarios_update_proprio_registro" on public.usuarios
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "usuarios_insert_proprio_registro" on public.usuarios
for insert to authenticated with check (id = auth.uid());

create policy "sessoes_select_proprias" on public.sessoes_whatsapp
for select to authenticated using (usuario_id = auth.uid());

create policy "sessoes_insert_proprias" on public.sessoes_whatsapp
for insert to authenticated with check (usuario_id = auth.uid());

create policy "sessoes_update_proprias" on public.sessoes_whatsapp
for update to authenticated using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

create policy "recibos_select_proprios" on public.recibos_evidencias
for select to authenticated using (usuario_id = auth.uid());

create policy "recibos_insert_proprios" on public.recibos_evidencias
for insert to authenticated with check (usuario_id = auth.uid());

create policy "recibos_update_proprios" on public.recibos_evidencias
for update to authenticated using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

create policy "recibos_delete_proprios" on public.recibos_evidencias
for delete to authenticated using (usuario_id = auth.uid());

