# The Node major and the Postgres client major are the ones CI uses;
# tests/scripts/setup-script.spec.ts reads both from ci.yml and fails when they drift.
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# psql and pg_isready for scripts/setup.sh, pg_dump for the restore rehearsal;
# xmllint (libxml2-utils) for the Anexo 24 XSD tests, as in CI's unit job.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-15 libxml2-utils \
  && rm -rf /var/lib/apt/lists/*
