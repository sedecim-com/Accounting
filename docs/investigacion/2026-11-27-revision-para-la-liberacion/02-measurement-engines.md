# 02 · Measurement engines — NIF series C and D against the code

Reviewer slug: `02-measurement-engines` · a checkout of the repository at `e9a327d0` (origin/develop, 27 Nov 2026) · read-only.

Measured here, not quoted: `npm run -s plan:status` → 14 of 16 packages green, 261 criteria (red: E4.2 one criterion, E5.1 two). `npm run -s catalogo:estado` → 298 commands, 81 families, 282 of 1651 catalogue rows invocable (the command rewrote its block byte-identical; `git status` clean afterwards).

Method: read `src/services/accruals/*`, `src/services/assets/*`, `src/services/payroll/common/gl-posting-service.ts`, `src/services/accounting/{closing-conductor,fx-revaluation}.ts`, `src/services/reporting/report-service.ts` (FX scope), `src/services/policy/pending-catalog.ts`, migration `003`, `docs/command-manifest.json`, `docs/backlog/PRD-001.json`, PRD-003 §4 and §8, ADR-0006, and the agent manuals `src/ai/docs/nif-*.md` and `niif-*.md`. Nothing was executed against a database except `plan:status`. Every "wrong" below is by reading the code path, with the failing case written out; none was reproduced by running.

Legend — engine status: **E** engine exists (computes and posts), **R** register only, **M** manual entry only (an accountant can post it with `entry create`, nothing helps), **A** absent (schema or account at most). Class: **R** blocks release, **S** should be in the release, **C** could wait, **N** out of scope by owner decision.

---

## 1. Norm list, code, manuals, backlog

Norm numbers and paragraph families are taken from the repo corpus (`src/ai/docs/nif-registro.md`, `nif-validaciones.md`, `niif-pymes-convergencia.md`, `niif-activos.md`, `niif-pasivos-empleados-impuestos.md`, `ifrs-registry.json`). The CINIF book is paid; the corpus says so itself. Anything marked «(to verify)» comes from memory and must be checked against the official text.

