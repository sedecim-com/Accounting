# ADR-0006 · Configurable options, with best practice as the default

- **Date:** 2026-09-29
- **Status:** accepted by the owner (@vic2099).
- **Extends:** invariant 6 of [`AGENTS.md`](../../AGENTS.md). It does not replace it.
- **First application:** the owner's decisions on withholdings of 2026-09-29, in #309.

## Context

Invariant 6 already says that a fork between two legitimate accounting treatments is not chosen in code: it becomes a key in the policy panel (`src/services/policy/`), with its reason and its reader. It says nothing about two things:

1. **Which option is the default.** Every key carries a `defaultValue` and a `defaultRationale` (`src/services/policy/pending-catalog.ts`), and the default is what an entity gets until someone answers. Nothing said how to pick it. The easy choice is whatever the code already did, and that is not always the right one.
2. **Choices that are not accounting.** Whether a correction keeps history or overwrites, how a query is scoped to an entity, whether a write is idempotent, whether an audit log is append-only. Without a rule, an agent that is unsure can push any of these into the panel and call it "configurable", which hands the accountant a question that is not theirs to answer.

On 2026-09-29, while reviewing the withholdings PR (#478, MNE-001-056), the owner decided three forks in #309: which accounts hold withheld ISR and VAT, what happens to existing entities that keep everything in 2140, and what to do with a professional-fees CFDI with no declared ISR withholding. In each one he kept every legitimate option in the panel and fixed a default. He then stated the rule, verbatim:

> «Mantén las opciones configurables pero establece la que sea la mejor práctica de sistemas y con las opciones por default en la mejor práctica contable. Esto es algo que debes recordar para elegir cómo crear el sistema.»

("Keep the options configurable, but set what is best systems practice, and with the default options at best accounting practice. This is something you must remember when choosing how to build the system.")

## Decision

1. **An accounting, fiscal or firm-policy fork is a panel key, and its default is the best accounting practice.**
   - The key offers every legitimate option, not only the one the code already implements.
   - The default is what a Mexican firm should do under the norm: NIF, LISR, LIVA, CFF, the RMF and SAT rules. Its `defaultRationale` cites the article, rule or standard that makes it the best practice.
   - When the norm leaves room, the default is the most conservative option: the one that does not post without review, does not lose deductibility and does not rewrite history.
2. **A systems-design choice is not a panel key. It follows best systems practice.**
   - History over overwrite; append-only audit; idempotent writes; every query bounded by `entity_id` / `tenant_id`; least privilege; data minimisation; names in English (see `docs/language.md`).
   - Making one of these configurable "just in case" is rejected: it multiplies the paths that must be tested and asks the accountant a question that is not accounting.
3. **When a choice is both** (for example, reassigning the roles of existing entities in #309), the accounting part goes to the panel and the systems part is fixed: whichever option the firm picks, the change is audited, has a `--dry-run` and never silently overwrites a manual mapping.

**Rejected:**

- **Keeping the existing behaviour as the default.** It turns an accident of implementation into policy.
- **No default: force the firm to answer before anything runs.** It blocks onboarding, and the panel already asks by priority.
- **Everything configurable.** Systems choices that vary per entity break the house invariants, which assume one behaviour.

## Consequences

- Every new panel key names its default and cites in `defaultRationale` why it is the best accounting practice. A key whose rationale is "this is what the code did" does not pass review.
- A PR that takes one of these choices lists it under "Open points" in its body: the key, its options, the default and the citation. The owner may change it there; until then the default stands.
- A PR that makes a systems choice configurable is sent back unless it shows that the choice is really accounting.
- `AGENTS.md` invariant 6 points here.
- **Revisited** if the panel grows keys whose default has to change often, which would show the rule is picking badly.
