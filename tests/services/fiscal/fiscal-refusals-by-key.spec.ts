/**
 * MNE-001-727 (#151), I9 by folder, part 4: the refusals of `src/services/fiscal`
 * that reached the requester in Spanish prose are catalogue keys now: the three
 * closed readers of the panel, the guards of the IVA and ISR workpapers, and the
 * capture rules of the ISR's annual figures. The Spanish twin must print, byte
 * for byte, what each site printed before (written by hand from those sites,
 * with synthetic values), and the English is the source the error's `message`
 * is fixed in. Codes, statuses and fields do not change.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type pg from 'pg';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { entityScope } from '../../../src/database/scope.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError, AppError, ValidationError } from '../../../src/utils/errors.js';
import {
  buildIvaWorkpaper,
  priorBalanceOf,
  readCreditableProration,
  readFilingRounding,
} from '../../../src/services/fiscal/iva-workpaper.js';
import {
  buildProvisionalIncomeTaxWorkpaper,
  readSalesReturnsTreatment,
} from '../../../src/services/fiscal/provisional-income-tax.js';
import {
  provisionalPaymentDueOn,
  recordIncomeTaxInput,
  type IncomeTaxInputCapture,
} from '../../../src/services/fiscal/provisional-income-tax-inputs.js';

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

const TENANT = 'a1b2c3d4-0000-4000-8000-000000000727';
const ENTITY = 'b2c3d4e5-0000-4000-8000-000000000727';
const ctx = { tenantId: TENANT, entityId: ENTITY };

/** key, params, the Spanish each site printed, the English source. */
type Case = readonly [TranslationKey, MessageParams, string, string];

const CASES: readonly Case[] = [
  // the three closed readers of the panel
  ['error.POLICY_VALUE_UNKNOWN.fiscal_reader',
    { policy: 'declaracion_redondeo_a_pesos', value: 'half_up', known: 'cada_renglon, solo_el_pago' },
    'La política declaracion_redondeo_a_pesos vale "half_up" y este lector sólo entiende cada_renglon, ' +
      'solo_el_pago. Corrígela en mnemosine pending.',
    'The policy declaracion_redondeo_a_pesos is set to "half_up" and this reader only understands ' +
      'cada_renglon, solo_el_pago. Correct it in mnemosine pending.'],
  // iva-workpaper.ts
  ['error.VALIDATION_ERROR.iva_workpaper.prior_balance_amount', { value: '-5' },
    'El saldo a favor de periodos anteriores vale "-5": debe ser un importe de cero o más.',
    'The balance in favor from prior periods is "-5": it must be an amount of zero or more.'],
  ['error.VALIDATION_ERROR.iva_workpaper.month', { month: '13' },
    'El mes 13 no existe: el IVA definitivo es mensual.',
    'Month 13 does not exist: the definitive IVA is monthly.'],
  ['error.VALIDATION_ERROR.iva_workpaper.entity_without_mexican_iva', {},
    'La entidad no causa IVA mexicano: no hay IVA definitivo que calcular.',
    'The entity does not owe Mexican IVA: there is no definitive IVA to compute.'],
  // provisional-income-tax.ts
  ['error.VALIDATION_ERROR.isr_workpaper.amount', { field: 'ptuPaidInYear', value: 'abc' },
    'ptuPaidInYear vale "abc": debe ser un importe de cero o más.',
    'ptuPaidInYear is "abc": it must be an amount of zero or more.'],
  ['error.VALIDATION_ERROR.isr_workpaper.month', { month: '0' },
    'El mes 0 no existe: el pago provisional es mensual.',
    'Month 0 does not exist: the provisional payment is monthly.'],
  ['error.VALIDATION_ERROR.isr_workpaper.entity_without_mexican_books', {},
    'La entidad no lleva libros mexicanos: no hay ISR provisional que calcular.',
    'The entity does not keep Mexican books: there is no provisional ISR to compute.'],
  // provisional-income-tax-inputs.ts
  ['error.VALIDATION_ERROR.income_tax_input.payment_month', { year: '2026', month: '13' },
    '2026-13 no es un mes de pago provisional.',
    '2026-13 is not a provisional payment month.'],
  ['error.VALIDATION_ERROR.income_tax_input.kind',
    { kind: 'ptu_paid', known: 'profit_coefficient, pending_tax_losses' },
    '"ptu_paid" no es un dato del ISR provisional: profit_coefficient, pending_tax_losses.',
    '"ptu_paid" is not an input of the provisional ISR: profit_coefficient, pending_tax_losses.'],
  ['error.VALIDATION_ERROR.income_tax_input.year_not_integer', {},
    'El ejercicio de la declaración fuente es un año entero.',
    'The fiscal year of the source return must be a whole number.'],
  ['error.VALIDATION_ERROR.income_tax_input.value_format', { value: '-0.1000' },
    '"-0.1000" no es una cifra no negativa con hasta cuatro decimales.',
    '"-0.1000" is not a non-negative figure with up to four decimals.'],
  ['error.VALIDATION_ERROR.income_tax_input.source_missing', {},
    'Falta la fuente: la declaración anual de la que se tomó la cifra.',
    'The source is missing: the annual return the figure was taken from.'],
  ['error.VALIDATION_ERROR.income_tax_input.filed_inside_year', { year: '2025', filedOn: '2025-12-31' },
    'La declaración de 2025 se presenta después de que termina el ejercicio: "2025-12-31" no puede ser su fecha.',
    'The return for 2025 is filed after the fiscal year ends: "2025-12-31" cannot be its date.'],
  ['error.VALIDATION_ERROR.income_tax_input.update_month_required', {},
    'Las pérdidas pendientes dicen hasta qué mes del INPC están actualizadas (AAAA-MM, LISR art. 57).',
    'Pending losses state the INPC month they are updated through (YYYY-MM, LISR art. 57).'],
  ['error.VALIDATION_ERROR.income_tax_input.update_month_only_for_losses', {},
    'Sólo las pérdidas pendientes llevan mes de actualización.',
    'Only pending losses carry an update month.'],
];

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPolicy.mockReset();
});
afterEach(() => resetLanguage());

