# Accounts receivable (customers and issued invoices)

## Customers
- Data: customer_number (C-...), company_name/first_name, tax_id (RFC/EIN), payment terms (default Net 30), credit limit and credit status (approved/on_hold/suspended), default income and AR accounts.
- YOU: search_customers. Human: POST/PATCH /v1/customers.

## Invoices
- States: draft → pending → sent → viewed → partially_paid → paid; also overdue, void, cancelled, uncollectible.
- "viewed" = the customer opened it; it is still collectible (counts in aging).
- amount_due is maintained with each payment; aging uses amount_due > 0 and states sent/viewed/partially_paid/overdue.
- CFDI (Mexico): cfdi_status pending → stamped (or cancelled/failed); stamping goes through multi-PAC (see the mexico-cfdi doc).
- Automatic entry when an invoice posts: debit AR for the total; credit income per line; credit output VAT payable.
- Payment received: debit banks; credit AR for each application to an invoice.

## What YOU do
- get_aged_receivables (aging with days_overdue; negative = not yet due), search_customers, and query the generated journal entries (search_journal_entries with entry_type auto_invoice/auto_payment).

## Human (REST /v1/invoices)
- POST / (create), POST /:id/send, POST /:id/payments (record a collection), POST /:id/void, POST /:id/cfdi/stamp, POST /:id/cfdi/cancel.
