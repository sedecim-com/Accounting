import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { ligarPagoREP } from '../../src/services/xml-ingestion/rep-linkage.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
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

async function fijarPoliticaGlobal(key: string, value: string): Promise<void> {
  await seedPolicies({ tenantId: f.tenantId });
  await resolvePolicy({ tenantId: f.tenantId }, key, value, f.userId, 'prueba');
}
async function borrarPoliticaGlobal(key: string): Promise<void> {
  await query(`DELETE FROM policy_decisions WHERE tenant_id=$1 AND key=$2`, [f.tenantId, key]);
}

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

/**
 * EL CAMINO COMPLETO: DE UN XML A UN PAGO LIGADO.
 *
 * Lo anterior prueba el motor. Esto prueba que el motor esté ENCHUFADO, que
 * es distinto: un CFDI tipo P recibía `document_type='credit_note'` —por
 * descarte, porque no es 'I'— y moría con UNSUPPORTED_TYPE antes de llegar a
 * ninguna parte. El pre-registro quedaba en 'error' y el comprobante que
 * sostiene el acreditamiento del IVA no se contabilizaba nunca.
 */
describe('la ingesta reconoce un REP y lo procesa', () => {
  function xmlDeREP(g: Gasto, repUuid: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:pago20="http://www.sat.gob.mx/Pagos20" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" TipoDeComprobante="P" Moneda="XXX" Total="0" SubTotal="0"
  Fecha="${fechaEnPeriodo().toISOString().slice(0, 19)}" LugarExpedicion="64000" Exportacion="01">
  <cfdi:Emisor Rfc="CCC030303CC3" Nombre="Proveedor REP" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Cliente" UsoCFDI="CP01"
    DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT"
      Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Pago FechaPago="${fechaEnPeriodo().toISOString().slice(0, 19)}"
        FormaDePagoP="03" MonedaP="MXN" Monto="${g.total}" NumOperacion="OP-9">
        <pago20:DoctoRelacionado IdDocumento="${g.cfdiUuid}" MonedaDR="MXN" NumParcialidad="1"
          ImpSaldoAnt="${g.total}" ImpPagado="${g.total}" ImpSaldoInsoluto="0" ObjetoImpDR="02">
          <pago20:ImpuestosDR><pago20:TrasladosDR>
            <pago20:TrasladoDR BaseDR="${(Number(g.total) - g.iva).toFixed(2)}" ImpuestoDR="002"
              TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="${g.iva.toFixed(2)}"/>
          </pago20:TrasladosDR></pago20:ImpuestosDR>
        </pago20:DoctoRelacionado>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${repUuid}"
      FechaTimbrado="${fechaEnPeriodo().toISOString().slice(0, 19)}" SelloCFD="x" NoCertificadoSAT="1" SelloSAT="y"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
  }

  it('el pre-registro nace como «payment», no como nota de crédito', async () => {
    const g = await gastoAprobado('1200.00', '192.00');
    const svc = new PreRegistrationService();
    const r = await svc.processXMLUpload(
      f.entityId, xmlDeREP(g, uuidv4()), 'manual_upload', f.userId
    );
    expect(
      (r.preRegistration as { document_type: string }).document_type,
      'un REP no es una nota de crédito, y tratarlo como tal lo mataba'
    ).toBe('payment');
  });

  it('procesarlo crea el pago y libera el IVA, sin póliza propia del REP', async () => {
    const g = await gastoAprobado('1200.00', '192.00');
    const pendienteAntes = await saldoDe(cuentaPendiente, g.periodo);
    const acreditableAntes = await saldoDe(cuentaAcreditable, g.periodo);

    const svc = new PreRegistrationService();
    const subida = await svc.processXMLUpload(
      f.entityId, xmlDeREP(g, uuidv4()), 'manual_upload', f.userId
    );
    const res = await svc.processToAccounting(
      subida.preRegistration as Record<string, unknown>, f.userId
    );

    expect(res.paymentId, 'el REP debía resolverse en un pago').toBeTruthy();
    expect(await saldoDe(cuentaPendiente, g.periodo)).toBeCloseTo(pendienteAntes - 192, 2);
    expect(await saldoDe(cuentaAcreditable, g.periodo)).toBeCloseTo(acreditableAntes + 192, 2);
    expect(await pagosDe(g.billId)).toBe(1);

    // El pre-registro apunta al pago, no a una póliza inventada.
    const pr = await query<{ status: string; result_type: string; result_id: string }>(
      `SELECT status, result_type, result_id FROM pre_registrations WHERE id = $1`,
      [(subida.preRegistration as { id: string }).id]
    );
    expect(pr.rows[0].status).toBe('completed');
    expect(pr.rows[0].result_type).toBe('payment');
    expect(pr.rows[0].result_id).toBe(res.paymentId);
  });

  it('lo que necesita decisión queda en revisión, no en error', async () => {
    // Un REP que relaciona un documento que el sistema no tiene: espera a la
    // factura. Antes, cualquier tropiezo dejaba el pre-registro en 'error',
    // que es donde van los fallos del sistema — no los documentos que esperan
    // a una persona.
    const g = await gastoAprobado('400.00', '64.00');
    const ajeno: Gasto = { ...g, cfdiUuid: uuidv4() };
    const svc = new PreRegistrationService();
    const subida = await svc.processXMLUpload(
      f.entityId, xmlDeREP(ajeno, uuidv4()), 'manual_upload', f.userId
    );
    await expect(
      svc.processToAccounting(subida.preRegistration as Record<string, unknown>, f.userId)
    ).rejects.toThrow();

    const pr = await query<{ status: string; validation_status: string; error_message: string }>(
      `SELECT status, validation_status, error_message FROM pre_registrations WHERE id = $1`,
      [(subida.preRegistration as { id: string }).id]
    );
    expect(pr.rows[0].status, 'esperar una factura no es un fallo del sistema').toBe('draft');
    expect(pr.rows[0].validation_status).toBe('needs_review');
    expect(pr.rows[0].error_message).toMatch(/no tiene/i);
  });
});

