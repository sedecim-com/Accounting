Issue: #1078

## Goal

A company that moves in with open documents keeps three things it loses today: the IVA inside each open customer invoice, so collecting it causes the tax; the currency its foreign documents were born in; and the files of the prior system the opening was built from, with their fingerprint.

## Tranche and context

- **Tranche:** new. It follows #310 (MNE-001-022 and 023, delivered), which wrote the subledger behind the opening.
- **Why now** (`develop` `e9a327d0`, read and not run: each plan reproduces its case first):
  - **A migrated receivable carries no IVA.** `ar/opening-invoices.ts:42-47`: «the open balance goes in as subtotal with no tax … a collection releases no IVA». `ivaStillParked` adds the opening's share for the received side only (`iva-cash-basis.ts:668-677`), and the IVA workpaper counts a PPD collection by `payment_allocations.iva_reclass_amount` (`iva-workpaper.ts:44-52`). The payable side has `ivaRate` (`opening-balance.ts:190`) and the key `opening_payable_iva` (`pending-catalog.ts:1600-1615`); the receivable side has neither, and the load raises no finding.
  - **The failing case.** Opening with 116,000.00 of PPD receivables and 16,000.00 on the pending-IVA account (2125). January collects them: nothing moves 2125 to 2120, the workpaper shows 0.00 caused IVA, and 16,000.00 stays on 2125.
  - **A foreign open document is refused** (`opening-invoices.ts:176-189`, `APE-CXC-MONEDA`; the payable mirror in `ap/opening-bills.ts`): the load tells the firm to bring the balance in pesos, so the origin and every later exchange difference are lost. Task `MNE-001-865`.
  - **The source files are not kept.** The opening's audit row holds a label (`xml-sat:BalanzaComprobacion:<year>-<month>`), the RFC and totals (`opening-balance.ts:1344-1366`): no sha256, no bytes. `chart import` the same (`sat-chart-import.ts:926`). The SAT packages are already archived by bytes (migration 310).
