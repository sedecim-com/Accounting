import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type OpenAI from 'openai';

import { query, closeDatabase, getClient } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, type DraftCapture } from '../../src/ai/ingest-service.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import { approveDraft, canonicalDraftHash, getDraft, type DraftLine, type Reviewer } from '../../src/ai/draft-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { registerIssuedInvoice } from '../../src/services/xml-ingestion/issued-invoice-approval.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { repXml } from './helpers/rep-xml.js';
import { reprocesarREPsAparcados } from '../../src/services/xml-ingestion/rep-pendientes.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';

// ============================================================
// ING-3 · #320 (MNE-001-028) — ISSUED PUE AND PPD GO TO AR, AND THE ISSUED
// REP SETTLES THE PPD.
//
// Measured before: an issued CFDI stopped at «receivables booking is not
// automated yet»; no draft, no customer invoice, and its REP found nothing to
// settle. Everything runs the real path: ingestCfdiFiles with an
// OpenAI-compatible fake calling the real draft_journal_entry tool, then
// approveDraft with the hash the reviewer saw. Synthetic data only: the entity
// is the generic RFC XAXX010101000 and the customer a made-up RFC.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const CUSTOMER_RFC = 'SIN060101AB1';

const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};

/**
 * The fixture turned around: the entity issues it to the customer. `method` is
 * written as given, so a test can state it in any case; `null` removes the
 * attribute, which is the XML no PAC validated.
 */
function issued(o: { method?: string | null; customerRfc?: string } = {}): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  const xml = FIXTURE.replace(FIXTURE_UUID, uuid)
    .replace(`<cfdi:Emisor Rfc="${CUSTOMER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
    .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${o.customerRfc ?? CUSTOMER_RFC}"`)
    .replace(' MetodoPago="PPD"', o.method === null ? '' : ` MetodoPago="${o.method ?? 'PPD'}"`);
  return { xml, uuid };
}

/** The sale entries an accountant approves for the fixture. */
const PPD_SALE: DraftLine[] = [
  { account_code: '1120', debit: 9280 },
  { account_code: '4100', credit: 8000, description: 'Consultoria agosto' },
  { account_code: '2125', credit: 1280 },
];
const PUE_COLLECTED: DraftLine[] = [
  { account_code: '1111', debit: 9280 },
  { account_code: '4100', credit: 8000 },
  { account_code: '2120', credit: 1280 },
];
const PUE_ON_CREDIT: DraftLine[] = [PPD_SALE[0], PPD_SALE[1], { account_code: '2120', credit: 1280 }];

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

/** Ingests one issued CFDI; the fake model drafts `lines` and closes the turn. */
async function ingest(xml: string, lines: DraftLine[]): Promise<string> {
  const file = path.join(dir, `${uuidv4()}.xml`);
  fs.writeFileSync(file, xml);
  const capture: DraftCapture = { drafts: [] };
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_0', type: 'function',
            function: {
              name: 'draft_journal_entry',
              arguments: JSON.stringify({
                entry_date: '2026-08-20', description: 'Venta B2001', reference: 'B2001',
                confidence: 0.9, reasoning: 'Issued sale', lines,
              }),
            },
          }],
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
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
    session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe('draft');
  return capture.drafts[0].draftId;
}

async function approve(draftId: string) {
  const d = await getDraft(ctx, draftId);
  return approveDraft(ctx, draftId, reviewer, undefined, canonicalDraftHash(d!.payload, d!.origin));
}

async function invoicesOf(uuid: string) {
  return (await query<{ id: string; status: string; amount_due: string; journal_entry_id: string | null }>(
    `SELECT id, status, amount_due::text, journal_entry_id FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows;
}

async function balanceOf(code: string, entryId: string): Promise<number> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(ab.debit_total - ab.credit_total, 0)::text AS s
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE a.entity_id = $1 AND a.code = $2
        AND ab.fiscal_period_id = (SELECT fiscal_period_id FROM journal_entries WHERE id = $3)`,
    [f.entityId, code, entryId]
  );
  return Number(r.rows[0]?.s ?? 0);
}

/** A tenant of its own, with the customer in its catalog; the cases after it run on it. */
async function useNewTenant(name: string): Promise<void> {
  f = await crearInquilino(name);
  ctx = {
    entityId: f.entityId, entityName: 'ING-3 AR', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing3-ar-'));
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'C-ING3', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, CUSTOMER_RFC, f.userId]
  );
}

