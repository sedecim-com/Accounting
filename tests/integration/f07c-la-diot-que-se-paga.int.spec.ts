import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { NotFoundError, ValidationError } from '../../src/utils/errors.js';
import {
  construirDiot,
  esEntregable,
  PAPEL_DE_TRABAJO,
  SERIALIZADOR_SAT,
  DiotFormatoNoFundamentado,
  RFC_GENERICO_NACIONAL,
} from '../../src/services/sat/diot/index.js';

// ============================================================
// F07c · LA DIOT, MEDIDA CONTRA POSTGRES
//
// Las unitarias (tests/sat/diot/) prueban el reparto por tasa y la
// clasificación del tercero con las cifras ya en la mano. Lo que NO pueden
// probar —y es lo único que importa de este módulo— es que esas cifras sean
// las que el MAYOR movió: un arnés que fabrica «IVA pagado: 80» sólo
// reproduce la resta que el código escribe.
//
// Aquí se siembra el gasto, se aprueba, se paga, y se compara la DIOT contra
// el movimiento real de la cuenta de IVA acreditable del periodo. Es el paso
// 6 de la lista de comprobación de la casa —«the total creditable IVA must
// match the IVA acreditable account movement; never "close enough"»— y es la
// única prueba que distingue una DIOT correcta de una bien formada.
//
// CADA ESCENARIO EN SU MES, a propósito: comparten inquilino y varias miden
// totales del periodo.
//
// Corre como superusuario y con la RLS inerte, como el resto de la suite: lo
// que se comprueba es la frontera del CÓDIGO.
// ============================================================

let f: Fixture;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

interface RenglonSembrado {
  importe: string;
  iva: string;
  tasa: string | null;
  tipoFactor?: 'tasa' | 'cuota' | 'exento';
  valorActos?: string | null;
}

interface ProveedorSembrado {
  rfc?: string | null;
  tipoTercero?: string | null;
  tipoOperacion?: string | null;
  idFiscalExtranjero?: string | null;
  paisResidencia?: string | null;
  nacionalidad?: string | null;
}

async function sembrarProveedor(
  entityId: string,
  userId: string,
  nombre: string,
  p: ProveedorSembrado = {}
): Promise<string> {
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
       currency_code, created_by, tipo_tercero, tipo_operacion,
       id_fiscal_extranjero, pais_residencia, nacionalidad)
     VALUES ($1,$2,$3,$4,$5,'rfc','MXN',$6,$7,$8,$9,$10,$11)`,
    [
      vendorId, entityId, `V-${vendorId.slice(0, 8)}`, nombre,
      p.rfc === undefined ? 'ABC010101AA1' : p.rfc,
      userId,
      p.tipoTercero ?? null, p.tipoOperacion ?? null,
      p.idFiscalExtranjero ?? null, p.paisResidencia ?? null, p.nacionalidad ?? null,
    ]
  );
  return vendorId;
}

/** Un gasto aprobado —o sea, con su pasivo y su IVA ya en el mayor—. */
async function sembrarGasto(
  fx: Fixture,
  vendorId: string,
  mes: number,
  metodo: 'PUE' | 'PPD',
  renglones: RenglonSembrado[],
  opciones: { cfdiUuid?: string; ivaRetenido?: string } = {}
): Promise<{ billId: string; numero: string; total: string; subtotal: string; iva: string }> {
  const subtotal = renglones.reduce((a, r) => a.plus(r.importe), new Decimal(0));
  const iva = renglones.reduce((a, r) => a.plus(r.iva), new Decimal(0));
  const total = subtotal.plus(iva);
  const billId = uuidv4();
  const marca = billId.slice(0, 8);
  const numero = `BILL-${marca}`;
  const fecha = fechaEnPeriodo(mes, 10);
  const cuentaGasto = await cuentaPorCodigo(fx.entityId, '6100');

  if (opciones.cfdiUuid) {
    await query(
      `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
         emisor_rfc, receptor_rfc, subtotal, total, moneda, total_iva_retenido,
         metodo_pago, xml_content, xml_hash, import_source, processing_status)
       VALUES ($1,'cfdi_ingreso',$2,'4.0',$3,'ABC010101AA1','XAXX010101000',$4,$5,'MXN',$6,
         $7,'<x/>',$8,'manual_upload','completed')`,
      [fx.entityId, opciones.cfdiUuid, fecha, subtotal.toFixed(2), total.toFixed(2),
       opciones.ivaRetenido ?? '0', metodo, opciones.cfdiUuid]
    );
  }

  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,$11,$12)`,
    [billId, fx.entityId, numero, vendorId, `CFDI-${marca}`,
     subtotal.toFixed(4), iva.toFixed(4), total.toFixed(4), fecha, fx.userId,
     metodo, opciones.cfdiUuid ?? null]
  );

  for (const [i, r] of renglones.entries()) {
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description,
         quantity, unit_price, line_amount, tax_amount, total_amount,
         tax_rate, tipo_factor, valor_actos)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), billId, i + 1, cuentaGasto, `Renglón ${i + 1}`,
       r.importe, r.iva, new Decimal(r.importe).plus(r.iva).toFixed(4),
       r.tasa, r.tipoFactor ?? 'tasa', r.valorActos ?? null]
    );
  }

  await approveBill(billId, fx.userId, { entityId: fx.entityId });
  return {
    billId, numero,
    total: total.toFixed(4),
    subtotal: subtotal.toFixed(4),
    iva: iva.toFixed(4),
  };
}

