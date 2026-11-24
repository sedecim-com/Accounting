import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  createInvoice,
  issueInvoice,
  updateDraftInvoice,
  deleteDraftInvoice,
  checkInvoiceSeries,
} from '../../src/services/ar/invoice-service.js';
import type { Invoice } from '../../src/types/index.js';
import {
  createCreditNote,
  issueCreditNote,
  applyCreditNote,
} from '../../src/services/ar/credit-note-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
  getCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { arReconcile, runArChecks } from '../../src/services/ar/ar-controls.js';
import {
  setCustomerTaxProfile,
  getCustomerTaxProfile,
  listCustomerTaxProfiles,
} from '../../src/services/ar/customer-service.js';
import { entityScope } from '../../src/database/scope.js';
import { AccountingError, ValidationError } from '../../src/utils/errors.js';
import { t } from '../../src/i18n/index.js';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';

/**
 * F03 · COBRAR, contra la base real.
 *
 * El ciclo completo: facturar → nota de crédito (emitir postea, aplicar
 * reparte) → cobro con remanente a cuenta → aplicación posterior →
 * desaplicación como evento → reversa NSF por espejos — y al final el
 * auxiliar CUADRA contra la cuenta de control, que es la única prueba que
 * un auditor acepta de que los eventos intermedios no mintieron.
 */

let f: Fixture;
let clienteId: string;

async function cuentaPorCodigo(code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [f.entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

const fecha = () => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Factura emitida (posteada, status 'sent'): la materia prima de todo lo demás. */
async function facturaEmitida(subtotal: string, tax: string, customerId = clienteId): Promise<Invoice> {
  const draft = await createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: fecha(),
    due_date: fecha(),
    currency_code: 'MXN',
    lines: [
      {
        revenue_account_id: await cuentaPorCodigo('4100'),
        description: 'Servicio',
        quantity: '1',
        unit_price: subtotal,
        tax_rate: new Decimal(tax).dividedBy(subtotal).times(100).toFixed(4),
      },
    ],
    created_by: f.userId,
  });
  const r = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  return r.invoice;
}


