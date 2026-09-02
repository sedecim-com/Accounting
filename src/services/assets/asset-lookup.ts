import { query } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import type { DepreciationMethod } from '../../types/index.js';

// ============================================================
// RESOLVER LA CATEGORÍA QUE UNA PERSONA TECLEA (F06a)
//
// `crearActivo` recibe `category_id`, que es un UUID. Nadie teclea un UUID:
// lo que el operador conoce es el NOMBRE que la siembra escribió («Equipo de
// Cómputo»), porque `sembrarCategoriasDeActivo` devuelve nombres y
// `asset_categories` no tiene código —la 003 no se lo puso—. Sin esta
// traducción el alta existe y no se puede usar.
//
// El precedente exacto es `resolvePeriod` (fiscal-calendar-service.ts:104):
// acepta el id o un trozo del nombre, y ante dos coincidencias RECHAZA en vez
// de tomar la primera. Ahí la consecuencia de elegir mal es cerrar otro mes;
// aquí es depreciar contra otra cuenta durante los próximos diez años, que
// nadie va a notar hasta que alguien cuadre la balanza con el auxiliar.
//
// ACOTADO POR ENTIDAD DENTRO DEL SQL, no después. `category_id` es una foránea
// a `asset_categories(id)` sin frontera: la categoría de otra entidad entra
// perfectamente, y con ella entran sus tres cuentas por omisión. Van cuatro
// fugas cerradas en este proyecto por dar por bueno un id que venía de una
// consulta anterior; ésta se cierra en el WHERE.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CategoriaDeActivo {
  id: string;
  name: string;
  is_active: boolean;
  default_useful_life_years: number | null;
  default_depreciation_method: DepreciationMethod | null;
  /** Cuántas de las tres cuentas por omisión trae resueltas (0-3). */
  cuentas_por_omision: number;
}

const SELECT_CATEGORIA = `
  SELECT id, name, is_active, default_useful_life_years, default_depreciation_method,
         (CASE WHEN default_asset_account_id IS NULL THEN 0 ELSE 1 END)
       + (CASE WHEN default_depreciation_account_id IS NULL THEN 0 ELSE 1 END)
       + (CASE WHEN default_expense_account_id IS NULL THEN 0 ELSE 1 END) AS cuentas_por_omision
    FROM asset_categories`;

/** Las categorías de la entidad, para poder nombrar las que sí existen. */
export async function listarCategoriasDeActivo(entityId: string): Promise<CategoriaDeActivo[]> {
  const r = await query<CategoriaDeActivo>(
    `${SELECT_CATEGORIA} WHERE entity_id = $1 ORDER BY name`,
    [entityId]
  );
  return r.rows;
}

/**
 * La categoría que el operador nombró: un id, el nombre exacto, o un trozo del
 * nombre que sólo case con una.
 *
 * Cuando no hay ninguna categoría en la entidad, el error NO dice «no existe»:
 * dice que la entidad todavía no tiene ninguna y por dónde se siembran. Es la
 * diferencia entre un callejón sin salida y un letrero — hoy el sembrador
 * (`sembrarCategoriasDeActivo`) no tiene ningún llamador y `asset category
 * seed` es fase 2, así que este mensaje es lo único que le dice al primer
 * usuario por qué el alta no arranca.
 */
