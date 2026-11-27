# 09-us-accounting — United States accounting, reporting and taxes outside payroll, and the jurisdiction switch

Reviewer 09 · read-only · a checkout of the repository (origin/develop `e9a327d0`, 27 Nov 2026). Backlog read at `docs/backlog/PRD-001.json` (854 tasks).
No test suite was run. One pure-function probe was run (kept outside the repository and not copied into this folder; no database) to confirm finding G02.

Conventions
- **(tv)** = «to verify against the official source»: my memory of a rule, rate, threshold or form detail that neither the `legal_parameters` seed nor the agent's corpus carries. The source to open is named.
- **Seed** = `legal_parameters` (United States rows: exactly three, all from migration 250). **Research** = `docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-us.md` and `gaap-asc.md`: the repo's own study with a sources table; it is not the agent's corpus and not the seed, so a figure taken from it is still (tv) before it reaches a table.
- **Agent corpus** = `src/ai/docs/*.md`: it has **no** United States document (no ASC, no IRC). `payroll.md` has a few payroll lines.
- Class: R / S / C / N as the addendum defines them.

---

## 1. What a United States entity gets today

`mnemosine entity create "X Inc" --tax-id 12-3456789 --country USA`

| Aspect | What happens (file:line) | Verdict |
|---|---|---|
| Row in `legal_entities` | `COUNTRY_PROFILES.USA` fixes currency USD, standard `us_gaap`, tax id type `ein`, **entity type `corporation` always** (`entity-service.ts:66-75`, `:378-394`). No flag for entity type, standard, state or fiscal-year start (`entity-command.ts:232-242`). `entity_type` CHECK has no S corporation (`001_core_schema.sql:81-82`) | Partial |
| Mexican flags | `--tax-regime 601` and `--minimum-wage-zone` are accepted on a United States entity; the column defaults to `general` (`entity-service.ts:146-167`, `:384-386`) | Leak (C) |
| Chart | `CATALOGO_UNIVERSAL` (Spanish names) + `ESTRATO_FISCAL_NEUTRO`: 1115 bank, **1136 «Impuesto Acreditable sobre Compras»**, 2135 «Impuesto sobre Ventas por Pagar» (`chart-seed.ts:225-229`, `:243-247`). No income tax payable, no income tax expense, no APIC. Deferred tax 1310/2300 exist | Partial; 1136 is wrong (G01) |
| Roles | Mexican fiscal roles removed; `banco`→1115, `iva_trasladado`→2135, `iva_acreditable`→1136 (`account-roles-seed.ts:408-442`, `:459-467`) | See G01 |
| Asset classes | **None seeded** (`entity-accounting.ts:162`); `asset create` needs a category (`asset-service.ts:541-549`) | G04 |
| Policy panel | All 103 keys of `POLICY_CATALOG` are seeded with no jurisdiction filter (`policy-service.ts:85-117`): `rep_*`, `diot_*`, `anexo24_*`, `efirma_*`, `dias_aguinaldo`, `isn_*`. Amount keys are bare numbers (`umbral_anticipado_mxn` 5,000, `cotejo_monto_maximo_auto` 50,000) read as USD | Leak (S) |
| Fiscal calendar | Always January–December plus period 13 «Year-end adjustments», whose contract is the Anexo 24's month 13 (`fiscal-calendar-service.ts:567-604`). `fiscal_year_start_month` has no reader | Partial (S) |
| Year-end close | Result goes to 3300 «Resultado del Ejercicio» by default (`destino_del_resultado_del_ejercicio` = `dos_pasos_hasta_asamblea`, rationale LGSM art. 19, `pending-catalog.ts:1732-1757`) | Mexican default (S) |
| Close checklist | Prints `sat-agrupador-missing` (red, warning by default) with «el catálogo del Anexo 24 de este periodo no se puede armar», plus `rep-parked`, `rep-missing`, `fees-without-withholding` (ISR), `withholding-accounts-layout` as vacuous greens (`period-close.ts:92-112`, `:1272-1288`). No jurisdiction guard on box 7 | Leak (S) |
| Statements | `report balance-sheet|income-statement|trial-balance|general-ledger show`, `cashflow`: no reader of the standard. Balance sheet groups by `fs_category` (current / non-current, so it is already classified) with NIF captions «Contributed capital», «Reserves and retained earnings», group «Earned capital» (`report-command.ts:438-500`, `i18n/en.ts:8979-8993`). Income statement: two sections, Revenue and Expenses, then «Profit (loss) for the period»; no gross profit, no operating income, no income before taxes, no tax line, no comparative column, no statement of equity | Partial (S) |
| `invoice issue` with tax | Tax rate typed per line (`tax-rate=`; help says «IVA RATE … 16 means 16%», `invoice-command.ts:165`). Posts DR 1120 · CR revenue · CR 2135 «Tax - Invoice N» (`ar-ap-posting.ts:136`, `:196-205`). No state, no rate table, no exemption | Liability correct, engine absent (S) |
| Bill with tax | DR expense · **DR 1136 «Creditable IVA - Bill N»** · CR 2110 (`ar-ap-posting.ts:279`, `:334-343`) | **Wrong (G01)** |
| Agent | Prompt says «(Mexico NIF / USA GAAP)» and grounds every treatment in the NIF documents (`system-prompt.ts:36`, `:76-83`); `system.md:4` promises «MX NIF / US GAAP / IFRS per entity» | **Wrong claim (G07)** |
| Engine messages | Validation rules cite NIF in Spanish for every entity (`validation.ts:82`, `:149`, `:184`, `:263`, `:326`, `:337`) | Leak (C) |

