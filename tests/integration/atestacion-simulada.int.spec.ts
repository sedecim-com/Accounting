import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

/**
 * UNA PRUEBA FABRICADA ES PEOR QUE NINGUNA.
 *
 * Los adaptadores de cadena no anclan nada: `simulateBlockNumber()`,
 * `simulateGasCost()` y un `confirmations: 12` fijo fabrican la atestación
 * entera. No hay transacción en ninguna red, no hay hash que nadie pueda
 * comprobar. Y `/public/v1` servía esas filas SIN AUTENTICACIÓN, que es
 * exactamente el público al que están destinadas: el auditor del cliente.
 *
 * Es la misma clase que retiró CLI-5 —reportar el éxito de un acto que no se
 * ejecuta— en su peor variante. Un timbre inventado engaña a quien lo
 * emitió; una atestación inventada engaña a quien vino a comprobarla.
 */

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Atestaciones');
});

afterAll(async () => {
  await closeDatabase();
});

describe('la columna que lo declara', () => {
  it('las tres tablas de anclaje la tienen, y por omisión es true', async () => {
    for (const t of ['blockchain_attestations', 'period_commitments', 'published_aggregates']) {
      const r = await query<{ column_default: string; is_nullable: string }>(
        `SELECT column_default, is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'is_simulated'`,
        [t]
      );
      expect(r.rows, `${t} necesita is_simulated`).toHaveLength(1);
      // true por omisión y NO NULL: todo lo escrito hasta hoy es simulado, y
      // un default false relabelaría como real un histórico fabricado.
      expect(r.rows[0].column_default).toMatch(/true/);
      expect(r.rows[0].is_nullable).toBe('NO');
    }
  });

  it('una atestación escrita sin declarar nada nace marcada como simulada', async () => {
    const id = uuidv4();
    await query(
      `INSERT INTO blockchain_attestations (
         id, tenant_id, entity_id, source_type, source_id, entry_hash, commitment, status
       ) VALUES ($1,$2,$3,'journal_entry',$4,$5,'compromiso-de-prueba','pending')`,
      [id, f.tenantId, f.entityId, uuidv4(), `0x${'a'.repeat(64)}`]
    );
    const r = await query<{ is_simulated: boolean }>(
      `SELECT is_simulated FROM blockchain_attestations WHERE id = $1`, [id]
    );
    expect(r.rows[0].is_simulated).toBe(true);
  });
});

describe('el endpoint público', () => {
  const fuenteRouter = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'api', 'rest', 'routes', 'public-verification.ts'),
    'utf-8'
  );
  const fuenteIndex = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'index.ts'),
    'utf-8'
  );

  it('está apagado por omisión: sólo se monta con la bandera', () => {
    expect(fuenteIndex).toMatch(/PUBLIC_VERIFICATION_ENABLED === 'true'/);
    // El montaje tiene que estar DENTRO del condicional, no antes.
    const i = fuenteIndex.indexOf("PUBLIC_VERIFICATION_ENABLED === 'true'");
    const j = fuenteIndex.indexOf("app.use('/public/v1', publicVerificationRouter)");
    expect(j).toBeGreaterThan(i);
  });

  it('encendido, se niega a servir una atestación simulada', () => {
    // La bandera decide si el router existe; no si miente.
    expect(fuenteRouter).toContain('ATTESTATION_SIMULATED');
    expect(fuenteRouter).toMatch(/if \(a\.is_simulated\)/);
  });

  it('no responde 404: el asiento existe, lo que falta es la prueba', () => {
    // Un 404 diría «no existe». El auditor tiene que saber que la
    // contabilidad está ahí y que lo que no está es el anclaje.
    expect(fuenteRouter).toMatch(/res\.status\(501\)[\s\S]{0,200}ATTESTATION_SIMULATED/);
    expect(fuenteRouter).toMatch(/anclaje es SIMULADO/);
  });
});
