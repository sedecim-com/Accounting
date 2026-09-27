#!/usr/bin/env bash
# One command that leaves this repository ready for scripts/verify.sh, the
# integration suite included (#335). Safe to run again: every step looks before
# it acts, and a second run answers `ok` everywhere and changes nothing.
#
#   scripts/setup.sh                   every step
#   scripts/setup.sh --only <step>     one step; unknown names exit 2
#   scripts/setup.sh --local-cluster   also start this machine's own Postgres
#                                      cluster and give the role in
#                                      TEST_ADMIN_DATABASE_URL its password.
#                                      For disposable containers (Claude Code
#                                      on the web, CI runners); never for a
#                                      Postgres whose passwords matter to you.
#
# Steps, in order:
#   deps      npm ci, only when package-lock.json changed since the last install
#   env       a development .env when there is none; an existing one is never rewritten
#   postgres  the server behind TEST_ADMIN_DATABASE_URL answers and lets us in
#   database  the database of MIGRATION_DATABASE_URL exists, and so do the cluster
#             roles of scripts/provision-roles.sql
#   migrate   npm run migrate, which skips what is already applied
#
# The Postgres major CI runs is READ from .github/workflows/ci.yml, never copied.
# Another major is warned about, not refused: the devcontainer pins CI's, and
# the owner chose a warning for everything else (#335).

set -u
cd "$(dirname "$0")/.."
. scripts/lib/env.sh

STEPS="deps env postgres database migrate"
ONLY=""
LOCAL_CLUSTER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --local-cluster) LOCAL_CLUSTER=1 ;;
    --only)
      shift
      ONLY="${1:-}"
      if [ -z "$ONLY" ] || ! printf ' %s ' "$STEPS" | grep -q " $ONLY "; then
        echo "--only needs one of: $STEPS" >&2
        exit 2
      fi
      ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

LOG_DIR=".agent-logs"

selected() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
ok()      { printf 'ok    %-9s %s\n' "$1" "$2"; }
changed() { printf 'done  %-9s %s\n' "$1" "$2"; }
warn()    { printf 'warn  %-9s %s\n' "$1" "$2"; }
fail()    { printf 'FAIL  %-9s %s\n' "$1" "$2"; exit 1; }

