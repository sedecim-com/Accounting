import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));

import Decimal from 'decimal.js';
import type pg from 'pg';
import { postBillEntry, postInvoiceEntry, postVendorPaymentEntry } from '../../src/services/accounting/ar-ap-posting.js';
import type { Bill, BillLine, Invoice, InvoiceLine } from '../../src/types/index.js';
import type { ContextoCambiario } from '../../src/services/accounting/moneda-origen.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';

const mockCreate = createJournalEntry as unknown as Mock;

const ENTITY = 'e0000000-0000-0000-0000-000000000001';
const USER = 'u0000000-0000-0000-0000-000000000001';

// ============================================================
// R4 · LA DIFERENCIA CAMBIARIA REALIZADA DEL PAGO
//
// `postVendorPaymentEntry` con contexto cambiario es el PRIMER consumidor
// de utilidad_cambiaria/perdida_cambiaria en la historia del sistema. La
// aritmética de B-15 que se afirma aquí: cada pasivo se extingue al tipo
// al que NACIÓ, el efectivo sale al tipo de HOY, y la brecha es resultado
// REALIZADO — que no lleva columnas FX porque su neto en la moneda del
// documento es cero.
//
// El cliente de pg es falso y responde por FORMA del SQL (el patrón de
// ar-ap-posting-f04-aplicacion.spec.ts); las cuentas de rol llegan como
// `acct:<rol>`, así que afirmar un account_id es afirmar EL ROL elegido.
// ============================================================

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];
    // La moneda funcional VA ANTES que la rama genérica de legal_entities:
    // las dos consultan la misma tabla y se distinguen por la columna.
    if (sql.includes('functional_currency')) {
      return { rows: [{ functional_currency: 'MXN' }] };
    }
    if (sql.includes('FROM legal_entities')) {
      return { rows: [{ incorporation_country: 'MX', accounting_standard: 'mx_nif' }] };
    }
    if (sql.includes('FROM account_roles')) {
      const roles = (p[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    if (sql.includes('FROM bank_accounts')) {
      return { rows: [{ gl_account_id: 'acct:banco-gl' }] };
    }
    // Sin filas de payment_applications no hay reclasificación de IVA: lo
    // que se prueba aquí es la aritmética cambiaria, no LIVA art. 5.
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

const pago = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  entity_id: ENTITY,
  payment_number: 'PMT-USD-1',
  payment_amount: '1000.0000',
  payment_date: new Date('2026-09-10'),
  bank_account_id: 'bank-1',
  journal_entry_id: null,
  ...over,
});

const contexto = (over: Partial<ContextoCambiario> = {}): ContextoCambiario => ({
  moneda: 'USD',
  monedaFuncional: 'MXN',
  tasaPago: '17.5000000000',
  fuenteTasa: 'dof',
  aplicaciones: [
    { billId: 'b1', numero: 'B-1', aplicado: '1000.00', descuento: '0', tasaHistorica: '17.0000000000' },
  ],
  ...over,
});

interface Linea {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  currency_code?: string | null;
  foreign_debit?: string | null;
  foreign_credit?: string | null;
  exchange_rate?: string | null;
}

function lines(): Linea[] {
  return mockCreate.mock.calls[0][4] as Linea[];
}
function de(cuenta: string): Linea | undefined {
  return lines().find((l) => l.account_id === cuenta);
}
function cuadre(): void {
  const dr = lines().reduce((s, l) => s.plus(l.debit_amount ?? '0'), new Decimal(0));
  const cr = lines().reduce((s, l) => s.plus(l.credit_amount ?? '0'), new Decimal(0));
  expect(dr.equals(cr), `descuadre: DR ${dr.toFixed(4)} vs CR ${cr.toFixed(4)}`).toBe(true);
}

beforeEach(() => {
  mockCreate.mockClear();
});

describe('postVendorPaymentEntry · la mitad realizada de NIF B-15', () => {
  it('pagar más caro de lo que nació el pasivo es PÉRDIDA: 1000 USD @17.00 pagados @17.50 → 6320 por 500', async () => {
    await postVendorPaymentEntry(fakeClient(), pago(), USER, contexto());

    // El pasivo se extingue a la tasa HISTÓRICA, con su origen a cuestas.
    const cxp = de('acct:cxp');
    expect(cxp?.debit_amount).toBe('17000.0000');
    expect(cxp?.currency_code).toBe('USD');
    expect(cxp?.foreign_debit).toBe('1000.0000');
    expect(cxp?.exchange_rate).toBe('17.0000000000');

    // El efectivo sale a la tasa de HOY.
    const banco = de('acct:banco-gl');
    expect(banco?.credit_amount).toBe('17500.0000');
    expect(banco?.foreign_credit).toBe('1000.0000');
    expect(banco?.exchange_rate).toBe('17.5000000000');

    // La brecha es pérdida realizada — y SIN columnas FX: su neto en la
    // moneda del documento es cero (se pagaron los mismos dólares debidos).
    const perdida = de('acct:perdida_cambiaria');
    expect(perdida?.debit_amount).toBe('500.0000');
    expect(perdida?.currency_code).toBeUndefined();
    expect(perdida?.foreign_debit).toBeUndefined();

    // Jamás la cuenta espejo, y el asiento cuadra en funcional.
    expect(de('acct:utilidad_cambiaria')).toBeUndefined();
    cuadre();
  });

  it('pagar más barato es UTILIDAD: 1000 USD @17.50 pagados @17.00 → 4320 por 500, como abono', async () => {
    await postVendorPaymentEntry(
      fakeClient(),
      pago(),
      USER,
      contexto({
        tasaPago: '17.0000000000',
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '1000.00', descuento: '0', tasaHistorica: '17.5000000000' },
        ],
      })
    );

    const utilidad = de('acct:utilidad_cambiaria');
    expect(utilidad?.credit_amount).toBe('500.0000');
    expect(utilidad?.debit_amount).toBeNull();
    expect(utilidad?.currency_code).toBeUndefined();
    expect(de('acct:perdida_cambiaria')).toBeUndefined();
    cuadre();
  });

  it('lo pagado de más es anticipo a la tasa del PAGO: es efectivo que salió hoy, no un pasivo viejo', async () => {
    await postVendorPaymentEntry(fakeClient(), pago({ payment_amount: '1200.0000' }), USER, contexto());

    const anticipo = de('acct:anticipo_proveedores');
    // 200 USD × 17.50 = 3500 — la tasa histórica del bill NO aplica aquí.
    expect(anticipo?.debit_amount).toBe('3500.0000');
    expect(anticipo?.foreign_debit).toBe('200.0000');
    expect(anticipo?.exchange_rate).toBe('17.5000000000');
    // El banco abona los 1200 completos al tipo de hoy.
    expect(de('acct:banco-gl')?.credit_amount).toBe('21000.0000');
    cuadre();
  });

  it('el descuento por pronto pago se abona a la tasa HISTÓRICA: es pasivo que se extingue, no efectivo', async () => {
    await postVendorPaymentEntry(
      fakeClient(),
      pago({ payment_amount: '980.0000' }),
      USER,
      contexto({
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '980.00', descuento: '20.00', tasaHistorica: '17.0000000000' },
        ],
      })
    );

    // El pasivo extinguido es aplicado + descuento, todo a la histórica.
    expect(de('acct:cxp')?.debit_amount).toBe('17000.0000');
    const desc = de('acct:devolucion_compras');
    expect(desc?.credit_amount).toBe('340.0000'); // 20 × 17.00
    expect(desc?.foreign_credit).toBe('20.0000');
    expect(desc?.exchange_rate).toBe('17.0000000000');
    // Banco: 980 × 17.50 = 17150.
    expect(de('acct:banco-gl')?.credit_amount).toBe('17150.0000');
    cuadre();
  });

  it('sin brecha de tasas no se pide NINGÚN rol cambiario: los roles se piden solo si la diferencia existe', async () => {
    await postVendorPaymentEntry(
      fakeClient(),
      pago(),
      USER,
      contexto({
        tasaPago: '17.0000000000',
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '1000.00', descuento: '0', tasaHistorica: '17.0000000000' },
        ],
      })
    );
    expect(de('acct:perdida_cambiaria')).toBeUndefined();
    expect(de('acct:utilidad_cambiaria')).toBeUndefined();
    cuadre();
  });
});

