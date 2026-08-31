import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  createJournalEntry,
  postJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { blockchainOrchestrator } from '../../src/services/blockchain/orchestrator.js';
import { CRITERIOS } from '../../src/plan/criterios.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * EL SELLO DEL PERIODO DICE QUÉ SELLÓ.
 *
 * Dos defectos que se sostenían el uno al otro.
 *
 * `postJournalEntry` no atestaba: la cadena de hashes cubría los asientos
 * creados con auto-posteo, los revertidos y los anulados, pero no los que
 * nacen borrador y se postean después — que es el camino normal de `entry
 * post`, de las dos superficies HTTP y del posteo de nómina.
 *
 * Y `commitPeriod` seleccionaba con `AND entry_hash IS NOT NULL`, de modo que
 * sellaba lo que quedara y guardaba ESA cuenta como `entry_count`. Con 100
 * asientos posteados y 3 atestados se sellaban 3 y se publicaba «3» como la
 * cuenta del periodo, sin manera de saber que faltaban 97.
 *
 * Juntos: el primero garantizaba que casi nada tuviera hash, y el segundo
 * convertía esa laguna en un sello con aspecto de completo.
 */

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Sello de periodo');

  // Sin configuración de anclaje activa, `attestJournalEntry` retorna null y
  // no escribe un solo hash: la suite pasaría en verde sin probar nada.
  // Ninguna otra prueba de integración la sembraba.
  await query(
    `INSERT INTO blockchain_config (tenant_id, primary_chain, redundancy_mode, verification_layer, is_active)
     VALUES ($1, 'arbitrum-one', 'none', 'zkverify', true)
     ON CONFLICT (tenant_id) DO UPDATE SET is_active = true`,
    [f.tenantId]
  );
});

afterAll(async () => {
  await drainAttestations(5000);
  await closeDatabase();
});

