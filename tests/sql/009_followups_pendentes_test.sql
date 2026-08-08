-- Fase 13 - o que a migration 009 promete, verificado no Postgres de verdade.
--
-- Rodar via tests/sql/run_migrations_docker.sh.

\set ON_ERROR_STOP on

-- 1. Idempotencia.
\i /migrations/009_followups_pendentes.sql

-- 2. Massa: dois usuarios com um recibo cada.
insert into auth.users (id) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

insert into public.usuarios (id, email, telefone_whatsapp) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c@exemplo.test', '+5511999990003'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'd@exemplo.test', '+5511999990004');

insert into public.recibos_evidencias (id, usuario_id, origem, descricao, valor, categoria)
values
  ('11111111-aaaa-4aaa-8aaa-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   'WHATSAPP_TEXTO', 'Consulta medica', 450, 'SAUDE'),
  ('22222222-aaaa-4aaa-8aaa-222222222222', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   'WHATSAPP_TEXTO', 'Exame laboratorial', 180, 'SAUDE'),
  ('33333333-aaaa-4aaa-8aaa-333333333333', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
   'WHATSAPP_TEXTO', 'Mensalidade', 320, 'EDUCACAO');

-- 3. Constraints.
do $$
declare
  v_id uuid;
begin
  insert into public.followups_pendentes
    (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-aaaa-4aaa-8aaa-111111111111',
          'documento_prestador', 'Voce tem o CNPJ?', now() + interval '30 minutes')
  returning id into v_id;

  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-aaaa-4aaa-8aaa-222222222222',
            'documento_prestador', 'E dessa outra?', now() + interval '30 minutes');
    raise exception 'duas pendencias abertas para o mesmo usuario foram aceitas';
  exception when unique_violation then null;
  end;

  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '33333333-aaaa-4aaa-8aaa-333333333333',
            'categoria', 'Qual a categoria?', now() + interval '30 minutes');
    raise exception 'campo_alvo fora da lista de respondiveis foi aceito';
  exception when check_violation then null;
  end;

  begin
    update public.followups_pendentes
       set respondida_em = now(), descartada_em = now()
     where id = v_id;
    raise exception 'pendencia respondida E descartada ao mesmo tempo foi aceita';
  exception when check_violation then null;
  end;

  begin
    update public.followups_pendentes set mensagens_restantes = -1 where id = v_id;
    raise exception 'orcamento negativo foi aceito';
  exception when check_violation then null;
  end;

  -- Fechada a primeira, a proxima cabe: a unique e parcial, nao total.
  update public.followups_pendentes set descartada_em = now(), descartada_motivo = 'EXPIRADA'
   where id = v_id;

  insert into public.followups_pendentes
    (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-aaaa-4aaa-8aaa-222222222222',
          'estabelecimento', 'Onde foi?', now() + interval '30 minutes');
end
$$;

-- 4. Exclusao mutua entre execucoes concorrentes.
--
-- O padrao usado pela followup-resolve e `update ... where respondida_em is
-- null returning`. O comportamento sob concorrencia real (Postgres serializa os
-- UPDATEs na mesma linha e reavalia o predicado no READ COMMITTED) ja esta
-- registrado no AGENTS.md, verificado com duas sessoes psql. O que se verifica
-- aqui e o outro lado da mesma moeda: com a linha ja reivindicada, a segunda
-- tentativa atualiza ZERO linhas em vez de sobrescrever a primeira.
do $$
declare
  v_id uuid;
  v_primeira int;
  v_segunda int;
begin
  select id into v_id from public.followups_pendentes
   where usuario_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
     and respondida_em is null and descartada_em is null;

  update public.followups_pendentes
     set respondida_em = now(), resolucao = 'CAMPO_PREENCHIDO'
   where id = v_id and respondida_em is null and descartada_em is null;
  get diagnostics v_primeira = row_count;

  update public.followups_pendentes
     set respondida_em = now(), resolucao = 'RECLASSIFICADO'
   where id = v_id and respondida_em is null and descartada_em is null;
  get diagnostics v_segunda = row_count;

  if v_primeira <> 1 or v_segunda <> 0 then
    raise exception 'exclusao mutua falhou (primeira=%, segunda=%)', v_primeira, v_segunda;
  end if;

  if (select resolucao from public.followups_pendentes where id = v_id) <> 'CAMPO_PREENCHIDO' then
    raise exception 'a segunda execucao sobrescreveu a resolucao da primeira';
  end if;
