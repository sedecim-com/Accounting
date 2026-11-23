import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { entityScope, type EntityScope } from '../../src/database/scope.js';
import { registerFilingRecordCommand } from '../../src/cli/filing-record-command.js';
import { recordFiledReturn, type FiledReturnFiling } from '../../src/services/fiscal/filed-returns.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import type { AppError } from '../../src/utils/errors.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-613 · #308 — THE WRITER CREDITS NO MORE THAN IS LEFT (LIVA art. 6),
// AGAINST POSTGRES. Risk 1 of #904: recordFiledReturn reads, inside its own
// transaction and under an advisory lock on the entity and the obligation,
// what balancesInFavorBefore says each earlier balance still holds, and
// refuses by key a credit above it. All data synthetic; figures by hand.
//
// Tenant A:
//   July    OP-SYN-0701  5,000.00 in favour
//   August  OP-SYN-0801  credits 3,000.00            → July keeps 2,000.00
//   September credits 2,000.01 → refused; 2,000.00 → accepted, July keeps 0.00
//   August's amendment OP-SYN-0802 credits 3,000.00 again: its predecessor's
//     3,000.00 is not counted, 5,000.00 − 2,000.00 = 3,000.00 → accepted;
//     3,000.01 → refused
//   July's amendment to 4,999.99 < 3,000.00 + 2,000.00 used → refused, naming
//     OP-SYN-0802 and OP-SYN-0901 (not the replaced 0801); at 5,000.00 → accepted
//   June OP-SYN-0601 100.00; October credits 1.00 in an open transaction,
//     November asks 100.00 and waits; after October commits: 99.00 left → refused
//
// Tenant B:
//   May   OP-SYN-B0501  400.00, refund requested 400.00     → 0.00 left
//   June  OP-SYN-B0601  1,000.00, compensated 300.00         → 700.00 left
// ============================================================

let a: Fixture;
let b: Fixture;
let sa: EntityScope;
let sb: EntityScope;

const iva = (x: Omit<FiledReturnFiling, 'obligation'>): FiledReturnFiling => ({ obligation: 'iva_monthly', ...x });
const credit = (sourceAcknowledgement: string, amount: string) => ({ sourceAcknowledgement, amount });

const refusalOf = async (p: Promise<unknown>) => {
  const err = (await p.then(() => null, (e: unknown) => e)) as AppError | null;
  expect(err, 'expected a refusal').not.toBeNull();
  return {
    status: err!.statusCode, key: err!.messageKey?.key, params: err!.messageKey?.params,
    en: err!.localized('en'), es: err!.localized('es'),
  };
};

const rowsOf = async (entity: string): Promise<number> =>
  Number((await query<{ n: string }>(
    `SELECT (SELECT count(*) FROM filed_tax_returns WHERE entity_id = $1)
          + (SELECT count(*) FROM filed_tax_return_credits WHERE entity_id = $1) AS n`, [entity]
  )).rows[0].n);

async function use(f: Fixture, kind: 'refund_request' | 'compensation', ack: string, amount: string, offset: string | null) {
  await query(
    `INSERT INTO tax_balance_uses (entity_id, obligation, kind, source_return_id, source_period, used_on, amount, reference, offset_period)
     SELECT entity_id, obligation, $2, id, period, '2026-08-20', $3, $4, $5::date
       FROM filed_tax_returns WHERE entity_id = $1 AND acknowledgement_number = $6`,
    [f.entityId, kind, amount, `REF-SYN-${ack}`, offset, ack]
  );
}

