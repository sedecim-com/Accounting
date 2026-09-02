import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearAjuste } from '../../src/services/banking/reconciliation-adjustments.js';
import { correrCotejo } from '../../src/services/banking/match-service.js';
import {
  abrirSesion,
  aprobarSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  contabilizarSesion,
  construirInstantanea,
  estadoDeSesion,
  hashDeInstantanea,
  criteriosDeCierre,
} from '../../src/services/banking/reconciliation-service.js';
import {
  conciliarCheque,
  contabilizarComisiones,
  contabilizarIntereses,
} from '../../src/services/banking/treasury-posting.js';
import { floorTolerancia } from '../../src/ai/floor.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * ATAQUE ADVERSARIAL A F05d.
 *
 * F05d es el ÚNICO tramo de F05 que toca el mayor, así que el objetivo del
 * ataque es UNO: que algo llegue al mayor sin merecerlo, o que caiga en el mes
 * equivocado. Todo lo demás es secundario.
 *
 * LOS DOS FRENTES:
 *
 *  1. LA FIRMA Y EL SELLO. Contabilizar sin firma, firmar sin cuadre, firmar o
 *     contabilizar dos veces, y sobre todo: escribir el ESTADO sin la
 *     CONSTANCIA por debajo del servicio, que es la forma exacta del defecto
 *     histórico del módulo. Los tres CHECK de la 055 se prueban INTENTÁNDOLOS,
 *     no leyéndolos.
 *
 *  2. EL MES DEL COBRO DEL CHEQUE, que es el más mexicano de los dos. Un cheque
 *     firmado en enero y cobrado en marzo tiene que reclasificar su IVA en
 *     MARZO: bajo la LIVA el pago se entiende efectuado al cobrarse. Un asiento
 *     fechado en enero —o «hoy»— CUADRA igual de bien y deja mal el IVA mensual
 *     de toda empresa que pague con cheques.
 */

let A: Fixture;
let B: Fixture;
let cuentaA: string;
let cuentaB: string;
let glA: string;
let firmante: string;

/**
 * Una cuenta bancaria nueva por bloque de ataque.
 *
 * No es comodidad: `abrirSesion` exige que las sesiones de una cuenta sean
 * CONTIGUAS —un tramo sin conciliar entre dos conciliados es dinero que nadie
 * miró—, así que dos bloques que abrieran sesiones de meses salteados sobre la
 * misma cuenta chocarían con esa regla y no con lo que vienen a probar.
 */
let siguienteGl = 0;
async function nuevaCuenta(fx: Fixture, nombre: string): Promise<string> {
  // Su PROPIA cuenta de mayor: `uq_bank_accounts_gl` no admite dos cuentas
  // bancarias colgando del mismo renglón del catálogo, y con razón.
  siguienteGl += 1;
  const gl = uuidv4();
  const codigo = `1110-${String(siguienteGl).padStart(2, '0')}`;
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id,
       currency_code, normal_balance, created_by)
     VALUES ($1,$2,$3,'asset','current_assets',$4,'MXN','debit',$5)`,
    [gl, codigo, `Banco ${nombre}`, fx.entityId, fx.userId]
  );
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, account_type)
     VALUES ($1,$2,$3,'Banco',$4,'MXN','checking')`,
    [id, fx.entityId, nombre, gl]
  );
  return id;
}

/** Un movimiento del extracto, en la cuenta que se le diga. */
async function mov(
  cuenta: string,
  fecha: string,
  importe: string,
  tipo: 'debit' | 'credit' | 'fee' | 'interest',
  desc: string,
  extracto?: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount,
       transaction_type, description, is_matched, statement_id)
     VALUES ($1,$2,$3::date,$4,$5,$6,false,$7)`,
    [id, cuenta, fecha, importe, tipo, desc, extracto ?? null]
  );
  return id;
}

interface RenglonDeAsiento {
  code: string;
  debit: string | null;
  credit: string | null;
}

/**
 * EL ASIENTO DEL GASTO PPD, con su IVA aparcado en 1135, POSTEADO POR EL MOTOR.
 *
 * Se postea con `createJournalEntry` y no con un INSERT a mano por una razón
 * que sólo se ve corriendo la suite entera: `account_balances` es tabla
 * derivada que el posteo refresca (042), y unas líneas metidas a mano dejan la
 * derivada desalineada del mayor — que es exactamente lo que
 * `checkLedgerIntegrity` reporta como `fail`. Un montaje de prueba no puede
 * romper el chequeo que otra prueba hace del mayor.
 */
async function asientoDelGasto(
  fx: Fixture,
  gastoId: string,
  fecha: string,
  numero: string
): Promise<void> {
  await createJournalEntry(
    fx.entityId,
    new Date(`${fecha}T00:00:00`),
    JournalEntryType.STANDARD,
    `Gasto ${numero}`,
    [
      {
        account_id: fx.roles.gasto ?? fx.cuentas['6100'],
        debit_amount: '1000.00',
        credit_amount: null,
        description: 'gasto',
      },
      {
        account_id: fx.roles.iva_pendiente_acreditar,
        debit_amount: '160.00',
        credit_amount: null,
        description: 'IVA pendiente de acreditar',
      },
      {
        account_id: fx.roles.cxp,
        debit_amount: null,
        credit_amount: '1160.00',
        description: 'CxP',
      },
    ],
    fx.userId,
    { autoPost: true, sourceType: 'bill', sourceId: gastoId }
  );
}

/** El asiento entero, por código de cuenta, tal como quedó en el mayor. */
async function asientoPorOrigen(
  entityId: string,
  sourceType: string,
  sourceId: string
): Promise<{ id: string; fecha: string; status: string; lineas: RenglonDeAsiento[] } | null> {
  const je = await query<{ id: string; fecha: string; status: string }>(
    `SELECT id, entry_date::text AS fecha, status
       FROM journal_entries
      WHERE entity_id = $1 AND source_type = $2 AND source_id = $3`,
    [entityId, sourceType, sourceId]
  );
  if (je.rows.length === 0) return null;
  const lineas = await query<RenglonDeAsiento>(
    `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY a.code`,
    [je.rows[0].id]
  );
  return { ...je.rows[0], lineas: lineas.rows };
}

/** Débitos menos créditos del asiento. Cero exacto o el asiento no cuadra. */
function descuadre(lineas: readonly RenglonDeAsiento[]): string {
  return lineas
    .reduce(
      (acc, l) => acc.plus(l.debit ?? '0').minus(l.credit ?? '0'),
      new Decimal(0)
    )
    .toFixed(4);
}

function importeEn(lineas: readonly RenglonDeAsiento[], code: string): RenglonDeAsiento | undefined {
  return lineas.find((l) => l.code === code);
}

beforeAll(async () => {
  A = await crearInquilino('Ataque F05d');
  B = await crearEntidadHermana(A, 'Hermana F05d');
  glA = A.roles.banco ?? Object.values(A.cuentas)[0];

  firmante = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
       roles, permissions, accessible_entities, is_active)
     VALUES ($1,$2,$3,'x','Firma','Ataque','["owner"]'::jsonb,'["*"]'::jsonb,$4::jsonb,true)`,
    [firmante, A.tenantId, `atq-${firmante.slice(0, 8)}@example.test`,
     JSON.stringify([A.entityId])]
  );

  cuentaA = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, account_type)
     VALUES ($1,$2,'Operativa A','Banco',$3,'MXN','checking')`,
    [cuentaA, A.entityId, glA]
  );
  cuentaB = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, account_type)
     VALUES ($1,$2,'Operativa B','Banco',$3,'MXN','checking')`,
    [cuentaB, B.entityId, B.roles.banco ?? Object.values(B.cuentas)[0]]
  );

  await seedPolicies({ tenantId: A.tenantId, entityId: A.entityId });
}, 240_000);

