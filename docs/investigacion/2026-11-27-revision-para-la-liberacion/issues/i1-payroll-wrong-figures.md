Issue: #1076

## Goal

A Mexican paycheck withholds and charges what the law says in six places where today it does not: no ISR and no worker IMSS quota for who earns the minimum wage, an INFONAVIT credit discount in the unit the law uses, the work-risk premium of the employer registration (and the right class IV mean), one monthly subsidy ceiling, and quotas rounded as the SUA rounds them.

## Tranche and context

- **Tranche:** new, from the norms review of 27 Nov 2026 (report 05, gaps G01–G04, G15, G24). Lane F.
- **Why now** (`develop` `e9a327d0`; figures read from the calculators with the seeded 2026 values, not run):
  - **The minimum-wage worker is under-paid 190.52 a fortnight.** Period 1–15 Nov 2026, general zone, 315.04 a day, gross 4,725.60, SBC 330.57. `MexicoIsrCalculator` applies the tariff to any base (`mx/isr-calculator.ts:56-87`): ISR 337.05, subsidy 264.30, withheld **72.75**. `MexicoImssEmployeeCalculator` always charges the five branches (`mx/imss-calculator.ts:68-123`): **117.77**. Net 4,535.08 where the law gives 4,725.60. `earnsTheMinimumWage` exists (`mx/isr-exemption.ts:248`) and serves overtime only.
  - **The INFONAVIT credit in VSM.** `mx/infonavit-calculator.ts:79-81`: general minimum wage × value × days. A 15.2-times credit gives 315.04 × 15.2 × 15 = **71,829.12** in a fortnight. `pesos` uses days / 30 (`:82-84`), not the days of the bimester.
  - **The risk premium.** `riesgoRate` picks a class mean by the **employee's** class and falls back to class I in silence (`mx/imss-calculator.ts:44-52`, `:189`). Seed `009_tax_tables_2026.sql:62` holds class IV at 0.046325; the repo's study says 4.65325 % (`docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md:169`, `:222`).
  - **The subsidy.** Each paycheck gets 535.65 × days / 30.4 with no look at the month (`mx/employment-subsidy.ts:62-98`): five weekly pay dates give 5 × 123.34 = 616.70 against 535.65. Eligibility compares wage × periods per month (`mx/isr-calculator.ts:107-109`, `:153`); the comment there says the question was left undecided.
  - **Rounding.** Branches are summed unrounded in `number` and rounded once (`mx/imss-calculator.ts:99-118`; `mx/infonavit-calculator.ts:39`, `:46`).
- **The law.** As the repo's study carries it, each to be opened in its official text first (por verificar contra el texto oficial):
  - LISR art. 96 ¶1: no withholding for who only earns one minimum wage (`fiscal-mx.md:97`).
  - LSS art. 36: the employer pays the worker's quota at the minimum wage (`motores/nomina-mx.md:118`, `:460`).
  - LSS arts. 71–74: the premium belongs to the employer; class means only at registration (`fiscal-mx.md:169`).
  - Subsidy decree DOF 31-12-2025: «sin exceder el tope mensual» (`fiscal-mx.md:98`).
  - INFONAVIT law arts. 29 fr. III and 44, LFT art. 97 fr. III, and the SUA's rounding: not in the corpus; the text enters it first or the task stops.
