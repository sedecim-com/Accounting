#!/usr/bin/env bash
# One command that runs what CI runs, for humans and agents alike.
#
#   scripts/verify.sh                  every gate, quiet; full logs in .agent-logs/
#   scripts/verify.sh --verbose        stream every gate's output
#   scripts/verify.sh --no-integration skip the Postgres suite (said out loud)
#   scripts/verify.sh --only <gate>    run a single gate (names below)
#
# Why it exists: an agent that has to guess how to verify its work either skips
# a gate or burns tokens reading CI YAML. The gates and their order mirror
# .github/workflows/ci.yml; the --exigir list is READ from that file, never
# copied, so the two cannot drift. Cheapest gates run first.
#
# Output is one line per gate. On failure it prints the last lines of that
# gate's log, with consecutive duplicate lines collapsed; the whole log stays
# in .agent-logs/<gate>.log to be searched, not dumped.
#
# The integration suite needs a Postgres role that can CREATE DATABASE
# (TEST_ADMIN_DATABASE_URL). Without it the gate is SKIPPED and reported as
# such: a skipped gate is never shown as green. See docs/MVP.md §7.

set -u
cd "$(dirname "$0")/.."

VERBOSE=0
INTEGRATION=1
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verbose) VERBOSE=1 ;;
    --no-integration) INTEGRATION=0 ;;
    --only) shift; ONLY="${1:-}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

LOG_DIR=".agent-logs"
mkdir -p "$LOG_DIR"

REQUIRED=$(grep -o -- '--exigir=[A-Z0-9.,]*' .github/workflows/ci.yml | head -1)
if [ -z "$REQUIRED" ]; then
  echo "cannot read the --exigir list from .github/workflows/ci.yml" >&2
  exit 2
fi

FAILED=()
SKIPPED=()

run_gate() {
  local name="$1"; shift
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then return 0; fi
  local log="$LOG_DIR/$name.log"
  local start=$SECONDS
  if [ "$VERBOSE" = 1 ]; then
    "$@" 2>&1 | tee "$log"
    local status=${PIPESTATUS[0]}
  else
    "$@" >"$log" 2>&1
    local status=$?
  fi
  local took=$((SECONDS - start))
  if [ "$status" = 0 ]; then
    printf 'ok    %-18s %4ss\n' "$name" "$took"
  else
    printf 'FAIL  %-18s %4ss  (exit %s, log: %s)\n' "$name" "$took" "$status" "$log"
    [ "$VERBOSE" = 1 ] || tail -n 40 "$log" | uniq -c | sed 's/^ *1 /      /; s/^ *\([0-9]*\) /  x\1 /'
    FAILED+=("$name")
  fi
}

skip_gate() {
  local name="$1" why="$2"
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then return 0; fi
  printf 'SKIP  %-18s        %s\n' "$name" "$why"
  SKIPPED+=("$name")
}

run_gate typecheck        npm run --silent typecheck
run_gate typecheck-tests  npm run --silent typecheck:tests
run_gate lint             npm run --silent lint
run_gate unit             npm test --silent
run_gate plan             npm run --silent plan:status -- --piso "$REQUIRED"
run_gate catalog          npx tsx scripts/catalogo-estado.ts --check
run_gate corpus           npx tsx scripts/corpus-manifiesto.ts --check
run_gate history          npx tsx scripts/historial-estado.ts --check
run_gate openapi          npx tsx scripts/openapi.ts --check
run_gate ux               npx tsx scripts/ux-status.ts --check
run_gate language         npx tsx scripts/language-status.ts --check

if [ "$INTEGRATION" = 0 ]; then
  skip_gate integration "--no-integration"
elif [ -z "${TEST_ADMIN_DATABASE_URL:-}" ]; then
  skip_gate integration "TEST_ADMIN_DATABASE_URL is not set"
else
  run_gate integration    npm run --silent test:integration
fi

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "verify: ${#FAILED[@]} gate(s) failed: ${FAILED[*]}"
  exit 1
fi
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "verify: passed, with ${#SKIPPED[@]} gate(s) NOT run: ${SKIPPED[*]} (CI will run them)"
  exit 0
fi
echo "verify: all gates passed"