async function pagar(
  fx: Fixture,
  vendorId: string,
  billId: string,
  importe: string,
  mes: number,
  dia = 20
): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: fx.entityId,
      counterpartyId: vendorId,
      paymentAmount: importe,
      paymentDate: fechaEnPeriodo(mes, dia),
      paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: importe }],
    },
    fx.userId
  );
  return r.paymentId;
}

/**
 * Lo que el MAYOR movió a la cuenta de IVA acreditable en el mes.
 *
 * Se lee de las líneas de asiento y no de `account_balances`, porque lo que
 * la DIOT declara es el movimiento DEUDOR del periodo —el IVA que se hizo
 * acreditable— y no el saldo, que arrastra lo de meses anteriores.
 */
async function ivaAcreditableDelMes(entityId: string, mes: number): Promise<string> {
  const desde = `2026-${String(mes).padStart(2, '0')}-01`;
  const hasta = new Date(Date.UTC(2026, mes, 0)).toISOString().slice(0, 10);
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS s
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN account_roles ar ON ar.account_id = jel.account_id
                            AND ar.entity_id = $1 AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND ar.role = 'iva_acreditable'
        AND je.entry_date >= $2::date AND je.entry_date <= $3::date`,
    [entityId, desde, hasta]
  );
  return new Decimal(r.rows[0]?.s ?? '0').toFixed(4);
}

beforeAll(async () => {
  f = await crearInquilino('F07c DIOT');
  await seedPolicies({ tenantId: f.tenantId });
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('el hecho que se declara es el del mayor, no el devengo', () => {
  it('un PPD pagado a medias declara la mitad, y cuadra contra 1130', async () => {
    const mes = 3;
    const v = await sembrarProveedor(f.entityId, f.userId, 'Insumos del Norte SA', {
      rfc: 'IDN010101AA1', tipoTercero: '04', tipoOperacion: '03',
    });
    // 1 000 al 16 %, 500 al 0 % y 300 exento con su base declarada.
    const g = await sembrarGasto(f, v, mes, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
      { importe: '500.0000', iva: '0.0000', tasa: '0.00' },
      { importe: '300.0000', iva: '0.0000', tasa: null, tipoFactor: 'exento', valorActos: '300.0000' },
    ]);
    expect(g.total).toBe('1960.0000');

    await pagar(f, v, g.billId, '980.0000', mes);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes,
    });

    expect(diot.renglones).toHaveLength(1);
    const r = diot.renglones[0];
    expect(r.tercero).toMatchObject({ rfc: 'IDN010101AA1', tipoTercero: '04', tipoOperacion: '03' });
    // La mitad pagada: la mitad de cada base, y el IVA sólo en el 16 %.
    expect(r.desglose.tasa16).toEqual({ base: '500.0000', iva: '80.0000' });
    expect(r.desglose.tasa0).toEqual({ base: '250.0000', iva: '0.0000' });
    expect(r.desglose.exento).toEqual({ base: '150.0000', iva: '0.0000' });
    expect(r.documentos[0]).toMatchObject({ metodo: 'PPD', ivaPagado: '80.0000' });

    // EL AMARRE. Si esto falla, la declaración es bonita y falsa.
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, mes));
    expect(diot.totales.ivaAcreditablePagado).toBe('80.0000');
  }, 60_000);

  it('un PUE entra completo en el mes del gasto: su IVA fue directo a 1130', async () => {
    const mes = 4;
    const v = await sembrarProveedor(f.entityId, f.userId, 'Contado SA', {
      rfc: 'CON010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, mes, 'PUE', [
      { importe: '2000.0000', iva: '320.0000', tasa: '16.00' },
    ]);
    await pagar(f, v, g.billId, g.total, mes);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes,
    });
    expect(diot.renglones[0].desglose.tasa16).toEqual({ base: '2000.0000', iva: '320.0000' });
    expect(diot.renglones[0].documentos[0].metodo).toBe('PUE');
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, mes));
  }, 60_000);

  it('DOS pagos al mismo gasto en el mismo mes NO declaran el doble', async () => {
    // El mes se calcula como acumulado al cierre menos acumulado al cierre
    // del mes anterior, no sumando pagos: con dos parcialidades sobre el
    // mismo gasto, cualquier reparto que no telescope declara de más o de
    // menos, y el mayor —que es quien no miente— movió 160 y nada más.
    const mes = 5;
    const v = await sembrarProveedor(f.entityId, f.userId, 'Parcialidades SA', {
      rfc: 'PAR010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, mes, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    await pagar(f, v, g.billId, '580.0000', mes, 10);
    await pagar(f, v, g.billId, '580.0000', mes, 20);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes,
    });
    expect(diot.totales.ivaAcreditablePagado).toBe('160.0000');
    expect(diot.renglones[0].desglose.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, mes));
  }, 60_000);

  it('un gasto pagado en OTRO mes no entra: la DIOT es del mes en que se pagó', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Diferido SA', {
      rfc: 'DIF010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, 6, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    // El gasto es de junio; el pago, de julio.
    await pagar(f, v, g.billId, '1160.0000', 7);

    const junio = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 6 });
    const julio = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 7 });

    expect(junio.renglones.filter((r) => r.tercero.rfc === 'DIF010101AA1')).toHaveLength(0);
    expect(julio.renglones.find((r) => r.tercero.rfc === 'DIF010101AA1')?.desglose.tasa16)
      .toEqual({ base: '1000.0000', iva: '160.0000' });
  }, 60_000);
});

describe('lo que no tiene IVA también se declara', () => {
  it('un gasto ENTERAMENTE exento pagado en el mes entra con su base y cero impuesto', async () => {
    // Es la razón principal por la que este módulo no recorre los pagos
    // llamando a `ivaReclassificationsFor`: aquella función descarta todo
    // documento cuya liberación sea cero, así que este gasto no existiría
    // para la DIOT. Y la DIOT declara el VALOR DE LOS ACTOS, no sólo el
    // impuesto: dejarlo fuera subdeclara la actividad del periodo.
    const mes = 2;
    const v = await sembrarProveedor(f.entityId, f.userId, 'Colegio Exento AC', {
      rfc: 'EXE010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, mes, 'PPD', [
      { importe: '700.0000', iva: '0.0000', tasa: null, tipoFactor: 'exento', valorActos: '700.0000' },
    ]);
    await pagar(f, v, g.billId, '700.0000', mes);

    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    const r = diot.renglones.find((x) => x.tercero.rfc === 'EXE010101AA1');
    expect(r, 'el gasto exento tiene que aparecer').toBeDefined();
    expect(r?.desglose.exento).toEqual({ base: '700.0000', iva: '0.0000' });
    expect(diot.totales.ivaAcreditablePagado).toBe('0.0000');
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, mes));
  }, 60_000);
});

describe('el IVA retenido sale del CFDI y se prorratea igual que todo', () => {
  it('un gasto pagado a medias declara la mitad de la retención', async () => {
    const mes = 8;
    const uuid = uuidv4();
    const v = await sembrarProveedor(f.entityId, f.userId, 'Honorarios SC', {
      rfc: 'HON010101AA1', tipoTercero: '04', tipoOperacion: '03',
    });
    const g = await sembrarGasto(
      f, v, mes, 'PPD',
      [{ importe: '1000.0000', iva: '160.0000', tasa: '16.00' }],
      { cfdiUuid: uuid, ivaRetenido: '106.6700' }
    );
    await pagar(f, v, g.billId, '580.0000', mes);

    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    const r = diot.renglones.find((x) => x.tercero.rfc === 'HON010101AA1');
    expect(r?.ivaRetenido).toBe('53.3350');
    expect(diot.totales.ivaRetenido).toBe('53.3350');
  }, 60_000);
});

describe('diot_tercero_sin_rfc decide, y se nota contra la base', () => {
  const mes = 9;
  let vendorId: string;

  it('con «bloquear» (el defecto) se niega y NOMBRA al proveedor', async () => {
    vendorId = await sembrarProveedor(f.entityId, f.userId, 'Anónimo SA', {
      rfc: RFC_GENERICO_NACIONAL, tipoTercero: null, tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, vendorId, mes, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    await pagar(f, vendorId, g.billId, '1160.0000', mes);

    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    expect(esEntregable(diot)).toBe(false);
    const h = diot.hallazgos.find((x) => x.codigo === 'DIOT-SIN-RFC');
    expect(h?.mensaje).toContain('Anónimo SA');
    expect(h?.mensaje).toContain(RFC_GENERICO_NACIONAL);
    expect(diot.renglones.find((r) => r.tercero.vendorId === vendorId)).toBeUndefined();
    // El papel de trabajo SÍ se imprime: es lo que hace falta para arreglarlo.
    expect(PAPEL_DE_TRABAJO.serializar(diot)).toContain('DIOT-SIN-RFC');
  }, 60_000);

  it('contestada «declarar_global», el MISMO mes sale como tercero 15', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId }, 'diot_tercero_sin_rfc', 'declarar_global', f.userId,
      'la prueba lo contesta'
    );
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    const r = diot.renglones.find((x) => x.tercero.vendorId === vendorId);
    expect(r?.tercero.tipoTercero).toBe('15');
    expect(diot.politicas.find((p) => p.clave === 'diot_tercero_sin_rfc')).toMatchObject({
      valor: 'declarar_global', definida: true,
    });
    expect(esEntregable(diot)).toBe(true);
    await reopenPolicy({ tenantId: f.tenantId }, 'diot_tercero_sin_rfc');
  }, 60_000);
});

describe('diot_iva_exento_y_base decide, y se nota contra la base', () => {
  const mes = 10;
  let vendorId: string;

  it('con «exigir_base» (el defecto) se niega y nombra el documento', async () => {
    vendorId = await sembrarProveedor(f.entityId, f.userId, 'Colegiaturas SC', {
      rfc: 'COL010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    // Exento SIN valor_actos: exactamente el renglón que el parser tiraba.
    const g = await sembrarGasto(f, vendorId, mes, 'PPD', [
      { importe: '500.0000', iva: '0.0000', tasa: null, tipoFactor: 'exento', valorActos: null },
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    await pagar(f, vendorId, g.billId, g.total, mes);

    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    const h = diot.hallazgos.find((x) => x.codigo === 'DIOT-BASE-EXENTA-DESCONOCIDA');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.documentNumber).toBe(g.numero);
    expect(esEntregable(diot)).toBe(false);
  }, 60_000);

  it('contestada «derivar_del_subtotal», la base exenta aparece y sólo queda el aviso', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId }, 'diot_iva_exento_y_base', 'derivar_del_subtotal', f.userId,
      'la prueba lo contesta'
    );
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    const r = diot.renglones.find((x) => x.tercero.vendorId === vendorId);
    expect(r?.desglose.exento.base).toBe('500.0000');
    expect(diot.hallazgos.map((h) => h.codigo)).toContain('DIOT-BASE-EXENTA-DERIVADA');
    expect(esEntregable(diot)).toBe(true);
    await reopenPolicy({ tenantId: f.tenantId }, 'diot_iva_exento_y_base');
  }, 60_000);
});

describe('diot_tipo_operacion_por_omision decide, y se nota contra la base', () => {
  it('sin tipo capturado usa el 85 del catálogo y lista al proveedor', async () => {
    const mes = 11;
    const v = await sembrarProveedor(f.entityId, f.userId, 'Sin clasificar SA', {
      rfc: 'SIN010101AA1', tipoTercero: '04', tipoOperacion: null,
    });
    const g = await sembrarGasto(f, v, mes, 'PPD', [
      { importe: '100.0000', iva: '16.0000', tasa: '16.00' },
    ]);
    await pagar(f, v, g.billId, '116.0000', mes);

    const conOmision = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    expect(conOmision.renglones[0].tercero.tipoOperacion).toBe('85');
    expect(conOmision.renglones[0].tercero.procedencia.tipoOperacion).toBe('politica');
    expect(conOmision.hallazgos.map((h) => h.codigo)).toContain('DIOT-TIPO-OPERACION-POR-OMISION');

    await resolvePolicy(
      { tenantId: f.tenantId }, 'diot_tipo_operacion_por_omision', 'bloquear', f.userId, 'prueba'
    );
    const bloqueada = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    expect(esEntregable(bloqueada)).toBe(false);
    expect(bloqueada.renglones).toHaveLength(0);
    await reopenPolicy({ tenantId: f.tenantId }, 'diot_tipo_operacion_por_omision');
  }, 60_000);
});

describe('la frontera de entidad', () => {
  it('la DIOT de una entidad no lleva ni un peso de su hermana', async () => {
    const mes = 12;
    const hermana = await crearEntidadHermana(f, 'Hermana F07c');

    const vPropio = await sembrarProveedor(f.entityId, f.userId, 'Propio SA', {
      rfc: 'PRO010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const gPropio = await sembrarGasto(f, vPropio, mes, 'PPD', [
      { importe: '100.0000', iva: '16.0000', tasa: '16.00' },
    ]);
    await pagar(f, vPropio, gPropio.billId, '116.0000', mes);

    const vAjeno = await sembrarProveedor(hermana.entityId, hermana.userId, 'Ajeno SA', {
      rfc: 'AJE010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const gAjeno = await sembrarGasto(hermana, vAjeno, mes, 'PPD', [
      { importe: '9000.0000', iva: '1440.0000', tasa: '16.00' },
    ]);
    await pagar(hermana, vAjeno, gAjeno.billId, '10440.0000', mes);

    const mia = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes });
    expect(mia.renglones.map((r) => r.tercero.rfc)).toEqual(['PRO010101AA1']);
    expect(mia.totales.ivaAcreditablePagado).toBe('16.0000');

    const suya = await construirDiot({
      tenantId: hermana.tenantId, entityId: hermana.entityId, anio: 2026, mes,
    });
    expect(suya.renglones.map((r) => r.tercero.rfc)).toEqual(['AJE010101AA1']);
    expect(suya.totales.ivaAcreditablePagado).toBe('1440.0000');
  }, 90_000);

  it('con el inquilino equivocado responde 404, no la declaración de otro', async () => {
    // El defecto de gravedad 2 de F07b, en el sitio en que se ARCHIVA a
    // nombre de un contribuyente: aquí el WHERE lleva tenant_id.
    await expect(
      construirDiot({ tenantId: uuidv4(), entityId: f.entityId, anio: 2026, mes: 3 })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('una entidad que no causa IVA no tiene DIOT que armar', async () => {
    const gringa = await crearInquilino('F07c US', { pais: 'US' });
    await expect(
      construirDiot({ tenantId: gringa.tenantId, entityId: gringa.entityId, anio: 2026, mes: 3 })
    ).rejects.toBeInstanceOf(ValidationError);
  }, 120_000);
});

describe('la entrega', () => {
  it('el papel de trabajo sale, y el archivo del SAT se niega con la lista de lo que falta', async () => {
    const diot = await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 3 });
    expect(esEntregable(diot)).toBe(true);

    const papel = PAPEL_DE_TRABAJO.serializar(diot);
    expect(papel.split('\n')[0]).toContain('NO ES EL ARCHIVO DE LA DECLARACIÓN');
    expect(papel).toContain('IDN010101AA1');
    expect(papel).toContain('IVA acreditable pagado en el mes: 80.0000');

    expect(() => SERIALIZADOR_SAT.serializar(diot)).toThrow(DiotFormatoNoFundamentado);
  }, 60_000);

  it('el mes 13 de la balanza de cierre no existe aquí', async () => {
    await expect(
      construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: 13 })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
