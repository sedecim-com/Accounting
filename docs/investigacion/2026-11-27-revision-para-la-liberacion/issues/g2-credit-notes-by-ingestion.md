Issue: #1074

## Goal

A credit note that arrives as a CFDI has a door on both sides. One the entity issued becomes its receivables credit note, tied to its invoice and carrying its UUID. One received that names several bills, or a bill already paid, or that applies a vendor advance (relation 07), is posted or says by name why it waits.

## Tranche and context

- **Tranche:** new, from the standards-and-code review of 27 Nov 2026 (report 03, findings G7 and G8). Read at `develop` `e9a327d0`. It continues #692 (the received note against one unpaid bill, MNE-001-555) and #620 (an issued CFDI by hand).
- **G7 · an issued type E has no door.**
  - It is born a `credit_note` pre-registration (`tipoDocumentoDe`, `src/services/xml-ingestion/pre-registration-service.ts:42-47`). `applyRulesAndProcess` leaves every issued CFDI but a REP (`:410`); `cfdi post` refuses any `document_type` but `invoice` (`:1529`); a draft bound to it is refused at approval, which asks for `bill` (`:2113`).
  - No door writes `credit_notes.cfdi_uuid` (column in `049_cobrar.sql`; the INSERT of `src/services/ar/credit-note-service.ts:166` does not carry it, and no UPDATE sets it). So a note typed with `credit-note create` never matches its CFDI: the census reads booked notes by that column (`sat-census/reconcile.ts:90-93`) and leaves the CFDI in `to_post`, and the vouchers XML has no CompNal for it.
- **G8 · a received type E posts only against one unpaid bill.**
  - `refusalOf` (`received-credit-note.ts:70-115`) lets through relation 01 or 03, one related bill of the same vendor, the functional currency, no other taxes, a total not above the balance due. So these wait in the inbox for ever: a rebate that names several bills (`related_bills`, `:89`), a note on a paid bill (`bill_not_payable`, `:95-97`; `exceeds_balance`, `:104-106`), and the egreso that applies an advance (`not_credit_note`, `:81-83`).
  - The taxonomy describes the advance application (`egreso_recibido_aplicacion_anticipo`, `cfdi-taxonomy.ts:278-292`) and nothing posts it; a received advance debits `anticipo_proveedores` (`:149-163`) and nothing ever credits it from a CFDI.
- **Sources.** LIVA arts. 5 fr. III and 7: cited by the corpus (`src/ai/docs/mexico-cfdi.md`), their text arrives with MNE-001-757. Anexo 20, relations 01, 03 and 07 (`cfdi-facts.ts:13-21`); its guide's Apéndice 6 on advances is described in `receivables.md:36-40` and its text is to verify against the official one (N5 brings it first, as MNE-001-525 does).
- **Forks** (ADR-0006):
  - *How a note over several bills is spread:* new key `received_credit_note_spread`: `hold` (default) · `pro_rata_by_total` · `oldest_first`. `hold` is the conservative one: no bill's balance or VAT moves on an allocation nobody chose; the note waits and names its bills.
  - *Which accounts the note credits:* the existing `received_credit_note_cost` (`pending-catalog.ts:2353`), unchanged.
  - *A note on a paid bill:* no fork. It is a balance in the entity's favour with that vendor, applied later to another bill or refunded, which is a fact the accountant records.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-897 | Una nota de crédito emitida (CFDI tipo E) que llega por la ingesta se registra por la puerta de notas de crédito de CxC, ligada a su factura y con su UUID | 350 | — | S |
| MNE-001-898 | Una nota de crédito recibida sobre varias facturas o sobre una ya pagada, y la aplicación de un anticipo a proveedor (TipoRelacion 07), tienen puerta | 400 + ~350 (the plan splits it in 2) | MNE-001-895 | S |

## Acceptance criteria

