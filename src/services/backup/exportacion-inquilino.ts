import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type pg from 'pg';
import { getClient } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// EXPORTACIÓN LÓGICA POR INQUILINO (o por entidad)
//
// POR QUÉ NO ES `backup create` CON UNA BANDERA MÁS. `backup create` vuelca
// con pg_dump, y pg_dump no filtra FILAS: no tiene cláusula WHERE, no conoce
// `app.current_tenant` y su credencial es justamente la que ignora RLS. El
// comando publicaba `-t/--tenant` y `-e/--entity` en su ayuda —«tenant (firm)
// whose data to scope to»—, los ignoraba, y entregaba el mismo archivo, byte
// por byte, con los datos SIN REDACTAR de TODOS los inquilinos. Se comprobó
// pasándole un UUID que no existe: el volcado pesaba igual y traía los dos
// despachos de la prueba. Una promesa que la herramienta usada no puede
// cumplir no se arregla con más banderas; hace falta otra herramienta.
//
// EL FILTRADO NO LO HACE ESTE MÓDULO: LO HACE LA BASE. Se lee por el pool de
// la APLICACIÓN, bajo un rol NOBYPASSRLS y con `app.current_tenant` fijado —
// el mismo mecanismo que `withTenant`/`enterTenant`—, así que quien recorta
// las filas es la política `tenant_isolation`. Consecuencia deliberada: aunque
// la lista de tablas de aquí abajo fuera incorrecta, la base sigue negándose a
// entregar filas de otro inquilino. Usar la credencial de respaldo
// (BACKUP_DATABASE_URL, BYPASSRLS) reintroduciría el defecto entero, así que
// este módulo NO la toca ni por error: si el rol de conexión ignora RLS, se
// asume uno que no, y si no se puede, se aborta ANTES de escribir un byte.
//
// LAS TABLAS SE ENUMERAN CON LA CONSULTA DE rls-policies.sql, no con una lista
// escrita a mano. Dos razones, y las dos son por lo que ya pasó con
// `ai_external_ops`: (1) una tabla que gane `tenant_id`/`entity_id` mañana
// entra sola en la exportación igual que gana su política; (2) no puede
// existir una tabla acotada que la exportación no vea — y eso se COMPRUEBA al
// final contra pg_policies, no se supone.
//
// SE LLAMA EXPORTACIÓN Y NO RESPALDO, a propósito. Ver `restaurable` más
// abajo: este artefacto NO tiene camino de vuelta probado, y este módulo
// existe —lo dice su hermano backup-service.ts— para no contar mentiras. La
// vía de recuperación ante desastre sigue siendo `backup create` sin banderas.
// ============================================================

/**
 * Las cuatro que rls-policies.sql excluye de la política, copiadas de allí.
 *
 * `users` y `sessions` porque el camino de autenticación tiene que leerlas
 * ANTES de saber a qué inquilino pertenece quien llama; `tenants` porque es la
 * raíz de la jerarquía; `migrations` porque no tiene alcance.
 *
 * Que no lleven política NO las deja fuera de la exportación por sí solo: dos
 * de ellas describen al inquilino y viajan acotadas A MANO (ver `A_MANO`).
 */
const EXCLUIDAS_DE_LA_POLITICA = ['users', 'sessions', 'tenants', 'migrations'];

/**
 * Lo que la exportación NO lleva, y por qué. Se escribe SIEMPRE en el
 * manifiesto: un archivo que no dice lo que le falta se lee como completo.
 */
const NO_INCLUYE = [
  'La llave del vault (.mnemosine-vault/vault.key o el gestor de secretos) y ENCRYPTION_KEY: ' +
    'viven fuera de la base, así que las credenciales fiscales y los datos bancarios cifrados ' +
    'de este archivo son texto ilegible sin ellas.',
  '`users.password_hash`: es un verificador de credencial, no un dato contable. Las demás ' +
    'columnas de los usuarios del despacho SÍ viajan, porque las filas exportadas los citan ' +
    'por `created_by` y sin ellos no se pueden leer — también en un alcance de entidad, de modo ' +
    'que `accessible_entities` puede nombrar los ids de las OTRAS sociedades del despacho. Sus ' +
    'IDS, nunca sus datos: ninguna fila de esas sociedades entra en un archivo de entidad.',
  '`sessions`: sus `refresh_token_hash` son credenciales VIVAS. Una sesión no es un hecho ' +
    'contable y reponerla es entrar de nuevo, así que no sale de la base.',
  '`identities`: el enlace de identidad federada (proveedor, subject, emisor) es del camino de ' +
    'autenticación, corre antes del contexto de inquilino y no atribuye ningún asiento.',
  '`migrations`: describe el ESQUEMA, no al inquilino. Su estado viaja resumido en ' +
    '`esquema.ultimaMigracion`, que es lo que hace falta para saber contra qué código leer esto.',
  'Los datos de referencia globales (`exchange_rates`, `tax_parameters`, `tax_tables`): no son ' +
    'de nadie en particular y los repone el esquema, no este archivo.',
  'Los archivos XML/PDF que vivan fuera de la base (rutas en cfdi_xml_url / pdf_url).',
];

