import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { registerPtuCommand } from '../../src/cli/ptu-command.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-298 (#111, option (b)) · THE PTU OF THE YEAR, FROM THE TERMINAL
//
// `ptu close` against a migrated Postgres, with the hand figures of the plan:
// base 1,106,000.00, PTU 110,600.00; after 96,000.00 provisioned in the year
// the true-up is 14,600.00, after 120,000.00 it reverses 9,400.00. The draft
// sits in period 13 against 6117 / 2205 with the three figures and their
// source in `calculation_metadata`; nothing is posted. The entity and the
// figures are invented, and so is the `ptu.rate` row: the real one is seeded
// only once the Comisión Nacional resolution's date is verified, so this spec
// adds a synthetic row and removes it at the end.
// ============================================================

let f: Fixture;
const same = (x: string): string => x;
const plain = { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same };
const SYNTHETIC_RATE_FROM = '2026-01-01';

interface CliResult { exitCode?: number; out: string; err: string }

async function cli(argv: string[], fx: Fixture): Promise<CliResult> {
  const r: CliResult = { out: '', err: '' };
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { r.out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { r.err += String(c); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerPtuCommand(p, {
      palette: plain,
      shutdown: (c: number) => { r.exitCode = c; },
      reportError: (e: unknown) => { r.err += `${(e as Error).message}\n`; },
    });
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fx.userId])).rows[0].email;
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', fx.entityId, '-t', fx.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return r;
}

const FIGURES = {
  'accumulable-income': '5000000', 'authorized-deductions': '3800000',
  'non-deductible-exempt-pay': '94000', source: 'Annual computation 2026, working file v3',
};
const close = (change: Record<string, string> = {}, extra: string[] = []): string[] => [
  'ptu', 'close', '--year', '2026',
  ...Object.entries({ ...FIGURES, ...change }).map(([k, v]) => `--${k}=${v}`), '--json', ...extra,
];
interface Row { outcome: string; entry_number: string | null; base: string; ptu: string; provisioned: string; adjustment: string }
const rowOf = (r: CliResult): Row => (JSON.parse(r.out) as { rows: Row[] }).rows[0];

