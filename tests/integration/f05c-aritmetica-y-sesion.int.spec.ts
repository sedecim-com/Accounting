import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  abrirSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  estadoDeSesion,
  listarSesiones,
  correrConciliacion,
} from '../../src/services/banking/reconciliation-service.js';

/**
 * F05c · LA ARITMÉTICA Y LA SESIÓN, CONTRA POSTGRES.
 *
 * `reconciliation-math.spec.ts` prueba la resta sin base de datos, y por eso
 * puede escribir el caso incómodo en cuatro líneas. Lo que ESE archivo no
 * puede probar es lo que sólo existe cuando hay filas: que el saldo de libros
 * sale de las líneas posteadas contra la cuenta de mayor de ESTA cuenta
 * bancaria, que el saldo de banco sale del extracto atado y no de la columna,
 * que `close` escribe `arithmetic_computed_at` en la misma sentencia que el
 * estado —el CHECK de la 053 no admite otra cosa— y que el pase guiado
 * encadena los cinco pasos y se detiene.
 *
 * `banco-sesion-invariantes.int.spec.ts` prueba el guardia desde la BASE: que
 * el UPDATE histórico ya no es representable. Éste prueba el camino de arriba:
 * que el servicio que sí puede llegar a `balanced` sólo llega cuando la cuenta
 * de verdad cuadra.
 */

let f: Fixture;
let cuenta: string;
let glBanco: string;
let estadoId: string;

