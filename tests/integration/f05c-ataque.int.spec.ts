import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  abrirSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  estadoDeSesion,
  listarSesiones,
  correrConciliacion,
  PASOS_DE_CORRIDA,
} from '../../src/services/banking/reconciliation-service.js';
import {
  listarPartidas,
  asignarPartida,
  reclasificarPartida,
} from '../../src/services/banking/reconciling-items.js';
import { crearAjuste, listarAjustes } from '../../src/services/banking/reconciliation-adjustments.js';

/**
 * ATAQUE ADVERSARIAL A F05c. El objetivo es UNO: hacer que una sesión llegue a
 * `balanced` sin merecerlo, que es el defecto histórico del módulo y la razón
 * entera de que este tramo exista.
 */

let A: Fixture;
let B: Fixture;
let cuentaA: string;
let cuentaB: string;

async function mov(
  cuenta: string,
  extracto: string | null,
  fecha: string,
  importe: string,
  desc: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,$3::date,$4,$5,$6,false,$7)`,
    [id, cuenta, fecha, importe, Number(importe) < 0 ? 'debit' : 'credit', desc, extracto]
  );
  return id;
}

async function lineaBanco(
  fx: Fixture,
  gl: string,
  fecha: string,
  importe: string,
  lado: 'debit' | 'credit'
): Promise<string> {
  const contra = fx.roles.cxc ?? Object.values(fx.cuentas)[0];
  const e = await withTransaction((client) =>
    createJournalEntry(
      fx.entityId,
      new Date(`${fecha}T00:00:00Z`),
      JournalEntryType.STANDARD,
      `mov ${importe}`,
      lado === 'debit'
        ? [
            { account_id: gl, debit_amount: importe, credit_amount: null, description: 'banco' },
            { account_id: contra, debit_amount: null, credit_amount: importe, description: 'contra' },
          ]
        : [
            { account_id: gl, debit_amount: null, credit_amount: importe, description: 'banco' },
            { account_id: contra, debit_amount: importe, credit_amount: null, description: 'contra' },
          ],
      fx.userId,
      { autoPost: true, client }
    )
  );
  return (
    await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`,
      [e.id, gl]
    )
  ).rows[0].id;
}

/** Sella una línea de libros: `clasificarPartidas` sólo levanta las sin sellar. */
async function sellar(lineaId: string): Promise<void> {
  await query(
    `UPDATE journal_entry_lines
        SET is_reconciled = true, reconciled_at = NOW(), reconciliation_id = $2
      WHERE id = $1`,
    [lineaId, uuidv4()]
  );
}

let secuencia = 0;

/**
 * Una cuenta bancaria CON SU PROPIA cuenta de mayor: `uq_bank_accounts_gl` (051)
 * es único global, así que dos cuentas no pueden compartir el mapeo.
 */
async function cuentaBancaria(
  fx: Fixture,
  nombre: string
): Promise<{ id: string; gl: string }> {
  const gl = uuidv4();
  const code = `199${String(++secuencia).padStart(3, '0')}`;
  await query(
    `INSERT INTO accounts (id, code, name, account_type, fs_category, entity_id,
       normal_balance, created_by)
     VALUES ($1,$2,$3,'asset','current_assets',$4,'debit',$5)`,
    [gl, code, `Banco ${nombre}`, fx.entityId, fx.userId]
  );
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,$3,'Banco',$4,'MXN','checking')`,
    [id, fx.entityId, nombre, gl]
  );
  return { id, gl };
}

async function extracto(
  fx: Fixture,
  cuenta: string,
  desde: string,
  hasta: string,
  apertura: string,
  cierre: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,'MXN','csv',$8,$9)`,
    [id, fx.entityId, cuenta, desde, hasta, apertura, cierre, uuidv4().replace(/-/g, '') + 'a'.repeat(32), fx.userId]
  );
  return id;
}

