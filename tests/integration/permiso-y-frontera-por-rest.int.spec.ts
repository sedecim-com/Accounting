import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { permissionsOf } from '../../src/auth/roles.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import fiscalPeriodsRouter from '../../src/api/rest/routes/fiscal-periods.js';

/**
 * LOS DOS EJES DEL MAYOR, AFIRMADOS POR LA PUERTA QUE SE QUEDA.
 *
 * `frontera-caminos.int.spec.ts` los afirmaba —contra Postgres y con el
 * asiento releído después del rechazo— pasando por los resolutores de
 * GraphQL. Esa superficie se retira, y estos dos hechos NO se van con ella:
 *
 *   · PERMISO. `assertPermissions` (src/api/rest/middleware/auth.ts:160) es
 *     el mismo código que usaban las dos puertas; REST lo llama por
 *     `requirePermission`. Un rol de sólo lectura sobre SU PROPIA entidad
 *     —donde la pertenencia no objeta nada— no postea, no anula y no cierra.
 *   · FRONTERA DE ENTIDAD por id. `assertEntryAccess` de la ruta
 *     (journal-entries.ts:31) mete el filtro DENTRO del SQL con
 *     `requireByIdInScope`, así que el asiento ajeno y el inexistente salen
 *     los dos por 404.
 *
 * Y en los dos casos se relee la fila: un 403 concedido después de escribir
 * no es un 403, y un 404 que ya posteó tampoco es un 404.
 *
 * Corre como SUPERUSUARIO, con RLS inerte a propósito, por la misma razón que
 * frontera-caminos: RLS acota por INQUILINO y lo que aquí se cruza es la
 * frontera de ENTIDAD, el eje que RLS no cubre ni activa.
 */

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('REST permiso A');
  b = await crearEntidadHermana(a, 'REST permiso B');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function asientoBorrador(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entity_id, fiscal_period_id, entry_number, entry_type,
       entry_date, description, status, created_by)
     VALUES ($1, $2, $3, $4, 'standard', $5, 'Borrador', 'draft', $6)`,
    [id, f.entityId, f.periodos[8], `JE-${uuidv4().slice(0, 8)}`, fechaEnPeriodo(), f.userId]
  );
  return id;
}

const estadoDe = async (id: string): Promise<string> => {
  const { rows } = await query<{ status: string }>(
    'SELECT status FROM journal_entries WHERE id = $1',
    [id]
  );
  return rows[0].status;
};

const LECTOR = [...permissionsOf('viewer')];

/** La misma sesión de siempre, pero con los permisos de un rol de lectura. */
const sesionLectora = (f: Fixture) => ({ ...sesionDe(f), permissions: LECTOR });

describe('el eje del PERMISO: un lector sobre lo suyo', () => {
  it('no postea su propio asiento, y el asiento no se mueve', async () => {
    const propio = await asientoBorrador(a);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionLectora(a));
    try {
      const r = await pedir(s, 'POST', `/v1/journal-entries/${propio}/post`);
      expect(r.status).toBe(403);
      const err = (r.body.errors as Array<{ message: string; details?: Record<string, unknown> }>)[0];
      expect(err.message).toBe('Insufficient permissions');
      // La misma carga que enseña el error de la otra puerta: qué se pedía,
      // qué faltaba y qué se traía. Sin esto, un 403 no dice qué conceder.
      expect(err.details).toEqual({
        required: ['journal_entries:post'],
        missing: ['journal_entries:post'],
        current: LECTOR,
      });
    } finally {
      await s.cerrar();
    }
    expect(await estadoDe(propio), 'el 403 llegó ANTES de postear').toBe('draft');
  });

  it('ni lo anula', async () => {
    const propio = await asientoBorrador(a);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionLectora(a));
    try {
      const r = await pedir(s, 'POST', `/v1/journal-entries/${propio}/void`, { reason: 'x' });
      expect(r.status).toBe(403);
      expect((r.body.errors as Array<{ details?: { missing?: string[] } }>)[0].details?.missing)
        .toEqual(['journal_entries:void']);
    } finally {
      await s.cerrar();
    }
    expect(await estadoDe(propio)).toBe('draft');
  });

  it('ni cierra el periodo en duro', async () => {
    const s = await levantar([['/v1/fiscal-periods', fiscalPeriodsRouter]], sesionLectora(a));
    try {
      const r = await pedir(s, 'POST', `/v1/fiscal-periods/${a.periodos[8]}/hard-close`, {});
      expect(r.status).toBe(403);
      expect((r.body.errors as Array<{ details?: { missing?: string[] } }>)[0].details?.missing)
        .toEqual(['periods:close']);
    } finally {
      await s.cerrar();
    }

    const { rows } = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1',
      [a.periodos[8]]
    );
    expect(rows[0].status).not.toBe('hard_close');
  });

  it('y sí lee lo que su rol concede, sobre lo suyo', async () => {
    // La puerta ACOTA, no apaga: sin esto las tres de arriba pasarían con un
    // `throw` incondicional en el middleware.
    const propio = await asientoBorrador(a);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionLectora(a));
    try {
      const r = await pedir(s, 'GET', `/v1/journal-entries/${propio}`);
      expect(r.status).toBe(200);
      expect((r.body.data as { id: string }).id).toBe(propio);
    } finally {
      await s.cerrar();
    }
  });
});

describe('el eje de la ENTIDAD: el asiento de la hermana, por id', () => {
  it('postear un asiento ajeno da 404 y lo deja en borrador', async () => {
    const ajeno = await asientoBorrador(b);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(a));
    try {
      expect((await pedir(s, 'POST', `/v1/journal-entries/${ajeno}/post`)).status).toBe(404);
    } finally {
      await s.cerrar();
    }
    expect(await estadoDe(ajeno)).toBe('draft');
  });

  it('anularlo, igual', async () => {
    const ajeno = await asientoBorrador(b);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(a));
    try {
      expect(
        (await pedir(s, 'POST', `/v1/journal-entries/${ajeno}/void`, { reason: 'x' })).status
      ).toBe(404);
    } finally {
      await s.cerrar();
    }
    expect(await estadoDe(ajeno)).toBe('draft');
  });

  it('404 y no 403: no distingue el asiento ajeno del inexistente', async () => {
    const ajeno = await asientoBorrador(b);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(a));
    try {
      const inventado = uuidv4();
      const conAjeno = await pedir(s, 'POST', `/v1/journal-entries/${ajeno}/post`);
      const conInventado = await pedir(s, 'POST', `/v1/journal-entries/${inventado}/post`);
      expect(conAjeno.status).toBe(conInventado.status);
      expect(conAjeno.status).toBe(404);
      // Ni el texto delata: si uno dijera «no es tuyo» y el otro «no existe»,
      // la ruta seguiría siendo oráculo del mayor ajeno. Se normaliza el id,
      // que es lo único que legítimamente cambia entre las dos respuestas.
      const texto = (r: typeof conAjeno, id: string) =>
        (r.body.errors as Array<{ message: string }>)[0].message.replace(id, 'ID');
      expect(texto(conAjeno, ajeno)).toBe(texto(conInventado, inventado));
    } finally {
      await s.cerrar();
    }
  });

  it('tener la entidad concedida NO basta si no es la entidad activa', async () => {
    // El alcance de la petición es UNO: `assertEntryAccess` acota con
    // req.entityId, no con la lista del token.
    const ajeno = await asientoBorrador(b);
    const s = await levantar(
      [['/v1/journal-entries', journalEntriesRouter]],
      sesionDe(a, [a.entityId, b.entityId])
    );
    try {
      expect((await pedir(s, 'POST', `/v1/journal-entries/${ajeno}/post`)).status).toBe(404);
    } finally {
      await s.cerrar();
    }
    expect(await estadoDe(ajeno)).toBe('draft');
  });

  it('sobre el suyo, postear sigue llegando al motor', async () => {
    // La frontera no puede ser «lanza siempre».
    const propio = await asientoBorrador(a);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', `/v1/journal-entries/${propio}/post`);
      // El asiento se sembró sin renglones a propósito: lo que se comprueba
      // aquí es que la petición ATRAVIESA permiso y frontera y llega al motor
      // contable, que es quien decide si la póliza cuadra.
      expect(r.status, JSON.stringify(r.body)).not.toBe(403);
      expect(r.status, JSON.stringify(r.body)).not.toBe(404);
    } finally {
      await s.cerrar();
    }
  });
});
