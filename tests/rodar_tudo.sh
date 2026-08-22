#!/usr/bin/env bash
# Roda a suite inteira do TaxMind em sequencia e imprime UM resumo no final.
#
#   bash tests/rodar_tudo.sh                # tudo
#   bash tests/rodar_tudo.sh --offline      # so o que nao depende de rede nem de credencial
#   bash tests/rodar_tudo.sh --listar       # mostra o plano sem executar nada
#   bash tests/rodar_tudo.sh --ajuda
#
# ORDEM, E POR QUE ELA E ESSA
#
#   1. OFFLINE   - logica pura, espelhos de arquivo, Code node do n8n e as
#                  Edge Functions com fetch stubado. Rapido e sem dependencia
#                  externa: e aqui que a maioria dos erros aparece, entao vem
#                  primeiro para o ciclo curto continuar curto.
#   2. SQL       - migrations num postgres:15 limpo (Docker). Sai do processo
#                  do Deno e sobe container, entao custa mais que o grupo 1 e
#                  menos que os de rede.
#   3. REDE      - Gemini real, Pluggy real e o servico de parametros da
#                  Receita. Lentos, pagos e sujeitos a instabilidade de
#                  terceiro: falha aqui nem sempre e falha de codigo.
#   4. DEPLOY    - deploy_drift_test.ts por ultimo, sozinho. Ele e o unico
#                  teste da casa que NAO afirma nada sobre o repositorio: ele
#                  compara o que esta PUBLICADO no Supabase com o que esta no
#                  disco. Rodar antes dos outros inverteria a leitura do
#                  resultado -- "o codigo esta certo?" tem que ser respondido
#                  antes de "o que esta no ar e esse codigo?".
#
# CADA ARQUIVO RODA NO SEU PROPRIO PROCESSO, E ISSO NAO E ESTILO
#
#   Cinco suites importam o index.ts real de uma Edge Function, que chama
#   serve() na porta 8000. Duas delas no mesmo `deno test` colidem na porta.
#   Um processo por arquivo tambem isola o Deno.env.set() que varias fazem no
#   topo do modulo.
#
# STATUS QUE O RESUMO USA
#
#   OK        passou
#   FALHOU    o `deno test` reportou teste falhando
#   ERRO      o processo morreu sem resumo (erro de compilacao, porta ocupada)
#   IGNORADO  o arquivo rodou mas TODOS os testes foram pulados por falta de
#             credencial. Nao e verde: nada foi provado.
#   PULADO    nem chegou a rodar (pre-requisito ausente ou flag de linha de
#             comando)
#
# O script nao commita, nao faz push e nao altera nada do repositorio alem de
# escrever os logs em tests/.logs/.

set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 2

# deploy_drift_test.ts e os testes do Gemini leem .env por caminho relativo.
# Rodar de outro diretorio os faria pular sozinhos sem dizer por que.

LOGS="$RAIZ/tests/.logs"
rm -rf "$LOGS"
mkdir -p "$LOGS"

# --- opcoes ---------------------------------------------------------------

RODAR_OFFLINE=1
RODAR_SQL=1
RODAR_REDE=1
RODAR_DRIFT=1
SO_LISTAR=0

ajuda() {
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | sed '$d'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --offline)      RODAR_REDE=0; RODAR_DRIFT=0 ;;
    --pular-sql)    RODAR_SQL=0 ;;
    --pular-rede)   RODAR_REDE=0 ;;
    --pular-drift)  RODAR_DRIFT=0 ;;
    --so-rede)      RODAR_OFFLINE=0; RODAR_SQL=0; RODAR_DRIFT=0 ;;
    --so-drift)     RODAR_OFFLINE=0; RODAR_SQL=0; RODAR_REDE=0 ;;
    --listar)       SO_LISTAR=1 ;;
    --ajuda|-h|--help) ajuda ;;
    *) echo "opcao desconhecida: $arg (use --ajuda)" >&2; exit 2 ;;
  esac