beforeAll(async () => {
  A = await crearInquilino('Ataque F05c A');
  B = await crearEntidadHermana(A, 'Ataque F05c B');
  cuentaA = (await cuentaBancaria(A, 'Operativa A')).id;
  cuentaB = (await cuentaBancaria(B, 'Operativa B')).id;
  await extracto(A, cuentaA, '2026-01-01', '2026-01-31', '0', '1000');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

// ============================================================
// ATAQUE 1 · LLEGAR A `balanced` SIN MERECERLO
// ============================================================
describe('ATAQUE · balanced sin merecerlo', () => {
  it('1a · con una variación distinta de cero, close se niega', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    // Banco 1000, libros 0: descuadre de 1000 y ninguna partida que lo explique.
    const s = await abrirSesion(scope, { cuenta: cuentaA, periodo: '2026-01' }, { userId: A.userId });
    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });
    expect(e.aritmetica.variacion).toBe('1000.00');
    expect(e.aritmetica.cuadra).toBe(false);
    expect(e.listaParaCerrar).toBe(false);
    await expect(
      cerrarSesion(scope, s.sesionId, {}, { userId: A.userId })
    ).rejects.toThrow(/no cierra/);
    const bd = await query<{ status: string; arithmetic_computed_at: string | null }>(
      `SELECT status, arithmetic_computed_at FROM reconciliation_sessions WHERE id = $1`,
      [s.sesionId]
    );
    expect(bd.rows[0].status).toBe('in_progress');
    expect(bd.rows[0].arithmetic_computed_at).toBeNull();
  });

  it('1b · con partidas sin fechar, close se niega — y NADA en el binario las puede fechar', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: cuenta, gl } = await cuentaBancaria(A, 'Sin fechar');
    const ext = await extracto(A, cuenta, '2026-02-01', '2026-02-28', '0', '900');
    // Un cargo del banco de −100 que los libros no tienen, y libros = 1000.
    await mov(cuenta, ext, '2026-02-10', '-100.0000', 'comision');
    // La línea de libros va SELLADA: ya está en el extracto, así que no es
    // partida. Queda un solo desacuerdo, la comisión que los libros no tienen.
    await sellar(await lineaBanco(A, gl, '2026-02-05', '1000.0000', 'debit'));

    const s = await abrirSesion(scope, { cuenta, periodo: '2026-02' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });

    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });
    // La aritmética cuadra: 900 + (cheque/depósito de libros) vs 1000 − 100.
    const codigos = e.bloqueantes.map((b) => b.codigo);
    expect(codigos, 'sólo debería quedar la fecha esperada').toContain('partida-sin-fechar');
    await expect(cerrarSesion(scope, s.sesionId, {}, { userId: A.userId })).rejects.toThrow();

    // Y ÉSTE ES EL PUNTO: `fecha_esperada` sólo la escribe `asignarPartida`, y
    // `asignarPartida` no tiene comando. Se comprueba contra el árbol de
    // comandos real más abajo, en el ataque 6.
    const partidas = await listarPartidas(A.entityId, s.sesionId);
    expect(partidas.length).toBeGreaterThan(0);
    expect(partidas.every((p) => p.fechaEsperada === null)).toBe(true);

    // Fechadas a mano (por el servicio, no por el binario), sí cierra.
    for (const p of partidas) {
      await asignarPartida(A.entityId, s.sesionId, p.id, { fechaEsperada: '2026-03-31' });
    }
    const listo = await estadoDeSesion(scope, { sesionId: s.sesionId });
    expect(listo.listaParaCerrar, JSON.stringify(listo.bloqueantes)).toBe(true);
    const r = await cerrarSesion(scope, s.sesionId, {}, { userId: A.userId });
    expect(r.estado).toBe('balanced');
    expect(r.aritmetica.variacion).toBe('0.00');
  });

  it('1c · con un movimiento del extracto sin cotejar y sin partida, close se niega', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: cuenta } = await cuentaBancaria(A, 'Sin explicar');
    const ext = await extracto(A, cuenta, '2026-03-01', '2026-03-31', '0', '0');
    await mov(cuenta, ext, '2026-03-10', '-50.0000', 'algo que nadie explica');

    const s = await abrirSesion(scope, { cuenta, periodo: '2026-03' }, { userId: A.userId });
    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });
    expect(e.bloqueantes.map((b) => b.codigo)).toContain('linea-de-banco-sin-explicar');
    await expect(cerrarSesion(scope, s.sesionId, {}, { userId: A.userId })).rejects.toThrow();
  });

  it('1d · el CHECK de la 053 rechaza balanced con la aritmética en NULL, por SQL directo', async () => {
    const id = uuidv4();
    await query(
      `INSERT INTO reconciliation_sessions
         (id, bank_account_id, entity_id, start_date, end_date, beginning_balance, ending_balance_per_bank)
       VALUES ($1,$2,$3,'2026-11-01','2026-11-30',0,1000)`,
      [id, cuentaA, A.entityId]
    );
    for (const estado of ['balanced', 'approved', 'posted']) {
      await expect(
        query(`UPDATE reconciliation_sessions SET status = $2 WHERE id = $1`, [id, estado])
      ).rejects.toThrow(/sesion_balanceada_con_aritmetica/);
    }
  });

  it('1e · status y close contestan LO MISMO sobre la misma sesión', async () => {
    // El defecto que F05a tuvo entre `list` y `check`: dos verbos con dos
    // criterios. Aquí se recorren varios mundos y se exige la equivalencia
    // `listaParaCerrar === (close no lanza)`.
    const scope = entityScope(A.tenantId, A.entityId);
    const casos: Array<{ nombre: string; sesion: string }> = [];

    // Mundo 1: cuadrado y fechado.
    {
      const { id: c, gl } = await cuentaBancaria(A, 'Equiv 1');
      const ext = await extracto(A, c, '2026-04-01', '2026-04-30', '0', '700');
      await mov(c, ext, '2026-04-02', '-300.0000', 'comision');
      await sellar(await lineaBanco(A, gl, '2026-04-01', '1000.0000', 'debit'));
      const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-04' }, { userId: A.userId });
      await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
      for (const p of await listarPartidas(A.entityId, s.sesionId)) {
        await asignarPartida(A.entityId, s.sesionId, p.id, { fechaEsperada: '2026-06-30' });
      }
      casos.push({ nombre: 'cuadrado y fechado', sesion: s.sesionId });
    }
    // Mundo 2: cuadrado pero con una partida SIN fechar.
    {
      const { id: c, gl } = await cuentaBancaria(A, 'Equiv 2');
      const ext = await extracto(A, c, '2026-05-01', '2026-05-31', '0', '700');
      await mov(c, ext, '2026-05-02', '-300.0000', 'comision');
      await sellar(await lineaBanco(A, gl, '2026-05-01', '1000.0000', 'debit'));
      const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-05' }, { userId: A.userId });
      await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
      casos.push({ nombre: 'cuadrado sin fechar', sesion: s.sesionId });
    }

    for (const caso of casos) {
      const e = await estadoDeSesion(scope, { sesionId: caso.sesion });
      let cerro = true;
      try {
        await cerrarSesion(scope, caso.sesion, {}, { userId: A.userId });
      } catch {
        cerro = false;
      }
      expect(cerro, `${caso.nombre}: status dijo ${e.listaParaCerrar} y close hizo ${cerro}`).toBe(
        e.listaParaCerrar
      );
    }
  });
});

