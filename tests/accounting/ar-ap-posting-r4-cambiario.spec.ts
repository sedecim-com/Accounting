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
  postBillEntry,
  postCustomerPaymentEntry,
  postInvoiceEntry,
  postVendorPaymentEntry,
} from '../../src/services/accounting/ar-ap-posting.js';
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

const sqlLog: { sql: string; params: unknown[] }[] = [];

function fakeClient(
  opts: { publishedRate?: string | null; invoiceUpdateRows?: number } = {}
): pg.PoolClient {
  const query = async (
    text: string,
    params?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];
    sqlLog.push({ sql, params: p });
    // La moneda funcional VA ANTES que la rama genérica de legal_entities:
    // las dos consultan la misma tabla y se distinguen por la columna.
    if (sql.includes('functional_currency')) {
      return { rows: [{ functional_currency: 'MXN' }] };
    }
    if (sql.includes('SELECT tenant_id FROM legal_entities')) {
      return { rows: [{ tenant_id: 't0000000-0000-0000-0000-000000000001' }] };
    }
    // No policy row: `fuente_tipo_cambio` answers with its catalog default (dof).
    if (sql.includes('FROM policy_decisions')) return { rows: [] };
    if (sql.includes('FROM exchange_rates')) {
      const published = opts.publishedRate === undefined ? '17.5000000000' : opts.publishedRate;
      // Only the direct pair is published; the inverse lookup finds nothing.
      return { rows: published && sql.includes('rate::text AS rate') ? [{ rate: published }] : [] };
    }
    if (sql.startsWith('UPDATE invoices')) {
      const n = opts.invoiceUpdateRows ?? 1;
      return { rows: [], rowCount: n };
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
  sqlLog.length = 0;
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

describe('postCustomerPaymentEntry · MNE-001-082: the realised difference of a collection', () => {
  // The receivable was born at 17.50 (the rate MNE-001-081 wrote back to the
  // invoice); the cash arrives at the rate of the collection day.
  const receipt = (rate: string): ContextoCambiario =>
    contexto({
      tasaPago: rate,
      aplicaciones: [
        { billId: 'inv-1', numero: 'INV-1', aplicado: '1000.00', descuento: '0', tasaHistorica: '17.5000000000' },
      ],
    });

  it('USD 1 000 born at 17.50 and collected at 18.00 credits 500 of realised gain to utilidad_cambiaria', async () => {
    await postCustomerPaymentEntry(fakeClient(), pago(), USER, receipt('18.0000000000'));

    const bank = de('acct:banco-gl');
    expect(bank?.debit_amount).toBe('18000.0000');
    expect(bank?.foreign_debit).toBe('1000.0000');
    expect(bank?.exchange_rate).toBe('18.0000000000');
    expect(bank?.currency_code).toBe('USD');

    const cxc = de('acct:cxc');
    expect(cxc?.credit_amount).toBe('17500.0000');
    expect(cxc?.foreign_credit).toBe('1000.0000');
    expect(cxc?.exchange_rate).toBe('17.5000000000');

    const gain = de('acct:utilidad_cambiaria');
    expect(gain?.credit_amount).toBe('500.0000');
    expect(gain?.debit_amount).toBeNull();
    // A realised result exists only in the functional currency.
    expect(gain?.currency_code).toBeUndefined();
    expect(de('acct:perdida_cambiaria')).toBeUndefined();
    cuadre();

    const opts = mockCreate.mock.calls[0][6] as { sourceType: string };
    expect(opts.sourceType).toBe('customer_payment');
    expect(mockCreate.mock.calls[0][3]).toMatch(/realized FX gain 500\.0000 MXN/);
  });

  it('collected at 17.20 the same receivable debits 300 of realised loss to perdida_cambiaria', async () => {
    await postCustomerPaymentEntry(fakeClient(), pago(), USER, receipt('17.2000000000'));

    const loss = de('acct:perdida_cambiaria');
    expect(loss?.debit_amount).toBe('300.0000');
    expect(loss?.credit_amount).toBeNull();
    expect(de('acct:utilidad_cambiaria')).toBeUndefined();
    expect(de('acct:banco-gl')?.debit_amount).toBe('17200.0000');
    cuadre();
  });

  it('collected at its own rate it realises nothing and asks for no FX role', async () => {
    await postCustomerPaymentEntry(fakeClient(), pago(), USER, receipt('17.5000000000'));

    expect(de('acct:banco-gl')?.debit_amount).toBe('17500.0000');
    expect(de('acct:banco-gl')?.foreign_debit).toBe('1000.0000');
    expect(de('acct:perdida_cambiaria')).toBeUndefined();
    expect(de('acct:utilidad_cambiaria')).toBeUndefined();
    const asked = sqlLog.filter((q) => q.sql.includes('FROM account_roles')).flatMap((q) => q.params[1] as string[]);
    expect(asked).not.toContain('utilidad_cambiaria');
    expect(asked).not.toContain('perdida_cambiaria');
    expect(mockCreate.mock.calls[0][3]).toBe('Customer payment PMT-USD-1');
    cuadre();
  });

  it('refuses a foreign-currency receipt with cash left on account instead of posting an unbalanced entry', async () => {
    await expect(
      postCustomerPaymentEntry(fakeClient(), pago({ payment_amount: '1200.0000' }), USER, receipt('18.0000000000'))
    ).rejects.toThrow(/a cuenta del cliente/);
    expect(mockCreate).not.toHaveBeenCalled();
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

describe('postInvoiceEntry · MNE-001-081: a foreign-currency invoice converts at the policy rate', () => {
  const usdInvoice = (over: Record<string, unknown> = {}): Invoice =>
    ({
      id: 'inv-1', entity_id: ENTITY, invoice_number: 'INV-USD-1', customer_id: 'c1',
      subtotal: '1000.00', tax_amount: '160.00', total_amount: '1160.00',
      currency_code: 'USD', exchange_rate: '1.0000000000',
      invoice_date: '2026-08-15', journal_entry_id: null,
      ...over,
    }) as unknown as Invoice;
  const usdLines = (amount = '1000.00'): InvoiceLine[] =>
    [
      { id: 'il-1', invoice_id: 'inv-1', line_number: 1, revenue_account_id: null, description: 'Exported service', line_amount: amount },
    ] as unknown as InvoiceLine[];

  it('USD 1 000 + IVA at 17.50 posts 17 500 of revenue and 20 300 of cxc, each line keeping its dollars', async () => {
    await postInvoiceEntry(fakeClient(), usdInvoice(), usdLines(), USER);

    const revenue = de('acct:ingreso');
    expect(revenue?.credit_amount).toBe('17500.0000');
    expect(revenue?.currency_code).toBe('USD');
    expect(revenue?.foreign_credit).toBe('1000.00');
    expect(revenue?.exchange_rate).toBe('17.5000000000');

    const vat = de('acct:iva_trasladado');
    expect(vat?.credit_amount).toBe('2800.0000');
    expect(vat?.foreign_credit).toBe('160.00');

    const receivable = de('acct:cxc');
    expect(receivable?.debit_amount).toBe('20300.0000');
    expect(receivable?.foreign_debit).toBe('1160.00');
    expect(receivable?.exchange_rate).toBe('17.5000000000');
    cuadre();

    // The rate is the one the policy's source published for the invoice
    // date, and it is written back to the invoice for its collection.
    const rateLookup = sqlLog.find((q) => q.sql.includes('FROM exchange_rates'));
    expect(rateLookup?.params).toEqual(['USD', 'MXN', '2026-08-15', 'dof']);
    const link = sqlLog.find((q) => q.sql.startsWith('UPDATE invoices'));
    expect(link?.sql).toContain('exchange_rate = $2');
    expect(link?.sql).toContain('journal_entry_id IS NULL');
    expect(link?.params).toEqual(['je-1', '17.5000000000', 'inv-1', ENTITY]);
  });

  it('with no rate published for the invoice date it fails closed instead of posting dollars as pesos', async () => {
    await expect(
      postInvoiceEntry(fakeClient({ publishedRate: null }), usdInvoice(), usdLines(), USER)
    ).rejects.toThrow(/No hay tipo de cambio USD→MXN de la fuente 'dof' para 2026-08-15/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a captured rate that disagrees with the policy source is refused, not silently overwritten', async () => {
    await expect(
      postInvoiceEntry(fakeClient(), usdInvoice({ exchange_rate: '17.2000000000' }), usdLines(), USER)
    ).rejects.toThrow(/17\.2000000000.*17\.5000000000/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a captured rate equal to the published one posts normally', async () => {
    await postInvoiceEntry(fakeClient(), usdInvoice({ exchange_rate: '17.5000000000' }), usdLines(), USER);
    expect(de('acct:ingreso')?.credit_amount).toBe('17500.0000');
  });

  it('when per-line rounding differs from total × rate, the receivable debit is the sum of the credits and carries no FX columns', async () => {
    // 0.0270 + 0.0270 @ 18.2345: each product rounds to 0.4923 (sum 0.9846)
    // but q4(0.0540 × 18.2345) = 0.9847 — no honest (amount, rate) pair
    // reproduces the posted sum, the same case postBillEntry pins.
    await postInvoiceEntry(
      fakeClient({ publishedRate: '18.2345000000' }),
      usdInvoice({ subtotal: '0.0270', tax_amount: '0.0270', total_amount: '0.0540' }),
      usdLines('0.0270'),
      USER
    );
    const receivable = de('acct:cxc');
    expect(receivable?.debit_amount).toBe('0.9846');
    expect(receivable?.foreign_debit).toBeUndefined();
    expect(receivable?.currency_code).toBeUndefined();
    cuadre();
  });

  it('refuses to link a second entry when the guarded update touches no row', async () => {
    await expect(
      postInvoiceEntry(fakeClient({ invoiceUpdateRows: 0 }), usdInvoice(), usdLines(), USER)
    ).rejects.toThrow(/ya tiene póliza/);
  });

  it('an invoice in the functional currency posts exactly as before: no rate lookup, no FX columns', async () => {
    await postInvoiceEntry(fakeClient(), usdInvoice({ currency_code: 'MXN' }), usdLines(), USER);
    expect(de('acct:cxc')?.debit_amount).toBe('1160.00');
    expect(de('acct:cxc')?.currency_code).toBeUndefined();
    expect(sqlLog.some((q) => q.sql.includes('FROM exchange_rates'))).toBe(false);
  });
});

