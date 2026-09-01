import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';

/**
 * EL PAGO DESDE LA TERMINAL.
 *
 * postVendorPaymentEntry sólo se invocaba desde dos rutas REST, así que
 * quien operaba por terminal —que es la tesis del producto— registraba el
 * gasto pero nunca lo pagaba, y el IVA de todo CFDI a crédito se quedaba
 * aparcado en la 1135 indefinidamente. Este servicio es el camino que usan
 * la terminal, la API y el agente.
 *
 * Se prueba contra Postgres real porque lo que importa no es que se llame a
 * la función, sino que los saldos acaben donde deben.
 */

let f: Fixture;
let otra: Fixture;
let cuentaAcreditable: string;
let cuentaPendiente: string;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Pagos');
  otra = await crearInquilino('Pagos · otra entidad');
  cuentaAcreditable = await cuentaPorCodigo(f.entityId, '1130');
  cuentaPendiente = await cuentaPorCodigo(f.entityId, '1135');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/**
 * Un gasto a crédito, aprobado: su pasivo ya está en el mayor y su IVA
 * aparcado en la 1135, que es de donde el pago tiene que sacarlo.
 */
async function gastoAprobado(
  fixture: Fixture,
  subtotal = '1000.00',
  iva = '160.00'
): Promise<{ billId: string; numero: string; total: string; periodo: string }> {
  const total = (Number(subtotal) + Number(iva)).toFixed(2);
  const fecha = fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor a crédito','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, fixture.entityId, `V-${marca}`, fixture.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10)`,
    [billId, fixture.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`,
     subtotal, iva, total, fecha, fixture.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, await cuentaPorCodigo(fixture.entityId, '6100'), subtotal, iva, total]
  );

  const aprobado = await approveBill(billId, fixture.userId, { entityId: fixture.entityId });
  const periodo = (aprobado as { entry?: { fiscal_period_id: string } }).entry?.fiscal_period_id;
  return { billId, numero: `BILL-${marca}`, total, periodo: periodo as string };
}

describe('pagar un gasto a crédito libera su IVA', () => {
  it('el impuesto sale de pendiente (1135) y entra en acreditable (1130)', async () => {
    const gasto = await gastoAprobado(f, '4000.00', '640.00');

    const pendienteAntes = await saldoDe(cuentaPendiente, gasto.periodo);
    const acreditableAntes = await saldoDe(cuentaAcreditable, gasto.periodo);
    expect(pendienteAntes, 'la aprobación debe haber aparcado el IVA').toBeGreaterThan(0);

    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: gasto.total,
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: gasto.billId, amountApplied: gasto.total }],
      },
      f.userId
    );

    expect(r.journalEntry, 'el pago debe generar asiento').not.toBeNull();
    expect(await saldoDe(cuentaPendiente, gasto.periodo)).toBeCloseTo(pendienteAntes - 640, 2);
    expect(await saldoDe(cuentaAcreditable, gasto.periodo)).toBeCloseTo(acreditableAntes + 640, 2);
  });

  it('el saldo del gasto queda liquidado y el documento pagado', async () => {
    const gasto = await gastoAprobado(f, '500.00', '80.00');
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: gasto.total,
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: gasto.billId, amountApplied: gasto.total }],
      },
      f.userId
    );
    expect(r.documentos[0].saldoNuevo).toBe('0.00');
    expect(r.documentos[0].estado).toBe('paid');

    const bd = await query<{ status: string; amount_due: string }>(
      `SELECT status, amount_due FROM bills WHERE id = $1`, [gasto.billId]
    );
    expect(bd.rows[0].status).toBe('paid');
    expect(Number(bd.rows[0].amount_due)).toBeCloseTo(0, 2);
  });
});

describe('el ensayo no escribe', () => {
  it('dry-run devuelve el mismo resultado y deja la base intacta', async () => {
    const gasto = await gastoAprobado(f, '700.00', '112.00');
    const antesPagos = await query<{ n: string }>(
      `SELECT count(*) AS n FROM vendor_payments WHERE entity_id = $1`, [f.entityId]
    );
    const antesSaldo = await saldoDe(cuentaPendiente, gasto.periodo);

    const previo = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: gasto.total,
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: gasto.billId, amountApplied: gasto.total }],
      },
      f.userId,
      { dryRun: true }
    );

    // Devuelve lo que HARÍA, con asiento y todo.
    expect(previo.documentos[0].saldoNuevo).toBe('0.00');
    expect(previo.journalEntry).not.toBeNull();

    // Y no escribió nada.
    const despuesPagos = await query<{ n: string }>(
      `SELECT count(*) AS n FROM vendor_payments WHERE entity_id = $1`, [f.entityId]
    );
    expect(despuesPagos.rows[0].n).toBe(antesPagos.rows[0].n);
    expect(await saldoDe(cuentaPendiente, gasto.periodo)).toBeCloseTo(antesSaldo, 2);

    const bd = await query<{ status: string }>(`SELECT status FROM bills WHERE id = $1`, [gasto.billId]);
    expect(bd.rows[0].status).not.toBe('paid');
  });
});

describe('lo que el servicio se niega a hacer', () => {
  it('no se puede aplicar más de lo que se debe', async () => {
    const gasto = await gastoAprobado(f, '100.00', '16.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '500.00',
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '500.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/debe 116\.00 y se intentan aplicar 500\.00/);
  });

  it('las aplicaciones no pueden sumar más que el pago', async () => {
    const gasto = await gastoAprobado(f, '100.00', '16.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: '50.00',
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/no se puede aplicar más de lo que se pagó/);
  });

  it('un pago sin aplicar a nada se rechaza: no liberaría nada', async () => {
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '10.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei', applications: [],
        },
        f.userId
      )
    ).rejects.toThrow(/no libera saldo ni acredita IVA/);
  });

  it('un estado distinto de completed se rechaza nombrando al programador que no existe', async () => {
    const gasto = await gastoAprobado(f, '100.00', '16.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '116.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei', status: 'pending',
          applications: [{ documentId: gasto.billId, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/programador de pagos que no existe/);
  });
});

