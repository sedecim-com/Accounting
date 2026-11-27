Addendum to issue #123

## Goal

After J0, a United States entity says what it is for federal tax and in which states it operates, and its close shows only its own boxes.

## Tranche and context

- **Tranche:** J0 (this issue), from the standards review of 27 Nov 2026 (report 09, section 4).
- **Why now** (`develop` `e9a327d0`):
  - **The entity door fixes everything by country.** `COUNTRY_PROFILES.USA` writes `corporation`, `us_gaap`, `ein`, USD (`entity-service.ts:66-75`, `:378-394`). The `entity_type` CHECK has no S corporation (`001_core_schema.sql:81-82`). `entity create` has no flag for type, classification, state or standard (`entity-command.ts:232-242`), and accepts `--tax-regime 601` on a United States entity.
  - **MNE-001-334 cannot be built as written:** it provisions «según entity_type (C-corp)» and skips «pass-through (S-corp, partnership)».
  - **The close checklist is Mexican for everyone.** Box 7 measures the SAT grouping code with no jurisdiction guard (`period-close.ts:1272-1288`); five more boxes are of Mexican law (`:92-112`). `ptu close` fails on a missing role instead of on the jurisdiction (`ptu.ts:131-136`).
  - **The `books` axis has no reader:** `jurisdictionOf().books` is read nowhere outside its module. Statements (MNE-001-343), the prompt (MNE-001-360) and validation messages ignore the standard.
  - **The panel:** all 103 keys are seeded to every tenant (`policy-service.ts:85-117`); the design table of `docs/jurisdicciones.md` §3.3 classifies 39.
- **What already fails closed, and is right:** the Anexo 24 files, DIOT, the IVA and ISR workpapers, cash-basis IVA, REP expectations, benefit provisions.
- **The norm.** Entity classification: Treas. Reg. 301.7701-3 (to verify against the official source before the column's values are fixed).
- **Forks:** none. The classification is a fact of the entity, not a criterion.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-994 | The United States entity door: type, federal tax classification and states | 300 | — | S |
| MNE-001-995 | The close checklist and the commands of Mexican law ask the entity's jurisdiction | 200 | — | S |

Existing tasks stay, with the edits of `09-us-accounting-edits.md`: 324 (index migration), 325 (103 keys, amount keys), 329 (accounts it must and must not bring), 330 (the flag), 331 (a sixth predicate).

## Acceptance criteria

- [ ] (U7) Given `entity create --country USA --entity-type llc --tax-classification partnership --state TX`, the three values are stored, shown by `entity show` and changed by `entity edit` with an audit row.
- [ ] (U7) Given a United States entity, `--tax-regime` and `--minimum-wage-zone` are refused.
- [ ] (U7) Given no classification, the entity is created as today and a warning says what is missing.
- [ ] (U8) Given an entity that does not keep Mexican books, `closing check` lists none of `sat-agrupador-missing`, `rep-parked`, `rep-missing`, `fees-without-withholding`, `withholding-accounts-layout`, `sat-census-missing`.
- [ ] (U8) Given that entity, `ptu close` refuses naming the jurisdiction.
- [ ] (U8) A Mexican entity keeps its checklist line by line (equality test).

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | New optional entity fields |
| SAT/IMSS deliverables | none | — |
| Schema (migration) | compatible | U7: new columns with a CHECK; the owner approves |
| CLI surface | compatible | New flags on `entity create` and `entity edit`; fewer boxes on a non-Mexican close |

## Out of scope / later

- An entity with country US and books `mx_nif`, and a third country: the two predicates disagree there; no door creates either today (PRD-003 RF-10).
- United States boxes on the checklist: each engine brings its own.
- A reader of `books` in validation messages.

## How to test

- **Unit:** the checklist builder with a Mexican and a non-Mexican entity.
- **Integration:** beside `jurisdiction-predicate.int.spec.ts` and `entity-service.spec.ts`.
- **Edge cases:** an LLC with no election; a change of classification mid-year.

## Classification

- U7: D3 / A3 (migration), 300 lines. U8: D3 / A3 (`period-close.ts`), 200 lines.

## Constraints

- «Ante la duda, mexicana» is untouched: an absent country stays Mexican.
- No key renamed, no reader changed for a Mexican entity.

## Depends on

- Nothing. U7 comes before MNE-001-334; U8 can come before or after J0.3.

**Para el dueño:** hoy toda empresa de Estados Unidos nace como «corporation» y no hay dónde decir que es una LLC, una S corporation o una sociedad de personas, ni en qué estados opera; sin eso la provisión de impuesto no sabe a quién aplicarse. Y su cierre mensual enseña en rojo el código agrupador del SAT. Estas dos tareas lo arreglan. La migración de las columnas nuevas es tuya.
