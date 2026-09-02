import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));

import Decimal from 'decimal.js';
import type pg from 'pg';
import {
  postVendorApplicationEntry,
  postCustomerPaymentEntry,
  postVendorPaymentEntry,
  type AplicacionPosterior,
} from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';

const mockCreate = createJournalEntry as unknown as Mock;

const ENTITY = 'e0000000-0000-0000-0000-000000000001';
const USER = 'u0000000-0000-0000-0000-000000000001';

// ============================================================
// F04 · APLICAR EL ANTICIPO A PROVEEDOR
//
// `postVendorApplicationEntry` es el espejo de la aplicación del lado
// cliente con dos diferencias que sólo se ven ejecutándola: aquí el
// descuento por pronto pago SÍ puede aparecer, y aquí hay CONDONACIÓN
// (pago corto) cuya cuenta destino llega como parámetro porque la dicta
// la política `pago_corto_residual`, no esta capa.
//
// El cliente de pg es falso y responde por FORMA del SQL; devuelve las
// cuentas de rol como `acct:<rol>`, de modo que afirmar sobre un
// account_id es afirmar sobre EL ROL que el motor eligió. Es el patrón
// de `ar-ap-posting-f03.spec.ts`, con tres respuestas más que esta
// función necesita: el total ya aplicado de un pago (`AS aplicado`), el
// metodo_pago que la pre-registración declara, y el conteo de roles que
// `ivaStillParked` consulta cuando el tope da cero.
// ============================================================

interface EstadoFalso {
  country: string;
  standard: string;
  /** metodo_pago que la pre-registración del gasto declara, por bill_id. */
  metodoPorGasto: Record<string, string | null>;
  /** IVA que cada gasto tiene TODAVÍA aparcado en 1135, por id. */
  parked: Record<string, string>;
  /** Roles que la entidad NO tiene sembrados: el motor debe plantarse. */
  rolesFaltantes: string[];
  /** Lo ya aplicado y descontado que la consulta de totales del pago ve. */
  totales: { aplicado: string; descuento: string };
  /** gl_account_id de la cuenta bancaria ligada, si la hay. */
  bankGl: string | null;
}

let state: EstadoFalso;

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];

    if (sql.includes('FROM legal_entities')) {
      return { rows: [{ incorporation_country: state.country, accounting_standard: state.standard }] };
    }
    // El metodo_pago del gasto llega por la pre-registración que lo creó:
    // un gasto no tiene columna cfdi_uuid. Así se declara un PUE sin
    // ensuciar `terms` con un token que el parser tendría que adivinar.
    if (sql.includes('FROM pre_registrations')) {
      const metodo = state.metodoPorGasto[String(p[0])];
      return { rows: metodo === undefined ? [] : [{ metodo_pago: metodo }] };
    }
    // El tope de liberación. Va ANTES de account_roles porque la consulta
    // hace JOIN con esa tabla.
    if (sql.includes('AS parked')) {
      return { rows: [{ parked: state.parked[String(p[2])] ?? '0' }] };
    }
    // Con tope cero, `ivaStillParked` pregunta si la entidad tiene sembrada
    // la capa semántica y se planta si no: aquí sí la tiene. Va ANTES de la
    // rama genérica de account_roles, que consulta la misma tabla.
    if (sql.includes('AS n FROM account_roles')) {
      return { rows: [{ n: '3' }] };
    }
    if (sql.includes('FROM account_roles')) {
      const roles = (p[1] ?? []) as string[];
      return {
        rows: roles
          .filter((role) => !state.rolesFaltantes.includes(role))
          .map((role) => ({ role, account_id: `acct:${role}` })),
      };
    }
    // Los totales del pago (lo aplicado y el descuento acumulados). Va ANTES
    // de las ramas con alias `pa`, que son las de `ivaReclassificationsFor`.
    if (sql.includes('AS aplicado')) {
      return { rows: [{ aplicado: state.totales.aplicado, descuento: state.totales.descuento }] };
    }
    if (sql.includes('FROM payment_allocations pa') || sql.includes('FROM payment_applications pa')) {
      return { rows: [] };
    }
    if (sql.includes('FROM bank_accounts')) {
      return { rows: state.bankGl === null ? [] : [{ gl_account_id: state.bankGl }] };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

beforeEach(() => {
  mockCreate.mockClear();
  state = {
    country: 'MX',
    standard: 'mx_nif',
    metodoPorGasto: {},
    parked: {},
    rolesFaltantes: [],
    totales: { aplicado: '0', descuento: '0' },
    bankGl: null,
  };
});

interface Linea {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
}

/** Las líneas que el motor entregó a createJournalEntry. */
function lines(): Linea[] {
  return mockCreate.mock.calls[0][4] as Linea[];
}
function entryDescription(): string {
  return mockCreate.mock.calls[0][3] as string;
}
/**
 * TODAS las líneas de una cuenta, no la primera: con condonación, 1135
 * recibe DOS abonos —el condonado y el liberado— y quedarse con el primero
 * escondería justamente lo que hay que afirmar.
 */
function lineasDe(accountId: string): Linea[] {
  return lines().filter((l) => l.account_id === accountId);
}
/** La única línea de una cuenta. Se planta si hay más de una. */
function lineaDe(accountId: string): Linea {
  const encontradas = lineasDe(accountId);
  expect(encontradas).toHaveLength(1);
  return encontradas[0];
}
/** Suma, en Decimal, de un lado del asiento para una cuenta. */
function sumaDe(accountId: string, lado: 'debit_amount' | 'credit_amount'): string {
  return lineasDe(accountId)
    .reduce((s, l) => s.plus(l[lado] ?? '0'), new Decimal(0))
    .toFixed(4);
}
/**
 * La partida doble cuadra. Con Decimal y comparando cadenas de cuatro
 * decimales: en float, 137.9310 + 22.0690 no siempre son 160.
 */
function cuadra(): void {
  const cargos = lines().reduce((s, l) => s.plus(l.debit_amount ?? '0'), new Decimal(0));
  const abonos = lines().reduce((s, l) => s.plus(l.credit_amount ?? '0'), new Decimal(0));
  expect(cargos.toFixed(4)).toBe(abonos.toFixed(4));
}

const pago = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  entity_id: ENTITY,
  payment_number: 'PMT-001',
  payment_amount: '1160.0000',
  payment_date: new Date('2026-09-10'),
  bank_account_id: null,
  journal_entry_id: null,
  ...over,
});

