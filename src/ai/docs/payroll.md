# Payroll (Mexico + USA)

## Pay run lifecycle
draft → calculating → calculated → approved → paid (also voided). Each transition fires webhooks (payroll.run.calculated/approved/paid). When posting to the GL: debit salaries + employer contributions; credit banks + tax/withholding liabilities.

## Employees
- MX data: RFC, CURP, NSS, integrated daily salary. USA: SSN, W-4 (2020+), work_state/residence_state (multi-state supported).
- Versioned compensation (history); termination via POST /employees/:id/terminate.

## Mexico
- ISR (SAT brackets), IMSS (employee-employer), INFONAVIT. Caps in UMA.
- Payroll CFDI 1.2: POST /paychecks/:id/cfdi-nomina (stamps via multi-PAC).
- SUA (POST /sua), severance/settlement (POST /finiquito — year-end bonus, vacation premium, TipoNomina E).
- IMSS IDSE: /imss-idse/batch and /submit.

## USA
- FIT (Pub 15-T), FICA (SS with annual cap + Medicare + additional 0.9%), FUTA ($7k), SUTA PER STATE (each state has its own base; SUTA YTD is tracked by work_state).
- Forms: W-2 (/w2; box 1 = FIT base without 401k, box 3 = FICA base with 401k capped at the SS wage base), W-3 (/w3), EFW2 (/efw2), 941 (/form-941), 940 (/form-940).
- Direct deposit: NACHA (/nacha). E-file: /irs-efile/:filing_id (+ status), /ssa-bso/submit.
- Benefits: 401k/HSA/FSA/Sec-125 plans (GET /benefit-plans, elections per employee).

## Self-service (authenticated employee)
GET /me/paychecks, GET /me/w2/:tax_year.

## What YOU do
- You have no payroll tools yet: query payroll journal entries in the ledger (search_journal_entries / get_general_ledger), explain calculations and rules, and direct the human to the correct /v1/payroll/... endpoint to execute. NEVER estimate taxes "by eye": if asked for an exact calculation, tell them to run the pay run (calculate) and read the result.
