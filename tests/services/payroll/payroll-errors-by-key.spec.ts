/**
 * MNE-001-730 (#151), I9 by folder, part 7: the refusals of src/services/payroll
 * that reached the requester in Spanish prose are catalogue keys now. The
 * Spanish twin must print, byte for byte, what each site printed before (the
 * strings below are written by hand from those sites, with synthetic values),
 * and the English is the source the error's `message` is fixed in. The two
 * guards of the subsidy calculator's input contract are for a developer, and
 * are English prose.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
  getPolicyNumber: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError, ValidationError } from '../../../src/utils/errors.js';
import {
  criterioCausacionDe,
  criterioProvisionDe,
  inicioDeMes,
} from '../../../src/services/payroll/common/employer-liability-service.js';
import { criterioEstadoDe } from '../../../src/services/payroll/mx/isn-calculator.js';
import {
  readEmploymentSubsidyRounding,
  readEmploymentSubsidySeparateRun,
} from '../../../src/services/payroll/mx/employment-subsidy.js';
import { leerRegistroDelSubsidio } from '../../../src/services/payroll/mx/subsidio-entregado.js';
import { MexicoSubsidioEmpleoCalculator } from '../../../src/services/payroll/mx/isr-calculator.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

type Case = readonly [TranslationKey, MessageParams, string];

const RUN = 'a1b2c3d4-0000-4000-8000-000000000730';
const BAJAS = 'renuncia, despido, rescision_por_el_trabajador, muerte';

const SPANISH_AS_BEFORE: readonly Case[] = [
  ['error.VALIDATION_ERROR.payroll.policy.provision_cuotas_patronales',
    { value: 'mensual', known: 'por_corrida, mensual_al_cierre', choices: 'por_corrida|mensual_al_cierre' },
    'La política provision_cuotas_patronales vale "mensual" y este motor sólo entiende por_corrida, ' +
      'mensual_al_cierre. No se elige uno por ti: de esa respuesta depende si las cuotas patronales se ' +
      'apuntan con cada corrida o una vez al mes, y aplicar la omisión como si fuera tu criterio deja el ' +
      'pasivo del mes repartido entre dos formas de contarlo. Corrígela con ' +
      '`mnemosine pending define provision_cuotas_patronales <por_corrida|mensual_al_cierre>`.'],
  ['error.VALIDATION_ERROR.payroll.policy.isn_momento_de_causacion',
    { value: 'pagos', known: 'devengo, pago', choices: 'devengo|pago' },
    'La política isn_momento_de_causacion vale "pagos" y este motor sólo entiende devengo, pago. No se ' +
      'elige uno por ti: de esa respuesta depende a qué MES pertenece el ISN de una nómina que cruza el fin ' +
      'de mes, y con él su fecha límite: un pasivo apuntado un mes antes de lo decidido no se distingue de ' +
      'uno correcto hasta que llega el requerimiento. Corrígela con ' +
      '`mnemosine pending define isn_momento_de_causacion <devengo|pago>`.'],
  ['error.VALIDATION_ERROR.payroll.policy.isn_estado_que_causa',
    { value: 'domicilio', known: 'centro_de_trabajo, domicilio_fiscal', choices: 'centro_de_trabajo|domicilio_fiscal' },
    'La política isn_estado_que_causa vale "domicilio" y este motor sólo entiende centro_de_trabajo, ' +
      'domicilio_fiscal. No se elige uno por ti: de esa respuesta depende a qué estado se le declara el ' +
      'ISN, y aplicar la omisión como si fuera tu criterio es cómo se le acaba debiendo a un estado durante ' +
      'años. Corrígela con `mnemosine pending define isn_estado_que_causa <centro_de_trabajo|domicilio_fiscal>`.'],
  ['error.VALIDATION_ERROR.payroll.date_unreadable', { date: 'marzo de 2026' },
    'Se esperaba una fecha \'YYYY-MM-DD\' y llegó "marzo de 2026": una fecha ilegible aquí produciría una ' +
      'fecha límite plausible y falsa.'],
  ['error.VALIDATION_ERROR.payroll.pay_run_not_found', { payRunId: RUN },
    `No existe la corrida de nómina ${RUN} en este inquilino.`],
  ['error.VALIDATION_ERROR.payroll.pay_run_not_closed', { payRunId: RUN, status: 'calculated' },
    `La corrida ${RUN} está en estado "calculated": el pasivo patronal se apunta cuando la corrida se ` +
      'cierra (approved o paid), no antes. Apuntarlo sobre números que todavía pueden cambiar deja un ' +
      'pasivo que no corresponde a ningún recibo.'],
  ['error.POLICY_VALUE_UNKNOWN.payroll_reader',
    { policy: 'subsidio_al_empleo_redondeo', value: 'truncar', known: 'producto_al_centavo, diario_al_centavo' },
    'La política subsidio_al_empleo_redondeo vale "truncar" y este lector sólo entiende ' +
      'producto_al_centavo, diario_al_centavo. Corrígela en mnemosine pending.'],
  ['error.VALIDATION_ERROR.payroll.termination_reason', { known: BAJAS },
    `termination_reason inválido o ausente: se esperaba ${BAJAS}. Decide si hay prima de antigüedad, que ` +
      'en un trabajador antiguo es la prestación más grande del finiquito, así que no tiene valor por omisión.'],
];

const ENGLISH: readonly Case[] = [
  ['error.VALIDATION_ERROR.payroll.policy.provision_cuotas_patronales',
    { value: 'mensual', known: 'por_corrida, mensual_al_cierre', choices: 'por_corrida|mensual_al_cierre' },
    'The policy provision_cuotas_patronales is set to "mensual" and this engine only understands ' +
      'por_corrida, mensual_al_cierre. None is chosen for you: that answer decides whether the employer ' +
      'contributions are booked with each run or once a month, and applying the default as if it were your ' +
      'criterion leaves the month\'s liability split between two ways of counting it. Correct it with ' +
      '`mnemosine pending define provision_cuotas_patronales <por_corrida|mensual_al_cierre>`.'],
  ['error.VALIDATION_ERROR.payroll.policy.isn_momento_de_causacion',
    { value: 'pagos', known: 'devengo, pago', choices: 'devengo|pago' },
    'The policy isn_momento_de_causacion is set to "pagos" and this engine only understands devengo, pago. ' +
      'None is chosen for you: that answer decides which MONTH the ISN of a payroll that crosses the month ' +
      'end belongs to, and with it its due date: a liability booked a month earlier than decided cannot be ' +
      'told from a correct one until the authority\'s demand arrives. Correct it with ' +
      '`mnemosine pending define isn_momento_de_causacion <devengo|pago>`.'],
  ['error.VALIDATION_ERROR.payroll.policy.isn_estado_que_causa',
    { value: 'domicilio', known: 'centro_de_trabajo, domicilio_fiscal', choices: 'centro_de_trabajo|domicilio_fiscal' },
    'The policy isn_estado_que_causa is set to "domicilio" and this engine only understands ' +
      'centro_de_trabajo, domicilio_fiscal. None is chosen for you: that answer decides which state the ISN ' +
      'is declared to, and applying the default as if it were your criterion is how a firm ends up owing a ' +
      'state for years. Correct it with ' +
      '`mnemosine pending define isn_estado_que_causa <centro_de_trabajo|domicilio_fiscal>`.'],
  ['error.VALIDATION_ERROR.payroll.date_unreadable', { date: 'marzo de 2026' },
    'Expected a date \'YYYY-MM-DD\' and got "marzo de 2026": an unreadable date here would produce a ' +
      'plausible and false due date.'],
  ['error.VALIDATION_ERROR.payroll.pay_run_not_found', { payRunId: RUN },
    `Pay run ${RUN} does not exist in this tenant.`],
  ['error.VALIDATION_ERROR.payroll.pay_run_not_closed', { payRunId: RUN, status: 'calculated' },
    `Pay run ${RUN} is in status "calculated": the employer liability is booked when the run closes ` +
      '(approved or paid), not before. Booking it on figures that can still change leaves a liability that ' +
      'matches no payslip.'],
  ['error.POLICY_VALUE_UNKNOWN.payroll_reader',
    { policy: 'subsidio_al_empleo_redondeo', value: 'truncar', known: 'producto_al_centavo, diario_al_centavo' },
    'The policy subsidio_al_empleo_redondeo is set to "truncar" and this reader only understands ' +
      'producto_al_centavo, diario_al_centavo. Correct it in mnemosine pending.'],
  ['error.VALIDATION_ERROR.payroll.termination_reason', { known: BAJAS },
    `termination_reason is invalid or missing: expected ${BAJAS}. It decides whether a seniority premium ` +
      'is owed, which for a long-serving worker is the largest item of the severance settlement, so it has ' +
      'no default.'],
];

const caseOf = (cases: readonly Case[], key: TranslationKey): Case => cases.find((c) => c[0] === key)!;

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockPolicy.mockReset();
});

afterEach(() => {
  resetLanguage();
});

describe('each key renders what its site printed', () => {
  it.each(SPANISH_AS_BEFORE)('%s in es is the Spanish of before', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it.each(ENGLISH)('%s in en', (key, params, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });
});

describe('the sites throw the key, with the code and field they always had', () => {
  it.each([
    ['provision_cuotas_patronales', criterioProvisionDe, 'mensual'],
    ['isn_momento_de_causacion', criterioCausacionDe, 'pagos'],
    ['isn_estado_que_causa', criterioEstadoDe, 'domicilio'],
  ] as const)('an unknown answer of %s is a keyed VALIDATION_ERROR on that field', (policy, read, value) => {
    const key = `error.VALIDATION_ERROR.payroll.policy.${policy}` as TranslationKey;
    let err: unknown;
    try {
      read(value);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR', field: policy, messageKey: { key } });
    expect((err as ValidationError).message).toBe(caseOf(ENGLISH, key)[2]);
    expect((err as ValidationError).localized('es')).toBe(caseOf(SPANISH_AS_BEFORE, key)[2]);
  });

  it('an unreadable date is a keyed VALIDATION_ERROR on fecha', () => {
    let err: unknown;
    try {
      inicioDeMes('marzo de 2026');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'fecha',
      messageKey: { key: 'error.VALIDATION_ERROR.payroll.date_unreadable', params: { date: 'marzo de 2026' } },
    });
    expect((err as ValidationError).localized('es')).toBe(caseOf(SPANISH_AS_BEFORE, 'error.VALIDATION_ERROR.payroll.date_unreadable')[2]);
  });

  it.each([
    ['EMPLOYMENT_SUBSIDY_ROUNDING_UNKNOWN', 'subsidio_al_empleo_redondeo', 'truncar',
      'producto_al_centavo, diario_al_centavo', () => readEmploymentSubsidyRounding({ tenantId: 't' })],
    ['EMPLOYMENT_SUBSIDY_SEPARATE_RUN_UNKNOWN', 'employment_subsidy_separate_run', 'twice',
      'recompute_on_combined_income, none_on_separate_paycheck', () => readEmploymentSubsidySeparateRun({ tenantId: 't' })],
    ['SUBSIDIO_REGISTRO_DESCONOCIDO', 'subsidio_al_empleo_entregado_registro', 'lo_que_sea',
      'cuenta_por_cobrar_fisco, gasto_del_patron', () => leerRegistroDelSubsidio({ tenantId: 't' })],
  ] as const)('%s keeps its code and shares one key', async (code, policy, value, known, read) => {
    mockPolicy.mockResolvedValue({ key: policy, value, defined: true });
    const err = await read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect(err).toMatchObject({
      statusCode: 422,
      code,
      messageKey: { key: 'error.POLICY_VALUE_UNKNOWN.payroll_reader', params: { policy, value, known } },
    });
    expect((err as AccountingError).localized('es')).toBe(
      `La política ${policy} vale "${value}" y este lector sólo entiende ${known}. Corrígela en mnemosine pending.`
    );
    expect((err as AccountingError).message).toBe(
      `The policy ${policy} is set to "${value}" and this reader only understands ${known}. Correct it in mnemosine pending.`
    );
  });
});

describe('the input contract of the subsidy calculator speaks to a developer, in English', () => {
  const calc = new MexicoSubsidioEmpleoCalculator();
  const base = { taxable_wages: 3000, pay_frequency: 'quincenal', tax_year: 2026 } as const;

  it('no payment date', async () => {
    await expect(calc.calculate({ ...base, employment_subsidy_rounding: 'producto_al_centavo' })).rejects.toThrow(
      'The employment subsidy is computed with the law in force on the payment date, and this input carries no ' +
        'payment date: the UMA changes on February 1st and the year is not enough to know which one rules.'
    );
  });

  it('no rounding', async () => {
    await expect(calc.calculate({ ...base, pay_date: '2026-03-13' })).rejects.toThrow(
      'The employment subsidy needs the policy subsidio_al_empleo_redondeo: the decree does not say how to ' +
        'round, so the firm decides it and not this calculator. Read it with readEmploymentSubsidyRounding and ' +
        'pass it in the input.'
    );
  });
});
