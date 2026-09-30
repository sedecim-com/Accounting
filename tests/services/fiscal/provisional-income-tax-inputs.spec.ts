import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  recordIncomeTaxInput,
  type IncomeTaxInputCapture,
} from '../../../src/services/fiscal/provisional-income-tax-inputs.js';
import { query } from '../../../src/database/connection.js';
import { entityScope } from '../../../src/database/scope.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// MNE-001-115 · the capture rules said in words before Postgres says them as a
// constraint name. The table's CHECKs are proven against Postgres in
// tests/integration/mne-001-115-provisional-income-tax-inputs.int.spec.ts;
// here, that a capture the law refuses never reaches the database.
// ============================================================

const mockQuery = query as unknown as Mock;
const scope = entityScope('tenant-1', 'entity-1');
const good: IncomeTaxInputCapture = {
  fiscalYear: 2026, kind: 'profit_coefficient', value: '0.1234',
  sourceFiscalYear: 2025, sourceDocument: 'Annual return 2025',
};

beforeEach(() => mockQuery.mockReset());

describe('recordIncomeTaxInput refuses what the law does not allow', () => {
  it.each<[string, Partial<IncomeTaxInputCapture>, string]>([
    ['an unknown kind', { kind: 'ptu_paid' as never }, 'kind'],
    ['a fractional year', { fiscalYear: 2026.5 }, 'fiscalYear'],
    ['a negative value', { value: '-0.1000' }, 'value'],
    ['five decimals', { value: '0.12345' }, 'value'],
    ['a blank source', { sourceDocument: '   ' }, 'sourceDocument'],
    ['a return of the same year', { sourceFiscalYear: 2026 }, 'sourceFiscalYear'],
    ['a coefficient above one', { value: '1.0001' }, 'value'],
    ['a coefficient older than five years', { sourceFiscalYear: 2020 }, 'sourceFiscalYear'],
  ])('%s', async (_, change, field) => {
    const err = await recordIncomeTaxInput(scope, { ...good, ...change }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts losses above one and a coefficient exactly five years old', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'x' }] });
    await recordIncomeTaxInput(scope, { ...good, kind: 'pending_tax_losses', value: '150000.5' });
    await recordIncomeTaxInput(scope, { ...good, sourceFiscalYear: 2021, value: '1' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('recordIncomeTaxInput bounds the entity inside the INSERT', () => {
  it('sends the tenant with the entity and answers 404 when no row is written', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const err = await recordIncomeTaxInput(scope, good, client as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE le\.id = \$1 AND le\.tenant_id = \$2/);
    expect(params.slice(0, 2)).toEqual(['entity-1', 'tenant-1']);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
