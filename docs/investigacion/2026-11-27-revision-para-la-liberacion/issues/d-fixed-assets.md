Issue: #1069

## Goal

A fixed asset can be corrected, retired, sold and reconciled from the terminal, and no asset can stop the close. The register holds what NIF C-6 and C-8 ask of a PyME: any class of asset, its opening accumulated depreciation, both depreciation schedules, and a tie-out to its control accounts.

## Tranche and context

- **Tranche:** new, from the norms review of 27 Nov 2026 (report 02, findings N-02, N-03, N-04, N-09, N-10, N-11). PRD-003 RF-05a names the disposal and has no task.
- **Why now** (`develop` `e9a327d0`):
  - **An asset never leaves.** `fixed_assets` has `status` `disposed`, `disposal_date`, `disposal_amount`, `gain_loss_amount` (`003_banking_assets_inventory.sql:182-186`) and no writer. The only `UPDATE fixed_assets` is the card refresh (`depreciation.ts:306`). The run takes every `active` asset (`:429`) and `closing run` posts it (`closing-conductor.ts:919`). The binary has `asset create` and `asset category seed` only (`asset-command.ts:271`, `:427`).
  - **Failing case 1.** A vehicle of 489,000.00 over 48 months, sold in month 6 for 400,000.00, keeps posting 10,187.50 at every close. The correct entry removes the cost and 61,125.00 of accumulated depreciation and books a loss of 27,875.00.
  - **Failing case 2.** A cost typed 4,890,000.00 posts 101,875.00 a month. Reversing does not help: the next month posts again, and since MNE-001-646 the reversed month is pending and re-posts.
  - **Units of production stop the close.** `asset create --method units_of_production` is accepted (`asset-command.ts:172-187`); the run reports an error for it (`depreciation.ts:478-484`); a step with errors is `failed` (`closing-conductor.ts:923`) and ends the run (`:1127-1130`). No command captures production.
  - **One schedule only.** «Only ONE schedule is computed and posted» (`pending-catalog.ts:176-177`), though `depreciation_schedules` admits `book`, `tax` and `projected` (`003:209-215`). Computer equipment of 62,500.00, 48 months in the books and 30 % for tax (migration 088): after twelve months 15,625.00 against 18,750.00, and the 3,125.00 difference is stored nowhere. NIF D-4 (MNE-001-300) and the annual ISR paper (MNE-001-850) need it.
  - **The register does not tie.** No opening accumulated depreciation at registration (`asset-service.ts:292`); the card sums only what this system posted (`depreciation.ts:300-325`). A machine of 240,000.00 from January 2024, registered in January 2027 with 72,000.00 already depreciated: the card says 2,000.00 and 238,000.00 after the first close, the ledger 74,000.00 and 166,000.00. No `asset list`, `asset show` or reconcile.
  - **Six classes.** The only `INSERT INTO asset_categories` is the LISR art. 34 seed (`asset-service.ts:103-152`, `:228`). No intangible account in the base chart (`chart-seed.ts:51-61`); the schema demands a life above zero (`003:157-158`), so land cannot be registered.
