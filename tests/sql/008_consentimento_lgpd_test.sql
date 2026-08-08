-- Fase 12 - o que a migration 008 promete, verificado no Postgres de verdade.
--
-- Rodar via tests/sql/run_migrations_docker.sh (postgres:15 + shim_supabase.sql
-- + migrations 001..008). Cada bloco falha com exception, entao ON_ERROR_STOP=1
-- transforma qualquer promessa quebrada em saida nao-zero.

\set ON_ERROR_STOP on

-- 1. Idempotencia: reaplicar a migration nao pode explodir.
\i /migrations/008_consentimento_lgpd.sql

-- 2. Estrutura.
do $$
begin
  if to_regclass('public.consentimentos_lgpd') is null then
    raise exception 'tabela consentimentos_lgpd nao existe';
  end if;

  if not exists (
    select 1 from pg_indexes
     where tablename = 'consentimentos_lgpd'
       and indexname = 'idx_consentimentos_lgpd_usuario_versao'
  ) then
    raise exception 'unique (usuario_id, versao) ausente';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.consentimentos_lgpd'::regclass) then
    raise exception 'RLS nao esta habilitada';
  end if;
end
$$;

-- 3. Massa de teste: dois usuarios.
insert into auth.users (id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

insert into public.usuarios (id, email, telefone_whatsapp) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@exemplo.test', '+5511999990001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@exemplo.test', '+5511999990002');

insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-08.v1', repeat('a', 64)),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-08-08.v1', repeat('b', 64));

-- 4. Constraints.
do $$
begin
  begin
    insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-08.v1', repeat('c', 64));
    raise exception 'aceite duplicado da mesma versao foi aceito';
  exception when unique_violation then null;
  end;

  begin
    insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-01.v2', 'HASH_NAO_HEX');
    raise exception 'texto_hash fora do formato foi aceito';
  exception when check_violation then null;
  end;

  begin
    insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '   ', repeat('d', 64));
    raise exception 'versao em branco foi aceita';
  exception when check_violation then null;
  end;

  -- Versao nova do mesmo usuario e legitima: o historico precisa caber.
  insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-01.v2', repeat('e', 64));
end
$$;

-- 5. Privilegios: o revoke tem que ter vencido o ALTER DEFAULT PRIVILEGES.
do $$
begin
  if has_table_privilege('authenticated', 'public.consentimentos_lgpd', 'INSERT')
     or has_table_privilege('authenticated', 'public.consentimentos_lgpd', 'UPDATE')
     or has_table_privilege('authenticated', 'public.consentimentos_lgpd', 'DELETE') then
    raise exception 'authenticated pode escrever no registro de consentimento';
  end if;

  if not has_table_privilege('authenticated', 'public.consentimentos_lgpd', 'SELECT') then
    raise exception 'authenticated nao consegue ler o proprio consentimento';
  end if;

  if has_table_privilege('anon', 'public.consentimentos_lgpd', 'SELECT') then
    raise exception 'anon enxerga a tabela de consentimento';
  end if;

  if not has_table_privilege('service_role', 'public.consentimentos_lgpd', 'INSERT') then
    raise exception 'service_role nao consegue gravar o consentimento';
  end if;
end
$$;

-- 6. RLS de verdade, dentro de transacao — `set local role` fora de bloco de
--    transacao e ignorado com WARNING e o teste passaria sem testar nada.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  do $$
  declare
    proprios int;
    alheios int;
  begin
    select count(*) into proprios from public.consentimentos_lgpd
     where usuario_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if proprios <> 2 then
      raise exception 'usuario nao le os proprios consentimentos (viu %)', proprios;
    end if;

    select count(*) into alheios from public.consentimentos_lgpd
     where usuario_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    if alheios <> 0 then
      raise exception 'usuario enxerga consentimento alheio (viu %)', alheios;
    end if;

    begin
      insert into public.consentimentos_lgpd (usuario_id, versao, texto_hash)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2027-01-01.v3', repeat('f', 64));
      raise exception 'titular conseguiu forjar o proprio consentimento';
    exception when insufficient_privilege then null;
    end;

    begin
      update public.consentimentos_lgpd set aceito_em = now()
       where usuario_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      raise exception 'titular conseguiu reescrever o proprio consentimento';
    exception when insufficient_privilege then null;
    end;

    begin
      delete from public.consentimentos_lgpd
       where usuario_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      raise exception 'titular conseguiu apagar o proprio consentimento';
    exception when insufficient_privilege then null;
    end;
  end
  $$;
rollback;

-- 7. Cascade: apagar o usuario leva o consentimento junto, sem deixar orfao.
do $$
declare
  restantes int;
begin
  delete from public.usuarios where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  select count(*) into restantes from public.consentimentos_lgpd
   where usuario_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if restantes <> 0 then
    raise exception 'consentimento sobreviveu ao delete do usuario';
  end if;
end
$$;

select 'migration 008 ok' as resultado;
