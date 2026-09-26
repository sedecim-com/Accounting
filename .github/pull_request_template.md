Closes #

<!-- One PR resolves one issue. Under ~400 lines not counting generated ones; if it does not fit, the issue is split. Open it as a Draft while CI is not green. -->

## What changes

<!-- One or two sentences. The "what", not the "how". -->

## Why

<!-- The problem that existed before this change. If there was no problem,
     explain what is gained. A PR with no why cannot be reviewed: only read. -->

## Type

- [ ] fix · - [ ] feature · - [ ] refactor · - [ ] docs · - [ ] maintenance · - [ ] changes a contract

## Impact

- **Contracts modified:** none | API `docs/openapi.json` | SAT/IMSS deliverable | schema (migration) | CLI (catalog) — (compatible / breaking)
- **Accounting-treatment decisions:** none | new key in the panel with its reader (invariant 6)

## How to test (person)

1. `npm ci && scripts/verify.sh`
2. <!-- the CLI command that shows the change, with synthetic data -->
3. Expected result: …

## How to test (agent)

- **Single command:** `scripts/verify.sh`. If integration was skipped, say why.
- **Acceptance criteria and their test:**

  | Criterion | Test · plan criterion |
  |---|---|
  | AC-1 | `tests/…` · `criterion-id` |

- **Mutants:** the criterion dies with its mutant (`npm run mutantes`), or it does not apply because …

## Evidence

<!-- Console output, before/after figures, reproduction of the defect. -->

## Risks and rollback

- **Risk:** …
- **Rollback:** revert the PR | new migration that undoes it (never edit an applied one) | panel key

## House invariants this change touches

<!-- Tick what applies and explain how it holds. If it touches none, delete
     this section. -->

- [ ] The AI writes neither the ledger nor external systems: everything stays in
      `ai_drafts` / `ai_external_ops` and a person approves it.
- [ ] `UPDATE`s carry a state predicate, entity scope and a `rowCount` check.
- [ ] Every query is bounded by `entity_id` / `tenant_id`.
- [ ] The limits in `src/ai/floor.ts` are only combined with `Math.min`.
- [ ] Third-party content (CFDI, webhooks, skills) is wrapped as untrusted, with
      its delimiters neutralised.

## Checklist

- [ ] `scripts/verify.sh` green (or what did not run, said above)
- [ ] Generated blocks regenerated, not edited by hand
- [ ] Documentation and comments touched in the same PR
- [ ] No secrets and no real data
- [ ] I reviewed the whole diff, also if an agent wrote it
- [ ] If an agent wrote it: label `agent-authored` and the model here → <!-- model / tool -->
