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
async function facturaEmitida(subtotal: string, tax: string): Promise<Invoice> {
  const draft = await createInvoice({
    entity_id: f.entityId,
    customer_id: clienteId,
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
    expect(Number(porCuenta['1110'].debit)).toBeCloseTo(1500); // banco
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
});
