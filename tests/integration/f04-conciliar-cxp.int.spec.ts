import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import {
  drainAttestations,
  createJournalEntry,
  reverseJournalEntry,
} from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';

/**
 * F04 · `ap reconcile`, contra la base real.
 *
 * La fila que el catálogo pedía para CERRAR CxP, y la única del flujo que
 * estaba en ❌ puro: existía la antigüedad de saldos, no el cuadre contra la
 * cuenta de control ni la detección de asientos manuales posteados directo a
 * ella. Un auxiliar que nadie cuadra contra el mayor es una lista bonita.
 *
 * Lo que se prueba aquí no es que la función devuelva números, sino que
 * ENCUENTRE lo que sólo ella puede encontrar: la póliza que alguien metió a
 * mano en la 2110 sin gasto detrás. Y que NO acuse a la que no lo es —una
 * reversión legítima nace sin `source_type` y se le parece mucho.
 */

let f: Fixture;
let cuentaCxp: string;
let cuentaGasto: string;

beforeAll(async () => {
  f = await crearInquilino('F04 conciliar CxP');
  const r = await query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE entity_id = $1 AND code = ANY($2)`,
    [f.entityId, ['2110', '6100']]
  );
  cuentaCxp = r.rows.find((x) => x.code === '2110')!.id;
  cuentaGasto = r.rows.find((x) => x.code === '6100')!.id;
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function gastoAprobado(subtotal = '1000.00', iva = '160.00'): Promise<{
  billId: string;
  numero: string;
  total: string;
}> {
  const total = new Decimal(subtotal).plus(iva).toFixed(2);
  const fecha = fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);

  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor conciliación','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${marca}`, f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10)`,
    [billId, f.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`,
     subtotal, iva, total, fecha, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, cuentaGasto, subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return { billId, numero: `BILL-${marca}`, total };
}

/**
 * Una póliza metida A MANO sobre la cuenta de control: sin gasto detrás, sin
 * `source_type`. Es exactamente lo que este comando existe para encontrar, y
 * lo que ninguna antigüedad de saldos puede ver — porque no hay documento en
 * el auxiliar que la delate.
 */
async function polizaManualSobreControl(
  importe: string,
  fecha: Date,
  descripcion = 'Ajuste a mano sobre la cuenta de control'
): Promise<string> {
  // Se postea por la VÍA REAL (`createJournalEntry` con autoPost), no con un
  // INSERT a mano.
  //
  // La primera versión insertaba las filas directamente, y eso rompió tres
  // pruebas de OTROS archivos: `mayor-inviolable` y el ensayo de restauración
  // de S3 comprueban que `account_balances` case con la suma de las líneas
  // posteadas y que todo asiento tenga su fila 'post' en la bitácora. Un
  // asiento inyectado por debajo no actualiza ninguna de las dos cosas, así
  // que la suite compartida acababa denunciando un mayor descuadrado que
  // había fabricado esta prueba. Un instrumento que sólo funciona rompiendo
  // los libros no prueba nada sobre los libros.
  //
  // Lo que hace manual a esta póliza no es cómo se inserta: es que no lleva
  // `sourceType`. Nadie la respalda con un gasto, y eso es justo lo que
  // `apReconcile` busca.
  const numero = await withTransaction(async (client) => {
    const entry = await createJournalEntry(
      f.entityId,
      fecha,
      JournalEntryType.STANDARD,
      descripcion,
      [
        // CR control / DR gasto: sube el pasivo en el mayor sin que ningún
        // gasto del auxiliar suba con él.
        { account_id: cuentaCxp, debit_amount: null, credit_amount: importe, description: 'a mano' },
        { account_id: cuentaGasto, debit_amount: importe, credit_amount: null, description: 'a mano' },
      ],
      f.userId,
      { autoPost: true, client }
    );
    return entry.entry_number;
  });
  return numero;
}

