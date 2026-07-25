-- Agregacao do resumo fiscal por categoria, usada pelo fluxo de acompanhamento
-- (consulta "resumo" via WhatsApp) e pelo dossie em PDF.
--
-- SECURITY INVOKER (default) e proposital, nao esquecimento: a funcao recebe
-- p_usuario_id como parametro. Com SECURITY DEFINER, qualquer usuario
-- authenticated poderia chamar resumo_fiscal_usuario('<uuid-de-outra-pessoa>')
-- e ler o resumo financeiro alheio, furando a RLS de recibos_evidencias.
-- Como INVOKER:
--   - service_role (n8n/Edge Functions) tem BYPASSRLS e agrega normalmente;
--   - authenticated cai nas policies existentes e so enxerga as proprias linhas,
--     entao passar uuid de terceiro devolve conjunto vazio.
--
-- total_dedutivel soma apenas deducibilidade = 'DEDUTIVEL'. Despesas
-- PARCIALMENTE_DEDUTIVEL entram em "total" mas ficam fora de "total_dedutivel":
-- o schema nao guarda o percentual aproveitavel, e somar o valor cheio
-- superestimaria a deducao, criando expectativa que vira glosa.
--
-- Teste manual:
--   select * from public.resumo_fiscal_usuario('00000000-0000-0000-0000-000000000001');
--   -- esperado: uma linha por categoria com despesa, ordenada por total desc
--
--   -- validacao cruzada (os numeros devem bater):
--   select r.categoria::text, sum(r.valor), count(*)::int
--   from public.recibos_evidencias r
--   where r.usuario_id = '00000000-0000-0000-0000-000000000001'
--   group by r.categoria
--   order by sum(r.valor) desc;
--
--   -- conferencia da isolacao: como authenticated, o resultado deve vir vazio
--   -- para um uuid que nao seja o proprio auth.uid().

create or replace function public.resumo_fiscal_usuario(p_usuario_id uuid)
returns table (
  categoria text,
  total numeric,
  quantidade int,
  total_dedutivel numeric,
  pendente_revisao int
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    r.categoria::text,
    sum(r.valor),
    count(*)::int,
    coalesce(sum(r.valor) filter (where r.deducibilidade = 'DEDUTIVEL'), 0),
    (count(*) filter (where r.status = 'REVISAO_HUMANA'))::int
  from public.recibos_evidencias r
  where r.usuario_id = p_usuario_id
  group by r.categoria
  order by sum(r.valor) desc;
$$;

comment on function public.resumo_fiscal_usuario(uuid) is
  'Resumo fiscal agregado por categoria. SECURITY INVOKER: respeita RLS para authenticated e depende de BYPASSRLS para service_role.';

grant execute on function public.resumo_fiscal_usuario(uuid) to service_role;
grant execute on function public.resumo_fiscal_usuario(uuid) to authenticated;
