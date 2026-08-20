-- Fase 18 - o que a migration 012 promete, verificado no Postgres de verdade.
--
-- Rodar via tests/sql/run_migrations_docker.sh.
--
-- O que so o banco prova (e o teste de Deno nao alcanca): a janela do ano, a
-- exclusao de status descartado, o liquido do reembolso na agregacao por
-- categoria e o modo de seguranca da funcao.

\set ON_ERROR_STOP on

-- 1. Idempotencia: a funcao e `create or replace`.
\i /migrations/012_pontos_atencao.sql

-- 2. Massa propria (os uuids das outras suites ja podem ter sido consumidos).
insert into auth.users (id) values
  ('12120000-1212-4121-8121-121200000001');

insert into public.usuarios (id, email, telefone_whatsapp) values
  ('12120000-1212-4121-8121-121200000001', 'atencao@exemplo.test', '+5511999990012');

-- Datas ancoradas no ano corrente da funcao, e nao em literais: a janela e
-- movel e um teste com "2026-03-10" cravado passaria a falhar sozinho na virada
-- do ano.
create temporary view ano_corrente as
  select extract(year from (now() at time zone 'America/Sao_Paulo'))::int as y;

insert into public.recibos_evidencias
  (id, usuario_id, origem, descricao, valor, categoria, deducibilidade, status,
   documento_prestador, estabelecimento, data_despesa, valor_reembolsado, criado_em)
select * from (values
  -- (a) Sem nenhum dos dois campos de identificacao, e ainda deduzivel: SINAL 1.
  ('c0000001-0000-4000-8000-000000000001'::uuid, '12120000-1212-4121-8121-121200000001'::uuid,
   'WHATSAPP_TEXTO'::public.origem_evidencia, 'Consulta sem prestador', 300::numeric,
   'SAUDE'::public.categoria_fiscal, 'INDETERMINADO'::public.status_deducibilidade,
   'REVISAO_HUMANA'::public.status_processamento,
   null::text, null::text, make_date((select y from ano_corrente), 3, 10), null::numeric, now()),

  -- (b) So o estabelecimento preenchido: NAO e sinal 1 (um dos dois basta), mas
  -- e SAUDE deduzivel sem reembolso informado, entao e sinal 2.
  ('c0000002-0000-4000-8000-000000000002', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Consulta com clinica', 400,
   'SAUDE', 'DEDUTIVEL', 'APROVADO_AUTOMATICAMENTE',
   null, 'Clinica Teste', make_date((select y from ano_corrente), 3, 11), null, now()),

  -- (c) SAUDE com reembolso ja respondido (0 = confirmou que nao houve): fora
  -- do sinal 2. Entra em totais_categoria pelo liquido, que aqui e o bruto.
  ('c0000003-0000-4000-8000-000000000003', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Exame respondido', 500,
   'SAUDE', 'DEDUTIVEL', 'APROVADO_AUTOMATICAMENTE',
   '12.345.678/0001-95', 'Lab Teste', make_date((select y from ano_corrente), 3, 12), 0, now()),

  -- (d) SAUDE com reembolso parcial: totais_categoria tem que somar o LIQUIDO.
  ('c0000004-0000-4000-8000-000000000004', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Fisioterapia reembolsada', 1000,
   'SAUDE', 'DEDUTIVEL', 'APROVADO_AUTOMATICAMENTE',
   '12.345.678/0001-95', 'Clinica Teste', make_date((select y from ano_corrente), 3, 13), 400, now()),

  -- (e) SAUDE NAO_DEDUTIVEL sem reembolso: fora do sinal 2 (reembolso so importa
  -- no que vai ser declarado) e fora de totais_categoria.
  ('c0000005-0000-4000-8000-000000000005', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Estetica', 700,
   'SAUDE', 'NAO_DEDUTIVEL', 'APROVADO_AUTOMATICAMENTE',
   '12.345.678/0001-95', 'Clinica Teste', make_date((select y from ano_corrente), 3, 14), null, now()),

  -- (f) Uso misto: SINAL 3. Sem identificacao nenhuma de proposito, para provar
  -- que ele NAO conta tambem no sinal 1.
  ('c0000006-0000-4000-8000-000000000006', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Internet do home office', 200,
   'INTERNET_TELEFONIA', 'PARCIALMENTE_DEDUTIVEL', 'REVISAO_HUMANA',
   null, null, make_date((select y from ano_corrente), 3, 15), null, now()),

  -- (g) Em revisao ha 45 dias: SINAL 4. E o mais antigo dos parados.
  ('c0000007-0000-4000-8000-000000000007', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Parado velho', 150,
   'ESCRITORIO', 'DEDUTIVEL', 'REVISAO_HUMANA',
   '12.345.678/0001-95', 'Papelaria', make_date((select y from ano_corrente), 3, 16), null,
   now() - interval '45 days'),

  -- (h) Em revisao ha 45 dias, mas JA REVISADO: fora do sinal 4.
  ('c0000008-0000-4000-8000-000000000008', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Parado mas revisado', 160,
   'ESCRITORIO', 'DEDUTIVEL', 'REVISAO_HUMANA',
   '12.345.678/0001-95', 'Papelaria', make_date((select y from ano_corrente), 3, 17), null,
   now() - interval '45 days'),

  -- (i) REJEITADO com todos os sinais ligados: nao pode aparecer em nenhum.
  ('c0000009-0000-4000-8000-000000000009', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Descartado', 900,
   'SAUDE', 'DEDUTIVEL', 'REJEITADO',
   null, null, make_date((select y from ano_corrente), 3, 18), null, now() - interval '90 days'),

  -- (j) ANO ANTERIOR, com todos os sinais ligados: fora da janela.
  ('c000000a-0000-4000-8000-00000000000a', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Do ano passado', 800,
   'SAUDE', 'DEDUTIVEL', 'REVISAO_HUMANA',
   null, null, make_date((select y from ano_corrente) - 1, 3, 19), null,
   now() - interval '400 days'),

  -- (l) Em revisao ha 10 dias: fora do limiar padrao (30), dentro de um limiar
  -- menor. E a linha que prova que p_dias_revisao muda a resposta de verdade.
  ('c000000c-0000-4000-8000-00000000000c', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Parado recente', 170,
   'ESCRITORIO', 'DEDUTIVEL', 'REVISAO_HUMANA',
   '12.345.678/0001-95', 'Papelaria', make_date((select y from ano_corrente), 3, 20), null,
   now() - interval '10 days'),

  -- (k) Sem data_despesa: a janela cai em criado_em, que e deste ano.
  ('c000000b-0000-4000-8000-00000000000b', '12120000-1212-4121-8121-121200000001',
   'WHATSAPP_TEXTO', 'Sem data informada', 250,
   'EDUCACAO', 'DEDUTIVEL', 'APROVADO_AUTOMATICAMENTE',
   '12.345.678/0001-95', 'Escola', null, null, now())
) as t;

