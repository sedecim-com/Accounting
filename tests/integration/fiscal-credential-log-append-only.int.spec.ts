import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * LA BITÁCORA DE LA e.firma NO SE REESCRIBE.
 *
 * `fiscal_credential_access_log` prueba quién descifró la e.firma del
 * contribuyente, cuándo y para qué. Es la única forma de distinguir un uso
 * legítimo de un abuso de la llave que firma ante el SAT en nombre de una
 * persona, así que una versión reescribible de esta tabla no vale nada.
 *
 * La migración 014 la declaró cerrada —«neither the code nor an attacker
 * holding the app's connection can erase the history»— y no lo estaba: su
 * único REVOKE era FROM PUBLIC, que no toca el GRANT explícito a
 * mnemosine_app, y `rls-policies.sql` corre después de todas las
 * migraciones devolviéndole UPDATE y DELETE en la misma corrida.
 *
 * Lo que se fija aquí es sobre todo la capa FUERTE, el disparador de la
 * migración 035. La revocación de privilegios detiene a mnemosine_app, pero
 * el dueño del esquema y el superusuario ignoran los privilegios de tabla — y
 * esta suite corre precisamente como superusuario, que además migró y es el
 * dueño. Que estas pruebas pasen significa que ni él puede reescribirla.
 *
 * Sobre la capa de PRIVILEGIOS: la primera versión de este comentario decía
 * que no se podía probar aquí «porque la base efímera no provisiona
 * mnemosine_app». Es falso, y conviene dejar escrito por qué: los roles de
 * Postgres son de nivel CLÚSTER, no de base. `global-setup` no corre
 * `provision-roles.sql`, pero si alguna vez se corrió en este clúster el rol
 * existe, y entonces el bloque de GRANT de `rls-policies.sql` no retorna
 * temprano: se aplica también sobre la base efímera. Así que la capa se
 * comprueba abajo cuando el rol está, y el caso dice cuál de las dos ramas
 * tomó en vez de pasar callando.
 *
 * Lo que de verdad ninguna prueba puede cubrir es la coherencia entre las
 * tres listas —disparadores, el array de rls-policies.sql y el de
 * provision-roles.sql—, porque las dos últimas son texto que sólo se
 * interpreta al desplegar. Eso lo vigila el criterio E0.3 de
 * `src/plan/criterios.ts`.
 */

let f: Fixture;
let renglon: string;
let renglonDenegado: string;
let credencialId: string;
let rolDeLaApp = false;