done

# --- coleta de resultados -------------------------------------------------

R_GRUPO=(); R_ROTULO=(); R_STATUS=(); R_PASSOU=(); R_FALHOU=()
R_IGNORADO=(); R_SEGUNDOS=(); R_LOG=(); R_NOTA=(); R_PASSOS=()

TOTAL_PASSOU=0
TOTAL_FALHOU=0
TOTAL_IGNORADO=0
SUITES_RUINS=0

registrar() {
  R_GRUPO+=("$1"); R_ROTULO+=("$2"); R_STATUS+=("$3"); R_PASSOU+=("$4")
  R_FALHOU+=("$5"); R_IGNORADO+=("$6"); R_SEGUNDOS+=("$7"); R_LOG+=("$8")
  R_NOTA+=("${9:-}"); R_PASSOS+=("${10:--}")
}

pular() { registrar "$1" "$2" "PULADO" 0 0 0 0 "-" "$3"; }

# --- porta 8000 -----------------------------------------------------------

# As suites que sobem serve() liberam a porta ao sair, mas o socket pode ficar
# alguns instantes em TIME_WAIT no Windows. Esperar aqui evita um "ERRO:
# AddrInUse" que nao tem nada a ver com o teste.
esperar_porta_livre() {
  command -v netstat >/dev/null 2>&1 || return 0
  local i
  for i in $(seq 1 20); do
    netstat -an 2>/dev/null | grep -qE "[:.]8000[[:space:]]+.*LISTEN" || return 0
    sleep 0.5
  done
  return 0
}

# --- execucao de uma suite ------------------------------------------------

executar() {
  local grupo="$1" rotulo="$2" log_nome="$3"
  shift 3
  local log="$LOGS/$log_nome.log"
  local inicio fim rc linha passou falhou ignorado passos status

  echo ""
  echo "--- [$grupo] $rotulo"
  inicio=$(date +%s)
  NO_COLOR=1 "$@" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  fim=$(date +%s)

  linha="$(grep -aE "^(ok|FAILED)[[:space:]]*\|" "$log" | tail -1)"
  if [ -n "$linha" ]; then
    passou="$(printf "%s" "$linha"   | sed -nE "s/.*\| *([0-9]+) passed.*/\1/p")"
    falhou="$(printf "%s" "$linha"   | sed -nE "s/.*\| *([0-9]+) failed.*/\1/p")"
    ignorado="$(printf "%s" "$linha" | sed -nE "s/.*\| *([0-9]+) ignored.*/\1/p")"
    # Suite de step (`t.step`) conta 1 teste de topo com N passos dentro. Sem
    # esta coluna, reverificacao_webhook_test.ts aparece como "1" no resumo e
    # parece que quase nada rodou.
    passos="$(printf "%s" "$linha" | sed -nE "s/.*passed \(([0-9]+) steps?\).*/\1/p")"
  else
    passou=""; falhou=""; ignorado=""; passos=""
  fi
  passou="${passou:-0}"; falhou="${falhou:-0}"; ignorado="${ignorado:-0}"
  passos="${passos:--}"

  if [ -z "$linha" ]; then
    # Sem linha de resumo o `deno test` nem chegou a rodar (erro de tipo, de
    # import, porta ocupada). rc=0 sem resumo tambem e anomalia.
    status="ERRO"
  elif [ "$rc" -ne 0 ] || [ "$falhou" -gt 0 ]; then
    status="FALHOU"
  elif [ "$passou" -eq 0 ] && [ "$ignorado" -gt 0 ]; then
    status="IGNORADO"
  else
    status="OK"
  fi

  TOTAL_PASSOU=$((TOTAL_PASSOU + passou))
  TOTAL_FALHOU=$((TOTAL_FALHOU + falhou))
  TOTAL_IGNORADO=$((TOTAL_IGNORADO + ignorado))
  if [ "$status" = "FALHOU" ] || [ "$status" = "ERRO" ]; then
    SUITES_RUINS=$((SUITES_RUINS + 1))
  fi

  registrar "$grupo" "$rotulo" "$status" "$passou" "$falhou" "$ignorado" \
    "$((fim - inicio))" "tests/.logs/$log_nome.log" "" "$passos"
}

