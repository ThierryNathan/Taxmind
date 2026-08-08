-- Arremedo minimo do ambiente Supabase para validar migrations num postgres
-- puro (imagem postgres:15), sem `supabase start`.
--
-- Cobre so o que as migrations do projeto tocam: os tres roles, o schema auth
-- com auth.users e auth.uid(), e o ALTER DEFAULT PRIVILEGES que o Supabase
-- configura no schema public — este ultimo e o que faz tabela nova nascer com
-- privilegio total para anon/authenticated, e por isso e o que da sentido aos
-- `revoke all` das migrations 006 e 008.

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- No Supabase o uid vem do JWT. Aqui vem de um GUC que o teste seta dentro da
-- transacao, que e o equivalente mais proximo e permite `set local`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
