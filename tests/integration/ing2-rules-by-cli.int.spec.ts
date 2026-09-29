import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, type IngestReport } from '../../src/ai/ingest-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import type { AgentContext } from '../../src/ai/context.js';

// ============================================================
// ING-2 · #319 (MNE-001-032) — THE FIRM'S RULES FROM THE TERMINAL.
//
// Measured before: `processing_rules` was only reachable through REST, so
// without a model every CFDI of a recurring vendor was left to code, batch
// after batch. The acceptance of the /confirmar of 2026-09-27, end to end: a
// batch ingested with no key stays in the inbox → it is coded by hand → a rule
// is created with `bill rule create` → the second batch of the same vendor
// posts by itself, and the pre-registration keeps which rule decided.
// Synthetic data only: the generic RFC XAXX010101000 and a made-up vendor RFC.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf8');
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const OWN_RFC = 'XAXX010101000';
const VENDOR_RFC = 'SIN060101AB1';

let f: Fixture;
let ctx: AgentContext;
let dir: string;
let email: string;

/** One batch of one CFDI of the vendor, ingested with no model provider. */
async function batchWithoutKey(): Promise<{ report: IngestReport; preRegistrationId: string }> {
  const uuid = uuidv4().toUpperCase();
  const file = path.join(dir, `${uuid}.xml`);
  fs.writeFileSync(file, FIXTURE.replace(FIXTURE_UUID, uuid));
  const report = await ingestCfdiFiles({
    ctx, reviewer: { userId: f.userId, email }, files: [file], session: null, capture: { drafts: [] },
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
  });
  const preRegistrationId = (await query<{ id: string }>(
    `SELECT p.id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows[0].id;
  return { report, preRegistrationId };
}

async function cli(...argv: string[]): Promise<{ exitCode?: number; errors: string[]; out: string }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  const errors: string[] = [];
  const id = (s: string) => s;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    registerBillCommand(program, {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); },
      confirm: () => Promise.resolve(true),
    });
    await program.parseAsync([
      'node', 'mnemosine', 'bill', ...argv, '--entity', f.entityId, '--tenant', f.tenantId,
    ]);
  } finally {
    process.stdout.write = write;
  }
  return { exitCode, errors, out: chunks.join('') };
}

async function preReg(id: string) {
  return (await query<{
    status: string; bill_id: string | null; journal_entry_id: string | null;
    account_mapping_method: string | null; rules_applied: Array<{ ruleId: string; ruleName: string }> | null;
  }>(
    `SELECT status, bill_id, journal_entry_id, account_mapping_method, rules_applied
       FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId]
  )).rows[0];
}

async function ruleCount(): Promise<number> {
  return Number((await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM processing_rules WHERE entity_id = $1`, [f.entityId]
  )).rows[0].n);
}

beforeAll(async () => {
  f = await crearInquilino('ING-2 rules by CLI');
  ctx = {
    entityId: f.entityId, entityName: 'ING-2', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-ING2R', 'Proveedor Sintetico', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, VENDOR_RFC, f.userId]
  );
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing2-rules-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-2 · processing rules from the terminal', () => {
  it('refuses a rule the REST route or the engine would not honor, and writes nothing', async () => {
    const header = (await query<{ code: string }>(
      `SELECT code FROM accounts WHERE entity_id = $1 AND is_header = true LIMIT 1`, [f.entityId]
    )).rows[0].code;
    const refused = [
      ['--name', 'x', '--then', 'set_account=6100'],
      ['--name', 'x', '--when', `emisor_rfc equals ${VENDOR_RFC}`],
      ['--name', 'x', '--when', `rfc_emisor equals ${VENDOR_RFC}`, '--then', 'set_account=6100'],
      ['--name', 'x', '--when', `emisor_rfc equals ${VENDOR_RFC}`, '--then', 'set_cost_center=cc'],
      ['--name', 'x', '--when', `emisor_rfc equals ${VENDOR_RFC}`, '--then', `set_account=${header}`],
      ['--name', 'x', '--when', `emisor_rfc equals ${VENDOR_RFC}`, '--then', 'set_account=6100', '--type', 'nope'],
      ['--name', '', '--when', `emisor_rfc equals ${VENDOR_RFC}`, '--then', 'set_account=6100'],
    ];
    for (const argv of refused) {
      const r = await cli('rule', 'create', ...argv);
      expect(r.exitCode, argv.join(' ')).not.toBe(0);
    }
    expect(await ruleCount()).toBe(0);
  });

  it('batch without key → coded by hand → rule → the second batch posts by itself, with the rule in its trace', async () => {
    // 1. No key: the CFDI stays in the inbox, to code.
    const first = await batchWithoutKey();
    expect(first.report.toCode).toBe(1);
    expect((await preReg(first.preRegistrationId)).bill_id).toBeNull();

    // 2. Coded by hand and posted through the single gate.
    const coded = await cli('inbox', 'edit', first.preRegistrationId, '--account', '6100');
    expect(coded.exitCode, coded.errors.join('\n')).toBe(0);
    const posted = await cli('inbox', 'run', first.preRegistrationId, '--yes');
    expect(posted.exitCode, posted.errors.join('\n')).toBe(0);
    expect((await preReg(first.preRegistrationId)).status).toBe('completed');

    // 3. The firm turns what it just did into a rule.
    const created = await cli(
      'rule', 'create', '--name', 'Consultoria SIN',
      '--when', `emisor_rfc equals ${VENDOR_RFC}`,
      '--then', 'set_account=6100', '--then', 'set_processing_mode=auto', '--json'
    );
    expect(created.exitCode, created.errors.join('\n')).toBe(0);
    const ruleId = (JSON.parse(created.out) as { rows: Array<{ id: string }> }).rows[0].id;

    // 4. The second batch of the same vendor needs nobody.
    const second = await batchWithoutKey();
    expect(second.report.toCode).toBe(0);
    expect(second.report.results[0].status).toBe('rules');
    expect(second.report.results[0].detail).toContain('«Consultoria SIN»');
    const done = await preReg(second.preRegistrationId);
    expect(done.status).toBe('completed');
    expect(done.bill_id).not.toBeNull();
    expect(done.account_mapping_method).toBe('rule');
    expect(done.rules_applied?.map((r) => r.ruleId)).toEqual([ruleId]);
    const expense = (await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE je.id = $1 AND je.entity_id = $2 AND je.status = 'posted'
          AND l.account_id = (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100')`,
      [done.journal_entry_id, f.entityId]
    )).rows[0].n;
    expect(Number(expense)).toBeGreaterThan(0);

    // 5. The list shows the rule, its account by code, and that it fired once.
    const listed = await cli('rule', 'list', '--json');
    expect(listed.exitCode, listed.errors.join('\n')).toBe(0);
    const { rows } = JSON.parse(listed.out) as { rows: Array<Record<string, unknown>> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ruleId, name: 'Consultoria SIN', matched: 1,
      when: `emisor_rfc equals ${VENDOR_RFC}`, then: 'set_account=6100 set_processing_mode=auto',
    });
  });
});