/**
 * LO QUE LA AUDITORÍA ADVERSARIA DESTAPÓ, FIJADO.
 *
 * Tres altos de dinero en un módulo con diez pruebas en verde: la rama del
 * lado emitido consultaba una columna que no existe (cero cobertura AR), la
 * búsqueda de candidato usaba un importe distinto del de creación (el
 * duplicado exacto que el módulo dice impedir), y el casado no cotejaba las
 * aplicaciones (dos pagos iguales se cruzaban). Cada caso de aquí abajo
 * reprodujo primero el defecto contra Postgres.
 */
describe('el lado EMITIDO: cobros de clientes', () => {
  async function facturaTimbrada(subtotal = '1000.00', iva = '160.00') {
    const total = (Number(subtotal) + Number(iva)).toFixed(2);
    const invoiceId = uuidv4();
    const customerId = uuidv4();
    const cfdiUuid = uuidv4();
    const marca = uuidv4().slice(0, 8);
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1,$2,$3,'Cliente REP','DDD040404DD4','rfc','MXN',$4)`,
      [customerId, f.entityId, `C-${marca}`, f.userId]
    );
    await query(
      `INSERT INTO invoices (
         id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
         amount_due, amount_paid, currency_code, invoice_date, due_date, status, cfdi_uuid, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0,'MXN',$8,$8,'sent',$9,$10)`,
      [invoiceId, f.entityId, `INV-${marca}`, customerId, subtotal, iva, total,
       fechaEnPeriodo(), cfdiUuid, f.userId]
    );
    return { invoiceId, customerId, cfdiUuid, total, iva: Number(iva) };
  }

  it('un REP emitido crea el cobro — la rama que moría con una columna inexistente', async () => {
    // La consulta decía `balance_due`; la tabla tiene `amount_due`. Todo REP
    // emitido lanzaba 42703 y el pre-registro caía en 'error'. Nadie lo vio
    // porque la suite sólo cubría gastos: una rama sin prueba no está «casi
    // lista», está sin ejecutar.
    const fac = await facturaTimbrada('2000.00', '320.00');
    const r = await ligarPagoREP({
      tenantId: f.tenantId,
      entityId: f.entityId,
      userId: f.userId,
      cfdiUuid: uuidv4(),
      direction: 'emitido',
      indice: 0,
      pago: {
        fechaPago: fechaEnPeriodo().toISOString(),
        formaDePagoP: '03', monedaP: 'MXN', monto: Number(fac.total),
        docsRelacionados: [{
          uuid: fac.cfdiUuid, impSaldoAnt: Number(fac.total),
          impPagado: Number(fac.total), impSaldoInsoluto: 0, monedaDR: 'MXN',
        }],
      },
      fechaCfdi: fechaEnPeriodo(),
      monedaFuncional: 'MXN',
    });
    expect(r.accion, r.motivo).toBe('creado');
    const alloc = await query<{ n: string }>(
      `SELECT count(*) AS n FROM payment_allocations WHERE invoice_id = $1`,
      [fac.invoiceId]
    );
    expect(Number(alloc.rows[0].n)).toBe(1);
  });
});

describe('regresiones de la auditoría del casamiento', () => {
  it('busca por lo que crearía, no por el Monto del nodo: sin duplicado con un DR ajeno', async () => {
    // Reproducido antes del arreglo: REP con Monto 11,600 y dos DR (uno del
    // sistema por 5,800 y uno ajeno por 5,800), política postear_sin_iva, y
    // un pago capturado de 5,800. La búsqueda iba por 11,600 → no casaba →
    // se creaba el segundo pago: banco abonado dos veces, IVA liberado dos
    // veces, y la póliza cuadrando.
    const g = await gastoAprobado('10000.00', '1600.00');
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: '5800.00', paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: '5800.00' }],
      },
      f.userId
    );
    await fijarPoliticaGlobal('rep_documento_desconocido', 'postear_sin_iva');
    try {
      const pago = pagoDe(g);
      pago.monto = 11600;
      pago.docsRelacionados = [
        { uuid: g.cfdiUuid, impSaldoAnt: 11600, impPagado: 5800, impSaldoInsoluto: 5800, monedaDR: 'MXN' },
        { uuid: uuidv4(), impSaldoAnt: 5800, impPagado: 5800, impSaldoInsoluto: 0, monedaDR: 'MXN' },
      ];
      const r = await ligar(g, pago);
      expect(r.accion, 'debía encontrar el pago de 5,800 ya capturado').toBe('casado');
      expect(await pagosDe(g.billId), 'un solo pago aplicado, no dos').toBe(1);
    } finally {
      await borrarPoliticaGlobal('rep_documento_desconocido');
    }
  });

  it('el candidato tiene que estar aplicado a LOS documentos del REP, no sólo parecerse', async () => {
    // Dos gastos iguales del mismo proveedor, un solo pago capturado (el de
    // B). El REP de A casaba con el pago de B por tercero+importe+fecha, y A
    // se quedaba sin pago y con su IVA aparcado mientras B lucía un
    // comprobante que no era suyo.
    const a = await gastoAprobado('3000.00', '480.00');
    const b = await gastoAprobado('3000.00', '480.00');
    // mismo proveedor para los dos gastos
    await query(`UPDATE bills SET vendor_id = (SELECT vendor_id FROM bills WHERE id = $1) WHERE id = $2`,
      [a.billId, b.billId]);
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: b.total, paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: b.billId, amountApplied: b.total }],
      },
      f.userId
    );
    const r = await ligar(a, pagoDe(a));
    expect(
      r.accion,
      'el pago existente está aplicado a B: casarlo con el REP de A cruza los comprobantes'
    ).not.toBe('casado');
  });

  it('fuera de la ventana de días no es el mismo hecho', async () => {
    // Toda la suite vivía en el mismo día, así que la ventana jamás se había
    // ejercitado en la dirección que rechaza.
    const g = await gastoAprobado('700.00', '112.00');
    const lejos = new Date(fechaEnPeriodo());
    lejos.setDate(lejos.getDate() - 10);
    await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: g.total, paymentDate: lejos,
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );
    const r = await ligar(g, pagoDe(g));
    // No casa — y tampoco crea: el gasto ya quedó `paid` por aquel pago, así
    // que la puerta de pagos rechaza aplicarle otro y el REP cae en revisión.
    // Las dos cosas son correctas: un comprobante para un documento ya
    // saldado por un pago que no coincide en fecha ES un caso para una
    // persona, no para el importador.
    expect(r.accion, 'diez días con ventana de tres no son el mismo pago').not.toBe('casado');
    const lejano = await query<{ cfdi_uuid: string | null }>(
      `SELECT vp.cfdi_uuid FROM vendor_payments vp
         JOIN payment_applications pa ON pa.payment_id = vp.id
        WHERE pa.bill_id = $1`,
      [g.billId]
    );
    expect(lejano.rows[0].cfdi_uuid, 'el pago lejano no debe quedar marcado').toBeNull();
  });

  it('el IVA que el REP declara se coteja: divergencia va a revisión', async () => {
    // El complemento traía ImpuestosDR y se descartaba mientras el catálogo
    // prometía que «la cifra del SAT siempre gana». Ahora se coteja contra el
    // prorrateo del documento; si contradice, nadie libera nada en silencio.
    const g = await gastoAprobado('1000.00', '160.00');
    const pago = pagoDe(g);
    pago.docsRelacionados[0].ivaTrasladadoDR = 90; // el prorrateo da 160
    const r = await ligar(g, pago);
    expect(r.accion).toBe('revision');
    expect(r.motivo).toMatch(/90\.00/);
    expect(r.motivo).toMatch(/160\.00/);
  });

  it('el pago creado desde REP conserva su referencia y su moneda', async () => {
    // El INSERT de proveedores omitía reference_number y currency_code — y la
    // columna de moneda tiene DEFAULT 'USD', así que todo pago en pesos
    // quedaba registrado como dólares.
    const g = await gastoAprobado('500.00', '80.00');
    const r = await ligar(g, pagoDe(g));
    expect(r.accion).toBe('creado');
    const p = await query<{ reference_number: string; currency_code: string }>(
      `SELECT reference_number, currency_code FROM vendor_payments WHERE id = $1`,
      [r.paymentId]
    );
    expect(p.rows[0].currency_code, 'MXN registrado como USD').toBe('MXN');
    expect(p.rows[0].reference_number).toBe('OP-REP');
  });
});
