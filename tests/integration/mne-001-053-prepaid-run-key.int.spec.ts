import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase, enterTenant, getClient } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import {
  createJournalEntry,
  reverseJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { registrarPagoAnticipado } from '../../src/services/accruals/prepaid-service.js';
import { hashDeCarga } from '../../src/services/idempotency/idempotency-store.js';
import { keyLockName, registerPrepaidCommand } from '../../src/cli/prepaid-command.js';
import { ExitCode, exitCodeFor } from '../../src/cli/kernel/index.js';
import { t } from '../../src/i18n/index.js';

// ============================================================
// MNE-001-053 (#317): `prepaid run` honours its idempotency key.
//
// The leaf passed the key to `conLlave`, but two things kept the promise
// "a retry with the same key returns the recorded result" false:
//
//   · The key was only consulted inside `conLlave`, and the handler left
//     earlier: a retry finds the month already accrued, `entran.length` is 0
//     and it exits with "nothing to accrue" — never reaching the store.
//   · The key's payload hashed `entran.length` and the previewed total, which
//     are the RESULT of the current ledger, not the order. After a reversal
//     the same key hashed equal again and silently replayed a result whose
//     entry no longer stands.
//
// This is the same defect #180 fixed in `payroll accrue`, and it is pinned the
// same way: counting rows in the ledger, which a unit double cannot do.
// ============================================================

let f: Fixture;

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs the real CLI leaf and returns its exit code; output goes wherever stdout/stderr point. */
async function invoke(argv: string[], err: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const p = new Command('mnemosine');
  registerPrepaidCommand(p, {
    palette: plain,
    shutdown: (c: number) => { exitCode = c; },
    reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
  });
  try {
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', f.entityId, '-t', f.tenantId, '-y', '--json']);
  } catch (e) {
    err.push(`${(e as Error).message}\n`);
    exitCode = exitCodeFor(e);
  }
  return exitCode;
}

/** Captures stdout and stderr around `fn`. */
async function captured<T>(fn: (err: string[]) => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const value = await fn(err);
    return { value, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
}

/** Runs the real CLI leaf and returns what it printed and its exit code. */
async function run(argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
  const r = await captured((err) => invoke(argv, err));
  return { exitCode: r.value, out: r.out, err: r.err };
}

/** Journal entries of this entity: any write by the leaf shows up here. */
async function journalEntries(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT count(*) n FROM journal_entries WHERE entity_id = $1`, [
    f.entityId,
  ]);
  return Number(r.rows[0].n);
}

/** The entry the (single) prepaid posted in a period, if it still stands. */
async function standingEntryOf(periodId: string): Promise<string | undefined> {
  const r = await query<{ journal_entry_id: string }>(
    `SELECT s.journal_entry_id FROM prepaid_amortization_schedules s
       JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.entity_id = $1 AND s.fiscal_period_id = $2 AND s.is_posted = true
        AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL`,
    [f.entityId, periodId]
  );
  return r.rows[0]?.journal_entry_id;
}

/** Runs waiting, right now, on the advisory lock `name` (a bigint key split in two oids). */
async function waitersOn(name: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*) n FROM pg_locks l, (SELECT hashtextextended($1, 0) AS k) h
      WHERE l.locktype = 'advisory' AND NOT l.granted
        AND l.objid::bigint = (h.k & 4294967295) AND l.classid::bigint = ((h.k >> 32) & 4294967295)`,
    [name]
  );
  return Number(r.rows[0].n);
}

/** What the store recorded under a `prepaid run` key. */
async function recordedUnder(key: string): Promise<Record<string, unknown> | undefined> {
  const r = await query<{ recorded: Record<string, unknown> }>(
    `SELECT resultado AS recorded FROM idempotency_keys WHERE tenant_id = $1 AND scope = 'prepaid run' AND clave = $2`,
    [f.tenantId, key]
  );
  return r.rows[0]?.recorded;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-053 prepaid run key');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  enterTenant(f.tenantId);
  const source = await createJournalEntry(
    f.entityId,
    new Date('2026-01-05T00:00:00'),
    JournalEntryType.STANDARD,
    'Annual insurance premium',
    [
      { account_id: f.roles.gasto_anticipado, debit_amount: '12000.0000', credit_amount: null, description: 'Premium' },
      { account_id: f.roles.banco, debit_amount: null, credit_amount: '12000.0000', description: 'Payment' },
    ],
    f.userId,
    { autoPost: true }
  );
  await registrarPagoAnticipado({
    entityId: f.entityId,
    descripcion: 'Fleet insurance 2026',
    importe: '12000.0000',
    inicio: '2026-01-01',
    fin: '2026-12-31',
    origen: 'cfdi',
    sourceJournalEntryId: source.id,
    createdBy: f.userId,
  });
}, 120_000);

