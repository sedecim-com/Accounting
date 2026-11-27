# 01 · Ledger core and financial statements — standards-and-code review

Reviewer slug `01-ledger-statements` · tree: `origin/develop` @ `e9a327d0` (worktree `mplan`) · 27 Nov 2026 · read-only.

Instruments read on this tree: `npm run plan:status` → 14 of 16 packages green, 261 criteria (E4.2 4/5: three copies of the balance SQL outside report-service; E5.1 25/27). `npm run catalogo:estado` → 298 commands, 282 of 1651 catalogue rows invocable (17.1 %); families `report` 8/32, `closing` 7/37, `period` 6/15, `entry` 13/35, `account` 16/21.

Marking: **(corpus)** = the repo's corpus or code carries the citation; **(to verify)** = from memory, must be checked against the official text before anyone acts on it.

---

## 1. What is sound (verified by reading the code)

| Invariant | Where it is enforced | Verdict |
|---|---|---|
| Debits = credits, exact, no tolerance | `validation.ts:64` (rule `balance`, Decimal equality) + DB `CHECK (status != 'posted' OR (total_debits = total_credits AND total_debits > 0))` `001_core_schema.sql:252` + trigger `update_je_totals` `:301` | correct |
| One side per line, positive amounts | `validation.ts` rule 2 + CHECKs `001:284-289` | correct |
| Posted entries immutable (rows and lines), no DELETE, no TRUNCATE | triggers `041_el_mayor_inviolable.sql` (JSONB diff with a whitelist: `reversed_by_entry_id`, `notes`, hash columns; lines: reconciliation marks), `ENABLE ALWAYS` in `058:60-63` | correct |
| Correction by reversal, never edit; void of a posted entry = linked posted mirror, original stays `posted` | `posting.ts:672-756` (`reverseWithinTransaction`), `:851-915` (`voidJournalEntryInTx`); one reversal per entry (`ALREADY_REVERSED`) | correct (NIF B-1 as the corpus states it) |
| Audit row in the same transaction as create / post / reverse / void / close / reopen | `registrarAuditoria` calls in `posting.ts`, `period-close.ts`, `fiscal-calendar-service.ts`; `audit_log` append-only (033, 058) | correct |
| Closed-period protection with race closed | `posting.ts:243` (period lookup excludes `hard_close`,`locked`), `:591` `bloquearPeriodoParaPostear` (`FOR SHARE` vs the close's `FOR UPDATE`), `validation.ts` rule 4 | correct in the application; no DB trigger (gap G22) |
| Folio: atomic per entity and year (`JE-YYYY-N`) | `entity_sequences` (025, 043), `nextEntityNumber`; continuity check in `ledger-checks.ts` | correct |
| Account of another entity refused | `validation.ts:45-56` (`cuentasDeLaEntidad`) | correct |
| FX line: four columns travel together and the conversion is verified (`functional = foreign × rate`, half-up 4 dp); reversal mirrors the origin | `fx/conversion.ts` `verificarOrigenFx`, `posting.ts:262-272`, `:707-715` | correct for lines that carry FX columns (see G02, G03) |
| Hard close: checklist re-read, closing entries, carry-forward in cascade, year closed, all in one transaction | `period-close.ts:1448-1612` | correct |
| Closing sweep by sign (contra-natural accounts handled), residue check blocks by default | `period-close.ts:1853-1890`, `:2218` | correct |
| Period 13 (year-end adjustment, 31 Dec only), December 31 lands in December while open, carry order by `(start_date, period_number)` | `fiscal-calendar-service.ts:543-611`, `period-close.ts:1648-1680`, migration 104 | correct |
| Year created after the seal opens with carried balances | `openFiscalYearOnSealedBooks` `period-close.ts:1745` (MNE-001-644 done) | correct |
| Balance sheet foots unconditionally: unswept result inside equity; contributed vs earned capital | `report-service.ts:1401` (`queryUnclosedEarnings`), `:1459`; CLI exits 4 when it does not foot (`report-command.ts:503-518`) | correct |
| Income statement leaves the closing entries out (panel `informes_asientos_de_cierre`) | `report-service.ts:1538-1560` | correct |
| Cash flow (indirect) ties to cash by construction; residue named by account; `cashflow reconcile` against the ledger | `cash-flow-service.ts:666-735`, `cash-flow-reconcile.ts` | correct as arithmetic; presentation gaps G12 |
| Ledger checks: balances vs lines, declared invariant, chaining, audit trail, year-sweep | `ledger-checks.ts` | correct |
| Realised FX difference at payment; closing revaluation, once per period, reversed on day 1 | `moneda-origen.ts`, `fx-revaluation.ts` (migration 168) | correct inside its scope (see G13) |

---

## 2. Norm list and code against the norm

| # | Norm | What a core system must do | Code today | Verdict | Gap |
|---|---|---|---|---|---|
| N1 | NIF A-1 (2023), cap. 20, dualidad económica (corpus `nif-marco.md`, `nif-validaciones.md`) | Every entry balanced | §1 row 1 | correct | — |
| N2 | NIF A-1 cap. 20, devengación; asociación de costos y gastos | Period of the event; accruals | Period from the entry date; warning (not refusal) on `future` and `soft_close` periods `validation.ts:180-187`; accrual engines exist (prepaids, benefits, deferred revenue, depreciation) | partial | G07 |
| N3 | NIF A-1 cap. 20, consistencia; NIF B-1 cambios contables y correcciones de errores (corpus `nif-registro.md:184`) | Corrections by reversal; prior-year error against retained earnings with retrospective comparatives; policy change retrospective | Reversal engine correct. No comparatives, no restatement, no flow for a prior-year error (a hand entry to 3200 with a warning) | partial | G11, G34 |
| N4 | NIF A-1 cap. 20, negocio en marcha; NIF A-2 (vigente 2026, corpus `nif-marco.md:37`) | Management's assessment recorded at year end | Nothing. The corpus says so: «no hay casilla de cierre que lo atestigüe» | absent | G08 |
| N5 | NIF A-1 cap. 20, valuación / unidad monetaria | Amounts in the currency's unit | Ledger `DECIMAL(19,4)`; functional amounts booked at four decimals; `AMOUNT_RE` admits four (`journal-entry-service.ts:63`); FX conversion keeps four (`moneda-origen.ts:31-36`) | **wrong** for a peso ledger | G01 |
| N6 | NIF B-6, estado de situación financiera (corpus: contributed vs earned capital, B-6/C-11) | Current/non-current, contributed/earned capital, comparative | `getBalanceSheet`: sections by `fs_category`, earned capital total, unswept result; no comparative column; rows at 4 dp | partial | G11 |
| N7 | NIF B-3, estado de resultado integral (corpus: ORI; presentation paragraphs not in the corpus, MNE-001-743 open) | Levels (gross, operating, financing result, before tax, net), ORI, by function or by nature | `getIncomeStatement` returns two blocks, Revenue and Expenses, and a net (`report-service.ts:1699-1743`, `report-command.ts:559-573`). The 3600 ORI account exists and no statement presents ORI movement | partial: the net is right, the statement is not a B-3 statement | G09 |
| N8 | NIF B-4, estado de cambios en el capital contable | The statement | Absent. Catalogue row `statement equity show` ❌. RCFF art. 33-B asks for «variaciones en el capital contable» among the statements the books must produce (to verify); LGSM art. 172 (to verify) | absent | G10 |
| N9 | NIF B-2, flujos de efectivo, direct or indirect | Either method; three activities; opening and closing cash; effect of exchange-rate changes on cash; interest, dividends and income tax shown | Indirect only; direct refused by design (`cash-flow-service.ts:885`). Sections by `fs_category` (`:460-482`): every `current_liabilities` account is working capital, so a short-term bank loan is an operating flow. No line for the FX effect on cash (a revaluation gain on a dollar bank account sits inside net income). Starts at net income; B-2's indirect layout starts before income tax (to verify) | partial | G12, G37 |
| N10 | NIF B-9, información a fechas intermedias | Statements for any interim period | Any `--period`/`--since`/`--until`; no condensed statements or notes | partial, enough for bookkeeping | G35 |
| N11 | NIF B-10, efectos de la inflación: entorno inflacionario = 26 % acumulado en el trienio (corpus `nif-registro.md:201`); «en cada cierre anual se documenta la verificación» | The test, documented each year; restatement when inflationary | INPC series exists (`src/services/fiscal/inpc/`), nobody computes the triennial figure; no attestation | absent | G20 (test), G08 (attestation) |
| N12 | NIF B-13, hechos posteriores (corpus `nif-registro.md:209`) | Adjusting events dated in the closed year; a record of the review | An entry dated 31 Dec lands in period 13 while it is open: adjusting events can be booked. No record of the review | partial | G08 |
| N13 | NIF B-15, transactions (corpus `nif-registro.md:110`) | Historical rate at recognition; monetary items at closing rate; realised difference at settlement; non-monetary at historical | AR/AP/payments: yes. Hand entries, imported entries and the REST route cannot carry FX columns (`journal-entry-service.ts:256-277`, `:475`; no `currency` in `entry-command.ts`, `batch-service.ts`, `routes/journal-entries.ts`). Opening balances carry none; an opening document in another currency is refused (`ar/opening-invoices.ts:176-182`). Revaluation reads only tagged lines of roles `cxc`,`cxp`,`banco` and bank GL accounts (`report-service.ts:2030-2052`) | **wrong** for an entity with foreign balances at migration or booked by hand | G02, G03, G13 |
| N14 | NIF B-15, translation of foreign operations; functional currency other than the peso | Translate; CTA in ORI | Revaluation refuses a functional currency other than MXN (`fx-revaluation.ts:64`); no translation | absent | G26, G27 |
| N15 | NIF B-7, B-8 | Consolidation | Absent. PRD-003 RF-08 is `Could`, without task. No owner decision excludes it; D-02 only defers a third jurisdiction | absent | G27 |
| N16 | NIF C-11 / LGSM art. 20 legal reserve (corpus) | Proposed at year end | Not proposed; account 3150 seeded | absent | G30 (MNE-001-347) |
| N17 | IAS 1 / IFRS 18, IAS 7, IAS 8, IAS 10, IAS 21, IAS 29, IAS 34 | For an `ifrs` entity | No engine reads the entity's standard; the corpus exists for the agent | absent | G28 |
| N18 | US GAAP (ASC 230, comparative statements) | Only where the code claims it | `accounting_standard` admits `us_gaap`; no report reads it; cash-flow header cites ASC 230 only as a title | not claimed in behaviour | G38 (N) |
| N19 | Código de Comercio arts. 33-38 (to verify): integrated records, each operation traceable to its voucher, books in Spanish (art. 37, to verify) | Trace entry ↔ voucher; Spanish | `source_type`/`source_id` for engine entries. A hand entry has only free-text `reference`; `attachments` column has no door; catalogue row `entry support add` ❌. Persisted descriptions of reversals and closing entries are English («Reversal of JE-…», «Year-end closing entries», `posting.ts:705,783`, `period-close.ts:2159`) | partial | G14, G15 |
| N20 | CFF art. 28 fr. I and IV (corpus `pending-catalog.ts:493,1432`), RCFF art. 33 (corpus cites «CFF 28, RCFF 33» at `:2983`) apartado B: analytic entries, within the month and at most five days after the operation (to verify), statements including «variaciones en el capital contable» and the trial balance with memorandum accounts (to verify) | Books, journal, ledger, statements, timeliness | Journal (`entry list/export`), ledger (`report general-ledger show`, `ledger auxiliary show`), trial balance with memorandum accounts doctrine (MNE-001-019 done). No report of entries booked late | partial | G10, G23 |
| N21 | CFF art. 28 fr. IV + RMF Anexo 24: catalogue with código agrupador, monthly balanza, period 13 | Ledger side | Agrupador column, close check `sat-agrupador-missing`, period 13, balanza from the ledger. The seeded chart is born without agrupador; `account map` fills it. Balanza amounts are two decimals and its rounding check is blocking | ledger side correct, except G01 | G01 |
| N22 | CFF art. 30 (corpus SCOPE): keep the books five years | No deletion | Posted ledger cannot be deleted | correct | — |
| N23 | Period locking; closing entry; retained earnings roll | Seal, sweep, roll | Seal and sweep correct. Sweep finds its accounts by the literal codes 3900, 3200, 3300 (`period-close.ts:1986-1987`). Status `locked` is read everywhere and written nowhere (no `period lock`) | partial | G05, G06 |
| N24 | Year-end completeness before the sweep | Revaluation, accruals, tax provision run | `closing run` conducts them as steps; the checklist that `close` and the hard close read has no box for revaluation or for the benefit accrual (`CLOSE_CHECK_CODES`, `period-close.ts:56-78`) | partial | G08, G19 |

---

## 3. Gaps, coverage and class

R = blocks a release for real use · S = should be in the release · C = can wait · N = out by an owner decision.

| ID | Gap | Evidence | Backlog | Class |
|---|---|---|---|---|
| G01 | **Peso amounts are booked at four decimals.** Each FX conversion writes `foreign × rate` at 4 dp into the functional columns (`moneda-origen.ts:34`, used at `ar-ap-posting.ts:181,313,794,1081`). The Anexo 24 balanza declares two decimals and its `redondeo` finding is blocking (`balanza-invariantes.ts:296-312`; `balanza-service.ts:762` refuses to generate). Failing case, run on this tree as a pure-function probe: January, USD 33.35 at 17.1141 → 570.7552; February, USD 5.85 at 17.0950 → 100.0058 on the same account. February's balanza: SaldoIni 570.76 + Debe 100.01 = 670.77, SaldoFin declared 670.76 → blocking, no file. The only way out is a hand adjusting entry of fractions of a cent. Statements and the trial balance also print 4 dp | no task | **R** (entities with any foreign-currency document; MVP β delivered foreign currency) |
| G02 | **A hand entry cannot carry its foreign-currency origin.** `entry create --line`, `entry import`/`batch post` and `POST /v1/journal-entries` have no currency, foreign amount or rate. A dollar loan received, a transfer between own dollar accounts or an adjustment on a dollar receivable is booked in pesos only; the closing revaluation never sees it, and the foreign balance it does compute for that account is short by that movement | no task | **R** (same population as G01) |
| G03 | **Migration loses the foreign-currency origin.** The opening entry has no FX columns; an open receivable or payable in another currency stops the load (`ar/opening-invoices.ts:176-182`, and its AP twin). A client with a dollar bank account opens with pesos only: the revaluation reads `foreign = 0` for the opening and revalues only what was booked later, so the balance sheet at every close misstates that account against NIF B-15. A client with open dollar invoices cannot be migrated at all | no task | **R** (clients with foreign balances at the cut) |
| G04 | An automated `entry_type` typed by a REST client exempts the entry from `allow_manual_entries=false` (`validation.ts:197-200,245`) | **MNE-001-643**, wave 4, Must, open (#593) | **R** (already Must; it lets a control account drift from its subledger) |
| G05 | The annual sweep finds its accounts by the codes 3900/3200/3300. A migrated client whose own chart carries «Utilidad del ejercicio» under another number gets its result in the seeded accounts, which then need their own agrupador and appear in its catalogue | PRD-003 RF-50 (Should), **no task** | S |
| G06 | `locked` is unreachable: nothing writes it. A month whose balanza was filed, or a year whose statements were issued, reopens with a reason like any other (`reopenClosedPeriod`, `fiscal-calendar-service.ts:246`). Catalogue rows `period lock`/`unlock` ❌ | no task | S |
| G07 | A soft-closed month accepts any posting of any type with a warning (`validation.ts:180`); the checklist photographed at soft close goes stale. The hard close re-reads it, so nothing is sealed wrong, but «cierre suave» protects nothing | no task | S (accepted-practice choice: panel key) |
| G08 | The annual seal has no normative gates: no box for the FX revaluation or the benefit accrual of the year, and no signed attestation for going concern (NIF A-2), subsequent events (B-13) or the inflation test (B-10) | PRD-003 RF-51 (Must), **no task** | S |
| G09 | The income statement has no NIF B-3 structure and no ORI | PRD-003 RF-24 (Must), no engine task; MNE-001-743 (corpus only, wave 4, open); MNE-001-365 (corpus, done) | S |
| G10 | No statement of changes in equity (NIF B-4) | RF-24, **no task** | S (RCFF 33-B and LGSM 172 name it, to verify; outside the MVP's own list of statements, `docs/MVP.md:19`) |
| G11 | No comparative column in any statement | PRD-003 RF-02 (Must), no task; MNE-001-343 covers the United States only (Could, parked) | S |
| G12 | Cash flow presentation: short-term debt as working capital, no FX-effect line, interest/dividends/income tax not shown, starts at net income | no task | S (figures per section are wrong when the entity has short-term loans or dollar cash; the net ties) |
| G13 | Revaluation scope is three roles plus bank GL accounts; any other monetary account in foreign currency (loans, sundry creditors) is not revalued | no task | S |
| G14 | A hand entry cannot be tied to its voucher (CFDI UUID or document); its node in the pólizas XML has no `CompNal` | no task (MNE-001-595 covers only the payment trace of a typed entry) | S |
| G15 | Persisted entry descriptions in English | **MNE-001-171, 172** (lane B, wave 4, Should), **173** (lane H, v1.0 scope) | S (existing) |
| G16 | The opening entry is a movement of the first month: the first balanza after a migration declares SaldoIni 0 and the whole balance sheet as Debe/Haber, which does not chain with the December the client filed from its old system. Declared in `opening-balance.ts:66-74` as a consequence of the design | no task | S (owner decision) |
| G17 | Restoring period 13 to `hard_close` does not sweep again | **MNE-001-781**, wave 4, Should, open | S (existing) |
| G18 | No single check that ties the statements to each other (net income = result in the balance sheet = first line of the cash flow; equity roll; Δcash = cash accounts) | PRD-003 RF-02 («verificación de amarres»), no task | S |
| G19 | Income-tax provision of the year (NIF D-4) so that the statements show the result after tax | **MNE-001-300**, wave 4, Must, v1.0 scope, open | S (existing; another reviewer's domain) |
| G20 | NIF B-10 inflation-environment test from the INPC series | RF-48 (Could) covers restatement; the test has no task; MNE-001-306 (INPC commands, Could) is its dependency | C |
| G21 | `entry void` dates its mirror with the process clock and has no `--date` (`posting.ts:881`), unlike `entry reverse`, which uses the entity's day. With the process in UTC, a void typed at 18:30 on 31 January in Mexico City books the mirror on 1 February | no task | C |
| G22 | Closed-period protection lives only in the application; the database would accept a `posted` row in a sealed period from any writer that skipped `posting.ts` | no task | C |
| G23 | No report of entries booked after the RCFF art. 33 deadline (to verify) | no task | C |
| G24 | NIF warnings of a posting are returned and not stored | PRD-003 RF-25 (Must), no task | C for the release |
| G25 | Dimensions (cost centre, project) take any UUID: no master | RF-04 (Should), no task (#256) | C |
| G26 | Functional currency other than the peso | RF-49 (Should), no task | C |
| G27 | Consolidation, eliminations, translation (NIF B-7, B-8, B-15) | RF-08 (Could), no task; no owner decision excludes it | C |
| G28 | IFRS presentation and measurement | RF-29, RF-30 (Must in PRD-003), no task | C for a Mexican NIF release |
| G29 | Irregular first fiscal year | **MNE-001-348**, Could, open | C (existing) |
| G30 | Legal reserve proposed at year end | **MNE-001-347**, Could, open | C (existing) |
| G31 | Audit extract sums with `Number` | **MNE-001-289**, Could, open | C (existing) |
| G32 | Three copies of the balance SQL outside report-service (E4.2 at 4/5) | **MNE-001-624, 625, 820**, Could, open | C (existing) |
| G33 | `year create` writes no audit row for the carry | **MNE-001-750**, Should, open | C (existing) |
| G34 | Prior-year error: no guided flow, no restated comparatives | no task | C (depends on G11) |
| G35 | Condensed interim statements | no task | C |
| G36 | «Result of the period» in the balance sheet sums every unswept year when a prior year was never sealed | no task | C |
| G37 | Direct-method cash flow | none; refused by design, panel `flujo_efectivo_metodo` | C |
| G38 | US GAAP comparative statements | **MNE-001-343**, Could | **N** — D-03 and the owner's «Aparcado» of 2026-11-18: what is only of the United States is parked after the MVP |

Count: **R 4 · S 15 · C 18 · N 1**. Of the 38, 10 have a task today (1 R, 3 S, 5 C, 1 N).

---

## 4. Proposed new tasks

Sizes are hand-written lines, tests excluded, capped at 400 per PR. «Critical path» = touches `posting.ts`, `validation.ts`, `period-close.ts` or a migration of the ledger tables.

| # | Title (backlog style) | Gap | Hang on | Lane | Size | Depends on | Flags |
|---|---|---|---|---|---|---|---|
| P1 | El importe en moneda funcional se guarda a la unidad mínima de su moneda: la conversión redondea al centavo y la validación niega un importe funcional con más decimales | G01 | new issue (child of #305) | I | 350 | — | critical path; accepted-practice choice: where the cent of a converted multi-line document goes (panel key, default to the exchange difference account) |
| P2 | Censo de los saldos con fracción de centavo ya posteados, y su póliza de ajuste por cuenta, revisada por una persona | G01 | same issue | I | 250 | P1 | writes through a reviewed entry; no migration |
| P3 | Una póliza manual lleva su origen en moneda extranjera: entry create, entry import y POST /v1/journal-entries aceptan moneda, importe de origen y tipo de cambio por renglón | G02 | new issue | I | 2 × 300 | P1 | critical path; `docs/openapi.json` regenerated |
| P4 | La apertura carga con su origen los saldos en otra divisa: bancos, clientes y proveedores entran con importe de origen y tipo de cambio | G03 | #220 or new | A | 2 × 350 | P3 | accepted-practice choice: the opening rate (implied by the book value, or the closing rate of the cut) → panel key |
| P5 | La revaluación del cierre alcanza toda cuenta monetaria en moneda extranjera, no sólo los roles cxc, cxp y banco | G13 | #305 | I | 300 | P3 | migration (a monetary mark on the account, or a role); panel key for the scope |
| P6 | El cierre anual localiza por rol el resumen de resultados, el resultado del ejercicio y los resultados acumulados | G05 | #603 (RF-50) | E | 250 | — | critical path; data migration seeding the three roles |
| P7 | period lock y period unlock: un periodo cuya balanza se presentó o cuyos estados se emitieron no se reabre sin un desbloqueo auditado | G06 | new issue | E | 300 | — | owner decision: who may unlock while the CLI has no permissions (RF-38) |
| P8 | Una clave del panel dice qué se puede postear en un periodo en cierre suave; por omisión, sólo ajustes y motores | G07 | new issue | E | 200 | — | critical path; panel key (ADR-0006) |
| P9 | El sello del ejercicio espera la revaluación y los devengos del año, y las atestaciones firmadas de negocio en marcha, hechos posteriores y entorno inflacionario | G08 | #603 (RF-51) | E | 2 × 300 | P11 for the inflation figure | migration (attestation rows, append-only); panel key for severity |
| P10 | El estado de resultado integral sale con la estructura de la NIF B-3 y su ORI, por función o por naturaleza según el panel | G09 | #603 (RF-24) | E | 2 × 350 | MNE-001-743 | migration (categories for the financing result and income tax lines); panel key; the B-3 text must be read first |
| P11 | La prueba del entorno inflacionario de la NIF B-10 sale de la serie del INPC, con su cédula | G20 | #112 | E | 200 | MNE-001-306 | threshold from the corpus (26 %), to verify against the standard |
| P12 | statement equity show: el estado de cambios en el capital contable (NIF B-4), amarrado al balance | G10 | #603 (RF-24) | E | 350 | P6 | — |
| P13 | Los estados financieros llevan la columna comparativa del periodo anterior | G11 | #603 (RF-02) | E | 300 | — | — |
| P14 | El flujo de efectivo presenta la deuda de corto plazo en financiamiento, los intereses, dividendos e impuestos en su renglón y el efecto cambiario sobre el efectivo aparte | G12 | #101 or new | E | 350 | P5 | accepted-practice choices (where interest and dividends go) → panel keys; the B-2 text must be read first |
| P15 | report tie-out check: un criterio ▶ amarra los estados entre sí y sale distinto de cero si uno no casa | G18 | #603 (RF-02) | E | 250 | P12 | new criterion in `src/plan/criteria/` |
| P16 | entry support add y list: una póliza manual liga sus comprobantes y el XML de pólizas los declara | G14 | #612 or new | E | 350 | — | migration (support rows); touches the pólizas builder |
| P17 | Decisión: la balanza del primer mes tras una migración, ¿declara la apertura como movimiento o como saldo inicial? | G16 | #220 | DEC | — | — | owner decision |
| P18 | entry void fecha su espejo con el día de la entidad y acepta --date, como entry reverse | G21 | new issue | E | 80 | — | critical path |
| P19 | Un disparador de la base niega pasar a posted un asiento de un periodo sellado | G22 | new issue | E | 120 | — | migration; critical path |
| P20 | ledger check avisa de las pólizas registradas fuera del plazo del RCFF art. 33 | G23 | new issue | E | 120 | — | the deadline goes to `legal_parameters` after reading the official text |

Not proposed: G24–G28 already have their PRD-003 requirement and wait for its backlog; G34–G37 wait for P13 or are refused by design.

---

## 5. Top findings

1. **G01 (R).** Pesos are booked at four decimals and the Anexo 24 balanza, at two, refuses an account whose rounded columns do not add up. Reproduced with two dollar invoices. No task.
2. **G03 (R).** Migration drops the foreign-currency origin of bank balances and refuses open documents in another currency; the closing revaluation then misstates those accounts. No task.
3. **G02 (R).** A hand entry, an imported entry and the REST route cannot carry a foreign currency. No task.
4. **G04 (R, existing).** MNE-001-643 (#593) is Must and sits in wave 4, after the MVP.
5. **G09, G10, G11 (S).** Of the statements PRD-003 RF-24 and RF-02 call Must, the income statement is two blocks, the statement of changes in equity does not exist and no statement has a comparative column. None has an engine task.
6. **G08 (S).** The annual seal does not wait for the year's revaluation and accruals nor for any attestation (RF-51, Must, no task).
7. **G06 (S).** `locked` is a status nothing can set: a filed month reopens like any other.
8. **G05 (S).** The sweep is tied to the seeded codes 3900/3200/3300 (RF-50, no task).
9. **G12, G13 (S).** The cash-flow sections misplace short-term debt and the FX effect on cash; the revaluation skips monetary accounts outside three roles.
10. **G14, G15 (S).** A hand entry has no link to its voucher, and persisted concepts of reversals and closing entries are in English (MNE-001-171 to 173 open).

---

## 6. Not reviewed

- GitHub issues were not read; coverage comes from `docs/backlog/PRD-001.json` and PRD-003 alone.
- The REST routes, beyond confirming that the journal-entry route has no FX fields.
- `ar-ap-posting.ts`, `iva-cash-basis.ts`, `opening-balance.ts` beyond the parts cited; banking postings into a foreign bank account; payroll and asset postings.
- The Anexo 24 builders, except the rounding invariant that G01 depends on.
- `closing-conductor.ts` beyond its step list; `closing-pack.ts`; the materialized views.
- No integration test was run. The only execution was a pure-function probe of `verificarRedondeo` and `convertirAFuncional`, kept outside the repository and not copied into this folder.
- Every norm marked (to verify) was cited from memory: RCFF art. 33-B, Código de Comercio arts. 33-38, LGSM art. 172, the layout of NIF B-2's indirect method, the comparative requirement.