afterAll(async () => {
  await closeDatabase();
});

// ============================================================
// 1 · LOS TRES CHECK DE LA 055, INTENTADOS Y NO LEÍDOS
//
// Es el ataque por debajo del servicio: si la base admite `approved` sin hash,
// entonces «aprobada» vuelve a ser una palabra que alguien escribe con un
// UPDATE, que es exactamente de lo que este módulo viene.
// ============================================================
describe('ataque: el estado sin la constancia', () => {
  let sesion: string;

  beforeAll(async () => {
    const cuenta = await nuevaCuenta(A, 'Estado sin constancia');
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-04-01','2026-04-30',0,0,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, 'a'.repeat(64), A.userId]
    );
    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-04' },
      { userId: A.userId }
    );
    sesion = abierta.sesionId;
    await cerrarSesion(entityScope(A.tenantId, A.entityId), sesion, {}, { userId: A.userId });
  });

  it('`approved` sin hash lo rechaza `sesion_aprobada_con_firma`', async () => {
    await expect(
      query(`UPDATE reconciliation_sessions SET status = 'approved' WHERE id = $1`, [sesion])
    ).rejects.toThrow(/sesion_aprobada_con_firma/);
  });

  it('`posted` sin hash lo rechaza también, aun con posted_at y posted_by', async () => {
    await expect(
      query(
        `UPDATE reconciliation_sessions
            SET status = 'posted', posted_at = NOW(), posted_by = $2
          WHERE id = $1`,
        [sesion, A.userId]
      )
    ).rejects.toThrow(/sesion_aprobada_con_firma/);
  });

  it('media firma —firmante y fecha sin instantánea— la rechaza `sesion_firma_coherente`', async () => {
    await expect(
      query(
        `UPDATE reconciliation_sessions SET approved_by = $2, approved_at = NOW() WHERE id = $1`,
        [sesion, A.userId]
      )
    ).rejects.toThrow(/sesion_firma_coherente/);
  });

  it('un hash sin firmante ni fecha tampoco pasa: la firma va entera o no va', async () => {
    await expect(
      query(
        `UPDATE reconciliation_sessions SET approval_hash = $2 WHERE id = $1`,
        [sesion, 'f'.repeat(64)]
      )
    ).rejects.toThrow(/sesion_firma_coherente/);
  });

  it('`posted` con firma pero sin rastro lo rechaza `sesion_contabilizada_con_rastro`', async () => {
    // La firma ENTERA, escrita como la escribe el servicio, para que el CHECK
    // que se prueba sea el del rastro y no el de la firma.
    await query(
      `UPDATE reconciliation_sessions
          SET status = 'approved', approved_by = $2, approved_at = NOW(),
              approval_snapshot = '{"version":1}'::jsonb, approval_hash = $3
        WHERE id = $1`,
      [sesion, A.userId, 'e'.repeat(64)]
    );
    await expect(
      query(`UPDATE reconciliation_sessions SET status = 'posted' WHERE id = $1`, [sesion])
    ).rejects.toThrow(/sesion_contabilizada_con_rastro/);
  });

  it('la fecha de cobro de un cheque sin el movimiento que la prueba tampoco pasa', async () => {
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-CHK','Proveedor CHECK','MXN',$3)`,
      [vendorId, A.entityId, A.userId]
    );
    const pagoId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, payment_date, status, created_by)
       VALUES ($1,$2,'P-CHK',$3,100,'MXN','check','9999','2026-04-01','completed',$4)`,
      [pagoId, A.entityId, vendorId, A.userId]
    );
    await expect(
      query(`UPDATE vendor_payments SET check_cleared_date = '2026-04-10' WHERE id = $1`, [pagoId])
    ).rejects.toThrow(/pago_cheque_cobro_coherente/);
  });
});

// ============================================================
// 2 · EL MES DEL COBRO — EL ATAQUE MÁS MEXICANO
//
// Cheque firmado en ENERO, cobrado en MARZO. El asiento tiene que caer en
// marzo. Si cae en enero o en «hoy», el módulo fiscal calcula mal el IVA
// mensual de toda empresa que pague con cheques — y el asiento CUADRA igual.
// ============================================================
describe('ataque: el cheque de enero cobrado en marzo', () => {
  let pagoId: string;
  let gastoId: string;
  let movDelCobro: string;

  beforeAll(async () => {
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-IVA','Proveedor PPD','MXN',$3)`,
      [vendorId, A.entityId, A.userId]
    );

    // EL GASTO, PPD y con IVA aparcado en 1135 por su propio asiento. `terms`
    // dice PPD porque es la señal que `decideMetodoPago` lee cuando no hay
    // CFDI timbrado detrás, y sin PPD no hay nada aparcado que liberar.
    gastoId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
         total_amount, currency_code, bill_date, due_date, status, amount_due, terms, created_by)
       VALUES ($1,$2,'B-ENE',$3,1000,160,1160,'MXN','2026-01-05','2026-02-05','posted',1160,'PPD',$4)`,
      [gastoId, A.entityId, vendorId, A.userId]
    );

    // El asiento del gasto: el IVA a 1135, que es lo que `ivaStillParked` lee
    // como tope. Lo que se ataca es el mes del COBRO, no el alta del gasto.
    await asientoDelGasto(A, gastoId, '2026-01-05', 'B-ENE');

    // EL CHEQUE: firmado el 15 de ENERO.
    pagoId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,'P-ENE',$3,1160,'MXN','check','1001',$4,'2026-01-15','completed',$5)`,
      [pagoId, A.entityId, vendorId, cuentaA, A.userId]
    );
    await query(
      `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied)
       VALUES ($1,$2,$3,1160)`,
      [uuidv4(), pagoId, gastoId]
    );

    // EL BANCO LO PAGA EL 10 DE MARZO.
    movDelCobro = await mov(cuentaA, '2026-03-10', '-1160', 'debit', 'cheque 1001');
  });

  it('el asiento cae en MARZO, que es cuando el banco pagó, y no en enero ni hoy', async () => {
    const r = await conciliarCheque(A.entityId, pagoId, { userId: A.userId });

    expect(r.fechaDeCobro).toBe('2026-03-10');
    expect(r.movimiento.id).toBe(movDelCobro);
    expect(r.periodo?.nombre).toBe('Periodo 3/2026');
    expect(r.reclasificado).toBe('160.0000');
    expect(r.entryId).not.toBeNull();

    const asiento = await asientoPorOrigen(A.entityId, 'bank_check_clearing', pagoId);
    expect(asiento).not.toBeNull();
    // LO QUE ESTA PRUEBA EXISTE PARA IMPEDIR: la fecha del asiento.
    expect(asiento?.fecha).toBe('2026-03-10');
    expect(asiento?.status).toBe('posted');

    // Y EL PERIODO FISCAL del asiento es el de marzo, no el de enero: la fecha
    // sola no basta si el asiento se colgó del periodo equivocado.
    const periodo = await query<{ period_number: number }>(
      `SELECT p.period_number FROM journal_entries je
         JOIN fiscal_periods p ON p.id = je.fiscal_period_id
        WHERE je.id = $1`,
      [asiento?.id]
    );
    expect(periodo.rows[0].period_number).toBe(3);
  });

  it('el importe sale del tope de 1135 y va de 1135 a 1130, no al revés', async () => {
    const asiento = await asientoPorOrigen(A.entityId, 'bank_check_clearing', pagoId);
    const lineas = asiento?.lineas ?? [];
    expect(descuadre(lineas)).toBe('0.0000');

    const codigoAcreditable = (
      await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
        A.roles.iva_acreditable,
      ])
    ).rows[0].code;
    const codigoPendiente = (
      await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
        A.roles.iva_pendiente_acreditar,
      ])
    ).rows[0].code;

    // 1130 se LLENA con un cargo y 1135 se VACÍA con un abono. Invertirlo
    // cuadra igual de bien y deja las dos cuentas del revés.
    expect(importeEn(lineas, codigoAcreditable)?.debit).toBe('160.0000');
    expect(importeEn(lineas, codigoPendiente)?.credit).toBe('160.0000');
    // Y no hay ninguna otra cuenta de por medio: el importe sale del tope de
    // 1135 del gasto, no de una cuenta propia de este comando.
    expect(lineas).toHaveLength(2);
  });

  it('el cobro queda escrito con sus dos columnas juntas', async () => {
    const bd = await query<{ d: string | null; tx: string | null }>(
      `SELECT check_cleared_date::text AS d, check_cleared_tx_id AS tx
         FROM vendor_payments WHERE id = $1`,
      [pagoId]
    );
    expect(bd.rows[0].d).toBe('2026-03-10');
    expect(bd.rows[0].tx).toBe(movDelCobro);
  });

  it('un cheque ya cobrado NO se reclasifica dos veces', async () => {
    await expect(conciliarCheque(A.entityId, pagoId, { userId: A.userId })).rejects.toThrow(
      /ya consta cobrado/
    );
    const n = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type = 'bank_check_clearing' AND source_id = $2`,
      [A.entityId, pagoId]
    );
    expect(n.rows[0].n).toBe('1');
  });

  it('el mismo cargo del banco no puede cobrar un segundo cheque', async () => {
    const otro = uuidv4();
    const vendorId = (
      await query<{ id: string }>(`SELECT vendor_id AS id FROM vendor_payments WHERE id = $1`, [
        pagoId,
      ])
    ).rows[0].id;
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,'P-ENE-2',$3,1160,'MXN','check','1002',$4,'2026-01-15','completed',$5)`,
      [otro, A.entityId, vendorId, cuentaA, A.userId]
    );
    await expect(
      conciliarCheque(A.entityId, otro, { transactionId: movDelCobro, userId: A.userId })
    ).rejects.toThrow(/ya consta como el cobro/);
  });
});

