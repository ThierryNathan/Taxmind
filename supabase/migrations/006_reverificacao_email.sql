-- Fase 7 - Re-verificacao por e-mail.
--
-- Estado encontrado antes desta migration (conferido na 001 e na 005, nao
-- assumido):
--   - sessoes_whatsapp ja tem contexto jsonb, expira_em de 24h e trigger de
--     atualizado_em. Nao existe nenhuma coluna de verificacao.
--   - public.set_atualizado_em() ja existe (001) e e reaproveitada aqui.
--   - usuarios.email e citext unique e pode ser null; a function trata a
--     ausencia de e-mail como "verificacao indisponivel" e libera a mensagem,
--     em vez de travar a conta sem caminho de saida.
--
-- O que muda:
--   1. sessoes_whatsapp.verificado_em, com backfill das sessoes existentes.
--   2. Tabela codigos_verificacao, com hash do codigo e controle de tentativas.
--   3. Tabela eventos_acesso, trilha append-only para LGPD e motor de risco.

-- 1. sessoes_whatsapp.verificado_em ---------------------------------------

alter table public.sessoes_whatsapp
  add column if not exists verificado_em timestamptz;

comment on column public.sessoes_whatsapp.verificado_em is
  'Ultima verificacao de identidade bem-sucedida registrada nesta sessao (onboarding original ou re-verificacao por e-mail). A whatsapp-webhook NAO le esta coluna da sessao atual: sessao expira em 24h e sessao nova nasce sem contexto, entao a janela de confianca de 30 dias e avaliada pelo maior verificado_em entre as sessoes do usuario, com fallback em usuarios.criado_em.';

-- Backfill: sem isto, todo cadastro existente cairia em re-verificacao na
-- primeira mensagem depois do deploy. criado_em da sessao e a melhor
-- aproximacao disponivel do momento em que aquele contato foi verificado.
update public.sessoes_whatsapp
   set verificado_em = criado_em
 where verificado_em is null;

-- Suporta exatamente a consulta da function: ultimo verificado_em do usuario.
create index if not exists idx_sessoes_whatsapp_usuario_verificado
  on public.sessoes_whatsapp (usuario_id, verificado_em desc)
  where usuario_id is not null and verificado_em is not null;

-- 2. codigos_verificacao --------------------------------------------------

-- Codigo de 6 digitos enviado por e-mail quando a janela de confianca vence.
-- Tabela propria em vez de sessoes_whatsapp.contexto de proposito:
--   - contexto e read-modify-write de tres escritores (whatsapp-webhook,
--     bootstrap-identity e este fluxo); contador de tentativas perdido numa
--     sobrescrita e limite de tentativas burlado;
--   - contexto e legivel por authenticated (policy sessoes_select_proprias) e
--     hash de codigo e credencial;
--   - o codigo precisa sobreviver a troca de sessao de 24h.
create table if not exists public.codigos_verificacao (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  sessao_whatsapp_id uuid references public.sessoes_whatsapp(id) on delete set null,
  canal text not null default 'EMAIL',
  codigo_hash text not null,
  destino_mascarado text,
  tentativas smallint not null default 0,
  max_tentativas smallint not null default 3,
  expira_em timestamptz not null,
  consumido_em timestamptz,
  invalidado_em timestamptz,
  invalidado_motivo text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint codigos_verificacao_tentativas_chk
    check (tentativas >= 0 and tentativas <= max_tentativas),
  constraint codigos_verificacao_max_tentativas_chk check (max_tentativas > 0)
);

comment on table public.codigos_verificacao is
  'Codigos de re-verificacao de identidade (Fase 7). Guarda apenas o HMAC do codigo, nunca o valor em claro. Escrita e leitura exclusivas das Edge Functions via service_role — RLS habilitada sem nenhuma policy para authenticated.';

comment on column public.codigos_verificacao.codigo_hash is
  'HMAC-SHA256 hex do codigo, com pepper CPF_HASH_PEPPER (fallback TAXMIND_BOOTSTRAP_SECRET). Mesmo padrao de pepper do cpf_hash.';

