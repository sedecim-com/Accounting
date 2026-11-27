# 06 · Subledgers and internal controls — release review

Reviewer slug `06-subledgers-controls`. Checkout: the repository at `e9a327d0` (origin/develop, 27 Nov 2026). Read-only.

Measured here, not quoted: `npm run -s plan:status` → **14 of 16 packages green, 261 criteria, 12 ▶ ran, 12 green**; red: **E4.2** (4/5, `single-report-query-layer`: 3 copies) and E5.1 (25/27). `npm run -s catalogo:estado` → **298 commands, 81 families, 282 of 1651 catalogue rows invocable** (the command rewrote its generated block with identical bytes; `git status` clean afterwards). Backlog `docs/backlog/PRD-001.json`: 853 tasks; open: wave 3 = 37, wave 4 = 312.

Evidence level: everything below is **read in the code, not executed**, unless it says «measured». Legal citations not carried by the repo's corpus or `legal_parameters` are marked **(tv)** = to verify against the official text.

Classes: **R** blocks a release for real use · **S** should be in the release · **C** could wait · **N** out of scope by owner decision.

---

## 1. Norm list, code against the norm, coverage, class

| # | Norm (precise) | What the code does today | Verdict | Backlog | Class |
|---|---|---|---|---|---|
| N1 | **CFF art. 28 fr. I–III** (tv: what integrates the accounting; records analytic, tied to vouchers; electronic media) and **RCFF art. 33 ap. B** (tv: fr. I chronological entry, fr. III tie each operation to its voucher/CFDI folio, fr. on payment form, auxiliaries by account and by third party). Not in `src/ai/docs/*.md` (grep: no «art. 28», «RCFF») | Entry ↔ document: `journal_entries.source_type/source_id/reference` (CFDI UUID); payment form: `payment_method`, `check_number`, payer/payee bank and account (migrations 064, 331, 335; `payment trace record`, `receipt trace record`); auxiliaries: `ledger auxiliary show` (by account), `customer show --as-of`, `report aged-receivable|aged-payable show`, Anexo 24 auxiliaries | **Partial**: no movement statement per third party; `vendor show` has no `--as-of`; `payment` has no `list/show`; a typed bank entry cannot take a payment trace | 744 (w4 open), 595 (w3 open), 758, 634, 635; corpus: no task | S (744, 595) / C (rest) |
| N2 | **CFF art. 30** (5 years; cited so by task 322) and **Código de Comercio art. 38** (tv: 10 years for vouchers) | No purge command exists for ledger, XML, audit; no retention horizon stated; `doctor` says nothing; prior-system files and bank statement files are not kept (hash of statement only: 051:145) | **Absent as a declared control**; nothing deletes | 322 (w4 open, Should, not marked v1.0) | S |
| N3 | **LISR art. 27 fr. III** — `legal_parameters` `income_tax.cash_payment_deduction_limit` = 2,000.00 MXN from 2014-01-01 (`legal-parameters-seed.ts:162-176`) | `cashLimitFinding` (`src/services/ap/cash-deductibility.ts:76-140`) at `bill approve` (CFDI FormaPago 01) and `payment create` with `cash` (`payment-service.ts:757-779`); panel key `cash_over_limit_outside_ingestion` default `signal`; ingestion still uses constants | **Partial**: judged per payment, MXN only; a 5,000 bill paid in three cash payments of 1,900 raises nothing; fuel rule not coded; ingestion thresholds hard-coded | 326 (w4 open, Must, v1.0) for ingestion; rest no task | C (accepted-practice choice) |
| N4 | **LIVA art. 1-B** (collected; cheque when cashed), **art. 5 fr. II–III** (paid in the month, with CFDI) — corpus `receivables.md`, `payables.md`, `banking.md:47` | IVA parked (2125 / 1135) and released by the payment's own entry (`ar-ap-posting.ts` `ivaReclassLines`); application day stored (332, 344); cheque holds IVA until cashed (508, 556); unapply/reverse keep or re-park by decision 756 | **Correct** for native documents. **Wrong for migrated receivables** (G1) and for REP forms without cash (G3) | G1, G3: no task | R |
| N5 | **NIF C-3** (corpus `nif-registro.md:49`), **NIF C-19**, **NIF C-20** as they bear on subledger = control | `arReconcile` (`ar/ar-controls.ts:63-171`), `apReconcile` (`ap/ap-controls.ts:306`), close boxes `ar-subledger-delta`/`ap-subledger-delta` **blocking** (`period-close.ts:583-609, 1289-1300`); manual entries on the control are listed | **Partial**: both sides read **today**, not at period end (`period-close.ts:492-500`, `ar-controls.ts:29`); AP aging as-of does not rebuild the past (`ap-controls.ts:541-551`) | 649, 650 (w4 open, Should); 648 done | S |
| N6 | **NIF B-15** settlement differences | Realised FX is the plug of the payment entry, each document at its own rate (`ar-ap-posting.ts:663-688`); revaluation in the conductor | **Correct where wired; refused elsewhere**: foreign credit note (`credit-note-service.ts:416` `FX_CREDIT_NOTE_NOT_WIRED`), foreign cash on account (`payment-service.ts:918`), foreign payment through a bank account kept in another currency (`ar-ap-posting.ts:646` `FX_BANK_CURRENCY_MISMATCH`, «until a panel key decides»), foreign open documents at migration (`opening-invoices.ts:176-189`) | no task | S |
| N7 | **NIF B-1** corrections by reversal (cited in migration 041) | Posted entries immutable by trigger; `entry reverse`, `entry void`, document reversals post mirrors | **Correct**; but G8: `entry reverse/void` accept document-born entries | no task | S |
| N8 | **NIF A-1 cap. 20** accrual / cut-off (cited `validation.ts:184`) | Period by stored day (#211, #241); close boxes: `sat-census-missing`, `rep-missing`, `rep-parked`, `entries-posted`, accrual boxes | **Correct**; plain `close` has no box for FX revaluation nor benefits accrual (only `closing run` runs them) | no task | S |
| N9 | **CFF arts. 29 / 29-A** cancellation of a CFDI (tv) and its effect on the books | Received: bill gets a mark (340), `ap check` probes `cancelled-cfdi-open`/`-paid` (warnings). Issued: `invoice void`, credit notes | **Absent for payables**: an approved bill cannot be voided (G2) | no task (643 delivered the mark only) | R |
| N10 | **CFDI complemento de pagos 2.0**, `c_FormaPago` (tv: 17 compensación, 12 dación, 15 condonación, 23–27) | `rep-linkage.ts:98-109` maps 01/02/03/04/28, everything else `other`; `:407-431` creates the payment; `bankAccountOf` (`ar-ap-posting.ts:611-627`) credits/debits the `banco` role | **Wrong** for forms that move no bank money (G3) | no task (635 = payer trace only) | R |
| N11 | **Anexo 24 RMF**, `c_MetPagos` | `METODO_A_SAT` (`polizas-service.ts:402-420`): debit card → `99`, code comment leaves 03/07/99 «for the owner, in the panel»; vendor payments cannot be `debit_card` (002:122-123) | **Partial, declared** | no task | C |
| N12 | **Bank reconciliation as a monthly control** (practice; NIF C-1 tv) | Statement as a document (sha256 per file, DB-computed line hash, overlap key default `block`), 7 integrity checks, two-sided arithmetic, baseline (109), reconciling items typed/owned/dated, close → approve (hash snapshot) → post, reopen with reversal (`reconciliation-service.ts:458, 1561, 2401, 2684, 3182`) | **Correct and deep**. Gaps: close box `bank-reconciled` is a **warning** with no panel key (`period-close.ts:766`); `reconciling-item correct/assign` write no audit row (`reconciling-items.ts:817-900, 918+`); REST route creates sessions outside the engine | 286, 672 (w4 open); rest no task | S |
| N13 | **Segregation of duties / maker-checker** (practice; agent proposes, person approves: AGENTS.md invariant 1) | Panel key `segregacion_de_funciones` (`off` default / `alertar` / `exigir`, `pending-catalog.ts:2138-2143`); enforced for manual `entry post` and `auto_post` (`posting.ts:156-187`), `batch post` (`batch-service.ts:698`), `bank reconciliation approve` (`reconciliation-service.ts:2423-2458`); AI drafts approved by a resolved person, hash-bound (`draft-service.ts:530, 644, 843-844`) | **Partial**: not on `bill create`→`bill approve` (`bill-service.ts:538-553`), `invoice create`→`issue`, opening draft→post, `batch reverse`, `close`/`period reopen`; every `source_type` entry is exempt (`posting.ts:173`) | 772 (w4 open); rest no task | S |
| N14 | **Audit trail that cannot be rewritten** | `audit_log` append-only trigger + REVOKE (033; `rls-policies.sql:150-175`), `ENABLE ALWAYS` (058), `doctor` watches `tgenabled`; `closing_packs`, `filed_tax_returns`, `fiscal_credential_access_log` same | **Correct**; no row hash chain; `year create` carry writes no row | 750 (w4 open) | C |
| N15 | **Period lock after filing; complementary filing after a reopen** (Anexo 24 / RMF 2.8.1.x tv) | `hard_close`/`locked` refuse posting (`posting.ts:239-253, 588-609`); `period reopen` needs a reason and audits (`fiscal-calendar-service.ts:246-316`); `locked` is never reopened | **Partial**: **no command or service sets `locked`** (grep: no writer); reopen does not read `filed_tax_returns`, the generated balanza or the closing pack | no task (304 `e-accounting status` is adjacent) | S |
| N16 | **Tenant and entity isolation** as an accounting control | Exists: forced RLS (`rls-policies.sql:114, 213`), scope helpers, CI job «Aislamiento por inquilino» | Exists (existence only reported) | — | — |
| N17 | **Backup and restore drill** | `backup create/list/verify/restore/export` (`backup-service.ts:308, 409, 531`); `verify` restores into a throwaway base and runs the ledger checks; CI job «Ensayo de restauración» (`ci.yml:340`) | Exists | #598: an open reserved issue about the backup artifact; tasks 653, 654 (w4 open, Must) | S |
| N18 | **Idempotency of writes** | Persisted key store (039; `idempotency-store.ts`): key optional in the CLI, recorded after the act; REST requires `Idempotency-Key` on irreversible routes; natural keys: REP `(entity, uuid, node)` unique (036:48-54), statement `(account, sha256)` unique, CFDI `(entity, uuid)` unique in `xml_documents` | Exists, by design | — | N (design choice, invariant 6) |
| N19 | **Migration from a prior system** (alta y migración) and conservation of its Anexo 24 files | `chart import`, `opening-balance import|check`; one opening per entity and date (DB unique 081/087); open documents become invoices and bills in the same transaction | **Partial / wrong**: G1 (no IVA on migrated receivables), foreign documents refused, source file neither hashed nor kept (`opening-balance.ts:1344-1366`) | no task | R / S |

---

## 2. Control matrix (where each control is enforced)

| Control | DB | Service | CLI only | Absent | Evidence |
|---|---|---|---|---|---|
| Posted entry and its lines cannot be edited or deleted; no TRUNCATE | ✔ | | | | 041 triggers, 058 `ENABLE ALWAYS` |
| Audit log append-only | ✔ | | | | 033, `rls-policies.sql:150` |
| Closing pack, filed returns, e.firma access log append-only | ✔ | | | | same list |
| Period lock (hard close refuses posting) | | ✔ | | | `posting.ts:239-253, 588-609`; no trigger on `journal_entries` |
| Close only with a clean blocking checklist | | ✔ | | | `softClosePeriod` 1362, `hardClosePeriod` 1448 |
| Bank reconciled before close | | warning | | as a gate | `period-close.ts:766` |
| Previous period closed before close | | warning | | as a gate | `period-close.ts:692-705` (code says: belongs in the panel) |
| Period reopen: reason + audit row | | ✔ | | | `fiscal-calendar-service.ts:246` |
| Period `locked` after filing | | reader only | | ✔ writer | grep: no `SET status = 'locked'` |
| Maker-checker: manual entry, batch post, bank approval | | ✔ (key default `off`) | | | `posting.ts:132-187` |
| Maker-checker: bill approve, invoice issue, opening post, batch reverse, close, reopen | | | | ✔ | `bill-service.ts:538-553`; 772 |
| Agent proposes, person approves (hash-bound) | | ✔ | | | `draft-service.ts`; floor by `Math.min` (`floor.ts:57, 151`) |
| Role / permission per command in the terminal | | | | ✔ (REST has `requirePermission`) | stated by task 704: «la terminal no comprueba hoy ningún rol ni permiso»; local mode by decision RS-3 (685) |
| Subledger = control account (AR, AP) | | ✔ detective, at today | `ar/ap reconcile` | | `ar-controls.ts`, `ap-controls.ts` |
| Document-born entry cannot be reversed outside its document | | | | ✔ | `posting.ts:763-797, 851-893` |
| Duplicate CFDI at ingestion | ✔ | ✔ | | | `xml_documents (entity_id, cfdi_uuid)` unique |
| Duplicate bill / invoice (UUID or vendor folio) | | AR warning probe only | | ✔ for AP | `bills` index 340:44 is not unique; `createBill` 367-386; `ap-checks.ts` has 2 probes |
| Same REP node twice | ✔ | ✔ | | | 036:48-54 |
| Same statement file twice; line fingerprint | ✔ | ✔ | | | 051/072 |
| Reconciliation `balanced` needs arithmetic; `approved` needs hash; `posted` needs who/when; baseline complete | ✔ | ✔ | | | 054:39, 055:55-72, 109:26 |
| Sessions of one account do not overlap | | ✔ (`FOR UPDATE`) | | | `reconciliation-service.ts:491-509` |
| Reconciling items aged and owned | | ✔ | | | `reconciling-items.ts`, close box `bank-items-overdue` |
| Audit row on reconciling-item correct / assign | | | | ✔ | `reconciling-items.ts:817, 918` |
| Cash over the LISR 27-III limit | | ✔ signal | | | `cash-deductibility.ts` |
| Role re-pointing guarded against a live balance | | audit row only | | ✔ guard | `account-roles-service.ts:101-156` |
| Backup verified by restore; CI drill | | ✔ | | | `backup-service.ts:409`; `ci.yml:340` |
| Retention horizon | | | | ✔ | task 322 |
| Tenant / entity isolation | ✔ | ✔ | | | existence only |

---

## 3. E4.2: the three copies of the balances SQL (tasks 624, 625, 819, 820)

Measured: `single-report-query-layer` lists `ar/credit-note-service.ts`, `fiscal/received-credit-notes.ts`, `payments/payment-service.ts`.

| Copy | What it sums | Published as a balance? | Can it differ from the reports? |
|---|---|---|---|
| `credit-note-service.ts:360-376` `openInvoicedAdvance` | Credits − debits on role `anticipo_clientes`, only in the entries of this customer's invoices and credit notes, posted and not reversed | No: gates an `anticipo` credit note | Yes, by scope (declared in its comment): an advance booked by a manual entry or the opening names no customer, so the sum is lower than account 2150. Conservative: it refuses |
| `received-credit-notes.ts:72-75, 86` | Net of one note's entry on the creditable / pending roles; `:86` sums **all** debit lines of the entry as «the debit to payables» | Feeds the IVA workpaper lines | `:86` equals the payable debit only while the entry has a single debit line (true for today's posting plan; unverified for a note with a second debit) |
| `payment-service.ts:1523-1533` `withholdingBookedAtIssuance` | Lines of the invoice's own entry on two withholding roles, **no status filter** | No: sizes a collection | Only if an invoice with a non-posted entry were collectable; not found |
| `payment-service.ts:2690-2698` `vatKeptByReversal` | Net on the pending role over given entry ids | No: amount of a reversal line | See below |
| `payment-service.ts:3913-3925` `writtenOffOf` | Debits on role `cxp` of the bill's received-note entries | No: gates unapply / reverse | See below |

