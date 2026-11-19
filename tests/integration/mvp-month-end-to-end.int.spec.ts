import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { BUILTIN_PROFILES } from '../../src/ai/providers/config.js';

// ============================================================
// MVP-E2E · THE MONTH OF AN SME, END TO END (#311, MNE-001-097)
//
// docs/MVP.md §1 defines the MVP as nine steps a firm can run from the
// terminal. This file is that definition made executable: one synthetic
// company, December 2025, driven ONLY through the real binary
// (`src/cli/mnemosine.ts` in a child process, the way an accountant types
// it), without an AI provider, against the ephemeral database that
// tests/integration/global-setup.ts creates and drops for every run.
//
// WHAT IS GREEN AND WHAT IS `it.todo`. Every step that already works runs for
// real; every one that does not is an `it.todo` naming the backlog task(s)
// in docs/backlog/PRD-001.json that will turn it green. MNE-001-098 closes
// #311 when this file has no `it.todo` left, so the route to the MVP is the
// list below and it empties itself.
//
// WHY DECEMBER 2025. Period states depend on today's date (a month after
// today is `future`), so a month in 2026 would change meaning as the calendar
// moves. December 2025 is always in the past, and it is also the last month
// of the year, which is where the fiscal-year close with period 13 belongs.
//
// THE FIGURES ARE WRITTEN BY HAND, never copied from the output: a test
// generated from the system's own answer cannot fail. Each constant carries
// its derivation from the opening and the twenty documents of the month.
//
// NOTHING IS SEEDED WITH SQL. The firm and its user come from `tenant create`
// and `user create`, like every other row of the month (MNE-001-406).
//
// THE OPENING IS MIGRATED, NOT TYPED (MNE-001-407). The company arrives from
// another system with its 2024 books in Anexo 24 XML: `chart import` adds the
// one account the seeded chart lacks, `opening-balance import` posts the
// balances on 2025-01-01, the first day of the fiscal year, and January to
// November, which hold nothing else, are hard-closed in order so that their
// carry-forward opens December with them.
//
// THE RECEIVED CFDI GO BY THE MANUAL PATH (MNE-001-408). A consultant's PPD
// and a cleaner's two PUE come from tests/fixtures/cfdi, rewritten to this
// company and December; the REP that pays the PPD is inline, since that
// folder has none. With no model, `bill inbox edit` and `bill inbox run` post
// the PPD and the first PUE, a rule posts the second on `ingest --retry`, and
// `ingest` links the REP by itself. The child runs with SAT_STATUS_MODE=off,
// so no synthetic UUID goes to the SAT. Each PUE is paid on its date: a PUE
// declares one payment. The PPD is coded by its line (`--line 1`), because
// the product suggests the opening bill's 2110 for an unknown issuer's line.
//
// THE EDGE CASES OF THE CFDI (MNE-001-409). Four more received CFDI, each a
// PUE paid on its date. Two are written here, because every fixture carries
// IVA at 16 %: a bookshop's own edition at 0 % and its resold magazines,
// exempt. Its folio keeps its leading zeros and its name its accents. A hotel
// night brings a local tax (ISH), posted to a leaf of its own once that leaf
// takes the role. An individual's fees bring withholdings: the company pays
// the net, and owes the SAT the ISR and the IVA it withheld.
//
// THE SAT CENSUS OF DECEMBER (MNE-001-410). The firm downloads the metadata
// of what it received in December and loads it with `ingest --kind metadata`.
// `sat download reconcile` then reads that census against the books: the
// eight CFDI above agree, one that arrived and nobody coded is still to post,
// and one the firm never brought in is still to fetch. Both gaps stay to the
// end of the month, since a received gap only warns at the close. No census
// of issued CFDI is loaded, and the command says so: a gap there would stop
// the close by default (`census_missing_at_close`).
//
// THE SUBLEDGERS TIE TO THEIR CONTROL ACCOUNTS (MNE-001-411). `ar reconcile`
// and `ap reconcile` read the open invoices and bills against 1120 and 2110.
// The payables side is cut at 2025-12-31; `ar reconcile` takes no cut-off, so
// receivables are read as they stand on the day of the run, which is where
// December left them: the month posts nothing after the 31st. A sale typed as
// a journal entry, with no invoice, then puts 2,000 on 1120 that no document
// explains, and the close refuses the month until `entry reverse` mirrors it
// with a date inside December. `entry void` would not do: its mirror takes
// the date of the run, outside the month.
//
// THE BANK STATEMENT AND ITS BASELINE (MNE-001-412). The company's one bank
// account is tied to 1111, and December's statement arrives as the CSV the
// bank's site exports: it lists movements and no balances, so the closing
// balance is typed from the printed statement and the opening follows from
// it. The bank and the books tell the same December, which is why the
// computers, paid from the bank on 12-01, are bought in section 3 with the
// rest of the cash: the asset itself is still registered at the close. The
// bank charged a fee the books do not know yet, so it ends 348.00 below 1111.
// This is the account's first reconciliation, and it starts from a baseline:
// the 100,000.00 that 1111 held on 11-30, which is the opening migrated in
// January. Nothing before December is left to explain. A second download
// that repeats movements of the first is refused whole.
//
// RECONCILE, THE FEE AND REOPEN (MNE-001-413). The matcher ties eleven of the
// thirteen movements to the lines of 1111 and finds nothing for the bank's
// own two. The guided pass raises those as reconciling items: charges the
// books still owe. Each gets an adjustment, which is a draft, and an owner
// and a date, which nobody but a person can give. Then the session closes,
// is signed and is posted, and only the post moves the ledger: 300.00 of fee
// to 6310 and its 48.00 of IVA to 1130, both out of 1111, which now ends where
// the statement does. Reopening the posted session deletes nothing: each
// entry gets a mirror dated the same 12-31, the adjustments are drafts again
// and the items open, and the same range closes, is signed and posts a second
// time. All of it happens before December is hard-closed.
//
// NO MODEL PROVIDER, AND THE FIRST TEST PROVES IT. In the child (`childEnv`)
// the helper blanks MNEMOSINE_PROVIDER, every ANTHROPIC_* variable, the
// credential each built-in profile names (`api_key_env` of BUILTIN_PROFILES)
// and the two switches that would let a .env override those blanks
// (DOTENV_OVERRIDE, DOTENV_CONFIG_OVERRIDE), and it points HOME and
// XDG_CONFIG_HOME at a throwaway directory. So none of these variables, in the
// shell or in a .env of whoever runs the suite, can turn the manual path into
// a model's. A mnemosine.config.json in the checkout can declare providers of
// its own (a key, an api_key_cmd, a default_provider) that no blank reaches,
// so the first test fails when the child loads one; CI has none.
//
// NO POSTGRES, NO RUN: without TEST_ADMIN_DATABASE_URL (a role that can
// CREATE DATABASE) the integration suite refuses to start, and
// `scripts/verify.sh` reports that SKIP with its reason. CI has the database.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
/** One CLI invocation costs a tsx start-up (~5 s); a step runs several. */
const STEP_TIMEOUT_MS = 240_000;

// SAT's published test RFC for the company; synthetic ones for its parties.
const COMPANY_RFC = 'EKU9003173C9';
const COMPANY_NAME = 'Comercializadora Sintetica SA de CV';
const CUSTOMER_RFC = 'SIN060101AB1';
const VENDOR_RFC = 'PRV060101AB1';

// ── THE OPENING, FROM THE PREVIOUS SYSTEM ──────────────────────────────
// The books at 2024-12-31: the chart (CtaCatalogo) and the trial balance
// (BalanzaComprobacion) of the migration are both written from these rows.
// Every code but 1320, a rent deposit, is one the seeded chart already has,
// so `chart import` creates 1320 alone; SubCtaDe and Nivel follow the seeded
// tree, where the role accounts 1135 and 2125 hang from 1100 and 2100, the
// headers of their class (MNE-001-482). Eight accounts carry a balance of
// their own:
//   1120  3,480.00 is one open invoice, 3,000 + 480 of IVA: uncollected, so
//         its 480 sits in 2125, IVA trasladado no cobrado
//   2110  2,320.00 is one open bill, 2,000 + 320 of IVA: unpaid, so its 320
//         waits in 1135 until it is paid (LIVA art. 5 fr. III)
// Debits 100,000 + 3,480 + 320 + 4,000 = 107,800 = credits 2,320 + 480
// + 100,000 + 5,000: the entry foots by itself, with no plug. As the Anexo 24
// asks, the parents declare their subaccounts inside, so they carry nothing
// of their own to post: 1000 = 103,800 + 4,000; 1100 = 100,000 + 3,480 + 320;
// 2000 = 2100 = 2,320 + 480; 3000 = 100,000 + 5,000.
const OPENING_2024 = [
  // NumCta, Desc, CodAgrup, SubCtaDe, Nivel, Natur, SaldoFin
  ['1000', 'Activo', '100', '', 1, 'D', '107800.00'],
  ['1100', 'Activo Circulante', '100.01', '1000', 2, 'D', '103800.00'],
  ['1110', 'Caja y Bancos', '102', '1100', 3, 'D', '100000.00'],
  ['1111', 'Banco Nacional - MXN', '102.01', '1110', 4, 'D', '100000.00'],
  ['1120', 'Cuentas por Cobrar', '105.01', '1100', 3, 'D', '3480.00'],
  ['1135', 'IVA Pendiente de Acreditar', '119.01', '1100', 3, 'D', '320.00'],
  ['1300', 'Activo Diferido', '100.02', '1000', 2, 'D', '4000.00'],
  ['1320', 'Depósitos en Garantía', '184.02', '1300', 3, 'D', '4000.00'],
  ['2000', 'Pasivo', '200', '', 1, 'A', '2800.00'],
  ['2100', 'Pasivo Circulante', '200.01', '2000', 2, 'A', '2800.00'],
  ['2110', 'Cuentas por Pagar', '201.01', '2100', 3, 'A', '2320.00'],
  ['2125', 'IVA Trasladado No Cobrado', '209.01', '2100', 3, 'A', '480.00'],
  ['3000', 'Capital Contable', '300', '', 1, 'A', '105000.00'],
  ['3100', 'Capital Social', '301.01', '3000', 2, 'A', '100000.00'],
  ['3200', 'Resultado de Ejercicios Anteriores', '304.01', '3000', 2, 'A', '5000.00'],
] as const;
const OPENING_DEBITS = '107800.00';
const SAT_NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3';
const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8"?><catalogocuentas:Catalogo xmlns:catalogocuentas="${SAT_NS}/CatalogoCuentas" ` +
  `Version="1.3" RFC="${COMPANY_RFC}" Mes="12" Anio="2024">` +
  OPENING_2024.map(([num, desc, group, parent, level, nature]) =>
    `<catalogocuentas:Ctas CodAgrup="${group}" NumCta="${num}" Desc="${desc}"` +
    `${parent ? ` SubCtaDe="${parent}"` : ''} Nivel="${level}" Natur="${nature}"/>`).join('') +
  '</catalogocuentas:Catalogo>';
// No movement in December 2024, so SaldoIni is SaldoFin: the cutoff is what matters.
const TRIAL_BALANCE_XML =
  `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza xmlns:BCE="${SAT_NS}/BalanzaComprobacion" ` +
  `Version="1.3" RFC="${COMPANY_RFC}" Mes="12" Anio="2024" TipoEnvio="N">` +
  OPENING_2024.map(([num, , , , , , balance]) =>
    `<BCE:Ctas NumCta="${num}" SaldoIni="${balance}" Debe="0.00" Haber="0.00" SaldoFin="${balance}"/>`).join('') +
  '</BCE:Balanza>';
// The documents behind 1120 and 2110, as the previous system's subledgers list
// them. Parties of their own, so that section 3's 'Cliente Sintetico' and
// 'Proveedor Sintetico' still name one each.
const OPEN_DOCUMENTS = [
  { cuenta: '1120', documento: 'A-2024-117', contraparte: 'Distribuidora del Bajio SA de CV', rfc: 'DBA060101AB1',
    fecha: '2024-12-10', vencimiento: '2025-01-09', importe: '3480.00' },
  { cuenta: '2110', documento: 'F-2024-881', contraparte: 'Servicios Logisticos del Norte SA de CV', rfc: 'SLN060101AB1',
    fecha: '2024-12-12', vencimiento: '2025-01-11', importe: '2320.00', ivaRate: '0.16' },
];

// ── THE RECEIVED CFDI OF DECEMBER (MNE-001-408) ────────────────────────
// Two vendors, personas morales like the company. Their names stay far from
// every vendor name in the entity, the opening's included: `ingest` matches
// an issuer by RFC, or by a name over 0.7 of trigram similarity. Neither name
// holds section 3's 'Proveedor Sintetico'. The consultant issues the PPD and
// its REP; the cleaner issues both PUE, so the rule of step 2·196 meets the
// vendor's second CFDI.
const CONSULTANT_RFC = 'CPA060101AB1';
const CONSULTANT_NAME = 'Consultores Asociados del Pacifico SC';
const CLEANER_RFC = 'LIM060101AB1';
const CLEANER_NAME = 'Limpieza Integral Moderna SA de CV';
const CLEANING_RULE = 'Cleaning goes to 6100';
// Fixed, not uuidv4(): dedupe is per entity and every run has a fresh one, so
// a later slice can name these CFDI by constant.
const PPD_UUID = '5A1E0408-1210-4C0A-9D2E-000000002001';
const CLEANER_PUE_UUIDS = ['5A1E0408-1212-4C0A-9D2E-000000001001', '5A1E0408-1219-4C0A-9D2E-000000001002'] as const;
const REP_UUID = '5A1E0408-1222-4C0A-9D2E-00000000A001';
// The REP of the PPD, inline because tests/fixtures/cfdi has none. It copies
// the shape of tests/integration/helpers/rep-xml.ts, which this spec cannot
// import: that helper reaches src/database, whose config loads a .env.
const REP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" TipoDeComprobante="P" Moneda="XXX" Total="0" SubTotal="0"
  Fecha="2025-12-22T10:00:00" LugarExpedicion="06600" Exportacion="01">
  <cfdi:Emisor Rfc="${CONSULTANT_RFC}" Nombre="${CONSULTANT_NAME}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${COMPANY_RFC}" Nombre="${COMPANY_NAME}" UsoCFDI="CP01"
    DomicilioFiscalReceptor="01000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT"
      Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="2025-12-22T10:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="9280.00" NumOperacion="OP-2212">
        <pago20:DoctoRelacionado IdDocumento="${PPD_UUID}" MonedaDR="MXN" NumParcialidad="1"
          ImpSaldoAnt="9280.00" ImpPagado="9280.00" ImpSaldoInsoluto="0" ObjetoImpDR="02">
          <pago20:ImpuestosDR><pago20:TrasladosDR>
            <pago20:TrasladoDR BaseDR="8000.00" ImpuestoDR="002"
              TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="1280.00"/>
          </pago20:TrasladosDR></pago20:ImpuestosDR>
        </pago20:DoctoRelacionado>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${REP_UUID}"
      FechaTimbrado="2025-12-22T10:05:00" SelloCFD="x" NoCertificadoSAT="1" SelloSAT="y"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

