Issue: #1068

## Goal

The year closes into the client's own equity accounts, a soft-closed month takes only what the firm says, the annual seal waits for the year's work and its three attestations, a void lands on the right day, and a hand entry points at its voucher.

## Tranche and context

- **Tranche:** new, from the standards review of 27 Nov 2026 (report 01, findings G05, G07, G08, G14, G21). PRD-003 RF-50 and RF-51 had no task.
- **Why now** (`develop` `e9a327d0`):
  - **The sweep is tied to three codes.** `generateClosingEntries` looks for 3900, 3200 and 3300 by literal (`period-close.ts:1986-1987`). Without them it logs and does not sweep (`:2020`), and the seal dies later with `RESULTADO_SIN_BARRER` (`:2246`), which names the income accounts and not the cause.
  - **Soft close refuses nothing.** A `soft_close` period takes any entry with a warning (`validation.ts:180-181`; `posting.ts:243`, `:591`).
  - **The annual seal asks nothing.** `CLOSE_CHECK_CODES` has no box for the year's revaluation or accruals, and none for an attestation (`period-close.ts:56-78`). The corpus says so for going concern (`src/ai/docs/nif-marco.md:37-52`).
  - **`entry void` dates its mirror with the process clock** (`posting.ts:881`; `:790` for a reversal with no date). `entry reverse` uses the entity's day and takes `--date`. With the process in UTC, a void typed at 18:30 on 31 January in Mexico City books the mirror on 1 February.
  - **A hand entry has no voucher.** Only an entry born from a document carries its CFDI (`polizas-service.ts:75-77`); catalogue row `entry support add` is ❌.
- **What is sound and stays:** immutability (migrations 041, 058), reversal instead of edit, the period lock against a concurrent close, the sweep by sign, period 13.
- **The norms.** NIF A-2, in force from 2026, NIF B-13 and NIF B-10 as the corpus states them (`nif-marco.md:37`, `nif-registro.md:201`, `:209`); the 26 % triennial figure is to verify against the standard. CFF art. 28 and RCFF art. 33 for the voucher (`pending-catalog.ts:2983`; the fraction, and Código de Comercio art. 33, to verify against the official text).
- **Forks** (ADR-0006):
  - `soft_close_posting`: `adjustments_and_engines` (default, conservative: what a soft close promises), `anything_with_warning` (today) or `nothing`.
  - `year_seal_attestations`: `require` (default, as `year_seal_with_unsealed_months`, `pending-catalog.ts:1822`) or `warn`.
  - *Which account is which in the sweep:* data, by role. *The void date:* the entity's day. No key.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-867 | The annual close finds its three equity accounts by role | 250 | — | S |
| MNE-001-868 | A panel key says what a soft-closed period takes | 200 | — | S |
| MNE-001-869 | The annual seal waits for revaluation, accruals and three signed attestations | 300, two parts | MNE-001-957 | S |
| MNE-001-875 | `entry support`: a hand entry links its vouchers and the pólizas XML declares them | 350 | — | S |
| MNE-001-876 | `entry void` dates its mirror with the entity's day and takes `--date` | 80 | — | S |
| MNE-001-950 | drafted by reviewer 06 | — | — | — |
| MNE-001-951 | `period lock` and `period unlock` (report 01's P7), drafted by reviewer 06 | — | — | — |
| MNE-001-957 | Monthly checklist boxes for FX revaluation and provisions, drafted by reviewer 06 | — | — | — |

## Acceptance criteria

- [ ] (P6) Given a client whose result of the year lives in 304.01 with the role pointed at it, the sweep of 1,700.00 lands there; an entity seeded today closes to the same figures as before.
- [ ] (P6) Given a missing role, the seal is refused naming the role and its remedy.
- [ ] (P8) Given March in soft close and the default, a `standard` entry dated 31 March is refused by key; an `adjusting` one and `closing fx revalue` post.
- [ ] (P9) Given a year with no attestation, or a month without its revaluation or accruals, the seal of period 13 is refused naming what is missing; with the three signed, it seals.
- [ ] (P9) An attestation row is never edited, and the agent cannot sign one.
- [ ] (P16) `entry support add <entry> --cfdi <uuid>` links a posted hand entry; `entry support list --missing` names those with none; the pólizas XML declares the `CompNal` and validates against the official XSD.
- [ ] (P18) Given the 18:30 case with the process in UTC, the mirror is dated 31 January; `--date 2026-01-15` dates it that day; a sealed period refuses as today.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | The void route takes a date (P18); `docs/openapi.json` regenerated |
| SAT/IMSS deliverables | compatible | Hand entries gain their `CompNal` (P16) |
| Schema (migration) | compatible | P6: a data migration seeding three roles; P9: an append-only table; P16: a table beside the ledger |
| CLI surface | compatible | Three roles; `closing attest`; `entry support`; `entry void --date`. P8 changes a default: named in its PR |

## Out of scope / later

- The NIF B-10 test computed from the INPC series (report 01 P11, G20), after MNE-001-306.
- A database trigger refusing a `posted` row in a sealed period (P19, G22).
- A report of entries booked after the RCFF art. 33 deadline (P20, G23).
- NIF warnings stored with the entry (RF-25, G24); a master for dimensions (RF-04, G25).
- Existing and unchanged: MNE-001-348 (irregular first year, G29), MNE-001-347 (legal reserve, G30), MNE-001-289 (G31), MNE-001-624, 625 and 820 (G32), MNE-001-750 (G33).

## How to test

- **Unit:** the role reader; the soft-close rule per entry type and origin; the date of the mirror with a fixed clock and zone.
- **Integration:** a year sealed with roles on the client's accounts; the seal refused and then accepted; the pólizas XML against the XSD.
- **Edge cases:** a re-closed period 13 under each `cierre_recierre_de_periodo_reabierto` value; an attestation for the wrong year; a void in a month already sealed.

## Classification

- **Difficulty:** D3. **Autonomy:** A3: `posting.ts`, `validation.ts`, `period-close.ts` and three migrations.
- **Size:** P6 ~250; P8 ~200; P9 ~300 + ~300; P16 ~350; P18 ~80. One PR per part («Part of #N»).

## Constraints

- No migration rewrites a posted closing entry.
- The immutability trigger of migration 041 is not touched: supports and attestations live in their own tables.
- Invariant 1: the agent neither signs an attestation nor posts.

## Depends on

- MNE-001-957 for P9. MNE-001-951 gives `locked` its writer; P9 does not wait for it.

**Para el dueño:** hoy el cierre anual manda el resultado a tres cuentas sembradas (3900, 3300, 3200) aunque el cliente lleve las suyas; un mes en cierre suave acepta cualquier póliza; el ejercicio se sella sin que nadie firme negocio en marcha, hechos posteriores ni el entorno inflacionario; anular una póliza de noche puede dejar el espejo en el mes siguiente, y una póliza manual no puede ligarse a su CFDI. Con esto cada punto queda atendido. Cambia un comportamiento: en cierre suave, por omisión, sólo entran ajustes y motores.

---
_Generated by [Claude Code](https://claude.ai/code)_
