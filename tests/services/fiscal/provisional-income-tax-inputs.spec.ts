import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  incomeTaxInputForPayment,
  provisionalPaymentDueOn,
  recordIncomeTaxInput,
  type IncomeTaxInputCapture,
} from '../../../src/services/fiscal/provisional-income-tax-inputs.js';
import { query } from '../../../src/database/connection.js';
import { entityScope } from '../../../src/database/scope.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// MNE-001-115 · the capture rules said in words before Postgres says them as a
// constraint name, and the scope answered 404 in the SQL. The table's CHECKs,
// its trigger and the choice of return by due date are proven against
// Postgres in tests/integration/mne-001-115-provisional-income-tax-inputs.int.spec.ts.
// ============================================================

const mockQuery = query as unknown as Mock;
const scope = entityScope('tenant-1', 'entity-1');
const good: IncomeTaxInputCapture = {
  kind: 'profit_coefficient', value: '0.1234',
  sourceFiscalYear: 2025, sourceFiledOn: '2026-03-25', sourceDocument: 'Annual return 2025',
};
const losses: IncomeTaxInputCapture = {
  ...good, kind: 'pending_tax_losses', value: '150000.5', updatedThrough: '2025-12',
};

beforeEach(() => mockQuery.mockReset());

describe('recordIncomeTaxInput refuses what the law does not allow', () => {
  it.each<[string, Partial<IncomeTaxInputCapture>, string]>([
    ['an unknown kind', { kind: 'ptu_paid' as never }, 'kind'],
    ['a fractional year', { sourceFiscalYear: 2025.5 }, 'sourceFiscalYear'],
    ['a negative value', { value: '-0.1000' }, 'value'],
    ['five decimals', { value: '0.12345' }, 'value'],
    ['a blank source', { sourceDocument: '   ' }, 'sourceDocument'],
    ['a return filed inside its own year', { sourceFiledOn: '2025-12-31' }, 'sourceFiledOn'],
    ['a filing date that is not a date', { sourceFiledOn: '25/03/2026' }, 'sourceFiledOn'],
    ['a coefficient with an update month', { updatedThrough: '2025-12' }, 'updatedThrough'],
  ])('%s', async (_, change, field) => {
    const err = await recordIncomeTaxInput(scope, { ...good, ...change }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<IncomeTaxInputCapture>]>([
    ['losses that do not say how far they are updated', { updatedThrough: undefined }],
    ['losses updated through a day, not a month', { updatedThrough: '2025-12-31' }],
  ])('%s', async (_, change) => {
    const err = await recordIncomeTaxInput(scope, { ...losses, ...change }).catch((e: unknown) => e);
    expect((err as ValidationError).field).toBe('updatedThrough');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts a coefficient above one: nominal income excludes the inflation adjustment', async () => {
    mockQuery.mockResolvedValue({ rows: [{ entityFound: true, id: 'x' }] });
    await expect(recordIncomeTaxInput(scope, { ...good, value: '1.2000' }))
      .resolves.toEqual({ id: 'x' });
    await recordIncomeTaxInput(scope, losses);
    const params = mockQuery.mock.calls[1][1] as unknown[];
    expect(params[7]).toBe('2025-12-01');
  });
});

describe('recordIncomeTaxInput bounds the entity and the user inside the statement', () => {
  it('sends the tenant with the entity and answers 404 when the entity is not the tenant\'s', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ entityFound: false, id: null }] }) };
    const err = await recordIncomeTaxInput(scope, good, client as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/^Entity/);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM legal_entities WHERE id = \$1 AND tenant_id = \$2/);
    expect(sql).toMatch(/FROM users WHERE id = \$9::uuid AND tenant_id = \$2/);
    expect(params.slice(0, 2)).toEqual(['entity-1', 'tenant-1']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers 404 for a user who is not the tenant\'s, instead of signing the capture with them', async () => {
    mockQuery.mockResolvedValue({ rows: [{ entityFound: true, id: null }] });
    const err = await recordIncomeTaxInput(scope, { ...good, recordedBy: 'other-firm-user' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/^User with id other-firm-user/);
  });
});

describe('incomeTaxInputForPayment', () => {
  it('answers 404 for an entity outside the tenant, and null only when nothing was captured', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 1 }))
      .rejects.toBeInstanceOf(NotFoundError);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: null }] });
    await expect(incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 1 }))
      .resolves.toBeNull();
  });

  it('passes the payment\'s due date, the window and asOf to the SQL', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'x', value: '0.1' }] }) };
    await incomeTaxInputForPayment(scope, 'pending_tax_losses', { fiscalYear: 2026, month: 3 },
      { asOf: '2026-04-01T00:00:00Z' }, client as never);
    const params = client.query.mock.calls[0][1] as unknown[];
    expect(params).toEqual(['entity-1', 'tenant-1', 'pending_tax_losses', 2026, 5, '2026-04-17',
      '2026-04-01T00:00:00Z']);
  });
});

describe('provisionalPaymentDueOn', () => {
  it('is the 17th of the next month, and December is due in January', () => {
    expect(provisionalPaymentDueOn({ fiscalYear: 2026, month: 1 })).toBe('2026-02-17');
    expect(provisionalPaymentDueOn({ fiscalYear: 2026, month: 12 })).toBe('2027-01-17');
  });

  it.each([0, 13, 1.5])('refuses month %s', (month) => {
    expect(() => provisionalPaymentDueOn({ fiscalYear: 2026, month })).toThrow(ValidationError);
  });
});
