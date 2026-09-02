import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import {
  recordVendorPayment,
  applyVendorPayment,
} from '../../src/services/payments/payment-service.js';
import {
  resolvePolicy,
  seedPolicies,
  reopenPolicy,
} from '../../src/services/policy/policy-service.js';

/**
 * F04 · PAGAR, contra la base real.
 *
 * Tres cosas que hasta hoy no se podían hacer y una que se hacía mal:
 *
 *   1. EL ANTICIPO REPARTIDO DESPUÉS. Una transferencia global al proveedor
 *      quedaba en 1150 sin forma de aplicarla nunca a las facturas concretas.
 *   2. EL DESCUENTO POR PRONTO PAGO. Se rechazaba en voz alta diciendo que
 *      faltaba una cuenta que llevaba sembrada desde el principio (5200).
 *   3. EL PAGO CORTO. Cerrar un gasto pagando de menos, con motivo escrito y
 *      con la cuenta destino decidida por el panel, no por el código.
 *   4. Y el residuo: el IVA de la parte condonada, que si no sale de 1135 en
 *      el mismo asiento se queda vivo para siempre en un gasto CERRADO.
 *
 * Todo contra Postgres real, porque lo que importa no es que las funciones se
 * llamen, sino dónde acaban los saldos.
 */

let f: Fixture;
let cuentaPendiente: string;
let cuentaAcreditable: string;
let cuentaCxp: string;
let cuentaAnticipo: string;
let cuentaDescuento: string;
let cuentaOtrosIngresos: string;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('F04 pagar');
  cuentaPendiente = await cuentaPorCodigo(f.entityId, '1135');
  cuentaAcreditable = await cuentaPorCodigo(f.entityId, '1130');
  cuentaCxp = await cuentaPorCodigo(f.entityId, '2110');
  cuentaAnticipo = await cuentaPorCodigo(f.entityId, '1150');
  cuentaDescuento = await cuentaPorCodigo(f.entityId, '5200');
  // 4300 y no 4200. Esta línea decía 4200 y la prueba pasaba POR la colisión,
  // no a pesar de ella: en el catálogo base 4200 es «Ingresos por Servicios»,
  // así que la semilla de roles se saltaba su propia cuenta y el rol
  // `otros_ingresos` resolvía a ingresos de operación. La prueba pedía ese
  // mismo id y lo llamaba «otros ingresos», de modo que el ✅ describía el
  // defecto. Por eso ahora también se afirma el NOMBRE: un código acertado con
  // la cuenta equivocada es exactamente lo que no se ve.
  cuentaOtrosIngresos = await cuentaPorCodigo(f.entityId, '4300');
  // El panel se siembra a nivel de INQUILINO (entity_id NULL), y ahí es donde
  // se resuelve: `resolvePolicy` exige el mismo alcance en que la decisión
  // está pendiente.
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

/**
 * El periodo en el que cayó el ASIENTO DE LA APLICACIÓN, que no es el del
 * gasto.
 *
 * Aplicar un pago es un evento de HOY: el efectivo salió del banco en su
 * fecha y ya se posteó entonces; repartirlo entre facturas es una decisión
 * posterior, y su asiento lleva la fecha en que se toma. Medir los saldos en
 * el periodo del gasto —que es lo que este archivo hacía— encontraba las
 * cuentas intactas y parecía que la aplicación no había movido nada.
 */
