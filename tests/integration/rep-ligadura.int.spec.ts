import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { ligarPagoREP } from '../../src/services/xml-ingestion/rep-linkage.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import type { PagoREP } from '../../src/services/xml-ingestion/cfdi-facts.js';

/**
 * EL MISMO HECHO ECONÓMICO POR LAS DOS PUERTAS DA EL MISMO MAYOR.
 *
 * Es el criterio de IVA-2 del Sprint 1 aplicado a la puerta que quedó fuera.
 *
 * Un pago a proveedor puede llegar de dos maneras: capturado por la puerta de
 * pagos, o documentado por el REP que el proveedor envía. La taxonomía tenía
 * escrito que un CFDI tipo P se postea plano —cargo a proveedores, abono a
 * bancos— sin crear fila de pago, y el plan anterior especificaba añadirle
 * encima las líneas del traspaso de IVA.
 *
 * Ese diseño produce dos daños. El banco queda abonado DOS VECES cuando el
 * pago también se capturó. Y el IVA se traspasa dos veces — sólo que
 * `ivaStillParked` topa el exceso en silencio contra lo que queda aparcado,
 * así que la póliza CUADRA y la declaración mensual sale mal. Un número
 * equivocado que cuadra no lo encuentra nadie.
 *
 * Aquí el REP nunca escribe un asiento: resuelve a qué pago corresponde y, si
 * no existe, lo crea por la puerta de pagos. Esa puerta ya libera el IVA
 * —`ivaReclassLines` lee las filas de aplicación, no el pago— así que el
 * traspaso sale gratis y sin una línea de impuesto escrita en la ingesta.
 */

let f: Fixture;
let cuentaAcreditable: string;
let cuentaPendiente: string;
let cuentaBanco: string;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Ligadura del REP');
  cuentaAcreditable = await cuentaPorCodigo(f.entityId, '1130');
  cuentaPendiente = await cuentaPorCodigo(f.entityId, '1135');
  cuentaBanco = await cuentaPorCodigo(f.entityId, '1110');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

interface Gasto {
  billId: string;
  vendorId: string;
  cfdiUuid: string;
  total: string;
  iva: number;
  periodo: string;
}

/**
 * Un gasto a crédito aprobado, con su puente al CFDI que lo originó.
 *
 * El puente importa: `bills` no tiene columna de UUID fiscal, así que la
 * única forma de ir del `IdDocumento` de un REP al gasto es el pre-registro
 * que lo creó. Es el mismo rodeo que ya usan el IVA sobre flujo y el servicio
 * de gastos, y si esa cadena se rompe, la ligadura deja de encontrar nada.
 */
async function gastoAprobado(subtotal = '1000.00', iva = '160.00'): Promise<Gasto> {
  const total = (Number(subtotal) + Number(iva)).toFixed(2);
  const fecha = fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const xmlId = uuidv4();
  const cfdiUuid = uuidv4();
  const marca = uuidv4().slice(0, 8);

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor REP','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${marca}`, f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10)`,
    [billId, f.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`, subtotal, iva, total, fecha, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, await cuentaPorCodigo(f.entityId, '6100'), subtotal, iva, total]
  );

  await query(
    `INSERT INTO xml_documents (
       id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, moneda, xml_content, xml_hash, import_source
     ) VALUES ($1,$2,'cfdi_ingreso',$3,'4.0',$4,'CCC030303CC3','XAXX010101000',$5,$6,'MXN','<x/>',$7,'manual_upload')`,
    [xmlId, f.entityId, cfdiUuid, fecha, subtotal, total, marca]
  );
  await query(
    `INSERT INTO pre_registrations (
       id, entity_id, xml_document_id, source_type, document_type, document_date,
       currency_code, subtotal, total_amount, lines, status, bill_id
     ) VALUES ($1,$2,$3,'xml_cfdi','bill',$4,'MXN',$5,$6,'[]'::jsonb,'completed',$7)`,
    [uuidv4(), f.entityId, xmlId, fecha, subtotal, total, billId]
  );

  const aprobado = await approveBill(billId, f.userId, { entityId: f.entityId });
  const periodo = (aprobado as { entry?: { fiscal_period_id: string } }).entry?.fiscal_period_id;
  return { billId, vendorId, cfdiUuid, total, iva: Number(iva), periodo: periodo as string };
}

/** El nodo `Pago` que un REP traería por ese gasto. */
function pagoDe(g: Gasto, extra: Partial<PagoREP> = {}): PagoREP {
  return {
    fechaPago: fechaEnPeriodo().toISOString(),
    formaDePagoP: '03',
    monedaP: 'MXN',
    monto: Number(g.total),
    numOperacion: 'OP-REP',
    docsRelacionados: [
      {
        uuid: g.cfdiUuid,
        impSaldoAnt: Number(g.total),
        impPagado: Number(g.total),
        impSaldoInsoluto: 0,
        numParcialidad: 1,
        monedaDR: 'MXN',
        ivaTrasladadoDR: g.iva,
        objetoImpDR: '02',
      },
    ],
    ...extra,
  };
}

const ligar = (g: Gasto, pago: PagoREP, repUuid = uuidv4(), indice = 0) =>
  ligarPagoREP({
    tenantId: f.tenantId,
    entityId: f.entityId,
    userId: f.userId,
    cfdiUuid: repUuid,
    direction: 'recibido',
    indice,
    pago,
    fechaCfdi: fechaEnPeriodo(),
    monedaFuncional: 'MXN',
  });

async function pagosDe(billId: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*) AS n FROM payment_applications WHERE bill_id = $1`,
    [billId]
  );
  return Number(r.rows[0].n);
}

