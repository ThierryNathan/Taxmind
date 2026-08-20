-- Fase 18 - Pontos de atencao antes de declarar.
--
-- O QUE ESTA MIGRATION NAO E
--
-- Nao e preditor de malha fina. O algoritmo de selecao da Receita e
-- confidencial e o TaxMind nao tem acesso a ele. Esta funcao agrega sinais que
-- o sistema JA gravou, escolhidos por serem causas conhecidas e documentadas de
-- pedido de comprovacao. Nenhum numero daqui pode ser apresentado como
-- probabilidade, e o texto que os consome (_shared/pontos_atencao.ts) tem essa
-- regra escrita.
--
-- Nada aqui reclassifica, promove ou rebaixa despesa: e leitura pura.
--
-- Estado encontrado antes desta migration (conferido na 001, 004 e 010, e no
-- banco de producao, nao assumido):
--   - recibos_evidencias ja guarda documento_prestador, estabelecimento,
--     deducibilidade, status, revisado_em, valor_reembolsado e categoria;
--   - resumo_fiscal_usuario (004, reescrita na 010) agrega o historico INTEIRO
--     por categoria e e SECURITY INVOKER;
--   - idx_recibos_usuario_status e idx_recibos_usuario_data ja existem, entao
--     nao ha indice novo a criar aqui;
--   - revisado_em e revisado_por sao declarados na 001 e NAO SAO ESCRITOS por
--     nenhum componente do repositorio: nao existe painel de revisao no MVP.
--     A clausula `revisado_em is null` abaixo e, portanto, inerte hoje. Ela
--     fica porque o sinal seria falso no dia em que a revisao existir, e um
--     sinal que so fica certo por acidente e um bug adiado.
--
-- POR QUE AGREGAR EM SQL, E NAO NA EDGE FUNCTION
--
-- A alternativa era a function baixar as linhas e contar em TypeScript, como
-- declaracao-resumo faz hoje. Medido no banco real: o usuario com mais volume
-- tem 244 linhas, das quais 221 vieram do Open Finance. Um usuario de Open
-- Finance ativo passa de mil linhas por ano com facilidade, e transferir mil
-- linhas para produzir quatro contagens desperdicaria banda e ainda esbarraria
-- no teto de linhas do PostgREST — que hoje nao aparece so por causa do volume
-- baixo. Aqui a conta acontece onde o dado esta.
--
-- O JUIZO DE PRODUTO NAO ESTA AQUI. Esta funcao devolve CONTAGENS e o dedutivel
-- por categoria; o criterio de "salto" ano a ano, os limiares e todo o texto
-- vivem em _shared/pontos_atencao.ts, testaveis sem banco.
--
-- SECURITY INVOKER, pelo mesmo motivo escrito por extenso na 004: a funcao
-- recebe p_usuario_id por parametro, e com DEFINER qualquer authenticated leria
-- os pontos de atencao alheios passando o uuid do outro.

