Issue: #1077

## Goal

A firm can run a real Mexican payroll year from the terminal: the system computes the SBC and keeps its history, takes absences and disability leave, exempts what art. 93 exempts, caps deductions, settles a termination as a run, does the annual ISR adjustment, changes an employee without REST, and books the ISN and wages payable.

## Tranche and context

- **Tranche:** new, from the norms review of 27 Nov 2026 (report 05, gaps G08–G14, G18). PRD-003 RF-16, RF-18, RF-19, RF-47. Lane F.
- **Why now** (`develop` `e9a327d0`):
  - **Gross, SBC and contributed days are typed.** The gross is the sum of typed lines (`common/paycheck-service.ts:351`; `cli/pay-run-command.ts:60-63`: «There is no input stage yet»). `employees.sbc` is typed (`008_payroll.sql:44`), `updateSalary` does not touch it (`common/employee-service.ts:219`), and IMSS charges every calendar day (`paycheck-service.ts:261`). The integration factor exists for the settlement only (`mx/finiquito-math.ts:230`).
  - **Art. 93.** Only aguinaldo and vacation premium have a cap (`mx/isr-exemption.ts:49-52`); rest-day work is taxed whole (the code's note at `:197`); the rest hangs on a typed flag.
  - **Deductions.** A Mexican deduction is a typed line with no ceiling (`paycheck-service.ts:352-358`); the net can go negative (`:848-855`); alimony is refused by name (`common/garnishment-service.ts:294`; MNE-001-307).
  - **Settlement.** `calculateFiniquito` returns figures through `POST /finiquito` (`mx/finiquito-calculator.ts:198`; `routes/payroll.ts:367`): no indemnity, no run, payslip, entry or CLI leaf.
  - **Annual adjustment.** No code (`grep` of «ajuste anual», «art. 97» empty); year-to-date figures have no annual reader (`tax-engine/ytd-service.ts:60`).
  - **The employee.** The terminal has `employee create|list|show` (`cli/employee-command.ts:66`); termination and wage change are REST only (`routes/payroll.ts:175`, `:194`).
  - **The ledger.** The ISN lives in `employer_tax_liabilities` only; the entry credits cash on the pay date with no wages payable (`common/gl-posting-service.ts:242-322`).
- **The law** (por verificar contra el texto oficial where the corpus does not carry it; the text enters the corpus first or the task stops): LSS arts. 27, 28, 30, 31, 34; LFT arts. 48–50, 84, 89, 97, 110; LISR arts. 93, 97, 152; NIF D-3. The repo's study lists each as absent (`motores/nomina-mx.md` §4, items 2, 3, 5, 8, 9, 18).
- **Forks and their defaults** (ADR-0006):
  - `annual_isr_difference_withholding`: `last_december_paycheck` (default: withholds while there is a wage) or `separate_run_by_february`.
  - `sbc_integration_factor_decimals`: `four` (default: reproduces the SBC already declared) or `unrounded`.
  - `severance_daily_wage_base`: `integrated_wage` (default: pays the worker more) or `contractual_daily_wage`.
  - `payroll_wages_recognition`: `accrue_at_period_end` (default: the liability is recognised earlier) or `on_payment_date` (today's).

## Tasks

| Temp id | Title | Size (first part) | Depends on | Class |
|---|---|---|---|---|
| MNE-001-935 | El SBC se calcula, con piso, tope e historial fechado (plan: 2 parts) | 350 | — | S |
| MNE-001-936 | Incidencias: faltas e incapacidades; insumos de la corrida (plan: 3 parts) | 350 | N13 | S |
| MNE-001-937 | Las exenciones del art. 93 que faltan | 320 | — | S |
| MNE-001-940 | FONACOT, cuota sindical y topes de la LFT; un neto negativo se niega | 350 | with MNE-001-307 | S |
| MNE-001-934 | Ajuste anual del ISR de sueldos (plan: 2 parts) | 350 | MNE-001-276 | S |
| MNE-001-938 | Liquidación, y el finiquito como corrida final (plan: 2 parts) | 380 | N8 | S |
| MNE-001-939 | Empleado desde la terminal: baja, sueldo, riesgo y crédito | 380 | — | S |
| MNE-001-941 | La póliza lleva el ISN y los sueldos por pagar | 350 | — | S |

## Acceptance criteria

- [ ] (N13) Given 315.04 a day in the first year, the SBC read-out is 330.57 (factor 1.0493); below the zone's minimum it refuses; above 25 UMA it caps; a change keeps its date and each contribution day reads the SBC in force.
- [ ] (N14) Given a fortnight with two absences, the contributed days are 13 in the branches the law names, and the salary line is reduced; `pay-run input import` stores the inputs against the run.
- [ ] (N15) Given a Sunday premium of 78.76 with UMA 117.31, the exempt part is 78.76 and the CFDI declares it; each new cap is a dated row.
- [ ] (N18) Given a deduction above its ceiling, or a net below zero, the paycheck is refused naming the article; FONACOT and union dues carry their SAT key.
- [ ] (N12) Given two workers worked by hand, the read-out gives each one's annual tax, withholdings and difference to the cent, and names who is excluded and why.
- [ ] (N16) Given a dismissal at 3.5 years, `finiquito calculate` gives the indemnity to the cent; `finiquito run` leaves a `final` run with payslip and draft entry.
- [ ] (N17) Given `employee archive <id> --as-of … --reason …`, the employee leaves later runs, with history and an audit row; `--dry-run` writes nothing.
- [ ] (N19) Given a run of 100,000.00 in a 3 % state, `pay-run post --dry-run` shows 3,000.00 to ISN expense and to its liability, equal to `tax-deposit list`.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | new read-outs; no route removed |
| SAT/IMSS deliverables | compatible | exempt parts and settlement nodes on the payroll CFDI (with MNE-001-931) |
| Schema (migration) | compatible | N13 (SBC history), N14 (incidences), N15 and N18 (dated rows), N12 (annual tariff); N19 if a bucket asks for it |
| CLI surface | compatible | new leaves under `employee`, `finiquito`, `pay-run input`; names by the command registry |

## Out of scope / later

- Aguinaldo run helper and the vacation ledger (earned, taken, expired).
- 14-day and 10-day pay frequencies (today refused by name).
- Reversing or correcting a posted run and stamping a correction run.
- Watching the deadline to issue the payroll CFDI (LISR 99-III; RMF 2.7.5.1).
- The optional procedure of RLISR art. 174 (MNE-001-784).
- Transmission to IDSE, FONACOT or the SAT; the IMSS disability subsidy; back wages of a lawsuit.
- United States payroll (D-03).

## How to test

- `scripts/verify.sh` with integration; synthetic data.
- **Unit:** beside `tests/payroll/mx/finiquito-math.spec.ts`, `vacation-premium-exemption.spec.ts`, `year-end-bonus-exemption.spec.ts`; each hand-worked case red first.
- **Integration:** beside `mne-001-068-pay-run-terminal.int.spec.ts` and `mne-001-069-pay-run-post.int.spec.ts`, driving the binary; the month spec's payroll step keeps passing.
- **Edge cases:** an SBC change in the middle of a period; an absence on 31 January and 1 February; a worker hired in the year (annual adjustment exclusion); a termination on 29 February.

## Classification

- **Difficulty:** D3 (suggested): money, five migrations, the pay-run entry (N19). N17 is D2.
- **Autonomy:** A3 (suggested); N17 A2.
- **Size:** first parts ~2,830 lines; with the planned later parts, about 14 PRs. Each plan splits its task and names the parts.

## Constraints

- Invariants 3, 4, 6: guarded updates with their row count, entity scope inside the SQL, law in dated rows.
- Nothing posts without a person; no employee data beyond the employee number in a list.
- The gross stays typed until N14's third part ships; no second payroll engine in the CLI.

## Depends on

- **MNE-001-931** before N16's second part (the separation node).
- **MNE-001-276** before N12 (the tariff read by date); **MNE-001-307** beside N18, no dependency: the second rebases.

**Para el dueño:** hoy el sistema calcula impuestos sobre importes que alguien teclea: no integra el SBC, no conoce faltas ni incapacidades, no liquida un despido, no hace el ajuste anual y no lleva el ISN al mayor. Con estas ocho piezas una nómina real corre desde la terminal. Cuatro criterios quedan como claves del panel con su valor prudente; no hay pregunta para ti salvo aprobar las migraciones.

---
_Generated by [Claude Code](https://claude.ai/code)_
