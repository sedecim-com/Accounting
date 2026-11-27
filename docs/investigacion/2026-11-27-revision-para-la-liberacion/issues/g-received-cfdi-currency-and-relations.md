Issue: #1073

## Goal

A CFDI in a currency other than the entity's functional one never reaches the ledger at face value: every door that posts it refuses it by name until the firm has chosen its rate, and then posts it converted, with its FX columns. A CFDI 4.0 with several `CfdiRelacionados` nodes is read whole, and both doors of an issued CFDI refuse an applied advance or a substitution.

## Tranche and context

- **Tranche:** new, from the standards-and-code review of 27 Nov 2026 (report 03, findings G1 and G2). Read at `develop` `e9a327d0`.
- **Where each task hangs.** MNE-001-895 is this issue's own. MNE-001-894 is filed under #1066 with the rest of the foreign-currency work; its evidence, fork and criteria are written here and travel with it.
- **G1 · a received CFDI in another currency is posted as pesos.**
  - `createBillFromPreReg` (`src/services/xml-ingestion/pre-registration-service.ts:1353-1459`) writes the bill with the CFDI's `currency_code` and `exchange_rate` (`:1902-1910`) and posts the classifier's lines as they are (`:1421`): no conversion, no FX columns. `cfdi-posting-plan.ts` never reads a rate.
  - The case, run on the classifier (probe in the report): Moneda USD, TipoCambio 18.50, SubTotal 1,000.00, IVA 160.00, Total 1,160.00, PPD → verdict `ready`, DR expense 1,000 / DR 1135 160 / CR vendors 1,160. It should be 18,500.00 / 2,960.00 / 21,460.00. Its warning says the opposite: «amounts are recorded in the functional currency» (`cfdi-classifier.ts:337`).
  - Doors with no refusal: `bill inbox run` (`src/cli/bill-command.ts:1673`), `POST …/pre-registrations/:id/process`, `/bulk` and `/processing-batches/:id/execute` (`src/api/rest/routes/xml-ingestion.ts:395`, `:512`, `:772`), and the approval of a bound draft, which reconciles the entry against the CFDI's own figures (`pre-registration-service.ts:2197-2235`; issued side `issued-invoice-approval.ts:172`, `:363-370`). Doors that do refuse: the auto-post gate (`src/ai/ingest-service.ts:610-616`) and `cfdi post` (`pre-registration-service.ts:1550`).
  - Read and probed, not executed end to end: N1's first step reproduces it in an integration spec.
  - The rest of the house already converts: `bill create` at the document's rate, refusing a rate of 1 (`postBillEntry`, `src/services/accounting/ar-ap-posting.ts:283-313`); `invoice issue` at the `fuente_tipo_cambio` rate of the day, refusing a conflicting rate (`src/ai/docs/receivables.md:17`).
- **G2 · two relation nodes are read as none.**
  - `cfdv40.xsd:39` (vendored, `src/services/sat/cfdi40/xsd/cfd/4/`) declares `CfdiRelacionados` with `maxOccurs="unbounded"`. `parseCfdiRelacionados` (`cfdi-parser.ts:190-203`) expects one object: with two nodes it returns `{tipoRelacion:'', uuids:[]}` (probe).
  - The case: an issued invoice of 1,160.00 with relations 04 and 07 passes both refusals of `cfdi post` (`pre-registration-service.ts:1586-1593`) and books a second sale of 1,160.00. A received type E with two nodes is refused (`received-credit-note.ts:80-83`), which is safe.
  - Found on the way, by reading: the approval of an issued draft (`registerIssuedInvoice`, `issued-invoice-approval.ts:172`) reads no `TipoRelacion` at all, so the two refusals exist at the hand door only.