create or replace function public.pontos_atencao_usuario(
  p_usuario_id uuid,
  p_dias_revisao int default 30
)
returns table (
  ano_referencia int,
  sem_identificacao int,
  saude_sem_reembolso int,
  uso_misto int,
  revisao_parada int,
  revisao_parada_desde date,
  totais_categoria jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with referencia as (
    -- O ano e o de America/Sao_Paulo, e nao o de UTC: em 31 de dezembro as 22h
    -- ja seria o ano seguinte em UTC, e a janela viraria antes da virada para
    -- quem esta olhando. Mesma regra da declaracao-resumo.
    select extract(year from (now() at time zone 'America/Sao_Paulo'))::int as ano
  ),
  base as (
    select r.*
      from public.recibos_evidencias r, referencia
     -- REJEITADO e ARQUIVADO sao decisoes ja tomadas de que a linha nao vale
     -- como evidencia (mesma lista de STATUS_FORA_DO_EXPORT). Cobrar atencao
     -- sobre elas seria desfazer a decisao.
     where r.usuario_id = p_usuario_id
       and r.status not in ('REJEITADO', 'ARQUIVADO')
       -- Todos os sinais na MESMA janela de proposito. "Pontos de atencao antes
       -- de declarar" e sobre a declaracao que esta sendo preparada; contar
       -- alguns sinais no ano e outros no historico inteiro produziria uma lista
       -- em que os numeros nao conversam entre si.
       and extract(
             year from coalesce(
               r.data_despesa,
               (r.criado_em at time zone 'America/Sao_Paulo')::date
             )
           )::int = referencia.ano
  ),
  contagens as (
    select
      -- 1. Nenhum dos dois campos de identificacao, numa linha que ainda pode
      -- ser deduzida. NAO_DEDUTIVEL fica de fora porque falta de prestador nao
      -- muda nada no que nao vai ser deduzido; PARCIALMENTE_DEDUTIVEL tambem,
      -- porque ja aparece no sinal 3 e a linha nao pode contar duas vezes.
      --
      -- Linha de Open Finance entra normalmente. Ela nasce sem documento por
      -- natureza do canal, e e justamente por isso que deduzir uma transacao
      -- bancaria sem comprovante e ponto de atencao, e nao ruido a filtrar.
      count(*) filter (
        where deducibilidade in ('DEDUTIVEL', 'INDETERMINADO')
          and coalesce(btrim(documento_prestador), '') = ''
          and coalesce(btrim(estabelecimento), '') = ''
      )::int as sem_identificacao,

      -- 2. Saude sem resposta sobre reembolso. NULL e "nunca perguntado ou sem
      -- resposta" e 0 e "o titular confirmou que nao houve" (010), entao so o
      -- NULL e lacuna. NAO_DEDUTIVEL fica fora: reembolso so importa no que vai
      -- ser declarado, porque o cruzamento da Receita e com a DMED do que foi
      -- deduzido.
      count(*) filter (
        where categoria = 'SAUDE'
          and valor_reembolsado is null
          and deducibilidade <> 'NAO_DEDUTIVEL'
      )::int as saude_sem_reembolso,

      -- 3. Uso misto. O sistema NAO guarda percentual de rateio em lugar nenhum
      -- — nem coluna, nem campo no schema do prompt fiscal —, entao "parcial sem
      -- percentual documentado" e o mesmo conjunto que "parcial". A contagem e
      -- honesta sobre isso: o texto diz que o percentual precisa ser definido
      -- com o contador, e nao finge que algumas linhas ja teriam a informacao.
      count(*) filter (where deducibilidade = 'PARCIALMENTE_DEDUTIVEL')::int as uso_misto,

      -- 4. Parado em revisao. O limiar chega por parametro para o valor de
      -- produto morar no TypeScript junto com o texto que o explica.
      count(*) filter (
        where status = 'REVISAO_HUMANA'
          and revisado_em is null
          and criado_em < now() - make_interval(days => p_dias_revisao)
      )::int as revisao_parada,

      min(criado_em) filter (
        where status = 'REVISAO_HUMANA'
          and revisado_em is null
          and criado_em < now() - make_interval(days => p_dias_revisao)
      )::date as revisao_parada_desde
    from base
  ),
  por_categoria as (
    -- Mesma regra do resumo_fiscal_usuario e do dossie: so DEDUTIVEL entra, e
    -- entra pelo liquido do reembolso. E o unico numero comparavel com o que
    -- foi (ou seria) declarado na ficha de Pagamentos Efetuados.
    --
    -- Devolve TODAS as categorias com dedutivel positivo. Quais delas valem
    -- comparacao com a declaracao anterior e decisao de produto, e fica em
    -- _shared/declaracao_anterior.ts (CATEGORIAS_ACOMPANHADAS) — repetir a lista
    -- aqui criaria duas copias da mesma regra em linguagens diferentes.
    select coalesce(
             jsonb_agg(
               jsonb_build_object('categoria', categoria::text, 'total_dedutivel', total)
               order by total desc
             ),
             '[]'::jsonb
           ) as totais
      from (
        select categoria, sum(valor - coalesce(valor_reembolsado, 0)) as total
          from base
         where deducibilidade = 'DEDUTIVEL'
         group by categoria
        having sum(valor - coalesce(valor_reembolsado, 0)) > 0
      ) t
  )
  select
    referencia.ano,
    contagens.sem_identificacao,
    contagens.saude_sem_reembolso,
    contagens.uso_misto,
    contagens.revisao_parada,
    contagens.revisao_parada_desde,
    por_categoria.totais
  from referencia, contagens, por_categoria;
$$;

comment on function public.pontos_atencao_usuario(uuid, int) is
  'Contagens de pontos de atencao do ano-calendario corrente, mais o dedutivel liquido por categoria. NAO e preditor de malha fina: agrega sinais ja gravados que sao causas conhecidas de pedido de comprovacao. SECURITY INVOKER: respeita RLS para authenticated e depende de BYPASSRLS para service_role.';

grant execute on function public.pontos_atencao_usuario(uuid, int) to service_role;
grant execute on function public.pontos_atencao_usuario(uuid, int) to authenticated;
