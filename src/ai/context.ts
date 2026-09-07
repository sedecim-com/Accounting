import { query, enterTenant, currentTenant } from '../database/connection.js';

// ============================================================
// AGENT CONTEXT
// Resolves which legal entity the CLI session operates on and
// carries the identifiers every tool needs for scoping.
// ============================================================

export interface AgentContext {
  entityId: string;
  entityName: string;
  tenantId: string;
  currency: string;
  country: string;
  accountingStandard: string;
  taxId: string;
}

interface EntityRow {
  id: string;
  name: string;
  tenant_id: string;
  functional_currency: string;
  incorporation_country: string;
  accounting_standard: string;
  tax_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTITY_COLUMNS = `id, name, tenant_id, functional_currency, incorporation_country, accounting_standard, tax_id`;

function toContext(row: EntityRow): AgentContext {
  // El contexto de inquilino NO se reemplaza si ya hay uno.
  //
  // El razonamiento anterior —«si ya existía es el mismo, porque RLS no
  // habría dejado leer una entidad de otro inquilino»— sólo se sostiene con
  // RLS ACTIVA, y RLS es inerte para un rol dueño o superusuario. En el
  // servidor eso era una fuga: la petición abre su contexto con withTenant a
  // partir del token, y aquí `enterWith` lo SUSTITUÍA por el inquilino de la
  // fila que designa la cabecera x-entity-id. A partir de ese punto el
  // inquilino efectivo lo elegía quien enviaba la cabecera, no el token.
  //
  // Es la forma que este repositorio prohíbe por escrito en
  // api/rest/middleware/tenant-context.ts. Ahora:
  //  · sin contexto (la terminal, que es de un proceso y un inquilino) se
  //    entra, que es para lo que enterTenant existe;
  //  · con contexto abierto se COMPRUEBA la pertenencia y se rechaza si no
  //    coincide, en vez de acomodarse al inquilino de la fila.
  const abierto = currentTenant();
  if (!abierto) {
    enterTenant(row.tenant_id);
  } else if (abierto !== row.tenant_id) {
    throw new Error(
      `La entidad ${row.name} pertenece al inquilino ${row.tenant_id} y el contexto activo es ` +
        `${abierto}. Si lo fijaste con --tenant o MNEMOSINE_TENANT, corrígelo o quítalo; ` +
        `en el servidor, el inquilino lo fija el token y no la cabecera x-entity-id.`
    );
  }
  return {
    entityId: row.id,
    entityName: row.name,
    tenantId: row.tenant_id,
    currency: row.functional_currency,
    country: row.incorporation_country,
    accountingStandard: row.accounting_standard,
    taxId: row.tax_id,
  };
}

// ============================================================
// EL INQUILINO DE LA INVOCACIÓN
//
// UNA sola resolución por proceso, con la precedencia que publica
// docs/cli-command-catalog.md §3.1: bandera > MNEMOSINE_TENANT > config.
//
// POR QUÉ HAY ESTADO Y NO SÓLO UNA FUNCIÓN PURA. `bootstrapTenant` tiene 81
// llamadores en las hojas y casi todos le pasan `opts.tenant`, que en
// commander v15 vale `undefined` aunque el usuario haya tecleado
// `--tenant <uuid>`: la raíz declara `-T, --tenant` y su parseOptions se come
// TODA la forma larga, la teclee quien la teclee y esté donde esté en la
// línea (medido: `p bank import --tenant X` deja el valor en la raíz y la
// hoja ve undefined; sólo la forma corta `-t` llega a la hoja, porque el
// corto de la raíz es `-T` y no coincide).
//
// Con la versión anterior —`tenantFlag || process.env.MNEMOSINE_TENANT`— ese
// `undefined` no era «no me han dicho nada» sino una ORDEN de usar el
// entorno: la hoja PISABA con MNEMOSINE_TENANT el inquilino que el gancho de
// la raíz acababa de fijar desde la bandera. Medido sobre el binario, con
// tres entidades en el inquilino del .env:
//     mnemosine -T <ceros> entities .......... «No active entities» (bien:
//                                              `entities` no vuelve a llamar)
//     mnemosine -T <ceros> entity list ....... 3 filas (mal: la hoja pisó)
// Es decir: se publicaba la balanza del despacho A rotulada como la que se
// pidió para B, y el `||` es todo el defecto.
//
// La regla ahora: un valor explícito manda y se registra; la AUSENCIA de
// valor no degrada nunca lo que ya se decidió. Por eso los 81 sitios quedan
// arreglados sin tocarlos.
// ============================================================

/** De dónde salió el inquilino con el que se está trabajando. */
export type OrigenDeInquilino = 'bandera' | 'entorno' | 'config' | 'ninguno';

export interface InquilinoDeLaSesion {
  tenantId?: string;
  origen: OrigenDeInquilino;
  /** El valor de MNEMOSINE_TENANT cuando la bandera lo deja de lado. */
  entornoIgnorado?: string;
}

let sesion: InquilinoDeLaSesion | null = null;

const limpio = (v?: string | null): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Fija el inquilino de la invocación. La llama el programa UNA vez, desde la
 * raíz, con el valor que el usuario tecleó (en cualquiera de las dos
 * posiciones) y con el de la configuración de proyecto/usuario.
 */
export function fijarInquilinoDeLaSesion(
  bandera?: string,
  deConfig?: string
): InquilinoDeLaSesion {
  const entorno = limpio(process.env.MNEMOSINE_TENANT);
  const flag = limpio(bandera);
  const cfg = limpio(deConfig);
  const resuelto: InquilinoDeLaSesion = flag
    ? { tenantId: flag, origen: 'bandera', ...(entorno && entorno !== flag ? { entornoIgnorado: entorno } : {}) }
    : entorno
      ? { tenantId: entorno, origen: 'entorno' }
      : cfg
        ? { tenantId: cfg, origen: 'config' }
        : { origen: 'ninguno' };
  sesion = resuelto;
  if (resuelto.tenantId) enterTenant(resuelto.tenantId);
  return resuelto;
}

/** Qué inquilino rige y de dónde salió. Para `status`, banners y mensajes. */
export function inquilinoDeLaSesion(): InquilinoDeLaSesion {
  return sesion ?? { origen: 'ninguno' };
}

/**
 * Borra la decisión. Sólo para pruebas y para procesos que sirven más de una
 * invocación; en el servidor el inquilino lo fija `withTenant` por petición y
 * esto no se usa.
 */
export function olvidarInquilinoDeLaSesion(): void {
  sesion = null;
}

/**
 * Under RLS, "not found" and "out of scope" are indistinguishable from the
 * query's point of view. The message has to say what is missing, or it sends
 * the user debugging in the wrong direction.
 */
function alcanceHint(): string {
  return currentTenant()
    ? ''
    : ' If the database enforces tenant isolation, specify one: --tenant <uuid> or MNEMOSINE_TENANT.';
}

/**
 * Deja puesto el contexto de inquilino antes de la primera consulta.
 *
 * Con argumento: es un valor que el usuario tecleó (la forma corta `-t` sí
 * llega a la hoja, y `globalsOf` recupera la larga), así que manda.
 *
 * SIN argumento: no es una orden. Si la raíz ya resolvió, se RE-ENTRA lo
 * resuelto —idempotente— y no se consulta el entorno; si nadie resolvió
 * todavía (pruebas, scripts que importan este módulo), se resuelve con la
 * misma precedencia y se recuerda.
 */
export function bootstrapTenant(tenantFlag?: string): void {
  const pedido = limpio(tenantFlag);
  if (pedido) {
    if (!sesion || sesion.tenantId !== pedido) {
      const entorno = limpio(process.env.MNEMOSINE_TENANT);
      sesion = {
        tenantId: pedido,
        origen: 'bandera',
        ...(entorno && entorno !== pedido ? { entornoIgnorado: entorno } : {}),
      };
    }
    enterTenant(pedido);
    return;
  }
  if (sesion) {
    if (sesion.tenantId) enterTenant(sesion.tenantId);
    return;
  }
  fijarInquilinoDeLaSesion(undefined);
}

/**
 * ¿Existe de verdad el inquilino que se pidió? Bajo RLS, un uuid inventado no
 * da error: da CERO FILAS, que se lee igual que «este despacho no tiene
 * nada». `tenants` es la tabla de la frontera y su fila propia es visible
 * desde su propio contexto, así que la pregunta se puede hacer.
 *
 * Devuelve 'inexistente' cuando no hay fila e 'inactivo' cuando la hay pero
 * está dada de baja: son dos remedios distintos y un solo booleano los
 * confunde.
 */
export async function estadoDelInquilino(
  tenantId: string
): Promise<'activo' | 'inactivo' | 'inexistente' | 'indeterminable'> {
  let r;
  try {
    r = await query<{ is_active: boolean }>(
      'SELECT is_active FROM tenants WHERE id = $1',
      [tenantId]
    );
  } catch (err) {
    // NO PODER COMPROBAR NO ES PODER ACUSAR. Un despliegue puede negarle a
    // este rol la lectura de `tenants` (42501) o no tener la tabla (42P01);
    // convertir eso en «ese inquilino no existe» sería exactamente el error
    // que esta comprobación viene a impedir, con el signo cambiado. Se calla
    // y sigue: el aislamiento no depende de esta consulta, sólo el aviso.
    // Y se calla ante CUALQUIER motivo de no poder preguntar, no sólo ante los
    // dos permisos. El aislamiento lo garantiza RLS; esta consulta sólo
    // alimenta un AVISO, así que ningún fallo suyo puede ser peor que el aviso
    // que deja de darse. En particular la base INALCANZABLE: este chequeo corre
    // en el gancho, antes de que la hoja valide sus propios argumentos, y
    // dejarlo lanzar convertía un error de USO —que debe salir 2 sin tocar la
    // base— en un fallo de conexión con código 1. Un instrumento de aviso que
    // cambia el código de salida de lo que observa es justo lo que este tramo
    // repara.
    const codigo = String((err as { code?: unknown } | null)?.code ?? '');
    // Permiso denegado y tabla ausente: el despliegue no deja preguntar.
    if (codigo === '42501' || codigo === '42P01') return 'indeterminable';
    // Y LA BASE INALCANZABLE, que es la familia que faltaba. Este chequeo corre
    // en el gancho, ANTES de que la hoja valide sus propios argumentos: dejarlo
    // lanzar convertía un error de USO —que debe salir 2 sin tocar la base— en
    // un fallo de conexión con código 1. Un instrumento de aviso que cambia el
    // desenlace de lo que observa es justo lo que este tramo repara.
    if (
      /^(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|08\d{3}|57P03)$/.test(codigo) ||
      err instanceof AggregateError ||
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/.test(String((err as { message?: unknown } | null)?.message ?? ''))
    ) {
      return 'indeterminable';
    }
    // Cualquier otro motivo SÍ se propaga: un fallo genuino de esta consulta
    // que se tragara dejaría el aviso mudo para siempre y nadie se enteraría.
    throw err;
  }
  // Y TAMPOCO ACUSA CUANDO NO HAY RESPUESTA QUE LEER. Un `query` simulado
  // —media suite del CLI lo está— devuelve undefined, y leerle `.rows` haría
  // reventar a comandos que jamás dependieron de esta pregunta. Es el mismo
  // principio que el catch de arriba: no poder comprobar no es poder acusar.
  if (!r || !Array.isArray(r.rows)) return 'indeterminable';
  if (r.rows.length === 0) return 'inexistente';
  return r.rows[0].is_active ? 'activo' : 'inactivo';
}

export async function listEntities(): Promise<EntityRow[]> {
  const result = await query<EntityRow>(
    `SELECT ${ENTITY_COLUMNS} FROM legal_entities WHERE is_active = true ORDER BY name`
  );
  return result.rows;
}

/**
 * Resolve an entity by UUID, exact tax id, or name fragment.
 * With no argument: succeeds only when exactly one active entity exists.
 */
export async function resolveEntity(idOrName?: string): Promise<AgentContext> {
  if (idOrName) {
    const trimmed = idOrName.trim();
    if (UUID_RE.test(trimmed)) {
      const byId = await query<EntityRow>(
        `SELECT ${ENTITY_COLUMNS} FROM legal_entities WHERE id = $1 AND is_active = true`,
        [trimmed]
      );
      if (byId.rows.length === 1) return toContext(byId.rows[0]);
      throw new Error(`No active entity exists with id ${trimmed}.${alcanceHint()}`);
    }

    const byName = await query<EntityRow>(
      `SELECT ${ENTITY_COLUMNS} FROM legal_entities
       WHERE is_active = true AND (name ILIKE $1 OR tax_id = $2)
       ORDER BY name`,
      [`%${trimmed}%`, trimmed.toUpperCase()]
    );
    if (byName.rows.length === 1) return toContext(byName.rows[0]);
    if (byName.rows.length === 0) {
      throw new Error(`No active entity matches "${trimmed}".${alcanceHint()}`);
    }
    throw new Error(
      `"${trimmed}" is ambiguous. Matches:\n` +
        byName.rows.map((r) => `  - ${r.name} (${r.tax_id}) → ${r.id}`).join('\n')
    );
  }

  const all = await listEntities();
  if (all.length === 1) return toContext(all[0]);
  if (all.length === 0) {
    // Readable fail-closed: without tenant context RLS returns zero rows, and
    // "no entities" would sound like an empty database when the problem is scope.
    if (!currentTenant()) {
      throw new Error(
        'No entities are visible. If the database enforces tenant isolation, specify one: ' +
          '--tenant <uuid> or MNEMOSINE_TENANT.'
      );
    }
    throw new Error('There are no active legal entities in this tenant. Create one first (POST /v1/entities or seed).');
  }
  throw new Error(
    'There are multiple active entities; specify one with --entity <id|name>:\n' +
      all.map((r) => `  - ${r.name} (${r.tax_id}) → ${r.id}`).join('\n')
  );
}