- **Sources.** NIF B-15 (corpus, `nif-registro.md`). CFF art. 20: the rate Banxico publishes in the DOF the day before (`docs/investigacion/2026-09-06-normas-y-motores/normas/fiscal-mx.md:129`, source 7). Anexo 20: the vendored XSD.
- **Forks** (ADR-0006, the owner's rule of 17 Nov):
  - *Which rate a received CFDI is born at:* new key `received_cfdi_exchange_rate`: `hold` (default) · `document_rate` (the CFDI's TipoCambio, as `bill create`) · `published_rate` (`fuente_tipo_cambio` on the CFDI's date; no published rate, it fails closed). `hold` is the conservative one: nothing is posted at a rate the firm did not choose, and the CFDI's rate is the vendor's figure.
  - *How relations are read:* no fork; the schema decides.

## Tasks

| Temp id | Title | Size | Depends on | Class |
|---|---|---|---|---|
| MNE-001-895 | El parser lee todos los nodos CfdiRelacionados de un CFDI 4.0, y las dos puertas de un CFDI emitido se niegan ante un anticipo aplicado o una sustitución | 180 | — | R |

Filed under #1066, described here: MNE-001-894 (the foreign-currency CFDI), 150 + ~350 lines, its plan splits it in 2, class R.

## Acceptance criteria

- [ ] (N1, part 1) Given the USD case above, `bill inbox run`, the three REST routes and the approval of its draft refuse it by catalogue key, in `en.ts` and `es.ts`, naming the currency and the CFDI's rate; nothing is written, the pre-registration stays in the inbox with that reason, and `cfdi explain <uuid>` shows it.
- [ ] (N1, part 1) The warning of `cfdi-classifier.ts:337` no longer says the amounts are in the functional currency.
- [ ] (N1, part 2) With `received_cfdi_exchange_rate=document_rate`, the same CFDI posts DR expense 18,500.00 / DR 1135 2,960.00 / CR vendors 21,460.00, each line with currency, foreign amount and 18.50, and the bill keeps USD 1,160.00 at 18.50.
- [ ] (N1, part 2) With `published_rate` and a published rate of 18.40, the entry is 18,400.00 / 2,944.00 / 21,344.00 and the bill's rate is 18.40; with no published rate it refuses and names `fx rate set`.
- [ ] (N1, part 2) With the key unanswered or on `hold`, part 1's refusal stands and names the key.
- [ ] (N1) A CFDI in the functional currency posts exactly as today.
- [ ] (N2) Given two `CfdiRelacionados` nodes (04 and 07), the parser returns both, each with its UUIDs.
- [ ] (N2) Given that issued invoice, `cfdi post` and the approval of its draft both refuse: `applies_advance`, and `ISSUED_CFDI_SUBSTITUTES_INVOICE` when the replaced invoice is live.
- [ ] (N2) Given one node, every reader behaves as today; facts stored in the old shape are still read.

## Impact

| Contract | Impact | Action |
|---|---|---|
| Published API | compatible | The process routes gain a 422 for the currency; `docs/openapi.json` regenerated |
| SAT/IMSS deliverables | compatible | The vouchers XML reads the bill's currency as before |
| Schema (migration) | none | — |
| CLI surface | compatible | New refusals by key; one panel key in `pending-catalog.ts`; `mexico-cfdi.md` and `payables.md` reread and resealed |

## Out of scope / later

- Bills already posted at face value: part 1's plan adds a read-only census of them (bills in another currency whose entry has no FX columns); correcting them is a task of its own if the census finds any.
- A received credit note or a REP in another currency (the note is refused today; the REP follows `rep_moneda_extranjera`).
- Seal and CSD validity of a received CFDI (MNE-001-352); IEPS in `xml_documents` (MNE-001-346); ImpuestosLocales detail (MNE-001-351).
- A parser for the CFDI de retenciones; the CFDI global; Carta Porte and Comercio Exterior, which need the owner's «out» in `docs/SCOPE.md`.
- Posting the applied advance (MNE-001-525; #1074).

## How to test

- `scripts/verify.sh` with integration.
- **Unit:** `cfdi-parser.spec.ts` (one node, two nodes, none); `cfdi-taxonomy.spec.ts` (the USD case; each reader of the relation list).
- **Integration:** beside `ing3-issued-cfdi-by-hand.int.spec.ts` and `f04-pagar.int.spec.ts`: the USD case through each door, red first; part 2 under each value of the key, then a payment at another rate to see the realised difference.
- **Edge cases:** Moneda `XXX`; TipoCambio absent or 1 on a non-MXN CFDI; a USD-functional entity receiving an MXN CFDI.

## Classification

- **Difficulty:** D3 (posted money; four doors share the change). **Autonomy:** A3.
- **Size:** N2 ~180 lines in one PR. N1 (under #1066) ~500 in two: the refusal, 150, goes first and alone. «Part of #N» on each.
- **Route:** release (wave 3), Must.

## Constraints

- Invariant 6: the rate is a panel key with its reader; no default rate in code.
- The conversion reuses `convertirAFuncional` and the FX columns `posting.ts` verifies.
- No posted entry is edited.

## Depends on

- N2: nothing.
- N1: its part 1 nothing; its part 2 converts under the rounding rule of MNE-001-862 (#1066), kept as text, not as `depends_on`: whichever merges second rebases.

**Para el dueño:** hoy una factura de proveedor en dólares que entra por la bandeja se registra en el mayor con el número de dólares como si fueran pesos: 1,160 en vez de 21,460. Con esto, primero ninguna puerta la deja pasar y dice por qué; después se registra convertida, al tipo de cambio que el despacho elija en el panel (el del CFDI o el publicado); mientras no elija, espera. Aparte, una factura emitida que sustituye a otra y aplica un anticipo deja de registrarse como una venta nueva.

---
_Generated by [Claude Code](https://claude.ai/code)_