Common cause of a real difference: **all five read the role's account as mapped today**, and the ledger was written to the account mapped then. `account role set` re-points a role with an audit row and **no guard on balance or open documents** (`account-roles-service.ts:101-156`). Case (read, not run): `cxp` re-pointed from 2110 to 2110.01 in March; a February bill with a received credit note → `writtenOffOf` no longer sees the note's debit → `assertNotClosedShort` refuses `payment unapply/reverse` as «closed short» for a bounced transfer, while the trial balance still shows the debit on 2110. The same pattern is in `ivaStillParked` (`iva-cash-basis.ts:679-693`, a `SUM(CASE …)` the detector does not see, task 819): after re-pointing `iva_pendiente_acreditar`, the cap reads 0 parked and a payment releases no IVA.

Conclusion: none of the three is a competing report layer; none publishes a figure a report also publishes. The risk is the mapping, not the SQL. Tasks 624/625/819/820 stay **C**; the guard is new task T11 (**S**).

---

## 4. Gaps

| # | Gap | Failing case | Task | Class |
|---|---|---|---|---|
| G1 | A migrated open customer invoice carries no IVA: `opening-invoices.ts:42-47` loads the balance «as subtotal with no tax»; `ivaStillParked` adds the opening share only for `received` (`iva-cash-basis.ts:668-677`); the IVA workpaper counts a PPD collection by `payment_allocations.iva_reclass_amount` (`iva-workpaper.ts:44-52`) | Opening with 116,000 of PPD receivables and 16,000 in IVA trasladado no cobrado. January collects them: no entry moves 2125 → 2120, the workpaper shows 0 caused IVA for those collections, 16,000 stays in 2125 for ever. The payable side has `ivaRate` and key `opening_payable_iva`; the receivable side has neither, and the load gives no finding | none | **R** |
| G2 | An approved vendor bill cannot be voided: no `voidBill` (only `opening-bills.ts:556`), `bill-command.ts:818-819` «`bill reverse` has no backend yet» | Vendor cancels a CFDI already approved. The bill gets a mark and a warning; expense, liability and 1135 stay. `entry reverse` of its entry leaves the bill open in the subledger → `ap-subledger-delta` blocks the close | none | **R** |
| G3 | A REP-born payment always moves the `banco` role, whatever its FormaDePagoP; default `rep_pago_no_registrado = crear_pago` | Received REP, FormaDePagoP 17, 11,600: `recordVendorPayment` method `other` → DR 2110 / CR bank 11,600 and IVA released; no bank movement exists, the receivable it nets stays open. Also: forma 01 credits the bank, not the cash box; with two bank accounts every REP lands on the default one | none (635 = payer trace) | **R** |
| G4 | Subledger tie-out reads today; AP aging as-of does not rebuild the past | Closing September on 20 Oct: a September entry on the control offset in October leaves no delta | 649, 650 | S |
| G5 | Maker-checker does not cover bill approve, invoice issue, opening post, batch reverse, close, reopen; default `off` | With `exigir`, one user runs `bill create` + `bill approve` and posts expense and liability alone | 772 (batch reverse) | S |
| G6 | `bank-reconciled` and `previous-period-closed` are warnings with no panel key (invariant 6; the code says so at `period-close.ts:686-691`) | A month is hard-closed with no reconciliation session | none | S |
| G7 | Nothing sets `locked`; `period reopen` ignores what was filed | A month whose return is in `filed_tax_returns` and whose balanza was generated is reopened with a reason and no notice of the complementary filing | none | S |
| G8 | `entry reverse` / `entry void` accept entries born from an invoice, bill, receipt or payment | `entry reverse` on a payment's entry: ledger undone, payment `completed`, bill `paid`, applications live → DIOT and workpaper still count it; found only at close | none | S |
| G9 | No duplicate guard for payables | `bill create` twice with the same vendor folio, or by hand for a CFDI the inbox already posted: two liabilities; `ap check` has no probe | none | S |
| G10 | Migration sources and statement files are not conserved; no retention horizon | The opening's audit row says `xml-sat:BalanzaComprobacion:2025-12` and totals, no sha256, no bytes | 322 (retention); hash/archive: none | S |
| G11 | Foreign currency in the subledgers stops at four doors | A PyME with one open USD invoice cannot migrate it as USD; a USD bill cannot be paid from a named MXN bank account | none | S |
| G12 | Role re-pointing unguarded (§3) | §3 | none | S |
| G13 | Plain `close` does not check FX revaluation nor benefits accrual | USD balances, `close --hard` without `closing run`: month sealed unrevalued, no box says so | none | S |
| G14 | REST `POST /reconciliations` outside the engine; reconciling items order and age at the statement date | — | 286, 672 | S |
| G15 | Vendor payment register and its dates/causes | — | 744, 745, 780, 755, 531, 664 (w3), 665 | S |
| G16 | A reserved issue | #598 | 653, 654 | S |
| G17 | `reconciling-item correct/assign` leave no audit row | Who turned a «bank error» into a «fee» between open and approve is not in the trail | none | S |
| G18 | `batch reverse` SoD; period 13 re-seal; `year create` audit row | — | 772, 781, 750 | S |
| G19 | LISR 27-III judged per payment, MXN only; ingestion constants | §1 N3 | 326 (ingestion) | C |
| G20 | Debit card → `c_MetPagos` 99; AP has no `debit_card` | — | none | C |
| G21 | E4.2 copies | §3 | 624, 625, 819, 820 | C |
| G22 | No statement of movements per third party; `vendor show --as-of` | — | 758 (adjacent) | C |
| G23 | Advances (cash on account, vendor advances) have no tie-out to 2150 / anticipo_proveedores | — | none | C |
| G24 | No compensation (netting AR against AP of one third party) as a document | Today a manual entry on both controls → both tie-outs show a delta and block the close | none | C |
| G25 | `audit_log` has no hash chain | — | none | C |
| G26 | Corpus has no text of CFF 28 / RCFF 33 / CFF 30 / CCom 38 | The agent cannot cite the bookkeeping and retention duties | none | C |
| G27 | Statement formats: csv (BBVA, Banorte, Santander, generic), camt.053, MT940; no xlsx / OFX | — | 340 (OFX, US) | C |
| G28 | Roles and permissions are not checked in the terminal's local mode | — | 704, 705 for the remote surface | N (RS-3, MNE-001-685, 26 Nov) |
| G29 | Idempotency key optional in the CLI, written after the act | — | — | N (design, invariant 6) |