end
$$;

-- 5. A funcao de registro: encerra a anterior e cria a nova, atomicamente.
do $$
declare
  v_primeiro uuid;
  v_segundo uuid;
  v_abertas int;
begin
  v_primeiro := public.registrar_followup_pendente(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '33333333-aaaa-4aaa-8aaa-333333333333',
    null, 'documento_prestador', 'Voce tem o CNPJ?'
  );

  v_segundo := public.registrar_followup_pendente(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '33333333-aaaa-4aaa-8aaa-333333333333',
    null, 'estabelecimento', 'Onde foi?'
  );

  select count(*) into v_abertas from public.followups_pendentes
   where usuario_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     and respondida_em is null and descartada_em is null;
  if v_abertas <> 1 then
    raise exception 'ficaram % pendencias abertas para o mesmo usuario', v_abertas;
  end if;

  if (select descartada_motivo from public.followups_pendentes where id = v_primeiro)
     <> 'SUPERSEDIDA' then
    raise exception 'a pendencia anterior nao foi encerrada como SUPERSEDIDA';
  end if;

  -- Default de 30 minutos e 2 mensagens, os mesmos de _shared/followup.ts.
  if (select mensagens_restantes from public.followups_pendentes where id = v_segundo) <> 2 then
    raise exception 'orcamento default diferente de 2';
  end if;
  if (select expira_em from public.followups_pendentes where id = v_segundo)
     > now() + interval '31 minutes' then
    raise exception 'TTL default maior que 30 minutos';
  end if;
end
$$;

-- 6. Privilegios.
do $$
begin
  if has_table_privilege('authenticated', 'public.followups_pendentes', 'INSERT')
     or has_table_privilege('authenticated', 'public.followups_pendentes', 'UPDATE')
     or has_table_privilege('authenticated', 'public.followups_pendentes', 'DELETE') then
    raise exception 'titular pode escrever na propria pendencia';
  end if;

  if not has_table_privilege('authenticated', 'public.followups_pendentes', 'SELECT') then
    raise exception 'titular nao le as proprias pendencias';
  end if;

  if has_table_privilege('anon', 'public.followups_pendentes', 'SELECT') then
    raise exception 'anon enxerga a tabela de pendencias';
  end if;

  -- Preencher o proprio campo bloqueante seria promover o proprio recibo para
  -- DEDUTIVEL sem analise: a funcao nao pode ser executavel pelo titular.
  if has_function_privilege(
       'authenticated',
       'public.registrar_followup_pendente(uuid, uuid, uuid, text, text, int, int)',
       'EXECUTE') then
    raise exception 'authenticated pode registrar pendencia';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.registrar_followup_pendente(uuid, uuid, uuid, text, text, int, int)',
       'EXECUTE') then
    raise exception 'service_role nao pode registrar pendencia';
  end if;

  if (select prosecdef from pg_proc where proname = 'registrar_followup_pendente') then
    raise exception 'registrar_followup_pendente esta como SECURITY DEFINER';
  end if;
end
$$;

-- 7. RLS dentro de transacao (set local role fora de transacao e ignorado).
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  do $$
  declare
    proprias int;
    alheias int;
  begin
    select count(*) into proprias from public.followups_pendentes
     where usuario_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    if proprias = 0 then
      raise exception 'titular nao enxerga as proprias pendencias';
    end if;

    select count(*) into alheias from public.followups_pendentes
     where usuario_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    if alheias <> 0 then
      raise exception 'titular enxerga pendencia alheia (viu %)', alheias;
    end if;

    begin
      update public.followups_pendentes set respondida_em = now()
       where usuario_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      raise exception 'titular conseguiu resolver a propria pendencia';
    exception when insufficient_privilege then null;
    end;
  end
  $$;
rollback;

-- 8. Cascade pelo recibo: pendencia nao sobrevive ao lancamento que a originou.
do $$
declare
  restantes int;
begin
  delete from public.recibos_evidencias where id = '22222222-aaaa-4aaa-8aaa-222222222222';
  select count(*) into restantes from public.followups_pendentes
   where recibo_id = '22222222-aaaa-4aaa-8aaa-222222222222';
  if restantes <> 0 then
    raise exception 'pendencia sobreviveu ao delete do recibo';
  end if;
end
$$;

select 'migration 009 ok' as resultado;