describe('each key prints, in es, the Spanish of before, and in en, its English source', () => {
  it.each(CASES)('%s', (key, params, es, en) => {
    expect(t(key, params, 'es')).toBe(es);
    expect(t(key, params, 'en')).toBe(en);
  });

  it('covers the fifteen keys of the block', () => {
    expect(new Set(CASES.map(([key]) => key)).size).toBe(15);
  });
});

const caseOf = (key: TranslationKey, params: MessageParams): Case => {
  const found = CASES.find(([k, p]) => k === key && JSON.stringify(p) === JSON.stringify(params));
  if (!found) throw new Error(`no case for ${key} ${JSON.stringify(params)}`);
  return found;
};

/** The error is the class and code of before, written by key, English in `message`, Spanish when localized to es. */
function expectKeyed(
  err: unknown,
  expected: { cls: new (...args: never[]) => AppError; code: string; status: number; field?: string; key: TranslationKey; params: MessageParams }
): void {
  expect(err).toBeInstanceOf(expected.cls);
  const e = err as AppError;
  expect(e.code).toBe(expected.code);
  expect(e.statusCode).toBe(expected.status);
  expect(e.field).toBe(expected.field);
  expect(e.messageKey?.key).toBe(expected.key);
  expect(e.messageKey?.params ?? {}).toEqual(expected.params);
  const [, , es, en] = caseOf(expected.key, expected.params);
  expect(e.message).toBe(en);
  expect(e.localized('en')).toBe(en);
  expect(e.localized('es')).toBe(es);
}

const caught = async (p: Promise<unknown> | (() => unknown)): Promise<unknown> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
};

describe('the three closed readers of the panel: one sentence, three codes', () => {
  it.each<[string, () => Promise<unknown>, string, string, string]>([
    ['readFilingRounding', () => readFilingRounding(ctx), 'FILING_ROUNDING_UNKNOWN',
      'declaracion_redondeo_a_pesos', 'cada_renglon, solo_el_pago'],
    ['readCreditableProration', () => readCreditableProration(ctx), 'CREDITABLE_PRORATION_UNKNOWN',
      'iva_creditable_proration', 'monthly, annual'],
    ['readSalesReturnsTreatment', () => readSalesReturnsTreatment(ctx), 'SALES_RETURNS_TREATMENT_UNKNOWN',
      'provisional_isr_sales_returns', 'deduction, net_of_income'],
  ])('%s', async (_, read, code, policy, known) => {
    mockGetPolicy.mockResolvedValueOnce({ key: policy, value: 'half_up', defined: true });
    const err = await caught(read);
    expect(err).toBeInstanceOf(AccountingError);
    const e = err as AppError;
    expect(e.code).toBe(code);
    expect(e.statusCode).toBe(422);
    expect(e.messageKey).toEqual({
      key: 'error.POLICY_VALUE_UNKNOWN.fiscal_reader',
      params: { policy, value: 'half_up', known },
    });
    expect(e.message).toBe(
      `The policy ${policy} is set to "half_up" and this reader only understands ${known}. Correct it in mnemosine pending.`);
    expect(e.localized('es')).toBe(
      `La política ${policy} vale "half_up" y este lector sólo entiende ${known}. Corrígela en mnemosine pending.`);
  });

  it('the rounding of the case table is the one readFilingRounding throws', async () => {
    mockGetPolicy.mockResolvedValueOnce({ key: 'declaracion_redondeo_a_pesos', value: 'half_up', defined: true });
    expectKeyed(await caught(() => readFilingRounding(ctx)), {
      cls: AccountingError, code: 'FILING_ROUNDING_UNKNOWN', status: 422, key: 'error.POLICY_VALUE_UNKNOWN.fiscal_reader',
      params: { policy: 'declaracion_redondeo_a_pesos', value: 'half_up', known: 'cada_renglon, solo_el_pago' },
    });
  });
});