describe('el REP llega DESPUÉS de que el pago se capturó', () => {
  it('se casa con el pago existente y no postea nada nuevo', async () => {
    const g = await gastoAprobado('4000.00', '640.00');

    const pago = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: g.total,
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );

    const bancoAntes = await saldoDe(cuentaBanco, g.periodo);
    const pendienteAntes = await saldoDe(cuentaPendiente, g.periodo);

    const r = await ligar(g, pagoDe(g));

    expect(r.accion, 'debía reconocer el pago ya registrado').toBe('casado');
    expect(r.paymentId).toBe(pago.paymentId);
    // Lo que este elemento existe para impedir: un segundo abono al banco.
    expect(
      await saldoDe(cuentaBanco, g.periodo),
      'el REP volvió a mover el banco: es el doble abono'
    ).toBeCloseTo(bancoAntes, 2);
    expect(
      await saldoDe(cuentaPendiente, g.periodo),
      'el REP volvió a tocar el IVA aparcado'
    ).toBeCloseTo(pendienteAntes, 2);
    expect(await pagosDe(g.billId), 'no puede haber dos aplicaciones').toBe(1);
  });

  it('el pago queda marcado con el comprobante que lo documenta', async () => {
    const g = await gastoAprobado('700.00', '112.00');
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: g.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );
    const rep = uuidv4();
    await ligar(g, pagoDe(g), rep);

    const p = await query<{ cfdi_uuid: string; cfdi_pago_indice: number }>(
      `SELECT vp.cfdi_uuid, vp.cfdi_pago_indice FROM vendor_payments vp
         JOIN payment_applications pa ON pa.payment_id = vp.id
        WHERE pa.bill_id = $1`,
      [g.billId]
    );
    expect(p.rows[0].cfdi_uuid, 'sin la marca no se puede saber si un REP ya se procesó').toBe(rep);
    expect(p.rows[0].cfdi_pago_indice).toBe(0);
  });

  it('el mismo REP dos veces no hace nada la segunda', async () => {
    const g = await gastoAprobado('300.00', '48.00');
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: g.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );
    const rep = uuidv4();
    const primera = await ligar(g, pagoDe(g), rep);
    const segunda = await ligar(g, pagoDe(g), rep);

    expect(primera.accion).toBe('casado');
    expect(segunda.accion, 'reprocesar un lote no puede duplicar nada').toBe('ya_ligado');
    expect(segunda.paymentId).toBe(primera.paymentId);
    expect(await pagosDe(g.billId)).toBe(1);
  });
});

