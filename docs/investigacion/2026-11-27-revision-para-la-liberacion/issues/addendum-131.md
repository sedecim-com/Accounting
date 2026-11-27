Addendum to issue #131

## Goal

For an entity whose books are US GAAP, the agent states that it has no US GAAP corpus, and does not cite a NIF as its ground.

## Tranche and context

- **Tranche:** N1 (this issue), from the standards review of 27 Nov 2026 (report 09, finding G07).
- **Why now** (`develop` `e9a327d0`): the stable prompt presents the system as «(Mexico NIF / USA GAAP)» and orders every treatment to be grounded in the NIF documents and cited as «NIF D-1» (`src/ai/system-prompt.ts:36`, `:76-83`); `src/ai/docs/system.md:4` promises «MX NIF / US GAAP / IFRS per entity»; `src/ai/docs` has no document of the Codification. The same file already reads the entity's books for the drafting language (`:208`).
- **Failing case.** In a Delaware entity, «how do I record a customer advance?» produces a draft citing NIF D-1.
- **Forks:** none.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-993 | The agent tells the truth about an entity with US GAAP books while its corpus does not exist | 150 | — | R |

MNE-001-355 to 360 stay and rise to Should; 360 removes this notice when the prompt forks by books.

## Acceptance criteria

- [ ] (U6) Given `jurisdictionOf(entity).books = 'us_gaap'`, the stable block says no US GAAP corpus is loaded, forbids citing a NIF as the ground for that entity, asks for confidence under 0.8 on any treatment and for `ask_user`.
- [ ] (U6) `system.md` and the scope line say the same.
- [ ] (U6) The prompt of a Mexican entity is byte for byte today's (test).

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | none | — |
| SAT/IMSS deliverables | none | — |
| Schema (migration) | none | — |
| CLI surface | none | The agent's text only |

## Out of scope / later

- Writing the corpus (MNE-001-355 to 360) and the fiscal document (MNE-001-364).
- Any change to `src/ai/floor.ts`.

## How to test

- `tests/ai/system-prompt.spec.ts`: one case per books value.

## Classification

- D2 / A2, 150 lines, one PR.

## Constraints

- The prompt cache: the notice sits in the stable block, chosen once per session by the entity.

## Depends on

- Nothing.

**Para el dueño:** hoy el agente dice que trabaja con US GAAP y, para una empresa de Estados Unidos, fundamenta sus borradores en las NIF mexicanas, porque no tiene ningún documento de la norma estadounidense. Esta tarea pequeña hace que lo diga con claridad y pregunte, hasta que las seis tareas del corpus lo sustituyan.