beforeAll(() => useNewTenant('ING-3 issued CFDI to AR'));

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-3 · S3: approving the draft of an issued CFDI creates the AR invoice', () => {
  it('PPD: the invoice stays open, and the issued REP settles it and moves the VAT from 2125 to 2120', async () => {
    const { xml, uuid } = issued();
    const posted = await approve(await ingest(xml, PPD_SALE));

    const [inv] = await invoicesOf(uuid);
    expect(inv).toMatchObject({ status: 'sent', amount_due: '9280.0000', journal_entry_id: posted.entryId });
    const source = (await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM journal_entries WHERE id = $1`, [posted.entryId]
    )).rows[0];
    expect(source).toEqual({ source_type: 'invoice', source_id: inv.id });
    const pre = (await query<{ status: string; result_type: string; result_id: string }>(
      `SELECT p.status, p.result_type, p.result_id FROM pre_registrations p
         JOIN xml_documents x ON x.id = p.xml_document_id WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
      [f.entityId, uuid]
    )).rows[0];
    expect(pre).toEqual({ status: 'completed', result_type: 'invoice', result_id: inv.id });

    const parkedBefore = await balanceOf('2125', posted.entryId);
    const dueBefore = await balanceOf('2120', posted.entryId);
    const svc = new PreRegistrationService();
    const rep = await svc.processXMLUpload(
      f.entityId,
      repXml({ cfdiUuid: uuid, total: '9280.00', iva: 1280 }, uuidv4().toUpperCase(), {
        issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: CUSTOMER_RFC,
        date: new Date(Date.UTC(2026, 7, 25)),
      }),
      'manual_upload', f.userId
    );
    const linked = await svc.processToAccounting(rep.preRegistration, f.userId);
    expect(linked.paymentId).toBeTruthy();

    const [settled] = await invoicesOf(uuid);
    expect(settled).toMatchObject({ status: 'paid', amount_due: '0.0000' });
    // Credit balances are negative: releasing the parked VAT raises 2125 and lowers 2120.
    expect(await balanceOf('2125', posted.entryId)).toBeCloseTo(parkedBefore + 1280, 2);
    expect(await balanceOf('2120', posted.entryId)).toBeCloseTo(dueBefore - 1280, 2);
  });

  it('PUE collected through the bank: the invoice is born paid', async () => {
    const { xml, uuid } = issued({ method: 'PUE' });
    const posted = await approve(await ingest(xml, PUE_COLLECTED));
    const [inv] = await invoicesOf(uuid);
    expect(inv).toMatchObject({ status: 'paid', amount_due: '0.0000', journal_entry_id: posted.entryId });
  });

  it('an unknown customer is refused with the command to register it; nothing is written', async () => {
    const { xml, uuid } = issued({ customerRfc: 'GAL150623QK8' });
    const draftId = await ingest(xml, PPD_SALE);
    await expect(approve(draftId)).rejects.toThrow(
      /GAL150623QK8.*not in this entity's customer catalog.*mnemosine customer create --name '.*' --tax-id 'GAL150623QK8'/
    );
    expect(await invoicesOf(uuid)).toHaveLength(0);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
  });

  it('a PPD sale whose VAT is not parked in 2125 is refused: the REP could not release it', async () => {
    const { xml, uuid } = issued();
    const draftId = await ingest(xml, [PPD_SALE[0], PPD_SALE[1], { account_code: '2120', credit: 1280 }]);
    await expect(approve(draftId)).rejects.toThrow(/transferred VAT \(iva_trasladado_no_cobrado, parked until the REP\) is 0.00 in the entry and 1280.00 in the CFDI/);
    expect(await invoicesOf(uuid)).toHaveLength(0);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
  });
});

