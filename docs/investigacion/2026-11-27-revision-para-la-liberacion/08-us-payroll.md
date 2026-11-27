# 08-us-payroll — United States payroll and payroll taxes

Read-only review at develop `e9a327d0` (27 Nov 2026). Scope: `src/services/payroll/usa/**`, `tax-engine/**`, the United States branch of `common/paycheck-service.ts`, `common/gl-posting-service.ts`, `common/employer-liability-service.ts`, `common/garnishment-service.ts`, migrations 008, 009 and 080, the payroll REST routes and CLI leaves, and the backlog tasks 275, 276, 327, 338, 339, 354, 364, 514.

**Sources.** First the code and the seed. For rule figures, the repo's own research `docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-us.md` (cited «research §n [Fnn]», with the official source it names). That research was written against an older commit: every code statement below was re-read at `e9a327d0`. A figure the research itself could not open, or that comes from my memory, is marked «(to verify against the official source)» with the source named. No web access was used.

**Classes.** R = wrong figure or rejected form in what the code does or claims today, or a duty a small payroll cannot skip; S = named by the parked tasks or needed for them to be coherent; C = beyond that (listed, not filed); N = out by an owner decision.

---

## 1. Two paychecks recomputed by hand

Seeded values: `009_tax_tables_2026.sql` (the only United States rows in the repository; window 1 Jan to 31 Dec 2026 by `080:153-156`). Rule values: research §2.1 and §2.2 (IRS Pub 15-T 2026 Worksheet 1A [F4], SSA 2026 wage base [F1]).

### Case A — single, paid biweekly 2,000.00, Form W-4 of 2020 or later with no entries, works in California

| Component | Code with the seed | Rule | Difference |
|---|---|---|---|
| Federal income tax | 2,000 × 26 = 52,000; seeded bracket 17,400–52,350: 1,110 + 12 % × 34,600 = 5,262.00; ÷ 26 = **202.38** (`fit-calculator.ts:70-92`) | 52,000 − 8,600 (line 1g) = 43,400; 2026 table 19,900–57,900: 1,240 + 12 % × 23,500 = 4,060.00; ÷ 26 = **156.15** | +46.23 a period, +1,202 a year over-withheld. Two causes: line 1g is never subtracted, and the seeded brackets are not the 2026 ones (0 % band 6,300 against 7,500). |
| Same, Step 2 box ticked | **202.38** (the box is never read: `fit-calculator.ts:72`) | line 1g = 0; checkbox table 33,250–60,900: 2,900 + 22 % × 18,750 = 7,025.00; ÷ 26 = **270.19** | −67.81 a period under-withheld |
| Social Security | 124.00 | 124.00 | none |
| Medicare | 29.00 | 29.00 | none |
| FUTA (employer) | 12.00, 12.00, 12.00, 6.00, then 0 = 42.00 a year at 0.6 % (`futa-calculator.ts:21`) | 42.00, plus the credit reduction of the state when it has one (California 1.2 % for 2025: research §2.3 [F9]; the 2026 list is to verify against the US DOL notice) | none without credit reduction; 84.00 a year missing with 1.2 % |
| California income tax | 52,000 on the seeded income-tax schedule, no standard deduction, no exemption credit: 1,091.50 + 6.6 % × 11,755 = 1,867.33; ÷ 26 = **71.82** (`state-tax-calculator.ts:60-80`) | EDD Method B subtracts a standard deduction and an exemption allowance credit from the DE 4 (to verify against EDD publication DE 44) | over-withheld; the rule figure is not in the repository |
| California SDI | 1.1 % × 2,000 = **22.00** (`009:73`) | 1.3 % × 2,000 = **26.00** (research §3.3 [F62]) | −4.00 a period |

### Case B — single, paid biweekly 8,000.00 (208,000 a year), paycheck 22 of 26, year-to-date 168,000.00

