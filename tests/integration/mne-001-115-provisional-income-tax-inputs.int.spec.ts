import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { LegalParameterUnavailableError } from '../../src/services/jurisdiction/legal-parameters.js';
import {
  corporateIncomeTaxRateAt,
  incomeTaxInputInForce,
  recordIncomeTaxInput,
} from '../../src/services/fiscal/provisional-income-tax-inputs.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-115 · #308 — THE INPUTS OF THE PROVISIONAL ISR, AGAINST POSTGRES.
//
// The coefficient and the pending losses are captured with the annual return
// they come from, in a table by fiscal year (decision MNE-001-114); the
// corporate rate is read from legal_parameters by date of entry, as migration
// 166 left it, with no seeder. All data is synthetic.
// ============================================================

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-115 A');
  b = await crearInquilino('MNE-001-115 B');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('the corporate ISR rate is law with a date of entry', () => {
  it('reads 30 % on the date of a 2026 payment, with its source', async () => {
    const rate = await corporateIncomeTaxRateAt('2026-06-17');
    expect(rate.value).toBe('0.3000');
    expect(rate.unit).toBe('rate');
    expect(rate.effectiveFrom).toBe('2014-01-01');
    expect(rate.sourceUrl).toMatch(/LISR\.pdf$/);
  });

  it('fails closed before the current LISR came into force', async () => {
    const err = await corporateIncomeTaxRateAt('2013-12-31').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LegalParameterUnavailableError);
    expect((err as LegalParameterUnavailableError).gap).toBe('not_yet_in_force');
  });
});

describe('the coefficient and the losses are captured with their source', () => {
  it('keeps each figure with its return, and a correction does not erase the first capture', async () => {
    const scope = entityScope(a.tenantId, a.entityId);
    expect(await incomeTaxInputInForce(scope, 2026, 'profit_coefficient')).toBeNull();

    await recordIncomeTaxInput(scope, {
      fiscalYear: 2026, kind: 'profit_coefficient', value: '0.1234', sourceFiscalYear: 2025,
      sourceDocument: 'Annual return 2025, operation 000111', recordedBy: a.userId,
    });
    await recordIncomeTaxInput(scope, {
      fiscalYear: 2026, kind: 'pending_tax_losses', value: '150000.5000', sourceFiscalYear: 2025,
      sourceDocument: 'Annual return 2025, operation 000111',
    });
    const fixed = await recordIncomeTaxInput(scope, {
      fiscalYear: 2026, kind: 'profit_coefficient', value: '0.1243', sourceFiscalYear: 2025,
      sourceDocument: 'Amended annual return 2025, operation 000222',
    });

    const coefficient = await incomeTaxInputInForce(scope, 2026, 'profit_coefficient');
    expect(coefficient).toMatchObject({
      id: fixed.id, value: '0.1243', sourceFiscalYear: 2025,
      sourceDocument: 'Amended annual return 2025, operation 000222',
    });
    const losses = await incomeTaxInputInForce(scope, 2026, 'pending_tax_losses');
    expect(losses).toMatchObject({ value: '150000.5000', sourceDocument: 'Annual return 2025, operation 000111' });

    const history = await query<{ value: string }>(
      `SELECT value::text AS value FROM income_tax_annual_inputs
        WHERE entity_id = $1 AND kind = 'profit_coefficient' ORDER BY recorded_at`,
      [a.entityId]
    );
    expect(history.rows.map((r) => r.value)).toEqual(['0.1234', '0.1243']);
  });

  it('answers 404 for another tenant\'s entity and never reads across tenants', async () => {
    const crossed = entityScope(b.tenantId, a.entityId);
    await expect(recordIncomeTaxInput(crossed, {
      fiscalYear: 2026, kind: 'profit_coefficient', value: '0.5000', sourceFiscalYear: 2025,
      sourceDocument: 'Annual return 2025',
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(await incomeTaxInputInForce(crossed, 2026, 'profit_coefficient')).toBeNull();
  });

  it('the table itself refuses what the law does not allow, even past the service', async () => {
    const insert = (kind: string, value: string, sourceYear: number, source = 'Annual return') =>
      query(
        `INSERT INTO income_tax_annual_inputs
           (entity_id, fiscal_year, kind, value, source_fiscal_year, source_document)
         VALUES ($1, 2026, $2, $3::numeric, $4, $5)`,
        [b.entityId, kind, value, sourceYear, source]
      );
    await expect(insert('profit_coefficient', '1.2000', 2025)).rejects.toThrow(/coefficient_within_law/);
    await expect(insert('profit_coefficient', '0.1000', 2020)).rejects.toThrow(/coefficient_within_law/);
    await expect(insert('pending_tax_losses', '10.0000', 2026)).rejects.toThrow(/earlier_return/);
    await expect(insert('pending_tax_losses', '10.0000', 2025, '  ')).rejects.toThrow(/source_document/);
    await expect(insert('profit_coefficient', '0.1000', 2021)).resolves.toBeDefined();
  });
});
