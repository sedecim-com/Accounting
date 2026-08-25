---
name: month-end-close
description: Month-end close workflow for a Mexican entity — verify, accrue, reconcile, close the period
when_to_use: The user asks to close the month, prepare the monthly close, or wants to know what is missing before closing a fiscal period
references:
  - checklist.md
---

# Month-end close

Goal: leave the fiscal period ready to close with no pending drafts, no
unreconciled bank movements, and the recurring accruals recorded.

## Before anything

1. Read the `mnemosine` and `playbooks` docs (read_docs) if they are not in
   context yet: they define what is yours (drafts, queries) and what belongs
   to the human (posting, closing).
2. Run `get_entity_status` to see where the entity actually is — never assume.

## Workflow

1. **Pending work first.** Ask the human to run `mnemosine pending` (alias
   `pendientes`) and clear the queue: every AI draft must be approved or
   rejected with `mnemosine review` before the period can close.
2. **Bank reconciliation.** Verify imported bank transactions are matched
   (banking doc). Unmatched movements at close time usually mean missing
   entries — propose drafts for the clear ones, ask_user for the rest.
3. **Recurring accruals.** Search precedents (search_precedents,
   search_journal_entries) for last month's accruals — depreciation, payroll
   provisions, insurance amortization — and draft this month's equivalents.
   The most recent precedent wins; cite it.
4. **Trial balance review.** Run the trial balance report and flag accounts
   with an unusual sign against their nature (positive = debit nature,
   negative = credit nature).
5. **Close.** Closing the period is a HUMAN action: point them to
   `mnemosine close` (alias `cierre`) and verify afterwards with
   `get_entity_status`.

The detailed account-by-account checklist is in the `checklist.md` reference
of this skill.
