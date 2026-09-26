---
name: Work ticket
about: One unit of work ready for a person or an agent — what must be true when it is done, not which files to touch
title: ''
labels: 'status:triage'
assignees: ''
---

<!--
Definition of Ready (docs/PROCESS.md §1 and docs/ROUTING.md). An issue moves to
`status:agent-ready` only if it has EVERYTHING below, is D1–D2 and is not blocked;
D3–D4 also need a human's `/confirmar`. If a new developer could not solve it
without asking, neither can an agent.
-->

## Goal

<!-- One sentence, with the outcome for the accountant or the firm. -->

## Tranche and context

- **Tranche:** <!-- the plan's code (T4, F07e, O1c…) or "new" -->
- **Why now:** <!-- copied from the sequence's "why here" if it exists; if it comes from an audit, file:line and a reproduction -->
- **Related:** <!-- #issue, PR, docs/adr/NNNN, section of docs/SCOPE.md -->

## Acceptance criteria

<!-- Verifiable, as Given / When / Then. Each one becomes a test. -->

- [ ] Given …, when …, then ….

## Impact

<!-- This repo's contracts that change: published API (docs/openapi.json), SAT/IMSS deliverables, schema (migration), CLI surface (catalog). "None" is also an answer. -->

| Contract | Impact (none · compatible · breaking) | Action |
|---|---|---|
| | | |

## Implementation hints

- **Likely files:** <!-- see docs/REPO_MAP.md -->
- **Pattern to follow:** <!-- link to existing code done well -->

## Out of scope

-

## How to test

- `scripts/verify.sh`, and the specific test: <!-- path of the spec -->
- **Data:** synthetic fixtures in `tests/fixtures/` (never real data).
- **Edge cases:**

## Classification

<!-- Filled in by triage; see the rubric in docs/ROUTING.md. -->

| Scope | Ambiguity | Novelty | Risk | Verifiability | Total → level |
|---|---|---|---|---|---|
| | | | | | D? |

- **Autonomy:** A1 | A2 | A3. This repo is **A3 by default**: it holds PII and regulated financial functions.
- **Estimated size:** ~N lines. Over ~400, split it before `agent-ready`.

## Constraints

<!-- Invariants from AGENTS.md that apply especially; paths that are not touched; decisions that go to the panel (invariant 6). -->

## Depends on

<!-- Another issue, or "none". If it depends on an open one: `status:blocked`. -->