| Component | Code with the seed | Rule | Difference |
|---|---|---|---|
| Social Security, paycheck 22 | base 168,600 (`009:15`): 600 taxable, **37.20**; paychecks 23 to 26: 0 | base 184,500: 8,000 taxable, **496.00**; paycheck 23: 496.00; paycheck 24: 500 taxable, 31.00 | year: 10,453.20 against 11,439.00. 985.80 not withheld from the worker and 985.80 not accrued by the employer |
| Additional Medicare | year-to-date reaches 200,000 after paycheck 25; paycheck 26: 8,000 × 0.9 % = 72.00 (`fica-calculator.ts:65-78`) | same (employer threshold 200,000 whatever the filing status: research §2.2) | none |
| Federal income tax | 208,000; seeded bracket 197,300–250,700: 39,072 + 32 % × 10,700 = 42,496; ÷ 26 = **1,634.46** | 208,000 − 8,600 = 199,400; 113,200–209,275: 17,966 + 24 % × 86,200 = 38,654; ÷ 26 = **1,486.69** | +147.77 a period |
| W-2 box 3 and box 4 | box 3 = min(208,000; 183,600) = **183,600.00** from a third literal (`w2-generator.ts:119-121`); box 4 = **10,453.20** | box 3 = 184,500.00; box 4 = 11,439.00 | the form contradicts itself: 183,600 × 6.2 % = 11,383.20 |
| Form 941, fourth quarter (7 paychecks, 56,000) | line 5a column 1 = **56,000.00**, the uncapped sum (`form-941-generator.ts:55`); column 2 = tax actually computed = 16,600 × 12.4 % = 2,058.40 | column 1 = the wages subject to the tax; column 2 = column 1 × 0.124 | 56,000 × 0.124 = 6,944.00 ≠ 2,058.40: the line does not foot |
| Form 940 | line 7 «taxable FUTA wages» = **208,000.00**, line 5 = 0.00, line 8 = 42.00 (`form-940-generator.ts:39-40, :72, :83`) | line 5 = 201,000.00, line 7 = 7,000.00, line 8 = 42.00 | line 8 ≠ line 7 × 0.006 |

Where the code and the rule agree: Social Security and Medicare rates, the cap arithmetic (`ytd-service.ts:173-180`), the Additional Medicare threshold, the FICA base keeping 401(k) deferrals in (`paycheck-service.ts:364-368`), the tax year of a period taken from its pay date (`pay-period-service.ts:119`).

---

## 2. Norms, the code against them, backlog coverage, class

Task state is `docs/backlog/PRD-001.json` as history 15 left it; after the owner's third message every open task is in wave 3.