- [ ] (N4) Given an issued type E of 116.00 (IVA 16.00), relation 01, on a PPD invoice of 1,160.00 not collected, `cfdi post <uuid>` creates and issues the note with its UUID: DR sales returns 100.00 / DR 2125 16.00 / CR receivables 116.00. On a PUE or collected invoice the 16.00 leaves 2120, as `credit-note-service.ts` already decides.
- [ ] (N4) After it, `sat download reconcile` counts that CFDI as matched, and a second `cfdi post` answers that it is already the note, by number.
- [ ] (N4) Given a type E in another currency, with relation 07, with no related invoice in the books, or naming several, the refusal names the reason by key and nothing is written.
- [ ] (N5, part 1) Given a note of 232.00 that names two unpaid bills of 1,160.00 and `pro_rata_by_total`, each bill goes down 116.00 and 16.00 of VAT leaves 1135 per bill, in one entry. On `hold` it waits and the reason names both bills and the key.
- [ ] (N5, part 1) Given a note of 116.00 on a bill paid in full, the vendor ends with 116.00 in the entity's favour, its 16.00 leaves 1130, and that balance can be applied to another bill of the same vendor; the AP ageing shows it.
- [ ] (N5, part 2) Given an advance bill posted to `anticipo_proveedores` and the egreso 07 that names the final bill, the advance is cancelled against that bill and its VAT is not credited twice.
- [ ] (N5) A note that fits today's rule posts exactly as today; one that still fits nothing waits with its reason.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | The process route can now post these notes |
| SAT/IMSS deliverables | compatible | The IVA workpaper already subtracts the 1130 share of a note (MNE-001-760); the DIOT fields are MNE-001-791 |
| Schema (migration) | none for N4; N5 only if its plan stores the spread | The plan says; a migration is the owner's review |
| CLI surface | compatible | `cfdi post` accepts an issued type E; one panel key; `mexico-cfdi.md`, `payables.md` and `receivables.md` reread and resealed |

## Out of scope / later

- Building and stamping the entity's own type E (MNE-001-904, part of #105).
- The customer advance by procedure B (MNE-001-525).
- Notes in another currency, with IEPS, local taxes or withholdings, or on a capitalised line: still refused.
- Telling an advance by the word «anticipo» in a description (`cfdi-facts.ts:400-405`), and the received advance whose VAT goes straight to creditable (`cfdi-taxonomy.ts:149-160`): both wait for a person today.
- The DIOT's returns fields (MNE-001-791).

## How to test

- `scripts/verify.sh` with integration.
- **Unit:** `refusalOf` with each new case; the spread under each value of the key, to the cent, remainder on the last bill.
- **Integration:** beside the spec of MNE-001-555 and `ing3-issued-cfdi-by-hand.int.spec.ts`; the census before and after N4; the IVA workpaper of the month of a note on a paid bill.
- **Edge cases:** a note above a bill's balance when spread; one bill of the list paid and one not; a reversal of the note's entry.

## Classification

- **Difficulty:** D3 (posted money, balances of bills). **Autonomy:** A3.
- **Size:** N4 ~350 in one PR; N5 ~750 in two («Part of #N»).
- **Route:** release (wave 3), Should.

## Constraints

- Invariants 3 and 4: each UPDATE of a bill or note carries its state predicate, its entity and a `rowCount` check, as MNE-001-555's does.
- The note's VAT follows where the bill's VAT is (1135 first, then 1130), never a second rule.
- No CFDI of a third party is corrected.

## Depends on

- MNE-001-895 (part of #1073) before N5: a note over several bills may carry several relation nodes.
- MNE-001-757 brings the text of LIVA arts. 5 fr. III and 7; N5 does not wait for it.

**Para el dueño:** hoy una nota de crédito que el cliente emitió en su sistema no tiene por dónde entrar al nuestro, y una nota de proveedor sólo se registra si nombra una sola factura sin pagar; la bonificación sobre varias facturas, la nota sobre una factura ya pagada y la aplicación de un anticipo se quedan en la bandeja. Con esto cada una se registra o dice por qué espera. El reparto de una nota entre varias facturas lo elige el despacho en el panel; mientras no elija, la nota espera.

---
_Generated by [Claude Code](https://claude.ai/code)_
