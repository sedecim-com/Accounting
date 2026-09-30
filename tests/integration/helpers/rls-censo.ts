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
  /** La mitad USING (polqual). */
  predicado: string;
  /** La mitad WITH CHECK (polwithcheck). null = ausente: Postgres aplica el USING. */
  check: string | null;
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

/**
 * Igual, para las políticas de hijos, que alcanzan al inquilino por su padre.
 *
 * Las dos mitades (USING y WITH CHECK) salen por separado: `pg_depend` las
 * mezcla —una política tiene UNA lista de dependencias—, así que `fk` y `padre`
 * son lo que cualquiera de las dos mitades menciona, y cuál de ellas lo hace se
 * juzga ejecutándolas (ver `childPolicyShape`). `fk` es la columna de la hija
 * distinta de `tenant_id`: LATERAL ... LIMIT 1 para que una política que lee
 * dos columnas siga dando UNA fila.
 */
export const SQL_POLITICAS_HIJAS = `
  SELECT hijo.relname AS hijo, col.attname AS fk, col.attnotnull AS "fkNotNull",
         padre.relname AS padre, padre.relrowsecurity AS "padreRls",
         padre.relforcerowsecurity AS "padreForce",
         EXISTS (SELECT 1 FROM pg_policy pp WHERE pp.polrelid = padre.oid
                   AND pp.polname LIKE 'tenant_isolation%') AS "padreAislado",
         pg_get_expr(p.polqual, p.polrelid) AS predicado,
         pg_get_expr(p.polwithcheck, p.polrelid) AS check
  FROM pg_policy p
  JOIN pg_class hijo ON hijo.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = hijo.relnamespace AND n.nspname = 'public'
  LEFT JOIN LATERAL (
    SELECT at.attname, at.attnotnull
    FROM pg_depend dcol
    JOIN pg_attribute at ON at.attrelid = dcol.refobjid AND at.attnum = dcol.refobjsubid
    WHERE dcol.objid = p.oid AND dcol.classid = 'pg_policy'::regclass
      AND dcol.refobjid = p.polrelid AND dcol.refobjsubid > 0 AND at.attname <> 'tenant_id'
    ORDER BY at.attnum LIMIT 1) col ON true
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

/**
 * Qué promete cada política de hijos.
 *
 *  - `delegated`: sin WITH CHECK, el USING hace también de comprobación y
 *    cuelga del padre (la forma de hoy: `USING (EXISTS padre)`).
 *  - `split`: con WITH CHECK. El USING promete el inquilino
 *    (`tenant_id = app_current_tenant()`) y el WITH CHECK promete el padre
 *    visible además del inquilino.
 *  - `loose`: no cumple ninguna de las dos por FORMA. Un WITH CHECK ausente
 *    sobre un USING que no cuelga del padre cae aquí (el INSERT no
 *    comprobaría al padre), y un WITH CHECK sin padre también (la mezcla de
 *    dependencias sólo trae padre si alguna mitad lo menciona, y en la forma
 *    dividida el USING no lo hace).
 */
export type ChildPolicyShape = 'delegated' | 'split' | 'loose';

export const childPolicyShape = (h: PoliticaHija): ChildPolicyShape => {
  if (h.check === null) return hijaAnclada(h) ? 'delegated' : 'loose';
  return hijaAnclada(h) ? 'split' : 'loose';
};
