-- Fase 12 - Consentimento LGPD no onboarding.
--
-- Estado encontrado antes desta migration (conferido na 001, nao assumido):
--   - usuarios ja tem consentimento_lgpd_em timestamptz, sempre gravada como
--     null pela bootstrap-identity. Nao ha nenhum registro de QUAL texto foi
--     aceito.
--   - public.set_atualizado_em() existe (001) mas nao e usada aqui: a tabela e
--     append-only e nao tem coluna atualizado_em.
--
-- Por que tabela propria em vez de so preencher usuarios.consentimento_lgpd_em:
--   - a coluna guarda um instante, e a pergunta que a LGPD faz e "consentiu com
--     o que". Sem a versao do texto, o registro nao prova nada;
--   - o texto vai mudar (hoje ele diz "prototipo academico / TCC"), e cada
--     versao precisa do proprio aceite. Uma coluna so guarda o ultimo estado e
--     apaga o historico;
--   - a evidencia de consentimento nao pode ser editavel por quem consentiu,
--     e usuarios ja tem policy de UPDATE para o proprio registro (001).
-- usuarios.consentimento_lgpd_em continua sendo preenchida, como ponteiro
-- barato para "esta pessoa ja consentiu"; a prova fica aqui.

create table if not exists public.consentimentos_lgpd (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  versao text not null,
  texto_hash text not null,
  canal text not null default 'ONBOARDING_WEB',
  aceito_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  constraint consentimentos_lgpd_versao_nao_vazia_chk check (length(btrim(versao)) > 0),
  constraint consentimentos_lgpd_texto_hash_chk check (texto_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.consentimentos_lgpd is
  'Evidencia de consentimento LGPD por versao de texto. Append-only: escrita apenas pela bootstrap-identity via service_role, leitura do proprio registro liberada ao usuario como transparencia. O texto integral de cada versao vive em supabase/functions/_shared/consentimento.ts e em docs/05 - Consentimento LGPD.md; texto_hash amarra o aceite a redacao exata.';

comment on column public.consentimentos_lgpd.versao is
  'Versao do texto exibido, ex.: 2026-08-08.v1. A Edge Function recusa versao que nao seja a atual — bundle antigo em cache registraria aceite de um texto que a pessoa nao leu.';

comment on column public.consentimentos_lgpd.texto_hash is
  'SHA-256 hex da serializacao canonica do texto (textoCanonicoConsentimento). Calculado no servidor, nunca recebido do navegador: valor vindo do cliente provaria apenas o que o cliente quis afirmar.';

-- Um aceite por versao. Reonboarding com o mesmo texto nao gera linha nova, e a
-- funcao usa insert com ignoreDuplicates para preservar o aceite ORIGINAL: a
-- data que interessa e a do primeiro sim, nao a da ultima visita.
create unique index if not exists idx_consentimentos_lgpd_usuario_versao
  on public.consentimentos_lgpd (usuario_id, versao);

create index if not exists idx_consentimentos_lgpd_usuario_aceito
  on public.consentimentos_lgpd (usuario_id, aceito_em desc);

alter table public.consentimentos_lgpd enable row level security;

-- Ler o proprio consentimento e transparencia LGPD. Nao existe policy de
-- insert, update ou delete para authenticated: evidencia que o interessado pode
-- reescrever nao e evidencia.
drop policy if exists "consentimentos_lgpd_select_proprios" on public.consentimentos_lgpd;
create policy "consentimentos_lgpd_select_proprios" on public.consentimentos_lgpd
for select to authenticated using (usuario_id = auth.uid());

-- Mesmo motivo do revoke em eventos_acesso (006): o Supabase configura
-- ALTER DEFAULT PRIVILEGES concedendo ALL em tabela nova do schema public a
-- anon e authenticated. A RLS ja nega, mas um "disable row level security"
-- acidental no futuro deixaria o registro de consentimento editavel pelo
-- proprio titular — e apagavel pelo anon key.
revoke all on public.consentimentos_lgpd from anon, authenticated;
grant select on public.consentimentos_lgpd to authenticated;
grant select, insert on public.consentimentos_lgpd to service_role;
