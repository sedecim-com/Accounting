import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { entityScope, type EntityScope } from '../../src/database/scope.js';
import {
  filedReturnInForce,
  recordFiledReturn,
  type FiledReturnFiling,
} from '../../src/services/fiscal/filed-returns.js';
import type { AppError } from '../../src/utils/errors.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-576 · #308 — THE SERVICE OF FILED RETURNS, AGAINST POSTGRES.
//
// recordFiledReturn writes a monthly IVA return and the earlier balances it
// credited in one transaction; filedReturnInForce reads the last link of a
// period's chain. The two rules between rows that migration 337 leaves to
// the service (an amendment comes after the return it replaces; a credit
// comes from an earlier return that left a balance) and the three UNIQUE
// violations are refused in words. Two tenants; all data is synthetic and
// every figure is worked by hand in its comment.
// ============================================================

let a: Fixture;
let b: Fixture;
let sa: EntityScope;
let sb: EntityScope;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-576 A');
  b = await crearInquilino('MNE-001-576 B');
  sa = entityScope(a.tenantId, a.entityId);
  sb = entityScope(b.tenantId, b.entityId);
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

const iva = (x: Omit<FiledReturnFiling, 'obligation'>): FiledReturnFiling => ({ obligation: 'iva_monthly', ...x });

const keyOf = async (p: Promise<unknown>): Promise<{ status: number; key: string | undefined }> => {
  const err = (await p.then(() => null, (e: unknown) => e)) as AppError | null;
  expect(err).not.toBeNull();
  return { status: err!.statusCode, key: err!.messageKey?.key };
};

const rowsOf = async (entity: string): Promise<number> =>
  Number((await query<{ n: string }>(
    `SELECT (SELECT count(*) FROM filed_tax_returns WHERE entity_id = $1)
          + (SELECT count(*) FROM filed_tax_return_credits WHERE entity_id = $1) AS n`, [entity]
  )).rows[0].n);

describe('a period\'s chain, written and read through the service', () => {
  it('records July with its balance, and August with the 3,000.00 it credited from July', async () => {
    const july = await recordFiledReturn(sa, iva({
      period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-0701', balanceInFavor: '5000.00',
      recordedBy: a.userId,
    }));
    expect(july).toMatchObject({
      returnType: 'original', replacesAcknowledgement: null, balanceInFavor: '5000.00', amountPayable: '0.00',
      captureLine: null, amountPaid: null, paidOn: null, credits: [],
    });

    // August: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 payable, paid in full the next day.
    const august = await recordFiledReturn(sa, iva({
      period: '2026-08', filedOn: '2026-09-15', acknowledgementNumber: ' OP-SYN-0801 ', captureLine: 'LC-SYN-0801',
      amountPayable: '5000', amountPaid: '5000.0', paidOn: '2026-09-16',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '3000' }],
    }));
    expect(august).toMatchObject({
      obligation: 'iva_monthly', period: '2026-08', returnType: 'original', filedOn: '2026-09-15',
      acknowledgementNumber: 'OP-SYN-0801', amountPayable: '5000.00', balanceInFavor: '0.00',
      amountPaid: '5000.00', paidOn: '2026-09-16',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', sourcePeriod: '2026-07', amount: '3000.00' }],
    });
    expect(await filedReturnInForce(sa, 'iva_monthly', '2026-08')).toEqual(august);
  });

  it('an amendment is in force, the return it replaces stays, and its own credits are restated', async () => {
    // The amendment finds 9,200.00 of IVA: 9,200.00 - 3,000.00 credited = 6,200.00 payable.
    // 5,000.00 was paid with the original, so it pays 6,200.00 - 5,000.00 = 1,200.00.
    const amended = await recordFiledReturn(sa, iva({
      period: '2026-08', filedOn: '2026-10-02', acknowledgementNumber: 'OP-SYN-0802', captureLine: 'LC-SYN-0802',
      replacesAcknowledgement: 'OP-SYN-0801', amountPayable: '6200.00', amountPaid: '1200.00', paidOn: '2026-10-03',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '3000.00' }],
    }));
    const inForce = await filedReturnInForce(sa, 'iva_monthly', '2026-08');
    expect(inForce).toEqual(amended);
    expect(inForce).toMatchObject({
      returnType: 'amended', replacesAcknowledgement: 'OP-SYN-0801', amountPayable: '6200.00', amountPaid: '1200.00',
    });
    const chain = await query<{ ack: string }>(
      `SELECT acknowledgement_number AS ack FROM filed_tax_returns
        WHERE entity_id = $1 AND period = '2026-08-01' ORDER BY seq`, [a.entityId]);
    expect(chain.rows.map((r) => r.ack)).toEqual(['OP-SYN-0801', 'OP-SYN-0802']);
    expect(await filedReturnInForce(sa, 'iva_monthly', '2026-07')).toMatchObject({ acknowledgementNumber: 'OP-SYN-0701' });
  });

  it('is null for a period with nothing filed and for the other obligation', async () => {
    expect(await filedReturnInForce(sa, 'iva_monthly', '2026-06')).toBeNull();
    expect(await filedReturnInForce(sa, 'isr_provisional', '2026-08')).toBeNull();
  });

  it('a return written inside the caller\'s transaction goes when the caller rolls back', async () => {
    const before = await rowsOf(a.entityId);
    // September: 2,500.00 of IVA less the 2,000.00 July has left = 500.00 payable.
    await expect(withTransaction(async (client) => {
      await recordFiledReturn(sa, iva({
        period: '2026-09', filedOn: '2026-10-14', acknowledgementNumber: 'OP-SYN-0901', amountPayable: '500.00',
        credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '2000.00' }],
      }), client);
      throw new Error('the caller changes its mind');
    })).rejects.toThrow('the caller changes its mind');
    expect(await rowsOf(a.entityId)).toBe(before);
  });
});

