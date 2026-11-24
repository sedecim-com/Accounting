import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { registerFilingRecordCommand } from '../../src/cli/filing-record-command.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { filedReturnInForce, recordFiledReturn } from '../../src/services/fiscal/filed-returns.js';
import { generateFilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { ConflictError, type AppError } from '../../src/utils/errors.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-629 (#308) · AN AMENDED IVA RETURN, FROM THE TERMINAL
//
// `filing correct` through the leaf, against a migrated Postgres: it writes
// through recordFiledReturn a new row that names, by its acuse, the return it
// replaces (CFF art. 32), keeps both, and the readers take the month from the
// amended one. The returns are invented and every figure is worked by hand.
//
// The entity sells 50,000.00 at 16 % (PUE) in September: 8,000.00 of IVA, the cap.
//   July  OP-SYN-0701  5,000.00 in favour → September credits 5,000.00, pays 3,000.00
//   July  OP-SYN-0702  amends it to 4,200.00 → September credits 4,200.00, pays 3,800.00
// ============================================================

let f: Fixture;
let email: string;

const same = (x: string): string => x;
const plain = { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same };

interface CliResult { exitCode?: number; out: string; err: string }

/** Runs a leaf of the family as `fx`'s entity; stdout, stderr and the reported error are kept. */
async function cli(argv: string[], fx: Fixture): Promise<CliResult> {
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
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', fx.entityId, '-t', fx.tenantId, '-u', email]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return r;
}

type Flags = Record<string, string | undefined>;
const leaf = (name: 'record' | 'correct') => (flags: Flags, extra: string[] = []): string[] => [
  'filing', name,
  ...Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}=${v}`])),
  ...extra,
];
const record = leaf('record');
const correct = leaf('correct');

/** July 2026: filed 2026-08-14, it left 5,000.00 in favour. */
const JULY = { form: 'iva', period: '2026-07', 'filed-on': '2026-08-14', acuse: 'OP-SYN-0701', 'in-favor': '5000.00' };
/** Its amendment, filed 2026-09-10: the balance in favour was 4,200.00, not 5,000.00. */
const JULY_AMENDED = { ...JULY, 'filed-on': '2026-09-10', acuse: 'OP-SYN-0702', replaces: 'OP-SYN-0701', 'in-favor': '4200.00' };
/** August: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 payable, paid the next day. */
const AUGUST = {
  form: 'iva', period: '2026-08', 'filed-on': '2026-09-15', acuse: 'OP-SYN-0801', 'capture-line': 'LC-SYN-0801',
  payable: '5000.00', paid: '5000.00', 'paid-on': '2026-09-16', credit: 'OP-SYN-0701:3000.00',
};

const count = async (entityId: string): Promise<{ returns: number; credits: number }> => {
  const r = await query<{ returns: string; credits: string }>(
    `SELECT (SELECT count(*) FROM filed_tax_returns WHERE entity_id = $1) AS returns,
            (SELECT count(*) FROM filed_tax_return_credits WHERE entity_id = $1) AS credits`,
    [entityId]
  );
  return { returns: Number(r.rows[0].returns), credits: Number(r.rows[0].credits) };
};
const rowOf = (r: CliResult): Record<string, unknown> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
const inForce = (fx: Fixture, period: string) =>
  filedReturnInForce(entityScope(fx.tenantId, fx.entityId), 'iva_monthly', period);

/** September's IVA paper: the prior balance it credits, the returns it traces it to, and what is left to pay. */
async function september(fx: Fixture) {
  const wp = await generateFilingWorkpaper({ tenantId: fx.tenantId, entityId: fx.entityId, year: 2026, month: 9, forms: ['iva'] });
  const section = wp.sections[0];
  const line = section.lines.find((l) => l.key === 'prior_balance_in_favor')!;
  const source = line.source as { kind: string; returns?: Array<{ acknowledgementNumber: string; amount: string }> };
  return { credited: line.cents, returns: source.returns, result: section.resultWhole };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-629 · filing correct');
  await seedPolicies({ tenantId: f.tenantId });
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;

  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-629', 'Cliente Sintético SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: '2026-09-05', due_date: '2026-09-05',
    currency_code: 'MXN', terms: 'PUE', created_by: f.userId,
    lines: [{ revenue_account_id: f.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: '50000', tax_rate: '16' }],
  });
  await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('filing correct --form iva --replaces <acuse>', () => {
  it('September\'s paper takes July\'s balance from the amended return, not from the one it replaced', async () => {
    expect((await cli(record(JULY), f)).exitCode).toBe(0);
    // 8,000.00 − 5,000.00 = 3,000.00
    expect(await september(f)).toEqual({
      credited: '5000.00', returns: [{ acknowledgementNumber: 'OP-SYN-0701', period: '2026-07', amount: '5000.00' }], result: '3000',
    });

    const r = await cli(correct(JULY_AMENDED, ['--json']), f);
    expect(r.exitCode, r.err).toBe(0);
    expect(rowOf(r)).toMatchObject({
      form: 'iva', period: '2026-07', return_type: 'amended', replaces: 'OP-SYN-0701', filed_on: '2026-09-10',
      acuse: 'OP-SYN-0702', payable: '0.00', in_favor: '4200.00', credits: '', recorded_by: email, dry_run: false,
    });

    // Both rows are kept, and the one in force is the amended one.
    const kept = await query<{ ack: string; type: string }>(
      `SELECT acknowledgement_number AS ack, return_type AS type FROM filed_tax_returns WHERE entity_id = $1 ORDER BY seq`,
      [f.entityId]);
    expect(kept.rows).toEqual([{ ack: 'OP-SYN-0701', type: 'original' }, { ack: 'OP-SYN-0702', type: 'amended' }]);
    expect(await inForce(f, '2026-07')).toMatchObject({
      id: rowOf(r).id, acknowledgementNumber: 'OP-SYN-0702', replacesAcknowledgement: 'OP-SYN-0701', balanceInFavor: '4200.00',
    });

    // 8,000.00 − 4,200.00 = 3,800.00
    expect(await september(f)).toEqual({
      credited: '4200.00', returns: [{ acknowledgementNumber: 'OP-SYN-0702', period: '2026-07', amount: '4200.00' }], result: '3800',
    });
  }, 240_000);

  it('holds the rules of MNE-001-613: what later months credited stays covered, and is not counted twice', async () => {
    const b = await crearEntidadHermana(f, 'MNE-001-629 · the rules of 613');
    expect((await cli(record(JULY), b)).exitCode).toBe(0);
    expect((await cli(record(AUGUST), b)).exitCode).toBe(0);

    // August credited 3,000.00 of July: 2,999.99 in favour would leave it one cent short.
    for (const extra of [[], ['--dry-run']]) {
      const short = await cli(correct({ ...JULY_AMENDED, 'in-favor': '2999.99' }, extra), b);
      expect(short.exitCode, short.err).toBe(4);
      expect(short.err).toMatch(/leaves 2999\.99 in favour for 2026-07, but 3000\.00 of that balance is already used/);
      expect(short.err).toContain('OP-SYN-0801');
      expect(await count(b.entityId)).toEqual({ returns: 2, credits: 1 });
    }
    // 3,000.00 covers it exactly.
    const exact = await cli(correct({ ...JULY_AMENDED, 'in-favor': '3000.00' }), b);
    expect(exact.exitCode, exact.err).toBe(0);

    // August amended: 8,500.00 of IVA less 3,000.00 = 5,500.00 payable, 500.00 more than was paid. The 3,000.00
    // its replaced return credited are free again, and no more.
    const augustAmended = {
      ...AUGUST, 'filed-on': '2026-10-02', acuse: 'OP-SYN-0802', replaces: 'OP-SYN-0801', 'capture-line': 'LC-SYN-0802',
      payable: '5500.00', paid: '500.00', 'paid-on': '2026-10-02',
    };
    const over = await cli(correct({ ...augustAmended, credit: 'OP-SYN-0702:3000.01' }), b);
    expect(over.exitCode, over.err).toBe(4);
    expect(over.err).toMatch(/OP-SYN-0702 \(2026-07\) has 3000\.00 of its balance in favour left to credit/);
    const again = await cli(correct({ ...augustAmended, credit: 'OP-SYN-0702:3000.00' }, ['--json']), b);
    expect(again.exitCode, again.err).toBe(0);
    expect(rowOf(again)).toMatchObject({
      return_type: 'amended', replaces: 'OP-SYN-0801', payable: '5500.00', paid: '500.00', credits: 'OP-SYN-0702:3000.00',
    });
    expect(await count(b.entityId)).toEqual({ returns: 4, credits: 2 });
    expect((await inForce(b, '2026-08'))?.acknowledgementNumber).toBe('OP-SYN-0802');
  }, 240_000);

  it('--dry-run prints the row and writes nothing; what is not an amendment of the return in force is refused in words; the chain goes on from its last link', async () => {
    const d = await crearEntidadHermana(f, 'MNE-001-629 · the chain');
    expect((await cli(record(JULY), d)).exitCode).toBe(0);
    const dry = await cli(correct(JULY_AMENDED, ['--dry-run', '--json']), d);
    expect(dry.exitCode, dry.err).toBe(0);
    expect(rowOf(dry)).toMatchObject({
      id: '', return_type: 'amended', replaces: 'OP-SYN-0701', acuse: 'OP-SYN-0702', in_favor: '4200.00',
      recorded_at: '', dry_run: true,
    });
    expect(await count(d.entityId)).toEqual({ returns: 1, credits: 0 });
    expect((await inForce(d, '2026-07'))?.acknowledgementNumber).toBe('OP-SYN-0701');

    const refusals: Array<[Flags, number, RegExp]> = [
      [{ ...JULY_AMENDED, replaces: undefined }, 2, /--replaces/],
      [{ ...JULY_AMENDED, replaces: 'OP-SYN-9999' }, 4, /No return with operation number OP-SYN-9999/],
      [{ ...JULY_AMENDED, period: '2026-08', 'filed-on': '2026-09-15' }, 4, /OP-SYN-0701 covers 2026-07/],
      [{ ...JULY_AMENDED, 'filed-on': '2026-08-13' }, 4, /before return OP-SYN-0701/],
    ];
    for (const [flags, exit, says] of refusals) {
      const r = await cli(correct(flags), d);
      expect(r.exitCode, r.err).toBe(exit);
      expect(r.err).toMatch(says);
      expect(r.err).not.toMatch(/constraint|violates|_check|filed_tax_returns/);
      expect(await count(d.entityId)).toEqual({ returns: 1, credits: 0 });
    }

    const real = await cli(correct(JULY_AMENDED), d);
    expect(real.exitCode, real.err).toBe(0);
    expect(real.err).toContain('OP-SYN-0702 replaces OP-SYN-0701 and is the 2026-07 return in force');
    expect(real.err).toContain('Nothing was sent to the SAT');
    // OP-SYN-0701 is no longer in force: a second amendment of it is a conflict.
    const branch = await cli(correct({ ...JULY_AMENDED, acuse: 'OP-SYN-0703', 'filed-on': '2026-09-20' }), d);
    expect(branch.exitCode).toBe(6);
    expect(branch.err).toMatch(/OP-SYN-0701 was already replaced/);
    const next = await cli(correct({ ...JULY_AMENDED, acuse: 'OP-SYN-0703', 'filed-on': '2026-09-20', replaces: 'OP-SYN-0702' }), d);
    expect(next.exitCode, next.err).toBe(0);
    expect(await count(d.entityId)).toEqual({ returns: 3, credits: 0 });
    expect((await inForce(d, '2026-07'))?.acknowledgementNumber).toBe('OP-SYN-0703');
  }, 240_000);

  it('two corrections of one return at once: one is written, the other is the conflict', async () => {
    const e = await crearEntidadHermana(f, 'MNE-001-629 · two at once');
    expect((await cli(record(JULY), e)).exitCode).toBe(0);
    const amend = (acknowledgementNumber: string) => recordFiledReturn(entityScope(e.tenantId, e.entityId), {
      obligation: 'iva_monthly', period: '2026-07', filedOn: '2026-09-10', acknowledgementNumber,
      balanceInFavor: '4200.00', replacesAcknowledgement: 'OP-SYN-0701',
    });
    const both = await Promise.allSettled([amend('OP-SYN-0702'), amend('OP-SYN-0703')]);
    expect(both.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = both.find((x): x is PromiseRejectedResult => x.status === 'rejected')!.reason as AppError;
    expect(lost).toBeInstanceOf(ConflictError);
    expect(lost.messageKey?.key).toBe('filed_return.already_replaced');
    expect(await count(e.entityId)).toEqual({ returns: 2, credits: 0 });
  }, 120_000);
});
