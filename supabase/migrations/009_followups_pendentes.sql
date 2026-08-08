-- Fase 13 - Follow-up conversacional de campo estruturado faltante.
--
-- Estado encontrado antes desta migration (conferido na 001 e na 006, nao
-- assumido):
--   - recibos_evidencias ja guarda documento_prestador, estabelecimento,
--     status, requer_revisao_humana e metadados_ia jsonb.
--   - sessoes_whatsapp.contexto jsonb existe e e escrito por tres componentes
--     (whatsapp-webhook, bootstrap-identity e os fluxos do n8n).
--   - public.set_atualizado_em() existe (001) e e reaproveitada aqui.
--
-- Por que tabela propria e nao sessoes_whatsapp.contexto:
--   - contexto e read-modify-write de tres escritores concorrentes, e a corrida
--     aqui e concreta: o n8n escreve a confirmacao no mesmo instante em que a
--     whatsapp-webhook pode estar atualizando contexto com a mensagem seguinte.
--     Uma sobrescrita perde a pendencia ou ressuscita uma ja respondida;
--   - contexto e legivel por authenticated (policy sessoes_select_proprias) e a
--     pendencia aponta para um recibo especifico;
--   - a pendencia precisa de expiracao propria (30 min), independente das 24h
--     da sessao.
--
-- A pendencia NUNCA bloqueia: o recibo ja foi gravado e confirmado antes de ela
-- existir. Ela e uma oportunidade de upgrade para DEDUTIVEL, e expira sozinha.

create table if not exists public.followups_pendentes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  recibo_id uuid not null references public.recibos_evidencias(id) on delete cascade,
  sessao_whatsapp_id uuid references public.sessoes_whatsapp(id) on delete set null,
  campo_alvo text not null,
  pergunta text not null,
  mensagens_restantes smallint not null default 2,
  expira_em timestamptz not null,
  respondida_em timestamptz,
  resolucao text,
  descartada_em timestamptz,
  descartada_motivo text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint followups_campo_alvo_chk
    check (campo_alvo in ('documento_prestador', 'estabelecimento')),
  constraint followups_mensagens_restantes_chk check (mensagens_restantes >= 0),
  -- Respondida e descartada sao estados finais mutuamente exclusivos: os dois
  -- ao mesmo tempo tornariam o historico impossivel de interpretar.
  constraint followups_desfecho_unico_chk
    check (respondida_em is null or descartada_em is null)
);

comment on table public.followups_pendentes is
  'Pergunta pendente sobre um campo estruturado faltante de um recibo (Fase 13). Opcional por natureza: o recibo ja existe em REVISAO_HUMANA antes desta linha, e a pendencia expira sozinha em 30 minutos ou 2 mensagens. Escrita exclusiva das Edge Functions via service_role.';

comment on column public.followups_pendentes.campo_alvo is
  'Campo estruturado e objetivamente respondivel. Ambiguidade de categoria fiscal nao entra aqui: aquilo e decisao de contador, nao dado que falta.';

comment on column public.followups_pendentes.mensagens_restantes is
  'Quantas mensagens seguintes ainda podem ser consideradas resposta. A whatsapp-webhook decrementa; resposta reconhecida nao consome orcamento.';

comment on column public.followups_pendentes.resolucao is
  'Como a pendencia foi resolvida: CAMPO_PREENCHIDO (patch deterministico) ou RECLASSIFICADO (evidencia nova em texto livre). Nunca guarda o texto da mensagem.';

drop trigger if exists trg_followups_pendentes_atualizado_em on public.followups_pendentes;
create trigger trg_followups_pendentes_atualizado_em before update on public.followups_pendentes
for each row execute function public.set_atualizado_em();

-- No maximo uma pendencia aberta por usuario. Duas perguntas em aberto tornam
-- "a qual delas isto responde" insoluvel, entao pendencia nova encerra a
-- anterior (motivo SUPERSEDIDA) dentro da mesma transacao da funcao abaixo.
create unique index if not exists idx_followups_pendentes_aberto_por_usuario
  on public.followups_pendentes (usuario_id)
  where respondida_em is null and descartada_em is null;

create index if not exists idx_followups_pendentes_recibo
  on public.followups_pendentes (recibo_id);

alter table public.followups_pendentes enable row level security;

-- Ler as proprias pendencias e transparencia. Escrita e das Edge Functions: o
-- titular preencher o proprio campo bloqueante por fora seria promover o
-- proprio recibo para DEDUTIVEL sem passar pela analise.
drop policy if exists "followups_pendentes_select_proprios" on public.followups_pendentes;
create policy "followups_pendentes_select_proprios" on public.followups_pendentes
for select to authenticated using (usuario_id = auth.uid());

-- Mesmo motivo dos revokes em 006 e 008: o Supabase configura
-- ALTER DEFAULT PRIVILEGES concedendo ALL em tabela nova a anon e authenticated.
revoke all on public.followups_pendentes from anon, authenticated;
grant select on public.followups_pendentes to authenticated;
grant select, insert, update on public.followups_pendentes to service_role;

-- Registro da pendencia em uma chamada so.
--
-- Encerrar a anterior e inserir a nova precisam ser atomicos: feitos em dois
-- requests do n8n, duas mensagens simultaneas conseguem encerrar as duas e
-- disputar o insert, e uma delas morre na unique parcial. Aqui as duas
-- operacoes vivem na mesma transacao.
--
-- SECURITY INVOKER de proposito (ver AGENTS.md): a funcao recebe usuario_id por
-- parametro, e com DEFINER qualquer authenticated criaria pendencia no recibo
-- alheio passando o uuid do outro. Como INVOKER, a RLS do chamador continua
-- valendo e o EXECUTE fica so com service_role.
create or replace function public.registrar_followup_pendente(
  p_usuario_id uuid,
  p_recibo_id uuid,
  p_sessao_whatsapp_id uuid,
  p_campo_alvo text,
  p_pergunta text,
  p_ttl_minutos int default 30,
  p_mensagens int default 2
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  update public.followups_pendentes
     set descartada_em = now(),
         descartada_motivo = 'SUPERSEDIDA'
   where usuario_id = p_usuario_id
     and respondida_em is null
     and descartada_em is null;

  insert into public.followups_pendentes (
    usuario_id, recibo_id, sessao_whatsapp_id, campo_alvo, pergunta,
    mensagens_restantes, expira_em
  )
  values (
    p_usuario_id, p_recibo_id, p_sessao_whatsapp_id, p_campo_alvo, p_pergunta,
    p_mensagens, now() + make_interval(mins => p_ttl_minutos)
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.registrar_followup_pendente is
  'Encerra a pendencia aberta do usuario (SUPERSEDIDA) e cria a nova, atomicamente. Chamada pelo workflow de recibo via service_role.';

-- Funcao no schema public nasce com EXECUTE para PUBLIC.
revoke execute on function public.registrar_followup_pendente(
  uuid, uuid, uuid, text, text, int, int
) from public, anon, authenticated;
grant execute on function public.registrar_followup_pendente(
  uuid, uuid, uuid, text, text, int, int
) to service_role;