# `deno test` de um arquivo, no proprio processo.
# Uso: deno_suite <grupo> <arquivo> [--rotulo <texto>] [flags...]
deno_suite() {
  local grupo="$1" arquivo="$2"
  shift 2
  local rotulo="$arquivo"
  if [ "${1:-}" = "--rotulo" ]; then
    rotulo="$2"
    shift 2
  fi
  local log_nome
  log_nome="$(printf "%s" "$rotulo" | tr -c "a-zA-Z0-9_.-" "_")"
  executar "$grupo" "$rotulo" "$log_nome" deno test "$@" "tests/$arquivo"
}

# --- plano ----------------------------------------------------------------
#
# PERMISSAO: um conjunto unico para todo mundo, e nao a linha "Rodar:" de cada
# cabecalho.
#
# A primeira versao deste script copiou as permissoes arquivo a arquivo, e o
# resultado foi DUAS FALHAS FALSAS na primeira execucao: pontos_atencao_test.ts
# nao tem linha "Rodar:" e le tres arquivos do disco, e o cabecalho de
# n8n_fase14_test.ts pede --allow-read mas o teste roda `git show HEAD`. Uma
# tabela de permissoes escrita a mao e uma segunda fonte de verdade que
# envelhece calada, e o custo dela e ruido em cima de suite verde -- o oposto
# do que este script existe para dar.
#
# A UNICA permissao que muda o COMPORTAMENTO de um teste e --allow-net em
# irpf_parametros_test.ts, que faz `Deno.permissions.query` para decidir se
# confere as fixtures contra o servico da Receita. Nenhum outro arquivo em
# tests/ consulta permissao (conferido com grep). Por isso ele e o unico com
# tratamento especial: entra offline sem net, e de novo no grupo de rede com
# net.
PERM=(--allow-env --allow-net --allow-read --allow-write --allow-run)
PERM_OFFLINE_SEM_REDE=(--allow-env --allow-read --allow-write --allow-run)

OFFLINE_PUROS=(
  "consentimento_espelho_test.ts"
  "followup_test.ts"
  "followup_reembolso_test.ts"
  "pontos_atencao_test.ts"
  "verificacao_test.ts"
  "irpf_calculo_test.ts"
  "n8n_campos_bloqueantes_test.ts"
  "n8n_declaracao_test.ts"
  "n8n_fase12_test.ts"
  "n8n_fase13_test.ts"
  "n8n_fase14_test.ts"
  "n8n_fase15_test.ts"
  "n8n_multiplas_despesas_test.ts"
  "n8n_pontos_atencao_test.ts"
  "n8n_rotulos_test.ts"
  "n8n_valor_invalido_test.ts"
  "n8n_export_contador_test.ts"
  "dossie_nota_deducao_test.ts"
  "export_contador_test.ts"
)

# Estas sobem serve() na porta 8000 (fetch stubado, sem rede de verdade).
OFFLINE_PORTA_8000=(
  "consentimento_bootstrap_test.ts"
  "reverificacao_webhook_test.ts"
  "whatsapp_followup_test.ts"
  "followup_resolve_test.ts"
)

REDE_GEMINI=(
  "prompt_gemini_test.ts"
  "multiplas_despesas_gemini_test.ts"
  "declaracao_gemini_test.ts"
  "export_contador_gemini_test.ts"
)

# Arquivos que o plano cobre fora das listas acima.
EXTRAS=(
  "irpf_parametros_test.ts"
  "pluggy_webhook_transacoes_test.ts"
  "deploy_drift_test.ts"
)