- **The norm.** NIF C-6 and C-8 as the corpus summarises them (`src/ai/docs/nif-registro.md:77-93`). The CINIF book is paid: paragraph numbers are not cited. That C-6 admits activity methods and that land is not depreciated are marked «por verificar contra el texto oficial».
- **Forks** (the owner's rule, #644; ADR-0006):
  - *Month of disposal:* key `asset_disposal_month_depreciation`: `through_previous_month` (default: symmetric with `mes_completo`, never over-depreciates) or `through_disposal_month`.
  - *Editing a posted asset, keeping history, audit rows:* systems choices, no key.
  - *Tax rates of the new classes:* law. LISR art. 33 (por verificar) enters `legal_parameters` from its source only; a class without a rate runs on its life.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-879 | `asset dispose`: retirement or sale, entry with gain or loss as a draft, depreciation stops | 350, two parts | — | R |
| MNE-001-880 | `asset edit` before any posted row, `asset retire` with its audit row | 250 | — | R |
| MNE-001-881 | Units of production refused at registration; an existing one no longer stops `closing run` | 200 | — | R |
| MNE-001-885 | Both schedules kept, one posted; `asset book diff` | 300, two parts | — | S |
| MNE-001-886 | Opening accumulated depreciation, `asset list`, `asset show`, `asset reconcile` | 300, two parts | MNE-001-880 | S |
| MNE-001-887 | `asset category create`: intangibles, improvements, land | 350 | — | S |
| MNE-001-916 | Fiscal depreciation on top of the tax schedule (drafted by reviewer 04) | theirs | MNE-001-885 | theirs |
| MNE-001-917 | Drafted by reviewer 04 | theirs | theirs | theirs |

## Acceptance criteria

- [ ] (N02) Given the vehicle of case 1, `asset dispose --date --proceeds 400000.00 --reason` leaves a draft that credits 489,000.00 of cost, debits 61,125.00 of accumulated depreciation and books 27,875.00 of loss; nothing posts without a person.
- [ ] (N02) Given that draft posted, the asset is `disposed` and the next `depreciation run` and `closing run` skip it.
- [ ] (N02) Given `through_disposal_month`, the month of the sale is depreciated first and the loss is lower by 10,187.50.
- [ ] (N03) Given case 2 with no live row, `asset edit --cost 489000.00 --reason` corrects it and the audit row keeps both values; with a live row it is refused by key, naming the reversal or `asset dispose`.
- [ ] (N03) Given `asset retire --effective --reason`, the run stops taking the asset; `--undo` returns it.
- [ ] (N04) Given `asset create --method units_of_production` (book or tax), it is refused by key.
- [ ] (N04) Given an asset already registered that way, `closing run` completes; the asset is listed as omitted with reason `unidades_de_produccion` and counted by `depreciacion_faltante_al_cierre`.
- [ ] (N09) Given the computer equipment above after twelve runs, `asset book diff --as-of 2026-12-31` prints 15,625.00, 18,750.00 and 3,125.00; the ledger holds the governing schedule only.
- [ ] (N10) Given the machine above with `--opening-accumulated 72000.00`, `asset show` prints 74,000.00 and 166,000.00 after the first close, and `asset reconcile` exits zero; without it, non-zero.
- [ ] (N11) Given `asset category create "Licencias de software" --life-months 36` and an asset of 180,000.00, the run posts 5,000.00; a `--non-depreciable` class takes land and the run omits it.
- [ ] No figure already posted changes in any task.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | none | REST gains no route here |
| SAT/IMSS deliverables | compatible | New accounts need their agrupador before the Anexo 24 catalog |
| Schema (migration) | compatible | N10: opening accumulated column. N11: non-depreciable flag and the life CHECK. Others: none |
| CLI surface | compatible | New leaves under `asset`; one refusal at `asset create` |

## Out of scope / later

- Capture of production for units of production; components with their own life (NIF C-6); construction in progress; bulk import.
- Catch-up of a month skipped in a closed period.
- Impairment (NIF C-15) and a minimal provisions register (report 02, N-19); retirement obligations (C-18); capitalised financing cost (D-6).
- The sale CFDI, its VAT and the taxable gain.
- A second IFRS book for assets (D-01, report 02, N-22).

## How to test

- **Unit:** the disposal arithmetic under each key value; the refusal texts by key in `en` and `es`.
- **Integration:** beside `act2-checklist-and-depreciation.int.spec.ts` and `mne-001-646-reversed-depreciation-runs-again.int.spec.ts`: a disposal mid-life; `closing run` with a units-of-production asset; reconcile with and without opening accumulated.
- **Edge cases:** disposal in the first month; an asset under `tasa_lisr`; a reversed disposal.

## Classification

- D3 / A3 for N02, N10, N11 (posted money or migration); D2 / A2 for N03, N04, N09.
- About 1,750 lines in six tasks; N02, N09 and N10 are two parts each, one PR per part.

## Constraints

- Invariants 3, 4 and 6: every `UPDATE` carries a state predicate, entity scope and a `rowCount` check; history is kept, never overwritten.
- Texts by key, `en.ts` first.

## Depends on

- Nothing outside the issue. MNE-001-916 waits for MNE-001-885.

**Para el dueño:** hoy un activo dado de alta no se puede corregir, vender ni dar de baja: el cierre lo sigue depreciando hasta agotar su vida, y un solo activo por unidades de producción detiene `closing run` cada mes. Con esto la baja deja su póliza con la utilidad o la pérdida como borrador, el alta mal capturada se corrige con su rastro, y el registro casa con el mayor. La única bifurcación contable va al panel (`asset_disposal_month_depreciation`); dos tareas traen migración, y su plan aprobado y su fusión te tocan.

---
_Generated by [Claude Code](https://claude.ai/code)_
