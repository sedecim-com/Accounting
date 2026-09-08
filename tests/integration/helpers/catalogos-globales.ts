import { beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * EL CENSO DE CATÁLOGOS GLOBALES, Y SU HUELLA.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO.
 *
 * La suite de integración comparte UNA base efímera entre los ~90 archivos, en
 * serie (`vitest.integration.config.ts`). Casi todo lo que escribe una prueba
 * cuelga de su propio inquilino y por tanto es invisible para las demás. Los
 * CATÁLOGOS no: `sat_bancos`, `sat_codigos_agrupadores`, `exchange_rates`,
 * `tax_tables`… son hechos publicados por la autoridad, no datos del
 * inquilino, así que no llevan `tenant_id` ni `entity_id` y una fila que deja
 * un archivo la ve el siguiente.
 *
 * Eso ya rompió una prueba. `f07d` vaciaba `sat_bancos` y luego insertaba dos
 * claves ('012' y '002') que no volvía a quitar; `f07cd` afirma que el c_Banco
 * está VACÍO en una instalación recién migrada. Aislados los dos pasan. Juntos
 * depende del ORDEN, y el orden de esta suite no es alfabético: el sequencer
 * de vitest ordena por el resultado de la corrida ANTERIOR (fallidos primero,
 * después los más lentos, y sólo en frío por tamaño de archivo), leyéndolo de
 * `node_modules/.vite/vitest/results.json`. Un fallo cuya causa es un archivo
 * que ni siquiera aparece en el informe, y que cambia de corrida en corrida.
 *
 * `f07a` ya había tropezado con esto y se defendió a mano: apunta cómo
 * encontró el catálogo y lo devuelve igual en su `afterAll`. Este archivo
 * convierte esa disciplina en algo que NO hay que acordarse de hacer: el
 * vigilante (`vigilante-catalogos.ts`) toma la huella antes y después de cada
 * archivo, y el que ensucie un catálogo falla EL MISMO, con el nombre de la
 * tabla. El descuido deja de viajar hasta la víctima.
 *
 * QUÉ CUENTA COMO CATÁLOGO, y por qué no es una lista escrita a mano.
 *
 * De las 110 tablas del esquema, 30 no llevan `tenant_id` ni `entity_id` —
 * pero 21 de ellas son RENGLONES (`invoice_lines`, `paycheck_taxes`,
 * `journal_entry_lines`…) que heredan el alcance por una FK a su padre, y ésas
 * se van con el inquilino desechable de cada archivo. El catálogo es la tabla
 * que no es de nadie Y no cuelga de nadie: sin columnas de alcance y sin
 * ninguna FK saliente. La regla se evalúa contra el catálogo de Postgres en
 * cada corrida, así que una tabla global NUEVA queda vigilada el día que la
 * crea su migración, sin que nadie edite esta lista.
 */

/** Un cliente propio: no depende del pool de la app ni de cuándo lo cierren. */
export async function clientePropio(): Promise<pg.Client> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // No se degrada en silencio. Una salvaguarda apagada es peor que ninguna:
    // deja creer que la disciplina está comprobada cuando no lo está.
    throw new Error(
      'catalogos-globales: no hay DATABASE_URL. La base efímera la publica ' +
        'tests/integration/global-setup.ts; sin ella no hay nada que vigilar.'
    );
  }
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/**
 * Las dos que la regla atrapa y no son catálogos:
 *
 *  · `migrations` sólo la escribe el migrador, antes de que exista la primera
 *    prueba; si cambiara a mitad de corrida el problema no sería el orden.
 *  · `tenants` es la RAÍZ del alcance, no algo alcanzado: cada archivo crea su
 *    inquilino desechable con `crearInquilino`, así que crece a propósito en
 *    todos. Vigilarla sería declarar rota la suite entera.
 */
export const NO_SON_CATALOGO = new Set(['migrations', 'tenants']);

/** Lo que se guarda de una tabla para saber si alguien la movió. */
export interface HuellaTabla {
  filas: number;
  /** md5 del volcado ordenado: delata un UPDATE que no cambia el conteo. */
  md5: string;
}

export type Huella = Map<string, HuellaTabla>;

/** Un catálogo que no quedó como se encontró. */
export interface Desajuste {
  tabla: string;
  antes: HuellaTabla;
  despues: HuellaTabla;
}