beforeAll(async () => {
  f = await crearInquilino('F03 Cobrar');
  clienteId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-F03-001', 'Cliente Cobrar SA', 'MXN', $3)`,
    [clienteId, f.entityId, f.userId]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('nota de crédito: emitir postea, aplicar reparte', () => {
  it('la nota ligada postea DR devoluciones + DR IVA / CR CxC y su aplicación salda la factura', async () => {
    const factura = await facturaEmitida('1000.00', '160.00');

    const nota = await createCreditNote(
      {
        entity_id: f.entityId,
        invoice_id: factura.id,
        type: 'devolucion',
        subtotal: '500.00',
        tax_amount: '80.00',
        reason: 'devolución parcial',
      },
      f.userId
    );
    expect(nota.credit_note_number).toMatch(/^CN-\d{4}-\d{5}$/);
    expect(nota.status).toBe('draft');
    expect(nota.customer_id).toBe(clienteId); // derivado de la factura

    const emision = await issueCreditNote(f.entityId, nota.id, f.userId);
    expect(emision.journalEntry).not.toBeNull();

    // El asiento: DR 4400 (500) + DR 2120 (80) / CR 1120 (580).
    const lineas = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 ORDER BY a.code`,
      [emision.journalEntry!.id]
    );
    const porCuenta = Object.fromEntries(lineas.rows.map((l) => [l.code, l]));
    expect(Number(porCuenta['4400'].debit)).toBeCloseTo(500);
    expect(Number(porCuenta['2120'].debit)).toBeCloseTo(80);
    expect(Number(porCuenta['1120'].credit)).toBeCloseTo(580);

    // La emisión NO tocó la factura: el crédito aún es saldo a favor.
    const antes = await query<{ amount_due: string }>(
      `SELECT amount_due FROM invoices WHERE id = $1`, [factura.id]
    );
    expect(Number(antes.rows[0].amount_due)).toBeCloseTo(1160);

    // Aplicar reparte en el auxiliar, sin asiento nuevo.
    const aplicacion = await applyCreditNote(
      f.entityId, nota.id, [{ invoiceId: factura.id, amount: '580.00' }], f.userId
    );
    expect(aplicacion.notaStatus).toBe('applied');
    const despues = await query<{ amount_due: string; amount_paid: string; status: string }>(
      `SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1`, [factura.id]
    );
    expect(Number(despues.rows[0].amount_due)).toBeCloseTo(580);
    // amount_paid intacto: una nota no es efectivo.
    expect(Number(despues.rows[0].amount_paid)).toBeCloseTo(0);
  });

  it('una nota ligada NO se aplica a otra factura: cruzarlas descuadraría el IVA', async () => {
    const original = await facturaEmitida('200.00', '32.00');
    const ajena = await facturaEmitida('300.00', '48.00');
    const nota = await createCreditNote(
      { entity_id: f.entityId, invoice_id: original.id, type: 'descuento', subtotal: '100.00', tax_amount: '16.00' },
      f.userId
    );
    await issueCreditNote(f.entityId, nota.id, f.userId);
    await expect(
      applyCreditNote(f.entityId, nota.id, [{ invoiceId: ajena.id, amount: '50.00' }], f.userId)
    ).rejects.toThrow(/ligada a otra factura/);
  });

  it('no se acredita más de lo facturado', async () => {
    const chica = await facturaEmitida('100.00', '16.00');
    await expect(
      createCreditNote(
        { entity_id: f.entityId, invoice_id: chica.id, type: 'devolucion', subtotal: '200.00', tax_amount: '32.00' },
        f.userId
      )
    ).rejects.toThrow(/no se acredita más de lo facturado/);
  });
});

describe('el cobro como historia: a cuenta, aplicar, desaplicar, reversar', () => {
  let facturaA: Invoice;
  let facturaB: Invoice;
  let paymentId: string;

  it('un cobro con remanente a cuenta acredita cxc por lo aplicado y anticipos por el resto', async () => {
    facturaA = await facturaEmitida('1000.00', '160.00');
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId,
        counterpartyId: clienteId,
        paymentAmount: '1500.00',
        paymentDate: fecha(),
        paymentMethod: 'spei',
        applications: [{ documentId: facturaA.id, amountApplied: '1160.00' }],
        onAccount: true,
      },
      f.userId
    );
    paymentId = r.paymentId;

    const lineas = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 ORDER BY a.code`,
      [r.journalEntry!.id]
    );
    const porCuenta = Object.fromEntries(lineas.rows.map((l) => [l.code, l]));
    // BAN-1 (#324): the bank role posts to the leaf 1111, never to 1110,
    // which is the parent of the bank accounts.
    expect(Number(porCuenta['1111'].debit)).toBeCloseTo(1500); // banco
    expect(porCuenta['1110']).toBeUndefined();
    expect(Number(porCuenta['1120'].credit)).toBeCloseTo(1160); // cxc: lo aplicado
    expect(Number(porCuenta['2150'].credit)).toBeCloseTo(340); // anticipo: el resto

    const detalle = await getCustomerPayment(f.entityId, r.paymentNumber);
    expect(detalle.unapplied_amount).toBe('340.00');
  });

  it('sin --on-account, el remanente accidental se rechaza en voz alta', async () => {
    const otra = await facturaEmitida('100.00', '16.00');
    await expect(
      recordCustomerPayment(
        {
          entityId: f.entityId,
          paymentAmount: '200.00',
          paymentDate: fecha(),
          paymentMethod: 'spei',
          applications: [{ documentId: otra.id, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/onAccount/);
  });

  it('la aplicación posterior mueve el crédito de anticipos al auxiliar', async () => {
    facturaB = await facturaEmitida('340.00', '0.00');
    const r = await applyCustomerPayment(
      f.entityId, paymentId, [{ documentId: facturaB.id, amountApplied: '340.00' }], f.userId
    );
    expect(r.remanenteAnterior).toBe('340.00');
    expect(r.remanenteNuevo).toBe('0.00');

    const lineas = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1 ORDER BY a.code`,
      [r.journalEntry!.id]
    );
    const porCuenta = Object.fromEntries(lineas.rows.map((l) => [l.code, l]));
    expect(Number(porCuenta['2150'].debit)).toBeCloseTo(340);
    expect(Number(porCuenta['1120'].credit)).toBeCloseTo(340);

    const factura = await query<{ status: string; amount_due: string }>(
      `SELECT status, amount_due FROM invoices WHERE id = $1`, [facturaB.id]
    );
    expect(factura.rows[0].status).toBe('paid');
  });

  it('desaplicar reabre la factura como evento nuevo y el crédito vuelve a anticipos', async () => {
    const r = await unapplyCustomerPayment(
      f.entityId, paymentId,
      { invoiceId: facturaB.id, reason: 'aplicado a la factura equivocada' },
      f.userId
    );
    expect(r.desaplicado).toBe('340.00');

    const factura = await query<{ status: string; amount_due: string; amount_paid: string }>(
      `SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1`, [facturaB.id]
    );
    expect(factura.rows[0].status).toBe('sent');
    expect(Number(factura.rows[0].amount_due)).toBeCloseTo(340);
    expect(Number(factura.rows[0].amount_paid)).toBeCloseTo(0);

    // La aplicación no se borró: se clausuró con su motivo.
    const historia = await query<{ unapply_reason: string }>(
      `SELECT unapply_reason FROM payment_allocations
        WHERE payment_id = $1 AND invoice_id = $2 AND unapplied_at IS NOT NULL`,
      [paymentId, facturaB.id]
    );
    expect(historia.rows[0].unapply_reason).toMatch(/equivocada/);

    const detalle = await getCustomerPayment(f.entityId, paymentId);
    expect(detalle.unapplied_amount).toBe('340.00');
  });

  it('la reversa NSF refleja cada asiento, reabre facturas y el cobro queda «reversed», no «void»', async () => {
    const r = await reverseCustomerPayment(
      f.entityId, paymentId, { reason: 'cheque devuelto' }, f.userId
    );
    // Original + aplicación + desaplicación: tres asientos, tres espejos.
    expect(r.reversals.length).toBe(3);
    expect(r.documentosReabiertos.map((d) => d.numero)).toContain(facturaA.invoice_number);

    const pago = await query<{ status: string; reversed_at: Date | null }>(
      `SELECT status, reversed_at FROM customer_payments WHERE id = $1`, [paymentId]
    );
    expect(pago.rows[0].status).toBe('reversed');
    expect(pago.rows[0].reversed_at).not.toBeNull();

    const factura = await query<{ status: string; amount_due: string }>(
      `SELECT status, amount_due FROM invoices WHERE id = $1`, [facturaA.id]
    );
    expect(Number(factura.rows[0].amount_due)).toBeCloseTo(1160);
    expect(factura.rows[0].status).toBe('sent');

    // Un cobro reversado no admite más eventos.
    await expect(
      reverseCustomerPayment(f.entityId, paymentId, { reason: 'otra vez' }, f.userId)
    ).rejects.toThrow(/'reversed'/);
  });

  it('la comisión NSF se rechaza en voz alta: no hay rol de comisiones todavía', async () => {
    await expect(
      reverseCustomerPayment(
        f.entityId, paymentId, { reason: 'x', feeAmount: '250.00' }, f.userId
      )
    ).rejects.toThrow(/comisiones bancarias/);
  });
});

describe('los controles de la cartera', () => {
  it('después de todo lo anterior, el auxiliar CUADRA contra la cuenta de control', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.balanced, `delta ${r.delta}: control ${r.control_balance} vs auxiliar ${r.subledger_net}`).toBe(true);
    expect(r.control_account?.code).toBe('1120');
  });

  it('la batería corre sin bloqueantes; missing-uuid avisa porque nada se timbra', async () => {
    const { results, blocking } = await runArChecks(f.entityId);
    expect(blocking).toBe(0);
    const uuid = results.find((r) => r.name === 'missing-uuid');
    expect(uuid?.level).toBe('warning');
    expect(uuid?.count).toBeGreaterThan(0);
  });

  it('una aplicación huérfana (defecto inyectado) se detecta como bloqueante', async () => {
    // El defecto que el motor no produciría: un cobro muerto por SQL directo
    // con su aplicación viva. Exactamente lo que la sonda existe para cazar.
    const factura = await facturaEmitida('50.00', '8.00');
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId,
        paymentAmount: '58.00',
        paymentDate: fecha(),
        paymentMethod: 'spei',
        applications: [{ documentId: factura.id, amountApplied: '58.00' }],
      },
      f.userId
    );
    await query(`UPDATE customer_payments SET status = 'void' WHERE id = $1`, [r.paymentId]);

    const { results } = await runArChecks(f.entityId, { checks: ['orphan-application'] });
    expect(results[0].level).toBe('blocking');
    expect(results[0].count).toBeGreaterThan(0);

    // Se repara para no contaminar las demás pruebas.
    await query(`UPDATE customer_payments SET status = 'completed' WHERE id = $1`, [r.paymentId]);
  });
});

describe('el borrador se edita y se elimina; el folio queda documentado', () => {
  it('editar recalcula totales; eliminar deja el hueco explicado en la serie', async () => {
    const draft = await createInvoice({
      entity_id: f.entityId,
      customer_id: clienteId,
      invoice_date: fecha(),
      due_date: fecha(),
      currency_code: 'MXN',
      lines: [
        { revenue_account_id: await cuentaPorCodigo('4100'), unit_price: '100.00', quantity: '1' },
      ],
      created_by: f.userId,
    });

    const editada = await updateDraftInvoice(
      draft.id,
      {
        entityId: f.entityId,
        lines: [
          { revenue_account_id: await cuentaPorCodigo('4100'), unit_price: '250.00', quantity: '2', tax_rate: '16' },
        ],
      },
      f.userId
    );
    expect(Number(editada.subtotal)).toBeCloseTo(500);
    expect(Number(editada.tax_amount)).toBeCloseTo(80);
    expect(Number(editada.amount_due)).toBeCloseTo(580);

    const borrada = await deleteDraftInvoice(
      draft.id, { entityId: f.entityId, reason: 'borrador de prueba' }, f.userId
    );
    expect(borrada.invoiceNumber).toBe(draft.invoice_number);

    const serie = await checkInvoiceSeries(f.entityId);
    const conHueco = serie.find((s) => s.missing.includes(draft.invoice_number));
    expect(conHueco, 'el folio eliminado debe aparecer como hueco').toBeDefined();
    const explicado = conHueco!.explained.find((e) => e.folio === draft.invoice_number);
    expect(explicado?.reason).toBe('borrador de prueba');
  });

  it('una factura emitida no se elimina: se anula, con rastro', async () => {
    const emitida = await facturaEmitida('10.00', '1.60');
    await expect(
      deleteDraftInvoice(emitida.id, { entityId: f.entityId, reason: 'x' }, f.userId)
    ).rejects.toThrow(/Only a draft/);
  });
});

describe('el perfil fiscal del cliente', () => {
  it('fija RFC/régimen/CP/UsoCFDI validando contra los catálogos, y el control previo lo ve', async () => {
    const scope = entityScope(f.tenantId, f.entityId);

    await expect(
      setCustomerTaxProfile(clienteId, scope, { taxId: 'NO-ES-RFC' },
        { userId: f.userId, tenantId: f.tenantId })
    ).rejects.toThrow(/forma de RFC/);
    await expect(
      setCustomerTaxProfile(clienteId, scope, { taxRegime: '999' },
        { userId: f.userId, tenantId: f.tenantId })
    ).rejects.toThrow(/c_RegimenFiscal/);

    const antes = await listCustomerTaxProfiles(scope, { missing: true });
    expect(antes.rows.map((r) => r.id)).toContain(clienteId);

    const perfil = await setCustomerTaxProfile(
      clienteId, scope,
      { taxId: 'CCO120301AB1', taxRegime: '601', postalCode: '06600', usoCfdi: 'G03' },
      { userId: f.userId, tenantId: f.tenantId, reason: 'alta fiscal' }
    );
    expect(perfil.complete).toBe(true);
    expect(perfil.tax_regime_name).toMatch(/General de Ley/);

    const leido = await getCustomerTaxProfile(clienteId, scope);
    expect(leido.uso_cfdi).toBe('G03');
    expect(leido.missing).toEqual([]);

    const despues = await listCustomerTaxProfiles(scope, { missing: true });
    expect(despues.rows.map((r) => r.id)).not.toContain(clienteId);
  });

  // #102 (MNE-001-033): current SAT codes the whitelist used to refuse.
  it.each([
    [{ usoCfdi: 'D10' }, 'uso_cfdi_name', 'Pagos por servicios educativos (colegiaturas)'],
    [{ usoCfdi: 'CN01' }, 'uso_cfdi_name', 'Nómina'],
    [{ taxRegime: '611' }, 'tax_regime_name', 'Ingresos por Dividendos (socios y accionistas)'],
  ] as const)('accepts the current SAT code %o and names it', async (patch, field, name) => {
    const scope = entityScope(f.tenantId, f.entityId);
    const profile = await setCustomerTaxProfile(clienteId, scope, patch,
      { userId: f.userId, tenantId: f.tenantId, reason: 'MNE-001-033' });
    expect(profile[field]).toBe(name);
  });
});

// MNE-001-516 (#664): cash on account settles only invoices of its own customer.
describe('receipt apply stays within the receipt\'s own customer', () => {
  const LABEL_A = 'C-F03-001 Cliente Cobrar SA';
  const LABEL_B = 'C-F03-002 Otro Cliente SA';
  let customerB: string;
  let receiptId: string;
  let receiptNumber: string;
  let invoiceB: Invoice;

  const invoiceRow = async (id: string) =>
    (await query<{ amount_due: string; amount_paid: string; status: string }>(
      `SELECT amount_due::text, amount_paid::text, status FROM invoices WHERE id = $1`, [id]
    )).rows[0];
  const liveAllocations = async () =>
    (await query(
      `SELECT 1 FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`, [receiptId]
    )).rows.length;
  const entriesOfReceipt = async () =>
    (await query(
      `SELECT 1 FROM journal_entries WHERE entity_id = $1 AND source_id = $2`, [f.entityId, receiptId]
    )).rows.length;
  const refusal = async (
    apps: Parameters<typeof applyCustomerPayment>[2],
    opts: Parameters<typeof applyCustomerPayment>[4] = {}
  ): Promise<ValidationError> => {
    const e = await applyCustomerPayment(f.entityId, receiptId, apps, f.userId, opts).then(
      () => null, (err: unknown) => err
    );
    expect(e, 'the application must be refused').toBeInstanceOf(ValidationError);
    return e as ValidationError;
  };

  beforeAll(async () => {
    customerB = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1, $2, 'C-F03-002', 'Otro Cliente SA', 'MXN', $3)`,
      [customerB, f.entityId, f.userId]
    );
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: clienteId, paymentAmount: '1160.00',
        paymentDate: fecha(), paymentMethod: 'spei', applications: [], onAccount: true,
      },
      f.userId
    );
    receiptId = r.paymentId;
    receiptNumber = r.paymentNumber;
    invoiceB = await facturaEmitida('1000.00', '160.00', customerB);
  });

  it('T1 · refuses an invoice of another customer, naming the invoice and both customers', async () => {
    const e = await refusal([{ documentId: invoiceB.id, amountApplied: '1160.00' }]);
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
    for (const text of [e.message, e.localized('es')]) {
      for (const part of [invoiceB.invoice_number, receiptNumber, LABEL_A, LABEL_B]) {
        expect(text).toContain(part);
      }
    }
    expect(e.localized('es')).not.toBe(e.message);
  });

  it('T2 · a dry run is refused the same way', async () => {
    const e = await refusal([{ documentId: invoiceB.id, amountApplied: '1160.00' }], { dryRun: true });
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
  });

  it('T3 · neither refusal wrote anything', async () => {
    expect(await liveAllocations()).toBe(0);
    expect(await invoiceRow(invoiceB.id)).toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'sent' });
    expect(await entriesOfReceipt(), 'only the entry of the receipt itself').toBe(1);
    expect((await getCustomerPayment(f.entityId, receiptId)).unapplied_amount).toBe('1160.00');
  });

  it('T5 · one call naming an invoice of each customer is refused whole', async () => {
    const invoiceA = await facturaEmitida('500.00', '80.00');
    const e = await refusal([
      { documentId: invoiceA.id, amountApplied: '580.00' },
      { documentId: invoiceB.id, amountApplied: '580.00' },
    ]);
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
    expect(await liveAllocations(), 'the allocation of the own invoice is rolled back too').toBe(0);
    expect(await invoiceRow(invoiceA.id)).toEqual({ amount_due: '580.0000', amount_paid: '0.0000', status: 'sent' });
    expect(await invoiceRow(invoiceB.id)).toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'sent' });
    expect(await entriesOfReceipt()).toBe(1);
  });

  it('T6 · the party refusal speaks before the currency one', async () => {
    // The row is set to USD by hand: issuing a USD invoice needs a published
    // rate in `exchange_rates`, a global table other suites read. The locked
    // read sees the same row either way.
    const usd = await facturaEmitida('100.00', '16.00', customerB);
    await query(`UPDATE invoices SET currency_code = 'USD' WHERE id = $1 AND entity_id = $2`, [usd.id, f.entityId]);
    const e = await refusal([{ documentId: usd.id, amountApplied: '116.00' }]);
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
  });

  it('T7 · an application with withholdings is refused the same way', async () => {
    const e = await refusal([
      { documentId: invoiceB.id, amountApplied: '953.33', withholdingIsr: '100.00', withholdingIva: '106.67' },
    ]);
    expect(e.messageKey?.key).toBe('receipt.apply.other_customer');
    expect(await liveAllocations()).toBe(0);
  });

  it('T4 · the same receipt applied to an invoice of its own customer posts DR 2150 / CR 1120', async () => {
    const invoiceA = await facturaEmitida('1000.00', '160.00');
    const r = await applyCustomerPayment(
      f.entityId, receiptId, [{ documentId: invoiceA.id, amountApplied: '1160.00' }], f.userId
    );
    expect(r.remanenteNuevo).toBe('0.00');
    const lines = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1`,
      [r.journalEntry!.id]
    );
    const byCode = Object.fromEntries(lines.rows.map((l) => [l.code, l]));
    expect(Number(byCode['2150'].debit)).toBeCloseTo(1160);
    expect(Number(byCode['1120'].credit)).toBeCloseTo(1160);
    expect((await invoiceRow(invoiceA.id)).status).toBe('paid');
    expect(await invoiceRow(invoiceB.id)).toEqual({ amount_due: '1160.0000', amount_paid: '0.0000', status: 'sent' });
  });
});

describe('ar check names the live allocations that cross customers (cross-party-application, MNE-001-530)', () => {
  const probe = async (entityId: string) =>
    (await runArChecks(entityId, { checks: ['cross-party-application'] })).results[0];

  it('T3-T5 · warns on a receipt of one customer applied to an invoice of another, in its own entity only', async () => {
    const customerC = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1, $2, 'C-F03-003', 'Cliente Cruce SA', 'MXN', $3)`,
      [customerC, f.entityId, f.userId]
    );
    const invoice = await facturaEmitida('100.00', '16.00'); // 116.00, of customer A (C-F03-001)
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: clienteId, paymentAmount: '116.00', paymentDate: fecha(),
        paymentMethod: 'spei', applications: [{ documentId: invoice.id, amountApplied: '116.00' }],
      },
      f.userId
    );
    // Since MNE-001-516 the engine refuses to write it, so the row written
    // before it is injected, as the orphan test does: the receipt becomes C's.
    await query(`UPDATE customer_payments SET customer_id = $1 WHERE id = $2 AND entity_id = $3`,
      [customerC, r.paymentId, f.entityId]);
    const other = await crearInquilino('F03 Cobrar · otra entidad');
    try {
      const found = await probe(f.entityId);
      expect(found).toMatchObject({ level: 'warning', count: 1, detailKey: 'ar.check.cross_party_application.found' });
      expect(found.detail, 'the English source is the catalog\'s').toBe(t('ar.check.cross_party_application.found', {}, 'en'));
      expect(found.sample).toEqual([`${r.paymentNumber} (C-F03-003) → ${invoice.invoice_number} (C-F03-001)`]);
      // T4 · another entity does not see it.
      expect(await probe(other.entityId)).toMatchObject({ level: 'clean', count: 0, sample: [] });
    } finally {
      await query(`UPDATE customer_payments SET customer_id = $1 WHERE id = $2 AND entity_id = $3`,
        [clienteId, r.paymentId, f.entityId]);
    }
    // T5 · restored, the battery is clean again.
    const clean = await probe(f.entityId);
    expect(clean).toMatchObject({
      level: 'clean', count: 0, sample: [], detailKey: 'ar.check.cross_party_application.none',
    });
  });
});

