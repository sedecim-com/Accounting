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
import { approveDraft, canonicalDraftHash, getDraft, type DraftLine, type Reviewer } from '../../src/ai/draft-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { repXml } from './helpers/rep-xml.js';
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

/** The fixture turned around: the entity issues it to the customer. */
function issued(o: { method?: 'PUE' | 'PPD'; customerRfc?: string } = {}): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  const xml = FIXTURE.replace(FIXTURE_UUID, uuid)
    .replace(`<cfdi:Emisor Rfc="${CUSTOMER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
    .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${o.customerRfc ?? CUSTOMER_RFC}"`)
    .replace('MetodoPago="PPD"', `MetodoPago="${o.method ?? 'PPD'}"`);
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

beforeAll(async () => {
  f = await crearInquilino('ING-3 issued CFDI to AR');
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
});

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