async function movimiento(fecha: string, importe: string, desc: string, matched: boolean): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)`,
    [id, cuenta, fecha, importe, Number(importe) < 0 ? 'debit' : 'credit', desc, matched, estadoId]
  );
  return id;
}

async function lineaDeBanco(fecha: string, importe: string, lado: 'debit' | 'credit'): Promise<string> {
  const contra = f.roles.cxc ?? Object.values(f.cuentas)[0];
  const e = await withTransaction((client) =>
    createJournalEntry(
      f.entityId,
      new Date(`${fecha}T00:00:00Z`),
      JournalEntryType.STANDARD,
      `mov ${importe}`,
      lado === 'debit'
        ? [
            { account_id: glBanco, debit_amount: importe, credit_amount: null, description: 'banco' },
            { account_id: contra, debit_amount: null, credit_amount: importe, description: 'contra' },
          ]
        : [
            { account_id: glBanco, debit_amount: null, credit_amount: importe, description: 'banco' },
            { account_id: contra, debit_amount: importe, credit_amount: null, description: 'contra' },
          ],
      f.userId,
      { autoPost: true, client }
    )
  );
  return (
    await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`,
      [e.id, glBanco]
    )
  ).rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('Sonda F05c');
  glBanco = f.roles.banco ?? Object.values(f.cuentas)[0];
  cuenta = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Operativa Sonda','Banco',$3,'MXN','checking')`,
    [cuenta, f.entityId, glBanco]
  );

  estadoId = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,10000,'MXN','csv',$4,$5)`,
    [estadoId, f.entityId, cuenta, 'a'.repeat(64), f.userId]
  );

  // El depósito grande YA cotejado y la línea de libros que lo explica.
  //
  // El cotejo se escribe COMO FILA en `reconciliation_matches`, no sólo
  // poniendo `is_matched = true`: la bandera es una caché, y tanto
  // `clasificarPartidas` como `movimientosSinExplicar` preguntan por el hecho.
  // Un fixture que sólo levantara la bandera estaría probando un mundo que el
  // programa no reconoce como cotejado.
  const depositoTx = await movimiento('2026-08-05', '10200.0000', 'deposito cotejado', true);
  // La comisión que los libros no registran: cargo-del-banco de −200.
  await movimiento('2026-08-20', '-200.0000', 'comision', false);

  // Libros: 10200 sellado + 500 en tránsito − 800 en circulación = 9900.
  const sellada = await lineaDeBanco('2026-08-05', '10200.0000', 'debit');
  await query(
    `UPDATE journal_entry_lines
        SET is_reconciled = true, reconciled_at = NOW(), reconciliation_id = $2
      WHERE id = $1`,
    [sellada, uuidv4()]
  );
  await query(
    `INSERT INTO reconciliation_matches
       (id, bank_transaction_id, match_type, matched_entity_type, matched_entity_id,
        matched_amount, matched_by)
     VALUES ($1,$2,'manual','journal_entry_line',$3,10200,$4)`,
    [uuidv4(), depositoTx, sellada, f.userId]
  );
  await lineaDeBanco('2026-08-28', '500.0000', 'debit');
  await lineaDeBanco('2026-08-29', '800.0000', 'credit');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('sonda: la aritmética de dos lados contra Postgres', () => {
  let sesionId: string;

  it('open ata el extracto y saca el saldo inicial de él, no de un cero', async () => {
    const abierta = await abrirSesion(
      entityScope(f.tenantId, f.entityId),
      { cuenta, periodo: '2026-08' },
      { userId: f.userId }
    );
    sesionId = abierta.sesionId;
    expect(abierta.statementId).toBe(estadoId);
    expect(abierta.saldoInicial).toBe('0.00');
    expect(abierta.saldoFinalBanco).toBe('10000.00');
  });

  it('status recalcula VIVO y la sesión recién abierta no cuadra', async () => {
    const e = await estadoDeSesion(entityScope(f.tenantId, f.entityId), { sesionId });
    expect(e.aritmetica.banco.saldo).toBe('10000.00');
    expect(e.aritmetica.libros.saldo).toBe('9900.00');
    // Sin partidas: 10000 contra 9900.
    expect(e.aritmetica.variacion).toBe('100.00');
    expect(e.aritmetica.cuadra).toBe(false);
    expect(e.congelado.aritmeticaCalculadaEl).toBeNull();
    expect(e.congelado.variance).toBe('0.00');
  });

  it('clasificar levanta las partidas de los dos lados y la variación se va a cero', async () => {
    const c = await clasificarPartidasDeSesion(entityScope(f.tenantId, f.entityId), sesionId, {
      userId: f.userId,
    });
    expect(c.levantadas.filter((p) => p.lado === 'libros')).toHaveLength(1);
    expect(c.levantadas.filter((p) => p.lado === 'banco')).toHaveLength(2);
    // TODAS nacen sin fecha esperada: nada en el extracto ni en el mayor dice
    // cuándo se espera que un cheque se cobre.
    expect(c.sinFechaEsperada).toBe(3);

    const e = await estadoDeSesion(entityScope(f.tenantId, f.entityId), { sesionId });
    expect(e.aritmetica.banco.partidas).toEqual([
      { tipo: 'cheque-en-circulacion', importe: '-800.00' },
      { tipo: 'deposito-en-transito', importe: '500.00' },
    ]);
    expect(e.aritmetica.libros.partidas).toEqual([{ tipo: 'cargo-del-banco', importe: '-200.00' }]);
    expect(e.aritmetica.banco.ajustado).toBe('9700.00');
    expect(e.aritmetica.libros.ajustado).toBe('9700.00');
    expect(e.aritmetica.variacion).toBe('0.00');
    expect(e.aritmetica.cuadra).toBe(true);
    // Y aun así NO cierra: las partidas no tienen fecha esperada.
    expect(e.listaParaCerrar).toBe(false);
    expect(e.bloqueantes.map((r) => r.codigo)).toEqual(['partida-sin-fechar']);
  });

  it('close se NIEGA mientras haya partidas sin fechar', async () => {
    await expect(
      cerrarSesion(entityScope(f.tenantId, f.entityId), sesionId, {}, { userId: f.userId })
    ).rejects.toThrow(/partida-sin-fechar/);
    const bd = await query<{ status: string; arithmetic_computed_at: string | null }>(
      `SELECT status, arithmetic_computed_at FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('in_progress');
    expect(bd.rows[0].arithmetic_computed_at).toBeNull();
  });

  it('con las partidas fechadas, close escribe la aritmética y congela el resumen', async () => {
    await query(
      `UPDATE reconciling_items SET fecha_esperada = '2026-09-15', responsable = 'tesoreria'
        WHERE reconciliation_session_id = $1`,
      [sesionId]
    );
    const r = await cerrarSesion(
      entityScope(f.tenantId, f.entityId),
      sesionId,
      { notas: 'sonda' },
      { userId: f.userId }
    );
    expect(r.estado).toBe('balanced');
    expect(r.congelado.variance).toBe('0.00');
    expect(r.congelado.saldoLibros).toBe('9900.00');
    expect(r.congelado.chequesEnCirculacion).toBe('-800.00');
    expect(r.congelado.depositosEnTransito).toBe('500.00');
    expect(r.congelado.cargosDelBanco).toBe('-200.00');
    expect(r.congelado.aritmeticaCalculadaEl).not.toBeNull();

    const bd = await query<{ status: string; arithmetic_computed_at: string | null; variance: string }>(
      `SELECT status, arithmetic_computed_at, variance::text AS variance
         FROM reconciliation_sessions WHERE id = $1`,
      [sesionId]
    );
    expect(bd.rows[0].status).toBe('balanced');
    expect(bd.rows[0].arithmetic_computed_at).not.toBeNull();
  });

  it('cerrar dos veces no es idempotente: se rehúsa', async () => {
    await expect(
      cerrarSesion(entityScope(f.tenantId, f.entityId), sesionId, {}, { userId: f.userId })
    ).rejects.toThrow(/ya está en 'balanced'/);
  });

  it('list proyecta la variación congelada sólo cuando la aritmética consta', async () => {
    const filas = await listarSesiones(entityScope(f.tenantId, f.entityId), {});
    expect(filas).toHaveLength(1);
    expect(filas[0].varianceCongelada).toBe('0.00');
    expect(filas[0].partidasAbiertas).toBe(3);

    // Una sesión sin aritmética sale con el hueco y no con un cero.
    const otra = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-06-01','2026-06-30',0,0)`,
      [otra, cuenta, f.entityId]
    );
    const dos = await listarSesiones(entityScope(f.tenantId, f.entityId), {});
    const sinAritmetica = dos.find((x) => x.id === otra);
    expect(sinAritmetica?.varianceCongelada).toBeNull();
  });

  it('la sesión sin extracto atado no tiene variación: null, y no cierra', async () => {
    const huerfana = (
      await query<{ id: string }>(
        `SELECT id FROM reconciliation_sessions WHERE entity_id = $1 AND statement_id IS NULL`,
        [f.entityId]
      )
    ).rows[0].id;
    const e = await estadoDeSesion(entityScope(f.tenantId, f.entityId), { sesionId: huerfana });
    expect(e.aritmetica.variacion).toBeNull();
    expect(e.aritmetica.cuadra).toBe(false);
    expect(e.bloqueantes.map((r) => r.codigo)).toContain('saldo-no-observado');
    await expect(
      cerrarSesion(entityScope(f.tenantId, f.entityId), huerfana, {}, { userId: f.userId })
    ).rejects.toThrow(/saldo-no-observado/);
  });

  it('abrir con hueco de fechas o traslape se rechaza', async () => {
    await expect(
      abrirSesion(
        entityScope(f.tenantId, f.entityId),
        { cuenta, periodo: '2026-08' },
        { userId: f.userId }
      )
    ).rejects.toThrow(/traslapada/);
  });

  it('el hueco de fechas contra la sesión anterior se rechaza', async () => {
    // Septiembre existe (la huérfana es de junio); octubre dejaría hueco tras
    // agosto sólo si septiembre no está. Se prueba con octubre.
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-31',10000,10000,'MXN','csv',$4,$5)`,
      [uuidv4(), f.entityId, cuenta, 'b'.repeat(64), f.userId]
    );
    await expect(
      abrirSesion(
        entityScope(f.tenantId, f.entityId),
        { cuenta, periodo: '2026-10' },
        { userId: f.userId }
      )
    ).rejects.toThrow(/sin conciliar entre dos|termina el/);
  });
});

