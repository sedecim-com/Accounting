# Reports: which exist and how to read them

## Your tools (the ledger ones read POSTED journal entries only, never drafts)
- get_trial_balance(as_of_date?, only_with_balance?) — trial balance: debits, credits, balance (positive=debit nature) + is_balanced. Year-end closing entries COUNT here by default; when the range holds one, a `closing_entries` note says so.
- get_balance_sheet(as_of_date) — assets/liabilities/equity in natural sign per section; NEGATIVE amounts are contra-accounts that subtract (e.g. accumulated depreciation under assets). This tool sums the PERMANENT accounts only: it leaves out the result of the period, so `assets.total` minus `total_liabilities_and_equity` is exactly the profit or loss not yet swept into equity. It does not foot, and that gap is NOT books out of balance — use is_balanced from get_trial_balance for that. The footed statement, with "Result Of The Period" inside equity plus out_of_balance/is_balanced, is `mnemosine report balance-sheet show` and GET /v1/reports/balance-sheet.
- get_income_statement(start_date, end_date) — income (natural credit) and expenses (natural debit) both positive; net_income = income − expenses. Year-end closing entries are LEFT OUT by default — counting them prints net_income 0.00 for a closed year — and a `closing_entries` note appears when the range holds one. An account that moved and netted to zero is still listed.
- get_aged_receivables / get_aged_payables(as_of_date?) — negative days_overdue = not yet due. These read OPEN invoices and bills, not the ledger. as_of_date ages the due date only: the amounts are what is owed TODAY, never what was owed on that date — fine for a collections call, wrong for an auditor.
- get_general_ledger(account_code, start_date?, end_date?) — ledger detail, max 100 movements; `truncated: true` means there were more. Everything posted shows here, closing entries included.

## Not a tool of yours (direct the human)
- Statement of cash flows — you have NO tool for this one. Terminal: `mnemosine cashflow generate --period 2026-07`, and `mnemosine cashflow reconcile` to tie it against real cash and print the residue instead of absorbing it. HTTP: GET /v1/reports/cash-flow?start_date&end_date. Indirect method only: asking for the direct one is REFUSED with what is missing, never answered with the indirect one relabelled. Sections are operating (net income + non-cash ± working capital), investing and financing, all derived from ledger movements; `unclassified` holds what the engine could not place and does NOT enter net_cash_flow, and `self_check` reports whether the statement ties to the real movement of cash.
- The same six tools above also exist as GET /v1/reports/... for dashboards, and as `mnemosine report ...` in the terminal.

## Rules when reporting
- Cite the report and the date cutoff used. If the trial balance does not balance (is_balanced=false), report it as a finding — do not "fix" it narratively.
- A trial balance and an income statement can legitimately disagree across a year-end: the first counts the closing entry, the second does not. That split is the `informes_asientos_de_cierre` policy, not an error — read the `closing_entries` note before calling it a discrepancy.
- Totals ALWAYS come from the tool, never hand-summed from the chart of accounts.
