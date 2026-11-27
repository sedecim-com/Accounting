Issue: #1075

## Goal

The IVA workpaper and the DIOT credit only the IVA the law allows, in the month it allows. Three cases credit too much or too early today: cash over the limit answered as non-deductible, a restaurant meal, and IVA withheld to a supplier. The DIOT file then declares the non-creditable IVA instead of leaving it out.

## Tranche and context

- **Tranche:** new, from the standards review of 27 Nov 2026 (report 04, findings I-3a, I-3b, V-4, D-2). Read on `develop` `e9a327d0`, not executed: each plan reproduces its case first.
- **Cash over the limit (N1, N2).** The answer `no_deducible` to `efectivo_no_deducible` re-roles the expense line alone (`cfdi-classifier.ts:301`, `:310`); the IVA line stays on 1135/1130. Its own label says «(and no VAT crediting)» (`cfdi-decisions.ts:227`); the AP door moves both (`ap/cash-deductibility.ts:153-155`). Case: FormaPago 01, 5,000.00 + 800.00 → DR 6900 5,000.00 · DR 1135 800.00; once paid, the paper and the DIOT credit the 800.00.
- **Restaurants (N3).** `split_85` is the default of the decision (`cfdi-decisions.ts:244-248`) and of `politica_restaurantes` (`pending-catalog.ts:280-291`), but it has no role and `restaurantPolicy` is never read (`cfdi-decisions.ts:76`, `:95`; `pre-registration-service.ts:1055`). Case: 2,000.00 + 320.00 → DR `gasto` 2,000.00 · DR 1135 320.00, verdict `ready` (`cfdi-taxonomy.spec.ts:369-377`); by law 170.00 and 27.20 are deductible and creditable.
- **IVA withheld to suppliers (N4).** The paid fact carries the bill's whole IVA (`sat/diot/hechos.ts:723`); the withheld part travels only to DIOT field 48 (`:724`; `sat-batch.ts:298`). Case: fees 10,000.00 + 1,600.00, 1,066.67 withheld, paid in January → January credits 1,600.00; by law 533.33 then and 1,066.67 in February's return.
- **The DIOT file (N13).** 54 fields, per the SAT's batch-file instructions of January 2025 (`sat-batch.ts:31-37`). `record` fills the 16 % value and IVA (`:284`), the IVA withheld (`:298`), exempt, 0 % and field 54 (`:309`); the 20 non-creditable boxes of §3.4 and the proportion boxes of §3.3 stay empty, and the file is refused unless `diot_creditable_iva_proportion` is `taxed_only` (`:326`).
- **The law, read in its source before any plan.** Not in the repo's corpus, so «to verify against the official text»: LIVA art. 5 fr. I (IVA is creditable only when the expense is deductible, and in that proportion) and fr. IV (IVA withheld under art. 1-A is credited in the monthly return after the one that remitted it). In the seed: LISR art. 27 fr. III and art. 28 fr. XX. MNE-001-757 brings LIVA art. 5 fr. III and art. 7 to the corpus; the edits ask it to carry fr. I and IV too.
- **Forks and their defaults** (the owner's rule of 17 Nov; ADR-0006):
  - *Cash and restaurants:* no new key: the person's answer and `politica_restaurantes` decide, and the law fixes the IVA.
  - *Posted rows (N2):* `non_deductible_vat_correction`: `list_only` (default; nothing moves a ledger or a declared month without a person) or `draft_correction`. The period follows `cfdi_periodo_cerrado`.
  - *Withheld IVA (N4):* `withheld_vat_credit_month`: `after_remittance` (default; never credits before the law allows) or `payment_month` (today's).

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-906 | Cash over the limit answered as non-deductible at ingestion takes its IVA to the non-deductible expense | ~220 | — | R |
| MNE-001-908 | A restaurant meal under `split_85` splits the expense and its IVA in the deductible proportion | ~300 | MNE-001-326 | R |
| MNE-001-909 | IVA withheld to a supplier is credited in the month after its remittance (two parts) | ~400 + ~300 | text; part 2 reads MNE-001-912 | R |
| MNE-001-907 | A read-only census of posted non-deductible bills whose IVA stayed on 1135/1130, and an audited correcting entry | ~280 | MNE-001-906 | S |
| MNE-001-918 | The DIOT file declares non-creditable IVA and the proportion (two parts) | ~350 + ~350 | MNE-001-906, MNE-001-908 | S |
| MNE-001-962 | Cash over the LISR 27-III limit measured per operation or per payment, by panel key (drafted by reviewer 06) | ~200 | MNE-001-326 | S |

## Acceptance criteria

- [ ] (N1) Given a received CFDI with FormaPago 01, 5,000.00 + 800.00, answered `no_deducible`, `classify` and `bill inbox run` propose DR 6900 5,800.00 · CR 2110 5,800.00, with no line on 1135 or 1130.
- [ ] (N1) Given that bill paid, the paper and the DIOT of the month credit none of its IVA.
- [ ] (N3) Given a restaurant CFDI of 2,000.00 + 320.00 under `split_85`, the proposal is DR `gasto` 170.00 · DR 1135 27.20 · DR 6900 2,122.80 · CR 2110 2,320.00, the rate read from `legal_parameters` on the CFDI date; paid, the paper credits 27.20.
- [ ] (N3) Given `politica_restaurantes = no_deducible`, the whole 2,320.00 goes to 6900.
- [ ] (N4, part 1) Given fees of 10,000.00 + 1,600.00 with 1,066.67 withheld, paid in January, under `after_remittance` January's paper credits 533.33, and February's credits 1,066.67 once a person captures the remittance with its acknowledgement; the tie-out against 1130 names the difference.
- [ ] (N4, part 1) Given `payment_month`, the paper is today's, to the cent.
- [ ] (N4, part 2) Given the same bill, the ledger parks the withheld IVA in its own role until the remittance is on record, the DIOT follows, and the tie-out is silent.
- [ ] (N2) Given the N1 case posted before N1, the census names the bill, its 800.00, where it sits, the month that credited it and whether that month has a filed return, and writes nothing; under `draft_correction` a draft moves it to 6900.
- [ ] (N13, part 1) Given the N3 meal paid in the month, `diot export` writes 27 as creditable IVA and 293 in the non-creditable box the instructions name, and `diot check` ties 320.00.
- [ ] (N13, part 2) Given an entity with exempt acts and the paper's proration, the file fills the proportion boxes and is no longer refused.
- [ ] Given a non-Mexican entity, or a bill with none of the three cases, nothing changes.

## Impact

| Contract | Impact | Action |
|---|---|---|
| SAT/IMSS deliverables | compatible | The DIOT file fills boxes it left empty, each cited by section of the instructions, re-opened |
| Schema (migration) | compatible | N4 part 2 only: a role and its account for withheld IVA pending credit |
| CLI surface | compatible | N2's census; N4 part 1's capture flag on `filing workpaper generate` |

## Out of scope / later

- The card-payment requisite of art. 28 fr. XX; car rent per day (fr. XIII); payroll deductible only with its CFDI.
- The proportion by expense (LIVA art. 5 fr. V inc. a, b): the paper prorates all IVA paid and says so.
- Imports: IVA at customs and self-assessed IVA on foreign services (LIVA arts. 24 to 28).
- The DIOT's border boxes (decision MNE-001-922) and returns boxes (MNE-001-791).
- Other withholdings (foreign residents, scrap, commissions); IVA rates as rows with a reader; received IEPS (#694).
- Report 04's later items: surcharges and updating (CFF arts. 17-A, 21), CUFIN and CUCA, the calendar of due dates, a close item for «return recorded», non-accumulable revenue in the nominal income.

## How to test

- `scripts/verify.sh` with integration; synthetic CFDIs.
- **Unit:** each answer in `cfdi-taxonomy.spec.ts`; `sat-batch` with non-creditable IVA.
- **Integration:** the three cases paid in one month and across two; N2 under each `cfdi_periodo_cerrado` answer.
- **Edge cases:** PPD paid in parts; foreign currency; a meal also paid in cash over the limit.

## Classification

- **Difficulty / autonomy:** D3 / A3 for all five: what posts, posted books, a migration, a SAT deliverable.
- **Size:** ~2,200 lines in seven PRs («Part of #N»), as in the table.
- **Route:** release (wave 3). N1, N3 and N4 are Must: each is a wrong figure in a return.

## Constraints

- Every correction is a draft a person approves; nothing here posts on its own.
- The law is read in its source first; if a text does not open, the task stops and says so.
- No declared figure moves silently: N2 names the month.

## Depends on

- **MNE-001-326** before N3 (the rate read by date).
- **MNE-001-912** (#308) before N4 part 2 (the remittance on record); part 1 does not wait.
- **MNE-001-757**, if first, carries the two LIVA texts; otherwise N1, N3 and N4 bring their own.

**Para el dueño:** hoy el sistema acredita IVA que la ley no deja acreditar, o lo acredita antes de tiempo: el de un gasto en efectivo que ya se marcó como no deducible, el del 91.5 % no deducible de un consumo en restaurante, y el IVA retenido a un proveedor, que se acredita hasta el mes siguiente a su entero. Con esto el papel del IVA y la DIOT dejan de contarlo, y la DIOT declara el IVA no acreditable en sus casillas. Lo ya contabilizado sólo se lista, y se corrige con una póliza que una persona aprueba. La migración de la segunda parte del IVA retenido necesita tu aprobación.

---
_Generated by [Claude Code](https://claude.ai/code)_