export const SUFIJO_EXPORTACION = '.exportacion.ndjson';
export const SUFIJO_MANIFIESTO = '.manifiesto.json';

/** Rol bajo el que se lee cuando el de conexión ignora RLS. */
const ROL_DE_LA_APLICACION = 'mnemosine_app';

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

export type TipoDeAlcance = 'inquilino' | 'entidad';

export interface Alcance {
  tipo: TipoDeAlcance;
  tenantId: string;
  tenantNombre: string;
  entityId?: string;
  entityNombre?: string;
}

export interface TablaExportada {
  tabla: string;
  filas: number;
  /** Quién recortó esas filas. Nunca «yo lo supuse». */
  acotadaPor:
    | 'rls-inquilino'
    | 'rls-hija'
    | 'entity_id'
    // Su `entity_id` admite NULL: las filas sin entidad son del despacho y no
    // viajan en un archivo cuyo alcance dice «entidad». Es una variante propia y
    // no una nota al pie de 'entity_id' porque el conteo de esa tabla sale más
    // bajo por una razón que el lector tiene que poder ver en el manifiesto.
    | 'entity_id-sin-las-de-despacho'
    | 'id-de-la-entidad'
    | 'padre'
    | 'a-mano';
}

export interface TablaFuera {
  tabla: string;
  motivo: string;
}

export interface ManifiestoExportacion {
  /** Versión del formato del manifiesto, para que un lector futuro sepa leerlo. */
  formato: 1;
  tipo: 'exportacion-logica';
  /**
   * FALSO, y dicho aquí antes que en ninguna otra parte.
   *
   * No existe camino de vuelta probado para este archivo: `users.password_hash`
   * va redactado y es NOT NULL, las filas tienen orden de dependencia por clave
   * foránea que nadie resuelve todavía, y `account_balances` volvería a
   * calcularse con los disparadores del mayor. Llamar «respaldo» a esto sería
   * exactamente la mentira que este módulo existe para no contar. Para
   * recuperación ante desastre: `mnemosine backup create` (instalación entera)
   * y `mnemosine backup restore`.
   */
  restaurable: false;
  creado: string;
  alcance: Alcance;
  /** La última migración aplicada: sin esto, leer esto es adivinar contra qué código. */
  esquema: { ultimaMigracion: string; migracionesAplicadas: number };
  base: string;
  archivo: string;
  bytes: number;
  /** SHA-256 del NDJSON: detecta corrupción silenciosa en el almacenamiento. */
  sha256: string;
  /** Con qué privilegio se leyó. Un export leído por un rol que ignora RLS no vale. */
  leidoComo: { rol: string; sujetoARls: true; aislamiento: 'REPEATABLE READ' };
  tablas: TablaExportada[];
  totalFilas: number;
  /** Lo que el archivo NO lleva. Se escribe SIEMPRE. */
  noIncluye: string[];
  /** Tablas acotadas que quedaron fuera de ESTE alcance, con su motivo. */
  fueraDeAlcance: TablaFuera[];
}

export interface OpcionesExportacion {
  tenantId: string;
  /** Acota además por entidad legal. Sin él, el alcance es el inquilino entero. */
  entityId?: string;
  /** Directorio destino. Se crea si no existe. */
  destino: string;
  /** Sólo para pruebas: fija el nombre en vez de derivarlo del reloj. */
  nombre?: string;
  /**
   * Rol bajo el que leer. Por omisión `mnemosine_app`, el de la aplicación.
   * Existe como opción porque una instalación puede haber nombrado el suyo de
   * otro modo — y porque la suite de integración corre como superusuario a
   * propósito y necesita nombrar el rol NOBYPASSRLS con el que se comprueba.
   * NO es una puerta trasera: la comprobación de abajo se aplica al rol que
   * quede efectivo, se llame como se llame.
   */
  rolLector?: string;
}

export interface ResultadoExportacion {
  archivo: string;
  manifiestoEn: string;
  manifiesto: ManifiestoExportacion;
}

interface Acotada {
  tabla: string;
  tieneTenant: boolean;
  tieneEntidad: boolean;
  /** `entity_id` admite NULL: esas filas son del despacho, no de una sociedad. */
  entidadNullable: boolean;
  /** Tiene `entity_id` pero SIN clave foránea a legal_entities: no es una entidad. */
  entidadEsPolimorfica: boolean;
}

interface Hija {
  tabla: string;
  padre: string;
  fk: string;
}

interface Plan {
  tabla: string;
  proyeccion: string;
  where: string | null;
  parametros: unknown[];
  acotadaPor: TablaExportada['acotadaPor'];
}

/**
 * LA MISMA CONSULTA QUE rls-policies.sql, palabra por palabra en lo que
 * importa: pg_class/pg_attribute, esquema public, tablas ordinarias o
 * particionadas, sin particiones hijas, columna `tenant_id` o `entity_id`, y
 * fuera las cuatro excluidas. Si mañana cambia allí, esta se queda corta —
 * y por eso existe `comprobarQueNoFaltaNinguna()`, que lo acusa.
 */