### 2.1 Federal income tax withholding (IRC §3402; Form W-4; IRS Pub 15-T, Pub 15 §7)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G01 | Pub 15-T Worksheet 1A line 1g: subtract 8,600 (12,900 married jointly) unless the Step 2 box is ticked (research §2.1 [F4]) | `fit-calculator.ts:70-79` annualizes, adds 4(a), subtracts 4(b); no line 1g | wrong (case A) | none (#662 says «its own issue») | R |
| G02 | Step 2 checkbox: its own rate schedules and line 1g = 0 | `multiple_jobs_box` declared (`tax-engine.interface.ts:34`), read nowhere; comment «no adjustment» (`fit-calculator.ts:72`); no checkbox rows seeded | wrong (case A, −67.81) | none | R |
| G03 | The 2026 percentage-method tables | `009:113-144` «2026 est.»: 0 % band 6,300 / 16,300 / 13,850 against 7,500 / 19,300 / 15,550 (research §2.1) | wrong | 514 (Could) | R |
| G04 | Single and married filing separately share one table | no `married_separately` rows; refused by `requireBrackets` (`tax-tables.ts:97-110`) | refused, not wrong | 354 (Could) | S |
| G05 | Supplemental wages (Pub 15 §7): flat 22 % or the aggregate procedure; 37 % on the excess over 1,000,000 of year-to-date supplemental wages | the flat branch exists (`fit-calculator.ts:44-56`) and is unreachable: `paycheck-service.ts:463` never passes `is_supplemental`; a bonus in its own run is annualized as if it were the regular wage: 3,000 gives 421.04, flat would be 660.00; the 37 % applies to the whole payment and is triggered by total year-to-date wages (`:45-46`) | wrong | none | R |
| G06 | A W-4 claiming exemption withholds no income tax; the claim expires each February (to verify against the Form W-4 instructions) | `employees.is_exempt_fit` and `is_exempt_fica` (`008:58-59`) have no reader | wrong for an exempt worker | none | R (with G01) |
| G07 | The W-4 as data | `w4_data` is a free JSON record (`routes/payroll.ts:98`): a misspelt key (`dependents` for `dependents_amount`) is ignored in silence; only an unknown `filing_status` throws (`fit-calculator.ts:24-31`) | partial | none | S |
| G08 | W-4 of 2019 or earlier (allowances × 4,300, no head-of-household table: research §2.1) | absent; such a worker is computed as a 2020 form | wrong if such a form is loaded | none | S (refuse by name) |
| G09 | Tables chosen by the pay date | `getBrackets` filters by `tax_year` only (`tax-tables.ts:64-72`) | partial | 276 (Should) | S |
| G10 | Nonresident alien additional amounts, Pub 15-T wage-bracket and other methods, daily and quarterly periods | absent | absent | none | C |

### 2.2 Social Security and Medicare (IRC §§3101, 3111, 3121)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G11 | Wage base of the year: 184,500 for 2026 (research §2.2 [F1]; issue #91 and task 275 say the same) | seed 168,600 (`009:15`, the 2024 figure by #91), literal fallbacks 168,600 (`fica-calculator.ts:18, :99`), third literal 183,600 in the W-2 (`w2-generator.ts:119`) | wrong (case B) | 275 (Could), 327 (Must) | R |
| G12 | Rates 6.2 % / 1.45 % / 0.9 % over 200,000 | correct; six keys read with a literal fallback (`fica-calculator.ts:19, :42, :63, :65, :100, :119`) | correct, fallback open | 514 | S |
| G13 | FICA base: §125 and HSA through a cafeteria plan are out, elective deferrals are in | `paycheck-service.ts:364-366` keeps in only `deduction_type` '401k' and 'roth_401k'; 403(b), 457(b) or SIMPLE flagged pre-tax would leave the base; `is_pre_tax` is whatever the caller sends | partial | none | S (with G40) |
| G14 | Annual caps count every wage paid in the year | `getEmployeeYtd` reads `pp.pay_date < $3` (`ytd-service.ts:108`): two runs with the same pay date (the regular run and a bonus run) do not see each other. Year-to-date FUTA wages 6,000, regular 2,000 and bonus 5,000 the same day: FUTA wages 1,000 + 1,000, tax 12.00 against 6.00. Same for the Social Security base, the SUTA base and the 200,000 threshold. A `calculated` run nobody approved counts for ever (`:107`) | wrong | none | R |

### 2.3 FUTA (IRC §§3301–3302; Form 940 and Schedule A)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G15 | 6.0 % on the first 7,000, credit up to 5.4 % | always the net 0.6 % (`futa-calculator.ts:21`); `futa_rate_gross` seeded, unread | correct only with full credit | 327 | S |
| G16 | Credit reduction (IRC §3302(c)(2)); California 1.2 % for 2025 (research §2.3 [F9]) | unknown to the engine and to the form | wrong for a credit-reduction state; California is one of the five seeded | none | R |
| G17 | Form 940 lines 4, 5, 7, 9–11, Schedule A for multi-state or credit reduction | line 7 is the uncapped sum, line 5 is gross minus that, line 4 fixed 0 (`form-940-generator.ts:39-40, :72, :81-83`); no Schedule A; deposits read a table nobody writes for the United States | wrong (case B) | none | R |
| G18 | Quarterly deposit when the accumulated tax passes 500; due 31 January | absent | absent | 338 (Could) | S |

