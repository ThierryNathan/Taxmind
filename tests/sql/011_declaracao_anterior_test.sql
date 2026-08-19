-- Fase 17 - o que a migration 011 promete, verificado no Postgres de verdade.
--
-- Rodar via tests/sql/run_migrations_docker.sh.

\set ON_ERROR_STOP on

-- 1. Idempotencia: a tabela usa `create table if not exists`, as constraints
-- usam `drop ... if exists` antes do add, o indice e `if not exists` e o
-- `alter column drop not null` e naturalmente repetivel.
\i /migrations/011_declaracao_anterior.sql

-- 2. Massa propria (uuids que as migrations anteriores nao consomem).
insert into auth.users (id) values
  ('17171717-17aa-4aaa-8aaa-171717171717');

insert into public.usuarios (id, email, telefone_whatsapp) values
  ('17171717-17aa-4aaa-8aaa-171717171717', 'fase17a@exemplo.test', '+5511999990017');

insert into public.recibos_evidencias
  (id, usuario_id, origem, descricao, valor, categoria, deducibilidade, status)
values
  ('17171717-17cc-4ccc-8ccc-171717171719', '17171717-17aa-4aaa-8aaa-171717171717',
   'WHATSAPP_TEXTO', 'Consulta medica', 500, 'SAUDE', 'DEDUTIVEL', 'RECEBIDO');

