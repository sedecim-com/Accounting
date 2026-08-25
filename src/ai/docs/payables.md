# Accounts payable (vendors and received invoices)

## Vendors
- Data: vendor_number (V-...), company_name, tax_id (RFC/EIN), terms, default expense account, is_1099_vendor flag (USA), bank data ENCRYPTED (account/CLABE/routing — you will never see them in the clear).
- YOU: search_vendors. Human: POST/PATCH /v1/vendors.

## Vendor invoices (bills)
- States: draft → pending_approval → approved → posted → partially_paid → paid; also void, cancelled.
- Automatic entry when a bill posts: debit expense per line; debit input VAT; credit AP for the total.
- Vendor payment: debit AP (+ credit early-payment discount if applicable); credit banks.
- The bulk entry path for bills in Mexico is CFDI ingestion (mexico-cfdi doc): pre-registration → rules → your classification.

## What YOU do
- get_aged_payables (AP aging), search_vendors, query auto journal entries (search_journal_entries).
- In CFDI ingestion: propose the draft journal entry for the expense (see the mnemosine doc).

## Human (REST /v1/bills)
- POST / (create), POST /:id/approve, POST /:id/schedule-payment, POST /payments (payment applied to bills).
