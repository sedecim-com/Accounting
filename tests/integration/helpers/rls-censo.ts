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
  /** The USING half (polqual). */
  predicado: string;
  /** The WITH CHECK half (polwithcheck). null = absent: Postgres applies the USING. */
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
 * Same, for the child policies, which reach the tenant through their parent.
 *
 * The two halves (USING and WITH CHECK) come out apart: `pg_depend` mixes them
 * (a policy has ONE dependency list), so `fk` and `padre` are whatever either
 * half mentions, and which half does is judged by running them (see
 * `childPolicyShape`). Both are picked with LATERAL ... LIMIT 1 so a policy
 * that reads two columns or mentions two tables still yields ONE row: `fk` is
 * the lowest-attnum column other than `tenant_id`, and `padre` is the table
 * that `fk` references through its foreign key when the policy mentions it,
 * otherwise the first table the policy mentions.
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
  LEFT JOIN LATERAL (
    SELECT dpar.refobjid
    FROM pg_depend dpar
    WHERE dpar.objid = p.oid AND dpar.classid = 'pg_policy'::regclass
      AND dpar.refclassid = 'pg_class'::regclass AND dpar.refobjid <> p.polrelid
    ORDER BY EXISTS (
      SELECT 1 FROM pg_constraint k JOIN pg_attribute fa ON fa.attrelid = k.conrelid
        AND fa.attnum = ANY (k.conkey) AND fa.attname = col.attname
      WHERE k.contype = 'f' AND k.conrelid = p.polrelid AND k.confrelid = dpar.refobjid) DESC,
      dpar.refobjid
    LIMIT 1) dp ON true
  LEFT JOIN pg_class padre ON padre.oid = dp.refobjid
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
 * What each child policy promises.
 *
 *  - `delegated`: no WITH CHECK, so the USING doubles as the check and hangs
 *    from the parent (today's shape: `USING (EXISTS parent)`).
 *  - `split`: has a WITH CHECK. The USING promises the tenant
 *    (`tenant_id = app_current_tenant()`) and the WITH CHECK promises a
 *    visible parent on top of the tenant.
 *  - `loose`: neither, by SHAPE. An absent WITH CHECK over a USING that does
 *    not hang from the parent lands here (the INSERT would not check the
 *    parent), and so does a WITH CHECK with no parent (the merged dependencies
 *    only carry a parent if some half mentions it, and in the split shape the
 *    USING does not).
 */
export type ChildPolicyShape = 'delegated' | 'split' | 'loose';

export const childPolicyShape = (h: PoliticaHija): ChildPolicyShape => {
  if (h.check === null) return hijaAnclada(h) ? 'delegated' : 'loose';
  return hijaAnclada(h) ? 'split' : 'loose';
};