async function tablasAcotadas(client: pg.PoolClient): Promise<Acotada[]> {
  const r = await client.query<{
    tabla: string;
    tiene_tenant: boolean;
    tiene_entidad: boolean;
    entidad_nullable: boolean;
    entidad_polimorfica: boolean;
  }>(
    `SELECT c.relname AS tabla,
            bool_or(a.attname = 'tenant_id') AS tiene_tenant,
            bool_or(a.attname = 'entity_id') AS tiene_entidad,
            bool_or(a.attname = 'entity_id' AND NOT a.attnotnull) AS entidad_nullable,
            -- ¿Su \`entity_id\` apunta de verdad a una entidad legal? Se pregunta
            -- por la FORMA —¿hay clave foránea de esa columna a legal_entities?—
            -- y no por una lista de nombres, que envejecería en silencio. Sin
            -- FK, la columna es la mitad de un par polimórfico y acotar por ella
            -- no significa lo que parece.
            NOT EXISTS (
              SELECT 1
                FROM pg_constraint k
                JOIN pg_attribute aa ON aa.attrelid = k.conrelid AND aa.attnum = ANY (k.conkey)
               WHERE k.conrelid = c.oid
                 AND k.contype = 'f'
                 AND k.confrelid = 'public.legal_entities'::regclass
                 AND aa.attname = 'entity_id'
            ) AS entidad_polimorfica
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND a.attname IN ('tenant_id', 'entity_id')
        AND c.relname <> ALL ($1::text[])
      GROUP BY c.oid, c.relname
      ORDER BY c.relname`,
    [EXCLUIDAS_DE_LA_POLITICA]
  );
  return r.rows.map((f) => ({
    tabla: f.tabla,
    tieneTenant: f.tiene_tenant,
    tieneEntidad: f.tiene_entidad,
    entidadNullable: f.entidad_nullable,
    entidadEsPolimorfica: f.entidad_polimorfica,
  }));
}

/**
 * Las tablas HIJAS, con su padre y su clave, leídos DEL PREDICADO QUE POSTGRES
 * GUARDA.
 *
 * La consulta de arriba no las ve: no llevan `tenant_id` ni `entity_id` y
 * llegan a su inquilino por la clave foránea del padre — son las líneas de
 * póliza, las de factura, los movimientos de banco. Una exportación que las
 * omitiera entregaría los asientos SIN SUS LÍNEAS, que es peor que no
 * entregar nada.
 *
 * El par (padre, clave) no se copia a mano de rls-policies.sql: se saca del
 * `qual` deparseado de la política `tenant_isolation_child`, que es la regla
 * que la base aplica de verdad. Si el deparseo dejara de casar con este patrón
 * se ROMPE en voz alta: perder una hija en silencio es justo lo que no puede
 * pasar.
 */
async function tablasHijas(client: pg.PoolClient): Promise<Hija[]> {
  const r = await client.query<{ tabla: string; qual: string | null }>(
    `SELECT tablename AS tabla, qual
       FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation_child'
      ORDER BY tablename`
  );
  return r.rows.map((f) => {
    const m = /FROM\s+([a-z_][a-z0-9_]*)\s+p\s+WHERE\s+\(p\.id\s*=\s*[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)\)/i.exec(
      f.qual ?? ''
    );
    if (!m) {
      throw new ValidationError(
        `No se pudo leer de qué padre cuelga "${f.tabla}": su política tenant_isolation_child ` +
          `dice «${(f.qual ?? '').replace(/\s+/g, ' ').trim()}» y no encaja con el patrón que ` +
          'rls-policies.sql genera. Antes que exportar esa tabla sin acotarla —o dejarla fuera ' +
          'sin decirlo— se detiene aquí.'
      );
    }
    return { tabla: f.tabla, padre: m[1], fk: m[2] };
  });
}

/**
 * NO PUEDE EXISTIR UNA TABLA ACOTADA QUE LA EXPORTACIÓN NO VEA.
 *
 * Las dos enumeraciones de arriba derivan del ESQUEMA (columnas) y del
 * PREDICADO (política hija). Esta comprueba el resultado contra el censo real
 * de políticas: si la base protege una tabla que el plan no toca, el archivo
 * saldría incompleto y con cara de completo. Se falla antes de escribir.
 */
function comprobarQueNoFaltaNinguna(conPolitica: string[], planeadas: Set<string>): void {
  const huerfanas = conPolitica.filter((t) => !planeadas.has(t));
  if (huerfanas.length > 0) {
    throw new ValidationError(
      `La base acota ${huerfanas.length} tabla(s) que esta exportación no enumera: ` +
        `${huerfanas.join(', ')}. Un archivo al que le faltan tablas acotadas parece completo y ` +
        'no lo está. Revisa src/database/rls-policies.sql contra la enumeración de ' +
        'src/services/backup/exportacion-inquilino.ts antes de volver a exportar.'
    );
  }
}