-- 3. campo_alvo novo e aceito, e a pendencia de declaracao vive SEM recibo.
insert into public.followups_pendentes
  (id, usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
values
  ('17171717-17dd-4ddd-8ddd-171717171720', '17171717-17aa-4aaa-8aaa-171717171717',
   null, 'declaracao_anterior', 'Me manda o PDF', now() + interval '30 minutes');

do $$
begin
  if (select count(*) from public.followups_pendentes
      where campo_alvo = 'declaracao_anterior' and recibo_id is null) <> 1 then
    raise exception 'pendencia de declaracao sem recibo deveria ter sido aceita';
  end if;
end $$;

-- 4. Pendencia de declaracao COM recibo e recusada: afrouxar o NOT NULL nao
-- pode virar licenca para vincular recibo onde nao ha lancamento.
do $$
begin
  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values
      ('17171717-17aa-4aaa-8aaa-171717171717', '17171717-17cc-4ccc-8ccc-171717171719',
       'declaracao_anterior', 'x', now() + interval '30 minutes');
    raise exception 'declaracao_anterior com recibo_id deveria violar a constraint';
  exception when check_violation then null;
  end;
end $$;

-- 5. E o inverso continua valendo: pendencia de RECIBO sem recibo e recusada.
-- Este e o caso que a 009 protegia com NOT NULL e que precisava sobreviver.
do $$
begin
  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values
      ('17171717-17aa-4aaa-8aaa-171717171717', null,
       'documento_prestador', 'x', now() + interval '30 minutes');
    raise exception 'documento_prestador sem recibo_id deveria violar a constraint';
  exception when check_violation then null;
  end;
end $$;

-- 6. A unique parcial de "uma pendencia aberta por usuario" continua valendo
-- entre tipos diferentes: a pendencia de declaracao ocupa a mesma vaga.
do $$
begin
  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values
      ('17171717-17aa-4aaa-8aaa-171717171717', '17171717-17cc-4ccc-8ccc-171717171719',
       'documento_prestador', 'x', now() + interval '30 minutes');
    raise exception 'duas pendencias abertas para o mesmo usuario deveriam colidir';
  exception when unique_violation then null;
  end;
end $$;

-- 7. A RPC que abre pendencia continua funcionando com recibo nulo (e o
-- caminho que a Edge Function usa para criar a pendencia de declaracao).
do $$
declare v_id uuid;
begin
  v_id := public.registrar_followup_pendente(
    '17171717-17aa-4aaa-8aaa-171717171717', null, null,
    'declaracao_anterior', 'Me manda o PDF da declaracao', 30, 2
  );
  if v_id is null then
    raise exception 'registrar_followup_pendente deveria devolver o id da nova pendencia';
  end if;
  -- E a anterior foi substituida, nao duplicada.
  if (select count(*) from public.followups_pendentes
      where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717'
        and respondida_em is null and descartada_em is null) <> 1 then
    raise exception 'deveria haver exatamente uma pendencia aberta';
  end if;
  if (select descartada_motivo from public.followups_pendentes
      where id = '17171717-17dd-4ddd-8ddd-171717171720') <> 'SUPERSEDIDA' then
    raise exception 'a pendencia anterior deveria ter sido marcada SUPERSEDIDA';
  end if;
end $$;

-- 8. declaracoes_anteriores: insert valido, chave por (usuario, ano) e upsert.
insert into public.declaracoes_anteriores
  (usuario_id, ano_calendario, modelo, aliquota_efetiva, categorias_pagamentos,
   arquivo_hash_sha256)
values
  ('17171717-17aa-4aaa-8aaa-171717171717', 2025, 'SIMPLIFICADO', 11.74,
   array['SAUDE', 'EDUCACAO'], repeat('a', 64));

-- Ano diferente do mesmo usuario convive.
insert into public.declaracoes_anteriores
  (usuario_id, ano_calendario, modelo, arquivo_hash_sha256)
values
  ('17171717-17aa-4aaa-8aaa-171717171717', 2024, 'COMPLETO', repeat('b', 64));

-- Mesmo ano colide, e o upsert por (usuario_id, ano_calendario) substitui.
insert into public.declaracoes_anteriores
  (usuario_id, ano_calendario, modelo, aliquota_efetiva, arquivo_hash_sha256)
values
  ('17171717-17aa-4aaa-8aaa-171717171717', 2025, 'COMPLETO', 8.32, repeat('c', 64))
on conflict (usuario_id, ano_calendario) do update
  set modelo = excluded.modelo,
      aliquota_efetiva = excluded.aliquota_efetiva,
      arquivo_hash_sha256 = excluded.arquivo_hash_sha256;

do $$
begin
  if (select count(*) from public.declaracoes_anteriores
      where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717') <> 2 then
    raise exception 'reimportar o mesmo ano deveria substituir, nao duplicar';
  end if;
  if (select modelo from public.declaracoes_anteriores
      where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717'
        and ano_calendario = 2025) <> 'COMPLETO' then
    raise exception 'o upsert deveria ter trocado o modelo para COMPLETO';
  end if;
end $$;

-- 9. Constraints de dominio.
do $$
begin
  begin
    insert into public.declaracoes_anteriores
      (usuario_id, ano_calendario, modelo, arquivo_hash_sha256)
    values ('17171717-17aa-4aaa-8aaa-171717171717', 2023, 'SIMPLES', repeat('d', 64));
    raise exception 'modelo invalido deveria violar declaracoes_modelo_chk';
  exception when check_violation then null;
  end;

  begin
    insert into public.declaracoes_anteriores
      (usuario_id, ano_calendario, modelo, aliquota_efetiva, arquivo_hash_sha256)
    values ('17171717-17aa-4aaa-8aaa-171717171717', 2023, 'SIMPLIFICADO', 120.00, repeat('e', 64));
    raise exception 'aliquota acima de 100 deveria violar declaracoes_aliquota_chk';
  exception when check_violation then null;
  end;

  begin
    insert into public.declaracoes_anteriores
      (usuario_id, ano_calendario, modelo, arquivo_hash_sha256)
    values ('17171717-17aa-4aaa-8aaa-171717171717', 20260, 'SIMPLIFICADO', repeat('f', 64));
    raise exception 'ano fora da faixa deveria violar declaracoes_ano_chk';
  exception when check_violation or numeric_value_out_of_range then null;
  end;

  begin
    insert into public.declaracoes_anteriores
      (usuario_id, ano_calendario, modelo, imposto_devido, arquivo_hash_sha256)
    values ('17171717-17aa-4aaa-8aaa-171717171717', 2023, 'SIMPLIFICADO', -1, repeat('0', 64));
    raise exception 'imposto negativo deveria violar a constraint de nao negativos';
  exception when check_violation then null;
  end;
end $$;

-- 10. Trigger de atualizado_em.
do $$
declare v_antes timestamptz; v_depois timestamptz;
begin
  select atualizado_em into v_antes from public.declaracoes_anteriores
   where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717' and ano_calendario = 2024;
  perform pg_sleep(0.05);
  update public.declaracoes_anteriores set confianca = 'ALTA'
   where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717' and ano_calendario = 2024;
  select atualizado_em into v_depois from public.declaracoes_anteriores
   where usuario_id = '17171717-17aa-4aaa-8aaa-171717171717' and ano_calendario = 2024;
  if v_depois <= v_antes then
    raise exception 'trigger de atualizado_em nao disparou';
  end if;
end $$;

-- 11. Privilegios: anon nao pode nada; authenticated so le.
do $$
begin
  if has_table_privilege('anon', 'public.declaracoes_anteriores', 'select') then
    raise exception 'anon nao deveria ter select em declaracoes_anteriores';
  end if;
  if has_table_privilege('authenticated', 'public.declaracoes_anteriores', 'insert') then
    raise exception 'authenticated nao deveria ter insert em declaracoes_anteriores';
  end if;
  if not has_table_privilege('authenticated', 'public.declaracoes_anteriores', 'select') then
    raise exception 'authenticated deveria ter select em declaracoes_anteriores';
  end if;
  if not has_table_privilege('service_role', 'public.declaracoes_anteriores', 'insert') then
    raise exception 'service_role deveria ter insert em declaracoes_anteriores';
  end if;
end $$;

-- 12. RLS isola por auth.uid(). Precisa de bloco de transacao: `set local role`
-- fora de transacao e ignorado com WARNING e o teste passaria sem testar nada
-- (ver AGENTS.md).
insert into auth.users (id) values ('17171717-17bb-4bbb-8bbb-171717171718');
insert into public.usuarios (id, email, telefone_whatsapp) values
  ('17171717-17bb-4bbb-8bbb-171717171718', 'fase17b@exemplo.test', '+5511999990018');

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '17171717-17bb-4bbb-8bbb-171717171718';
  do $$
  begin
    if (select count(*) from public.declaracoes_anteriores) <> 0 then
      raise exception 'RLS deveria esconder a declaracao de outro usuario';
    end if;
  end $$;
rollback;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '17171717-17aa-4aaa-8aaa-171717171717';
  do $$
  begin
    if (select count(*) from public.declaracoes_anteriores) <> 2 then
      raise exception 'o dono deveria enxergar as proprias duas declaracoes';
    end if;
  end $$;
rollback;

select 'ok 011_declaracao_anterior' as resultado;
