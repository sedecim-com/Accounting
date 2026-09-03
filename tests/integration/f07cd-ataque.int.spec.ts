import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import {
  recordVendorPayment,
  recordCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { AccountingError } from '../../src/utils/errors.js';
import {
  construirDiot,
  esEntregable,
  PAPEL_DE_TRABAJO,
  RFC_GENERICO_NACIONAL,
} from '../../src/services/sat/diot/index.js';
import { generarPolizas, generarAuxiliar } from '../../src/services/sat/anexo24/polizas-service.js';
import {
  factorEntrePeriodos,
  importarSerie,
  resolverIndice,
} from '../../src/services/fiscal/inpc/inpc-service.js';
import { factorDeActualizacion } from '../../src/services/fiscal/inpc/factor.js';

// ============================================================
// F07c + F07d · VERIFICACIÓN ADVERSARIAL
//
// Lo que sale de estos dos tramos lo lee la autoridad fiscal. Las pruebas de
// los frentes demuestran que el camino feliz produce las cifras correctas;
// esto busca lo contrario: el dato que ENTRA en la base sin pasar por la
// puerta que lo validaría, y lo que el generador hace entonces.
//
// LA TESIS DE ESTE ARCHIVO, y es la que ordena los ataques: en este sistema
// hay dos clases de dato sucio y los dos módulos los tratan al revés.
//
//   · La DIOT trata el dato sucio como HALLAZGO: nombra al proveedor, sigue
//     y devuelve la lista entera. `vendors.tax_id` es VARCHAR(50) sin CHECK
//     —lo dice la cabecera de rfc.ts— así que ese es exactamente el caso que
//     tiene que aguantar, y lo aguanta.
//   · Las pólizas tratan varios de esos mismos datos como EXCEPCIÓN del
//     constructor, y el constructor no distingue «esta póliza» de «este
//     archivo»: una sola fila sucia mata la generación del mes entera con un
//     mensaje que nombra un atributo XML y no la póliza.
//
// Cada escenario vive en SU MES, y no por aseo: `voucher generate` produce un
// archivo por periodo, así que un dato envenenado en el mes 6 impediría medir
// cualquier otra cosa del mes 6.
//
// Corre como superusuario y con la RLS inerte, igual que el resto de la
// suite: lo que se comprueba es la frontera del CÓDIGO.
// ============================================================

let f: Fixture;
let hermana: Fixture;
let bancoId: string;

const CLABE = '012180001234567895';
const SOLICITUD = { tipo: 'AF' as const, numOrden: 'ATQ7654321/26' };

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
  tasa?: string | null;
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

/**
 * El proveedor se siembra con INSERT directo y no con `createVendor` A
 * PROPÓSITO, y conviene decir por qué: `createVendor` no admite ni una de las
 * cinco columnas que la 063 añadió (no aparecen en su INSERT), así que por
 * ese camino NO HAY forma de dar de alta un tercero extranjero. El INSERT
 * directo es además el camino que la cabecera de rfc.ts nombra como el que
 * mete RFC malformados: importación, ingesta y SQL directo.
 */
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

async function sembrarGasto(
  fx: Fixture,
  vendorId: string,
  mes: number,
  metodo: 'PUE' | 'PPD',
  renglones: RenglonSembrado[],
  opciones: { cfdiUuid?: string; ivaRetenido?: string; isrRetenido?: string } = {}
): Promise<{ billId: string; numero: string; total: string; iva: string }> {
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
         emisor_rfc, receptor_rfc, subtotal, total, moneda,
         total_iva_retenido, total_isr_retenido,
         metodo_pago, xml_content, xml_hash, import_source, processing_status)
       VALUES ($1,'cfdi_ingreso',$2,'4.0',$3,'ABC010101AA1','XAXX010101000',$4,$5,'MXN',$6,$7,
         $8,'<x/>',$9,'manual_upload','completed')`,
      [fx.entityId, opciones.cfdiUuid, fecha, subtotal.toFixed(2), total.toFixed(2),
       opciones.ivaRetenido ?? '0', opciones.isrRetenido ?? '0',
       metodo, opciones.cfdiUuid]
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
       r.tasa ?? null, r.tipoFactor ?? 'tasa', r.valorActos ?? null]
    );
  }

  await approveBill(billId, fx.userId, { entityId: fx.entityId });
  return { billId, numero, total: total.toFixed(4), iva: iva.toFixed(4) };
}

async function pagar(
  fx: Fixture,
  billId: string,
  importe: string,
  mes: number,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const r = await recordVendorPayment(
    {
      entityId: fx.entityId,
      paymentAmount: importe,
      paymentDate: fechaEnPeriodo(mes, 20),
      paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: importe }],
      ...extra,
    },
    fx.userId
  );
  return r.paymentId;
}

/** El movimiento DEUDOR de la cuenta con rol `iva_acreditable` en el mes. */
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

const periodoDe = (mes: number): string => `2026-${String(mes).padStart(2, '0')}`;

beforeAll(async () => {
  f = await crearInquilino('F07cd ataque');
  hermana = await crearEntidadHermana(f, 'F07cd hermana');
  await seedPolicies({ tenantId: f.tenantId });

  bancoId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Cuenta de cheques','BBVA México',$3,'MXN','012',$4,$5,true)`,
    [bancoId, f.entityId, await cuentaPorCodigo(f.entityId, '1120'), encrypt(CLABE), CLABE.slice(-4)]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

// ============================================================
// 1 · CONTRA LA DIOT · EL RFC QUE TIENE FORMA Y NO IDENTIFICA
// ============================================================

describe('el RFC del tercero: los tres casos que llegan hasta el archivo', () => {
  const MES = 2;

  it('el genérico, el malformado y el vacío se cazan LOS TRES y cada uno con su motivo', async () => {
    // Los tres entran por INSERT directo, que es como entran de verdad: la
    // validación de forma de `normalizeTaxId` sólo corre en el alta por
    // `vendor create`, y `vendors.tax_id` es VARCHAR(50) sin CHECK.
    const generico = await sembrarProveedor(f.entityId, f.userId, 'Público en General SA', {
      rfc: RFC_GENERICO_NACIONAL, tipoTercero: null, tipoOperacion: '85',
    });
    const malformado = await sembrarProveedor(f.entityId, f.userId, 'Tecleado a Mano SA', {
      // 11 caracteres: un dígito de menos. Pasa cualquier NOT NULL y ningún
      // CFDI casará nunca con él.
      rfc: 'TAM01010AA', tipoTercero: null, tipoOperacion: '85',
    });
    const vacio = await sembrarProveedor(f.entityId, f.userId, 'Sin Expediente SA', {
      rfc: null, tipoTercero: null, tipoOperacion: '85',
    });
    // Y un cuarto con fecha imposible dentro del patrón: 13 como mes.
    const fechaImposible = await sembrarProveedor(f.entityId, f.userId, 'Mes Trece SA', {
      rfc: 'MTR011301AA1', tipoTercero: null, tipoOperacion: '85',
    });

    for (const v of [generico, malformado, vacio, fechaImposible]) {
      const g = await sembrarGasto(f, v, MES, 'PPD', [
        { importe: '100.0000', iva: '16.0000', tasa: '16.00' },
      ]);
      await pagar(f, g.billId, '116.0000', MES);
    }

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });

    const sinRfc = diot.hallazgos.filter((h) => h.codigo === 'DIOT-SIN-RFC');
    expect(sinRfc, 'los CUATRO se nombran, no sólo el vacío').toHaveLength(4);
    expect(esEntregable(diot)).toBe(false);
    expect(diot.renglones).toHaveLength(0);

    // Cada motivo dice QUÉ le pasa a ESE proveedor. Un solo mensaje genérico
    // obligaría a adivinar cuál de los cuatro es cuál.
    const porProveedor = new Map(sinRfc.map((h) => [h.vendorId, h.mensaje]));
    expect(porProveedor.get(generico)).toContain('público en general');
    expect(porProveedor.get(generico)).toContain(RFC_GENERICO_NACIONAL);
    expect(porProveedor.get(malformado)).toContain('no tiene forma de RFC mexicano');
    expect(porProveedor.get(vacio)).toContain('no tiene RFC en el expediente');
    expect(porProveedor.get(fechaImposible)).toContain('no existe');

    // El aviso plural es la promesa de la política: se nombran TODOS en una
    // sola corrida. Lanzar al primero costaría cuatro vueltas.
    const papel = PAPEL_DE_TRABAJO.serializar(diot);
    for (const nombre of ['Público en General SA', 'Tecleado a Mano SA', 'Sin Expediente SA']) {
      expect(papel).toContain(nombre);
    }
  }, 120_000);

  it('el RFC del CONTRIBUYENTE que declara no se clasifica: sólo se comprueba que no esté vacío', async () => {
    // El fixture da de alta la entidad con tax_id = XAXX010101000, que es el
    // RFC del público en general. `clasificarRfc` existe y NO se aplica al
    // declarante: `contribuyente()` (diot-service.ts:96) sólo rechaza la
    // cadena vacía. La DIOT se arma a nombre de un RFC que no identifica a
    // nadie y ni un hallazgo lo dice.
    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    expect(diot.rfc).toBe(RFC_GENERICO_NACIONAL);
    const sobreElDeclarante = diot.hallazgos.filter(
      (h) => h.vendorId === undefined && h.documentId === undefined && /RFC/.test(h.mensaje)
    );
    expect(
      sobreElDeclarante,
      'HALLAZGO: el declarante puede llevar el genérico y nada lo denuncia'
    ).toHaveLength(0);
    expect(PAPEL_DE_TRABAJO.serializar(diot)).toContain(`Contribuyente: ${RFC_GENERICO_NACIONAL}`);
  }, 60_000);
});