// MNE-001-520 (#668): the approval asks the rule every other reader of the
// ledger asks (decideMetodoPago), so the VAT lands where a collection, a credit
// note and the IVA working paper already expect it.
describe('an issued CFDI with no MetodoPago is a PUE sale', () => {
  let sale: { invoiceId: string; entryId: string };

  // Its own tenant: the working paper of the month must see these sales only.
  beforeAll(() => useNewTenant('MNE-001-520 issued CFDI with no MetodoPago'));

  it('VAT on 2120: the invoice is born sent with the whole total due, and the entry is its own', async () => {
    const { xml, uuid } = issued({ method: null });
    expect(xml).not.toMatch(/MetodoPago/);
    const posted = await approve(await ingest(xml, PUE_ON_CREDIT));

    const [inv] = await invoicesOf(uuid);
    expect(inv).toMatchObject({ status: 'sent', amount_due: '9280.0000', journal_entry_id: posted.entryId });
    const source = (await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM journal_entries WHERE id = $1`, [posted.entryId]
    )).rows[0];
    expect(source).toEqual({ source_type: 'invoice', source_id: inv.id });
    sale = { invoiceId: inv.id, entryId: posted.entryId };
  });

  it('VAT on 2125 is refused, and the refusal says the method was assumed; nothing is written', async () => {
    const { xml, uuid } = issued({ method: null });
    const draftId = await ingest(xml, PPD_SALE);
    const refusal = await approve(draftId).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect((refusal as Error).message).toMatch(
      /transferred VAT \(iva_trasladado; no MetodoPago, read as PUE\) is 0.00 in the entry and 1280.00 in the CFDI/
    );
    expect(await invoicesOf(uuid)).toHaveLength(0);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
  });

  it('a collection of the total pays the invoice and moves neither 2125 nor 2120', async () => {
    const parkedBefore = await balanceOf('2125', sale.entryId);
    const dueBefore = await balanceOf('2120', sale.entryId);
    expect(dueBefore).toBeCloseTo(-1280, 2);

    await recordCustomerPayment(
      {
        entityId: f.entityId, paymentAmount: '9280', paymentDate: '2026-08-25', paymentMethod: 'spei',
        applications: [{ documentId: sale.invoiceId, amountApplied: '9280' }],
      },
      f.userId
    );

    const paid = (await query<{ status: string; amount_due: string }>(
      `SELECT status, amount_due::text FROM invoices WHERE id = $1 AND entity_id = $2`, [sale.invoiceId, f.entityId]
    )).rows[0];
    expect(paid).toEqual({ status: 'paid', amount_due: '0.0000' });
    expect(await balanceOf('2125', sale.entryId)).toBeCloseTo(parkedBefore, 2);
    expect(await balanceOf('2120', sale.entryId)).toBeCloseTo(dueBefore, 2);
  });

  it('a draft that debits the bank is a collected PUE sale: the invoice is born paid', async () => {
    const { xml, uuid } = issued({ method: null });
    const posted = await approve(await ingest(xml, PUE_COLLECTED));
    const [inv] = await invoicesOf(uuid);
    expect(inv).toMatchObject({ status: 'paid', amount_due: '0.0000', journal_entry_id: posted.entryId });
  });

  it('MetodoPago="pue" in lower case is PUE here as it is for every other reader', async () => {
    const { xml, uuid } = issued({ method: 'pue' });
    expect(xml).toMatch(/MetodoPago="pue"/);
    const posted = await approve(await ingest(xml, PUE_ON_CREDIT));
    const [inv] = await invoicesOf(uuid);
    expect(inv).toMatchObject({ status: 'sent', amount_due: '9280.0000', journal_entry_id: posted.entryId });
  });

  it("the month's IVA working paper ties its charged VAT to 2120: the three sales above, no finding", async () => {
    const paper = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8 });
    expect(paper.figures.charged.tasa16).toEqual({ base: '24000.0000', iva: '3840.0000' });
    expect(paper.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  });
});

// MNE-001-454: the receivables core is shared by the draft door and the hand
// door, and one CFDI gives one invoice whichever door wrote the first.
describe('the shared receivables core: one CFDI, one invoice', () => {
  beforeAll(() => useNewTenant('MNE-001-454 shared issued invoice core'));

  it('the draft door refuses a CFDI already on a live invoice, in any letter case, and names it; a void one does not refuse', async () => {
    const { xml, uuid } = issued();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount, amount_due,
         currency_code, invoice_date, due_date, status, cfdi_uuid, created_by)
       SELECT $1, $2, 'INV-OPENING-7', c.id, 8000, 1280, 9280, 9280, 'MXN', '2026-08-20', '2026-08-20', 'sent', $3, $4
         FROM customers c WHERE c.entity_id = $2 AND c.tax_id = $5`,
      [uuidv4(), f.entityId, uuid.toLowerCase(), f.userId, CUSTOMER_RFC]
    );
    const sameCfdi = async () => (await query<{ invoice_number: string }>(
      `SELECT invoice_number FROM invoices WHERE entity_id = $1 AND lower(cfdi_uuid) = lower($2)`, [f.entityId, uuid]
    )).rows;
    const invoiceEntries = async () => Number((await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1 AND source_type = 'invoice'`, [f.entityId]
    )).rows[0].n);
    const before = await invoiceEntries();

    const draftId = await ingest(xml, PPD_SALE);
    const refusal = await approve(draftId).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_ALREADY_INVOICED' });
    expect((refusal as Error).message).toMatch(/INV-OPENING-7.*sent/);
    expect(await sameCfdi()).toEqual([{ invoice_number: 'INV-OPENING-7' }]);
    expect(await invoiceEntries()).toBe(before);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');

    const voided = await query(
      `UPDATE invoices SET status = 'void' WHERE entity_id = $1 AND invoice_number = 'INV-OPENING-7' AND status = 'sent'`,
      [f.entityId]
    );
    expect(voided.rowCount).toBe(1);
    const posted = await approve(draftId);
    expect(await invoicesOf(uuid)).toEqual([expect.objectContaining({ status: 'sent', journal_entry_id: posted.entryId })]);
  });

  it('the hand door calls the core with lines already resolved: a CFDI with no MetodoPago is a PUE sale, born sent', async () => {
    const { xml, uuid } = issued({ method: null });
    const file = path.join(dir, `${uuid}.xml`);
    fs.writeFileSync(file, xml);
    const report = await ingestCfdiFiles({
      ctx, reviewer, files: [file], session: null, capture: { drafts: [] },
      thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
    });
    expect(report.toCode, report.results[0].detail).toBe(1);
    const preRegistrationId = (await query<{ id: string }>(
      `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
        WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
      [f.entityId, uuid]
    )).rows[0].id;
    const ids = new Map((await query<{ code: string; id: string }>(
      `SELECT code, id FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`, [f.entityId, ['1120', '4100', '2120']]
    )).rows.map((a) => [a.code, a.id]));

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const invoice = await registerIssuedInvoice(client, {
        tenantId: f.tenantId, entityId: f.entityId, preRegistrationId, userId: f.userId,
        description: 'Sale B2001', door: 'manual',
        lines: [
          { accountId: ids.get('1120')!, debit: 9280 },
          { accountId: ids.get('4100')!, credit: 8000 },
          { accountId: ids.get('2120')!, credit: 1280 },
        ],
      });
      const born = (await client.query<{ status: string; amount_due: string; cfdi_uuid: string }>(
        `SELECT status, amount_due::text, cfdi_uuid FROM invoices WHERE id = $1 AND entity_id = $2`,
        [invoice.invoiceId, f.entityId]
      )).rows[0];
      expect(born).toEqual({ status: 'sent', amount_due: '9280.0000', cfdi_uuid: uuid });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await invoicesOf(uuid)).toHaveLength(0);
  });
});