- **Forks and their defaults** (the owner's rule of 17 Nov; ADR-0006):
  - `minimum_wage_isr_exemption`: `only_minimum_wage_paid` (default: with any other taxed earning the tariff applies to everything, the reading that can only withhold more) or `minimum_wage_part_never_taxed`.
  - `employment_subsidy_eligibility_base`: `period_wage_over_days_times_30_4` (default: credits less, withholds more) or `period_wage_times_periods_per_month` (today's).
  - `imss_quota_rounding`, only if the SUA's rule cannot be sourced: `total_to_the_cent` (default: changes no figure) or `per_branch_to_the_cent`.
  - No key for LSS 36, the premium, the monthly ceiling or the UMI: the law settles them.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-923 | Quien sólo gana el salario mínimo de su zona no sufre retención de ISR | 200 | — | R |
| MNE-001-924 | El patrón absorbe la cuota obrera del IMSS de quien cotiza con el salario mínimo | 300 | N1 | R |
| MNE-001-925 | El descuento del crédito INFONAVIT sale de la ley | 350 | — | R |
| MNE-001-926 | La prima media de la clase IV vale lo que dice la LSS, con su censo | 80 | — | R |
| MNE-001-927 | La prima de riesgo es la del registro patronal, con vigencia | 380 | MNE-001-278 | R |
| MNE-001-942 | Subsidio: tope mensual y base de elegibilidad | 220 | — | S |
| MNE-001-945 | Cuotas en Decimal, redondeadas por ramo como la cédula del SUA | 180 | — | S |

## Acceptance criteria

Setup: a Mexican entity, general zone, `quincenal`, period 1–15 Nov 2026, UMA 117.31, minimum wage 315.04.

- [ ] (N1) Given 4,725.60 taxed and nothing else, `isr_withheld` is 0.00 and the note names the article; given 4,725.61, the tariff applies.
- [ ] (N1) Given the default key and a taxed bonus on the same paycheck, the tariff applies to the whole base; under `minimum_wage_part_never_taxed` only to the excess.
- [ ] (N2) Given SBC 330.57, `imss_employee` is 0.00, the employer side carries 1,124.80, the net is 4,725.60, and the entry, the liability and the SUA total agree.
- [ ] (N3) Given a credit in times, in pesos and in percentage, each discount equals the figure worked by hand from the official text, to the cent; none exceeds the minimum-wage ceiling.
- [ ] (N4) Given the migration applied, SBC 874.42 for 15 days in class IV gives 610.33 of work risk, not 607.61; the census lists earlier paychecks and writes nothing.
- [ ] (N5) Given a registration premium of 1.50000 % in force, SBC 874.42 for 15 days gives 196.74; given no premium in force, `pay-run calculate` refuses by key and names the registration and the date.
- [ ] (N20) Given five weekly pay dates in a month, the fifth causes 42.29; given 5,700.00 a fortnight, the default key gives no subsidy and the other gives 264.30.
- [ ] (N23) Given SBC 330.57 and 874.42 for 15 days, each branch equals the cédula's figure and the stored breakdown adds up to the total.
- [ ] Given a US employee, or a Mexican one above the minimum wage with no credit, no figure changes except by N5 and N23.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | paycheck breakdown gains the absorbed quota and notes |
| SAT/IMSS deliverables | compatible | the payroll CFDI stops declaring deduction 001 and ISR for the minimum-wage worker; SUA totals follow |
| Schema (migration) | compatible | N3 (dated rows), N4 (data), N5 (premium table); the owner approves each |
| CLI surface | compatible | a door to load the premium (N5); a read-only census (N4) |

**Rollout:** after N5 an entity with no premium loaded cannot calculate; the PR names the command that loads it.

## Out of scope / later

- Correcting paychecks already approved: a census and a person's decision, as in MNE-001-740.
- Several registrations per entity; the yearly premium from the accident record and its February filing.
- INFONAVIT notices of retention or suspension.
- ISN: tiered or exempt-amount state regimes and state exclusions from the base (refused by name today).
- A due-date row for the ISR withheld in `tax-deposit list`.

## How to test

- `scripts/verify.sh` with integration; synthetic employees only.
- **Unit:** beside `tests/payroll/mx/overtime-exemption.spec.ts`, `employment-subsidy.spec.ts`, `old-age-band.spec.ts`; each failing case above red first.
- **Integration:** beside `mne-001-068-pay-run-terminal.int.spec.ts`, `mne-001-069-pay-run-post.int.spec.ts`, `mne-001-070-payslip-and-sua.int.spec.ts`: one fortnight for worker A (minimum wage) and worker B (25,000 a month), figures to the cent.
- **Edge cases:** 16–28 February; the border zone (440.87); a period straddling 1 February; a second run in the period.

## Classification

- **Difficulty:** D3 (suggested): paycheck money, three migrations, the run's entry (N2).
- **Autonomy:** A3 (suggested): the migrations and the paycheck path are the owner's to confirm.
- **Size:** ~1,710 lines in seven PRs, one per task, each «Part of #N».

## Constraints

- Invariant 6: no rate, date or threshold in code; each is a dated row.
- The law is opened in its official text before a figure changes; if it does not open, the task stops and says so.
- A paycheck already written is never rewritten.

## Depends on

- **MNE-001-278**, before N5 (the registration of the entity).
- **MNE-001-637 / 638** (the 2027 parameters), no dependency: same tables; the second rebases.

**Para el dueño:** hoy a quien gana el salario mínimo se le retienen ISR y cuota del IMSS que la ley no permite (190.52 por quincena en 2026); un crédito INFONAVIT en veces sale con una cifra absurda; y la prima de riesgo es la media de una clase, no la de tu registro patronal. Con esto el recibo sale como manda la ley y se niega cuando falta la prima. Tres piezas traen migración: su aprobación te toca. Lo ya pagado no se corrige aquí; se lista para que decidas.

---
_Generated by [Claude Code](https://claude.ai/code)_
