-- Fase 10 - Janela de agregacao dos eventos transactions/* do Pluggy.
--
-- Problema que esta tabela resolve, observado em log real de invocacao:
-- o Pluggy dispara um evento por CONTA, nao um por conexao. Um item com conta
-- corrente, poupanca e cartao produz tres webhooks em ~2 segundos, e cada um
-- cai numa invocacao ISOLADA da Edge Function (tres "booted" distintos no log).
-- Como cada encaminhamento ao n8n vira uma mensagem de WhatsApp, o usuario
-- recebia tres confirmacoes quase simultaneas ("25 despesas", "25 despesas",
-- "23 despesas") em vez de uma dizendo 73.
--
-- Nao ha estado compartilhado entre invocacoes de Edge Function, entao a
-- agregacao precisa de um ponto de encontro fora do processo. Esta tabela e
-- esse ponto: cada evento grava seu lote ja normalizado, espera a janela curta
-- e disputa a reivindicacao. Quem vence encaminha tudo junto.
--
-- Por que uma tabela e nao advisory lock: o lock resolveria a exclusao mutua,
-- mas ainda faltaria onde guardar o payload de quem chegou antes. A tabela
-- resolve as duas coisas com um mecanismo so.
--
-- Retencao: linha e transitoria (segundos). A propria pluggy-webhook apaga o
-- que ja foi consumido e o que ficou orfao; ver limpeza oportunista la.

create table if not exists public.open_finance_lotes_pendentes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  pluggy_item_id text not null,
  account_id text not null,
  origem text not null,
  -- Lote ja normalizado pela pluggy-webhook (mesmo formato que vai ao n8n).
  -- Guardar normalizado evita que o vencedor da reivindicacao tenha que
  -- refazer as consultas ao Pluggy das contas que nao sao a dele.
  transacoes jsonb not null,
  criado_em timestamptz not null default now(),
  consumido_em timestamptz
);

comment on table public.open_finance_lotes_pendentes is
  'Buffer de curta duracao (segundos) que junta os eventos transactions/* que o Pluggy dispara por conta, para que uma conexao com N contas gere UM encaminhamento ao n8n e UMA mensagem de WhatsApp, em vez de N. Escrita e leitura exclusivas da Edge Function pluggy-webhook (service_role).';

comment on column public.open_finance_lotes_pendentes.consumido_em is
  'Carimbo da reivindicacao. O UPDATE condicional "where consumido_em is null" e o que garante que apenas uma invocacao concorrente encaminhe o lote consolidado: o Postgres serializa os UPDATEs na mesma linha e reavalia o predicado, entao a segunda invocacao atualiza zero linhas.';

-- Indice do caminho quente: reivindicar tudo que esta pendente de um item.
-- Parcial de proposito — linha consumida so interessa a limpeza.
create index if not exists idx_of_lotes_pendentes_item
  on public.open_finance_lotes_pendentes (pluggy_item_id)
  where consumido_em is null;

-- Limpeza por idade.
create index if not exists idx_of_lotes_pendentes_criado_em
  on public.open_finance_lotes_pendentes (criado_em);

alter table public.open_finance_lotes_pendentes enable row level security;

-- Sem policy nenhuma: RLS habilitada e sem policy ja nega tudo para anon e
-- authenticated. Nao existe caso de uso de leitura pelo usuario final — a
-- tabela e um detalhe de implementacao do webhook, e o dado definitivo vive em
-- recibos_evidencias.
--
-- O revoke abaixo nao e redundante. Este projeto tem
-- `alter default privileges ... grant all on tables to anon, authenticated,
-- service_role` no schema public, entao a tabela NASCE com privilegio total
-- para a anon key. Hoje a RLS segura; um `disable row level security`
-- acidental no futuro exporia transacao bancaria de todos os usuarios para
-- qualquer portador da chave publica. Mesmo raciocinio ja aplicado nas tabelas
-- de credencial da migration 006.
revoke all on public.open_finance_lotes_pendentes from anon, authenticated;

grant select, insert, update, delete on public.open_finance_lotes_pendentes to service_role;
