/**
 * MNE-001-815 (#151), I9 by folder, part 7b: the findings and notes of
 * src/services/payroll that a person reads are catalogue keys now. The Spanish
 * twin must print, byte for byte, what each site wrote before (the strings
 * below are written by hand from those sites, with synthetic values), and an
 * English session reads English.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import { query } from '../../../src/database/connection.js';
import { t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import type { ErrorMessageKey } from '../../../src/utils/errors.js';
import { calcularIsn, type HallazgoNomina } from '../../../src/services/payroll/mx/isn-calculator.js';
import { calcularFiniquito, type EntradaFiniquito } from '../../../src/services/payroll/mx/finiquito-math.js';
import { findingText } from '../../../src/i18n/payroll-finding-text.js';

const mockQuery = query as unknown as Mock;
const MARCH = { periodoInicio: '2026-03-01', periodoFin: '2026-03-15', fechaCausacion: '2026-03-15' };
const BASE = [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }];

function rate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estado: 'JAL', vigencia_desde: '2026-01-01', vigencia_hasta: null, tasa: '0.030000',
    regimen: 'tasa_plana', exencion_mensual: null, fundamento: 'Ley de Hacienda de Jalisco', ...over,
  };
}

async function isnFinding(rows: Record<string, unknown>[], bases = BASE): Promise<HallazgoNomina> {
  mockQuery.mockResolvedValue({ rows });
  const r = await calcularIsn({ bases, ...MARCH });
  expect(r.hallazgos).toHaveLength(1);
  return r.hallazgos[0];
}

beforeEach(() => mockQuery.mockReset());

describe('the ISN findings are keys, rendered in the reader language', () => {
  it('no state on the worker', async () => {
    const h = await isnFinding([], [{ estado: null, base: '40000.0000', trabajadores: 2 }] as never);
    expect(h.mensaje).toMatchObject({ key: 'payroll.finding.isn_sin_estado_en_el_trabajador' });
    expect(findingText(h, 'es')).toBe(
      '2 recibo(s) del periodo 2026-03-01 a 2026-03-15 suman 40000.0000 sin estado que los cause: el ISN de ' +
        'esa base no se puede calcular ni declarar. Captura el estado de trabajo del trabajador, o cambia la ' +
        'política isn_estado_que_causa a domicilio_fiscal si tu criterio es declararlo todo en el domicilio ' +
        'de la entidad.'
    );
    expect(findingText(h, 'en')).toMatch(/^2 payslip\(s\) of the period 2026-03-01 to 2026-03-15 add up to 40000\.0000/);
  });

  it('no rate captured, and rates that do not cover the causation date', async () => {
    const none = await isnFinding([]);
    expect(findingText(none, 'es')).toBe(
      'No hay tasa de ISN capturada para JAL en el periodo 2026-03-01 a 2026-03-15 (causación 2026-03-15). ' +
        'La base de 100000.0000 de 7 recibo(s) queda SIN calcular: no se declara cero, se declara que falta ' +
        'el dato. Captura la tasa con su fundamento en mx_isn_tasas_estatales.'
    );
    expect(findingText(none, 'en')).toMatch(/^No ISN rate is captured for JAL in the period 2026-03-01 to 2026-03-15/);

    const gap = await isnFinding([rate({ vigencia_desde: '2025-01-01', vigencia_hasta: '2026-03-10' })]);
    expect(findingText(gap, 'es')).toBe(
      'JAL tiene 1 vigencia(s) capturada(s) que tocan el periodo 2026-03-01 a 2026-03-15 o su causación, ' +
        'pero ninguna cubre la fecha de causación 2026-03-15: la base de 100000.0000 queda sin calcular. ' +
        'Revisa vigencia_desde/vigencia_hasta.'
    );
    expect(findingText(gap, 'en')).toMatch(/but none covers the causation date 2026-03-15/);
  });

  it('a regime the engine cannot compute, with and without a monthly exemption', async () => {
    const stepped = await isnFinding([rate({ regimen: 'escalonado' })]);
    const tail =
      ', y este motor sólo sabe calcular tasa plana. La base de 100000.0000 del periodo 2026-03-01 a ' +
      '2026-03-15 NO se calcula: aplicarle la tasa como si fuera plana daría un importe de la magnitud ' +
      'correcta y del valor equivocado.';
    expect(findingText(stepped, 'es')).toBe(
      'La tasa de ISN de JAL vigente desde 2026-01-01 está capturada como régimen «escalonado»' + tail
    );
    const exempt = await isnFinding([rate({ regimen: 'con_exencion', exencion_mensual: '5000.0000' })]);
    expect(findingText(exempt, 'es')).toBe(
      'La tasa de ISN de JAL vigente desde 2026-01-01 está capturada como régimen «con_exencion» ' +
        '(exime 5000.0000 al mes)' + tail
    );
    expect(findingText(exempt, 'en')).toMatch(/regime «con_exencion» \(it exempts 5000\.0000 a month\), and this engine/);
  });

  it('a rate that changes within the period', async () => {
    const h = await isnFinding([
      rate({ vigencia_hasta: '2026-03-10' }),
      rate({ vigencia_desde: '2026-03-10', tasa: '0.040000' }),
    ]);
    expect(h.severidad).toBe('aviso');
    expect(findingText(h, 'es')).toBe(
      'JAL cambió de tasa dentro del periodo 2026-03-01 a 2026-03-15: se aplicó la vigente al 2026-03-15 ' +
        '(0.040000, desde 2026-03-10) a la base completa, sin partirla por días.'
    );
    expect(findingText(h, 'en')).toMatch(/^JAL changed its rate within the period 2026-03-01 to 2026-03-15/);
  });
});

type Case = readonly [TranslationKey, MessageParams, string];

// The employer liability's findings, with the params each site passes.
const LIABILITY: readonly Case[] = [
  ['payroll.finding.recibos_de_otra_entidad_en_la_corrida', { count: 2, entityId: 'ent-815' },
    '2 recibo(s) mexicanos de esta corrida son de trabajadores de OTRA entidad legal y no entran en el ' +
      'pasivo de ent-815, que es la del calendario de la corrida. Su IMSS, INFONAVIT e ISN no quedan ' +
      'acumulados en ninguna parte.'],
  ['payroll.finding.imss_patronal_en_cero', { count: 3 },
    'La corrida tiene 3 recibo(s) mexicanos y el IMSS patronal suma cero. Revisa el SBC de esos ' +
      'trabajadores: sin él no hay cuota que acumular y el costo laboral de la corrida queda corto.'],
  ['payroll.finding.pasivo_por_corrida_absorbido_por_el_mensual', { count: 2 },
    '2 renglón(es) de cuotas patronales que esta corrida había apuntado por su cuenta se retiraron: ' +
      '`provision_cuotas_patronales` dice ahora «mensual_al_cierre» y el renglón del mes ya los incluye. ' +
      'Dejarlos habría duplicado el IMSS patronal del mes.'],
  ['payroll.finding.share_in_already_settled_month',
    { days: 4, start: '2026-02-25', end: '2026-02-28', monthStart: '2026-02-01', closedRows: 2, settled: 'both' },
    'La corrida cruza el cambio de mes: 4 día(s) cotizados, del 2026-02-25 al 2026-02-28, caen en el mes ' +
      'que inicia el 2026-02-01, que ya tiene 2 renglón(es) de IMSS/INFONAVIT patronal ya depositados y su ' +
      'archivo del SUA ya generado. Esa parte de las cuotas llega después de cerrado el mes: el SUA ya ' +
      'generado la declara de menos y, si el renglón del mes ya se depositó, no se reescribe. Presenta la ' +
      'complementaria de ese mes.'],
  ['payroll.finding.pasivo_reubicado_de_mes', { count: 1 },
    '1 renglón(es) de pasivo de esta corrida cambiaron de mes en este cierre y el apunte anterior se ' +
      'retiró: la respuesta de `isn_momento_de_causacion` mueve el ISN al mes del devengo o al del pago, y ' +
      'dejar los dos habría duplicado el impuesto. Revisa las fechas límite del mes que se vació y del que ' +
      'se llenó.'],
  ['payroll.finding.pasivo_ya_depositado_no_se_toca', { count: 2, rows: 'imss_employer/MX, isn/MX-JAL' },
    "2 renglón(es) de pasivo ya no están en 'pending' —depositados, dispensados o marcados como " +
      'tardíos— y NO se reescribieron: imss_employer/MX, isn/MX-JAL. Cambiarles el importe borraría la ' +
      'evidencia de lo que se pagó.'],
];

describe('the employer liability findings print today\'s Spanish', () => {
  it.each(LIABILITY)('%s', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
    expect(t(key, params, 'en')).not.toBe(spanish);
  });

  it('the settled month names only what it has', () => {
    const p = { days: 4, start: '2026-02-25', end: '2026-02-28', monthStart: '2026-02-01', closedRows: 0 };
    const key = 'payroll.finding.share_in_already_settled_month';
    expect(t(key, { ...p, settled: 'sua' }, 'es')).toContain('que ya tiene su archivo del SUA ya generado. Esa');
    expect(t(key, { ...p, closedRows: 1, settled: 'rows' }, 'es')).toContain(
      'que ya tiene 1 renglón(es) de IMSS/INFONAVIT patronal ya depositados. Esa'
    );
    expect(t(key, { ...p, settled: 'sua' }, 'en')).toContain('which already has its SUA file already generated.');
  });

  it('the rows of a month booked both ways are rendered in the same language as their sentence', () => {
    const row = (taxType: string, amount: string): ErrorMessageKey => ({
      key: 'payroll.finding.pasivo_mensual_y_por_corrida_a_la_vez.row',
      params: { taxType, amount, monthStart: '2026-02-01' },
    });
    const h: HallazgoNomina = {
      codigo: 'pasivo_mensual_y_por_corrida_a_la_vez',
      severidad: 'bloqueante',
      mensaje: { key: 'payroll.finding.pasivo_mensual_y_por_corrida_a_la_vez', params: { count: 2 } },
      lists: { rows: [row('imss_employer', '1285.71'), row('infonavit_employer', '642.86')] },
    };
    expect(findingText(h, 'es')).toBe(
      'Hay 2 renglón(es) de cuotas patronales provisionados AL CIERRE DEL MES en los meses que toca esta ' +
        'corrida (imss_employer 1285.71 del mes que inicia el 2026-02-01; infonavit_employer 642.86 del mes ' +
        'que inicia el 2026-02-01), y esta corrida los está apuntando además POR CORRIDA porque ' +
        '`provision_cuotas_patronales` cambió a «por_corrida». Lo provisionado queda contado dos veces. El ' +
        'renglón mensual agrega varias corridas y este cierre no lo puede retirar sin llevarse el pasivo de ' +
        'las demás: resuélvelo a mano antes de declarar.'
    );
    expect(findingText(h, 'en')).toContain(
      '(imss_employer 1285.71 of the month starting 2026-02-01; infonavit_employer 642.86 of the month starting 2026-02-01)'
    );
    expect(findingText({ ...h, mensaje: 'prosa' }, 'en')).toBe('prosa');
  });
});

describe('the seniority-premium note of the severance is a key', () => {
  // Fifteen years of service: 12 × 15 = 180 days; the base is capped at 2 × 315.04 = 630.08.
  const input: EntradaFiniquito = {
    fecha_alta: '2011-03-01', fecha_baja: '2026-06-30', pagado_hasta: '2026-06-15', salario_diario: '1000.00',
    dias_aguinaldo_por_anio: 15, prima_vacacional_pct: '0.25', motivo_baja: 'despido',
  };

  it.each([
    [{ motivo_baja: 'renuncia', fecha_alta: '2023-03-01' }, 'payroll.finiquito.seniority_premium.not_owed',
      'no se devenga: la renuncia paga prima de antigüedad sólo con quince años cumplidos (LFT art. 162 fr. III)'],
    [{ motivo_baja: 'despido' }, 'payroll.finiquito.seniority_premium.not_calculated',
      'SIN CALCULAR: faltó el salario mínimo de la zona, del que cuelga el tope del art. 486. Se deben 180 ' +
        'días de prima de antigüedad y NO están en este total'],
    [{ motivo_baja: 'despido', salario_minimo_diario: '315.04' }, 'payroll.finiquito.seniority_premium.calculated',
      '180 días × 630.0800 (LFT art. 162 fr. I, base topada por el 486 con un mínimo de 315.04)'],
  ] as const)('%o', (over, key, spanish) => {
    const note = calcularFiniquito({ ...input, ...over } as EntradaFiniquito).prima_antiguedad_nota;
    expect(note.key).toBe(key);
    expect(t(note.key, note.params, 'es')).toBe(spanish);
    expect(t(note.key, note.params, 'en')).not.toBe(spanish);
  });
});
