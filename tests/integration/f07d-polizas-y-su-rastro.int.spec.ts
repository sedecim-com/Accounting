import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { ValidationError, NotFoundError } from '../../src/utils/errors.js';
import {
  generarPolizas,
  generarAuxiliar,
} from '../../src/services/sat/anexo24/polizas-service.js';

// ============================================================
// F07d · LAS PÓLIZAS Y SU RASTRO DE PAGO, MEDIDO CONTRA POSTGRES.
//
// Las unitarias (tests/sat/anexo24/polizas-*.spec.ts) prueban la forma del
// archivo y la aritmética con los datos ya en la mano. Lo que NO pueden probar
// es que esos datos SEAN los del mayor y los del pago de verdad:
//
//   · que `check_number` LLEGUE A LA COLUMNA. Existía desde la 002, la leían
//     tres sitios de treasury-posting y el INSERT del servicio la omitía: un
//     arnés que fabrica la fila reproduce el INSERT que el código escribe, no
//     el que debería. Aquí se lee de la tabla.
//   · que la cuenta ORIGEN salga descifrada de `bank_accounts`, que es donde
//     vive cifrada desde la 051.
//   · que una póliza que mueve dinero SIN rastro se denuncie CON SU NÚMERO y
//     que entonces NO se archive artefacto ninguno.
//   · que con `sat_bancos` vacía la validación de la clave de banco DIGA que
//     no miró nada, en vez de aprobar en silencio.
//   · y la frontera de entidad, octava aparición: las pólizas de la hermana no
//     entran en este archivo ni conociendo su id.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
// es la frontera del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

let f: Fixture;
let hermana: Fixture;
let bancoId: string;

const CLABE = '012180001234567895';
const SOLICITUD = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };
/** El mes en el que caen todos los movimientos de este archivo. */
const MES = 8;