// ============================================================
// 2 · CONTRA LA DIOT · EL TERCERO EXTRANJERO
// ============================================================

describe('el tercero extranjero (05) y sus tres datos', () => {
  const MES = 11;

  it('el CHECK de la 063 lo impide en la tabla, y el error que llega arriba NO es legible', async () => {
    // El CHECK `tercero_extranjero_identificado` exige id fiscal y país. El
    // INSERT es el que hacen la importación y la ingesta; no hay puerta de
    // servicio que lo preceda, porque `createVendor` ni siquiera acepta estas
    // columnas.
    let err: unknown;
    try {
      await sembrarProveedor(f.entityId, f.userId, 'Foreign Supplier LLC', {
        rfc: null, tipoTercero: '05', tipoOperacion: '85',
      });
    } catch (e) {
      err = e;
    }
    expect(err, 'el CHECK tiene que impedirlo').toBeDefined();
    const mensaje = (err as Error).message;
    // Lo que llega arriba es el texto crudo de Postgres, en inglés y con el
    // nombre de la restricción. No dice qué falta ni cómo arreglarlo.
    expect(mensaje).toMatch(/violates check constraint/i);
    expect(mensaje).toContain('tercero_extranjero_identificado');
    expect(
      mensaje,
      'HALLAZGO: el mensaje no nombra los datos que faltan ni está en español'
    ).not.toMatch(/identificación fiscal/i);
  });

  it('el CHECK deja pasar el 05 SIN NACIONALIDAD; quien lo caza es el generador, y lo dice bien', async () => {
    // El CHECK exige DOS de los tres (id fiscal y país). La nacionalidad
    // queda fuera de la restricción aunque el formato pida los tres, así que
    // la fila entra en la tabla y el hueco no aparece hasta que alguien pide
    // la DIOT — que es exactamente lo que la 063 dice querer evitar.
    const v = await sembrarProveedor(f.entityId, f.userId, 'Servicios Transfronterizos LLC', {
      rfc: null, tipoTercero: '05', tipoOperacion: '85',
      idFiscalExtranjero: '98-7654321', paisResidencia: 'USA', nacionalidad: null,
    });
    const g = await sembrarGasto(f, v, MES, 'PPD', [
      { importe: '1000.0000', iva: '0.0000', tasa: '0.00' },
    ]);
    await pagar(f, g.billId, '1000.0000', MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const h = diot.hallazgos.find((x) => x.codigo === 'DIOT-EXTRANJERO-INCOMPLETO');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.mensaje).toContain('Servicios Transfronterizos LLC');
    expect(h?.mensaje).toContain('nacionalidad');
    expect(esEntregable(diot)).toBe(false);
  }, 60_000);

  it('completo, el extranjero se declara por su identificación fiscal y NO por RFC', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Complete Foreign Co', {
      rfc: null, tipoTercero: '05', tipoOperacion: '85',
      idFiscalExtranjero: '12-3456789', paisResidencia: 'USA', nacionalidad: 'Estadounidense',
    });
    const g = await sembrarGasto(f, v, MES, 'PPD', [
      { importe: '500.0000', iva: '0.0000', tasa: '0.00' },
    ]);
    await pagar(f, g.billId, '500.0000', MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const r = diot.renglones.find((x) => x.tercero.vendorId === v);
    expect(r?.tercero.tipoTercero).toBe('05');
    expect(r?.tercero.rfc, 'un 05 no lleva RFC: lo identifica su número fiscal').toBeUndefined();
    expect(r?.tercero.idFiscalExtranjero).toBe('12-3456789');
    expect(r?.tercero.nacionalidad).toBe('Estadounidense');
  }, 60_000);
});

