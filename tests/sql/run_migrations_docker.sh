#!/usr/bin/env bash
# Aplica todas as migrations num postgres:15 limpo e roda os testes SQL.
#
#   bash tests/sql/run_migrations_docker.sh
#
# Mais rapido que `supabase start` e suficiente para constraint, trigger, RLS,
# privilegio e idempotencia. O que falta em relacao ao Supabase real esta em
# tests/sql/shim_supabase.sql.
set -euo pipefail

# No Git Bash o MSYS reescreve qualquer argumento com barra inicial para
# C:/Program Files/Git/... em TODO subcomando do docker (exec, cp), e a
# mensagem de erro sempre parece problema do arquivo.
export MSYS_NO_PATHCONV=1

CONTAINER="${CONTAINER:-taxmind-migrations-test}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# O docker e binario Windows: com MSYS_NO_PATHCONV=1 ligado, o caminho /c/Users
# do lado de fora chega cru e vira "CreateFile C:\c: file not found". O destino
# dentro do container continua sendo caminho POSIX, e e justamente ele que
# precisa do MSYS_NO_PATHCONV.
if command -v cygpath >/dev/null 2>&1; then
  RAIZ_HOST="$(cygpath -w "$RAIZ")"
else
  RAIZ_HOST="$RAIZ"
fi

limpar() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap limpar EXIT
limpar

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres postgres:15 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

docker cp "$RAIZ_HOST/supabase/migrations" "$CONTAINER:/migrations"
docker cp "$RAIZ_HOST/tests/sql" "$CONTAINER:/sql"

psql_arquivo() {
  docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f "$1"
}

echo "== shim do ambiente Supabase =="
psql_arquivo /sql/shim_supabase.sql

echo "== migrations =="
for arquivo in "$RAIZ"/supabase/migrations/*.sql; do
  nome="$(basename "$arquivo")"
  echo "-- $nome"
  psql_arquivo "/migrations/$nome"
done

echo "== testes SQL =="
for arquivo in "$RAIZ"/tests/sql/*_test.sql; do
  nome="$(basename "$arquivo")"
  echo "-- $nome"
  psql_arquivo "/sql/$nome"
done

echo "OK"
