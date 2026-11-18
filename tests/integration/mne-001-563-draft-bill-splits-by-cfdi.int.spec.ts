import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type OpenAI from 'openai';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, type DraftCapture } from '../../src/ai/ingest-service.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import { approveDraft, canonicalDraftHash, getDraft, type Reviewer } from '../../src/ai/draft-service.js';
import { reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { approveBill, createBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';

// ============================================================
// MNE-001-563 · A BILL BORN FROM AN APPROVED DRAFT IS SPLIT BY ITS CFDI
//
// Under the default `lineas_factura_desde = poliza` the bill lines are the
// debits of the approved entry and carry no VAT; the header keeps the CFDI's.
// The DIOT and the VAT workpaper read the split by rate from the CFDI itself.
// Every bill goes through a real door; all data is synthetic.
//
//   T1, T2, T5 · PUE 1,460.00 (1,000.00 at 16 % + 300.00 exempt), paid in March
//   T3 · the same CFDI as PPD, paid 730.00 in April and 730.00 in May
//   T4 · one concept at 16 % coded to two accounts (June)
//   G1 · `conceptos_cfdi` (August)        G2, G4 · the inbox door (September)
//   G3 · `bill create` with a header that differs from its lines (October)
// ============================================================

const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'EXM010101AA1';
const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};
type Diot = Awaited<ReturnType<typeof construirDiot>>;
type EntryLine = { account_code: string; debit?: number; credit?: number };

const vat16 = '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>';
const exempt = '<cfdi:Traslado Base="300.00" Impuesto="002" TipoFactor="Exento"/>';
const ACCEPTANCE: Array<[string, string]> = [['1000.00', vat16], ['300.00', exempt]];
const DRAFT: EntryLine[] = [{ account_code: '6100', debit: 1300 }, { account_code: '1130', debit: 160 }, { account_code: '2110', credit: 1460 }];

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;
let vendorId: string;
const bills: Record<string, string> = {};
const diots: Record<string, Diot> = {};
let workpaper: IvaWorkpaper;

/** A received CFDI dated the 10th of `month`; the summary node repeats every concept transfer. */
function cfdi(month: number, method: 'PUE' | 'PPD', concepts: Array<[amount: string, transfer: string]>, taxes: string, total: string) {
  const uuid = uuidv4().toUpperCase();
  const date = `2026-${String(month).padStart(2, '0')}-10`;
  const lines = concepts.map(([amount, transfer], i) =>
    `<cfdi:Concepto ClaveProdServ="86121700" ClaveUnidad="E48" Descripcion="Concept ${i + 1}" Cantidad="1" ` +
    `ValorUnitario="${amount}" Importe="${amount}" ObjetoImp="02">` +
    `<cfdi:Impuestos><cfdi:Traslados>${transfer}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`).join('');
  const subtotal = concepts.reduce((s, [amount]) => s + Number(amount), 0).toFixed(2);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="E" Folio="${uuid.slice(0, 6)}" Fecha="${date}T10:00:00" FormaPago="${method === 'PUE' ? '03' : '99'}" MetodoPago="${method}" TipoDeComprobante="I" Moneda="MXN" SubTotal="${subtotal}" Total="${total}" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${VENDOR_RFC}" Nombre="Mixed Services SC" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>${lines}</cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${taxes}"><cfdi:Traslados>${concepts.map(([, t]) => t).join('')}</cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="${date}T10:00:00" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001000000500000001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
  return { xml, uuid, date };
}

/** The real approval door: ingest the CFDI, let the model draft `lines`, approve the draft. */
async function approved(doc: ReturnType<typeof cfdi>, lines: EntryLine[]): Promise<string> {
  const file = path.join(dir, `${doc.uuid}.xml`);
  fs.writeFileSync(file, doc.xml);
  const args = { entry_date: doc.date, description: `Bill ${doc.uuid}`, reference: doc.uuid.slice(0, 8), confidence: 0.9, reasoning: 'Expense', lines };
  const capture: DraftCapture = { drafts: [] };
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'draft_journal_entry', arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    .mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Draft created.' }, finish_reason: 'stop' }] });
  const session = new OpenAiCompatSession(
    { chat: { completions: { create } } } as unknown as OpenAI, PROFILE, ctx, 'system',
    { onDraftCreated: (d) => capture.drafts.push(d), draftOrigin: () => capture.origin },
    { grounding: { enabled: false }, cwd: dir }
  );
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file], thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 100000 }, session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe('draft');
  const draft = await getDraft(ctx, capture.drafts[0].draftId);
  await approveDraft(ctx, draft!.id, reviewer, undefined, canonicalDraftHash(draft!.payload, draft!.origin));
  return (await query<{ id: string }>(`SELECT id FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, doc.uuid])).rows[0].id;
}

const pay = (billId: string, amount: string, date: string) =>
  recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: amount, paymentDate: date, paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: amount }],
    },
    f.userId
  );
const diot = (month: number) => construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
/** What the DIOT declares for one bill: its boxes and the codes of its findings. */
const declared = (d: Diot, billId: string) => {
  const doc = d.renglones.flatMap((r) => r.documentos).find((x) => x.billId === billId);
  return {
    tasa16: doc?.desglose.tasa16, exento: doc?.desglose.exento,
    codes: d.hallazgos.filter((h) => h.documentId === billId && h.severidad === 'bloqueante').map((h) => h.codigo),
  };
};
const lineTaxes = async (billId: string) =>
  (await query<{ tax: string }>(`SELECT tax_amount::text AS tax FROM bill_lines WHERE bill_id = $1 ORDER BY line_number`, [billId])).rows.map((r) => r.tax);
const box = (base: string, iva = '0.0000') => ({ base, iva });
const SPLIT = { tasa16: box('1000.0000', '160.0000'), exento: box('300.0000'), codes: [] };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-563 draft bill split');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-563', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  const policy = { tenantId: f.tenantId, entityId: f.entityId };
  await seedPolicies(policy);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne563-'));
  vendorId = uuidv4();
  const expense = (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId])).rows[0].id;
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, tipo_tercero, tipo_operacion, default_expense_account_id)
     VALUES ($1, $2, 'V-563', 'Mixed Services SC', $3, 'rfc', 'MXN', $4, '04', '85', $5)`,
    [vendorId, f.entityId, VENDOR_RFC, f.userId, expense]
  );

  // The default policy: `lineas_factura_desde = poliza`.
  bills.t1 = await approved(cfdi(3, 'PUE', ACCEPTANCE, '160.00', '1460.00'), DRAFT);
  bills.t3 = await approved(cfdi(3, 'PPD', ACCEPTANCE, '160.00', '1460.00'), DRAFT.map((l) => (l.account_code === '1130' ? { ...l, account_code: '1135' } : l)));
  bills.t4 = await approved(cfdi(6, 'PUE', [['1000.00', vat16]], '160.00', '1160.00'), [
    { account_code: '6100', debit: 600 }, { account_code: '6100', debit: 400 }, { account_code: '1130', debit: 160 }, { account_code: '2110', credit: 1160 },
  ]);

  await resolvePolicy(policy, 'lineas_factura_desde', 'conceptos_cfdi', email);
  bills.g1 = await approved(cfdi(8, 'PUE', ACCEPTANCE, '160.00', '1460.00'), [
    { account_code: '6100', debit: 1000 }, { account_code: '6100', debit: 300 }, { account_code: '1130', debit: 160 }, { account_code: '2110', credit: 1460 },
  ]);
  await reopenPolicy(policy, 'lineas_factura_desde');

  const svc = new PreRegistrationService();
  const up = await svc.processXMLUpload(f.entityId, cfdi(9, 'PUE', ACCEPTANCE, '160.00', '1460.00').xml, 'manual_upload', f.userId);
  bills.g2 = ((await svc.processToAccounting(up.preRegistration, f.userId)).bill as { id: string }).id;

  const manual = await createBill({
    entity_id: f.entityId, vendor_id: vendorId, created_by: f.userId, bill_date: '2026-10-10', due_date: '2026-11-09',
    currency_code: 'MXN', lines: [{ account_id: expense, unit_price: '1000' }],
  });
  bills.g3 = manual.id;
  await approveBill(manual.id, f.userId, { entityId: f.entityId });
  await query(`UPDATE bills SET tax_amount = 160 WHERE id = $1 AND entity_id = $2`, [manual.id, f.entityId]);

  await pay(bills.t1, '1460.00', '2026-03-20');
  await pay(bills.t3, '730.00', '2026-04-20');
  await pay(bills.t3, '730.00', '2026-05-20');
  await pay(bills.g1, '1460.00', '2026-08-20');
  await pay(bills.g2, '1460.00', '2026-09-20');
  await pay(bills.g3, '1000.00', '2026-10-20');

  for (const m of [3, 4, 5, 6, 8, 9, 10]) diots[m] = await diot(m);
  workpaper = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 3 });
  await query(
    `UPDATE bill_lines SET tax_amount = 100 WHERE bill_id = $1 AND tax_amount = 160
       AND bill_id IN (SELECT id FROM bills WHERE entity_id = $2)`, [bills.g2, f.entityId]
  );
  diots.tampered = await diot(9);
}, 300_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a `poliza` bill is split by rate as its CFDI states', () => {
  it('T1 · PUE paid in March: 1,000.00 and 160.00 at 16 %, 300.00 exempt, no DIOT-IVA-CABECERA', () => {
    expect(declared(diots[3], bills.t1)).toEqual(SPLIT);
  });

  it('T2 · the March workpaper credits 160.00 at 16 % and carries a settlement', () => {
    expect(workpaper.figures.creditable.tasa16).toEqual(box('1000.0000', '160.0000'));
    expect(workpaper.figures.creditable.exento).toEqual(box('300.0000'));
    expect(workpaper.blockedBy).toEqual([]);
    expect(workpaper.settlement).not.toBeNull();
  });

  it('T3 · PPD paid in two halves: each month declares 500.00 and 80.00 at 16 % and 150.00 exempt', () => {
    const half = { ...SPLIT, tasa16: box('500.0000', '80.0000'), exento: box('150.0000') };
    expect(declared(diots[4], bills.t3)).toEqual(half);
    expect(declared(diots[5], bills.t3)).toEqual(half);
  });

  it('T4 · one concept coded to two accounts: the split is the CFDI\'s, 1,000.00 and 160.00 at 16 %', () => {
    expect(declared(diots[6], bills.t4)).toEqual({ ...SPLIT, exento: box('0.0000') });
  });

  it('T5 · nothing was rewritten: the stored line of T1 still has no VAT', async () => {
    expect(await lineTaxes(bills.t1)).toEqual(['0.0000']);
  });
});

describe('guards: lines that carry their VAT are read as before', () => {
  it('G1 · `conceptos_cfdi`: each line keeps its concept\'s VAT and the DIOT says the same', async () => {
    expect(await lineTaxes(bills.g1)).toEqual(['160.0000', '0.0000']);
    expect(declared(diots[8], bills.g1)).toEqual(SPLIT);
  });

  it('G2 · the inbox door: its lines carry the VAT and the DIOT says the same', () => {
    expect(declared(diots[9], bills.g2)).toEqual(SPLIT);
  });

  it('G3 · a `bill create` bill whose header differs from its lines still blocks', () => {
    expect(declared(diots[10], bills.g3).codes).toEqual(['DIOT-IVA-CABECERA']);
  });

  it('G4 · a bill whose lines carry a VAT that differs from the header still blocks, although it has a CFDI', async () => {
    expect(await lineTaxes(bills.g2)).toEqual(['100.0000', '0.0000']);
    expect(declared(diots.tampered, bills.g2).codes).toEqual(['DIOT-IVA-CABECERA']);
  });
});