const CENSO = `
  SELECT c.relname AS tabla
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     -- No es de nadie: sin columnas de alcance.
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND NOT a.attisdropped
          AND a.attname IN ('tenant_id', 'entity_id'))
     -- Y no cuelga de nadie: sin FK saliente que le preste el alcance.
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = 'f')
   ORDER BY c.relname`;

/** Las tablas globales que esta base tiene HOY, según su propio catálogo. */
export async function censarCatalogosGlobales(cliente: pg.ClientBase): Promise<string[]> {
  const r = await cliente.query<{ tabla: string }>(CENSO);
  return r.rows.map((f) => f.tabla).filter((t) => !NO_SON_CATALOGO.has(t));
}

/**
 * La huella de cada catálogo. El `md5` sale del volcado de la fila entera
 * (`t::text`) ordenado por sí mismo: no depende de que la tabla tenga llave
 * primaria ni de en qué orden la devuelva Postgres, y cambia si alguien
 * ACTUALIZA una fila sin alterar el conteo.
 */
export async function huellaDeCatalogos(
  cliente: pg.ClientBase,
  tablas: string[]
): Promise<Huella> {
  const huella: Huella = new Map();
  for (const tabla of tablas) {
    // El nombre viene de pg_class, no de una prueba: interpolarlo es leer el
    // catálogo, no aceptar entrada. Aun así se cita, por si algún día nace una
    // tabla con mayúsculas o palabra reservada.
    const r = await cliente.query<{ filas: string; md5: string | null }>(
      `SELECT count(*)::text AS filas,
              md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS md5
         FROM "${tabla}" t`
    );
    huella.set(tabla, { filas: Number(r.rows[0].filas), md5: r.rows[0].md5 ?? '' });
  }
  return huella;
}

/** Lo que cambió entre dos huellas. Vacío = el archivo dejó todo como estaba. */
export function compararHuellas(antes: Huella, despues: Huella): Desajuste[] {
  const desajustes: Desajuste[] = [];
  for (const [tabla, a] of antes) {
    const d = despues.get(tabla);
    if (!d) continue; // La tabla desapareció: eso lo juzga el contrato de esquema.
    if (a.filas !== d.filas || a.md5 !== d.md5) desajustes.push({ tabla, antes: a, despues: d });
  }
  return desajustes;
}

/** El reproche, con el nombre de la tabla y qué hacer al respecto. */
export function explicarDesajustes(archivo: string, desajustes: Desajuste[]): string {
  const detalle = desajustes
    .map(({ tabla, antes, despues }) => {
      const cambio =
        antes.filas === despues.filas
          ? `${antes.filas} filas, pero con el contenido CAMBIADO (algún UPDATE)`
          : `${antes.filas} → ${despues.filas} filas`;
      return `  · ${tabla}: ${cambio}`;
    })
    .join('\n');

  return [
    `${archivo} dejó SUCIO un catálogo GLOBAL:`,
    detalle,
    '',
    'Estas tablas no llevan tenant_id ni entity_id: las comparte toda la corrida,',
    'y esta suite no corre en orden alfabético — el sequencer de vitest ordena por',
    'el resultado de la corrida anterior. Así que lo que dejes aquí hará fallar a',
    'OTRO archivo, en OTRA corrida, por un motivo que no es suyo.',
    '',
    'Devuélvela como la encontraste. Es UNA línea al nivel del módulo, encima de',
    'tu beforeAll:',
    '',
    "    apartarCatalogos('<la tabla>');   // de helpers/catalogos-globales.ts",
    '',
    'Y no un conteo de filas a mano: un conteo no ve un UPDATE que deja el mismo',
    'número de filas, y esa diferencia ya se ha cobrado una restauración rota.',
    '',
    'Si una prueba NECESITA de verdad dejar sembrada una tabla global, el sitio de',
    'esa discusión es la revisión, no un afterAll silencioso.',
  ].join('\n');
}

// ============================================================
// LA DISCIPLINA, EN UNA LÍNEA
// ============================================================

