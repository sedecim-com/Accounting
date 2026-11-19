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
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { applyVendorPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';

// ============================================================
// MNE-001-491 · THE RELEASE, THE DIOT AND THE WORKPAPER ASK WHERE THE VAT SITS
//
// Every bill is the same received CFDI of 1,160.00 (1,000.00 + 160.00),
// approved from its draft; what changes is its method, the account its VAT was
// debited to (1130 creditable, 1135 pending) and what the entry credits.
//
//   G1 · PUE, VAT on 1130, credits the bank: born paid, a March fact
//   G2 · PUE, VAT on 1130, paid 2026-04-08: stays a March fact, releases nothing
//   G3 · PPD, VAT on 1130 (May), paid in June: base declared, VAT 0.00, capped
//   T1 · PUE, VAT on 1135, paid 2026-04-08: releases 160.00, an April fact
//   T2 · the same in July, paid from a payment on account applied afterwards
//        (in its own month: the application's entry is dated the day it runs,
//        not the payment's, so it would break the workpaper's tie of T4)
//   T5 · PUE, VAT on 1130, never paid: the notice names 1130, not the method
//
// T6 (an issued PUE with VAT in 2125 releases nothing on collection) lives in
// tests/accounting/ar-ap-posting-iva.spec.ts: the issued door no longer lets
// that invoice be born.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');
const CONCEPT_VAT = '<cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>';
const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};
type Diot = Awaited<ReturnType<typeof construirDiot>>;

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;
let vendorId: string;
const bills: Record<string, string> = {};
const entries: Record<string, string> = {};
let marchBeforePaying: Diot, march: Diot, april: Diot, june: Diot, july: Diot;
let wpMarch: IvaWorkpaper, wpApril: IvaWorkpaper;

/** The fixture CFDI as a bill of `date`, approved with its VAT on `vat` against `credit`. */
async function bill(method: 'PUE' | 'PPD', vat: '1130' | '1135', date: string, credit = '2110'): Promise<string> {
  const uuid = uuidv4().toUpperCase();
  const number = uuid.slice(0, 8);
  const file = path.join(dir, `${uuid}.xml`);
  fs.writeFileSync(file, FIXTURE
    .replace('D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E', uuid)
    .replace('Folio="1001"', `Folio="${number}"`)
    .replace('MetodoPago="PUE"', `MetodoPago="${method}"`)
    // The fixture states its VAT only in the summary node; the DIOT splits by rate from the concept's.
    .replace('ObjetoImp="02"/>', `ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados>${CONCEPT_VAT}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`)
    .replaceAll('2026-08-15', date));
  const lines = [
    { account_code: '6100', debit: 1000, description: 'Cleaning' },
    { account_code: vat, debit: 160 },
    { account_code: credit, credit: 1160 },
  ];
  const args = { entry_date: date, description: `Bill ${number}`, reference: number, confidence: 0.9, reasoning: 'Expense', lines };
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
    ctx, reviewer, files: [file],
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 100000 },
    session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe('draft');
  const draft = await getDraft(ctx, capture.drafts[0].draftId);
  await approveDraft(ctx, draft!.id, reviewer, undefined, canonicalDraftHash(draft!.payload, draft!.origin));
  return (await query<{ id: string }>(`SELECT id FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid])).rows[0].id;
}

async function pay(billId: string | null, date: string) {
  return recordVendorPayment(
    {
      entityId: f.entityId, counterpartyId: vendorId, paymentAmount: '1160.00', paymentDate: date, paymentMethod: 'spei',
      applications: billId ? [{ documentId: billId, amountApplied: '1160.00' }] : [],
      ...(billId ? {} : { onAccount: true }),
    },
    f.userId
  );
}

/** What an entry moved in 1130 and 1135, as `code debit/credit`. */
async function vatLines(entryId: string): Promise<string[]> {
  const { rows } = await query<{ line: string }>(
    `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::text || '/' || COALESCE(l.credit_amount, 0)::text AS line
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 AND a.code IN ('1130', '1135') ORDER BY a.code`,
    [entryId]
  );
  return rows.map((r) => r.line);
}

const diot = (month: number) => construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month });
const fact = (d: Diot, billId: string) => d.renglones.flatMap((r) => r.documentos).find((doc) => doc.billId === billId);
const declared = (d: Diot, billId: string) => {
  const doc = fact(d, billId);
  return doc && { ...doc.desglose.tasa16 };
};
const codes = (w: IvaWorkpaper) => w.findings.map((h) => h.codigo);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-491 received PUE');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-491', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  // Lines per concept carry their own VAT: this spec guards that value. Under the default (`poliza`)
  // the lines carry none and the DIOT reads the split from the CFDI (MNE-001-563, its own spec).
  await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde', 'conceptos_cfdi', email);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne491-'));
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-491', 'Servicios Integrales SA', 'SIN060101AB1', 'rfc', 'MXN', $3)`,
    [vendorId, f.entityId, f.userId]
  );
  const bank = Object.entries(f.cuentas).find(([, id]) => id === f.roles.banco)![0];

  bills.g1 = await bill('PUE', '1130', '2026-03-12', bank);
  bills.g2 = await bill('PUE', '1130', '2026-03-12');
  bills.t1 = await bill('PUE', '1135', '2026-03-12');
  bills.t2 = await bill('PUE', '1135', '2026-07-12');
  bills.t5 = await bill('PUE', '1130', '2026-03-12');
  bills.g3 = await bill('PPD', '1130', '2026-05-12');
  marchBeforePaying = await diot(3);

  entries.g2 = (await pay(bills.g2, '2026-04-08')).journalEntry!.id;
  entries.t1 = (await pay(bills.t1, '2026-04-08')).journalEntry!.id;
  const onAccount = await pay(null, '2026-07-20');
  const applied = await applyVendorPayment(
    f.entityId, onAccount.paymentId, [{ documentId: bills.t2, amountApplied: '1160.00' }], f.userId
  );
  entries.t2 = applied.journalEntry!.id;
  await pay(bills.g3, '2026-06-08');

  [march, april, june, july] = [await diot(3), await diot(4), await diot(6), await diot(7)];
  wpMarch = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 3 });
  wpApril = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 4 });
}, 300_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('guards: a PUE whose VAT went to 1130 keeps its bill month', () => {
  it('G1 · a PUE draft that credits the bank is born paid, declared in March and not in April', async () => {
    const { rows } = await query<{ status: string; entry: string }>(
      `SELECT status, journal_entry_id::text AS entry FROM bills WHERE id = $1`, [bills.g1]
    );
    expect(rows[0].status).toBe('paid');
    expect(await vatLines(rows[0].entry)).toEqual(['1130 160.0000/0']);
    expect(declared(march, bills.g1)).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(fact(april, bills.g1)).toBeUndefined();
  });

  it('G2 · paid on 2026-04-08 it releases nothing: March keeps it whole and April has no row for it', async () => {
    expect(await vatLines(entries.g2)).toEqual([]);
    expect(declared(march, bills.g2)).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(fact(april, bills.g2)).toBeUndefined();
  });

  it('G3 · a PPD whose VAT went to 1130 declares its base in the payment month, VAT 0.00, and says why', () => {
    expect(declared(june, bills.g3)).toEqual({ base: '1000.0000', iva: '0.0000' });
    expect(june.hallazgos.filter((h) => h.documentId === bills.g3).map((h) => h.codigo)).toContain('DIOT-TOPE-APARCADO');
  });
});

