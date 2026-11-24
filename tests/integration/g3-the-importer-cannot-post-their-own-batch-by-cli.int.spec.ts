import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { registerEntryCommand } from '../../src/cli/entry-command.js';
import { registerBatchCommand } from '../../src/cli/batch-command.js';
import { logger } from '../../src/utils/logger.js';

// ============================================================
// G3 · #592 (MNE-001-642) — THE FOUR-EYES LOCK ON AN IMPORTED BATCH, DRIVEN
// THROUGH THE TWO REAL COMMANDS.
//
// `tests/integration/g3-ataque.int.spec.ts` attacks this lock through the
// service and hands it the same user id on both sides, so it never saw what
// the terminal did: `entry import` stored the importer's E-MAIL in
// `journal_entry_import_batches.created_by`, `batch post` compared it with the
// poster's USER ID, and an e-mail never equals a UUID. With the policy
// `segregacion_de_funciones` on `exigir`, one person imported and posted.
//
// So this spec picks no ids by hand: it types `--user <email>` into
// `entry import`, `batch check` and `batch post`, and reads what the ledger
// holds afterwards. Synthetic data only.
// ============================================================

let f: Fixture;
let ana: { id: string; email: string };
let beto: { id: string; email: string };
let dir: string;
let bankCode: string;
let receivableCode: string;

interface Run {
  exitCode?: number;
  errors: Array<{ code?: string; message: string }>;
  out: string;
}

