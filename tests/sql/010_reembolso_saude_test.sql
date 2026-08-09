-- Fase 15 - o que a migration 010 promete, verificado no Postgres de verdade.
--
-- Rodar via tests/sql/run_migrations_docker.sh.

\set ON_ERROR_STOP on

-- 1. Idempotencia. As tres partes da 010 sao rodadas duas vezes: a coluna usa
-- `add column if not exists`, as duas constraints usam `drop ... if exists`
-- antes do add, e a funcao e `create or replace`.
\i /migrations/010_reembolso_saude.sql

-- 2. Massa propria (os uuids da 009 podem ja ter sido consumidos por ela).
insert into auth.users (id) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

insert into public.usuarios (id, email, telefone_whatsapp) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'e@exemplo.test', '+5511999990005');

insert into public.recibos_evidencias
  (id, usuario_id, origem, descricao, valor, categoria, deducibilidade, status)
values
  -- Sem reembolso informado (o estado de toda linha anterior a esta migration).
  ('aaaa1111-aaaa-4aaa-8aaa-aaaa11111111', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'WHATSAPP_TEXTO', 'Consulta medica', 500, 'SAUDE', 'DEDUTIVEL', 'RECEBIDO'),
  -- Reembolso parcial.
  ('aaaa2222-aaaa-4aaa-8aaa-aaaa22222222', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'WHATSAPP_TEXTO', 'Sessao de fisioterapia', 400, 'SAUDE', 'DEDUTIVEL', 'RECEBIDO'),
  -- Reembolso integral: continua sendo despesa de 300 no total, e 0 dedutivel.
  ('aaaa3333-aaaa-4aaa-8aaa-aaaa33333333', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'WHATSAPP_TEXTO', 'Exame de imagem', 300, 'SAUDE', 'NAO_DEDUTIVEL', 'RECEBIDO'),
  -- Confirmado que NAO houve reembolso: 0 e resposta, nao ausencia.
  ('aaaa4444-aaaa-4aaa-8aaa-aaaa44444444', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   'WHATSAPP_TEXTO', 'Consulta odontologica', 250, 'SAUDE', 'DEDUTIVEL', 'RECEBIDO');

update public.recibos_evidencias set valor_reembolsado = 150
 where id = 'aaaa2222-aaaa-4aaa-8aaa-aaaa22222222';
update public.recibos_evidencias set valor_reembolsado = 300, deducibilidade = 'NAO_DEDUTIVEL'
 where id = 'aaaa3333-aaaa-4aaa-8aaa-aaaa33333333';
update public.recibos_evidencias set valor_reembolsado = 0
 where id = 'aaaa4444-aaaa-4aaa-8aaa-aaaa44444444';

-- 3. Estado default e constraint de valor_reembolsado.
do $$
begin
  if (select valor_reembolsado from public.recibos_evidencias
       where id = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111') is not null then
    raise exception 'coluna nova nasceu com default em vez de NULL';
  end if;

  -- NULL e 0 precisam continuar distinguiveis: o primeiro e lacuna, o segundo e
  -- resposta do usuario. Um default 0 apagaria a diferenca sem erro nenhum.
  if (select valor_reembolsado from public.recibos_evidencias
       where id = 'aaaa4444-aaaa-4aaa-8aaa-aaaa44444444') is distinct from 0 then
    raise exception 'reembolso zero nao foi gravado como zero';
  end if;

  begin
    update public.recibos_evidencias set valor_reembolsado = -1
     where id = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111';
    raise exception 'reembolso negativo foi aceito';
  exception when check_violation then null;
  end;

  -- Reembolso maior que a despesa nao e reembolso. Ultima barreira depois da
  -- guarda equivalente na followup-resolve.
  begin
    update public.recibos_evidencias set valor_reembolsado = 500.01
     where id = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111';
    raise exception 'reembolso maior que o valor da despesa foi aceito';
  exception when check_violation then null;
  end;

  -- O limite e o valor da PROPRIA linha, nao um teto fixo.
  update public.recibos_evidencias set valor_reembolsado = 500
   where id = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111';
  update public.recibos_evidencias set valor_reembolsado = null
   where id = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111';

  -- valor continua com a constraint de sempre: guardar o liquido de um
  -- reembolso integral seria zero, e zero nao entra nesta coluna. E o quarto
  -- motivo do cabecalho da migration, verificado e nao inferido.
  begin
    update public.recibos_evidencias set valor = 0
     where id = 'aaaa3333-aaaa-4aaa-8aaa-aaaa33333333';
    raise exception 'valor zero foi aceito na coluna do bruto';
  exception when check_violation then null;
  end;
end
$$;

-- 4. campo_alvo aceita o campo novo e continua recusando o que nao e respondivel.
do $$
begin
  insert into public.followups_pendentes
    (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'aaaa2222-aaaa-4aaa-8aaa-aaaa22222222',
          'valor_reembolso', 'Esse valor foi reembolsado?', now() + interval '30 minutes');

  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111',
            'valor', 'Quanto foi?', now() + interval '30 minutes');
    raise exception 'campo_alvo fora da lista de respondiveis foi aceito';
  exception when check_violation then null;
  end;

  -- A unique parcial nao afrouxou junto com a constraint: continua sendo uma
  -- pendencia aberta por usuario, com o campo novo disputando a mesma vaga.
  begin
    insert into public.followups_pendentes
      (usuario_id, recibo_id, campo_alvo, pergunta, expira_em)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'aaaa1111-aaaa-4aaa-8aaa-aaaa11111111',
            'documento_prestador', 'Voce tem o CNPJ?', now() + interval '30 minutes');
    raise exception 'duas pendencias abertas para o mesmo usuario foram aceitas';
  exception when unique_violation then null;
  end;