// ── THE EDGE CASES OF THE RECEIVED CFDI (MNE-001-409) ──────────────────
// The bookshop is created before its CFDI arrive, like the cleaner. In the
// XML its name travels as character references (&#237; is í), so the accents
// the binary prints were decoded by the parser, not copied from this file.
const BOOKSHOP_RFC = 'LEB060101AB1';
const BOOKSHOP_NAME = 'Librería y Editorial del Bajío SA de CV';
// The hotel and the individual keep the issuers of their fixtures.
const HOTEL_RFC = 'HOS060101AB1';
const HOTEL_NAME = 'Hotel Sintetico SA de CV';
const FEES_RFC = 'GOMJ800101HA5';
const FEES_NAME = 'Julian Gomez Martinez';
const ZERO_RATE_UUID = '5A1E0409-1203-4C0A-9D2E-000000000123';
const EXEMPT_UUID = '5A1E0409-1204-4C0A-9D2E-000000000124';
const LODGING_UUID = '5A1E0409-1209-4C0A-9D2E-000000004001';
const FEES_UUID = '5A1E0409-1216-4C0A-9D2E-000000000056';
/** The leaf the lodging tax is posted to, created in step 2·198. */
const LODGING_TAX_ACCOUNT = '6150';
/** A CFDI of the bookshop with one concept and one IVA transfer, at 0 % or exempt. */
const bookshopCfdi = (o: { date: string; uuid: string; invoiceNumber: string; amount: string; exempt: boolean }): string => {
  const transfer = o.exempt
    ? `<cfdi:Traslado Base="${o.amount}" Impuesto="002" TipoFactor="Exento"/>`
    : `<cfdi:Traslado Base="${o.amount}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.00"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Folio="${o.invoiceNumber}" Fecha="${o.date}T10:00:00" FormaPago="03" MetodoPago="PUE"
  TipoDeComprobante="I" Moneda="MXN" SubTotal="${o.amount}" Total="${o.amount}" LugarExpedicion="37000">
  <cfdi:Emisor Rfc="${BOOKSHOP_RFC}" Nombre="${BOOKSHOP_NAME.replace(/í/g, '&#237;')}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${COMPANY_RFC}" Nombre="${COMPANY_NAME}" UsoCFDI="G03"
    DomicilioFiscalReceptor="01000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="55101500" ClaveUnidad="H87" Descripcion="Publicaciones" Cantidad="1"
      ValorUnitario="${o.amount}" Importe="${o.amount}" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados>${transfer}</cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos${o.exempt ? '' : ' TotalImpuestosTrasladados="0.00"'}><cfdi:Traslados>${transfer}</cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${o.uuid}" FechaTimbrado="${o.date}T10:05:00"
      RfcProvCertif="SAT970701NN3" SelloCFD="x" NoCertificadoSAT="30001000000500000001" SelloSAT="y"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
};

// ── THE SAT CENSUS OF DECEMBER (MNE-001-410) ───────────────────────────
// Two more received CFDI, neither of them in the books. A gardener's arrives
// on 12-29 and is left in the inbox, uncoded: fetched, not posted. A phone
// company's exists only in the SAT's list: the firm never got its XML. Their
// issuers are in no catalog, and no rule names them.
const GARDENER_RFC = 'JAR060101AB1';
const GARDENER_NAME = 'Jardineria Ornamental de Occidente SC';
const PHONE_COMPANY_RFC = 'TEL060101AB1';
const UNPOSTED_UUID = '5A1E0410-1229-4C0A-9D2E-000000007741';
const UNFETCHED_UUID = '5A1E0410-1230-4C0A-9D2E-000000000310';
// What the SAT lists as received by the company in December, a row per CFDI,
// each written by hand from its document: the date, the total and the type
// (I an invoice, P a payment receipt, whose total is 0).
const CENSUS_RECEIVED = [
  // Uuid, RfcEmisor, NombreEmisor, date of FechaEmision, Monto, EfectoComprobante
  [ZERO_RATE_UUID, BOOKSHOP_RFC, BOOKSHOP_NAME, '2025-12-03', '1200.00', 'I'],
  [EXEMPT_UUID, BOOKSHOP_RFC, BOOKSHOP_NAME, '2025-12-04', '450.00', 'I'],
  [LODGING_UUID, HOTEL_RFC, HOTEL_NAME, '2025-12-09', '1190.00', 'I'],
  [PPD_UUID, CONSULTANT_RFC, CONSULTANT_NAME, '2025-12-10', '9280.00', 'I'],
  [CLEANER_PUE_UUIDS[0], CLEANER_RFC, CLEANER_NAME, '2025-12-12', '1160.00', 'I'],
  [FEES_UUID, FEES_RFC, FEES_NAME, '2025-12-16', '9533.33', 'I'],
  [CLEANER_PUE_UUIDS[1], CLEANER_RFC, CLEANER_NAME, '2025-12-19', '1160.00', 'I'],
  [REP_UUID, CONSULTANT_RFC, CONSULTANT_NAME, '2025-12-22', '0', 'P'],
  [UNPOSTED_UUID, GARDENER_RFC, GARDENER_NAME, '2025-12-29', '1160.00', 'I'],
  [UNFETCHED_UUID, PHONE_COMPANY_RFC, 'Telefonia Sintetica SA de CV', '2025-12-30', '580.00', 'I'],
] as const;
// The metadata file of the SAT's bulk download: `~` between fields, CRLF
// between records, Estatus 1 for a CFDI in force (the contract is in
// src/services/sat-census/census.ts).
const CENSUS_METADATA = [
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion',
  ...CENSUS_RECEIVED.map(([uuid, rfc, name, date, amount, type]) =>
    `${uuid}~${rfc}~${name}~${COMPANY_RFC}~${COMPANY_NAME}~SAT970701NN3~${date} 10:00:00~${date} 10:05:00~${amount}~${type}~1~`),
].join('\r\n');

// ── THE BANK STATEMENT OF DECEMBER (MNE-001-412) ───────────────────────
const BANK_ACCOUNT = 'BBVA Operativa MXN';
// What the bank saw in December, a row per movement, each written by hand
// from the document that caused it, on that document's date. The last two
// are the bank's own: the account fee and its IVA, which no document of the
// month announces and the books do not hold yet.
const STATEMENT_MOVEMENTS = [
  // day, DESCRIPCIÓN, CARGO, ABONO
  ['01', 'SPEI ENVIADO EQUIPO DE COMPUTO', '36000.00', ''],
  ['03', 'SPEI ENVIADO LIBRERIA Y EDITORIAL DEL BAJIO', '1200.00', ''],
  ['04', 'SPEI ENVIADO LIBRERIA Y EDITORIAL DEL BAJIO', '450.00', ''],
  ['09', 'SPEI ENVIADO HOTEL SINTETICO', '1190.00', ''],
  ['10', 'SPEI RECIBIDO CLIENTE SINTETICO', '', '1160.00'],
  ['12', 'SPEI ENVIADO LIMPIEZA INTEGRAL MODERNA', '1160.00', ''],
  ['15', 'SPEI RECIBIDO CLIENTE SINTETICO', '', '5800.00'],
  ['16', 'SPEI ENVIADO JULIAN GOMEZ MARTINEZ', '9533.33', ''],
  ['19', 'SPEI ENVIADO LIMPIEZA INTEGRAL MODERNA', '1160.00', ''],
  ['20', 'SPEI ENVIADO PROVEEDOR SINTETICO', '5800.00', ''],
  ['22', 'SPEI ENVIADO CONSULTORES ASOCIADOS DEL PACIFICO', '9280.00', ''],
  ['31', 'COMISIÓN POR MANEJO DE CUENTA', '300.00', ''],
  ['31', 'IVA DE COMISIÓN', '48.00', ''],
] as const;
/**
 * The export of the bank's site (profile bbva-mx): a letterhead, the header
 * and the movements from day `from` on, in Latin-1 as the bank writes it. It
 * has no SALDO column: the file carries no balance at all. Nor a REFERENCIA:
 * a movement has no id of the bank's, so a repeated one is known by its
 * content alone, which is what `bank_statement_overlap` rules on. (With an
 * id, the importer skips the repeated row by itself and names it.)
 */
const statementCsv = (from: string): Buffer => Buffer.from([
  'BBVA MEXICO - MOVIMIENTOS DE LA CUENTA',
  'Cuenta: ****1111',
  '',
  'FECHA,DESCRIPCIÓN,CARGO,ABONO',
  ...STATEMENT_MOVEMENTS.filter(([day]) => day >= from)
    .map(([day, description, charge, credit]) => `${day}/12/2025,${description},${charge},${credit}`),
].join('\n'), 'latin1');
// By hand. The bank's December is the books' December on 1111 plus its fee:
//   credited   1,160 + 5,800                                    =  6,960.00
//   charged    36,000 + 1,200 + 450 + 1,190 + 1,160 + 9,533.33
//              + 1,160 + 5,800 + 9,280 = 65,773.33, and 300 + 48 = 66,121.33
// From the 100,000.00 of 11-30: 100,000 + 6,960 − 66,121.33 = 40,838.67, the
// balance the printed statement closes with. Until the reconciliation posts
// the fee and its IVA, the books stand 348.00 above it, at 41,186.67.
const BANK_BASELINE = '100000.00'; // 1111 on 2025-11-30: the opening, untouched until December
const STATEMENT_CLOSING = '40838.67';
const BOOKS_BEFORE_FEE = '41186.67'; // 100,000 + 6,960 − 65,773.33: 1111 before the session is posted
const BANK_FEE = '300.00';
const BANK_FEE_IVA = '48.00'; // 16 % of the fee
/** The December statement and its session, as steps 4·231 and 4·232 leave them. */
let statementId = '';

// ── THE MONTH, BY HAND ──────────────────────────────────────────────────
//   12-01 computers      1220 Dr 36,000.00 / 1111 Cr 36,000.00
//   12-03 received 0 %   6100 Dr 1,200.00 / 2110 Cr 1,200.00, and paid that day:
//                        2110 Dr 1,200.00 / bank Cr 1,200.00 (the bookshop's own
//                        edition, LIVA art. 2-A fr. I i: a rate of 0 %, no IVA line)
//   12-04 received exempt 6100 Dr 450.00 / 2110 Cr 450.00, and paid that day
//                        (magazines it resells, LIVA art. 9 fr. III: no IVA at all)
//   12-05 invoice        1120 Dr 11,600.00 / 4100 Cr 10,000.00, 2120 Cr 1,600.00
//                        (16 % of 10,000; no MetodoPago on a typed invoice → PUE)
//   12-08 bill           6100 Dr 5,000.00, 1135 Dr 800.00 / 2110 Cr 5,800.00
//                        (no MetodoPago on a typed bill → PPD, IVA parked in 1135)
//   12-09 lodging        6100 Dr 1,000.00, 6150 Dr 30.00, 1130 Dr 160.00 / 2110 Cr
//                        1,190.00, and paid that day: the 3 % ISH on the 1,000 is
//                        a cost, not a creditable tax, in a leaf of its own
//   12-10 advance        bank Dr 1,160.00 / 2150 Cr 1,000.00, 2120 Cr 160.00: a
//                        customer advance with no invoice causes its IVA the
//                        day it is collected (LIVA art. 1-B); 1,160 / 1.16
//   12-10 received PPD   6100 Dr 8,000.00, 1135 Dr 1,280.00 / 2110 Cr 9,280.00
//                        (the consultant's CFDI: PPD, so its IVA waits in 1135)
//   12-12 received PUE   6100 Dr 1,000.00, 1130 Dr 160.00 / 2110 Cr 1,160.00, and
//                        paid that day: 2110 Dr 1,160.00 / bank Cr 1,160.00, with
//                        no IVA moved (a PUE declares one payment, CFF 29-A fr. VII b)
//   12-15 receipt        bank Dr 5,800.00 / 1120 Cr 5,800.00 (half the invoice)
//   12-16 fees           6100 Dr 10,000.00, 1130 Dr 1,600.00 / 2141 Cr 1,000.00,
//                        2142 Cr 1,066.67, 2110 Cr 9,533.33: an individual's fees,
//                        so the company withholds 10 % of ISR (LISR art. 106) and
//                        two thirds of the 1,600 of IVA (LIVA art. 1-A fr. II a;
//                        RLIVA art. 3), and that day pays the net alone:
//                        2110 Dr 9,533.33 / bank Cr 9,533.33
//   12-18 credit note    4400 Dr 1,000.00, 2120 Dr 160.00 / 1120 Cr 1,160.00
//   12-19 received PUE   the same as on 12-12: the cleaner's second CFDI
//   12-20 payment        2110 Dr 5,800.00 / bank Cr 5,800.00,
//                        and the paid IVA moves 1135 → 1130: 800.00
//   12-22 REP            2110 Dr 9,280.00 / bank Cr 9,280.00, and the PPD's
//                        paid IVA moves 1135 → 1130: 1,280.00 (LIVA art. 5 fr. III)
//   12-28 stray entry    1120 Dr 2,000.00 / 4100 Cr 2,000.00: a sale typed as a
//                        journal entry, with no invoice behind it, so 1120 holds
//                        2,000 that the receivables subledger does not
//   12-31 its reversal   4100 Dr 2,000.00 / 1120 Cr 2,000.00: the mirror, dated
//                        inside December, so both wash out within the month
//   12-31 bank fee       6310 Dr 300.00 / 1111 Cr 300.00, and its IVA, 1130 Dr 48.00
//                        / 1111 Cr 48.00: one entry each, posted by the bank
//                        reconciliation. The bank took both when it charged
//                        them, so the IVA is paid and goes straight to 1130.
//                        Reopening the session mirrors both entries on 12-31
//                        and the second post books them again: three times
//                        348.00 of debits for one fee
//   12-31 depreciation   6140 Dr 900.00 / 1290 Cr 900.00, posted by the close:
//                        computer class, 30 % LISR maximum → 40-month book
//                        life; whole-month convention, so 36,000 / 40
// Debits of December: 36,000 + 11,600 + 5,800 + 5,800 + 1,160 + 5,800 + 800
// + 900 + 1,160 (the advance) = 69,020 typed, and 9,280 + 2 × 1,160 + 2 × 1,160 + (9,280 + 1,280)
// = 24,480 received by slice 3, and the edge cases: 2 × 1,200 + 2 × 450
// + 2 × 1,190 + (11,600 + 9,533.33) = 26,813.33, and the stray entry and its
// mirror, which move no balance but are debits all the same: 2 × 2,000
// = 4,000, and the bank fee with its IVA, posted, mirrored and posted again:
// 3 × 348 = 1,044. In all 125,357.33. The dossier seals the trial balance as
// of 12-31, so it counts the opening of 01-01 too: 107,800 + 125,357.33.
const SEALED_DEBITS = '233157.33';
const ENDING = {
  // 100,000 opening − 36,000 − 5,800 + 5,800 − 9,280 (REP) − 1,160 − 1,160 (the PUE)
  // − 1,200 − 450 (the bookshop) − 1,190 (the hotel) − 9,533.33 (the fees, net)
  // + 1,160 (the customer advance) (see MNE-001-039 in step 4) − 300 − 48 (the
  // bank fee and its IVA): the balance the statement closes with
  '1111': STATEMENT_CLOSING,
  '1120': '8120.00', // 3,480 opening + 11,600 − 5,800 − 1,160 (+ 2,000 − 2,000, the stray entry and its mirror)
  // the IVA paid in December: 800 + 1,280 (the REP's) + 160 + 160 (the PUE) + 160 (the hotel) + 1,600 (the fees)
  // + 48 (the bank fee's)
  '1130': '4208.00',
  '1135': '320.00', // the opening's; the 800 and the 1,280 parked in December moved to 1130 when paid
  '1220': '36000.00',
  '1290': '-900.00', // accumulated depreciation, credit balance
  '1320': '4000.00', // the deposit, untouched since the opening
  '2110': '-2320.00', // the opening bill: every December bill was paid within the month
  '2120': '-1600.00', // −1,600 + 160 − 160 (the advance's IVA), credit balance
  '2141': '-1000.00', // the ISR withheld from the fees, owed to the SAT
  '2142': '-1066.67', // the IVA withheld from the fees, owed to the SAT
  '2125': '-480.00', // the opening invoice's IVA, still uncollected
  '2150': '-1000.00', // the advance's base, a liability until it meets its invoice
  '3100': '-100000.00',
  '3200': '-5000.00', // the 2024 result, untouched since the opening
  '4100': '-10000.00', // the invoice; the stray 2,000 was credited on 12-28 and debited back on 12-31
  '4400': '1000.00',
  // 5,000 typed + 8,000 (PPD) + 1,000 + 1,000 (the PUE) + 1,200 + 450 (the bookshop)
  // + 1,000 (the hotel) + 10,000 (the fees)
  '6100': '27650.00',
  '6140': '900.00',
  '6310': BANK_FEE, // posted twice and mirrored once: 600 of debits, 300 of credits
  [LODGING_TAX_ACCOUNT]: '30.00', // the ISH of the hotel night
} as const;
const NET_SALES = '9000.00'; // 10,000 − 1,000 returned
const NET_INCOME = '-19880.00'; // 9,000 − 27,650 − 30 − 900 − 300 (the bank fee)
const TOTAL_ASSETS = '92586.67'; // 40,838.67 + 8,120 + 4,208 + 320 + 36,000 − 900 + 4,000
const TOTAL_LIABILITIES = '7466.67'; // 2,320 + 1,600 + 480 + 1,000 + 1,066.67 + 1,000 (the advance)
const TOTAL_EQUITY = '85120.00'; // 100,000 + 5,000 − 19,880; and 92,586.67 = 7,466.67 + 85,120
// Indirect method: −19,880 + 900 (depreciation, no cash) − 4,640 (AR up)
// − 4,208 (IVA credit up) + 1,600 (IVA payable up) + 2,066.67 (withholdings
// owed) + 1,000 (customer advances up) = −23,161.33, which is the 5,800
// + 1,160 received minus the 5,800 + 9,280 + 1,160 + 1,160 + 1,200 + 450
// + 1,190 + 9,533.33 + 300 + 48 paid. 1135, 2110 and 2125 end December where
// they began it.
const OPERATING_CASH = '-23161.33';
const INVESTING_CASH = '-36000.00'; // the computers
const FINANCING_CASH = '0.00'; // the capital came in with the opening, in January

// The firm's handle, its owner's login and that login's password: synthetic,
// and fresh on every run, so none of them can name a real account.
const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
const userEmail = `month-${suffix}@example.test`;
const password = `month-${uuidv4()}`;
let tenantId = '';
let entityId = '';
/** The opening's entry number, as `opening-balance import --json` printed it. */
let openingEntry = '';
let workDir: string;

/**
 * The variables that hand the child a model provider by name: the three of
 * MNE-001-406's acceptance, and the credential each built-in profile names
 * (`api_key_env`), read from the profiles so that a provider added there is
 * kept out the day it lands. `childEnv` blanks them. A provider declared in a
 * mnemosine.config.json names its own variables, so the first test catches
 * that file instead.
 */
const PROVIDER_ENV = [
  ...new Set([
    'MNEMOSINE_PROVIDER',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    ...Object.values(BUILTIN_PROFILES).flatMap((p) => (p.api_key_env ? [p.api_key_env] : [])),
  ]),
];

interface Run {
  status: number | null;
  out: string;
  err: string;
}

/**
 * The context flags of one call, typed the way an accountant types them:
 *   'entity'  `-t <firm> -u <user>`, and `-e <entity>` once it exists (the default);
 *   'ingest'  the same with the root's `-T`: `ingest` declares -e and -u, but no -t;
 *   'tenant'  `-t <firm>` alone, for the leaves that declare nothing else (`user create`);
 *   'none'    no flags, for what acts on the installation (`tenant create`, `backup`).
 */
type Scope = 'entity' | 'ingest' | 'tenant' | 'none';

function contextOf(scope: Scope): string[] {
  if (scope === 'none') return [];
  if (scope === 'tenant') return ['-t', tenantId];
  return [scope === 'ingest' ? '-T' : '-t', tenantId, '-u', userEmail, ...(entityId ? ['-e', entityId] : [])];
}

/**
 * The child's environment: the suite's own, plus `extra` for this call, and
 * then none of the variables that hand it a model provider, whatever the shell
 * or a .env of whoever runs the suite holds. PROVIDER_ENV goes, and so does
 * every ANTHROPIC_* variable: with no key, the Anthropic SDK of the default
 * profile authenticates on its own from them (auth token, profile, workload
 * identity: see node_modules/@anthropic-ai/sdk/core/credentials.js) and from
 * the profiles under XDG_CONFIG_HOME, which therefore points inside the
 * throwaway HOME too.
 *
 * NOTE: blanked, not deleted. dotenv does not override a variable that is set
 * unless DOTENV_OVERRIDE (or DOTENV_CONFIG_OVERRIDE) asks it to, so those two
 * are blanked as well, and an empty key keeps the child's own .env from
 * bringing it back.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // HOME points at a throwaway directory so no pinned entity, saved setting
    // or login of whoever runs the suite can leak into the month.
    HOME: workDir,
    XDG_CONFIG_HOME: path.join(workDir, '.config'),
    NO_COLOR: '1',
    // `ingest` would ask the SAT about synthetic UUIDs; unvalidated, a CFDI only warns.
    SAT_STATUS_MODE: 'off',
    MNEMOSINE_LOCALE: 'en-US',
    ...extra,
  };
  for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_')) env[name] = '';
  for (const name of PROVIDER_ENV) env[name] = '';
  // dotenv reads its options from the environment too, DOTENV_OVERRIDE first
  // and DOTENV_CONFIG_OVERRIDE after it, and '' reads as false.
  for (const name of ['DOTENV_OVERRIDE', 'DOTENV_CONFIG_OVERRIDE']) env[name] = '';
  return env;
}

/** The binary, as typed: `args`, then the flags of `scope`, with `extra` in its environment. */
function mnemosine(args: string[], scope: Scope = 'entity', extra: Record<string, string> = {}): Run {
  const r = spawnSync('npx', ['tsx', CLI, ...args, ...contextOf(scope)], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    env: childEnv(extra),
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Runs and demands exit 0, printing everything the CLI said when it is not. */
function ok(args: string[], scope: Scope = 'entity', extra: Record<string, string> = {}): Run {
  const r = mnemosine(args, scope, extra);
  expect(r.status, `mnemosine ${args.join(' ')}\n${r.out}\n${r.err}`).toBe(0);
  return r;
}

/** The `--json` document. Log lines may share stdout, so cut the JSON out. */
function rowsOf<T>(r: Run): T[] {
  const start = r.out.indexOf('{\n');
  const end = r.out.lastIndexOf('\n}');
  expect(start, `no JSON document in:\n${r.out}`).toBeGreaterThanOrEqual(0);
  return (JSON.parse(r.out.slice(start, end + 2)) as { rows: T[] }).rows;
}

const money = (v: string | undefined): string => new Decimal(v ?? 'NaN').toFixed(2);

/** December's movement (`net_change`) of each account in `codes`; 0.00 for one that did not move. */
function decemberMoves(codes: string[]): Record<string, string> {
  const tb = rowsOf<{ account_code: string; net_change: string }>(
    ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json'])
  );
  return Object.fromEntries(codes.map((c) => [c, money(tb.find((r) => r.account_code === c)?.net_change ?? '0')]));
}

/**
 * A received CFDI of tests/fixtures/cfdi, rewritten by string replacement:
 * the issuer, if given (else the fixture keeps its own), this company as
 * receiver (the fixtures' Rfc, Nombre and 06600), the date, the UUID and, if
 * given, the `Folio`. Written to the run's directory.
 */
function receivedCfdi(
  fixture: string,
  o: { file: string; rfc?: string; name?: string; date: string; uuid: string; invoiceNumber?: string }
): string {
  let xml = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cfdi', fixture), 'utf-8')
    .replace('Rfc="SIN060101AB1" Nombre="Servicios Integrales SA"', o.rfc ? `Rfc="${o.rfc}" Nombre="${o.name}"` : '$&')
    .replace(/<cfdi:Receptor Rfc="[^"]+" Nombre="[^"]+"/, `<cfdi:Receptor Rfc="${COMPANY_RFC}" Nombre="${COMPANY_NAME}"`)
    .replace('DomicilioFiscalReceptor="06600"', 'DomicilioFiscalReceptor="01000"')
    .replace(/ Fecha="[^"]+"/, ` Fecha="${o.date}T10:00:00"`)
    .replace(/FechaTimbrado="[^"]+"/, `FechaTimbrado="${o.date}T10:05:00"`)
    .replace(/UUID="[^"]+"/, `UUID="${o.uuid}"`);
  if (o.invoiceNumber) xml = xml.replace(/ Folio="[^"]+"/, ` Folio="${o.invoiceNumber}"`);
  const file = path.join(workDir, o.file);
  fs.writeFileSync(file, xml);
  return file;
}

interface StatementRow {
  section: string;
  line: string;
  code: string;
  name: string;
  amount: string;
}
/** The bill number of each of the vendor's invoice numbers: `bill inbox run --json` carries it only in prose. */
function billNumbers(): Record<string, string> {
  return Object.fromEntries(
    rowsOf<{ vendor_invoice_number: string; bill_number: string }>(
      ok(['bill', 'list', '--all', '--fields', 'vendor_invoice_number,bill_number', '--json'])
    ).map((b) => [b.vendor_invoice_number, b.bill_number])
  );
}

/** A bill's own lines and the entry it posted, as `<account> Dr|Cr <amount>`, from one `bill show`. */
function billPosting(billNumber: string): { lines: Record<string, string>[]; entry: string[] } {
  type EntryLine = { account_code: string; debit_amount: string | null; credit_amount: string | null };
  const [bill] = rowsOf<{ lines: Record<string, string>[]; journal_entry: { lines: EntryLine[] } }>(
    ok(['bill', 'show', billNumber, '--journal', '--json'])
  );
  const side = (l: EntryLine): string =>
    new Decimal(l.debit_amount ?? 0).isZero() ? `Cr ${money(l.credit_amount ?? '0')}` : `Dr ${money(l.debit_amount ?? '0')}`;
  return { lines: bill.lines, entry: bill.journal_entry.lines.map((l) => `${l.account_code} ${side(l)}`) };
}

/** Ingests one received CFDI whose vendor exists, codes it to 6100 by hand, posts it and returns its bill number. */
function postToExpense(file: string, invoiceNumber: string, total: string): string {
  expect(ok(['ingest', file, '-y'], 'ingest').out).toContain('1 left to code');
  const ready = rowsOf<{ id: string; document: string; total: string }>(
    ok(['bill', 'inbox', 'list', '--status', 'ready', '--fields', 'id,document,total', '--json'])
  );
  expect(ready.map((r) => `${r.document} ${money(r.total)}`)).toEqual([`${invoiceNumber} ${total}`]);
  ok(['bill', 'inbox', 'edit', ready[0].id, '--account', '6100']);
  ok(['bill', 'inbox', 'run', ready[0].id, '--yes']);
  return billNumbers()[invoiceNumber];
}

const lineOf = (rows: StatementRow[], pred: (r: StatementRow) => boolean): string =>
  money(rows.find(pred)?.amount);

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-mvp-month-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('MVP month end to end: December 2025 of a synthetic SME, through the CLI only', () => {
  it('runs with no model provider: no built-in provider credential, no MNEMOSINE_PROVIDER and no mnemosine.config.json reach the binary', () => {
    // A credential takes three roads into the child: the environment that runs
    // the suite, and the two .env files that one dotenv call loads, the
    // checkout's ./.env and the ~/.mnemosine/.env of the child's HOME
    // (src/config/env-file.ts). Both files go through the same override rule,
    // so the test poisons the environment and the HOME file, each naming
    // another provider (the default printed says which one leaked), and leaves
    // the checkout's .env, which belongs to whoever runs the suite, alone.
    // The poisoned names come from the profiles, not from PROVIDER_ENV, the
    // list under test: a name the helper forgets is still poisoned, and reads ✔.
    const keys = [
      ...new Set([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        ...Object.values(BUILTIN_PROFILES).flatMap((p) => (p.api_key_env ? [p.api_key_env] : [])),
      ]),
    ];
    const inherited: Record<string, string> = {
      ...Object.fromEntries(keys.map((name) => [name, `leaked-${name}`])),
      MNEMOSINE_PROVIDER: 'ollama',
      ANTHROPIC_AUTH_TOKEN: 'leaked-token',
      XDG_CONFIG_HOME: '/nonexistent/leaked-config',
      DOTENV_OVERRIDE: 'true',
      DOTENV_CONFIG_OVERRIDE: 'true',
    };
    const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
    const childDotenv = path.join(workDir, '.mnemosine', '.env');
    fs.mkdirSync(path.dirname(childDotenv), { recursive: true });
    fs.writeFileSync(
      childDotenv,
      [...keys.map((name) => `${name}=leaked-from-dotenv\n`), 'MNEMOSINE_PROVIDER=hermes\n'].join('')
    );
    Object.assign(process.env, inherited);
    try {
      const listed = ok(['providers'], 'none').out;
      for (const { api_key_env: key } of Object.values(BUILTIN_PROFILES)) {
        if (key) expect(listed, `${key} in:\n${listed}`).toContain(`${key} ✘ missing`);
      }
      expect(listed).not.toMatch(/^(ollama|hermes) ← default$/m);
      // A mnemosine.config.json can declare providers, keys and a default that
      // no blank reaches, so the child must load none: `providers` prints this
      // line only when it loads no config file.
      expect(listed, `the child loaded a mnemosine.config.json:\n${listed}`).toContain('Using built-in profiles.');
      // What `providers` cannot print: the Anthropic SDK's own credentials and
      // config directory, and a key that one call's environment tries to hand in.
      expect(childEnv().ANTHROPIC_AUTH_TOKEN).toBe('');
      expect(childEnv().XDG_CONFIG_HOME).toBe(path.join(workDir, '.config'));
      expect(childEnv({ OPENAI_API_KEY: 'leaked-by-a-call' }).OPENAI_API_KEY).toBe('');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(childDotenv, { force: true });
    }
  }, STEP_TIMEOUT_MS);

  describe('1 · registration and migration', () => {
    it('creates the firm and its user without a TTY (tenant create, user create) — MNE-001-085, MNE-001-086', () => {
      const [firm] = rowsOf<{ tenantId: string; subdomain: string }>(
        ok(['tenant', 'create', 'Synthetic firm for the MVP month', '--subdomain', `mvp-${suffix}`, '--json'], 'none')
      );
      expect(firm.subdomain).toBe(`mvp-${suffix}`);
      tenantId = firm.tenantId;

      // The password travels in MNEMOSINE_USER_PASSWORD, never in argv, and
      // never comes back out.
      const created = ok(['user', 'create', '--email', userEmail, '--role', 'owner', '--json'], 'tenant', {
        MNEMOSINE_USER_PASSWORD: password,
      });
      expect(rowsOf<{ email: string; role: string; tenantId: string }>(created)[0])
        .toMatchObject({ email: userEmail, role: 'owner', tenantId });
      expect(created.out + created.err).not.toContain(password);
    }, STEP_TIMEOUT_MS);

    it('creates the entity with its seeded chart and the 2025 fiscal year', () => {
      const created = rowsOf<{ entityId: string; taxId: string }>(
        ok(['entity', 'create', COMPANY_NAME, '--tax-id', COMPANY_RFC,
          '--tax-regime', '601', '--tax-postal-code', '01000', '--json'])
      );
      expect(created[0].taxId).toBe(COMPANY_RFC);
      entityId = created[0].entityId;

      ok(['year', 'create', '2025']);
    }, STEP_TIMEOUT_MS);

    it('records regime 601 and the fiscal address of the persona moral — MNE-001-017', () => {
      // 601 is c_RegimenFiscal's general regime of a persona moral; 01000 is
      // the fiscal postal code typed at `entity create`.
      expect(rowsOf<Record<string, string>>(ok(['entity', 'show', '--json']))[0]).toMatchObject({
        id: entityId,
        tax_id: COMPANY_RFC,
        tax_regime: '601',
        tax_regime_name: 'General de Ley Personas Morales',
        tax_postal_code: '01000',
      });
    }, STEP_TIMEOUT_MS);

    it('reaches `ingest` with the root -T (the helper\'s ingest scope); its dry run writes nothing', () => {
      // `ingest` declares -e and -u but no -t, so the firm goes in the root's -T.
      // A fixture CFDI addressed to this company: --dry-run writes nothing and
      // calls no one, so no figure of the month moves.
      const xml = path.join(workDir, 'ingest-scope.xml');
      fs.writeFileSync(
        xml,
        fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf-8')
          .replace('Rfc="XAXX010101000"', `Rfc="${COMPANY_RFC}"`)
      );
      const dry = ok(['ingest', xml, '--dry-run'], 'ingest');
      expect(dry.out).toContain(`mnemosine ingest --dry-run · ${COMPANY_NAME} · 1 file(s)`);
      expect(dry.out).toContain('ingest-scope.xml  would_process · received');
      expect(dry.out).toContain('dry-run: nothing was written');
    }, STEP_TIMEOUT_MS);

    it('imports the chart from Anexo 24 XML: the dry run writes nothing, and --yes creates the one account the seeded chart lacks — MNE-001-018', () => {
      const chart = path.join(workDir, 'catalogo-2024-12.xml');
      fs.writeFileSync(chart, CHART_XML);
      // The report publishes the service's keys, in Spanish: read as printed, never renamed.
      const [dry] = rowsOf<Record<string, unknown>>(ok(['chart', 'import', chart, '--dry-run', '--json']));
      expect(dry).toMatchObject({
        dryRun: true, escrito: false, creadas: [], omitidas: [], aCrear: [expect.objectContaining({ code: '1320' })],
      });
      // The other fourteen are seeded accounts: named, and left as they are.
      expect(dry['yaExistian']).toHaveLength(14);

      // Only the dry run came before: had it written 1320, this run would list it as existing.
      const [applied] = rowsOf<Record<string, unknown>>(ok(['chart', 'import', chart, '--yes', '--json']));
      expect(applied).toMatchObject({ dryRun: false, escrito: true, creadas: ['1320'] });
      expect(applied['yaExistian']).toHaveLength(14);

      // A second dry run reads the accounts back. Nothing is left to create,
      // 1320 is as the file describes it, and each seeded account still
      // differs from the file in the SAT grouping code alone, which the seed
      // never sets (the names and natures are the seed's): an import creates,
      // and never rewrites what was there.
      const [again] = rowsOf<Record<string, unknown>>(ok(['chart', 'import', chart, '--dry-run', '--json']));
      expect(again['aCrear']).toEqual([]);
      const found = (again['yaExistian'] as { code: string; divergencias: unknown[] }[])
        .map((m): [string, unknown[]] => [m.code, m.divergencias]);
      const expected = OPENING_2024.map(([code, , group]): [string, unknown[]] =>
        [code, code === '1320' ? [] : [{ campo: 'codigo_agrupador_sat', enElArchivo: group, enElSistema: '' }]]);
      expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected));
    }, STEP_TIMEOUT_MS);

    it('imports the open receivables and payables with the migration, and stops when they do not tie — MNE-001-022, MNE-001-023', () => {
      const trialBalance = path.join(workDir, 'balanza-2024-12.xml');
      fs.writeFileSync(trialBalance, TRIAL_BALANCE_XML);
      const subledger = (name: string, documents: object[]): string => {
        const file = path.join(workDir, name);
        fs.writeFileSync(file, JSON.stringify(documents));
        return file;
      };
      const load = (file: string): string[] => ['opening-balance', 'import', trialBalance, '--subledger', file, '--yes', '--json'];

      // The bill one peso short: 2,319.00 of documents against the 2,320.00
      // the trial balance declares on 2110. With --yes, only the refusal
      // keeps it from writing: exit 4. The report keeps the service's Spanish
      // keys, read as printed. Being the preview's report, it says
      // `escrito: false` by construction. What shows that nothing was written
      // is that the ledger is empty, and so are the open documents and their
      // parties, which the leaf also declares it writes.
      const short = OPEN_DOCUMENTS.map((d) => (d.cuenta === '2110' ? { ...d, importe: '2319.00' } : d));
      const refused = mnemosine(load(subledger('subledger-one-peso-short.json', short)));
      expect(refused.status, refused.out + refused.err).toBe(4);
      const [stopped] = rowsOf<Record<string, unknown>>(refused);
      expect(stopped).toMatchObject({ escrito: false, asiento: null });
      const untied = (stopped['findings'] as Record<string, string>[]).find((f) => f['regla'] === 'APE-DETALLE-NO-CUADRA');
      expect(untied).toMatchObject({ numCta: '2110', severidad: 'bloquea' });
      expect(untied?.['mensaje']).toContain('faltan 1.00');
      expect(rowsOf(ok(['entry', 'list', '--all', '--json']))).toEqual([]);
      for (const leaf of ['invoice', 'customer', 'bill', 'vendor']) {
        expect(rowsOf(ok([leaf, 'list', '--all', '--json'])), `${leaf} list after the refusal`).toEqual([]);
      }

      const [loaded] = rowsOf<Record<string, unknown>>(ok(load(subledger('subledger.json', OPEN_DOCUMENTS))));
      expect(loaded).toMatchObject({ escrito: true, loadMode: 'post', fecha: '2025-01-01', arInvoices: 1, apBills: 1 });
      expect(money(loaded['totalDebe'] as string)).toBe(OPENING_DEBITS);
      expect(money(loaded['totalHaber'] as string)).toBe(OPENING_DEBITS);
      openingEntry = (loaded['asiento'] as { entry_number: string }).entry_number;

      // Each document is the invoice or bill it was, hanging from the opening
      // entry, which already carries its amount.
      const invoices = rowsOf<Record<string, string>>(ok(['invoice', 'list', '--json']));
      expect(invoices).toEqual([expect.objectContaining({
        invoice_number: 'A-2024-117', customer_name: 'Distribuidora del Bajio SA de CV', status: 'sent',
      })]);
      expect(money(invoices[0].amount_due)).toBe('3480.00');
      expect(rowsOf(ok(['invoice', 'show', 'A-2024-117', '--json']))[0]).toMatchObject({ journal_entry_number: openingEntry });
      const bills = rowsOf<Record<string, string>>(ok(['bill', 'list', '--json']));
      expect(bills).toHaveLength(1);
      // The BILL series of its own document year, so December's bills start at BILL-2025-00001.
      expect(bills[0].bill_number).toMatch(/^BILL-2024-\d{5}$/);
      expect(money(bills[0].amount_due)).toBe('2320.00');
      // 2,320 / 1.16 = 2,000 of base and 320 of IVA: the 320 the trial balance parks in 1135.
      const [bill] = rowsOf<Record<string, string>>(ok(['bill', 'show', bills[0].bill_number, '--journal', '--json']));
      expect(bill).toMatchObject({
        vendor_invoice_number: 'F-2024-881', status: 'approved', journal_entry: { entry_number: openingEntry },
      });
      expect(money(bill.subtotal)).toBe('2000.00');
      expect(money(bill.tax_amount)).toBe('320.00');

      // The vendor subledger against 2110 on the day of the opening. --strict
      // would exit 4 on any reconciling item, the opening entry included.
      expect(rowsOf(ok(['ap', 'reconcile', '--as-of', '2025-01-01', '--strict', '--json']))[0]).toMatchObject({
        subdiario: '2320.00', mayor: '2320.00', diferencia: '0.00', cuadra: true, partidas: [],
      });
    }, STEP_TIMEOUT_MS);

    it('the opening, posted on 2025-01-01, is the only entry of the year so far and ties to the peso; January to November are hard-closed in order — MNE-001-018, MNE-001-099', () => {
      // Posted and not left as a draft: apertura_modo_de_carga posts by
      // default (MNE-001-099). No opening is typed in December any more.
      const entries = rowsOf<Record<string, string>>(ok(['entry', 'list', '--all', '--json']));
      expect(entries).toEqual([expect.objectContaining({
        entry_number: openingEntry, entry_date: '2025-01-01', status: 'posted', source_type: 'opening_balance',
      })]);
      expect(money(entries[0].total_debits)).toBe(OPENING_DEBITS);

      // The fifteen accounts of the source, parents included, against our
      // ledger on 2025-01-01, rolled up the same way.
      const [check] = rowsOf<Record<string, unknown>>(
        ok(['opening-balance', 'check', path.join(workDir, 'balanza-2024-12.xml'), '--json'])
      );
      expect(check).toMatchObject({ asOf: '2025-01-01', comparison: { comparadas: 15, iguales: true } });

      // Each month is soft-closed, then hard-closed, oldest first. The hard
      // close carries its endings into the next month and no further, since
      // no later month is closed yet; November's carries the opening into
      // December.
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'];
      months.slice(0, 11).forEach((month, i) => {
        const period = `2025-${String(i + 1).padStart(2, '0')}`;
        expect(ok(['close', '--period', period, '--yes']).out).toContain(`✔ ${month} 2025 is now soft_close`);
        const sealed = ok(['close', '--period', period, '--hard', '--yes']).out;
        expect(sealed).toContain(`✔ ${month} 2025 is now hard_close`);
        expect(sealed).toMatch(new RegExp(`Beginning balances carried into: ${months[i + 1]} 2025$`, 'm'));
      });
      const periods = rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']));
      expect(months.map((m) => periods.find((p) => p.period_name === `${m} 2025`)?.status))
        .toEqual([...Array<string>(11).fill('hard_close'), 'open']);
    }, STEP_TIMEOUT_MS);

    it.todo('imports the 8xx memorandum accounts with the chart and the opening trial balance, and leaves them out of the footing — MNE-001-019, MNE-001-484');
  });

  describe('2 · CFDI to the ledger', () => {
    it.todo('ingests the issued PUE and PPD invoices from tests/fixtures into receivables, never as expense, and the issued REP settles the PPD — MNE-001-025, MNE-001-028');

    it('approving a received PPD creates the bill, and its REP moves the IVA from 1135 to 1130 — MNE-001-026, MNE-001-116, MNE-001-117', () => {
      const ppd = receivedCfdi('factura-consultoria-2001.xml',
        { file: 'ppd-2025-12-10.xml', rfc: CONSULTANT_RFC, name: CONSULTANT_NAME, date: '2025-12-10', uuid: PPD_UUID });
      // No model: the CFDI is registered and left to code, with nothing posted.
      expect(ok(['ingest', ppd, '-y'], 'ingest').out).toContain('1 left to code');
      const inbox = rowsOf<{ id: string; rfc: string; total: string }>(
        ok(['bill', 'inbox', 'list', '--fields', 'id,rfc,total', '--json'])
      );
      expect(inbox.map((r) => `${r.rfc} ${money(r.total)}`)).toEqual([`${CONSULTANT_RFC} 9280.00`]);
      const [row] = inbox;

      // The consultant is in no catalog: the inbox refuses to create a vendor
      // without --allow-new-vendor (exit 11, needs a human), and writes nothing.
      const entries = rowsOf(ok(['entry', 'list', '--all', '--json']));
      const refused = mnemosine(['bill', 'inbox', 'run', row.id, '--yes']);
      expect(refused.status, refused.out + refused.err).toBe(11);
      expect(rowsOf(ok(['entry', 'list', '--all', '--json']))).toEqual(entries);
      expect(rowsOf<{ tax_id: string }>(ok(['vendor', 'list', '--json'])).map((v) => v.tax_id))
        .not.toContain(CONSULTANT_RFC);

      // FIXME(#684): a person registers the vendor and codes the line. The
      // line's own account is needed: with no vendor at ingest, the product
      // suggests the opening bill's 2110 for it, and the suggestion beats a
      // default account.
      ok(['vendor', 'create', CONSULTANT_NAME, '--tax-id', CONSULTANT_RFC]);
      ok(['bill', 'inbox', 'edit', row.id, '--line', '1', '--account', '6100']);
      ok(['bill', 'inbox', 'run', row.id, '--yes']);
      const moves = ['6100', '1135', '1130', '2110', '1111'];
      expect(decemberMoves(moves)).toEqual(
        { '6100': '8000.00', '1135': '1280.00', '1130': '0.00', '2110': '-9280.00', '1111': '0.00' }
      );

      // The REP pays it on 12-22: the payment is created from the receipt, and
      // the IVA it pays leaves 1135 for 1130 in the same entry (LIVA art. 5 fr. III).
      const rep = path.join(workDir, 'rep-2025-12-22.xml');
      fs.writeFileSync(rep, REP_XML);
      expect(ok(['ingest', rep, '-y'], 'ingest').out).toContain('rep-2025-12-22.xml  rules · Payment receipt linked');
      // An inbox bill takes the BILL series of its CFDI's year, and the refused
      // run drew no number (its transaction rolled back): this is 2025's first.
      const [paid] = rowsOf<{ status: string; total_amount: string; amount_due: string }>(
        ok(['bill', 'show', 'BILL-2025-00001', '--json'])
      );
      expect(paid.status).toBe('paid');
      expect([money(paid.total_amount), money(paid.amount_due)]).toEqual(['9280.00', '0.00']);
      expect(decemberMoves(moves)).toEqual(
        { '6100': '8000.00', '1135': '0.00', '1130': '1280.00', '2110': '0.00', '1111': '-9280.00' }
      );
    }, STEP_TIMEOUT_MS);

    it('classifies the month by the manual path, with no model: reprocess, hand coding and processing rules — MNE-001-029, MNE-001-030, MNE-001-032', () => {
      ok(['vendor', 'create', CLEANER_NAME, '--tax-id', CLEANER_RFC]);
      const [pue12, pue19] = (['12', '19'] as const).map((day, i) => receivedCfdi('factura-limpieza-1001.xml', {
        file: `pue-2025-12-${day}.xml`, rfc: CLEANER_RFC, name: CLEANER_NAME, date: `2025-12-${day}`,
        uuid: CLEANER_PUE_UUIDS[i], invoiceNumber: String(1001 + i),
      }));
      expect(ok(['ingest', pue12, pue19, '-y'], 'ingest').out).toContain('2 left to code');
      const ready = rowsOf<{ id: string; date: string; total: string }>(
        ok(['bill', 'inbox', 'list', '--status', 'ready', '--json'])
      );
      expect(ready.map((r) => `${r.date} ${money(r.total)}`).sort()).toEqual(['2025-12-12 1160.00', '2025-12-19 1160.00']);
      const first = ready.find((r) => r.date === '2025-12-12')?.id ?? '';

      // MNE-001-030: the cleaner has no bills, so nothing suggests an account,
      // and the single gate refuses the uncoded line (exit 1). Coded by hand, it posts.
      const uncoded = mnemosine(['bill', 'inbox', 'run', first, '--yes']);
      expect(uncoded.status, uncoded.out + uncoded.err).toBe(1);
      ok(['bill', 'inbox', 'edit', first, '--account', '6100']);
      ok(['bill', 'inbox', 'run', first, '--yes']);

      // MNE-001-029 and MNE-001-032: a plain ingest calls the second CFDI a
      // duplicate; a rule made in the terminal posts it on --retry, with no
      // hand coding. The first one already has its bill and is not reprocessed.
      expect(ok(['ingest', pue19, '-y'], 'ingest').out).toContain('pue-2025-12-19.xml  duplicate');
      const [rule] = rowsOf<{ id: string }>(ok(['bill', 'rule', 'create', '--name', CLEANING_RULE,
        '--when', `emisor_rfc equals ${CLEANER_RFC}`, '--then', 'set_account=6100', '--then', 'set_processing_mode=auto',
        '--json']));
      const retried = ok(['ingest', pue12, pue19, '--retry', '-y'], 'ingest').out;
      expect(retried).toMatch(/pue-2025-12-12\.xml {2}duplicate · .*not reprocessable/);
      expect(retried).toMatch(new RegExp(`pue-2025-12-19\\.xml {2}rules · .*«${CLEANING_RULE}»`));
      expect(rowsOf<{ id: string; matched: unknown }>(ok(['bill', 'rule', 'list', '--json']))
        .map((r) => [r.id, Number(r.matched)])).toEqual([[rule.id, 1]]);
      expect(rowsOf(ok(['bill', 'inbox', 'list', '--status', 'ready', '--json']))).toEqual([]);

      // A PUE declares that it was paid in one exhibition (CFF art. 29-A fr. VII b),
      // which is why its IVA was credited when it posted: each is paid on its
      // date, and the payment releases no IVA again. The numbers are derived:
      // `bill inbox run --json` carries them only inside its Spanish prose.
      for (const [bill, date] of [['BILL-2025-00002', '2025-12-12'], ['BILL-2025-00003', '2025-12-19']]) {
        expect(ok(['payment', 'create', bill, '--amount', '1160.00', '--date', date, '--yes']).out)
          .toContain('1160.00 → 0.00 (paid)');
      }
      expect(rowsOf<{ bill_number: string; bill_date: string; status: string }>(ok(['bill', 'list', '--json']))
        .filter((b) => b.bill_number.startsWith('BILL-2025-')).map((b) => `${b.bill_number} ${b.bill_date} ${b.status}`)
        .sort()).toEqual(['BILL-2025-00001 2025-12-10 paid', 'BILL-2025-00002 2025-12-12 paid', 'BILL-2025-00003 2025-12-19 paid']);
      // A 1130 above 1,600.00 would be a second IVA release.
      expect(decemberMoves(['6100', '1130', '1135', '2110', '1111'])).toEqual(
        { '6100': '10000.00', '1130': '1600.00', '1135': '0.00', '2110': '0.00', '1111': '-11600.00' }
      );
    }, STEP_TIMEOUT_MS);

    it('keeps leading zeros and accents of the parsed CFDI, including a 0 % and an exempt one — MNE-001-031, MNE-001-027', () => {
      ok(['vendor', 'create', BOOKSHOP_NAME, '--tax-id', BOOKSHOP_RFC]);
      const received = [
        { file: 'zero-rate-2025-12-03.xml', date: '2025-12-03', uuid: ZERO_RATE_UUID, invoiceNumber: '000123', amount: '1200.00', exempt: false },
        { file: 'exempt-2025-12-04.xml', date: '2025-12-04', uuid: EXEMPT_UUID, invoiceNumber: '000124', amount: '450.00', exempt: true },
      ].map((c) => ({ ...c, file: path.join(workDir, c.file) }));
      for (const c of received) fs.writeFileSync(c.file, bookshopCfdi(c));
      expect(ok(['ingest', ...received.map((c) => c.file), '-y'], 'ingest').out).toContain('2 left to code');

      // MNE-001-031: a folio is a text, so its leading zeros reach the inbox,
      // and the issuer's name comes out of its character references with its
      // accents. The receiver's postal code is in no parsed field: only the
      // bytes as they arrived keep it, zero included.
      const ready = rowsOf<{ id: string; document: string; total: string }>(
        ok(['bill', 'inbox', 'list', '--status', 'ready', '--fields', 'id,document,total', '--json'])
      );
      expect(ready.map((r) => `${r.document} ${money(r.total)}`).sort()).toEqual(['000123 1200.00', '000124 450.00']);
      expect(rowsOf<Record<string, string>>(ok(['cfdi', 'show', ZERO_RATE_UUID, '--json']))[0])
        .toMatchObject({ emisor_rfc: BOOKSHOP_RFC, emisor_nombre: BOOKSHOP_NAME, receptor_rfc: COMPANY_RFC });
      expect(ok(['cfdi', 'show', ZERO_RATE_UUID, '--format', 'xml']).out).toContain('DomicilioFiscalReceptor="01000"');

      for (const r of ready) {
        ok(['bill', 'inbox', 'edit', r.id, '--account', '6100']);
        ok(['bill', 'inbox', 'run', r.id, '--yes']);
      }
      // MNE-001-027: each enters as what it is, a rate of 0 % or no rate at
      // all, which is what tells the two apart in the DIOT. Neither has an
      // IVA line, and each is paid on its date, like every PUE of the month.
      const bills = billNumbers();
      const [zeroRate, exempt] = received.map((c) => billPosting(bills[c.invoiceNumber]));
      expect(zeroRate.lines).toEqual([expect.objectContaining({ tipo_factor: 'tasa', account_code: '6100' })]);
      expect(money(zeroRate.lines[0].tax_rate)).toBe('0.00');
      expect(zeroRate.entry).toEqual(['6100 Dr 1200.00', '2110 Cr 1200.00']);
      expect(exempt.lines).toEqual([expect.objectContaining({ tipo_factor: 'exento', tax_rate: null, account_code: '6100' })]);
      expect(exempt.entry).toEqual(['6100 Dr 450.00', '2110 Cr 450.00']);
      for (const c of received) {
        expect(ok(['payment', 'create', bills[c.invoiceNumber], '--amount', c.amount, '--date', c.date, '--yes']).out)
          .toContain(`${c.amount} → 0.00 (paid)`);
      }
      // 6100: 10,000 + 1,200 + 450; the bank: −11,600 − 1,200 − 450; no IVA moved.
      expect(decemberMoves(['6100', '1130', '1135', '2110', '1111'])).toEqual(
        { '6100': '11650.00', '1130': '1600.00', '1135': '0.00', '2110': '0.00', '1111': '-13250.00' }
      );
    }, STEP_TIMEOUT_MS);

    it('posts a lodging CFDI with its local tax (ISH) in its own account — MNE-001-033', () => {
      // The seeded chart sends local taxes to 6100, with the rest of the
      // expense. The firm opens a leaf for them and points the role at it.
      ok(['account', 'create', LODGING_TAX_ACCOUNT, 'Impuesto sobre Hospedaje', '--type', 'expense', '--parent', '6100']);
      expect(ok(['account', 'role', 'set', 'impuestos_locales_gasto', LODGING_TAX_ACCOUNT]).out)
        .toContain(`impuestos_locales_gasto → ${LODGING_TAX_ACCOUNT}`);
      ok(['vendor', 'create', HOTEL_NAME, '--tax-id', HOTEL_RFC]);
      const lodging = receivedCfdi('hospedaje-ish-4001.xml',
        { file: 'lodging-2025-12-09.xml', date: '2025-12-09', uuid: LODGING_UUID });

      // 1,000 + 160 of IVA + 30 of ISH (3 %, in the ImpuestosLocales complement)
      // = 1,190: the IVA is credited, the ISH is a cost, and the bill owes both.
      const bill = postToExpense(lodging, 'H4001', '1190.00');
      expect(billPosting(bill).entry)
        .toEqual(['6100 Dr 1000.00', `${LODGING_TAX_ACCOUNT} Dr 30.00`, '1130 Dr 160.00', '2110 Cr 1190.00']);
      expect(ok(['payment', 'create', bill, '--amount', '1190.00', '--date', '2025-12-09', '--yes']).out)
        .toContain('1190.00 → 0.00 (paid)');
      // 6100: 11,650 + 1,000; 1130: 1,600 + 160; the bank: −13,250 − 1,190.
      expect(decemberMoves(['6100', LODGING_TAX_ACCOUNT, '1130', '2110', '1111'])).toEqual(
        { '6100': '12650.00', [LODGING_TAX_ACCOUNT]: '30.00', '1130': '1760.00', '2110': '0.00', '1111': '-14440.00' }
      );
    }, STEP_TIMEOUT_MS);

    it('posts a CFDI with withholdings, and paying its net leaves the withheld ISR and IVA owed to the SAT — MNE-001-056', () => {
      ok(['vendor', 'create', FEES_NAME, '--tax-id', FEES_RFC]);
      const fees = receivedCfdi('honorarios-pf-612.xml', { file: 'fees-2025-12-16.xml', date: '2025-12-16', uuid: FEES_UUID });

      // An individual's fees to a persona moral: 10,000 + 1,600 of IVA, less
      // 1,000 of ISR (10 %) and 1,066.67 of IVA (two thirds of 1,600) withheld
      // = 9,533.33, the CFDI's total and all the vendor is owed. The whole
      // 1,600 is credited, as the product posts a PUE.
      const bill = postToExpense(fees, 'H56', '9533.33');
      expect(billPosting(bill).entry)
        .toEqual(['6100 Dr 10000.00', '1130 Dr 1600.00', '2141 Cr 1000.00', '2142 Cr 1066.67', '2110 Cr 9533.33']);
      // Paying the net settles the vendor and touches neither withholding:
      // 2141 and 2142 stay owed to the SAT until the company remits them.
      expect(ok(['payment', 'create', bill, '--amount', '9533.33', '--date', '2025-12-16', '--yes']).out)
        .toContain('9533.33 → 0.00 (paid)');
      // 6100: 12,650 + 10,000; 1130: 1,760 + 1,600; the bank: −14,440 − 9,533.33.
      expect(decemberMoves(['6100', '1130', '2141', '2142', '2110', '1111'])).toEqual(
        { '6100': '22650.00', '1130': '3360.00', '2141': '-1000.00', '2142': '-1066.67', '2110': '0.00', '1111': '-23973.33' }
      );
    }, STEP_TIMEOUT_MS);

    it('loads a synthetic SAT census for 2025-12 and `sat download reconcile --period` names each CFDI as missing, unposted or posted — MNE-001-096, MNE-001-119', () => {
      // The gardener's CFDI arrives and stays in the inbox: with no model, no
      // vendor and no rule, nothing codes it and nothing is posted.
      const unposted = receivedCfdi('factura-limpieza-1001.xml', {
        file: 'unposted-2025-12-29.xml', rfc: GARDENER_RFC, name: GARDENER_NAME, date: '2025-12-29',
        uuid: UNPOSTED_UUID, invoiceNumber: '7741',
      });
      expect(ok(['ingest', unposted, '-y'], 'ingest').out).toContain('1 left to code');

      // MNE-001-096: the metadata loads the census and stops. Ten rows, all
      // received: the company is the receiver of every one.
      const census = path.join(workDir, 'recibidos-2025-12.txt');
      fs.writeFileSync(census, CENSUS_METADATA);
      const loaded = ok(['ingest', census, '--kind', 'metadata', '-y'], 'ingest').out;
      expect(loaded).toContain('10 CFDI (0 issued, 10 received)');
      expect(loaded).toContain('Census loaded from recibidos-2025-12.txt: 10 new, 0 already known.');

      // MNE-001-119: the month is not complete, so the command exits 4
      // (validation) and its rows are the two gaps, the one to fetch first.
      const reconciled = mnemosine(['sat', 'download', 'reconcile', '--period', '2025-12', '--json']);
      expect(reconciled.status, reconciled.out + reconciled.err).toBe(4);
      expect(
        rowsOf<Record<string, string>>(reconciled)
          .map((r) => [r.status, r.direction, r.type, r.uuid, r.date, money(r.amount)].join(' '))
      ).toEqual([
        `to_fetch received I ${UNFETCHED_UUID.toLowerCase()} 2025-12-30 10:00:00 580.00`,
        `to_post received I ${UNPOSTED_UUID.toLowerCase()} 2025-12-29 10:00:00 1160.00`,
      ]);
      // The summary counts what agrees: the seven bills of steps 2·195 to
      // 2·199 and the REP, which matches by the payment it created. Nothing
      // is cancelled, and no posted CFDI is missing from the census.
      expect(reconciled.err).toContain(
        '2025-12: 8 agree · 1 to fetch · 1 to post · 0 cancelled at the SAT but posted · ' +
        '0 posted but not in the census (0 cancelled and never posted: not a gap).'
      );
      // A direction nobody loaded is said apart: it is not «nothing issued».
      expect(reconciled.err).toContain('No census of issued CFDI covers this month: it is not loaded');
      expect(reconciled.err).not.toContain('No census of received CFDI');

      // A census and an uncoded CFDI post nothing: December is where 2·199 left it.
      expect(decemberMoves(['6100', '1130', '2141', '2142', '2110', '1111'])).toEqual(
        { '6100': '22650.00', '1130': '3360.00', '2141': '-1000.00', '2142': '-1066.67', '2110': '0.00', '1111': '-23973.33' }
      );
    }, STEP_TIMEOUT_MS);
  });

  describe('3 · receivables and payables', () => {
    it('buys the computers on 12-01 from the bank, typed as a journal entry', () => {
      // Bought here, with the rest of the month's cash, so that 1111 holds
      // every movement the bank statement of step 4 lists. The asset is
      // registered at the close, in step 6.
      const [purchase] = rowsOf<{ entry_number: string }>(
        ok(['entry', 'create', '--date', '2025-12-01', '--description', 'Computer equipment',
          '--line', '1220:debit:36000.00', '--line', '1111:credit:36000.00', '--json'])
      );
      ok(['entry', 'post', purchase.entry_number, '--yes']);
      // The bank: −23,973.33, where section 2 left it, − 36,000.
      expect(decemberMoves(['1220', '1111'])).toEqual({ '1220': '36000.00', '1111': '-59973.33' });
    }, STEP_TIMEOUT_MS);

    it('issues an invoice, collects half, captures and pays a bill, and issues a credit note', () => {
      ok(['customer', 'create', '--name', 'Cliente Sintetico SA de CV', '--tax-id', CUSTOMER_RFC, '--terms', 'Net 30']);
      ok(['invoice', 'create', '--customer', 'Cliente Sintetico', '--date', '2025-12-05',
        '--line', 'account=4100;qty=1;price=10000.00;tax-rate=16;description=Mercancia']);
      ok(['invoice', 'issue', 'INV-2025-00001', '--yes']);
      expect(ok(['receipt', 'record', 'INV-2025-00001', '--amount', '5800.00', '--date', '2025-12-15', '--yes']).out)
        .toContain('11600.00 → 5800.00 (partially_paid)');

      ok(['vendor', 'create', 'Proveedor Sintetico SA de CV', '--tax-id', VENDOR_RFC, '--terms', 'Net 30']);
      // The number is read, not written: section 2's inbox bills drew 2025's first ones.
      const [bill] = rowsOf<{ bill_number: string }>(
        ok(['bill', 'create', 'Proveedor Sintetico', '--vendor-invoice-number', 'F-100', '--bill-date', '2025-12-08',
          '--line', 'account=6100;price=5000.00;tax-amount=800.00;description=Papeleria', '--json'])
      );
      ok(['bill', 'approve', bill.bill_number, '--yes']);
      expect(ok(['payment', 'create', bill.bill_number, '--amount', '5800.00', '--date', '2025-12-20', '--yes']).out)
        .toContain('5800.00 → 0.00 (paid)');

      ok(['credit-note', 'create', '--type', 'devolucion', '--invoice', 'INV-2025-00001',
        '--amount', '1000.00', '--tax', '160.00', '--date', '2025-12-18']);
      ok(['credit-note', 'issue', 'CN-2025-00001', '--yes']);
    }, STEP_TIMEOUT_MS);

    it('applies the credit note without a TTY: `credit-note apply` asks for --yes, and with it the invoice owes 4,640.00 and no entry is posted — MNE-001-088', () => {
      const owed = (): string =>
        money(rowsOf<{ amount_due: string }>(ok(['invoice', 'show', 'INV-2025-00001', '--json']))[0].amount_due);
      const entries = (): string[] =>
        rowsOf<{ entry_number: string }>(ok(['entry', 'list', '--all', '--json'])).map((e) => e.entry_number);
      const apply = ['credit-note', 'apply', 'CN-2025-00001', '--invoice', 'INV-2025-00001:1160.00'];
      const posted = entries();

      // A pipe is not a terminal: the binary asks for --yes, aborts (exit 10,
      // the code of a declined confirmation) and writes nothing.
      const refused = mnemosine(apply);
      expect(refused.status, refused.out + refused.err).toBe(10);
      expect(refused.err).toContain('Re-run with --yes');
      expect(owed()).toBe('5800.00');

      // 11,600 − 5,800 collected − 1,160 credited (1,000 + 160 IVA). The note
      // posted its entry when it was issued; applying it moves the subledger only.
      expect(ok([...apply, '--yes']).out).toContain('INV-2025-00001 5800.00 → 4640.00 (partially_paid)');
      expect(owed()).toBe('4640.00');
      expect(entries()).toEqual(posted);
    }, STEP_TIMEOUT_MS);

    it('records a customer advance with no invoice from the terminal: its IVA is caused the day it is collected — MNE-001-421', () => {
      // 1,160.00 at 16 %: the base is 1,160 / 1.16 = 1,000.00 and the IVA the other 160.00.
      const [advance] = rowsOf<Record<string, string>>(
        ok(['receipt', 'record', '--customer', 'Cliente Sintetico', '--amount', '1160.00', '--tax-rate', '16',
          '--date', '2025-12-10', '--yes', '--json'])
      );
      expect(advance).toMatchObject({ document: null, advance_base: '1000.00', advance_tax_rate: '16', advance_iva: '160.00' });
      const [entry] = rowsOf<{ lines: { account: string; debit: string; credit: string }[] }>(
        ok(['entry', 'show', advance.journal_entry, '--json'])
      );
      // The bank, the liability and the IVA caused: no revenue account moves.
      expect(entry.lines.map((l) => [l.account, l.debit && money(l.debit), l.credit && money(l.credit)])).toEqual([
        ['1111', '1160.00', ''], ['2150', '', '1000.00'], ['2120', '', '160.00'],
      ]);
    }, STEP_TIMEOUT_MS);

    it.todo('applies the customer advance to the next invoice — MNE-001-422');
    it('ar reconcile ties to 1120 as of the run and ap reconcile to 2110 at 2025-12-31, and an entry on 1120 blocks the close until it is reversed — MNE-001-034, MNE-001-035, MNE-001-036, MNE-001-037', () => {
      type ArTie = { control_balance: string; subledger_net: string; delta: string; balanced: boolean;
        manual_entries: { entry_number: string }[] };
      const arTie = ['ar', 'reconcile', '--strict', '--json'];
      const closeCheck = ['closing', 'check', '--period', 'December 2025', '--check', 'ar-subledger-delta', '--json'];
      // By hand: the opening invoice, 3,480, and what INV-2025-00001 still owes
      // after its receipt and its credit note, 11,600 − 5,800 − 1,160 = 4,640.
      // No credit note waits to be applied. 1120 holds the same 8,120.
      const tied = {
        control_balance: '8120.00', open_invoices: '8120.00', unapplied_credit_notes: '0.00',
        subledger_net: '8120.00', delta: '0.00', balanced: true,
      };
      // `ar reconcile` has no --as-of: it reads today's subledger against today's 1120.
      expect(rowsOf<ArTie>(ok(arTie))[0]).toMatchObject(tied);
      // Payables at the end of the month: every December bill was paid within
      // it, so the opening bill, 2,320, is all the subledger and all of 2110.
      // --strict would exit 4 on any reconciling item.
      expect(rowsOf(ok(['ap', 'reconcile', '--as-of', '2025-12-31', '--strict', '--json']))[0]).toMatchObject({
        asOf: '2025-12-31', subdiario: '2320.00', mayor: '2320.00', diferencia: '0.00', cuadra: true, partidas: [],
      });
      expect(rowsOf<{ is_complete: boolean }>(ok(closeCheck))[0].is_complete).toBe(true);

      // A sale typed as a journal entry: 1120 rises by 2,000 with no invoice behind it.
      const [stray] = rowsOf<{ entry_number: string }>(
        ok(['entry', 'create', '--date', '2025-12-28', '--description', 'Sale booked without an invoice',
          '--line', '1120:debit:2000.00', '--line', '4100:credit:2000.00', '--json'])
      );
      ok(['entry', 'post', stray.entry_number, '--yes']);

      // 8,120 + 2,000 = 10,120 in the ledger against 8,120 of documents. The
      // command names the entry and, under --strict, exits 4.
      const untied = mnemosine(arTie);
      expect(untied.status, untied.out + untied.err).toBe(4);
      const [delta] = rowsOf<ArTie>(untied);
      expect(delta).toMatchObject({ control_balance: '10120.00', subledger_net: '8120.00', delta: '2000.00', balanced: false });
      expect(delta.manual_entries.map((m) => m.entry_number)).toContain(stray.entry_number);
      // The close reads the same figure, and it blocks without --strict.
      const blocked = mnemosine(closeCheck);
      expect(blocked.status, blocked.out + blocked.err).toBe(4);
      expect(rowsOf<{ is_complete: boolean; severity: string; details: string }>(blocked)[0]).toMatchObject({
        is_complete: false,
        severity: 'blocking',
        details: 'control 10120.00 vs subledger 8120.00 · delta 2000.00 (ar reconcile lists the causes)',
      });

      // The correction is a mirror dated inside December (NIF B-1). `entry void`
      // would date its mirror on the day of the run, outside the month.
      const reversed = ok(['entry', 'reverse', stray.entry_number, '--date', '2025-12-31',
        '--reason', 'Sale booked without an invoice', '--yes']).out;
      const mirror = /(\S+) posted as the reversal of/.exec(reversed)?.[1] ?? '';
      const [shown] = rowsOf<{ entry_date: string; reverses: string; is_reversal: boolean }>(
        ok(['entry', 'show', mirror, '--no-lines', '--json'])
      );
      expect(shown).toMatchObject({ reverses: stray.entry_number, is_reversal: true });
      expect(shown.entry_date.slice(0, 10)).toBe('2025-12-31');

      expect(rowsOf<ArTie>(ok(arTie))[0]).toMatchObject(tied);
      expect(rowsOf<{ is_complete: boolean }>(ok(closeCheck))[0].is_complete).toBe(true);
      // December moved as if the entry had never been typed: 1120 by 11,600
      // − 5,800 − 1,160, and 4100 by the one invoice.
      expect(decemberMoves(['1120', '4100'])).toEqual({ '1120': '4640.00', '4100': '-10000.00' });
    }, STEP_TIMEOUT_MS);
  });

  describe('4 · bank', () => {
    /** The bank's movements as `bank transaction list` prints them: date and signed amount, sorted. */
    const bankMovements = (): string[] =>
      rowsOf<{ date: string; amount: string }>(
        ok(['bank', 'transaction', 'list', '--account', BANK_ACCOUNT, '--all', '--fields', 'date,amount', '--json'])
      ).map((m) => `${m.date} ${money(m.amount)}`).sort();

    type SessionStatus = {
      id: string; status: string; variance: string; unexplained_lines: number; blockers: { code: string }[];
      items: { id: string; date: string; type: string; side: string; amount: string; owner: string; expected: string; resolved: boolean }[];
      adjustments: { type: string; amount: string; draft_status: string; journal_entry: string }[];
    };
    type SessionPost = { entries: { entry_number: string }[] };
    /** The December session, the hash of its first signature and the entries its first post wrote. */
    let sessionId = '';
    let signature = '';
    let postedEntries: string[] = [];
    /** An entry as `<date> <account> Dr|Cr <amount> …`, a line after another. */
    const entryOf = (entryNumber: string): string => {
      const [entry] = rowsOf<{ entry_date: string; lines: { account: string; debit: string; credit: string }[] }>(
        ok(['entry', 'show', entryNumber, '--json'])
      );
      return [entry.entry_date.slice(0, 10),
        ...entry.lines.map((l) => `${l.account} ${l.debit ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}`)].join(' ');
    };

    it('collections and payments land on 1111, the leaf, not on 1110: debits 6,960.00 and credits 65,773.33 — MNE-001-039', () => {
      // The role that every receipt and payment posts to names the leaf.
      expect(rowsOf<{ account_code: string }>(ok(['account', 'role', 'list', '--role', 'banco', '--json']))
        .map((r) => r.account_code)).toEqual(['1111']);

      // By hand, the cash of the month before its close. Debits: the 1,160
      // advance and the 5,800 receipt. Credits: the 36,000 computers, the
      // bookshop's 1,200 and 450, the hotel's 1,190, the two PUE of 1,160, the
      // fees' net of 9,533.33, the 5,800 payment and the REP's 9,280.
      const tb = rowsOf<{ account_code: string; debit_total: string; credit_total: string }>(
        ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json'])
      );
      const moved = (code: string): string[] => {
        const row = tb.find((r) => r.account_code === code);
        return [money(row?.debit_total ?? '0'), money(row?.credit_total ?? '0')];
      };
      expect(moved('1111')).toEqual(['6960.00', '65773.33']);
      // Nothing on the parent itself, nor on its other leaves.
      for (const code of ['1110', '1112', '1115']) expect(moved(code), code).toEqual(['0.00', '0.00']);
    }, STEP_TIMEOUT_MS);

    it('imports the December statement, the first session with a baseline instead of the whole ledger history — MNE-001-038', () => {
      const [account] = rowsOf<Record<string, string>>(
        ok(['bank', 'account', 'create', BANK_ACCOUNT, '--bank', 'BBVA Mexico', '--gl-account', '1111', '--currency', 'MXN', '--json'])
      );
      expect(account).toMatchObject({ account: BANK_ACCOUNT, gl_code: '1111', currency: 'MXN' });

      // The export carries no balance and the account has no earlier
      // statement to carry one from: without --closing-balance it is refused
      // (exit 4) and nothing is imported.
      const csv = path.join(workDir, 'bbva-2025-12.csv');
      fs.writeFileSync(csv, statementCsv('01'));
      const load = ['bank', 'statement', 'import', csv, '--account', BANK_ACCOUNT];
      const bare = mnemosine([...load, '--json']);
      expect(bare.status, bare.out + bare.err).toBe(4);
      expect(bare.err).toContain('--closing-balance');
      expect(bankMovements()).toEqual([]);

      // With the closing balance of the printed statement, the opening
      // follows: 40,838.67 − 6,960 + 66,121.33 = 100,000.00.
      const [imported] = rowsOf<Record<string, unknown>>(ok([...load, '--closing-balance', STATEMENT_CLOSING, '--json']));
      expect(imported).toMatchObject({
        file: 'bbva-2025-12.csv', format: 'csv', profile: 'bbva-mx', account: BANK_ACCOUNT, currency: 'MXN',
        period: '2025-12-01..2025-12-31', read: 13, imported: 13, duplicated: 0, overlaps: [], overlap_policy: 'block',
      });
      expect([money(imported['opening'] as string), money(imported['closing'] as string)])
        .toEqual([BANK_BASELINE, STATEMENT_CLOSING]);
      statementId = imported['statement_id'] as string;

      // The baseline is what 1111 held the day before the period. Typing
      // today's balance of 1111 instead is refused (exit 4) with the
      // difference, 100,000 − 41,186.67 (the fee is not in the books yet), and
      // no session is opened.
      const open = (baseline: string): string[] =>
        ['bank', 'reconciliation', 'open', BANK_ACCOUNT, '--period', '2025-12', '--baseline', baseline, '--json'];
      const refused = mnemosine(open(BOOKS_BEFORE_FEE));
      expect(refused.status, refused.out + refused.err).toBe(4);
      expect(refused.err).toContain('41186.67 al 2025-11-30 y los libros dicen 100000.00: difieren en 58813.33');
      expect(rowsOf(ok(['bank', 'reconciliation', 'list', '--json']))).toEqual([]);

      const [session] = rowsOf<Record<string, unknown>>(ok(open(BANK_BASELINE)));
      expect(session).toMatchObject({
        account: BANK_ACCOUNT, period: '2025-12-01..2025-12-31', statement_id: statementId, statements: 1,
        previous_session: '', baseline_date: '2025-11-30', warnings: [], dry_run: false,
      });
      expect(['opening', 'closing_bank', 'baseline_balance'].map((k) => money(session[k] as string)))
        .toEqual([BANK_BASELINE, STATEMENT_CLOSING, BANK_BASELINE]);
    }, STEP_TIMEOUT_MS);

    it('an overlapping statement does not duplicate movements — MNE-001-042', () => {
      // The thirteen movements of the statement, charges negative.
      const movements = STATEMENT_MOVEMENTS
        .map(([day, , charge, credit]) => `2025-12-${day} ${money(credit || `-${charge}`)}`).sort();
      expect(bankMovements()).toEqual(movements);

      // A second download, of the last fortnight: other bytes, so it is not
      // the same document, but its six movements are in the month's file.
      // The panel's default, bank_statement_overlap = block, refuses it whole
      // (exit 6, a conflict) and names where the movements already are.
      const csv = path.join(workDir, 'bbva-2025-12-16-al-31.csv');
      fs.writeFileSync(csv, statementCsv('16'));
      const refused = mnemosine(
        ['bank', 'statement', 'import', csv, '--account', BANK_ACCOUNT, '--closing-balance', STATEMENT_CLOSING, '--json']
      );
      expect(refused.status, refused.out + refused.err).toBe(6);
      expect(refused.err).toContain('6 línea(s) de este archivo ya están en otro estado de cuenta de la cuenta (bbva-2025-12.csv)');
      expect(refused.err).toContain('`bank_statement_overlap` está en "block"');

      expect(bankMovements()).toEqual(movements);
      expect(rowsOf<{ id: string }>(ok(['bank', 'statement', 'list', '--account', BANK_ACCOUNT, '--fields', 'id', '--json'])).map((s) => s.id))
        .toEqual([statementId]);
    }, STEP_TIMEOUT_MS);

    it('reconciles, classifies the bank fee and its IVA, and closes the session — MNE-001-040, MNE-001-041, MNE-001-043', () => {
      // Where step 4·231 left the session: nothing matched yet, and the bank
      // 348.00 below the books, 40,838.67 − 41,186.67.
      const [opened] = rowsOf<SessionStatus>(ok(['bank', 'reconciliation', 'status', '--account', BANK_ACCOUNT, '--json']));
      expect(opened).toMatchObject({ status: 'in_progress', variance: '-348.00', unexplained_lines: 13, items: [] });
      sessionId = opened.id;

      // The matcher writes matches and seals lines of 1111, never an entry.
      // Eleven movements have their line in the books, to the cent and on
      // their date; the bank's own two have none.
      const matched = rowsOf<{ outcome: string; amount: string; sealed: boolean; reason: string | null }>(
        ok(['bank', 'match', 'run', '--account', BANK_ACCOUNT, '--session', sessionId, '--json'])
      );
      expect(matched.filter((m) => m.outcome === 'applied' && m.sealed).map((m) => money(m.amount)).sort())
        .toEqual(STATEMENT_MOVEMENTS.slice(0, 11).map(([, , charge, credit]) => charge || credit).sort());
      expect(matched.filter((m) => m.outcome !== 'applied').map((m) => `${m.outcome} ${m.reason}`))
        .toEqual(['skipped sin-candidato', 'skipped sin-candidato']);

      // Two lines of the statement that nothing explains: the session does
      // not close (exit 4), and says what is missing.
      const close = ['bank', 'reconciliation', 'close', sessionId, '--yes', '--json'];
      const early = mnemosine(close);
      expect(early.status, early.out + early.err).toBe(4);
      const [unexplained] = rowsOf<SessionStatus & { closed: boolean }>(early);
      expect(unexplained).toMatchObject({ closed: false, status: 'in_progress', variance: '-348.00', unexplained_lines: 2 });
      expect(unexplained.blockers.map((b) => b.code)).toEqual(['variacion-fuera-de-tolerancia', 'linea-de-banco-sin-explicar']);

      // The guided pass, resumed over the open session, raises each as a
      // reconciling item: a charge of the bank that the books still owe. With
      // them the arithmetic ties, 41,186.67 − 348 = 40,838.67. What is left
      // is theirs to say: who follows each item, and when it settles.
      const [pass] = rowsOf<{ classification: { raised: number }; status: SessionStatus }>(
        ok(['bank', 'reconciliation', 'run', BANK_ACCOUNT, '--period', '2025-12', '--resume', '--json'])
      );
      expect(pass.classification.raised).toBe(2);
      expect(pass.status).toMatchObject({ variance: '0.00', unexplained_lines: 0, undated: 2, ready_to_close: false });
      expect(pass.status.blockers.map((b) => b.code)).toEqual(['partida-sin-fechar']);
      expect(pass.status.items.map((i) => `${i.date} ${i.type} ${i.side} ${i.amount}`).sort())
        .toEqual([`2025-12-31 cargo-del-banco libros -${BANK_FEE}`, `2025-12-31 cargo-del-banco libros -${BANK_FEE_IVA}`]);
      const [fee, feeIva] = [BANK_FEE, BANK_FEE_IVA].map((amount) => pass.status.items.find((i) => i.amount === `-${amount}`)?.id ?? '');

      // An adjustment proposes the entry of an item. A fee has no account
      // role to resolve, so without --gl-account it is refused (exit 4); its
      // IVA goes to the role of creditable IVA, 1130, by itself. Each comes
      // out with 11: a draft that waits for a person, with no entry.
      const adjust = (type: string, amount: string, item: string, ...account: string[]): Run =>
        mnemosine(['bank', 'adjustment', 'create', sessionId, '--type', type, '--amount', `-${amount}`, '--item', item, ...account, '--json']);
      const noAccount = adjust('comision', BANK_FEE, fee);
      expect(noAccount.status, noAccount.out + noAccount.err).toBe(4);
      expect(noAccount.out + noAccount.err).toContain('comision_bancaria');
      for (const [draft, counterpart, amount] of [
        [adjust('comision', BANK_FEE, fee, '--gl-account', '6310'), '6310', 300],
        [adjust('iva-comision', BANK_FEE_IVA, feeIva), '1130', 48],
      ] as const) {
        expect(draft.status, draft.out + draft.err).toBe(11);
        const [proposed] = rowsOf<Record<string, unknown>>(draft);
        expect(proposed).toMatchObject({ counterparty_account: counterpart, bank_account: '1111', journal_entry: null });
        expect(proposed['lines']).toEqual([
          expect.objectContaining({ account_code: counterpart, debit: amount }),
          expect.objectContaining({ account_code: '1111', credit: amount }),
        ]);
      }
      for (const item of [fee, feeIva]) {
        ok(['bank', 'reconciling-item', 'assign', sessionId, item, '--owner', 'Tesoreria', '--expected', '2025-12-31', '--yes']);
      }

      // Closed: the session says the cash is verified against the bank, with
      // the 348.00 as charges the books have yet to record. Signed: the firm
      // has one user, and by default the panel lets the one who closed sign
      // (segregacion_de_funciones is off), which the signature says aloud.
      // Neither act posts: December moved as section 3 left it.
      expect(rowsOf(ok(close))[0]).toMatchObject({
        status: 'balanced', variance: '0.00', books_balance: BOOKS_BEFORE_FEE, bank_charges: '-348.00',
        bank_adjusted: STATEMENT_CLOSING, books_adjusted: STATEMENT_CLOSING,
      });
      const [signed] = rowsOf<{ hash: string }>(
        ok(['bank', 'reconciliation', 'approve', sessionId, '--reason', 'December statement', '--yes', '--json'])
      );
      expect(signed).toMatchObject({
        status: 'approved', balances: true, items: 2, matches: 11, adjustments: 2,
        segregation: { policy: 'off', approver_is_preparer: true },
      });
      signature = signed.hash;
      expect(decemberMoves(['1111', '1130', '6310'])).toEqual({ '1111': '-58813.33', '1130': '4160.00', '6310': '0.00' });

      // The post is what moves the ledger: an entry per adjustment, dated the
      // last day of the session, each sealed against its line of the statement.
      const [posted] = rowsOf<SessionPost>(ok(['bank', 'reconciliation', 'post', sessionId, '--yes', '--json']));
      expect(posted).toMatchObject({
        status: 'posted', posted: 2, adopted: 0, sealed_lines: 2, matches_written: 2, items_resolved: 2,
      });
      postedEntries = posted.entries.map((e) => e.entry_number).sort();
      expect(postedEntries.map(entryOf).sort()).toEqual([
        '2025-12-31 1130 Dr 48.00 1111 Cr 48.00', '2025-12-31 6310 Dr 300.00 1111 Cr 300.00',
      ]);
      // The bank: −58,813.33 − 348; 1130: 4,160 + 48. The books now end
      // where the statement does.
      expect(decemberMoves(['1111', '1130', '6310'])).toEqual({ '1111': '-59161.33', '1130': '4208.00', '6310': BANK_FEE });
      expect(rowsOf<SessionStatus>(ok(['bank', 'reconciliation', 'status', sessionId, '--json']))[0]).toMatchObject({
        status: 'posted', variance: '0.00', resolved_items: 2, unexplained_lines: 0,
        bank: { balance: STATEMENT_CLOSING }, books: { balance: STATEMENT_CLOSING },
      });
    }, STEP_TIMEOUT_MS);

    it('reopens the posted reconciliation from the terminal, which reverses what it posted, and closes, signs and posts it again — MNE-001-044, MNE-001-130', () => {
      // Withdrawing a signature takes a reason: without one the command is
      // refused as misused (exit 2) and the session stays posted.
      const reopen = ['bank', 'reconciliation', 'reopen', sessionId, '--yes', '--json'];
      const unexplained = mnemosine(reopen);
      expect(unexplained.status, unexplained.out + unexplained.err).toBe(2);
      expect(unexplained.out + unexplained.err).toContain('--reason');

      const [reopened] = rowsOf<{ reversals: { entry: string; reversal: string }[] }>(
        ok([...reopen, '--reason', 'The fee is checked against the contract with the bank'])
      );
      expect(reopened).toMatchObject({ id: sessionId, status: 'in_progress', previous_status: 'posted', withdrawn_hash: signature });
      expect(reopened.reversals.map((r) => r.entry).sort()).toEqual(postedEntries);
      // Nothing is deleted: each entry gets its mirror, dated the same 12-31,
      // inside the month that is still open.
      expect(reopened.reversals.map((r) => entryOf(r.reversal)).sort()).toEqual([
        '2025-12-31 1130 Cr 48.00 1111 Dr 48.00', '2025-12-31 6310 Cr 300.00 1111 Dr 300.00',
      ]);
      expect(rowsOf(ok(['entry', 'show', reopened.reversals[0].reversal, '--no-lines', '--json']))[0])
        .toMatchObject({ reverses: reopened.reversals[0].entry, is_reversal: true });

      // The books are back where the first close found them, the two items
      // are open again with their owner and date, and each adjustment is a
      // draft once more, on a draft of its own.
      expect(decemberMoves(['1111', '1130', '6310'])).toEqual({ '1111': '-58813.33', '1130': '4160.00', '6310': '0.00' });
      const [again] = rowsOf<SessionStatus>(ok(['bank', 'reconciliation', 'status', sessionId, '--json']));
      expect(again).toMatchObject({
        status: 'in_progress', variance: '0.00', resolved_items: 0, undated: 0, blockers: [], ready_to_close: true,
        bank: { balance: STATEMENT_CLOSING }, books: { balance: BOOKS_BEFORE_FEE, adjusted: STATEMENT_CLOSING },
      });
      expect(again.items.map((i) => `${i.amount} ${i.owner} ${i.expected} ${i.resolved}`).sort())
        .toEqual([`-${BANK_FEE} Tesoreria 2025-12-31 false`, `-${BANK_FEE_IVA} Tesoreria 2025-12-31 false`]);
      expect(again.adjustments.map((a) => `${a.type} ${a.amount} ${a.draft_status} ${a.journal_entry}`).sort())
        .toEqual([`comision -${BANK_FEE} pending_review `, `iva-comision -${BANK_FEE_IVA} pending_review `]);

      // The same range, a second time: closed, signed with another hash, and
      // posted as two new entries.
      expect(rowsOf(ok(['bank', 'reconciliation', 'close', sessionId, '--yes', '--json']))[0])
        .toMatchObject({ status: 'balanced', variance: '0.00', bank_charges: '-348.00' });
      const [signed] = rowsOf<{ hash: string }>(
        ok(['bank', 'reconciliation', 'approve', sessionId, '--reason', 'Checked: the fee is the contract\'s', '--yes', '--json'])
      );
      expect(signed).toMatchObject({ status: 'approved', items: 2, matches: 11, adjustments: 2 });
      expect(signed.hash).not.toBe(signature);
      const [posted] = rowsOf<SessionPost>(ok(['bank', 'reconciliation', 'post', sessionId, '--yes', '--json']));
      expect(posted).toMatchObject({ status: 'posted', posted: 2, adopted: 0, items_resolved: 2 });
      const second = posted.entries.map((e) => e.entry_number);
      expect(second.filter((n) => postedEntries.includes(n))).toEqual([]);
      expect(second.map(entryOf).sort()).toEqual([
        '2025-12-31 1130 Dr 48.00 1111 Cr 48.00', '2025-12-31 6310 Dr 300.00 1111 Cr 300.00',
      ]);

      // One fee in the balances, three passes in the columns: on 1111, the
      // 6,960 of step 4·230 + 348 of the mirrors, and its 65,773.33 + 2 × 348.
      const tb = rowsOf<{ account_code: string; debit_total: string; credit_total: string; net_change: string }>(
        ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json'])
      );
      expect(Object.fromEntries(['1111', '1130', '6310'].map((code) => {
        const row = tb.find((r) => r.account_code === code);
        return [code, [row?.debit_total, row?.credit_total, row?.net_change].map(money).join(' ')];
      }))).toEqual({ '1111': '7308.00 66469.33 -59161.33', '1130': '4256.00 48.00 4208.00', '6310': '600.00 300.00 300.00' });

      // The range was reused, not opened as a second session, and all of it
      // happened with December open: its hard close is step 6.
      expect(rowsOf<{ status: string; variance: string; open_items: number }>(ok(['bank', 'reconciliation', 'list', '--json'])))
        .toEqual([expect.objectContaining({ account: BANK_ACCOUNT, status: 'posted', variance: '0.00', open_items: 0 })]);
      expect(rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']))
        .find((p) => p.period_name === 'December 2025')?.status).toBe('open');
    }, STEP_TIMEOUT_MS);
  });

  describe('5 · payroll', () => {
    it.todo('hires two employees and runs and posts a fortnight: ISR with subsidy, IMSS, INFONAVIT, ISN, entry and SUA — MNE-001-066, MNE-001-068, MNE-001-069, MNE-001-070');
    it.todo('the fortnight figures match the hand-computed ones: employer IMSS, aguinaldo, vacation premium and 2026 subsidy — MNE-001-061, MNE-001-062, MNE-001-063, MNE-001-064');
  });

  describe('6 · month-end close', () => {
    it('the checklist flags an entity with no fixed assets while 1220 carries the computers, and the asset is registered — MNE-001-020, MNE-001-021', () => {
      // The computers were bought in step 3, on 12-01: 1220 holds their 36,000
      // and no asset is registered yet.
      // A finding, not a pass: warning weight, so only --strict makes it fail.
      const flagged = mnemosine(['closing', 'check', '--period', 'December 2025',
        '--check', 'depreciation-posted', '--strict', '--json']);
      expect(flagged.status, flagged.out + flagged.err).toBe(4);
      expect(rowsOf<{ is_complete: boolean; details: string }>(flagged)[0]).toMatchObject({
        is_complete: false,
        details: '0 fixed assets registered, but the fixed-asset accounts carry 36000.00 at 2025-12-31: ' +
          'register them (asset create) so the month can be depreciated',
      });

      ok(['asset', 'create', 'Laptops', '--category', 'Equipo de Cómputo', '--cost', '36000.00',
        '--acquired', '2025-12-01', '--capitalized', 'yes']);
    }, STEP_TIMEOUT_MS);

    it('conducts the close of December, posts its depreciation, and seals a balanced dossier', () => {
      // December shares its start month with period 13 ("Year-end adjustments 2025"),
      // so the close leaves refuse 2025-12 and the month is named (MNE-001-087).
      const run = ok(['closing', 'run', 'December 2025', '-y']).out;
      expect(run).toMatch(/December 2025\s+completed/);
      expect(run).toContain('1 asset(s) depreciated');
      // `closing run` ends with the seal (#99, MNE-001-049): the carry-forward
      // into period 13 lives only in the hard close.
      expect(run).toContain('period hard-closed; balances carried into');
      const periods = rowsOf<{ period_name: string; status: string }>(ok(['period', 'list', '--json']));
      expect(periods.find((p) => p.period_name === 'December 2025')?.status).toBe('hard_close');

      const pack = ok(['closing', 'pack', 'generate', 'December 2025', '--json']);
      const [sealed] = rowsOf<{ debit: string; credit: string; balanced: boolean }>(pack);
      expect(money(sealed.debit)).toBe(SEALED_DEBITS);
      expect(money(sealed.credit)).toBe(SEALED_DEBITS);
      expect(sealed.balanced).toBe(true);
    }, STEP_TIMEOUT_MS);

    it.todo('closes the 2025 fiscal year into period 13: `balance generate --closing` nets to 0 and the closing entries are not in December — MNE-001-046');
  });

  describe('7 · financial statements, to the cent', () => {
    it('trial balance, income statement, balance sheet and cash flow match the hand figures', () => {
      // A period's trial balance has a beginning, so its ending balance is
      // `final_balance`; `net_change` is the month's movement (MNE-001-126).
      const tb = rowsOf<{ account_code: string; final_balance: string; debit_total: string; credit_total: string }>(
        ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--exclude-zero', '--json'])
      );
      for (const [code, expected] of Object.entries(ENDING)) {
        expect(money(tb.find((r) => r.account_code === code)?.final_balance), `ending balance of ${code}`).toBe(expected);
      }
      const debits = tb.reduce((s, r) => s.plus(r.debit_total), new Decimal(0));
      const credits = tb.reduce((s, r) => s.plus(r.credit_total), new Decimal(0));
      expect(credits.toFixed(2)).toBe(debits.toFixed(2));

      const is = rowsOf<StatementRow>(ok(['report', 'income-statement', 'show', '--period', '2025-12', '--json']));
      expect(lineOf(is, (r) => r.section === 'revenue' && r.line === 'total')).toBe(NET_SALES);
      expect(lineOf(is, (r) => r.section === '' && r.line === 'total')).toBe(NET_INCOME);

      const bs = rowsOf<StatementRow>(ok(['report', 'balance-sheet', 'show', '--as-of', '2025-12-31', '--json']));
      expect(lineOf(bs, (r) => r.section === 'assets' && r.line === 'total')).toBe(TOTAL_ASSETS);
      expect(lineOf(bs, (r) => r.section === 'liabilities' && r.line === 'total')).toBe(TOTAL_LIABILITIES);
      expect(lineOf(bs, (r) => r.section === 'equity' && r.line === 'total')).toBe(TOTAL_EQUITY);

      const cf = rowsOf<StatementRow>(ok(['cashflow', 'generate', '--period', '2025-12', '--json']));
      expect(lineOf(cf, (r) => r.section === 'operating' && r.line === 'total')).toBe(OPERATING_CASH);
      expect(lineOf(cf, (r) => r.section === 'investing' && r.line === 'total')).toBe(INVESTING_CASH);
      expect(lineOf(cf, (r) => r.section === 'financing' && r.line === 'total')).toBe(FINANCING_CASH);
      expect(lineOf(cf, (r) => r.line === 'residue')).toBe('0.00');
    }, STEP_TIMEOUT_MS);

    it('the trial balance by --level rolls its subaccounts up into their parent — MNE-001-050', () => {
      type TbRow = { account_code: string; debit_total: string; credit_total: string; net_change: string; final_balance: string };
      const detail = rowsOf<TbRow>(ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--json']));
      const leveled = ok(['report', 'trial-balance', 'show', '--period', '2025-12', '--level', '3', '--json']);
      expect(leveled.err).not.toContain('OUT OF BALANCE');
      const tb = rowsOf<TbRow>(leveled);
      const cash = tb.find((r) => r.account_code === '1110');

      // By hand: every cash movement of the month sits in the subtree of 1110,
      // whichever of its accounts it landed on (MNE-001-039). Debits: the
      // 5,800 receipt and the 1,160 advance, since the opening is January's; credits: the 36,000
      // computers, the 5,800 payment, the REP's 9,280, the two PUE paid,
      // 1,160 each, and the edge cases: 1,200 + 450 + 1,190 + 9,533.33. The
      // bank fee and its IVA were credited twice, 2 × 348, and debited once,
      // by the mirrors of the reopening: 6,960 + 348 and 65,773.33 + 696.
      // 100,000 + 7,308 − 66,469.33 = 40,838.67, the ending of 1111.
      expect(money(cash?.debit_total)).toBe('7308.00');
      expect(money(cash?.credit_total)).toBe('66469.33');
      expect(money(cash?.final_balance)).toBe(ENDING['1111']);

      // And against the detail balanza: 1110 is itself plus 1111, 1112 and
      // 1115, its children in the seeded chart (issue #100: 1110 = 1111 + 1112).
      for (const col of ['debit_total', 'credit_total', 'net_change', 'final_balance'] as const) {
        const subtree = detail
          .filter((r) => ['1110', '1111', '1112', '1115'].includes(r.account_code))
          .reduce((s, r) => s.plus(r[col]), new Decimal(0));
        expect(money(cash?.[col]), `1110 ${col}`).toBe(subtree.toFixed(2));
      }
      // 1000 → 1100 → 1110 → 1111: the leaves are level 4, so the cut hides
      // them and their money is printed once, inside 1110.
      expect(tb.some((r) => ['1111', '1112', '1115'].includes(r.account_code))).toBe(false);
    }, STEP_TIMEOUT_MS);
  });

  describe('8 · monthly obligations', () => {
    it.todo('the Anexo 24 chart and trial balance XML validate against their XSD, and 1110 declares 1111 + 1112 — MNE-001-047');
    it.todo('the journal and auxiliary XML of the month are produced by command — MNE-001-054');
    it.todo('`diot export --layout sat` matches, byte for byte, the file written by hand — MNE-001-055, MNE-001-027');
    it.todo('the IVA and ISR working paper has the exact hand figures, each line traced to its entries — MNE-001-058, MNE-001-059, MNE-001-060, MNE-001-115');
  });

  describe('9 · safe operation', () => {
    it('the ledger checks pass, and the backup restores into another database with its checks green', () => {
      ok(['ledger', 'check']);
      const target = path.join(workDir, 'backups');
      // `backup --json` publishes its keys in Spanish; they are read as printed, never renamed.
      const [dump] = rowsOf<Record<string, string>>(ok(['backup', 'create', '--target', target, '--json'], 'none'));
      const [verified] = rowsOf<Record<string, unknown>>(
        ok(['backup', 'verify', dump['archivo'], '--restore', '--json'], 'none')
      );
      // restored, intact, and no blocking ledger finding in the restored copy
      expect(verified).toMatchObject({ restauro: true, integro: true, bloqueantes: 0 });
    }, STEP_TIMEOUT_MS);
  });
});