update public.recibos_evidencias
   set revisado_em = now() - interval '10 days'
 where id = 'c0000008-0000-4000-8000-000000000008';

-- 3. As quatro contagens.
do $$
declare
  r record;
begin
  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-121200000001');

  if r.ano_referencia is distinct from extract(year from (now() at time zone 'America/Sao_Paulo'))::int then
    raise exception 'ano_referencia nao e o ano de Sao Paulo: %', r.ano_referencia;
  end if;

  -- So (a). (b) tem estabelecimento, (f) e parcialmente dedutivel, (i) esta
  -- rejeitado e (j) e do ano passado.
  if r.sem_identificacao <> 1 then
    raise exception 'sem_identificacao esperado 1, veio %', r.sem_identificacao;
  end if;

  -- (a) e (b). (c) e (d) ja responderam, (e) e nao dedutivel, (i)/(j) fora.
  if r.saude_sem_reembolso <> 2 then
    raise exception 'saude_sem_reembolso esperado 2, veio %', r.saude_sem_reembolso;
  end if;

  -- So (f).
  if r.uso_misto <> 1 then
    raise exception 'uso_misto esperado 1, veio %', r.uso_misto;
  end if;

  -- So (g): (h) foi revisado e (j) esta fora da janela do ano, apesar de velha.
  if r.revisao_parada <> 1 then
    raise exception 'revisao_parada esperado 1, veio %', r.revisao_parada;
  end if;

  if r.revisao_parada_desde is distinct from (now() - interval '45 days')::date then
    raise exception 'revisao_parada_desde errado: %', r.revisao_parada_desde;
  end if;
end
$$;

-- 4. O limiar de dias e parametro de verdade, e nao numero cravado no corpo.
do $$
declare
  r record;
