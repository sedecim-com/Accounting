import fs from 'node:fs';
import path from 'node:path';

/**
 * Extractor de referencias SQL del código fuente.
 *
 * Alcance deliberadamente acotado a lo que se puede afirmar con certeza sin
 * escribir un parser de SQL: nombres de tabla en FROM/JOIN/INSERT INTO/UPDATE,
 * con dos exclusiones aprendidas de dos falsos positivos reales. La de R1:
 * `IS DISTINCT FROM COALESCE(...)` no nombra una tabla `coalesce` — el
 * lookbehind de DISTINCT lo descarta. La de F05b: `FOR UPDATE OF jel` no
 * nombra una tabla `of` — el candado por alias es la primera vez que este
 * código escribe `UPDATE` sin que sea el verbo de una sentencia, y sin el
 * lookbehind de FOR el escáner denunciaba cuatro tablas inexistentes.
 * También se descartan las listas de columnas de INSERT INTO tabla (...).
 * Ese subconjunto es
 * justo el que produjo las divergencias reales del sistema (una tabla
 * `entities` que no existe, columnas inventadas en garnishments, `slug` en
 * tenants). Lo que NO cubre —columnas en SELECT, WHERE o SET— queda anotado
 * en el propio test para que nadie lo confunda con cobertura total.
 *
 * Dos precauciones que importan: se quitan los comentarios ANTES de escanear
 * (si no, la prosa en inglés «FROM here», «UPDATE a…» se lee como SQL), y solo
 * se miran literales de cadena que contengan un verbo SQL.
 */

export interface RefTabla {
  tabla: string;
  archivo: string;
  linea: number;
}

export interface RefColumnas {
  tabla: string;
  columnas: string[];
  archivo: string;
  linea: number;
}

/** Catálogos del sistema y construcciones que no son tablas del esquema. */
const IGNORAR = new Set([
  'select', 'lateral', 'unnest', 'generate_series', 'jsonb_array_elements',
  'json_array_elements', 'jsonb_each', 'values', 'only', 'dual',
  'pg_class', 'pg_namespace', 'pg_attribute', 'pg_roles', 'pg_tables',
  'pg_policies', 'pg_constraint', 'pg_proc', 'pg_trigger', 'pg_indexes',
  'pg_stat_activity', 'pg_matviews', 'pg_settings', 'pg_type',
  'information_schema',
]);

export function listarFuentes(raiz: string): string[] {
  const out: string[] = [];
  const caminar = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        caminar(full);
      } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  caminar(raiz);
  return out;
}

/**
 * Sustituye comentarios por espacios del mismo largo: así los índices —y por
 * tanto los números de línea— siguen siendo los del archivo original.
 */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

/** El literal debe EMPEZAR por un verbo SQL: así una cadena de ayuda que
 *  mencione «select» de pasada no entra al escaneo. */
const EMPIEZA_SQL =
  /^\s*(?:--[^\n]*\n\s*)*(?:WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|GRANT|REVOKE|TRUNCATE|SET\s+|ALTER\s+(?:TABLE|FUNCTION|DATABASE)|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|UNIQUE|VIEW|MATERIALIZED|POLICY|FUNCTION|TRIGGER|EXTENSION|SCHEMA|SEQUENCE))\b/i;

/** Literales de plantilla y de comilla simple que parecen SQL. */
function literalesSql(texto: string): Array<{ sql: string; offset: number }> {
  const out: Array<{ sql: string; offset: number }> = [];
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const cuerpo = m[1] ?? m[2] ?? '';
    if (cuerpo.length < 12 || !EMPIEZA_SQL.test(cuerpo)) continue;
    out.push({ sql: cuerpo, offset: m.index + 1 });
  }
  return out;
}

function lineaDe(texto: string, idx: number): number {
  return texto.slice(0, idx).split('\n').length;
}

