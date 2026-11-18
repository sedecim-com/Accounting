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

// MNE-001-454: the revenue line of an issued sale opens by concept, so a
// person's coding of each line reaches the entry. Only with `revenueLines`.
describe('the revenue line of an issued sale opens by concept', () => {
  const ISSUER_RFC = 'SIN060101AB1';
  const SALE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'), 'utf-8');
  const CONCEPT = 'Consultoria en procesos administrativos agosto 2026';
  // Two concepts with their own discounts: 5,000.00 − 300.00 and 3,000.00 − 200.00.
  const SALE_TWO = SALE.replace('SubTotal="8000.00" Total="9280.00"', 'SubTotal="8000.00" Descuento="500.00" Total="8700.00"')
    .replace(/<cfdi:Concepto [^>]*\/>/, (c) =>
      c.replace('ValorUnitario="8000.00" Importe="8000.00"', 'ValorUnitario="5000.00" Importe="5000.00" Descuento="300.00"') +
      c.replace('ValorUnitario="8000.00" Importe="8000.00"', 'ValorUnitario="3000.00" Importe="3000.00" Descuento="200.00"'))
    .replace('TotalImpuestosTrasladados="1280.00"', 'TotalImpuestosTrasladados="1200.00"')
    .replace('Base="8000.00"', 'Base="7500.00"')
    .replace('Importe="1280.00"', 'Importe="1200.00"');
  const one = (extra: object = {}) => [{ line_number: 1, descripcion: CONCEPT, importe: 8000, ...extra }];
  const two = (secondDiscount: number) => [
    { line_number: 1, descripcion: 'First', importe: 5000, discount: 300, account_id: 'acct-4300' },
    { line_number: 2, descripcion: 'Second', importe: 3000, discount: secondDiscount, account_id: 'acct-4400' },
  ];
  const plan = (xml: string, renglones: Parameters<typeof planearAsiento>[0]['renglones'], revenueLines?: object) =>
    planearAsiento({
      entityId: ENTIDAD, entityRfc: ISSUER_RFC, xml, renglones, referencia: 'INV',
      periodOpen: true, satStatus: 'vigente', ...(revenueLines ? { revenueLines } : {}),
    });
  const credits = (p: Awaited<ReturnType<typeof planearAsiento>>) =>
    p.lineas.filter((l) => l.credit_amount !== null).map((l) => [l.account_id, l.credit_amount]);

  it('without the option: one credit of the whole revenue to the role account, as before', async () => {
    const p = await plan(SALE, one({ account_id: 'acct-4300' }));
    expect(credits(p)).toEqual([[idDe('4100'), '8000.0000'], [idDe('2125'), '1280.0000']]);
    expect(p.revenueLinesMismatch).toBeUndefined();
  });

  it('with the option and nothing coded: the credit goes to the role account with the concept description', async () => {
    const p = await plan(SALE, one(), {});
    expect(lineaDe(p, idDe('1120'))?.debit_amount).toBe('9280.0000');
    expect(credits(p)).toEqual([[idDe('4100'), '8000.0000'], [idDe('2125'), '1280.0000']]);
    expect(lineaDe(p, idDe('4100'))?.description).toBe(CONCEPT);
    expect(planContabilizable(p).ok).toBe(true);
  });

  it.each([
    ['a coded line wins over the account passed', { account_id: 'acct-4300' }, { callerAccountId: 'acct-4200' }, 'acct-4300'],
    ['the account passed wins over the stored one', {}, { callerAccountId: 'acct-4300', storedDefaultAccountId: 'acct-4200' }, 'acct-4300'],
    ['the stored account wins over the role', {}, { storedDefaultAccountId: 'acct-4200' }, 'acct-4200'],
    ['a suggestion is never read', { suggested_account_id: idDe('6100') }, {}, idDe('4100')],
  ])('precedence: %s', async (_name, line, option, expected) => {
    const p = await plan(SALE, one(line), option);
    expect(credits(p)[0]).toEqual([expected, '8000.0000']);
  });

  it('two concepts with discounts: one credit each, net of its own discount, to its own account', async () => {
    const p = await plan(SALE_TWO, two(200), {});
    expect(lineaDe(p, idDe('1120'))?.debit_amount).toBe('8700.0000');
    expect(credits(p)).toEqual([['acct-4300', '4700.0000'], ['acct-4400', '2800.0000'], [idDe('2125'), '1200.0000']]);
    expect(planContabilizable(p).ok).toBe(true);
  });

  it('nets that do not add up to the revenue of the CFDI: not opened, and the plan says so', async () => {
    const p = await plan(SALE_TWO, two(300), {});
    expect(credits(p)).toEqual([[idDe('4100'), '7500.0000'], [idDe('2125'), '1200.0000']]);
    expect(p.revenueLinesMismatch).toEqual({ linesTotal: '7400.00', revenueTotal: '7500.00' });
    expect(p.avisos.join(' ')).toMatch(/7400\.00.*7500\.00/);
  });

  it('nets one cent short: opened, and the last credit carries the cent', async () => {
    const p = await plan(SALE_TWO, two(200.01), {});
    expect(credits(p)).toEqual([['acct-4300', '4700.0000'], ['acct-4400', '2800.0000'], [idDe('2125'), '1200.0000']]);
    expect(p.revenueLinesMismatch).toBeUndefined();
    expect(planContabilizable(p).ok).toBe(true);
    expect(p.avisos.join(' ')).toMatch(/line 2.*0\.01/);
  });

  it('a received CFDI with the option present: the expense side is untouched', async () => {
    const base = {
      entityId: ENTIDAD, entityRfc: RFC_RECEPTOR, xml: XML_PUE, renglones: RENGLONES, referencia: 'BILL',
      vendorExists: true, periodOpen: true, satStatus: 'vigente' as const,
    };
    expect(await planearAsiento({ ...base, revenueLines: { callerAccountId: 'acct-4200' } })).toEqual(await planearAsiento(base));
  });
});
