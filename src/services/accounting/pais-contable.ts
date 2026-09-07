// ============================================================
// ESTE ARCHIVO YA NO DECIDE NADA: REEXPORTA.
//
// «¿Esta entidad lleva contabilidad mexicana?» se contestaba aquí, y aquí
// mismo decía la cabecera que había unificado cuatro copias. No las había
// unificado: tres seguían vivas sin usar esta función —el predicado de
// `iva-cash-basis`, el mismo predicado dentro del SQL de `iva-ppd-reclass` y
// el país comparado a secas contra MX del doctor— y difería el borde,
// que es la peor clase de convención: la que parece una y son varias.
//
// J0.1 (issue #123, docs/jurisdicciones.md §3.1) mueve la decisión a
// `src/services/jurisdiccion/jurisdiccion.ts`, donde además de este booleano
// vive `jurisdiccionDe`, que contesta las dos preguntas que el booleano
// colapsaba —qué autoridad fiscal gobierna a la entidad y bajo qué norma
// lleva los libros—, y el fragmento de SQL que dice lo MISMO dentro de un
// `WHERE`, para que las consultas sigan acotando en la consulta.
//
// El reexporte se conserva porque `entity-accounting.ts` importa desde aquí
// y este tramo no cambia a QUIÉN se le siembra el estrato fiscal mexicano:
// eso es una bifurcación de criterio contable —la filial extranjera con
// libros en NIF— y se decide con nombre propio, no dentro de una
// refactorización. El día que se decida, se cambia en un solo sitio.
// ============================================================

export { esContabilidadMexicana } from '../jurisdiccion/jurisdiccion.js';
