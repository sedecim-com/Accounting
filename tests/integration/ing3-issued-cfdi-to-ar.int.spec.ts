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
import { actoresPorInquilino, addMissingRoles, censusMissingRole } from '../../src/services/accounting/account-roles-backfill.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { repXml } from './helpers/rep-xml.js';
import { reprocesarREPsAparcados } from '../../src/services/xml-ingestion/rep-pendientes.js';
import { issuedIepsSale, issuedIshSale } from './helpers/issued-cfdi-xml.js';
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
function issued(
  o: { method?: string | null; customerRfc?: string; customerName?: string; ownRfc?: string } = {}
): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  const xml = FIXTURE.replace(FIXTURE_UUID, uuid)
    .replace(`<cfdi:Emisor Rfc="${CUSTOMER_RFC}"`, `<cfdi:Emisor Rfc="${o.ownRfc ?? OWN_RFC}"`)
    .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${o.customerRfc ?? CUSTOMER_RFC}"`)
    .replace(' Nombre="Demo Corp MX"', ` Nombre="${o.customerName ?? 'Demo Corp MX'}"`)
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

// MNE-001-521 (#669): IEPS (2180) and local taxes (2190) are roles of the
// receivables core, each checked against the CFDI, and no longer revenue.
// MNE-001-505 (#699): a PPD sale's IEPS is caused on collection (LIEPS art.
// 10), so it parks in 2181, the seeded `ieps_trasladado_no_cobrado`, and each
// collection moves its share to 2180. Figures by hand. ISH sale: 1,000.00 +
// VAT 160.00 + ISH 30.00 = 1,190.00. IEPS sale: 1,000.00 + IEPS 80.00 + VAT
// 172.80 (16 % of 1,080.00) = 1,252.80; with the local tax of 30.00 as well,
// 1,282.80.
describe('an issued CFDI with IEPS or a local tax reaches receivables, each tax on its own role', () => {
  const who = { ownRfc: OWN_RFC, customerRfc: CUSTOMER_RFC };
  const dr = (account_code: string, debit: number): DraftLine => ({ account_code, debit });
  const cr = (account_code: string, credit: number): DraftLine => ({ account_code, credit });
  const ishSale = (vat: string) => [dr('1120', 1190), cr('4100', 1000), cr(vat, 160), cr('2190', 30)];
  // The IEPS goes where the VAT does: 2180 beside 2120 (PUE), 2181 beside 2125 (PPD).
  const iepsOf = (vat: string) => (vat === '2125' ? '2181' : '2180');
  const iepsSale = (vat: string, ieps = iepsOf(vat)) => [dr('1120', 1252.8), cr('4100', 1000), cr(ieps, 80), cr(vat, 172.8)];
  const bothSale = (vat: string) => [dr('1120', 1282.8), cr('4100', 1000), cr(iepsOf(vat), 80), cr(vat, 172.8), cr('2190', 30)];
  const IEPS_WITHOUT_ROLE = /PPD sale.*IEPS \(80\.00\).*ieps_trasladado_no_cobrado \(2181\).*npm run backfill:account-roles -- --aplicar/;

  /** The posted credit balance of each code, at 4 dp. */
  async function credits(...codes: string[]): Promise<Record<string, string>> {
    const r = await query<{ code: string; b: string }>(
      `SELECT a.code, COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::numeric(18,4)::text AS b
         FROM accounts a
         LEFT JOIN journal_entry_lines l ON l.account_id = a.id
          AND l.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1 AND status = 'posted')
        WHERE a.entity_id = $1 AND a.code = ANY($2::text[]) GROUP BY a.code`,
      [f.entityId, codes]
    );
    return Object.fromEntries(codes.map((c) => [c, r.rows.find((x) => x.code === c)?.b ?? 'missing']));
  }
  const minus = (after: Record<string, string>, before: Record<string, string>) =>
    Object.fromEntries(Object.keys(after).map((k) => [k, (Number(after[k]) - Number(before[k])).toFixed(4)]));

  beforeAll(() => useNewTenant('MNE-001-521 issued CFDI with IEPS or a local tax'));

  /** The invoice of a CFDI with its revenue lines, and the entry it posted as. */
  async function born(uuid: string) {
    const invoice = (await query<{ id: string; status: string; amount_due: string; tax_amount: string; journal_entry_id: string }>(
      `SELECT id, status, amount_due::text, tax_amount::text, journal_entry_id FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, uuid]
    )).rows[0];
    const lines = await query<{ line: string }>(
      `SELECT a.code || ' ' || l.line_amount::text AS line FROM invoice_lines l JOIN accounts a ON a.id = l.revenue_account_id
        WHERE l.invoice_id = $1 ORDER BY l.line_number`,
      [invoice.id]
    );
    const entry = await query<{ line: string }>(
      `SELECT (CASE WHEN l.debit_amount IS NULL THEN 'CR ' ELSE 'DR ' END) || a.code || ' ' ||
              to_char(COALESCE(l.debit_amount, l.credit_amount), 'FM9999990.00') AS line
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
      [invoice.journal_entry_id]
    );
    return { ...invoice, lines: lines.rows.map((l) => l.line), entry: entry.rows.map((l) => l.line) };
  }

  const written = async () => (await query<{ invoices: number; entries: number }>(
    `SELECT (SELECT count(*) FROM invoices WHERE entity_id = $1)::int AS invoices,
            (SELECT count(*) FROM journal_entries WHERE entity_id = $1)::int AS entries`,
    [f.entityId]
  )).rows[0];

  /** Approves the draft of `lines`, expects a refusal that wrote nothing, and returns it. */
  async function refused(sale: { xml: string; uuid: string }, lines: DraftLine[]): Promise<Error & { code?: string }> {
    const draftId = await ingest(sale.xml, lines);
    const before = await written();
    const refusal = await approve(draftId).then(() => new Error('the draft was approved'), (e: Error) => e);
    expect(await written()).toEqual(before);
    expect(await invoicesOf(sale.uuid)).toHaveLength(0);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
    return refusal;
  }

  it('T1 · ISH on a PUE sale: born sent with 1,190.00 due, tax_amount the VAT alone, one line of 1,000.00 on 4100', async () => {
    const { xml, uuid } = issuedIshSale(who);
    const posted = await approve(await ingest(xml, ishSale('2120')));
    expect(await born(uuid)).toMatchObject({
      status: 'sent', amount_due: '1190.0000', tax_amount: '160.0000', journal_entry_id: posted.entryId,
      lines: ['4100 1000.0000'], entry: ['DR 1120 1190.00', 'CR 4100 1000.00', 'CR 2120 160.00', 'CR 2190 30.00'],
    });
  });

  it('T2 · ISH on a PPD sale: the REP of 1,190.00 pays it, moves exactly 160.00 from 2125 to 2120, and 2190 keeps its 30.00', async () => {
    const before = (await written()).entries;
    const { xml, uuid } = issuedIshSale({ ...who, method: 'PPD' });
    const posted = await approve(await ingest(xml, ishSale('2125')));
    expect(await born(uuid)).toMatchObject({ status: 'sent', amount_due: '1190.0000', tax_amount: '160.0000', lines: ['4100 1000.0000'] });
    expect((await written()).entries).toBe(before + 1);

    const balances = async () => Promise.all(['2125', '2120', '2190'].map((code) => balanceOf(code, posted.entryId)));
    const [parked, due, local] = await balances();
    const svc = new PreRegistrationService();
    const rep = await svc.processXMLUpload(
      f.entityId,
      repXml({ cfdiUuid: uuid, total: '1190.00', iva: 160 }, uuidv4().toUpperCase(), {
        issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: CUSTOMER_RFC, date: new Date(Date.UTC(2026, 7, 25)),
      }),
      'manual_upload', f.userId
    );
    expect((await svc.processToAccounting(rep.preRegistration, f.userId)).paymentId).toBeTruthy();

    expect(await born(uuid)).toMatchObject({ status: 'paid', amount_due: '0.0000' });
    // Credit balances are negative: releasing the parked VAT raises 2125 and lowers 2120.
    const after = await balances();
    expect(after[0]).toBeCloseTo(parked + 160, 2);
    expect(after[1]).toBeCloseTo(due - 160, 2);
    expect(after[2]).toBeCloseTo(local, 2);
  });

  it('T3 · IEPS on a PUE sale: 80.00 on 2180, born sent with 1,252.80 due and tax_amount 172.80', async () => {
    const { xml, uuid } = issuedIepsSale(who);
    await approve(await ingest(xml, iepsSale('2120')));
    expect(await born(uuid)).toMatchObject({
      status: 'sent', amount_due: '1252.8000', tax_amount: '172.8000', lines: ['4100 1000.0000'],
      entry: ['DR 1120 1252.80', 'CR 4100 1000.00', 'CR 2180 80.00', 'CR 2120 172.80'],
    });
  });

  it('T4 · IEPS on a PPD sale parks in 2181: born sent with 1,252.80 due and tax_amount 172.80; two receipts of 626.40 move 86.40 and 40.00 each', async () => {
    const { xml, uuid } = issuedIepsSale({ ...who, method: 'PPD' });
    await approve(await ingest(xml, iepsSale('2125')));
    const inv = await born(uuid);
    expect(inv).toMatchObject({
      status: 'sent', amount_due: '1252.8000', tax_amount: '172.8000', lines: ['4100 1000.0000'],
      entry: ['DR 1120 1252.80', 'CR 4100 1000.00', 'CR 2181 80.00', 'CR 2125 172.80'],
    });

    const before = await credits('2120', '2125', '2180', '2181');
    const customer = (await query<{ customer_id: string }>(`SELECT customer_id FROM invoices WHERE id = $1`, [inv.id])).rows[0].customer_id;
    const collect = () => recordCustomerPayment({
      entityId: f.entityId, counterpartyId: customer, paymentAmount: '626.40', paymentDate: '2026-08-25',
      paymentMethod: 'spei', applications: [{ documentId: inv.id, amountApplied: '626.40' }],
    }, f.userId);
    await collect();
    expect(minus(await credits('2120', '2125', '2180', '2181'), before))
      .toEqual({ '2120': '86.4000', '2125': '-86.4000', '2180': '40.0000', '2181': '-40.0000' });
    await collect();
    expect(minus(await credits('2120', '2125', '2180', '2181'), before))
      .toEqual({ '2120': '172.8000', '2125': '-172.8000', '2180': '80.0000', '2181': '-80.0000' });
    expect(await born(uuid)).toMatchObject({ status: 'paid', amount_due: '0.0000' });
  });

  it('T4b · its issued REP of 1,252.80 settles it and moves the whole 80.00 from 2181 to 2180', async () => {
    const { xml, uuid } = issuedIepsSale({ ...who, method: 'PPD' });
    await approve(await ingest(xml, iepsSale('2125')));
    const before = await credits('2120', '2125', '2180', '2181');
    const svc = new PreRegistrationService();
    const rep = await svc.processXMLUpload(
      f.entityId,
      repXml({ cfdiUuid: uuid, total: '1252.80', iva: 172.8 }, uuidv4().toUpperCase(), {
        issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: CUSTOMER_RFC, date: new Date(Date.UTC(2026, 7, 25)),
      }),
      'manual_upload', f.userId
    );
    expect((await svc.processToAccounting(rep.preRegistration, f.userId)).paymentId).toBeTruthy();
    expect(await born(uuid)).toMatchObject({ status: 'paid', amount_due: '0.0000' });
    expect(minus(await credits('2120', '2125', '2180', '2181'), before))
      .toEqual({ '2120': '172.8000', '2125': '-172.8000', '2180': '80.0000', '2181': '-80.0000' });
  });

  it('T4c · a PPD whose 80.00 sits on 2180 or in revenue fails CFDI_RECONCILIATION_FAILED on the IEPS figure; a PUE on 2181 too', async () => {
    const onDue = await refused(issuedIepsSale({ ...who, method: 'PPD' }), iepsSale('2125', '2180'));
    expect(onDue).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect(onDue.message).toMatch(/transferred IEPS \(ieps_trasladado_no_cobrado\) is 0\.00 in the entry and 80\.00 in the CFDI/);

    const inRevenue = await refused(issuedIepsSale({ ...who, method: 'PPD' }), [dr('1120', 1252.8), cr('4100', 1080), cr('2125', 172.8)]);
    expect(inRevenue).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect(inRevenue.message).toMatch(/transferred IEPS \(ieps_trasladado_no_cobrado\) is 0\.00 in the entry and 80\.00 in the CFDI/);

    const pueParked = await refused(issuedIepsSale(who), iepsSale('2120', '2181'));
    expect(pueParked.message).toMatch(/transferred IEPS \(ieps_por_pagar\) is 0\.00 in the entry and 80\.00 in the CFDI/);
  });

  it('T4d · an entity seeded before the role refuses a PPD with IEPS naming the backfill, and posts it once the backfill ran', async () => {
    await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = 'ieps_trasladado_no_cobrado'`, [f.entityId]);
    const sale = issuedIepsSale({ ...who, method: 'PPD' });
    const refusal = await refused(sale, iepsSale('2125', '2180'));
    expect(refusal.message).toMatch(IEPS_WITHOUT_ROLE);

    // Collections post as today in between: a PPD with no IEPS moves its VAT alone.
    const plain = issued();
    await approve(await ingest(plain.xml, PPD_SALE));
    const [inv] = await invoicesOf(plain.uuid);
    const before = await credits('2120', '2125', '2180');
    const customer = (await query<{ customer_id: string }>(`SELECT customer_id FROM invoices WHERE id = $1`, [inv.id])).rows[0].customer_id;
    await recordCustomerPayment({
      entityId: f.entityId, counterpartyId: customer, paymentAmount: '9280.00', paymentDate: '2026-08-25',
      paymentMethod: 'spei', applications: [{ documentId: inv.id, amountApplied: '9280.00' }],
    }, f.userId);
    expect(minus(await credits('2120', '2125', '2180'), before)).toEqual({ '2120': '1280.0000', '2125': '-1280.0000', '2180': '0.0000' });

    const census = await censusMissingRole('ieps_trasladado_no_cobrado', f.tenantId);
    expect(census.missing.map((m) => [m.entityId, m.code, m.create])).toEqual([[f.entityId, '2181', undefined]]);
    expect(await addMissingRoles(census.missing, await actoresPorInquilino([f.tenantId]))).toEqual({ added: 1, failures: [] });

    const again = issuedIepsSale({ ...who, method: 'PPD' });
    await approve(await ingest(again.xml, iepsSale('2125')));
    expect((await born(again.uuid)).entry).toEqual(['DR 1120 1252.80', 'CR 4100 1000.00', 'CR 2181 80.00', 'CR 2125 172.80']);
  });

  it('T5 · a tax off its role by more than the tolerance, or left in revenue, is refused by figure', async () => {
    const off = await refused(issuedIshSale(who), [dr('1120', 1190), cr('4100', 1000.02), cr('2120', 160), cr('2190', 29.98)]);
    expect(off).toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
    expect(off.message).toMatch(/transferred local taxes \(impuestos_locales_por_pagar\) is 29\.98 in the entry and 30\.00 in the CFDI/);

    const inRevenue = await refused(issuedIshSale({ ...who, method: 'PPD' }), [dr('1120', 1190), cr('4100', 1030), cr('2125', 160)]);
    expect(inRevenue.message).toMatch(/transferred local taxes \(impuestos_locales_por_pagar\) is 0\.00 in the entry and 30\.00 in the CFDI/);
    expect(inRevenue.message).toMatch(/subtotal minus discount \(non-tax credits\) is 1030\.00 in the entry and 1000\.00 in the CFDI/);

    const ieps = await refused(issuedIepsSale(who), [dr('1120', 1252.8), cr('4100', 1080), cr('2120', 172.8)]);
    expect(ieps.message).toMatch(/transferred IEPS \(ieps_por_pagar\) is 0\.00 in the entry and 80\.00 in the CFDI/);
  });

  it('T6 · IEPS by quota, both taxes on one CFDI, and IEPS with no MetodoPago: PUE on 2180, PPD on 2181', async () => {
    const quota = issuedIepsSale({ ...who, quota: true });
    expect(quota.xml).toMatch(/TipoFactor="Cuota"/);
    await approve(await ingest(quota.xml, iepsSale('2120')));
    expect((await born(quota.uuid)).entry).toContain('CR 2180 80.00');
    const quotaPpd = issuedIepsSale({ ...who, quota: true, method: 'PPD' });
    await approve(await ingest(quotaPpd.xml, iepsSale('2125')));
    expect((await born(quotaPpd.uuid)).entry).toContain('CR 2181 80.00');

    const both = issuedIepsSale({ ...who, localTax: true });
    await approve(await ingest(both.xml, bothSale('2120')));
    expect(await born(both.uuid)).toMatchObject({
      status: 'sent', amount_due: '1282.8000', tax_amount: '172.8000', lines: ['4100 1000.0000'],
      entry: ['DR 1120 1282.80', 'CR 4100 1000.00', 'CR 2180 80.00', 'CR 2120 172.80', 'CR 2190 30.00'],
    });
    const bothPpd = issuedIepsSale({ ...who, localTax: true, method: 'PPD' });
    await approve(await ingest(bothPpd.xml, bothSale('2125')));
    expect((await born(bothPpd.uuid)).entry).toEqual(['DR 1120 1282.80', 'CR 4100 1000.00', 'CR 2181 80.00', 'CR 2125 172.80', 'CR 2190 30.00']);

    const noMethod = issuedIepsSale({ ...who, method: null });
    expect(noMethod.xml).not.toMatch(/MetodoPago/);
    await approve(await ingest(noMethod.xml, iepsSale('2120')));
    expect(await born(noMethod.uuid)).toMatchObject({ status: 'sent', amount_due: '1252.8000', tax_amount: '172.8000' });
  });
});

// MNE-001-523 (#671): a generic RFC is shared by every anonymous or foreign
// customer, so it identifies nobody: the sale belongs to the customer the CFDI
// names, and wherever two customers match, nothing posts.
describe('the customer of an issued CFDI: by name under a generic RFC, and never a guess', () => {
  const XEXX = 'XEXX010101000';
  let age = 0;

  /** Customers are born one day apart in the order they are added: «the oldest» is never a tie. */
  async function addCustomer(number: string, name: string, rfc: string, active = true): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code,
         is_active, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6, $7, TIMESTAMPTZ '2026-01-01' + make_interval(days => $8))`,
      [id, f.entityId, number, name, rfc, active, f.userId, age++]
    );
    return id;
  }
  /** The customer number each invoice of the CFDI was filed under, and what it still owes. */
  const filedUnder = async (uuid: string) => (await query<{ customer_number: string; amount_due: string }>(
    `SELECT c.customer_number, i.amount_due::text FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.entity_id = i.entity_id
      WHERE i.entity_id = $1 AND i.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows;
  const written = async () => (await query<{ customers: string; invoices: string; entries: string }>(
    `SELECT (SELECT count(*) FROM customers WHERE entity_id = $1)::text AS customers,
            (SELECT count(*) FROM invoices WHERE entity_id = $1)::text AS invoices,
            (SELECT count(*) FROM journal_entries WHERE entity_id = $1 AND source_type = 'invoice')::text AS entries`,
    [f.entityId]
  )).rows[0];
  /** Approves the sale and expects the refusal: nothing is written and the draft stays pending. */
  async function refused(o: Parameters<typeof issued>[0], refusal: RegExp): Promise<void> {
    const { xml } = issued(o);
    const draftId = await ingest(xml, PPD_SALE);
    const before = await written();
    const error = await approve(draftId).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ValidationError', field: 'customer_id' });
    expect((error as Error).message).toMatch(refusal);
    expect(await written()).toEqual(before);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
  }
  async function sold(o: Parameters<typeof issued>[0], customerNumber: string): Promise<string> {
    const { xml, uuid } = issued(o);
    await approve(await ingest(xml, PPD_SALE));
    expect(await filedUnder(uuid)).toEqual([{ customer_number: customerNumber, amount_due: '9280.0000' }]);
    return uuid;
  }

  describe('a foreign customer, XEXX010101000', () => {
    let acmeId: string;
    beforeAll(async () => {
      await useNewTenant('MNE-001-523 generic RFC, customer by name');
      await addCustomer('C-GLOBEX', 'Globex GmbH', XEXX);
      acmeId = await addCustomer('C-ACME', 'Acme Inc', XEXX);
    });

    it('T1 · the invoice is of the customer the CFDI names, not of the oldest, and its REP collects from that customer', async () => {
      const uuid = await sold({ customerRfc: XEXX, customerName: 'Acme Inc' }, 'C-ACME');
      const svc = new PreRegistrationService();
      const rep = await svc.processXMLUpload(
        f.entityId,
        repXml({ cfdiUuid: uuid, total: '9280.00', iva: 1280 }, uuidv4().toUpperCase(), {
          issuerRfc: OWN_RFC, issuerName: 'Demo Corp MX', receiverRfc: XEXX, date: new Date(Date.UTC(2026, 7, 25)),
        }),
        'manual_upload', f.userId
      );
      const { paymentId } = await svc.processToAccounting(rep.preRegistration, f.userId);
      const payment = (await query<{ customer_id: string; payment_amount: string }>(
        `SELECT customer_id, payment_amount::text FROM customer_payments WHERE id = $1 AND entity_id = $2`,
        [paymentId, f.entityId]
      )).rows[0];
      expect(payment).toEqual({ customer_id: acmeId, payment_amount: '9280.0000' });
      expect(await filedUnder(uuid)).toEqual([{ customer_number: 'C-ACME', amount_due: '0.0000' }]);
    });

    it('T2 · the name compares without case or runs of spaces', () =>
      sold({ customerRfc: XEXX, customerName: 'ACME   inc' }, 'C-ACME'));

    it('T3 · a name nobody carries is refused with the runnable command and the numbers under that RFC; nothing is written', () =>
      refused(
        { customerRfc: XEXX, customerName: 'Initech LLC' },
        /not in this entity's customer catalog.*mnemosine customer create --name 'Initech LLC' --tax-id 'XEXX010101000'.*matched by name.*C-GLOBEX, C-ACME/
      ));

    it('T4 · an archived customer with the right name is taken before an active one with another name', async () => {
      await addCustomer('C-HOOLI', 'Hooli Ltd', XEXX, false);
      await sold({ customerRfc: XEXX, customerName: 'Hooli Ltd' }, 'C-HOOLI');
    });

    it('T8 · the hand door reads the same customer: it calls the same core', async () => {
      const { xml, uuid } = issued({ customerRfc: XEXX, customerName: 'Acme Inc' });
      const file = path.join(dir, `${uuid}.xml`);
      fs.writeFileSync(file, xml);
      await ingestCfdiFiles({
        ctx, reviewer, files: [file], session: null, capture: { drafts: [] },
        thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
      });
      const preRegistrationId = (await query<{ id: string }>(
        `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
          WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
        [f.entityId, uuid]
      )).rows[0].id;
      const ids = new Map((await query<{ code: string; id: string }>(
        `SELECT code, id FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`, [f.entityId, ['1120', '4100', '2125']]
      )).rows.map((a) => [a.code, a.id]));
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const invoice = await registerIssuedInvoice(client, {
          tenantId: f.tenantId, entityId: f.entityId, preRegistrationId, userId: f.userId,
          description: 'Sale B2001', door: 'manual',
          lines: PPD_SALE.map((l) => ({ accountId: ids.get(l.account_code)!, debit: l.debit, credit: l.credit })),
        });
        const born = await client.query<{ customer_id: string }>(
          `SELECT customer_id FROM invoices WHERE id = $1 AND entity_id = $2`, [invoice.invoiceId, f.entityId]
        );
        expect(born.rows).toEqual([{ customer_id: acmeId }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('T7 · two active customers under one real RFC are refused naming both, with the way out', async () => {
      // Dated in January by addCustomer, so it is listed before the tenant's own C-ING3, born today.
      await addCustomer('C-ING3-BIS', 'Servicios Integrales Sucursal', CUSTOMER_RFC);
      await refused({}, /SIN060101AB1.*2 active customers.*: C-ING3-BIS, C-ING3\..*mnemosine customer archive .*nothing was posted/);
    });

    it('T5 · two active customers with the same name are refused naming both numbers; nothing posts', async () => {
      await addCustomer('C-ACME-2', 'ACME Inc', XEXX);
      await refused(
        { customerRfc: XEXX, customerName: 'Acme Inc' },
        /"Acme Inc" \(RFC XEXX010101000\).*2 active customers.*: C-ACME, C-ACME-2\..*nothing was posted/
      );
    });
  });

  describe('T6 · the general public, XAXX010101000', () => {
    const OWN = 'EMP010101AB1';
    const counter = (customerName: string) => ({ ownRfc: OWN, customerRfc: OWN_RFC, customerName });
    beforeAll(async () => {
      // The fixture entity is itself XAXX010101000: it takes a made-up RFC so that it is the issuer and not the receiver.
      await useNewTenant('MNE-001-523 general public, customer by name');
      const moved = await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [OWN, f.entityId, f.tenantId]);
      expect(moved.rowCount).toBe(1);
      ctx.taxId = OWN;
      await addCustomer('C-NORTE', 'Mostrador Norte', OWN_RFC);
      await addCustomer('C-SUR', 'Mostrador Sur', OWN_RFC);
    });

    it('the sale is of the counter the CFDI names', () => sold(counter('Mostrador Sur'), 'C-SUR'));

    it('a counter nobody registered is refused with the command; nothing is written', () =>
      refused(
        counter('Mostrador Centro'),
        /mnemosine customer create --name 'Mostrador Centro' --tax-id 'XAXX010101000'.*matched by name.*C-NORTE, C-SUR/
      ));

    it('two active counters with one name are refused naming both; nothing posts', async () => {
      await addCustomer('C-SUR-2', 'Mostrador  Sur', OWN_RFC);
      await refused(counter('Mostrador Sur'), /2 active customers.*: C-SUR, C-SUR-2\..*nothing was posted/);
    });
  });
});