/**
 * LAS COLUMNAS DE `users` SE CONGELAN AQUÍ, y romper esto es el objetivo.
 *
 * `users` no lleva política —el login la lee antes de saber de qué inquilino
 * es quien llama—, así que la acota este módulo a mano, y su redacción
 * (`password_hash` fuera) también es de este módulo. Una columna nueva entraría
 * al archivo sin que nadie decidiera si es secreto. Por eso, cuando la tabla
 * cambia, la exportación se DETIENE y pide la decisión: es la clase de fallo
 * que se quiere ruidoso.
 */
const COLUMNAS_DE_USERS = [
  'id', 'tenant_id', 'email', 'password_hash', 'first_name', 'last_name', 'is_active',
  'roles', 'permissions', 'accessible_entities', 'last_login_at', 'created_at', 'updated_at',
  'is_service_account',
];

async function comprobarColumnasDeUsers(client: pg.PoolClient): Promise<void> {
  const r = await client.query<{ columnas: string[] }>(
    // `::text` no es adorno: `attname` es de tipo `name`, y node-pg no tiene
    // parseador para `name[]` — devolvía la cadena cruda «{id,tenant_id,…}» y
    // la comparación reventaba antes de poder decir nada útil.
    `SELECT array_agg(a.attname::text ORDER BY a.attnum) AS columnas
       FROM pg_attribute a
      WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped`
  );
  const hoy = (r.rows[0]?.columnas ?? []).slice().sort();
  const esperadas = COLUMNAS_DE_USERS.slice().sort();
  if (hoy.join(',') !== esperadas.join(',')) {
    const nuevas = hoy.filter((c) => !esperadas.includes(c));
    const idas = esperadas.filter((c) => !hoy.includes(c));
    throw new ValidationError(
      '`users` ya no tiene las columnas que esta exportación sabe redactar' +
        (nuevas.length ? ` (nuevas: ${nuevas.join(', ')})` : '') +
        (idas.length ? ` (desaparecidas: ${idas.join(', ')})` : '') +
        '. Decide si cada columna nueva es secreto ANTES de que salga en un archivo: ' +
        'actualiza COLUMNAS_DE_USERS y, si toca, la lista de redacción en ' +
        'src/services/backup/exportacion-inquilino.ts.'
    );
  }
}

function identificador(nombre: string): string {
  if (!IDENTIFICADOR.test(nombre)) {
    throw new ValidationError(`Nombre de objeto no exportable: "${nombre}".`);
  }
  return nombre;
}

/**
 * `public.<tabla>` compuesto AQUÍ y no escrito en la plantilla del SQL.
 *
 * Calificar el esquema importa —una tabla homónima en otro esquema del
 * search_path cambiaría lo que se exporta sin cambiar una línea—, pero
 * `FROM public.${tabla}` deja en el literal la cadena «public.» seguida de una
 * interpolación, y el contrato código↔esquema (tests/integration/helpers/
 * sql-scan.ts) la lee como una consulta contra una tabla llamada «public».
 * Componiendo el nombre entero fuera de la plantilla, el escáner ve
 * `FROM ${...}` y se abstiene, que es la respuesta correcta: un nombre de tabla
 * que se decide en tiempo de ejecución no se puede comprobar estáticamente.
 */
function tablaCalificada(nombre: string): string {
  return `public.${identificador(nombre)}`;
}

/**
 * QUIÉN LEE, y por qué esto es la pieza que sostiene todo lo demás.
 *
 * RLS es INERTE para un superusuario o para un rol con BYPASSRLS: en ese
 * estado la exportación devolvería las filas de todos y el archivo diría, en
 * su manifiesto, que es de uno. Postgres decide el bypass por el rol ACTUAL,
 * no por el de conexión, así que basta con asumir el de la aplicación dentro
 * de la transacción (SET LOCAL ROLE, el mismo paso HACIA ABAJO que hace la
 * consulta pública en src/database/consulta-publica.ts) y volver a preguntar.
 *
 * Y se vuelve a preguntar de verdad: no se confía en que el rol pedido sea el
 * que se cree. Si tras el cambio el rol efectivo sigue ignorando RLS, se
 * aborta — antes de crear el archivo.
 */
