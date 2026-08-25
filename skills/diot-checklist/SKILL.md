---
name: diot-checklist
description: DIOT preparation — reconcile creditable IVA by vendor before filing the monthly declaration
when_to_use: The user mentions DIOT, the monthly informative declaration of operations with third parties, or asks to reconcile IVA acreditable by vendor
---

# DIOT / IVA reconciliation checklist

The DIOT reports operations with vendors and the IVA involved, split by
rate and by paid vs accrued. Everything below is QUERY work for you plus
named commands for the human — you never file anything.

## Steps

1. Read the `payables` and `mexico-cfdi` docs first if not in context.
2. **Vendor RFC hygiene.** Every vendor with operations in the month must
   have a valid RFC; generic RFCs (XAXX010101000 / XEXX010101000) only where
   the rule allows them. List offenders with your search tools.
3. **IVA by rate.** Reconcile the 16%, 0%, and exempt buckets: the IVA
   acreditable ledger balance for the month must equal the sum of IVA on
   PAID received invoices (cash basis — PPD bills count when paid, not when
   received).
4. **PPD payments.** Bills under PPD method need their payment records in
   the month to enter the DIOT; flag paid bills whose payment entry is
   missing and draft the clear ones.
5. **Border-rate and imports.** 8% border-region operations and imports
   (IVA paid at customs) are separate DIOT columns — verify they are not
   mixed into the 16% bucket.
6. **Tie-out.** The total creditable IVA in the DIOT worksheet must match
   the IVA acreditable account movement for the month. Any difference gets
   an explanation or a draft — never "close enough".
7. Filing the DIOT is a HUMAN action in the SAT portal; hand over the
   reconciled per-vendor totals and stop there.
