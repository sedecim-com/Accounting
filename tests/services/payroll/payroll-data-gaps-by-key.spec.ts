/**
 * MNE-001-822 (#151), I9 by folder, part 7c: the SUA cross-check and the eight
 * plain `Error`s of src/services/payroll are catalogue keys now. The Spanish
 * twin must print, byte for byte, what each site printed before (the strings
 * below are written by hand from those sites, with synthetic values), and the
 * English is the source the error's `message` is fixed in. The eight are gaps
 * in the deployment's data, so each is a 500 with its own code, logged where
 * it is thrown; the SUA refusal stays a 422 whose findings follow the reader.
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach, type Mock, type MockInstance } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import { query, withTransaction } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, SuaMismatchError, ValidationError } from '../../../src/utils/errors.js';
import { logger } from '../../../src/utils/logger.js';
import { getTaxParameters, requiredParameter, requiredRates } from '../../../src/services/payroll/tax-engine/tax-tables.js';
import { tarifaDelPeriodo } from '../../../src/services/payroll/mx/isr-calculator.js';
import { subsidyDaysInPeriod } from '../../../src/services/payroll/mx/employment-subsidy.js';
import { previewPayRunEntry } from '../../../src/services/payroll/common/gl-posting-service.js';
import { generateSuaFile, suaMismatchFindings } from '../../../src/services/payroll/mx/sua-generator.js';
import type { PayFrequency } from '../../../src/services/payroll/tax-engine/tax-engine.interface.js';
import { negotiateLocale } from '../../../src/api/rest/middleware/locale.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

const mockQuery = query as unknown as Mock;
const mockTransaction = withTransaction as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

type Case = readonly [TranslationKey, MessageParams, string, string];

const MAPPING = { bucket: 'isr_payable', amount: '100.00', value: 'cuenta_por_cobrar_fisco' };
const BIWEEKLY = { frequency: 'biweekly' };
const MISMATCH = { jurisdiction: 'MX', taxYear: 2025, day: '2026-03-15' };
const NO_ROW = { jurisdiction: 'MX', day: '1999-06-01', taxYear: 1999 };
const UMA = { parameter: 'uma_daily', jurisdiction: 'MX', taxYear: 2027 };
const BLOCK = { block: 'imss_employee', taxYear: 2027 };
const RATES = { block: 'imss_employee', taxYear: 2027, missing: 'invalidez_vida, cesantia_vejez' };
const SUA_GAP = { file: '1000.00', concept: 'imss_employer', monthStart: '2026-03-01', monthEnd: '2026-03-31' };
const SUA_OFF = { concept: 'imss_employer', file: '1000.00', ledger: '1500.00', difference: '500.00' };
const BACKFILL = '`npm run backfill:straddling-liabilities -- --tenant <id>`';

// [key, params, the Spanish of before, the English source]
const CASES: readonly Case[] = [
  ['error.PAYROLL_ACCOUNT_MAPPING_MISSING.subsidy_in_cash', MAPPING,
    'Missing payroll_account_mapping for bucket: isr_payable. La corrida entregó 100.00 de subsidio al empleo en ' +
      'efectivo y la política subsidio_al_empleo_entregado_registro dice registrarlo como cuenta_por_cobrar_fisco.',
    'Missing payroll_account_mapping for bucket: isr_payable. The run handed over 100.00 of employment subsidy in ' +
      'cash and the policy subsidio_al_empleo_entregado_registro says to record it as cuenta_por_cobrar_fisco.'],
  ['error.EMPLOYMENT_SUBSIDY_PERIOD_UNSUPPORTED', BIWEEKLY,
    'No hay regla del subsidio al empleo para el periodo «biweekly»: el decreto prorratea por días entre 30.4, y ' +
      'sólo la semana (7), la quincena (15) y el mes tienen tarifa del art. 96 con la que acreditarlo. Configura la ' +
      'nómina como semanal, quincenal o mensual.',
    'There is no employment subsidy rule for the period "biweekly": the decree prorates by days over 30.4, and only ' +
      'the week (7), the fortnight (15) and the month have an art. 96 tariff to credit it against. Set the payroll ' +
      'up as weekly, fortnightly or monthly.'],
  ['error.ISR_TARIFF_PERIOD_UNSUPPORTED', BIWEEKLY,
    'No hay tarifa del art. 96 publicada para el periodo «biweekly»: el Anexo 8 publica diaria, 7, 10 y 15 días y ' +
      'mensual, y no catorcenal. Antes se le aplicaba la MENSUAL a la base del periodo, que subretiene entre el 85 % ' +
      'y el 100 %. Configura la nómina como quincenal o mensual, o siembra la tarifa que corresponda con su fuente.',
    'No art. 96 tariff is published for the period "biweekly": Anexo 8 publishes daily, 7, 10 and 15 days and ' +
      'monthly, and no 14-day one. The MONTHLY tariff used to be applied to the base of the period, which ' +
      'under-withholds by between 85 % and 100 %. Set the payroll up as fortnightly or monthly, or seed the tariff ' +
      'that applies, with its source.'],
  ['error.TAX_PARAMETERS_YEAR_MISMATCH', MISMATCH,
    'Se pidieron los parámetros de MX para el ejercicio 2025 con una fecha de otro año (2026-03-15): el ejercicio y ' +
      'la fecha del acto tienen que ser el mismo, o el recálculo de un recibo viejo tomaría los parámetros de hoy.',
    'The parameters of MX were asked for the tax year 2025 with a date of another year (2026-03-15): the tax year ' +
      'and the date of the act must be the same, or recalculating an old payslip would take today\'s parameters.'],
  ['error.TAX_PARAMETERS_MISSING', NO_ROW,
    'No hay parámetros fiscales de MX vigentes el 1999-06-01 (ejercicio 1999): siembra la fila en tax_parameters ' +
      'antes de calcular. Sin ella no se puede retener, y una cifra inventada sale en el recibo, en el CFDI y en la ' +
      'línea de captura.',
    'No tax parameters of MX are in force on 1999-06-01 (tax year 1999): seed the row in tax_parameters before ' +
      'calculating. Without it nothing can be withheld, and an invented figure reaches the payslip, the CFDI and ' +
      'the payment reference line.'],
  ['error.TAX_PARAMETER_MISSING', UMA,
    'Falta el parámetro fiscal «uma_daily» de MX para 2027: sin él no se puede calcular la cuota. Antes se ' +
      'sustituía por un valor quemado y la cifra inventada salía en el recibo, en el CFDI de nómina y en la línea ' +
      'de captura.',
    'The tax parameter "uma_daily" of MX for 2027 is missing: without it the contribution cannot be computed. It ' +
      'used to be replaced by a hard-coded value, and the invented figure reached the payslip, the payroll CFDI and ' +
      'the payment reference line.'],
  ['error.TAX_RATES_MISSING.block', BLOCK,
    'Falta el bloque de tasas «imss_employee» de MX para 2027: sin él la cuota saldría en cero con los días ' +
      'cotizados correctos, que es un recibo creíble y falso.',
    'The rate block "imss_employee" of MX for 2027 is missing: without it the contribution would come out as zero ' +
      'with the right contribution days, which is a payslip that is credible and false.'],
  ['error.TAX_RATES_MISSING.rates', RATES,
    'Faltan tasas en «imss_employee» de MX para 2027: invalidez_vida, cesantia_vejez. Una tasa ausente no es una ' +
      'tasa de cero.',
    'Rates are missing in "imss_employee" of MX for 2027: invalidez_vida, cesantia_vejez. A missing rate is not a ' +
      'zero rate.'],
  ['payroll.sua.finding.no_liability', SUA_GAP,
    'el archivo declara 1000.00 de imss_employer y no hay ningún renglón de pasivo apuntado para ' +
      '2026-03-01..2026-03-31 contra el que cotejarlo: la cifra sale de un solo camino y nadie la confirma',
    'the file declares 1000.00 of imss_employer and no liability row is recorded for 2026-03-01..2026-03-31 to ' +
      'check it against: the figure comes from one road only and nobody confirms it'],
  ['payroll.sua.finding.mismatch', SUA_OFF,
    'imss_employer: el archivo declara 1000.00 y el pasivo apuntado dice 1500.00 (diferencia 500.00). Si un ' +
      'periodo cruza el cambio de mes y su pasivo se apuntó antes del reparto por días cotizados, ese renglón lo ' +
      `lleva entero en un solo mes: ${BACKFILL} lo reparte`,
    'imss_employer: the file declares 1000.00 and the recorded liability says 1500.00 (difference 500.00). If a ' +
      'period crosses the month end and its liability was recorded before the split by contribution days, that ' +
      `row carries it whole in one month: ${BACKFILL} splits it`],
];

const caseOf = (key: TranslationKey): Case => CASES.find((c) => c[0] === key)!;
const SUA_FRAME_ES = 'El archivo del SUA no cuadra con el pasivo patronal ya apuntado, así que no se entrega: ';
const SUA_FRAME_EN = 'The SUA file does not match the employer liability already recorded, so it is not delivered: ';

let logged: MockInstance;
beforeEach(() => {
  mockQuery.mockReset();
  mockPolicy.mockReset();
  mockTransaction.mockReset();
  logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
});
afterEach(() => logged.mockRestore());

describe('each key renders what its site printed', () => {
  it.each(CASES)('%s in es is the Spanish of before, and in en its source', (key, params, spanish, english) => {
    expect(t(key, params, 'es')).toBe(spanish);
    expect(t(key, params, 'en')).toBe(english);
  });
});

async function thrown(act: () => unknown): Promise<AppError> {
  try {
    await act();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('it did not throw');
}

/** A run whose cash subsidy (100.00) has no account: only the three mandatory buckets are mapped. */
function cashSubsidyWithoutAccount(): Promise<unknown> {
  const rows = (sql: string): unknown[] => {
    if (/FROM pay_runs pr/.test(sql)) return [{ status: 'approved', journal_entry_id: null, entity_id: 'n-1' }];
    if (/FROM paychecks/.test(sql)) return [{ isr: '-100.00' }];
    if (!/FROM payroll_account_mapping/.test(sql)) return [];
    return ['wages_expense', 'payroll_tax_expense', 'cash_payroll'].map((bucket, i) => ({ bucket, account_id: `a-${i}`, code: `60${i}` }));
  };
  mockTransaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ query: async (sql: string) => ({ rows: rows(sql) }) }));
  mockPolicy.mockResolvedValue({ key: 'subsidio_al_empleo_entregado_registro', value: 'cuenta_por_cobrar_fisco', defined: true });
  return previewPayRunEntry('run-1', 't-1', 'n-1');
}

