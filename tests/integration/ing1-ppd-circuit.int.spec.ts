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
// ING-1 · #318 PR3 (MNE-001-117) — THE PPD CIRCUIT, END TO END, ON ONE
// FRESH ENTITY.
//
// ing1-draft-becomes-bill covers each step against a shared entity, so it can
// only assert deltas. Here one entity sees exactly one received PPD CFDI, and
// the whole ledger is checked against figures worked out by hand:
//
//   CFDI    subtotal 8000, VAT 16 % 1280, total 9280, PPD
//   model   proposes 6100 8080 / 1135 1200 / 2110 9280 (VAT wrong)
//   review  approval refused by the CFDI reconciliation; nothing posts
//           reviewer corrects to 6100 8000 / 1135 1280 / 2110 9280
//   REP     pays 9280: 2110 debit 9280 / bank credit 9280,
//           and the parked VAT moves 1135 credit 1280 / 1130 debit 1280
//   ledger  6100 +8000, 1130 +1280, 1135 0, 2110 0, bank -9280
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const VENDOR_RFC = 'SIN060101AB1';

const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};

/** What the model proposes: balanced, but its VAT is not the CFDI's. */
const PROPOSED: DraftLine[] = [
  { account_code: '6100', debit: 8080, description: 'Consultoria agosto' },
  { account_code: '1135', debit: 1200 },
  { account_code: '2110', credit: 9280 },
];
/** What the reviewer approves after the refusal. */
const CORRECTED: DraftLine[] = [
  { account_code: '6100', debit: 8000, description: 'Consultoria agosto' },
  { account_code: '1135', debit: 1280 },
  { account_code: '2110', credit: 9280 },
];

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

/** Ingests the CFDI; the fake model drafts `lines` through the real tool and closes the turn. */
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
                entry_date: '2026-08-20', description: 'Servicios Integrales B2001', reference: 'B2001',
                confidence: 0.9, reasoning: 'Consulting expense on credit', lines,
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

/** Every account of the entity with a non-zero balance over the year, debit positive. */
async function ledger(): Promise<Record<string, string>> {
  const rows = (await query<{ code: string; s: string }>(
    `SELECT a.code, SUM(ab.debit_total - ab.credit_total)::numeric(18,2)::text AS s
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE a.entity_id = $1
      GROUP BY a.code
     HAVING SUM(ab.debit_total - ab.credit_total) <> 0`,
    [f.entityId]
  )).rows;
  return Object.fromEntries(rows.map((r) => [r.code, r.s]));
}

async function billOf(uuid: string) {
  return (await query<{ id: string; status: string; amount_due: string; journal_entry_id: string | null }>(
    `SELECT id, status, amount_due::text, journal_entry_id FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows;
}

beforeAll(async () => {
  f = await crearInquilino('ING-1 PPD circuit');
  ctx = {
    entityId: f.entityId, entityName: 'ING-1 circuit', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing1-circuit-'));
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-CIRCUIT', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, VENDOR_RFC, f.userId]
  );
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-1 · the received PPD circuit, end to end', () => {
  it('ingest, refused draft, corrected approval, bill, REP: the ledger ends at the hand-worked figures', async () => {
    const uuid = uuidv4().toUpperCase();
    const draftId = await ingest(FIXTURE.replace(FIXTURE_UUID, uuid), PROPOSED);
    const draft = (await getDraft(ctx, draftId))!;
    expect(draft.origin?.cfdi_uuid).toBe(uuid);
    const shown = canonicalDraftHash(draft.payload, draft.origin);

    // 1. The model's VAT is not the CFDI's: the approval is refused and nothing is written.
    await expect(approveDraft(ctx, draftId, reviewer, undefined, shown)).rejects.toThrow(
      /transferred VAT is 1200\.00 in the entry and 1280\.00 in the CFDI/
    );
    expect(await billOf(uuid)).toEqual([]);
    expect(await ledger()).toEqual({});

    // 2. The reviewer corrects and approves: the bill is born and the entry posts as the bill.
    const posted = await approveDraft(ctx, draftId, reviewer, undefined, shown, {
      payload: { ...draft.payload, lines: CORRECTED },
      basedOnHash: shown,
    });
    const [bill] = await billOf(uuid);
    expect(bill).toMatchObject({ status: 'posted', amount_due: '9280.0000', journal_entry_id: posted.entryId });
    const source = (await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM journal_entries WHERE id = $1`, [posted.entryId]
    )).rows[0];
    expect(source).toEqual({ source_type: 'bill', source_id: bill.id });
    expect(await ledger()).toEqual({ '6100': '8000.00', '1135': '1280.00', '2110': '-9280.00' });

    // 3. The vendor's REP pays the bill and releases the parked VAT.
    const svc = new PreRegistrationService();
    const rep = await svc.processXMLUpload(
      f.entityId,
      repXml({ cfdiUuid: uuid, total: '9280.00', iva: 1280 }, uuidv4().toUpperCase(), {
        issuerRfc: VENDOR_RFC, issuerName: 'Servicios Integrales SA', date: new Date(Date.UTC(2026, 7, 25)),
      }),
      'manual_upload', f.userId
    );
    const linked = await svc.processToAccounting(rep.preRegistration, f.userId);
    expect(linked.paymentId).toBeTruthy();

    const [paid] = await billOf(uuid);
    expect(paid).toMatchObject({ status: 'paid', amount_due: '0.0000' });
    const bank = (await query<{ code: string }>(
      `SELECT a.code FROM account_roles r JOIN accounts a ON a.id = r.account_id
        WHERE r.entity_id = $1 AND r.role = 'banco' AND r.qualifier IS NULL`,
      [f.entityId]
    )).rows[0].code;
    expect(await ledger()).toEqual({ '6100': '8000.00', '1130': '1280.00', [bank]: '-9280.00' });
  });
});
