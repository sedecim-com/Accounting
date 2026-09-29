import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
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
import { registerPrepaidCommand } from '../../src/cli/prepaid-command.js';
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

/** Runs the real CLI leaf and returns what it printed and its exit code. */
async function run(argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
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
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, out: out.join(''), err: err.join('') };
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
});