function periodoDelAsiento(r: { journalEntry: { fiscal_period_id?: string } | null }): string {
  const periodo = r.journalEntry?.fiscal_period_id;
  if (!periodo) throw new Error('la aplicación tiene que haber generado asiento');
  return periodo;
}

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/** Un gasto a crédito (PPD) aprobado: pasivo en el mayor, IVA aparcado en 1135. */
async function gastoAprobado(
  subtotal = '1000.00',
  iva = '160.00'
): Promise<{ billId: string; numero: string; total: string; periodo: string; vendorId: string }> {
  const total = new Decimal(subtotal).plus(iva).toFixed(2);
  const fecha = fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor F04','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${marca}`, f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,'PPD')`,
    [billId, f.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`,
     subtotal, iva, total, fecha, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, await cuentaPorCodigo(f.entityId, '6100'), subtotal, iva, total]
  );

  const aprobado = await approveBill(billId, f.userId, { entityId: f.entityId });
  const periodo = (aprobado as { entry?: { fiscal_period_id: string } }).entry?.fiscal_period_id;
  return { billId, numero: `BILL-${marca}`, total, periodo: periodo as string, vendorId };
}

/** Una transferencia global al proveedor, sin aplicar a nada: anticipo puro. */
async function pagoACuenta(vendorId: string, importe: string): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: f.entityId,
      counterpartyId: vendorId,
      paymentAmount: importe,
      paymentDate: fechaEnPeriodo(),
      paymentMethod: 'spei',
      applications: [],
      onAccount: true,
    },
    f.userId
  );
  return r.paymentId;
}

describe('el anticipo a proveedores se reparte DESPUÉS', () => {
  it('una transferencia global sin factura queda viva en 1150 y luego baja al aplicarse', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1160.00');

    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1160.00' }],
      f.userId
    );
    const periodo = periodoDelAsiento(r);

    expect(r.documentos[0].saldoNuevo).toBe('0.00');
    expect(r.documentos[0].estado).toBe('paid');
    expect(r.remanenteAnterior).toBe('1160.00');
    expect(r.remanenteNuevo).toBe('0.00');
    // El efectivo NO se mueve: ya salió del banco. Lo que se mueve es el
    // derecho, del anticipo (crédito: baja el activo) al pasivo que extingue
    // (débito: baja la deuda). Se miden las DOS patas del mismo asiento.
    const lineas = await lineasDelAsiento(r.journalEntry!.id);
    expect(lineas.get(cuentaAnticipo)?.credito).toBe('1160.0000');
    expect(lineas.get(cuentaCxp)?.debito).toBe('1160.0000');
    expect(periodo).toBeTruthy();
  });

  it('libera el IVA aparcado del gasto PPD que paga', async () => {
    const gasto = await gastoAprobado('2000.00', '320.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '2320.00');

    expect(
      await saldoDe(cuentaPendiente, gasto.periodo),
      'aprobar el gasto PPD aparca su IVA'
    ).toBeGreaterThan(0);

    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '2320.00' }],
      f.userId
    );

    const lineas = await lineasDelAsiento(r.journalEntry!.id);
    expect(lineas.get(cuentaPendiente)?.credito, 'sale de 1135').toBe('320.0000');
    expect(lineas.get(cuentaAcreditable)?.debito, 'entra en 1130').toBe('320.0000');
  });

  it('no deja aplicar más de lo que el pago tiene sin repartir', async () => {
    const gasto = await gastoAprobado('500.00', '80.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '200.00');
    await expect(
      applyVendorPayment(
        f.entityId, pagoId,
        [{ documentId: gasto.billId, amountApplied: '580.00' }],
        f.userId
      )
    ).rejects.toThrow(/saldo a cuenta no alcanza/);
  });

  it('rechaza el mismo gasto dos veces en la misma aplicación', async () => {
    const gasto = await gastoAprobado('500.00', '80.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '580.00');
    await expect(
      applyVendorPayment(
        f.entityId, pagoId,
        [
          { documentId: gasto.billId, amountApplied: '290.00' },
          { documentId: gasto.billId, amountApplied: '290.00' },
        ],
        f.userId
      )
    ).rejects.toThrow(/dos veces/);
  });

  it('no alcanza un pago de OTRA entidad ni conociendo su id', async () => {
    const otra = await crearInquilino('F04 · frontera');
    const gasto = await gastoAprobado('100.00', '16.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '116.00');
    await expect(
      applyVendorPayment(
        otra.entityId, pagoId,
        [{ documentId: gasto.billId, amountApplied: '116.00' }],
        otra.userId
      )
    ).rejects.toThrow(/Vendor payment/);
  }, 120_000);
});

describe('el descuento por pronto pago, que se rechazaba por una cuenta que sí existía', () => {
  it('extingue más pasivo que el efectivo, y la diferencia va al contra-costo 5200', async () => {
    // 1160 de deuda: se pagan 1100 y se pactan 60 de descuento.
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1100.00');

    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1100.00', discountAmount: '60.00' }],
      f.userId
    );

    expect(r.documentos[0].saldoNuevo, 'efectivo + descuento saldan el gasto entero').toBe('0.00');
    expect(r.documentos[0].estado).toBe('paid');
    const lineas = await lineasDelAsiento(r.journalEntry!.id);
    // 5200 es contra-costo: se ABONA para reducir la compra.
    expect(lineas.get(cuentaDescuento)?.credito).toBe('60.0000');
    expect(
      lineas.get(cuentaCxp)?.debito,
      'el pasivo se extingue por los 1160 completos, no sólo por el efectivo'
    ).toBe('1160.0000');
  });

  it('el descuento NO cuenta como dinero recibido por el proveedor', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1100.00');
    await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1100.00', discountAmount: '60.00' }],
      f.userId
    );
    const bd = await query<{ amount_paid: string; amount_due: string; status: string }>(
      `SELECT amount_paid, amount_due, status FROM bills WHERE id = $1`, [gasto.billId]
    );
    // Contar el descuento como pagado inflaría lo que salió del banco y
    // descuadraría cualquier conciliación bancaria.
    expect(bd.rows[0].amount_paid).toBe('1100.0000');
    expect(bd.rows[0].amount_due).toBe('0.0000');
    expect(bd.rows[0].status).toBe('paid');
  });

  it('no deja extinguir más de lo que se debe, y dice de qué se compone', async () => {
    const gasto = await gastoAprobado('100.00', '16.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '116.00');
    await expect(
      applyVendorPayment(
        f.entityId, pagoId,
        [{ documentId: gasto.billId, amountApplied: '116.00', discountAmount: '50.00' }],
        f.userId
      )
    ).rejects.toThrow(/de efectivo \+ 50\.00 de descuento/);
  });
});

describe('el pago corto: cerrar un gasto pagando de menos', () => {
  it('sin motivo escrito no se hace, porque un pasivo que desaparece necesita explicación', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    await expect(
      applyVendorPayment(
        f.entityId, pagoId,
        [{ documentId: gasto.billId, amountApplied: '1000.00' }],
        f.userId,
        { modo: 'residual' }
      )
    ).rejects.toThrow(/--short-pay-reason/);
  });

  it('en modo `partial` el gasto SIGUE ABIERTO por la diferencia', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1000.00' }],
      f.userId,
      { modo: 'partial' }
    );
    expect(r.documentos[0].saldoNuevo).toBe('160.00');
    expect(r.documentos[0].estado).toBe('partially_paid');
    expect(r.condonado).toBe('0.00');
  });

  it('en modo `residual` el gasto se CIERRA y lo que falta deja de deberse', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1000.00' }],
      f.userId,
      { modo: 'residual', shortPayReason: 'Flete en disputa, acordado con el proveedor' }
    );

    expect(r.documentos[0].saldoNuevo).toBe('0.00');
    expect(r.documentos[0].estado).toBe('paid');
    expect(r.condonado, 'los 160 que no se pagaron').toBe('160.00');
    // El defecto declarado del panel mientras nadie lo decida.
    expect(r.cuentaCondonacion).toBe('devolucion_compras');
    expect(r.politicaDefinida, 'nadie ha resuelto la política todavía').toBe(false);

    const lineas = await lineasDelAsiento(r.journalEntry!.id);
    // El pasivo se extingue ENTERO: efectivo 1000 + condonado 160.
    expect(lineas.get(cuentaCxp)?.debito).toBe('1160.0000');
    // De los 160 condonados, la parte de IVA (160 × 160/1160 = 22.07) sale de
    // 1135 SIN acreditarse; sólo el resto (137.93) es costo y va al 5200.
    expect(r.ivaNoAcreditable).toBe('22.07');
    expect(lineas.get(cuentaDescuento)?.credito).toBe('137.9310');
  });

  it('EL RESIDUO: 1135 queda en cero para un gasto cerrado corto', async () => {
    // Es el defecto que este modo podía introducir: liberar sólo la parte
    // pagada dejaría vivo en 1135 el IVA de un gasto que ya nadie va a pagar,
    // y ningún informe sabría de dónde salió ese resto.
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');

    await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1000.00' }],
      f.userId,
      { modo: 'residual', shortPayReason: 'Merma aceptada' }
    );

    const parked = await query<{ saldo: string }>(
      `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS saldo
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.status = 'posted'
          AND jel.account_id = $2
          AND je.source_id IN (
            SELECT id FROM bills WHERE id = $3
            UNION SELECT payment_id FROM payment_applications WHERE bill_id = $3
          )`,
      [f.entityId, cuentaPendiente, gasto.billId]
    );
    expect(
      new Decimal(parked.rows[0].saldo).abs().toNumber(),
      'todo el IVA aparcado por este gasto tiene que haber salido de 1135'
    ).toBeLessThan(0.005);
  });

  it('el motivo del pago corto queda en la bitácora, que es su única huella', async () => {
    const gasto = await gastoAprobado('500.00', '80.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '500.00');
    const motivo = 'Nota de crédito prometida y nunca emitida';
    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '500.00' }],
      f.userId,
      { modo: 'residual', shortPayReason: motivo }
    );
    const log = await query<{ new_values: Record<string, unknown> }>(
      `SELECT new_values FROM audit_log
        WHERE entity_type = 'vendor_payments' AND entity_id = $1
        ORDER BY timestamp DESC LIMIT 1`,
      [r.paymentId]
    );
    expect(log.rows[0].new_values.short_pay_reason).toBe(motivo);
    expect(log.rows[0].new_values.condonado).toBe('80.00');
  });
});

describe('la cuenta del pago corto la decide el PANEL, no el código', () => {
  it('resuelta a `otros_ingresos`, el saldo condonado deja de tocar el 5200', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId },
      'pago_corto_residual',
      'otros_ingresos',
      'victor@example.com',
      'El despacho lo trata como ganancia del periodo'
    );

    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1000.00' }],
      f.userId,
      { modo: 'residual', shortPayReason: 'Acuerdo comercial' }
    );

    expect(r.cuentaCondonacion).toBe('otros_ingresos');
    expect(r.politicaDefinida, 'ahora sí la decidió alguien').toBe(true);
    const lineas = await lineasDelAsiento(r.journalEntry!.id);
    expect(lineas.get(cuentaOtrosIngresos)?.credito).toBe('137.9310');
    expect(lineas.get(cuentaDescuento), 'el contra-costo ya no participa').toBeUndefined();
    const nombre = await query<{ name: string }>(
      'SELECT name FROM accounts WHERE id = $1', [cuentaOtrosIngresos]
    );
    expect(nombre.rows[0].name, 'la condonación no puede caer en ingresos de operación')
      .toBe('Otros Ingresos');
  });

  it('resuelta a `prohibir`, el modo residual se niega y dice qué hacer en su lugar', async () => {
    // Cambiar de criterio no es re-resolver: hay que REABRIR primero. El
    // UPDATE de resolvePolicy exige status 'pending' a propósito, para que
    // una decisión ya tomada no se sobrescriba sin dejar rastro del cambio.
    await reopenPolicy({ tenantId: f.tenantId }, 'pago_corto_residual');
    await resolvePolicy(
      { tenantId: f.tenantId },
      'pago_corto_residual',
      'prohibir',
      'victor@example.com',
      'Aquí no se cierra nada sin nota de crédito del proveedor'
    );

    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    await expect(
      applyVendorPayment(
        f.entityId, pagoId,
        [{ documentId: gasto.billId, amountApplied: '1000.00' }],
        f.userId,
        { modo: 'residual', shortPayReason: 'Da igual el motivo: está prohibido' }
      )
    ).rejects.toThrow(/nota de crédito/);
  });

  it('y `partial` sigue funcionando aunque `residual` esté prohibido', async () => {
    const gasto = await gastoAprobado('1000.00', '160.00');
    const pagoId = await pagoACuenta(gasto.vendorId, '1000.00');
    const r = await applyVendorPayment(
      f.entityId, pagoId,
      [{ documentId: gasto.billId, amountApplied: '1000.00' }],
      f.userId
    );
    expect(r.documentos[0].estado).toBe('partially_paid');
  });
});

/**
 * Las líneas de un asiento, por cuenta.
 *
 * Se mide el ASIENTO y no el saldo acumulado del periodo a propósito: los
 * saldos materializados mezclan todo lo que la suite haya posteado antes en
 * esa cuenta, así que una aserción sobre ellos pasa o falla según en qué
 * orden corran las pruebas. Las líneas del asiento son de este evento y de
 * ningún otro.
 */
async function lineasDelAsiento(
  entryId: string
): Promise<Map<string, { debito: string | null; credito: string | null }>> {
  const r = await query<{ account_id: string; debit_amount: string | null; credit_amount: string | null }>(
    `SELECT account_id, debit_amount, credit_amount
       FROM journal_entry_lines WHERE journal_entry_id = $1`,
    [entryId]
  );
  const m = new Map<string, { debito: string | null; credito: string | null }>();
  for (const l of r.rows) {
    // Una cuenta puede recibir DOS líneas en el mismo asiento (p. ej. 1135
    // pierde IVA por acreditación y por condonación). Se suman, que es lo que
    // el mayor acaba viendo.
    const previo = m.get(l.account_id);
    const debito = new Decimal(previo?.debito ?? '0').plus(l.debit_amount ?? '0');
    const credito = new Decimal(previo?.credito ?? '0').plus(l.credit_amount ?? '0');
    m.set(l.account_id, {
      debito: debito.isZero() ? null : debito.toFixed(4),
      credito: credito.isZero() ? null : credito.toFixed(4),
    });
  }
  return m;
}
