# Code language

> Spanish twin: [[Code-language.es]].

Since 2026-09-06 the rule is one sentence, refined twice the same day until no exception was left: **everything into English at origin — code, comments, commits, documentation, reports, persisted vocabulary, published contracts, migrations — and the whole user experience adjustable to another language, with Spanish configured first.** The only thing that does not go to English is what is not origin: rows already written in the database and proper names (SAT, CFDI, RFC, IMSS are not translated, as IRS is not translated in Spanish). The governing document is [`docs/language.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/language.md) (with its Spanish twin [`language.es.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/language.es.md)); the inventory that supports it, with the command behind every figure, is in [`docs/investigacion/2026-09-06-idioma/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-idioma).

## Three layers, three treatments

| Layer | Language | How it changes |
|---|---|---|
| **What the machine and the programmer read** — identifiers, files, comments, keys, error codes, CLI verbs, new columns | English | renaming, with a *codemod* and the instruments updated in the same commit |
| **What the user reads** — CLI help and messages, API errors, labels, panel questions, `doctor` notices, agent answers | the user's: Spanish first and by default, English second | extracting the English source into a catalog and rendering in the resolved language |
| **What is persisted vocabulary or a published contract** — panel keys and values, account roles, `CHECK`, error codes, JSON keys, migration names | English in the source; what is stored gets migrated | a data migration under RLS, an alias window and a contract version bump |
| **What is not origin** — rows already written, artifacts already signed, proper names and official acronyms | whatever it has | untouched |

## What exists today

- 45 % of the 4,637 declarations in `src/` are Spanish, and not by layer but by date: what was written in August is English; September's is Spanish. 51 files and 35 migrations carry Spanish names (migration numbers never change).
- 78 % of the 29,319 comment lines are Spanish **because a rule orders it** (`CONTRIBUTING.md:158`). That rule is inverted for what is new; what exists is translated by tranche with a ratchet.
- The CLI help is 99 % English and three instruments guard that; but the execution answers in Spanish in 24 files, and nobody measured it.
- The policy panel is the opposite of the request: keys and values in Spanish (persisted) under questions and labels in English.
- Some 120 entry description templates are English and **travel to the SAT as the `Concepto`** of Anexo 24, which is also persisted whole with its hash. It is a fiscal defect before a language one.
- `account_roles.role` is a vocabulary of 36 Spanish values persisted without a `CHECK` and read in 26 files; and the panel's English texts are persisted per tenant, so changing them means changing readers, not just labels.
- No `Intl`, no language column, no `--lang` flag; the only language resolver is used by the agent alone.

## What is proposed, in order

Twenty-seven tranches (I0–I26; epic [#141](https://github.com/sedecim-com/Accounting/issues/141), tranches [#142](https://github.com/sedecim-com/Accounting/issues/142)–[#169](https://github.com/sedecim-com/Accounting/issues/169)), each with its executable criterion; each leaves the tree green and the baseline lower, and stopping at any of them is a valid state.

1. **I0–I4, the foundations**: stable identity for the instruments that today use Spanish text as a key; the lexicon and the written rule; the `language:status` meter with figures that only lower; the `house/english-identifiers` lint that fails a new Spanish identifier, with a per-file baseline; and the stable vocabulary — panel keys and values, the 36 account roles, the `CHECK`s, the published codes, the migrations — registered with an English gloss. **I5**: J0 is born English.
2. **I6–I11, the user reads in their language**: a locale resolver (`--locale`, `es-MX` by default), a **typed** catalog (a key without a Spanish translation is a compile error) with an own formatter over `Intl`; the CLI kernel and the `bank` pilot; the leaves by family; the API with `Accept-Language` and the error codes untouched until I24; the panel asking in the accountant's language without touching what is persisted; reports, `doctor` and the agent.
3. **I12–I15, the renames**: the *codemod* that updates criteria, thresholds, manifest and catalog in the same commit, rehearsed on a module without coupling; `scripts/` with `npm` aliases for one version; the internal API that crosses folders; SAT, DIOT, Anexo 24 and payroll without touching a byte of what goes to the SAT.
4. **I16–I17, what is persisted**: key and parameters in entries, audit and periods, with the `Concepto` of Anexo 24 in Spanish from the key; the seeds rendered on seeding by the jurisdiction.
5. **I18–I22**: the sealed engine, with its four threshold tables moved at once; `tests/` and the instrument; existing comments by tranche with a ratchet; documentation as user experience (English source and Spanish twin per page); and commits in English.
6. **I23–I26, what has a net underneath**: persisted vocabulary with a data migration and an alias window; published contracts with `SCHEMA_VERSION 2` and a legacy code for one version; migrations and schema with a legacy-name map in the migrator; and dated reports with their twin. They go last because each touches tenants' data or third-party clients. **The twin obligation enters with I21 and I26**; until then every page without a twin counts in the meter's baseline, which only lowers, starting with the 23 reports of this investigation. This page and the governing document already comply: English source and Spanish twin with `source_sha`.

**J0 is born English**: `jurisdictionOf`, `JurisdictionPackage`, `legal_parameters`, `src/jurisdictions/`. The first step of J0 was renamed to English on its own branch before merging (PR #140, 2026-09-07, at the reviewer's request): the cheapest rename of the whole plan.

## What the owner decides

Already decided: everything into English at origin, including comments, commits, documentation, dated reports, persisted vocabulary, published contracts and migrations; the whole user experience — the CLI help included — adjusts to the user's language with Spanish first; domain terms are translated and only proper names stay. And only two languages for now, `es-MX` and `en-US`. Remaining: the lint's scope from day one.

## Further reading

- [[Jurisdicciones]] — the other dimension that runs through all the code, and which this change renames.
- [[Catalogo-de-comandos]] — why canonical command names stay English with Spanish aliases.
- [[Como-contribuir]] — where the language rule lives.