const JULY = iva({ period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-0701', balanceInFavor: '5000.00' });
const AUGUST = iva({ period: '2026-08', filedOn: '2026-09-15', acknowledgementNumber: 'OP-SYN-0801', amountPayable: '5000.00',
  credits: [credit('OP-SYN-0701', '3000.00')] });
/** September: 2,500.00 of IVA less what it credits from July. */
const september = (amount: string) => iva({ period: '2026-09', filedOn: '2026-10-14', acknowledgementNumber: 'OP-SYN-0901',
  amountPayable: '500.00', credits: [credit('OP-SYN-0701', amount)] });

beforeAll(async () => {
  a = await crearInquilino('MNE-001-613 A');
  b = await crearInquilino('MNE-001-613 B');
  sa = entityScope(a.tenantId, a.entityId);
  sb = entityScope(b.tenantId, b.entityId);
  await recordFiledReturn(sa, JULY);
  await recordFiledReturn(sa, AUGUST);

  for (const filing of [
    iva({ period: '2026-05', filedOn: '2026-06-14', acknowledgementNumber: 'OP-SYN-B0501', balanceInFavor: '400.00' }),
    iva({ period: '2026-06', filedOn: '2026-07-14', acknowledgementNumber: 'OP-SYN-B0601', balanceInFavor: '1000.00' }),
  ]) await recordFiledReturn(sb, filing);
  await use(b, 'refund_request', 'OP-SYN-B0501', '400.00', null);
  await use(b, 'compensation', 'OP-SYN-B0601', '300.00', '2026-07-01');
  // June's amendment keeps 1,000.00: 300.00 compensated is below it, so it is accepted.
  await recordFiledReturn(sb, iva({ period: '2026-06', filedOn: '2026-08-25', acknowledgementNumber: 'OP-SYN-B0602',
    balanceInFavor: '1000.00', replacesAcknowledgement: 'OP-SYN-B0601' }));
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('a credit is capped at what its balance still holds (LIVA art. 6)', () => {
  it('September cannot credit 2,000.01 of July\'s 2,000.00 left, and the refusal names the acuse, the ask and the available', async () => {
    const before = await rowsOf(a.entityId);
    const r = await refusalOf(recordFiledReturn(sa, september('2000.01')));
    expect(r).toMatchObject({
      status: 422, key: 'filed_return.credit_above_available',
      params: { acknowledgement: 'OP-SYN-0701', sourcePeriod: '2026-07', requested: '2000.01', available: '2000.00' },
    });
    for (const text of [r.en, r.es]) expect(text).toMatch(/OP-SYN-0701.*2000\.00.*2000\.01/s);
    expect(r.es).not.toBe(r.en);
    expect(await rowsOf(a.entityId)).toBe(before);
  });

  it('September credits exactly the 2,000.00 left', async () => {
    const saved = await recordFiledReturn(sa, september('2000.00'));
    expect(saved.credits).toEqual([{ sourceAcknowledgement: 'OP-SYN-0701', sourcePeriod: '2026-07', amount: '2000.00' }]);
  });

  it('an amendment of August is checked against what its predecessor did not use: 3,000.00 yes, 3,000.01 no', async () => {
    const amended = (amount: string) => iva({ period: '2026-08', filedOn: '2026-10-20', acknowledgementNumber: 'OP-SYN-0802',
      amountPayable: '5000.00', replacesAcknowledgement: 'OP-SYN-0801', credits: [credit('OP-SYN-0701', amount)] });
    expect(await refusalOf(recordFiledReturn(sa, amended('3000.01')))).toMatchObject({
      status: 422, key: 'filed_return.credit_above_available', params: { requested: '3000.01', available: '3000.00' },
    });
    const saved = await recordFiledReturn(sa, amended('3000.00'));
    expect(saved).toMatchObject({ returnType: 'amended', replacesAcknowledgement: 'OP-SYN-0801' });
  });

  it('an amendment of July below the 5,000.00 already credited is refused, naming the returns in force that used it', async () => {
    const july = (balance: string) => iva({ period: '2026-07', filedOn: '2026-11-03', acknowledgementNumber: 'OP-SYN-0702',
      balanceInFavor: balance, replacesAcknowledgement: 'OP-SYN-0701' });
    const before = await rowsOf(a.entityId);
    const r = await refusalOf(recordFiledReturn(sa, july('4999.99')));
    expect(r).toMatchObject({
      status: 422, key: 'filed_return.amended_below_used',
      params: { period: '2026-07', balance: '4999.99', used: '5000.00', credited: '5000.00', compensated: '0.00',
        returns: 'OP-SYN-0802, OP-SYN-0901' },
    });
    expect(r.en).not.toContain('OP-SYN-0801');
    expect(r.es).not.toBe(r.en);
    expect(await rowsOf(a.entityId)).toBe(before);
    expect(await recordFiledReturn(sa, july('5000.00'))).toMatchObject({ returnType: 'amended' });
  });

  it('two filings that credit the same balance run one after the other: the second reads what the first wrote', async () => {
    await recordFiledReturn(sa, iva({ period: '2026-06', filedOn: '2026-07-14', acknowledgementNumber: 'OP-SYN-0601',
      balanceInFavor: '100.00' }));
    let wrote!: () => void;
    let commit!: () => void;
    const written = new Promise<void>((r) => { wrote = r; });
    const gate = new Promise<void>((r) => { commit = r; });
    const october = withTransaction(async (c) => {
      await recordFiledReturn(sa, iva({ period: '2026-10', filedOn: '2026-11-10', acknowledgementNumber: 'OP-SYN-1001',
        amountPayable: '10.00', credits: [credit('OP-SYN-0601', '1.00')] }), c);
      wrote();
      await gate;
    });
    await written;
    let settled = false;
    const november = recordFiledReturn(sa, iva({ period: '2026-11', filedOn: '2026-12-10', acknowledgementNumber: 'OP-SYN-1101',
      amountPayable: '10.00', credits: [credit('OP-SYN-0601', '100.00')] }));
    void november.then(() => { settled = true; }, () => { settled = true; });
    // November waits on the lock while October is open. Without the lock it reads 100.00 left and writes.
    const waiting = async () => Number((await query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n) > 0;
    try {
      for (let i = 0; i < 400 && !settled && !(await waiting()); i++) await new Promise((r) => setTimeout(r, 25));
      expect(settled, 'November must wait for October').toBe(false);
    } finally {
      commit();
      await october;
    }
    expect(await refusalOf(november)).toMatchObject({
      status: 422, key: 'filed_return.credit_above_available',
      params: { acknowledgement: 'OP-SYN-0601', requested: '100.00', available: '99.00' },
    });
  }, 60_000);
});

describe('a refund request and a compensation leave less to credit', () => {
  it('May\'s balance, asked back whole, has nothing left: 0.01 is refused', async () => {
    expect(await refusalOf(recordFiledReturn(sb, iva({
      period: '2026-08', filedOn: '2026-09-14', acknowledgementNumber: 'OP-SYN-B0801', amountPayable: '100.00',
      credits: [credit('OP-SYN-B0501', '0.01')],
    })))).toMatchObject({ status: 422, key: 'filed_return.credit_above_available', params: { available: '0.00' } });
  });

  it('two credits from June\'s original and its amendment share June\'s 700.00: 400.00 and 300.01 refuse the second', async () => {
    const before = await rowsOf(b.entityId);
    const r = await refusalOf(recordFiledReturn(sb, iva({
      period: '2026-08', filedOn: '2026-09-14', acknowledgementNumber: 'OP-SYN-B0801', amountPayable: '100.00',
      credits: [credit('OP-SYN-B0601', '400.00'), credit('OP-SYN-B0602', '300.01')],
    })));
    expect(r).toMatchObject({
      key: 'filed_return.credit_above_available',
      params: { acknowledgement: 'OP-SYN-B0602', sourcePeriod: '2026-06', requested: '300.01', available: '300.00' },
    });
    expect(await rowsOf(b.entityId)).toBe(before);
  });

  it('July credits 1,000.00 − 300.00 compensated = 700.00, and not 700.01', async () => {
    const july = (amount: string) => iva({ period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-B0701',
      amountPayable: '50.00', credits: [credit('OP-SYN-B0602', amount)] });
    expect(await refusalOf(recordFiledReturn(sb, july('700.01')))).toMatchObject({ params: { available: '700.00' } });
    expect((await recordFiledReturn(sb, july('700.00'))).credits).toHaveLength(1);
  });

  it('a credit naming another tenant\'s return is still unknown', async () => {
    expect(await refusalOf(recordFiledReturn(sb, iva({
      period: '2026-09', filedOn: '2026-10-14', acknowledgementNumber: 'OP-SYN-B0901', amountPayable: '1.00',
      credits: [credit('OP-SYN-0701', '1.00')],
    })))).toMatchObject({ status: 422, key: 'filed_return.credit_source_unknown' });
  });
});

describe('filing record says the refusal with exit 4, also in a rehearsal', () => {
  const same = (x: string): string => x;
  const plain = { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same };

  async function cli(argv: string[], fx: Fixture, email: string): Promise<{ exitCode?: number; err: string }> {
    const r: { exitCode?: number; err: string } = { err: '' };
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
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

  it('September crediting OP-SYN-0701:2000.01 exits 4 with and without --dry-run, and writes nothing', async () => {
    await seedPolicies({ tenantId: a.tenantId });
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [a.userId])).rows[0].email;
    const s = await crearEntidadHermana(a, 'MNE-001-613 · filing record');
    const ss = entityScope(s.tenantId, s.entityId);
    await recordFiledReturn(ss, JULY);
    await recordFiledReturn(ss, AUGUST);
    const before = await rowsOf(s.entityId);
    const argv = ['filing', 'record', '--form=iva', '--period=2026-09', '--filed-on=2026-10-14', '--acuse=OP-SYN-0901',
      '--payable=500.00', '--credit=OP-SYN-0701:2000.01'];
    for (const extra of [['--dry-run'], []]) {
      const r = await cli([...argv, ...extra], s, email);
      expect(r.exitCode, r.err).toBe(4);
      expect(r.err).toMatch(/OP-SYN-0701 \(2026-07\) has 2000\.00 .*2000\.01 cannot be credited/s);
    }
    expect(await rowsOf(s.entityId)).toBe(before);
  }, 120_000);
});
