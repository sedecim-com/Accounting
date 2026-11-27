Issue: #1067

## Goal

An entity under NIF gets its set of statements from the CLI: comprehensive income with its levels and ORI, changes in equity, cash flow with each flow in its activity, each with the prior period beside it, and one command that proves they agree.

## Tranche and context

- **Tranche:** new, from the standards review of 27 Nov 2026 (report 01, findings G09 to G12 and G18). PRD-003 RF-24 and RF-02 are `Must` and had no engine task.
- **Why now** (`develop` `e9a327d0`):
  - **The income statement is two blocks.** `getIncomeStatement` returns Revenue, Expenses and a net (`report-service.ts:1699-1743`; `report-command.ts:559-573`). The categories that would give the levels already exist (`cogs`, `operating_expenses`, `other_income`, `other_expenses`, `tax`); the ORI account exists (3600) and no statement shows its movement.
  - **No statement of changes in equity.** Catalogue row `statement equity show` is ❌ (`docs/cli-command-catalog.md:2297`).
  - **No comparative column** in any statement (`report-command.ts:438-573`). MNE-001-343 asks for it for the United States only.
  - **Cash flow sections.** `clasificarCuenta` sends every `current_liabilities` account to working capital (`cash-flow-service.ts:460-482`), so a 90-day loan of 100,000.00 reads as an operating flow. A revaluation gain on dollar cash sits inside net income; there is no line for it.
  - **Nothing ties the statements.** The balance sheet checks itself (`report-command.ts:503-518`) and the cash flow checks cash (`cash-flow-reconcile.ts`).
- **What is sound and stays:** the balance sheet foots with the unswept result inside equity; the income statement leaves closing entries out; the indirect cash flow ties to cash by construction.
- **The norms.** NIF B-3, B-4, B-2 and B-6. The corpus holds summaries only (`src/ai/docs/nif-registro.md:181-182`, `:291`). Each task reads the standard first and puts the paragraphs it uses in the corpus with their source; if the text does not open, the task stops and says so. RCFF art. 33 names the statement of changes in equity (to verify against the official text).
- **Forks** (ADR-0006):
  - `income_statement_classification`: `by_function` (default, conservative: no account is reclassified) or `by_nature`.
  - `comprehensive_income_presentation`: `single_statement` (default: ORI is always shown) or `two_statements`.
  - `cash_flow_interest_paid`, `cash_flow_interest_received`: `operating` (default: where they are today) or the other activity.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-870 | Comprehensive income with the NIF B-3 levels and ORI | 350, two parts | MNE-001-743 | S |
| MNE-001-871 | Statement of changes in equity (NIF B-4), tied to the balance sheet | 350 | MNE-001-867 | S |
| MNE-001-872 | The comparative column of the prior period | 300 | — | S |
| MNE-001-873 | Cash flow: short-term debt in financing and the FX effect on cash in its own line | 350 | — | S |
| MNE-001-874 | A command and a ▶ criterion tie the statements to each other | 250 | MNE-001-871 | S |

## Acceptance criteria

Setup: sales 10,000.00, cost of sales 6,000.00, operating expenses 1,500.00, financial expenses 200.00, income tax 600.00; share capital 50,000.00, accumulated results 8,000.00.

- [ ] (P10) The statement prints gross profit 4,000.00, operating profit 2,500.00, financing result −200.00, before tax 2,300.00, net 1,700.00, ORI 0.00, comprehensive income 1,700.00. The net is today's figure.
- [ ] (P10) Under `by_nature` the same net is reached with no cost-of-sales line.
- [ ] (P12) Opening equity 58,000.00, comprehensive income 1,700.00, closing 59,700.00, equal to the balance sheet's equity to the cent; otherwise exit code 4.
- [ ] (P12) The year-end sweep shows as a transfer, never as income.
- [ ] (P13) `--compare prior-year` adds the compared amount and the variation to every row (10,000.00, 8,000.00, 2,000.00), read from the ledger with the same service; json and csv carry the column by key.
- [ ] (P14) Given a 90-day loan of 100,000.00 and a revaluation gain of 5,000.00 on dollar cash: operating 0.00, financing 100,000.00, FX effect 5,000.00; opening + flows + effect = closing; `cashflow reconcile` residue 0.00.
- [ ] (P15) The tie-out prints each tie with its two figures and its difference, exits 4 on a difference, and says when a tie does not apply.
- [ ] (P15) A ▶ criterion runs it on an ephemeral database, with its mutant.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | Statement routes gain fields; `docs/openapi.json` regenerated |
| SAT/IMSS deliverables | none | — |
| Schema (migration) | compatible | P10: a category for the financing result; P14 only if the account's activity mark is a column |
| CLI surface | compatible | New sheet for equity; `--compare`; the tie-out command |

## Out of scope / later

- IFRS presentation (IAS 1, IFRS 18, IAS 7): PRD-003 RF-29 and RF-30 (report 01 G28).
- US GAAP comparative statements: MNE-001-343, a task of its own (G38).
- A guided flow for a prior-year error and restated comparatives (G34); condensed interim statements (G35); the «result of the period» label when a prior year was never sealed (G36); the direct method (G37).
- Notes and disclosures (RF-28).

## How to test

- **Unit:** the layout as data; the classification rule; the equity roll.
- **Integration:** the setup above through the binary; a closed prior year for the comparative; the mutant of the tie-out.
- **Edge cases:** a loss; a contra-natural account; an entity with no prior year; ORI with movement; an account with no category.

## Classification

- **Difficulty:** D2 for P12 to P15; D3 for P10 (migration). **Autonomy:** A2; A3 for P10.
- **Size:** P10 ~350 + ~300; P12 ~350; P13 ~300; P14 ~350; P15 ~250. One PR per part («Part of #N»).

## Constraints

- No statement is stored: each is read from the ledger.
- Every figure that exists today keeps its value; what changes is where it is presented.
- No layout is written from memory of a standard.

## Depends on

- MNE-001-743 (the NIF B-3 paragraphs in the corpus), which moves to wave 3.
- MNE-001-867 (equity accounts by role), under #1068.

**Para el dueño:** hoy el estado de resultados sale en dos bloques, ingresos y gastos, sin utilidad bruta ni de operación; no existe el estado de cambios en el capital contable; ningún estado trae la columna del año anterior, y el flujo de efectivo pone un préstamo de corto plazo en la operación. Con esto salen los estados que piden las NIF y un comando que comprueba que casan entre sí. Las utilidades no cambian: cambia cómo se presentan. Antes de armar cada estado se lee la norma y se guarda su fuente.

---
_Generated by [Claude Code](https://claude.ai/code)_