// ============================================================
// ATAQUE 2 · DINERO
// ============================================================
describe('ATAQUE · dinero', () => {
  it('2a · los diezmilésimos sobreviven a la aritmética y al resumen congelado', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Diezmilesimos');
    // Banco 0.6250. Libros 1.0000. Tres cargos de −0.1250 = −0.3750.
    // Con recorte a dos decimales serían tres veces −0.13 = −0.39 y descuadra.
    const ext = await extracto(A, c, '2026-06-01', '2026-06-30', '0', '0.6250');
    await mov(c, ext, '2026-06-02', '-0.1250', 'a');
    await mov(c, ext, '2026-06-03', '-0.1250', 'b');
    await mov(c, ext, '2026-06-04', '-0.1250', 'c');
    await sellar(await lineaBanco(A, gl, '2026-06-01', '1.0000', 'debit'));

    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-06' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
    for (const p of await listarPartidas(A.entityId, s.sesionId)) {
      await asignarPartida(A.entityId, s.sesionId, p.id, { fechaEsperada: '2026-09-30' });
    }
    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });
    const cargos = e.aritmetica.libros.partidas.find((p) => p.tipo === 'cargo-del-banco');
    expect(cargos?.importe, 'la suma de tres 0.1250 no se recorta').toBe('-0.3750');
    expect(e.aritmetica.variacion).toBe('0.00');
    expect(e.listaParaCerrar, JSON.stringify(e.bloqueantes)).toBe(true);

    const r = await cerrarSesion(scope, s.sesionId, {}, { userId: A.userId });
    expect(r.congelado.cargosDelBanco).toBe('-0.3750');
    const bd = await query<{ bank_charges: string; variance: string }>(
      `SELECT bank_charges::text, variance::text FROM reconciliation_sessions WHERE id = $1`,
      [s.sesionId]
    );
    expect(new Number(bd.rows[0].bank_charges).valueOf()).toBeCloseTo(-0.375, 6);
  });

  it('2b · los cuatro signos: el cheque RESTA del banco y el depósito SUMA', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Cuatro signos');
    // Banco 130, libros 100, cheque de 30 sin cobrar → banco ajustado 100.
    await extracto(A, c, '2026-07-01', '2026-07-31', '0', '130');
    await lineaBanco(A, gl, '2026-07-01', '130.0000', 'debit');
    await lineaBanco(A, gl, '2026-07-20', '30.0000', 'credit');
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-07' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });

    const cheque = e.partidas.find((p) => p.tipo === 'cheque-en-circulacion');
    const deposito = e.partidas.find((p) => p.tipo === 'deposito-en-transito');
    expect(cheque?.importe, 'el cheque aporta NEGATIVO').toBe('-30.00');
    expect(deposito?.importe, 'el depósito aporta POSITIVO').toBe('130.00');
    expect(e.aritmetica.banco.saldo).toBe('130.00');
    // 130 − 30 + 130 = 230 contra libros 100: NO cuadra, y eso es correcto —
    // el depósito de 130 ya está en el banco (fue cotejado en el mundo real).
    // Lo que se afirma aquí es el SIGNO, no el cuadre.
    expect(new Number(e.aritmetica.banco.ajustado).valueOf()).toBe(230);
  });
});

