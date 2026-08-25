import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * EL IVA DE UNA FACTURA A CRÉDITO NO ES ACREDITABLE TODAVÍA.
 *
 * Bajo PUE (pago en una sola exhibición) el IVA trasladado se acredita al
 * recibir la factura. Bajo PPD (parcialidades o diferido) NO: se acredita
 * cuando se paga, con el REP. La ruta viva de ingesta mandaba todo a la
 * 1130 «IVA Acreditable» sin mirar el método de pago, de modo que cada
 * factura a crédito adelantaba un acreditamiento que aún no existía.
 *
 * Estas pruebas fijan la diferencia: mismo CFDI, un solo atributo distinto,
 * dos cuentas distintas.
 */

const { consultaFalsa } = vi.hoisted(() => ({ consultaFalsa: vi.fn() }));

vi.mock('../../src/database/connection.js', () => ({
  query: (...a: unknown[]) => consultaFalsa(...a),
}));

import { planearAsiento, planContabilizable } from '../../src/services/xml-ingestion/cfdi-posting-plan.js';

const ENTIDAD = '11111111-1111-1111-1111-111111111111';
const RFC_RECEPTOR = 'XAXX010101000';

const XML_PUE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'),
  'utf-8'
);
const XML_PPD = XML_PUE.replace('MetodoPago="PUE"', 'MetodoPago="PPD"');

/** Rol → código, tal como los siembra account-roles-seed. */
const ROLES: Array<[string, string, string]> = [
  ['gasto', '6100', 'Gastos Generales'],
  ['cxp', '2110', 'Proveedores'],
  ['iva_acreditable', '1130', 'IVA Acreditable'],
  ['iva_pendiente_acreditar', '1135', 'IVA Pendiente de Acreditar'],
  ['iva_trasladado', '2120', 'IVA Trasladado'],
  ['iva_trasladado_no_cobrado', '2125', 'IVA Trasladado No Cobrado'],
  ['ingreso', '4100', 'Ingresos'],
  ['cxc', '1120', 'Clientes'],
];

/** id determinista por código, para poder afirmar sobre él. */
const idDe = (code: string): string => `cuenta-${code}`;

beforeEach(() => {
  consultaFalsa.mockReset();
  consultaFalsa.mockImplementation((sql: string, params: unknown[]) => {
    if (/FROM account_roles/.test(sql)) {
      return Promise.resolve({
        rows: ROLES.map(([role, code, name]) => ({ role, code, name })),
      });
    }
    if (/FROM accounts WHERE entity_id/.test(sql)) {
      const codigos = params[1] as string[];
      return Promise.resolve({ rows: codigos.map((code) => ({ id: idDe(code), code })) });
    }
    throw new Error(`Consulta no esperada: ${sql}`);
  });
});

const RENGLONES = [
  { line_number: 1, descripcion: 'Servicio de limpieza', importe: 1000, account_id: 'cuenta-gasto-limpieza' },
];

function lineaDe(plan: Awaited<ReturnType<typeof planearAsiento>>, cuenta: string) {
  return plan.lineas.find((l) => l.account_id === cuenta);
}