### Engines of Mexican law on a United States entity

| Engine | Behaviour | Verdict |
|---|---|---|
| Anexo 24 catalog, trial balance, pólizas | Refuse on `tax_id_type !== 'rfc'` (`catalogo-cuentas.ts:574`, `balanza-service.ts:137`, `polizas-service.ts:129`) | Fails closed (predicate is not the switch: MNE-001-331) |
| DIOT | Refuses, `diot.entity_not_mexican` (`diot-service.ts:161-175`) | Fails closed |
| IVA workpaper | Refuses, `iva_workpaper.entity_without_mexican_iva` (`iva-workpaper.ts:2586-2588`) | Fails closed |
| Provisional ISR workpaper | Refuses, `isr_workpaper.entity_without_mexican_books` (`provisional-income-tax.ts:261-263`) | Fails closed |
| IVA on cash basis, PPD parking, REP expected | `keepsMexicanBooks` false: tax posts straight to the role, no REP expected (`iva-cash-basis.ts:403-421`, `rep-expected.ts:215`) | Correct |
| Cash-payment deductibility (LISR 27-III) | Skipped when `jurisdictionOf().fiscal !== 'MX'` (`cash-deductibility.ts:89`) | Correct |
| Benefit provisions (aguinaldo…) | Only employees with `country_code = 'MX'` (`provisions-run.ts:293`) | Correct |
| Closing FX revaluation | Refuses a functional currency other than MXN as soon as a foreign balance exists (`fx-revaluation.ts:64`, `:398-403`) | Fails closed; ASC 830 absent (G24) |
| **`asset category seed`** | **No guard: seeds the six LISR classes with their art. 34/35 maximum rates and `legal_basis` into a United States entity** (`asset-command.ts:427-440`, `asset-service.ts:176-241`) | **Silently Mexican (G04)** |
| `ptu close` | No jurisdiction guard; a null regime only warns; it then fails on missing roles, not on jurisdiction (`ptu.ts:131-136`) | Fails, wrong reason (S, G13) |
| Close checklist box 7 (agrupador) | No guard (above) | Leak (G13) |
| Fixed-asset tax schedule | `--tax-method` defaults to straight line at the class's LISR rate; `base_depreciacion=tasa_lisr` would post it (`asset-service.ts:571-588`) | Silently Mexican once G04 happens |

---

## 2. Norm list and code against the norm

### 2.1 US GAAP for a small private company