/**
 * Aparta el contenido de uno o más catálogos globales al empezar el archivo y
 * lo devuelve tal cual al terminar. Se llama al NIVEL DEL MÓDULO, encima del
 * `beforeAll` del archivo:
 *
 *     apartarCatalogos('exchange_rates');
 *
 *     beforeAll(async () => { … });
 *
 * EL ORDEN SALE SOLO, y conviene saber por qué. Vitest resuelve
 * `sequence.hooks` a `'stack'`: los `beforeAll` corren en orden de registro y
 * los `afterAll` en orden INVERSO. Como los hooks se registran al recolectar el
 * módulo, poner esta llamada arriba del todo produce el emparedado correcto —
 *
 *     entrando:  vigilante · apartar · el archivo
 *     saliendo:  el archivo · devolver · vigilante
 *
 * — es decir: se apunta antes de que el archivo siembre, se devuelve después de
 * que el archivo termine, y el vigilante comprueba el resultado al final.
 *
 * USA SU PROPIO CLIENTE, y no el pool de `src/database/connection`, por una
 * razón concreta: casi todos estos archivos llaman a `closeDatabase()` en su
 * `afterAll`, que corre ANTES que éste. Con el pool compartido, `query()`
 * volvería a abrirlo —es perezoso— y dejaría una conexión que ya nadie cierra.
 *
 * Restaura con un volcado JSON y no borrando las filas que el archivo
 * insertó: así sigue siendo correcto cuando alguien añada una prueba que
 * siembre una fila más, o cuando una migración le añada una columna a la
 * tabla. Que la restauración no dependa de acordarse es justamente el punto.
 *
 * Y EL VOLCADO LO SERIALIZA POSTGRES (`json_agg(t)::text`), que llega aquí como
 * texto plano y se devuelve sin tocar. La primera versión traía las filas como
 * objetos de JS y las volvía a serializar con `JSON.stringify`, y eso NO es un
 * viaje de ida y vuelta: `timestamptz` guarda microsegundos y el `Date` de JS
 * sólo llega al milisegundo, así que `19:36:37.588013` volvía como
 * `19:36:37.588`. Mismo número de filas, contenido distinto — lo detectó el
 * md5 del vigilante sobre `tax_tables`, que un conteo habría dejado pasar.
 *
 * Las columnas del INSERT van ENUMERADAS y no con `SELECT *` porque una columna
 * GENERADA no admite que se le escriba un valor: `exchange_rates.inverse_rate`
 * lo es, y con `*` el restaurador moría con «cannot insert a non-DEFAULT value
 * into column». La lista sale de `pg_attribute` en cada corrida, así que vale
 * también para la generada que alguien añada mañana.
 *
 * No hay caso en que dejar sembrada una tabla global sea correcto sin
 * discutirlo: el vigilante (`../vigilante-catalogos.ts`) hace fallar al
 * archivo que lo intente.
 */
export function apartarCatalogos(...tablas: string[]): void {
  /** El volcado TAL CUAL lo escribe Postgres: texto, sin pasar por tipos de JS. */
  const volcado = new Map<string, string>();
  /** Las columnas que se pueden ESCRIBIR, ya citadas y en orden. */
  const columnas = new Map<string, string>();
  let cliente: pg.Client | null = null;

  beforeAll(async () => {
    cliente = await clientePropio();
    for (const tabla of tablas) {
      const r = await cliente.query<{ volcado: string; columnas: string }>(
        `SELECT (SELECT coalesce(json_agg(t)::text, '[]') FROM "${tabla}" t) AS volcado,
                (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
                   FROM pg_attribute a
                  WHERE a.attrelid = $1::regclass AND a.attnum > 0
                    AND NOT a.attisdropped AND a.attgenerated = '') AS columnas`,
        [tabla]
      );
      volcado.set(tabla, r.rows[0].volcado);
      columnas.set(tabla, r.rows[0].columnas);
    }
  });

  afterAll(async () => {
    if (!cliente) return;
    try {
      // En orden inverso, por simetría: si dos catálogos llegaran a
      // depender uno de otro, se deshace como se hizo.
      for (const tabla of [...tablas].reverse()) {
        const cols = columnas.get(tabla);
        await cliente.query(`DELETE FROM "${tabla}"`);
        await cliente.query(
          `INSERT INTO "${tabla}" (${cols})
           SELECT ${cols} FROM json_populate_recordset(NULL::"${tabla}", $1::json)`,
          [volcado.get(tabla) ?? '[]']
        );
      }
    } finally {
      await cliente.end();
      cliente = null;
    }
  });
}
