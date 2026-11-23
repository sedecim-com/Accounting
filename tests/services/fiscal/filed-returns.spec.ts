import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  filedReturnInForce,
  recordFiledReturn,
  type FiledReturnFiling,
} from '../../../src/services/fiscal/filed-returns.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { entityScope } from '../../../src/database/scope.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// MNE-001-576 · the rules of a filed return said by key, in en and es, before
// Postgres says them as a constraint name; and the three UNIQUE violations
// put into words. The chain, the credits between rows and the 404 of a
// foreign entity are proven against Postgres in
// tests/integration/mne-001-576-filed-returns-service.int.spec.ts.
// ============================================================

const mockQuery = query as unknown as Mock;
const mockTransaction = withTransaction as unknown as Mock;
const scope = entityScope('tenant-1', 'entity-1');

// August 2026: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 payable.
const august: FiledReturnFiling = {
  obligation: 'iva_monthly', period: '2026-08', filedOn: '2026-09-15', acknowledgementNumber: 'OP-SYN-0801',
  captureLine: 'LC-SYN-0801', amountPayable: '5000.00', amountPaid: '5000.00', paidOn: '2026-09-16',
  credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '3000.00' }],
};

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset();
});

const refusal = async (filing: FiledReturnFiling): Promise<AppError> => {
  const err = await recordFiledReturn(scope, filing).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return err as AppError;
};

describe('recordFiledReturn refuses by key, before Postgres speaks', () => {
  it.each<[string, Partial<FiledReturnFiling>, string, string]>([
    ['the provisional ISR, which this writer does not write yet',
      { obligation: 'isr_provisional' }, 'obligation', 'filed_return.obligation_not_written'],
    ['a period that is not a month', { period: '2026-13' }, 'period', 'filed_return.period_invalid'],
    ['a filing date that does not exist', { filedOn: '2026-09-31' }, 'filedOn', 'filed_return.filed_on_not_a_day'],
    ['a filing before the month ends', { filedOn: '2026-08-31' }, 'filedOn', 'filed_return.filed_before_period_ends'],
    ['a payment day that does not exist', { paidOn: '2026-02-29' }, 'paidOn', 'filed_return.paid_on_not_a_day'],
    ['a payment before the filing', { paidOn: '2026-09-14' }, 'paidOn', 'filed_return.paid_before_filed'],
    ['an amount paid with no day', { paidOn: undefined }, 'paidOn', 'filed_return.payment_incomplete'],
    ['a payment day with no amount', { amountPaid: undefined }, 'amountPaid', 'filed_return.payment_incomplete'],
    ['an amount payable and a balance in favour, both above zero',
      { balanceInFavor: '0.01' }, 'balanceInFavor', 'filed_return.payable_and_in_favor'],
    ['three decimals payable', { amountPayable: '5000.005' }, 'amountPayable', 'filed_return.amount_invalid'],
    ['three decimals in favour', { amountPayable: '0', balanceInFavor: '1.001' }, 'balanceInFavor',
      'filed_return.amount_invalid'],
    ['three decimals paid', { amountPaid: '5000.001' }, 'amountPaid', 'filed_return.amount_invalid'],
    ['a negative amount', { amountPayable: '-5000.00' }, 'amountPayable', 'filed_return.amount_invalid'],
    ['more digits than DECIMAL(19,2) holds', { amountPayable: '100000000000000000' }, 'amountPayable',
      'filed_return.amount_invalid'],
    ['a blank acknowledgement', { acknowledgementNumber: '  ' }, 'acknowledgementNumber',
      'filed_return.acknowledgement_required'],
    ['a blank capture line', { captureLine: ' ' }, 'captureLine', 'filed_return.capture_line_blank'],
    ['a credit with three decimals', { credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '3000.001' }] },
      'credits[0].amount', 'filed_return.amount_invalid'],
    ['a credit of zero', { credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '0.00' }] },
      'credits[0].amount', 'filed_return.credit_amount_not_positive'],
    ['a credit with no return named', { credits: [{ sourceAcknowledgement: ' ', amount: '1.00' }] },
      'credits[0].sourceAcknowledgement', 'filed_return.acknowledgement_required'],
    ['the same balance credited twice', {
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '1000.00' },
        { sourceAcknowledgement: ' OP-SYN-0701', amount: '2000.00' }],
    }, 'credits[1].sourceAcknowledgement', 'filed_return.credit_repeated'],
    ['an amendment with no return named', { replacesAcknowledgement: '' }, 'replacesAcknowledgement',
      'filed_return.acknowledgement_required'],
  ])('%s', async (_, change, field, key) => {
    const err = await refusal({ ...august, ...change });
    expect(err.field).toBe(field);
    expect(err.messageKey?.key).toBe(key);
    expect(err.localized('es')).not.toBe(err.localized('en'));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('accepts a return filed on the first day after its month, and paid that same day', async () => {
    mockTransaction.mockRejectedValue(new Error('reached Postgres'));
    await expect(recordFiledReturn(scope, { ...august, filedOn: '2026-09-01', paidOn: '2026-09-01' }))
      .rejects.toThrow('reached Postgres');
  });
});