async function cuentaPorCodigo(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`falta la cuenta ${code}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('F07d pólizas');
  hermana = await crearEntidadHermana(f, 'F07d hermana');
  await seedPolicies({ tenantId: f.tenantId });

  // LA CUENTA BANCARIA CON SU CLABE CIFRADA Y SU CLAVE DE BANCO.
  // La CLABE va cifrada porque así la escribe `bank account create` (051): el
  // generador tiene que descifrarla para poner CtaOri, y si el arnés la
  // guardara en claro esta prueba no mediría el camino real.
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

/** Un gasto aprobado, con su CFDI, listo para pagarse. */
async function gastoAprobado(
  entityId: string,
  userId: string,
  subtotal = '1000.00',
  iva = '160.00'
): Promise<{ billId: string; total: string; vendorId: string; uuid: string }> {
  const total = new Decimal(subtotal).plus(iva).toFixed(2);
  const fecha = fechaEnPeriodo(MES);
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);
  const uuidCfdi = uuidv4();

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Aceros & Cía','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, entityId, `V-${marca}`, userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,'PPD',$11)`,
    [billId, entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`,
     subtotal, iva, total, fecha, userId, uuidCfdi]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, await cuentaPorCodigo(entityId, '6100'), subtotal, iva, total]
  );
  await approveBill(billId, userId, { entityId });
  return { billId, total, vendorId, uuid: uuidCfdi };
}

// ============================================================
// 1 · EL NÚMERO DE CHEQUE, QUE POR FIN TIENE ESCRITOR
// ============================================================

describe('la columna que se leía y nadie escribía', () => {
  it('`recordVendorPayment` guarda check_number, cuenta destino y banco destino', async () => {
    const g = await gastoAprobado(f.entityId, f.userId);
    const r = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: g.total,
        paymentDate: fechaEnPeriodo(MES),
        paymentMethod: 'check',
        bankAccountId: bancoId,
        checkNumber: '10042',
        cuentaDestino: '002180009876543210',
        bancoDestinoSat: '002',
        applications: [{ documentId: g.billId, amountApplied: g.total }],
      },
      f.userId
    );

    const fila = await query<{
      check_number: string | null;
      cuenta_destino: string | null;
      banco_destino_sat: string | null;
      banco_destino_extranjero: string | null;
    }>(
      `SELECT check_number, cuenta_destino, banco_destino_sat, banco_destino_extranjero
         FROM vendor_payments WHERE id = $1 AND entity_id = $2`,
      [r.paymentId, f.entityId]
    );
    // Antes de este commit las cuatro valían NULL SIEMPRE, y las tres lecturas
    // de treasury-posting caían al payment_number sin que nada lo dijera.
    expect(fila.rows[0].check_number).toBe('10042');
    expect(fila.rows[0].cuenta_destino).toBe('002180009876543210');
    expect(fila.rows[0].banco_destino_sat).toBe('002');
    expect(fila.rows[0].banco_destino_extranjero).toBeNull();
  });

  it('rechaza el número de cheque sobre una transferencia, ANTES de tocar la base', async () => {
    const g = await gastoAprobado(f.entityId, f.userId);
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: g.total,
          paymentDate: fechaEnPeriodo(MES),
          paymentMethod: 'spei',
          bankAccountId: bancoId,
          checkNumber: '10043',
          applications: [{ documentId: g.billId, amountApplied: g.total }],
        },
        f.userId
      )
    ).rejects.toThrow(ValidationError);
    // Y el gasto sigue intacto: el rechazo ocurrió antes de mover nada.
    const b = await query<{ amount_due: string }>(
      `SELECT amount_due::text FROM bills WHERE id = $1`,
      [g.billId]
    );
    expect(new Decimal(b.rows[0].amount_due).toFixed(2)).toBe(g.total);
  });

  it('rechaza declarar banco destino nacional Y extranjero: el CHECK de la 064, con mensaje', async () => {
    const g = await gastoAprobado(f.entityId, f.userId);
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: g.total,
          paymentDate: fechaEnPeriodo(MES),
          paymentMethod: 'spei',
          bankAccountId: bancoId,
          cuentaDestino: '002180009876543210',
          bancoDestinoSat: '002',
          bancoDestinoExtranjero: 'Bank of Nowhere',
          applications: [{ documentId: g.billId, amountApplied: g.total }],
        },
        f.userId
      )
    ).rejects.toThrow(/incompatibles/);
  });

  it('rechaza el banco destino SIN cuenta destino: el banco solo no permite emitir el rastro', async () => {
    const g = await gastoAprobado(f.entityId, f.userId);
    await expect(
      recordVendorPayment(
        {
          entityId: f.entityId,
          paymentAmount: g.total,
          paymentDate: fechaEnPeriodo(MES),
          paymentMethod: 'spei',
          bankAccountId: bancoId,
          bancoDestinoSat: '002',
          applications: [{ documentId: g.billId, amountApplied: g.total }],
        },
        f.userId
      )
    ).rejects.toThrow(/cuenta destino/);
  });
});

// ============================================================
// 2 · EL RASTRO DENTRO DEL XML
// ============================================================

describe('el XML de pólizas lleva el rastro del pago', () => {
  it('el nodo Cheque sale con su número, su banco emisor y la cuenta origen DESCIFRADA', async () => {
    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });

    expect(r.xml).toContain('<PLZ:Cheque');
    expect(r.xml).toContain('Num="10042"');
    expect(r.xml).toContain('BanEmisNal="012"');
    // La CLABE entra cifrada en la tabla y sale en claro en el archivo: es el
    // dato que hace seguible la deducción, y poner los últimos cuatro en su
    // lugar habría declarado como número de cuenta algo que no lo es.
    expect(r.xml).toContain(`CtaOri="${CLABE}"`);
    expect(r.xml).toContain('Benef="Aceros &amp; Cía"');
  });

  it('el CFDI del gasto cuelga del renglón de la cuenta de control, no del de banco', async () => {
    const g = await gastoAprobado(f.entityId, f.userId, '500.00', '80.00');
    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });
    const lineas = r.xml.split('\n');
    const iComp = lineas.findIndex((l) => l.includes(`UUID_CFDI="${g.uuid}"`));
    expect(iComp, 'el CFDI del gasto tiene que estar en el archivo').toBeGreaterThan(0);
    // El nodo anterior con NumCta es el renglón del que cuelga: ha de ser la
    // cuenta de proveedores (2110), no la de bancos (1120).
    const renglon = [...lineas.slice(0, iComp)].reverse().find((l) => l.includes('NumCta='));
    expect(renglon).toContain('NumCta="2110"');
  });

  it('el archivo sale SIN SELLAR y lo dice', async () => {
    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });
    expect(r.xml).not.toContain('Sello=');
    expect(r.meta.sellada).toBe(false);
    expect(r.notaDeSellado).toContain('SIN SELLAR');
    // Y qué contestaba el panel queda registrado con el archivo.
    expect(r.meta.criterio_sellado).toBeTruthy();
  });

  it('produce BYTES IDÉNTICOS en dos corridas seguidas', async () => {
    const a = await generarPolizas(f.entityId, { periodo: `2026-0${MES}`, solicitud: SOLICITUD });
    const b = await generarPolizas(f.entityId, { periodo: `2026-0${MES}`, solicitud: SOLICITUD });
    expect(a.hash).toBe(b.hash);
  });
});

// ============================================================
// 3 · LA HONESTIDAD DE LO QUE FALTA
// ============================================================

describe('una póliza que mueve dinero y no trae el rastro', () => {
  it('se denuncia CON SU NÚMERO y el archivo no se puede entregar', async () => {
    const g = await gastoAprobado(f.entityId, f.userId, '300.00', '48.00');
    // Una transferencia sin cuenta destino: el pago se registra —ya ocurrió—
    // y es la PÓLIZA la que se queda coja.
    const pago = await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '348.00',
        paymentDate: fechaEnPeriodo(MES),
        paymentMethod: 'spei',
        bankAccountId: bancoId,
        applications: [{ documentId: g.billId, amountApplied: '348.00' }],
      },
      f.userId
    );
    const numero = pago.journalEntry?.entry_number;
    expect(numero, 'el pago tiene que haber posteado').toBeTruthy();

    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });

    const sinRastro = r.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro');
    expect(sinRastro.length).toBeGreaterThan(0);
    expect(sinRastro.map((h) => h.referencia)).toContain(numero);
    expect(sinRastro[0].detalle).toContain('cuenta destino');
    expect(r.puedeEntregarse).toBe(false);
    // Y NO se archiva: un artefacto es lo que se entrega, y esto no se entrega.
    expect(r.artefacto).toBeNull();
    // El XML sí se construye: el contador tiene que poder MIRAR lo que falta.
    expect(r.xml).toContain('<PLZ:Polizas');
  });
});

describe('la clave de banco cuando no hay catálogo', () => {
  it('con `sat_bancos` vacía DICE que no validó nada, en vez de aceptar en silencio', async () => {
    await query(`DELETE FROM sat_bancos`);
    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });
    const aviso = r.hallazgos.find((h) => h.check === 'banco-en-catalogo');
    expect(aviso, 'sin catálogo tiene que haber aviso').toBeDefined();
    expect(aviso!.severity).toBe('warning');
    expect(aviso!.detalle).toContain('sat_bancos');
    expect(r.meta.bancos_sembrados).toBe(false);
  });

  it('sembrado el catálogo, una clave que no está en él BLOQUEA', async () => {
    await query(
      `INSERT INTO sat_bancos (clave, nombre_corto, vigente) VALUES ('012','BBVA',true)
       ON CONFLICT (clave) DO NOTHING`
    );
    // Una TRANSFERENCIA con banco destino '002', que no está sembrado. Tiene
    // que ser transferencia y no cheque: el nodo `Cheque` del Anexo 24 declara
    // el banco EMISOR y no tiene dónde poner el destino, así que un cheque con
    // banco destino capturado no lo emite — el dato se guarda y el archivo no
    // lo lleva, que es lo correcto y no evidente.
    const g = await gastoAprobado(f.entityId, f.userId, '200.00', '32.00');
    await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: '232.00',
        paymentDate: fechaEnPeriodo(MES),
        paymentMethod: 'spei',
        bankAccountId: bancoId,
        cuentaDestino: '002180009876543210',
        bancoDestinoSat: '002',
        applications: [{ documentId: g.billId, amountApplied: '232.00' }],
      },
      f.userId
    );

    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });
    const fuera = r.hallazgos.filter(
      (h) => h.check === 'banco-en-catalogo' && h.severity === 'blocking'
    );
    expect(fuera.length).toBeGreaterThan(0);
    expect(fuera[0].detalle).toContain('002');
    expect(r.meta.bancos_sembrados).toBe(true);

    // Se deja sembrado lo que hace falta para el resto del archivo.
    await query(
      `INSERT INTO sat_bancos (clave, nombre_corto, vigente) VALUES ('002','Banamex',true)
       ON CONFLICT (clave) DO NOTHING`
    );
  });
});

// ============================================================
// 4 · LA FRONTERA DE ENTIDAD
// ============================================================

describe('la frontera de entidad, dentro del SQL', () => {
  it('las pólizas de la hermana no entran en el archivo de esta entidad', async () => {
    const g = await gastoAprobado(hermana.entityId, hermana.userId, '900.00', '144.00');
    expect(g.billId).toBeTruthy();

    const mia = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });
    expect(mia.xml).not.toContain(g.uuid);
  });

  it('un inquilino ajeno no resuelve el contribuyente: no archiva a su nombre', async () => {
    const otro = await crearInquilino('F07d otro despacho');
    enterTenant(otro.tenantId);
    try {
      await expect(
        generarPolizas(f.entityId, { periodo: `2026-0${MES}`, solicitud: SOLICITUD })
      ).rejects.toThrow(NotFoundError);
    } finally {
      enterTenant(f.tenantId);
    }
  });
});

// ============================================================
// 5 · LOS DOS AUXILIARES
// ============================================================

describe('el auxiliar, que el SAT pide sólo a requerimiento', () => {
  it('`--kind folios` lista los comprobantes de cada póliza y archiva su artefacto', async () => {
    const r = await generarAuxiliar(f.entityId, 'folios', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    expect(r.xml).toContain('<RepAuxFol:RepAuxFol');
    expect(r.xml).toContain('<RepAuxFol:DetAuxFol');
    expect(r.xml).toContain('<RepAuxFol:ComprNal');
    // Comparte la cabecera de solicitud con las pólizas, literalmente.
    expect(r.xml).toContain('TipoSolicitud="AF"');
    expect(r.xml).toContain('NumOrden="ABC1234567/26"');
    expect(r.artefacto).not.toBeNull();

    const fila = await query<{ tipo: string; hash_sha256: string }>(
      `SELECT tipo, hash_sha256 FROM sat_anexo24_artefactos WHERE id = $1`,
      [r.artefacto!.id]
    );
    expect(fila.rows[0].tipo).toBe('auxiliar_folios');
    expect(fila.rows[0].hash_sha256).toBe(r.hash);
  });

  it('`--kind accounts` declara el saldo de la cuenta EN SU PROPIA NATURALEZA', async () => {
    const r = await generarAuxiliar(f.entityId, 'accounts', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    expect(r.xml).toContain('<AuxiliarCtas:AuxiliarCtas');
    expect(r.xml).toContain('<AuxiliarCtas:Cuenta');
    expect(r.xml).toContain('<AuxiliarCtas:DetalleAux');

    // 2110 es ACREEDORA: el mayor la lleva en negativo y el archivo la declara
    // positiva. Un `abs()` daría la misma cifra por la razón equivocada; lo
    // que se comprueba es que NO salga con el signo del libro.
    const cuenta = r.xml.split('\n').find((l) => l.includes('NumCta="2110"'));
    expect(cuenta, 'la cuenta de proveedores tiene que estar en el auxiliar').toBeDefined();
    expect(cuenta).not.toContain('SaldoFin="-');
    expect(cuenta).not.toContain('SaldoIni="-');
  });

  it('los dos auxiliares se archivan como tipos DISTINTOS', async () => {
    const folios = await generarAuxiliar(f.entityId, 'folios', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    const cuentas = await generarAuxiliar(f.entityId, 'accounts', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    expect(folios.hash).not.toBe(cuentas.hash);
    expect(folios.nombre.endsWith('XF.XML')).toBe(true);
    expect(cuentas.nombre.endsWith('XC.XML')).toBe(true);
  });

  it('regenerar sin cambios NO crea fila nueva: la idempotencia es por hash', async () => {
    const a = await generarAuxiliar(f.entityId, 'accounts', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    const b = await generarAuxiliar(f.entityId, 'accounts', {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
      generadoPor: f.userId,
    });
    expect(b.artefacto!.yaExistia).toBe(true);
    expect(b.artefacto!.id).toBe(a.artefacto!.id);
  });
});

// ============================================================
// 6 · LO QUE NO SE PUEDE PEDIR
// ============================================================

describe('el salto de línea pegado desde Excel', () => {
  it('se limpia para que el archivo salga, y se DENUNCIA con el número de póliza', async () => {
    // El constructor de F07b RECHAZA un salto de línea dentro de un atributo:
    // XML 1.0 §3.3.3 obliga a todo analizador a convertirlo en espacio, así que
    // el SAT recibiría un texto distinto del que se firmó. Sin esta limpieza el
    // archivo ENTERO moriría por un concepto tecleado con Intro.
    const asiento = await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(MES),
      JournalEntryType.STANDARD,
      'Ajuste\nde   fin de mes',
      [
        {
          account_id: await cuentaPorCodigo(f.entityId, '6100'),
          debit_amount: '10.00',
          credit_amount: null,
          description: 'reclasificación',
        },
        {
          account_id: await cuentaPorCodigo(f.entityId, '6200'),
          debit_amount: null,
          credit_amount: '10.00',
          description: 'reclasificación',
        },
      ],
      f.userId,
      { autoPost: true }
    );

    const r = await generarPolizas(f.entityId, {
      periodo: `2026-0${MES}`,
      solicitud: SOLICITUD,
    });

    expect(r.xml).toContain('Concepto="Ajuste de fin de mes"');
    const aviso = r.hallazgos.find(
      (h) => h.check === 'texto-normalizado' && h.referencia === asiento.entry_number
    );
    expect(aviso, 'el cambio se dice en vez de callarse').toBeDefined();
    expect(aviso!.severity).toBe('warning');
  });
});

describe('los errores de uso, dichos en el idioma del que los comete', () => {
  it('una entidad sin RFC no puede entregar pólizas del Anexo 24', async () => {
    const usa = await crearInquilino('F07d entidad de EEUU', { pais: 'US' });
    enterTenant(usa.tenantId);
    try {
      await expect(
        generarPolizas(usa.entityId, { periodo: '2026-08', solicitud: SOLICITUD })
      ).rejects.toThrow(/no con RFC/);
    } finally {
      enterTenant(f.tenantId);
    }
  });

  it('sin TipoSolicitud válido no hay archivo: las pólizas no se presentan de oficio', async () => {
    await expect(
      generarPolizas(f.entityId, {
        periodo: `2026-0${MES}`,
        solicitud: { tipo: 'AF' },
      })
    ).rejects.toThrow(/exige NumOrden/);
  });
});