/** A client double whose queries answer in order; the builders take it in place of a transaction. */
const clientAnswering = (...answers: Array<{ rowCount: number; rows: unknown[] }>): pg.PoolClient => {
  const q = vi.fn();
  for (const a of answers) q.mockResolvedValueOnce(a);
  return { query: q } as unknown as pg.PoolClient;
};

describe('the IVA workpaper refuses by key', () => {
  it('a prior balance in favor that is not an amount', async () => {
    expectKeyed(await caught(() => priorBalanceOf('-5')), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'priorBalanceInFavor',
      key: 'error.VALIDATION_ERROR.iva_workpaper.prior_balance_amount', params: { value: '-5' },
    });
  });

  it('a month outside 1..12, before any query', async () => {
    const client = clientAnswering();
    expectKeyed(await caught(buildIvaWorkpaper({ ...ctx, year: 2026, month: 13, client })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'month',
      key: 'error.VALIDATION_ERROR.iva_workpaper.month', params: { month: '13' },
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('an entity that does not owe Mexican IVA', async () => {
    // The entity exists in the tenant; its row for the regime switch is absent: not Mexican.
    const client = clientAnswering({ rowCount: 1, rows: [] }, { rowCount: 0, rows: [] });
    expectKeyed(await caught(buildIvaWorkpaper({ ...ctx, year: 2026, month: 6, client })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'entity_id',
      key: 'error.VALIDATION_ERROR.iva_workpaper.entity_without_mexican_iva', params: {},
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe('the ISR workpaper refuses by key', () => {
  it('a month outside 1..12, before any query', async () => {
    const client = clientAnswering();
    expectKeyed(await caught(buildProvisionalIncomeTaxWorkpaper({ ...ctx, year: 2026, month: 0, client })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'month',
      key: 'error.VALIDATION_ERROR.isr_workpaper.month', params: { month: '0' },
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('an amount that is not one names the option it came in', async () => {
    const client = clientAnswering();
    expectKeyed(await caught(buildProvisionalIncomeTaxWorkpaper({ ...ctx, year: 2026, month: 6, ptuPaidInYear: 'abc', client })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'ptuPaidInYear',
      key: 'error.VALIDATION_ERROR.isr_workpaper.amount', params: { field: 'ptuPaidInYear', value: 'abc' },
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('an entity without Mexican books', async () => {
    const client = clientAnswering({ rowCount: 1, rows: [{ tax_regime: '601' }] }, { rowCount: 0, rows: [] });
    expectKeyed(await caught(buildProvisionalIncomeTaxWorkpaper({ ...ctx, year: 2026, month: 6, client })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'entity_id',
      key: 'error.VALIDATION_ERROR.isr_workpaper.entity_without_mexican_books', params: {},
    });
  });
});

describe('the annual figures of the provisional ISR refuse by key, before any query', () => {
  const scope = entityScope(TENANT, ENTITY);
  const good: IncomeTaxInputCapture = {
    kind: 'profit_coefficient', value: '0.1234', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-25',
    sourceDocument: 'Synthetic annual return 2025', recordedBy: 'c3d4e5f6-0000-4000-8000-000000000727',
  };

  it('a month that is not a provisional payment month', async () => {
    expectKeyed(await caught(() => provisionalPaymentDueOn({ fiscalYear: 2026, month: 13 })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field: 'month',
      key: 'error.VALIDATION_ERROR.income_tax_input.payment_month', params: { year: '2026', month: '13' },
    });
  });

  it.each<[string, Partial<IncomeTaxInputCapture>, string, TranslationKey, MessageParams]>([
    ['an unknown kind', { kind: 'ptu_paid' as never }, 'kind', 'error.VALIDATION_ERROR.income_tax_input.kind',
      { kind: 'ptu_paid', known: 'profit_coefficient, pending_tax_losses' }],
    ['a fractional fiscal year', { sourceFiscalYear: 2025.5 }, 'sourceFiscalYear',
      'error.VALIDATION_ERROR.income_tax_input.year_not_integer', {}],
    ['a negative value', { value: '-0.1000' }, 'value', 'error.VALIDATION_ERROR.income_tax_input.value_format',
      { value: '-0.1000' }],
    ['a blank source', { sourceDocument: '   ' }, 'sourceDocument',
      'error.VALIDATION_ERROR.income_tax_input.source_missing', {}],
    ['a return dated inside its own year', { sourceFiledOn: '2025-12-31' }, 'sourceFiledOn',
      'error.VALIDATION_ERROR.income_tax_input.filed_inside_year', { year: '2025', filedOn: '2025-12-31' }],
    ['pending losses without their update month', { kind: 'pending_tax_losses' }, 'updatedThrough',
      'error.VALIDATION_ERROR.income_tax_input.update_month_required', {}],
    ['a coefficient with an update month', { updatedThrough: '2025-12' }, 'updatedThrough',
      'error.VALIDATION_ERROR.income_tax_input.update_month_only_for_losses', {}],
  ])('%s', async (_, change, field, key, params) => {
    expectKeyed(await caught(recordIncomeTaxInput(scope, { ...good, ...change })), {
      cls: ValidationError, code: 'VALIDATION_ERROR', status: 422, field, key, params,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
