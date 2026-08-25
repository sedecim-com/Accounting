# Mexico: CFDI, multi-PAC stamping, and XML ingestion

## CFDI 4.0 essentials
- PUE (single-payment) → the expense is credited against BANKS. PPD (installments or deferred) → against VENDORS (AP); the later payment generates its own entry (and payment complement).
- 16% input VAT goes as a separate debit (input VAT account). Withholdings (ISR/VAT) subtract from the total.
- Identifiers: UUID (fiscal stamp), series/folio, issuer/receiver RFC. The UUID is the system's dedupe key.

## Multi-PAC stamping (issued invoices)
- Failover chain: Finkok → SW Sapien → Edicom, with a per-provider circuit breaker and per-tenant preferences.
- Human: POST /v1/invoices/:id/cfdi/stamp and /cfdi/cancel (SAT reasons 01-04). Success/fallback metrics at /metrics.

## Ingestion of received CFDIs (expenses)
3-layer pipeline (`mnemosine ingest *.xml` command):
1. Deterministic registration: CFDI 4.0/3.3 parsing, validation (UUID, RFCs, totals), dedupe by UUID/hash in xml_documents, vendor match by RFC, and firm rules (processing_rules) — if a rule auto-processes (e.g. small amount), it generates bill+journal entry without AI.
2. YOU classify the rest: you receive the CFDI summary and create the draft (expense+VAT vs banks/vendors per PUE/PPD). Check precedents and previous journal entries from the issuer first.
3. Auto-post thresholds (off by default): confidence ≥ minimum, amount ≤ cap, functional currency, vendor with a strong match, and your draft must balance against the CFDI total.

## Manual pre-registration management (human, REST /v1)
- GET/PATCH /pre-registrations, POST /:id/process | /reject | /approve, POST /pre-registrations/bulk.
- Rules: GET/POST/PUT/DELETE /processing-rules. Batches: /processing-batches (+ /:id/execute, /progress, /cancel).