### 2.4 State income tax, unemployment, disability (D-03 (a): five states, the rest refused)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G19 | D-03 (a): only seeded states, the rest refused by name (RF-22) | 50 states and DC registered (`register-all.ts:44-55`); seeded CA, NY, IL, TX, FL. An unseeded state stops the run with `TAX_PARAMETERS_MISSING` naming the jurisdiction (`tax-tables.ts:202`) | meets D-03 (a) | — | N (D-03) |
| G20 | California: EDD Method B with the DE 4 (to verify against DE 44); New York: NYS-50-T-NYS with the IT-2104 (to verify) | the seeded rows are income-tax schedules (`009:197`, `:212` «abbreviated»), `single` only, no standard deduction, no allowances, no state certificate; any other filing status is refused; the federal W-4 status is reused (`state-tax-calculator.ts:60-66`) | wrong (case A) | 514 covers the values, nobody the method | R |
| G21 | Illinois: 4.95 % less the exemptions of the IL-W-4 | one exemption of 2,775 always (`state-tax-calculator.ts:38-52`; `009:102`) | partial | 514 (value) | S |
| G22 | New York disability: 0.5 % capped at 0.60 a week (to verify against NY WCL §209); paid family leave with an annual cap | 0.5 % uncapped: 2,000 biweekly gives 10.00 against 1.20 (`state-tax-calculator.ts:132-137`); `sdi_weekly_max`, `pfl_rate`, `pfl_annual_cap` seeded and unread (`009:86-90`) | wrong | none (#662 «its own issue») | R |
| G23 | California SDI 1.3 % in 2026, no wage cap (research §3.3 [F62]) | 1.1 % (`009:73`) | wrong | 514 | R |
| G24 | SUTA at the rate the state assigned to the employer; bases of 2026 (New York 17,600: research §3.2 [F61]) | `experience_rate` exists in the input and nobody passes it (`paycheck-service.ts:524`); always the seeded default; fallback 7,000 / 2.7 % (`state-tax-calculator.ts:99-100`); New York 12,800; California ETT seeded and unread | wrong for any employer with an assigned rate | 514 (bases, fallback); the rate: none | S |
| G25 | SUTA year-to-date by state | summed by the worker's current `work_state` (`ytd-service.ts:153-166`): a move re-labels the past | partial | none | C |
| G26 | Local taxes (New York City, Yonkers, Philadelphia) | four localities registered, none seeded; the city is the first three letters of a free-text `work_city` (`paycheck-service.ts:541`): «New York» matches nothing and withholds 0.00 in silence, «NYC» stops with `TAX_PARAMETERS_MISSING`; «resident» compares states, not cities (`local-tax-calculator.ts:34`) | silent zero in a seeded state | none | S (refuse by name) |
| G27 | Reciprocity, state treatment of 401(k), employee SUTA (AK, NJ, PA), paid-leave programmes of other states | absent | absent | none | C / N (D-03) |

### 2.5 Deductions and benefits (IRC §§125, 223, 401(k), 402(g))

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G28 | Elections produce the deduction of each paycheck | `calculateBenefitsForPaycheck` has no caller (`benefits-service.ts:104`); a paycheck carries only the deductions of the inputs file | absent | none | S |
| G29 | Annual limits (2026: 401(k) 24,500 and catch-up 8,000; HSA 4,400 / 8,750; health FSA 3,400: research §2.6 [F25–F28]) | three sources that disagree: `009:26-30` (23,500 / 7,500 / 4,400 / 8,750 / 3,300, unread), `benefits-service.ts:204` (23,500 / 4,300 / 3,200 / 5,000, called only by a spec), the header comment (`:9-10`); the run accepts any amount | absent | 514 (drops or sources the unread keys) | S |
| G30 | Employer contributions are an expense and a liability | lines with `is_employer_contribution` are left out of the totals (`paycheck-service.ts:353-358`) and of the entry (`gl-posting-service.ts:199-218`) | absent | none | S |
| G31 | Group-term life over 50,000, transit, adoption, dependent care 7,500 | absent | absent | none | C |

### 2.6 Garnishments (CCPA Title III, 15 U.S.C. §1673; 29 CFR 870; IRC §6334; Pub 1494)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G32 | Ordinary creditor: the lesser of 25 % of disposable earnings and the excess over 30 × the federal minimum wage | correct, weekly equivalents right for the four frequencies (`garnishment-engine.ts:45-52, :259-261`); 7.25 is a constant (`:39`) | correct, constant | 327 (Must) | S |
| G33 | A support order counts against the 25 %: when support takes 25 % or more, an ordinary creditor takes nothing (to verify against 29 CFR 870.11 and DOL Fact Sheet 30) | the creditor ceiling subtracts only what is withheld outside support (`:293`). Weekly disposable 1,000.00, support 40 % and a creditor order of 300.00: withholds 400.00 + 250.00 = **650.00**; the rule gives 400.00 + 0.00 | wrong | none | R |
| G34 | Student-loan administrative garnishment: 15 % (research §2.7 [F37]) and never below 30 × the minimum wage [F38] | 15 % for each order with no shared ceiling and no floor (`:296-303`) | wrong with two orders or low pay | none | S (with G33) |
| G35 | An order stops at the amount owed | `total_owed`, `max_withholding_pct` and `end_date` decide nothing (`garnishment-service.ts:57-68`); only `is_active` | absent | none | S (with G33) |
| G36 | Support ceilings 50/55/60/65 %, levy exemption required, precedence by statute, CLI | correct: `:54-57`, `garnishment-service.ts:397-424`, `RANK` (`:168-176`), `garnishment record|list|archive` | correct | — | — |
| G37 | Stricter state limits, a levy against an earlier support order, the Pub 1494 table by year, remittance to the state unit | absent | absent | none | C |

### 2.7 Forms and deposits (Forms 941, 940, W-2, W-3; SSA EFW2; Pub 15 §11)

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G38 | Form 941: line 1 counts the workers of the pay period that includes the 12th of the quarter's last month; lines 5a–5d are taxable wages × rate; line 7 adjusts fractions of cents; line 16 or Schedule B gives the liability by date (to verify against the Form 941 instructions) | line 1 counts every worker of the quarter (`form-941-generator.ts:52`); 5a and 5c are the same uncapped sum (`:55, :58`); 5d takes the whole paycheck that crossed 200,000 (`:61`); column 2 is the tax computed, not wages × rate; no line 7, no line 16, no Schedule B; each call inserts another `ready` filing (`:114-118`) | wrong (case B) | none | R |
| G39 | The employer's liability is recorded with its deposit date; deposits made feed line 13 | `employer-liability-service.ts:513, :601, :672` writes Mexican rows only; no United States row exists, so line 13 is always 0.00 and line 14 is the whole tax. The agent's corpus says the employer side accrues on approval «one row per tax» (`src/ai/docs/payroll.md:36`) | wrong | 338 lists a calendar; nobody writes the rows | R |
| G40 | W-2 boxes: 12 code W is employer plus employee HSA through the plan, AA Roth, DD total cost of coverage, box 13, boxes 15–20 only where there is a state or local tax (research §2.5 [F15]) | W takes the employee side only (`w2-generator.ts:103`); DD the employer side only (`:104`); no AA, no box 13; box 18 repeats the state wages with no local tax (`:107`); Texas and Florida get box 16 wages | wrong boxes | none | R |
| G41 | New for tax year 2026: codes TP, TT, TA and box 14b (research §2.5 [F29–F31]; to verify against the 2026 General Instructions for Forms W-2 and W-3) | absent; no overtime premium kept apart | absent | 339 lacks it | S |
| G42 | W-3 is the sum of the W-2s sent | sums the stored `w2` filings (`w3-generator.ts:51-68`), does not check that every paid worker has one; its totals depend on MNE-001-641 | partial | 641 (number only) | R (with G40) |
| G43 | EFW2 (SSA Pub 42-007): records RA, RE, RW, RO, RS, RT, RU, RF at fixed positions | «Simplified» by its own comment (`w3-generator.ts:108-110`); the RW money fields start at column 145 where the specification puts 188 (research §2.5; the SSA text could not be opened: to verify); RA and RE lack required fields; no RS | a file the SSA would reject, and the corpus says it is produced (`payroll.md:20`) | none | R |
| G44 | Deposit schedule: lookback, monthly or semiweekly, the 100,000 next-day rule, under 2,500 with the return; due dates of 941, 940, W-2 (research §2.4) | absent | absent | 338 (Could) | S |
| G45 | One door per form | 941, 940, W-2, W-3, EFW2, benefits and NACHA are REST only (`routes/payroll.ts:389-437`); the catalog rows `w2 prepare`, `w2 reconcile`, `w3 prepare`, `efw2 generate` are not built; CLI exists for `employee`, `pay-schedule`, `pay-period`, `pay-run create|calculate|approve|post`, `payslip`, `garnishment`, `tax-deposit list` | REST only | none (RF-21 asks for a leaf or a withdrawal) | S |
| G46 | W-2 against the four 941s of the year | absent (catalog row `w2 reconcile`) | absent | none | S (with G40) |
| G47 | 1099-NEC | not produced by payroll; MNE-001-332 (done) builds it from payables | other reviewer | 332 | — |
| G48 | Forms 941-X, W-2c, 944, 943, 945, state quarterly wage reports, new-hire reporting, delivery of the W-2 to the worker, ACA forms, electronic filing | absent; the transmission routes answer 501 | absent | none | C |
| G49 | Tests | no spec runs the 941, 940, W-2, W-3, EFW2, the income-tax calculator, the state or the local calculators beyond the empty-table and scope specs | absent | each task carries its own | S |

### 2.8 The journal entry, pay frequency, NACHA

| # | Norm | Code today | Verdict | Task | Class |
|---|---|---|---|---|---|
| G50 | Entry of a United States run | gross to wages, employer taxes to payroll tax expense, net to cash, one payable per tax family (`gl-posting-service.ts:242-277`, `US_BUCKET_MAP`); balanced or refused (`:338-349`); draft for review by default | correct for wages and taxes | — | — |
| G51 | Payables by nature | every pre-tax deduction goes to one account (2157) and every post-tax deduction, garnishments included, to another (2156) (`:324-331`) | partial | none | S (with G30) |
| G52 | Wages earned and unpaid at period end, compensated absences (ASC 710) | the entry is dated on the pay date; no accrual for the United States | absent | none | C |
| G53 | Pay frequencies | 52 / 26 / 24 / 12 (`tax-tables.ts:451-460`): correct for the four | correct | — | — |
| G54 | NACHA file | by my count of the field widths the five record types are 94 columns and the hash and totals follow the layout (the Nacha rules could not be opened: research §2.10; to verify). Workers with no usable bank data are skipped in silence (`nacha-generator.ts:175-180`); a routing number is padded or cut with no check digit test (`:183`); destination name fixed «BANK» (`:144`); REST only | D-09: the dispersion belongs to payments, not to payroll | 737 (one batch per run) | N (D-09); the silent skip is S through 737 |
| G55 | The year after 2026 | every United States window ends on 31 Dec 2026: from 1 Jan 2027 each United States paycheck is refused | refusal, by design | 514 lacks 2027 | S |

### 2.9 Sensitive issues (number and one sentence)

- #96: open; its backlog tasks 280–283 are open.
- #591: open; its backlog task 641 is open.

---

## 3. Count of gaps by class

| Class | Gaps | Ids |
|---|---|---|
| R | 18 | G01, G02, G03, G05, G06, G11, G14, G16, G17, G20, G22, G23, G33, G38, G39, G40, G42, G43 |
| S | 24 | G04, G07, G08, G09, G12, G13, G15, G18, G21, G24, G26, G28, G29, G30, G32, G34, G35, G41, G44, G45, G46, G49, G51, G55 |
| C | 7 | G10, G25, G27, G31, G37, G48, G52 |
| N | 2 | G19 (D-03 (a)), G54 (D-09) |

R covered by an existing task: G03 and G23 (514), G11 (275 and 327). R with no task: the other fifteen.

---

## 4. Proposed new tasks (12)

All lane F, wave 3, requirement RF-05. Sizes are the first part's hand-written lines.

| Temp id | Title (Spanish, as filed) | Gaps | Class | Issue | Size | Depends on | Notes |
|---|---|---|---|---|---|---|---|
| MNE-001-976 | El impuesto federal de un recibo de EE. UU. sigue la hoja 1A de la Pub 15-T: línea 1g, casilla del paso 2 y W-4 validado | G01, G02, G06, G07, G08 | R | #91 | 300 | 327; after 514 | migration (checkbox rows); 2 parts |
| MNE-001-977 | Un pago suplementario de EE. UU. retiene por el método que el panel eligió | G05 | R | #91 | 250 | U1 | panel key `us_supplemental_wage_method`, default `aggregate` |
| MNE-001-978 | Los topes anuales de EE. UU. cuentan todo lo pagado hasta la fecha de pago, también la otra corrida del mismo día | G14 | R | #91 | 180 | — | no migration |
| MNE-001-979 | Al aprobar una corrida de EE. UU. se apunta el pasivo federal, FUTA y estatal con su fecha de depósito, y el depósito se registra | G39 | R | #1084 | 350 | — | panel key `us_federal_deposit_schedule`, default `semiweekly`; 2 parts |
| MNE-001-980 | La forma 941 cuadra renglón por renglón con sus instrucciones | G38 | R | #1084 | 350 | U4, U3 | 2 parts; CLI leaf |
| MNE-001-981 | La forma 940 separa lo exento y lo que pasa de 7,000, y el FUTA conoce la reducción de crédito | G16, G17 | R | #1084 | 300 | U4, 327 | panel key for the accrual; 2 parts |
| MNE-001-982 | El W-2 llena sus casillas 12 a 20 como dicen sus instrucciones y el W-3 se niega si no cuadra | G40, G42, G46 | R | #1084 | 350 | 327; after 275, 641, 282 | 2 parts; CLI leaves |
| MNE-001-983 | El archivo EFW2 se niega hasta seguir la especificación de la SSA, y el corpus dice lo que la nómina de EE. UU. hace hoy | G43 | R | #1084 | 150 | —; part 2 after U7 | 2 parts |
| MNE-001-984 | Un acreedor ordinario no cobra por encima de la pensión alimenticia, y una orden se detiene en lo que se debe | G33, G34, G35 | R | #127 | 300 | 327 | 2 parts |
| MNE-001-985 | California y Nueva York retienen por el método de su agencia, con su certificado, y el SDI de Nueva York respeta su tope | G20, G21, G22, G26 | R | #662 | 400 | 327; after 514 | migration; 3 parts |
| MNE-001-986 | La tasa de SUTA es la que el estado asignó al patrón, por entidad, estado y año | G24 | S | #662 | 220 | 327 | migration likely |
| MNE-001-987 | Las elecciones de prestaciones llegan al recibo con su límite anual, y la aportación del patrón llega a la póliza | G13, G28, G29, G30, G51 | S | #124 | 400 | 327 | 3 parts |

One new issue proposed, **#1084** «US payroll: forms 941, 940, W-2/W-3 and EFW2 follow their instructions, and the employer liability is recorded» (U4 to U8): none of #91 (withholding), #127 (tranche T20: paths that invent or stay silent), #662 (seed values) or #124 (new capabilities) holds five form defects coherently.

---

## 5. Top findings

1. **Federal income tax is over-withheld on every paycheck.** Line 1g of the Pub 15-T worksheet is never subtracted and the seeded 2026 brackets are estimates: 202.38 against 156.15 on 2,000 biweekly (G01, G03). No task covers the method.
2. **The Social Security wage base has three values and none is the 2026 one**: 168,600 in the seed, 183,600 in the W-2, 184,500 in the repo's own research and in task 275. A worker at 208,000 is under-withheld 985.80 and gets a W-2 whose box 4 is not 6.2 % of box 3 (G11). Task 275 is filed as «Could».
3. **Forms 941 and 940 do not foot.** Line 5a carries uncapped wages, line 7 of the 940 carries every dollar instead of the first 7,000, and deposits are always zero because no United States liability row is ever written (G17, G38, G39).
4. **The EFW2 file is not the SSA layout**, by the file's own comment and by the position of its money fields, while the agent's corpus says it is produced (G43).
5. **A creditor garnishment is taken on top of child support**: 650.00 withheld where the federal ceiling leaves 400.00 (G33).
6. **California and New York withholding use income-tax schedules, single only, with no state certificate**; New York disability is withheld at 10.00 where the cap is 1.20; California SDI is 1.1 % against 1.3 % (G20, G22, G23).
7. **Annual caps break when two runs share a pay date**, the plain case of a bonus run on payday (G14).
8. **Supplemental wages follow no permitted method**: the flat-rate branch is unreachable and a bonus alone is annualized as a wage (G05).
9. **Benefit elections never reach a paycheck, limits live in three places, and the employer's contribution never reaches the ledger** (G28–G30).
10. **From 1 January 2027 every United States paycheck is refused** until the 2027 values are seeded; five weeks from this review (G55).

---

## 6. Existing tasks: verdict and build order

| Task | Verdict |
|---|---|
| 275 | right; raise to Must (G11); its 184,500 agrees with the research |
| 276 | right; Should |
| 327 | right and first: every other task needs to know where United States values live |
| 338 | lacks the 100,000 rule, the 2,500 and 500 thresholds, the +10 days, state deposits, the weekend shift; depends on MNE-001-979; raise to Should |
| 339 | lacks the regular rate and the half-time premium kept apart for W-2 code TT; raise to Should |
| 354 | right; raise to Should |
| 364 | right; add that `src/ai/docs/payroll.md:19-23, :36` stops claiming what is not built (first cut is in MNE-001-983) |
| 514 | right; raise to Must (G03, G23); add the 2027 rows as soon as published and the checkbox schedules' source |
| 737 | add: the file names every paycheck it left out and why |

Order: (1) 327, 275, 514, 354, 276; (2) MNE-001-976, U3, U2; (3) U4, 338, U5, U6; (4) U7 with 641 and 282, then U8; (5) U9, U10, U11, U12, 339, 364.

---

## 7. Not reviewed

- The official texts themselves: no IRS, SSA, DOL, EDD or New York publication was opened. Every rule figure comes from the repo's research or is marked to verify.
- The Nacha Operating Rules and SSA Pub 42-007 (EFW2): field positions were checked only against my own count and the research's claim.
- `pay-run-service.ts`, `pay-period-service.ts` and the CLI leaves beyond their command lists; `payroll accrue`; the United States chart of accounts beyond the bucket map.
- No test was run and no database was queried: seed values were read from the migrations.
- Sales tax, 1099-NEC, entity income tax and GAAP presentation: other reviewers.
- Issues #96 and #591 and their tasks: not opened.