describe('the invoice UPDATEs of a collection are guarded (invariant 3, MNE-001-580)', () => {
  const invoiceRow = async (id: string) =>
    (await query<{ amount_due: string; amount_paid: string; status: string; last: string | null }>(
      `SELECT amount_due::text, amount_paid::text, status, to_char(last_payment_date, 'YYYY-MM-DD') AS last
         FROM invoices WHERE id = $1`, [id]
    )).rows[0];
  const entriesOfEntity = async () =>
    (await query(`SELECT 1 FROM journal_entries WHERE entity_id = $1`, [f.entityId])).rows.length;
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /**
   * Under the row lock nothing else can move the invoice, so the UPDATE is made
   * to match no row as in f04-pagar (#808): a trigger on this invoice alone that
   * skips it. Returns its undo.
   */
  const sabotage = async (invoiceId: string): Promise<() => Promise<void>> => {
    const tag = invoiceId.replace(/-/g, '').slice(0, 12);
    await query(
      `CREATE OR REPLACE FUNCTION f03_skip_${tag}() RETURNS TRIGGER AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`
    );
    await query(
      `CREATE TRIGGER trg_f03_skip_${tag} BEFORE UPDATE ON invoices
       FOR EACH ROW WHEN (OLD.id = '${invoiceId}') EXECUTE FUNCTION f03_skip_${tag}()`
    );
    return async () => {
      await query(`DROP TRIGGER IF EXISTS trg_f03_skip_${tag} ON invoices`);
      await query(`DROP FUNCTION IF EXISTS f03_skip_${tag}()`);
    };
  };
  const changed = async (call: () => Promise<unknown>): Promise<AccountingError> => {
    const e = await call().then(() => null, (err: unknown) => err);
    expect(e, 'the call must be refused').toBeInstanceOf(AccountingError);
    expect((e as AccountingError).code).toBe('INVOICE_CHANGED');
    return e as AccountingError;
  };
  const record = (invoiceId: string, amount: string, date: string) =>
    recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: clienteId, paymentAmount: amount, paymentDate: date,
        paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: amount }],
      },
      f.userId
    );

  it('R1 · receipt record: an invoice UPDATE that touches no row writes no receipt and no entry', async () => {
    const invoice = await facturaEmitida('100.00', '16.00'); // 116.00
    const before = { entries: await entriesOfEntity(), row: await invoiceRow(invoice.id) };
    const restore = await sabotage(invoice.id);
    let e: AccountingError;
    try {
      e = await changed(() => record(invoice.id, '116.00', fecha()));
    } finally {
      await restore();
    }
    expect(e.message).toContain(invoice.invoice_number);
    const receipts = await query(
      `SELECT 1 FROM payment_allocations WHERE invoice_id = $1`, [invoice.id]
    );
    expect(receipts.rows.length).toBe(0);
    expect(await entriesOfEntity()).toBe(before.entries);
    expect(await invoiceRow(invoice.id)).toEqual(before.row);
  });

  it('R2 · receipt record: a receipt dated before the last one does not move the invoice\'s last payment back', async () => {
    const invoice = await facturaEmitida('1000.00', '160.00'); // 1,160.00
    await record(invoice.id, '500.00', iso(fechaEnPeriodo(8, 20)));
    await record(invoice.id, '660.00', iso(fechaEnPeriodo(8, 10))); // 500 + 660 = 1,160: paid
    expect(await invoiceRow(invoice.id)).toEqual({
      amount_due: '0.0000', amount_paid: '1160.0000', status: 'paid', last: '2026-08-20',
    });
  });

  it('R3 · receipt reverse: an invoice reopening that touches no row reverses nothing', async () => {
    const invoice = await facturaEmitida('100.00', '16.00'); // 116.00
    const r = await record(invoice.id, '116.00', fecha());
    const before = { entries: await entriesOfEntity(), row: await invoiceRow(invoice.id) };
    const restore = await sabotage(invoice.id);
    let e: AccountingError;
    try {
      e = await changed(() => reverseCustomerPayment(f.entityId, r.paymentId, { reason: 'cheque devuelto' }, f.userId));
    } finally {
      await restore();
    }
    expect(e.message).toContain(invoice.invoice_number);
    const receipt = await query<{ status: string }>(`SELECT status FROM customer_payments WHERE id = $1`, [r.paymentId]);
    expect(receipt.rows[0].status).toBe('completed');
    const live = await query(
      `SELECT 1 FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`, [r.paymentId]
    );
    expect(live.rows.length).toBe(1);
    expect(await entriesOfEntity()).toBe(before.entries);
    expect(await invoiceRow(invoice.id)).toEqual(before.row);
  });

  describe('and so is the close of a reversed receipt\'s allocations (MNE-001-584)', () => {
    /** Skips the close of one allocation row and nothing else. Returns its undo. */
    const sabotageClose = async (allocationId: string): Promise<() => Promise<void>> => {
      const tag = allocationId.replace(/-/g, '').slice(0, 12);
      await query(
        `CREATE OR REPLACE FUNCTION f03_keep_${tag}() RETURNS TRIGGER AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`
      );
      await query(
        `CREATE TRIGGER trg_f03_keep_${tag} BEFORE UPDATE ON payment_allocations
         FOR EACH ROW WHEN (OLD.id = '${allocationId}' AND NEW.unapplied_at IS NOT NULL)
         EXECUTE FUNCTION f03_keep_${tag}()`
      );
      return async () => {
        await query(`DROP TRIGGER IF EXISTS trg_f03_keep_${tag} ON payment_allocations`);
        await query(`DROP FUNCTION IF EXISTS f03_keep_${tag}()`);
      };
    };
    /** Invoices A and B of 116.00 each; one receipt of 232.00 applied 116.00 to each. */
    const twoInvoicesOneReceipt = async () => {
      const a = await facturaEmitida('100.00', '16.00');
      const b = await facturaEmitida('100.00', '16.00');
      const r = await recordCustomerPayment(
        {
          entityId: f.entityId, counterpartyId: clienteId, paymentAmount: '232.00', paymentDate: fecha(),
          paymentMethod: 'spei',
          applications: [{ documentId: a.id, amountApplied: '116.00' }, { documentId: b.id, amountApplied: '116.00' }],
        },
        f.userId
      );
      return { a, b, paymentId: r.paymentId };
    };
    const allocationsOf = async (paymentId: string) =>
      (await query<{ id: string; invoice_id: string; unapplied_at: string | null; unapply_reason: string | null }>(
        `SELECT id, invoice_id, unapplied_at::text, unapply_reason
           FROM payment_allocations WHERE payment_id = $1 ORDER BY invoice_id`, [paymentId]
      )).rows;
    const statusOf = async (paymentId: string) =>
      (await query<{ status: string }>(`SELECT status FROM customer_payments WHERE id = $1`, [paymentId])).rows[0].status;

    it('R4 · a close that misses one allocation refuses the whole reversal', async () => {
      const { a, b, paymentId } = await twoInvoicesOneReceipt();
      const before = {
        entries: await entriesOfEntity(), a: await invoiceRow(a.id), b: await invoiceRow(b.id),
        allocations: await allocationsOf(paymentId),
      };
      expect(before.a).toMatchObject({ amount_due: '0.0000', status: 'paid' });
      expect(before.b).toMatchObject({ amount_due: '0.0000', status: 'paid' });
      const restore = await sabotageClose(before.allocations.find((x) => x.invoice_id === b.id)!.id);
      let e: unknown;
      try {
        e = await reverseCustomerPayment(f.entityId, paymentId, { reason: 'cheque devuelto' }, f.userId)
          .then(() => null, (err: unknown) => err);
      } finally {
        await restore();
      }
      expect(e, 'the reversal must be refused').toBeInstanceOf(AccountingError);
      expect((e as AccountingError).code).toBe('REVERSE_RACE');
      expect(await statusOf(paymentId)).toBe('completed');
      const after = await allocationsOf(paymentId);
      expect(after).toEqual(before.allocations);
      expect(after.every((x) => x.unapplied_at === null)).toBe(true);
      expect(await entriesOfEntity()).toBe(before.entries);
      expect(await invoiceRow(a.id)).toEqual(before.a);
      expect(await invoiceRow(b.id)).toEqual(before.b);
    });

    it('R5 · with no fault, every allocation closes with the reversal\'s note', async () => {
      const { a, b, paymentId } = await twoInvoicesOneReceipt();
      await reverseCustomerPayment(f.entityId, paymentId, { reason: 'cheque devuelto' }, f.userId);
      expect(await statusOf(paymentId)).toBe('reversed');
      const after = await allocationsOf(paymentId);
      expect(after).toHaveLength(2);
      for (const x of after) {
        expect(x.unapplied_at).not.toBeNull();
        expect(x.unapply_reason).toContain('cheque devuelto');
      }
      expect(await invoiceRow(a.id)).toMatchObject({ amount_due: '116.0000', amount_paid: '0.0000', status: 'sent' });
      expect(await invoiceRow(b.id)).toMatchObject({ amount_due: '116.0000', amount_paid: '0.0000', status: 'sent' });
    });

    it('R6 · a receipt with nothing applied reverses, closing nothing', async () => {
      const r = await recordCustomerPayment(
        {
          entityId: f.entityId, counterpartyId: clienteId, paymentAmount: '50.00', paymentDate: fecha(),
          paymentMethod: 'spei', applications: [], onAccount: true,
        },
        f.userId
      );
      const out = await reverseCustomerPayment(f.entityId, r.paymentId, { reason: 'transferencia devuelta' }, f.userId);
      expect(out.documentosReabiertos).toEqual([]);
      expect(await statusOf(r.paymentId)).toBe('reversed');
      expect(await allocationsOf(r.paymentId)).toEqual([]);
    });

    it('R7 · an allocation unapplied earlier keeps its own date and reason; only the live one reopens', async () => {
      const { a, b, paymentId } = await twoInvoicesOneReceipt();
      await unapplyCustomerPayment(
        f.entityId, paymentId, { invoiceId: b.id, reason: 'aplicado a la factura equivocada' }, f.userId
      );
      const unappliedB = (await allocationsOf(paymentId)).find((x) => x.invoice_id === b.id)!;
      expect(unappliedB.unapplied_at).not.toBeNull();
      const bBefore = await invoiceRow(b.id);
      expect(bBefore).toMatchObject({ amount_due: '116.0000', status: 'sent' });

      const out = await reverseCustomerPayment(f.entityId, paymentId, { reason: 'cheque devuelto' }, f.userId);
      expect(out.documentosReabiertos.map((d) => d.numero)).toEqual([a.invoice_number]);
      expect(await statusOf(paymentId)).toBe('reversed');
      const after = await allocationsOf(paymentId);
      expect(after.find((x) => x.invoice_id === b.id)).toEqual(unappliedB);
      expect(after.find((x) => x.invoice_id === a.id)!.unapply_reason).toContain('cheque devuelto');
      expect(await invoiceRow(a.id)).toMatchObject({ amount_due: '116.0000', status: 'sent' });
      expect(await invoiceRow(b.id)).toEqual(bBefore);
    });

    // MNE-001-589: the rows a miss left before 584 are named by ar check, and only read.
    const probe = async (entityId: string, name: string) =>
      (await runArChecks(entityId, { checks: [name] })).results[0];

    it('R8 · the live row a pre-584 miss left on a reversed receipt is named with its amount, and nothing is written', async () => {
      const { a, b, paymentId } = await twoInvoicesOneReceipt();
      await reverseCustomerPayment(f.entityId, paymentId, { reason: 'cheque devuelto' }, f.userId);
      const number = (await query<{ payment_number: string }>(
        `SELECT payment_number FROM customer_payments WHERE id = $1`, [paymentId]
      )).rows[0].payment_number;
      const rowB = (await query<{ id: string; unapplied_at: Date; unapplied_by: string; unapply_reason: string }>(
        `SELECT id, unapplied_at, unapplied_by, unapply_reason
           FROM payment_allocations WHERE payment_id = $1 AND invoice_id = $2`, [paymentId, b.id]
      )).rows[0];
      // The state a close that missed B's row left: mirrors posted, B reopened, the row live.
      await query(
        `UPDATE payment_allocations SET unapplied_at = NULL, unapplied_by = NULL, unapply_reason = NULL WHERE id = $1`,
        [rowB.id]
      );
      const other = await crearInquilino('F03 Cobrar · MNE-001-589');
      try {
        const before = {
          entries: await entriesOfEntity(), a: await invoiceRow(a.id), b: await invoiceRow(b.id),
          allocations: await allocationsOf(paymentId),
        };
        const found = await probe(f.entityId, 'orphan-application');
        expect(found).toMatchObject({ level: 'blocking', count: 1, detailKey: 'ar.check.orphan_application.found' });
        expect(found.detail, 'the English source is the catalog\'s').toBe(t('ar.check.orphan_application.found', {}, 'en'));
        expect(found.sample).toEqual([`${number} (reversed) → ${b.invoice_number} 116.00`]);
        // Until B is collected again, live 116.00 is not over its 116.00: only this probe sees it.
        expect((await probe(f.entityId, 'over-application')).level).toBe('clean');
        // Another entity does not see it.
        expect(await probe(other.entityId, 'orphan-application')).toMatchObject({ level: 'clean', count: 0, sample: [] });
        // It only reads.
        expect({
          entries: await entriesOfEntity(), a: await invoiceRow(a.id), b: await invoiceRow(b.id),
          allocations: await allocationsOf(paymentId),
        }).toEqual(before);
      } finally {
        await query(
          `UPDATE payment_allocations SET unapplied_at = $2, unapplied_by = $3, unapply_reason = $4 WHERE id = $1`,
          [rowB.id, rowB.unapplied_at, rowB.unapplied_by, rowB.unapply_reason]
        );
      }
    });

    it('R9 · with the row closed again, the probe is clean', async () => {
      expect(await probe(f.entityId, 'orphan-application')).toMatchObject({
        level: 'clean', count: 0, sample: [], detailKey: 'ar.check.orphan_application.none',
      });
    });
  });
});
