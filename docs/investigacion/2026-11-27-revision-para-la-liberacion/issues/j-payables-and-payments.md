Issue: #1079

## Goal

The payables subledger can be corrected by its own doors. An approved bill can be voided; the same vendor invoice cannot enter twice unnoticed; a document's entry is reversed only through its document; and a payment receipt (REP) creates a bank payment only when its form moved the bank, on the account it names.

## Tranche and context

- **Tranche:** new. It follows #643 (the mark on a bill whose CFDI was cancelled) and #612 (the trail of a payment).
- **Why now** (`develop` `e9a327d0`, read and not run: each plan reproduces its case first):
  - **An approved bill cannot be voided.** There is no `voidBill`; `bill-command.ts:818-819` says «`bill reverse` has no backend yet». A cancelled received CFDI leaves a mark (migration 340) and two `ap check` warnings (`ap-checks.ts:90-144`). Case: a bill of 11,600.00 cancelled by its issuer keeps 10,000.00 of expense, 1,600.00 on 1135 and 11,600.00 on 2110; reversing its entry by hand leaves the bill open, and `ap-subledger-delta` blocks the close.
  - **A REP-born payment always moves the `banco` role.** `rep-linkage.ts:98-109` maps forms 01, 02, 03, 04 and 28 and sends the rest to `other`; `bankAccountOf` (`ar-ap-posting.ts:611-627`) posts to the bank; `rep_pago_no_registrado` defaults to `crear_pago`. Case: a received REP, form 17 «Compensación» (`sat-catalogs.ts:103`), 11,600.00: DR 2110 / CR bank 11,600.00 and 1,600.00 of IVA released, with no bank movement. With two bank accounts every REP lands on the default one.
  - **`entry reverse` and `entry void` accept a document's entry** (`posting.ts:763-797`, `:919`; `entry-command.ts:1083`, `:1156`; REST `journal-entries.ts:270`, `:295`). The ledger goes back, the payment stays `completed` and the bill `paid`; only the close notices.
  - **Payables have no duplicate guard.** `createBill` inserts without looking (`bill-service.ts:364-386`); the UUID index on `bills` is not unique (migration 340, `:44-45`); `ap check` has no duplicate probe, while receivables have `duplicate-invoice` (`ar-controls.ts:331`).
  - **Debit card.** `vendor_payments` does not admit `debit_card` (`002_ap_ar_schema.sql:122-123`), and the vouchers file declares it as 99 (`polizas-service.ts:402-420`, whose comment leaves the choice to the panel).