/** One real CLI invocation: `mnemosine <family> <argv…> --entity … --tenant …`. */
async function cli(family: 'entry' | 'batch', ...argv: string[]): Promise<Run> {
  const program = new Command('mnemosine').exitOverride();
  const r: Run = { errors: [], out: '' };
  const id = (s: string) => s;
  const deps = {
    palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
    shutdown: (c: number) => { r.exitCode = c; },
    reportError: (e: unknown) => {
      const err = e as { code?: string; message?: string };
      r.errors.push({ code: err.code, message: String(err.message ?? e) });
    },
    confirm: () => Promise.resolve(true),
    home: dir,
  };
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { r.out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    if (family === 'entry') registerEntryCommand(program, deps);
    else registerBatchCommand(program, deps);
    await program.parseAsync(['node', 'mnemosine', family, ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return r;
}

async function policy(value: string): Promise<void> {
  const ctx = { tenantId: f.tenantId, entityId: f.entityId };
  await reopenPolicy(ctx, 'segregacion_de_funciones').catch(() => undefined);
  await resolvePolicy(ctx, 'segregacion_de_funciones', value, 'sod@example.test');
}

/** `entry import` + `batch check`, both typed by `who`: a checked batch of one entry of 1,250.00. */
async function importedBy(who: { email: string }, label: string): Promise<string> {
  const file = path.join(dir, `${label}.csv`);
  fs.writeFileSync(
    file,
    'entry_key,entry_date,description,account_code,debit,credit,line_description\n' +
      `L1,2026-08-15,${label},${bankCode},1250.00,,debit\n` +
      `L1,2026-08-15,${label},${receivableCode},,1250.00,credit\n`
  );
  const imported = await cli('entry', 'import', file, '--user', who.email);
  expect(imported.errors).toEqual([]);
  const batchId = (await query<{ id: string }>(
    `SELECT id FROM journal_entry_import_batches
      WHERE tenant_id = $1 AND entity_id = $2 AND file_name = $3`,
    [f.tenantId, f.entityId, file]
  )).rows[0].id;
  const checked = await cli('batch', 'check', batchId, '--user', who.email);
  expect(checked.errors).toEqual([]);
  return batchId;
}

/** What the ledger holds of a batch: its state and who posted each of its entries. */
async function ledgerOf(batchId: string): Promise<{ status: string; postedBy: string[] }> {
  const status = (await query<{ status: string }>(
    `SELECT status FROM journal_entry_import_batches WHERE id = $1 AND tenant_id = $2`,
    [batchId, f.tenantId]
  )).rows[0].status;
  const entries = await query<{ posted_by: string }>(
    `SELECT je.posted_by FROM journal_entries je
       JOIN journal_entry_import_rows r ON r.id = je.source_id AND r.tenant_id = $2 AND r.batch_id = $1
      WHERE je.entity_id = $3 AND je.source_type = 'import_batch'`,
    [batchId, f.tenantId, f.entityId]
  );
  return { status, postedBy: entries.rows.map((e) => e.posted_by) };
}

async function user(first: string): Promise<{ id: string; email: string }> {
  const id = uuidv4();
  const email = `${first}-${id.slice(0, 8)}@example.test`;
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', $4, 'Synthetic', '["owner"]'::jsonb, '["*"]'::jsonb, $5::jsonb, true)`,
    [id, f.tenantId, email, first, JSON.stringify([f.entityId])]
  );
  return { id, email };
}

beforeAll(async () => {
  f = await crearInquilino('G3 importer cannot post by CLI');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  ana = await user('ana');
  beto = await user('beto');
  const codes = await query<{ id: string; code: string }>(
    'SELECT id, code FROM accounts WHERE entity_id = $1 AND id = ANY($2::uuid[])',
    [f.entityId, [f.roles.banco, f.roles.cxc]]
  );
  bankCode = codes.rows.find((r) => r.id === f.roles.banco)!.code;
  receivableCode = codes.rows.find((r) => r.id === f.roles.cxc)!.code;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-importer-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('G3 · the importer cannot post their own batch from the terminal', () => {
  it('refuses `batch post` to whoever ran `entry import`, and lets a second person post', async () => {
    await policy('exigir');
    const batchId = await importedBy(ana, 'one-person-batch');

    const own = await cli('batch', 'post', batchId, '--yes', '--user', ana.email);
    expect(own.errors.map((e) => e.code)).toEqual(['SOD_QUIEN_CREA_NO_POSTEA']);
    expect(own.exitCode).not.toBe(0);
    expect(await ledgerOf(batchId)).toEqual({ status: 'checked', postedBy: [] });

    // The preview refuses too: a dry run that said «this will post» to the one
    // person who may not post it would promise what the real run denies.
    const preview = await cli('batch', 'post', batchId, '--dry-run', '--user', ana.email);
    expect(preview.errors.map((e) => e.code)).toEqual(['SOD_QUIEN_CREA_NO_POSTEA']);

    const second = await cli('batch', 'post', batchId, '--yes', '--user', beto.email);
    expect(second.errors).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(await ledgerOf(batchId)).toEqual({ status: 'posted', postedBy: [beto.id] });
  });

  it('stores the importer as a user id, and `batch show` and `batch list` still name them by e-mail', async () => {
    await policy('exigir');
    const batchId = await importedBy(ana, 'stored-by-id');
    const stored = (await query<{ created_by: string }>(
      `SELECT created_by FROM journal_entry_import_batches WHERE id = $1 AND tenant_id = $2`,
      [batchId, f.tenantId]
    )).rows[0].created_by;
    expect(stored).toBe(ana.id);

    const shown = await cli('batch', 'show', batchId);
    expect(shown.out).toContain(ana.email);
    expect(shown.out).not.toContain(ana.id);

    const listed = JSON.parse((await cli('batch', 'list', '--json', '--fields', 'id,created_by')).out) as {
      rows: Array<{ id: string; created_by: string }>;
    };
    expect(listed.rows.find((b) => b.id === batchId)?.created_by).toBe(ana.email);
  });

  it('compares a batch staged before the change, whose created_by holds the e-mail', async () => {
    await policy('exigir');
    const batchId = await importedBy(ana, 'staged-before-the-change');
    // What every batch staged from the terminal before MNE-001-642 holds.
    const old = await query(
      `UPDATE journal_entry_import_batches SET created_by = $3
        WHERE id = $1 AND tenant_id = $2 AND status = 'checked'`,
      [batchId, f.tenantId, ana.email]
    );
    expect(old.rowCount).toBe(1);

    const own = await cli('batch', 'post', batchId, '--yes', '--user', ana.email);
    expect(own.errors.map((e) => e.code)).toEqual(['SOD_QUIEN_CREA_NO_POSTEA']);
    expect(await ledgerOf(batchId)).toEqual({ status: 'checked', postedBy: [] });

    const shown = await cli('batch', 'show', batchId);
    expect(shown.out).toContain(ana.email);

    const second = await cli('batch', 'post', batchId, '--yes', '--user', beto.email);
    expect(second.errors).toEqual([]);
    expect(await ledgerOf(batchId)).toEqual({ status: 'posted', postedBy: [beto.id] });
  });

  it('with the policy on `alertar` the same person posts and the note is still written', async () => {
    await policy('alertar');
    const batchId = await importedBy(ana, 'alert-only');
    const warn = vi.spyOn(logger, 'warn');
    try {
      const own = await cli('batch', 'post', batchId, '--yes', '--user', ana.email);
      expect(own.errors).toEqual([]);
      const notes = warn.mock.calls
        .map((c): unknown => c[0])
        .filter((m): m is string => typeof m === 'string' && m.includes(batchId));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^SoD: /);
    } finally {
      warn.mockRestore();
    }
    expect(await ledgerOf(batchId)).toEqual({ status: 'posted', postedBy: [ana.id] });
  });

  it('with the policy off nobody is asked for a second pair of eyes', async () => {
    await policy('off');
    const batchId = await importedBy(ana, 'policy-off');
    const own = await cli('batch', 'post', batchId, '--yes', '--user', ana.email);
    expect(own.errors).toEqual([]);
    expect(await ledgerOf(batchId)).toEqual({ status: 'posted', postedBy: [ana.id] });
  });
});