describe('the eight gaps are a 500 with their own code, logged where they are thrown', () => {
  it.each([
    ['PAYROLL_ACCOUNT_MAPPING_MISSING', 'error.PAYROLL_ACCOUNT_MAPPING_MISSING.subsidy_in_cash', cashSubsidyWithoutAccount],
    ['TAX_PARAMETER_MISSING', 'error.TAX_PARAMETER_MISSING', () => requiredParameter({}, 'uma_daily', 'MX', 2027)],
    ['TAX_RATES_MISSING', 'error.TAX_RATES_MISSING.block', () => requiredRates({}, 'imss_employee', ['x'], 2027)],
    ['TAX_RATES_MISSING', 'error.TAX_RATES_MISSING.rates',
      () => requiredRates({ imss_employee: { enf_mat: 0.4 } }, 'imss_employee', ['enf_mat', 'invalidez_vida', 'cesantia_vejez'], 2027)],
    ['TAX_PARAMETERS_YEAR_MISMATCH', 'error.TAX_PARAMETERS_YEAR_MISMATCH', () => getTaxParameters('MX', 2025, '2026-03-15')],
    ['TAX_PARAMETERS_MISSING', 'error.TAX_PARAMETERS_MISSING', () => getTaxParameters('MX', 1999, '1999-06-01')],
    ['ISR_TARIFF_PERIOD_UNSUPPORTED', 'error.ISR_TARIFF_PERIOD_UNSUPPORTED', () => tarifaDelPeriodo('biweekly' as PayFrequency)],
    ['EMPLOYMENT_SUBSIDY_PERIOD_UNSUPPORTED', 'error.EMPLOYMENT_SUBSIDY_PERIOD_UNSUPPORTED',
      () => subsidyDaysInPeriod('biweekly' as PayFrequency)],
  ] as const)('%s (%s)', async (code, key, act) => {
    mockQuery.mockResolvedValue({ rows: [] });
    const err = await thrown(act);
    const [, params, spanish, english] = caseOf(key);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 500, code, messageKey: { key, params } });
    expect(err.message).toBe(english);
    expect(err.localized('es')).toBe(spanish);
    expect(logged).toHaveBeenCalledWith('payroll_data_gap', { code, key, ...params });
  });
});

