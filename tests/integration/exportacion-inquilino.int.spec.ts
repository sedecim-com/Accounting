import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import {
  exportarInquilino,
  listarExportaciones,
} from '../../src/services/backup/exportacion-inquilino.js';
import { restaurarRespaldo } from '../../src/services/backup/backup-service.js';

/**
 * LA EXPORTACIÓN DE A NO PUEDE TRAER NI UN DATO DE B.
 *
 * La auditoría encontró que `backup create` publicaba `-t/--tenant` y
 * `-e/--entity`, los ignoraba, y entregaba un pg_dump con los datos SIN
 * REDACTAR de todos los inquilinos: con un UUID inexistente el archivo pesaba
 * exactamente lo mismo. Estas pruebas son la forma de que eso no vuelva.
 *
 * SE AFIRMA EL PAR, siempre. Que lo de B no esté es la mitad barata: un
 * archivo vacío la pasa. La otra mitad —que lo de A SÍ esté— es la que le da
 * sentido, y por eso cada prueba de ausencia viene con la de presencia al lado.
 *
 * EL ROL: la suite corre como superusuario a propósito (global-setup.ts), y
 * para un superusuario RLS es INERTE — sin este cuidado, la exportación vería
 * las filas de todos y esta prueba pasaría en verde por el motivo equivocado.
 * Se usa el mismo truco que tenant-isolation.int.spec.ts: un rol NOLOGIN con
 * NOBYPASSRLS que el exportador asume con SET LOCAL ROLE. En producción ese
 * rol es `mnemosine_app`, que es el valor por omisión del módulo.
 */

const ROL = 'mnemosine_export_probe';
const MARCADOR_A = 'C-EXPORT-A-TESTIGO';
const MARCADOR_B = 'C-EXPORT-B-SECRETO-DE-B';
const MARCADOR_HERMANA = 'C-EXPORT-A2-HERMANA';

let a: Fixture;
let b: Fixture;
let hermana: Fixture;
let admin: pg.Client;
let directorio: string;

async function sembrarCliente(f: Fixture, marcador: string, nombre: string): Promise<void> {
  enterTenant(f.tenantId);
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'MXN', $4)`,
    [f.entityId, marcador, nombre, f.userId]
  );
}

beforeAll(async () => {
  a = await crearInquilino('Despacho A');
  b = await crearInquilino('Despacho B');
  hermana = await crearEntidadHermana(a, 'Sociedad hermana de A');

  await sembrarCliente(a, MARCADOR_A, 'Testigo del despacho A');
  await sembrarCliente(b, MARCADOR_B, 'Secreto del despacho B');
  await sembrarCliente(hermana, MARCADOR_HERMANA, 'Testigo de la hermana');

  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  // NOLOGIN y NOBYPASSRLS: nadie se conecta con él, sólo se asume. Postgres
  // decide el bypass por el rol ACTUAL, así que dentro de la transacción del
  // exportador la conexión de superusuario deja de serlo y las políticas
  // empiezan a filtrar de verdad.
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
      CREATE ROLE ${ROL} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROL}`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROL}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROL}`);

  directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-export-'));
}, 180_000);

afterAll(async () => {
  fs.rmSync(directorio, { recursive: true, force: true });
  if (admin) {
    // El rol es de nivel clúster y sobrevive a la base efímera: hay que
    // soltarlo a mano o la siguiente corrida lo hereda.
    await admin.query(`DROP OWNED BY ${ROL}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch(() => undefined);
    await admin.end();
  }
  await closeDatabase();
});

describe('el rol con el que se lee', () => {
  it('se niega a exportar si ignora RLS, en vez de entregar las filas de todos', async () => {
    // `postgres` es superusuario en cualquier clúster: nombrarlo como lector
    // es pedir exactamente el defecto que esto cierra.
    await expect(
      exportarInquilino({
        tenantId: a.tenantId,
        destino: directorio,
        nombre: 'nunca',
        rolLector: 'postgres',
      })
    ).rejects.toThrow(/ignora row level security/i);
    expect(
      fs.readdirSync(directorio).filter((n) => n.includes('nunca')),
      'y no deja un archivo a medias con nombre de exportación'
    ).toEqual([]);
  }, 60_000);

  it('se niega si el inquilino no existe, en vez de exportar lo de todos', async () => {
    await expect(
      exportarInquilino({
        tenantId: '00000000-0000-0000-0000-000000000000',
        destino: directorio,
        nombre: 'fantasma',
        rolLector: ROL,
      })
    ).rejects.toThrow(/No existe el inquilino/);
  }, 60_000);
});

