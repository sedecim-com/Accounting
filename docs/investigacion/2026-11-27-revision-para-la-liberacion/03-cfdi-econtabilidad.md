# 03 · CFDI and the electronic accounting the SAT receives

Reviewer slug `03-cfdi-econtabilidad`. Checkout: the repository (origin/develop, `e9a327d0`, 27 Nov 2026). Read-only.
`npm run -s plan:status`: 14 of 16 packages green; E3.1 3/3 and E3.2 10/10 green. Backlog: 853 tasks; wave 3 has 37 open, wave 4 has 312 open.

Marks: **(tv)** = from my memory of the law or rule, to verify against the official text. Where no mark, the repo's corpus, a vendored SAT file or a seed carries it.
Evidence levels: **read** = code read; **probe** = executed a read-only script (two probes kept outside the repository and not copied into this folder); nothing was run against Postgres, a PAC or the SAT.

## 1. Norm list and code against the norm

### 1.1 Contabilidad electrónica (Anexo 24)

| # | Norm | What the code does (file:line, command) | Verdict |
|---|---|---|---|
| A1 | CFF art. 28 fr. III (contabilidad en medios electrónicos) and fr. IV (envío mensual) (tv); RCFF arts. 33–35 (tv); RMF rules of chapter 2.8 on «contabilidad en medios electrónicos» (catalogue with código agrupador, monthly trial balance, vouchers and auxiliaries on request) (tv: rule numbers and deadlines are NOT in the corpus nor in `legal_parameters`) | `mnemosine e-accounting catalog generate/seal`, `balance generate/check/seal`, `voucher generate`, `subledger generate` (`src/cli/e-accounting-command.ts:586-1000`, `e-accounting-request-command.ts:331-408`). Nothing is filed: the receipt says `filed_with_sat: false` and lists four manual steps | Supported; filing itself is N (owner decision, SCOPE «presentar ante el SAT») |
| A2 | Anexo 24, XSD `CatalogoCuentas_1_3` | `catalogo-cuentas.ts` + `validador.ts` (16 named rules `CAT-*`, `validador.ts:151-364`), panel keys `anexo24_niveles_a_presentar`, `anexo24_cuenta_sin_agrupador`; the finished file passes `officialXsdRefusal(xml,'chart')` (`catalogo-cuentas.ts:444`) against the vendored XSD (`xsd/provenance.json`, downloaded 2026-09-27, SHA-256 per file, `xmllint --nonet`) | Correct by construction (XSD-gated since MNE-001-666) |
| A3 | Anexo 24, XSD `BalanzaComprobacion_1_3`; month 13 = year-end balance; TipoEnvio N/C with FechaModBal | `balanza-xml.ts:1-219`, `balanza-service.ts:781` (XSD gate), invariants `balanza-invariantes.ts:225-447` (balances, rounding, accounts in catalogue, nature vs agrupador, seal); hand rules now equal the schema (commit `7cfa35f4`, MNE-001-775) | Correct. `balance check` does not yet run the XSD (MNE-001-774 open) |
| A4 | Anexo 24, XSD `PolizasPeriodo_1_3`: TipoSolicitud AF/FC/DE/CO with NumOrden / NumTramite; per transaction CompNal (UUID, RFC, MontoTotal, Moneda, TipCamb), CompNalOtr, CompExt, Cheque, Transferencia, OtrMetodoPago | `polizas-xml.ts:18-190` (request types and formats), `polizas-service.ts:1042-1130` resolves the voucher from `journal_entries.source_type`: bill, invoice, credit_note (issued), vendor_payment, customer_payment (REP + payment trace). Checks: `polizas-invariantes.ts:64-73` (8 names) | **Partial** — see G3, G4, G5 |
| A5 | Anexo 24, XSD `AuxiliarFolios_1_3`, `AuxiliarCtas_1_3` | `polizas-auxiliar-xml.ts`, same reading as A4 | Partial (same gaps as A4; not XSD-gated) |
| A6 | Sello of the e-accounting file with the e.firma (cadena original by the SAT's XSLT, RSA-SHA256) — optional attribute in the XSD (`BalanzaComprobacion_1_3.xsd:122`) | `seal.ts`, `original-string.ts` run the vendored SAT stylesheet; only catalogue and trial balance; under panel value `sellar_con_custodia`; logged use of the credential (migration 172) | Correct for the two monthly files. Vouchers/auxiliaries have no seal leaf (optional in XSD: acceptable) |
| A7 | SAT technical document for file names and `.zip` packaging (tv) | Names `RFC+AAAA+MM+BN|BC|PL|XF|XC.XML`; three places say «NO VERIFICADO contra la guía oficial» (`balanza-xml.ts:213`, `polizas-xml.ts:870`, `polizas-auxiliar-xml.ts:281`); `Anio` range «NO VERIFICADO» (`balanza-xml.ts:77`). No ZIP is written: step 3 tells the person to compress | Unverified (G12) |
| A8 | Deadlines of the monthly trial balance, of the year-end balance, and «catalogue only the first time and when it changes» (tv) | No calendar, no status of what was generated/filed per month (`filed-returns.ts` covers tax returns only) | Absent (MNE-001-304, wave 4, Could) |

### 1.2 CFDI received and issued by third parties: ingestion (Anexo 20, CFDI 4.0)

| # | Norm | What the code does | Verdict |
|---|---|---|---|
| B1 | CFF arts. 29 and 29-A (requirements of a CFDI) (tv for fractions); Anexo 20 CFDI 4.0 (`cfdv40.xsd` vendored in `src/services/sat/cfdi40/xsd`) | `cfdi-parser.ts:129` accepts 4.0 and 3.3; `validate()` (`:312-383`): UUID present, RFC shape, SubTotal = Σ Importe, Descuento, Total incl. ImpuestosLocales. No XSD validation of a received CFDI, no seal/cadena check, no CSD validity check | Partial (MNE-001-352 «verificación del sello», wave 4, Could) |
| B2 | Direction by the entity's RFC | `pre-registration-service.ts:60-80, 246-251`: a CFDI the entity is not party to is refused; dedupe per entity by UUID or hash | Correct |
| B3 | LIVA art. 1-B and 5 fr. III (cash basis); RMF 2.7.1.39 (PUE is the issuer's label) — both in corpus `mexico-cfdi.md` | Taxonomy `cfdi-taxonomy.ts`: received I, PUE and PPD → DR expense / DR 1135 pending / CR AP; issued PUE → 2120, PPD → 2125; release at payment by the payment door | Correct for MXN |
| B4 | Type I received, foreign currency (Moneda ≠ MXN, TipoCambio); CFF art. 20 (tv) | `cfdi-classifier.ts:138-378` builds the lines from the CFDI's own figures; `cfdi-posting-plan.ts` and `createBillFromPreReg` (`pre-registration-service.ts:1353-1459`) post them with no conversion and no FX columns; only the AI auto-post gate refuses a foreign currency (`src/ai/ingest-service.ts:610-616`); the issued hand door refuses it (`pre-registration-service.ts:1550`); the received hand door does not | **Wrong** — G1 |
| B5 | Type E received (nota de crédito, TipoRelacion 01/03); LIVA art. 7 | `received-credit-note-posting.ts`, `received-credit-note.ts:70-115`: exactly one related bill of the same vendor, MXN, no IEPS/local/withheld taxes, not above the balance due, VAT in the bill's proportion, no capitalised line; VAT split 1135/1130 | Correct and conservative; refuses common cases (G8) |
| B6 | Type E issued | Pre-registration `credit_note`, direction issued: `applyRulesAndProcess` stops (`:410`); `cfdi post` refuses `document_type` (`:1529`); an AI draft bound to it is refused at approval (`:2109-2125`). The person must use the AR credit-note command by hand | Refused, no door (G7) |
| B7 | Type P (complemento de recepción de pagos 2.0: Pago, DoctoRelacionado, ImpuestosDR) | `cfdi-facts.ts:300-392` reads FechaPago, FormaDePagoP, MonedaP, TipoCambioP, Monto, NumOperacion, each DoctoRelacionado and its IVA TrasladoDR (sum, not by rate; RetencionesDR and IEPS not read). `rep-linkage.ts`: the REP never posts by itself; it matches or creates the payment through the payment door; foreign currency by panel key `rep_moneda_extranjera`. `rep missing list`, `rep reconcile` | Correct in design (not line-read in full) |
| B8 | Type N (nómina 1.2), ingestion only | Complement kept raw (`cfdi-parser.ts:289`), nothing reads it; from a SAT ZIP it never reaches the inbox (`sat-census/census.ts:49`); by hand it becomes a `credit_note` pre-registration that every door refuses. Census counts a payroll receipt as booked through its pay run | Not ingested, safely. Taxonomy case `nomina_emitida` (`cfdi-taxonomy.ts:416`) would understate wages (Total, not gross) but no door posts it |
| B9 | Type T, Carta Porte, Comercio Exterior | T → no posting (`cfdi-taxonomy.ts` case `traslado`); neither complement is parsed; issuance to a foreign receiver refused (`income-cfdi-service.ts:67`) | Out of scope in practice; no owner decision recorded (C) |
| B10 | CfdiRelacionados (CFDI 4.0: `maxOccurs="unbounded"`, `cfdv40.xsd:39`) | `cfdi-parser.ts:190-203` reads one node; with two nodes it returns `{tipoRelacion:'', uuids:[]}` (probe) | **Wrong** — G2 |
| B11 | Anticipos, Anexo 20 guide Apéndice 6, procedures A and B (corpus `receivables.md:36-40`) | Detection by ClaveProdServ 84111506 or the word «anticipo» in a description (`cfdi-facts.ts:400-405`); issued advance and «applies advance» refused by `cfdi post` (`:1575-1578`); customer side handled by hand with `receipt apply` (procedure A); procedure B open (MNE-001-525); received egreso 07 has no door | Partial (G8, MNE-001-525) |
| B12 | IEPS, local taxes (complemento ImpuestosLocales), withholdings | IEPS split out in facts but not kept in `xml_documents` (MNE-001-346) and received IEPS treatment open (MNE-001-494…497); ImpuestosLocales totals read (`cfdi-parser.ts:295`), local withholdings have no posting line (entry does not balance → held); withholdings by law from `legal_parameters` (`withholding-law.ts`) | Partial, fails closed |
| B13 | CFDI de retenciones e información de pagos | Refused by the parser (not a `cfdi:Comprobante`); taxonomy says «needs its own parser» (`cfdi-taxonomy.ts:446-460`) | Absent (C, no task) |
| B14 | CFDI global (InformacionGlobal, receptor XAXX010101000) | Not parsed; an issued global I posts as a sale to that RFC if the customer exists | Not distinguished (C) |

### 1.3 Status, cancellation, EFOS

| # | Norm | What the code does | Verdict |
|---|---|---|---|
| C1 | Consulta del estado del CFDI (public SAT service) | `src/services/sat/cfdi-status.ts`: real SOAP client, `SAT_STATUS_MODE` on by default, off says «disabled» (never a false «Vigente»); on upload (async, `pre-registration-service.ts:333`), `cfdi status show/sync` (`cfdi-command.ts:252-284`) | Correct |
| C2 | CFF art. 29-A (cancellation with the receiver's acceptance, deadline) and the RMF rules on acceptance, cases without acceptance, and the deadline (tv: numbers and terms not in corpus); Anexo 20 motivos 01–04 | Detection only: status sweep and census metadata mark the mirror, the invoice (`cfdi_status='cancelled'`, `cfdi-status.ts:209-219`) and the bill (`bills.cfdi_cancellation_noted_at`, migration 340). AR control `cancelled-cfdi-open` blocks; `ap check` warns (`ap-checks.ts:92-131`); the close reads `cancelledBooked` through the census under `census_missing_at_close` (`period-close.ts:1328`). Nothing is reversed: the accountant decides. A cancelled CFDI at classification is a blocking decision (`cfdi-decisions.ts:387`). IVA workpaper and DIOT do not read the bill's mark | Detection correct; own cancellation absent (`POST /v1/invoices/:id/cfdi/cancel` is an unconditional 501, `invoices.ts:419-470`; MNE-001-297); pending requests not surfaced (G6) |
| C3 | CFF art. 69-B (EFOS) | The SAT's `ValidacionEFOS` is read (`cfdi-status.ts:91`) and dropped: only in a transient `rawResponse` (`sat-validation.ts:54`), not stored | Absent (MNE-001-349, wave 4, Could) |

### 1.4 Descarga masiva and census

| # | Norm | What the code does | Verdict |
|---|---|---|---|
| D1 | SAT web service «Descarga masiva de CFDI y retenciones»: autenticación, SolicitaDescargaEmitidos/Recibidos, VerificaSolicitudDescarga, Descargar; EstadoComprobante; limits (tv for the published figures) | `src/services/sat-download/descarga-masiva.ts`: request written before the call, lifetime limit of two identical XML requests (`LIFETIME_XML_LIMIT`, migration 167), quota released when the SAT registered nothing; codes 300–305, 404, 5000–5012 (`sat-codes.ts`); received XML asks `Vigente` (5012); packages archived by bytes with SHA-256 (migration 310). CLI `sat download create/check/status/list`, `sat package download [--import]`, `sat quota show` | Correct (read; auth and WS-Security modules not assessed) |
| D2 | Completeness of the month (SCOPE MVP step 2) | `sat-census/census.ts` (metadata and ZIP), `reconcile.ts`: to_fetch, to_post, cancelled_booked, surplus, per direction with coverage; panel keys `census_cfdi_types`, `census_missing_at_close`; `sat download reconcile` | Correct |
| D3 | Unattended daily metadata sync | Absent: MNE-001-429 and 430 (wave 3, open; 429 waits for the owner's `/aprobar-plan` on consent) | Open MVP work |

### 1.5 Issuance, PAC, conservation

| # | Norm | What the code does | Verdict |
|---|---|---|---|
| E1 | CFF 29 fr. II–IV, 29-A; Anexo 20 (sello with the CSD, cadena original by the SAT XSLT) | `cfdi40/income-cfdi.ts`: type I only, XSD-valid, **unsealed**; fixed `MetodoPago=PPD`, `FormaPago=99` (`:92-93`), `Exportacion=01` (`:249`); no Serie, Descuento, retenciones, IEPS, CfdiRelacionados, InformacionGlobal; foreign receiver refused. REST only: `POST /v1/invoices/:id/cfdi/stamp` (`invoices.ts:285-416`), one transaction with the row locked, never stamps twice, a simulated folio is stored `failed`. No CLI leaf | Cannot stamp for real (MNE-001-296) |
| E2 | PAC contract (RMF rules on proveedores de certificación) (tv) | Router with failover and circuit breaker (`pac-router.ts`); four adapters: Finkok, SW Sapien, Edicom `simulado = true`; Sovos `simulado = false` but, by MNE-001-534's own acceptance, cannot stamp or cancel as written. No call timeout (MNE-001-765) | Not usable (MNE-001-534, 310–313, 765) |
| E3 | REP issued (complemento de pagos 2.0) and its deadline (tv) | Absent (MNE-001-323, wave 4, Could). With E1's fixed PPD every collected invoice would need one | Absent |
| E4 | CFF art. 30 (five years) — SCOPE, owner's decision of 2026-09-30; NOM-151-SCFI (tv) | Received XML kept whole with its hash (`xml_documents.xml_content`, `xml_hash`), SAT packages by bytes, Anexo 24 artifacts with hash; no delete path found in `src`. The **stamped** XML a PAC returns (`xml_timbrado`) is not stored by the stamp route: only UUID, status, provider (`invoices.ts:386-394`). No retention policy (MNE-001-322). NOM-151: MNE-001-268/269 | Partial (G9) |
| E5 | CFF 17-D…17-K (e.firma; buzón) | e.firma custody and consent in `fiscal-credentials/` (`sat cred add/status/audit/revoke`); not assessed here. Buzón tributario: N (SCOPE: the SAT offers no public web service, the system does not scrape) | — |

## 2. Gaps: backlog coverage and class

R = blocks a release for real use · S = should be in the release · C = could wait · N = out by owner decision.
«R·v1.0» = blocks only the part of the release that stamps (the owner asked to integrate the v1.0 into the MVP).

| G | Gap | Evidence | Backlog | Class |
|---|---|---|---|---|
| G1 | A received CFDI in a foreign currency processed by `bill inbox run` or `POST /v1/pre-registrations/:id/process` posts the CFDI's figures as functional currency. Case: Moneda USD, TipoCambio 18.50, SubTotal 1,000.00, IVA 160.00, Total 1,160.00, PPD → classifier verdict `ready`, lines DR 6100 1,000 / DR 1135 160 / CR 2100 1,160 (probe03b) with the warning «amounts are recorded in the functional currency» (`cfdi-classifier.ts:337`); the bill row is written USD at 18.50 (`pre-registration-service.ts:1902-1910`); expected in MXN 18,500 / 2,960 / 21,460. The final `createJournalEntry` was read, not executed | read + probe | no task | **R** |
| G2 | Two `CfdiRelacionados` nodes lose every relation. Case: an issued I with TipoRelacion 04 and 07 → `tipoRelacion` empty → `cfdi post` skips both its «applies advance» refusal and its «substitutes a live invoice» guard (`pre-registration-service.ts:1578-1590`) and books a second sale. A received E with two nodes is refused (`not_credit_note`), which is safe | probe | no task | **R** (narrow, silent) |
| G3 | Vouchers XML and the two auxiliaries are not gated by the official XSD | `officialXsdRefusal` is called only for chart and trial balance | MNE-001-667 (w3, open); 774 (w3, open) | S |
| G4 | Vouchers XML carries no CompNal for a received credit note (`vendor_credit_note`), payroll (`pay_run`), nor any typed entry with a CFDI; there is no finding that names a voucher whose origin has a CFDI and no node; `TipCamb` is never written (only `Moneda`) | `polizas-service.ts:1042-1130`; header comment `:68-84` («cfdi link add» does not exist) | no task (595 covers only the payment trace of a typed entry) | S |
| G5 | `Concepto` of vouchers always in Spanish | — | MNE-001-173 (w4, Should, v1.0 scope) | S |
| G6 | A received CFDI with a cancellation request in process (the SAT's `EstatusCancelacion`) is stored in `sat_efecto_cancelacion` and shown by `cfdi status show`, but no probe lists the ones waiting for the entity's answer nor their term (tv) | `cfdi-status.ts:264-268` | no task | S |
| G7 | An issued credit note CFDI (type E) that arrives by ingestion or download has no door | B6 | no task | S |
| G8 | Received type E beyond «one unpaid MXN bill»: several related bills (a volume rebate), a bill already paid (vendor credit balance), TipoRelacion 07 (application of a vendor advance) — all wait in the inbox for ever | `received-credit-note.ts:81-106` | no task | S |
| G9 | The stamped XML and the cancellation acknowledgement are not stored | E4 | no task (296/297/534 do not say it) | **R·v1.0** |
| G10 | Seal with the CSD; real PAC (Sovos first, keys by the administrator); cancellation; call timeout | E1, E2, C2 | MNE-001-296, 534, 297, 765 (w4, open, v1.0 scope) | **R·v1.0** |
| G11 | `MetodoPago` of a stamped invoice and its VAT (PPD parks in 2125) | `income-cfdi.ts:92` | MNE-001-500, 501 (w4, open; 500 is a migration on the critical path) | **R·v1.0** (wrong VAT month otherwise) |
| G12 | Issued REP | E3 | MNE-001-323 (w4, **Could**) | **R·v1.0** (priority to raise) |
| G13 | No CLI leaf stamps or cancels an invoice (the CLI is the product; RNF-03) | `docs/cli-command-catalog.md:672-714` names `cfdi stamp/cancel`; only REST exists | no task | S·v1.0 |
| G14 | Income CFDI builder: no Serie, discounts, withholdings, IEPS, público en general / global, foreign receiver | E1 | no task | S·v1.0 |
| G15 | Issued credit note (type E) cannot be built or stamped; re-stamp of a cancelled invoice without CfdiRelacionados | E1 | 788 (w4, Should) for the re-stamp; no task for type E | S·v1.0 |
| G16 | Other PACs; payroll CFDI cancellation | — | MNE-001-310…313, 767 (w4, Could) | C |
| G17 | Unattended metadata sync | D3 | MNE-001-429, 430 (w3, open) | S |
| G18 | EFOS (69-B) flag dropped | C3 | MNE-001-349 (w4, Could) | S (priority to raise: the datum is already fetched) |
| G19 | Retention policy CFF 30 | E4 | MNE-001-322 (w4, Should) | S |
| G20 | NOM-151 constancia | E4 | MNE-001-268, 269 (w4, Could; v1.0 scope by MVP.md §3) | S |
| G21 | The corpus and `legal_parameters` carry no text of the RMF rules on e-accounting (who sends, what, deadlines, vouchers on request) nor on cancellation (deadline, acceptance, motivos); only 2.7.1.39 and one mention of 29-A | `grep` of `src/ai/docs` | no task | S |
| G22 | e-accounting status and deadlines per month | A8 | MNE-001-304 (w4, Could) | C |
| G23 | Anexo 24 file names, ZIP and `Anio` range marked «NO VERIFICADO» | A7 | no task | C |
| G24 | Seal / cadena / CSD validity of a received CFDI | B1 | MNE-001-352 (w4, Could) | C |
| G25 | IEPS kept in `xml_documents`; received IEPS; local taxes detail | B12 | MNE-001-346, 494–497, 351 | C (494–497 S, another reviewer's IVA/IEPS domain) |
| G26 | Customer advance by procedure B | B11 | MNE-001-525 (w4, Should) | S |
| G27 | Payer trace from an ingested REP; REST receipts trace | — | MNE-001-635, 634 (w4, Could) | C |
| G28 | CFDI de retenciones parser; CFDI global distinguished; advance detected by a word in the description (held for a person, so safe); a received advance posts its VAT straight to creditable (`cfdi-taxonomy.ts:149-160`) | B11, B13, B14 | no task | C |
| G29 | Carta Porte and Comercio Exterior | B9 | no task, no decision | C (needs the owner's «out» in SCOPE to become N) |
| G30 | Filing with the SAT; buzón tributario | A1, E5 | — | N (SCOPE, MVP.md «Fuera del MVP») |
| G31 | Backlog drift: MNE-001-775 merged (`7cfa35f4`, #1063) and still `open` in `docs/backlog/PRD-001.json` | `git log` | — | process note |

Count: **R 2** (G1, G2) · **R·v1.0 4** (G9–G12) · **S 16** (G3–G8, G13–G15, G17–G21, G26, and 494–497 inside G25) · **C 8** (G16, G22–G25, G27–G29) · **N 1** (G30).

## 3. Proposed new tasks

| # | Title (backlog style) | Issue | Lane | Lines | Depends on | Flags |
|---|---|---|---|---|---|---|
| N1 | Un CFDI recibido en moneda extranjera se contabiliza en la moneda funcional con sus columnas de divisa, o la bandeja se niega nombrando la moneda | #692 (or a new one) | B | 2 PRs: 150 (the refusal, first) + 350 | corpus text of CFF art. 20 first | Accepted-practice choice → ADR-0006 panel key (the document's TipoCambio or the published rate); conservative default: hold. No migration. Integration spec with the case of G1 |
| N2 | El parser lee todos los nodos CfdiRelacionados de un CFDI 4.0, y cada puerta que lee TipoRelacion ve todas las relaciones | #125 | B | 180 | — | No migration; `xml_documents`/facts shape changes (stored facts JSON) |
| N3 | El XML de pólizas declara el CFDI de una nota de crédito recibida y los de la nómina, escribe TipCamb, y una póliza con CFDI en su origen y sin CompNal sale con su hallazgo | #608 | E | 350 | MNE-001-667 | No migration |
| N4 | Una nota de crédito emitida (CFDI tipo E) que llega por la ingesta se registra por la puerta de notas de crédito de CxC, ligada a su factura | #620 | C | 350 | — | Shares the core of `credit-note-service`; critical path no |
| N5 | Una nota de crédito recibida que nombra varias facturas o una ya pagada, y la aplicación de un anticipo a proveedor (TipoRelacion 07), tienen puerta | #692 | C | 400 (2 PRs) | N2 | Accepted-practice choice (how a rebate is spread; credit balance vs refund) → panel key |
| N6 | Las solicitudes de cancelación en proceso de un CFDI recibido se nombran con su plazo en `ap check` | #643 | X | 200 | N8 | Term from `legal_parameters` (data migration) |
| N7 | El dato ValidacionEFOS del SAT se guarda con el CFDI (first PR of MNE-001-349, raised to Should) | #125 | B | 120 | — | Migration (one column) |
| N8 | Normas: el corpus lleva el texto de las reglas de la RMF sobre contabilidad electrónica y sobre la cancelación de CFDI, con su fuente, y sus plazos van a legal_parameters | #133 | G | 250 | — | Owner provides or approves the source; data migration («tablas globales de ley») |
| N9 | El XML timbrado y el acuse de cancelación se guardan por bytes, con su hash, junto al documento | #105 | X | 250 | MNE-001-534 | Migration (owner's review); CFF 30 |
| N10 | `invoice stamp` e `invoice cfdi cancel`: las hojas del CLI que timbran y cancelan por el enrutador, cerradas al agente | #105 | U | 300 | 296, 297, 534, 765 | Risk class `externo`; no migration |
| N11 | El CFDI de ingreso lleva Serie, descuentos, retenciones e IEPS, y el receptor público en general o extranjero, o la puerta se niega nombrando el dato | #105 | B | 400 (2 PRs) | 296 | Corpus (Anexo 20) first |
| N12 | El CFDI de egreso de una nota de crédito de CxC se construye con sus CfdiRelacionados | #105 | B | 350 | 296, 788 | — |
| N13 | Los nombres de archivo y el .zip del Anexo 24 se verifican contra el documento técnico del SAT, y las marcas NO VERIFICADO desaparecen | #608 | E | 120 | N8 | — |
| — | Re-prioritise, no new task: MNE-001-323 (REP emitido) Could → Must for the v1.0; MNE-001-349 Could → Should; mark MNE-001-775 done | | | | | |

## 4. Top findings

1. **G1 (R)** A received CFDI in USD goes to the ledger at face value as pesos through the hand inbox door; no conversion, no refusal, and a warning that says the opposite. No task.
2. **G2 (R)** A CFDI 4.0 with two `CfdiRelacionados` nodes is read as having none; the issued hand door then skips its advance and substitution guards. No task.
3. **G10 (R·v1.0)** Nothing can stamp: the income CFDI is unsealed, three of four adapters are simulators and the Sovos one must be redone; cancellation is a 501. All tasked in wave 4 (296, 534, 297, 765), none started.
4. **G11/G12 (R·v1.0)** The builder writes PPD on every invoice while the ledger and the REP side are not ready for it (500, 501 open; REP issuance 323 is «Could»).
5. **G9 (R·v1.0)** The stamped XML is not stored. No task.
6. **G3/G4 (S)** Vouchers and auxiliaries: no XSD gate yet (667), and silent missing CompNal for received credit notes and payroll. Chart and trial balance are XSD-gated and sound.
7. **G7/G8 (S)** Credit notes: an issued type E has no door; a received one posts only against one unpaid MXN bill.
8. **G6 + G18 (S)** Two data the SAT already hands over are not used: the cancellation in process and the EFOS flag.
9. **G21 (S)** The agent's corpus and `legal_parameters` hold none of the RMF rules of this domain (deadlines, who files, cancellation terms): every such figure in this report is «to verify».
10. **Sound, by reading:** descarga masiva (quota, codes, archive), the census and its reach into the close, cancellation detection to mirror/invoice/bill, REP linkage through the payment door, the Anexo 24 chart, trial balance and seal.

## 5. Not reviewed

- `src/services/sat/diot/**` (another reviewer); payroll CFDI issuance (`payroll/mx/cfdi-nomina-generator.ts`).
- `fiscal-credentials/`, `vault/`, `sat-download/authentication.ts`, `ws-security.ts`: not assessed.
- Read by outline, not line by line: `polizas-service.ts` (1,639), `balanza-service.ts`, `catalogo-cuentas.ts`, `catalog-reader.ts`, `balance-reader.ts`, `polizas-auxiliar-xml.ts`, `rep-linkage.ts` after line 110, `rules-engine.ts`, `processing-rules.ts`, `account-roles-seed.ts`, `zip-reader.ts`, the REST routes of `xml-ingestion`, the Sovos adapter's internals (MNE-001-534's statement taken as given).
- No integration test was run; G1's last step (the posted entry) is by reading. No PAC, SAT or key was touched.
- GitHub: only issue #105 was read. Rule numbers, deadlines and limits of the RMF, Anexo 20 guide and the download service are from memory and marked (tv).