describe('el método de pago decide la cuenta del IVA', () => {
  it('PUE: el IVA se acredita al recibir la factura (1130)', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PUE,
      renglones: RENGLONES, referencia: 'BILL-2026-00001',
      vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });

    expect(plan.clasificacion.verdict).toBe('ready');
    expect(lineaDe(plan, idDe('1130'))?.debit_amount).toBe('160.0000');
    expect(lineaDe(plan, idDe('1135'))).toBeUndefined();
  });

  it('PPD: el IVA queda PENDIENTE de acreditar (1135), no acreditado', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PPD,
      renglones: RENGLONES, referencia: 'BILL-2026-00002',
      vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });

    expect(plan.clasificacion.verdict).toBe('ready');
    expect(lineaDe(plan, idDe('1135'))?.debit_amount).toBe('160.0000');
    // Este es el defecto que se corrige: antes esta línea existía.
    expect(lineaDe(plan, idDe('1130'))).toBeUndefined();
  });

  it('en ambos casos el asiento cuadra y toca la cuenta por pagar', async () => {
    for (const xml of [XML_PUE, XML_PPD]) {
      const plan = await planearAsiento({
        entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml,
        renglones: RENGLONES, referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
      });
      const cargos = plan.lineas.reduce((s, l) => s + Number(l.debit_amount ?? 0), 0);
      const abonos = plan.lineas.reduce((s, l) => s + Number(l.credit_amount ?? 0), 0);
      expect(cargos).toBeCloseTo(1160, 2);
      expect(abonos).toBeCloseTo(1160, 2);
      expect(lineaDe(plan, idDe('2110'))?.credit_amount).toBe('1160.0000');
      expect(planContabilizable(plan).ok).toBe(true);
    }
  });
});

describe('el desglose por renglón y el clasificador se reparten el trabajo', () => {
  it('el gasto se abre en las cuentas de los renglones, no en la genérica 6100', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PUE,
      renglones: RENGLONES, referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });
    expect(plan.desglose).toBe('abierta');
    expect(lineaDe(plan, 'cuenta-gasto-limpieza')?.debit_amount).toBe('1000.0000');
    expect(lineaDe(plan, idDe('6100'))).toBeUndefined();
  });

  it('si los renglones no suman lo que el CFDI dice, se usa la cuenta genérica y se avisa', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PUE,
      // 900 ≠ 1000: un desglose que descuadraría el asiento.
      renglones: [{ ...RENGLONES[0], importe: 900 }],
      referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });
    expect(plan.desglose).toBe('generica');
    expect(lineaDe(plan, idDe('6100'))?.debit_amount).toBe('1000.0000');
    expect(plan.avisos.join(' ')).toMatch(/no coincide/);
    // Lo que importa: el asiento sigue cuadrando.
    expect(planContabilizable(plan).ok).toBe(true);
  });

  it('un renglón sin cuenta tampoco produce un desglose incompleto', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PUE,
      renglones: [{ line_number: 1, descripcion: 'Servicio', importe: 1000 }],
      referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });
    expect(plan.desglose).toBe('generica');
    expect(plan.avisos.join(' ')).toMatch(/sin cuenta asignada/);
  });
});

describe('un plan incompleto no se contabiliza', () => {
  it('si a la entidad le falta la cuenta de un rol, se dice cuál y no se postea', async () => {
    consultaFalsa.mockImplementation((sql: string, params: unknown[]) => {
      if (/FROM account_roles/.test(sql)) {
        return Promise.resolve({
          rows: ROLES.filter(([r]) => r !== 'iva_pendiente_acreditar')
            .map(([role, code, name]) => ({ role, code, name })),
        });
      }
      if (/FROM accounts WHERE entity_id/.test(sql)) {
        const codigos = params[1] as string[];
        return Promise.resolve({ rows: codigos.map((code) => ({ id: idDe(code), code })) });
      }
      throw new Error(`Consulta no esperada: ${sql}`);
    });

    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PPD,
      renglones: RENGLONES, referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });

    const veredicto = planContabilizable(plan);
    expect(veredicto.ok).toBe(false);
    expect(veredicto.motivo).toMatch(/iva_pendiente_acreditar/);
  });

  it('un CFDI ajeno —ni emitido ni recibido por la entidad— no genera asiento', async () => {
    const plan = await planearAsiento({
      entityId: ENTIDAD, entityRfc: 'AAA010101AAA', xml: XML_PUE,
      renglones: RENGLONES, referencia: 'BILL', vendorExists: true, periodOpen: true, satStatus: 'vigente',
    });
    expect(plan.lineas).toEqual([]);
    expect(planContabilizable(plan).ok).toBe(false);
  });
});
