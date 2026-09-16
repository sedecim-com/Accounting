## What changes

<!-- One or two sentences. The "what", not the "how". -->

## Why

<!-- The problem that existed before this change. If there was no problem,
     explain what is gained. A PR with no why cannot be reviewed: only read. -->

## How it was verified

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` green
- [ ] `npm run test:integration` (needs Postgres) — if the change touches the database
- [ ] `npm run plan:status` with no required package going backwards

<!-- If something could NOT be verified, say it here. A declared gap is
     information; a silent one is a surprise for whoever reviews. -->

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