| # | Norm (IFRS pair) | What the code does today | Status | Manual tells the truth? | Backlog | Class |
|---|---|---|---|---|---|---|
| 1 | **NIF C-1** efectivo y equivalentes (IAS 7) | Bank accounts, statements, reconciliation; FX cash revalued at close. No flag for restricted cash or cash equivalents. | E (banking; another reviewer) | n/a | — | C |
| 2 | **NIF C-2 / C-20** inversión en instrumentos financieros, IFCPI (IFRS 9) | Nothing: no instrument register, no effective interest, no fair value. | M | Corpus describes the norm only | no task | C |
| 3 | **NIF C-3** cuentas por cobrar (IFRS 9) | AR subledger: `invoice *`, `receipt *`, `credit-note *`, `ar reconcile`, `report aged-receivable show --as-of` (MNE-001-648 done). **No write-off**: enum `InvoiceStatus.UNCOLLECTIBLE` (`src/types/index.ts:106`) has no writer; `customer-service.ts:51` describes a write-off nobody performs. | E recognition · A write-off | `cli-reference.md:4169` shows `customer archive … "Uncollectible balance already written off"` — no command writes it off | AP as-of MNE-001-649 (w4 open), reconcile as-of MNE-001-650 (w4 open), MNE-001-758 (w4 open). Write-off: **no task** (PRD-003 RF-05c) | S |
| 4 | **NIF C-16** deterioro de IFC / pérdidas crediticias esperadas (IFRS 9 §5.5) | Account 1129 seeded (`chart-seed.ts:82`). No engine, no matrix, no command. | A | `nif-registro.md` §C-3 says "propón, no impongas" — true; the engine table omits the row | MNE-001-337 is the **US** CECL only (w4, Could, parked by D-03). MX: **no task** (RF-27) | S |
| 5 | **NIF C-4** inventarios (IAS 2) | Tables `inventory_items/layers/layer_consumption` (migration `003:225-275`) with **no reader or writer**; costing module was deleted (S0.4). Panel key `lleva_inventarios` (`pending-catalog.ts:393`, default `directo`) only decides whether the CFDI classifier offers account 1140 (`cfdi-classifier.ts:283-290`). No item master, no cost formula, no cost of sales on `invoice issue`, no NRV test. Schema CHECK still admits `lifo` (`003:232`), which neither C-4 nor IAS 2 admits (corpus, `nif-registro.md` §C-4). | A (classification switch only) | **Misleading**: §C-4 says "Venta: además del ingreso, Cargo Costo de ventas · Abono Inventarios" as if it happened; the engine table ("Lo que este sistema devenga…") has no inventory row | **no task** (RF-06, RF-31) | S |
| 6 | **NIF C-5** pagos anticipados | `prepaid create|list|run|show`, closing step `amortize-prepaids`; adopts a balance already in 1160, frozen convention, gap report, close gate. Keys `amortizacion_anticipados_convencion`, `umbral_anticipado_mxn`, `amortizacion_faltante_al_cierre`. **No cancel / early termination**: `status='cancelled'` is read in eight places and written by none. | E | True | cancel: **no task** | S |
| 7 | **NIF C-6** propiedades, planta y equipo (IAS 16) | Register `asset create`, `asset category seed` (six LISR art. 34 classes, max rates in `legal_parameters`, migration 088); engine `depreciation run|post` and closing step `depreciate-assets`; methods straight line, DB 150/200, SYD, MACRS, units of production (`depreciation-math.ts`). Keys `base_depreciacion`, `convencion_primer_mes`, `depreciacion_faltante_al_cierre`, `umbral_capitalizacion_mxn`. See §2 for the four defects. | E alta + depreciation · A everything after | §C-6 describes components; the engine has no parent/child. Table has no row for disposal | **no task** for disposal (RF-05a), edit, list/show, components, UoP capture | **R** |
| 8 | **NIF C-8** intangibles (IAS 38) | No class: only the six tangible classes can be seeded and there is **no `asset category create`** (single `INSERT INTO asset_categories` at `asset-service.ts:228`). No intangible account in the base chart (the CLI help example creates `1250` by hand). Amortization therefore manual. | M | Norm only; no claim | **no task** | S |
| 9 | **NIF C-9** provisiones, contingencias, compromisos (IAS 37) | No register, no review at close. Manual draft. | M | True ("no registres sin confirmación") | **no task** (RF-27) | C |
| 10 | **NIF C-10** derivados y coberturas; **C-12** instrumentos con características de pasivo y capital | Nothing. | M | Norm only | no task | C |
| 11 | **NIF C-11** capital contable | Earned vs contributed capital presented (MNE-001-651/652 done). Warning `nifSubstance` on manual equity entries. No legal-reserve proposal at year end, no dividend flow. | M + warning | True | no task | C |
| 12 | **NIF C-15** deterioro de activos de larga duración (IAS 36) | Nothing; no accumulated-impairment account in the base chart. | M | True, but no table row | **no task** (RF-27) | C |
| 13 | **NIF C-18** obligaciones de retiro; **D-6** capitalización del RIF (IAS 23) | Nothing. D-6 also waits in the corpus (MNE-001-424 open, Could). | M | Norm only | corpus: MNE-001-424 | C |
| 14 | **NIF C-19** pasivos financieros (IFRS 9) | AP subledger and payments only. No loan with schedule, interest accrual or current/non-current split. A foreign-currency loan is not revalued (see #21). | M | Norm only | **no task** (RF-07) | C |
| 15 | **NIF D-1** ingresos por contratos (IFRS 15) | Revenue at `invoice issue`; customer advances to 2150 with VAT at collection (MNE-001-421…462, 515, 549, 558, 572-574, 592 done); time-based contract liability 2158 with `deferred-revenue create|run` and closing step `recognize-deferred-revenue` (MNE-001-299 done). Warning `nifSubstance` on revenue credited in an "anticipo" entry. No performance-obligation allocation, variable consideration or progress measurement. | E for point-in-time, advances and straight-line over time | True | MNE-001-852 (w4 open: list/show/gap), MNE-001-525 (w4 open: Apéndice 6 procedure B) | S (852) · C (rest) |
| 16 | **NIF D-2** costos por contratos | Nothing. | M | True | no task | C |
| 17 | **NIF D-3** beneficios a empleados (IAS 19) — short term | `payroll accrue`, closing step `accrue-benefits` (`provisions-run.ts`, `provisions-math.ts`): aguinaldo, vacaciones, prima vacacional per worker per day, one posted entry per run to 6116 / 2202-2204 by role. Keys `provision_base_salarial`, `devengo_vacaciones`, `dias_aguinaldo`, `prima_vacacional_pct`, `provision_cuotas_patronales`. **The liability is never released** — §2.1. | E accrual · A release | True as far as it goes; silent on release | **no task** | **R** |
| 18 | **NIF D-3** — PTU causada | `ptu close` (`ptu.ts`, MNE-001-298 done): three captured figures (LISR art. 9), rate from `legal_parameters` `ptu.rate`, draft in period 13 against roles `ptu_gasto`/`provision_ptu`, net of the year's credits. **`ptu.rate` is not seeded**, so it refuses in every installation. Gross of the per-worker caps of LFT art. 127 fr. VIII (declared in the header). | E, fail-closed today | **False**: `nif-registro.md:176` says "Cuenta sembrada (2205) y SIN motor"; `nif-validaciones.md` lists "Provisiones (aguinaldo, PTU, garantías)" under what the system does not do | MNE-001-854 (w4 open, Must: seed the rate), MNE-001-849 (w4 open, Should: monthly 1/12), MNE-001-850 (w4 open, Should: annual ISR paper feeds it) | **R** (854) |
| 19 | **NIF D-3** — PTU diferida; long term and termination (prima de antigüedad LFT 162, indemnizaciones) | Nothing. Declared out of scope in every schedule row (`provisions-run.ts:metadatosDeProvision`). Finiquito calculator pays them (payroll reviewer). | A, declared | True ("Fuera de alcance, declarado") | **no task** (RF-27: import an external actuarial valuation) | C |
| 20 | **NIF D-4** impuestos a la utilidad (IAS 12) | Accounts 1310 and 2300 seeded. No engine: no current-tax provision at year end, no temporary differences, no rate reconciliation. Only one depreciation schedule is ever computed (`pending-catalog.ts:176-177`), so the main temporary difference has no data. | A | True ("Cuentas sembradas… se propone como borrador") | MNE-001-300 (w4 open, Must, v1.0: captured ISR causado + diferido from declared differences), MNE-001-850 | **R** (300) |
| 21 | **NIF B-15** on monetary items (in this domain only for scope) | `closing fx revalue` revalues roles `cxc`, `cxp`, `banco` and bank GL accounts only (`report-service.ts:2036-2041`). Customer advances stay historical, which matches the Mejoras 2027 project text in the corpus. Any other foreign-currency monetary balance (a loan, an intercompany account, sundry creditors) is not revalued. MXN functional only (RF-49). | E, partial scope | `nif-registro.md` §B-15 says "partidas monetarias (bancos, clientes, proveedores…)" — matches | **no task** for the scope | S |
| 22 | **NIF D-5** arrendamientos (IFRS 16) | Nothing. Rent is an expense. | A | True ("Sin motor") | **no task** (RF-07) | S |
| 23 | **NIF D-8** pagos basados en acciones | Nothing. | M | Norm only | no task | C |
| 24 | **IFRS 9, 15, 16; IAS 2, 12, 16, 19, 36, 37, 38** as a second book | No book dimension on `journal_entries`; `parallel_book_standard` does not exist in `src/` (grep: 0). D-01 was answered (capability, default `none`, MNE-001-529) and has no implementation task. No NIF registry (only `ifrs-registry.json`, 74 entries), no norm→engine matrix. | A | The `niif-*.md` manuals describe norms and never claim an engine | RF-01, RF-23, RF-29…RF-33: **no task** (PRD-003 §8 says so; still true) | C (RF-23 matrix: S) |
| 25 | US: ASC 740, ASC 326 | — | A | — | MNE-001-334, MNE-001-337 (w4, Could) | **N** (D-03, parked) |

---

## 2. Defects: code that produces a wrong figure

### 2.1 Benefit provisions are accrued and never used (NIF D-3) — R

- Accrual: `runMonthlyProvisions` debits role `provision_prestaciones_gasto` (6116) and credits `provision_aguinaldo` / `provision_vacaciones` / `provision_prima_vacacional` (2202/2203/2204), auto-posted (`provisions-run.ts:107-110`, `:702`). `closing run` calls it every month as its first step (`closing-conductor.ts:87`, `:880`).
- Payment: the pay-run entry debits the bucket `wages_expense` (6110) for the **whole gross** of the run (`gl-posting-service.ts:243`) and credits cash and withholdings. The bucket map has no provision bucket (`payroll-account-mapping-seed.ts:132-142`).
- The four provision roles are named in exactly one service file (`grep -rn provision_aguinaldo src` → `provisions-run.ts` plus seeds and taxonomy). Nothing debits 2202-2204, in the pay run or in the finiquito.
- **Failing case.** One worker, daily salary 1,000.00, 15 days of aguinaldo, employed all year. Twelve `closing run` post 15,000.00 to 6116 / 2202. The December pay run with the aguinaldo posts 15,000.00 to 6110 / cash. Year result carries 30,000.00 of aguinaldo; 2202 shows 15,000.00 owed that was paid. Same for vacation pay and the premium, and for the finiquito of a worker who leaves.
- Comments in `finiquito-math.ts:240-265` show the intent ("la provisión de doce meses … extingue lo que el finiquito liquida") was aligned in arithmetic and never wired in the ledger.
- Backlog: no task. RF-47 (pay-run entry recognises accrued pay) is the nearest requirement and has none.

### 2.2 An asset can never leave the register (NIF C-6) — R

- `fixed_assets.status` admits `disposed`, with `disposal_date`, `disposal_amount`, `gain_loss_amount` (migration `003:182-186`). The only `UPDATE fixed_assets` in `src/` is `refreshAssetCard` (`depreciation.ts:306`), which touches accumulated depreciation and book value. No command edits, retires, sells or deletes an asset: the manifest has `asset create` and `asset category seed` and nothing else.
- The run takes every `status = 'active'` asset (`depreciation.ts:429`) and `closing run` posts it (`closing-conductor.ts:919`).
- **Failing case.** A vehicle of 489,000.00 registered in January 2026 is sold in June. From July on every `closing run` posts its depreciation. Reversing each entry does not help: the following month posts again, and since MNE-001-646 the reversed month counts as pending in the close checklist and is re-posted when it is run. A cost typed wrong at `asset create` has the same fate. The only way out is SQL.
- Backlog: no task (PRD-003 RF-05a names it, "Sin tarea todavía").

### 2.3 Units of production: accepted at registration, never depreciable, and it stops the close — R

- `asset create --method units_of_production` is accepted (`asset-command.ts:172-187`, the six enum values).
- The monthly run pushes an error for that asset: "la corrida mensual no tiene de dónde leer la producción del periodo. Su renglón se captura aparte" (`depreciation.ts:478-484`). No command captures it.
- A step with errors is `failed` (`closing-conductor.ts:923`) and a failed step ends the run (`:1127-1130`). With 2.2, the asset cannot be changed either.
- **Failing case.** One asset registered by units of production → `closing run` fails at `depreciate-assets` every month for that entity.
- Backlog: no task.

### 2.4 One depreciation book, and the tax rate offered to any NIF entity (NIF C-6, NIF D-4) — S

- `base_depreciacion` chooses `vida_util_nif` or `tasa_lisr`; "Only ONE schedule is computed and posted" (`pending-catalog.ts:176-177`). The other basis is not kept as `schedule_type='tax'` or `'projected'`, although the table allows both.
- Consequences: no book-versus-tax difference per asset for NIF D-4 (MNE-001-300 will have to take it by capture) and none for the annual ISR paper (MNE-001-850 lists it as a captured item). PRD-003 RF-31 already says the option "depreciar a la tasa fiscal" must be reviewed against each norm.
- The LISR side of the schedule (INPC update of the deduction, the vehicle ceiling) is the fiscal reviewer's; this engine does neither.

### 2.5 The register does not tie to the ledger (NIF C-6) — S

- No opening accumulated depreciation at `asset create` (`DatosDeAlta`, `asset-service.ts:289-320`). An asset three years old gets the right monthly amount (the index is calendar months since service) but its card shows only what this system posted (`refreshAssetCard`).
- One accumulated-depreciation account, 1290, for every class; no `asset list|show`, no register-versus-control-account check, unlike `ar reconcile` / `ap reconcile`.
- Land and construction in progress cannot be registered: CHECKs demand `useful_life > 0` and `cost > salvage`, and there is no class.

### 2.6 Schedules that cannot be stopped (NIF C-5, NIF D-1) — S

- `prepaid_expenses.status = 'cancelled'` has no writer; the amortization run does not re-check the backing balance. An insurance policy cancelled in month 4 keeps amortizing through month 12, and the same for a deferred-revenue contract that ends early.

### 2.7 PTU (NIF D-3) — R until MNE-001-854, then S

- `ptu close` refuses everywhere today: `legalParameterAt('MX','ptu.rate', …)` has no row (`ptu.ts:PTU_RATE_KEY`; seed and migrations carry none). MNE-001-854 covers it.
- The provision is gross of the caps of LFT art. 127 fr. VIII (three months of salary or the three-year average, per worker — to verify against the text). For a profitable entity with few workers the draft overstates the liability. The header says it; the draft does not let the accountant enter the capped figure.
- `provisioned` reads `credit_total` of the provision account for the year (`ptu.ts`, `queryTrialBalanceRows`). Once MNE-001-849 posts monthly accruals, a reversed accrual would still count as provisioned unless that query nets reversals. To check when 849 is planned.
- PTU diferida: absent, declared.

### 2.8 Smaller, by reading

- Daily salary = annual / 365 is a constant shared with the finiquito (`finiquito-math.ts`, `DIAS_PARA_SALARIO_DIARIO`); the comment itself says many firms use 360. Under the owner's rule of 17 Nov this is an accepted-practice fork with no panel key. C.
- Accrued vacation is not re-measured when the salary changes; no social charges on accrued benefits; no suspension days (declared). C.
- A month of depreciation skipped and then hard-closed is lost to the engine (the catalogue designs `depreciation recover`; it does not exist). C.

---

## 3. Panel keys (ADR-0006) in this domain

Present, each with a reader: `base_depreciacion`, `convencion_primer_mes`, `depreciacion_faltante_al_cierre`, `umbral_capitalizacion_mxn`, `lleva_inventarios`, `amortizacion_anticipados_convencion`, `amortizacion_faltante_al_cierre`, `umbral_anticipado_mxn`, `deferred_revenue_recognition_convention`, `provision_base_salarial`, `devengo_vacaciones`, `dias_aguinaldo` (legal floor), `prima_vacacional_pct` (legal floor), `provision_cuotas_patronales`, `closing_exchange_rate_source`, `fx_revaluation_reversal` (one option), `pago_corto_residual`, `received_credit_note_cost`.

Present with a reader that does nothing: `provision_ptu_mensual` (`provisions-run.ts:215`, waits for MNE-001-849).

Missing, and needed by the tasks proposed below (default = conservative):

| Key (proposed) | Options | Default | Needed by |
|---|---|---|---|
| `benefit_payment_against_provision` | `consume_provision` / `expense_on_payment` (only valid if the entity does not accrue) | `consume_provision` | N-01 |
| `asset_disposal_month_depreciation` | `through_month_before` / `through_disposal_month` / `pro_rata_days` | follows `convencion_primer_mes` | N-02 |
| `inventory_cost_formula` | `promedios` / `peps` / `costos_identificados`; UEPS refused with the C-4 citation | none: asked before the first movement | N-08 |
| `inventory_period_end_method` (for `directo`) | `no_adjustment` / `count_and_adjust_draft` | `count_and_adjust_draft` | N-07 |
| `expected_credit_loss_method` | `aging_matrix` / `individual` / `none_declared` | `aging_matrix`, draft only | N-06 |
| `ptu_provision_cap` | `gross` / `captured_capped_amount` | `captured_capped_amount` when given, else gross with a finding | N-12 |
| `daily_salary_divisor` | `365` / `360` (one constant for accrual and finiquito) | `365` (what the finiquito pays today) | N-15 |
| `lease_short_term_exemption`, `lease_low_value_exemption` | PRD-003 RF-07 already names them | apply exemption = no | N-16 |

`parallel_book_standard` and `parallel_book_adjustment_posting` (MNE-001-529) are decided and not in the catalogue.

---

## 4. Do the agent's manuals tell the truth?

| Manual, place | Says | Code | Verdict |
|---|---|---|---|
| `nif-registro.md:176` (engine table, PTU) | "Cuenta sembrada (2205) y SIN motor" | `ptu close` exists since MNE-001-298 | **False (stale)** |
| `nif-registro.md` §D-3, PTU bullet | "NO cae en la corrida mensual… ver la tabla de abajo" | same | stale by reference |
| `nif-validaciones.md`, "Lo que el sistema NO valida solo" | Provisions (aguinaldo, PTU, garantías) and multi-year accrual are left to judgement | `payroll accrue`, `ptu close`, `prepaid *`, `deferred-revenue *` exist | **Stale** for four of the items |
| `nif-registro.md` §C-4 | Sale: "Cargo Costo de ventas · Abono Inventarios" | no engine posts it | **Misleading**: norm stated as behaviour; table has no row |
| `nif-registro.md` engine table | rows for anticipos, prestaciones, PTU, prima de antigüedad, diferidos, arrendamientos, partes relacionadas, ORI, capital ganado | — | **Incomplete**: no row for inventories, asset disposal, impairment (C-15), expected credit losses (C-16), intangibles (C-8), provisions (C-9), loans (C-19), deferred revenue (D-1) |
| `nif-registro.md` §D-3 aguinaldo | "El sistema lo hace: `runMonthlyProvisions`…" | true for the accrual; nothing says the payment does not consume it | **True and incomplete** (defect 2.1) |
| `nif-registro.md` §C-6 | components depreciated separately | no component model | norm only; table should say "sin componentes" |
| `nif-registro.md` D-4, D-5, C-13 rows | no engine | none | True |
| `nif-registro.md` §C-5, §D-1 deferred revenue | engine and commands | match | True |
| `cli-reference.md:4169` | example reason "Uncollectible balance already written off" | no write-off | harmless, misleading |
| `niif-*.md` | norms only | — | No claim about engines; nothing false found |

Stale code comment, not a manual: `finiquito-math.ts:245` names account "2196" for the provision; the seeded accounts are 2202-2204.

---

## 5. Proposed new tasks (gaps with no task)

Next free id is above MNE-001-858; the coordinator assigns. Lane letters are the backlog's. Sizes are hand-written lines, each under 400. "AP" = accepted-practice choice (ADR-0006 key with conservative default).

| # | Title (backlog style) | Hang on | Lane | Size | Depends on | Flags | Class |
|---|---|---|---|---|---|---|---|
| N-01 | El pago de aguinaldo, vacaciones y prima vacacional en una corrida o en un finiquito consume su provisión (2202-2204) antes de cargar gasto, y el excedente o el faltante va a resultados | #111 (or new issue under #603) | F | 2 PRs × ~300 | MNE-001-069 | **Critical path** (pay-run entry); AP key `benefit_payment_against_provision`; owner decision on what to do with balances already accrued and paid (a census + correcting draft); no migration expected | R |
| N-02 | Baja de un activo: `asset dispose` registra la venta o el retiro, deja su póliza con la utilidad o la pérdida como borrador y el activo deja de depreciarse (NIF C-6, RF-05a) | new issue under #603 | E | 2 PRs × ~350 | — | AP key for the month of disposal; link to the sale CFDI is a later task; uses the columns of migration 003, no new migration expected | R |
| N-03 | `asset edit` corrige un activo sin renglones posteados, y `asset retire --reason` detiene uno que no debe depreciarse, con su fila de auditoría | same as N-02 | E | ~250 | — | none | R |
| N-04 | Un activo por unidades de producción no detiene `closing run`: se captura su producción del periodo (`depreciation units record`) o el alta lo rehúsa mientras no exista esa captura | same as N-02 | E | ~200 (refuse) or ~350 (capture, with migration) | — | owner picks refuse-now vs capture; migration only for capture | R |
| N-05 | Castigo de una cuenta por cobrar: `invoice write-off` deja su póliza contra la estimación o contra resultados y la factura pasa a `uncollectible`; `--reverse` la reinstala (NIF C-3, RF-05c) | #596 or new under #603 | C | ~350 | — | AP (direct write-off vs allowance); the LISR art. 27 fr. XV deduction test belongs to the fiscal reviewer | S |
| N-06 | Estimación para pérdidas crediticias esperadas: `allowance calculate` propone como borrador el ajuste a la 1129 desde la antigüedad a la fecha, con su cédula (NIF C-16, RF-27) | new under #603 | C | 2 PRs × ~300 | MNE-001-648; N-05 | AP key `expected_credit_loss_method`; rates per bucket are the firm's, captured with source; migration for the matrix | S |
| N-07 | Inventarios, mínimo honesto: el manual y el panel dicen que no hay motor de costo; con `directo`, el cierre anual pide el inventario final contado y propone como borrador su ajuste contra costo de ventas; con `perpetuos`, el checklist avisa de la 1140 sin salidas | new under #603 | E | ~300 | — | AP key `inventory_period_end_method`; no migration | S |
| N-08 | Inventarios y costo de ventas (RF-06): artículos, movimientos y capas; el costo sale por la fórmula del panel al facturar; el auxiliar casa con su cuenta de control; UEPS se rehúsa y `lifo` sale del CHECK | new under #603 | E | plan splits it: ≥6 PRs | N-07 | owner decision (it is ERP-adjacent: D-04 left "almacén" out, PRD-003 §6); migrations; critical path at `invoice issue` | C (S only if the owner wants trading companies served in v1.0) |
| N-09 | La depreciación guarda los dos calendarios: el que rige postea y el otro queda como `schedule_type` sin postear, y `asset book diff` da la diferencia temporal por activo (insumo de NIF D-4 y del papel anual) | #111 | E | 2 PRs × ~300 | — | feeds MNE-001-300 and MNE-001-850; no migration (UNIQUE already includes `schedule_type`) | S |
| N-10 | El registro de activos casa con el mayor: depreciación acumulada de apertura en el alta, `asset list|show`, y `asset reconcile` contra las cuentas de control | new under #603 | E | 2 PRs × ~300 | N-03 | migration (opening accumulated column); no critical path | S |
| N-11 | Clases de activo que no son del art. 34: `asset category create` (intangibles, mejoras a locales arrendados, terrenos sin depreciación), con su cuenta y su vida, y la amortización por el mismo motor (NIF C-8) | new under #603 | E | ~350 | — | relaxes two CHECKs for non-depreciable classes → migration; LISR art. 33 rates enter `legal_parameters` only from their source | S |
| N-12 | Terminar antes de tiempo un anticipado o un ingreso diferido: `prepaid cancel` / `deferred-revenue cancel` lleva el remanente a resultados como borrador y detiene el calendario | #111 | E | ~250 | MNE-001-852 | none | S |
| N-13 | La PTU al cierre admite la cifra con el tope del art. 127 fr. VIII capturada con su fuente, y el borrador dice cuál usó | #111 | E | ~150 | MNE-001-854 | AP key `ptu_provision_cap`; the legal text enters the corpus first (#133 pattern) | S |
| N-14 | La revaluación cambiaria alcanza toda cuenta monetaria en divisa: una marca por cuenta (o más roles) además de `cxc`, `cxp` y `banco` (NIF B-15) | #305 if open, else new | I | ~250 | — | AP (which accounts are monetary is the firm's call per account; default: only the three roles, as today, plus a finding that names foreign balances left out) | S |
| N-15 | El divisor del salario diario (365 o 360) es una clave del panel que leen la provisión y el finiquito | #196 if still open, else new | F | ~150 | N-01 | AP key `daily_salary_divisor` | C |
| N-16 | Arrendamientos (NIF D-5, RF-07): contrato con calendario, derecho de uso, pasivo, interés y depreciación al cierre, con las exenciones como claves | new under #603 | E | plan splits it: ≥4 PRs | — | owner decision on timing; migration | S (PRD-003 Should) |
| N-17 | Manuales: `nif-registro.md` y `nif-validaciones.md` dicen la verdad de los motores (PTU, provisiones, anticipados, ingreso diferido) y la tabla gana una fila por norma sin motor (C-4, C-6 baja, C-8, C-9, C-15, C-16, C-19) | #133 | G | ~120 (docs + reseal manifest) | — | none; do first, it is cheap and the agent reads it | S |
| N-18 | Registro de normas NIF legible por máquina y matriz norma → motor → comando → criterio, con `--check` en CI (RF-23) | #603 | G | 2 PRs × ~300 | N-17 | none | S |
| N-19 | Provisiones de NIF C-9 y deterioro de NIF C-15: registro mínimo y recordatorio en el cierre anual, siempre borrador (RF-27) | new under #603 | E | ~300 | — | AP | C |
| N-20 | Préstamos recibidos con calendario: interés devengado al cierre y porción circulante (NIF C-19, RF-07) | new under #603 | E | ≥2 PRs | N-14 | migration | C |
| N-21 | Beneficios a largo plazo y por terminación: se importa la valuación actuarial externa como borrador con su fuente (NIF D-3, RF-27) | new under #603 | E | ~250 | — | owner decision (today declared out of scope) | C |
| N-22 | Libro paralelo (D-01, MNE-001-529): diseño de sistema y primera tarea con migración | #603 | 0 | design first | PRD-003 approval | owner approval of PRD-003; D4 with migrations | C |

Already covered, keep: MNE-001-854 (R), MNE-001-300 (R), MNE-001-849, 850, 852, 649, 650, 758, 525, 424.

---

## 6. Top findings

1. **D-3 provisions are never consumed.** Accrual posts to 6116 / 2202-2204 every close; the pay run debits the whole gross to 6110 (`gl-posting-service.ts:243`). Aguinaldo, vacation pay and premium are expensed twice and the liability never clears. No task. R.
2. **An asset cannot be sold, retired or corrected.** No writer of `fixed_assets.status`; `closing run` depreciates it to the end of its life, and a reversal is re-posted by the next run. No task. R.
3. **A units-of-production asset stops `closing run`** for its entity every month and cannot be changed. No task. R.
4. **`ptu close` refuses in every installation** until `ptu.rate` is seeded (MNE-001-854, open). R, covered.
5. **No income-tax provision** (NIF D-4): current and deferred both absent; MNE-001-300 open and it will rely on captured differences because only one depreciation book exists. R, covered; N-09 gives it data.
6. **Two manuals are stale about engines** (`nif-registro.md:176` says the PTU has no engine; `nif-validaciones.md` lists four things as manual that have commands) and the engine table omits seven norms with no engine. The agent answers from them. S, no task.
7. **Inventories: nothing behind the switch.** `lleva_inventarios = perpetuos` sends purchases to 1140 with no way out; `directo` never recognises an ending inventory; the manual describes the sale entry as if posted. S, no task.
8. **Receivables cannot be written off and there is no allowance** (C-3, C-16); the `uncollectible` status and account 1129 have no writer. S, no task for Mexico.
9. **The asset register does not tie to the ledger**: no opening accumulated depreciation, no list/show, no reconcile, six classes only (no intangibles, no land). S, no task.
10. **Prepaid and deferred-revenue schedules cannot be cancelled**, and FX revaluation leaves out every foreign monetary balance outside three roles. S, no task.

## 7. Counts

| Class | Gaps | Which |
|---|---:|---|
| R | 5 | provisions never released; asset disposal/edit; units of production stops the close; PTU rate (854); ISR provision (300) |
| S | 15 | AR write-off; ECL; inventory; leases; single depreciation book / `tasa_lisr` per norm; register tie-out; intangibles and classes; schedule cancel; PTU cap; PTU monthly (849); deferred-revenue readers (852); NIF registry and matrix (RF-23); stale manuals; FX revaluation scope; AP aging and reconcile as-of (649, 650) |
| C | 12 | C-15; C-9; long-term D-3 and PTU diferida; D-1 beyond straight line and D-2; C-19 loans; C-2/C-10/C-12/C-18/C-20/D-6/D-8; parallel book and IFRS measurement (RF-01, RF-32, RF-33); C-11 reserve and dividends; salary divisor and re-measurement; depreciation catch-up; C-1 restricted cash; land and construction in progress |
| N | 1 | US ASC 740 and CECL (D-03, parked) |

## 8. Not reviewed

- Nothing was run against a database beyond `plan:status`; the three R defects without a task are by reading, not reproduced.
- The arithmetic of `amortization-math.ts` and `provisions-math.ts` line by line (headers, signatures and callers only); their unit specs were not run.
- `depreciation-plan.ts` and `depreciation post --file` beyond its omission reasons.
- The customer-advance engine (MNE-001-421…592) beyond its existence and its accounts; AR/AP posting (`ar-ap-posting.ts`, `payment-service.ts`) beyond the write-off paths.
- LISR depreciation as a deduction (INPC update, vehicle ceiling, art. 35 rates by activity), cost of goods sold for tax, the bad-debt deduction: fiscal reviewer.
- Payroll calculation, finiquito amounts, statements (B-2, B-3, B-4, B-6), year-end gates (RF-51), B-10, B-15 beyond the revaluation scope, consolidation.
- REST routes; the web board; US engines.
- GitHub: only the open-issue list (first 100 of 110) and #111 were read; issue comments were not.
- The CINIF and IASB texts themselves: every norm statement here is the repo corpus's or is marked «(to verify)».
