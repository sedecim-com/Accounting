#!/usr/bin/env bash
# One command that runs what CI runs, for humans and agents alike.
#
#   scripts/verify.sh                  every gate that can run here, quiet; logs in .agent-logs/
#   scripts/verify.sh --verbose        stream every gate's output
#   scripts/verify.sh --no-integration skip the Postgres gates (said out loud)
#   scripts/verify.sh --only <gate>    run a single gate; unknown names exit 2
#
# PARITY WITH CI IS DECLARED, NOT ASSUMED. Every `run:` of .github/workflows/ci.yml
# that is not environment setup appears below either as `# ci: <command>` next to
# the gate that reproduces it, or as `# ci-skip: <command>` with the reason it
# cannot run here. tests/scripts/verify-script.spec.ts fails when ci.yml gains a
# step that this file does not account for, or when a `# ci:` line no longer
# exists in ci.yml. The --exigir list is READ from ci.yml, never copied.
#
# A gate that did not run is never reported as passed: it is listed as SKIP with
# its reason, and the summary says which gates did not run. On failure the last
# lines of the gate's log are printed with repeated lines collapsed; the whole
# log stays in .agent-logs/<gate>.log.
#
# Postgres gates need a role that can CREATE DATABASE (TEST_ADMIN_DATABASE_URL);
# the suite creates and drops its own ephemeral databases. See docs/MVP.md §7.

set -u
cd "$(dirname "$0")/.."

GATES="typecheck typecheck-tests lint icu unit plan catalog corpus history openapi ux language integration restore isolation eval"

VERBOSE=0
INTEGRATION=1
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verbose) VERBOSE=1 ;;
    --no-integration) INTEGRATION=0 ;;
    --only)
      shift
      ONLY="${1:-}"
      if [ -z "$ONLY" ] || ! printf ' %s ' "$GATES" | grep -q " $ONLY "; then
        echo "--only needs one of: $GATES" >&2
        exit 2
      fi
      ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
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

PASSED=()
FAILED=()
SKIPPED=()

selected() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

run_gate() {
  local name="$1"; shift
  selected "$name" || return 0
  local log="$LOG_DIR/$name.log"
  local start=$SECONDS status
  if [ "$VERBOSE" = 1 ]; then
    "$@" 2>&1 | tee "$log"
    status=${PIPESTATUS[0]}
  else
    "$@" >"$log" 2>&1
    status=$?
  fi
  local took=$((SECONDS - start))
  if [ "$status" = 0 ]; then
    printf 'ok    %-16s %4ss\n' "$name" "$took"
    PASSED+=("$name")
  else
    printf 'FAIL  %-16s %4ss  (exit %s, log: %s)\n' "$name" "$took" "$status" "$log"
    [ "$VERBOSE" = 1 ] || tail -n 40 "$log" | uniq -c | sed 's/^ *1 /      /; s/^ *\([0-9]*\) /  x\1 /'
    FAILED+=("$name")
  fi
}

skip_gate() {
  local name="$1" why="$2"
  selected "$name" || return 0
  printf 'SKIP  %-16s        %s\n' "$name" "$why"
  SKIPPED+=("$name")
}

icu_probe() {
  node -e '
    const failures = [];
    for (const tag of ["es-MX", "en-US"]) {
      const resolved = new Intl.NumberFormat(tag).resolvedOptions().locale;
      if (resolved !== tag) failures.push(tag + " resolves to " + resolved);
    }
    const first = new Intl.NumberFormat("ar-EG").format(1234).codePointAt(0);
    if (first < 0x660 || first > 0x669) failures.push("ar-EG does not print Arabic-Indic digits");
    if (failures.length > 0) { console.error("incomplete ICU: " + failures.join("; ")); process.exit(1); }
    console.log("ICU " + process.versions.icu + " complete in Node " + process.version);
  '
}

have_db_admin() { [ "$INTEGRATION" = 1 ] && [ -n "${TEST_ADMIN_DATABASE_URL:-}" ]; }
no_db_reason() {
  if [ "$INTEGRATION" = 0 ]; then echo "--no-integration"; else echo "TEST_ADMIN_DATABASE_URL is not set"; fi
}

# ci: npm run typecheck
run_gate typecheck        npm run --silent typecheck
# ci: npm run typecheck:tests
run_gate typecheck-tests  npm run --silent typecheck:tests
# ci: npm run lint
run_gate lint             npm run --silent lint
# ci-step: ICU completo en el Node de la corrida
run_gate icu              icu_probe
# ci: npm test
# ci: npx vitest run --coverage
# (the coverage run executes the same suite as `npm test` and also enforces the per-file thresholds)
run_gate unit             npx vitest run --coverage
# ci: npm run plan:status -- --piso --exigir=<read from ci.yml>
if [ -z "${DATABASE_URL:-}" ] && selected plan; then
  echo "note  plan: DATABASE_URL is not set, so criteria that need a database are not evaluated (CI evaluates them)"
fi
run_gate plan             npm run --silent plan:status -- --piso "$REQUIRED"
# ci: npx tsx scripts/catalogo-estado.ts --check
run_gate catalog          npx tsx scripts/catalogo-estado.ts --check
# ci: npx tsx scripts/corpus-manifiesto.ts --check
run_gate corpus           npx tsx scripts/corpus-manifiesto.ts --check
# ci: npx tsx scripts/historial-estado.ts --check
run_gate history          npx tsx scripts/historial-estado.ts --check
# ci: npx tsx scripts/openapi.ts --check
run_gate openapi          npx tsx scripts/openapi.ts --check
# ci: npx tsx scripts/ux-status.ts --check
run_gate ux               npx tsx scripts/ux-status.ts --check
# ci: npx tsx scripts/language-status.ts --check
run_gate language         npx tsx scripts/language-status.ts --check

# ci: npm run test:integration -- --coverage
# (CI also provisions roles with scripts/provision-roles.sql; without them 7 attack cases report as skipped)
if have_db_admin; then
  run_gate integration    npm run --silent test:integration -- --coverage
else
  skip_gate integration   "$(no_db_reason)"
fi

# ci: npx vitest run --config vitest.integration.config.ts tests/integration/s3-
if have_db_admin && command -v pg_dump >/dev/null 2>&1; then
  run_gate restore        npx vitest run --config vitest.integration.config.ts tests/integration/s3-
elif have_db_admin; then
  skip_gate restore       "pg_dump is not installed"
else
  skip_gate restore       "$(no_db_reason)"
fi

# ci-skip: bash scripts/verify-isolation.sh — needs the mnemosine_app role, a seeded database and the app connecting as that role (CI job «Aislamiento por inquilino»)
skip_gate isolation       "needs mnemosine_app and a seeded database; runs in CI"
# ci-skip: npm run eval -- --provider anthropic — needs ANTHROPIC_API_KEY and appends to docs/evals/ (CI job «Eval del clasificador»)
skip_gate eval            "needs a provider key and writes docs/evals/; runs in CI"

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "verify: ${#FAILED[@]} gate(s) failed: ${FAILED[*]}"
  exit 1
fi
if [ -n "$ONLY" ]; then
  if [ ${#PASSED[@]} -gt 0 ]; then
    echo "verify: only '$ONLY' ran, and it passed"
  else
    echo "verify: only '$ONLY' was selected, and it did not run (see SKIP above)"
  fi
  exit 0
fi
echo "verify: ${#PASSED[@]} gate(s) passed; NOT run here: ${SKIPPED[*]:-none}"
