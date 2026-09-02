# System overview

## Architecture
Multi-tenant (tenant → organization → MX/USA legal entities). Every operation is scoped by entity_id. Standards: MX NIF / US GAAP / IFRS per entity. REST API /v1 (JWT + granular permissions) + GraphQL. Prometheus metrics at /metrics; health at /live and /ready.

## Modules and their docs
accounting (journal entries/periods), receivables (customers/invoices), payables (vendors/bills), banking (reconciliation), mexico-cfdi (stamping/ingestion), payroll (MX+USA), reports, mnemosine (your flow), cli-reference (exact command surface), identity-access (login/RLS/roles), connectivity (database hosting + model providers).

## Events (outbound webhooks)
The system publishes events with retries: invoice.*, bill.*, payment.*, payroll.run.calculated/approved/paid, paycheck.issued, cfdi_nomina.stamped, tax_form.filed, test.ping. Human: POST/GET/DELETE /v1/webhooks, /:id/test, /:id/deliveries, /deliveries/:id/retry.

## Integrations (admin)
- Mexico PACs: Finkok/SW Sapien/Edicom with failover and preferences (/v1/admin/integrations/pac/preferences/all).
- Payments: Stripe/Conekta. Banks: Plaid/Belvo. Files: S3. (Email fue retirado en F03: el adaptador simulaba el envío.)
- Per-provider health with circuit breaker: GET /v1/admin/integrations/health/all.

## Blockchain attestation (optional)
Every posted journal entry can be attested (hash → configured chains + Bitcoin anchor). Admin config: /v1/admin/blockchain/config, /bitcoin/config, /commit-period, /publish-aggregates. Public verification without auth: /public/v1.

## Audit
Every request carries an x-request-id (correlation in logs). Your actions are recorded in ai_drafts/ai_questions with model, confidence, reasoning, and the user's original request.
