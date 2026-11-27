#!/usr/bin/env bash
# The built program starts before a release (MNE-001-970, #1080).
#
#   scripts/smoke-dist.sh               build clean, then start what a firm installs
#   scripts/smoke-dist.sh --files-only  judge the dist that is there: no build, no database
#
# CI runs the source through tsx and never builds. So dist/cli/mnemosine.js, the
# `bin` of package.json, and dist/index.js, the CMD of docker/Dockerfile, were
# first executed on a firm's machine, and a data file that build:api forgot to
# copy would have been found there. This script:
#
#   1. removes dist and runs `npm run build`;
#   2. checks that dist carries every file of src that is not TypeScript: the
#      XSDs, the corpus, the migrations, the policies, the web program;
#   3. runs the binary as an installation does, from another folder with an
#      empty HOME and an empty environment: --version must equal package.json,
#      and --help must list the commands;
#   4. creates a database of its own, migrates it with dist/database/migrate.js
#      and runs `init --yes`; then, connected as mnemosine_app, `doctor` must
#      report no failure and `account list` must return the chart `init` created;
#   5. drops that database and its scratch folder, also when a step fails.
#
# A gate for development and CI: it creates and drops a database in the cluster
# TEST_ADMIN_DATABASE_URL (environment or .env) points at, and needs psql. It
# never touches a database it did not create, and it needs no network: the model
# provider is a local one, so no key is asked for. About a minute, nearly all of
# it the build.
#
# IT NEVER ALTERS A ROLE THAT EXISTS. Roles belong to the cluster, not to the
# scratch database, and scripts/provision-roles.sql sets both passwords every
# time it runs. So that script runs only where the cluster has neither
# mnemosine_app nor mnemosine_owner, which is CI's case, and needs a superuser
# there. Where both exist they are used as they are: MNEMOSINE_APP_PASSWORD
# (default: the one scripts/setup.sh provisions) is what this script logs in
# with, and a wrong one stops it before the build. One role without the other
# stops it too.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
. scripts/lib/env.sh

FILES_ONLY=0
case "${1:-}" in
  "") ;;
  --files-only) FILES_ONLY=1 ;;
  -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

# What the task names. A tree that moves in src has to move here too, or the
# check below would pass for having nothing to look for.
DATA_TREES='services/sat/anexo24/xsd services/sat/cfdi40/xsd ai/docs database/migrations'
# Read from a checkout only, never by an installation.
NOT_SHIPPED=' cli/README.md plan/mutation-census.txt '

files_are_carried() {
  local tree file entries missing=()
  for tree in $DATA_TREES; do
    [ -n "$(find "src/$tree" -type f 2>/dev/null | head -n 1)" ] || missing+=("src/$tree (empty or gone)")
  done
  entries=$(node -p "const p = require('./package.json'); [p.main, ...Object.values(p.bin)].join(' ')") || return 1
  for file in $entries; do
    [ -f "$file" ] || missing+=("$file (package.json names it)")
  done
  # tsc carries what it compiles and nothing else: the rest is copied by hand.
  while IFS= read -r file; do
    case "$NOT_SHIPPED" in *" $file "*) continue ;; esac
    [ -f "dist/$file" ] || missing+=("dist/$file")
  done < <(cd src && find . -type f ! -name '*.ts' | sed 's#^\./##' | sort)
  [ ${#missing[@]} -eq 0 ] && return 0
  echo "the build left out ${#missing[@]} file(s); see build:api in package.json:"
  printf '  %s\n' "${missing[@]}"
  return 1
}

SCRATCH=$(mktemp -d)
ADMIN=""
DB=""
cleanup() {
  local status=$?
  if [ -n "$DB" ] && ! psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1; then
    echo "smoke-dist: could not drop $DB; drop it by hand" >&2
    [ "$status" != 0 ] || status=1
  fi
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# $1 = name, the rest = command. Quiet on success; on failure, the end of its output.
step() {
  local name=$1 start=$SECONDS status
  shift
  if "$@" >"$SCRATCH/$name.log" 2>&1; then
    printf 'ok    %-12s %3ss\n' "$name" "$((SECONDS - start))"
  else
    status=$?
    printf 'FAIL  %-12s (exit %s)\n' "$name" "$status"
    tail -n 40 "$SCRATCH/$name.log"
    exit 1
  fi
}

if [ "$FILES_ONLY" = 1 ]; then
  step files files_are_carried
  exit 0
fi

# ── Before the build: everything that can refuse does it now ──
ADMIN=$(dotenv_value TEST_ADMIN_DATABASE_URL)
if [ -z "$ADMIN" ]; then
  echo "smoke-dist: TEST_ADMIN_DATABASE_URL is in neither the environment nor .env (scripts/setup.sh leaves it ready)" >&2
  exit 2
fi
command -v psql >/dev/null || { echo "smoke-dist: psql is needed (the postgresql-client package)" >&2; exit 2; }

base=${ADMIN%%\?*}
address=${base#*://}; address=${address##*@}; address=${address%%/*}
DB_NAME=mnemosine_smoke_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
OWN_URL="${base%/*}/$DB_NAME"
APP_PW=${MNEMOSINE_APP_PASSWORD:-dev_app_pw}

# How many of the two login roles the cluster has: 0, 1 or 2.
roles_present() {
  psql "$ADMIN" -qtA -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('mnemosine_app', 'mnemosine_owner')"
}
if ! ROLES=$(roles_present); then
  echo "smoke-dist: the cluster of TEST_ADMIN_DATABASE_URL does not answer" >&2
  exit 2
fi
case "$ROLES" in
  0) ;; # nobody provisioned this cluster: create_database does, below
  2)
    if ! PGPASSWORD="$APP_PW" psql "postgresql://mnemosine_app@$address/${base##*/}" -qtAc 'SELECT 1' >/dev/null 2>&1; then
      echo "smoke-dist: mnemosine_app exists in this cluster and MNEMOSINE_APP_PASSWORD (default: the one scripts/setup.sh provisions) is not its password. Export the right one: this script never alters a role that exists" >&2
      exit 2
    fi
    ;;
  *)
    echo "smoke-dist: this cluster has one of mnemosine_app and mnemosine_owner without the other. Provision it yourself (scripts/provision-roles.sql) or drop the odd one: this script never alters a role that exists" >&2
    exit 2
    ;;