const aplicacion = (over: Partial<AplicacionPosterior> = {}): AplicacionPosterior => ({
  invoiceId: 'bill-1',
  invoiceNumber: 'BILL-001',
  amount: '1160.0000',
  priorApplied: '0',
  taxAmount: '160.0000',
  totalAmount: '1160.0000',
  cfdiUuid: null,
  terms: null,
  memo: null,
  ...over,
});

// ============================================================
// EL CASO DE SIEMPRE: EL DERECHO SE TRASPASA Y EL IVA SE ACREDITA
// ============================================================

describe('aplicar el anticipo a proveedor mueve el derecho, no el efectivo', () => {
  it('aplica el anticipo a un gasto PPD completo: el pasivo baja y el IVA se vuelve acreditable', async () => {
    state.parked = { 'bill-1': '160.0000' };

    const { entry, ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion()],
      USER
    );

    expect(entry.id).toBe('je-1');
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1160.0000');
    expect(lineaDe('acct:iva_acreditable').debit_amount).toBe('160.0000');
    expect(lineaDe('acct:iva_pendiente_acreditar').credit_amount).toBe('160.0000');
    expect(ivaPorGasto.get('bill-1')).toBe('160.0000');
    expect(ivaNoAcreditablePorGasto.size).toBe(0);
    // El efectivo ya salió con el pago: este evento no vuelve a tocarlo.
    expect(lineasDe('acct:banco')).toHaveLength(0);
    expect(entryDescription()).toMatch(/IVA creditable on payment: BILL-001/);
    expect(lines()).toHaveLength(4);
    cuadra();
  });

  it('fuera de la base de flujo el evento es sólo el traspaso del derecho', async () => {
    state.country = 'US';
    state.standard = 'us_gaap';
    state.parked = { 'bill-1': '160.0000' };

    const { ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion()],
      USER
    );

    expect(lines()).toHaveLength(2);
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1160.0000');
    expect(ivaPorGasto.size).toBe(0);
    expect(ivaNoAcreditablePorGasto.size).toBe(0);
    expect(lineasDe('acct:iva_acreditable')).toHaveLength(0);
    expect(lineasDe('acct:iva_pendiente_acreditar')).toHaveLength(0);
    expect(entryDescription()).toBe('Application of PMT-001');
    cuadra();
  });

  it('un gasto PUE no acredita nada aquí: su IVA se acreditó al recibirlo', async () => {
    state.metodoPorGasto = { 'bill-1': 'PUE' };
    state.parked = { 'bill-1': '160.0000' };

    const { ivaPorGasto } = await postVendorApplicationEntry(fakeClient(), pago(), [aplicacion()], USER);

    expect(lines()).toHaveLength(2);
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1160.0000');
    expect(ivaPorGasto.size).toBe(0);
    expect(entryDescription()).toBe('Application of PMT-001');
    cuadra();
  });

  it('varias aplicaciones en un solo evento producen un asiento, no dos', async () => {
    state.parked = { 'bill-1': '160.0000', 'bill-2': '80.0000' };

    const { ivaPorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [
        aplicacion(),
        aplicacion({
          invoiceId: 'bill-2',
          invoiceNumber: 'BILL-002',
          amount: '580.0000',
          taxAmount: '80.0000',
          totalAmount: '580.0000',
        }),
      ],
      USER
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(lineaDe('acct:cxp').debit_amount).toBe('1740.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1740.0000');
    expect(lineasDe('acct:iva_acreditable').map((l) => l.debit_amount)).toEqual(['160.0000', '80.0000']);
    expect(sumaDe('acct:iva_acreditable', 'debit_amount')).toBe('240.0000');
    expect(sumaDe('acct:iva_pendiente_acreditar', 'credit_amount')).toBe('240.0000');
    expect(ivaPorGasto.get('bill-1')).toBe('160.0000');
    expect(ivaPorGasto.get('bill-2')).toBe('80.0000');
    expect(entryDescription()).toMatch(/IVA creditable on payment: BILL-001, BILL-002/);
    cuadra();
  });
});

