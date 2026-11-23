import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { registerFilingRecordCommand } from '../../src/cli/filing-record-command.js';
import { filedReturnInForce } from '../../src/services/fiscal/filed-returns.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-577 (#308, part 3/3) · A FILED IVA RETURN, FROM THE TERMINAL
//
// `filing record` through the leaf, against a migrated Postgres: it writes
// through recordFiledReturn (MNE-001-576) into migration 337's record, and
// filedReturnInForce reads back what it wrote. The returns are invented and
// every figure is worked by hand in its comment. A case that writes uses its
// own sibling entity; the refusals run on the bare one and leave it empty.
// ============================================================

let f: Fixture;
let other: Fixture;
let email: string;

const same = (x: string): string => x;
const plain = { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same };

interface Who { entity: string; tenant: string; user: string }
interface CliResult { exitCode?: number; out: string; err: string }

/** Runs the leaf; stdout, stderr and the reported error are kept. */
async function cli(argv: string[], who: Who): Promise<CliResult> {
  const r: CliResult = { out: '', err: '' };
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { r.out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { r.err += String(c); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerFilingRecordCommand(p, {
      palette: plain,
      shutdown: (c: number) => { r.exitCode = c; },
      reportError: (e: unknown) => { r.err += `${(e as Error).message}\n`; },
    });
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', who.entity, '-t', who.tenant, '-u', who.user]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return r;
}
const me = (fx: Fixture = f): Who => ({ entity: fx.entityId, tenant: fx.tenantId, user: email });

/** July 2026: filed 2026-08-14, it left 5,000.00 in favour. */
const JULY = { form: 'iva', period: '2026-07', 'filed-on': '2026-08-14', acuse: 'OP-SYN-0701', 'in-favor': '5000.00' };
/** August: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 payable, paid the next day. */
const AUGUST = {
  form: 'iva', period: '2026-08', 'filed-on': '2026-09-15', acuse: 'OP-SYN-0801', 'capture-line': 'LC-SYN-0801',
  payable: '5000.00', paid: '5000.00', 'paid-on': '2026-09-16', credit: 'OP-SYN-0701:3000.00',
};

/** `filing record` with these flags; a flag set to undefined is left out. */
const record = (flags: Record<string, string | undefined>, extra: string[] = []): string[] => [
  'filing', 'record',
  ...Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}=${v}`])),
  ...extra,
];

const count = async (entityId: string): Promise<{ returns: number; credits: number }> => {
  const r = await query<{ returns: string; credits: string }>(
    `SELECT (SELECT count(*) FROM filed_tax_returns WHERE entity_id = $1) AS returns,
            (SELECT count(*) FROM filed_tax_return_credits WHERE entity_id = $1) AS credits`,
    [entityId]
  );
  return { returns: Number(r.rows[0].returns), credits: Number(r.rows[0].credits) };
};
const NOTHING = { returns: 0, credits: 0 };

const rowOf = (r: CliResult): Record<string, unknown> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];

beforeAll(async () => {
  other = await crearInquilino('MNE-001-577 · the other tenant');
  f = await crearInquilino('MNE-001-577 · filing record');
  await seedPolicies({ tenantId: f.tenantId });
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
}, 180_000);

afterAll(() => closeDatabase());

describe('filing record --form iva', () => {
  it('records July with its balance, then August with the 3,000.00 it credited, and the reader finds August in force', async () => {
    const a = await crearEntidadHermana(f, 'MNE-001-577 · July and August');
    const july = await cli(record(JULY, ['--json']), me(a));
    expect(july.exitCode, july.err).toBe(0);
    expect(rowOf(july)).toMatchObject({
      form: 'iva', period: '2026-07', return_type: 'original', filed_on: '2026-08-14', acuse: 'OP-SYN-0701',
      capture_line: null, payable: '0.00', in_favor: '5000.00', paid: null, paid_on: null, credits: '',
      recorded_by: email, dry_run: false,
    });
    expect(rowOf(july).id).toMatch(/^[0-9a-f-]{36}$/);

    const august = await cli(record(AUGUST, ['--json']), me(a));
    expect(august.exitCode, august.err).toBe(0);
    expect(rowOf(august)).toMatchObject({
      period: '2026-08', acuse: 'OP-SYN-0801', capture_line: 'LC-SYN-0801', payable: '5000.00', in_favor: '0.00',
      paid: '5000.00', paid_on: '2026-09-16', credits: 'OP-SYN-0701:3000.00', dry_run: false,
    });
    expect(await count(a.entityId)).toEqual({ returns: 2, credits: 1 });

    const inForce = await filedReturnInForce(entityScope(a.tenantId, a.entityId), 'iva_monthly', '2026-08');
    expect(inForce).toMatchObject({
      id: rowOf(august).id, acknowledgementNumber: 'OP-SYN-0801', amountPayable: '5000.00',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', sourcePeriod: '2026-07', amount: '3000.00' }],
    });
    const recordedBy = await query<{ recorded_by: string }>(
      'SELECT recorded_by FROM filed_tax_returns WHERE entity_id = $1 ORDER BY seq', [a.entityId]);
    expect(recordedBy.rows.map((x) => x.recorded_by)).toEqual([f.userId, f.userId]);
  }, 120_000);

  it('takes --credit more than once, in order: September credits 1,200.00 from June and 2,000.00 from July', async () => {
    const b = await crearEntidadHermana(f, 'MNE-001-577 · two credits');
    // June left 1,200.00 in favour; July 5,000.00.
    const june = { ...JULY, period: '2026-06', 'filed-on': '2026-07-17', acuse: 'OP-SYN-0601', 'in-favor': '1200.00' };
    expect((await cli(record(june), me(b))).exitCode).toBe(0);
    expect((await cli(record(JULY), me(b))).exitCode).toBe(0);
    // September: 4,000.00 of IVA less 1,200.00 and 2,000.00 credited = 800.00 payable, not paid yet.
    const r = await cli([
      ...record({ form: 'iva', period: '2026-09', 'filed-on': '2026-10-16', acuse: 'OP-SYN-0901', payable: '800' }),
      '--credit', 'OP-SYN-0601:1200', '--credit', 'OP-SYN-0701:2000.00', '--json',
    ], me(b));
    expect(r.exitCode, r.err).toBe(0);
    expect(rowOf(r)).toMatchObject({ payable: '800.00', paid: null, credits: 'OP-SYN-0601:1200.00 OP-SYN-0701:2000.00' });
    expect(await count(b.entityId)).toEqual({ returns: 3, credits: 2 });
  }, 120_000);

  it('the table names the return in force and says nothing was sent to the SAT', async () => {
    const c = await crearEntidadHermana(f, 'MNE-001-577 · the table');
    const r = await cli(record(JULY), me(c));
    expect(r.exitCode, r.err).toBe(0);
    expect(r.out).toContain('OP-SYN-0701');
    expect(r.err).toContain('OP-SYN-0701 is the 2026-07 return in force');
    expect(r.err).toContain('Nothing was sent to the SAT');
  }, 120_000);

  it('--dry-run --json prints the row a real run would leave, hears the rules between rows, and writes nothing', async () => {
    const d = await crearEntidadHermana(f, 'MNE-001-577 · dry run');
    const dry = await cli(record(JULY, ['--dry-run', '--json']), me(d));
    expect(dry.exitCode, dry.err).toBe(0);
    expect(rowOf(dry)).toMatchObject({ id: '', acuse: 'OP-SYN-0701', in_favor: '5000.00', recorded_at: '', dry_run: true });
    expect(await count(d.entityId)).toEqual(NOTHING);
    // July is not recorded, so a rehearsal of August that credits it is refused like the real run.
    const august = await cli(record(AUGUST, ['--dry-run']), me(d));
    expect(august.exitCode).toBe(4);
    expect(august.err).toMatch(/No return with operation number OP-SYN-0701/);
    expect(await count(d.entityId)).toEqual(NOTHING);
  }, 120_000);

  it('the same acuse twice, and a second return for a month, are a conflict in words and leave one row', async () => {
    const e = await crearEntidadHermana(f, 'MNE-001-577 · twice');
    expect((await cli(record(JULY), me(e))).exitCode).toBe(0);
    const again = await cli(record(JULY), me(e));
    expect(again.exitCode).toBe(6);
    expect(again.err).toMatch(/OP-SYN-0701 is already recorded/);
    const second = await cli(record({ ...JULY, acuse: 'OP-SYN-0702' }), me(e));
    expect(second.exitCode).toBe(6);
    expect(second.err).toMatch(/2026-07 return of this tax is already recorded/);
    expect(await count(e.entityId)).toEqual({ returns: 1, credits: 0 });
  }, 120_000);

  it.each<[string, Record<string, string | undefined>, number, RegExp]>([
    ['no --form', { form: undefined }, 2, /--form/],
    ['the provisional ISR', { form: 'isr' }, 2, /--form.*isr/],
    ['a period that is not a month', { period: '2026-13' }, 2, /--period.*2026-13/],
    ['a filing date that is not a day', { 'filed-on': '2026-09-31' }, 2, /--filed-on.*2026-09-31/],
    ['no --acuse', { acuse: undefined }, 2, /--acuse/],
    ['--payable and --in-favor together', { 'in-favor': '0' }, 2, /--payable.*--in-favor/],
    ['neither --payable nor --in-favor', { payable: undefined }, 2, /--payable.*--in-favor/],
    ['an amount with three decimals', { payable: '5000.001' }, 2, /--payable.*5000\.001/],
    ['--paid without --paid-on', { 'paid-on': undefined }, 2, /--paid-on/],
    ['a credit that is not acuse:amount', { credit: 'OP-SYN-0701' }, 2, /--credit.*OP-SYN-0701/],
    ['a return filed before its month ends', { 'filed-on': '2026-08-31' }, 4, /on 2026-09-01 or later/],
    ['a payment before the filing', { 'paid-on': '2026-09-14' }, 4, /payment on 2026-09-14 comes before the filing/],
    ['a return filed after today', { period: '2099-12', 'filed-on': '2100-01-15', 'paid-on': '2100-01-16' }, 4, /--filed-on 2100-01-15 is after today/],
    ['a payment after today', { 'paid-on': '2100-01-01' }, 4, /--paid-on 2100-01-01 is after today/],
    ['a credit of a return not recorded', {}, 4, /No return with operation number OP-SYN-0701/],
  ])('refuses %s in words and writes nothing', async (_, change, exit, says) => {
    const r = await cli(record({ ...AUGUST, ...change }), me());
    expect(r.exitCode, r.err).toBe(exit);
    expect(r.err).toMatch(says);
    expect(r.err).not.toMatch(/constraint|violates|_check|filed_tax_returns/);
    expect(await count(f.entityId)).toEqual(NOTHING);
  });

  it('refuses a credit from the same month, and from a return with no balance, by the service\'s keys', async () => {
    const g = await crearEntidadHermana(f, 'MNE-001-577 · credits refused');
    // August's own original paid 5,000.00 and left nothing in favour.
    expect((await cli(record({ ...AUGUST, credit: undefined }), me(g))).exitCode).toBe(0);
    const sameMonth = await cli(record({ ...AUGUST, period: '2026-08', acuse: 'OP-SYN-0802', credit: 'OP-SYN-0801:10' }), me(g));
    expect(sameMonth.exitCode).toBe(4);
    expect(sameMonth.err).toMatch(/earlier months only \(LIVA art\. 6\)/);
    const noBalance = await cli(record({
      ...AUGUST, period: '2026-09', 'filed-on': '2026-10-16', 'paid-on': '2026-10-16', acuse: 'OP-SYN-0901',
      credit: 'OP-SYN-0801:10',
    }), me(g));
    expect(noBalance.exitCode).toBe(4);
    expect(noBalance.err).toMatch(/OP-SYN-0801 left no balance in favour/);
    expect(await count(g.entityId)).toEqual({ returns: 1, credits: 0 });
  }, 120_000);

  it('an entity of another tenant is refused by the context guard, and no tenant gets a row', async () => {
    const r = await cli(record(JULY), { ...me(), entity: other.entityId });
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toMatch(/pertenece al inquilino/);
    expect(await count(f.entityId)).toEqual(NOTHING);
    expect(await count(other.entityId)).toEqual(NOTHING);
  });
});