// ============================================================
// 2-bis · EL COBRO DEL DÍA 1, QUE ES DONDE EL DÍA SE VUELVE MES
//
// Un desplazamiento de un día en la fecha del asiento sólo se nota cuando cae
// sobre el primero de un mes: ahí deja de ser un día y pasa a ser la
// declaración mensual de IVA equivocada, que es exactamente lo que la fila 1271
// existe para impedir.
// ============================================================
describe('ataque: el cheque cobrado el día 1', () => {
  it('el asiento cae en el mes del cobro, no en el anterior', async () => {
    const cuenta = await nuevaCuenta(A, 'Cobro del dia uno');
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-DIA1','Proveedor dia uno','MXN',$3)`,
      [vendorId, A.entityId, A.userId]
    );
    const gastoId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
         total_amount, currency_code, bill_date, due_date, status, amount_due, terms, created_by)
       VALUES ($1,$2,'B-DIA1',$3,1000,160,1160,'MXN','2026-05-05','2026-06-05','posted',1160,'PPD',$4)`,
      [gastoId, A.entityId, vendorId, A.userId]
    );
    await asientoDelGasto(A, gastoId, '2026-05-05', 'B-DIA1');

    const pagoId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,'P-DIA1',$3,1160,'MXN','check','1500',$4,'2026-05-20','completed',$5)`,
      [pagoId, A.entityId, vendorId, cuenta, A.userId]
    );
    await query(
      `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied)
       VALUES ($1,$2,$3,1160)`,
      [uuidv4(), pagoId, gastoId]
    );
    // EL BANCO LO PAGA EL PRIMERO DE JUNIO.
    await mov(cuenta, '2026-06-01', '-1160', 'debit', 'cheque 1500');

    const r = await conciliarCheque(A.entityId, pagoId, { userId: A.userId });
    expect(r.fechaDeCobro).toBe('2026-06-01');
    expect(r.periodo?.nombre).toBe('Periodo 6/2026');

    const asiento = await asientoPorOrigen(A.entityId, 'bank_check_clearing', pagoId);
    // LA FECHA DEL ASIENTO ES LA DEL COBRO, y su periodo es JUNIO. Un día de
    // corrimiento aquí manda el IVA a la declaración de mayo.
    expect(asiento?.fecha).toBe('2026-06-01');
    const periodo = await query<{ period_number: number }>(
      `SELECT p.period_number FROM journal_entries je
         JOIN fiscal_periods p ON p.id = je.fiscal_period_id
        WHERE je.id = $1`,
      [asiento?.id]
    );
    expect(periodo.rows[0].period_number).toBe(6);
  });
});