| # | Norm (source to open) | Code today | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| A-1 | ASC 210 classified balance sheet; ASC 505 equity captions (tv, FASB ASC) | Classified by `fs_category`; NIF captions; Spanish account names | Partial | 343; MNE-001-872 (comparatives); 178 (names) | S |
| A-2 | ASC 220/225 income statement and comprehensive income (tv) | Revenue / Expenses / net; OCI account 3600 exists, no statement | Partial | 343; MNE-001-870 | S |
| A-3 | ASC 230 cash flows: indirect method allowed; interest and income taxes paid disclosed (ASC 230-10-50-2, tv) | `cashflow` by account type, indirect by default; no supplemental figures | Partial | 343 (not named) | C |
| A-4 | ASC 205 comparatives: «desirable», not mandatory for a private company (tv) | None | Absent | 343; MNE-001-872 | S |
| A-5 | Statement of changes in stockholders' equity (ASC 505-10-50-2, tv) | None | Absent | MNE-001-871 (NIF B-4); 343 silent | S |
| A-6 | Accrual and cut-off | Periods, soft and hard close, prepaid and deferred-revenue schedules: jurisdiction-neutral | Correct | — | — |
| A-7 | ASC 606 (five steps) at ledger level | `deferred-revenue` schedules; no contract or performance-obligation model | Partial, enough for a ledger | none | C |
| A-8 | ASC 842 leases: lessee dual model (operating: single straight-line cost; finance: interest + amortization); private-company risk-free rate election; short-term exemption (tv) | No lease engine. Sibling draft MNE-001-890 builds the NIF D-5 single model | Absent | MNE-001-890 (NIF only) | C, with a fail-closed sentence asked on N16 |
| A-9 | ASC 360 cost and depreciation over useful life; cost includes non-refundable taxes (tv) | Straight line, declining balance, SYD, units; **sales tax split out to 1136** | Wrong at acquisition (G01) | MNE-001-988 | **R** |
| A-10 | Tax book beside the book schedule: MACRS GDS tables, half-year and mid-quarter conventions, mid-month for real property, section 179, bonus (IRS Pub. 946, tv; research §6) | `MACRS_TABLES` six half-year classes in code (`depreciation-math.ts:308-318`); schedule starts in the in-service month; class never written; one schedule posts | **Wrong (G02, G03)** | 336 (mid-quarter, class); MNE-001-885 (two schedules) | **R** + S |
| A-11 | ASC 326 CECL on trade receivables: lifetime expected losses, aging pool method allowed (tv) | Account 1129 seeded; no engine | Absent | 337; MNE-001-883 | S |
| A-12 | ASC 330 inventory: lower of cost and NRV (FIFO/average); LIFO allowed with the conformity rule IRC 472 (tv) | No cost engine; `lleva_inventarios` routes purchases | Absent | MNE-001-884, MNE-001-893 | C |
| A-13 | ASC 740: current and deferred tax for a C corporation; none at entity level for a pass-through (tv) | No engine, no expense account, no payable account, no classification of the entity | Absent | 334 (current only) | S; deferred C |
| A-14 | ASC 830-20: monetary balances in a foreign currency remeasured at the closing rate through income (tv) | Documents convert at their own rate in any functional currency; the closing run refuses USD | Absent, fails closed | **no task** (MNE-001-112 left it to #124) | S |
| A-15 | ASC 830-30 translation, consolidation | Absent | Absent | none | C |
| A-16 | ASC 250, 855, 235 (changes, subsequent events, notes) | Reversal-only corrections; no notes | Partial | none | C |
| A-17 | Agent corpus for all of the above | None | Absent | 355–360 | S; the false claim is R (G07) |

### 2.2 Taxes outside payroll

| # | Norm (source to open) | Code today | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| T-1 | Sales tax collected is a liability, by state; rate = state + local at destination (state agencies; research §4) | One account 2135, rate typed per line, no state on the invoice | Partial | 333 | S |
| T-2 | Sales tax return figures by state: gross, exempt, taxable, tax collected (state return instructions, tv) | Nothing reads the invoices by state | Absent | 333 is «1/2»; **2/2 was never filed** | S |
| T-3 | Sales tax paid on a purchase is cost, not a credit (ASC 330-10-30, 360-10-30, tv) | Posted to an asset | **Wrong (G01)** | none | **R** |
| T-4 | Use tax accrued by the buyer when the seller did not charge it (state law, tv) | Absent | Absent | none | S (inside MNE-001-996) |
| T-5 | Nexus thresholds (Wayfair; research §4) | Absent; out of a ledger's reach beyond a warning | Absent | 333 names the panel key | C for monitoring |
| T-6 | Form 1099-NEC: threshold (Seed: 600 through 2025, 2,000 from 2026-01-01, mig. 250), cash basis, card payments excluded (IRC 6041, 6041A, 6050W; form instructions) | `generate1099Nec` is correct on those four points (`form-1099-nec.ts:124-150`) | Correct engine, **no caller** (`:57`) | 332 done; PRD-003 D-03 row says the door was left out; **no task** | **R** (G05) |
| T-7 | W-9: name, federal tax classification, TIN (SSN, ITIN or EIN), exempt payee code (Form W-9 instructions, tv) | `vendors.tax_id_type` ∈ rfc, ein, vat (`002:16`); nothing else of the W-9 | **Wrong signal (G06)** | none | **R** |
| T-8 | Backup withholding: rate (Seed: 0.24 from 2018-01-01), withheld on payment when no TIN, deposited and reported on Form 945, box 4 of the 1099 (IRC 3406, tv) | Exposure computed at year end only; nothing withholds, no liability account, no box 4 | Partial | none | S (flag) / C (withholding engine) |
| T-9 | Form 1099-MISC: rents, royalties, other income, attorney proceeds, each with its threshold (form instructions, tv) | Absent; box 1 of the NEC sums every payment whatever its purpose (`form-1099-nec.ts:49-51`) | Absent; NEC overstated for mixed vendors | none | S |
| T-10 | Filing: 31 January for the NEC; Form 1096 on paper; IRIS or FIRE e-file; state copies (tv) | No file, no calendar | Absent | 338 lists payroll forms only | S (date) / C (file) |
| T-11 | Federal corporate income tax: rate (research: 21 %, IRC 11(b), tv); estimates on the 15th of the 4th, 6th, 9th and 12th month (Form 1120-W / IRC 6655, tv) | Absent; no parameter | Absent | 334 (rate); calendar no task | S |
| T-12 | State income or franchise tax as an accrual (state agencies, tv) | Absent | Absent | none; asked as an amendment to 334 | S |
| T-13 | Entity classification decides the forms: 1120, 1120-S, 1065, Schedule C (research §5) | `corporation` always; no federal classification | Absent | **no task**; 334's acceptance needs it | S |
| T-14 | IRC 274 meals 50 %, de minimis safe harbor (research: 2,500 / 5,000, Treas. Reg. 1.263(a)-1(f), tv) | Absent. `umbral_capitalizacion_mxn` 20,000 is read only by CFDI ingestion | Absent | 335 (wrong shape, see edits) | S |
| T-15 | Records retention IRC 6001 (tv) | Mexican horizon | Absent | 342 | S |
| T-16 | Legal parameters for the United States with validity and source | Three rows | Absent | 327 (payroll keys), 328 (command); each engine task seeds its own | S |
| T-17 | Filing with the IRS or a state | Not a product function (`docs/SCOPE.md`: the system does not file with an authority) | — | — | **N** |

---

## 3. Findings with their failing case

**G01 (R) — Sales tax paid to a vendor is booked as a recoverable asset.**
A United States entity records a bill of USD 1,000.00 plus USD 82.50 of sales tax. `postBillEntry` picks role `iva_acreditable` (`ar-ap-posting.ts:279`), which the neutral map points to 1136 (`account-roles-seed.ts:441`): DR 6100 1,000.00 · DR 1136 82.50 «Creditable IVA - Bill …» · CR 2110 1,082.50. Nothing ever credits 1136 for this entity. Correct: DR 6100 1,082.50 · CR 2110 1,082.50. Effect: expenses (or asset cost) understated and current assets overstated by every cent of sales tax paid, in every month. Design `docs/jurisdicciones.md` §3.5 and MNE-001-329 only say «sin IVA y con Sales Tax Payable».

**G02 (R) — MACRS runs from the in-service month, not by tax year.**
`serieMACRS` spreads the first-year percentage over six months starting at `depreciation_start_date`, then each later percentage over twelve (`depreciation-math.ts:332-340`, `armarCalendario` `:436-475`). Probe, cost 10,000.00, 5-year class:

| In service | 2026 by the system | 2026 by the table (20 %) | 2027 system / table |
|---|---|---|---|
| 1 Mar 2026 | 3,066.67 | 2,000.00 | 2,773.33 / 3,200.00 |
| 1 Jul 2026 | 2,000.00 | 2,000.00 | 3,200.00 / 3,200.00 |
| 1 Nov 2026 | 666.67 | 2,000.00 | 3,466.67 / 3,200.00 |

Only an asset placed in service in July of a calendar-year entity matches (tables as in research §6 and IRS Pub. 946 Table A-1, tv). The research note called the tables correct and missed the calendar. Reachable today: `asset create --method macrs` and `--tax-method macrs` (`asset-command.ts:287-288`).

**G03 (R) — Every MACRS asset is a 5-year asset.** Nothing writes `fixed_assets.macrs_class`, and the engine falls back to `'5-year'` (`depreciation-math.ts:321`). Office furniture (7-year class, tv) of 10,000.00 takes 2,000.00 in its first year instead of 1,429.00.

**G04 (R) — The only way a United States entity gets asset classes is the Mexican seed.** `entity create` seeds none; `mnemosine asset category seed` on that entity creates «Equipo de Cómputo (30% — LISR art. 34 …)» and five more, reading `legalParameterAt('MX', …)` (`asset-service.ts:218`). The asset then carries a LISR maximum as its tax rate.

**G05 (R) — Form 1099-NEC cannot be produced.** `generate1099Nec` has one caller, its integration test. No command, no route, no way to mark a form filed.

**G06 (R) — An individual payee is reported as having no TIN.** `vendor create --tax-id 123-45-6789 --tax-id-type ein` is refused (`vendor-service.ts:51`, `:104-110`); there is no `ssn` or `itin` type. The contractor is stored without a tax id, and the engine then reports `tin_missing: true` and a backup-withholding exposure of 24 % of what was paid (USD 12,000.00 paid → 2,880.00), for a payee who did hand in a W-9. With an RFC or VAT on file the row stays `draft` for ever. The form can reach `ready` only for payees with an EIN. Storage of an individual's TIN must follow whatever #96 settles.

**G07 (R) — The agent claims US GAAP and cites NIF.** For an entity with books `us_gaap` the stable prompt still says every accounting treatment «is grounded in the NIF docs … Cite the specific standard ("NIF D-1")» (`system-prompt.ts:76-83`). Failing case: a Delaware entity asks how to record a customer advance; the agent reads `nif-registro` and drafts citing NIF D-1. `keepsMexicanBooks` is already read in the same file (`:208`) for the drafting language only.

**G13 (S) — The close of a United States entity carries Mexican boxes.** `period close --dry-run` lists «Accounts with movement have their SAT grouping code» as incomplete, with all its moved accounts named, every month.

**G14 (S) — No door states what the entity is for federal tax.** Task 334 says «según entity_type (C-corp) … pass-through (S-corp, partnership) no provisiona»; `entity_type` cannot hold an S corporation, an LLC's election is not a type, and the profile writes `corporation` whatever the user wants.

**G24 (S) — A USD entity with a peso or euro receivable cannot close it at the closing rate.** `closing fx revalue` answers `FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED`. The rate sources of the panel are DOF and Banxico FIX (`pending-catalog.ts:1846-1856`).

---

## 4. Is the switch of #123 enough for a United States entity to be safe?

No. After J0.3–J0.6 as written the entity gets its own chart stratum, a filtered panel, its fiscal year and (for payroll) dated parameters. What the plan does not reach:

| Hole | Why the switch misses it | Where it goes |
|---|---|---|
| Purchase tax as an asset | J0.5 names the liability only; the role `iva_acreditable` stays «generic» | MNE-001-988 |
| Asset classes, MACRS | J0.5 seeds the chart, not `asset_categories`; `sembrarCategoriasDeActivo` has no guard | MNE-001-989, U3 |
| Close checklist, `ptu close`, other Mexican commands | J0.3 filters panel keys, not the boxes or commands that read them; 331 moves five predicates only | MNE-001-995 |
| The `books` axis has no reader | `jurisdictionOf().books` is read nowhere outside its module (`grep`): statements, validation messages and the prompt ignore the standard | 343, 360, MNE-001-993 |
| The entity door | RF-11 of PRD-003 asks for standard, currency and start month at creation; 329 and 330 «cover it in part»; nothing adds entity type, federal classification or state | MNE-001-994 |
| `state` is declared and never filled | By design (§6: nexus is a panel key). State income tax and sales-tax registration still need the entity's states | MNE-001-994, 333 |
| Two predicates | `keepsMexicanBooks` and `jurisdictionOf().fiscal` disagree for a third country (first says no, second says MX) and for country US with books `mx_nif`. One consumer reads the second (`cash-deductibility.ts:89`), the rest the first. No door creates either entity today | C; RF-10 of PRD-003 (fail closed for a country without package) |
| Panel uniqueness | Two indexes of migration 017 still forbid an MX answer and a US answer for one key (`policy-service.ts:99-108`): J0.3 needs a migration its acceptance does not name | edit on 324 |
| Amount keys | The design says the value is read in the legal currency with a default per jurisdiction; the acceptances of 324 and 325 do not | edit on 325 |
| The agent's floors | `FLOOR_MAX_AUTO_POST` 50,000 and the reconciliation tolerance ceiling 500 are bare numbers (`src/ai/floor.ts:39`, `:114`); the design puts a floor per jurisdiction in the package; no task | C |

---

## 5. Backlog coverage and class of each gap

| Gap | What | Task | Class |
|---|---|---|---|
| G01 | Purchase sales tax to an asset | MNE-001-988 | R |
| G02 | MACRS by tax year | MNE-001-989 | R |
| G03 | MACRS class never written | MNE-001-989 | R |
| G04 | LISR classes on a US entity; none of its own | MNE-001-990 | R |
| G05 | 1099-NEC without a door | MNE-001-991 | R |
| G06 | Individual TIN cannot be stored; false exposure | MNE-001-991 | R |
| G07 | Agent claims US GAAP, cites NIF | MNE-001-993 | R |
| G08 | United States chart stratum | 329 | S |
| G09 | Panel by jurisdiction; amount keys | 324, 325 | S |
| G10 | Year result destination default | 324 + 329 | S |
| G11 | Fiscal year start month | 330 | S |
| G12 | `tax_id_type !== 'rfc'` predicates | 331 | S |
| G13 | Mexican boxes and commands on a US entity | MNE-001-995 | S |
| G14 | Entity type, federal classification, state, standard at the door | MNE-001-994 | S |
| G15 | Sales tax collected: state, rate as law, nexus key | 333 | S |
| G16 | Sales tax return figures by state; use tax | MNE-001-996 | S |
| G17 | 1099 by purpose; 1099-MISC; backup flag on payment | MNE-001-992 | S |
| G18 | Income tax provision, federal and state | 334 | S |
| G19 | IRC permanent differences | 335 (reshaped) | S |
| G20 | Mid-quarter; tax book beside the book | 336; MNE-001-885 | S |
| G21 | CECL | 337; MNE-001-883 | S |
| G22 | Calendar of non-payroll obligations | 338 (amended) | S |
| G23 | Statements by the entity's standard | 343; MNE-001-870, P12, P13 | S |
| G24 | ASC 830 remeasurement in a USD entity | MNE-001-997 | S |
| G25 | US GAAP corpus | 355–360 | S |
| G26 | Fiscal corpus and `get_legal_parameter` | 361, 364 | S |
| G27 | US legal parameters outside payroll | each engine task; 328 | S |
| G28 | Chart names in the statutory language | 178, 179 | S |
| G29 | Retention horizon | 342 | S |
| G30 | OFX/QFX reader | 340 | S |
| G31 | Authority credentials | 341 | S |
| G32 | ASC 842 leases | — | C |
| G33 | ASC 606 beyond schedules | — | C |
| G34 | Inventory cost, LIFO | — | C |
| G35 | Deferred tax, uncertain positions | — | C |
| G36 | Section 179, bonus, mid-month, 27.5 and 39-year property | — | C |
| G37 | 1096, IRIS/FIRE file, state copies, 1099-K/INT, TIN matching, Form 945 | — | C |
| G38 | Nexus monitoring, marketplace facilitator, local rate tables | — | C |
| G39 | Forms 1120, 1120-S, 1065; M-1 from `us-tax-line` | — | C |
| G40 | Capital by partner (K-1), S corporation pay | — | C |
| G41 | Agent floors per legal currency | — | C |
| G42 | Engine messages cite NIF on a US entity | — | C |
| G43 | 52-53 week and 4-4-5 calendars | — | C |
| G44 | Translation and consolidation | — | C |
| G45 | SAT regime and wage zone accepted on a US entity | — | C |
| G46 | Mixed entity (US + `mx_nif`) and third country | — | C |
| G47 | Cash-flow supplemental figures | — | C |
| G48 | Notes, subsequent events | — | C |
| G49 | Filing with the IRS or a state | — | N (`docs/SCOPE.md`, no filing with an authority) |

Counts: **R 7 · S 24 · C 17 · N 1**.

---

## 6. Proposed new tasks

| Id | Title | Issue | Lane | Size | Depends | Needs |
|---|---|---|---|---|---|---|
| MNE-001-988 | En una entidad de Estados Unidos el impuesto sobre ventas pagado en una compra entra al costo del renglón, no a una cuenta acreditable | #124 | C | 250 | — | critical path (`ar-ap-posting.ts`); census of what is in 1136; no migration |
| MNE-001-989 | MACRS deprecia por ejercicio fiscal con la clase del activo escrita, y se niega sin ella | #124 | E | 250 | — | critical path (posted depreciation); migration no; census of live MACRS assets |
| MNE-001-990 | Una entidad de Estados Unidos nace con sus clases de activo, y asset category seed se niega a sembrarle las de la LISR | #124 | E | 250 | — | accepted practice: default book life per class |
| MNE-001-991 | El 1099-NEC tiene puerta: el proveedor guarda su W-9 con el TIN de una persona física y vendor 1099 genera, lista y marca presentado | #124 | C | 380, two parts | — | migration (vendor W-9 columns, TIN type); storage rule follows #96 |
| MNE-001-992 | Cada pago a un proveedor 1099 lleva su casilla: el NEC sólo suma servicios y el 1099-MISC sale con rentas y otros ingresos | #124 | C | 300 | U4 | migration (box per vendor and per bill line); seed of thresholds |
| MNE-001-993 | El agente dice la verdad sobre una entidad con libros US GAAP mientras su corpus no exista | #131 | G | 150 | — | — |
| MNE-001-994 | La puerta de la entidad de Estados Unidos: tipo, clasificación fiscal federal y estados, en entity create y entity edit | #123 | A | 300 | — | migration |
| MNE-001-995 | El checklist del cierre y los comandos de ley mexicana preguntan la jurisdicción de la entidad | #123 | E | 200 | — | critical path (`period-close.ts`) |
| MNE-001-996 | Sales tax 2/2: las cifras de la declaración por estado, el cliente exento y el use tax devengado | #124 | H | 350, two parts | 333 | migration (state on the invoice); panel key |
| MNE-001-997 | closing fx revalue remide los saldos en moneda extranjera de una entidad con moneda funcional USD | #124 | I | 250 | — (text: MNE-001-862, P5) | critical path; panel key options by jurisdiction |

No new issue: every task hangs on #123, #124 or #131.

## 7. Top findings

1. **G01 (R)** Purchase sales tax goes to an asset account that never clears: every bill with tax misstates expense and assets.
2. **G02–G03 (R)** MACRS gives the table's year only for a July asset, and every asset is 5-year.
3. **G04 (R)** A United States entity has no asset classes; the only seed gives it LISR classes and rates.
4. **G05–G06 (R)** The 1099-NEC engine has no door, cannot hold an individual's TIN, and reports such a payee as owing backup withholding.
5. **G07 (R)** The agent says US GAAP and grounds its drafts in NIF; there is no United States document in its corpus.
6. **Switch (S)** #123 as planned leaves the `books` axis without a reader and does not reach asset classes, purchase tax, the close checklist or the entity door.
7. **G14 (S)** No federal tax classification: 334 (provision only for a C corporation) cannot be built as written.
8. **G16 (S)** Sales tax is «1/2» with no «2/2»: the liability exists, the return's figures by state do not.
9. **G24 (S)** ASC 830 remeasurement has no task since MNE-001-112 shipped pesos only.
10. **Seed (S)** The United States has three rows of law outside payroll; every engine task must seed its own with source.

## 8. Not reviewed

- Payroll (FIT, FICA, FUTA, SUTA, W-2, 941/940, NACHA, garnishments): reviewer 08's domain; tasks 275, 276, 327, 338 (payroll part), 339, 354, 514, 641 only read.
- Bank readers (340), credentials (341), retention mechanics (342): read as backlog entries only.
- REST routes for a United States entity, the web board, the `init` wizard screens.
- No command was run against a database: every behaviour above is read from code, except the MACRS probe.
- No official source was opened. Every figure not in the seed is (tv).
- The 2026 threshold row of migration 250 cites a bill text as its source; whether the enacted section and its indexing match was not checked (tv, IRS instructions for Form 1099-NEC, 2026 revision).
- The panel already has a `manual` option for `fuente_tipo_cambio`; MNE-001-997 uses it as the United States default instead of a new option.
