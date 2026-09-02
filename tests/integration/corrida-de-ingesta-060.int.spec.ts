import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import {
  abrirCorridaIngesta,
  cerrarCorridaIngesta,
  conCorridaRegistrada,
} from '../../src/ai/ingest-runs.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * A7·3 — LA CORRIDA ABIERTA, CONTRA LA BASE REAL.
 *
 * Lo que la prueba unitaria NO puede afirmar porque `query` allí es un doble:
 * que la 058 aplica sobre el esquema, que su CHECK impide escribir un cierre
 * a medias, que el UPDATE de cierre no choca con ningún disparador (la 041
 * protege el mayor, no esta tabla), y que la fila que queda tras una muerte a
 * media lista se distingue de una corrida vacía LEYÉNDOLA.
 *
 * NO CORRE EN ESTA MÁQUINA: no hay Postgres accesible (role postgres does not
 * exist). Corre en CI, donde la suite de integración levanta su base efímera
 * y la migra entera. Se declara aquí y no se fuerza.
 */

let f: Fixture;
let ctx: AgentContext;

const APERTURA = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  filesTotal: 1500,
  autoPostEnabled: false,
  createdBy: 'contador@despacho.mx',
};

const COUNTS = {
  rules: 3, auto_post: 0, draft: 1495, blocked: 2, duplicate: 0, invalid: 0, error: 0,
};

const CONSUMO = {
  sospechaCount: 0,
  draftsCreated: 1495,
  inputTokens: 900000,
  outputTokens: 40000,
  estimatedCostUsd: 12.5,
  durationMs: 3_600_000,
};

type Fila = {
  status: string;
  closed_at: Date | null;
  error: string | null;
  files_total: number;
  draft_count: number;
  drafts_created: number;
  duration_ms: number | null;
  estimated_cost_usd: string | null;
};