/** One March payslip of 1,000.00 employer IMSS, and the liability `booked` (none: no row). */
function suaMonth(booked: string | null): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM employer_tax_liabilities/.test(sql)) {
      return { rows: booked === null ? [] : [{ tax_type: 'imss_employer', total: booked }] };
    }
    return {
      rows: [{
        employee_id: 'e-1', nss: 'NSS0000001', rfc: 'XAXX010101000', curp: 'CURP000000SYNTH001', last_name: 'Uno',
        second_last_name: null, first_name: 'Persona', sbc: '500.00', imss_employee: '0', imss_employer: '1000.00',
        infonavit_withheld: '0', infonavit_employer: '0', period_start: '2026-03-01', period_end: '2026-03-15',
      }],
    };
  });
}

describe('the SUA refusal is one language, its findings included', () => {
  const [, , spanish, english] = caseOf('payroll.sua.finding.mismatch');

  it('refuses with every finding in the reader\'s language and the difference as computed', async () => {
    suaMonth('1500.00');
    const err = await thrown(() => generateSuaFile('t-1', 'n-1', 2026, 3, { record: false }));
    expect(err).toBeInstanceOf(SuaMismatchError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(err.localized('es')).toBe(SUA_FRAME_ES + spanish);
    expect(err.message).toBe(SUA_FRAME_EN + english);
    // The findings keep their code, figures and stored Spanish detail.
    expect(suaMismatchFindings(err)).toEqual([{
      codigo: 'el_archivo_no_cuadra_con_el_pasivo', concepto: 'imss_employer', bloquea: true,
      detalle: spanish, file_amount: '1000.00', ledger_amount: '1500.00',
    }]);
  });

  it('the finding with nothing to check against is stored in Spanish, whoever reads it', async () => {
    suaMonth(null);
    const r = await generateSuaFile('t-1', 'n-1', 2026, 3, { record: false });
    expect(r.hallazgos).toEqual([{
      codigo: 'sin_pasivo_que_cotejar', concepto: 'imss_employer', bloquea: false,
      detalle: caseOf('payroll.sua.finding.no_liability')[2], file_amount: '1000.00', ledger_amount: null,
    }]);
  });
});

describe('a REST client reads the code, and the message in its language', () => {
  let server: Server;
  beforeAll(async () => {
    const app = express();
    app.use(negotiateLocale);
    app.get('/gap', () => requiredParameter({}, 'uma_daily', 'MX', 2027));
    app.get('/sua', () => {
      throw new SuaMismatchError([{ key: 'payroll.sua.finding.mismatch', params: SUA_OFF }], { findings: [] });
    });
    app.use(errorHandler);
    await new Promise<void>((ok) => (server = app.listen(0, '127.0.0.1', () => ok())));
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  type Answer = { status: number; language?: string; error: { code: string; message: string } };
  // Through node:http, not fetch: fetch adds `accept-language: *` to a request that sends none.
  const call = (path: string, language?: string) => new Promise<Answer>((ok, ko) => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
    request(url, { headers: language ? { 'accept-language': language } : {} }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString('utf-8')));
      res.on('end', () => ok({
        status: res.statusCode ?? 0,
        language: res.headers['content-language'],
        error: (JSON.parse(raw) as { errors: Answer['error'][] }).errors[0],
      }));
    }).on('error', ko).end();
  });

  it.each([
    ['/gap', 500, 'TAX_PARAMETER_MISSING', '', caseOf('error.TAX_PARAMETER_MISSING')],
    ['/sua', 422, 'VALIDATION_ERROR', 'frame', caseOf('payroll.sua.finding.mismatch')],
  ] as const)('%s: %i %s, es-MX without a header, English when asked', async (path, status, code, frame, c) => {
    const none = await call(path);
    expect(none).toMatchObject({ status, language: 'es-MX', error: { code, message: (frame ? SUA_FRAME_ES : '') + c[2] } });
    const en = await call(path, 'en');
    expect(en).toMatchObject({ status, language: 'en-US', error: { code, message: (frame ? SUA_FRAME_EN : '') + c[3] } });
  });
});