# SECURITY: URLs are printed with their password masked, even development ones.
masked() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }
url_part() {
  # $1 = user | password | port | database
  local rest=${2#*://} auth="" hostport
  case "$rest" in *@*) auth=${rest%%@*}; rest=${rest#*@} ;; esac
  hostport=${rest%%/*}
  case "$1" in
    user) printf '%s' "${auth%%:*}" ;;
    password) case "$auth" in *:*) printf '%s' "${auth#*:}" ;; esac ;;
    port) case "$hostport" in *:*) printf '%s' "${hostport##*:}" ;; *) printf '5432' ;; esac ;;
    database) local db=${rest#*/}; [ "$db" = "$rest" ] && db=""; printf '%s' "${db%%\?*}" ;;
  esac
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
ci_value() { grep -o -m1 "$1" .github/workflows/ci.yml | sed 's/.*[:] *//; s/'"'"'//g'; }
ci_pg_major() { ci_value 'image: postgres:[0-9]*'; }
ci_node_major() { ci_value "NODE_VERSION: '[0-9]*'"; }

step_deps() {
  local node_major want stamp=node_modules/.setup-lock-sha256
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || fail deps "node is not installed"
  want=$(ci_node_major)
  [ "$node_major" = "$want" ] || warn deps "Node $node_major here, CI runs Node $want"
  want=$(sha256 package-lock.json)
  if [ -d node_modules ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
    ok deps "node_modules matches package-lock.json"
    return
  fi
  mkdir -p "$LOG_DIR"
  npm ci --no-audit --no-fund >"$LOG_DIR/setup-deps.log" 2>&1 || fail deps "npm ci failed; see $LOG_DIR/setup-deps.log"
  printf '%s\n' "$want" >"$stamp"
  changed deps "npm ci"
}

step_env() {
  if [ -e .env ]; then
    local key missing=()
    for key in DATABASE_URL MIGRATION_DATABASE_URL TEST_ADMIN_DATABASE_URL; do
      [ -n "$(dotenv_value "$key")" ] || missing+=("$key")
    done
    if [ ${#missing[@]} -eq 0 ]; then
      ok env ".env has its database keys, and is left as it is"
    else
      warn env ".env is left as it is, but it lacks ${missing[*]}; see .env.example"
    fi
    return
  fi
  cat >.env <<'DEV_ENV'
# Written by scripts/setup.sh for local development (#335). Every value is a
# development value and none is a secret. Edit freely: setup.sh never rewrites
# this file once it exists. What each key does is in .env.example.
NODE_ENV=development

# The same roles and shape as the `plan` and `integration` jobs of CI.
# Connected as a superuser, RLS filters nothing: tenant isolation is proven by
# the «Aislamiento por inquilino» job, which connects as mnemosine_app.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemosine_dev
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemosine_dev
TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

VAULT_BACKEND=local-dev

# Empty on purpose: the code falls back to its development values, which are
# public, and refuses to start with them in production.
JWT_SECRET=
ENCRYPTION_KEY=
DEV_ENV
  changed env ".env written with development values"
}

run_as_postgres() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else sudo -n -u postgres "$@"; fi
}

start_local_cluster() {
  local port=$1 cluster
  command -v pg_lsclusters >/dev/null || return 1
  cluster=$(pg_lsclusters -h | awk -v p="$port" '$3 == p { print $1, $2; exit }')
  [ -n "$cluster" ] || return 1
  # shellcheck disable=SC2086 # "<version> <name>" splits on purpose
  if [ "$(id -u)" = 0 ]; then pg_ctlcluster $cluster start; else sudo -n pg_ctlcluster $cluster start; fi 2>/dev/null
  return 0
}

# NOTE: `timeout` is GNU coreutils; macOS lacks it, and then docker answers unbounded.
with_timeout() { if command -v timeout >/dev/null; then timeout 10 "$@"; else "$@"; fi; }
docker_available() { command -v docker >/dev/null && with_timeout docker info >/dev/null 2>&1; }

start_docker_postgres() {
  local port=$1 password=$2 image
  image="postgres:$(ci_pg_major)"
  if docker container inspect mnemosine-postgres >/dev/null 2>&1; then
    docker start mnemosine-postgres >/dev/null
  else
    docker run -d --quiet --name mnemosine-postgres -p "$port:5432" -e POSTGRES_PASSWORD="$password" "$image" >/dev/null
  fi
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    pg_isready -q -d "$1" && return 0
    sleep 1
  done
  return 1
}

step_postgres() {
  local admin port started="" num major want
  admin=$(dotenv_value TEST_ADMIN_DATABASE_URL)
  [ -n "$admin" ] || fail postgres "TEST_ADMIN_DATABASE_URL is in neither the environment nor .env"
  command -v psql >/dev/null && command -v pg_isready >/dev/null \
    || fail postgres "psql and pg_isready are needed (the postgresql-client package)"
  port=$(url_part port "$admin")

  if ! pg_isready -q -d "$admin"; then
    if [ "$LOCAL_CLUSTER" = 1 ] && start_local_cluster "$port"; then
      started="started the local cluster on port $port"
    elif [ "$LOCAL_CLUSTER" = 0 ] && docker_available; then
      start_docker_postgres "$port" "$(url_part password "$admin")" \
        || fail postgres "docker could not start the mnemosine-postgres container"
      started="started the mnemosine-postgres container"
    else
      fail postgres "nothing answers at $(masked "$admin"). Open the devcontainer, start a Postgres $(ci_pg_major) yourself, or, in a disposable container, run scripts/setup.sh --local-cluster"
    fi
    wait_ready "$admin" || fail postgres "$started, but it did not become ready within 30 s"
  fi

  if ! psql "$admin" -qtAc 'SELECT 1' >/dev/null 2>&1; then
    [ "$LOCAL_CLUSTER" = 1 ] \
      || fail postgres "the server answers but refuses $(masked "$admin"); fix TEST_ADMIN_DATABASE_URL in .env"
    printf "ALTER ROLE :\"u\" PASSWORD :'p';\n" \
      | run_as_postgres psql -p "$port" -q -v ON_ERROR_STOP=1 -v u="$(url_part user "$admin")" -v p="$(url_part password "$admin")" \
      || fail postgres "could not set the password of $(url_part user "$admin") on the local cluster"
    psql "$admin" -qtAc 'SELECT 1' >/dev/null 2>&1 || fail postgres "still refused after setting the password"
    started="${started:+$started; }set the password of $(url_part user "$admin")"
  fi

  num=$(psql "$admin" -qtAc 'SHOW server_version_num')
  major=$((num / 10000))
  want=$(ci_pg_major)
  [ "$major" = "$want" ] || warn postgres "Postgres $major here, CI runs $want; the devcontainer runs $want"
  if [ -n "$started" ]; then changed postgres "$started"; else ok postgres "Postgres $major answers at $(masked "$admin")"; fi
}

step_database() {
  local admin target db roles did=()
  admin=$(dotenv_value TEST_ADMIN_DATABASE_URL)
  target=$(dotenv_value MIGRATION_DATABASE_URL)
  [ -n "$target" ] || target=$(dotenv_value DATABASE_URL)
  db=$(url_part database "$target")
  [ -n "$db" ] || fail database "MIGRATION_DATABASE_URL (or DATABASE_URL) names no database"

  if [ "$(printf "SELECT 1 FROM pg_database WHERE datname = :'db';\n" | psql "$admin" -qtA -v db="$db")" != 1 ]; then
    printf 'CREATE DATABASE :"db";\n' | psql "$admin" -q -v ON_ERROR_STOP=1 -v db="$db" \
      || fail database "could not create database $db"
    did+=("created $db")
  fi

  # NOTE: provisioned only while the cluster roles are missing. The script also
  # hands every existing table to mnemosine_owner, so running it again on a
  # migrated database would change ownership on the second run, and CI never
  # does that: it provisions an empty database and migrates after.
  roles=$(psql "$admin" -qtAc "SELECT count(*) FROM pg_roles WHERE rolname IN ('mnemosine_owner', 'mnemosine_app', 'mnemosine_verifier', 'mnemosine_refresher')")
  if [ "$roles" != 4 ]; then
    mkdir -p "$LOG_DIR"
    psql "$target" -q -v ON_ERROR_STOP=1 -v app_pw=dev_app_pw -v owner_pw=dev_owner_pw \
      -f scripts/provision-roles.sql >"$LOG_DIR/setup-roles.log" 2>&1 \
      || fail database "scripts/provision-roles.sql failed; see $LOG_DIR/setup-roles.log"
    did+=("provisioned the cluster roles")
  fi

  if [ ${#did[@]} -gt 0 ]; then
    changed database "$(IFS=,; printf '%s' "${did[*]}" | sed 's/,/, /g')"
  else
    ok database "$db exists and the cluster roles are provisioned"
  fi
}

step_migrate() {
  local applied
  mkdir -p "$LOG_DIR"
  npm run --silent migrate >"$LOG_DIR/setup-migrate.log" 2>&1 || fail migrate "npm run migrate failed; see $LOG_DIR/setup-migrate.log"
  applied=$(grep -c '^  Executing ' "$LOG_DIR/setup-migrate.log")
  if [ "$applied" -gt 0 ]; then changed migrate "applied $applied migration(s)"; else ok migrate "every migration already applied"; fi
}

for step in $STEPS; do
  selected "$step" && "step_$step"
done

[ -n "$ONLY" ] || echo "setup: ready. Next: scripts/verify.sh"
