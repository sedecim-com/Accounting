import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles } from '../../src/ai/ingest-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import type { AgentContext } from '../../src/ai/context.js';

// ============================================================
// ING-2 · #319 (MNE-001-030) — A STRANDED CFDI IS CODED BY HAND.
//
// Measured before: a CFDI ingested without a model sat in the inbox, and
// `bill inbox run` refused it with «Line 1: no account assigned»; the only way
// to code it was the REST PATCH. Now `bill inbox edit` codes it from the
// terminal and the same `bill inbox run` posts it. Synthetic data only: the
// entity is the generic RFC XAXX010101000 and the vendor a made-up RFC.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'SIN060101AB1';

let f: Fixture;
let ctx: AgentContext;
let dir: string;

/** A CFDI ingested with no model provider: it is left in the inbox to code. */
async function strandedCfdi(): Promise<string> {
  const uuid = uuidv4().toUpperCase();
  const file = path.join(dir, `${uuid}.xml`);
  fs.writeFileSync(file, FIXTURE.replace(FIXTURE_UUID, uuid));
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  const report = await ingestCfdiFiles({
    ctx, reviewer: { userId: f.userId, email }, files: [file], session: null, capture: { drafts: [] },
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
  });
  expect(report.toCode).toBe(1);
  return (await query<{ id: string }>(
    `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows[0].id;
}

async function cli(...argv: string[]): Promise<{ exitCode?: number; errors: string[] }> {
  return cliAs(f, ...argv);
}

async function cliAs(who: Fixture, ...argv: string[]): Promise<{ exitCode?: number; errors: string[] }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  const errors: string[] = [];
  const id = (s: string) => s;
  registerBillCommand(program, {
    palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
    shutdown: (c: number) => { exitCode = c; },
    reportError: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); },
    confirm: () => Promise.resolve(true),
  });
  await program.parseAsync([
    'node', 'mnemosine', 'bill', 'inbox', ...argv, '--entity', who.entityId, '--tenant', who.tenantId,
  ]);
  return { exitCode, errors };
}

async function preReg(id: string) {
  return (await query<{
    status: string; bill_id: string | null; journal_entry_id: string | null;
    account_mapping_method: string | null; lines: Array<{ account_id?: string; cost_center_id?: string }>;
  }>(
    `SELECT status, bill_id, journal_entry_id, account_mapping_method, lines
       FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId]
  )).rows[0];
}

async function accountId(code: string): Promise<string> {
  return (await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`, [f.entityId, code]
  )).rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('ING-2 code by hand');
  ctx = {
    entityId: f.entityId, entityName: 'ING-2', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-ING2', 'Proveedor Sintetico', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, VENDOR_RFC, f.userId]
  );
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing2-code-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-2 · coding a stranded CFDI from the terminal', () => {
  it('is coded with `bill inbox edit` and `bill inbox run` posts it through the single gate', async () => {
    const id = await strandedCfdi();

    // Before: the single gate refuses it, and it stays out of the ledger.
    const refused = await cli('run', id, '--yes');
    expect(refused.exitCode).not.toBe(0);
    expect((await preReg(id)).bill_id).toBeNull();

    const costCenter = uuidv4();
    const coded = await cli('edit', id, '--line', '1', '--account', '6100', '--cost-center', costCenter);
    expect(coded.exitCode, coded.errors.join('\n')).toBe(0);
    const after = await preReg(id);
    expect(after.lines[0].account_id).toBe(await accountId('6100'));
    expect(after.lines[0].cost_center_id).toBe(costCenter);
    expect(after.account_mapping_method).toBe('manual');

    const posted = await cli('run', id, '--yes');
    expect(posted.exitCode, posted.errors.join('\n')).toBe(0);
    const done = await preReg(id);
    expect(done.status).toBe('completed');
    expect(done.bill_id).not.toBeNull();
    const expense = (await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE je.id = $1 AND je.entity_id = $2 AND je.status = 'posted' AND l.account_id = $3`,
      [done.journal_entry_id, f.entityId, await accountId('6100')]
    )).rows[0].n;
    expect(Number(expense)).toBeGreaterThan(0);

    // Posted, it can no longer be re-coded: that would be a reclassification entry.
    const late = await cli('edit', id, '--line', '1', '--account', '6100');
    expect(late.exitCode).toBe(5);
    expect(late.errors.join('\n')).toMatch(/completed/);
  });

  it('a default account codes every line with none of its own', async () => {
    const id = await strandedCfdi();
    const coded = await cli('edit', id, '--account', '6100');
    expect(coded.exitCode, coded.errors.join('\n')).toBe(0);
    const posted = await cli('run', id, '--yes');
    expect(posted.exitCode, posted.errors.join('\n')).toBe(0);
    expect((await preReg(id)).status).toBe('completed');
  });

  it('refuses a header account, a line that does not exist and another entity', async () => {
    const id = await strandedCfdi();
    const header = (await query<{ code: string }>(
      `SELECT code FROM accounts WHERE entity_id = $1 AND is_header = true LIMIT 1`, [f.entityId]
    )).rows[0].code;
    const headerRefused = await cli('edit', id, '--account', header);
    expect(headerRefused.exitCode).toBe(4);
    expect(headerRefused.errors.join('\n')).toMatch(/not a postable account/);
    expect((await cli('edit', id, '--line', '99', '--account', '6100')).exitCode).toBe(3);

    // Another entity's operator cannot even see it: 404, never «not codable».
    const other = await crearInquilino('ING-2 code by hand, other');
    expect((await cliAs(other, 'edit', id, '--account', '6100')).exitCode).toBe(3);

    const untouched = await preReg(id);
    expect(untouched.account_mapping_method).not.toBe('manual');
    expect(untouched.lines[0].account_id).toBeUndefined();
  });
});