describe('the rules between rows, refused in words', () => {
  beforeAll(async () => {
    // B: October leaves 1,000.00 in favour; November 300.00 payable and no balance.
    await recordFiledReturn(sb, iva({
      period: '2026-10', filedOn: '2026-11-12', acknowledgementNumber: 'OP-SYN-B1001', balanceInFavor: '1000.00',
    }));
    await recordFiledReturn(sb, iva({
      period: '2026-11', filedOn: '2026-12-10', acknowledgementNumber: 'OP-SYN-B1101', amountPayable: '300.00',
    }));
  });

  it.each<[string, Omit<FiledReturnFiling, 'obligation'>, string]>([
    ['a credit from a later period', {
      period: '2026-09', filedOn: '2026-10-14', acknowledgementNumber: 'OP-SYN-B0901', amountPayable: '400.00',
      credits: [{ sourceAcknowledgement: 'OP-SYN-B1001', amount: '100.00' }],
    }, 'filed_return.credit_source_not_earlier'],
    ['a credit from the same period', {
      period: '2026-10', filedOn: '2026-11-20', acknowledgementNumber: 'OP-SYN-B1002',
      replacesAcknowledgement: 'OP-SYN-B1001', balanceInFavor: '900.00',
      credits: [{ sourceAcknowledgement: 'OP-SYN-B1001', amount: '100.00' }],
    }, 'filed_return.credit_source_not_earlier'],
    ['a credit from a return that left no balance', {
      period: '2026-12', filedOn: '2027-01-15', acknowledgementNumber: 'OP-SYN-B1201', amountPayable: '200.00',
      credits: [{ sourceAcknowledgement: 'OP-SYN-B1101', amount: '100.00' }],
    }, 'filed_return.credit_source_no_balance'],
    ['a credit from another tenant\'s return', {
      period: '2026-12', filedOn: '2027-01-15', acknowledgementNumber: 'OP-SYN-B1201', amountPayable: '200.00',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '100.00' }],
    }, 'filed_return.credit_source_unknown'],
    ['an amendment filed before the return it replaces', {
      period: '2026-10', filedOn: '2026-11-11', acknowledgementNumber: 'OP-SYN-B1002',
      replacesAcknowledgement: 'OP-SYN-B1001', balanceInFavor: '900.00',
    }, 'filed_return.amended_before_replaced'],
    ['an amendment of another month\'s return', {
      period: '2026-11', filedOn: '2026-12-20', acknowledgementNumber: 'OP-SYN-B1102',
      replacesAcknowledgement: 'OP-SYN-B1001', amountPayable: '350.00',
    }, 'filed_return.replaced_other_period'],
    ['an amendment of a return nobody recorded', {
      period: '2026-11', filedOn: '2026-12-20', acknowledgementNumber: 'OP-SYN-B1102',
      replacesAcknowledgement: 'OP-SYN-NONE', amountPayable: '350.00',
    }, 'filed_return.replaced_unknown'],
  ])('%s', async (_, filing, key) => {
    const before = await rowsOf(b.entityId);
    expect(await keyOf(recordFiledReturn(sb, iva(filing)))).toEqual({ status: 422, key });
    expect(await rowsOf(b.entityId)).toBe(before);
  });

  it.each<[string, Omit<FiledReturnFiling, 'obligation'>, string]>([
    ['an acknowledgement recorded already', {
      period: '2026-12', filedOn: '2027-01-15', acknowledgementNumber: 'OP-SYN-B1001', amountPayable: '200.00',
    }, 'filed_return.acknowledgement_taken'],
    ['a second original for a month', {
      period: '2026-10', filedOn: '2026-11-25', acknowledgementNumber: 'OP-SYN-B1003', balanceInFavor: '800.00',
    }, 'filed_return.original_exists'],
  ])('the UNIQUE of %s, in words', async (_, filing, key) => {
    const before = await rowsOf(b.entityId);
    expect(await keyOf(recordFiledReturn(sb, iva(filing)))).toEqual({ status: 409, key });
    expect(await rowsOf(b.entityId)).toBe(before);
  });

  it('the UNIQUE of a return replaced twice, in words: an amendment replaces the one in force', async () => {
    const before = await rowsOf(a.entityId);
    expect(await keyOf(recordFiledReturn(sa, iva({
      period: '2026-08', filedOn: '2026-10-20', acknowledgementNumber: 'OP-SYN-0803',
      replacesAcknowledgement: 'OP-SYN-0801', amountPayable: '6300.00',
    })))).toEqual({ status: 409, key: 'filed_return.already_replaced' });
    expect(await rowsOf(a.entityId)).toBe(before);
  });
});

describe('scope', () => {
  it('answers 404 for another tenant\'s entity or user, reading and writing', async () => {
    const crossed = entityScope(b.tenantId, a.entityId);
    expect((await keyOf(filedReturnInForce(crossed, 'iva_monthly', '2026-08'))).status).toBe(404);
    expect((await keyOf(recordFiledReturn(crossed, iva({
      period: '2026-12', filedOn: '2027-01-15', acknowledgementNumber: 'OP-SYN-X1201', amountPayable: '1.00',
    })))).status).toBe(404);
    expect((await keyOf(recordFiledReturn(sa, iva({
      period: '2026-12', filedOn: '2027-01-15', acknowledgementNumber: 'OP-SYN-X1201', amountPayable: '1.00',
      recordedBy: b.userId,
    })))).status).toBe(404);
  });
});
