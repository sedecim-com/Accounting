/**
 * EL CENSO DE POLÍTICAS DE AISLAMIENTO, EN UN SOLO SITIO.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (auditoría adversarial de S4a).
 *
 * `rls-por-su-predicado.int.spec.ts` juzga cada política ejecutando su
 * predicado almacenado, y probaba que sabía hacerlo contra catorce formas
 * inofensivas escritas a mano. Pero esas catorce viajaban por un camino
 * distinto del que viajan las políticas de verdad: se leían con `pg_get_expr` y
 * se pasaban directamente al juez, saltándose el CENSO. Y el censo tenía la
 * fuga:
 *
 *   JOIN pg_depend d ON … AND d.refobjsubid > 0
 *   JOIN pg_attribute at ON …
 *
 * Un JOIN INTERNO por la columna de la que la política depende. Medido contra
 * Postgres 15 el 2026-09-02: `USING (true)` y `USING (1 = 1)` producen CERO
 * dependencias de columna en `pg_depend`. Es decir, las dos maneras más
 * simples de anular el aislamiento —y la primera es exactamente lo que
 * cualquiera escribe para «desactivarlo un rato»— DESAPARECÍAN de la lista
 * antes de ser juzgadas. La política existía, no filtraba, y ninguna aserción
 * la tocaba. La red que quedaba debajo (conjuntos disjuntos) sólo dice algo de
 * las ~24 tablas sembradas con filas de los dos inquilinos; las otras ~74
 * pasaban por vacuidad.
 *
 * Aquí el censo usa LEFT JOIN, así que una política sin columna sí aparece —
 * con `columna: null`— y `discrimina` la declara rota sin necesidad de
 * ejecutar nada: un predicado que no lee ninguna columna de su tabla no puede
 * distinguir una fila de otra, y por tanto tampoco al dueño del extraño.
 *
 * Vive en un helper y no en el spec para que el ATAQUE
 * (s4a-ataque.int.spec.ts) juzgue el MISMO SQL que corre en producción de la
 * prueba, en vez de una copia que se puede quedar atrás. La lección del tramo,
 * aplicada al tramo.
 */

export interface PoliticaDirecta {
  tabla: string;
  /** null = la política no depende de ninguna columna de su propia tabla. */
  columna: string | null;
  predicado: string;
}

/** Una política directa que sí depende de una columna de su tabla. */
export interface PoliticaConColumna extends PoliticaDirecta {
  columna: string;
}

export interface PoliticaHija {
  hijo: string;
  /** null = sin dependencia de columna: no cuelga de ninguna llave. */
  fk: string | null;
  fkNotNull: boolean | null;
  /** null = sin dependencia de tabla padre: no cuelga de ningún padre. */
  padre: string | null;
  padreRls: boolean | null;
  padreForce: boolean | null;
  padreAislado: boolean | null;
  predicado: string;
}

/**
 * Políticas `tenant_isolation` con la columna de la que dependen.
 *
 * LEFT JOIN, no JOIN: ver la cabecera. Una política sin dependencia de columna
 * sale con `columna: null` en vez de no salir.
 */
export const SQL_POLITICAS_DIRECTAS = `
  SELECT c.relname AS tabla, at.attname AS columna, pg_get_expr(p.polqual, p.polrelid) AS predicado
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_policy'::regclass
                       AND d.refobjid = p.polrelid AND d.refobjsubid > 0
  LEFT JOIN pg_attribute at ON at.attrelid = d.refobjid AND at.attnum = d.refobjsubid
  WHERE p.polname = 'tenant_isolation' ORDER BY 1`;

/** Igual, para las políticas de hijos, que alcanzan al inquilino por su padre. */
export const SQL_POLITICAS_HIJAS = `
  SELECT hijo.relname AS hijo, col.attname AS fk, col.attnotnull AS "fkNotNull",
         padre.relname AS padre, padre.relrowsecurity AS "padreRls",
         padre.relforcerowsecurity AS "padreForce",
         EXISTS (SELECT 1 FROM pg_policy pp WHERE pp.polrelid = padre.oid
                   AND pp.polname LIKE 'tenant_isolation%') AS "padreAislado",
         pg_get_expr(p.polqual, p.polrelid) AS predicado
  FROM pg_policy p
  JOIN pg_class hijo ON hijo.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = hijo.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_depend dcol ON dcol.objid = p.oid AND dcol.classid = 'pg_policy'::regclass
                          AND dcol.refobjid = p.polrelid AND dcol.refobjsubid > 0
  LEFT JOIN pg_attribute col ON col.attrelid = dcol.refobjid AND col.attnum = dcol.refobjsubid
  LEFT JOIN pg_depend dpar ON dpar.objid = p.oid AND dpar.classid = 'pg_policy'::regclass
                          AND dpar.refclassid = 'pg_class'::regclass AND dpar.refobjid <> p.polrelid
  LEFT JOIN pg_class padre ON padre.oid = dpar.refobjid
  WHERE p.polname = 'tenant_isolation_child' ORDER BY 1`;

/**
 * ¿Este predicado es incapaz de distinguir una fila de otra?
 *
 * Sin dependencia de columna, el predicado da el mismo valor para toda fila de
 * la tabla: o las deja pasar todas o no deja ninguna. `USING (true)`,
 * `USING (1 = 1)` y `USING ((SELECT true))` caen aquí, y no hace falta
 * ejecutarlas para saberlo. Es un juicio sobre la FORMA, sí — pero sobre la
 * forma que Postgres almacena, no sobre el texto que alguien escribió.
 */
export const discrimina = (p: PoliticaDirecta): p is PoliticaConColumna => p.columna !== null;

/** Una política de hijos que sí cuelga de una llave y de un padre. */
export interface HijaAnclada extends PoliticaHija {
  fk: string;
  padre: string;
}

/**
 * ¿Esta política de hijos cuelga de algo?
 *
 * La política de hijos no menciona al inquilino: lo alcanza por el padre. Sin
 * dependencia de columna (la llave) NI de tabla (el padre) no delega en nadie,
 * y —igual que en las directas— con un JOIN interno ni siquiera salía en la
 * lista. Es un predicado de la forma `true`.
 */
export const hijaAnclada = (h: PoliticaHija): h is HijaAnclada =>
  h.fk !== null && h.padre !== null;
