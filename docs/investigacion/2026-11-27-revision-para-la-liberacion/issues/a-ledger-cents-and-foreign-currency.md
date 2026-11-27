Issue: #1066

## Goal

A peso ledger holds pesos to the cent, so the Anexo 24 trial balance always adds up after rounding. A foreign-currency amount keeps its origin through every door, and the closing revaluation reaches every monetary account the firm marks.

## Tranche and context

- **Tranche:** new, from the standards review of 27 Nov 2026 (report 01, findings G01, G02, G13).
- **Why now** (`develop` `e9a327d0`):
  - **Pesos are booked at four decimals.** `convertirAFuncional` keeps `foreign × rate` at 4 dp (`moneda-origen.ts:31-36`; used at `ar-ap-posting.ts:181`, `:313`, `:1081`), and `AMOUNT_RE` admits four on a hand entry (`journal-entry-service.ts:63`). The Anexo 24 amount has two (`balanza-invariantes.ts:50`), and its rounding finding blocks the file (`:296-312`; `balanza-service.ts:762`).
  - **Failing case, run as a pure-function probe.** USD 33.35 at 17.1141 in January (570.7552) and USD 5.85 at 17.0950 in February (100.0058) on one account: February declares 570.76 + 100.01 = 670.77 against SaldoFin 670.76. No file.
  - **The control account can lose its origin today.** The receivable is the sum of the converted lines and carries its FX columns only when that sum equals `total × rate` (`ar-ap-posting.ts:212-218`; payable twin `:350-367`). USD 33.33 + VAT 5.33 at 17.1141: 570.4130 + 91.2182 = 661.6312 against 661.6311, so the receivable posts in pesos only and the revaluation never reads it.
  - **A hand entry has no foreign currency.** `DraftLineInput` has none (`journal-entry-service.ts:256-277`, `:475`); nor do `entry-command.ts`, `batch-service.ts` or `routes/journal-entries.ts`. The engine already verifies an origin when one is given (`posting.ts:279`).
  - **Revaluation covers three roles.** `cxc`, `cxp`, `banco` and the banks' GL accounts (`report-service.ts:2030-2052`). A dollar loan stays at its birth rate.
- **The norm.** NIF B-15 as the corpus states it (`src/ai/docs/nif-registro.md:110-121`): historical rate at recognition, monetary items at the closing rate, non-monetary items at the historical one. The cent is the peso's unit; the Anexo 24 schema is in the repo.
- **Forks** (the owner's rule of 17 Nov, ADR-0006):
  - *Where the cent between converted lines and converted total goes:* new key `fx_conversion_cent_difference`, default `exchange_difference_line`, the conservative one: no line and no tax changes, and the cent is visible. Other option: `largest_line`.
  - *What the close does with a foreign-denominated account nobody marked monetary:* new key `fx_revaluation_unmarked_account`, default `warn`: nothing moves the result on a guess (an advance in dollars is non-monetary). Other option: `block`.
  - *Rounding to the cent, and an origin on a hand entry:* not choices. No key.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-862 | Functional amounts at the currency's minor unit; the control account keeps its origin | 350, two parts | — | R |
| MNE-001-863 | Census of posted sub-cent balances and their reviewed adjusting entry | 250 | MNE-001-862 | R |
| MNE-001-864 | A hand entry carries its foreign-currency origin (CLI, import, REST) | 300, two parts | MNE-001-862 | R |
| MNE-001-866 | Revaluation reaches every marked monetary account (absorbs report 02's N-14) | 300 | MNE-001-864 | S |
| MNE-001-955 | Three subledger doors in foreign currency | drafted by reviewer 06 | — | — |
| MNE-001-894 | A received USD CFDI posted at face value | drafted by reviewer 03 | — | — |

## Acceptance criteria

- [ ] (P1) Given the January and February case, the account holds 570.76 and 100.01 and February's trial balance declares SaldoFin 670.77 with no rounding finding.
- [ ] (P1) Given USD 33.33 + VAT 5.33 at 17.1141, the receivable posts `total × rate` to the cent with its FX columns, and the cent follows `fx_conversion_cent_difference`.
- [ ] (P1) Given `entry create` with 0.005 on a peso entity, it is refused naming the line.
- [ ] (P2) Given balances posted before P1, the census lists each account with its fraction and the months whose trial balance no longer adds up; `--apply` leaves one draft; once a person posts it the census is empty.
- [ ] (P2) Nothing edits a posted entry or reopens a period.
- [ ] (P3) Given a line with currency USD, 10,000.00 and rate 18.50, `entry create`, `entry import` and `POST /v1/journal-entries` store the origin; 185,000.01 is refused; the reversal mirrors it.
- [ ] (P5) Given a marked loan account with USD 10,000.00 at 18.50 and a closing rate of 19.00, `closing fx revalue` posts a 5,000.00 loss; an unmarked foreign account is listed, not revalued.
- [ ] (P5) Given a marked account, a line without its origin is refused.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | New optional line fields; `docs/openapi.json` regenerated (P3) |
| SAT/IMSS deliverables | compatible | The trial balance stops refusing on sub-cent rounding |
| Schema (migration) | none or compatible | P5 only, if the account mark is a column |
| CLI surface | compatible | New line fields; a census command; `account set` gains the mark |

## Out of scope / later

- A functional currency other than the peso (PRD-003 RF-49, report 01 G26).
- Consolidation and translation of foreign operations (RF-08, G27).
- Opening balances in foreign currency: MNE-001-865, under #1078.
- Statements printed at two decimals: follows from P1 and P2, no task.

## How to test

- **Unit:** the two probes above as specs of the conversion and of `verificarRedondeo`; the hand-entry shapes.
- **Integration:** beside the foreign-currency specs of the month; a January and February trial balance; the census on a base seeded at four decimals.
- **Edge cases:** a currency with no minor unit; a payment that realises a difference of less than a cent; a revaluation line on a marked account.

## Classification

- **Difficulty:** D3. **Autonomy:** A3: `posting.ts`, `validation.ts` and posted money.
- **Size:** P1 ~350 + ~300; P2 ~250; P3 ~300 + ~300; P5 ~300. One PR per part («Part of #N»).

## Constraints

- P1 changes amounts that engines post from then on, never a posted line.
- P2 writes only through a draft a person posts.
- Invariants 1, 3 and 4 of `AGENTS.md`.

## Depends on

- Nothing outside this issue. P1 goes first.

**Para el dueño:** hoy el mayor guarda los pesos con cuatro decimales, y una cuenta con dos facturas en dólares puede dejar una balanza que el Anexo 24 no acepta por un centavo. Además, una póliza tecleada a mano no puede decir que es en dólares, y la revaluación del cierre sólo mira clientes, proveedores y bancos. Con esto los pesos quedan al centavo, toda puerta acepta la divisa y el despacho marca qué otras cuentas se revalúan. Lo ya registrado se corrige con una póliza de ajuste que una persona revisa.

---
_Generated by [Claude Code](https://claude.ai/code)_