describe('el cuadre del subdiario contra la cuenta de control', () => {
  it('con los libros limpios, auxiliar y mayor dicen lo mismo', async () => {
    await gastoAprobado('1000.00', '160.00');
    const r = await apReconcile(f.entityId);

    expect(r.cuentaControl.code, 'el rol cxp resuelve a la 2110').toBe('2110');
    expect(
      new Decimal(r.diferencia).abs().toNumber(),
      `subdiario ${r.subdiario} vs mayor ${r.mayor}: ${r.partidas.map((p) => p.detalle).join(' | ')}`
    ).toBeLessThan(0.01);
    expect(r.cuadra).toBe(true);
    expect(r.sinExplicar).toBe('0.00');
  });

  it('sigue cuadrando después de pagar: el pago baja las dos mitades a la vez', async () => {
    const gasto = await gastoAprobado('500.00', '80.00');
    await recordVendorPayment(
      {
        entityId: f.entityId,
        paymentAmount: gasto.total,
        paymentDate: fechaEnPeriodo(),
        paymentMethod: 'spei',
        applications: [{ documentId: gasto.billId, amountApplied: gasto.total }],
      },
      f.userId
    );
    const r = await apReconcile(f.entityId);
    expect(r.cuadra, `quedó ${r.sinExplicar} sin explicar`).toBe(true);
  });
});

describe('el asiento manual sobre la cuenta de control, que es lo que nadie más ve', () => {
  it('lo encuentra, lo nombra y lo cuantifica', async () => {
    const numero = await polizaManualSobreControl('750.00', fechaEnPeriodo());
    const r = await apReconcile(f.entityId);

    const manual = r.partidas.find((p) => p.referencia === numero);
    expect(manual, `no apareció ${numero} entre ${r.partidas.length} partidas`).toBeDefined();
    expect(manual!.tipo).toBe('asiento-manual');
    expect(new Decimal(manual!.importe).abs().toFixed(2)).toBe('750.00');
    // Un pasivo que sube en el mayor sin subir en el auxiliar deja el
    // subdiario POR DEBAJO: la aportación a `subdiario − mayor` es negativa.
    expect(new Decimal(manual!.importe).isNegative()).toBe(true);
  });

  it('y su importe EXPLICA la diferencia, en vez de dejarla sin dueño', async () => {
    const r = await apReconcile(f.entityId);
    expect(r.cuadra, 'con un ajuste a mano vivo, los libros ya no cuadran').toBe(false);
    // Lo que este comando vale: no decir «hay 750 de diferencia», sino decir
    // de QUIÉN son. Si el explicado no cubre la diferencia, queda residuo.
    expect(
      new Decimal(r.sinExplicar).abs().toNumber(),
      `${r.diferencia} de diferencia y sólo ${r.explicado} explicado`
    ).toBeLessThan(0.01);
  });

  it('con --explain el detalle es prosa, no una etiqueta', async () => {
    const corto = await apReconcile(f.entityId);
    const largo = await apReconcile(f.entityId, { explain: true });
    const dCorto = corto.partidas.find((p) => p.tipo === 'asiento-manual')!.detalle;
    const dLargo = largo.partidas.find((p) => p.tipo === 'asiento-manual')!.detalle;
    expect(dLargo.length, 'explicar es decir por qué, no repetir el qué').toBeGreaterThan(
      dCorto.length
    );
  });
});

describe('la fecha de corte', () => {
  it('un asiento posterior al corte no entra, y el corte retroactivo se advierte', async () => {
    // El ajuste vive en agosto; se corta a julio.
    const r = await apReconcile(f.entityId, { asOf: '2026-07-31' });
    expect(r.asOf).toBe('2026-07-31');
    expect(
      r.partidas.some((p) => p.tipo === 'asiento-manual'),
      'el ajuste de agosto no puede aparecer en un corte a julio'
    ).toBe(false);
    expect(
      r.advertenciaAsOf,
      'un corte hacia atrás compara saldos de hoy con documentos de entonces: hay que decirlo'
    ).not.toBeNull();
  });

  it('sin corte explícito no hay advertencia que dar', async () => {
    const r = await apReconcile(f.entityId);
    expect(r.advertenciaAsOf).toBeNull();
  });

  it('rechaza una fecha que no es una fecha', async () => {
    await expect(apReconcile(f.entityId, { asOf: 'ayer' })).rejects.toThrow();
  });
});

