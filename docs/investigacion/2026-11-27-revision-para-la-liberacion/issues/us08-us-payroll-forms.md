Issue: #1084

## Goal

A United States entity that runs its payroll here gets a Form 941, a Form 940, W-2s and a W-3 whose lines foot with their own instructions, an employer liability with a deposit date for every approved run, and an EFW2 file only once it follows the SSA layout.

## Tranche and context

- **Tranche:** new. From the norms review of 27 Nov 2026 (report 08, G16, G17, G38–G40, G42, G43, G46), after the owner's «Para el 1.0 desaparca lo aparcado» (#329).
- **Why now** (read at `develop` `e9a327d0`):
  - **941.** `src/services/payroll/usa/forms/form-941-generator.ts:55` and `:58` report uncapped wages on lines 5a and 5c; `:61` puts the whole paycheck that crossed 200,000 on 5d; `:52` counts every worker of the quarter; column 2 is the tax computed, not wages × rate; no line 7, 16 or Schedule B; each call inserts another filing (`:114-118`).
  - **Failing case.** A worker paid 8,000.00 biweekly (208,000 a year), fourth quarter of seven paychecks, seeded wage base 168,600: line 5a says 56,000.00 with a tax of 2,058.40; it must say 16,600.00.
  - **940.** `form-940-generator.ts:39-40` takes the uncapped sum as the FUTA base, `:72` derives line 5 from gross minus that sum, `:81` fixes line 4 at 0. The same worker: line 7 says 208,000.00 and line 8 says 42.00; it must say line 5 = 201,000.00, line 7 = 7,000.00. `futa-calculator.ts:21` always applies 0.6 % and knows no credit reduction (California 1.2 % for 2025: the repo's research `fiscal-us.md` §2.3).
  - **Liability.** `src/services/payroll/common/employer-liability-service.ts:513`, `:601` and `:672` write Mexican rows only. An approved United States run leaves none, so line 13 of the 941 and of the 940 is always 0.00, while `src/ai/docs/payroll.md:36` says the employer side accrues on approval.
  - **W-2 and W-3.** `w2-generator.ts:103` puts only the employee's HSA under code W and `:104` only the employer's cost under DD; no code AA or box 13; `:107` repeats state wages in box 18 with no local tax. `w3-generator.ts:51-68` sums the stored W-2s without checking that every paid worker has one.
  - **EFW2.** `w3-generator.ts:108-110` calls itself «Simplified»; the RW money fields start at column 145 where the research places the specification's at 188; RA and RE lack required fields; there is no RS record. `payroll.md:20` says the file is produced.
- **The norm, in its source:** the instructions of Forms 941, 940 (and Schedule A), W-2 and W-3 for the year, IRS Pub 15 §11, IRC §3302(c)(2), SSA Pub 42-007. None is in the agent's corpus and the sandbox could not open them: each task's first step is to bring the text in with its source, and to stop if it does not open.
- **Forks and their defaults (ADR-0006):**
  - `us_federal_deposit_schedule`: `semiweekly` (default, the earlier due date) or `monthly`. The lookback that decides it by law is MNE-001-338.
  - `us_futa_credit_reduction_accrual`: `each_run_at_last_known_rate` (default, the larger liability is recognised sooner) or `at_year_end`.
- **Related:** #91 (MNE-001-275), #662 (MNE-001-514), #124 (MNE-001-338), #96 and #591 (their tasks 282 and 641 come before the W-2 work).

## Tasks

| Temp id | Title | Size (first part) | Depends on | Class |
|---|---|---|---|---|
| MNE-001-979 | Al aprobar una corrida de EE. UU. se apunta el pasivo federal, FUTA y estatal con su fecha de depósito, y el depósito se registra | 350 (2 parts) | — | R |
| MNE-001-980 | La forma 941 cuadra renglón por renglón con sus instrucciones | 350 (2 parts) | MNE-001-979, MNE-001-978 | R |
| MNE-001-981 | La forma 940 separa lo exento y lo que pasa de 7,000, y el FUTA conoce la reducción de crédito | 300 (2 parts) | MNE-001-979, MNE-001-327 | R |
| MNE-001-982 | El W-2 llena sus casillas 12 a 20 como dicen sus instrucciones y el W-3 se niega si no cuadra | 350 (2 parts) | MNE-001-327; after 275, 641, 282 | R |
| MNE-001-983 | El archivo EFW2 se niega hasta seguir la especificación de la SSA, y el corpus dice lo que la nómina de EE. UU. hace hoy | 150 (2 parts) | part 2 after MNE-001-982 | R |

## Acceptance criteria

- [ ] (U4) Given an approved United States run, then `employer_tax_liabilities` holds one pending row per tax (941 federal, FUTA, and SIT, SDI and SUTA by state) with its due date; approving twice does not duplicate it.
- [ ] (U4) Given a deposit, when `tax-deposit record` runs with its reference and date, then line 13 of the 941 shows it.
- [ ] (U5) Given the failing case above, when `filing prepare --form 941` runs, then line 5a is 16,600.00 × 0.124 = 2,058.40, line 1 counts the workers of the pay period that includes the 12th, and asking twice leaves one filing.
- [ ] (U5) Given a semiweekly depositor, then Schedule B lists the liability by pay date and totals line 12.
- [ ] (U6) Given the same worker, when `filing prepare --form 940` runs, then line 5 is 201,000.00, line 7 is 7,000.00 and line 8 is 42.00.
- [ ] (U6) Given a state with a credit reduction seeded with its source, then Schedule A and line 11 carry it (84.00 at 1.2 % on 7,000.00).
- [ ] (U7) Given 1,000.00 of employee and 500.00 of employer HSA through the plan, when `w2 prepare` runs, then code W is 1,500.00; a Texas worker has no boxes 16 to 20.
- [ ] (U7) Given a paid worker with no W-2, when the W-3 is asked for, then it refuses and names the worker; `w2 reconcile` ties the W-2s to the four 941s of the year.
- [ ] (U8) Given the layout is not verified, when `POST /payroll/efw2` is called, then it refuses by key and reads no SSN; `src/ai/docs/payroll.md` says which forms foot and which do not.
- [ ] (U8) Given the SSA text in the corpus, when `efw2 generate` runs, then each field of RA, RE, RW, RS, RT and RF sits at its position.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API (`docs/openapi.json`) | compatible; `/payroll/efw2` answers a refusal until part 2 | document the code |
| IRS and SSA deliverables | breaking: the figures of 941, 940, W-2 and W-3 change | nothing is filed from here (501) |
| SAT/IMSS deliverables | none | — |
| Schema (migration) | the plan of U4 says whether the liability needs a new index | owner's plan and review if so |
| CLI surface (catalog) | new leaves: `filing prepare --form 941|940`, `w2 prepare`, `w2 reconcile`, `w3 prepare`, `efw2 generate`, `tax-deposit record` | catalog rows updated |

## Out of scope / later

Class C gaps of report 08, not filed as tasks:

- Forms 941-X, W-2c, W-3c, 944, 943, 945; state quarterly wage reports; new-hire reporting; W-2 delivery to the worker; ACA forms; electronic filing.
- Nonresident-alien amounts, the wage-bracket method and daily or quarterly pay periods in Pub 15-T.
- SUTA wages by the state of each paycheck; reciprocity; employee SUTA in AK, NJ and PA; paid-leave programmes outside the five seeded states (D-03).
- Group-term life over 50,000, transit, adoption, dependent care.
- State garnishment limits, a levy against an earlier support order, the Pub 1494 table by year, remittance to the state disbursement unit.
- Accrual of wages earned and unpaid at period end and of compensated absences (ASC 710).
- The W-2 codes new for 2026 (TP, TT, TA, box 14b): with MNE-001-339.
- The NACHA file: D-09 puts the dispersion in payments.

## How to test

- `scripts/verify.sh`; one integration spec per form on Postgres: the 208,000 worker, a worker under every cap, one with pre-tax benefits, a Texas worker.
- Each spec red before its change.
- **Edge cases:** a quarter with no paychecks; a worker who crosses 200,000 inside a paycheck; two runs on one pay date.

## Classification

- **Difficulty / autonomy:** U4 and U6 D3/A3 (money, a liability, maybe a migration); U5 D2/A2; U7 and U8 D2/A3 (they materialise SSNs).
- **Size per part:** U4 350 + ~250; U5 350 + ~300; U6 300 + ~250; U7 350 + ~300; U8 150 + ~350.

## Constraints

- **Law, not policy**, except the two panel keys above. A figure with no official text in the corpus is not typed from memory.
- **Restricted paths:** migrations have a reinforced owner; 009 is never edited.
- **PII:** no SSN in logs or fixtures; synthetic workers only.
- **Network:** each plan names the hosts of the IRS and SSA texts; the owner opens them or reads the text outside the sandbox.

## Depends on

MNE-001-327 (where United States values live). U5 and U6 come after U4; U5 after MNE-001-978 (year-to-date); U7 after MNE-001-275, MNE-001-641 and MNE-001-282; U8 part 2 after U7.

**Para el dueño:** Hoy las formas 941 y 940 no cuadran consigo mismas: declaran como base gravable todo el salario aunque pase del tope, y siempre dicen cero depositado porque el pasivo patronal de Estados Unidos no se apunta. El W-2 llena mal varias casillas y el archivo EFW2 no sigue el layout de la SSA. Este tramo corrige las formas, apunta el pasivo con su fecha de depósito y niega el EFW2 hasta que siga la especificación. Lo único suyo es abrir los textos oficiales del IRS y de la SSA, o leerlos fuera del sandbox.