// ============================================================
// ATAQUE 3 · FUGA ENTRE ENTIDADES HERMANAS
// ============================================================
describe('ATAQUE · frontera de entidad', () => {
  let sesionDeB: string;

  beforeAll(async () => {
    const scopeB = entityScope(B.tenantId, B.entityId);
    const extB = await extracto(B, cuentaB, '2026-01-01', '2026-01-31', '0', '5000');
    // Un movimiento sin cotejar, para que B tenga una partida que A pueda
    // intentar nombrar desde sus propios libros.
    await mov(cuentaB, extB, '2026-01-15', '-77.0000', 'comision de B');
    const s = await abrirSesion(scopeB, { cuenta: cuentaB, periodo: '2026-01' }, { userId: B.userId });
    sesionDeB = s.sesionId;
  });

  it('3a · A no abre sesión sobre la cuenta de B', async () => {
    const scopeA = entityScope(A.tenantId, A.entityId);
    await expect(
      abrirSesion(scopeA, { cuenta: cuentaB, periodo: '2026-12' }, { userId: A.userId })
    ).rejects.toThrow();
  });

  it('3b · A no ve el estado de la sesión de B', async () => {
    const scopeA = entityScope(A.tenantId, A.entityId);
    await expect(estadoDeSesion(scopeA, { sesionId: sesionDeB })).rejects.toThrow();
  });

  it('3c · A no lista las partidas de la sesión de B', async () => {
    const p = await listarPartidas(A.entityId, sesionDeB, { incluirResueltas: true });
    expect(p).toEqual([]);
  });

  it('3d · A no cierra la sesión de B', async () => {
    const scopeA = entityScope(A.tenantId, A.entityId);
    await expect(cerrarSesion(scopeA, sesionDeB, {}, { userId: A.userId })).rejects.toThrow();
    const bd = await query<{ status: string }>(
      `SELECT status FROM reconciliation_sessions WHERE id = $1`, [sesionDeB]
    );
    expect(bd.rows[0].status).toBe('in_progress');
  });

  it('3e · A no clasifica partidas en la sesión de B', async () => {
    const scopeA = entityScope(A.tenantId, A.entityId);
    await expect(
      clasificarPartidasDeSesion(scopeA, sesionDeB, { userId: A.userId })
    ).rejects.toThrow();
  });

  it('3f · A no crea un ajuste en la sesión de B', async () => {
    await expect(
      crearAjuste(A.entityId, sesionDeB, { tipo: 'comision', importe: '-10', cuenta: '6100' }, A.userId)
    ).rejects.toThrow();
  });

  it('3f-bis · un ajuste de A NO puede colgarse de una partida de B', async () => {
    // `crearAjuste` acota la SESIÓN por entidad, pero `reconciling_item_id`
    // entra tal cual: la foránea sólo prueba que la fila existe EN ALGUNA
    // entidad. El resultado es una fila de A apuntando a una partida de B —no
    // filtra datos hoy, porque nadie la sigue a través de la frontera, pero es
    // la clase de vínculo que un informe futuro sí seguiría.
    const scopeB = entityScope(B.tenantId, B.entityId);
    await clasificarPartidasDeSesion(scopeB, sesionDeB, { userId: B.userId });
    const deB = await listarPartidas(B.entityId, sesionDeB);

    const scopeA = entityScope(A.tenantId, A.entityId);
    const { id: c } = await cuentaBancaria(A, 'Ajuste cruzado');
    await extracto(A, c, '2026-06-01', '2026-06-30', '0', '0');
    const sA = await abrirSesion(scopeA, { cuenta: c, periodo: '2026-06' }, { userId: A.userId });

    expect(deB.length, 'el escenario necesita una partida de B').toBeGreaterThan(0);
    await expect(
      crearAjuste(
        A.entityId,
        sA.sesionId,
        { tipo: 'comision', importe: '-10', cuenta: '6100' },
        A.userId,
        { reconcilingItemId: deB[0].id }
      )
    ).rejects.toThrow(/Reconciling Item/);

    // Y no queda ni la fila ni el borrador huérfano: se rechaza ANTES de
    // escribir nada.
    const cruzadas = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM reconciliation_adjustments ra
         JOIN reconciling_items ri ON ri.id = ra.reconciling_item_id
        WHERE ra.entity_id <> ri.entity_id`
    );
    expect(cruzadas.rows[0].n, 'ninguna fila cruza la frontera').toBe('0');
  });

  it('3g · list de A no trae ninguna sesión de B', async () => {
    const filas = await listarSesiones(entityScope(A.tenantId, A.entityId), { limit: 500 });
    expect(filas.every((x) => x.entityId === A.entityId)).toBe(true);
    expect(filas.some((x) => x.id === sesionDeB)).toBe(false);
  });
});

// ============================================================
// ATAQUE 4 · LA PROMESA DEL BORRADOR
// ============================================================
describe('ATAQUE · el ajuste nunca contabiliza', () => {
  it('4a · crear un ajuste no produce ni un solo journal_entries nuevo', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c } = await cuentaBancaria(A, 'Ajuste');
    await extracto(A, c, '2026-08-01', '2026-08-31', '0', '0');
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-08' }, { userId: A.userId });

    const antes = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM journal_entries`);
    const ajuste = await crearAjuste(
      A.entityId,
      s.sesionId,
      { tipo: 'comision', importe: '-35.00', cuenta: '6100' },
      A.userId
    );
    const despues = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM journal_entries`);
    expect(despues.rows[0].n, 'ni un asiento nuevo').toBe(antes.rows[0].n);
    expect(ajuste.journalEntryId).toBeNull();

    const bd = await query<{ journal_entry_id: string | null; draft_id: string }>(
      `SELECT journal_entry_id, draft_id FROM reconciliation_adjustments WHERE id = $1`, [ajuste.id]
    );
    expect(bd.rows[0].journal_entry_id).toBeNull();
    expect(bd.rows[0].draft_id).toBe(ajuste.draftId);

    const lista = await listarAjustes(A.entityId, s.sesionId);
    expect(lista[0].estadoDelBorrador).toBe('pending_review');
    expect(lista[0].journalEntryId).toBeNull();
  });
});

// ============================================================
// ATAQUE 5 · `run` SE DETIENE
// ============================================================
describe('ATAQUE · run se detiene antes de approve y post', () => {
  it('5a · los pasos no incluyen approve ni post, y el resultado lo dice como dato', async () => {
    expect(PASOS_DE_CORRIDA as readonly string[]).not.toContain('approve');
    expect(PASOS_DE_CORRIDA as readonly string[]).not.toContain('post');
    expect(PASOS_DE_CORRIDA as readonly string[]).not.toContain('close');

    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c } = await cuentaBancaria(A, 'Run');
    await extracto(A, c, '2026-09-01', '2026-09-30', '0', '0');
    const r = await correrConciliacion(scope, { cuenta: c, periodo: '2026-09' }, { userId: A.userId });
    expect(r.detenidaAntesDeAprobar).toBe(true);
    expect(r.loQueFalta.join(' ')).toMatch(/approve/);
    const bd = await query<{ status: string }>(
      `SELECT status FROM reconciliation_sessions WHERE id = $1`, [r.sesionId!]
    );
    expect(bd.rows[0].status, 'run no cierra jamás').toBe('in_progress');
  });
});

// ============================================================
// ATAQUE 6 · LO QUE EL BINARIO NO PUEDE HACER
//
// EL HALLAZGO ABIERTO DEL TRAMO, ANOTADO EN UNA PRUEBA QUE ROMPERÁ EL DÍA QUE
// SE ARREGLE.
//
// `close` exige toda partida CLASIFICADA Y FECHADA y no hay política que
// indulte `partida-sin-fechar`. `clasificarPartidas` levanta TODA partida sin
// `fecha_esperada` —a propósito: nada en el extracto ni en el mayor sabe cuándo
// se cobrará un cheque—. El único escritor de esa fecha es `asignarPartida`, y
// el único que corrige un tipo mal propuesto es `reclasificarPartida`: los dos
// existen, están probados, y NINGUNO tiene comando.
//
// Consecuencia, comprobada abajo por el camino de arriba y no por lectura: en
// cuanto una sesión tiene UNA partida, `bank reconciliation close` deja de ser
// alcanzable desde el binario para siempre. Un cierre que no se puede alcanzar
// es indistinguible de uno que no existe, que es lo que este tramo vino a
// dejar de ser.
//
// No se arregla aquí porque las dos hojas que faltan necesitan FILA EN EL
// CATÁLOGO antes de existir —`scripts/catalogo-estado.ts --check` corre en CI y
// rechaza todo comando que el catálogo no nombre—, y el catálogo es de su
// dueño. Los nombres propuestos están escritos junto al hueco, en
// `bank-command.ts`.
// ============================================================
describe('ATAQUE · el camino completo por el binario', () => {
  it('6a · el hueco está CERRADO: `reconciling-item` sabe fechar y corregir', async () => {
    const { Command } = await import('commander');
    const { registerBankCommand } = await import('../../src/cli/bank-command.js');
    const program = new Command();
    registerBankCommand(program, {
      palette: new Proxy({}, { get: () => (s: string) => s }) as never,
      shutdown: () => {},
      reportError: () => {},
    });
    const bank = program.commands.find((c) => c.name() === 'bank');
    const item = bank?.commands.find((c) => c.name() === 'reconciling-item');
    expect(item, 'el grupo existe').toBeDefined();
    const verbos = (item as { commands: readonly { name(): string }[] }).commands.map((x) => x.name());

    // Este caso nació afirmando `['list']` para romper el día que el hueco se
    // cerrara — y rompió. Se conserva invertido y con la igualdad EXACTA, no
    // un `toContain`: si mañana alguien retira `assign`, `close` vuelve a ser
    // inalcanzable en cuanto una sesión tiene una partida, y eso tiene que
    // romper aquí y no descubrirse cerrando un mes.
    expect(
      verbos.sort(),
      'Sin `assign` nadie puede escribir `fecha_esperada`, y sin `correct` cuatro de los seis ' +
        'tipos son inalcanzables porque el signo no distingue una comisión de un error del banco.'
    ).toEqual(['assign', 'correct', 'list']);
  });

  it('6b · y una sesión con una partida se puede cerrar, fechándola primero', async () => {
    // El mismo hecho, por el camino de arriba: se levanta la partida como lo
    // hace `bank reconciliation run` y se pide el estado como lo hace
    // `bank reconciliation status`. Lo que queda abierto es exactamente lo que
    // ninguna hoja puede tocar.
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Hueco');
    const ext = await extracto(A, c, '2026-05-01', '2026-05-31', '0', '900');
    await mov(c, ext, '2026-05-10', '-100.0000', 'comision');
    await sellar(await lineaBanco(A, gl, '2026-05-05', '1000.0000', 'debit'));
    const r = await correrConciliacion(scope, { cuenta: c, periodo: '2026-05' }, { userId: A.userId });

    // Sin fechar, sigue bloqueada: el bloqueo es correcto y no se ha aflojado.
    expect(r.estado?.listaParaCerrar).toBe(false);
    expect(r.estado?.bloqueantes.map((b) => b.codigo)).toEqual(['partida-sin-fechar']);
    await expect(
      cerrarSesion(scope, r.sesionId as string, {}, { userId: A.userId })
    ).rejects.toThrow(/partida-sin-fechar/);

    // Y con la fecha puesta —lo que antes no tenía puerta— el camino existe.
    for (const p of await listarPartidas(A.entityId, r.sesionId as string)) {
      await asignarPartida(A.entityId, r.sesionId as string, p.id, {
        responsable: 'Tesorería',
        fechaEsperada: '2026-07-31',
      });
    }
    const despues = await estadoDeSesion(scope, { sesionId: r.sesionId as string });
    expect(
      despues.bloqueantes.map((b) => b.codigo),
      'fechar la partida quita el bloqueo que la mantenía abierta'
    ).not.toContain('partida-sin-fechar');
  });
});

// ============================================================
// ATAQUE 7 · EL RESUMEN CONGELADO SE TIENE QUE PODER RECONSTRUIR
// ============================================================
describe('ATAQUE · el resumen congelado', () => {
  it('7a · con error del banco Y error de libros, las seis columnas reconstruyen la variación', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Dos errores');
    // Banco 1000, libros 1000. Un error del banco de +100 (suma al banco) y un
    // error de libros de +100 (suma a libros): la variación sigue siendo 0.
    await extracto(A, c, '2026-10-01', '2026-10-31', '0', '1000');
    await lineaBanco(A, gl, '2026-10-01', '1000.0000', 'debit');
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-10' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
    const partidas = await listarPartidas(A.entityId, s.sesionId);
    // El depósito en tránsito de 1000 se reclasifica a error-del-banco de +100
    // y se añade a mano un error-de-libros de +100.
    await reclasificarPartida(A.entityId, s.sesionId, partidas[0].id, {
      tipo: 'error-del-banco',
      importe: '100.0000',
    });
    await query(
      `INSERT INTO reconciling_items
         (entity_id, reconciliation_session_id, tipo, importe, fecha, fecha_esperada, created_by)
       VALUES ($1,$2,'error-de-libros',100,'2026-10-15','2026-12-31',$3)`,
      [A.entityId, s.sesionId, A.userId]
    );
    for (const p of await listarPartidas(A.entityId, s.sesionId)) {
      await asignarPartida(A.entityId, s.sesionId, p.id, { fechaEsperada: '2026-12-31' });
    }

    const e = await estadoDeSesion(scope, { sesionId: s.sesionId });
    expect(e.aritmetica.banco.ajustado).toBe('1100.00');
    expect(e.aritmetica.libros.ajustado).toBe('1100.00');
    expect(e.listaParaCerrar, JSON.stringify(e.bloqueantes)).toBe(true);

    const r = await cerrarSesion(scope, s.sesionId, {}, { userId: A.userId });
    const g = r.congelado;
    // LA RECONSTRUCCIÓN, tal como la promete `congelar`: un informe que sume
    // las seis columnas y los dos saldos tiene que llegar a `variance`.
    const bancoAjustado =
      Number(e.aritmetica.banco.saldo) +
      Number(g.chequesEnCirculacion) +
      Number(g.depositosEnTransito);
    const librosAjustado =
      Number(g.saldoLibros) + Number(g.cargosDelBanco) + Number(g.abonosDelBanco);
    // `otrosAjustes` es la única pieza que queda, y tiene que poder repartirse.
    expect(
      bancoAjustado - librosAjustado + Number(g.otrosAjustes),
      `otros_ajustes=${g.otrosAjustes} no reconstruye la variación ${g.variance}`
    ).toBeCloseTo(Number(g.variance), 6);
  });
});

// ============================================================
// ATAQUE 8 · LO QUE PASA DESPUÉS DE CERRAR
// ============================================================
describe('ATAQUE · la sesión cerrada', () => {
  let cerrada: string;

  beforeAll(async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c } = await cuentaBancaria(A, 'Ya cerrada');
    await extracto(A, c, '2026-12-01', '2026-12-31', '0', '0');
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-12' }, { userId: A.userId });
    // Una partida declarada a mano, fechada, que aporta cero neto no existe:
    // se usa una sesión vacía, que cuadra 0 contra 0.
    await cerrarSesion(scope, s.sesionId, {}, { userId: A.userId });
    cerrada = s.sesionId;
  });

  it('8a · no admite partidas nuevas', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    await expect(
      clasificarPartidasDeSesion(scope, cerrada, { userId: A.userId })
    ).rejects.toThrow(/no admite partidas nuevas/);
  });

  it('8b · no admite ajustes nuevos', async () => {
    await expect(
      crearAjuste(A.entityId, cerrada, { tipo: 'comision', importe: '-1', cuenta: '6100' }, A.userId)
    ).rejects.toThrow(/no admite ajustes nuevos/);
  });

  it('8c · no se cierra dos veces', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    await expect(cerrarSesion(scope, cerrada, {}, { userId: A.userId })).rejects.toThrow(/ya está en/);
  });

  it('8d · tampoco se le puede tocar el seguimiento de una partida', async () => {
    // La sesión cerrada congeló su resumen. Si `asignarPartida` no exige
    // `in_progress`, el desglose vivo puede moverse debajo de la aseveración.
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Seguimiento tras cierre');
    const ext = await extracto(A, c, '2026-11-01', '2026-11-30', '0', '900');
    await mov(c, ext, '2026-11-10', '-100.0000', 'comision');
    await sellar(await lineaBanco(A, gl, '2026-11-05', '1000.0000', 'debit'));
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-11' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
    for (const p of await listarPartidas(A.entityId, s.sesionId)) {
      await asignarPartida(A.entityId, s.sesionId, p.id, { fechaEsperada: '2026-12-31' });
    }
    await cerrarSesion(scope, s.sesionId, {}, { userId: A.userId });

    const p0 = (await listarPartidas(A.entityId, s.sesionId))[0];
    await expect(
      asignarPartida(A.entityId, s.sesionId, p0.id, { fechaEsperada: '2099-12-31', notas: 'movida' })
    ).rejects.toThrow();
  });
});

// ============================================================
// ATAQUE 9 · EL CANDADO QUE `close` DICE SOSTENER
// ============================================================
describe('ATAQUE · el candado de close', () => {
  it('9a · con la sesión tomada FOR UPDATE, nadie puede reclasificar sus partidas', async () => {
    const scope = entityScope(A.tenantId, A.entityId);
    const { id: c, gl } = await cuentaBancaria(A, 'Candado');
    const ext = await extracto(A, c, '2026-09-01', '2026-09-30', '0', '900');
    await mov(c, ext, '2026-09-10', '-100.0000', 'comision');
    await sellar(await lineaBanco(A, gl, '2026-09-05', '1000.0000', 'debit'));
    const s = await abrirSesion(scope, { cuenta: c, periodo: '2026-09' }, { userId: A.userId });
    await clasificarPartidasDeSesion(scope, s.sesionId, { userId: A.userId });
    const p0 = (await listarPartidas(A.entityId, s.sesionId))[0];

    // Una conexión aparte sostiene el candado que `close` sostiene.
    const url = process.env.DATABASE_URL as string;
    const tenedor = new pg.Client({ connectionString: url });
    await tenedor.connect();
    await tenedor.query('BEGIN');
    await tenedor.query('SELECT * FROM reconciliation_sessions WHERE id = $1 FOR UPDATE', [s.sesionId]);

    // NO SE AWAIT: lo que se afirma es que ESPERA, no que falle. Un rechazo
    // inmediato pasaría una prueba escrita como «no se reclasificó» y estaría
    // describiendo otro programa.
    let terminada = false;
    const enCurso = reclasificarPartida(A.entityId, s.sesionId, p0.id, {
      tipo: LADO_OPUESTO[p0.tipo],
      importe: '-999.0000',
    }).then((r) => {
      terminada = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 750));
    expect(
      terminada,
      'close lee las partidas por el POOL confiando en este candado: si se puede reclasificar ' +
        'mientras lo sostiene, la aritmética que firma queda obsoleta entre la lectura y el UPDATE'
    ).toBe(false);

    // Y al soltarlo, entra. Es la otra mitad: la partida no está bloqueada,
    // está ESPERANDO su turno.
    await tenedor.query('ROLLBACK');
    await tenedor.end();
    const despues = await enCurso;
    expect(despues.importe).toBe('-999.00');
  });
});

const LADO_OPUESTO: Record<string, string> = {
  'cargo-del-banco': 'cheque-en-circulacion',
  'abono-del-banco': 'deposito-en-transito',
  'cheque-en-circulacion': 'cargo-del-banco',
  'deposito-en-transito': 'abono-del-banco',
  'error-del-banco': 'error-de-libros',
  'error-de-libros': 'error-del-banco',
};