afterAll(async () => {
  await drainAttestations(5000).catch(() => undefined);
  await closeDatabase();
});

describe('prepaid run honours its idempotency key', () => {
  it('a retry with the same key returns the recorded result and posts nothing', async () => {
    const before = await journalEntries();
    const first = await run(['prepaid', 'run', '--period', f.periodos[1], '--idempotency-key', 'k-jan']);
    expect(first.exitCode, first.err).toBe(ExitCode.OK);
    expect(await journalEntries()).toBe(before + 1);
    const entry = await standingEntryOf(f.periodos[1]);
    expect(entry).toBeDefined();

    const retry = await run(['prepaid', 'run', '--period', f.periodos[1], '--idempotency-key', 'k-jan']);
    expect(retry.exitCode, retry.err).toBe(ExitCode.OK);
    // It SAYS it is the recorded result, and shows it — not "nothing to accrue".
    expect(retry.err).toContain(t('prepaid.run.key_replayed'));
    expect(retry.err).not.toContain('Nada que devengar');
    const shown = (JSON.parse(retry.out) as { rows: Array<Record<string, unknown>> }).rows;
    expect(shown[0]).toMatchObject({ devengados: 1, total: '1019.1781', asientos: entry });
    expect(await journalEntries()).toBe(before + 1);
  }, 60_000);

  it('the key payload is the order (entity + period), not entran.length or the total', async () => {
    const stored = await query<{ payload_hash: string }>(
      `SELECT payload_hash FROM idempotency_keys WHERE tenant_id = $1 AND scope = 'prepaid run' AND clave = 'k-jan'`,
      [f.tenantId]
    );
    expect(stored.rows.map((r) => r.payload_hash)).toEqual([hashDeCarga(f.entityId, f.periodos[1])]);
  });

  it('the same key on another period is key reuse, and posts nothing', async () => {
    const before = await journalEntries();
    const other = await run(['prepaid', 'run', '--period', f.periodos[2], '--idempotency-key', 'k-jan']);
    expect(other.exitCode).toBe(ExitCode.CONFLICT);
    expect(await journalEntries()).toBe(before);
  }, 60_000);

  it('a reversed entry is not replayed, and a new key accrues the month again', async () => {
    const first = await run(['prepaid', 'run', '--period', f.periodos[3], '--idempotency-key', 'k-mar']);
    expect(first.exitCode, first.err).toBe(ExitCode.OK);
    const entry = await standingEntryOf(f.periodos[3]);
    expect(entry).toBeDefined();
    await reverseJournalEntry(entry as string, f.userId, { reason: 'wrong premium' });
    const before = await journalEntries();

    // Replaying "1 accrued" would be false: the month is no longer accrued.
    const retry = await run(['prepaid', 'run', '--period', f.periodos[3], '--idempotency-key', 'k-mar']);
    expect(retry.exitCode, retry.err).toBe(ExitCode.USAGE);
    expect(retry.err).toContain(entry as string);
    expect(await journalEntries()).toBe(before);

    // The legitimate re-accrual, under a new key, runs and does not collide.
    const again = await run(['prepaid', 'run', '--period', f.periodos[3], '--idempotency-key', 'k-mar-2']);
    expect(again.exitCode, again.err).toBe(ExitCode.OK);
    expect(await journalEntries()).toBe(before + 1);
    const fresh = await standingEntryOf(f.periodos[3]);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(entry);
  }, 60_000);

  it('a key recorded before MNE-001-053 (old payload) is key reuse, exit 6, and posts nothing', async () => {
    // The old payload also hashed the previewed count and total.
    await query(
      `INSERT INTO idempotency_keys (tenant_id, entity_id, scope, clave, payload_hash, resultado)
       VALUES ($1, $2, 'prepaid run', 'k-old', $3, $4)`,
      [f.tenantId, f.entityId, hashDeCarga(f.entityId, f.periodos[6], 1, '1000.0000'),
        JSON.stringify({ processed: 1, total: '1000.0000', skipped: 0, errors: [] })]
    );
    const before = await journalEntries();
    const retry = await run(['prepaid', 'run', '--period', f.periodos[6], '--idempotency-key', 'k-old']);
    expect(retry.exitCode, retry.err).toBe(ExitCode.CONFLICT);
    expect(await journalEntries()).toBe(before);
  }, 60_000);

  it('two runs with the same key at once post once, and record the result that replays', async () => {
    const argv = ['prepaid', 'run', '--period', f.periodos[5], '--idempotency-key', 'k-may'];
    const name = keyLockName(f.tenantId, 'prepaid run', 'k-may');
    const before = await journalEntries();

    // Hold the key's lock, start both runs, and see them queue behind it
    // without posting: without the lock they both run the engine at once.
    const holder = await getClient();
    let both: Promise<{ value: Array<number | undefined>; out: string; err: string }> | undefined;
    let queued = 0;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [name]);
      both = captured((err) => Promise.all([invoke(argv, err), invoke(argv, err)]));
      for (let i = 0; i < 60 && queued < 2; i++) {
        await new Promise((r) => setTimeout(r, 100));
        queued = await waitersOn(name);
      }
      expect(await journalEntries()).toBe(before);
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      holder.release();
    }
    const done = await both;
    expect(queued, 'both runs wait on the key lock').toBe(2);
    expect(done?.value, done?.err).toEqual([ExitCode.OK, ExitCode.OK]);
    expect(done?.err).toContain(t('prepaid.run.key_replayed'));
    expect(await journalEntries()).toBe(before + 1);

    const entry = await standingEntryOf(f.periodos[5]);
    expect(await recordedUnder('k-may')).toMatchObject({ processed: 1, errors: [], journalEntryIds: [entry] });
    const retry = await run(argv);
    expect(retry.exitCode, retry.err).toBe(ExitCode.OK);
    const shown = (JSON.parse(retry.out) as { rows: Array<Record<string, unknown>> }).rows;
    expect(shown[0]).toMatchObject({ devengados: 1, asientos: entry });
    expect(await journalEntries()).toBe(before + 1);
  }, 60_000);

  it('a partial run is not replayed while a prepaid is still pending, and replays its errors once none is', async () => {
    // A second prepaid, from August, charged to an expense account that is
    // then deactivated: the engine accrues the first and fails this one.
    const expense = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND account_type = 'expense' AND NOT is_header
          AND is_active AND id <> $2 ORDER BY code LIMIT 1`,
      [f.entityId, f.roles.gasto]
    );
    const expenseId = expense.rows[0].id;
    const source = await createJournalEntry(
      f.entityId,
      new Date('2026-08-01T00:00:00'),
      JournalEntryType.STANDARD,
      'Office lease paid in advance',
      [
        { account_id: f.roles.gasto_anticipado, debit_amount: '5000.0000', credit_amount: null, description: 'Lease' },
        { account_id: f.roles.banco, debit_amount: null, credit_amount: '5000.0000', description: 'Payment' },
      ],
      f.userId,
      { autoPost: true }
    );
    await registrarPagoAnticipado({
      entityId: f.entityId,
      descripcion: 'Office lease Aug-Dec',
      importe: '5000.0000',
      inicio: '2026-08-01',
      fin: '2026-12-31',
      origen: 'cfdi',
      sourceJournalEntryId: source.id,
      createdBy: f.userId,
      cuentas: { expenseAccountId: expenseId },
    });
    await query(`UPDATE accounts SET is_active = false WHERE id = $1 AND entity_id = $2`, [expenseId, f.entityId]);
    const period = f.periodos[8];
    const argv = ['prepaid', 'run', '--period', period, '--idempotency-key', 'k-aug'];
    const before = await journalEntries();

    const first = await run(argv);
    expect(first.exitCode, first.err).toBe(ExitCode.VALIDATION);
    expect(first.err).toContain('Office lease Aug-Dec');
    expect(await journalEntries()).toBe(before + 1);
    const recorded = await recordedUnder('k-aug');
    const errors = (recorded?.errors ?? []) as string[];
    expect(errors).toHaveLength(1);

    // Still pending: replaying would repeat the failure without trying again.
    const name = (await query<{ period_name: string }>(`SELECT period_name FROM fiscal_periods WHERE id = $1`, [period]))
      .rows[0].period_name;
    const retry = await run(argv);
    expect(retry.exitCode, retry.err).toBe(ExitCode.USAGE);
    expect(retry.err).toContain(t('prepaid.run.key_partial', { key: 'k-aug', period: name, failed: 1, pending: 1 }));
    expect(await journalEntries()).toBe(before + 1);

    // Fixed and accrued without the key: nothing is pending, and the key
    // replays what it recorded, saying WHY it failed.
    await query(`UPDATE accounts SET is_active = true WHERE id = $1 AND entity_id = $2`, [expenseId, f.entityId]);
    const fixed = await run(['prepaid', 'run', '--period', period]);
    expect(fixed.exitCode, fixed.err).toBe(ExitCode.OK);
    expect(await journalEntries()).toBe(before + 2);
    const replayed = await run(argv);
    expect(replayed.exitCode, replayed.err).toBe(ExitCode.VALIDATION);
    expect(replayed.err).toContain(t('prepaid.run.key_replayed'));
    expect(replayed.err).toContain(errors[0]);
    expect(await journalEntries()).toBe(before + 2);
  }, 60_000);
});
