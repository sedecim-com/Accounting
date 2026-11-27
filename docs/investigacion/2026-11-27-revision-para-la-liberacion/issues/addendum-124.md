Addendum to issue #124

## Goal

A United States entity that records a purchase, a fixed asset or a payment to a contractor gets the figure its own rules give. Sales tax has the return's figures by state, and a dollar entity can close a foreign-currency balance.

## Tranche and context

- **Tranche:** J1 (this issue), from the standards review of 27 Nov 2026 (report 09). The owner un-parked the United States for the 1.0 on that day (#329, comment 7210598786).
- **Why now** (`develop` `e9a327d0`):
  - **Sales tax paid is booked as an asset.** `postBillEntry` debits the role `iva_acreditable` (`ar-ap-posting.ts:279`, `:334-343`), mapped to 1136 «Impuesto Acreditable sobre Compras» on a non-Mexican entity (`account-roles-seed.ts:441`). Bill of 1,000.00 plus 82.50: DR 6100 1,000.00 · DR 1136 82.50 · CR 2110 1,082.50. Nothing ever credits 1136.
  - **MACRS follows the month, not the tax year.** `serieMACRS` spreads the first percentage over six months from the in-service month (`depreciation-math.ts:332-340`). Pure-function probe, 10,000.00, 5-year class, in service 1 Mar 2026: 3,066.67 in 2026 against 2,000.00 by the table. Only a July asset matches.
  - **Every MACRS asset is 5-year.** Nothing writes `macrs_class`; the engine falls back to `'5-year'` (`:321`).
  - **The only asset classes a United States entity can get are the LISR ones.** `entity create` seeds none (`entity-accounting.ts:162`); `asset category seed` has no jurisdiction guard and reads `legalParameterAt('MX', …)` (`asset-service.ts:176`, `:218`).
  - **The 1099-NEC engine has no caller** (`form-1099-nec.ts:57`), and `vendors.tax_id_type` admits only `rfc`, `ein`, `vat` (`002_ap_ar_schema.sql:16`): a contractor who gave a W-9 with a social security number is stored without a tax id and reported with `tin_missing` and 24 % of exposure (`:167-176`).
  - **Sales tax collected lands on one account** (2135) with no state; MNE-001-333 is «1/2» and no «2/2» was filed.
  - **`closing fx revalue` refuses a USD entity** (`fx-revaluation.ts:64`, `:398-403`); MNE-001-112 left it to this issue and no task took it.
- **The norm.** In the seed: the 1099-NEC threshold and the backup withholding rate (migration 250). Everything else is to verify against the official source before any figure is written: FASB ASC 330-10-30, 360-10-30 and -35, 830-20-35; IRS Pub. 946; the instructions of Forms W-9, 1099-NEC and 1099-MISC; each state's return instructions. The repo's study: `normas/fiscal-us.md` §4–§6.
- **Forks** (the owner's rule of 17 Nov, ADR-0006):
  - *A payment to a 1099 vendor with no box declared:* key `form_1099_unclassified_payment`, default `draft_for_review`, the conservative one: no form leaves as ready on a guess. Other option: `nonemployee_compensation`.
  - *Use tax on a purchase with no tax charged:* key `use_tax_accrual`, default `ask_per_bill`: nothing is accrued until a person confirms. Other option: `accrue_at_state_rate`.
  - *Exchange-rate source of a United States entity:* the default of `fuente_tipo_cambio` there is `manual`, which exists: DOF and FIX are of Mexican law.
  - *Sales tax paid as cost, MACRS by tax year, the class of an asset:* not choices. No key.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-988 | Sales tax paid on a purchase goes into the line's cost | 250 | — | R |
| MNE-001-989 | MACRS by tax year, with the asset's class written | 250 | — | R |
| MNE-001-990 | A United States entity is born with its asset classes; the LISR seed refuses | 250 | — | R |
| MNE-001-991 | The 1099-NEC has a door; the vendor keeps its W-9 and an individual's TIN | 380, two parts | — | R |
| MNE-001-992 | Each payment has its 1099 box; the 1099-MISC; a warning when paying without a TIN | 300 | MNE-001-991 | S |
| MNE-001-996 | Sales tax 2/2: return figures by state, exempt customer, use tax | 350, two parts | MNE-001-333 | S |
| MNE-001-997 | `closing fx revalue` in a USD entity | 250 | — | S |

Existing tasks of this issue stay, with the edits of `09-us-accounting-edits.md`: 333, 334, 335 (reshaped), 336, 337, 338, 340, 341, 342, 343.

## Acceptance criteria

- [ ] (U1) Given a United States entity and a bill of 1,000.00 plus 82.50 of tax, `bill approve` posts DR 6100 1,082.50 · CR 2110 1,082.50, and no line on 1136.
- [ ] (U1) Given balances already on 1136, a census that writes nothing lists them by bill and leaves one draft.
- [ ] (U2) Given 10,000.00, 5-year class, in service in March, July or November, the year's totals are 2,000.00 and 3,200.00 for the first two years.
- [ ] (U2) Given `--method macrs` with no class, the command refuses and names the classes.
- [ ] (U3) Given `entity create --country USA`, the entity has its classes with a MACRS class and no LISR rate; `asset category seed` on it never seeds a LISR class.
- [ ] (U4) Given a contractor with a W-9 and a social security number paid 12,000.00, the form is `ready` with no backup-withholding exposure.
- [ ] (U4) `vendor 1099 generate --year`, `list` and `mark-filed` exist.
- [ ] (U5) Given a landlord paid 18,000.00 of rent, the amount is in the rents box of a 1099-MISC row and not in box 1 of the NEC.
- [ ] (U9) Given March sales to Texas of 10,000.00 taxable and 2,000.00 exempt, `sales-tax report --state TX --period 2026-03` gives 12,000.00, 2,000.00, 10,000.00 and the tax, tied to its account.
- [ ] (U10) Given a USD entity with MXN 185,000.00 receivable born at 18.50 and a closing rate of 19.00, the run proposes a loss of USD 263.16 with its mirror on day 1.
- [ ] (all) A Mexican entity comes out identical: an equality test per task.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | New optional vendor and customer fields; `docs/openapi.json` regenerated |
| SAT/IMSS deliverables | none | — |
| Schema (migration) | compatible | U4 (W-9 columns, TIN type), U5 (box per vendor and bill line), U9 (customer exemption). The owner approves each |
| CLI surface | compatible | `vendor 1099 …`, `sales-tax report`, `asset create --macrs-class`; two panel keys |

## Out of scope / later

Class C in report 09, not filed as tasks:
- Leases under ASC 842 (operating and finance models, private-company elections).
- Revenue beyond schedules (ASC 606).
- Inventory cost and LIFO (ASC 330).
- Deferred tax and uncertain positions (ASC 740).
- Section 179, bonus depreciation, mid-month convention, 27.5 and 39-year property.
- Form 1096, IRIS or FIRE files, state copies, 1099-K and 1099-INT, TIN matching, Form 945 and box 4.
- Nexus monitoring, marketplace facilitators, local rate tables.
- Forms 1120, 1120-S, 1065; Schedule M-1; capital by partner.
- Translation and consolidation; 52-53 week calendars.
- The agent's floors per legal currency; engine messages that cite NIF; notes and subsequent events.
- Filing with the IRS or a state: not a product function (`docs/SCOPE.md`).

## How to test

- `scripts/verify.sh` with integration; synthetic data only.
- **Unit:** MACRS totals by tax year (three months, two classes); a bill's tax over two lines; the TIN states.
- **Integration:** beside `catalogo-por-pais.int.spec.ts` and `mne-001-332-form-1099-nec.int.spec.ts`, with a Mexican and a United States entity in one tenant.
- **Edge cases:** a foreign-currency bill with tax; a non-calendar fiscal year; a vendor with NEC and MISC payments.

## Classification

- **Difficulty / autonomy:** D3 / A3 for all seven: posted money, `ar-ap-posting.ts`, depreciation, a migration.
- **Size per part:** as in the tasks table; U4 is 1/2 W-9 and migration, 2/2 commands; U9 is 1/2 exemption and report, 2/2 use tax.

## Constraints

- Invariants 3 and 4: every new `UPDATE` carries its state predicate and reads `rowCount`; every query carries the entity.
- No figure of law in code: each rate, threshold and table enters `legal_parameters` with its source and validity, through MNE-001-328's command where it exists.
- Where an individual's TIN is stored and shown follows #96.

## Depends on

- Nothing of #123 for U1–U4: they read `jurisdictionOf` and `keepsMexicanBooks`, which exist.
- MNE-001-333 for U9 (it must be raised to Should). Text only: MNE-001-862 and MNE-001-866 for U10; MNE-001-885 and MNE-001-883 for 336 and 337.

**Para el dueño:** hoy una empresa de Estados Unidos que captura una compra con impuesto lo manda a una cuenta de activo que nunca se cancela; MACRS da la cifra de la tabla sólo si el activo entra en julio; sus únicas clases de activo son las de la LISR; y el 1099-NEC no tiene comando ni puede guardar el número de una persona física. Las cuatro primeras tareas corrigen eso sin tocar a México. Tres migraciones son tuyas (el W-9 del proveedor, la casilla del 1099 y la exención del cliente). Ninguna cifra de ley se escribe sin abrir antes su fuente oficial.
