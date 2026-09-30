import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { LegalParameterUnavailableError } from '../../src/services/jurisdiction/legal-parameters.js';
import {
  corporateIncomeTaxRateAt,
  incomeTaxInputForPayment,
  recordIncomeTaxInput,
  type IncomeTaxInputCapture,
} from '../../src/services/fiscal/provisional-income-tax-inputs.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-115 · #308 — THE INPUTS OF THE PROVISIONAL ISR, AGAINST POSTGRES.
//
// The coefficient and the pending losses are captured with the annual return
// they come from, in a table by the return's fiscal year (decision
// MNE-001-114); a payment reads the return filed or due by its due date
// (LISR art. 14 fr. I); the corporate rate is read from legal_parameters by
// date of entry, as migration 166 left it, with no seeder. All data is
// synthetic.
// ============================================================

let a: Fixture;
let b: Fixture;
let c: Fixture;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-115 A');
  b = await crearInquilino('MNE-001-115 B');
  c = await crearInquilino('MNE-001-115 C');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

const coefficient = (year: number, value: string, filedOn: string, doc = `Annual return ${year}`):
  IncomeTaxInputCapture => ({
  kind: 'profit_coefficient', value, sourceFiscalYear: year, sourceFiledOn: filedOn, sourceDocument: doc,
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

describe('a payment reads the return the law says, and a re-run reads what it read then', () => {
  it('January and February 2026 read the 2024 return; March reads the 2025 one', async () => {
    const scope = entityScope(a.tenantId, a.entityId);
    expect(await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 1 }))
      .toBeNull();

    await recordIncomeTaxInput(scope, { ...coefficient(2024, '0.1111', '2025-03-20'), recordedBy: a.userId });
    await recordIncomeTaxInput(scope, coefficient(2025, '0.2222', '2026-03-25'));

    const read = async (month: number) =>
      (await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month }))?.value;
    expect(await read(1)).toBe('0.1111');
    expect(await read(2)).toBe('0.1111');
    expect(await read(3)).toBe('0.2222');
    expect(await read(12)).toBe('0.2222');
  });

  it('a return filed early reaches January, as "se hubiera presentado" allows', async () => {
    const scope = entityScope(b.tenantId, b.entityId);
    await recordIncomeTaxInput(scope, coefficient(2024, '0.1111', '2025-03-20'));
    await recordIncomeTaxInput(scope, coefficient(2025, '0.3333', '2026-02-10'));
    const jan = await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 1 });
    expect(jan?.value).toBe('0.3333');
  });

  it('a correction is in force, and a January re-run with asOf reads the figure before it', async () => {
    const scope = entityScope(c.tenantId, c.entityId);
    const first = await recordIncomeTaxInput(scope, coefficient(2025, '0.1234', '2026-03-25', 'op 000111'));
    const fixed = await recordIncomeTaxInput(scope, coefficient(2025, '0.1243', '2026-05-02', 'op 000222'));
    expect(fixed.recordedAt > first.recordedAt).toBe(true);

    const may = await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 5 });
    expect(may).toMatchObject({ id: fixed.id, value: '0.1243', sourceDocument: 'op 000222' });
    const rerun = await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2026, month: 5 },
      { asOf: first.recordedAt });
    expect(rerun).toMatchObject({ id: first.id, value: '0.1234' });
  });

  it('keeps the five-year window of a coefficient, and the losses with their INPC month', async () => {
    const scope = entityScope(c.tenantId, c.entityId);
    await recordIncomeTaxInput(scope, coefficient(2019, '0.0500', '2020-03-30'));
    expect(await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2025, month: 6 }))
      .toBeNull();
    expect((await incomeTaxInputForPayment(scope, 'profit_coefficient', { fiscalYear: 2024, month: 6 }))?.value)
      .toBe('0.0500');

    await recordIncomeTaxInput(scope, {
      kind: 'pending_tax_losses', value: '150000.5000', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-25',
      sourceDocument: 'op 000111', updatedThrough: '2025-12',
    });
    const losses = await incomeTaxInputForPayment(scope, 'pending_tax_losses', { fiscalYear: 2026, month: 7 });
    expect(losses).toMatchObject({ value: '150000.5000', updatedThrough: '2025-12' });
  });
});

describe('scope and history', () => {
  it('answers 404 for another tenant\'s entity or user, reading and writing', async () => {
    const crossed = entityScope(b.tenantId, a.entityId);
    await expect(recordIncomeTaxInput(crossed, coefficient(2025, '0.5000', '2026-03-25')))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(incomeTaxInputForPayment(crossed, 'profit_coefficient', { fiscalYear: 2026, month: 3 }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(recordIncomeTaxInput(entityScope(a.tenantId, a.entityId),
      { ...coefficient(2025, '0.5000', '2026-03-25'), recordedBy: b.userId }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses UPDATE and DELETE even to the schema owner: a correction is a new row', async () => {
    await expect(query(`UPDATE income_tax_annual_inputs SET value = 0 WHERE entity_id = $1`, [a.entityId]))
      .rejects.toThrow(/sólo escritura: UPDATE/);
    await expect(query(`DELETE FROM income_tax_annual_inputs WHERE entity_id = $1`, [a.entityId]))
      .rejects.toThrow(/sólo escritura: DELETE/);
  });

  it('the table itself refuses what the law does not allow, and takes a coefficient above one', async () => {
    const insert = (kind: string, value: string, filedOn: string, through: string | null, source = 'op') =>
      query(
        `INSERT INTO income_tax_annual_inputs
           (entity_id, kind, value, source_fiscal_year, source_filed_on, source_document, updated_through)
         VALUES ($1, $2, $3::numeric, 2025, $4::date, $5, $6::date)`,
        [b.entityId, kind, value, filedOn, source, through]
      );
    await expect(insert('profit_coefficient', '0.1000', '2025-12-31', null)).rejects.toThrow(/filed_after_its_year/);
    await expect(insert('pending_tax_losses', '10.0000', '2026-03-25', null)).rejects.toThrow(/state_their_update/);
    await expect(insert('profit_coefficient', '0.1000', '2026-03-25', '2025-12-01')).rejects.toThrow(/state_their_update/);
    await expect(insert('pending_tax_losses', '10.0000', '2026-03-25', '2025-12-31')).rejects.toThrow(/state_their_update/);
    await expect(insert('pending_tax_losses', '10.0000', '2026-03-25', '2025-12-01', '  ')).rejects.toThrow(/source_document/);
    await expect(insert('profit_coefficient', '1.2000', '2026-03-25', null)).resolves.toBeDefined();
  });
});