// ============================================================
// 3 · CONTRA LA DIOT · 16 %, 0 % Y EXENTO SON TRES RENGLONES
// ============================================================

describe('el desglose por tasa: el 0 % y lo exento no comparten casilla', () => {
  const MES = 3;

  it('un gasto con 16 %, 0 % y exento reparte en tres casillas y ninguna se pliega al 16 %', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Mixto SA', {
      rfc: 'MIX010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, MES, 'PUE', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
      { importe: '400.0000', iva: '0.0000', tasa: '0.00' },
      { importe: '600.0000', iva: '0.0000', tipoFactor: 'exento', valorActos: '600.0000' },
      // La región fronteriza, que es la trampa que la cabecera de desglose.ts
      // nombra: 8 % NO es 16 % y no se le suma.
      { importe: '200.0000', iva: '16.0000', tasa: '8.00' },
      // Y una tasa histórica que el catálogo del formato no nombra.
      { importe: '100.0000', iva: '11.0000', tasa: '11.00' },
    ]);
    await pagar(f, g.billId, g.total, MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const r = diot.renglones.find((x) => x.tercero.vendorId === v);
    expect(r, 'el gasto tiene que estar').toBeDefined();

    expect(r!.desglose.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(r!.desglose.tasa8).toEqual({ base: '200.0000', iva: '16.0000' });
    // LA COMPROBACIÓN QUE IMPORTA: las dos casillas de impuesto CERO llevan
    // bases DISTINTAS y no una suma de 1000. Si acabaran juntas, el
    // desglose mentiría exactamente donde la 063 vino a arreglarlo.
    expect(r!.desglose.tasa0).toEqual({ base: '400.0000', iva: '0.0000' });
    expect(r!.desglose.exento).toEqual({ base: '600.0000', iva: '0.0000' });
    expect(r!.desglose.tasa0.base).not.toBe(r!.desglose.exento.base);

    const otras = r!.desglose.otras;
    expect(otras).toHaveLength(1);
    expect(otras[0]).toEqual({ etiqueta: '11.00', base: '100.0000', iva: '11.0000' });
    expect(diot.hallazgos.map((h) => h.codigo)).toContain('DIOT-TASA-FUERA-DE-CATALOGO');

    // Y la suma de las cinco casillas es EXACTAMENTE lo que el mayor movió.
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, MES));
    expect(diot.totales.ivaAcreditablePagado).toBe('187.0000');
  }, 90_000);

  it('un renglón EXENTO con impuesto encima se bloquea: una exención no traslada IVA', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Exento con IVA SA', {
      rfc: 'ECI010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, MES, 'PUE', [
      { importe: '100.0000', iva: '16.0000', tipoFactor: 'exento', valorActos: '100.0000' },
    ]);
    await pagar(f, g.billId, g.total, MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const h = diot.hallazgos.find((x) => x.codigo === 'DIOT-EXENTO-CON-IVA');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.documentNumber).toBe(g.numero);
  }, 60_000);

  it('LA COLUMNA QUE NADIE ESCRIBE: sin `tipo_factor`, un gasto exento se declara al 0 %', async () => {
    // Ni `bill-service.ts` ni `pre-registration-service.ts` (la ingesta de
    // CFDI, que es de donde salen los gastos de verdad) escriben `tax_rate`,
    // `tipo_factor` ni `valor_actos`: sus dos INSERT en `bill_lines` no
    // nombran ninguna de las tres. Con el DEFAULT 'tasa' de la 063, un
    // renglón EXENTO ingerido de un CFDI real es indistinguible de uno al
    // 0 % — que es la asimetría exacta que la 063 vino a cerrar.
    const v = await sembrarProveedor(f.entityId, f.userId, 'Como Lo Ingiere El CFDI SA', {
      rfc: 'CIC010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, MES, 'PUE', [
      // Exactamente lo que la ingesta escribe hoy: importe, impuesto y nada más.
      { importe: '700.0000', iva: '0.0000', tasa: null, tipoFactor: undefined, valorActos: null },
    ]);
    await pagar(f, g.billId, g.total, MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const r = diot.renglones.find((x) => x.tercero.vendorId === v);
    expect(r!.desglose.tasa0).toEqual({ base: '700.0000', iva: '0.0000' });
    expect(
      r!.desglose.exento,
      'HALLAZGO: el gasto exento acaba en la casilla del 0 % y la declaración no lo dice'
    ).toEqual({ base: '0.0000', iva: '0.0000' });
    // Y no hay ni un aviso: `DIOT-TASA-MEDIDA` sólo sale con impuesto distinto
    // de cero, así que el renglón que la 063 vino a rescatar pasa mudo.
    const avisos = diot.hallazgos.filter(
      (h) => h.documentNumber === g.numero && h.codigo === 'DIOT-TASA-MEDIDA'
    );
    expect(avisos).toHaveLength(0);
  }, 60_000);
});