- **The norm.** LIVA arts. 1-B and 5 fr. III and NIF B-1, as the corpus and migration 041 carry them. CFF art. 29-A (cancellation), RCFF art. 33 and the descriptions of `c_MetPagos`: not in the corpus, to verify against the official text first.
- **Forks** (the owner's rule of 17 Nov; ADR-0006):
  - *The date of a void's mirror:* key `bill_void_mirror_date`, `void_date` (default) or `bill_date`. The default is the conservative one: the day of the act, as `invoice void` already dates its mirror, so no closed or declared month moves. `bill_date` in a period that is not open follows `cfdi_periodo_cerrado` (default `preguntar`).
  - *A repeated vendor invoice:* key `duplicate_vendor_bill`, `refuse` (default, conservative) or `warn`.
  - *The `c_MetPagos` code of a debit card:* key `anexo24_debit_card_method`, default 99, today's value, which claims no instrument.
  - *Which REP forms create a bank payment:* an allow-list (02, 03, 04, 28; 01 to the cash box), a systems choice: anything else waits for a person. No key.

## Tasks

| Id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| `MNE-001-947` | `bill void` with its mirror entry, its 1135 and its audit row | 380 | MNE-001-610 | R |
| `MNE-001-948` | A REP whose form moves no bank goes to review; one that does names the own account | 300 | — | R |
| `MNE-001-952` | `entry reverse` and `entry void` refuse a document's entry and name its command | 200 | `MNE-001-947` | S |
| `MNE-001-953` | `bill create` refuses a repeated vendor invoice; `ap check` gains `duplicate-bill` | 200 | — | S |
| `MNE-001-959` | Debit card on vendor payments, and its `c_MetPagos` code by panel | 200 | MNE-001-139 | S |

## Acceptance criteria

Setup: a Mexican entity; BILL-1 of vendor V, vendor folio F-881, subtotal 10,000.00, IVA 1,600.00, total 11,600.00, approved.

- [ ] (T2) Given the setup, `bill void BILL-1 --reason …` posts the mirror entry, leaves the bill `void` with 0.00 due and an audit row; `ap reconcile` shows delta 0.00 and the bill's 1135 nets to 0.0000. `--dry-run` prints the mirror and writes nothing.
- [ ] (T2) Given a live payment application or a live received credit note, the void is refused and names `payment unapply`; a bill born from the opening is refused, as `voidInvoice` refuses its mirror case.
- [ ] (T2) Given `void_date`, the mirror is dated the day of the act in the entity's time zone and needs an open period; given `bill_date` and a period that is not open, `cfdi_periodo_cerrado` decides, and `preguntar` writes nothing.
- [ ] (T3) Given a received REP with form 17 for 11,600.00 and no payment on file, no payment and no entry are created; the receipt stays `needs_review` with a reason that names the form.
- [ ] (T3) Given form 03 and one active bank account, the payment is created as today. Given two accounts and a REP that names own account B, the entry moves B's ledger account; with no match it waits in review and names `payment create --bank-account`.
- [ ] (T3) Given form 01, the payment moves the entity's single petty-cash account; with none or several it waits in review.
- [ ] (T7) Given the entry of an invoice, a bill, a receipt or a payment, `entry reverse`, `entry void` and both REST routes refuse by key and name the document's command; a manual entry is reversed as today; `invoice void`, `bill void`, `receipt reverse` and `payment reverse` still work.
- [ ] (T8) Given a second `bill create` for vendor V with folio F-881, it is refused and names BILL-1; under `warn` it enters with a notice; `ap check` lists the pair under `duplicate-bill` and writes nothing.
- [ ] (T14) Given `payment create --method debit_card`, it is accepted; a received REP with form 28 is stored as `debit_card`; the vouchers file declares the key's code (99 by default) and passes the official XSD.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | breaking, by refusal | `POST /v1/journal-entries/:id/reverse` and `/void` refuse a document's entry (T7); OpenAPI regenerated |
| SAT/IMSS deliverables | compatible | Anexo 24 vouchers: the method code of a debit-card payment follows the key, 99 by default |
| Schema (migration) | compatible | T14: the CHECK of `vendor_payments.payment_method` admits `debit_card` |
| CLI surface | compatible | New `bill void`; new probe `duplicate-bill`; new method value; three panel keys |

## Out of scope / later

- Cancelling a CFDI before the SAT; voiding a bill with live payments in one act.
- A vendor paid by **credit card** still credits the bank and not a liability to the card issuer.
- The compensation itself is `MNE-001-960`; the payer's trail of a REP-born receipt is MNE-001-635.
- A unique index on `bills`: only after the census of T8.
- **C gaps of report 06 with no task:** no statement of movements per third party and no `vendor show --as-of` (G22); cash on account and vendor advances are not tied to their accounts (G23).

## How to test

- `scripts/verify.sh` with integration; synthetic data only.
- **Integration:** beside `f04-pagar.int.spec.ts` and `rep-ligadura.int.spec.ts`: void unpaid, void refused when paid, the form-17 REP, two bank accounts, the duplicate under each answer, the refused reversal.
- **Edge cases:** a foreign-currency bill; a REP with several payment nodes of different forms.

## Classification

- **Difficulty / autonomy:** D3 / A3 (suggested) for T2, T3, T7 and T14 (posted money, `posting.ts`, a migration); D2 / A2 for T8.
- **Size:** ~1,280 lines in five PRs, in this order: T2, T3, T8, T7, T14.

## Constraints

- Invariants 3, 4 and 6: guarded UPDATEs with `rowCount`, scope inside the SQL, each key with its reader in the same commit.
- Each PR says «Part of #N».

## Depends on

- T7 goes after T2, so a bill has its own door before the general one is shut.
- T3 does not wait for MNE-001-635; the two share the reading of the REP's account fields.

**Para el dueño:** hoy un gasto aprobado no se puede anular: si el proveedor cancela su CFDI, el pasivo y el gasto se quedan, o se reversa la póliza a mano y el cierre se bloquea. Y un REP con forma de pago «compensación» mueve el banco aunque no salió dinero. Con esto, el gasto se anula por su propia puerta, el REP sin movimiento de banco espera a una persona, un gasto repetido se niega, y la póliza de un documento sólo se reversa desde el documento. Las tres bifurcaciones nacen con el valor conservador en el panel; no hay ninguna decisión pendiente tuya, salvo aprobar los planes.

---
_Generated by [Claude Code](https://claude.ai/code)_
