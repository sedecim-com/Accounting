# 05-nomina — Mexican payroll, social security and its tax duties (US payroll: inventory only)

Reviewer slug `05-nomina`. Read-only review of `origin/develop` at `e9a327d0` (worktree `mplan`), 27 Nov 2026.
`npm run -s plan:status`: 14 of 16 packages green; E4.1 (payroll) 30/30 — its criteria read the source, they do not run a fortnight (docs/SCOPE.md:217).

Sources, in order: the code; `docs/investigacion/2026-09-06-normas-y-motores/{motores/nomina-mx.md,normas/fiscal-mx.md}` (the repo's own study, called «corpus» below); `src/ai/docs/payroll.md`; `legal_parameters` seed and migrations 009, 070, 073, 074, 080, 082, 094, 095, 106, 164, 329, 330; `docs/prd/PRD-003` §4.3 (RF-16…RF-22, RF-47) and D-03, D-09; `docs/cli-command-catalog.md` §payroll rows; issues #92 (comments), #113. Anything marked **(tv)** = «to verify against the official text»: I rely on memory or on the corpus's reading, not on an opened source. No web access was used.

---

## 1. Two fortnights recomputed by hand

Period 1–15 Nov 2026 (15 days), `quincenal`, paid in November 2026, general zone, first year of service, risk class I, no INFONAVIT credit.
Parameters as seeded: UMA 117.31 (073), minimum wage 315.04 (074), ISR monthly tariff 2026 (073) and its derived 15-day tariff (limit = round(monthly ÷ 30.4, 2) × 15), subsidy 15.02 % × 3,566.22 = 535.65/month, cap 11,492.66 (095), worker quotas 0.40/0.25/0.375/0.625/1.125 % (009 + 070), employer quotas 20.40 % UMA, 1.10, 0.70, 1.05, 1.75, 1.00, class I 0.54355 %, retiro 2 %, old-age band table 2026 (330), INFONAVIT 5 %.
Derived 15-day tariff used (lower limit / fixed quota / rate): 3,537.16 / 207.75 / 10.88 % · 8,651.41 / 916.20 / 21.36 %.
Gross and SBC are **typed** inputs in this system (see G10, G11); I typed what an accountant would: SBC = daily wage × 1.0493.

| Concept | A · 1 minimum wage (315.04/day; gross 4,725.60; SBC 330.57) | | B · 25,000/month (gross 12,500.00; SBC 874.42) | |
|---|---|---|---|---|
| | **Code would produce** | **Law, by hand** | **Code would produce** | **Law, by hand** |
| ISR of the tariff | 207.75 + (4,725.60 − 3,537.16) × 10.88 % = **337.05** | 337.05 (tariff) | 916.20 + (12,500 − 8,651.41) × 21.36 % = **1,738.26** | 1,738.26 |
| Subsidy caused | 4,725.60 × 2 = 9,451.20 ≤ cap → 535.65 × 15 / 30.4 = **264.30** | 264.30 | 25,000 > cap → **0.00** | 0.00 |
| ISR withheld | **72.75** | **0.00** — LISR art. 96 ¶1: no withholding for who only earns one minimum wage (corpus fiscal-mx.md:97) | **1,738.26** | 1,738.26 |
| IMSS worker | 12.40 + 18.59 + 30.99 + 55.78 = **117.77** | **0.00** to the worker — LSS art. 36: the employer pays the worker's quota (corpus nomina-mx.md:118, 460) | 31.35 + 32.79 + 49.19 + 81.98 + 147.56 = **342.86** | 342.86 |
| IMSS employer | 358.97 + 0 + 34.71 + 52.06 + 86.77 + 49.59 + 26.95 + old age band «2.51–3.00 UMA» 6.026 % 298.80 + retiro 99.17 = **1,007.03** | 1,007.03 **+ 117.77** absorbed = 1,124.80 | 358.97 + 86.21 + 91.81 + 137.72 + 229.54 + 131.16 + 71.29 + band «4.01 UMA+» 7.513 % 985.43 + 262.33 = **2,354.46** | 2,354.46 |
| INFONAVIT employer 5 % | **247.93** | 247.93 | **655.82** (float, see G24) | 655.82 |
| Net pay | 4,725.60 − 72.75 − 117.77 = **4,535.08** | **4,725.60** | 12,500 − 1,738.26 − 342.86 = **10,418.88** | 10,418.88 |

**Divergence A:** the minimum-wage worker is paid **190.52 less per fortnight** (72.75 ISR + 117.77 IMSS) than the law allows; the employer's IMSS cost is understated by 117.77; the CFDI would declare an ISR withholding and a deduction 001 that should not exist. Neither rule exists anywhere in `src/services/payroll` (grep of `art. 36`, `únicamente perciban`: no hit; `earnsTheMinimumWage` in `isr-exemption.ts` is used only for overtime).
**Divergence B:** none in the arithmetic. Open points that do not move B's figures today: per-branch rounding against the SUA cédula (G24); the risk premium is the class mean, not the employer's own (G04).

---

## 2. Norm list, code against the norm, backlog coverage, class

Class: **R** blocks a release for real use · **S** should be in the release · **C** could wait · **N** out by owner decision. «ok» rows are not gaps.

### 2.1 ISR on wages (LISR Título IV cap. I, RLISR, subsidy decree)

| # | Norm | Code today (file:line) | Verdict | Task | Class |
|---|---|---|---|---|---|
| — | LISR 96 tariff; Anexo 8 RMF 2026 (monthly, and 1/7/10/15-day tables); art. 152 update rule | `mx/isr-calculator.ts:39-87`, `tax-engine/tax-tables.ts:431-446`; seed 073:151-183 (monthly typed, four derived, anchored to DOF figures); tariff chosen by **payment year** (`paymentYear`); 14-day and `semimonthly` refused | correct for 2026 | — | ok |
| G01 | LISR 96 ¶1: no withholding when the worker only earns the minimum wage of the area | absent | **wrong** — case A above: 72.75 withheld | no task | **R** |
| G06 | Tariff, UMA and minimum wage of **2027** | `tax_parameters` MX window closed at 2026-12-31 by 080:153-156 (stated in task 789); `getBrackets` looks up `tax_year = 2027` and finds nothing (`isr-calculator.ts:73`). From 1 Jan 2027 every Mexican paycheck is refused (`TAX_PARAMETERS_MISSING`, «No ISR brackets found»): fail closed, not silently wrong. The 2026 UMA legally rules until 31 Jan 2027 and is unreachable too | **blocked on a date** | 637, 638 (w4, Must, open): their acceptance loads `legal_parameters` rows (`minimum_wage.*`, UMA) that **no calculator reads** — the readers use `tax_parameters.salario_minimo_*`, `uma_daily` and `tax_tables`. 276 (w4) would let the tariff be read by date | **R** |
| — | LISR 93 fr. XIV aguinaldo 30 UMA, prima vacacional 15 UMA; fr. I overtime 50 % up to 5 UMA/week, 100 % at minimum wage; LFT 66 hours limit | `mx/isr-exemption.ts:123-146, 200-235, 359-391`; caps in `legal_parameters` (094, 106, 164); per calendar year, across runs | correct | 062, 063, 110, 633 done | ok |
| G12 | LISR 93 fr. XIV prima dominical (1 UMA per Sunday), PTU (15 UMA); fr. I rest-day work; fr. VIII/IX previsión social and its 7-UMA cap; fr. XI savings fund | only the all-or-nothing flag `is_taxable_isr` typed per line; `isr-exemption.ts:197-199` FIXME(#125) rest-day work taxed whole | partial (over- or under-withholds by what is typed) | no task | S |
| G15 | Subsidy decree DOF 31-12-2025 (15.02 % UMA; ÷30.4 × days; «sin exceder el tope mensual»; cap on monthly income) | amount, dating and the no-cash rule correct (`mx/employment-subsidy.ts`, 095, 329). Not covered: (a) the monthly ceiling across the payments of a month — a weekly schedule with 5 pay dates gives 5 × 123.34 = 616.70 > 535.65 **(tv)**; (b) eligibility compares wage × 2 for a fortnight (`isr-calculator.ts:107-109, 153`) where ×30.4/15 is the other reading — a fortnight of 5,700.00 is eligible one way (11,400.00) and not the other (11,552.00); the code says the question was not decided | partial | no task (674, 675 cover only the pre-fix excess) | S |
| G22 | RLISR 174 optional procedure for a separate payment | refused by name (`separate-payment-isr.ts`) | absent, declared | 784 (w4), corpus 783 | C |
| G08 | LISR 97 annual calculation per worker (art. 152 tariff, exclusions), art. 99 fr. II; the December/February adjustment run | absent (`grep` empty; catalog rows `isr annual-adjustment …` ❌) | absent | **no task** (PRD-003 RF-19 says so) | S — a yearly legal duty that falls due with the release; R if the release claims a full payroll year |
| G20 | LISR 27-XI, 28-XXX: 53 %/47 % of exempt pay is not deductible | exempt amounts are stored per earning (`paycheck_earnings.isr_exempt_amount`) but nothing totals them; `accruals/ptu.ts:49-59` takes the figure typed | absent | none explicit (850 annual ISR paper, w4) | S |
| G29 | LISR 99-III, RMF 2.7.5.1: payroll CFDI on the payment date or within 3–11 business days | no door watches it | absent | 738 (corpus only) | C |

### 2.2 Social security (LSS), INFONAVIT, SAR

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| — | LSS 25, 106, 107, 147, 211, 168 (worker 1.125 %, retiro 2 %), cap 25 UMA, 3-UMA excess; days by calendar month with that month's UMA | `mx/imss-calculator.ts:68-241`, `tax-tables.ts:292-314`; rates 009 + 070 | correct (case B) | 061 done | ok |
| — | LSS 168 fr. II a) employer old-age table 2023–2030 by SBC band | `mx/old-age-band.ts`, migration 330 (64 rows, column sums checked) | correct; two panel keys for the edges | 512, 513, 578 done | ok |
| G02 | LSS 36: the employer pays the worker's quota when the wage is the minimum | absent | **wrong** — case A: 117.77 deducted | no task (corpus lists it as M3 #16) | **R** |
| G04 | LSS 71–74: the risk premium belongs to the **employer registration**, revised each February; class means only at registration | `imss-calculator.ts:44-52`: a rate per **employee** class, default class I when the field is empty; no registration, no dated premium. Seed 009:62 class IV = **0.046325**; the corpus says 4.65325 % (fiscal-mx.md:169, 222) → every class-IV worker under-contributes 0.0207 % of SBC | **wrong** for any employer whose premium is not the class mean; one wrong seed | no task | **R** |
| G03 | INFONAVIT credit amortization (percentage, fixed quota, VSM→UMI), bimonthly days, damage insurance; LFT 97-III 20 % ceiling at minimum wage | `mx/infonavit-calculator.ts:75-85`: `vsm` = general minimum wage × value × days (no UMI; the notice's factor is monthly **(tv)**) — a 15.2 VSM credit gives 315.04 × 15.2 × 15 = 71,829.12 in a fortnight; `pesos` = value × days/30 | **wrong** (`vsm`), approximate (`pesos`), correct (`factor`) | no task | **R** |
| G11 | LSS 27–30, 32: integration of the SBC (factor, exclusions with their caps), floor of one minimum wage (art. 28), bimonthly variable part, dated history | `employees.sbc` is typed (`common/employee-service.ts:92-134`; `updateSalary` :219); `updateSalary` does not touch it; no history; no floor check. The factor exists only for the settlement and the provisions (`mx/finiquito-math.ts`) | absent | no task (catalog `sbc calculate` ❌) | S |
| G10 | LSS 31, LFT 42/58/69–75: absences, disability leave, days actually contributed; séptimo día, Sunday premium, holidays | none: the gross is the sum of typed lines (`paycheck-service.ts:351`, `cli/pay-run-command.ts:60-63`), IMSS always charges every calendar day of the period | absent | **no task** (PRD-003 RF-18, Must) | S |
| G24 | SUA arithmetic: each branch rounded per worker | branches summed unrounded in JS `number`, one rounding of the total (`imss-calculator.ts:113-122`); INFONAVIT in `number` | cent differences against the cédula **(tv)** | no task | C |
| G07 | SUA import layout (workers, movements) | `mx/sua-generator.ts:255-269`: «Simplified SUA layout», 12 fields; the help says «The SUA import file of a month» (`i18n/en.ts:7036`). The month scoping, the split of a straddling week and the cross-check against the liability are sound | **a file the SUA would not import** offered as one (RF-20: a format with no versioned official layout has no command) | no task | **R** |
| G17 | IDSE affiliation movements (alta, baja, wage change) in the official layout, 5 business days | `integrations/imss-idse-adapter.ts:59-148` «simplified layout», REST only, nothing triggers a movement from an employee change; movement codes **(tv)** | absent in substance | no task (D-09 (a) decided it is in scope: MNE-001-541) | S |
| G23 | LSS 39 / INFONAVIT 35 due dates; LISR 96 monthly payment of the ISR withheld | `common/employer-liability-service.ts:221-234` writes IMSS, INFONAVIT (bimonthly) and ISN rows with due date; no row for the ISR withheld | partial | no task | C |

### 2.3 Labour law (LFT)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| — | Art. 76 (2023 reform), 80, 87: vacation table, 25 % premium, 15 days — as floors read from `legal_parameters` (082) | `mx/finiquito-math.ts:118-123`, panel keys `dias_aguinaldo`, `prima_vacacional_pct`; monthly provisions `payroll accrue` (`accruals/provisions-*.ts`) | correct | 374 done | ok |
| — | Art. 162, 485–486 seniority premium (12 days/year, base capped at twice the zone's minimum); LISR 93-XIII (90 UMA/year) and art. 96 USMO rate | `mx/finiquito-calculator.ts`, `mx/separation-isr*.ts`, zone per entity/employee (336) | correct as a quotation | 375, 377, 579 done | ok |
| G09 | Arts. 48–50: constitutional indemnity (3 months), 20 days per year, back wages; the settlement as a run with payslip, entry and CFDI (`SeparacionIndemnizacion`) | no indemnity anywhere (grep empty); `POST /finiquito` only returns figures (risk «lectura»), no CLI leaf; the ISR of the ordinary parts is not computed | absent | **no task** (RF-19, Should) | S |
| G13 | Art. 110 permitted deductions and their ceilings, art. 97 protection of the minimum wage; alimony; FONACOT; union dues | Mexican deductions are typed lines; no ceiling, no check that the net is not negative; alimony refused by name (`common/garnishment-service.ts:294-305`) | absent | 307 (#113, w4, v1.0) covers alimony only; FONACOT and the ceilings: no task | S |
| G16 | Arts. 117–131 PTU: 10 %, base of LISR 9, distribution (50 % days / 50 % wages), the 2021 cap of art. 127-VIII, payment by 30 May | entity-level proposal at close (`accruals/ptu.ts`, `ptu close`) — today it **refuses**: the `ptu.rate` row is not loaded. No per-worker distribution, no PTU run | partial | 854 (rate, w4 Must), 849 (monthly, w4); distribution: **no task** | S |
| G25 | Art. 87 aguinaldo run, vacation ledger (76–81, 516) | provisions accrue; no calculator produces the December line or a vacation balance (catalog rows 🟡/❌) | partial | no task | C |
| G27 | Art. 88 pay frequencies | weekly, quincenal, monthly; 14-day and 10-day refused by name | partial, fail closed | no task | C |

### 2.4 State payroll tax (ISN)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G26 | 32 state treasury laws: rate, base and exclusions differ | `mx/isn-calculator.ts`: **no state is seeded, by design** (067: the table is born empty); the firm loads each rate with its source (`isn rate set`); flat rate only — tiered or exempt-amount regimes are refused by name; base = gross of the run, no state exclusions; state by workplace or fiscal domicile (panel) | sound as far as it goes | none | C |
| G14 | NIF D-3 / RF-47: ISN in expense and liability; wages payable at accrual; each deposit against its liability | ISN lives only in `employer_tax_liabilities`; the run's entry (`common/gl-posting-service.ts:242-322`) carries no ISN line, credits cash on the pay date for the net, and has no wages-payable step | absent | **no task** (RF-47, Should) | S |

### 2.5 Payroll CFDI (CFDI 4.0 + complemento de nómina 1.2, SAT filling guide)

`mx/cfdi-nomina-generator.ts`. One gap, **G05, class R: the voucher does not pass the SAT schema today** (the owner said so on #92, 26 Nov). Its parts:

| Part | Where | Task |
|---|---|---|
| `LugarExpedicion="00000"`, `RegimenFiscal="601"`, `DomicilioFiscalReceptor="00000"`, `RegistroPatronal="B0000000000"` literals | :290-293, :303 | 278 (w3, open) |
| IMSS (001) and INFONAVIT (010) inside `TotalOtrasDeducciones` with no `Deduccion` node; no OtroPago 002 in the ordinary band; `SubTotal`/`ValorUnitario` leave out `TotalOtrosPagos` | :253-255, :288, :313-316 | 279 (w3, open) |
| `Antiguedad` (the schema spells `Antigüedad`); `NumSeguridadSocial=""`; fallback `RiesgoPuesto="01"` (catalogue 1–5, 99); `Deducciones` with no child | :304-308, :313 | **no task** (#92 comment of 19 Nov) |
| `ClaveEntFed="MEX"` literal; receiver name without second surname; generic RFC `XAXX010101000` and CURP fallbacks instead of a refusal; `TotalSueldos` = all earnings | :291-292, :304, :309-310 | **no task** (278 names neither) |
| `TipoPercepcion` defaults to 001 for every line unless typed; no `HorasExtra`, `Incapacidades`, `SeparacionIndemnizacion` nodes; no `SalarioBaseCotApor`/`SalarioDiarioIntegrado` | :275, :304-309 | **no task** |
| `Fecha` hour literal `T10:00:00`; `Folio` length | :287-288 | 768, 770 (w4) |
| No CSD seal; real PAC; cancellation; a stamp the PAC issued and the paycheck lost | — | 296, 534, 767, 766 (w4) |
| No CLI leaf: stamping exists only as `POST /paychecks/:id/cfdi-nomina` | `api/rest/routes/payroll.ts:340` | **no task** (catalog `payslip stamp` 🟡) |
| Done and sound: TipoNomina from the run, PeriodicidadPago, P{n}W weeks, exempt/taxed split read back from the row, stamp-once under a row lock, refusal for an unapproved run, dates in CFDI format | | 277, 551, 720, 735, 736 done |

### 2.6 Journal entry, provisions, lifecycle

| # | Norm / need | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| — | One run, one entry; draft for review by default; exact balance; subsidy in cash by panel key | `common/gl-posting-service.ts` | correct | 069 done | ok |
| G18 | Employee lifecycle from the terminal | CLI has `employee create|list|show` only; termination and wage change are REST only; no door edits SBC, risk class or INFONAVIT credit | absent | no task | S |
| G28 | Reversal and correction of a run | a reversed entry still blocks the run (`gl-posting-service.ts:41-43`); a `correction` run cannot be stamped (`cfdi-nomina-generator.ts:441-445`) | absent, declared | no task (catalog `pay-run reverse` pending) | C |
| G21 | Repair of what earlier defects wrote | censuses and guards planned | — | 740, 773, 674, 675, 721, 722, 737, 764 (w4) | S |
| G30 | Dry run, comments, renames | — | — | 660, 789, 793, 169, 175, 179 (w4) | C |

### 2.7 United States (parked, D-03 — class N, inventory only)

Exists: federal FIT, FICA (SS, Medicare, additional), FUTA (`usa/federal/*`); state SIT/SUTA/SDI calculators registered for 50 states + DC with parameters seeded for five (CA, NY, TX, FL, IL; 009 says «estimated»); three local taxes; forms 940, 941, W-2, W-3, EFW2 (REST only); NACHA file; benefits elections; garnishment engine with the CCPA ceilings and `garnishment record|list|archive` in the CLI. Transmission routes answer 501.
Parked tasks (w4): 275, 276, 327, 339, 354, 514 (official 2026 values), 338, 364, 641, 280–283. Nothing reviewed in depth.
Also N: bank dispersion (D-09: goes to payments); internal renames (D-05).

### 2.8 Sensitive issues (number and one sentence)

- #96: open; its backlog tasks 280–283 are in wave 4.
- #590: open; its backlog task 640 (Must) is in wave 4.
- #591: open; its backlog task 641 is in wave 4.

---

## 3. Count of gaps by class

| Class | Count | Gaps |
|---|---|---|
| R | 7 | G01 ISR at minimum wage · G02 LSS 36 · G03 INFONAVIT credit · G04 risk premium and class IV seed · G05 payroll CFDI fails the schema · G06 2027 parameters · G07 SUA layout |
| S | 13 | G08 annual adjustment · G09 indemnity and settlement run · G10 earnings and incidences · G11 SBC · G12 missing art. 93 exemptions · G13 Mexican deductions and ceilings · G14 ISN and wages payable in the ledger · G15 subsidy monthly ceiling · G16 PTU · G17 IDSE · G18 employee lifecycle in the CLI · G20 non-deductible exempt pay · G21 repairs already planned |
| C | 9 | G22 · G23 · G24 · G25 · G26 · G27 · G28 · G29 · G30 |
| N | 3 | US payroll (D-03) · dispersion (D-09) · renames (D-05) |

Of the 7 R gaps, **5 have no task at all** (G01, G02, G03, G04, G07), G05 is half covered (278, 279 in wave 3; four schema failures and three more parts with no task), and G06 has tasks in wave 4 whose acceptance points at the wrong table.

---

## 4. Proposed new tasks

Lane F unless said. Sizes in hand-written lines (cap 400 per PR). «CP» = touches the critical path of the paycheck (`paycheck-service.ts`). «Panel» = ADR-0006 key with a conservative default.

| # | Title | Issue | Size | Depends on | Needs |
|---|---|---|---|---|---|
| N1 | Quien sólo gana el salario mínimo de su zona no sufre retención de ISR (LISR art. 96, primer párrafo), y el recibo lo dice | #196 | 200 | 633 (zone reader, done) | CP · Panel: what «únicamente» means when the fortnight also carries overtime or a bonus (default: exempt only the minimum-wage part, withhold on the rest) · corpus row with the verbatim text |
| N2 | El patrón absorbe la cuota obrera del IMSS de quien cotiza con el salario mínimo (LSS art. 36): recibo, pasivo, póliza, SUA y CFDI | #296 or new | 300 | N1 (same test for «minimum wage») | CP · no migration |
| N3 | El descuento del crédito INFONAVIT sale de la ley: veces en UMI, cuota fija y porcentaje por los días del bimestre, seguro de daños y tope del art. 97 fr. III LFT | new, under #113 | 350 | — | migration (UMI and insurance as dated `legal_parameters`) · CP · source to open first |
| N4 | La clase IV de riesgo de trabajo de la semilla vale 4.65325 % (LSS art. 73), con el censo de los recibos que la usaron | #127 | 80 | — | data migration · owner approves |
| N5 | La prima de riesgo de trabajo es del registro patronal: su alta con prima fechada (marzo a febrero) y el cálculo la lee; sin prima, se niega | new | 380 | 278 | migration (registration table or columns) · CP · owner decision: one registration per entity or several |
| N6 | Los parámetros de 2027 entran donde el cálculo los lee: la ventana de `tax_parameters` desde el 1 de enero (con la UMA de 2026 hasta el 31) y la tarifa del ISR de 2027 | #953 — **amend 637/638 and move them to wave 3** | 0 new (rewrite of acceptance) | DOF publications | migration · date-bound: before the first payroll of January |
| N7 | El CFDI de nómina entero valida contra `nomina12.xsd`: Antigüedad, NumSeguridadSocial, RiesgoPuesto, ClaveEntFed del centro de trabajo, nombre completo y ningún RFC o CURP genérico | #92 | 280 | 278, 279 | — |
| N8 | CFDI de nómina: la clave SAT de cada percepción sale de su tipo, y los nodos HorasExtra, Incapacidades y SeparacionIndemnizacion existen cuando su clave lo exige | #92 | 350 | N7 | — |
| N9 | `payslip stamp`: el CFDI de nómina se timbra desde la terminal, una vez, con ensayo | #92 / #105 | 300 | N7, 296 | — |
| N10 | `imss sua export` entrega el layout oficial de importación del SUA versionado en el repositorio, o se llama cédula de cotejo y deja de decirse archivo de importación | #92 | 60 (rename) or 2 × 350 (layout) | N5 for the layout | **owner decision** (RF-20) |
| N11 | Movimientos afiliatorios en el layout oficial del IDSE: alta, baja y modificación de salario nacen del cambio del empleado, con su plazo de cinco días hábiles y hoja de CLI | new, from D-09 | 2 × 380 | N13, N17 | migration (movements table) · official layout to version first |
| N12 | Ajuste anual del ISR de sueldos (LISR art. 97) 1/2: el cálculo por trabajador con la tarifa anual y sus exclusiones; 2/2: la corrida que retiene o devuelve la diferencia | new | 2 × 350 | 276, N6 | migration (annual tariff rows) · Panel: December or February |
| N13 | SBC: se calcula con el factor de integración, piso de un salario mínimo y tope de 25 UMA, y se guarda con historial fechado; después, la parte variable bimestral | new | 350 + 300 | — | migration (SBC history) |
| N14 | Incidencias del periodo: faltas e incapacidades con sus días, que reducen sueldo y días cotizados; `pay-run input` | new (RF-18) | 3 × 350 | N13 | migration · CP · owner decision on how far «the system computes the gross» goes for the release |
| N15 | Exenciones del art. 93 que faltan: prima dominical, PTU, descanso trabajado y previsión social con su tope de 7 UMA | #297 | 320 | — | migration (four `legal_parameters` rows) |
| N16 | Liquidación: indemnización de tres meses y veinte días por año (LFT arts. 48 a 50), y el finiquito guardado como corrida final con recibo, póliza y `finiquito calculate|run` | #194 | 2 × 380 | N8 | Panel (integrated wage for the indemnity) |
| N17 | Empleado desde la terminal: baja, cambio de sueldo, de SBC, de clase de riesgo y de crédito INFONAVIT, con motivo y fila de auditoría | #113 | 380 | — | — |
| N18 | Descuentos del recibo mexicano: FONACOT y cuota sindical con su clave, y los topes de los arts. 97 y 110 LFT como parámetros fechados; un neto negativo se niega | #113 (with 307) | 350 | 307 | migration |
| N19 | La póliza de nómina lleva el ISN a gasto y a su pasivo, y los sueldos por pagar al devengarse (RF-47) | #306 | 350 | — | Panel (accrue at period end or at payment; default accrue) |
| N20 | Subsidio al empleo: el tope mensual entre los pagos del mes y la base de elegibilidad de un periodo menor al mes | #600 | 220 | — | Panel · decree text to open first |
| N21 | PTU: reparto por trabajador (LFT arts. 123, 124 y 127 fr. VIII), su corrida y la exención de 15 UMA | #111 | 2 × 350 | 854, N15 | v1.0 scope |
| N22 | Los ingresos exentos pagados y su parte no deducible (LISR art. 28 fr. XXX), por ejercicio, desde los recibos | #111 (lane E) | 200 | — | Panel (53 % or 47 %: whether benefits fell against the prior year) |
| N23 | Las cuotas del IMSS y del INFONAVIT se calculan en Decimal y se redondean por ramo como la cédula del SUA | #601 | 180 | — | CP · Panel if the SUA's rounding cannot be sourced |

Reprioritisation without new tasks: 854 (`ptu.rate`) before the 2026 close; 637/638 (N6) into wave 3; 307 next to N18.

---

## 5. Top findings

1. **A minimum-wage worker is under-paid 190.52 a fortnight** (2026 figures): ISR withheld against LISR art. 96 ¶1 (72.75) and the worker's IMSS quota charged against LSS art. 36 (117.77). No task. (G01, G02)
2. **On 1 January 2027 Mexican payroll stops**: the `tax_parameters` window ends 2026-12-31 and there is no 2027 ISR tariff. It fails closed. The tasks that load 2027 (637, 638) are wave 4 and describe rows in a table the calculators do not read. (G06)
3. **The payroll CFDI does not pass the SAT schema**: 278 and 279 (wave 3) cover the literals and the deduction nodes; four schema failures and the entity-federal key, the receiver's name, the generic RFC/CURP, the overtime/leave/separation nodes have no task; stamping has no CLI leaf. (G05)
4. **INFONAVIT credit in VSM is computed with the minimum wage × factor × days**: a 15.2-VSM credit would deduct 71,829.12 in a fortnight. No task. (G03)
5. **The work-risk premium is a class mean per employee, with class I as the silent fallback**, not the employer registration's premium; and the seeded class IV rate (0.046325) differs from the corpus's 4.65325 %. No task. (G04)
6. **`imss sua export` writes a «simplified» layout** and calls it the SUA import file; the IDSE batch is equally simplified. D-09 put the IDSE in scope; neither has a task. (G07, G17)
7. **The engine does not compute the gross, the SBC or the contributed days**: all three are typed; absences and disability leave do not exist; a wage change does not move the SBC. RF-18 (Must in PRD-003) has no task. (G10, G11)
8. **Year-end duties have no engine**: the annual ISR adjustment (art. 97) has no code and no task; `ptu close` refuses because `ptu.rate` is not loaded (854, wave 4); PTU distribution per worker has no task. (G08, G16)
9. **Settlement is a quotation**: no indemnity (LFT 48–50), no run, payslip, entry or CLI leaf. (G09)
10. **The ledger entry of a run omits the ISN** and books cash on the pay date with no wages payable (RF-47, no task); employee termination and wage change cannot be done from the terminal. (G14, G18)

What holds: the 2026 ISR tariff and its derivation, the dated subsidy and its no-cash rule, IMSS branch rates and the old-age band table, contribution days split by month, one contribution per period across runs, the art. 93 caps for aguinaldo/vacation premium/overtime, the seniority premium and separation ISR, monthly benefit provisions, the atomic run and its one entry.

---

## 6. Not reviewed

- No test was run and no paycheck was calculated against a database: the «code would produce» column is a reading of the calculators with the seeded values.
- No official text was opened (no web): LISR 96 ¶1, LSS 36 and 73, the INFONAVIT VSM/UMI rule, the subsidy's monthly ceiling, the SUA and IDSE layouts and the IDSE movement codes are **(tv)**; the first three are also stated by the repo's corpus.
- US payroll code, the garnishment engine's arithmetic, `ytd-service`, `pay-period-service`, `benefits-service`, the REST routes' authorisation, the i18n catalogues, `payroll-account-mapping-seed` beyond its bucket names, the internals of `employer-liability-service` beyond due dates, `provisions-math` and `ptu.ts` arithmetic, the XSD validator of MNE-001-551, and the tests.
- The monthly return workpapers' treatment of the ISR withheld on wages (another reviewer's domain).
- Issues #96, #590, #591 were not opened beyond their backlog rows.
