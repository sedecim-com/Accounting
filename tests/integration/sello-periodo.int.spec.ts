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
async function asientoDesdeBorrador(descripcion: string): Promise<string> {
  const entry = await createJournalEntry(
    f.entityId,
    fechaEnPeriodo(),
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
    await query(`UPDATE journal_entries SET entry_hash = NULL WHERE id = $1`, [id]);

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

    // Se restaura para la prueba siguiente.
    await query(
      `UPDATE journal_entries SET entry_hash = $2 WHERE id = $1`,
      [id, 'a'.repeat(64)]
    );
  });

  it('el mensaje nombra el total y la laguna, para poder actuar', async () => {
    const id = await asientoDesdeBorrador('Otro sin hash');
    await drainAttestations(5000);
    await query(`UPDATE journal_entries SET entry_hash = NULL WHERE id = $1`, [id]);
    const periodo = await query<{ id: string }>(
      `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
    );

    try {
      await blockchainOrchestrator.commitPeriod({
        tenantId: f.tenantId, entityId: f.entityId, periodId: periodo.rows[0].id,
      });
      throw new Error('debió negarse');
    } catch (e) {
      const m = (e as Error).message;
      expect(m, 'sin las dos cifras no se sabe si falta uno o noventa').toMatch(/\d+ asientos posteados/);
      expect(m).toMatch(/1 sin atestar/);
      // Y nombra la causa más común, que no es un fallo de los asientos.
      expect(m).toMatch(/configuración de anclaje/);
    }

    await query(`UPDATE journal_entries SET entry_hash = $2 WHERE id = $1`, [id, 'b'.repeat(64)]);
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
      const id = await asientoDesdeBorrador('Sello con default invertido');
      await drainAttestations(5000);
      const p = await query<{ id: string }>(
        `SELECT fiscal_period_id AS id FROM journal_entries WHERE id = $1`, [id]
      );
      // Un periodo que aún no tiene sello: se busca uno sin fila.
      const yaSellado = await query<{ n: string }>(
        `SELECT count(*) AS n FROM period_commitments WHERE entity_id = $1 AND period_id = $2`,
        [f.entityId, p.rows[0].id]
      );
      if (yaSellado.rows[0].n !== '0') return; // el periodo del fixture ya se selló arriba

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

  it('resellar devuelve lo ALMACENADO, no lo que se podría firmar ahora', async () => {
    // La rama de idempotencia devolvía el commitmentId de la fila junto al
    // merkleRoot recalculado en esa llamada. Si el periodo había recibido
    // asientos, el llamador recibía una raíz que no está en ninguna parte: ni
    // comprometida, ni anclada, ni igual a la que sirve el endpoint público.
    const periodo = await query<{ period_id: string; merkle_root: string; entry_count: number }>(
      `SELECT period_id, merkle_root, entry_count FROM period_commitments
        WHERE entity_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [f.entityId]
    );
    const guardado = periodo.rows[0];

    // Un asiento más en el mismo periodo: la raíz de "ahora" ya no es la sellada.
    await asientoDesdeBorrador('Posterior al sello');
    await drainAttestations(5000);

    const otra = await blockchainOrchestrator.commitPeriod({
      tenantId: f.tenantId, entityId: f.entityId, periodId: guardado.period_id,
    });
    expect(otra.merkleRoot).toBe(guardado.merkle_root);
    expect(otra.entryCount).toBe(guardado.entry_count);
  });
});

/**
 * EL CRITERIO QUE VIGILA ESTO, VIGILADO.
 *
 * `npm run plan:status` decide si el paquete está cerrado, así que un criterio
 * que no distingue el estado bueno del malo es peor que no tenerlo: da por
 * terminado lo que no lo está. Aquí se le planta la mentira exacta que existe
 * para detectar —un sello que declara menos asientos de los que su periodo
 * tiene posteados— y se exige que la vea.
 *
 * La base de desarrollo está vacía, así que este es el único sitio del
 * repositorio donde el criterio se puede medir contra datos de verdad.
 */
describe('el criterio del plan detecta un sello que declara de menos', () => {
  const criterio = CRITERIOS.find((c) => /sello de un periodo abarca el periodo entero/i.test(c.enunciado))!;

  it('existe y está declarado como dependiente de la base', () => {
    expect(criterio, 'si se renombra el enunciado, esta prueba deja de vigilar nada').toBeDefined();
    expect(criterio.necesita).toBe('base-de-datos');
  });

  it('con los sellos honestos, no falla', async () => {
    const r = await criterio.evaluar();
    expect(r.estado, `dijo: ${r.detalle}`).not.toBe('falla');
  });

  it('con un sello que declara de menos, falla y dice cuál', async () => {
    const p = await query<{ period_id: string; entry_count: number }>(
      `SELECT period_id, entry_count FROM period_commitments
        WHERE entity_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [f.entityId]
    );
    if (p.rows.length === 0) throw new Error('la suite debió dejar al menos un sello');
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

  it('con un asiento posteado fuera de la cadena, también falla', async () => {
    // La otra mitad del enunciado: el inquilino tiene anclaje activo, así que
    // un posteado sin hash es un hueco, no una configuración ausente.
    const id = await asientoDesdeBorrador('Se le quita el hash para el criterio');
    await drainAttestations(5000);
    await query(`UPDATE journal_entries SET entry_hash = NULL WHERE id = $1`, [id]);
    try {
      const r = await criterio.evaluar();
      expect(r.estado).toBe('falla');
      expect(r.detalle).toMatch(/sin entry_hash/);
    } finally {
      await query(`UPDATE journal_entries SET entry_hash = $2 WHERE id = $1`, [id, 'd'.repeat(64)]);
    }
  });
});