/** Period 13, which `ensureFiscalYear` creates and the fixture does not. */
async function withPeriod13(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, period_type, status)
     VALUES ($1, $2, $3, 13, 'Year-end adjustments 2026', '2026-12-31', '2026-12-31', 'adjustment', 'open')`,
    [id, fx.fiscalYearId, fx.entityId]
  );
  return id;
}

interface Stored { id: string; entry_number: string; status: string; fiscal_period_id: string; lines: Array<{ code: string; debit: string | null; credit: string | null; meta: Record<string, unknown> }> }
async function ptuEntries(fx: Fixture): Promise<Stored[]> {
  return (await query<Stored>(
    `SELECT je.id, je.entry_number, je.status, je.fiscal_period_id,
            json_agg(json_build_object('code', a.code, 'debit', jel.debit_amount::text, 'credit', jel.credit_amount::text,
                     'meta', jel.tags->'calculation_metadata') ORDER BY jel.line_number) AS lines
       FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id
      WHERE je.entity_id = $1 AND je.source_type = 'ptu_provision'
      GROUP BY je.id ORDER BY je.created_at`,
    [fx.entityId]
  )).rows;
}

/** A provision already credited in June, posted: what a monthly run (MNE-001-849) would leave. */
async function provisioned(fx: Fixture, amount: string): Promise<void> {
  await createJournalEntry(fx.entityId, '2026-06-30', JournalEntryType.ADJUSTING, 'PTU provision to date', [
    { account_id: fx.cuentas['6117'], debit_amount: amount, credit_amount: null, description: 'PTU' },
    { account_id: fx.cuentas['2205'], debit_amount: null, credit_amount: amount, description: 'PTU' },
  ], fx.userId, { autoPost: true });
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-298 · ptu close');
  await seedPolicies({ tenantId: f.tenantId });
}, 180_000);

afterAll(async () => {
  await query(`DELETE FROM legal_parameters WHERE jurisdiction = 'MX' AND key = 'ptu.rate' AND effective_from = $1`, [SYNTHETIC_RATE_FROM]);
  await closeDatabase();
});

describe('ptu close', () => {
  it('a new entity gets 6117 and the two roles', () => {
    expect(f.roles.provision_ptu).toBe(f.cuentas['2205']);
    expect(f.roles.ptu_gasto).toBe(f.cuentas['6117']);
  });

  it('refuses without period 13 and without the rate row, and writes nothing', async () => {
    const noPeriod = await cli(close(), f);
    expect(noPeriod.exitCode).toBe(4);
    expect(noPeriod.err).toContain('year-end adjustment period (13)');
    await withPeriod13(f);
    const noRate = await cli(close(), f);
    expect(noRate.exitCode).toBe(4);
    expect(noRate.err).toContain('The PTU percentage (ptu.rate) is not in force on 2026-12-31');
    expect(await ptuEntries(f)).toEqual([]);
    await query(
      `INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
       VALUES ('MX', 'ptu.rate', $1, '0.1000', 'rate', 'https://example.test/synthetic-ptu-rate', 'Synthetic row of MNE-001-298 spec')`,
      [SYNTHETIC_RATE_FROM]
    );
  }, 120_000);

  it('the dry run shows 1,106,000.00 and 110,600.00 and writes nothing', async () => {
    const dry = await cli(close({}, ['--dry-run']), f);
    expect(dry.exitCode, dry.err).toBe(0);
    expect(rowOf(dry)).toMatchObject({ outcome: 'dry_run', base: '1106000.0000', ptu: '110600.00', adjustment: '110600.00', entry_number: null });
    expect(await ptuEntries(f)).toEqual([]);
  }, 60_000);

  it('leaves one draft in period 13, DR 6117 / CR 2205, with the figures and their source', async () => {
    const run = await cli(close(), f);
    expect(run.exitCode, run.err).toBe(0);
    expect(rowOf(run)).toMatchObject({ outcome: 'proposed', ptu: '110600.00', provisioned: '0.0000' });
    const [entry] = await ptuEntries(f);
    const p13 = (await query<{ id: string }>(
      'SELECT id FROM fiscal_periods WHERE entity_id = $1 AND period_number = 13', [f.entityId])).rows[0].id;
    expect(entry).toMatchObject({ status: 'draft', fiscal_period_id: p13, entry_number: rowOf(run).entry_number });
    expect(entry.lines.map(({ code, debit, credit }) => ({ code, debit, credit }))).toEqual([
      { code: '6117', debit: '110600.0000', credit: null },
      { code: '2205', debit: null, credit: '110600.0000' },
    ]);
    expect(entry.lines[0].meta).toMatchObject({
      year: 2026, base: '1106000.0000', ptu: '110600.00', provisioned: '0.0000', provision_cap: 'gross',
      figures: { accumulable_income: '5000000.0000', authorized_deductions: '3800000.0000',
        non_deductible_exempt_pay: '94000.0000', source: FIGURES.source },
      rate: { key: 'ptu.rate', value: '0.1000', effective_from: SYNTHETIC_RATE_FROM },
    });
  }, 60_000);

  it('the same figures again find the draft; other figures are refused naming it', async () => {
    const [entry] = await ptuEntries(f);
    const again = await cli(close(), f);
    expect(again.exitCode, again.err).toBe(0);
    expect(rowOf(again)).toMatchObject({ outcome: 'exists', entry_number: entry.entry_number, ptu: '110600.00' });
    const told = await cli(close().filter((a) => a !== '--json'), f);
    expect(told.err).toContain(`already entry ${entry.entry_number} (draft)`);
    const other = await cli(close({ 'authorized-deductions': '3700000' }), f);
    expect(other.exitCode).toBe(4);
    expect(other.err).toContain(`mnemosine entry void ${entry.entry_number}`);
    expect(await ptuEntries(f)).toHaveLength(1);
  }, 60_000);

  it('after 96,000.00 provisioned the draft is the 14,600.00 true-up; after 120,000.00 it reverses 9,400.00', async () => {
    const short = await crearEntidadHermana(f, 'MNE-001-298 · provisioned short');
    await withPeriod13(short);
    await provisioned(short, '96000.0000');
    const up = await cli(close(), short);
    expect(up.exitCode, up.err).toBe(0);
    expect(rowOf(up)).toMatchObject({ provisioned: '96000.0000', adjustment: '14600.00' });
    expect((await ptuEntries(short))[0].lines.map((l) => [l.code, l.debit, l.credit])).toEqual(
      [['6117', '14600.0000', null], ['2205', null, '14600.0000']]);

    const over = await crearEntidadHermana(f, 'MNE-001-298 · provisioned over');
    await withPeriod13(over);
    await provisioned(over, '120000.0000');
    const down = await cli(close(), over);
    expect(rowOf(down)).toMatchObject({ provisioned: '120000.0000', adjustment: '-9400.00' });
    expect((await ptuEntries(over))[0].lines.map((l) => [l.code, l.debit, l.credit])).toEqual(
      [['2205', '9400.0000', null], ['6117', null, '9400.0000']]);
  }, 180_000);

  it('a regime other than 601 is refused', async () => {
    const resico = await crearEntidadHermana(f, 'MNE-001-298 · RESICO');
    await withPeriod13(resico);
    await query(`UPDATE legal_entities SET tax_regime = '626' WHERE id = $1`, [resico.entityId]);
    const r = await cli(close(), resico);
    expect(r.exitCode).toBe(4);
    expect(r.err).toContain('tax regime 626');
    expect(await ptuEntries(resico)).toEqual([]);
  }, 120_000);
});