/** CTEs y alias de tabla: ambos se referencian como si fueran tablas. */
function nombresLocales(sql: string): Set<string> {
  const locales = new Set<string>();
  for (const n of sql.matchAll(/([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) {
    locales.add(n[1].toLowerCase());
  }
  // `FROM tabla alias` / `JOIN tabla alias` (con o sin AS)
  for (const n of sql.matchAll(
    /\b(?:(?<!DISTINCT\s)FROM|JOIN|(?<!FOR\s)UPDATE)\s+(?:public\.)?[a-z_][a-z0-9_]*\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi
  )) {
    const alias = n[1].toLowerCase();
    if (!PALABRAS_SQL.has(alias)) locales.add(alias);
  }
  return locales;
}

/**
 * Solo los CTE (`WITH x AS (...)`). `nombresLocales` mezcla CTEs con alias de
 * tabla porque para descartar NOMBRES DE TABLA inventados da igual cuál sea;
 * para resolver COLUMNAS calificadas no da igual: un alias es exactamente lo
 * que hay que resolver, y un CTE es lo único que hay que descartar, porque su
 * forma la define la consulta y no el esquema.
 */
function nombresCte(sql: string): Set<string> {
  const ctes = new Set<string>();
  for (const n of sql.matchAll(/([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) ctes.add(n[1].toLowerCase());
  return ctes;
}

/** Palabras que siguen a una tabla sin ser alias. */
const PALABRAS_SQL = new Set([
  'set', 'where', 'on', 'using', 'inner', 'left', 'right', 'full', 'cross',
  'join', 'group', 'order', 'having', 'limit', 'offset', 'returning',
  'values', 'as', 'and', 'or', 'union', 'except', 'intersect', 'for',
  'window', 'fetch', 'into',
]);

/**
 * Columnas de un SELECT que consulta UNA SOLA tabla sin alias ni JOIN: en ese
 * caso cada nombre suelto pertenece sin ambigüedad a esa tabla. Es el caso que
 * produjo las ocho columnas inventadas de garnishments. Con JOINs no se puede
 * afirmar a quién pertenece cada nombre, así que no se intenta.
 */
function selectsDeUnaTabla(sql: string): Array<{ tabla: string; columnas: string[]; idx: number }> {
  const out: Array<{ tabla: string; columnas: string[]; idx: number }> = [];
  const re = /\bSELECT\s+((?!\*)[^;]*?)\s+FROM\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*(?=WHERE|ORDER|GROUP|LIMIT|$|\))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const cuerpo = m[1];
    const tabla = m[2].toLowerCase();
    // Cualquier señal de más de una tabla, alias o expresión invalida la
    // atribución: se descarta el SELECT entero.
    if (/\bJOIN\b|\bFROM\b|[()*]|\bAS\b|\bCASE\b|\bDISTINCT\b|::/i.test(cuerpo)) continue;
    if (/\bJOIN\b/i.test(sql)) continue;
    const crudos = cuerpo.split(',').map((c) => c.trim()).filter(Boolean);
    const columnas = crudos.filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c)).map((c) => c.toLowerCase());
    if (columnas.length !== crudos.length || columnas.length === 0) continue;
    out.push({ tabla, columnas, idx: m.index });
  }
  return out;
}

/**
 * Columnas CALIFICADAS: `p.futa` cuando la consulta declara `FROM paychecks p`.
 *
 * Generaliza el caso anterior y es estrictamente más fuerte: el alias ata la
 * columna a su tabla sin ambigüedad, así que funciona **aunque haya JOINs** —
 * que es justo donde el extractor de una sola tabla se rinde.
 *
 * Es la comprobación que faltaba. `form-940-generator` consultaba
 * `p.futa_employer` cinco veces contra `FROM paychecks p JOIN pay_periods pp`;
 * la columna no existe (es `paychecks.futa`) y la forma 940 reventaba en su
 * primera invocación, con el contrato de esquema en verde porque su alcance
 * declarado excluía las consultas con alias.
 *
 * Se aceptan dos calificadores: un alias declarado en FROM/JOIN, y el propio
 * nombre de la tabla. Se descarta `public.` (esquema, no tabla) y todo alias
 * que en realidad sea un CTE, porque su forma la define la consulta y no el
 * esquema.
 */
export function columnasCalificadas(
  sql: string,
  ctes: Set<string>
): Array<{ tabla: string; columnas: string[]; idx: number }> {
  // alias → tabla, y también tabla → tabla para las referencias sin alias.
  const porAlias = new Map<string, string>();
  const reFuente =
    /\b(?:(?<!DISTINCT\s)FROM|JOIN|(?<!FOR\s)UPDATE)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  let f: RegExpExecArray | null;
  while ((f = reFuente.exec(sql))) {
    const tabla = f[1].toLowerCase();
    if (ctes.has(tabla)) continue;
    porAlias.set(tabla, tabla);
    const alias = f[2]?.toLowerCase();
    if (alias && !PALABRAS_SQL.has(alias) && !ctes.has(alias)) porAlias.set(alias, tabla);
  }
  if (porAlias.size === 0) return [];

  const porTabla = new Map<string, { columnas: Set<string>; idx: number }>();
  const reCol = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
  let c: RegExpExecArray | null;
  while ((c = reCol.exec(sql))) {
    const calificador = c[1].toLowerCase();
    if (calificador === 'public') continue;
    const tabla = porAlias.get(calificador);
    if (!tabla) continue;
    const columna = c[2].toLowerCase();
    // `t.*` no nombra columna, y una palabra reservada tras el punto no lo es.
    if (columna === '*' || PALABRAS_SQL.has(columna)) continue;
    const yaEsta = porTabla.get(tabla);
    if (yaEsta) yaEsta.columnas.add(columna);
    else porTabla.set(tabla, { columnas: new Set([columna]), idx: c.index });
  }

  return [...porTabla.entries()].map(([tabla, v]) => ({
    tabla,
    columnas: [...v.columnas],
    idx: v.idx,
  }));
}

export function escanearArchivo(archivo: string): {
  tablas: RefTabla[];
  inserts: RefColumnas[];
  selects: RefColumnas[];
} {
  const original = fs.readFileSync(archivo, 'utf-8');
  const texto = sinComentarios(original);
  const tablas: RefTabla[] = [];
  const inserts: RefColumnas[] = [];
  const selects: RefColumnas[] = [];

  for (const { sql: crudo, offset } of literalesSql(texto)) {
    // Dos clases de prosa dentro de un literal SQL que no son SQL, ambas
    // sustituidas por espacios para conservar los desplazamientos:
    //  · comentarios SQL (`-- removed real money FROM the statement` hacía
    //    creer que existe una tabla «the»);
    //  · cadenas ('did not arise from a question' → tabla «a»).
    const sql = crudo
      .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/'[^']*'/g, (m) => ' '.repeat(m.length));
    const locales = nombresLocales(sql);

    const reTabla =
      /\b(?:(?<!DISTINCT\s)FROM|JOIN|INSERT\s+INTO|(?<!FOR\s)UPDATE)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = reTabla.exec(sql))) {
      const t = m[1].toLowerCase();
      if (IGNORAR.has(t) || locales.has(t) || PALABRAS_SQL.has(t) || t.startsWith('pg_')) continue;
      tablas.push({ tabla: t, archivo, linea: lineaDe(original, offset + m.index) });
    }

    const reInsert =
      /\bINSERT\s+INTO\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
    while ((m = reInsert.exec(sql))) {
      const tabla = m[1].toLowerCase();
      if (locales.has(tabla) || IGNORAR.has(tabla)) continue;
      const crudos = m[2].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
      const columnas = crudos
        .filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c))
        .map((c) => c.toLowerCase());
      // Si algún elemento no era un identificador simple, la lista lleva una
      // expresión y no se puede afirmar nada sobre ella: se descarta entera.
      if (columnas.length !== crudos.length) continue;
      inserts.push({ tabla, columnas, archivo, linea: lineaDe(original, offset + m.index) });
    }

    // Columnas calificadas por alias: cubren las consultas CON JOIN, que es
    // donde el extractor de una sola tabla se rinde y donde vivía el
    // `p.futa_employer` de la forma 940.
    for (const cal of columnasCalificadas(sql, nombresCte(sql))) {
      if (IGNORAR.has(cal.tabla) || cal.tabla.startsWith('pg_')) continue;
      selects.push({
        tabla: cal.tabla, columnas: cal.columnas, archivo,
        linea: lineaDe(original, offset + cal.idx),
      });
    }

    for (const sel of selectsDeUnaTabla(sql)) {
      if (locales.has(sel.tabla) || IGNORAR.has(sel.tabla)) continue;
      selects.push({
        tabla: sel.tabla, columnas: sel.columnas, archivo,
        linea: lineaDe(original, offset + sel.idx),
      });
    }
  }

  return { tablas, inserts, selects };
}