export async function resolverCategoriaDeActivo(
  entityId: string,
  referencia: string
): Promise<CategoriaDeActivo> {
  const texto = referencia.trim();
  if (texto.length === 0) {
    throw new ValidationError('--category llegó vacía: el activo necesita su clase.', 'category_id');
  }

  if (UUID_RE.test(texto)) {
    const porId = await query<CategoriaDeActivo>(
      `${SELECT_CATEGORIA} WHERE id = $1 AND entity_id = $2`,
      [texto, entityId]
    );
    if (porId.rows.length === 0) throw new NotFoundError('Asset Category', texto);
    return porId.rows[0];
  }

  const todas = await listarCategoriasDeActivo(entityId);
  if (todas.length === 0) {
    throw new ValidationError(
      'Esta entidad no tiene ninguna categoría de activo, y el alta necesita una: la categoría ' +
        'aporta la vida útil, el método y las tres cuentas por omisión. Todavía no hay hoja que ' +
        'las siembre (`asset category seed` es de fase 2) ni el alta de entidad las siembra.',
      'category_id'
    );
  }

  const minusculas = texto.toLowerCase();
  const exactas = todas.filter((c) => c.name.toLowerCase() === minusculas);
  if (exactas.length === 1) return exactas[0];

  const parciales = todas.filter((c) => c.name.toLowerCase().includes(minusculas));
  if (parciales.length === 1) return parciales[0];
  if (parciales.length > 1) {
    throw new ValidationError(
      `"${texto}" casa con ${parciales.length} categorías (${parciales.map((c) => c.name).join(', ')}). ` +
        'Escribe el nombre completo o pasa su id: elegir la primera depreciaría contra las ' +
        'cuentas de otra clase durante toda la vida del activo.',
      'category_id'
    );
  }

  throw new ValidationError(
    `No hay ninguna categoría llamada "${texto}" en esta entidad. Las que hay: ` +
      `${todas.map((c) => c.name).join(', ')}.`,
    'category_id'
  );
}

// ============================================================
// QUÉ LIBRO RIGE, PARA QUE `--book` PUEDA CONTRASTARSE
//
// El catálogo pone `--book` en once filas de la familia. La bandera NO ELIGE:
// cuál de las dos depreciaciones llega al mayor es la política
// `base_depreciacion`, que vive en el panel porque las dos respuestas son
// defendibles y postean importes distintos todos los meses —es la regla de la
// casa, una bifurcación de criterio contable no se pregunta ni se elige desde
// la terminal—.
//
// Lo que la bandera hace es DECLARAR sobre qué libro cree estar operando quien
// escribe la orden, para que el comando pueda contrastarlo. El operador que
// teclea `--book tax` creyendo que corre la fiscal y tiene el panel en
// `vida_util_nif` se entera ahí, en vez de descubrirlo en la conciliación
// anual entre la deducción y el gasto contable.
// ============================================================

export const LIBROS_DE_DEPRECIACION = ['book', 'tax'] as const;
export type LibroDeDepreciacion = (typeof LIBROS_DE_DEPRECIACION)[number];

export interface LibroVigente {
  libro: LibroDeDepreciacion;
  base: string;
  /** false cuando rige el defecto declarado y no una respuesta del despacho. */
  definida: boolean;
}

export async function libroQueRige(
  tenantId: string,
  entityId: string
): Promise<LibroVigente> {
  const base = await getPolicy({ tenantId, entityId }, 'base_depreciacion');
  return {
    libro: base.value === 'tasa_lisr' ? 'tax' : 'book',
    base: base.value,
    definida: base.defined,
  };
}

/**
 * Rechaza un `--book` que contradice al panel.
 *
 * Devuelve el libro vigente para que el llamador lo imprima. Nunca devuelve el
 * de la bandera: apretar es de cualquiera, aflojar sólo del despacho.
 */
export function exigirLibroDelPanel(
  declarado: string | undefined,
  vigente: LibroVigente
): LibroDeDepreciacion {
  if (declarado === undefined) return vigente.libro;
  const pedido = declarado.trim().toLowerCase();
  if (!(LIBROS_DE_DEPRECIACION as readonly string[]).includes(pedido)) {
    throw new ValidationError(
      `--book "${declarado}" no existe: los dos libros son ${LIBROS_DE_DEPRECIACION.join(' y ')} ` +
        '(el contable de la NIF C-6 y el fiscal de la LISR).',
      'book'
    );
  }
  if (pedido !== vigente.libro) {
    throw new ValidationError(
      `--book ${pedido} contradice al panel: \`base_depreciacion\` vale "${vigente.base}", así que ` +
        `el libro que llega al mayor es ${vigente.libro}${vigente.definida ? '' : ' (defecto declarado, nadie ha contestado)'}. ` +
        'Esta bandera declara sobre qué libro crees estar operando, no lo elige: cuál de las dos ' +
        'depreciaciones se postea es criterio del despacho y se contesta con ' +
        '`mnemosine pending resolve base_depreciacion`.',
      'book'
    );
  }
  return vigente.libro;
}