describe('a PUE whose VAT is parked in 1135 follows its payment', () => {
  it('T1 · the vendor payment carries DR 1130 160.00 / CR 1135 160.00 and stores it on the application', async () => {
    expect(await vatLines(entries.t1)).toEqual(['1130 160.0000/0', '1135 0/160.0000']);
    const { rows } = await query<{ released: string | null }>(
      `SELECT iva_reclass_amount::text AS released FROM payment_applications WHERE bill_id = $1`, [bills.t1]
    );
    expect(rows.map((r) => r.released)).toEqual(['160.0000']);
  });

  it('T2 · applying a payment on account releases the same, declared in the payment month', async () => {
    expect(await vatLines(entries.t2)).toEqual(['1130 160.0000/0', '1135 0/160.0000']);
    expect(declared(july, bills.t2)).toEqual({ base: '1000.0000', iva: '160.0000' });
  });

  it('T3 · the DIOT declares it in April and never in March, before or after the payment', () => {
    expect(fact(marchBeforePaying, bills.t1)).toBeUndefined();
    expect(fact(march, bills.t1)).toBeUndefined();
    expect(declared(april, bills.t1)).toEqual({ base: '1000.0000', iva: '160.0000' });
  });

  it('T4 · the workpaper traces it to the entry of its payment, and ties to 1130 both months', () => {
    const contribution = wpApril.contributions.creditable.find((c) => c.entryIds.includes(entries.t1));
    expect(contribution?.entryIds).toEqual([entries.t1]);
    expect(wpMarch.contributions.creditable.flatMap((c) => c.entryIds)).not.toContain(entries.t1);
    expect(wpMarch.ledger.iva_acreditable).toBe('480.0000');
    expect(wpApril.ledger.iva_acreditable).toBe('160.0000');
    expect(codes(wpMarch)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
    expect(codes(wpApril)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
  });
});

describe('an unpaid PUE on 1130', () => {
  it('T5 · DIOT-PUE-SIN-PAGO says its VAT is credited before it is paid, without blaming the method', () => {
    const notice = march.hallazgos.find((h) => h.codigo === 'DIOT-PUE-SIN-PAGO' && h.documentId === bills.t5);
    expect(notice?.mensaje).toMatch(/1130/);
    expect(notice?.mensaje).not.toMatch(/mal capturado/);
    expect(march.hallazgos.filter((h) => h.codigo === 'DIOT-PUE-SIN-PAGO').map((h) => h.documentId)).toEqual([bills.t5]);
  });
});