async function leerBajoRolSujetoARls(client: pg.PoolClient, rolPedido: string): Promise<string> {
  const preguntar = async (): Promise<{ rol: string; ignora: boolean }> => {
    const r = await client.query<{ rol: string; ignora: boolean }>(
      `SELECT current_user AS rol,
              COALESCE(rolsuper OR rolbypassrls, false) AS ignora
         FROM pg_roles WHERE rolname = current_user`
    );
    const f = r.rows[0];
    if (!f) throw new ValidationError('No se pudo leer el rol de conexión.');
    return f;
  };

  const inicial = await preguntar();
  if (!inicial.ignora) return inicial.rol;

  try {
    await client.query(`SET LOCAL ROLE ${identificador(rolPedido)}`);
  } catch (err) {
    throw new ValidationError(
      `El rol de conexión "${inicial.rol}" ignora row level security (superusuario o BYPASSRLS) ` +
        `y no se pudo asumir "${rolPedido}" para bajar de privilegio: ${(err as Error).message}\n` +
        'Ese rol lo crea scripts/provision-roles.sql. Exportar un inquilino con un rol que ve ' +
        'todas las filas produciría un archivo con datos de otros despachos y un manifiesto que ' +
        'dice que no — exactamente el defecto que esta exportación existe para cerrar.'
    );
  }

  const efectivo = await preguntar();
  if (efectivo.ignora) {
    throw new ValidationError(
      `El rol "${efectivo.rol}" también ignora row level security. Quien recorta las filas de ` +
        'esta exportación es la política tenant_isolation, y para un rol con BYPASSRLS esa ' +
        'política no existe. Nombra un rol NOBYPASSRLS (mnemosine_app) o no exportes.'
    );
  }
  return efectivo.rol;
}

/** Orden estable: la clave primaria. Sin ella, dos exportaciones iguales difieren. */
async function clavesPrimarias(client: pg.PoolClient): Promise<Map<string, string>> {
  const r = await client.query<{ tabla: string; clave: string | null }>(
    `SELECT c.relname AS tabla,
            (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS clave
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`
  );
  const m = new Map<string, string>();
  for (const f of r.rows) if (f.clave) m.set(f.tabla, f.clave);
  return m;
}

/**
 * Las dos tablas SIN política que sí describen al inquilino, acotadas a mano.
 *
 * `tenants`: su propia fila. Un archivo que no dice de quién es no se puede
 * custodiar, y el nombre del despacho no está en ninguna otra tabla.
 * `users`: los del inquilino, sin `password_hash`. Sin ellos, cada
 * `created_by` de las filas exportadas apunta a la nada.
 * `sessions` y `migrations` no entran: ver NO_INCLUYE.
 */
function A_MANO(tenantId: string): Plan[] {
  return [
    {
      tabla: 'tenants',
      proyeccion: 'to_jsonb(t)',
      where: 't.id = $1',
      parametros: [tenantId],
      acotadaPor: 'a-mano',
    },
    {
      tabla: 'users',
      // `- 'password_hash'` y no un SELECT de columnas: así una columna nueva
      // no se cuela por olvido — y comprobarColumnasDeUsers() se encarga de que
      // tampoco se cuele por descuido.
      proyeccion: `to_jsonb(t) - 'password_hash'`,
      where: 't.tenant_id = $1',
      parametros: [tenantId],
      acotadaPor: 'a-mano',
    },
  ];
}

/**
 * QUÉ SIGNIFICA `--entity` PARA UNA TABLA QUE SÓLO TIENE `tenant_id`.
 *
 * Es la pregunta que decide si el archivo miente. Hay quince de esas
 * —`organizations`, `integration_credentials`, `pac_preferences`, los lotes de
 * nómina, la configuración de anclaje— y son hechos del DESPACHO, no de la
 * sociedad: no hay columna por la que recortarlas a una entidad. Meterlas
 * enteras en un archivo que dice «alcance: entidad» colaría las filas de la
 * sociedad hermana por la puerta de atrás, que es la misma clase de fuga que
 * esta exportación viene a cerrar. Así que quedan FUERA y el manifiesto las
 * nombra una por una: un límite declarado es utilizable; uno silencioso, no.
 *
 * La única excepción es `legal_entities`, y es una excepción de forma, no de
 * criterio: la entidad no tiene `entity_id` porque ELLA es la entidad, y su
 * columna de alcance es `id`. Sin esta línea, un export de entidad no llevaría
 * a la entidad misma.
 */
