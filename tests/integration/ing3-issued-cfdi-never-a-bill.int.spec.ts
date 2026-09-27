import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, previewCfdiFiles } from '../../src/ai/ingest-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { approveDraft, canonicalDraftHash, createDraft, getDraft, type Reviewer } from '../../src/ai/draft-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { LlmSession } from '../../src/ai/providers/types.js';

// ============================================================
// ING-3 · #320 (MNE-001-025) — A CFDI THE ENTITY ISSUED NEVER ENTERS AS AN EXPENSE.
//
// Measured before: the entity's own sale sat in `bill inbox list` as «new
// vendor», and the agent was asked to draft it as a received CFDI. All data is
// synthetic: the entity is the generic RFC XAXX010101000, the counterparty a
// made-up RFC and the stranger the SAT test RFC EKU9003173C9.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const OTHER_RFC = 'SIN060101AB1';

/** The fixture with a fresh UUID, issued by the entity, received, or between two strangers. */
function cfdi(kind: 'issued' | 'received' | 'foreign'): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  let xml = FIXTURE.replace(FIXTURE_UUID, uuid);
  if (kind === 'issued') {
    xml = xml
      .replace(`<cfdi:Emisor Rfc="${OTHER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
      .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${OTHER_RFC}"`);
  }
  if (kind === 'foreign') xml = xml.replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, '<cfdi:Receptor Rfc="EKU9003173C9"');
  return { xml, uuid };
}

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

function file(xml: string): string {
  const p = path.join(dir, `${uuidv4()}.xml`);
  fs.writeFileSync(p, xml);
  return p;
}

/** A session that fails the test if the model is ever asked about the CFDI. */
function silentModel(): LlmSession {
  return { label: 'never called', reset: vi.fn(), runTurn: vi.fn(async () => 'should not run') };
}

async function ingestOne(xml: string) {
  const session = silentModel();
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file(xml)],
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
    session, capture: { drafts: [] },
  });
  return { result: report.results[0], session };
}

const billsOf = async (uuid: string) =>
  (await query(`SELECT id FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid])).rows;

/** A pre-registration of an issued CFDI as it was born before the direction existed. */
async function legacyBillRow(): Promise<{ uuid: string; preReg: Record<string, unknown> }> {
  const { xml, uuid } = cfdi('issued');
  const up = await new PreRegistrationService().processXMLUpload(f.entityId, xml, 'api', f.userId);
  const selfVendor = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, 'Demo Corp MX', $4, 'rfc', 'MXN', $5)`,
    [selfVendor, f.entityId, `V-SELF-${uuid.slice(0, 6)}`, OWN_RFC, f.userId]
  );
  const updated = await query<Record<string, unknown>>(
    `UPDATE pre_registrations
        SET document_type = 'bill', vendor_id = $3,
            lines = jsonb_set(lines, '{0,account_id}',
              to_jsonb((SELECT id::text FROM accounts WHERE entity_id = $2 AND code = '6100')))
      WHERE id = $1 AND entity_id = $2 AND status IN ('draft', 'ready') RETURNING *`,
    [up.preRegistration.id, f.entityId, selfVendor]
  );
  expect(updated.rowCount).toBe(1);
  return { uuid, preReg: updated.rows[0] };
}

beforeAll(async () => {
  f = await crearInquilino('ING-3 issued CFDI');
  ctx = {
    entityId: f.entityId, entityName: 'ING-3', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing3-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-3 · the ingest path', () => {
  it('an issued CFDI is registered but never matched as a vendor nor drafted as an expense', async () => {
    const { xml, uuid } = cfdi('issued');
    const { result, session } = await ingestOne(xml);
    expect(result.status, result.detail).toBe('blocked');
    expect(result.detail).toMatch(/Issued by this entity: a sale, not an expense/);
    expect(session.runTurn).not.toHaveBeenCalled();
    expect(await billsOf(uuid)).toHaveLength(0);

    const pre = (await query<{ document_type: string; vendor_id: string | null; is_new_vendor: boolean }>(
      `SELECT p.document_type, p.vendor_id, p.is_new_vendor
         FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
        WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
      [f.entityId, uuid]
    )).rows[0];
    expect(pre).toEqual({ document_type: 'invoice', vendor_id: null, is_new_vendor: false });
  });

  it('a CFDI where the entity is neither issuer nor receiver is refused with its reason, and nothing is written', async () => {
    const { xml, uuid } = cfdi('foreign');
    const { result, session } = await ingestOne(xml);
    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/issued by SIN060101AB1 to EKU9003173C9, and this entity is XAXX010101000/);
    expect(session.runTurn).not.toHaveBeenCalled();
    const docs = await query(`SELECT 1 FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid]);
    expect(docs.rows).toHaveLength(0);
  });

  it('--dry-run shows the direction of each CFDI and refuses the foreign one', async () => {
    const rows = await previewCfdiFiles({
      files: [file(cfdi('issued').xml), file(cfdi('received').xml), file(cfdi('foreign').xml)],
      thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
      entityId: f.entityId,
    });
    expect(rows.map((r) => [r.verdict, r.direction])).toEqual([
      ['would_process', 'issued'], ['would_process', 'received'], ['invalid', 'foreign'],
    ]);
    expect(rows[0].route).toMatch(/never as a vendor bill/);
    expect(rows[2].detail).toMatch(/not a party to the operation/);
  });

  it('`bill inbox run` over a legacy row that says «bill» still refuses the entity\'s own sale', async () => {
    const { uuid, preReg } = await legacyBillRow();
    await expect(new PreRegistrationService().processToAccounting(preReg, f.userId)).rejects.toThrow(
      /issued by the entity itself \(RFC XAXX010101000\)/
    );
    expect(await billsOf(uuid)).toHaveLength(0);
  });
});

describe('ING-3 · the approval path', () => {
  it('approving a draft bound to an issued CFDI is refused and rolled back, even on a legacy «bill» row', async () => {
    const { uuid, preReg } = await legacyBillRow();
    const { id: draftId } = await createDraft(ctx, {
      payload: {
        entry_date: '2026-08-20', description: 'Consultoria B2001', reference: 'B2001',
        lines: [
          { account_code: '6100', debit: 8000 },
          { account_code: '1135', debit: 1280 },
          { account_code: '2110', credit: 9280 },
        ],
      },
      confidence: 0.9, reasoning: 'synthetic', model: 'fake', preRegistrationId: String(preReg.id),
    });
    const entries = async () =>
      Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId])).rows[0].n);
    const before = await entries();
    const d = await getDraft(ctx, draftId);
    await expect(
      approveDraft(ctx, draftId, reviewer, undefined, canonicalDraftHash(d!.payload, d!.origin))
    ).rejects.toThrow(/issued by the entity itself/);
    expect(await entries()).toBe(before);
    expect(await billsOf(uuid)).toHaveLength(0);
    expect((await getDraft(ctx, draftId))!.status).toBe('pending_review');
  });
});