describe('sonda: el pase guiado se detiene antes de aprobar', () => {
  let cuenta2: string;

  beforeAll(async () => {
    cuenta2 = uuidv4();
    const gl2 = Object.values(f.cuentas).find((id) => id !== glBanco) as string;
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
       VALUES ($1,$2,'Sonda Run','Banco',$3,'MXN','checking')`,
      [cuenta2, f.entityId, gl2]
    );
    await query(
      `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
       VALUES ($1,$2,$3,'2026-07-01','2026-07-31',0,-450,'MXN','csv',$4,$5)`,
      [uuidv4(), f.entityId, cuenta2, 'c'.repeat(64), f.userId]
    );
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
         description, is_matched)
       VALUES ($1,$2,'2026-07-11',-450,'debit','comision sin registrar',false)`,
      [uuidv4(), cuenta2]
    );
  });

  it('run encadena extracto, cotejo, sesión, partidas y estado, y nombra lo que falta', async () => {
    const r = await correrConciliacion(
      entityScope(f.tenantId, f.entityId),
      { cuenta: cuenta2, periodo: '2026-07' },
      { userId: f.userId }
    );

    expect(r.pasos.map((p) => p.paso)).toEqual(['extracto', 'cotejo', 'sesion', 'partidas', 'estado']);
    expect(r.pasos.every((p) => p.hecho)).toBe(true);
    expect(r.sesionId).not.toBeNull();
    expect(r.detenidaAntesDeAprobar).toBe(true);
    expect(r.loQueFalta.at(-1)).toMatch(/approve/);
    expect(r.loQueFalta.at(-1)).toMatch(/post/);

    // La comisión de −450 se levanta como cargo-del-banco y cuadra los dos
    // lados: banco −450, libros 0 − 450 = −450.
    expect(r.clasificacion?.levantadas).toHaveLength(1);
    expect(r.estado?.aritmetica.variacion).toBe('0.00');
    expect(r.estado?.aritmetica.cuadra).toBe(true);
    // Y no está lista: la partida nació sin fecha esperada.
    expect(r.estado?.listaParaCerrar).toBe(false);
  });

  it('correr otra vez sin --resume se rehúsa, y con --resume continúa', async () => {
    await expect(
      correrConciliacion(
        entityScope(f.tenantId, f.entityId),
        { cuenta: cuenta2, periodo: '2026-07' },
        { userId: f.userId }
      )
    ).rejects.toThrow(/--resume/);

    const r = await correrConciliacion(
      entityScope(f.tenantId, f.entityId),
      { cuenta: cuenta2, periodo: '2026-07', reanudar: true },
      { userId: f.userId }
    );
    // Idempotente: no vuelve a levantar la misma partida.
    expect(r.clasificacion?.levantadas).toEqual([]);
    expect(r.estado?.partidas).toHaveLength(1);
  });
});
