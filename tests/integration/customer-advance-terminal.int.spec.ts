import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-421 (#623, part 2/8) · A CUSTOMER ADVANCE FROM THE TERMINAL.
 *
 * `receipt record` with no invoice, `--customer` and `--tax-rate` records
 * the advance of part 1/8: bank Dr · 2150 Cr for the base · 2120 Cr for the
 * IVA caused on collection (LIVA art. 1-B). The leaf runs in-process against
 * Postgres, and every figure is computed by hand.
 */

let f: Fixture;
const CUSTOMER = 'Synthetic Advance Payer SA';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs `receipt <argv>` as the binary would (a write goes with --yes); returns what it printed and its exit code. */
async function receipt(argv: string[]): Promise<{ exitCode?: number; out: string; err: string; errors: unknown[] }> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errors.push(e); err.push(`${(e as Error).message}\n`); },
    });
    try {
      await program.parseAsync(['node', 'mnemosine', 'receipt', ...argv, '-e', f.entityId, '-t', f.tenantId,
        ...(argv[0] === 'record' ? ['-y'] : [])]);
    } catch (e) {
      errors.push(e);
      exitCode = exitCodeFor(e);
    }
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { exitCode, out: out.join(''), err: err.join(''), errors };
}

const advance = (...extra: string[]): string[] =>
  ['record', '--customer', CUSTOMER, '--amount', '1160.00', '--tax-rate', '16', '--date', '2026-08-15', ...extra];

const rowOf = (out: string): Record<string, unknown> => (JSON.parse(out) as { rows: Record<string, unknown>[] }).rows[0];

/** How many receipts, allocations and posted entries the entity holds. */
async function written(): Promise<number[]> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1
     UNION ALL
     SELECT COUNT(*)::text FROM payment_allocations a JOIN customer_payments p ON p.id = a.payment_id WHERE p.entity_id = $1
     UNION ALL
     SELECT COUNT(*)::text FROM journal_entries WHERE entity_id = $1`,
    [f.entityId]
  );
  return r.rows.map((x) => Number(x.n));
}

/** The lines of an entry by account code: [debit, credit]. */
async function linesOf(entryNumber: unknown): Promise<Record<string, [number, number]>> {
  const r = await query<{ account_id: string; debit: string; credit: string }>(
    `SELECT l.account_id, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.entry_number = $2 AND je.status = 'posted'
      GROUP BY l.account_id`,
    [f.entityId, entryNumber]
  );
  const code = Object.fromEntries(Object.entries(f.cuentas).map(([c, id]) => [id, c]));
  return Object.fromEntries(r.rows.map((l) => [code[l.account_id], [Number(l.debit), Number(l.credit)]]));
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-421 advance from the terminal');
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-421', $3, 'MXN', $4)`,
    [uuidv4(), f.entityId, CUSTOMER, f.userId]
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt record with no invoice, --customer and --tax-rate', () => {
  it('--dry-run writes nothing and shows the base, the rate and the IVA', async () => {
    const before = await written();
    const r = await receipt(advance('--dry-run'));
    expect(r.exitCode, r.err).toBe(0);
    expect(r.out).toContain('base 1000.00, IVA 160.00, rate 16 %');
    expect(await written()).toEqual(before);
  });

  it('with --yes posts bank 1,160.00 / 2150 1,000.00 / 2120 160.00, and --json carries the three figures', async () => {
    const [receipts, allocations, entries] = await written();
    const r = await receipt(advance('--json'));
    expect(r.exitCode, r.err).toBe(0);
    const row = rowOf(r.out);
    expect(row).toMatchObject({
      document: null, on_account: '1160.00', advance_base: '1000.00', advance_tax_rate: '16', advance_iva: '160.00', dry_run: false,
    });
    // One receipt with no allocation, and one entry of three lines: no revenue account moves.
    expect(await written()).toEqual([receipts + 1, allocations, entries + 1]);
    expect(await linesOf(row.journal_entry)).toEqual({ '1111': [1160, 0], '2150': [0, 1000], '2120': [0, 160] });
  });

  it('retried with the same --idempotency-key, returns the recorded receipt and writes nothing again', async () => {
    const [receipts, allocations, entries] = await written();
    const first = await receipt(advance('--json', '--idempotency-key', 'advance-421'));
    expect(first.exitCode, first.err).toBe(0);
    expect(await written()).toEqual([receipts + 1, allocations, entries + 1]);

    const second = await receipt(advance('--json', '--idempotency-key', 'advance-421'));
    expect(second.exitCode, second.err).toBe(0);
    expect(second.err).toContain('Idempotency hit');
    expect(rowOf(second.out)).toEqual(rowOf(first.out));
    expect(await written()).toEqual([receipts + 1, allocations, entries + 1]);
  });

  it('refuses an advance by cheque naming issue 700, and writes nothing', async () => {
    // LIVA art. 1-B, second paragraph: a cheque's IVA is caused the day the bank cashes it.
    const before = await written();
    const r = await receipt(advance('--method', 'check'));
    expect(r.exitCode).not.toBe(0);
    expect(r.errors[0]).toMatchObject({ code: 'ADVANCE_BY_CHEQUE_NOT_WIRED', messageKey: { key: 'receipt.advance.cheque_not_wired' } });
    expect(r.err).toContain('issue 700');
    expect(await written()).toEqual(before);
  });

  it('receipt show lists the three figures of the advance', async () => {
    const recorded = rowOf((await receipt(advance('--json'))).out);
    const shown = await receipt(['show', String(recorded.payment_number)]);
    expect(shown.exitCode, shown.err).toBe(0);
    expect(shown.out).toMatch(/advance_base\s+advance_tax_rate\s+advance_iva/);
    expect(shown.out).toMatch(/1000\.00\s+16\s+160\.00/);
    const json = rowOf((await receipt(['show', String(recorded.payment_number), '--json'])).out);
    expect(json).toMatchObject({ advance_base: '1000.00', advance_tax_rate: '16', advance_iva: '160.00' });
  });
});