describe('la frontera del inquilino', () => {
  it('no ve los gastos ni los ajustes de otra entidad', async () => {
    const otra = await crearInquilino('F04 conciliar · otra');
    const r = await apReconcile(otra.entityId);
    // La entidad recién creada no tiene gastos: si viera los de `f`, el
    // subdiario no sería cero.
    expect(new Decimal(r.subdiario).toNumber()).toBe(0);
    expect(new Decimal(r.mayor).toNumber()).toBe(0);
    expect(r.partidas).toEqual([]);
  }, 120_000);
});

// ============================================================
// LAS SONDAS 2 Y 3, Y LA CLÁUSULA QUE LAS DEFIENDE.
//
// Lo de arriba prueba el caso limpio, el pago y el asiento manual. Faltaban
// las dos sondas que reparten el resto de la diferencia —«gasto sin asiento»
// y «asiento sin gasto»— y, sobre todo, faltaba la cláusula de la que
// depende que la primera no mienta: una reversión legítima nace SIN
// `source_type` y es idéntica a un ajuste a mano si nadie mira
// `reverses_entry_id`. Sin esta prueba, quitar ese NOT EXISTS no rompía nada
// y cada anulación correcta del sistema aparecía denunciada como manual.
//
// Cada escenario levanta su PROPIO inquilino: los de arriba comparten `f` y
// se leen en orden, así que un gasto de más en ese fixture rompe asertos
// ajenos tres pruebas más abajo.
// ============================================================

interface Escenario {
  f: Fixture;
  cuentaCxp: string;
  cuentaGasto: string;
}