function planDeEntidad(a: Acotada, entityId: string): Plan | TablaFuera {
  if (a.tabla === 'legal_entities') {
    return {
      tabla: a.tabla,
      proyeccion: 'to_jsonb(t)',
      where: 't.id = $1',
      parametros: [entityId],
      acotadaPor: 'id-de-la-entidad',
    };
  }
  // `entity_id` NO SIEMPRE ES UNA ENTIDAD LEGAL. En audit_log es la mitad de un
  // par polimórfico `(entity_type, entity_id)` que apunta al OBJETO auditado —
  // una póliza, una factura, un cobro—, y por eso esa tabla no tiene clave
  // foránea a legal_entities y sí tiene `entity_type NOT NULL` al lado.
  // Compararla con el id de la sociedad da CERO filas en toda instalación real,
  // y el manifiesto lo habría certificado como «acotada por entity_id, 0 filas»:
  // quien leyera el archivo concluiría que esa sociedad no tiene rastro de
  // auditoría, cuando lo que pasa es que se fue entero y en silencio. Es
  // exactamente el defecto que esta exportación existe para cerrar, en el único
  // sitio donde el código escribe su propio predicado en vez de dejar filtrar a
  // RLS. Se detecta por la FORMA de la tabla —columna de tipo al lado, sin FK a
  // legal_entities— y no por una lista de nombres, que envejecería.
  if (a.tieneEntidad && a.entidadEsPolimorfica) {
    return {
      tabla: a.tabla,
      motivo:
        'su `entity_id` no es una entidad legal: es la mitad del par polimórfico (entity_type, ' +
        'entity_id) que apunta al objeto auditado, sin clave foránea a legal_entities. Acotar por ' +
        'esa columna daría cero filas y las perdería en silencio. Va completa en el alcance «inquilino».',
    };
  }
  if (a.tieneEntidad) {
    return {
      tabla: a.tabla,
      proyeccion: 'to_jsonb(t)',
      where: 't.entity_id = $1',
      parametros: [entityId],
      // Cuando `entity_id` admite NULL, esas filas son del DESPACHO y no de
      // ninguna sociedad (idempotency_keys, policy_decisions). No viajan en un
      // archivo cuyo alcance dice «entidad», y el manifiesto lo dice aquí en
      // vez de dejar que el lector lo deduzca de un conteo más bajo.
      acotadaPor: a.entidadNullable ? 'entity_id-sin-las-de-despacho' : 'entity_id',
    };
  }
  return {
    tabla: a.tabla,
    motivo:
      'sólo lleva tenant_id: es un hecho del despacho y no hay columna por la que acotarlo a una ' +
      'entidad. Va completa en el alcance «inquilino».',
  };
}

