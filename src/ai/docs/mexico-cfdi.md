# Mexico: CFDI, multi-PAC stamping, and XML ingestion

## CFDI 4.0 essentials
- PUE (single-payment) → the expense is credited against BANKS. PPD (installments or deferred) → against VENDORS (AP); the later payment generates its own entry (and payment complement).
- IVA IS ON A CASH BASIS (LIVA art. 1-B, art. 5-III) and WHICH account it hits depends on MetodoPago:
  - PUE received → DR 1130 "IVA Acreditable" (creditable now). PUE issued → CR 2120 "IVA Trasladado".
  - PPD received → DR 1135 "IVA Pendiente de Acreditar" — NOT creditable yet; it PARKS there and the PAYMENT (with its REP) releases it to 1130, pro-rata to the amount paid. PPD issued mirrors this: parks in 2125 "IVA Trasladado No Cobrado", released to 2120 on collection.
  - Never send PPD tax straight to 1130/2120: that claims/causes tax before the law does. The engine (iva-cash-basis.ts) picks the role from MetodoPago and the payment path does the release — your draft must use the parked account for PPD.
- **PAYMENT BY CHEQUE IS EFFECTIVE WHEN THE CHEQUE IS CASHED, NOT WHEN IT IS HANDED OVER.** So the creditable VAT of a cheque payment belongs to the month the BANK PAID IT, not the month the cheque was written. `mnemosine bank check reconcile` posts that reclassification (1135 → 1130) dated on the clearing day. If a user asks why a January cheque's VAT is not in January's return, this is why — and if it IS in January, something reclassified it too early.
- Withholdings (ISR/VAT) subtract from the total.
- Identifiers: UUID (fiscal stamp), series/folio, issuer/receiver RFC. The UUID is the system's dedupe key.

## Multi-PAC stamping (issued invoices)
- Failover chain with per-provider circuit breaker and per-tenant preferences. Three adapters are SIMULATED (Finkok, SW Sapien, Edicom): an anti-simulation lock guarantees a simulated folio is NEVER persisted as 'stamped' (it lands as 'failed' with a note). Stamping is de facto off until a real PAC is configured (§5 decision).
- Human: POST /v1/invoices/:id/cfdi/stamp. CANCELLATION IS WITHDRAWN: /cfdi/cancel answers 501 — the human cancels at the PAC/SAT portal and reverses the entry with `mnemosine entry reverse`. Never tell a user the system cancels CFDIs.

## Ingestion of received CFDIs (expenses)
3-layer pipeline (`mnemosine ingest *.xml` command):
1. Deterministic registration: CFDI 4.0/3.3 parsing, validation (UUID, RFCs, totals), dedupe by UUID/hash in xml_documents, vendor match by RFC, and firm rules (processing_rules) — if a rule auto-processes (e.g. small amount), it generates bill+journal entry without AI.
   - AN UNKNOWN ISSUER STOPS EVERYTHING AUTOMATIC. Registering a vendor creates a counterparty from data a third party wrote inside the XML, so no unattended path may do it: rules, scheduled batches, your ingestion and webhooks all refuse and leave the CFDI in the inbox saying which vendor it would have created. Only a human re-running it interactively (`bill inbox run --allow-new-vendor`, or `allow_new_vendor` in the REST body) authorizes the creation. Never tell a user you can add the vendor yourself — tell them to run `mnemosine vendor create --tax-id <RFC>` and re-run, which matches by RFC.
2. YOU classify the rest: you receive the CFDI summary and create the draft (expense+VAT vs banks/vendors per PUE/PPD). Check precedents and previous journal entries from the issuer first.
3. Auto-post gates (off by default). Two classes, and the difference matters:
   - INTEGRITY (no policy ever skips these): suspicious third-party text, more than one draft for one CFDI, currency ≠ functional, and your draft must balance against the CFDI total.
   - DISCRETIONAL: confidence ≥ minimum, amount ≤ cap (hard-clamped by a floor), vendor with a strong match. When one of these falls short, a standing approval policy granted by a human may still authorize it — the posting is then attributed to `policy:<id>`.
   Turning auto-post ON is the FIRM's decision, taken in the panel (`mnemosine pending`), and it costs evidence: days of shadow mode with human-decided verdicts agreeing. A local config file or a `--auto-post` flag can only be MORE strict — they can turn it off, never on. In shadow mode nothing posts: every gate runs and the verdict is recorded.

## Manual pre-registration management (human)
- CLI: `mnemosine bill inbox list` shows the queue and flags rows whose issuer is not in the vendor catalog; `bill inbox run [id]` processes one or, with `--bulk --query`, many.
- REST /v1: GET/PATCH /pre-registrations, POST /:id/process | /reject | /approve, POST /pre-registrations/bulk.
- Rules: GET/POST/PUT/DELETE /processing-rules. Batches: /processing-batches (+ /:id/execute, /progress, /cancel).