end
$$;

-- 5. A RPC do resumo: total continua bruto, total_dedutivel passa a ser liquido.
do $$
declare
  v_total numeric;
  v_dedutivel numeric;
begin
  select total, total_dedutivel into v_total, v_dedutivel
    from public.resumo_fiscal_usuario('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
   where categoria = 'SAUDE';

  -- 500 + 400 + 300 + 250. Reembolso nao desfaz o desembolso.
  if v_total <> 1450 then
    raise exception 'total deixou de ser o bruto gasto (veio %)', v_total;
  end if;

  -- Dedutiveis: 500 (sem reembolso) + (400 - 150) + (250 - 0) = 1000.
  -- O recibo integralmente reembolsado esta como NAO_DEDUTIVEL e ja ficava de
  -- fora; quem prova o desconto e o de 400.
  if v_dedutivel <> 1000 then
    raise exception 'total_dedutivel nao descontou o reembolso (veio %)', v_dedutivel;
  end if;
end
$$;

-- 6. Linha anterior a migration nao muda de numero.
--
-- E a promessa do coalesce, e sem este bloco a mudanca do item 5 poderia estar
-- somando NULL e zerando categoria inteira sem ninguem perceber.
do $$
declare
  v_dedutivel numeric;
begin
  insert into auth.users (id) values ('ffffffff-ffff-4fff-8fff-ffffffffffff');
  insert into public.usuarios (id, email, telefone_whatsapp)
  values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'f@exemplo.test', '+5511999990006');

  insert into public.recibos_evidencias
    (usuario_id, origem, descricao, valor, categoria, deducibilidade)
  values
    ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'WHATSAPP_TEXTO', 'Consulta', 200, 'SAUDE', 'DEDUTIVEL'),
    ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'WHATSAPP_TEXTO', 'Exame', 120, 'SAUDE', 'DEDUTIVEL');

  select total_dedutivel into v_dedutivel
    from public.resumo_fiscal_usuario('ffffffff-ffff-4fff-8fff-ffffffffffff')
   where categoria = 'SAUDE';

  if v_dedutivel <> 320 then
    raise exception 'linha sem reembolso informado mudou de total (veio %)', v_dedutivel;
  end if;
end
$$;

-- 7. A RPC continua SECURITY INVOKER depois do create or replace.
--
-- O replace reescreve o corpo inteiro, entao a propriedade que protege o resumo
-- alheio precisa ser reafirmada aqui: com DEFINER, qualquer authenticated leria
-- o financeiro de outro passando o uuid.
do $$
begin
  if (select prosecdef from pg_proc where proname = 'resumo_fiscal_usuario') then
    raise exception 'resumo_fiscal_usuario virou SECURITY DEFINER';
  end if;

  if not has_function_privilege('service_role', 'public.resumo_fiscal_usuario(uuid)', 'EXECUTE') then
    raise exception 'service_role perdeu o EXECUTE do resumo';
  end if;
  if not has_function_privilege('authenticated', 'public.resumo_fiscal_usuario(uuid)', 'EXECUTE') then
    raise exception 'authenticated perdeu o EXECUTE do resumo';
  end if;
end
$$;

-- 8. Isolamento do resumo com a coluna nova, dentro de transacao.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  do $$
  declare
    alheias int;
  begin
    select count(*) into alheias
      from public.resumo_fiscal_usuario('ffffffff-ffff-4fff-8fff-ffffffffffff');
    if alheias <> 0 then
      raise exception 'titular leu o resumo alheio (viu % categorias)', alheias;
    end if;
  end
  $$;
rollback;

select 'migration 010 ok' as resultado;