describe('la frontera de entidad', () => {
  it('conocer el UUID de un gasto ajeno no permite pagarlo', async () => {
    // El gasto vive en OTRA entidad. Antes, la ruta REST leía la factura con
    // `WHERE id = $1` sin filtro: bastaba el UUID para aplicarle un cobro y
    // su asiento. Ahora la lectura va acotada por entidad.
    const ajeno = await gastoAprobado(otra, '900.00', '144.00');

    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,           // ← mi entidad
          paymentAmount: ajeno.total,
          paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: ajeno.billId, amountApplied: ajeno.total }],
        },
        f.userId
      )
    ).rejects.toThrow(/Bill/);

    // Y el gasto ajeno sigue intacto.
    const bd = await query<{ status: string; amount_due: string }>(
      `SELECT status, amount_due FROM bills WHERE id = $1`, [ajeno.billId]
    );
    expect(bd.rows[0].status).not.toBe('paid');
    expect(Number(bd.rows[0].amount_due)).toBeGreaterThan(0);
  });

  it('tampoco se le crea un pago a la otra entidad', async () => {
    const antes = await query<{ n: string }>(
      `SELECT count(*) AS n FROM vendor_payments WHERE entity_id = $1`, [otra.entityId]
    );
    const ajeno = await gastoAprobado(otra, '300.00', '48.00');
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: ajeno.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: ajeno.billId, amountApplied: ajeno.total }],
      },
      f.userId
    ).catch(() => undefined);

    const despues = await query<{ n: string }>(
      `SELECT count(*) AS n FROM vendor_payments WHERE entity_id = $1`, [otra.entityId]
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});

/**
 * LO QUE LA AUDITORÍA ENCONTRÓ Y AQUÍ QUEDA FIJADO.
 *
 * Cinco defectos del servicio de pagos, todos con escenario reproducible y
 * ninguno atrapado por la suite anterior.
 */
describe('defectos de dinero que la auditoría destapó', () => {
  it('el mismo documento dos veces en un pago se rechaza', async () => {
    // Ambas aplicaciones validaban contra el saldo ORIGINAL —el bucle que
    // valida corre entero antes del que escribe— y los dos UPDATE se
    // acumulaban: amount_due quedaba en negativo, el gasto en 'paid', y el
    // asiento cargaba el doble a la cuenta de control de proveedores.
    const gasto = await gastoAprobado(f, '1000.00', '160.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '2320.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [
            { documentId: gasto.billId, amountApplied: '1160.00' },
            { documentId: gasto.billId, amountApplied: '1160.00' },
          ],
        },
        f.userId
      )
    ).rejects.toThrow(/aparece dos veces/);

    const bd = await query<{ amount_due: string; status: string }>(
      `SELECT amount_due, status FROM bills WHERE id = $1`, [gasto.billId]
    );
    expect(Number(bd.rows[0].amount_due), 'el saldo no puede quedar negativo').toBeGreaterThan(0);
  });

  it('aplicar MENOS de lo pagado se rechaza: el resto quedaría en el aire', async () => {
    // El asiento carga el importe completo del pago contra la cuenta de
    // control mientras el auxiliar sólo baja lo aplicado.
    const gasto = await gastoAprobado(f, '1000.00', '160.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '1160.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '500.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/Tienen que coincidir/);
  });

  it('un gasto en otra moneda no se paga con un importe crudo', async () => {
    const gasto = await gastoAprobado(f, '1000.00', '160.00');
    await query(`UPDATE bills SET currency_code = 'USD' WHERE id = $1`, [gasto.billId]);
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '1160.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei', currencyCode: 'MXN',
          applications: [{ documentId: gasto.billId, amountApplied: '1160.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/está en USD y el pago en MXN/);
  });

  it('un descuento por pronto pago se rechaza en voz alta, no se traga', async () => {
    // Se insertaba en payment_applications y no participaba en nada más: ni
    // reducía el saldo ni entraba en el asiento, así que el proveedor quedaba
    // debiendo el descuento para siempre.
    const gasto = await gastoAprobado(f, '1000.00', '160.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '1100.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '1100.00', discountAmount: '60.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/descuento por pronto pago todavía no se puede registrar/);
  });

  it('un gasto en borrador no se paga: su pasivo no está en el mayor', async () => {
    // La guarda vivía SÓLO en el comando de la terminal; por REST se pagaba
    // un borrador y se posteaba el asiento contra un pasivo inexistente.
    const gasto = await gastoAprobado(f, '400.00', '64.00');
    await query(`UPDATE bills SET status = 'draft' WHERE id = $1`, [gasto.billId]);
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, paymentAmount: '464.00', paymentDate: fechaEnPeriodo(),
          paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '464.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/su pasivo tiene que estar en el mayor primero/);
  });

  it('el pago se atribuye al proveedor del gasto, no a otro', async () => {
    const gasto = await gastoAprobado(f, '100.00', '16.00');
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId, counterpartyId: uuidv4(),
          paymentAmount: '116.00', paymentDate: fechaEnPeriodo(), paymentMethod: 'spei',
          applications: [{ documentId: gasto.billId, amountApplied: '116.00' }],
        },
        f.userId
      )
    ).rejects.toThrow(/auxiliar equivocado/);
  });
});