const leer = async (id: string): Promise<Fila> => {
  const r = await query<Fila>(
    `SELECT status, closed_at, error, files_total, draft_count, drafts_created,
            duration_ms, estimated_cost_usd
       FROM ai_ingest_runs WHERE id = $1`,
    [id]
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
};

beforeAll(async () => {
  f = await crearInquilino('Corrida de ingesta 058');
  ctx = {
    entityId: f.entityId,
    entityName: 'Corrida de ingesta 058',
    tenantId: f.tenantId,
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'mx_nif',
    taxId: 'XAXX010101000',
  };
});

afterAll(async () => {
  await closeDatabase();
});

describe('la fila abierta es legible desde el primer archivo', () => {
  it('abre en running, sin cierre, sin duración y sin contadores', async () => {
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    const fila = await leer(id);
    expect(fila.status).toBe('running');
    expect(fila.closed_at).toBeNull();
    // Lo que se sabe al abrir, se sabe; lo que no, es NULL o su DEFAULT.
    expect(fila.files_total).toBe(1500);
    expect(fila.draft_count).toBe(0);
    expect(fila.duration_ms).toBeNull();
    expect(fila.estimated_cost_usd).toBeNull();
  });

  it('y el cierre la completa: sin disparador que lo impida', async () => {
    // La 041 protege journal_entries y journal_entry_lines. Si alguien le
    // pone un disparador de sólo-agregar a esta tabla, o la mete en el array
    // append_only de rls-policies.sql, este UPDATE deja de escribir y la
    // corrida vuelve a no tener fila.
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await cerrarCorridaIngesta(ctx, id, { counts: COUNTS, ...CONSUMO });
    const fila = await leer(id);
    expect(fila.status).toBe('completed');
    expect(fila.closed_at).not.toBeNull();
    expect(fila.error).toBeNull();
    expect(fila.draft_count).toBe(1495);
    expect(fila.drafts_created).toBe(1495);
    expect(fila.duration_ms).toBe(3_600_000);
    expect(Number(fila.estimated_cost_usd)).toBeCloseTo(12.5, 6);
  });

  it('cerrar dos veces no reescribe la fila: lanza', async () => {
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await cerrarCorridaIngesta(ctx, id, { counts: COUNTS, ...CONSUMO });
    await expect(
      cerrarCorridaIngesta(ctx, id, { counts: COUNTS, ...CONSUMO })
    ).rejects.toThrow(/no hay corrida ABIERTA/);
  });
});

describe('la corrida que muere a media lista se distingue de la corrida vacía', () => {
  it('la muerta queda en failed con su razón y sus ceros de «no se contó»', async () => {
    const muerte = new Error('SIGTERM en el archivo 1500');
    let id: string | null = null;
    await expect(
      conCorridaRegistrada({
        ctx,
        apertura: APERTURA,
        cuerpo: async (corridaId) => {
          id = corridaId;
          throw muerte;
        },
        cierre: (resultado) => ({
          counts: resultado === null ? undefined : COUNTS,
          ...CONSUMO,
          draftsCreated: 1500,
        }),
        onAviso: (m) => expect.unreachable(`no debía avisar: ${m}`),
      })
    ).rejects.toThrow('SIGTERM en el archivo 1500');

    expect(id).not.toBeNull();
    const fila = await leer(id!);
    expect(fila.status).toBe('failed');
    expect(fila.error).toContain('SIGTERM en el archivo 1500');
    expect(fila.closed_at).not.toBeNull();
    // Los contadores se quedaron en su DEFAULT porque nadie los contó — y el
    // status es lo único que separa eso de una corrida que sí terminó vacía.
    expect(fila.draft_count).toBe(0);
    // Pero los mil quinientos borradores que SÍ se crearon quedan escritos.
    expect(fila.drafts_created).toBe(1500);
  });

  it('la vacía queda en completed con los mismos ceros, y por eso el estado hace falta', async () => {
    const vacios = {
      rules: 0, auto_post: 0, draft: 0, blocked: 0, duplicate: 0, invalid: 0, error: 0,
    };
    const id = await abrirCorridaIngesta(ctx, { ...APERTURA, filesTotal: 0 });
    await cerrarCorridaIngesta(ctx, id, {
      counts: vacios, ...CONSUMO, draftsCreated: 0, estimatedCostUsd: null,
    });
    const fila = await leer(id);
    expect(fila.status).toBe('completed');
    expect(fila.draft_count).toBe(0);
    expect(fila.estimated_cost_usd).toBeNull();
  });
});

// ============================================================
// B3 · LA GUARDA DE ENTIDAD, CRUZADA DE VERDAD
//
// El WHERE del cierre es `id = $16 AND entity_id = $17 AND status = 'running'`,
// y hasta hoy sólo se cruzaba la mitad: la unitaria lo comprueba con un regex
// sobre el SQL (legítimo —con `query` doblado no hay semántica que ejercer—,
// pero es texto), y esta suite creaba UN inquilino, así que todo lo que
// ejercía era la guarda de ESTADO (cerrar dos veces). La de ENTIDAD no la
// cruzaba nadie: quitar `entity_id = $17` del UPDATE dejaba todo verde.
//
// Y el eje tiene que ser el correcto. Dos `crearInquilino` son dos INQUILINOS,
// y cruzar de uno a otro cruza la frontera que RLS SÍ defiende: la prueba
// pasaría por el motivo equivocado. El eje que esta guarda defiende es el
// otro, el que RLS no acota — dos entidades legales del MISMO inquilino, que
// es la holding con varias sociedades, el caso normal en México.
// ============================================================

describe('una corrida de la entidad vecina no se cierra desde aquí', () => {
  it('la hermana falla al cerrarla, y la fila NO se mueve', async () => {
    const hermana = await crearEntidadHermana(f, 'Hermana de la corrida');
    // El eje: mismo inquilino, entidad distinta. Si esto dejara de cumplirse,
    // la prueba estaría midiendo RLS y no la guarda del UPDATE.
    expect(hermana.tenantId).toBe(f.tenantId);
    expect(hermana.entityId).not.toBe(f.entityId);
    const ctxHermana: AgentContext = {
      ...ctx,
      entityId: hermana.entityId,
      entityName: 'Hermana de la corrida',
    };

    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await expect(
      cerrarCorridaIngesta(ctxHermana, id, { counts: COUNTS, ...CONSUMO })
    ).rejects.toThrow(/no hay corrida ABIERTA/);

    // Lo que la guarda impide no es sólo el error: es la ESCRITURA. La fila
    // sigue abierta, sin cierre y sin los contadores de la vecina encima.
    const fila = await leer(id);
    expect(fila.status).toBe('running');
    expect(fila.closed_at).toBeNull();
    expect(fila.draft_count).toBe(0);
    expect(fila.drafts_created).toBe(0);

    // Y su dueña sí la cierra: la guarda acota, no rompe.
    await cerrarCorridaIngesta(ctx, id, { counts: COUNTS, ...CONSUMO });
    const cerrada = await leer(id);
    expect(cerrada.status).toBe('completed');
    expect(cerrada.draft_count).toBe(1495);
  });

  it('y en el sentido contrario tampoco: la guarda no tiene lado bueno', async () => {
    const hermana = await crearEntidadHermana(f, 'Hermana que abre');
    const ctxHermana: AgentContext = {
      ...ctx,
      entityId: hermana.entityId,
      entityName: 'Hermana que abre',
    };
    const id = await abrirCorridaIngesta(ctxHermana, APERTURA);
    await expect(
      cerrarCorridaIngesta(ctx, id, { counts: COUNTS, ...CONSUMO })
    ).rejects.toThrow(/no hay corrida ABIERTA/);
    expect((await leer(id)).status).toBe('running');
  });

  it('y el envoltorio completo respeta la frontera: avisa en vez de escribir en la vecina', async () => {
    // `conCorridaRegistrada` abre con SU ctx y cierra con SU ctx, así que el
    // camino entero no puede tocar la fila de al lado. Lo que se afirma aquí
    // es que la corrida de la hermana deja SU fila y no la de la vecina.
    const hermana = await crearEntidadHermana(f, 'Hermana con corrida entera');
    const ctxHermana: AgentContext = {
      ...ctx,
      entityId: hermana.entityId,
      entityName: 'Hermana con corrida entera',
    };
    let id: string | null = null;
    await conCorridaRegistrada({
      ctx: ctxHermana,
      apertura: APERTURA,
      cuerpo: (corridaId) => {
        id = corridaId;
        return Promise.resolve('ok');
      },
      cierre: () => ({ counts: COUNTS, ...CONSUMO }),
      onAviso: (m) => expect.unreachable(`no debía avisar: ${m}`),
    });
    expect(id).not.toBeNull();
    const propia = await query<{ entity_id: string }>(
      'SELECT entity_id FROM ai_ingest_runs WHERE id = $1',
      [id!]
    );
    expect(propia.rows[0].entity_id).toBe(hermana.entityId);
    const enLaVecina = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ai_ingest_runs WHERE id = $1 AND entity_id = $2`,
      [id!, f.entityId]
    );
    expect(enLaVecina.rows[0].n).toBe('0');
  });
});

describe('el CHECK de la 058 no admite un cierre a medias', () => {
  it('un estado terminal sin fecha de cierre no se puede escribir', async () => {
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await expect(
      query(`UPDATE ai_ingest_runs SET status = 'completed' WHERE id = $1`, [id])
    ).rejects.toThrow(/ai_ingest_runs_cierre_check/);
  });

  it('una fecha de cierre sin salir de running tampoco', async () => {
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await expect(
      query(`UPDATE ai_ingest_runs SET closed_at = NOW() WHERE id = $1`, [id])
    ).rejects.toThrow(/ai_ingest_runs_cierre_check/);
  });

  it('y un estado inventado tampoco entra', async () => {
    const id = await abrirCorridaIngesta(ctx, APERTURA);
    await expect(
      query(`UPDATE ai_ingest_runs SET status = 'zombi', closed_at = NOW() WHERE id = $1`, [id])
    ).rejects.toThrow(/ai_ingest_runs_status_check/);
  });
});
