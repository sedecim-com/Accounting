#!/bin/bash
# Claude Code on the web starts each session in a disposable container where
# Postgres is installed but stopped. Without it the integration suite is skipped
# and plan:status reports fewer green packages without calling it a failure
# (#335). Elsewhere this hook does nothing: a person's own Postgres is theirs.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
scripts/setup.sh --local-cluster