// ============================================================
// 3 · DINERO Y SIGNO: LOS DOS ASIENTOS DE TESORERÍA
// ============================================================
describe('ataque: la comisión y el interés', () => {
  let movComision: string;
  let movInteres: string;

  beforeAll(async () => {
    movComision = await mov(cuentaA, '2026-05-12', '-348.0000', 'fee', 'manejo de cuenta');
    movInteres = await mov(cuentaA, '2026-05-31', '850.0000', 'interest', 'intereses del mes');
  });

  it('la comisión: 300 a 6310, 48 a 1135 (NUNCA a 1130) y 348 al banco', async () => {
    const r = await contabilizarComisiones(A.entityId, cuentaA, {
      periodo: '2026-05',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(r.contabilizadas).toHaveLength(1);
    expect(r.contabilizadas[0].base).toBe('300.0000');
    expect(r.contabilizadas[0].iva).toBe('48.0000');

    const asiento = await asientoPorOrigen(A.entityId, 'bank_fee', movComision);
    const lineas = asiento?.lineas ?? [];
    expect(descuadre(lineas)).toBe('0.0000');

    const codigo = async (id: string): Promise<string> =>
      (await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [id])).rows[0].code;
    expect(importeEn(lineas, await codigo(A.roles.comision_bancaria))?.debit).toBe('300.0000');
    // EL IVA A 1135 Y NO A 1130: sin CFDI del banco no hay acreditamiento.
    expect(importeEn(lineas, await codigo(A.roles.iva_pendiente_acreditar))?.debit).toBe('48.0000');
    expect(importeEn(lineas, await codigo(A.roles.iva_acreditable))).toBeUndefined();
    expect(importeEn(lineas, await codigo(glA))?.credit).toBe('348.0000');
  });

  it('el interés se reconoce BRUTO: 1000 a 4310, 150 a 1145 y 850 al banco', async () => {
    const r = await contabilizarIntereses(A.entityId, cuentaA, {
      periodo: '2026-05',
      retencion: { modo: 'tasa', tasa: '0.15' },
      userId: A.userId,
    });
    expect(r.contabilizados).toHaveLength(1);
    expect(r.contabilizados[0].bruto).toBe('1000.0000');
    expect(r.contabilizados[0].retencion).toBe('150.0000');
    expect(r.contabilizados[0].neto).toBe('850.0000');

    const asiento = await asientoPorOrigen(A.entityId, 'bank_interest', movInteres);
    const lineas = asiento?.lineas ?? [];
    expect(descuadre(lineas)).toBe('0.0000');

    const codigo = async (id: string): Promise<string> =>
      (await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [id])).rows[0].code;
    // BRUTO al ingreso, y la retención como ACTIVO (1145). La versión de dos
    // líneas —banco contra 4310 por el neto— cuadra igual y pierde el ISR.
    expect(importeEn(lineas, await codigo(A.roles.producto_financiero))?.credit).toBe('1000.0000');
    expect(importeEn(lineas, await codigo(A.roles.isr_retenido_a_favor))?.debit).toBe('150.0000');
    expect(importeEn(lineas, await codigo(glA))?.debit).toBe('850.0000');
  });

  it('no se contabiliza dos veces el mismo cargo ni el mismo abono', async () => {
    const otra = await contabilizarComisiones(A.entityId, cuentaA, {
      periodo: '2026-05',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(otra.contabilizadas).toHaveLength(0);
    expect(otra.omitidas[0].motivo).toBe('ya-contabilizada');

    const n = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND source_type IN ('bank_fee','bank_interest')`,
      [A.entityId]
    );
    expect(n.rows[0].n).toBe('2');
  });

  it('un cargo con el signo al revés NO se voltea en silencio', async () => {
    await mov(cuentaA, '2026-06-03', '120.0000', 'fee', 'devolucion de comision');
    const r = await contabilizarComisiones(A.entityId, cuentaA, {
      periodo: '2026-06',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(r.contabilizadas).toHaveLength(0);
    expect(r.omitidas[0].motivo).toBe('signo-contrario');
  });

  it('el cargo y el abono del día 1 se fechan el día 1, y en SU periodo', async () => {
    // La misma clase de defecto que el cheque: la medianoche UTC de un `Date`
    // se serializa en la zona del proceso y, al oeste de Greenwich, retrocede
    // un día. El primero de mes es donde un día se vuelve un MES: la comisión
    // de julio caería en el gasto de junio y el interés de enero, en el
    // ejercicio anterior —con folio del ejercicio anterior—.
    const suya = await nuevaCuenta(A, 'Dia uno tesoreria');
    const comision = await mov(suya, '2026-07-01', '-116', 'fee', 'comision del dia uno');
    const interes = await mov(suya, '2026-07-01', '100', 'interest', 'interes del dia uno');

    await contabilizarComisiones(A.entityId, suya, {
      periodo: '2026-07',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    await contabilizarIntereses(A.entityId, suya, {
      periodo: '2026-07',
      retencion: { modo: 'sin-retencion' },
      userId: A.userId,
    });

    for (const [origen, movId] of [
      ['bank_fee', comision],
      ['bank_interest', interes],
    ] as const) {
      const asiento = await asientoPorOrigen(A.entityId, origen, movId);
      expect(asiento?.fecha).toBe('2026-07-01');
      const periodo = await query<{ period_number: number }>(
        `SELECT p.period_number FROM journal_entries je
           JOIN fiscal_periods p ON p.id = je.fiscal_period_id
          WHERE je.id = $1`,
        [asiento?.id]
      );
      expect(periodo.rows[0].period_number).toBe(7);
    }
  });

  it('el mayor es inmutable: los asientos de tesorería no se editan ni se borran', async () => {
    const asiento = await asientoPorOrigen(A.entityId, 'bank_fee', movComision);
    await expect(
      query(`UPDATE journal_entries SET description = 'otra cosa' WHERE id = $1`, [asiento?.id])
    ).rejects.toThrow();
    await expect(
      query(`DELETE FROM journal_entries WHERE id = $1`, [asiento?.id])
    ).rejects.toThrow();
    // Y de una línea posteada sólo se tocan las tres columnas del sello.
    await expect(
      query(
        `UPDATE journal_entry_lines SET debit_amount = 1 WHERE journal_entry_id = $1`,
        [asiento?.id]
      )
    ).rejects.toThrow();
  });
});

// ============================================================
// 3-bis · LOS DOS CAMINOS QUE LLEGAN AL MISMO CARGO
//
// `bank fee post` y `bank reconciliation post` contabilizan comisiones por vías
// distintas y con `source_type` distintos, así que la idempotencia por
// (source_type, source_id) no ve a la otra. Lo único que ata el cargo ya
// contabilizado con su renglón del extracto es el COTEJO, y `bank fee post` no
// lo escribe: lo escribe `bank match run` después. Estas dos pruebas fijan las
// dos caras de eso.
// ============================================================
describe('ataque: contabilizar el mismo cargo por los dos caminos', () => {
  async function mesConComisionContabilizada(nombre: string): Promise<{
    cuenta: string;
    sesionId: string;
  }> {
    const cuenta = await nuevaCuenta(A, nombre);
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-12-01','2026-12-31',0,-348,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, uuidv4().replace(/-/g, '').padEnd(64, '9'), A.userId]
    );
    await mov(cuenta, '2026-12-04', '-348', 'fee', 'comision de diciembre', extracto);

    const porTesoreria = await contabilizarComisiones(A.entityId, cuenta, {
      periodo: '2026-12',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(porTesoreria.contabilizadas).toHaveLength(1);

    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-12' },
      { userId: A.userId }
    );
    return { cuenta, sesionId: abierta.sesionId };
  }

  it('con el cotejo hecho, el cargo ya contabilizado NO se levanta como partida', async () => {
    const { cuenta, sesionId } = await mesConComisionContabilizada('Doble camino cotejado');
    const cotejo = await correrCotejo(
      entityScope(A.tenantId, A.entityId),
      { cuentaId: cuenta, desde: '2026-12-01', hasta: '2026-12-31', sesionId },
      { userId: A.userId }
    );
    // El motor ya no tiene nada que hacer aquí: `bank fee post` ató el
    // movimiento al contabilizarlo. Antes hacía falta correrlo —y era la ÚNICA
    // defensa contra el doble conteo—; ahora es redundante, que es exactamente
    // lo que se quería.
    expect(cotejo.aplicados).toHaveLength(0);

    await clasificarPartidasDeSesion(entityScope(A.tenantId, A.entityId), sesionId, {
      userId: A.userId,
    });
    const vivo = await estadoDeSesion(entityScope(A.tenantId, A.entityId), { sesionId });
    expect(vivo.partidas).toHaveLength(0);
    expect(vivo.aritmetica.variacion).toBe('0.00');
    expect(vivo.listaParaCerrar).toBe(true);
  });

  it('el cargo contabilizado ya NO se levanta dos veces, ni sin correr el motor', async () => {
    const { sesionId } = await mesConComisionContabilizada('Doble camino sin cotejar');
    await clasificarPartidasDeSesion(entityScope(A.tenantId, A.entityId), sesionId, {
      userId: A.userId,
    });
    const vivo = await estadoDeSesion(entityScope(A.tenantId, A.entityId), { sesionId });

    // ESTE CASO NACIÓ FIJANDO EL DEFECTO Y AHORA FIJA SU ARREGLO. El
    // movimiento salía como `cargo-del-banco` del lado de LIBROS —«está en el
    // banco y no en libros», que era falso: `bank fee post` ya lo había
    // puesto— y la línea de banco del mismo asiento salía como
    // `cheque-en-circulacion` del lado del BANCO. Las dos eran el MISMO hecho
    // contado dos veces, se anulaban, y la sesión informaba variación cero: un
    // ajuste sobre la primera contabilizaba la comisión OTRA VEZ y la sesión
    // seguía cuadrando, porque la segunda partida absorbía el desvío.
    //
    // La única defensa era acordarse de correr `bank match run` antes de
    // clasificar. Ahora `bank fee post` ata el movimiento a la línea que acaba
    // de crear —como ya hacía `contabilizarSesion`—, así que el defecto no
    // depende de que alguien recuerde un paso.
    expect(
      vivo.partidas,
      'el cargo ya está explicado en libros: no es partida conciliatoria de ningún lado'
    ).toHaveLength(0);
    expect(vivo.aritmetica.variacion).toBe('0.00');
  });
});

// ============================================================
// 3-ter · LO QUE NO SE POSTEA CON OTRA FECHA
//
// El periodo cerrado es la tentación exacta de este tramo: el asiento cuadraría
// igual fechado en otro mes, y el que lo descubre es el módulo fiscal tres
// meses después.
// ============================================================
describe('ataque: el periodo cerrado y la fecha declarada', () => {
  let cuenta: string;
  let vendorId: string;

  beforeAll(async () => {
    cuenta = await nuevaCuenta(A, 'Periodo cerrado');
    vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-CERR','Proveedor cerrado','MXN',$3)`,
      [vendorId, A.entityId, A.userId]
    );
  });

  /** Un gasto PPD con su IVA aparcado en 1135 y su cheque, sin cobrar todavía. */
  async function chequePendiente(
    sufijo: string,
    mesDelGasto: number,
    fechaDelCheque: string
  ): Promise<string> {
    const gastoId = uuidv4();
    const mm = String(mesDelGasto).padStart(2, '0');
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
         total_amount, currency_code, bill_date, due_date, status, amount_due, terms, created_by)
       VALUES ($1,$2,$3,$4,1000,160,1160,'MXN',$5::date,$5::date,'posted',1160,'PPD',$6)`,
      [gastoId, A.entityId, `B-${sufijo}`, vendorId, `2026-${mm}-05`, A.userId]
    );
    await asientoDelGasto(A, gastoId, `2026-${mm}-05`, `B-${sufijo}`);
    const pagoId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,$3,$4,1160,'MXN','check',$5,$6,$7::date,'completed',$8)`,
      [pagoId, A.entityId, `P-${sufijo}`, vendorId, sufijo, cuenta, fechaDelCheque, A.userId]
    );
    await query(
      `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied)
       VALUES ($1,$2,$3,1160)`,
      [uuidv4(), pagoId, gastoId]
    );
    return pagoId;
  }

  it('un cobro en periodo cerrado se RECHAZA y no deja el cobro escrito a medias', async () => {
    const pagoId = await chequePendiente('7001', 2, '2026-02-10');
    await mov(cuenta, '2026-04-20', '-1160', 'debit', 'cheque 7001');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [A.periodos[4]]);

    await expect(conciliarCheque(A.entityId, pagoId, { userId: A.userId })).rejects.toThrow(
      /PERTENECE al mes del cobro/
    );

    // NI EL ASIENTO NI EL COBRO: el acto es uno solo. Escribir el cobro sin
    // reclasificar dejaría el pago diciendo que el cheque se cobró y el mayor
    // sin el IVA, que es el descuadre que este comando existe para no producir.
    const bd = await query<{ d: string | null; tx: string | null }>(
      `SELECT check_cleared_date::text AS d, check_cleared_tx_id AS tx
         FROM vendor_payments WHERE id = $1`,
      [pagoId]
    );
    expect(bd.rows[0].d).toBeNull();
    expect(bd.rows[0].tx).toBeNull();
    expect(await asientoPorOrigen(A.entityId, 'bank_check_clearing', pagoId)).toBeNull();

    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [A.periodos[4]]);
  });

  it('`--as-of` no impone la fecha: si discrepa del banco, se rechaza', async () => {
    const pagoId = await chequePendiente('7002', 2, '2026-02-10');
    const suyo = await mov(cuenta, '2026-04-21', '-1160', 'debit', 'cheque 7002');

    await expect(
      conciliarCheque(A.entityId, pagoId, {
        transactionId: suyo,
        asOf: '2026-02-28',
        userId: A.userId,
      })
    ).rejects.toThrow(/La fecha del cobro la pone el movimiento/);

    const bd = await query<{ tx: string | null }>(
      `SELECT check_cleared_tx_id AS tx FROM vendor_payments WHERE id = $1`,
      [pagoId]
    );
    expect(bd.rows[0].tx).toBeNull();
  });

  it('un cheque no se cobra antes de existir', async () => {
    const pagoId = await chequePendiente('7003', 2, '2026-04-25');
    const anterior = await mov(cuenta, '2026-02-01', '-1160', 'debit', 'otro cargo igual');
    await expect(
      conciliarCheque(A.entityId, pagoId, { transactionId: anterior, userId: A.userId })
    ).rejects.toThrow(/no se cobra antes de existir/);
  });

  it('una comisión en periodo cerrado se OMITE con su motivo, no se postea a la fuerza', async () => {
    const suya = await nuevaCuenta(A, 'Comision en cerrado');
    await mov(suya, '2026-02-14', '-116', 'fee', 'comision de febrero');
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [A.periodos[2]]);

    const r = await contabilizarComisiones(A.entityId, suya, {
      periodo: '2026-02',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(r.contabilizadas).toHaveLength(0);
    expect(r.omitidas[0].motivo).toBe('periodo-cerrado');

    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [A.periodos[2]]);
  });

  it('los CUATRO decimales de la columna llegan enteros al asiento', async () => {
    const suya = await nuevaCuenta(A, 'Cuatro decimales');
    const movId = await mov(suya, '2026-02-18', '-348.1234', 'fee', 'comision con centesimas');
    const r = await contabilizarComisiones(A.entityId, suya, {
      periodo: '2026-02',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: A.userId,
    });
    expect(r.contabilizadas[0].total).toBe('348.1234');
    // base + IVA = total EXACTO. Recortar a dos decimales aquí fue el defecto
    // que F05a cazó tres veces.
    expect(
      new Decimal(r.contabilizadas[0].base).plus(r.contabilizadas[0].iva).toFixed(4)
    ).toBe('348.1234');

    const asiento = await asientoPorOrigen(A.entityId, 'bank_fee', movId);
    expect(descuadre(asiento?.lineas ?? [])).toBe('0.0000');
    const glDeEsa = (
      await query<{ code: string }>(
        `SELECT a.code FROM bank_accounts b JOIN accounts a ON a.id = b.gl_account_id
          WHERE b.id = $1`,
        [suya]
      )
    ).rows[0].code;
    expect(importeEn(asiento?.lineas ?? [], glDeEsa)?.credit).toBe('348.1234');
  });
});