// ============================================================
// R4 · EL GASTO NACE CONVERTIDO — Y EL INGRESO SE PLANTA
// ============================================================

const billUsd = (over: Record<string, unknown> = {}): Bill =>
  ({
    id: 'bill-usd-1',
    entity_id: ENTITY,
    bill_number: 'BILL-USD-1',
    vendor_id: 'v1',
    subtotal: '1000.00',
    tax_amount: '160.00',
    total_amount: '1160.00',
    currency_code: 'USD',
    exchange_rate: '17.0000000000',
    bill_date: '2026-08-15',
    journal_entry_id: null,
    ...over,
  }) as unknown as Bill;

const lineaBill = (over: Record<string, unknown> = {}): BillLine =>
  ({
    id: 'bl-1', bill_id: 'bill-usd-1', line_number: 1, account_id: null,
    description: 'Servicio en USD', line_amount: '1000.00', ...over,
  }) as unknown as BillLine;

describe('postBillEntry · R4: el pasivo nace al tipo del documento', () => {
  it('cada cargo se convierte y lleva su origen; el abono es la SUMA de lo asentado y dice la verdad FX', async () => {
    await postBillEntry(fakeClient(), billUsd(), [lineaBill()], USER);

    const gasto = de('acct:gasto');
    expect(gasto?.debit_amount).toBe('17000.0000');
    expect(gasto?.foreign_debit).toBe('1000.00');
    expect(gasto?.exchange_rate).toBe('17.0000000000');
    // México es IVA en flujo y sin pre-registración el default conservador
    // es PPD: el impuesto se APARCA en 1135, no va directo a acreditable.
    const iva = lines().find((l) => l.account_id.startsWith('acct:iva'));
    expect(iva?.debit_amount).toBe('2720.0000');
    expect(iva?.foreign_debit).toBe('160.00');
    // 17000 + 2720 = 19720 = q4(1160 × 17): la suma coincide con la
    // multiplicación teórica y el abono lleva el origen completo.
    const cxp = de('acct:cxp');
    expect(cxp?.credit_amount).toBe('19720.0000');
    expect(cxp?.foreign_credit).toBe('1160.00');
    cuadre();
  });

  it('cuando el redondeo por línea difiere de total × tasa, el abono nace funcional: declarar un origen que no casa tumbaba el asiento entero', async () => {
    // subtotal 0.0270 + IVA 0.0270 @ 18.2345: cada producto redondea a
    // 0.4923 y la suma da 0.9846, pero q4(0.0540 × 18.2345) = 0.9847.
    // NINGÚN par (importe, tasa) honesto reproduce 0.9846 — el defecto
    // gravedad 1 que el adversarial cazó con el gasto imposteable.
    await postBillEntry(
      fakeClient(),
      billUsd({ subtotal: '0.0270', tax_amount: '0.0270', total_amount: '0.0540', exchange_rate: '18.2345000000' }),
      [lineaBill({ line_amount: '0.0270' })],
      USER
    );
    const cxp = de('acct:cxp');
    expect(cxp?.credit_amount).toBe('0.9846');
    expect(cxp?.foreign_credit).toBeUndefined();
    expect(cxp?.currency_code).toBeUndefined();
    cuadre();
  });

  it('la tasa 1.0 exacta es el default de captura, no una tasa: el bill USD se acusa en vez de asentarse sin convertir', async () => {
    await expect(
      postBillEntry(fakeClient(), billUsd({ exchange_rate: '1.0000000000' }), [lineaBill()], USER)
    ).rejects.toThrow(/default de captura|perdería su origen/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('postInvoiceEntry · R4: el lado AR no miente mientras no convierte', () => {
  it('la factura en moneda extranjera SE NIEGA a postearse nombrando lo que falta', async () => {
    const invoice = {
      id: 'inv-1', entity_id: ENTITY, invoice_number: 'INV-USD-1', customer_id: 'c1',
      subtotal: '1000.00', tax_amount: '160.00', total_amount: '1160.00',
      currency_code: 'USD', exchange_rate: '17.5000000000',
      invoice_date: '2026-08-15', journal_entry_id: null,
    } as unknown as Invoice;
    const lineas = [
      { id: 'il-1', invoice_id: 'inv-1', line_number: 1, revenue_account_id: null, description: 'Servicio exportado', line_amount: '1000.00' },
    ] as unknown as InvoiceLine[];
    await expect(postInvoiceEntry(fakeClient(), invoice, lineas, USER)).rejects.toThrow(
      /fase 2 de R4|sin rastro del importe/
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

