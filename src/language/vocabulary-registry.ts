// ============================================================
// EL REGISTRO DEL VOCABULARIO PERSISTIDO (I4 · issue #146)
//
// QUÉ ES, Y QUÉ NO ES. No es el destino: es EL MAPA Y LA RED.
//
// El epic #141 va a renombrar al inglés lo que este sistema persiste —valores
// en columnas de despachos reales, códigos que un cliente ajeno ya consume,
// nombres de migración que un migrador reconoce—. Ese renombrado ocurre en
// I23–I25, no aquí. Lo que este tramo entrega es el inventario con el nombre
// inglés YA DECIDIDO para cada entrada, y con la razón escrita cuando una
// entrada NO se renombra.
//
// Sin este mapa, cada tramo posterior decide su nombre por su cuenta y el
// mismo concepto acaba con dos traducciones en dos tablas. Con él, el
// renombrado por clase es mecánico y revisable ANTES de tocar un solo dato.
//
// ============================================================
// LA DISTINCIÓN QUE DECIDE ESTE REGISTRO
//
// No es «español» contra «inglés»: es QUIÉN PUSO EL NOMBRE.
//
//   · Lo que nombramos NOSOTROS se traduce. `pendiente`, `cancelada`,
//     `saldo_libro` son decisiones de esta casa y se pueden cambiar.
//   · Lo que nombra UNA AUTORIDAD se queda, y con su razón escrita.
//     `RfcProvCertif`, `NumCta`, `CodAgrup`, `MetodoPago` son campos del SAT:
//     traducirlos rompe el mapeo con un catálogo externo, y el archivo que
//     sale hacia la autoridad dejaría de casar. Eso no es deuda, es contrato.
//
// La segunda clase es mayoría en las columnas fiscales, y confundirla con la
// primera es el error caro de este tramo: un renombrado «de limpieza» sobre
// un campo del Anexo 24 no se nota en ninguna prueba y se descubre cuando el
// SAT rechaza el archivo del mes.
// ============================================================

/** De qué población sale la entrada. Cada clase se renombra en su propio PR. */
export type VocabularyClass =
  | 'table'
  | 'column'
  | 'check-value'
  | 'account-role'
  | 'as-const'
  | 'policy-key'
  | 'policy-value'
  | 'migration-name'
  | 'error-code'
  | 'openapi-extension'
  | 'golden-key'
  | 'sealed-artifact';

/** Por qué una entrada NO se renombra. Una excepción sin razón es una excepción sin dueño. */
export type KeptReason =
  /** Lo nombra el SAT, el IMSS o el INFONAVIT: traducirlo rompe el mapeo con su catálogo. */
  | 'authority-field'
  /** Es un acrónimo oficial (RFC, CFDI, IMSS, UMA): no es vocabulario, es nombre propio. */
  | 'official-acronym'
  /** Un tercero ya lo consume y romperlo es un cambio de contrato, no una traducción. */
  | 'published-contract'
  /** Es idéntico en los dos idiomas: renombrarlo no cambia nada. */
  | 'identical-in-both'
  /**
   * EL NOMBRE ES LA IDENTIDAD DE UNA FILA YA ESCRITA, y cambiarlo no la
   * renombra: crea otra.
   *
   * El caso que obligó a añadir esta razón son los nombres de migración. El
   * migrador guarda el nombre COMPLETO del archivo en `public.migrations.
   * filename` y decide saltarse un archivo comparando ese nombre, así que
   * renombrar una migración ya aplicada la VUELVE A APLICAR — sobre la base
   * de un despacho, con sus rellenos y sus purgas otra vez. El árbol ya lo
   * prohíbe en `isRenameable()` (scripts/language/lanes/plan.ts:207-211), y
   * el inventario de este tramo llegó a proponer los 35 renombrados igual:
   * la razón existe para que esa contradicción no pueda repetirse en
   * silencio.
   *
   * No es `published-contract`: no hay un tercero al que avisar. Es más
   * duro que eso — no hay forma de renombrar, ni siquiera coordinada, salvo
   * migrando también las filas que guardan el nombre viejo.
   */
  | 'record-identity';

export interface VocabularyEntry {
  /** De qué población sale. */
  class: VocabularyClass;
  /** Dónde vive, para poder encontrarlo: `tabla.columna`, ruta, o el nombre del `as const`. */
  where: string;
  /** El nombre de hoy, tal cual está persistido o escrito. */
  es: string;
  /**
   * El nombre inglés con el que se renombrará — o `null` si NO se renombra,
   * y entonces `keptBecause` dice por qué.
   *
   * Decidirlo AQUÍ y no en el tramo que renombra es el punto entero del
   * registro: si cada clase elige su nombre cuando le toca, el mismo concepto
   * acaba traducido de dos formas en dos tablas, y eso ya no se arregla con
   * un renombrado — se arregla con otro.
   */
  en: string | null;
  /** Obligatoria cuando `en` es null. */
  keptBecause?: KeptReason;
  /** Por qué este nombre y no otro; o qué se rompe si se traduce. */
  why: string;
}