async function escenario(nombre: string): Promise<Escenario> {
  const fx = await crearInquilino(`F04 conciliar · ${nombre}`);
  const r = await query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE entity_id = $1 AND code = ANY($2)`,
    [fx.entityId, ['2110', '6100']]
  );
  return {
    f: fx,
    cuentaCxp: r.rows.find((x) => x.code === '2110')!.id,
    cuentaGasto: r.rows.find((x) => x.code === '6100')!.id,
  };
}

/**
 * `aprobar: false` deja el gasto ABIERTO en el auxiliar y sin asiento en el
 * mayor. Es un estado que la aplicación no produce —aprobar es justo lo que
 * contabiliza— pero que un alta directa, una migración o un `entry unpost` sí
 * dejan, y es exactamente lo que la sonda 2 existe para encontrar.
 */
async function gastoEn(
  e: Escenario,
  opts: { subtotal: string; iva: string; aprobar: boolean }
): Promise<{ billId: string; numero: string; total: string }> {
  const total = new Decimal(opts.subtotal).plus(opts.iva).toFixed(2);
  const fecha = fechaEnPeriodo();
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor sonda','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, e.f.entityId, `V-${marca}`, e.f.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10)`,
    [billId, e.f.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`,
     opts.subtotal, opts.iva, total, fecha, e.f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, e.cuentaGasto, opts.subtotal, opts.iva, total]
  );
  if (opts.aprobar) await approveBill(billId, e.f.userId, { entityId: e.f.entityId });
  else await query(`UPDATE bills SET status = 'approved' WHERE id = $1`, [billId]);
  return { billId, numero: `BILL-${marca}`, total };
}

describe('las otras dos sondas reparten el resto de la diferencia', () => {
  it('gasto sin asiento: el auxiliar pesa y el mayor no lo reconoce', async () => {
    const e = await escenario('sonda gasto-sin-asiento');
    const g = await gastoEn(e, { subtotal: '1000.00', iva: '160.00', aprobar: false });
    const r = await apReconcile(e.f.entityId);

    const p = r.partidas.find((x) => x.referencia === g.numero);
    expect(p, `no apareció ${g.numero}: ${JSON.stringify(r.partidas)}`).toBeDefined();
    expect(p!.tipo).toBe('gasto-sin-asiento');
    // El pasivo existe y la contabilidad no lo tiene: el auxiliar va POR
    // ENCIMA, así que la aportación a `subdiario − mayor` es positiva.
    expect(p!.importe).toBe('1160.00');
    expect(r.diferencia).toBe('1160.00');
    expect(r.sinExplicar, 'la sonda cubre la diferencia entera').toBe('0.00');
  }, 120_000);

  it('asiento sin gasto: el gasto murió y su crédito sigue vivo en el control', async () => {
    const e = await escenario('sonda asiento-sin-gasto');
    const g = await gastoEn(e, { subtotal: '2000.00', iva: '320.00', aprobar: true });
    expect((await apReconcile(e.f.entityId)).cuadra, 'el punto de partida cuadra').toBe(true);

    // Anulado SIN reversar: el pecado que esta sonda persigue.
    await query(
      `UPDATE bills SET status='cancelled', amount_due=0 WHERE id=$1 AND entity_id=$2`,
      [g.billId, e.f.entityId]
    );
    const r = await apReconcile(e.f.entityId);

    const p = r.partidas.find((x) => x.referencia === g.numero);
    expect(p, `no apareció ${g.numero}: ${JSON.stringify(r.partidas)}`).toBeDefined();
    expect(p!.tipo).toBe('asiento-sin-gasto');
    expect(p!.importe).toBe('-2320.00');
    expect(r.sinExplicar).toBe('0.00');
  }, 120_000);

  it('un pago parcial y luego la anulación: residuo con nombre, no partida inventada', async () => {
    const e = await escenario('residuo honesto');
    const g = await gastoEn(e, { subtotal: '1000.00', iva: '0.00', aprobar: true });
    await recordVendorPayment(
      {
        entityId: e.f.entityId,
        paymentAmount: '400.00',
        paymentDate: fechaEnPeriodo(8, 20),
        paymentMethod: 'spei',
        applications: [{ documentId: g.billId, amountApplied: '400.00' }],
      },
      e.f.userId
    );
    expect((await apReconcile(e.f.entityId)).cuadra, 'un pago parcial no descuadra').toBe(true);

    await query(
      `UPDATE bills SET status='cancelled', amount_due=0 WHERE id=$1 AND entity_id=$2`,
      [g.billId, e.f.entityId]
    );
    const r = await apReconcile(e.f.entityId);

    // Quedan 600 vivos en el control, no 1000: la sonda 3 NO sabe repartir el
    // débito del pago (la condonación no se guarda por gasto) y por eso se
    // calla en vez de reclamar el crédito entero. Lo que no sabe medir cae en
    // residuo, que es el trato.
    expect(r.diferencia).toBe('-600.00');
    expect(
      r.partidas.find((p) => p.tipo === 'asiento-sin-gasto'),
      'reclamar 1000 por 600 vivos sería una partida falsa'
    ).toBeUndefined();
    expect(r.partidas.find((p) => p.tipo === 'residuo')!.importe).toBe('-600.00');
  }, 120_000);
});

describe('la reversión legítima, que se parece a un ajuste a mano y no lo es', () => {
  it('no se acusa de manual al espejo de un gasto anulado por el camino correcto', async () => {
    const e = await escenario('reversión limpia');
    const g = await gastoEn(e, { subtotal: '3000.00', iva: '480.00', aprobar: true });
    const je = await query<{ journal_entry_id: string }>(
      `SELECT journal_entry_id FROM bills WHERE id = $1`,
      [g.billId]
    );

    // NIF B-1: se corrige por reversión. El espejo nace sin `source_type`.
    await reverseJournalEntry(je.rows[0].journal_entry_id, e.f.userId, { reason: 'CFDI cancelado' });
    await query(
      `UPDATE bills SET status='cancelled', amount_due=0 WHERE id=$1 AND entity_id=$2`,
      [g.billId, e.f.entityId]
    );
    const r = await apReconcile(e.f.entityId);

    expect(
      r.partidas.filter((p) => p.tipo === 'asiento-manual'),
      'sin el NOT EXISTS sobre reverses_entry_id, cada anulación correcta sale denunciada'
    ).toEqual([]);
    expect(r.cuadra, `dif ${r.diferencia} · ${JSON.stringify(r.partidas)}`).toBe(true);
    expect(r.partidas, 'una anulación limpia no deja nada que conciliar').toEqual([]);
  }, 120_000);
});

describe('la frontera de ENTIDAD, que es la que RLS no defiende', () => {
  it('dos entidades del MISMO inquilino no se ven los libros', async () => {
    // Con `crearInquilino` dos veces esto pasaría por el motivo equivocado:
    // cruzaría la frontera de INQUILINO, que RLS sí acota. Una holding con
    // varias entidades legales es el caso normal, y ahí sólo protege el
    // `entity_id` que va dentro del SQL.
    const a = await escenario('frontera A');
    const hermana = await crearEntidadHermana(a.f, 'F04 conciliar · hermana');
    const cuentasB = await query<{ id: string; code: string }>(
      `SELECT id, code FROM accounts WHERE entity_id = $1 AND code = '2110'`,
      [hermana.entityId]
    );

    await gastoEn(a, { subtotal: '5000.00', iva: '800.00', aprobar: true });
    await withTransaction(async (client) => {
      await createJournalEntry(
        a.f.entityId,
        fechaEnPeriodo(),
        JournalEntryType.STANDARD,
        'ajuste a mano de A',
        [
          { account_id: a.cuentaCxp, debit_amount: null, credit_amount: '333.00', description: 'A' },
          { account_id: a.cuentaGasto, debit_amount: '333.00', credit_amount: null, description: 'A' },
        ],
        a.f.userId,
        { autoPost: true, client }
      );
    });

    const rb = await apReconcile(hermana.entityId);
    expect(rb.cuentaControl.id, 'cada entidad resuelve SU cuenta de control').toBe(cuentasB.rows[0].id);
    expect(rb.subdiario, 'B no tiene gastos').toBe('0.00');
    expect(rb.mayor, 'B no tiene mayor').toBe('0.00');
    expect(rb.partidas, 'ni el ajuste a mano de A').toEqual([]);

    const ra = await apReconcile(a.f.entityId);
    expect(ra.subdiario).toBe('5800.00');
    expect(ra.partidas.some((p) => p.tipo === 'asiento-manual')).toBe(true);
  }, 120_000);
});

describe('el medio centavo, que decide un código de salida', () => {
  it('por debajo de la tolerancia no hay partida de residuo, aunque se imprima 0.01', async () => {
    const e = await escenario('medio centavo');
    // Un crédito de medio centavo al control con `source_type` de CxP: ninguna
    // sonda lo reclama, así que es residuo puro… por debajo de la tolerancia.
    await withTransaction(async (client) => {
      await createJournalEntry(
        e.f.entityId,
        fechaEnPeriodo(),
        JournalEntryType.STANDARD,
        'medio centavo al control',
        [
          { account_id: e.cuentaCxp, debit_amount: null, credit_amount: '0.0050', description: 'x' },
          { account_id: e.cuentaGasto, debit_amount: '0.0050', credit_amount: null, description: 'x' },
        ],
        e.f.userId,
        { autoPost: true, client, sourceType: 'bill', sourceId: uuidv4() }
      );
    });
    const r = await apReconcile(e.f.entityId);

    // Éste es el contrato del que depende el CLI: lo BLOQUEANTE es la
    // existencia de la fila de residuo, no el importe presentado. Aquí no hay
    // fila, y `sinExplicar` sale igualmente como «-0.01» porque se presenta a
    // dos decimales. Un comando que recalculara el umbral sobre ese texto
    // diría «cuadra» y saldría 4 a la vez.
    expect(r.cuadra).toBe(true);
    expect(r.sinExplicar).toBe('-0.01');
    expect(r.partidas.filter((p) => p.tipo === 'residuo')).toEqual([]);
  }, 120_000);
});