/** Un asiento cuadrado, creado como BORRADOR y posteado aparte. */
async function asientoDesdeBorrador(descripcion: string, mes = 8): Promise<string> {
  const entry = await createJournalEntry(
    f.entityId,
    fechaEnPeriodo(mes),
    JournalEntryType.STANDARD,
    descripcion,
    [
      { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'cargo' },
      { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.00', description: 'abono' },
    ],
    f.userId
  );
  await postJournalEntry(entry.id, f.userId);
  return entry.id;
}

/**
 * Quitar y devolver el hash REAL de un asiento.
 *
 * Las pruebas que simulan «una atestación que no llegó» tienen que dejar la
 * base como estaba: la suite corre en un solo hilo sobre una base compartida,
 * así que un hash inventado que sobrevive convierte un fallo en siete y hace
 * ilegible cuál fue el primero.
 */
async function quitarHash(id: string): Promise<string | null> {
  const r = await query<{ entry_hash: string | null }>(
    `UPDATE journal_entries SET entry_hash = NULL WHERE id = $1 RETURNING
       (SELECT entry_hash FROM journal_entries WHERE id = $1) AS entry_hash`,
    [id]
  );
  return r.rows[0]?.entry_hash ?? null;
}

async function devolverHash(id: string, hash: string | null): Promise<void> {
  await query(`UPDATE journal_entries SET entry_hash = $2 WHERE id = $1`, [id, hash]);
}

/** Ejecuta y devuelve el error, exigiendo que lo haya. */
async function capturar(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('se esperaba un rechazo y no lo hubo');
}

describe('postear un borrador entra en la cadena', () => {
  it('el asiento acaba con entry_hash, que antes nunca recibía', async () => {
    const id = await asientoDesdeBorrador('Borrador posteado');
    await drainAttestations(5000);

    const r = await query<{ entry_hash: string | null; att: string | null; status: string }>(
      `SELECT entry_hash, blockchain_attestation_id AS att, status
         FROM journal_entries WHERE id = $1`,
      [id]
    );
    expect(r.rows[0].status).toBe('posted');
    expect(
      r.rows[0].entry_hash,
      'un asiento nacido borrador y posteado después quedaba fuera de la cadena'
    ).not.toBeNull();
    expect(r.rows[0].att).not.toBeNull();
  });

  it('la atestación se marca SIMULADA, y el valor lo ESCRIBE el código', async () => {
    // Afirmar `is_simulated === true` a secas no prueba nada: el DEFAULT de la
    // migración 034 ya es true, así que la prueba pasaría igual con el código
    // que NO escribía la columna — que era precisamente el defecto.
    //
    // Así que se invierte el default mientras dura la prueba. Si el INSERT no
    // nombra la columna, la fila nace `false` y el caso cae. Es la única forma
    // de distinguir «lo declaró el adaptador» de «lo heredó de la tabla».
    await query(`ALTER TABLE blockchain_attestations ALTER COLUMN is_simulated SET DEFAULT false`);
    try {
      const id = await asientoDesdeBorrador('Con el default invertido');
      await drainAttestations(5000);

      const r = await query<{ is_simulated: boolean }>(
        `SELECT a.is_simulated FROM blockchain_attestations a
          WHERE a.source_id = $1`,
        [id]
      );
      expect(r.rows).toHaveLength(1);
      expect(
        r.rows[0].is_simulated,
        'con el DEFAULT en false la fila sólo sale true si el código escribió la columna'
      ).toBe(true);
    } finally {
      await query(`ALTER TABLE blockchain_attestations ALTER COLUMN is_simulated SET DEFAULT true`);
    }
  });
});

describe('commitPeriod se niega a sellar un periodo incompleto', () => {
  it('con un solo asiento sin atestar, no sella y dice cuántos son', async () => {
    // Se crea un asiento posteado SIN hash a mano: es el estado que deja una
    // atestación que falló, o un apagado a mitad. La consulta va por id para
    // no depender del orden.
    const id = await asientoDesdeBorrador('Se le quita el hash');
    await drainAttestations(5000);
    // El hash REAL, para devolverlo tal cual: restaurar una cadena inventada
    // deja la base mintiendo para las pruebas siguientes.
    const previo = await quitarHash(id);
    try {
      const periodo = await query<{ id: string }>(
        `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
      );

      await expect(
        blockchainOrchestrator.commitPeriod({
          tenantId: f.tenantId,
          entityId: f.entityId,
          periodId: periodo.rows[0].id,
        })
      ).rejects.toThrow(/sin atestar/);

      // Y no dejó rastro: negarse significa no sellar, no sellar a medias.
      const c = await query<{ n: string }>(
        `SELECT count(*) AS n FROM period_commitments WHERE entity_id = $1 AND period_id = $2`,
        [f.entityId, periodo.rows[0].id]
      );
      expect(c.rows[0].n).toBe('0');
    } finally {
      await devolverHash(id, previo);
    }
  });

  it('el mensaje nombra el total y la laguna, para poder actuar', async () => {
    const id = await asientoDesdeBorrador('Otro sin hash');
    await drainAttestations(5000);
    const previo = await quitarHash(id);
    try {
      const periodo = await query<{ id: string }>(
        `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
      );
      const e = await capturar(() =>
        blockchainOrchestrator.commitPeriod({
          tenantId: f.tenantId, entityId: f.entityId, periodId: periodo.rows[0].id,
        })
      );
      const m = e.message;
      expect(m, 'sin las dos cifras no se sabe si falta uno o noventa').toMatch(/\d+ asientos posteados/);
      expect(m).toMatch(/1 sin atestar/);
      // Y nombra la causa más común, que no es un fallo de los asientos.
      expect(m).toMatch(/configuración de anclaje/);
    } finally {
      await devolverHash(id, previo);
    }
  });

  it('con todos atestados sí sella, y la cuenta es la del periodo entero', async () => {
    const id = await asientoDesdeBorrador('Completo');
    await drainAttestations(5000);
    const periodo = await query<{ id: string }>(
      `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
    );

    const posteados = await query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries
        WHERE fiscal_period_id = $1 AND entity_id = $2 AND status = 'posted'`,
      [periodo.rows[0].id, f.entityId]
    );

    const sello = await blockchainOrchestrator.commitPeriod({
      tenantId: f.tenantId, entityId: f.entityId, periodId: periodo.rows[0].id,
    });

    // La afirmación que da nombre al elemento: la cuenta del sello es la del
    // periodo, no la del subconjunto que se pudo probar.
    expect(sello.entryCount).toBe(Number(posteados.rows[0].n));

    const fila = await query<{ entry_count: number; is_simulated: boolean; merkle_root: string }>(
      `SELECT entry_count, is_simulated, merkle_root FROM period_commitments
        WHERE entity_id = $1 AND period_id = $2`,
      [f.entityId, periodo.rows[0].id]
    );
    expect(fila.rows[0].entry_count).toBe(Number(posteados.rows[0].n));
    expect(fila.rows[0].is_simulated, 'el sello también se marca').toBe(true);
  });

  it('el sello escribe su propia marca de simulación, no la hereda', async () => {
    // Mismo razonamiento que en la atestación: con el DEFAULT en true, afirmar
    // true no distingue el código escribiendo de la tabla rellenando.
    await query(`ALTER TABLE period_commitments ALTER COLUMN is_simulated SET DEFAULT false`);
    try {
      // Un periodo PROPIO. `fechaEnPeriodo()` es constante, así que sin el
      // mes explícito todos los asientos del archivo caen en el mismo periodo
      // —el que el caso anterior ya selló— y este caso salía por un `return`
      // silencioso sin ejecutar una sola aserción. Un salto callado en una
      // prueba es un verde que no midió nada.
      const id = await asientoDesdeBorrador('Sello con default invertido', 10);
      await drainAttestations(5000);
      const p = await query<{ id: string }>(
        `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
      );
      const yaSellado = await query<{ n: string }>(
        `SELECT count(*) AS n FROM period_commitments WHERE entity_id = $1 AND period_id = $2`,
        [f.entityId, p.rows[0].id]
      );
      expect(
        yaSellado.rows[0].n,
        'el periodo elegido ya estaba sellado: este caso no puede medir nada'
      ).toBe('0');

      await blockchainOrchestrator.commitPeriod({
        tenantId: f.tenantId, entityId: f.entityId, periodId: p.rows[0].id,
      });
      const fila = await query<{ is_simulated: boolean }>(
        `SELECT is_simulated FROM period_commitments WHERE entity_id = $1 AND period_id = $2`,
        [f.entityId, p.rows[0].id]
      );
      expect(fila.rows[0].is_simulated).toBe(true);
    } finally {
      await query(`ALTER TABLE period_commitments ALTER COLUMN is_simulated SET DEFAULT true`);
    }
  });

  it('un sello ya emitido se sigue pudiendo LEER aunque el periodo tenga una laguna', async () => {
    // La primera versión de ATE-1 puso la negativa por asientos sin atestar
    // ENCIMA de la lectura del sello existente, y así un periodo ya sellado
    // dejaba de poder devolver su sello en cuanto entraba un posteado sin
    // hash: reventaba antes de mirar la fila. Como POST /commit-period es el
    // único camino autenticado a period_commitments —no hay GET—, el sello
    // quedaba ilegible para siempre. Negarse a EMITIR uno incompleto es el
    // punto del elemento; negarse a LEER uno ya emitido es perder información.
    const semilla = await asientoDesdeBorrador('Sello que luego tendrá laguna', 12);
    await drainAttestations(5000);
    const p = await query<{ id: string }>(
      `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [semilla]
    );
    const emitido = await blockchainOrchestrator.commitPeriod({
      tenantId: f.tenantId, entityId: f.entityId, periodId: p.rows[0].id,
    });

    // Ahora la laguna: otro asiento en el mismo periodo, sin hash.
    const huerfano = await asientoDesdeBorrador('Sin atestar, tras el sello', 12);
    await drainAttestations(5000);
    const previo = await quitarHash(huerfano);
    try {
      const leido = await blockchainOrchestrator.commitPeriod({
        tenantId: f.tenantId, entityId: f.entityId, periodId: p.rows[0].id,
      });
      expect(leido.commitmentId).toBe(emitido.commitmentId);
      expect(leido.merkleRoot).toBe(emitido.merkleRoot);
      expect(leido.entryCount).toBe(emitido.entryCount);
    } finally {
      await devolverHash(huerfano, previo);
    }
  });

  it('resellar devuelve lo ALMACENADO, no lo que se podría firmar ahora', async () => {
    // La rama de idempotencia devolvía el commitmentId de la fila junto al
    // merkleRoot recalculado en esa llamada. Si el periodo había recibido
    // asientos, el llamador recibía una raíz que no está en ninguna parte: ni
    // comprometida, ni anclada, ni igual a la que sirve el endpoint público.
    // El caso se fabrica su propia precondición en un periodo propio, en vez
    // de heredar el sello del caso anterior: dependía del orden de los
    // `describe` y, corrido en aislamiento con `-t`, reventaba con un
    // TypeError en vez de decir qué le faltaba.
    const semilla = await asientoDesdeBorrador('Sello para la idempotencia', 11);
    await drainAttestations(5000);
    const suyo = await query<{ id: string }>(
      `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [semilla]
    );
    await blockchainOrchestrator.commitPeriod({
      tenantId: f.tenantId, entityId: f.entityId, periodId: suyo.rows[0].id,
    });

    const periodo = await query<{ period_id: string; merkle_root: string; entry_count: number }>(
      `SELECT period_id, merkle_root, entry_count FROM period_commitments
        WHERE entity_id = $1 AND period_id = $2`,
      [f.entityId, suyo.rows[0].id]
    );
    expect(periodo.rows, 'el caso debió dejar su propio sello').toHaveLength(1);
    const guardado = periodo.rows[0];

    // Un asiento más en el mismo periodo: la raíz de "ahora" ya no es la sellada.
    await asientoDesdeBorrador('Posterior al sello', 11);
    await drainAttestations(5000);

    const otra = await blockchainOrchestrator.commitPeriod({
      tenantId: f.tenantId, entityId: f.entityId, periodId: guardado.period_id,
    });
    expect(otra.merkleRoot).toBe(guardado.merkle_root);
    expect(otra.entryCount).toBe(guardado.entry_count);
  });
});

/**
 * EL CRITERIO DEL PLAN, VIGILADO.
 *
 * `npm run plan:status` decide si el paquete está cerrado, así que un criterio
 * que no distingue el estado bueno del malo da por terminado lo que no lo está.
 *
 * El criterio cubre SÓLO la mitad decidible sin datos previos: que ningún
 * sello declare menos asientos de los que su periodo CERRADO tiene posteados.
 * La otra mitad —que todo posteado entre en la cadena— no se puede medir sin
 * un inquilino anclado, y sobre la base recién creada de CI salía «no
 * evaluable», lo que reabría E0.1 con razón. Esa mitad se demuestra arriba, en
 * este mismo archivo, que sí siembra el anclaje.
 *
 * La base de desarrollo está vacía y corre bajo un rol sujeto a RLS, así que
 * éste es el único sitio del repositorio donde el criterio se mide de verdad.
 */
describe('el criterio del plan detecta un sello que declara de menos', () => {
  const criterio = CRITERIOS.find((c) => /Ningún sello de periodo declara menos/i.test(c.enunciado))!;

  it('existe y se declara dependiente de la base', () => {
    expect(criterio, 'si se renombra el enunciado, esta prueba deja de vigilar nada').toBeDefined();
    expect(criterio.necesita).toBe('base-de-datos');
  });

  it('con los sellos honestos, no falla', async () => {
    const r = await criterio.evaluar();
    expect(r.estado, `dijo: ${r.detalle}`).not.toBe('falla');
  });

  it('su detalle dice cuántos sellos llegó a inspeccionar', async () => {
    // Un verde que no diga qué miró es verde por no mirar — y aquí importa
    // más que en otros criterios, porque las tablas llevan RLS forzado: bajo
    // el rol de la aplicación y sin contexto de inquilino, la consulta ve
    // cero filas y podría dar verde sin haber examinado nada.
    const r = await criterio.evaluar();
    expect(r.detalle).toMatch(/sello|revisar/i);
  });

  it('con un sello que declara de menos, falla y dice cuál', async () => {
    const p = await query<{ period_id: string; entry_count: number }>(
      `SELECT period_id, entry_count FROM period_commitments
        WHERE entity_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [f.entityId]
    );
    expect(p.rows, 'la suite debió dejar al menos un sello').toHaveLength(1);
    const original = p.rows[0].entry_count;

    // El criterio sólo mira periodos CERRADOS: en uno abierto, un sello que
    // cubre menos es una foto con fecha, no una mentira.
    const estado = await query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE id = $1`, [p.rows[0].period_id]
    );
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [p.rows[0].period_id]);
    await query(
      `UPDATE period_commitments SET entry_count = $2 WHERE entity_id = $1 AND period_id = $3`,
      [f.entityId, Math.max(original - 1, 0), p.rows[0].period_id]
    );
    try {
      const r = await criterio.evaluar();
      expect(r.estado, 'el criterio no vio un sello que miente').toBe('falla');
      expect(r.detalle).toMatch(/declaran menos asientos/);
      expect(r.detalle, 'sin el periodo concreto no se puede actuar').toContain(
        p.rows[0].period_id.slice(0, 8)
      );
    } finally {
      await query(
        `UPDATE period_commitments SET entry_count = $2 WHERE entity_id = $1 AND period_id = $3`,
        [f.entityId, original, p.rows[0].period_id]
      );
      await query(`UPDATE fiscal_periods SET status = $2 WHERE id = $1`,
        [p.rows[0].period_id, estado.rows[0].status]);
    }
  });

  it('un periodo ABIERTO con sello viejo no se acusa: es una foto con fecha', async () => {
    // La otra cara. Si el criterio no distinguiera, cualquier sello emitido
    // antes de que el periodo recibiera más asientos saldría como mentira, y
    // un criterio que grita por lo normal se desactiva a la semana.
    const p = await query<{ period_id: string; entry_count: number }>(
      `SELECT period_id, entry_count FROM period_commitments
        WHERE entity_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [f.entityId]
    );
    const original = p.rows[0].entry_count;
    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [p.rows[0].period_id]);
    await query(
      `UPDATE period_commitments SET entry_count = $2 WHERE entity_id = $1 AND period_id = $3`,
      [f.entityId, Math.max(original - 1, 0), p.rows[0].period_id]
    );
    try {
      const r = await criterio.evaluar();
      expect(r.estado, `acusó a un periodo abierto: ${r.detalle}`).not.toBe('falla');
    } finally {
      await query(
        `UPDATE period_commitments SET entry_count = $2 WHERE entity_id = $1 AND period_id = $3`,
        [f.entityId, original, p.rows[0].period_id]
      );
    }
  });
});
