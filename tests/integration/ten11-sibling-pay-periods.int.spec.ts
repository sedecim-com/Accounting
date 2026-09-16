import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

// ============================================================
// TEN-11 · GENERAR PERIODOS EN EL CALENDARIO DE LA SOCIEDAD HERMANA
//
// Una frontera LATENTE, y por eso esta prueba no se parece a las otras tres.
// Medido: la ruta contestaba 500 a todo el mundo —calendario ajeno, propio e
// inexistente— y no escribía un solo periodo. `first_period_start` es DATE, pg
// lo devuelve como objeto `Date`, y `Date + 'T00:00:00Z'` es una cadena que
// `new Date()` no entiende.
//
// Hoy, pues, no filtra. Pero el SELECT del calendario iba por `WHERE id = $1`
// a secas: arreglar la avería SIN la frontera habría abierto la fuga, y
// arreglar la frontera SIN la avería dejaba una ruta muerta donde un 404 no
// distingue «es ajeno» de «está roto». Van juntas, y el contrapeso —el
// calendario propio SÍ genera— es lo que prueba que el 404 es la frontera.
// ============================================================

let a: Fixture;
let b: Fixture;
let srv: Servidor;
const OWN_SCHEDULE = randomUUID();
const SIBLING_SCHEDULE = randomUUID();

beforeAll(async () => {
  a = await crearInquilino('TEN-11 periodos A');
  b = await crearEntidadHermana(a, 'TEN-11 periodos B');
  for (const [id, fx] of [[OWN_SCHEDULE, a], [SIBLING_SCHEDULE, b]] as const) {
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
       VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
      [id, fx.tenantId, fx.entityId]
    );
  }
  srv = await levantar([['/v1/payroll', payrollRouter]], { ...sesionDe(a), permissions: ['payroll:create'] });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

const periodStarts = async (schedule: string): Promise<string[]> => {
  const { rows } = await query<{ period_start: string }>(
    `SELECT period_start::text FROM pay_periods WHERE pay_schedule_id = $1 ORDER BY period_start`,
    [schedule]
  );
  return rows.map((r) => r.period_start);
};

describe('los periodos del calendario de la hermana', () => {
  it('contesta 404, y no escribe un solo periodo', async () => {
    const r = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${SIBLING_SCHEDULE}/generate-periods`, { count: 3 });
    expect(r.status, `contestó ${r.status}`).toBe(404);
    expect(await periodStarts(SIBLING_SCHEDULE)).toEqual([]);
  });

  it('el 404 es idéntico al de un calendario que no existe', async () => {
    const foreign = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${SIBLING_SCHEDULE}/generate-periods`, { count: 3 });
    const fantasmaId = randomUUID();
    const fantasma = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${fantasmaId}/generate-periods`, { count: 3 });
    expect(fantasma.status).toBe(404);
    const normalize = (body: unknown, id: string): string =>
      JSON.stringify((body as { errors?: unknown }).errors).split(id).join('<id>');
    expect(normalize(foreign.body, SIBLING_SCHEDULE)).toBe(normalize(fantasma.body, fantasmaId));
  });

  it('EL CONTRAPESO: el calendario propio SÍ genera, y con las fechas correctas', async () => {
    const r = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${OWN_SCHEDULE}/generate-periods`, { count: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Las fechas importan tanto como el conteo: la avería era de conversión de
    // DATE, y un arreglo que corriera un día —la familia de #211— generaría
    // tres periodos equivocados y esta prueba seguiría contando tres.
    expect(await periodStarts(OWN_SCHEDULE)).toEqual(['2026-01-01', '2026-01-16', '2026-02-01']);
  });

  it('y la segunda llamada continúa donde terminó la primera', async () => {
    // El otro camino de la avería: con periodos ya escritos, el cursor sale de
    // `period_end`, que también es DATE.
    const r = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${OWN_SCHEDULE}/generate-periods`, { count: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await periodStarts(OWN_SCHEDULE)).toEqual(['2026-01-01', '2026-01-16', '2026-02-01', '2026-02-16']);
  });

  it('un count fuera de rango se rechaza antes de escribir', async () => {
    const r = await pedir(srv, 'POST', `/v1/payroll/pay-schedules/${OWN_SCHEDULE}/generate-periods`, { count: 100000 });
    expect(r.status, `contestó ${r.status}`).toBe(422);
  });
});