**Count: R 3 · S 15 · C 9 · N 2.**

---

## 5. Proposed new tasks

| # | Title (backlog style) | Hang on | Lane | Lines | Depends | Needs |
|---|---|---|---|---|---|---|
| T1 | Documentos abiertos de CxC: cada factura migrada lleva su tasa de IVA, y cobrarla libera su parte de 2125 a 2120 (dos PRs: la carga con `opening_receivable_iva` y APE-CXC-IVA-SIN-SALDO; el tope de `ivaStillParked` para `issued`) | #310 (if closed, new issue) | A / C | 350 + 250 | 022, 023 | Panel key, default `require_rate` (LIVA 1-B); critical path (posting, IVA workpaper); no migration |
| T2 | `bill void`: anular una factura de proveedor aprobada con su póliza espejo, su IVA de 1135 y su fila de auditoría; se niega con pagos vivos | new issue (follows #643) | C | 380 | 431, 610 | Owner decision on the date of the mirror for a closed period (reuse `cfdi_periodo_cerrado`); critical path; maybe a migration for the status |
| T3 | Un REP cuya forma de pago no mueve banco (17, 12, 15, 23 a 27) no crea un pago contra el banco: queda en revisión con su motivo; y un REP en efectivo o con cuenta nombra la cuenta propia | new issue (near #698 / #612) | B | 300 | 635 | Corpus first (c_FormaPago list); accepted-practice key for what a compensation posts; critical path |
| T4 | Con la segregación exigida, quien capturó un gasto o una factura manual no lo aprueba ni la emite, y quien cargó la apertura en borrador no la postea | #592 | C / E | 250 | 642, 772 | Reuses `segregacion_de_funciones`; owner decision whether the default stays `off` |
| T5 | Dos claves del panel para el cierre: conciliación bancaria faltante y periodo anterior sin cerrar, con valor por omisión que bloquea | new issue (near #98 / #99) | E | 300 | — | ADR-0006 keys with conservative default; touches `period-close.ts` (critical path) |
| T6 | `period lock` sella un periodo ya declarado, y `period reopen` nombra la declaración registrada, la balanza generada y el expediente del mes antes de reabrir | new issue (near #99 / #308) | E | 350 | 304 | Corpus first (RMF rule on complementary balanza, tv); no migration (`locked` exists) |
| T7 | `entry reverse` y `entry void` se niegan sobre la póliza de un documento y nombran el comando del documento | new issue | E | 200 | T2 | Critical path (`posting.ts`); needs T2 so bills have a door |
| T8 | Sonda `duplicate-bill` en `ap check` y negativa de `bill create` ante el mismo folio del mismo proveedor o un UUID ya contabilizado | new issue | C | 200 | — | Owner decision: refuse or warn; a census before any unique index |
| T9 | La carga del catálogo y de la apertura guarda la huella sha256 de su archivo en la bitácora y archiva sus bytes, como los paquetes del SAT (310) | #120 (with 322) | A | 300 | 322 | Migration (archive table, append-only); owner decision on the horizon (CFF 30 vs CCom 38) |
| T10 | Moneda extranjera en los auxiliares: documentos abiertos de la migración, nota de crédito, saldo a cuenta y pago desde una cuenta en otra moneda (una tarea por puerta, plan primero) | #305 (if closed, new issue) | I | 4 × ~350 | 081–083, 112 | Panel key the code already asks for (`ar-ap-posting.ts:636-644`); critical path |
| T11 | `account role set` avisa o se niega cuando la cuenta anterior tiene saldo o documentos abiertos, y dice qué sumas leen el rol | #101 | E | 200 | 819 | Owner decision: warn or refuse; no migration |
| T12 | El checklist del cierre gana las casillas de revaluación cambiaria y de provisiones, para quien cierra sin `closing run` | new issue (near #128) | E | 250 | 112 | Severity from the existing `*_faltante_al_cierre` keys; critical path |
| T13 | `bank reconciling-item correct` y `assign` dejan su fila de auditoría | #771 | D | 120 | 672 | — |
| T14 | Tarjeta de débito: `vendor_payments` la admite y el c_MetPagos del Anexo 24 lo elige el panel | new issue (follows #404) | E | 200 | 139 | Owner decision already named in `polizas-service.ts:402-411`; migration (CHECK) |
| T15 | Compensación entre lo que un tercero debe y lo que se le debe, como documento que salda los dos auxiliares | new issue | C | 380 | T3 | Corpus first; accepted-practice key for its IVA day (LIVA 1-B) |
| T16 | Corpus: los deberes de registro y conservación (CFF 28 y 30, RCFF 33, Código de Comercio 38) con su fuente | #133 | G | 150 (prose) | — | Official text first; `corpus-manifiesto --check` |
| T17 | El efectivo sobre el límite de LISR 27-III se juzga por operación o por pago, según el panel | #123 (with 326) | B | 200 | 326 | Accepted-practice key, conservative default = per operation |

Existing tasks this review asks to **pull into the release**: 649, 650 (subledger at a date), 772, 286, 672, 744, 745, 780, 755, 531, 664, 665, 322, 750, 781, 653, 654.

---

## 6. Top findings

1. **G1 (R)**: migrated receivables release no IVA when collected; the months after go-live under-state caused IVA in the workpaper. The payable side was done (MNE-001-023); the receivable side was left with a NOTE.
2. **G2 (R)**: there is no way to void an approved vendor bill; a cancelled received CFDI leaves the books wrong or the close blocked.
3. **G3 (R)**: every REP-born payment moves the default bank account, including forms that move no money; `crear_pago` is the default.
4. **G4 (S)**: the blocking tie-out of AR and AP at close compares today's subledger with today's control, not the month's end (tasks 649, 650, wave 4).
5. **G5 (S)**: maker-checker covers three doors (manual entry, batch post, bank approval) and is `off` by default; bills, invoices, the opening, the close and the reopen have none.
6. **G7 (S)**: the `locked` status has readers and no writer; reopening a filed month warns of nothing.
7. **G8 + G9 (S)**: two preventive controls missing on the subledgers: reversing a document's entry outside its document, and a duplicate payable.
8. **G12 (S)**: role re-pointing is unguarded while the E4.2 copies and the IVA caps read the ledger through today's mapping; the E4.2 copies themselves are not a release risk.
9. **G6 + G13 (S)**: the closing checklist lets a month be sealed with no bank reconciliation (warning, no key) and, outside `closing run`, with no FX revaluation.
10. **G10 (S)**: the prior system's Anexo 24 files behind the opening are neither hashed nor kept, and no retention horizon is declared (task 322 open).

What is solid: ledger and audit immutability in the database, the bank reconciliation engine (arithmetic, baseline, snapshot, reopen) with its CHECKs, the dated IVA of payments and cheques, the restore drill in CI, idempotent REP and statement imports.

---

## 7. Not reviewed

- Not executed: no spec was run; every failing case above is by reading. G1, G2 and G3 deserve a reproducing test before their plans.
- Not read line by line: `payment-service.ts` (4,282 lines; read around create, apply guards, the three sums and the reversal), `treasury-posting.ts`, `match-service.ts`, `matching.ts`, the statement parsers, `closing-conductor.ts` beyond its steps, `closing-pack.ts`, `customer-service.ts`, `vendor-service.ts`, `invoice-service.ts`, `customer-advance.ts`, `exportacion-inquilino.ts`.
- `src/ai/floor.ts` and the draft approval path: read only, not assessed for change.
- REST routes for the same acts (only `banking.md` and the permission list); the web dashboard.
- GitHub issues: one label read on #310; issue states are taken from the backlog file.
- Sensitive issues: only #598 touched this domain; nothing new of that kind was found.
- Rates, thresholds and article numbers marked (tv) were not checked against official text (no web access used).
- Payroll, assets, Anexo 24 XML validity, DIOT, year-end sweep, FX revaluation engine: other reviewers' domains; touched only where a subledger control depends on them.
