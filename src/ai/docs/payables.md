# Accounts payable (vendors and received invoices)

## Vendors
- Data: vendor_number (V-...), company_name, tax_id (RFC/EIN), terms, default expense account, is_1099_vendor flag (USA), bank data ENCRYPTED (account/CLABE/routing — you will never see them in the clear).
- YOU: search_vendors. Human: POST/PATCH /v1/vendors.

## Vendor invoices (bills)
- States: draft → pending_approval → approved → posted → partially_paid → paid; also void, cancelled.
- Automatic entry when a bill posts: debit expense per line; debit input VAT; credit AP for the total.
- Vendor payment: credit BANKS for the cash that left. The debit splits by what the payment actually settles: AP for the amount APPLIED to bills, and `anticipo_proveedores` (1150) for whatever was paid without naming a bill — money out with no bill named is an advance, not a settled liability, and posting it to AP would move the control account while no subledger row moved (exactly what `ap reconcile` reports).
- An early-payment discount credits `devolucion_compras` (5200, contra-cost) and settles MORE liability than the cash: bill 1160, cash 1100, discount 60 → AP debited 1160. `amount_paid` only ever grows by the CASH: a discount is not money the vendor received, and counting it as such breaks bank reconciliation.
- Applying later (`payment apply`): an advance can be spread over bills afterwards — DR AP / CR 1150, and for PPD bills the parked VAT is released pro-rata. NO cash moves: it already left with the payment.
- Short pay (`payment apply --mode residual`, requires a written reason): the bill closes for less than it owed and the shortfall stops being owed. WHERE it goes is the firm's policy (`pago_corto_residual` in the panel: contra-cost, other income, or forbidden) — never assume it, and if the firm has not decided, say the default is being used. On a PPD bill the VAT on the unpaid part leaves 1135 WITHOUT becoming creditable: cash basis credits what was paid, and that part never will be.
- The bulk entry path for bills in Mexico is CFDI ingestion (mexico-cfdi doc): pre-registration → rules → your classification.

## What YOU do
- get_aged_payables (AP aging), search_vendors, query auto journal entries (search_journal_entries).
- `mnemosine ap reconcile` (read-only, you may run it) squares the AP subledger against the control account and NAMES what explains any gap — including journal entries somebody posted straight to the control account with no bill behind them, which no aging report can see.
- In CFDI ingestion: propose the draft journal entry for the expense (see the mnemosine doc).

## Human (REST /v1/bills)
- POST / (create), POST /:id/approve, POST /payments (payment applied to bills — this is the call that moves amount_due and posts to the ledger).
- CLI: `bill create|approve`, `payment create` (pay a bill), `payment apply` (spread a payment already made), `bill inbox list|run` (the CFDI queue). Payment writes are IA ✗ — you may read and propose, never run them.
- POST /:id/schedule-payment answers 501: mnemosine has no payment scheduler and no connection to any bank. It used to answer 200 and append a line to bills.memo, which left the vendor unpaid on the date it reported. Never tell a human a payment is scheduled.