/** A client whose first query answers the lookup and whose second throws `error`. */
const clientFailingOnInsert = (error: unknown) => ({
  query: vi.fn()
    .mockResolvedValueOnce({
      rows: [{
        entityFound: true, userFound: true,
        refs: [{ id: 'r-0701', acknowledgementNumber: 'OP-SYN-0701', period: '2026-07', filedOn: '2026-08-14',
          balanceInFavor: '5000.00' }],
      }],
    })
    .mockRejectedValueOnce(error),
});

describe('recordFiledReturn says the three UNIQUE violations in words', () => {
  it.each<[string, string]>([
    ['filed_tax_return_acknowledgement_once', 'filed_return.acknowledgement_taken'],
    ['filed_tax_return_one_original', 'filed_return.original_exists'],
    ['filed_tax_return_replaced_once', 'filed_return.already_replaced'],
  ])('%s', async (constraint, key) => {
    const client = clientFailingOnInsert(Object.assign(new Error('duplicate key'), { code: '23505', constraint }));
    const err = await recordFiledReturn(scope, august, client as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as AppError).messageKey?.key).toBe(key);
    expect((err as AppError).localized('es')).not.toBe((err as AppError).localized('en'));
  });

  it('lets any other database error through as it is', async () => {
    const boom = Object.assign(new Error('connection lost'), { code: '08006' });
    const err = await recordFiledReturn(scope, august, clientFailingOnInsert(boom) as never)
      .catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it('writes inside the caller\'s client when given one, and opens a transaction when not', async () => {
    const client = clientFailingOnInsert(new Error('stop'));
    await expect(recordFiledReturn(scope, august, client as never)).rejects.toThrow('stop');
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0][1]).toEqual(
      ['entity-1', 'tenant-1', null, 'iva_monthly', ['OP-SYN-0701']]);

    mockTransaction.mockImplementation((fn: (c: unknown) => unknown) => fn(clientFailingOnInsert(new Error('tx'))));
    await expect(recordFiledReturn(scope, august)).rejects.toThrow('tx');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for an entity outside the scope\'s tenant, and for a foreign user', async () => {
    const lookup = (entityFound: boolean, userFound: boolean) =>
      ({ query: vi.fn().mockResolvedValue({ rows: [{ entityFound, userFound, refs: [] }] }) });
    const noCredits = { ...august, credits: [] };
    const entity = await recordFiledReturn(scope, noCredits, lookup(false, false) as never).catch((e: unknown) => e);
    expect(entity).toBeInstanceOf(NotFoundError);
    expect((entity as Error).message).toMatch(/^Entity/);
    const user = await recordFiledReturn(scope, { ...noCredits, recordedBy: 'u-9' }, lookup(true, false) as never)
      .catch((e: unknown) => e);
    expect(user).toBeInstanceOf(NotFoundError);
    expect((user as Error).message).toMatch(/^User/);
  });
});

describe('filedReturnInForce', () => {
  it('refuses a period or an obligation it does not know, by key', async () => {
    const bad = await filedReturnInForce(scope, 'iva_monthly', '2026-8').catch((e: unknown) => e);
    expect((bad as AppError).messageKey?.key).toBe('filed_return.period_invalid');
    const other = await filedReturnInForce(scope, 'iva_annual' as never, '2026-08').catch((e: unknown) => e);
    expect((other as AppError).messageKey?.key).toBe('filed_return.obligation_invalid');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('binds the tenant with the entity, and answers 404, never null, when the entity is not the tenant\'s', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const err = await filedReturnInForce(scope, 'iva_monthly', '2026-08').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(mockQuery.mock.calls[0][1]).toEqual(['entity-1', 'tenant-1', 'iva_monthly', '2026-08-01']);
  });

  it('is null when the entity filed nothing for the period', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: null }] });
    await expect(filedReturnInForce(scope, 'iva_monthly', '2026-08')).resolves.toBeNull();
  });
});