// ============================================================
// 4 · FUGA ENTRE ENTIDADES DEL MISMO INQUILINO
//
// El eje que RLS NO defiende: dos sociedades de una misma holding. Van tres
// fugas cerradas en este módulo; ésta busca la cuarta.
// ============================================================
describe('ataque: la entidad hermana', () => {
  let sesionDeB: string;
  let pagoDeB: string;
  let movDeB: string;

  beforeAll(async () => {
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-07-01','2026-07-31',0,0,'MXN','csv',$4,$5)`,
      [extracto, B.entityId, cuentaB, 'b'.repeat(64), B.userId]
    );
    const abierta = await abrirSesion(
      entityScope(A.tenantId, B.entityId),
      { cuenta: cuentaB, periodo: '2026-07' },
      { userId: B.userId }
    );
    sesionDeB = abierta.sesionId;
    await cerrarSesion(entityScope(A.tenantId, B.entityId), sesionDeB, {}, { userId: B.userId });

    const vendorB = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-B','Proveedor de B','MXN',$3)`,
      [vendorB, B.entityId, B.userId]
    );
    pagoDeB = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,'P-B',$3,500,'MXN','check','2001',$4,'2026-07-01','completed',$5)`,
      [pagoDeB, B.entityId, vendorB, cuentaB, B.userId]
    );
    movDeB = await mov(cuentaB, '2026-07-20', '-500', 'debit', 'cheque 2001 de B');
  });

  it('A no puede firmar la sesión de B: 404 y no 403', async () => {
    await expect(
      aprobarSesion(entityScope(A.tenantId, A.entityId), sesionDeB, {}, { userId: firmante })
    ).rejects.toThrow(/not found|no encontr/i);
  });

  it('A no puede contabilizar la sesión de B', async () => {
    await expect(
      contabilizarSesion(entityScope(A.tenantId, A.entityId), sesionDeB, {}, { userId: firmante })
    ).rejects.toThrow(/not found|no encontr/i);
  });

  it('A no puede conciliar el cheque de B', async () => {
    await expect(conciliarCheque(A.entityId, pagoDeB, { userId: A.userId })).rejects.toThrow(
      /not found|no encontr/i
    );
  });

  it('A no puede atar su cheque a un movimiento de la cuenta de B', async () => {
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, currency_code, created_by)
       VALUES ($1,$2,'V-CRUCE','Proveedor cruce','MXN',$3)`,
      [vendorId, A.entityId, A.userId]
    );
    const pagoA = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
         currency_code, payment_method, check_number, bank_account_id, payment_date, status, created_by)
       VALUES ($1,$2,'P-CRUCE',$3,500,'MXN','check','3001',$4,'2026-07-01','completed',$5)`,
      [pagoA, A.entityId, vendorId, cuentaA, A.userId]
    );
    await expect(
      conciliarCheque(A.entityId, pagoA, { transactionId: movDeB, userId: A.userId })
    ).rejects.toThrow(/not found|no encontr/i);

    const bd = await query<{ tx: string | null }>(
      `SELECT check_cleared_tx_id AS tx FROM vendor_payments WHERE id = $1`,
      [pagoA]
    );
    expect(bd.rows[0].tx).toBeNull();
  });

  it('A no puede contabilizar las comisiones de la cuenta de B', async () => {
    await mov(cuentaB, '2026-07-05', '-116', 'fee', 'comision de B');
    await expect(
      contabilizarComisiones(A.entityId, cuentaB, {
        periodo: '2026-07',
        iva: { modo: 'tasa', tasa: '0.16' },
        userId: A.userId,
      })
    ).rejects.toThrow(/not found|no encontr/i);

    const n = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
      [B.entityId]
    );
    expect(n.rows[0].n).toBe('0');
  });
});

// ============================================================
// 5 · EL TOPE DE LA TOLERANCIA
// ============================================================
describe('ataque: cerrar un descuadre llamándolo tolerancia', () => {
  it('el piso se combina por el MÍNIMO: lo pedido por encima del techo se acota', () => {
    expect(floorTolerancia('100')).toBe('100.0000');
    expect(floorTolerancia('500')).toBe('500.0000');
    // Por el máximo esto habría devuelto 50 000: el piso dejaría de serlo.
    expect(floorTolerancia('50000')).toBe('500.0000');
    expect(floorTolerancia('-1')).toBe('0.0000');
    expect(floorTolerancia('no es un número')).toBe('0.0000');
    // `1e400` NO es Infinity para decimal.js —su exponente llega mucho más
    // lejos que el de un float—, así que NO caía por la rama de «no finito» y
    // salía convertido en EL TECHO. Este caso quedó anotado aquí como
    // desviación del docblock («nunca el techo») y se corrigió: el criterio no
    // es la finitud sino la REPRESENTABILIDAD, porque una tolerancia es un
    // importe y los importes viven en DECIMAL(19,4).
    //
    // El cuadre falso no se abría ni antes ni ahora —`criteriosDeCierre`
    // compara lo pedido con lo acotado y rechaza la diferencia—, pero el piso
    // delegaba su propia promesa en un segundo guardia. Ahora falla cerrado él.
    expect(floorTolerancia('1e400')).toBe('0.0000');
    expect(floorTolerancia('1e15')).toBe('0.0000');
    // Y sigue distinguiendo «no es dinero» de «es mucho dinero»: un importe
    // legítimo y enorme se acota al techo, no se anula.
    expect(floorTolerancia('1e14')).toBe('500.0000');
  });

  it('una tolerancia por encima del techo se RECHAZA y no se recorta en silencio', async () => {
    await resolvePolicy(
      { tenantId: A.tenantId, entityId: A.entityId },
      'conciliacion_tolerancia',
      'tolerancia_con_residual',
      'ataque@f05d'
    );
    await expect(
      criteriosDeCierre(A.tenantId, A.entityId, '50000')
    ).rejects.toThrow(/techo irrompible/);

    const dentro = await criteriosDeCierre(A.tenantId, A.entityId, '450');
    expect(dentro.tolerancia.tolerancia).toBe('450.0000');
  });

  it('lo que se FIRMA de una sesión cerrada con tolerancia dice que SÍ cuadró', async () => {
    // ESTE CASO NACIÓ FIJANDO EL DEFECTO Y AHORA FIJA SU ARREGLO.
    //
    // La tolerancia con la que se cerraba no se guardaba en ninguna columna:
    // vivía sólo en la bandera de aquel momento. La firma volvía a leer los
    // criterios SIN ella, así que la instantánea que se congela y se sella con
    // el hash registraba tolerancia cero y «no cuadra» para una sesión que el
    // despacho había cerrado legítimamente dentro de su tolerancia.
    //
    // Ningún IMPORTE era falso y nada pasaba al mayor por esto. Lo que estaba
    // mal era la única pieza cuyo trabajo es no estarlo: el documento que
    // existe para contestar «esto es lo que se aprobó» afirmaba que la cuenta
    // no cuadraba. La 055 le dio columna, el cierre la escribe y la firma la
    // lee de la SESIÓN y no de la política — relitigar las reglas al firmar
    // permitiría además que un cambio de panel invalidara un cierre ya hecho.
    const cuenta = await nuevaCuenta(A, 'Tolerancia firmada');
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,-120,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, '7'.repeat(64), A.userId]
    );
    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-08' },
      { userId: A.userId }
    );
    const cerrada = await cerrarSesion(
      entityScope(A.tenantId, A.entityId),
      abierta.sesionId,
      { tolerancia: '150' },
      { userId: A.userId }
    );
    expect(cerrada.estado).toBe('balanced');
    expect(cerrada.aritmetica.cuadra).toBe(true);
    expect(cerrada.aritmetica.tolerancia).toBe('150.00');

    const firmada = await aprobarSesion(
      entityScope(A.tenantId, A.entityId),
      abierta.sesionId,
      {},
      { userId: firmante }
    );
    expect(firmada.instantanea.saldos.variacion).toBe('-120.00');
    expect(
      firmada.instantanea.saldos.tolerancia,
      'la instantánea guarda la tolerancia CON LA QUE SE CERRÓ, no la de hoy'
    ).toBe('150.00');
    expect(
      firmada.instantanea.saldos.cuadra,
      'y por tanto no contradice al cierre que está firmando'
    ).toBe(true);
  });

  it('un descuadre grande NO se cierra con una tolerancia grande', async () => {
    const cuenta = await nuevaCuenta(A, 'Tolerancia A');
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-09-01','2026-09-30',0,-5000,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, 'c'.repeat(64), A.userId]
    );
    await mov(cuenta, '2026-09-10', '-5000', 'debit', 'cargo sin explicar', extracto);

    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-09' },
      { userId: A.userId }
    );
    await expect(
      cerrarSesion(
        entityScope(A.tenantId, A.entityId),
        abierta.sesionId,
        { tolerancia: '5000' },
        { userId: A.userId }
      )
    ).rejects.toThrow(/techo irrompible/);

    const bd = await query<{ status: string }>(
      `SELECT status FROM reconciliation_sessions WHERE id = $1`,
      [abierta.sesionId]
    );
    expect(bd.rows[0].status).toBe('in_progress');
  });
});

// ============================================================
// 6 · LA CONTABILIZACIÓN ROTA A MITAD
//
// Lo que NO se puede deshacer: un ajuste posteado colgando de una sesión que no
// llegó a `posted`. El mayor es inmutable (041) y eso ya sólo se corrige por
// reversa.
// ============================================================
describe('ataque: romper la contabilización a mitad', () => {
  let sesion: string;
  let ajusteBueno: string;
  let cuenta: string;

  beforeAll(async () => {
    await resolvePolicy(
      { tenantId: A.tenantId, entityId: A.entityId },
      'segregacion_de_funciones',
      'off',
      'ataque@f05d'
    );

    cuenta = await nuevaCuenta(A, 'Rota a mitad');
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-31',0,-700,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, 'd'.repeat(64), A.userId]
    );
    await mov(cuenta, '2026-10-05', '-300', 'debit', 'comision uno', extracto);
    await mov(cuenta, '2026-10-06', '-400', 'debit', 'comision dos', extracto);

    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-10' },
      { userId: A.userId }
    );
    sesion = abierta.sesionId;
    await clasificarPartidasDeSesion(entityScope(A.tenantId, A.entityId), sesion, {
      userId: A.userId,
    });
    const partidas = await query<{ id: string; importe: string }>(
      `SELECT id, importe::text AS importe FROM reconciling_items
        WHERE reconciliation_session_id = $1 ORDER BY importe`,
      [sesion]
    );
    await query(
      `UPDATE reconciling_items SET fecha_esperada = '2026-11-15', responsable = 'tesoreria'
        WHERE reconciliation_session_id = $1`,
      [sesion]
    );

    const codigoComision = (
      await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
        A.roles.comision_bancaria,
      ])
    ).rows[0].code;

    const primero = await crearAjuste(
      A.entityId,
      sesion,
      { tipo: 'comision', cuenta: codigoComision, importe: '-300.00' },
      A.userId,
      { reconcilingItemId: partidas.rows.find((p) => p.importe.startsWith('-300'))?.id }
    );
    ajusteBueno = primero.id;
    const segundo = await crearAjuste(
      A.entityId,
      sesion,
      { tipo: 'comision', cuenta: codigoComision, importe: '-400.00' },
      A.userId,
      { reconcilingItemId: partidas.rows.find((p) => p.importe.startsWith('-400'))?.id }
    );

    await cerrarSesion(entityScope(A.tenantId, A.entityId), sesion, {}, { userId: A.userId });
    await aprobarSesion(entityScope(A.tenantId, A.entityId), sesion, {}, { userId: firmante });

    // Y AHORA SE ROMPE EL SEGUNDO, después de la firma: su borrador se marca
    // RECHAZADO, que es la situación real —alguien lo rechazó en `review`
    // mientras la sesión esperaba— y la que hace fallar el acto a mitad.
    await query(`UPDATE ai_drafts SET status = 'rejected' WHERE id = $1`, [segundo.draftId]);
  });

  it('el acto entero se cae y NO deja ningún asiento posteado', async () => {
    const antes = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
      [A.entityId]
    );
    await expect(
      contabilizarSesion(entityScope(A.tenantId, A.entityId), sesion, {}, { userId: firmante })
    ).rejects.toThrow(/RECHAZADO/);

    const despues = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
      [A.entityId]
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('la sesión sigue en `approved` y ningún ajuste quedó con asiento', async () => {
    const bd = await query<{ status: string; posted_at: string | null }>(
      `SELECT status, posted_at::text AS posted_at FROM reconciliation_sessions WHERE id = $1`,
      [sesion]
    );
    expect(bd.rows[0].status).toBe('approved');
    expect(bd.rows[0].posted_at).toBeNull();

    const conAsiento = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM reconciliation_adjustments
        WHERE reconciliation_session_id = $1 AND journal_entry_id IS NOT NULL`,
      [sesion]
    );
    expect(conAsiento.rows[0].n).toBe('0');

    // Y el borrador del ajuste bueno tampoco se cerró a medias.
    const borrador = await query<{ status: string }>(
      `SELECT d.status FROM ai_drafts d
         JOIN reconciliation_adjustments ra ON ra.draft_id = d.id
        WHERE ra.id = $1`,
      [ajusteBueno]
    );
    expect(borrador.rows[0].status).toBe('pending_review');
  });
});

