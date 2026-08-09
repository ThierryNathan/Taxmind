-- Fase 15 - Reembolso de despesa de saude (DMED).
--
-- Estado encontrado antes desta migration (conferido na 001, 004 e 009, nao
-- assumido):
--   - recibos_evidencias.valor e numeric(12,2) not null com
--     recibos_valor_positivo_chk (valor > 0);
--   - followups_pendentes.campo_alvo e restrito por followups_campo_alvo_chk aos
--     dois campos de identificacao;
--   - resumo_fiscal_usuario soma valor cheio em total_dedutivel.
--
-- Tres mudancas, todas aditivas em relacao ao dado ja gravado.
--
-- 1. valor_reembolsado ao lado de valor, NUNCA no lugar dele.
--
-- Guardar o liquido na coluna valor foi descartado por quatro motivos
-- independentes, e vale registrar porque a tentacao volta:
--   a) quebraria a invariante escrita em docs/06 e no AGENTS.md — "valor e
--      data_despesa nunca sao reescritos por follow-up" — e a quebraria em
--      silencio, que e exatamente o que a regra existe para impedir;
--   b) a nota fiscal comprova o BRUTO. Com o liquido na coluna, a linha do
--      dossie deixa de bater com qualquer documento, e o cruzamento da DMED
--      (que a Receita faz sobre bruto + reembolso) fica irreconciliavel;
--   c) a coluna e o que todo consumidor le (resumo_fiscal_usuario,
--      generate-dossier, exports futuros). Guardar o bruto so em metadados_ia
--      deixaria a coluna errada e o rastro escondido;
--   d) reembolso integral daria liquido 0 e violaria recibos_valor_positivo_chk.
--      O modelo "liquido na coluna" simplesmente nao consegue representar
--      "totalmente reembolsado".
--
-- NULL e 0 sao estados diferentes de proposito, e um `default 0` apagaria a
-- distincao: NULL = nunca perguntado ou sem resposta; 0 = o usuario confirmou
-- que nao houve reembolso. O segundo e evidencia de auditoria, o primeiro e
-- lacuna.
--
-- 2. campo_alvo aceita valor_reembolso.
--
-- Mesma tabela followups_pendentes, e nao tabela propria: TTL, orcamento de
-- mensagens, SUPERSEDIDA, exclusao mutua e anotacao na whatsapp-webhook sao
-- todos por PENDENCIA, nao por tipo de campo. Tabela separada duplicaria as
-- seis coisas e criaria a pergunta "qual das duas tem a pendencia aberta?", que
-- e a fila de multiplas pendencias com outro nome — decidida fora de escopo.
--
-- 3. total_dedutivel passa a somar o liquido.
--
-- Correcao, nao so mudanca de numero: somar o bruto de uma despesa reembolsada
-- superestima a deducao, que e o gatilho de malha fina que esta fase existe para
-- evitar. coalesce(valor_reembolsado, 0) deixa toda linha anterior a esta
-- migration com o mesmo total de antes.

-- 1 -------------------------------------------------------------------------

alter table public.recibos_evidencias
  add column if not exists valor_reembolsado numeric(12, 2);

comment on column public.recibos_evidencias.valor_reembolsado is
  'Parte do valor devolvida por plano de saude, convenio, seguro ou empregador. NULL = nao perguntado ou sem resposta; 0 = o usuario confirmou que nao houve reembolso. O valor dedutivel e valor - coalesce(valor_reembolsado, 0); a coluna valor continua sendo o bruto pago, que e o que a nota comprova.';

-- Limite superior em valor, e nao so >= 0: reembolso maior que a despesa nao e
-- reembolso, e a constraint e a ultima barreira depois da guarda equivalente na
-- followup-resolve. O limite inferior aceita 0 porque 0 e resposta, nao ausencia.
alter table public.recibos_evidencias
  drop constraint if exists recibos_valor_reembolsado_chk;
alter table public.recibos_evidencias
  add constraint recibos_valor_reembolsado_chk
  check (
    valor_reembolsado is null
    or (valor_reembolsado >= 0 and valor_reembolsado <= valor)
  );

-- 2 -------------------------------------------------------------------------

alter table public.followups_pendentes
  drop constraint if exists followups_campo_alvo_chk;
alter table public.followups_pendentes
  add constraint followups_campo_alvo_chk
  check (campo_alvo in ('documento_prestador', 'estabelecimento', 'valor_reembolso'));

comment on column public.followups_pendentes.campo_alvo is
  'O que foi perguntado. documento_prestador e estabelecimento identificam o prestador; valor_reembolso pergunta se um plano devolveu parte da despesa de saude. Ambiguidade de categoria fiscal nao entra aqui: aquilo e decisao de contador, nao dado que falta.';

-- 3 -------------------------------------------------------------------------

-- SECURITY INVOKER continua sendo o ponto (ver o comentario longo na 004): a
-- funcao recebe p_usuario_id por parametro, e com DEFINER qualquer authenticated
-- leria o resumo financeiro alheio passando o uuid do outro.
--
-- total continua BRUTO: e a resposta de "quanto eu gastei", e o reembolso nao
-- desfaz o desembolso. So total_dedutivel muda, porque so ele responde "quanto
-- disso reduz a base de calculo".
--
-- Teste manual (os numeros devem bater):
--   select * from public.resumo_fiscal_usuario('<uuid>');
--   select r.categoria::text, sum(r.valor),
--          sum(r.valor - coalesce(r.valor_reembolsado, 0))
--            filter (where r.deducibilidade = 'DEDUTIVEL')
--     from public.recibos_evidencias r where r.usuario_id = '<uuid>'
--    group by r.categoria;
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
    coalesce(
      sum(r.valor - coalesce(r.valor_reembolsado, 0))
        filter (where r.deducibilidade = 'DEDUTIVEL'),
      0
    ),
    (count(*) filter (where r.status = 'REVISAO_HUMANA'))::int
  from public.recibos_evidencias r
  where r.usuario_id = p_usuario_id
  group by r.categoria
  order by sum(r.valor) desc;
$$;

comment on function public.resumo_fiscal_usuario(uuid) is
  'Resumo fiscal agregado por categoria. total e o bruto gasto; total_dedutivel desconta o reembolso informado. SECURITY INVOKER: respeita RLS para authenticated e depende de BYPASSRLS para service_role.';

grant execute on function public.resumo_fiscal_usuario(uuid) to service_role;
grant execute on function public.resumo_fiscal_usuario(uuid) to authenticated;