# --- cobertura do plano ---------------------------------------------------
#
# O plano e uma lista escrita a mao, e lista escrita a mao envelhece: um
# arquivo *_test.ts novo em tests/ simplesmente nunca rodaria, e o resumo
# terminaria VERDE mentindo. E o mesmo desfecho que o deploy_drift_test.ts
# passou a tratar como erro quando descobriu que function nunca deployada era
# ignorada em silencio. Aqui a ausencia tambem e o erro.
FORA_DO_PLANO=()
conferir_cobertura() {
  local planejados=() linha_plano arquivo no_disco base
  for linha_plano in "${OFFLINE_PUROS[@]}" "${OFFLINE_PORTA_8000[@]}" "${REDE_GEMINI[@]}"; do
    planejados+=("${linha_plano%%|*}")
  done
  planejados+=("${EXTRAS[@]}")

  for no_disco in tests/*_test.ts; do
    [ -e "$no_disco" ] || continue
    base="$(basename "$no_disco")"
    for arquivo in "${planejados[@]}"; do
      if [ "$arquivo" = "$base" ]; then
        base=""
        break
      fi
    done
    [ -n "$base" ] && FORA_DO_PLANO+=("$base")
  done
}
conferir_cobertura

if [ "$SO_LISTAR" = "1" ]; then
  echo "Plano de execucao (nada foi rodado):"
  echo ""
  echo "[1/4 offline]"
  for l in "${OFFLINE_PUROS[@]}"; do echo "  - $l"; done
  echo "  - irpf_parametros_test.ts (offline, sem --allow-net)"
  for l in "${OFFLINE_PORTA_8000[@]}"; do echo "  - $l  (sobe serve() na :8000)"; done
  echo ""
  echo "[2/4 sql]      tests/sql/run_migrations_docker.sh (Docker)"
  echo ""
  echo "[3/4 rede]"
  for l in "${REDE_GEMINI[@]}"; do echo "  - $l  (GEMINI_API_KEY)"; done
  echo "  - irpf_parametros_test.ts (rede)  (servico da Receita)"
  echo "  - pluggy_webhook_transacoes_test.ts  (PLUGGY_CLIENT_ID/SECRET)"
  echo ""
  echo "[4/4 deploy]   deploy_drift_test.ts (~/.supabase/access-token)"
  if [ "${#FORA_DO_PLANO[@]}" -gt 0 ]; then
    echo ""
    echo "FORA DO PLANO (existem em tests/ e ninguem roda):"
    for arquivo in "${FORA_DO_PLANO[@]}"; do echo "  ! $arquivo"; done
    exit 1
  fi
  exit 0
fi

INICIO_GERAL=$(date +%s)

echo "========================================================================"
echo " TaxMind - suite completa"
echo " raiz: $RAIZ"
echo " logs: tests/.logs/"
echo "========================================================================"

# --- grupo 1: offline -----------------------------------------------------

if [ "$RODAR_OFFLINE" = "1" ]; then
  echo ""
  echo "### [1/4] offline"
  for arquivo in "${OFFLINE_PUROS[@]}"; do
    deno_suite "offline" "$arquivo" "${PERM[@]}"
  done

  # Sem --allow-net: e assim que o `Deno.permissions.query` dele desliga a
  # conferencia contra o servico ao vivo da Receita, que roda no grupo 3.
  deno_suite "offline" "irpf_parametros_test.ts" \
    --rotulo "irpf_parametros_test.ts (offline)" "${PERM_OFFLINE_SEM_REDE[@]}"

  for arquivo in "${OFFLINE_PORTA_8000[@]}"; do
    esperar_porta_livre
    deno_suite "offline" "$arquivo" "${PERM[@]}"
  done
else
  pular "offline" "(suites offline)" "desligado por flag"
fi

# --- grupo 2: SQL ---------------------------------------------------------

if [ "$RODAR_SQL" = "1" ]; then
  echo ""
  echo "### [2/4] sql (migrations em postgres:15)"
  if ! command -v docker >/dev/null 2>&1; then
    pular "sql" "tests/sql/run_migrations_docker.sh" "docker nao encontrado no PATH"
  elif ! docker info >/dev/null 2>&1; then
    pular "sql" "tests/sql/run_migrations_docker.sh" "daemon do Docker nao esta rodando"
  else
    # O runner de SQL nao imprime resumo no formato do Deno: aqui o que conta e
    # o codigo de saida (ele roda com set -e e ON_ERROR_STOP=1).
    echo ""
    echo "--- [sql] tests/sql/run_migrations_docker.sh"
    inicio_sql=$(date +%s)
    bash tests/sql/run_migrations_docker.sh 2>&1 | tee "$LOGS/sql_migrations.log"
    rc_sql=${PIPESTATUS[0]}
    fim_sql=$(date +%s)
    n_sql=$(find tests/sql -name "*_test.sql" | wc -l | tr -d " ")
    if [ "$rc_sql" -eq 0 ]; then
      registrar "sql" "tests/sql/run_migrations_docker.sh" "OK" "$n_sql" 0 0 \
        "$((fim_sql - inicio_sql))" "tests/.logs/sql_migrations.log"
      TOTAL_PASSOU=$((TOTAL_PASSOU + n_sql))
    else
      registrar "sql" "tests/sql/run_migrations_docker.sh" "FALHOU" 0 1 0 \
        "$((fim_sql - inicio_sql))" "tests/.logs/sql_migrations.log"
      TOTAL_FALHOU=$((TOTAL_FALHOU + 1))
      SUITES_RUINS=$((SUITES_RUINS + 1))
    fi
  fi
else
  pular "sql" "tests/sql/run_migrations_docker.sh" "desligado por flag"
fi

# --- grupo 3: rede --------------------------------------------------------

# Le uma chave do .env sem exportar o arquivo inteiro. Os testes do Gemini leem
# o .env sozinhos; o do Pluggy so olha o ambiente, entao precisa disto.
do_env() {
  [ -f "$RAIZ/.env" ] || return 0
  sed -nE "s/^$1=//p" "$RAIZ/.env" | head -1 | tr -d "\r" | sed -E "s/^\"(.*)\"$/\1/"
}

if [ "$RODAR_REDE" = "1" ]; then
  echo ""
  echo "### [3/4] rede (Gemini, Receita, Pluggy)"

  for arquivo in "${REDE_GEMINI[@]}"; do
    deno_suite "rede" "$arquivo" "${PERM[@]}"
  done

  # Mesmo arquivo do grupo 1, agora COM rede: o teste de deriva contra o
  # servico da Receita so existe quando a permissao de net esta concedida
  # (Deno.permissions.query no proprio arquivo). Sao os dois modos que o
  # cabecalho dele documenta, nao execucao duplicada por descuido.
  deno_suite "rede" "irpf_parametros_test.ts" \
    --rotulo "irpf_parametros_test.ts (rede)" "${PERM[@]}"

  PLUGGY_ID="$(do_env PLUGGY_CLIENT_ID)"
  PLUGGY_SECRET="$(do_env PLUGGY_CLIENT_SECRET)"
  if [ -z "$PLUGGY_ID" ] || [ -z "$PLUGGY_SECRET" ]; then
    pular "rede" "pluggy_webhook_transacoes_test.ts" "sem PLUGGY_CLIENT_ID/SECRET"
  else
    esperar_porta_livre
    export PLUGGY_CLIENT_ID="$PLUGGY_ID"
    export PLUGGY_CLIENT_SECRET="$PLUGGY_SECRET"
    ITEM_DO_ENV="$(do_env PLUGGY_TEST_ITEM_ID)"
    if [ -n "${PLUGGY_TEST_ITEM_ID:-}" ]; then
      export PLUGGY_TEST_ITEM_ID
    elif [ -n "$ITEM_DO_ENV" ]; then
      export PLUGGY_TEST_ITEM_ID="$ITEM_DO_ENV"
    fi
    deno_suite "rede" "pluggy_webhook_transacoes_test.ts" "${PERM[@]}"
  fi
else
  pular "rede" "(suites de rede)" "desligado por flag"
fi

# --- grupo 4: deploy ------------------------------------------------------

if [ "$RODAR_DRIFT" = "1" ]; then
  echo ""
  echo "### [4/4] deploy (o que esta PUBLICADO, nao o repositorio)"
  deno_suite "deploy" "deploy_drift_test.ts" "${PERM[@]}"
else
  pular "deploy" "deploy_drift_test.ts" "desligado por flag"
fi

# --- resumo ---------------------------------------------------------------

FIM_GERAL=$(date +%s)
DURACAO=$((FIM_GERAL - INICIO_GERAL))

echo ""
echo "========================================================================"
echo " RESUMO"
echo "========================================================================"
printf "%-8s %-46s %-9s %5s %5s %5s %7s %6s\n" \
  "GRUPO" "SUITE" "STATUS" "OK" "FALH" "IGN" "PASSOS" "SEG"
echo "--------------------------------------------------------------------------------------------"

for i in "${!R_ROTULO[@]}"; do
  printf "%-8s %-46s %-9s %5s %5s %5s %7s %6s\n" \
    "${R_GRUPO[$i]}" "${R_ROTULO[$i]}" "${R_STATUS[$i]}" \
    "${R_PASSOU[$i]}" "${R_FALHOU[$i]}" "${R_IGNORADO[$i]}" \
    "${R_PASSOS[$i]}" "${R_SEGUNDOS[$i]}"
done

echo ""
echo "  testes:  $TOTAL_PASSOU passaram, $TOTAL_FALHOU falharam, $TOTAL_IGNORADO ignorados"
echo "  suites:  ${#R_ROTULO[@]} no total, $SUITES_RUINS com problema"
echo "  tempo:   ${DURACAO}s"

houve_aviso=0
for i in "${!R_ROTULO[@]}"; do
  case "${R_STATUS[$i]}" in
    FALHOU|ERRO)
      if [ "$houve_aviso" = 0 ]; then
        echo ""
        echo "  precisam de atencao:"
        houve_aviso=1
      fi
      echo "    ${R_STATUS[$i]}  ${R_ROTULO[$i]}  ->  ${R_LOG[$i]}"
      ;;
  esac
done

houve_ignorado=0
for i in "${!R_ROTULO[@]}"; do
  if [ "${R_STATUS[$i]}" = "IGNORADO" ]; then
    if [ "$houve_ignorado" = 0 ]; then
      echo ""
      echo "  rodaram sem provar nada (todos os testes ignorados por falta de credencial):"
      houve_ignorado=1
    fi
    echo "    ${R_ROTULO[$i]}"
  fi
done

houve_pulado=0
for i in "${!R_ROTULO[@]}"; do
  if [ "${R_STATUS[$i]}" = "PULADO" ]; then
    if [ "$houve_pulado" = 0 ]; then
      echo ""
      echo "  nao rodaram:"
      houve_pulado=1
    fi
    echo "    ${R_ROTULO[$i]}  (${R_NOTA[$i]})"
  fi
done

if [ "${#FORA_DO_PLANO[@]}" -gt 0 ]; then
  echo ""
  echo "  ARQUIVOS DE TESTE FORA DO PLANO (existem em tests/ e ninguem rodou):"
  for arquivo in "${FORA_DO_PLANO[@]}"; do
    echo "    ! $arquivo   -> acrescentar ao plano em tests/rodar_tudo.sh"
  done
  SUITES_RUINS=$((SUITES_RUINS + ${#FORA_DO_PLANO[@]}))
fi

echo ""
if [ "$SUITES_RUINS" -eq 0 ]; then
  echo "  >> VERDE"
else
  echo "  >> VERMELHO ($SUITES_RUINS suite(s) com problema)"
fi
echo "========================================================================"

if [ "$SUITES_RUINS" -gt 0 ]; then
  exit 1
fi
exit 0