comment on column public.codigos_verificacao.destino_mascarado is
  'E-mail de destino mascarado (ex.: t***y@gmail.com), para exibir no WhatsApp sem repetir o endereco completo no canal menos protegido.';

drop trigger if exists trg_codigos_verificacao_atualizado_em on public.codigos_verificacao;
create trigger trg_codigos_verificacao_atualizado_em before update on public.codigos_verificacao
for each row execute function public.set_atualizado_em();

-- No maximo um codigo ativo por usuario. Duas mensagens chegando juntas nao
-- podem gerar dois codigos validos: a segunda insercao falha na unique e a
-- function trata como "codigo ja enviado", sem novo e-mail. A function
-- invalida codigo vencido ou esgotado (invalidado_em) antes de gerar o proximo,
-- entao esta unique nao bloqueia a renovacao legitima.
create unique index if not exists idx_codigos_verificacao_ativo_por_usuario
  on public.codigos_verificacao (usuario_id)
  where consumido_em is null and invalidado_em is null;

create index if not exists idx_codigos_verificacao_usuario_criado
  on public.codigos_verificacao (usuario_id, criado_em desc);

alter table public.codigos_verificacao enable row level security;

-- Nenhuma policy para authenticated: o hash e as tentativas sao material de
-- seguranca. O usuario nao precisa ler nem escrever nada aqui — ele digita o
-- codigo no WhatsApp e a function valida.
--
-- O revoke e defesa em profundidade, nao redundancia: o Supabase configura
-- ALTER DEFAULT PRIVILEGES concedendo ALL em tabelas novas do schema public a
-- anon e authenticated. Hoje a RLS sem policy ja nega tudo, mas se algum dia
-- alguem desabilitar RLS nesta tabela por engano, sem o revoke o hash do codigo
-- ficaria legivel pelo anon key.
revoke all on public.codigos_verificacao from anon, authenticated;
grant select, insert, update on public.codigos_verificacao to service_role;

-- 3. eventos_acesso ------------------------------------------------------

-- Trilha append-only de acesso a dado sensivel. Serve a dois propositos:
-- rastreabilidade LGPD ("quando confirmaram identidade nesta conta") e base
-- para o motor de risco futuro. tipo_evento e text, nao enum, justamente para
-- que um tipo novo de evento nao exija migration.
create table if not exists public.eventos_acesso (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  tipo_evento text not null,
  detalhes jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now()
);

comment on table public.eventos_acesso is
  'Log append-only de eventos de acesso e verificacao de identidade. Tipos gravados na Fase 7: CODIGO_VERIFICACAO_GERADO, CODIGO_VERIFICACAO_ENVIO_FALHOU, VERIFICACAO_SUCESSO, VERIFICACAO_FALHA, VERIFICACAO_INDISPONIVEL. Nunca gravar codigo em claro nem conteudo de mensagem em detalhes.';

create index if not exists idx_eventos_acesso_usuario_criado
  on public.eventos_acesso (usuario_id, criado_em desc);

create index if not exists idx_eventos_acesso_tipo_criado
  on public.eventos_acesso (tipo_evento, criado_em desc);

alter table public.eventos_acesso enable row level security;

-- Leitura do proprio historico e transparencia LGPD. Nao existe policy de
-- insert, update ou delete para authenticated: o log e escrito somente pelas
-- Edge Functions e nao pode ser editado por quem esta sendo auditado.
drop policy if exists "eventos_acesso_select_proprios" on public.eventos_acesso;
create policy "eventos_acesso_select_proprios" on public.eventos_acesso
for select to authenticated using (usuario_id = auth.uid());

-- Append-only tambem no nivel de privilegio, nao so de policy: o default
-- privilege do Supabase daria INSERT/UPDATE/DELETE a authenticated em tabela
-- nova, e log de auditoria que o auditado pode escrever nao e log.
revoke all on public.eventos_acesso from anon, authenticated;
grant select on public.eventos_acesso to authenticated;
grant select, insert on public.eventos_acesso to service_role;