// MNE-001-524 (#672): the lookup used to take the oldest invoice with the
// REP's UUID, whatever its status. A void or cancelled invoice holds no
// receivable, so the REP settles the live one, and goes to review by name when
// there is none or more than one.
describe('an issued REP settles the live invoice that carries its UUID, never an annulled one', () => {
  const svc = new PreRegistrationService();
  const REP_DAY = new Date(Date.UTC(2026, 7, 25));
  const SALE = { total: '9280.00', iva: 1280 };
  const POLICY_KEYS = ['rep_pago_no_registrado', 'rep_documento_desconocido', 'rep_voided_document'];

  beforeAll(() => useNewTenant('MNE-001-524 REP settles the live invoice'));

  /** An invoice written straight to the table, as an opening import or a voided one leaves it. */
  async function insertInvoice(number: string, uuid: string, status: string, createdAt = 'NOW()'): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount, amount_due,
         currency_code, invoice_date, due_date, status, cfdi_uuid, created_by, created_at)
       SELECT $1, $2, $3, c.id, 8000, 1280, 9280, 9280, 'MXN', '2026-08-20', '2026-08-20', $4, $5, $6, ${createdAt}
         FROM customers c WHERE c.entity_id = $2 AND c.tax_id = $7`,
      [id, f.entityId, number, status, uuid, f.userId, CUSTOMER_RFC]
    );
    return id;
  }

  async function uploadRep(paid: string, alsoPays?: string) {
    const repUuid = uuidv4().toUpperCase();
    const rep = await svc.processXMLUpload(
      f.entityId,
      repXml({ cfdiUuid: paid, ...SALE }, repUuid, {
        issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: CUSTOMER_RFC, date: REP_DAY,
        alsoPays: alsoPays ? { cfdiUuid: alsoPays, ...SALE } : undefined,
      }),
      'manual_upload', f.userId
    );
    return { repUuid, preRegistration: rep.preRegistration as Record<string, unknown> };
  }

  /** The review a REP is sent to: its reason, read from the refusal. */
  async function reviewOf(preRegistration: Record<string, unknown>): Promise<string> {
    const refusal = await svc.processToAccounting(preRegistration, f.userId).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    return (refusal as Error).message;
  }

  const paymentsLinkedTo = async (repUuid: string) => (await query<{ id: string; payment_amount: string }>(
    `SELECT id, payment_amount::text FROM customer_payments WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, repUuid]
  )).rows;
  const paymentCount = async () => Number((await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM customer_payments WHERE entity_id = $1`, [f.entityId]
  )).rows[0].n);
  const invoiceById = async (id: string) => (await query<{ status: string; amount_due: string }>(
    `SELECT status, amount_due::text FROM invoices WHERE id = $1 AND entity_id = $2`, [id, f.entityId]
  )).rows[0];
  const allocatedTo = async (paymentId: string) => (await query<{ invoice_id: string }>(
    `SELECT invoice_id FROM payment_allocations WHERE payment_id = $1`, [paymentId]
  )).rows.map((a) => a.invoice_id);
  // The entity's own panel rows, answered and reopened in place: a case here answers one key several times.
  async function setPolicy(key: string, value: string): Promise<void> {
    await clearPolicies([key]);
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, key, value, f.userId, 'test');
  }
  const clearPolicies = (keys = POLICY_KEYS) => query(
    `UPDATE policy_decisions SET status = 'pending', resolved_value = NULL
      WHERE tenant_id = $1 AND entity_id = $2 AND key = ANY($3::text[])`,
    [f.tenantId, f.entityId, keys]
  );

  it.each([
    ['a void invoice created first', 'void', `NOW() - interval '1 day'`],
    ['a void invoice created after', 'void', `NOW() + interval '1 day'`],
    ['a cancelled invoice created first', 'cancelled', `NOW() - interval '1 day'`],
  ])('next to %s, the REP pays the live invoice and moves its VAT from 2125 to 2120', async (_case, status, createdAt) => {
    const { xml, uuid } = issued();
    const annulledId = await insertInvoice(`INV-ANNULLED-${uuid.slice(0, 8)}`, uuid, status, createdAt);
    const posted = await approve(await ingest(xml, PPD_SALE));
    const live = (await invoicesOf(uuid)).find((i) => i.id !== annulledId)!;
    const parkedBefore = await balanceOf('2125', posted.entryId);
    const dueBefore = await balanceOf('2120', posted.entryId);

    const rep = await uploadRep(uuid);
    const linked = await svc.processToAccounting(rep.preRegistration, f.userId);

    expect(await allocatedTo(linked.paymentId!)).toEqual([live.id]);
    expect(await invoiceById(live.id)).toEqual({ status: 'paid', amount_due: '0.0000' });
    expect(await invoiceById(annulledId)).toEqual({ status, amount_due: '9280.0000' });
    expect(await balanceOf('2125', posted.entryId)).toBeCloseTo(parkedBefore + 1280, 2);
    expect(await balanceOf('2120', posted.entryId)).toBeCloseTo(dueBefore - 1280, 2);
  });

  // The two cases below share one CFDI: its draft waits while the only invoice with its UUID is void.
  let parked: { uuid: string; draftId: string; voidId: string; collectionId: string; repId: string; repUuid: string };

  it('only a void invoice, with a collection already applied to it: review naming it under every policy; nothing is linked', async () => {
    const { xml, uuid } = issued();
    const draftId = await ingest(xml, PPD_SALE);
    const voidId = await insertInvoice('INV-VOID-ONLY', uuid, 'sent');
    const collection = await recordCustomerPayment(
      {
        entityId: f.entityId, paymentAmount: '9280', paymentDate: '2026-08-25', paymentMethod: 'spei',
        applications: [{ documentId: voidId, amountApplied: '9280' }],
      },
      f.userId
    );
    // What POST /v1/invoices/:id/void leaves: a void invoice that keeps its collection.
    const voided = await query(`UPDATE invoices SET status = 'void' WHERE id = $1 AND entity_id = $2 AND status = 'paid'`, [voidId, f.entityId]);
    expect(voided.rowCount).toBe(1);
    const rep = await uploadRep(uuid);
    parked = { uuid, draftId, voidId, collectionId: collection.paymentId, repId: rep.preRegistration.id as string, repUuid: rep.repUuid };
    const before = await paymentCount();

    try {
      for (const unrecorded of ['crear_pago', 'revision']) {
        for (const unknown of ['esperar', 'postear_sin_iva', 'preguntar']) {
          for (const voidedDocument of ['review', 'post_live_documents']) {
            await setPolicy('rep_pago_no_registrado', unrecorded);
            await setPolicy('rep_documento_desconocido', unknown);
            await setPolicy('rep_voided_document', voidedDocument);
            const reason = await reviewOf(rep.preRegistration);
            expect(reason, `${unrecorded}/${unknown}/${voidedDocument}`).toMatch(/INV-VOID-ONLY \(void\)/);
          }
        }
      }
    } finally {
      await clearPolicies();
    }
    expect(await paymentsLinkedTo(rep.repUuid)).toEqual([]);
    expect(await paymentCount()).toBe(before);
    const old = (await query<{ cfdi_uuid: string | null }>(
      `SELECT cfdi_uuid FROM customer_payments WHERE id = $1 AND entity_id = $2`, [collection.paymentId, f.entityId]
    )).rows[0];
    expect(old.cfdi_uuid).toBeNull();
  });

  it('the way out: once the draft of that CFDI is approved, rep reconcile links the REP to the live invoice', async () => {
    await approve(parked.draftId);
    const live = (await invoicesOf(parked.uuid)).find((i) => i.id !== parked.voidId)!;

    const retried = await reprocesarREPsAparcados(f.entityId, f.userId, { service: svc });
    expect(retried.detalles).toContainEqual({ id: parked.repId, resultado: 'ligado' });

    const [payment] = await paymentsLinkedTo(parked.repUuid);
    expect(payment.id).not.toBe(parked.collectionId);
    expect(await allocatedTo(payment.id)).toEqual([live.id]);
    expect(await invoiceById(live.id)).toEqual({ status: 'paid', amount_due: '0.0000' });
  });

  it('two live invoices with the UUID: review naming both, and no payment', async () => {
    const { xml, uuid } = issued();
    await approve(await ingest(xml, PPD_SALE));
    const [first] = (await query<{ invoice_number: string }>(
      `SELECT invoice_number FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid]
    )).rows;
    await insertInvoice('INV-TWIN', uuid, 'sent');
    const before = await paymentCount();

    const rep = await uploadRep(uuid);
    const reason = await reviewOf(rep.preRegistration);

    expect(reason).toContain(first.invoice_number);
    expect(reason).toContain('INV-TWIN');
    expect(await paymentCount()).toBe(before);
    expect((await invoicesOf(uuid)).map((i) => i.status)).toEqual(['sent', 'sent']);
  });

  it('one payment for a void invoice and a live one: review by default; post_live_documents collects the live one and keeps a warning', async () => {
    const { xml, uuid: liveUuid } = issued();
    const posted = await approve(await ingest(xml, PPD_SALE));
    const [live] = await invoicesOf(liveUuid);
    const voidUuid = uuidv4().toUpperCase();
    const voidId = await insertInvoice('INV-VOID-SHARED', voidUuid, 'void');
    const rep = await uploadRep(voidUuid, liveUuid);
    const before = await paymentCount();
    const parkedBefore = await balanceOf('2125', posted.entryId);
    const dueBefore = await balanceOf('2120', posted.entryId);

    try {
      for (const unknown of ['esperar', 'postear_sin_iva', 'preguntar']) {
        await setPolicy('rep_documento_desconocido', unknown);
        expect(await reviewOf(rep.preRegistration), unknown).toMatch(/INV-VOID-SHARED \(void\)/);
      }
      expect(await paymentCount()).toBe(before);
      expect(await invoiceById(live.id)).toEqual({ status: 'sent', amount_due: '9280.0000' });
      await clearPolicies();

      // The REP already holds a warning: the new one is appended, not written over it.
      await query(
        `UPDATE pre_registrations SET validation_warnings = '["earlier warning"]'::jsonb WHERE id = $1 AND entity_id = $2`,
        [rep.preRegistration.id, f.entityId]
      );
      await setPolicy('rep_voided_document', 'post_live_documents');
      const linked = await svc.processToAccounting(rep.preRegistration, f.userId);

      expect(await paymentsLinkedTo(rep.repUuid)).toEqual([{ id: linked.paymentId, payment_amount: '9280.0000' }]);
      expect(await allocatedTo(linked.paymentId!)).toEqual([live.id]);
      expect(await paymentCount()).toBe(before + 1);
    } finally {
      await clearPolicies();
    }
    expect(await invoiceById(live.id)).toEqual({ status: 'paid', amount_due: '0.0000' });
    expect(await invoiceById(voidId)).toEqual({ status: 'void', amount_due: '9280.0000' });
    expect(await balanceOf('2125', posted.entryId)).toBeCloseTo(parkedBefore + 1280, 2);
    expect(await balanceOf('2120', posted.entryId)).toBeCloseTo(dueBefore - 1280, 2);
    const saved = (await query<{ status: string; validation_status: string; validation_warnings: string[] }>(
      `SELECT status, validation_status, validation_warnings FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
      [rep.preRegistration.id, f.entityId]
    )).rows[0];
    expect(saved).toMatchObject({ status: 'completed', validation_status: 'warnings' });
    expect(saved.validation_warnings).toEqual(['earlier warning', expect.stringMatching(/INV-VOID-SHARED \(void\)/)]);
  });

  it('the REP writes the UUID in lower case and the invoice holds it in upper case: it links', async () => {
    const { xml, uuid } = issued();
    await approve(await ingest(xml, PPD_SALE));
    const [live] = await invoicesOf(uuid);

    const rep = await uploadRep(uuid.toLowerCase());
    const linked = await svc.processToAccounting(rep.preRegistration, f.userId);

    expect(await allocatedTo(linked.paymentId!)).toEqual([live.id]);
    expect(await invoiceById(live.id)).toEqual({ status: 'paid', amount_due: '0.0000' });
  });
});