begin
  -- Com 60 dias, nem (g) (45 dias) esta parado.
  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-121200000001', 60);
  if r.revisao_parada <> 0 then
    raise exception 'com 60 dias nada devia estar parado, veio %', r.revisao_parada;
  end if;

  -- Com 5 dias, entram (g) 45 dias e (l) 10 dias. (h) continua fora por ter
  -- sido revisado, e (a)/(f) sao de hoje.
  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-121200000001', 5);
  if r.revisao_parada <> 2 then
    raise exception 'com 5 dias esperava 2 parados (g e l), veio %', r.revisao_parada;
  end if;
end
$$;

-- 5. totais_categoria: so DEDUTIVEL, pelo liquido do reembolso, e sem categoria
-- de total zero.
do $$
declare
  r record;
  v_saude numeric;
  v_educacao numeric;
begin
  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-121200000001');

  select (item->>'total_dedutivel')::numeric into v_saude
    from jsonb_array_elements(r.totais_categoria) item
   where item->>'categoria' = 'SAUDE';

  -- (b) 400 + (c) 500 + (d) 1000-400 = 1500. (a) e INDETERMINADO, (e) e
  -- NAO_DEDUTIVEL, (i) rejeitado, (j) do ano passado.
  if v_saude is distinct from 1500 then
    raise exception 'total dedutivel de saude esperado 1500, veio %', v_saude;
  end if;

  select (item->>'total_dedutivel')::numeric into v_educacao
    from jsonb_array_elements(r.totais_categoria) item
   where item->>'categoria' = 'EDUCACAO';

  -- (k): entrou pela janela via criado_em, ja que data_despesa e nula.
  if v_educacao is distinct from 250 then
    raise exception 'total dedutivel de educacao esperado 250, veio %', v_educacao;
  end if;

  -- INTERNET_TELEFONIA so tem linha PARCIALMENTE_DEDUTIVEL, que nao entra.
  if exists (
    select 1 from jsonb_array_elements(r.totais_categoria) item
     where item->>'categoria' = 'INTERNET_TELEFONIA'
  ) then
    raise exception 'categoria sem dedutivel apareceu em totais_categoria';
  end if;
end
$$;

-- 6. Usuario sem nenhuma despesa continua recebendo UMA linha, com zeros e
-- lista vazia. Um resultado vazio faria a Edge Function tratar "sem despesa"
-- como "consulta falhou", e o bloco sumiria por motivo errado.
do $$
declare
  r record;
  n int;
begin
  select count(*) into n
    from public.pontos_atencao_usuario('12120000-1212-4121-8121-12120000ffff');
  if n <> 1 then
    raise exception 'usuario sem despesa devolveu % linhas', n;
  end if;

  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-12120000ffff');
  if r.sem_identificacao <> 0 or r.saude_sem_reembolso <> 0
     or r.uso_misto <> 0 or r.revisao_parada <> 0 then
    raise exception 'usuario sem despesa veio com contagem nao nula';
  end if;
  if r.totais_categoria is distinct from '[]'::jsonb then
    raise exception 'totais_categoria devia ser lista vazia, veio %', r.totais_categoria;
  end if;
end
$$;

-- 7. SECURITY INVOKER, e nao DEFINER.
--
-- A funcao recebe usuario_id por PARAMETRO. Com DEFINER, qualquer authenticated
-- leria os pontos de atencao alheios passando o uuid do outro — o mesmo motivo
-- escrito por extenso na 004.
do $$
begin
  if (select prosecdef from pg_proc where proname = 'pontos_atencao_usuario') then
    raise exception 'pontos_atencao_usuario esta SECURITY DEFINER';
  end if;

  if not has_function_privilege('service_role', 'public.pontos_atencao_usuario(uuid, int)', 'execute') then
    raise exception 'service_role nao pode executar a funcao';
  end if;
end
$$;

-- 8. Como authenticated, o uuid alheio devolve zeros: a RLS de
-- recibos_evidencias continua valendo dentro da funcao.
--
-- begin/rollback obrigatorio: `set local role` fora de transacao e ignorado com
-- um WARNING e o psql segue como superusuario — o teste passaria sem testar
-- nada (armadilha registrada em AGENTS.md).
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"12120000-1212-4121-8121-12120000aaaa"}';

do $$
declare
  r record;
begin
  select * into r from public.pontos_atencao_usuario('12120000-1212-4121-8121-121200000001');
  if r.sem_identificacao <> 0 or r.saude_sem_reembolso <> 0 or r.uso_misto <> 0 then
    raise exception 'authenticated leu os pontos de atencao de outro usuario';
  end if;
  if r.totais_categoria is distinct from '[]'::jsonb then
    raise exception 'authenticated leu os totais de outro usuario';
  end if;
end
$$;

rollback;