esac

# ── The program as an installation runs it ──
mkdir -p "$SCRATCH/cwd" "$SCRATCH/home"
MNEMOSINE="$ROOT/dist/cli/mnemosine.js"
# $@ = VAR=value... command. No .env of the checkout, no variable of the caller.
installed() { (cd "$SCRATCH/cwd" && env -i PATH="$PATH" HOME="$SCRATCH/home" MNEMOSINE_PROVIDER=ollama "$@" </dev/null); }
as_admin() { installed DATABASE_URL="$OWN_URL" "$@"; }
as_app() { installed DATABASE_URL="postgresql://mnemosine_app@$address/$DB_NAME" PGPASSWORD="$APP_PW" "$@"; }

build_clean() { rm -rf dist && npm run --silent build; }

version_matches() {
  local want got
  want=$(node -p "require('./package.json').version") && got=$(installed node "$MNEMOSINE" --version) || return 1
  echo "package.json says $want, the binary says $got"
  [ "$got" = "$want" ]
}

help_lists_commands() {
  local help
  help=$(installed node "$MNEMOSINE" --help) || return 1
  grep -Eq '^  doctor( |$)' <<<"$help" && grep -Eq '^  account[| ]' <<<"$help"
}

# The roles are asked for again here, a build later: one that appeared in the
# meantime is not altered either.
create_database() {
  psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\"" || return 1
  if [ "$ROLES" = 2 ]; then
    echo "mnemosine_app and mnemosine_owner exist: used as they are, provision-roles.sql not run"
    return 0
  fi
  if [ "$(roles_present)" != 0 ]; then
    echo "a role appeared in this cluster since the script started; run it again"
    return 1
  fi
  psql "$OWN_URL" -q -v ON_ERROR_STOP=1 \
    -v app_pw="$APP_PW" -v owner_pw="${MNEMOSINE_OWNER_PASSWORD:-dev_owner_pw}" \
    -f scripts/provision-roles.sql
}

# NOTE: as the administrator, the way CI's isolation job seeds. Run as
# mnemosine_app, init stops at the row-level policy of `organizations`.
first_run() {
  as_admin node "$MNEMOSINE" init --yes --entity 'Despacho de Humo' --rfc XAXX010101000 --country MX --currency MXN
}

# Exit 0 is not enough: a superuser connection passes with a warning, and the
# point of the roles is that this one is subject to the policies.
doctor_reports_no_failure() {
  as_app node "$MNEMOSINE" doctor --json >"$SCRATCH/doctor.json"
  node -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const level = Object.fromEntries(report.checks.map((check) => [check.id, check.level]));
    for (const check of report.checks) {
      if (check.level !== "ok") console.log(check.level + "  " + check.id + "  " + check.detail);
    }
    const required = ["database-connection", "migrations-applied", "active-legal-entities", "rls-enforced-on-connection"];
    const notOk = required.filter((id) => level[id] !== "ok");
    if (report.worst === "fail" || notOk.length > 0) {
      console.log("doctor: " + report.worst + (notOk.length > 0 ? "; not ok: " + notOk.join(", ") : ""));
      process.exit(1);
    }
  ' "$SCRATCH/doctor.json"
}

accounts_are_listed() {
  local count
  count=$(as_app node "$MNEMOSINE" account list --quiet | wc -l) || return 1
  echo "account list returned $count account(s)"
  [ "$count" -gt 0 ]
}

step build build_clean
step files files_are_carried
step version version_matches
step help help_lists_commands
DB=$DB_NAME
step database create_database
step migrate as_admin node "$ROOT/dist/database/migrate.js"
step init first_run
step doctor doctor_reports_no_failure
step account-list accounts_are_listed

echo "smoke-dist: the built program starts"