describe('el REP llega SIN pago capturado', () => {
  it('crea el pago, y con él se libera el IVA — sin escribir una línea de impuesto', async () => {
    const g = await gastoAprobado('2000.00', '320.00');
    const pendienteAntes = await saldoDe(cuentaPendiente, g.periodo);
    const acreditableAntes = await saldoDe(cuentaAcreditable, g.periodo);
    expect(pendienteAntes, 'la aprobación debió aparcar el IVA').toBeGreaterThan(0);

    const r = await ligar(g, pagoDe(g));

    expect(r.accion).toBe('creado');
    // La afirmación central: el impuesto se movió, y lo movió la puerta de
    // pagos. En la ingesta no hay una sola línea de IVA escrita a mano.
    expect(await saldoDe(cuentaPendiente, g.periodo)).toBeCloseTo(pendienteAntes - 320, 2);
    expect(await saldoDe(cuentaAcreditable, g.periodo)).toBeCloseTo(acreditableAntes + 320, 2);
    expect(await pagosDe(g.billId)).toBe(1);
  });

  it('las dos puertas dejan el MISMO mayor', async () => {
    // El criterio del elemento. Dos gastos idénticos: uno pagado a mano, otro
    // por el REP. Los saldos que mueven tienen que ser los mismos.
    const manual = await gastoAprobado('1500.00', '240.00');
    const porRep = await gastoAprobado('1500.00', '240.00');

    const antes = {
      banco: await saldoDe(cuentaBanco, manual.periodo),
      pendiente: await saldoDe(cuentaPendiente, manual.periodo),
      acreditable: await saldoDe(cuentaAcreditable, manual.periodo),
    };

    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: manual.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: manual.billId, amountApplied: manual.total }],
      },
      f.userId
    );
    const medio = {
      banco: await saldoDe(cuentaBanco, manual.periodo),
      pendiente: await saldoDe(cuentaPendiente, manual.periodo),
      acreditable: await saldoDe(cuentaAcreditable, manual.periodo),
    };

    await ligar(porRep, pagoDe(porRep));
    const despues = {
      banco: await saldoDe(cuentaBanco, manual.periodo),
      pendiente: await saldoDe(cuentaPendiente, manual.periodo),
      acreditable: await saldoDe(cuentaAcreditable, manual.periodo),
    };

    const porManual = {
      banco: medio.banco - antes.banco,
      pendiente: medio.pendiente - antes.pendiente,
      acreditable: medio.acreditable - antes.acreditable,
    };
    const porIngesta = {
      banco: despues.banco - medio.banco,
      pendiente: despues.pendiente - medio.pendiente,
      acreditable: despues.acreditable - medio.acreditable,
    };

    expect(porIngesta.banco, 'el banco').toBeCloseTo(porManual.banco, 2);
    expect(porIngesta.pendiente, 'el IVA que sale de pendiente').toBeCloseTo(porManual.pendiente, 2);
    expect(porIngesta.acreditable, 'el IVA que entra en acreditable').toBeCloseTo(
      porManual.acreditable,
      2
    );
  });
});

describe('las decisiones son del usuario, no del código', () => {
  // Se usa el servicio real, no un INSERT a mano: lo que se prueba es que la
  // decisión del usuario llegue al motor por el camino que el usuario usa
  // —`mnemosine pending define` corre exactamente estas dos funciones—.
  async function fijarPolitica(key: string, value: string): Promise<void> {
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy({ tenantId: f.tenantId }, key, value, f.userId, 'prueba');
  }
  async function borrarPolitica(key: string): Promise<void> {
    await query(`DELETE FROM policy_decisions WHERE tenant_id=$1 AND key=$2`, [f.tenantId, key]);
  }

  it('con «revision», la ingesta NO crea pagos por su cuenta', async () => {
    const g = await gastoAprobado('900.00', '144.00');
    await fijarPolitica('rep_pago_no_registrado', 'revision');
    try {
      const r = await ligar(g, pagoDe(g));
      expect(r.accion).toBe('revision');
      expect(await pagosDe(g.billId), 'no debía crearse ningún pago').toBe(0);
    } finally {
      await borrarPolitica('rep_pago_no_registrado');
    }
  });

  it('por omisión sí lo crea: la política manda, no el código', async () => {
    // Sin fila en policy_decisions, `getPolicy` cae al valor del catálogo.
    const g = await gastoAprobado('900.00', '144.00');
    const r = await ligar(g, pagoDe(g));
    expect(r.accion).toBe('creado');
  });

  it('un documento que el sistema no tiene deja el IVA aparcado, no lo inventa', async () => {
    const g = await gastoAprobado('800.00', '128.00');
    const pendienteAntes = await saldoDe(cuentaPendiente, g.periodo);
    const pago = pagoDe(g);
    pago.docsRelacionados[0].uuid = uuidv4(); // un UUID que nadie tiene

    const r = await ligar(g, pago);
    expect(r.accion).toBe('revision');
    expect(r.motivo).toMatch(/no tiene/i);
    expect(
      await saldoDe(cuentaPendiente, g.periodo),
      'sin la factura original no hay base para repartir el impuesto'
    ).toBeCloseTo(pendienteAntes, 2);
  });

  it('en moneda extranjera se para, en vez de inventar un tipo de cambio', async () => {
    const g = await gastoAprobado('600.00', '96.00');
    const pago = pagoDe(g, { monedaP: 'USD', tipoCambioP: 17.5 });
    const r = await ligar(g, pago);
    expect(r.accion).toBe('revision');
    expect(r.motivo).toMatch(/cambiaria/i);
    expect(await pagosDe(g.billId)).toBe(0);
  });

  it('la tolerancia de importe decide si dos cosas son la misma', async () => {
    const g = await gastoAprobado('1000.00', '160.00');
    // Un pago capturado por un peso de más: fuera de la tolerancia de un centavo.
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: g.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );
    // El REP dice otro importe: no puede casar con ese pago.
    const pago = pagoDe(g);
    pago.monto = Number(g.total) + 50;
    pago.docsRelacionados[0].impPagado = Number(g.total) + 50;

    const r = await ligar(g, pago);
    expect(
      r.accion,
      'cincuenta pesos de diferencia no son redondeo: es otro pago'
    ).not.toBe('casado');
  });
});