// ============================================================
// EL DESCUENTO POR PRONTO PAGO
// ============================================================

describe('el descuento por pronto pago extingue pasivo sin efectivo detrás', () => {
  it('con descuento por pronto pago el pasivo se extingue por más de lo aplicado', async () => {
    state.parked = { 'bill-1': '160.0000' };

    const { ivaPorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '980.0000', discount: '20.0000' })],
      USER
    );

    expect(lineaDe('acct:cxp').debit_amount).toBe('1000.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('980.0000');
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('20.0000');
    // 160 × 980 / 1160: sólo se acredita el IVA de lo que este evento paga.
    expect(lineaDe('acct:iva_acreditable').debit_amount).toBe('135.1724');
    expect(lineaDe('acct:iva_pendiente_acreditar').credit_amount).toBe('135.1724');
    expect(ivaPorGasto.get('bill-1')).toBe('135.1724');
    cuadra();
  });
});

// ============================================================
// EL PAGO CORTO: LA CONDONACIÓN Y SU IVA
// ============================================================

describe('el pago corto cierra el gasto y no deja residuo en 1135', () => {
  it('condonar saldo sin cuenta destino se planta en vez de descuadrar', async () => {
    state.parked = { 'bill-1': '160.0000' };

    await expect(
      postVendorApplicationEntry(
        fakeClient(),
        pago(),
        [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
        USER
      )
    ).rejects.toMatchObject({ code: 'WRITE_OFF_ACCOUNT_UNRESOLVED' });
    await expect(
      postVendorApplicationEntry(
        fakeClient(),
        pago(),
        [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
        USER
      )
    ).rejects.toThrow(/pago_corto_residual/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('el pago corto contra devolucion_compras: el IVA condonado sale de 1135 sin acreditarse', async () => {
    state.parked = { 'bill-1': '160.0000' };

    const { ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
      USER,
      'devolucion_compras'
    );

    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1000.0000');
    // Sólo la parte de COSTO: 160 condonados menos los 22.0690 de IVA que ya
    // salieron por su cuenta. Abonarlos aquí también los contaría dos veces.
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('137.9310');
    expect(lineaDe('acct:iva_acreditable').debit_amount).toBe('137.9310');
    // 1135 queda en cero para este gasto: ni un peso varado.
    expect(lineasDe('acct:iva_pendiente_acreditar').map((l) => l.credit_amount)).toEqual([
      '22.0690',
      '137.9310',
    ]);
    expect(sumaDe('acct:iva_pendiente_acreditar', 'credit_amount')).toBe('160.0000');
    expect(ivaNoAcreditablePorGasto.get('bill-1')).toBe('22.0690');
    expect(ivaPorGasto.get('bill-1')).toBe('137.9310');
    cuadra();
  });

  it('el mismo pago corto contra otros_ingresos cuando la política así lo dicta', async () => {
    state.parked = { 'bill-1': '160.0000' };

    await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
      USER,
      'otros_ingresos'
    );

    expect(lineaDe('acct:otros_ingresos').credit_amount).toBe('137.9310');
    // No hubo descuento: la cuenta de devoluciones no aparece por ningún lado.
    expect(lineasDe('acct:devolucion_compras')).toHaveLength(0);
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1000.0000');
    cuadra();
  });

  it('descuento y condonación en el mismo evento salen de 2110 por caminos distintos', async () => {
    state.parked = { 'bill-1': '160.0000' };

    const { ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '900.0000', discount: '20.0000', writeOff: '240.0000' })],
      USER,
      'otros_ingresos'
    );

    // 900 aplicados + 20 de descuento + 240 condonados: el gasto queda saldado.
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('900.0000');
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('20.0000');
    expect(lineaDe('acct:otros_ingresos').credit_amount).toBe('206.8966');
    expect(lineaDe('acct:iva_acreditable').debit_amount).toBe('124.1379');
    expect(sumaDe('acct:iva_pendiente_acreditar', 'credit_amount')).toBe('157.2413');
    expect(ivaNoAcreditablePorGasto.get('bill-1')).toBe('33.1034');
    cuadra();
  });

  it('de 1135 no puede salir más de lo que hay: el IVA condonado se topa con lo aparcado', async () => {
    // El gasto aparcó 150, no 160: la liberación se lleva 137.9310 y sólo
    // quedan 12.0690 para el condonado, menos que su parte proporcional.
    state.parked = { 'bill-1': '150.0000' };

    const { ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
      USER,
      'devolucion_compras'
    );

    expect(lineaDe('acct:iva_acreditable').debit_amount).toBe('137.9310');
    expect(ivaNoAcreditablePorGasto.get('bill-1')).toBe('12.0690');
    expect(sumaDe('acct:iva_pendiente_acreditar', 'credit_amount')).toBe('150.0000');
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('147.9310');
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1000.0000');
    cuadra();
  });

  it('un gasto que nunca aparcó IVA no libera nada, y entonces todo lo condonado es costo', async () => {
    state.parked = { 'bill-1': '0' };

    const { ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [aplicacion({ amount: '1000.0000', writeOff: '160.0000' })],
      USER,
      'devolucion_compras'
    );

    expect(lineasDe('acct:iva_acreditable')).toHaveLength(0);
    expect(lineasDe('acct:iva_pendiente_acreditar')).toHaveLength(0);
    expect(ivaPorGasto.size).toBe(0);
    expect(ivaNoAcreditablePorGasto.size).toBe(0);
    expect(lineaDe('acct:cxp').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('1000.0000');
    // El saldo condonado ÍNTEGRO: no salió IVA que restarle.
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('160.0000');
    expect(entryDescription()).toBe('Application of PMT-001');
    cuadra();
  });

  it('un saldo condonado que era todo IVA no abona nada a la cuenta de condonación', async () => {
    state.parked = { 'bill-1': '160.0000' };

    const { ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [
        aplicacion({
          amount: '0.0000',
          writeOff: '160.0000',
          taxAmount: '160.0000',
          totalAmount: '160.0000',
        }),
      ],
      USER,
      'devolucion_compras'
    );

    // Abonar la cuenta de condonación contaría el impuesto dos veces.
    expect(lineasDe('acct:devolucion_compras')).toHaveLength(0);
    expect(lineaDe('acct:iva_pendiente_acreditar').credit_amount).toBe('160.0000');
    expect(ivaNoAcreditablePorGasto.get('bill-1')).toBe('160.0000');
    expect(ivaPorGasto.size).toBe(0);
    expect(lineaDe('acct:cxp').debit_amount).toBe('160.0000');
    // Y NO hay línea de anticipo: no se aplicó nada. Emitir un abono de
    // 0.0000 contra 1150 tumbaría el asiento entero en el INSERT, porque
    // `journal_entry_lines` lleva `CHECK (credit_amount IS NULL OR
    // credit_amount > 0)`. Aquí `createJournalEntry` está mockeado, así que
    // esta aserción es lo único que separa «el motor no la emite» de «el
    // motor la emite y la base la rechaza en producción».
    expect(lineasDe('acct:anticipo_proveedores')).toHaveLength(0);
    cuadra();
  });

  it('sin total no hay prorrateo: la condonación de un gasto de total cero es toda costo', async () => {
    state.parked = { 'bill-1': '0' };

    const { ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      fakeClient(),
      pago(),
      [
        aplicacion({
          amount: '100.0000',
          writeOff: '50.0000',
          taxAmount: '0.0000',
          totalAmount: '0.0000',
        }),
      ],
      USER,
      'devolucion_compras'
    );

    expect(lineaDe('acct:cxp').debit_amount).toBe('150.0000');
    expect(lineaDe('acct:anticipo_proveedores').credit_amount).toBe('100.0000');
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('50.0000');
    expect(ivaNoAcreditablePorGasto.size).toBe(0);
    expect(lineasDe('acct:iva_acreditable')).toHaveLength(0);
    expect(lineasDe('acct:iva_pendiente_acreditar')).toHaveLength(0);
    cuadra();
  });

  it('sin el rol anticipo_proveedores sembrado se planta en vez de asentar contra nada', async () => {
    state.parked = { 'bill-1': '160.0000' };
    state.rolesFaltantes = ['anticipo_proveedores'];

    await expect(
      postVendorApplicationEntry(fakeClient(), pago(), [aplicacion()], USER)
    ).rejects.toMatchObject({ code: 'MISSING_ROLE_ACCOUNT' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ============================================================
// EL DESGLOSE DEL PAGO: APLICADO, DESCUENTO Y REMANENTE
//
// Los dos posteos de pago reparten el importe entre el auxiliar y la
// cuenta a cuenta leyendo los totales YA aplicados. Con aplicación
// parcial el control no puede bajar por el total: ése era exactamente el
// agujero que la validación de suma exacta tapaba.
// ============================================================

describe('el cobro y el pago reparten su importe entre el auxiliar y lo que queda a cuenta', () => {
  it('un cobro parcialmente aplicado abona cxc por lo aplicado y anticipos por el resto', async () => {
    state.totales = { aplicado: '800.0000', descuento: '0' };

    await postCustomerPaymentEntry(fakeClient(), pago(), USER);

    expect(lineaDe('acct:banco').debit_amount).toBe('1160.0000');
    // Lo APLICADO, no el total del cobro.
    expect(lineaDe('acct:cxc').credit_amount).toBe('800.0000');
    expect(lineaDe('acct:anticipo_clientes').credit_amount).toBe('360.0000');
    expect(lines()).toHaveLength(3);
    cuadra();
  });

  it('con aplicación exacta el remanente es cero y el asiento es el de siempre', async () => {
    state.totales = { aplicado: '1160.0000', descuento: '0' };

    await postCustomerPaymentEntry(fakeClient(), pago(), USER);

    expect(lineaDe('acct:banco').debit_amount).toBe('1160.0000');
    expect(lineaDe('acct:cxc').credit_amount).toBe('1160.0000');
    // Nada queda a cuenta: la cuenta de anticipos ni siquiera se pide.
    expect(lineasDe('acct:anticipo_clientes')).toHaveLength(0);
    expect(lines()).toHaveLength(2);
    cuadra();
  });

  it('un pago a proveedor con aplicaciones y descuento extingue 2110 por más de lo que sale del banco', async () => {
    state.totales = { aplicado: '980.0000', descuento: '20.0000' };

    await postVendorPaymentEntry(fakeClient(), pago({ payment_amount: '980.0000' }), USER);

    // Lo aplicado MÁS el descuento: el proveedor deja de tener derecho a ambos.
    expect(lineaDe('acct:cxp').debit_amount).toBe('1000.0000');
    expect(lineaDe('acct:banco').credit_amount).toBe('980.0000');
    expect(lineaDe('acct:devolucion_compras').credit_amount).toBe('20.0000');
    // No se pagó de más: no hay anticipo que registrar.
    expect(lineasDe('acct:anticipo_proveedores')).toHaveLength(0);
    expect(entryDescription()).toBe('Vendor payment PMT-001 · early-payment discount 20.00');
    cuadra();
  });
});