async function sha256De(archivo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(archivo);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * El fallo de escritura NO se espera eternamente ni se pierde.
 *
 * Dos trampas del mismo objeto: un `write()` que devuelve `false` y luego
 * revienta —disco lleno, sistema de archivos de sólo lectura— nunca emite
 * `drain`, así que un `await` a secas sobre ese evento cuelga el proceso para
 * siempre; y un `error` sin oyente en un stream tumba a Node entero. Por eso el
 * error se captura al crear el stream, se guarda, y aquí se convierte en una
 * excepción normal que el `catch` de arriba puede tratar: borrar el archivo a
 * medias y contar por qué.
 */
interface Salida {
  stream: fs.WriteStream;
  error?: Error;
}

function abrirSalida(archivo: string): Salida {
  const salida: Salida = { stream: fs.createWriteStream(archivo, { mode: 0o600 }) };
  salida.stream.on('error', (err: Error) => {
    salida.error = err;
    salida.stream.emit('drain');
  });
  return salida;
}

function siFalloLaEscritura(salida: Salida): void {
  if (!salida.error) return;
  throw new ValidationError(
    `No se pudo escribir la exportación: ${salida.error.message}. El archivo a medias se borra.`
  );
}

async function escribir(salida: Salida, linea: string): Promise<void> {
  siFalloLaEscritura(salida);
  if (!salida.stream.write(linea)) {
    await new Promise<void>((resolve) => salida.stream.once('drain', resolve));
  }
  siFalloLaEscritura(salida);
}

const LOTE = 1000;

/**
 * Vuelca una tabla por CURSOR, no de un tirón.
 *
 * El cursor vive dentro de la misma transacción REPEATABLE READ, así que ve la
 * misma instantánea que todas las demás tablas, y la memoria del proceso no
 * crece con el tamaño del mayor — que es el caso que importa, porque
 * `journal_entry_lines` es la tabla grande de cualquier despacho con años.
 */
async function volcarTabla(
  client: pg.PoolClient,
  salida: Salida,
  plan: Plan,
  orden: string | undefined
): Promise<number> {
  const tabla = tablaCalificada(plan.tabla);
  const sql =
    // El paréntesis no es cosmético: `::` liga más fuerte que el `-` de jsonb,
    // así que sin él la proyección de `users` se convertía en
    // `to_jsonb(t) - ('password_hash'::text)` — jsonb, no texto — y cada fila
    // llegaba a JavaScript como objeto para acabar escrita «[object Object]».
    `SELECT (${plan.proyeccion})::text AS fila FROM ${tabla} t` +
    (plan.where ? ` WHERE ${plan.where}` : '') +
    (orden ? ` ORDER BY ${orden}` : '');
  await client.query(`DECLARE cur_exportacion NO SCROLL CURSOR FOR ${sql}`, plan.parametros);
  let filas = 0;
  try {
    for (;;) {
      const lote = await client.query<{ fila: string }>(`FETCH ${LOTE} FROM cur_exportacion`);
      if (lote.rows.length === 0) break;
      await escribir(
        salida,
        lote.rows.map((f) => `{"t":${JSON.stringify(plan.tabla)},"r":${f.fila}}\n`).join('')
      );
      filas += lote.rows.length;
      if (lote.rows.length < LOTE) break;
    }
  } finally {
    await client.query('CLOSE cur_exportacion').catch(() => undefined);
  }
  return filas;
}

/**
 * Exporta un inquilino —o una de sus entidades— a NDJSON, con su manifiesto.
 *
 * TODO SALE DE LA MISMA INSTANTÁNEA. Una transacción única en REPEATABLE READ
 * y de sólo lectura: el catálogo promete «consistente», y exportar tabla por
 * tabla en transacciones distintas produce archivos con un cobro cuya factura
 * no está, o con una línea de póliza cuya póliza se posteó después. Que sea
 * READ ONLY es la otra mitad: una exportación que pudiera escribir no sería
 * una exportación.
 */
export async function exportarInquilino(
  opts: OpcionesExportacion
): Promise<ResultadoExportacion> {
  if (!opts.tenantId) {
    throw new ValidationError('Una exportación por inquilino necesita el id del inquilino.');
  }
  fs.mkdirSync(opts.destino, { recursive: true });

  const client = await getClient();
  let salida: Salida | undefined;
  let archivo = '';
  try {
    // El nivel de aislamiento viaja EN el BEGIN, así que esta transacción no
    // puede salir de withTransaction(): aquel abre con un BEGIN pelado y fija
    // el inquilino con la primera consulta, y para entonces
    // «SET TRANSACTION ISOLATION LEVEL» ya llega tarde. El mecanismo de
    // inquilino es el mismo de connection.ts —set_config con ámbito local—,
    // sólo que la transacción la abre este módulo.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const rol = await leerBajoRolSujetoARls(client, opts.rolLector ?? ROL_DE_LA_APLICACION);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', opts.tenantId]);

    const base = (await client.query<{ b: string }>('SELECT current_database() AS b')).rows[0].b;

    // El inquilino tiene que EXISTIR. El defecto que originó todo esto se veía
    // justo aquí: con un UUID inexistente el comando entregaba un archivo del
    // mismo tamaño, con los datos de todos, y nadie se enteraba.
    const elInquilino = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE id = $1',
      [opts.tenantId]
    );
    if (elInquilino.rows.length === 0) {
      throw new ValidationError(
        `No existe el inquilino ${opts.tenantId}. Una exportación de un inquilino que no existe ` +
          'no es un archivo vacío: es un archivo que no se sabe de quién es.'
      );
    }

    const alcance: Alcance = {
      tipo: opts.entityId ? 'entidad' : 'inquilino',
      tenantId: opts.tenantId,
      tenantNombre: elInquilino.rows[0].name,
    };

    if (opts.entityId) {
      // Se resuelve BAJO RLS y bajo el rol de la aplicación: si la entidad es
      // de otro inquilino, aquí no aparece, y el mensaje es el mismo que si no
      // existiera — la frontera no se cuenta.
      const laEntidad = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM legal_entities WHERE id = $1',
        [opts.entityId]
      );
      if (laEntidad.rows.length === 0) {
        throw new ValidationError(
          `El inquilino ${opts.tenantId} no tiene ninguna entidad ${opts.entityId}.`
        );
      }
      alcance.entityId = laEntidad.rows[0].id;
      alcance.entityNombre = laEntidad.rows[0].name;
    }

    await comprobarColumnasDeUsers(client);

    const acotadas = await tablasAcotadas(client);
    const hijas = await tablasHijas(client);
    const orden = await clavesPrimarias(client);

    const planes: Plan[] = [];
    const fuera: TablaFuera[] = [];

    if (opts.entityId) {
      const dentro = new Set<string>();
      for (const a of acotadas) {
        const p = planDeEntidad(a, opts.entityId);
        if ('motivo' in p) {
          fuera.push(p);
          continue;
        }
        planes.push(p);
        dentro.add(a.tabla);
      }
      for (const h of hijas) {
        const padre = acotadas.find((a) => a.tabla === h.padre);
        if (!padre || !dentro.has(h.padre)) {
          fuera.push({
            tabla: h.tabla,
            motivo: `cuelga de "${h.padre}", que queda fuera de un alcance de entidad`,
          });
          continue;
        }
        const columnaDelPadre = h.padre === 'legal_entities' ? 'p.id' : 'p.entity_id';
        planes.push({
          tabla: h.tabla,
          proyeccion: 'to_jsonb(t)',
          where:
            `EXISTS (SELECT 1 FROM ${tablaCalificada(h.padre)} p ` +
            `WHERE p.id = t.${identificador(h.fk)} AND ${columnaDelPadre} = $1)`,
          parametros: [opts.entityId],
          acotadaPor: 'padre',
        });
      }
    } else {
      // Alcance de inquilino: no hay predicado que escribir. Lo pone la
      // política `tenant_isolation` sobre cada tabla y la
      // `tenant_isolation_child` sobre cada hija, y ese es justamente el punto.
      for (const a of acotadas) {
        planes.push({
          tabla: a.tabla,
          proyeccion: 'to_jsonb(t)',
          where: null,
          parametros: [],
          acotadaPor: 'rls-inquilino',
        });
      }
      for (const h of hijas) {
        planes.push({
          tabla: h.tabla,
          proyeccion: 'to_jsonb(t)',
          where: null,
          parametros: [],
          acotadaPor: 'rls-hija',
        });
      }
    }

    const conPolitica = (
      await client.query<{ tabla: string }>(
        `SELECT DISTINCT tablename AS tabla FROM pg_policies
          WHERE schemaname = 'public'
            AND policyname IN ('tenant_isolation', 'tenant_isolation_child')`
      )
    ).rows.map((f) => f.tabla);
    comprobarQueNoFaltaNinguna(
      conPolitica,
      new Set([...planes.map((p) => p.tabla), ...fuera.map((f) => f.tabla)])
    );

    planes.push(...A_MANO(opts.tenantId));
    planes.sort((x, y) => x.tabla.localeCompare(y.tabla));

    const esquema = (
      await client.query<{ ultima: string | null; n: string }>(
        'SELECT max(filename) AS ultima, count(*)::text AS n FROM public.migrations'
      )
    ).rows[0];

    const sello = opts.nombre ?? new Date().toISOString().replace(/[:.]/g, '-');
    const etiqueta = opts.entityId ? `entidad-${opts.entityId}` : `inquilino-${opts.tenantId}`;
    archivo = path.join(opts.destino, `${base}-${etiqueta}-${sello}${SUFIJO_EXPORTACION}`);
    salida = abrirSalida(archivo);

    // La primera línea del archivo declara su alcance, para que el propio
    // NDJSON se sostenga si alguien lo separa de su manifiesto.
    await escribir(
      salida,
      JSON.stringify({
        mnemosine: 'exportacion-logica',
        formato: 1,
        restaurable: false,
        creado: new Date().toISOString(),
        alcance,
        esquema: {
          ultimaMigracion: esquema?.ultima ?? '(ninguna)',
          migracionesAplicadas: Number(esquema?.n ?? 0),
        },
      }) + '\n'
    );

    const tablas: TablaExportada[] = [];
    for (const plan of planes) {
      const filas = await volcarTabla(client, salida, plan, orden.get(plan.tabla));
      tablas.push({ tabla: plan.tabla, filas, acotadaPor: plan.acotadaPor });
    }

    await client.query('COMMIT');

    const cerrada = salida;
    salida = undefined;
    await new Promise<void>((resolve) => cerrada.stream.end(resolve));
    // El sha256 se calcula sobre el archivo cerrado, así que el fallo de
    // cierre —el vaciado del último búfer— tiene que mirarse ANTES: si no, el
    // manifiesto certificaría un archivo truncado.
    siFalloLaEscritura(cerrada);

    const manifiesto: ManifiestoExportacion = {
      formato: 1,
      tipo: 'exportacion-logica',
      restaurable: false,
      creado: new Date().toISOString(),
      alcance,
      esquema: {
        ultimaMigracion: esquema?.ultima ?? '(ninguna)',
        migracionesAplicadas: Number(esquema?.n ?? 0),
      },
      base,
      archivo: path.basename(archivo),
      bytes: fs.statSync(archivo).size,
      sha256: await sha256De(archivo),
      leidoComo: { rol, sujetoARls: true, aislamiento: 'REPEATABLE READ' },
      tablas,
      totalFilas: tablas.reduce((s, t) => s + t.filas, 0),
      noIncluye: NO_INCLUYE,
      fueraDeAlcance: fuera.sort((x, y) => x.tabla.localeCompare(y.tabla)),
    };
    const manifiestoEn = `${archivo}${SUFIJO_MANIFIESTO}`;
    fs.writeFileSync(manifiestoEn, JSON.stringify(manifiesto, null, 2) + '\n', { mode: 0o600 });
    return { archivo, manifiestoEn, manifiesto };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Un NDJSON a medias con nombre de exportación es la misma mentira que un
    // .dump truncado con nombre de respaldo: no se queda en el disco.
    const aMedias = salida;
    if (aMedias) await new Promise<void>((resolve) => aMedias.stream.end(resolve));
    if (archivo) fs.rmSync(archivo, { force: true });
    throw err;
  } finally {
    client.release();
  }
}

export interface Exportacion {
  archivo: string;
  manifiesto: ManifiestoExportacion | null;
  /** El manifiesto existe y su sha256 casa con el archivo de hoy. */
  integro: boolean | null;
}

/** Inventario de exportaciones de un directorio, con su alcance y su integridad. */
export async function listarExportaciones(directorio: string): Promise<Exportacion[]> {
  if (!fs.existsSync(directorio)) return [];
  const salida: Exportacion[] = [];
  for (const nombre of fs.readdirSync(directorio).sort().reverse()) {
    if (!nombre.endsWith(SUFIJO_EXPORTACION)) continue;
    const archivo = path.join(directorio, nombre);
    const rutaManifiesto = `${archivo}${SUFIJO_MANIFIESTO}`;
    let manifiesto: ManifiestoExportacion | null = null;
    let integro: boolean | null = null;
    if (fs.existsSync(rutaManifiesto)) {
      try {
        manifiesto = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf-8')) as ManifiestoExportacion;
        integro = manifiesto.sha256 === (await sha256De(archivo));
      } catch {
        manifiesto = null;
      }
    }
    salida.push({ archivo, manifiesto, integro });
  }
  return salida;
}