// ============================================================
// POR QUÉ LOS DATOS ESTÁN EN UN JSON Y NO AQUÍ
//
// Las entradas son 638 y cada una lleva escrita su razón: ~280 KB. Como
// literal TypeScript harían este módulo ilegible y el compilador lento, y
// además invitarían a editar el registro a mano en medio del código que lo
// interpreta. Separados, los datos son datos y esto es el contrato.
//
// El precio de separarlos es que `import` de un JSON NO COMPRUEBA NADA en
// ejecución: el tipo pasaría a ser una promesa. Por eso se valida al leer, y
// se falla ruidoso. Un registro malformado leído en silencio es peor que no
// tener registro, porque el renombrado de I23–I25 le va a creer.
// ============================================================

import bruto from './vocabulary-registry.json';

const CLASSES: readonly VocabularyClass[] = [
  'table',
  'column',
  'check-value',
  'account-role',
  'as-const',
  'policy-key',
  'policy-value',
  'migration-name',
  'error-code',
  'openapi-extension',
  'golden-key',
  'sealed-artifact',
];

const REASONS: readonly KeptReason[] = [
  'authority-field',
  'official-acronym',
  'published-contract',
  'identical-in-both',
  'record-identity',
];

/**
 * QUÉ HACE INVÁLIDA UNA ENTRADA. Devuelve la lista de problemas, vacía si no
 * hay ninguno; no lanza, para que un criterio pueda REPORTARLOS TODOS en vez
 * de morirse en el primero.
 *
 * Las dos reglas que no son de forma sino de fondo:
 *   · `en: null` OBLIGA a `keptBecause`. Una excepción sin razón es una
 *     excepción sin dueño, y dentro de seis meses nadie sabrá si el término
 *     se quedó por contrato o porque a alguien se le pasó.
 *   · `en` y `keptBecause` juntos es una contradicción: o se renombra o no.
 */
export function problemsIn(e: VocabularyEntry, at: number): string[] {
  const p: string[] = [];
  const id = `#${at} ${e.where} · ${e.es}`;
  if (!CLASSES.includes(e.class)) p.push(`${id}: clase desconocida «${String(e.class)}»`);
  if (!e.where?.trim()) p.push(`${id}: sin «where», así que nadie puede encontrarlo`);
  if (!e.es?.trim()) p.push(`${id}: sin «es»`);
  if (!e.why?.trim()) p.push(`${id}: sin «why»; una decisión sin razón no es una decisión`);
  if (e.en === null || e.en === undefined) {
    if (!e.keptBecause) p.push(`${id}: no se renombra y no dice por qué`);
    else if (!REASONS.includes(e.keptBecause)) p.push(`${id}: razón desconocida «${e.keptBecause}»`);
  } else {
    if (!e.en.trim()) p.push(`${id}: «en» vacío; para no renombrar se usa null y una razón`);
    if (e.keptBecause) p.push(`${id}: trae nombre inglés Y razón para no renombrarse`);
  }
  return p;
}

interface RegistryFile {
  entries: VocabularyEntry[];
}

function load(): readonly VocabularyEntry[] {
  const entries = (bruto as unknown as RegistryFile).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('vocabulary-registry.json no trae entradas: el registro está vacío o malformado');
  }
  const problems = entries.flatMap((e, i) => problemsIn(e, i));
  if (problems.length) {
    throw new Error(
      `vocabulary-registry.json tiene ${problems.length} entrada(s) inválida(s):\n  ` +
        problems.slice(0, 10).join('\n  ')
    );
  }
  return Object.freeze(entries);
}

/**
 * El registro. Se valida la PRIMERA VEZ que alguien lo pide, no al importar:
 * un módulo que lanza al cargarse rompe importaciones que no tenían nada que
 * ver con él, y el fallo aparece lejos de su causa.
 */
let cached: readonly VocabularyEntry[] | null = null;
export function registry(): readonly VocabularyEntry[] {
  if (cached === null) cached = load();
  return cached;
}

/** Las entradas de una clase, para que cada tramo de renombrado lea la suya. */
export function entriesOf(cls: VocabularyClass): VocabularyEntry[] {
  return registry().filter((e) => e.class === cls);
}

/** Lo que se renombra: tiene nombre inglés decidido. */
export function renamed(): VocabularyEntry[] {
  return registry().filter((e) => e.en !== null);
}

/** Lo que se queda, con su razón. Es la lista que un revisor lee primero. */
export function kept(): VocabularyEntry[] {
  return registry().filter((e) => e.en === null);
}

/**
 * ¿ESTÁ ESTE TÉRMINO REGISTRADO? Es la pregunta que hace el criterio, una vez
 * por cada literal español que encuentra en un CHECK y por cada AccountRole.
 *
 * `where` se compara por su CABEZA —lo que va antes de « · » o de un
 * paréntesis— porque una entrada puede precisar su sitio («tabla.columna ·
 * TipoArtefacto (artefactos.ts:24)») sin dejar de ser la misma columna. Sin
 * esa normalización, precisar el sitio sacaría la entrada del registro a ojos
 * del criterio, y precisar sería castigado.
 */
export function headOf(where: string): string {
  return where.split(' · ')[0].split(' (')[0].trim();
}

export function isRegistered(cls: VocabularyClass, where: string, es: string): boolean {
  const head = headOf(where);
  return registry().some((e) => e.class === cls && headOf(e.where) === head && e.es === es);
}