describe('exportación por INQUILINO', () => {
  let archivo: string;
  let contenido: string;

  it('sale de una sola instantánea, bajo un rol sujeto a RLS, y lo declara', async () => {
    const r = await exportarInquilino({
      tenantId: a.tenantId,
      destino: directorio,
      nombre: 'inquilino-a',
      rolLector: ROL,
    });
    archivo = r.archivo;
    contenido = fs.readFileSync(archivo, 'utf-8');

    expect(r.manifiesto.leidoComo.rol).toBe(ROL);
    expect(r.manifiesto.leidoComo.aislamiento).toBe('REPEATABLE READ');
    expect(r.manifiesto.alcance.tipo).toBe('inquilino');
    expect(r.manifiesto.alcance.tenantId).toBe(a.tenantId);
    expect(r.manifiesto.alcance.tenantNombre).toBe('Despacho A');
    // Un artefacto que no se puede volver a meter no se llama respaldo.
    expect(r.manifiesto.restaurable).toBe(false);
    expect(r.manifiesto.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it('NO trae ni un dato del despacho B — y sí trae el de A', () => {
    expect(contenido, 'el marcador sembrado en B no puede aparecer').not.toContain(MARCADOR_B);
    expect(contenido, 'el marcador de B tampoco por su nombre').not.toContain('Secreto del despacho B');
    expect(contenido.includes(b.tenantId), 'ni el id del inquilino B').toBe(false);
    expect(contenido.includes(b.entityId), 'ni el id de su entidad').toBe(false);
    // El par: sin esto, un archivo vacío pasaría las tres afirmaciones de arriba.
    expect(contenido, 'lo de A sí está').toContain(MARCADOR_A);
    expect(contenido).toContain(a.entityId);
  });

  it('el alcance de inquilino SÍ trae a la sociedad hermana: es del mismo despacho', () => {
    expect(contenido).toContain(MARCADOR_HERMANA);
    expect(contenido).toContain(hermana.entityId);
  });

  it('lleva las tablas HIJAS, que no tienen tenant_id y llegan por su padre', async () => {
    const m = (await listarExportaciones(directorio)).find((x) => x.archivo === archivo)?.manifiesto;
    const hijas = m?.tablas.filter((t) => t.acotadaPor === 'rls-hija') ?? [];
    expect(
      hijas.map((t) => t.tabla),
      'sin ellas el archivo llevaría los asientos sin sus líneas'
    ).toContain('journal_entry_lines');
    expect(hijas.length).toBeGreaterThan(15);
  });

  it('cuenta las filas TABLA POR TABLA, y el conteo casa con el archivo', () => {
    const m = JSON.parse(
      fs.readFileSync(`${archivo}.manifiesto.json`, 'utf-8')
    ) as { tablas: { tabla: string; filas: number }[]; totalFilas: number };
    const lineas = fs.readFileSync(archivo, 'utf-8').trim().split('\n');
    // La primera línea es la cabecera de alcance; las demás son filas.
    expect(lineas.length - 1).toBe(m.totalFilas);
    const porTabla = new Map(m.tablas.map((t) => [t.tabla, t.filas]));
    expect(porTabla.get('tenants'), 'su propia fila de tenants, y sólo la suya').toBe(1);
    expect(porTabla.get('legal_entities'), 'las dos entidades del despacho A').toBe(2);
    expect((porTabla.get('customers') ?? 0) >= 2, 'el testigo de A y el de su hermana').toBe(true);
  });

  it('redacta password_hash y deja fuera las sesiones, y lo dice', () => {
    expect(contenido).not.toContain('password_hash');
    const m = JSON.parse(fs.readFileSync(`${archivo}.manifiesto.json`, 'utf-8')) as {
      noIncluye: string[];
      tablas: { tabla: string }[];
    };
    const dicho = m.noIncluye.join(' ');
    expect(dicho).toMatch(/password_hash/);
    expect(dicho).toMatch(/sessions/);
    expect(dicho).toMatch(/ENCRYPTION_KEY/);
    expect(m.tablas.map((t) => t.tabla)).not.toContain('sessions');
    // Los usuarios del despacho sí viajan: sin ellos, cada created_by apunta a
    // la nada.
    expect(m.tablas.map((t) => t.tabla)).toContain('users');
    expect(contenido).toContain(a.userId);
  });

  it('el hash del manifiesto casa, y una corrupción de un byte se detecta', async () => {
    const antes = await listarExportaciones(directorio);
    expect(antes.find((x) => x.archivo === archivo)?.integro).toBe(true);

    const copia = path.join(directorio, `corrupta${'.exportacion.ndjson'}`);
    const bytes = fs.readFileSync(archivo);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(copia, bytes);
    fs.copyFileSync(`${archivo}.manifiesto.json`, `${copia}.manifiesto.json`);

    const despues = await listarExportaciones(directorio);
    expect(despues.find((x) => x.archivo === copia)?.integro).toBe(false);
    fs.rmSync(copia);
    fs.rmSync(`${copia}.manifiesto.json`);
  });
});

describe('exportación por ENTIDAD', () => {
  let contenido: string;
  let manifiesto: {
    alcance: { tipo: string; entityId?: string; entityNombre?: string };
    tablas: { tabla: string; filas: number; acotadaPor: string }[];
    fueraDeAlcance: { tabla: string; motivo: string }[];
  };

  it('acota a una sola sociedad del despacho', async () => {
    const r = await exportarInquilino({
      tenantId: a.tenantId,
      entityId: a.entityId,
      destino: directorio,
      nombre: 'entidad-a',
      rolLector: ROL,
    });
    contenido = fs.readFileSync(r.archivo, 'utf-8');
    manifiesto = r.manifiesto as unknown as typeof manifiesto;
    expect(manifiesto.alcance.tipo).toBe('entidad');
    expect(manifiesto.alcance.entityId).toBe(a.entityId);
  }, 180_000);

  it('deja fuera a la sociedad HERMANA, que es el eje que RLS no defiende', () => {
    // crearInquilino crea inquilinos distintos, y cruzar de uno a otro cruza la
    // frontera que RLS SÍ defiende: una prueba escrita así puede pasar por el
    // motivo equivocado. El eje de `--entity` es este otro — dos sociedades del
    // MISMO despacho, donde el predicado del inquilino no acota nada.
    expect(contenido).not.toContain(MARCADOR_HERMANA);
    expect(contenido, 'y lo de la entidad pedida sí está').toContain(MARCADOR_A);
    expect(contenido).toContain(a.entityId);
    // Y sigue sin traer nada del otro despacho.
    expect(contenido).not.toContain(MARCADOR_B);
  });

  it('el id de la hermana sólo aparece donde el manifiesto dice que puede', () => {
    // EL PERÍMETRO EXACTO, en vez de un «no aparece» que sería falso. Los
    // usuarios del despacho viajan enteros —sin ellos cada `created_by` apunta
    // a la nada— y su `accessible_entities` nombra los ids de las otras
    // sociedades. Que se vea un ID no es que se vean sus DATOS, y la diferencia
    // se afirma aquí en lugar de dejarla a la buena fe: ninguna FILA del
    // archivo pertenece a la hermana.
    const filas = contenido
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as { t: string; r: Record<string, unknown> });

    const suyas = filas.filter((f) => f.r.entity_id === hermana.entityId);
    expect(suyas.map((f) => f.t), 'ninguna fila es de la sociedad hermana').toEqual([]);

    const tablasQueLoNombran = [
      ...new Set(
        filas.filter((f) => JSON.stringify(f.r).includes(hermana.entityId)).map((f) => f.t)
      ),
    ];
    expect(tablasQueLoNombran, 'y sólo lo nombra la tabla que el manifiesto declara').toEqual([
      'users',
    ]);
  });

  it('trae a la entidad misma, cuya columna de alcance es `id` y no `entity_id`', () => {
    const le = manifiesto.tablas.find((t) => t.tabla === 'legal_entities');
    expect(le?.filas, 'una sola: la pedida, no las dos del despacho').toBe(1);
    expect(le?.acotadaPor).toBe('id-de-la-entidad');
  });

  it('DECLARA lo que no pudo acotar, tabla por tabla y con su motivo', () => {
    expect(manifiesto.fueraDeAlcance.length).toBeGreaterThan(0);
    const nombres = manifiesto.fueraDeAlcance.map((f) => f.tabla);
    // `organizations` sólo lleva tenant_id: es un hecho del despacho y no hay
    // columna por la que recortarlo a una sociedad. Meterlo entero colaría las
    // filas de la hermana por la puerta de atrás.
    expect(nombres).toContain('organizations');
    for (const f of manifiesto.fueraDeAlcance) {
      expect(f.motivo.length, `${f.tabla} sale sin motivo`).toBeGreaterThan(10);
    }
  });
});

// ============================================================
// LO QUE LA PRIMERA VERSIÓN DE ESTA SUITE NO MIRABA.
//
// Una auditoría adversarial encontró que ninguna de las catorce pruebas de
// arriba sembraba un renglón de auditoría ni miraba `audit_log` en alcance de
// entidad — así que pasaban igual con el defecto dentro. El defecto: el plan de
// entidad clasificaba las tablas por el NOMBRE de la columna, y `audit_log`
// tiene `entity_id` que NO es una entidad legal, sino la mitad del par
// polimórfico (entity_type, entity_id) que apunta al objeto auditado. Compararlo
// con el id de la sociedad da cero filas SIEMPRE, y el manifiesto lo certificaba
// como «acotada por entity_id, 0 filas»: el rastro de auditoría se iba entero,
// en silencio y con un sello de corrección encima. Es el mismo defecto que esta
// exportación existe para cerrar, en el único sitio donde el código escribe su
// propio predicado en vez de dejar filtrar a RLS.
// ============================================================
describe('el rastro de auditoría no se pierde en silencio', () => {
  beforeAll(async () => {
    // Un renglón que audita una PÓLIZA de A: su entity_id es el de la póliza,
    // no el de la sociedad. Así es como lo escribe audit-log.ts en producción.
    await query(
      `INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id, new_values)
       VALUES ($1, $2, 'post', 'journal_entries', $3, $4::jsonb)`,
      [a.userId, a.tenantId, a.entityId, JSON.stringify({ testigo: MARCADOR_A })]
    );
  }, 60_000);

  it('en alcance de INQUILINO el renglón viaja: lo acota RLS por tenant_id', async () => {
    const r = await exportarInquilino({
      tenantId: a.tenantId,
      destino: directorio,
      nombre: 'auditoria-inquilino',
      rolLector: ROL,
    });
    const contenido = fs.readFileSync(r.archivo, 'utf-8');
    expect(contenido).toContain(MARCADOR_A);
    const m = r.manifiesto as unknown as { tablas: { tabla: string; filas: number }[] };
    const auditoria = m.tablas.find((t) => t.tabla === 'audit_log');
    expect(auditoria?.filas ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('en alcance de ENTIDAD se DECLARA fuera, en vez de salir con cero filas y sello de correcta', async () => {
    const r = await exportarInquilino({
      tenantId: a.tenantId,
      entityId: a.entityId,
      destino: directorio,
      nombre: 'auditoria-entidad',
      rolLector: ROL,
    });
    const m = r.manifiesto as unknown as {
      tablas: { tabla: string; filas: number; acotadaPor: string }[];
      fueraDeAlcance: { tabla: string; motivo: string }[];
    };
    // Lo que fallaba antes: audit_log aparecía en `tablas` con filas: 0.
    expect(m.tablas.find((t) => t.tabla === 'audit_log')).toBeUndefined();
    const fuera = m.fueraDeAlcance.find((f) => f.tabla === 'audit_log');
    expect(fuera, 'audit_log tiene que estar declarada fuera de alcance').toBeDefined();
    expect(fuera?.motivo).toMatch(/polim|no es una entidad legal/i);
  }, 180_000);

  it('la tabla se reconoce por su FORMA, no por su nombre', async () => {
    // La detección pregunta si hay clave foránea de `entity_id` a
    // legal_entities. Si alguien la cambiara por una lista de nombres, esta
    // afirmación seguiría pasando y la de arriba también — por eso se comprueba
    // el hecho del esquema en el que se apoya la decisión.
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM pg_constraint k
         JOIN pg_attribute aa ON aa.attrelid = k.conrelid AND aa.attnum = ANY (k.conkey)
        WHERE k.conrelid = 'public.audit_log'::regclass
          AND k.contype = 'f'
          AND k.confrelid = 'public.legal_entities'::regclass
          AND aa.attname = 'entity_id'`
    );
    expect(Number(r.rows[0].n)).toBe(0);
  });
});

// ============================================================
// UNA EXPORTACIÓN NO SE RESTAURA, Y DECIRLO NO BASTA.
//
// El manifiesto lleva `restaurable: false` y el CLI lo repite, pero la
// exportación se escribe en el MISMO directorio que los respaldos y `backup
// list` la publica en la MISMA columna. El gesto natural del operador —copiar el
// nombre que `list` acaba de dar y pegarlo en `restore`— llegaba a
// `restaurarRespaldo`, donde el fallo de pg_restore estaba degradado a «Avisos»:
// imprimía «✔ restaurado», salía 0, y dejaba una base con CERO tablas. El
// artefacto mal etiquetado volvía por la puerta de al lado, y por una que esta
// misma exportación abrió.
// ============================================================
describe('restaurar una exportación se niega en voz alta', () => {
  const destinoFalso = 'export_no_restaurable_probe';

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${destinoFalso}`);
  });

  it('lanza en vez de dar una base vacía por buena, y no deja el cadáver', async () => {
    const r = await exportarInquilino({
      tenantId: a.tenantId,
      destino: directorio,
      nombre: 'para-restaurar',
      rolLector: ROL,
    });

    await expect(restaurarRespaldo(r.archivo, destinoFalso)).rejects.toThrow(
      /no restauró nada|exportación/i
    );

    // Y la base a medio nacer no se queda con el nombre que el operador pidió:
    // mañana se leería como una restauración buena.
    const quedo = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [destinoFalso]);
    expect(quedo.rows.length).toBe(0);
  }, 180_000);
});
