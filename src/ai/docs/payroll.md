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
  The finiquito computes on the SALARIO DIARIO, never on the SBC (the SBC is the integrated salary and is for IMSS contributions only); it reads `dias_aguinaldo` and `prima_vacacional_pct` from the policy panel, applies the LFT art. 76 vacation table (12 days year 1, +2/year to 20 at year 5, then +2 every five years), prorates the aguinaldo from the hire date when the employee joined mid-year (art. 87), and returns every amount as a STRING with four decimals plus a `basis` block saying which seniority, table row and daily wage produced it.
- IMSS IDSE: /imss-idse/batch produces the fixed-width .txt. There is NO submit: /imss-idse/submit answers 501. A human uploads the file at idse.imss.gob.mx with the patron FIEL and keeps the acuse.

## USA
- FIT (Pub 15-T), FICA (SS with annual cap + Medicare + additional 0.9%), FUTA ($7k), SUTA PER STATE (each state has its own base; SUTA YTD is tracked by work_state).
- Forms: W-2 (/w2; box 1 = FIT base without 401k, box 3 = FICA base with 401k capped at the SS wage base), W-3 (/w3), EFW2 (/efw2), 941 (/form-941), 940 (/form-940).
- Direct deposit: NACHA (/nacha) produces the file; the human delivers it to the bank.
- mnemosine does NOT transmit to any tax authority. /irs-efile/:filing_id, its status endpoint and /ssa-bso/submit all answer 501. The forms above are produced here; filing them is a HUMAN act — an authorized e-file provider or mail for the IRS, the BSO portal for the EFW2 — and the confirmation number is recorded on the filing afterwards.
- Benefits: 401k/HSA/FSA/Sec-125 plans (GET /benefit-plans, elections per employee).

## Self-service (authenticated employee)
GET /me/paychecks, GET /me/w2/:tax_year.

## What YOU do
- NEVER tell a human that mnemosine has filed, transmitted or submitted anything to the IRS, the SSA or IMSS. It cannot, and the endpoints that once implied otherwise now refuse.
- You have no payroll tools yet: query payroll journal entries in the ledger (search_journal_entries / get_general_ledger), explain calculations and rules, and direct the human to the correct /v1/payroll/... endpoint to execute. NEVER estimate taxes "by eye": if asked for an exact calculation, tell them to run the pay run (calculate) and read the result.

## Employer taxes and the employment subsidy (F08a)
- Every tax component of a paycheck is now stored per row in `paycheck_taxes` (base, rate, EE/ER side, credit flag). Forms that used to report zeros read this. The employer side accrues to `employer_tax_liabilities` when the pay run is approved, one row per tax and — for the ISN — one row per state.
- SUBSIDIO AL EMPLEO: when it exceeds the ISR of the period, the employer HANDS THE DIFFERENCE TO THE WORKER IN CASH. It lands in `paychecks.subsidio_entregado_efectivo`, raises net pay, is declared in the CFDI as `OtrosPagos` `TipoOtroPago="002"` with its `SubsidioCausado`, and is posted against the account the policy `subsidio_al_empleo_entregado_registro` names. Never describe the subsidy as "reducing ISR to zero" — the excess is money the worker receives.
- ISN (state payroll tax, employer's burden, roughly 1%–4%): computed per state from `mx_isn_tasas_estatales`, which is **empty on purpose**. If a state has no rate captured for the period, the calculation does NOT return zero: it names the state and the period that are missing. Say that out loud — a zero would be a filing omission dressed as a result. A human captures rates with `mnemosine isn rate set`, and that capture governs every firm on the installation.
- The regimes `escalonado` and `con_exencion` are refused, not approximated.
