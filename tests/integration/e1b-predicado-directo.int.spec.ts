import { describe, it, expect } from 'vitest';
import { query } from '../../src/database/connection.js';
import { crearInquilino } from './helpers/tenant-fixture.js';
import { sembrarVolumen } from './helpers/volumen.js';

// ============================================================
// E1b · EL PREDICADO DIRECTO, MEDIDO
//
// La tarjeta de E1 afirma 840 ms → 193 ms. Esta prueba no da por buena esa
// cifra: la re-mide aquí, sobre esta máquina y este volumen, porque una cifra
// heredada de otro árbol y otra máquina no es una medición, es una cita.
//
// Se compara EL MISMO conteo bajo los dos predicados: el que la política de
// hija usaba hasta la 071 —EXISTS correlacionado contra el padre, que a su vez
// resuelve su inquilino por otra subconsulta— y el directo por columna.
// ============================================================

const ASIENTOS = Number(process.env.E1B_ASIENTOS ?? 20000);

async function medir(sql: string, p: unknown[]): Promise<{ ms: number; filas: number }> {
  // Una vuelta en frío para llenar cachés de plan y de página: lo que se
  // compara es el predicado, no quién llegó primero al disco.
  await query(sql, p);
  const t0 = process.hrtime.bigint();
  const { rows } = await query<{ n: string }>(sql, p);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, filas: Number(rows[0]?.n ?? 0) };
}

describe('E1b · el predicado de la hija deja de pagarse por fila', () => {
  it(`sobre ${ASIENTOS} asientos, el predicado directo cuesta menos que la subconsulta`, async () => {
    const inq = await crearInquilino('E1b · volumen');
    const periodo = inq.periodos[8];
    const cargo = inq.cuentas['1110'] ?? Object.values(inq.cuentas)[0];
    const abono = inq.cuentas['4100'] ?? Object.values(inq.cuentas)[1];
    if (!periodo || !cargo || !abono) throw new Error('la fixture base no trae periodo ni cuentas');

    const sembrado = await sembrarVolumen(inq.entityId, periodo, inq.userId, cargo, abono, ASIENTOS);

    const viejo = await medir(
      `SELECT count(*)::text AS n FROM journal_entry_lines l
        WHERE EXISTS (SELECT 1 FROM journal_entries p
                       WHERE p.id = l.journal_entry_id
                         AND p.entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $1))`,
      [inq.tenantId]
    );
    const directo = await medir(
      `SELECT count(*)::text AS n FROM journal_entry_lines l WHERE l.tenant_id = $1`,
      [inq.tenantId]
    );

    // Las dos formas tienen que contar LO MISMO. Un predicado más rápido que
    // devuelve otra cosa no es una mejora, es un defecto de aislamiento.
    expect(directo.filas, 'los dos predicados no acotan igual').toBe(viejo.filas);
    expect(directo.filas).toBeGreaterThanOrEqual(sembrado.lineas);

    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT count(*) FROM journal_entry_lines l WHERE l.tenant_id = $1`,
      [inq.tenantId]
    );
    const texto = plan.rows.map((r) => r['QUERY PLAN']).join('\n');

    // LA CIFRA ES EL PRODUCTO DE ESTA PRUEBA, no un resto de depuración.
    // Una prueba de rendimiento que no publica lo que midió obliga a
    // reproducirla para saber qué dijo. Lleva prefijo por la misma razón que
    // `[ataque N]` en g3-ataque: para que se lea como evidencia y no como un
    // console.log olvidado — que es justo lo que el triaje automático supone.
    console.log('[E1b] PLAN DIRECTO:\n' + texto + '\n' +
      `\n[E1b] ${sembrado.asientos} asientos / ${sembrado.lineas} líneas sembradas en ${sembrado.ms} ms\n` +
        `      subconsulta por fila: ${viejo.ms.toFixed(0)} ms\n` +
        `      predicado directo   : ${directo.ms.toFixed(0)} ms\n` +
        `      factor              : ${(viejo.ms / directo.ms).toFixed(2)}×`
    );

    expect(directo.ms, `el predicado directo (${directo.ms} ms) no mejoró la subconsulta (${viejo.ms} ms)`)
      .toBeLessThan(viejo.ms);
  }, 600_000);
});
