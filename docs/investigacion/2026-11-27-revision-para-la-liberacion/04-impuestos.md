# 04-impuestos — taxes the books must compute and support (ISR, IVA, IEPS, retenciones, DIOT, tax accounts)

Reviewer 04 of 7 · read-only · a checkout of the repository (origin/develop `e9a327d0`, 27 Nov 2026).
`npm run -s plan:status`: 14 of 16 packages green (E4.2 4/5, E5.1 25/27); 261 criteria. No test suite was run.

Conventions: **(tv)** = «to verify against the official text» (my memory of the law, not carried by the repo's corpus or seed).
Corpus = `docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md` (sources table §1, verified one by one) + `src/ai/docs/*.md`. The agent's corpus (`src/ai/docs`) has **no** fiscal-law document: only operational rules in `mexico-cfdi.md`, `payables.md`, `receivables.md` (MNE-001-362 is the open task for `fiscal-mx.md`).
Class: R blocks real use · S should be in the release · C could wait · N out by owner decision.

---

## 1. Norm list and code against the norm

### 1.1 ISR — persona moral, Título II

| # | Norm | What the code does today | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| I-1 | LISR art. 9: resultado fiscal = ingresos acumulables − deducciones − PTU pagada − pérdidas; tasa (seed `income_tax.corporate_rate` 0.30, mig. 166) | No annual computation. Rate row exists and is read by date (`provisional-income-tax-inputs.ts:193`). `annual figure record` only captures two figures off a return already filed | Absent (annual) | MNE-001-850 (w4, Should, open, no plan yet) | S |
| I-2 | LISR art. 14: pagos provisionales (coeficiente, ingresos nominales, PTU en octavos may–dic, pérdidas, acreditamiento de pagos previos y de retención art. 54) | `src/services/fiscal/provisional-income-tax.ts` (`chain` :104, `ptuDeductibleIn` :162, `lossesUpdateTarget` :172). `filing workpaper generate --form isr`. Arithmetic matches art. 14 as I read it (tv). Fails closed on regime ≠ 601, no coefficient, stale losses, no rate | Correct, with the partials below | done (059, 115, 420, 457) | — |
| I-2a | art. 14 fr. I: if the last 12-month year gives no coefficient, use the last one within five years | The reader takes the latest captured return ≤ 5 years (`provisional-income-tax-inputs.ts:150-158`). But `value` accepts `0` (`DECIMAL_4` regex :84, CHECK `value >= 0` mig. 166). **Failing case:** 2025 closed with a tax loss; the accountant records `--kind profit_coefficient --value 0 --year 2025`; every 2026 payment computes 0 instead of falling back to the 2024 coefficient | Wrong when so captured | no task | S |
| I-2b | art. 14: prior provisional payments and PTU paid | Typed by a person on every run (`ptuPaidInYear`, `priorProvisionalPayments`, :187-191). `filing record` writes only `iva_monthly` (`filed-returns.ts:55-60` «Only iva_monthly is written for now») | Partial | no task | S |
| I-2c | art. 17 fr. I: anticipos de clientes accumulate when collected | Not added: warning `ISR-WP-ADVANCES` tells the person to add them by hand (:367-375). Deferred revenue (role `ingreso_cobrado_por_anticipado`) **is** added (:330-340). The settlement is presented with the advances missing | Partial (figure understated when advances exist) | no task | S |
| I-2d | arts. 16, 18: non-accumulable revenue (dividends from Mexican entities), fiscal vs book gain on asset sales | Nominal income = every `revenue`-type account, credits − debits (:307-317). No role to exclude or adjust; header comment admits it | Partial | no task | C |
| I-2e | art. 14: second-year first payment (quarterly), irregular years | Not modelled; message says «en el primer ejercicio no hay pagos provisionales» | Absent | MNE-001-348 (irregular first year, Could) touches the calendar only | C |
| I-3 | LISR arts. 25–28: deducciones, requisitos, no deducibles | `cfdi-decisions.ts` asks three forks at ingestion (cash > limit, restaurant, fuel in cash); AP door `ap/cash-deductibility.ts` (MNE-001-345) | See I-3a, I-3b | — | — |
| I-3a | art. 27 fr. III (seed `income_tax.cash_payment_deduction_limit` 2,000) + LIVA art. 5 fr. I (IVA of a non-deductible expense is not creditable) | Ingestion: answer `no_deducible` only swaps the **expense** role (`cfdi-classifier.ts:301,311` `resolveRoleOverride`); the IVA line still goes to `iva_pendiente_acreditar`/`iva_acreditable`. The option label itself says «(and no VAT crediting)» (`cfdi-decisions.ts:227`). The AP door does it right (moves expense **and** IVA, `cash-deductibility.ts:153-155`). **Failing case:** CFDI FormaPago 01, 5,000 + 800 IVA, answered `no_deducible` → DR 6900 5,000 · DR 1135 800 · CR 2110 5,800; on payment the 800 reaches 1130 and the IVA workpaper and the DIOT (field 22) credit it | **Wrong** | no task | **R** |
| I-3b | art. 28 fr. XX (seed `income_tax.restaurant_deductible_rate` 0.085) | `split_85` is the default of `consumo_restaurante` and of the panel key `politica_restaurantes`, but it has no `role` and **no code splits anything**: `restaurantPolicy` is assigned and never read; the only arithmetic is the question's context text (`cfdi-decisions.ts:241-242`) and the panel preview. **Failing case:** restaurant CFDI 2,000 + 320 → DR `gasto` 2,000 · DR 1135 320 (verdict `ready`, `tests/xml-ingestion/cfdi-taxonomy.spec.ts:369-377`). Law: 170 deductible, 1,830 non-deductible, and IVA creditable only in that proportion (LIVA 5-I, tv). Card-payment requisite not checked against FormaPago. The constant is hard-coded twice (seed note says so) | **Wrong** (label promises a split the entry does not make) | MNE-001-326 only moves the constant to the table | **R** |
| I-3c | art. 28 fr. XXX: non-deductible share of exempt pay (0.53 / 0.47, tv) | Not computed; `ptu close` asks for it as a captured figure (`ptu.ts:50`). No row in `legal_parameters` | Absent | inside MNE-001-850 (captured) | C |
| I-3d | art. 28 fr. XIII (car rent 200/day), art. 27 fr. V (payroll deductible only with withholding, entero and CFDI) | Absent. Fees without withholding are signalled (`fees-without-withholding` close item, `period-close.ts:948`) | Partial | MNE-001-363 (Could) for the parameters | C |
| I-4 | LISR arts. 31–38: deducción de inversiones, por cientos máximos (seed mig. 088: 5 / 10 / 25 / 30 / 35 / 10 %), MOI, actualización INPC, tope de automóviles (36-II: 175,000 / 250,000 in the corpus) | One schedule per asset, chosen by panel `base_depreciacion` (`vida_util_nif` default, or `tasa_lisr`): book **or** tax, never both (`assets/depreciation-math.ts:50-67`). Max rate enforced per class (`asset-service.ts:484-491`). No parallel tax schedule, no INPC update of the deduction (`inpc-service.ts:51-55` says so), no car cap, six classes of arts. 34–35 only | Partial | MVP.md says «el calendario paralelo, en #112»; **no backlog task** | S |
| I-5 | LISR arts. 44–46: ajuste anual por inflación | Absent (catalog row `annual inflation calculate` ❌) | Absent | captured figure in MNE-001-850 | C |
| I-6 | LISR arts. 57–58: pérdidas fiscales, actualización, ten-year carry (tv) | One captured figure «pending losses updated through YYYY-MM» per return (mig. 166); updated to June / prior December with INPC (`lossesUpdateTarget`). No ledger by vintage, no expiry | Partial | no task (`annual loss list` ❌) | C |
| I-7 | INPC and factor (LISR art. 6 fr. II; CFF art. 17-A is a different shift) | `fiscal/inpc/factor.ts`, `inpc-service.ts` (import, list, verify, same-base refusal, fails closed on a missing month). **No door**: no CLI, no REST, no script calls `importarSerie`; the table is empty in every install. Effect: an entity with pending losses blocks with `ISR-WP-LOSSES-NOT-UPDATED` unless the losses were captured already updated to the target month. CFF 17-A factor deliberately not implemented | Partial (engine without door) | MNE-001-306 (w4, **Could**, open) | S |
| I-8 | LISR art. 76: obligations (contabilidad, anual, informativas) | Books and Anexo 24: other reviewers. No annual-return support, no informatives | Absent | 850 | S / C |
| I-9 | LISR arts. 77–78 (CUFIN, CUCA), art. 10 and 140 (dividends) | Absent. Memorandum accounts exist (8xx) and could hold the balances by hand | Absent | no task | C |
| I-10 | Retenciones a terceros: arts. 106, 116 (10 %), 113-J (1.25 %); rates in `legal_parameters` (mig. 129, 175) | `xml-ingestion/withholding-law.ts` computes the law's figure on the CFDI date, compares with the declared one, panel keys `fees_without_withholding`, `withholding_mismatch`, `withholding_accounts_layout`. Collection with withholding applied (MNE-001-113) | Correct at recognition; see V-6 for the month | done (056, 057, 113, 147, 148) | — |
| I-11 | RESICO personas morales (arts. 206–215) | **Out, fail closed**: ISR workpaper blocks with `ISR-WP-REGIME` for regime ≠ 601 (:273-281); `ptu close` refuses (`ptu.ts:128`). IVA workpaper and DIOT still work for such an entity | By design | — | **N** — `docs/MVP.md:9` «persona moral, régimen general» |
| I-12 | PTU: LFT arts. 117–127; LISR art. 9 last paragraphs (base without PTU paid or losses, less the 28-XXX non-deductible) | `accruals/ptu.ts` `ptuBase` :55 is correct as I read art. 9 (tv). `ptu close` drafts in period 13. **It refuses in every database**: row `ptu.rate` is not seeded (`PTU_RATE_KEY`, :164-169). Distribution, caps of art. 127 fr. VIII, payment run and 15-UMA exemption: absent (catalog ❌) | Engine correct, unusable | MNE-001-854 (w4, Must, open); MNE-001-849 monthly (Should, open) | **R** (854) · S |
| I-13 | NIF D-4 / ISR del ejercicio as closing draft | Absent. Accounts 2130, 1310, 2300 seeded; no role, no engine | Absent | MNE-001-300 (w4, Must, open) | **R** (annual statements) |
| I-14 | Coeficiente de utilidad recalculated from the annual figures | Absent; captured from the filed return | Absent | not named in MNE-001-850's acceptance | S (amend 850) |

### 1.2 IVA

| # | Norm | What the code does today | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| V-1 | LIVA arts. 1, 1-B, 5 fr. III, 5-D: cash basis, monthly definitive | `accounting/iva-cash-basis.ts`, roles 1130 / 1135 / 2120 / 2125; `fiscal/iva-workpaper.ts` (2,764 lines): charged by collection, creditable by payment, cheque on cashing, advances, credit notes (art. 7), undo rules, FX. `filing workpaper generate --form iva` | Correct on reading of the settlement (`settleIva` :375); the many edge rules were not re-derived | done (058, 344, 385, 386, 421–423, 491–493, 506–510, 565–566, 679, 682 …) | — |
| V-2 | CFF art. 20: adjustment to pesos | `roundToWhole` :238 (1–50 down, 51–99 up), panel `declaracion_redondeo_a_pesos` | Correct | done (004) | — |
| V-3 | LIVA art. 5 fr. I: creditable only if the expense is deductible; proportional when partly deductible | See I-3a and I-3b: the ingestion door credits the IVA of a non-deductible cash expense and of the non-deductible 91.5 % of a meal | **Wrong** | no task | **R** |
| V-4 | LIVA art. 5 fr. IV: IVA withheld under art. 1-A is creditable in the monthly return **following** the one in which it was remitted (tv; the corpus is silent on fr. IV) | Not modelled. `hechos.ts:714-724` takes the bill's whole IVA as `ivaPagado`; the withheld part is kept only for DIOT field 48. **Failing case:** fees 10,000 + 1,600 IVA − 1,066.67 IVA withheld, paid 20 Jan. January's paper credits 1,600. Law: 533.33 in January; 1,066.67 in the return after the one that remitted it (February's, filed in March) | **Wrong** (month of the credit) | no task | **R** |
| V-5 | LIVA art. 1-A, RLIVA art. 3: retención (2/3; 4 % freight; rows mig. 129, 175) | `withholding-law.ts`. Not covered: border-rate freight (says so), art. 1-A fr. III (foreign residents), desperdicios, commissions | Partial | done / no task | C |
| V-6 | LIVA art. 1-A, LISR 106/116: the withholding is made when the price is **paid**, on what is paid (tv) | The liability is credited when the **bill is posted** (`cfdi-taxonomy.ts:178-179, 201-202`), and the paper's `withheld_to_remit` is the month's credits to 2142 (`iva-workpaper.ts:2727`). **Failing case:** fees CFDI of 28 Jan paid 5 Feb → shown to remit in January (due 17 Feb) instead of February. Early, so conservative; DIOT field 48 follows the payment, so the two papers disagree. ISR withheld to third parties has **no** workpaper line at all | Wrong month (early) + absent ISR paper | no task | S |
| V-7 | LIVA art. 5 fr. V, 5-B, 5-C: proporción | Panel `iva_creditable_proration` (monthly default / prior year). The factor multiplies **all** IVA paid: no identification of expenses used only for taxed (inc. a) or only for exempt acts (inc. b); the paper warns. No-objeto acts in the denominator | Partial, disclosed | done (344, 385) | C (S for a mixed-activity client) |
| V-8 | LIVA art. 6: saldo a favor (credit, refund; a balance whose refund was asked is gone) | `fiscal/filed-returns.ts`, `prior-balance.ts`: record of filed returns, credits capped, oldest first, criterio 23/IVA/N cited. `filing record`, `filing correct` | Correct on reading | done (386, 533, 576, 577, 613, 629); open: 630 (refund / compensation leaf), 748, 749 | C |
| V-9 | Compensación (CFF art. 23) | Table `tax_balance_uses` has a reader and no writer (MNE-001-630). Modelled as same-obligation only. For IVA, art. 6 names only credit and refund (tv): 630 should refuse an IVA compensation unless the text read says otherwise | Absent writer | MNE-001-630 (w4, Should) | C |
| V-10 | LIVA arts. 2-A, 9, 15, 20: 0 %, exempt | Boxes per rate from CFDI lines (`sat/diot/desglose.ts`); exempt and no-objeto bases kept | Correct on reading | done | — |
| V-11 | Región fronteriza (decree; 8 % as a 50 % credit; corpus: extended to 31-12-2026, publication date to confirm) | `tasa8` box exists; no `legal_parameters` row (seed says «comes with J0.4»), no entity flag; DIOT batch **refuses** any 8 % (`sat-batch.ts:268`); freight withholding at 8 % not computed. Validity after 31-12-2026 is unknown to the repo | Partial, fails closed | no task | C (owner decision: in or out) |
| V-12 | LIVA arts. 24–28: imports (pedimento; self-assessed IVA on foreign services) | Absent. A foreign supplier's 16 % is written to the «import of intangibles» boxes of the DIOT; a 0 % foreign bill is refused | Absent | no task | C |
| V-13 | IVA rates as law with date (`vat.standard_rate` seeded 0.16 from 2010-01-01) | The row has **no reader**; rates are literals in `cfdi-parser.ts`, `cfdi-facts.ts`, `sat-catalogs.ts` | Partial | MNE-001-328 (doctor), no task for the reader | C |
| V-14 | Since January 2024 the SAT form captures bases, not IVA | Paper shows both; no check line per rate | Partial | MNE-001-631 (w4, Should) | S |

### 1.3 DIOT (LIVA art. 32 fr. V and VIII; RMF 4.5.1)

| # | Norm | Code | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| D-1 | 2025 batch layout | `sat/diot/sat-batch.ts`: **54** pipe-separated fields (7 + 10 + 10 + 20 + 7), no header, UTF-8, CRLF, whole pesos; grounded in the SAT «Instructivo … carga masiva DIOT, Enero 2025», consulted 2026-09-29 (`SAT_SOURCE` :31-37; criterion `E1.2 diot-sat-layout-cited`). Years before 2025 refused. The research corpus (Sept) still says DIOT «Ausente»; `src/ai/docs` does not describe the 54 fields. I could not open the instructivo: field positions are **as cited, not re-verified** | Grounded | done (027, 055) | — |
| D-2 | Fields filled | 1–6 (third party), 12 / 22 (16 % value / IVA), 16 / 26 (import of intangibles, foreign), 48 (IVA withheld), 49–51 (exempt import, exempt, 0 %), 54 (`01`). **Never filled:** returns (9, 11, 13, 15, 17), proportion boxes of §3.3, the 20 non-creditable boxes (28–47), not-subject (52–53), border regions | Partial | MNE-001-791 (returns, w4, Should) | S |
| D-3 | Refusals | Mixed activities (`proportion ≠ taxed_only`) refuse the whole file; 8 %; other rates; negative net per third party; foreign 0 %; country ZZZ | Fails closed: such a client files by hand in the portal | no task for proportion / non-creditable | S |
| D-4 | Facts = IVA effectively paid, tied to 1130 | `hechos.ts`; `diot check` reconciles against the IVA paper | Correct by construction | done | — |
| D-5 | Formato A-29 | Not used: the 2025 platform takes the batch file; the old layout is refused, not written | n/a | — | — |

### 1.4 IEPS, tax accounts, the rest

| # | Norm | Code | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| E-1 | LIEPS arts. 10, 5-C: caused when collected (issued side) | `accounting/ieps-cash-basis.ts`, roles 2180 / 2181 (209.02) | Correct on reading | done (504, 505, 521, 590, 604, 608) | — |
| E-2 | IEPS received: creditable or cost (`tratamiento_ieps`), cash basis | Classifier posts to `ieps_acreditable` at recognition; no parking, header fix done (488, 554) | Partial | MNE-001-494…497 (w4, Should), 346 | C |
| E-3 | IEPS monthly return | No workpaper | Absent | no task | C |
| A-1 | Tax accounts of the chart | Seeded: 1130, 1135, 1145, 1146, 1165, 2120, 2125, 2130, 2140–2145, 2180, 2181, 2190, 1310, 2300, 2205, 6900. **Missing:** IVA por pagar, IVA a favor, pagos provisionales de ISR, ISR del ejercicio (expense) and their roles | Partial | no task | S |
| A-2 | Monthly clearing entry (determinación del IVA; payment of IVA, ISR and withholdings) | **Absent** (`filing post` is 🟡 in the catalog). 2120 and 1130 grow gross for ever unless a person writes the entry by hand. And the paper's tie-outs `IVA-WP-CHARGED-VS-LEDGER` / `IVA-WP-CREDITABLE-VS-LEDGER` compare against the month's **net** movement of 2120 / 1130 (`iva-workpaper.ts:2643-2651`): a hand-written clearing entry dated in a month raises a warning in that month's paper, every month | Absent, and the hand-made substitute collides with the paper | no task | S |
| A-3 | Recargos y actualización (CFF arts. 17-A, 21) | Absent (the CFF factor is deliberately not written, `factor.ts:30-37`) | Absent | no task | C |
| A-4 | Calendar of obligations (day 17; extra days by sixth RFC digit, decree of 26-12-2013 in the corpus) | `PAYMENT_DUE_DAY = 17` is a constant used only to pick the coefficient; no calendar | Absent | MNE-001-363 (Could) seeds parameters only | C |
| A-5 | Month close gates | No item says «the month's return was recorded» or «the DIOT was generated» | Absent | no task | C |
| A-6 | Annual informatives (art. 76; DIM annexes) | Absent | Absent | no task | C / N (presenting is manual, MVP.md:44) |

---

## 2. `legal_parameters`: every tax rate, threshold and date against its source

Two writers: `LEGAL_PARAMETERS_SEED` (runs only with `npm run seed`) and data migrations (082…330). Tax rows:

| Key | Value · effective_from | Source cited in the row | In the corpus? | Reader | Note |
|---|---|---|---|---|---|
| `vat.standard_rate` | 0.16 · 2010-01-01 | LIVA art. 1; decree DOF 07-12-2009 (reform record) | Rate yes («16 % estable»); the date comes from the reform record, noted in the seed | **none** | row without reader |
| `income_tax.cash_payment_deduction_limit` | 2,000 · 2014-01-01 | LISR 27-III | yes (§2.1) | `ap/cash-deductibility.ts` only; ingestion uses the constant `CASH_DEDUCTION_LIMIT_MXN` | MNE-001-326 |
| `income_tax.restaurant_deductible_rate` | 0.085 · 2014-01-01 | LISR 28-XX | yes (§2.1) | **none**; two constants | MNE-001-326; and see I-3b |
| `income_tax.corporate_rate` | 0.30 · 2014-01-01 | LISR art. 9 | yes (§2.4) | ISR paper | ok |
| `income_tax.depreciation_max_rate.*` (6) | 5 / 10 / 25 / 30 / 35 / 10 % · 2014-01-01 | LISR 34 fr. I b, III, VI, VII, VIII; 35 fr. XIV | yes (§2.2) | asset classes | the other fractions of 34–35 and the art. 36-II cap are not rows |
| `income_tax.withholding.professional_fees_rate`, `.lease_rate` | 0.10 · 2014-01-01 | LISR 106, 116 | yes (§2.3) | `withholding-law.ts` | ok |
| `vat.withholding.individual_thirds`, `.freight_rate` | 2/3, 0.04 · **2006-12-05** | LIVA 1-A, RLIVA art. 3 | values yes (§2.5, source 5); **the date is not in the corpus** (the corpus only gives the RLIVA's last reform, DOF 25-09-2014) | `withholding-law.ts` | **date without source in the corpus** |
| `income_tax.withholding.resico_rate` | 0.0125 · 2022-01-01 | LISR art. 113-J «fifth paragraph» | **no**: art. 113-J is not among the articles the corpus read (source 1 lists 113-E, not 113-J); the date is not in the corpus | `withholding-law.ts` | **value, paragraph and date without source in the corpus** |
| `income_tax.exempt_cap.separation_uma_per_year_of_service` | 90 UMA · 2016-01-28 | LISR 93-XIII; desindexation decree DOF 27-01-2016 | value yes; **the decree is source 42, `verificada = false`** (not opened) | payroll | date rests on an unopened source |
| `ptu.rate` | **no row** | Sexta Resolución, DOF 18-09-2020: corpus source 41, `verificada = false`; the 10 % stands on source 40 (STPS page) | — | `ptu close` (refuses) | MNE-001-854 |
| region fronteriza 8 %, art. 36-II cap, 28-XIII, 28-XXX factors, surcharge rate, day 17, loss carry years, coefficient age (5 years, constant) | **no rows** | — | 8 %, 175,000 / 250,000, 200 and day 17 are in the corpus; the rest are not | — | MNE-001-363 covers part |

Payroll rows (UMA, subsidy, minimum wages, aguinaldo, exempt caps) belong to the payroll reviewer; all carry a DOF URL. Not checked here beyond noting that no `uma.daily` row exists for 2025 and that the 2027 rows are MNE-001-637 / 638.

---

## 3. The v1.0 items of #111 and PRD-003

| Task | State | Finding |
|---|---|---|
| MNE-001-300 ISR del ejercicio (D-4) como borrador de cierre | w4 · Must · open | Option (b): the accountant captures the ISR causado with its source; needs roles for 2130 / 1310 / 2300 (none today) and an expense account that the seeded chart lacks |
| MNE-001-849 PTU mensual | w4 · Should · open | Depends on 298 (done). Useless until 854 lands |
| MNE-001-850 Papel del ISR anual (art. 9) | w4 · Should · open · no plan · needs a migration | The keystone: 298 and 300 read from it. Its acceptance does not name the **coefficient** as an output, nor the art. 28-XXX share, nor the tax depreciation source. Amend before planning |
| MNE-001-852 Ingreso diferido, parte 2 | w4 · Should · open | Books side; the ISR paper already adds the liability's net credit |
| MNE-001-854 fila `ptu.rate` | w4 · Must · open | Blocks `ptu close` everywhere today. Needs the resolution's text opened (the task says: if it cannot be opened, stop) |
| PRD-003 RF-26 (D-4 and D-3 PTU) | Must since 2026-11-18 | 300 + 298 cover the draft; the conciliación contable-fiscal and the effective-rate reconciliation it asks for exist only inside 850 |
| PRD-003 RF-19 («el ajuste anual no tiene tarea») | — | That is the workers' annual ISR (art. 97), payroll domain; still no task |
| PRD-003 RF-13 (indirect tax from the package) | Should, no task | Not a release item for Mexico |

---

## 4. Proposed new tasks (gaps with no task)

Sizes in hand-written lines; cap 400 per PR.

| # | Title (backlog style) | Hang on | Lane | Size | Depends on | Needs |
|---|---|---|---|---|---|---|
| N1 | El efectivo sobre el límite contestado como no deducible en la ingesta lleva su IVA al gasto no deducible, como ya hace `cash-deductibility.ts` (LIVA art. 5 fr. I) | #125 | B | ~180 | — | critical path (classifier); reads LIVA 5-I into the corpus first (MNE-001-757 family) |
| N2 | Censo, sin escribir, de las facturas ya contabilizadas como no deducibles cuyo IVA quedó en 1130 o 1135, y su póliza de corrección auditada | #125 | C | ~250 | N1 | pattern of MNE-001-562 / 599; panel key for the correction (ADR-0006) |
| N3 | Consumo en restaurante: `split_85` parte el gasto en su parte deducible y su parte a `gasto_no_deducible`, con el IVA en la misma proporción, leyendo `income_tax.restaurant_deductible_rate` | #123 | B | ~300 | MNE-001-326 | critical path; accepted-practice: `politica_restaurantes` exists, its IVA treatment needs an option with the conservative default (non-creditable share to 6900) |
| N4 | El IVA retenido a un proveedor se acredita en el mes siguiente a su entero (LIVA art. 5 fr. IV): el papel del IVA y la DIOT lo separan del IVA pagado | #308 | H | ~400 + ~300 | N7 (remittance recorded) | owner decision (ledger: park in a role of its own, or paper-only); probably a migration (role + account); corpus text first; panel key with conservative default |
| N5 | Las retenciones por enterar del mes se leen de lo efectivamente pagado, no de la factura contabilizada (LIVA art. 1-A; LISR arts. 106, 116, 113-J) | #309 | H | ~250 | — | accepted-practice (ledger keeps accrual; the paper reads payments) |
| N6 | Papel de trabajo de retenciones: ISR por honorarios, arrendamiento, RESICO y salarios, e IVA retenido, por mes y por concepto (`filing workpaper generate --form withholdings`) | #309 | H | ~350 | N5 | — |
| N7 | `filing record` guarda un pago provisional de ISR y un entero de retenciones presentados, y el papel del ISR lee de ahí los pagos anteriores | #308 | H | ~300 | MNE-001-577 | the table already admits `isr_provisional`; maybe a CHECK migration for a third obligation |
| N8 | El coeficiente de utilidad en cero no se captura: `annual figure record` lo niega y el papel nombra el último coeficiente de hasta cinco años (LISR art. 14 fr. I) | #308 | H | ~90 | — | — |
| N9 | El papel del ISR suma los anticipos de clientes cobrados por su base (LISR art. 17 fr. I), menos lo ya facturado, con su traza | #308 | H | ~280 | — | accepted-practice key (add / warn only), default: add |
| N10 | La póliza mensual de impuestos como borrador: determinación del IVA y registro del pago de IVA, ISR provisional y retenciones, con los roles `iva_por_pagar`, `iva_a_favor` e `isr_pagos_provisionales`; el amarre del papel la excluye por su `source_type` | #308 | H / E | ~400 + ~350 | N7 | migration (roles, accounts, backfill); owner decision on the entry's date (month end or payment day) as a panel key; critical path (posting through `posting.ts` as a draft) |
| N11 | Depreciación fiscal en calendario paralelo (`schedule_type = tax`) junto al contable, con el tope de automóviles del art. 36 fr. II y los por cientos restantes de los arts. 34 y 35 en `legal_parameters` | #112 | A | 3 × ~350 | MNE-001-363 | owner decision (meaning of `base_depreciacion` once both exist); migration likely |
| N12 | La deducción de inversiones actualizada por INPC (LISR art. 31) como insumo del papel anual | #112 | A | ~250 | N11, MNE-001-306 | — |
| N13 | DIOT: el archivo declara el IVA no acreditable (§3.4), la proporción (§3.3) y los actos no objeto (§3.5), en vez de negarse | #307 | H | 2 × ~350 | N1, N3 | critical path (`sat-batch.ts`); every field grounded in the instructivo, re-opened |
| N14 | Semilla: la fecha de entrada de las retenciones del RLIVA, la retención de RESICO (art. 113-J) y el tope de separación quedan con su fuente abierta y anotada en el corpus | #132 | G | ~120 | — | a corrected date is a new row, never an update |
| N15 | Ajuste anual por inflación (LISR arts. 44 a 46): saldos promedio de créditos y deudas del mayor y factor de ajuste anual, como cédula del papel anual | #111 | E | ~380 | MNE-001-306, 850 | accepted-practice (which accounts are créditos / deudas: by role) |
| N16 | Pérdidas fiscales por ejercicio de origen, con su actualización y su vigencia, en vez de una sola cifra | #308 | H | ~300 | 850 | migration |
| N17 | CUFIN y CUCA en cuentas de orden con su actualización, y el ISR de un dividendo decretado (LISR arts. 10, 77, 78 y 140) | new, under #125 | E | ~400 | MNE-001-306, 850 | corpus text first; Could |
| N18 | Recargos y actualización de una contribución pagada fuera de plazo (CFF arts. 17-A y 21), con la tasa en `legal_parameters` | #308 | H | ~220 | MNE-001-306 | source for the yearly rate (not in the corpus) |
| N19 | Decisión: la región fronteriza (IVA al 8 %), ¿entra a la liberación o se niega por escrito? | #603 | DEC | — | — | owner decision; decree validity after 31-12-2026 to read |
| N20 | Las casillas del cierre de mes dicen si la declaración del mes y la DIOT quedaron registradas | #308 | E | ~150 | N7 | Could |

Changes to existing tasks rather than new ones:
- **MNE-001-306** (`inpc import|list|check`): raise from Could to Should and move before 850: without it the INPC engine has no door.
- **MNE-001-854**: first of the route (unblocks 298, 849).
- **MNE-001-850**: add to its acceptance the coefficient of the year as an output (it feeds next year's art. 14), the art. 28-XXX share, and the source of the tax depreciation (N11 or captured).
- **MNE-001-630**: say what happens with a compensation of an IVA balance (LIVA art. 6, tv).
- **MNE-001-362 / 757**: the corpus needs LIVA art. 5 fr. I and IV, LISR 14, 17, 28-XX and 28-XXX before N1–N4 and N9 are planned (rule «la ley se verifica en su fuente», PRD-003 §7).

---

## 5. Counts

| Class | Count | Items |
|---|---|---|
| R | 5 | I-3a / V-3 cash non-deductible IVA; I-3b restaurant split; V-4 withheld IVA month; I-12 `ptu.rate` (854); I-13 ISR del ejercicio (300) |
| S | 16 | I-1 (850), I-2a, I-2b, I-2c, I-4, I-7 (306), I-14, V-6, V-14 (631), D-2, D-3, A-1, A-2, seed sources (§2), corpus `fiscal-mx.md` (362), PTU monthly and distribution (849 + no task) |
| C | 17 | I-2d, I-2e, I-3c, I-3d, I-5, I-6, I-9, V-5, V-7, V-8/9, V-11, V-12, V-13, E-2, E-3, A-3, A-4/A-5/A-6 |
| N | 3 | RESICO PM and every regime other than 601 (MVP.md:9); presenting returns, DIOT and e-accounting in the portal (MVP.md:44); United States taxes beyond what exists (D-03) |

## 6. Top findings

1. **IVA of a non-deductible cash expense is credited** when the fork is answered at ingestion (I-3a). Two doors, two results: the AP door moves the IVA, the ingestion door does not.
2. **The restaurant split does not exist** (I-3b): the default answer `split_85` posts 100 % deductible and credits 100 % of the IVA.
3. **IVA withheld to suppliers is credited a month (or two) early** (V-4): LIVA art. 5 fr. IV is nowhere in code or corpus.
4. **`ptu close` cannot run in any database** (I-12): the `ptu.rate` row is missing; MNE-001-854 is the smallest R on the list.
5. **No ISR of the year, current or deferred** (I-13, I-1): 300 and 850 open; 850 has no plan and needs a migration; nothing computes or even captures the annual tax figures except the three of `ptu close`.
6. **The INPC engine has no door** (I-7): no command, route or script loads the series; MNE-001-306 is «Could».
7. **No monthly tax entry and no tax-payment accounts** (A-1, A-2): the workpaper computes the tax but the ledger never settles it, and a hand-made clearing entry trips the paper's own tie-out.
8. **Withholdings to remit are read by accrual, and ISR withheld to third parties has no paper** (V-6).
9. **The DIOT file refuses mixed-activity and border clients and never fills non-creditable IVA** (D-2, D-3): once N1 and N3 create non-creditable IVA, the file needs those boxes.
10. **Seed rows whose date or article the corpus does not carry** (§2): RLIVA date 2006-12-05, RESICO 113-J rate and paragraph, the 2016 desindexation date; plus law still in constants (IVA rates, day 17, five years, 8.5 %).

## 7. Not reviewed

- No test was executed; every «wrong» is from reading the code path, with the spec that shows the current behaviour cited where one exists.
- `iva-workpaper.ts` beyond its header, settlement, tie-out and figures assembly (lines 403–2430: undo, cheque, credit-note and advance rules) — taken as delivered by their tasks.
- `bank-fee-iva.ts`, `issued-credit-notes.ts`, `received-credit-notes.ts`, `vat-overcredit.ts`, `sale-sources.ts`, `filing-record-command.ts`, `diot/desglose.ts`, `diot/tercero.ts`, `diot/rfc.ts` in detail.
- Payroll taxes (ISR art. 96, subsidy, IMSS, ISN, annual adjustment art. 97), Anexo 24 / e-accounting, annual close and period 13 internals, US taxes: other reviewers.
- The SAT DIOT instructivo, the LISR, LIVA and CFF texts were not opened (no web): every (tv) needs the official text before a task is planned.
- GitHub: only issue #111's body was read; the owner's answers were taken from the backlog's acceptance text. No sensitive issue was opened.
