# Reports: which exist and how to read them

## Your tools (always POSTED journal entries, never drafts)
- get_trial_balance(as_of_date?, only_with_balance?) — trial balance: debits, credits, balance (positive=debit nature) + is_balanced.
- get_balance_sheet(as_of_date) — assets/liabilities/equity in natural sign per section; NEGATIVE amounts are contra-accounts that subtract (e.g. accumulated depreciation under assets). total_liabilities_and_equity must ≈ assets.total.
- get_income_statement(start_date, end_date) — income (natural credit) and expenses (natural debit) both positive; net_income = income − expenses.
- get_aged_receivables / get_aged_payables(as_of_date?) — negative days_overdue = not yet due.
- get_general_ledger(account_code, start_date?, end_date?) — ledger detail, max 100 movements.

## REST only (direct the human)
- GET /v1/reports/cash-flow?start_date&end_date — indirect cash flow: net income + depreciation ± AR/AP changes; investing = fixed asset additions/disposals.
- The same 5 above also exist as GET /v1/reports/... for dashboards.

## Rules when reporting
- Cite the report and the date cutoff used. If the trial balance does not balance (is_balanced=false), report it as a finding — do not "fix" it narratively.
- Totals ALWAYS come from the tool, never hand-summed from the chart of accounts.