- **The norm.** LIVA art. 1-B, as the corpus carries it (`src/ai/docs/receivables.md`): IVA is caused when collected. CFF art. 30 (five years, as MNE-001-322 cites it) and Código de Comercio art. 38: not in the corpus, to verify against the official text (`MNE-001-961`).
- **Forks** (the owner's rule of 17 Nov; ADR-0006):
  - *A receivable with no rate:* key `opening_receivable_iva`, `require_rate` (default) or `assume_zero_rate`. The default is the conservative one: it stops the load and names the documents, so no IVA is left uncaused. It mirrors `opening_payable_iva`.
  - *Where the files live, append-only, one row per file:* systems choices, no key.

## Tasks

| Id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| `MNE-001-946` | Open receivables carry their IVA rate, and collecting them releases 2125 to 2120 | 350, first of 2 parts | MNE-001-023 | R |
| `MNE-001-954` | The chart and opening loads keep the sha256 and the bytes of their file | 300 | — | S |
| `MNE-001-865` | The opening loads balances in another currency with their origin amount and rate (drafted by reviewer 01) | see its entry | `MNE-001-864` | R |
| `MNE-001-877` | Decision: does the first month's trial balance after a migration declare the opening as movement or as opening balance? (drafted by reviewer 01) | — | — | decision |

## Acceptance criteria

Setup: a Mexican entity on cash-basis IVA; an opening file whose `cxc` control account holds document A-123 for 116,000.00 with rate 0.16, and 16,000.00 on the account of role `iva_trasladado_no_cobrado`.

- [ ] (T1·1) Given the setup, `opening-balance import` creates invoice A-123 with subtotal 100,000.00, IVA 16,000.00, total 116,000.00, pointing at the opening entry; `ar reconcile` shows delta 0.00.
- [ ] (T1·1) Given a document with no rate, `require_rate` stops the load, names it and writes nothing; `assume_zero_rate` loads it at 0 % with a warning.
- [ ] (T1·1) Given documents whose IVA adds to more than the opening holds on the pending account, the load blocks with `APE-CXC-IVA-SIN-SALDO`, naming the account and both figures.
- [ ] (T1·2) Given `receipt record` of 116,000.00 against A-123, the receipt's entry moves 16,000.0000 from 2125 to 2120, the allocation stores it, and the month's IVA workpaper counts base 100,000.00 and IVA 16,000.00. A 58,000.00 receipt moves 8,000.0000.
- [ ] (T1·2) Given that receipt unapplied or reversed, the stored 16,000.0000 follows the rules a native PPD invoice follows today.
- [ ] (T1) Given an opening voided and loaded again (migration 087), the invoices it takes over carry their rate; nothing is released twice.
- [ ] (T9) Given `chart import` or `opening-balance import`, one archive row holds the file's sha256 and bytes, scoped by tenant and entity, and the audit row carries the sha256; `audit show` prints it.
- [ ] (T9) Given the same file loaded again, no second archive row; given `--dry-run`, none at all; an UPDATE or DELETE on the table is refused by its trigger.
- [ ] Given a non-Mexican entity, or an opening with no control documents, nothing changes.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | none | — |
| SAT/IMSS deliverables | compatible | The IVA workpaper and the DIOT-side figures of the months after go-live gain the IVA of migrated receivables |
| Schema (migration) | compatible | T9: one new append-only table, added to `append_only` in `rls-policies.sql:150` (owner path) |
| CLI surface | compatible | A new optional field in the opening's document rows; a new finding code; a new panel key |

## Out of scope / later

- **Openings already loaded:** T1 corrects nothing posted; a census of migrated invoices collected with no release is a later task.
- **Bank statement files:** only their sha256 is kept (migration 051, `:145`); archiving the bytes waits (report 06, G10).
- **The retention horizon** is MNE-001-322.
- **Other C gaps of report 06 with no task:** no hash chain across `audit_log` rows (G25); statement formats beyond csv, camt.053 and MT940 (G27).

## How to test

- `scripts/verify.sh` with integration; synthetic data only.
- **Unit:** the receivable plan with and without a rate, under each answer of the key; the finding when 2125 is short.
- **Integration:** beside the opening specs of #310 and `f03-cobrar.int.spec.ts`: load, collect in full and in halves, unapply; the month spec's opening slice (step 1) stays green.
- **Edge cases:** rate `0` and `exento`; a generic RFC; a reload after a voided opening; the same file with a changed byte.

## Classification

- **Difficulty / autonomy:** D3 / A3 (suggested). T1 touches posted money and the IVA cap; T9 brings a migration and an owner path.
- **Size:** T1 ~600 lines in two parts (the load and its key, ~350; the cap for the issued side, ~250); T9 ~300.

## Constraints

- Invariants 3, 4 and 6: guarded UPDATEs, entity and tenant inside the SQL, the key with its reader in the same commit.
- No adjusting entry is ever posted to make the opening tie.
- Each PR says «Part of #N».

## Depends on

- `MNE-001-865` and `MNE-001-877` are drafted by reviewer 01; `MNE-001-865` needs `MNE-001-864`.
- T9 reads the corpus section of `MNE-001-961` for its citation; it does not wait for MNE-001-322.

**Para el dueño:** hoy, una factura de cliente que llega abierta en la migración entra sin su IVA: al cobrarla, el sistema no causa el IVA y el papel de trabajo del mes sale corto. Con esto, cada documento dice su tasa, como ya lo hacen los de proveedores, y si no la dice la carga se detiene y nombra cuáles. Además, el archivo del sistema anterior del que salió la apertura queda guardado con su huella. Los saldos en moneda extranjera entran con su divisa de origen. Queda una decisión tuya: cómo declara la apertura la balanza del primer mes.

---
_Generated by [Claude Code](https://claude.ai/code)_