beforeAll(async () => {
  f = await crearInquilino('Bitácora de credenciales');

  // La credencial padre. No hace falta bóveda ni material: la tabla guarda
  // sólo la referencia, que es justamente su razón de ser.
  const cred = await query<{ id: string }>(
    `INSERT INTO fiscal_credentials (
       tenant_id, entity_id, credential_type, rfc, cert_serial,
       valid_from, valid_to, vault_backend, vault_ref,
       consent_at, consent_by, consent_version
     ) VALUES ($1,$2,'efirma','AAA010101AAA','30001000000400000001',
       NOW() - interval '1 year', NOW() + interval '1 year', 'test', 'test://efirma',
       NOW(), 'prueba@example.com', 'v1')
     RETURNING id`,
    [f.tenantId, f.entityId]
  );
  credencialId = cred.rows[0].id;

  // El renglón con el que se intenta. Las columnas son las mismas que
  // escribe `logAccess` (services/fiscal-credentials/service.ts): si su
  // forma cambia, esta prueba se entera.
  const log = await query<{ id: string }>(
    `INSERT INTO fiscal_credential_access_log (
       credential_id, tenant_id, entity_id, purpose, actor, unattended,
       request_id, source_host, outcome, denied_reason, error
     ) VALUES ($1,$2,$3,'sat_auth','contador@example.com',false,
       'req-1','host-1','success',NULL,NULL)
     RETURNING id`,
    [credencialId, f.tenantId, f.entityId]
  );
  renglon = log.rows[0].id;

  // Un segundo renglón con OTRO desenlace. No es adorno: un disparador con
  // una cláusula WHEN —por ejemplo `WHEN (OLD.outcome = 'success')`— dejaría
  // protegidas sólo las filas que la cumplen, y una suite que ataque siempre
  // la misma fila pasaría entera sin notarlo. Se comprobó: con esa cláusula
  // añadida, las diez pruebas anteriores daban verde.
  const denegado = await query<{ id: string }>(
    `INSERT INTO fiscal_credential_access_log (
       credential_id, tenant_id, entity_id, purpose, actor, unattended,
       outcome, denied_reason
     ) VALUES ($1,$2,$3,'export','scheduler',true,'denied','rate_limit')
     RETURNING id`,
    [credencialId, f.tenantId, f.entityId]
  );
  renglonDenegado = denegado.rows[0].id;

  const rol = await query(`SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_app'`);
  rolDeLaApp = rol.rows.length > 0;
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

/**
 * Los rechazos se afirman por SQLSTATE además de por texto. `42501`
 * (insufficient_privilege) es el código que comparten las dos capas: lo
 * levanta el disparador con `USING ERRCODE` y es también el que devuelve
 * Postgres al denegar por privilegios. Afirmar sólo sobre el mensaje ataría
 * la prueba a la capa del disparador y la haría fallar por el motivo
 * equivocado el día que la detenga la otra.
 */
async function rechaza(sql: string, params: unknown[] = []): Promise<Error & { code?: string }> {
  try {
    await query(sql, params);
  } catch (e) {
    const err = e as Error & { code?: string };
    expect(err.code, `se esperaba 42501 y llegó ${err.code}: ${err.message}`).toBe('42501');
    return err;
  }
  throw new Error(`no rechazó: ${sql}`);
}

describe('fiscal_credential_access_log sólo admite INSERT', () => {
  it('registrar un acceso nuevo sigue funcionando', async () => {
    // Lo primero que hay que demostrar es que el cierre no rompió el acto
    // legítimo: si el disparador estorbara al INSERT, `withCredential` no
    // podría dejar rastro y el remedio sería peor que la enfermedad.
    const antes = await query<{ n: string }>(
      `SELECT count(*) AS n FROM fiscal_credential_access_log WHERE tenant_id = $1`,
      [f.tenantId]
    );
    await query(
      `INSERT INTO fiscal_credential_access_log (
         credential_id, tenant_id, entity_id, purpose, actor, unattended, outcome
       ) VALUES ($1,$2,$3,'validation','scheduler',true,'denied')`,
      [credencialId, f.tenantId, f.entityId]
    );
    const despues = await query<{ n: string }>(
      `SELECT count(*) AS n FROM fiscal_credential_access_log WHERE tenant_id = $1`,
      [f.tenantId]
    );
    expect(Number(despues.rows[0].n)).toBe(Number(antes.rows[0].n) + 1);
  });

  it('un UPDATE se rechaza, aunque lo intente el superusuario', async () => {
    await rechaza(
      `UPDATE fiscal_credential_access_log SET outcome = 'denied' WHERE id = $1`,
      [renglon]
    );
  });

  it('cambiar el ACTOR de un descifrado tampoco se puede', async () => {
    // El caso que importa no es borrar la fila: es reasignar a otro el
    // haber usado la e.firma.
    await rechaza(
      `UPDATE fiscal_credential_access_log SET actor = 'otro@example.com' WHERE id = $1`,
      [renglon]
    );
  });

  it('borrar el motivo de una denegación tampoco', async () => {
    await rechaza(
      `UPDATE fiscal_credential_access_log SET denied_reason = NULL, unattended = false
        WHERE tenant_id = $1`,
      [f.tenantId]
    );
  });

  it('un DELETE se rechaza', async () => {
    await rechaza(`DELETE FROM fiscal_credential_access_log WHERE id = $1`, [renglon]);
  });

  it('un DELETE masivo tampoco: no hay atajo por volumen', async () => {
    await rechaza(
      `DELETE FROM fiscal_credential_access_log WHERE tenant_id = $1`,
      [f.tenantId]
    );
  });

  it('TRUNCATE se rechaza: no dispara triggers de fila y necesita el suyo', async () => {
    await rechaza(`TRUNCATE fiscal_credential_access_log`);
  });

  it('un renglón DENEGADO está igual de protegido: no hay exención por contenido', async () => {
    // Ataca por id, no por tenant_id: si el disparador tuviera una cláusula
    // WHEN, un ataque masivo podría chocar antes con una fila protegida y
    // rebotar por ella, dejando pasar el caso.
    await rechaza(
      `UPDATE fiscal_credential_access_log SET denied_reason = NULL WHERE id = $1`,
      [renglonDenegado]
    );
    await rechaza(`DELETE FROM fiscal_credential_access_log WHERE id = $1`, [
      renglonDenegado,
    ]);
  });

  it('el renglón sigue intacto tras los seis intentos', async () => {
    const r = await query<{ id: string; actor: string; outcome: string }>(
      `SELECT id, actor, outcome FROM fiscal_credential_access_log WHERE id = $1`,
      [renglon]
    );
    expect(r.rows, 'la fila no puede haber desaparecido').toHaveLength(1);
    expect(r.rows[0].actor).toBe('contador@example.com');
    expect(r.rows[0].outcome).toBe('success');
  });

  it('el mensaje nombra ESTA tabla, no la otra bitácora', async () => {
    // La función de la migración 033 lleva 'audit_log' escrito en su
    // mensaje y sólo interpola TG_OP. Reutilizarla habría producido un
    // error que acusa a la tabla equivocada: un mensaje que miente sobre
    // qué se protegió, dentro del arreglo que existe para no tener eso.
    const err = await rechaza(
      `DELETE FROM fiscal_credential_access_log WHERE id = $1`,
      [renglon]
    );
    expect(err.message).toMatch(/fiscal_credential_access_log/);
    expect(err.message).not.toMatch(/audit_log/);
    expect(err.message, 'el mensaje explica por qué, no sólo que no se puede').toMatch(
      /quién descifró la e.firma/i
    );
  });
});

/**
 * LA CAPA BARATA, CUANDO SE PUEDE MIRAR.
 *
 * Es la que detiene a la aplicación antes de ejecutar nada, y la que la 014
 * creyó haber puesto: su REVOKE era `FROM PUBLIC`, que no toca el GRANT
 * explícito a mnemosine_app. Se comprueba con `has_table_privilege`, que
 * pregunta al catálogo por el privilegio efectivo en vez de leer el SQL.
 */
describe('la capa de privilegios sobre las dos bitácoras', () => {
  it('mnemosine_app no puede modificarlas — o se dice que el rol no está', async () => {
    if (!rolDeLaApp) {
      // Rama explícita: sin rol no hay privilegio que mirar, y el bloque de
      // rls-policies.sql ni siquiera corrió. Se afirma para que quede en el
      // informe cuál de las dos ramas se tomó, en vez de pasar en silencio.
      expect(
        rolDeLaApp,
        'el rol mnemosine_app no existe en este clúster: la capa de privilegios ' +
          'no se evaluó aquí y queda sólo bajo el criterio E0.3'
      ).toBe(false);
      return;
    }
    const r = await query<{ tabla: string; upd: boolean; del: boolean; ins: boolean }>(
      `SELECT t AS tabla,
              has_table_privilege('mnemosine_app', t, 'UPDATE') AS upd,
              has_table_privilege('mnemosine_app', t, 'DELETE') AS del,
              has_table_privilege('mnemosine_app', t, 'INSERT') AS ins
         FROM unnest(ARRAY['public.fiscal_credential_access_log','public.audit_log']) AS t`
    );
    expect(r.rows).toHaveLength(2);
    for (const fila of r.rows) {
      expect(fila.upd, `${fila.tabla}: la app puede hacer UPDATE`).toBe(false);
      expect(fila.del, `${fila.tabla}: la app puede hacer DELETE`).toBe(false);
      // Y que el cierre no se llevó por delante el acto legítimo.
      expect(fila.ins, `${fila.tabla}: la app ya no puede escribir el rastro`).toBe(true);
    }
  });
});

/**
 * La otra bitácora sigue cerrada. Las dos migraciones son independientes y
 * cada una tiene su función; esto fija que añadir la segunda no aflojó la
 * primera, que es el modo en que estas cosas se rompen.
 */
describe('audit_log sigue cerrada, y con su propio mensaje', () => {
  it('su disparador nombra audit_log y no la bitácora de credenciales', async () => {
    try {
      await query(`TRUNCATE audit_log`);
      throw new Error('debió lanzar');
    } catch (e) {
      const err = e as Error & { code?: string };
      expect(err.code).toBe('42501');
      expect(err.message).toMatch(/audit_log/);
      expect(err.message).not.toMatch(/fiscal_credential_access_log/);
    }
  });
});
