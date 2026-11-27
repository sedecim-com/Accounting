import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));
// MNE-001-616: the receivable an invoice was born with is read through
// report-service. The real helper runs (its SQL reaches the fake client),
// wrapped in a spy so a test can say which layer was asked, on which client.
vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/reporting/report-service.js')>();
  return { ...real, queryInvoiceEntryNetOnAccount: vi.fn(real.queryInvoiceEntryNetOnAccount) };
});

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
import { queryInvoiceEntryNetOnAccount } from '../../src/services/reporting/report-service.js';

const mockCreate = createJournalEntry as unknown as Mock;
const bornReader = queryInvoiceEntryNetOnAccount as unknown as Mock;

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
  opts: {
    publishedRate?: string | null;
    invoiceUpdateRows?: number;
    /** rowCount of the collection's guarded UPDATEs (customer_payments, payment_allocations). */
    paymentUpdateRows?: number;
    /** currency_code of the linked bank account (none by default). */
    bankCurrency?: string;
    /** The cxc debit the invoice was born with (none: the invoice entry is not found). */
    bornDebit?: string;
    /** MNE-001-597 · the payment's rows that have not stored their discount's VAT. */
    discounts?: Array<Record<string, string>>;
    /** MNE-001-597 · what the bill's entries parked in 1135, and what its live rows stored. */
    parked?: string;
    released?: string;
    /** MNE-001-862 · the firm's answer to fx_conversion_cent_difference (none: the catalogue default). */
    centPolicy?: string;
  } = {}
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
    if (sql.includes('FROM policy_decisions')) {
      return {
        rows: opts.centPolicy && p[1] === 'fx_conversion_cent_difference'
          ? [{ key: p[1], status: 'resolved', resolved_value: opts.centPolicy, question: '', resolution_notes: null, jurisdiction: null }]
          : [],
      };
    }
    if (sql.includes('FROM exchange_rates')) {
      const published = opts.publishedRate === undefined ? '17.5000000000' : opts.publishedRate;
      // Only the direct pair is published; the inverse lookup finds nothing.
      return { rows: published && sql.includes('rate::text AS rate') ? [{ rate: published }] : [] };
    }
    if (/^UPDATE (customer_payments|payment_allocations)/.test(sql.trim())) {
      return { rows: [], rowCount: opts.paymentUpdateRows ?? 1 };
    }
    if (sql.includes('AS taken')) return { rows: opts.discounts ?? [] };
    if (sql.includes('AS parked')) return { rows: [{ parked: opts.parked ?? '0' }] };
    if (sql.includes('AS released')) return { rows: [{ released: opts.released ?? '0' }] };
    if (sql.includes('AS born')) {
      return { rows: [{ born: opts.bornDebit ?? null }] };
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
      return { rows: [{ gl_account_id: 'acct:banco-gl', currency_code: opts.bankCurrency ?? null }] };
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
  bornReader.mockClear();
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

  it('MNE-001-597 · the discount\'s VAT leaves 1135 at the bill\'s rate, as a functional pair beside the FX discount line', async () => {
    // USD 100 + 16 at 20.0000 parked 320.0000; paid USD 110.20 + 5.80 of
    // discount at 19.50. The release took 15.20 × 20 = 304.0000, so 16.0000
    // is left, and the discount's USD 0.80 of VAT × 20 is exactly that.
    await postVendorPaymentEntry(
      fakeClient({
        parked: '320.0000', released: '304.0000',
        discounts: [{ id: 'app-1', bill_id: 'b1', bill_number: 'B-1', taken: '5.8000', tax_amount: '16.0000',
          total_amount: '116.0000', amount_due: '0.0000', exchange_rate: '20.0000000000' }],
      }),
      pago({ payment_amount: '110.2000' }),
      USER,
      contexto({
        tasaPago: '19.5000000000',
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '110.20', descuento: '5.80', tasaHistorica: '20.0000000000' },
        ],
      })
    );

    const discountLines = lines().filter((l) => l.account_id === 'acct:devolucion_compras');
    // The FX line keeps the gross discount at the bill's rate, 5.80 × 20.
    expect(discountLines[0]).toMatchObject({ credit_amount: '116.0000', foreign_credit: '5.8000', currency_code: 'USD' });
    // The pair takes its VAT off it, in pesos by declaration: 5200 nets 100.00.
    expect(discountLines[1]).toMatchObject({ debit_amount: '16.0000', credit_amount: null });
    expect(discountLines[1].currency_code).toBeUndefined();
    expect(de('acct:iva_pendiente_acreditar')).toMatchObject({ credit_amount: '16.0000', debit_amount: null });
    const stored = sqlLog.filter((q) => q.sql.includes('SET discount_iva_amount')).map((q) => q.params);
    expect(stored).toEqual([['16.0000', 'app-1']]);
    cuadre();
  });

  it('MNE-001-862 · the tranche that finishes a bill debits what the payable still holds, the cent on a line without origin', async () => {
    // USD 5.40 at 18.2345 was born at 98.47; the first half took 49.23, so
    // this one takes 49.24: 49.23 with its dollars and 0.01 in pesos only.
    await postVendorPaymentEntry(
      fakeClient(),
      pago({ payment_amount: '2.7000' }),
      USER,
      contexto({
        tasaPago: '18.2345000000',
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '2.70', descuento: '0', tasaHistorica: '18.2345000000', priorApplied: '2.70' },
        ],
      })
    );
    const payable = lines().filter((l) => l.account_id === 'acct:cxp');
    expect(payable.map((l) => [l.debit_amount, l.foreign_debit])).toEqual([['49.2300', '2.7000'], ['0.0100', undefined]]);
    expect(de('acct:utilidad_cambiaria')?.credit_amount).toBe('0.0100');
    cuadre();
  });

  it('MNE-001-862 · a tranche whose own product rounds up gives the cent back to the payable', async () => {
    // At 18.2345, 0.03 → 0.547035 → 0.55 and 0.06 → 1.09407 → 1.09: after a
    // first 0.03 the second one takes 0.54, so 0.01 is credited back, in pesos only.
    await postVendorPaymentEntry(
      fakeClient(),
      pago({ payment_amount: '0.0300' }),
      USER,
      contexto({
        tasaPago: '18.2345000000',
        aplicaciones: [
          { billId: 'b1', numero: 'B-1', aplicado: '0.03', descuento: '0', tasaHistorica: '18.2345000000', priorApplied: '0.03' },
        ],
      })
    );
    const payable = lines().filter((l) => l.account_id === 'acct:cxp');
    expect(payable.map((l) => [l.debit_amount, l.credit_amount, l.foreign_debit]))
      .toEqual([['0.5500', null, '0.0300'], [null, '0.0100', undefined]]);
    expect(de('acct:perdida_cambiaria')?.debit_amount).toBe('0.0100');
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

describe('postVendorPaymentEntry · the bank account currency (review of #500)', () => {
  it('refuses dollars paid out of a bank account kept in pesos', async () => {
    await expect(
      postVendorPaymentEntry(fakeClient({ bankCurrency: 'MXN' }), pago(), USER, contexto())
    ).rejects.toThrow(/USD but its bank account is kept in MXN/);
    expect(mockCreate).not.toHaveBeenCalled();
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

  // Rounding (review of #500): the invoice's receivable was born as the SUM
  // of its rounded lines, and every tranche used to be rounded on its own, so
  // a fully collected invoice could keep a ten-thousandth in cxc.
  const tranche = (over: Partial<ContextoCambiario['aplicaciones'][number]>): ContextoCambiario =>
    contexto({
      tasaPago: '18.0000000000',
      aplicaciones: [
        {
          billId: 'inv-1', numero: 'INV-1', aplicado: '1000.00', descuento: '0',
          tasaHistorica: '17.1235000000', priorApplied: '0', documentTotal: '1000.0000',
          ...over,
        },
      ],
    });
  const receivableNet = (): Decimal =>
    lines()
      .filter((l) => l.account_id === 'acct:cxc')
      .reduce((s, l) => s.plus(l.credit_amount ?? '0').minus(l.debit_amount ?? '0'), new Decimal(0));

  it('the tranche that collects an invoice in full credits exactly the receivable it was born with', async () => {
    // Three lines of 333.33/333.33/333.34 at 17.1235 are born as 17 123.5001,
    // while q4(1 000 × 17.1235) is 17 123.5000.
    await postCustomerPaymentEntry(fakeClient({ bornDebit: '17123.5001' }), pago(), USER, tranche({}));

    expect(receivableNet().toFixed(4)).toBe('17123.5001');
    // The truthful line keeps its origin; the remainder is functional only.
    const [truthful, remainder] = lines().filter((l) => l.account_id === 'acct:cxc');
    expect(truthful.credit_amount).toBe('17123.5000');
    expect(truthful.foreign_credit).toBe('1000.0000');
    expect(remainder.credit_amount).toBe('0.0001');
    expect(remainder.currency_code).toBeUndefined();
    // 18 000 − 17 123.5001: the ten-thousandth leaves the gain, not the receivable.
    expect(de('acct:utilidad_cambiaria')?.credit_amount).toBe('876.4999');
    cuadre();
  });

  it('when the receivable was born a ten-thousandth short, the last tranche debits the difference back', async () => {
    await postCustomerPaymentEntry(fakeClient({ bornDebit: '17123.4999' }), pago(), USER, tranche({}));

    expect(receivableNet().toFixed(4)).toBe('17123.4999');
    const remainder = lines().filter((l) => l.account_id === 'acct:cxc')[1];
    expect(remainder.debit_amount).toBe('0.0001');
    cuadre();
  });

  it('a partial tranche is credited telescopically, so the tranches add up to the whole', async () => {
    // At 18.2345, 0.03 converts to 0.547035 → 0.55 and 0.06 to 1.09407 →
    // 1.09: the second three cents take 0.54 off the receivable, not their
    // own rounded 0.55 (MNE-001-862: the conversion rounds to the cent).
    await postCustomerPaymentEntry(
      fakeClient(),
      pago({ payment_amount: '0.0300' }),
      USER,
      tranche({ aplicado: '0.03', priorApplied: '0.0300', tasaHistorica: '18.2345000000' })
    );
    expect(receivableNet().toFixed(4)).toBe('0.5400');
    cuadre();
  });

  it('a settling tranche whose invoice entry cannot be read falls back to the telescoped figure', async () => {
    await postCustomerPaymentEntry(fakeClient(), pago(), USER, tranche({}));
    expect(receivableNet().toFixed(4)).toBe('17123.5000');
    expect(lines().filter((l) => l.account_id === 'acct:cxc')).toHaveLength(1);
  });

  it('the closing tranche reads what the receivable was born with through report-service, on the same client (MNE-001-616)', async () => {
    // By hand: USD 1 000.00 born at 17.50 is 17 500.0000, a ten-thousandth over
    // (17 500.0001); 400.00 collected before at 17.50 took 7 000.0000. The last
    // 600.00 credits 17 500.0001 − 7 000.0000 = 10 500.0001: 10 500.0000 at the
    // rate plus 0.0001 of rounding. Cash at 18.00 is 10 800.0000, so the gain is
    // 10 800.0000 − 10 500.0001 = 299.9999.
    const client = fakeClient({ bornDebit: '17500.0001' });
    await postCustomerPaymentEntry(
      client,
      pago({ payment_amount: '600.0000' }),
      USER,
      tranche({ aplicado: '600.00', priorApplied: '400.0000', tasaHistorica: '17.5000000000' })
    );
    expect(bornReader.mock.calls).toEqual([[ENTITY, 'inv-1', 'acct:cxc', client]]);
    // Its SQL ran on the caller's transaction client, once.
    expect(sqlLog.filter((q) => q.sql.includes('AS born')).map((q) => q.params)).toEqual([['inv-1', ENTITY, 'acct:cxc']]);
    expect(receivableNet().toFixed(4)).toBe('10500.0001');
    const [truthful, remainder] = lines().filter((l) => l.account_id === 'acct:cxc');
    expect(truthful.credit_amount).toBe('10500.0000');
    expect(remainder.credit_amount).toBe('0.0001');
    expect(de('acct:utilidad_cambiaria')?.credit_amount).toBe('299.9999');
    cuadre();
  });

  it('a tranche that does not close the invoice never asks what it was born with', async () => {
    await postCustomerPaymentEntry(
      fakeClient({ bornDebit: '17500.0001' }),
      pago({ payment_amount: '400.0000' }),
      USER,
      tranche({ aplicado: '400.00', priorApplied: '0', tasaHistorica: '17.5000000000' })
    );
    expect(bornReader).not.toHaveBeenCalled();
    expect(receivableNet().toFixed(4)).toBe('7000.0000');
  });

  it('refuses dollars deposited into a bank account kept in pesos, naming both currencies', async () => {
    await expect(
      postCustomerPaymentEntry(fakeClient({ bankCurrency: 'MXN' }), pago(), USER, receipt('18.0000000000'))
    ).rejects.toThrow(/USD but its bank account is kept in MXN/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a USD bank account takes the dollars with their origin', async () => {
    await postCustomerPaymentEntry(fakeClient({ bankCurrency: 'USD' }), pago(), USER, receipt('18.0000000000'));
    expect(de('acct:banco-gl')?.foreign_debit).toBe('1000.0000');
  });

  it('a payment whose row is already linked to an entry fails loudly instead of linking a second one', async () => {
    await expect(
      postCustomerPaymentEntry(fakeClient({ paymentUpdateRows: 0 }), pago(), USER, receipt('18.0000000000'))
    ).rejects.toThrow(/already has an entry/);
  });

  it('refuses a foreign-currency receipt with cash left on account instead of posting an unbalanced entry', async () => {
    await expect(
      postCustomerPaymentEntry(fakeClient(), pago({ payment_amount: '1200.0000' }), USER, receipt('18.0000000000'))
    ).rejects.toThrow(/on the customer's account/);
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

  // MNE-001-862 · USD 46.66 + 20.00 at 17.1141, by hand: 798.543906 → 798.54
  // and 342.282 → 342.28 add up to 1 140.82; 66.66 × 17.1141 = 1 140.825906
  // → 1 140.83. The payable is the document, and the cent is its own line.
  const twoLines = (): BillLine[] => [
    lineaBill({ line_amount: '46.66', account_id: 'acct:big' }),
    lineaBill({ id: 'bl-2', line_number: 2, line_amount: '20.00', account_id: 'acct:small' }),
  ];
  const centBill = (): Bill =>
    billUsd({ subtotal: '66.66', tax_amount: '0', total_amount: '66.66', exchange_rate: '17.1141000000' });

  it('the payable is total × rate to the cent and keeps its origin; the cent is a loss line by default', async () => {
    await postBillEntry(fakeClient(), centBill(), twoLines(), USER);
    expect(de('acct:big')).toMatchObject({ debit_amount: '798.5400', foreign_debit: '46.66' });
    expect(de('acct:small')).toMatchObject({ debit_amount: '342.2800', foreign_debit: '20.00' });
    expect(de('acct:cxp')).toMatchObject({
      credit_amount: '1140.8300', currency_code: 'USD', foreign_credit: '66.66', exchange_rate: '17.1141000000',
    });
    const cent = de('acct:perdida_cambiaria');
    expect(cent).toMatchObject({ debit_amount: '0.0100', credit_amount: null });
    expect(cent?.currency_code).toBeUndefined();
    expect(lines()).toHaveLength(4);
    cuadre();
  });

  it('under largest_line the cent goes to the account of the largest line, as its own line without origin', async () => {
    await postBillEntry(fakeClient({ centPolicy: 'largest_line' }), centBill(), twoLines(), USER);
    const onBig = lines().filter((l) => l.account_id === 'acct:big');
    expect(onBig.map((l) => [l.debit_amount, l.foreign_debit])).toEqual([['798.5400', '46.66'], ['0.0100', undefined]]);
    expect(de('acct:perdida_cambiaria')).toBeUndefined();
    expect(de('acct:cxp')?.foreign_credit).toBe('66.66');
    cuadre();
  });

  it('a value of the key this reader does not know fails closed', async () => {
    await expect(postBillEntry(fakeClient({ centPolicy: 'somewhere' }), centBill(), twoLines(), USER))
      .rejects.toThrow(/fx_conversion_cent_difference.*somewhere/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('la tasa 1.0 exacta es el default de captura, no una tasa: el bill USD se acusa en vez de asentarse sin convertir', async () => {
    await expect(
      postBillEntry(fakeClient(), billUsd({ exchange_rate: '1.0000000000' }), [lineaBill()], USER)
    ).rejects.toThrow(/capture default|lose its origin/);
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
    ).rejects.toThrow(/There is no USD→MXN rate from the source 'dof' for 2026-08-15/);
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

  // MNE-001-862 · the issue's case, by hand at 17.1141: 33.33 → 570.412953 →
  // 570.41, 5.33 → 91.218153 → 91.22, and 38.66 → 661.631106 → 661.63. At
  // four decimals the sum (661.6312) missed the total (661.6311) and the
  // receivable was posted in pesos only.
  const centFx = (policy?: string): pg.PoolClient => fakeClient({ publishedRate: '17.1141000000', centPolicy: policy });
  const centPolicyReads = (): number =>
    sqlLog.filter((q) => q.sql.includes('FROM policy_decisions') && q.params[1] === 'fx_conversion_cent_difference').length;

  it('USD 33.33 + VAT 5.33 at 17.1141: the receivable is 661.63 with its dollars, and no key is read', async () => {
    await postInvoiceEntry(
      centFx(), usdInvoice({ subtotal: '33.33', tax_amount: '5.33', total_amount: '38.66' }), usdLines('33.33'), USER
    );
    expect(de('acct:ingreso')?.credit_amount).toBe('570.4100');
    expect(de('acct:iva_trasladado')?.credit_amount).toBe('91.2200');
    expect(de('acct:cxc')).toMatchObject({
      debit_amount: '661.6300', currency_code: 'USD', foreign_debit: '38.66', exchange_rate: '17.1141000000',
    });
    expect(lines()).toHaveLength(3);
    expect(centPolicyReads()).toBe(0);
    cuadre();
  });

  // USD 46.66 + 20.00, no tax: 798.54 + 342.28 = 1 140.82 against 1 140.83.
  const twoLines = (): InvoiceLine[] =>
    [
      { id: 'il-1', invoice_id: 'inv-1', line_number: 1, revenue_account_id: 'acct:big', description: 'A', line_amount: '46.66' },
      { id: 'il-2', invoice_id: 'inv-1', line_number: 2, revenue_account_id: 'acct:small', description: 'B', line_amount: '20.00' },
    ] as unknown as InvoiceLine[];
  const centInvoice = (over: Record<string, unknown> = {}): Invoice =>
    usdInvoice({ subtotal: '66.66', tax_amount: '0', total_amount: '66.66', ...over });

  it('the cent between the lines and the total is a gain line by default: no line and no tax changes', async () => {
    await postInvoiceEntry(centFx(), centInvoice(), twoLines(), USER);
    expect(de('acct:cxc')).toMatchObject({ debit_amount: '1140.8300', foreign_debit: '66.66' });
    expect(de('acct:big')).toMatchObject({ credit_amount: '798.5400', foreign_credit: '46.66' });
    expect(de('acct:small')).toMatchObject({ credit_amount: '342.2800', foreign_credit: '20.00' });
    const cent = de('acct:utilidad_cambiaria');
    expect(cent).toMatchObject({ debit_amount: null, credit_amount: '0.0100' });
    expect(cent?.currency_code).toBeUndefined();
    expect(centPolicyReads()).toBe(1);
    cuadre();
  });

  it('under largest_line the cent is credited to the account of the largest line', async () => {
    await postInvoiceEntry(centFx('largest_line'), centInvoice(), twoLines(), USER);
    const onBig = lines().filter((l) => l.account_id === 'acct:big');
    expect(onBig.map((l) => [l.credit_amount, l.foreign_credit])).toEqual([['798.5400', '46.66'], ['0.0100', undefined]]);
    expect(de('acct:utilidad_cambiaria')).toBeUndefined();
    cuadre();
  });

  it('a document that does not foot in its own currency gets no cent line: the engine refuses what does not balance', async () => {
    await postInvoiceEntry(centFx(), centInvoice({ total_amount: '70.00' }), twoLines(), USER);
    expect(lines()).toHaveLength(3);
    expect(centPolicyReads()).toBe(0);
    const net = lines().reduce((s, l) => s.plus(l.debit_amount ?? '0').minus(l.credit_amount ?? '0'), new Decimal(0));
    // 70.00 × 17.1141 = 1 197.987 → 1 197.99, against 1 140.82 of credits.
    expect(net.toFixed(2)).toBe('57.17');
  });

  it('refuses to link a second entry when the guarded update touches no row', async () => {
    await expect(
      postInvoiceEntry(fakeClient({ invoiceUpdateRows: 0 }), usdInvoice(), usdLines(), USER)
    ).rejects.toMatchObject({ messageKey: { key: 'error.INVOICE_ALREADY_POSTED' } });
  });

  it('an invoice in the functional currency posts exactly as before: no rate lookup, no FX columns', async () => {
    await postInvoiceEntry(fakeClient(), usdInvoice({ currency_code: 'MXN' }), usdLines(), USER);
    expect(de('acct:cxc')?.debit_amount).toBe('1160.00');
    expect(de('acct:cxc')?.currency_code).toBeUndefined();
    expect(sqlLog.some((q) => q.sql.includes('FROM exchange_rates'))).toBe(false);
  });
});

