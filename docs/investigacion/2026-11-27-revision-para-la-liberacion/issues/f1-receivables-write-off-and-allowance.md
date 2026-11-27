Issue: #1070

## Goal

A receivable that will not be collected leaves the subledger by a command, with its entry as a draft, and the firm can propose its allowance for expected credit losses from the aging at a date.

## Tranche and context

- **Tranche:** new, from the norms review of 27 Nov 2026 (report 02, findings N-05 and N-06). PRD-003 RF-05c and RF-27.
- **Why now** (`develop` `e9a327d0`):
  - **No write-off.** The status `uncollectible` exists (`src/types/index.ts:106`; `002_ap_ar_schema.sql:215`) and nothing writes it. `customer-service.ts:51` describes a write-off nobody performs; the help shows `customer archive … "Uncollectible balance already written off"` (`cli-reference.md:4169`).
  - **No allowance.** Account 1129 «Estimación para Cuentas de Cobro Dudoso» is seeded (`chart-seed.ts:82`) with no role and no engine. The base chart has no bad-debt expense account.
  - **Failing case 1.** An invoice of 116,000.00 from a bankrupt customer stays in the aging for good, or leaves by a manual entry that makes `ar reconcile` fail.
  - **Failing case 2.** 100,000.00 current, 50,000.00 at 31-60 days and 20,000.00 over 90, with the firm's rates of 1 %, 5 % and 50 %: the allowance is 13,500.00 and the balance sheet shows 170,000.00 with none.
  - The aging at a date already exists (`report-service.ts:2646`, MNE-001-648).
- **The norm.** NIF C-3 and C-16 as the corpus has them: the allowance is recognised from the start of the receivable, and writing off consumes it (`nif-registro.md:49-55`; `niif-pymes-convergencia.md:56`). Paragraph numbers are not in the corpus and are not cited.
- **Forks** (ADR-0006):
  - *What a write-off debits:* key `receivable_write_off_against`: `allowance_first` (default, what the corpus states) or `direct_expense`.
  - *How the allowance is estimated:* key `expected_credit_loss_method`: `aging_matrix` (default, always a draft) or `individual_review`.
  - *The rates:* the firm's, captured with their source and a start date. No default: without rates the command refuses.
  - *The uncollected VAT of a written-off invoice (2125):* its plan states it from the law's text.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-882 | `invoice write-off`: draft entry, invoice to `uncollectible`, `--reverse` | 350 | — | S |
| MNE-001-883 | `allowance calculate`: rates, schedule and the draft adjustment of 1129 | 300, two parts | MNE-001-648, MNE-001-882 | S |
| MNE-001-960 | Netting a receivable against a payable (drafted by reviewer 06) | theirs | theirs | theirs |

## Acceptance criteria

- [ ] (N05) Given case 1 and an allowance of 100,000.00, `invoice write-off --date --reason` leaves a draft: 100,000.00 against the allowance, 16,000.00 to bad-debt expense, 116,000.00 off the receivable. Under `direct_expense`, 116,000.00 to expense.
- [ ] (N05) Given that draft posted, the invoice is `uncollectible`, absent from `report aged-receivable show`, and `ar reconcile` ties.
- [ ] (N05) Given `--reverse`, the receivable and the invoice status return, with an audit row.
- [ ] (N05) Given an entity seeded before the task, `account role seed` creates the two roles and never overwrites a hand mapping.
- [ ] (N06) Given no rates, `allowance calculate` refuses and names the missing bucket.
- [ ] (N06) Given case 2, `allowance calculate --as-of 2026-12-31` prints the schedule and 13,500.00; with 4,000.00 already in 1129 the draft adjusts by 9,500.00.
- [ ] (N06) Given the year-end close with an allowance never calculated, the checklist warns.
- [ ] Nothing posts without a person in either task.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | none | — |
| SAT/IMSS deliverables | compatible | The new expense account needs its agrupador |
| Schema (migration) | compatible | N06: a rates table with validity. N05: none |
| CLI surface | compatible | `invoice write-off`, `allowance rate set`, `allowance calculate` |

## Out of scope / later

- Instruments held to collect principal and interest (NIF C-20) and investments (C-2): effective interest and stages.
- The tax deduction of a bad debt (LISR art. 27 fr. XV, por verificar contra el texto oficial) and the notice to the debtor.
- Batch write-off of small balances; recovery of a written-off account beyond `--reverse`.
- The US allowance (MNE-001-337, a task of its own).

## How to test

- **Unit:** the split between allowance and expense; the matrix arithmetic to four decimals.
- **Integration:** beside `ar-amount-due-as-of.int.spec.ts`: write-off, reverse, reconcile; a foreign-currency invoice.
- **Edge cases:** a partially paid invoice; an invoice with a credit note applied; a PPD invoice with VAT still in 2125.

## Classification

- D3 / A3 both (posted money; N06 has a migration). About 950 lines: N05 one PR, N06 two.

## Constraints

- Invariants 3 and 4; rates are never invented or defaulted; every draft carries its schedule in `calculation_metadata`.

## Depends on

- MNE-001-648 (done). MNE-001-883 after MNE-001-882.

**Para el dueño:** hoy una factura incobrable no se puede castigar desde el sistema y la estimación de cuentas incobrables no la calcula nadie, aunque su cuenta está sembrada. Con esto el castigo deja su póliza como borrador y la estimación se propone desde la antigüedad con las tasas que el despacho capture. Las dos bifurcaciones van al panel con valor por omisión; nada se postea sin una persona.

---
_Generated by [Claude Code](https://claude.ai/code)_