// ============================================================
// 4 · CONTRA LA DIOT · EL IVA RETENIDO Y DÓNDE ACABA
// ============================================================

describe('el IVA retenido: la DIOT lo separa y el mayor no', () => {
  const MES = 4;

  it('la retención sale del CFDI, se prorratea, y NO se puede cotejar contra el mayor', async () => {
    const uuid = uuidv4();
    const v = await sembrarProveedor(f.entityId, f.userId, 'Honorarios Retenidos SC', {
      rfc: 'HRE010101AA1', tipoTercero: '04', tipoOperacion: '03',
    });
    const g = await sembrarGasto(
      f, v, MES, 'PPD',
      [{ importe: '1000.0000', iva: '160.0000', tasa: '16.00' }],
      { cfdiUuid: uuid, ivaRetenido: '106.6700', isrRetenido: '100.0000' }
    );
    await pagar(f, g.billId, '580.0000', MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const r = diot.renglones.find((x) => x.tercero.vendorId === v);
    // La mitad del documento pagada ⇒ la mitad de la retención declarada, y
    // la del ISR NO se cuela: la consulta lee `total_iva_retenido` y no la
    // suma de retenciones.
    expect(r!.ivaRetenido).toBe('53.3350');

    // AHORA EL AMARRE QUE NO EXISTE. Las dos retenciones comparten cuenta:
    // `account-roles-seed.ts:261-262` mapea `isr_retenido_por_pagar` Y
    // `iva_retenido_por_pagar` a la MISMA 2140 (y `isr_nomina_por_pagar`
    // también, :273). En el mayor son el mismo saldo.
    const cuentas = await query<{ role: string; code: string }>(
      `SELECT ar.role, a.code FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
        WHERE ar.entity_id = $1 AND ar.qualifier IS NULL
          AND ar.role IN ('iva_retenido_por_pagar','isr_retenido_por_pagar','isr_nomina_por_pagar')
        ORDER BY ar.role`,
      [f.entityId]
    );
    const codigos = new Set(cuentas.rows.map((x) => x.code));
    expect(cuentas.rows.length).toBeGreaterThanOrEqual(2);
    expect(
      codigos.size,
      'HALLAZGO: las retenciones de IVA e ISR comparten cuenta, así que la cifra ' +
        'de IVA retenido de la DIOT no tiene contra qué cotejarse en el mayor'
    ).toBe(1);
    expect([...codigos][0]).toBe('2140');
  }, 60_000);
});

// ============================================================
// 5 · CONTRA LA DIOT · LA SUMA CONTRA EL MAYOR
// ============================================================

describe('la suma: el IVA declarado contra el que el mayor dice que se pagó', () => {
  const MES = 5;

  it('con un tercero BLOQUEADO el total declarado es MENOR que el del mayor, y el papel no lo cifra', async () => {
    const bueno = await sembrarProveedor(f.entityId, f.userId, 'Declarable SA', {
      rfc: 'DEC010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const roto = await sembrarProveedor(f.entityId, f.userId, 'No Declarable SA', {
      rfc: null, tipoTercero: null, tipoOperacion: '85',
    });
    const gB = await sembrarGasto(f, bueno, MES, 'PUE', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    await pagar(f, gB.billId, gB.total, MES);
    const gR = await sembrarGasto(f, roto, MES, 'PUE', [
      { importe: '2000.0000', iva: '320.0000', tasa: '16.00' },
    ]);
    await pagar(f, gR.billId, gR.total, MES);

    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const mayor = await ivaAcreditableDelMes(f.entityId, MES);

    expect(mayor).toBe('480.0000');
    // El total sólo suma los terceros DECLARABLES; el bloqueado desaparece de
    // la cifra. Es coherente —no se entrega— pero la diferencia contra el
    // mayor es de 320 pesos y el papel de trabajo imprime las dos cosas sin
    // decir que no cuadran.
    expect(diot.totales.ivaAcreditablePagado).toBe('160.0000');
    expect(esEntregable(diot)).toBe(false);

    const papel = PAPEL_DE_TRABAJO.serializar(diot);
    expect(papel).toContain('IVA acreditable pagado en el mes: 160.0000');
    expect(papel).toContain('debe cuadrar contra el movimiento de iva_acreditable');
    expect(
      papel,
      'HALLAZGO: el papel promete el amarre, imprime la cifra corta y no dice cuánto falta'
    ).not.toContain('480.0000');
  }, 90_000);

  it('resuelto el RFC, el total vuelve a ser EXACTAMENTE el del mayor', async () => {
    await query(
      `UPDATE vendors SET tax_id = 'NDE010101AA1'
        WHERE entity_id = $1 AND company_name = 'No Declarable SA'`,
      [f.entityId]
    );
    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    expect(esEntregable(diot)).toBe(true);
    expect(diot.totales.ivaAcreditablePagado).toBe(await ivaAcreditableDelMes(f.entityId, MES));
    expect(diot.totales.ivaAcreditablePagado).toBe('480.0000');
  }, 60_000);
});

// ============================================================
// 6 · CONTRA LA DIOT · LA FRONTERA DE ENTIDAD, POR LA TABLA PUENTE
// ============================================================

describe('la frontera de entidad en la tabla puente', () => {
  const MES = 12;

  it('un pago de la HERMANA aplicado a MI gasto no entra en ninguna de las dos DIOT', async () => {
    // `payment_applications` no tiene entity_id: la frontera tiene que venir
    // de sus dos extremos. Este es el cruce que sólo se puede fabricar con
    // SQL directo, y es el que decidiría a nombre de quién se declara.
    const vPropio = await sembrarProveedor(f.entityId, f.userId, 'Propio Puente SA', {
      rfc: 'PPU010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const gPropio = await sembrarGasto(f, vPropio, MES, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);

    // Un pago de la hermana, posteado, aplicado al gasto de la otra entidad.
    const vAjeno = await sembrarProveedor(hermana.entityId, hermana.userId, 'Ajeno Puente SA', {
      rfc: 'APU010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const gAjeno = await sembrarGasto(hermana, vAjeno, MES, 'PPD', [
      { importe: '10.0000', iva: '1.6000', tasa: '16.00' },
    ]);
    const pagoAjeno = await pagar(hermana, gAjeno.billId, '11.6000', MES);
    await query(
      `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
       VALUES ($1,$2,$3,$4,0)`,
      [uuidv4(), pagoAjeno, gPropio.billId, '1160.0000']
    );

    const mia = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const suya = await construirDiot({
      tenantId: hermana.tenantId, entityId: hermana.entityId, anio: 2026, mes: MES,
    });

    // Ni el gasto propio se declara pagado (el pago es de otra entidad), ni
    // el gasto ajeno arrastra el mío.
    expect(mia.renglones.map((r) => r.tercero.rfc)).not.toContain('PPU010101AA1');
    expect(suya.renglones.map((r) => r.tercero.rfc)).toEqual(['APU010101AA1']);
    expect(suya.totales.ivaAcreditablePagado).toBe('1.6000');
    expect(suya.totales.ivaAcreditablePagado).toBe(
      await ivaAcreditableDelMes(hermana.entityId, MES)
    );
  }, 120_000);
});

// ============================================================
// 7 · CONTRA LAS PÓLIZAS · UN DATO SUCIO Y EL ARCHIVO ENTERO
// ============================================================

describe('el nombre del beneficiario, que nadie limpiaba', () => {
  const MES = 6;

  it('un salto de línea en el nombre del proveedor se limpia y se denuncia, ya no mata el mes', async () => {
    // `generarPolizas` limpia `DesCta` y `Concepto` con `limpiar()` y lo
    // denuncia — la lección de F07b, aplicada. `Benef` sale CRUDO de
    // `vendors.company_name` (polizas-service.ts:412), que es texto libre de
    // 255 caracteres del mismo origen que el nombre de cuenta: un catálogo de
    // proveedores importado de Excel.
    const v = await sembrarProveedor(f.entityId, f.userId, 'Aceros del Bajío\nSA de CV', {
      rfc: 'ADB010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, MES, 'PPD', [
      { importe: '1000.0000', iva: '160.0000', tasa: '16.00' },
    ]);
    await pagar(f, g.billId, '1160.0000', MES, {
      bankAccountId: bancoId,
      cuentaDestino: '002180009876543210',
      bancoDestinoSat: '002',
    });

    // ARREGLADO (gravedad 2). Antes: `exigirValorDeAtributo` lanzaba y se
    // llevaba por delante la generación del mes entera, con un mensaje que
    // nombraba `@Benef` y ni la póliza ni al proveedor — o sea, el comando
    // cuyo producto es la lista de lo que falta no dejaba lista ninguna.
    // Ahora `Benef` pasa por el MISMO saneador que `DesCta` y `Concepto`.
    const r = await generarPolizas(f.entityId, {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
    });
    expect(r.xml).toContain('Benef="Aceros del Bajío SA de CV"');

    // Y limpiar no es callar: el cambio sale con el número de póliza encima.
    const aviso = r.hallazgos.find(
      (h) => h.check === 'texto-normalizado' && h.detalle.includes('Benef del pago')
    );
    expect(aviso, 'el texto que se cambió se denuncia').toBeDefined();
    expect(aviso!.severity).toBe('warning');
    expect(aviso!.referencia).toMatch(/\S/);
    expect(r.xml).toContain(`NumUnIdenPol="${aviso!.referencia}"`);

    // El contraste que motivó el arreglo: la DIOT del mismo mes y el mismo
    // proveedor SIEMPRE salió, porque su serializador sanea en vez de rechazar.
    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    expect(PAPEL_DE_TRABAJO.serializar(diot)).toContain('Aceros del Bajío SA de CV');
  }, 90_000);
});

describe('el RFC del proveedor, que las pólizas validan en un nodo y no en el otro', () => {
  const MES = 7;

  it('un RFC malformado deja la póliza sin comprobante y sin rastro, nombrada, en vez de tirar el archivo', async () => {
    // El mismo dato que la DIOT clasifica y nombra. Aquí:
    //   · `nodoDeComprobante` exige RFC_RE y LANZA (polizas-xml.ts:340);
    //   · `nodoDePago` emite @RFC sin comprobar nada.
    const uuid = uuidv4();
    const v = await sembrarProveedor(f.entityId, f.userId, 'RFC Corto SA', {
      rfc: 'RCO01010AA', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(
      f, v, MES, 'PPD',
      [{ importe: '1000.0000', iva: '160.0000', tasa: '16.00' }],
      { cfdiUuid: uuid }
    );
    await pagar(f, g.billId, '1160.0000', MES, {
      bankAccountId: bancoId,
      cuentaDestino: '002180009876543210',
      bancoDestinoSat: '002',
    });

    // ARREGLADO (gravedad 2). Antes: `nodoDeComprobante` exigía el patrón y
    // LANZABA, así que el RFC de UN proveedor mataba el archivo del mes.
    const r = await generarPolizas(f.entityId, {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
    });

    // El comprobante NO viaja —no puede: el nodo sería inválido— y la póliza
    // que lo perdió sale nombrada, con el RFC culpable dentro del aviso.
    expect(r.xml).not.toContain(uuid);
    const sinComp = r.hallazgos.filter((h) => h.check === 'comprobante-sin-rfc-usable');
    expect(sinComp.length).toBeGreaterThan(0);
    expect(sinComp[0].severity).toBe('warning');
    expect(sinComp.some((h) => h.detalle.includes('RCO01010AA'))).toBe(true);
    expect(sinComp.some((h) => h.detalle.includes(uuid))).toBe(true);
    for (const h of sinComp) expect(r.xml).toContain(`NumUnIdenPol="${h.referencia}"`);

    // Y el MISMO RFC tampoco se cuela por el nodo de pago, que antes lo emitía
    // sin mirarlo: ahora la póliza aparece como «mueve dinero y no lleva
    // rastro», con el motivo, en vez de declarar un RFC que no cruza con nada.
    expect(r.xml).not.toContain('RFC="RCO01010AA"');
    const sinRastro = r.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro');
    expect(sinRastro.some((h) => h.detalle.includes('no tiene forma de RFC'))).toBe(true);

    // La DIOT del mismo mes lo caza y lo nombra igual, que es de donde salió
    // el criterio.
    const diot = await construirDiot({
      tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MES,
    });
    const h = diot.hallazgos.find(
      (x) => x.codigo === 'DIOT-SIN-RFC' && x.mensaje.includes('RFC Corto SA')
    );
    expect(h?.mensaje).toContain('no tiene forma de RFC mexicano');
  }, 90_000);
});

describe('el banco de destino de un COBRO', () => {
  const MES = 9;

  it('un banco destino EXTRANJERO ya no choca con el relleno del nuestro', async () => {
    // El CHECK de la 064 impide la clave nacional Y el nombre extranjero EN LA
    // MISMA FILA, y `assertRastroDePago` lo repite con mensaje. Lo que ninguno
    // de los dos ve es que en un COBRO el generador RELLENA el banco destino
    // nacional con el nuestro cuando no viene capturado
    // (polizas-service.ts:493-497) y deja el extranjero capturado en su sitio:
    // los dos atributos salen a la vez y `exigirBancoUnico` lanza.
    const clienteId = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1,$2,$3,'Cliente del Exterior SA','MXN',$4)`,
      [clienteId, f.entityId, `C-${clienteId.slice(0, 8)}`, f.userId]
    );
    const draft = await createInvoice({
      entity_id: f.entityId,
      customer_id: clienteId,
      invoice_date: fechaEnPeriodo(MES, 5).toISOString().slice(0, 10),
      due_date: fechaEnPeriodo(MES, 5).toISOString().slice(0, 10),
      currency_code: 'MXN',
      lines: [
        {
          revenue_account_id: await cuentaPorCodigo(f.entityId, '4100'),
          description: 'Servicio',
          quantity: '1',
          unit_price: '1000.00',
          tax_rate: '16.0000',
        },
      ],
      created_by: f.userId,
    });
    const emitida = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });

    // La fila pasa el CHECK: sólo lleva el banco EXTRANJERO.
    await recordCustomerPayment(
      {
        entityId: f.entityId,
        paymentAmount: '1160.00',
        paymentDate: fechaEnPeriodo(MES, 20),
        paymentMethod: 'spei',
        bankAccountId: bancoId,
        cuentaDestino: 'GB29NWBK60161331926819',
        bancoDestinoExtranjero: 'Bank of Nowhere',
        applications: [{ documentId: emitida.invoice.id, amountApplied: '1160.00' }],
      },
      f.userId
    );

    // ARREGLADO (gravedad 2). Antes el relleno del banco NUESTRO convivía con
    // el extranjero capturado y `exigirBancoUnico` lanzaba: el archivo del mes
    // entero moría por un cobro. El CHECK de la 064 no lo veía porque en la
    // FILA sólo hay uno de los dos; los dos se juntaban en el generador.
    const r = await generarPolizas(f.entityId, {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
    });

    // Manda lo CAPTURADO: el banco destino que se declaró es el extranjero, y
    // el nuestro no se le añade encima.
    expect(r.xml).toContain('BancoDestExt="Bank of Nowhere"');
    const transferencia = r.xml
      .split('\n')
      .find((l) => l.includes('BancoDestExt="Bank of Nowhere"'));
    expect(transferencia).toBeDefined();
    expect(transferencia, 'nacional y extranjero no conviven').not.toContain('BancoDestNal=');
    expect(r.xml).toContain('CtaDest="GB29NWBK60161331926819"');

    // Y el auxiliar de cuentas del mismo mes, que no toca nodos de pago, sale
    // igual: la prueba de que el dato que mataba no era el de los libros.
    const aux = await generarAuxiliar(f.entityId, 'accounts', {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
    });
    expect(aux.xml).toContain('<AuxiliarCtas:AuxiliarCtas');
  }, 120_000);
});

// ============================================================
// 8 · CONTRA LAS PÓLIZAS · LO QUE SÍ AGUANTA
// ============================================================

describe('el cheque, el rastro y el constructor único', () => {
  const MES = 10;

  it('el número de cheque llega al XML, y el mismo escapado rige en pólizas y en auxiliar', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Aceros & Cía "El Yunque"', {
      rfc: 'AYU010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const uuid = uuidv4();
    const g = await sembrarGasto(
      f, v, MES, 'PPD',
      [{ importe: '1000.0000', iva: '160.0000', tasa: '16.00' }],
      { cfdiUuid: uuid }
    );
    await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '1160.0000',
        paymentDate: fechaEnPeriodo(MES, 20),
        paymentMethod: 'check',
        bankAccountId: bancoId,
        checkNumber: '77123',
        applications: [{ documentId: g.billId, amountApplied: '1160.0000' }],
      },
      f.userId
    );

    const r = await generarPolizas(f.entityId, { periodo: periodoDe(MES), solicitud: SOLICITUD });
    expect(r.xml).toContain('Num="77123"');
    expect(r.xml).toContain(`CtaOri="${CLABE}"`);
    // El escapado es ESTRUCTURAL y por tanto idéntico en los dos archivos: es
    // la prueba de que hay UN constructor y no dos. Con dos, el `&` y la
    // comilla se arreglarían en uno y no en el otro.
    const esperado = 'Aceros &amp; Cía &quot;El Yunque&quot;';
    expect(r.xml).toContain(esperado);
    const aux = await generarAuxiliar(f.entityId, 'folios', {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
    });
    expect(aux.xml).toContain(uuid);
    expect(aux.xml).toContain('TipoSolicitud="AF"');
  }, 90_000);

  it('una póliza que mueve dinero sin rastro se denuncia CON SU NÚMERO y no se archiva', async () => {
    const v = await sembrarProveedor(f.entityId, f.userId, 'Sin Rastro SA', {
      rfc: 'SRA010101AA1', tipoTercero: '04', tipoOperacion: '85',
    });
    const g = await sembrarGasto(f, v, MES, 'PPD', [
      { importe: '100.0000', iva: '16.0000', tasa: '16.00' },
    ]);
    // Transferencia sin cuenta destino: el pago ocurrió; la póliza queda coja.
    const pago = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '116.0000',
        paymentDate: fechaEnPeriodo(MES, 21),
        paymentMethod: 'spei',
        bankAccountId: bancoId,
        applications: [{ documentId: g.billId, amountApplied: '116.0000' }],
      },
      f.userId
    );
    const numero = pago.journalEntry?.entry_number;

    const r = await generarPolizas(f.entityId, {
      periodo: periodoDe(MES),
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    const sinRastro = r.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro');
    expect(sinRastro.map((h) => h.referencia)).toContain(numero);
    expect(r.puedeEntregarse).toBe(false);
    expect(r.artefacto, 'lo que no se entrega no se archiva').toBeNull();
    // El XML se construye igual: la lista es el producto, no el error.
    expect(r.xml).toContain('<PLZ:Polizas');
  }, 90_000);
});

// ============================================================
// 9 · CONTRA EL INPC
// ============================================================

describe('el factor de actualización y la trampa de las bases', () => {
  const BASE_2018 = '2018-Jul2=100';
  const BASE_2010 = '2010=100';

  beforeAll(async () => {
    // La serie de verdad, en su base vigente.
    await importarSerie({
      fuente: 'dof',
      capturadoPor: f.userId,
      filas: [
        { periodo: { anio: 2023, mes: 1 }, valor: '125.564', base: BASE_2018, publicadoEl: '2023-02-10', linea: 1 },
        { periodo: { anio: 2023, mes: 12 }, valor: '132.373', base: BASE_2018, publicadoEl: '2024-01-10', linea: 2 },
        { periodo: { anio: 2024, mes: 6 }, valor: '135.317', base: BASE_2018, publicadoEl: '2024-07-10', linea: 3 },
      ],
    });
    // Y el mismo diciembre republicado en la base VIEJA: es lo que pasa de
    // verdad cuando el INEGI rebasa y alguien carga los dos archivos.
    await importarSerie({
      fuente: 'inegi',
      capturadoPor: f.userId,
      filas: [
        { periodo: { anio: 2022, mes: 12 }, valor: '108.400', base: BASE_2010, publicadoEl: '2023-01-10', linea: 1 },
      ],
    });
  }, 60_000);

  it('dos índices de BASES DISTINTAS: el factor se NIEGA en vez de dar un número plausible', async () => {
    // Sin la guarda, 132.373 / 108.400 = 1.2212, que es perfectamente
    // creíble y no significa nada.
    const plausible = new Decimal('132.373').dividedBy('108.400').toFixed(4);
    expect(plausible).toBe('1.2212');

    let err: unknown;
    try {
      await factorEntrePeriodos({ anio: 2022, mes: 12 }, { anio: 2023, mes: 12 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).code).toBe('INPC_BASES_DISTINTAS');
    expect((err as Error).message).toContain(BASE_2010);
    expect((err as Error).message).toContain(BASE_2018);
    // Y el número plausible no aparece por ningún lado del mensaje.
    expect((err as Error).message).not.toContain('1.2212');
  });

  it('un periodo SIN índice falla cerrado nombrando el mes, y no arrastra el anterior', async () => {
    let err: unknown;
    try {
      await factorEntrePeriodos({ anio: 2023, mes: 1 }, { anio: 2024, mes: 7 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).code).toBe('INPC_SIN_INDICE');
    expect((err as Error).message).toContain('julio de 2024');
    // Junio SÍ está cargado y no se usa en su lugar: eso daría 1.0000 sobre
    // sí mismo o un factor de otro mes, indistinguible de uno legítimo.
    const junio = await resolverIndice({ anio: 2024, mes: 6 });
    expect(junio.valor).toContain('135.317');
    expect((err as Error).message).not.toContain('135.317');
  });

  it('el factor coincide con el cálculo de la LISR hecho a mano', async () => {
    // LISR art. 6 fr. II: índice del mes MÁS RECIENTE entre el del MÁS
    // ANTIGUO. 132.373 / 125.564, al diezmilésimo.
    const aMano = new Decimal('132.373').dividedBy('125.564').toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    expect(aMano.toFixed(4)).toBe('1.0542');

    const r = await factorEntrePeriodos({ anio: 2023, mes: 1 }, { anio: 2023, mes: 12 });
    expect(r.factor).toBe('1.0542');
    expect(r.base).toBe(BASE_2018);
    expect(r.meses).toBe(12);
    expect(r.fuentes).toEqual({ antiguo: 'dof', reciente: 'dof' });
  });

  it('invertir las puntas NO devuelve el recíproco en silencio', async () => {
    await expect(
      factorEntrePeriodos({ anio: 2023, mes: 12 }, { anio: 2023, mes: 1 })
    ).rejects.toMatchObject({ code: 'INPC_PERIODO_INVERTIDO' });
  });

  it('el mismo mes en DOS bases hace ambigua la resolución, y se dice en vez de elegir', async () => {
    await importarSerie({
      fuente: 'inegi',
      capturadoPor: f.userId,
      filas: [
        { periodo: { anio: 2023, mes: 12 }, valor: '99.999', base: BASE_2010, publicadoEl: null, linea: 1 },
      ],
    });
    await expect(resolverIndice({ anio: 2023, mes: 12 })).rejects.toMatchObject({
      code: 'INPC_BASE_AMBIGUA',
    });
    // Con --base la ambigüedad desaparece y el factor vuelve a salir.
    const r = await factorEntrePeriodos(
      { anio: 2023, mes: 1 }, { anio: 2023, mes: 12 }, { base: BASE_2018 }
    );
    expect(r.factor).toBe('1.0542');
  });

  it('un índice que ya está con OTRO valor se acusa; no se pisa ni se ignora', async () => {
    await expect(
      importarSerie({
        fuente: 'dof',
        capturadoPor: f.userId,
        filas: [
          { periodo: { anio: 2023, mes: 1 }, valor: '999.999', base: BASE_2018, publicadoEl: null, linea: 7 },
        ],
      })
    ).rejects.toThrow(/contradice/);
    const sigue = await resolverIndice({ anio: 2023, mes: 1 }, { base: BASE_2018 });
    expect(new Decimal(sigue.valor).toFixed(3)).toBe('125.564');
  });

  it('el factor puro se niega con bases distintas aunque los números vengan a mano', async () => {
    expect(() =>
      factorDeActualizacion(
        { periodo: { anio: 2022, mes: 12 }, valor: '108.400', base: BASE_2010 },
        { periodo: { anio: 2023, mes: 12 }, valor: '132.373', base: BASE_2018 }
      )
    ).toThrow(/bases distintas|base "2010=100"/);
  });
});

describe('las tablas globales: lectura compartida, escritura sin gobierno', () => {
  it('la serie del INPC la ve OTRO inquilino, que es lo que la 065 quiere', async () => {
    await crearInquilino('F07cd otro despacho');
    try {
      const desdeElOtro = await resolverIndice({ anio: 2024, mes: 6 });
      expect(desdeElOtro.valor).toContain('135.317');
    } finally {
      enterTenant(f.tenantId);
    }
  }, 120_000);

  it('la ESCRITURA no está acotada: cualquier autor escribe la serie de todos', async () => {
    // El COMMENT de la 065 dice «lo que se acota es la escritura», y R4 lo
    // consigue con `created_by NOT NULL` en el esquema más el riesgo
    // declarado del comando. Aquí `inpc_serie.capturado_por` es NULLABLE y la
    // cota vive SÓLO en `importarSerie`; no hay comando que declare riesgo
    // porque `inpc` no está registrado en la CLI.
    const nullable = await query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'inpc_serie' AND column_name = 'capturado_por'`
    );
    expect(
      nullable.rows[0].is_nullable,
      'HALLAZGO: la cota de escritura de R4 (NOT NULL) no está en la 065'
    ).toBe('YES');

    // La cota de código sí funciona, y es la única que hay.
    await expect(
      importarSerie({
        fuente: 'manual',
        capturadoPor: '   ',
        filas: [
          { periodo: { anio: 2024, mes: 7 }, valor: '136.0', base: '2018-Jul2=100', publicadoEl: null, linea: 1 },
        ],
      })
    ).rejects.toThrow(/exige autor/);

    // Y un INSERT directo la rodea entera, dejando una fila global sin firma.
    await query(
      `INSERT INTO inpc_serie (anio, mes, valor, base, fuente) VALUES (2099, 1, 1.0, 'sin-firma', 'manual')`
    );
    const huerfana = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM inpc_serie WHERE capturado_por IS NULL`
    );
    expect(Number(huerfana.rows[0].n)).toBeGreaterThan(0);
    await query(`DELETE FROM inpc_serie WHERE base = 'sin-firma'`);
  });

  it('el c_Banco nace vacío y NO tiene quién lo siembre', async () => {
    // `sat_bancos` sólo aparece en la 064 y en dos lecturas de F07d: no hay
    // importador, ni semilla, ni comando. Así que `bancos_sembrados` vale
    // false en toda instalación recién migrada y la comprobación de la clave
    // de banco nunca afirma nada.
    const filas = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sat_bancos`);
    expect(Number(filas.rows[0].n)).toBe(0);

    const r = await generarPolizas(f.entityId, { periodo: periodoDe(10), solicitud: SOLICITUD });
    expect(r.meta.bancos_sembrados).toBe(false);
    const aviso = r.hallazgos.find((h) => h.check === 'banco-en-catalogo');
    expect(aviso?.severity).toBe('warning');
    expect(aviso?.detalle).toContain('sat_bancos');
  }, 60_000);
});