// ============================================================
// 7 · FIRMAR Y DESPUÉS CAMBIAR
//
// La instantánea sólo vale si un cambio posterior se NOTA. Y los miembros de
// una sesión firmada no se pueden mover por los verbos del módulo.
// ============================================================
describe('ataque: cambiar lo que ya se firmó', () => {
  let sesion: string;
  let hashFirmado: string;

  beforeAll(async () => {
    const cuenta = await nuevaCuenta(A, 'Firmada y movida');
    const extracto = uuidv4();
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-11-01','2026-11-30',0,-250,'MXN','csv',$4,$5)`,
      [extracto, A.entityId, cuenta, 'e'.repeat(64), A.userId]
    );
    await mov(cuenta, '2026-11-08', '-250', 'debit', 'comision de noviembre', extracto);

    const abierta = await abrirSesion(
      entityScope(A.tenantId, A.entityId),
      { cuenta, periodo: '2026-11' },
      { userId: A.userId }
    );
    sesion = abierta.sesionId;
    await clasificarPartidasDeSesion(entityScope(A.tenantId, A.entityId), sesion, {
      userId: A.userId,
    });
    await query(
      `UPDATE reconciling_items SET fecha_esperada = '2026-12-15', responsable = 'tesoreria'
        WHERE reconciliation_session_id = $1`,
      [sesion]
    );
    const codigoComision = (
      await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
        A.roles.comision_bancaria,
      ])
    ).rows[0].code;
    const partida = (
      await query<{ id: string }>(
        `SELECT id FROM reconciling_items WHERE reconciliation_session_id = $1`,
        [sesion]
      )
    ).rows[0].id;
    await crearAjuste(
      A.entityId,
      sesion,
      { tipo: 'comision', cuenta: codigoComision, importe: '-250.00' },
      A.userId,
      { reconcilingItemId: partida }
    );
    await cerrarSesion(entityScope(A.tenantId, A.entityId), sesion, {}, { userId: A.userId });
    const firmada = await aprobarSesion(
      entityScope(A.tenantId, A.entityId),
      sesion,
      {},
      { userId: firmante }
    );
    hashFirmado = firmada.hash;
  });

  it('un ajuste nuevo no entra en una sesión ya firmada', async () => {
    const codigoComision = (
      await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
        A.roles.comision_bancaria,
      ])
    ).rows[0].code;
    await expect(
      crearAjuste(
        A.entityId,
        sesion,
        { tipo: 'comision', cuenta: codigoComision, importe: '-999.00' },
        A.userId,
        {}
      )
    ).rejects.toThrow(/no admite ajustes nuevos/);
  });

  it('si la partida se mueve POR DEBAJO del servicio, el hash lo delata', async () => {
    // Se altera la fila directamente, que es la única forma de cambiar un
    // miembro firmado: los verbos del módulo ya se niegan. Si al reconstruir la
    // instantánea desde el estado vivo el hash siguiera casando, la firma no
    // estaría firmando nada.
    await query(
      `UPDATE reconciling_items SET importe = importe - 100
        WHERE reconciliation_session_id = $1`,
      [sesion]
    );

    const fila = await query<{
      id: string; entity_id: string; bank_account_id: string; statement_id: string | null;
      start_date: string; end_date: string; currency_code: string;
    }>(
      `SELECT s.id, s.entity_id, s.bank_account_id, s.statement_id,
              s.start_date::text AS start_date, s.end_date::text AS end_date,
              ba.currency_code
         FROM reconciliation_sessions s
         JOIN bank_accounts ba ON ba.id = s.bank_account_id
        WHERE s.id = $1`,
      [sesion]
    );
    const vivo = await estadoDeSesion(entityScope(A.tenantId, A.entityId), {
      sesionId: sesion,
    });
    const rehecha = construirInstantanea({
      sesion: {
        id: fila.rows[0].id,
        entityId: fila.rows[0].entity_id,
        bankAccountId: fila.rows[0].bank_account_id,
        statementId: fila.rows[0].statement_id,
        desde: fila.rows[0].start_date,
        hasta: fila.rows[0].end_date,
        moneda: fila.rows[0].currency_code,
      },
      aritmetica: vivo.aritmetica,
      congelado: vivo.congelado,
      partidas: vivo.partidas,
      cotejos: [],
      ajustes: vivo.ajustes,
    });
    expect(hashDeInstantanea(rehecha)).not.toBe(hashFirmado);

    // Y la instantánea GUARDADA sigue diciendo lo que se firmó, con su hash
    // intacto: es lo que permite contestar «¿esto es lo que se aprobó?».
    const bd = await query<{ snap: Parameters<typeof hashDeInstantanea>[0]; hash: string }>(
      `SELECT approval_snapshot AS snap, approval_hash AS hash
         FROM reconciliation_sessions WHERE id = $1`,
      [sesion]
    );
    expect(hashDeInstantanea(bd.rows[0].snap)).toBe(bd.rows[0].hash);
    expect(bd.rows[0].snap.miembros.partidas[0].importe).toBe('-250.00');
  });
});
