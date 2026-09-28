import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles } from '../../src/ai/ingest-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import type { Reviewer } from '../../src/ai/draft-service.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { LlmSession } from '../../src/ai/providers/types.js';

// ============================================================
// ING-2 · #319 (MNE-001-029) — WITHOUT A MODEL, OR AFTER ITS FAILURE.
//
// Measured before: an ingest without a key failed file by file with «Model
// failure», and ingesting the same XML again answered «duplicate» with the
// pre-registration stranded. All data is synthetic: the entity is the generic
// RFC XAXX010101000 and the vendor a made-up RFC.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'SIN060101AB1';

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

function receivedCfdi(): { file: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  const file = path.join(dir, `${uuid}.xml`);
  fs.writeFileSync(file, FIXTURE.replace(FIXTURE_UUID, uuid));
  return { file, uuid };
}

/** What the Anthropic SDK throws when no credential resolves. */
function keylessModel(): LlmSession {
  return {
    label: 'no key',
    reset: vi.fn(),
    runTurn: vi.fn(async () => {
      throw new Error('Could not resolve authentication method. Expected one of apiKey, authToken');
    }),
  };
}

async function ingest(files: string[], session: LlmSession | null, retry = false) {
  return ingestCfdiFiles({
    ctx, reviewer, files, session, retry, capture: { drafts: [] },
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
  });
}

async function preRegOf(uuid: string) {
  return (await query<{ status: string; bill_id: string | null }>(
    `SELECT p.status, p.bill_id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows[0];
}

beforeAll(async () => {
  f = await crearInquilino('ING-2 retry without model');
  ctx = {
    entityId: f.entityId, entityName: 'ING-2', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-ING2', 'Proveedor Sintetico', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, VENDOR_RFC, f.userId]
  );
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing2-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-2 · a batch without a model provider', () => {
  it('runs the deterministic layer, fails no file and says how many are left to code', async () => {
    const a = receivedCfdi();
    const b = receivedCfdi();
    const session = keylessModel();
    const report = await ingest([a.file, b.file], session);
    expect(report.results.map((r) => r.status)).toEqual(['blocked', 'blocked']);
    expect(report.counts.error).toBe(0);
    expect(report.toCode).toBe(2);
    // The credential is asked once, not once per file.
    expect(session.runTurn).toHaveBeenCalledTimes(1);
    expect((await preRegOf(a.uuid)).status).toBe('ready');
  });
});

describe('ING-2 · reprocessing a CFDI whose processing failed', () => {
  it('does not answer «duplicate» with --retry, and its pre-registration advances', async () => {
    const { file, uuid } = receivedCfdi();
    await ingest([file], keylessModel());
    expect((await preRegOf(uuid)).status).toBe('ready');

    const plain = await ingest([file], null);
    expect(plain.results[0].status).toBe('duplicate');
    expect(plain.results[0].detail).toMatch(/--retry/);

    // The firm now has a rule for this vendor: the deterministic layer can
    // decide the account on the retry, with no model at all.
    const expense = (await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId]
    )).rows[0].id;
    await query(
      `INSERT INTO processing_rules (id, entity_id, rule_name, rule_type, conditions, actions)
       VALUES ($1, $2, 'ING-2 vendor rule', 'account_mapping', $3::jsonb, $4::jsonb)`,
      [
        uuidv4(), f.entityId,
        JSON.stringify({ all: [{ field: 'emisor_rfc', operator: 'equals', value: VENDOR_RFC }] }),
        JSON.stringify({ set_account: expense, set_processing_mode: 'auto' }),
      ]
    );

    const retried = await ingest([file], null, true);
    expect(retried.results[0].status, retried.results[0].detail).toBe('rules');
    const pre = await preRegOf(uuid);
    expect(pre.status).toBe('completed');
    expect(pre.bill_id).not.toBeNull();

    // Once it advanced, a second retry has nothing left to reprocess.
    const again = await ingest([file], null, true);
    expect(again.results[0].status).toBe('duplicate');
    expect(again.results[0].detail).toMatch(/not reprocessable/);
  });
});
