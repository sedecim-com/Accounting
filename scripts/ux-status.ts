/**
 * EL CENSO DE SUPERFICIE — `npm run ux:status`
 *
 *   npm run ux:status               imprime el censo (tabla)
 *   npm run ux:status -- --json     el mismo censo, contrato de máquina
 *   npm run ux:status -- --check    sale con 1 si algún número CRECIÓ
 *   npm run ux:status -- --apretar  baja las líneas base que quedaron con holgura
 *
 * POR QUÉ EXISTE, Y POR QUÉ NO SE PARECE AL GUARDIÁN QUE YA HABÍA
 *
 * La política de superficie —cada hoja con su ejemplo, su contrato de salida,
 * su alias en castellano, su ayuda en el idioma canónico— ya tenía guardián:
 * tests/cli/bilingual-matrix.spec.ts. Pasaba en verde mientras trece hojas la
 * incumplían, y no por un descuido de quien lo escribió, sino por su FORMA:
 * mide contra una LISTA ESCRITA A MANO. Catorce familias de cuarenta y cinco
 * en el mapa bilingüe; diez expresiones regulares de frases literales que
 * alguien vio una vez, aplicadas a cuatro pantallas de ciento setenta y ocho.
 * Un instrumento así no mide la superficie: mide la lista, y la lista no crece
 * cuando crece el binario. El día que se añade la familia número cuarenta y
 * seis, el guardián sigue diciendo que todo está bien.
 *
 * La lección de la casa es la de `scripts/catalogo-estado.ts` y la de
 * `auditProgram`: el instrumento se deriva del ÁRBOL REAL. Aquí se recorre el
 * `program` que exporta src/cli/mnemosine.ts —el mismo objeto que responde en
 * la terminal, no una réplica— y se cuentan seis cosas sobre las hojas y los
 * nodos que existen hoy.
 *
 * SEIS NÚMEROS Y SEIS TRINQUETES
 *
 * Ninguno de los seis se puede llevar a cero en un commit, y fingir lo
 * contrario apagaría la puerta el primer día (es exactamente lo que le pasó a
 * LINEA_BASE en src/cli/kernel/audit.ts, y de ahí se copia el mecanismo: no se
 * inventa otro). Así que cada número lleva su línea base sembrada con lo
 * MEDIDO, y la línea base SÓLO PUEDE ENCOGER: `--check` falla si un número
 * crece, y la prueba falla si un número baja sin que alguien baje también su
 * línea base — que es donde se recuerda apretar el trinquete.
 *
 * Las líneas base de este archivo se sembraron el 2026-09-02 midiendo el árbol
 * real (178 hojas, 235 nodos). NO son las cifras de la auditoría de
 * usabilidad: el árbol cambió desde entonces y copiarlas habría vuelto a poner
 * una lista paralela donde tiene que haber una medición. `hojas-sin-ejemplo`
 * ya se apretó cuatro veces en la misma sesión en que se sembró —170, 161,
 * 151, 140— porque otra mano estaba añadiendo bloques `Examples:` mientras
 * esto se escribía. Es la mejor prueba de que el censo mide el árbol y no una
 * lista: si midiera una lista, ese trabajo no habría movido nada.
 *
 * LO QUE CAMBIÓ EL MISMO 2026-09-02, DESPUÉS DE MEDIR AL PROPIO CENSO
 *
 * El censo se midió a sí mismo con lo que le pide a los demás y salió con
 * cinco defectos; los cinco están cerrados en este archivo y cada uno tiene su
 * caso en tests/cli/censo-superficie.spec.ts:
 *
 *   · `--json --apretar` imprimía prosa DESPUÉS del JSON en el mismo stdout, y
 *     `JSON.parse` de la salida reventaba. Ahora los efectos entran por
 *     parámetro y stdout lleva sólo el contrato (ver `Efectos`).
 *   · `tieneEjemplo` medía la ayuda ENTERA y daba por resueltas dos hojas por
 *     una referencia cruzada y por una advertencia de lo que NO teclear. Ahora
 *     mide sólo la prosa que un autor escribió (ver `prosaQueEnsena`).
 *   · La RAÍZ no se censaba: sus banderas globales contaban para un número y
 *     su prosa para ninguno. Ahora es un nodo más (de ahí 179 hojas y 237
 *     nodos donde antes se leían 236).
 *   · `hojas-sin-contrato-de-salida` se le exigía a `completion`, cuya salida
 *     es un guion de shell. Ahora hay lista de excepciones explícita, con la
 *     razón escrita al lado y su propio trinquete (ver `SALIDA_NO_TABULAR`).
 *   · Lo que `hojas-sin-alias-castellano` NO comprueba está dicho por escrito
 *     en `faltaAlias`, con la prueba que acota el hueco.
 *
 * Y las líneas base se apretaron contra el árbol ya reparado por los seis
 * arreglos de este lote: `hojas-sin-ejemplo` bajó de 116 a 64 —los dos falsos
 * positivos incluidos, que SUBEN el número honesto— con `--apretar` corriendo
 * sobre este mismo archivo.
 *
 * EL ÁRBOL CRECIÓ Y EL CENSO LO VIO: 179 → 210 HOJAS, LA MISMA TARDE
 *
 * La fusión de F05 (banco), F06 (cierre, activos, lotes) y R4 (moneda
 * extranjera) trajo treinta y una hojas nuevas, y `hojas-sin-ejemplo` subió de
 * 64 a 94 sin que nadie borrara un solo ejemplo: las que llegaron venían sin
 * ellos. Ése es el instrumento haciendo su trabajo. La lista escrita a mano que
 * este censo vino a sustituir habría seguido en verde, porque treinta y una
 * hojas que no están en la lista no existen para ella.
 *
 * Se cerró DOCUMENTANDO, no subiendo la línea base: 94 → 47 (ver
 * `LINEAS_BASE`, que dice qué se documentó y qué no). El árbol de hoy mide 210
 * hojas y 280 nodos, y las seis líneas base están pegadas a lo medido, sin un
 * punto de holgura.
 *
 * De las seis, UNA subió: `nodos-fuera-del-idioma-canonico`, de 6 a 7, porque
 * la fusión trajo un nodo más fuera del idioma y el arreglo no es de este
 * tramo (es un valor de bandera, y su idioma es la decisión §5.1, abierta y del
 * dueño). Está escrito entero en `LINEAS_BASE` con su porqué: subir es un acto
 * manual —`--apretar` se niega— y ésta es la única forma en que un +1 deja
 * rastro legible en vez de esconderse en un diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { program } from '../src/cli/mnemosine.js';
import { riskOf } from '../src/cli/kernel/risk.js';
import { FLAG_DICTIONARY } from '../src/cli/kernel/flags.js';
import { VERBS } from '../src/cli/kernel/vocabulary.js';

// ============================================================
// LAS SEIS MEDIDAS
// ============================================================

export const CLAVES = [
  'hojas-sin-ejemplo',
  'hojas-sin-contrato-de-salida',
  'hojas-sin-alias-castellano',
  'nodos-fuera-del-idioma-canonico',
  'hojas-graves-sin-las-tres-banderas',
  'banderas-del-diccionario-sin-hoja',
] as const;

export type Clave = (typeof CLAVES)[number];

/** Qué mide cada número, en una línea, para la tabla y para el JSON. */
export const TITULOS: Readonly<Record<Clave, string>> = Object.freeze({
  'hojas-sin-ejemplo': 'hojas cuya ayuda no muestra ni una invocación',
  'hojas-sin-contrato-de-salida': 'hojas declaradas de lectura sin --format y --json',
  'hojas-sin-alias-castellano': 'hojas sin su alias en castellano',
  'nodos-fuera-del-idioma-canonico': 'nodos con prosa fuera del idioma canónico',
  'hojas-graves-sin-las-tres-banderas':
    'hojas irreversibles o externas sin --dry-run, --yes e --idempotency-key',
  'banderas-del-diccionario-sin-hoja': 'banderas del diccionario que ningún nodo declara',
});

/**
 * LO MEDIDO HOY (2026-09-02, 210 hojas y 280 nodos: el árbol DESPUÉS de la
 * fusión de F05, F06 y R4).
 *
 * Sólo puede encoger. Si arreglas hojas, aprieta el trinquete en el mismo
 * commit —`npm run ux:status -- --apretar` reescribe estos números— porque la
 * prueba te lo va a pedir: una línea base con holgura deja de ser deuda
 * registrada y se vuelve un permiso permanente. SUBIR uno de estos números
 * sigue siendo un acto manual; `--apretar` se niega a hacerlo.
 *
 * ── `hojas-sin-ejemplo` = 47 ──────────────────────────────────────────────
 *
 * QUÉ SE DOCUMENTÓ Y QUÉ NO, ESCRITO AQUÍ PARA QUE EL NÚMERO SIGUIENTE SEPA
 * CONTRA QUÉ COMPARA. 64 era el número de un árbol de 179 hojas; la fusión lo
 * llevó a 94 y este lote lo bajó a 47 escribiendo ejemplos, que es la única
 * forma de bajarlo que no es maquillaje.
 *
 * Lo documentado es CONTABILIDAD DIARIA —lo que un contador teclea todos los
 * meses—: la familia `bank` entera (32 hojas, de `bank account create` a
 * `bank check reconcile`: conciliación bancaria, el hueco más grande y el más
 * tecleado), y `fx`, `batch`, `closing`, `depreciation`, `asset` y `period`
 * de lo que trajo la fusión.
 *
 * Los 47 que quedan NO son un descuido ni un resto: son PLOMERÍA, y quedan
 * ENTERAS. Diecisiete familias sin una sola hoja documentada —ninguna a
 * medias, que es la forma que sí engaña al usuario y que la regla de «familia
 * a medias» de tests/cli/ejemplos-de-ayuda.spec.ts vigila aparte—:
 *
 *   entity 6 · jobs 6 · backup 5 · sat 4 · memory 4 · webhooks 4 · pending 3 ·
 *   approvals 3 · skills 3 · rep 2 · doctor · prompt-size · compact · ai ·
 *   usage · status · init
 *
 * Ninguna se teclea en el cierre de un mes: son administración de la
 * instalación (entity, backup, init), del agente (memory, skills, ai,
 * prompt-size, compact), de la automatización (jobs, webhooks, approvals,
 * pending) y del diagnóstico (doctor, status, usage, rep, sat cred). Bajar de
 * 47 es documentar plomería, y eso es un lote con su propio alcance, no el
 * efecto secundario de que alguien toque la hoja de al lado.
 *
 * ── `nodos-fuera-del-idioma-canonico` = 7, SUBIDO A MANO ──────────────────
 *
 * Es el único de los seis que SUBE en este lote, y sube porque el árbol creció
 * con un nodo más fuera del idioma. Los seis de siempre son `account map
 * import`, `entry import`, `cfdi list`, `cfdi status show`, `ai` y `ai stats`
 * —prosa de autor escrita en castellano, deuda vieja y arreglable—. El séptimo
 * lo trajo la fusión y NO es de esa clase: `batch check` enumera en su
 * `--check` las cinco categorías de hallazgo que el servicio acepta, y una se
 * llama `cuenta`. El censo la ve como castellano dentro de una frase inglesa,
 * y tiene razón en lo que ve: está en pantalla y está en castellano.
 *
 * POR QUÉ SUBE LA LÍNEA BASE EN VEZ DE ARREGLARSE. `cuenta` no es una palabra
 * que el autor eligió al redactar: es un VALOR QUE EL USUARIO TECLEA, superficie
 * con el mismo estatus que el nombre de un comando. Renombrarlo para bajar un
 * número rompería a quien ya escribe `--check cuenta` y, sobre todo, decidiría
 * por su cuenta la §5.1 —el idioma de la interfaz—, que es del DUEÑO y está
 * ABIERTA. Un trinquete no toma decisiones de producto; las registra hasta que
 * alguien las toma. Así que aquí queda registrada, con nombre y sitio, y sale
 * también en los pendientes del lote para que el dueño la vea al decidir.
 *
 * SUBIR ES UN ACTO MANUAL Y ÉSTE ES SU RASTRO. `--apretar` se niega a subir una
 * línea base justamente para que un +1 no pueda colarse como efecto secundario
 * de correr un comando; esta línea se escribió a mano y este párrafo es la razón
 * que la acompaña, que es lo que el mensaje del trinquete pide («sube la línea
 * base a mano en scripts/ux-status.ts y dilo en el commit»).
 *
 * LO QUE SE MIRÓ Y NO SE HIZO. `fueraDeIdioma` descuenta lo entrecomillado y lo
 * marcado entre acentos graves —por eso la descripción de `lang`, con su literal
 * 'es', no cuenta—, así que marcar las cinco categorías bajaría el número a 6 y
 * además le diría al lector que son valores literales. Es defendible, pero es
 * una edición de la ayuda de `batch check` (src/cli/batch-command.ts), no de
 * este censo, y hoy NO está hecha: ese archivo lleva un comentario que dice que
 * las cinco «van entre acentos graves» y la cadena que se imprime no los tiene.
 * Este 7 es la medición del árbol tal como está, no la del árbol que el
 * comentario describe; si alguien termina esa edición, el número baja a 6 y el
 * trinquete lo va a pedir por holgura.
 *
 * ── `hojas-graves-sin-las-tres-banderas` = 0 ──────────────────────────────
 *
 * Está en CERO y así se queda: hoy `declareRisk` inyecta las tres banderas a
 * toda hoja irreversible o externa, y el criterio es que eso NO se rompa el
 * día que alguien registre una hoja grave por fuera del núcleo.
 */
export const LINEAS_BASE: Readonly<Record<Clave, number>> = Object.freeze({
  'hojas-sin-ejemplo': 47,
  'hojas-sin-contrato-de-salida': 21,
  'hojas-sin-alias-castellano': 17,
  'nodos-fuera-del-idioma-canonico': 7,
  'hojas-graves-sin-las-tres-banderas': 0,
  'banderas-del-diccionario-sin-hoja': 11,
});

/**
 * HOJAS DE LECTURA CUYA SALIDA NO ES UNA TABLA.
 *
 * `hojas-sin-contrato-de-salida` le exige `--format` y `--json` a toda hoja
 * declarada de lectura, y esa exigencia da por hecho que lo que la hoja
 * imprime son FILAS. Para `completion` no lo son: imprime un guion de shell
 * que el usuario mete en un `eval`. Un `--json` ahí sería una mentira de
 * contrato —nadie va a hacer `eval` de un JSON— y `--format table` no
 * significa nada. Se barajaron tres salidas y ésta es la elegida:
 *
 *   (i)   inventarle las dos banderas para que el número baje: es maquillar, y
 *         además rompería el comando para quien lo use como manda su ayuda.
 *   (ii)  subir la línea base a mano con su razón escrita: el número sube y la
 *         razón queda en un commit que nadie vuelve a leer; la próxima hoja
 *         igual la sube otra vez y a los tres commits la línea base es una
 *         bolsa de excusas sin nombre.
 *   (iii) ESTA: una lista EXPLÍCITA, cada entrada con su razón en el código y
 *         nombrando la ruta exacta. Una excepción nueva es un renglón en el
 *         diff con su porqué al lado, no un +1 anónimo en una constante.
 *
 * Y SÓLO PUEDE ENCOGER, con el mismo mecanismo que `LINEA_BASE` de
 * src/cli/kernel/audit.ts: `censar` devuelve en `excepcionesMuertas` toda
 * entrada que este árbol ya no usa —porque la hoja se fue, o porque alguien le
 * dio su contrato de salida— y `--check` falla mientras siga escrita. Una
 * excepción que deja de hacer falta se borra; si no, deja de ser una decisión
 * y se vuelve un permiso permanente, que es exactamente lo que le pasó a la
 * lista escrita a mano que este censo vino a sustituir.
 */
export const SALIDA_NO_TABULAR: Readonly<Record<string, string>> = Object.freeze({
  completion:
    'imprime un guion de shell para `eval`, no filas: --json sería una mentira de contrato y --format table no significa nada',
});

export interface Caso {
  /** La ruta del nodo, o la bandera, según la medida. */
  sujeto: string;
  /** Por qué cuenta. */
  motivo: string;
}

export interface Censo {
  hojas: number;
  nodos: number;
  numeros: Record<Clave, number>;
  casos: Record<Clave, Caso[]>;
  /**
   * Rutas de `SALIDA_NO_TABULAR` que este árbol ya no necesita: la hoja
   * desapareció o ya declara su contrato. Son el trinquete de la lista de
   * excepciones —sólo puede encoger— y `--check` falla por ellas.
   */
  excepcionesMuertas: string[];
}

// ============================================================
// DETECTORES
// ============================================================

/**
 * NFD → NFC antes de comparar cualquier alias.
 *
 * `período` se puede escribir con la o acentuada precompuesta (U+00F3) o con
 * una o seguida del acento combinante (U+0301). Son la misma palabra y
 * distintas cadenas: sin normalizar, un alias acentuado que SÍ existe cuenta
 * como ausente y el número sube sin que nadie haya roto nada.
 */
export function normalizar(s: string): string {
  return s.normalize('NFC');
}

/** Secuencias de color, por si la ayuda se pide desde una terminal. */
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Marcas inequívocas de castellano en prosa que debería estar en inglés.
 *
 * Lista corta y deliberadamente conservadora: sólo palabras que no son
 * también inglesas. Quedaron fuera `no`, `a`, `as`, `son`, `con` y `este`
 * («con» y «son» son palabras inglesas y los demás aparecen a diario en ayuda
 * inglesa). La otra mitad del detector —acentos y eñe— no necesita lista.
 */
const PALABRAS_CASTELLANAS: ReadonlySet<string> = new Set([
  'aunque', 'cada', 'como', 'cuando', 'cuenta', 'desde', 'donde', 'el', 'entidad',
  'esta', 'fecha', 'la', 'las', 'los', 'del', 'muestra', 'opcional', 'para',
  'por', 'que', 'sin', 'sus', 'una', 'uno', 'archivo', 'proveedor', 'nombre',
]);

/**
 * ¿Esta prosa está fuera del idioma canónico (inglés)?
 *
 * Antes de mirar palabras se borra todo lo que es DATO y no prosa: los valores
 * entre comillas, las banderas y los marcadores `<x>` / `[x]`. Sin eso, la
 * descripción de `lang` —«'en' or 'es'; omit to show the current setting»—
 * contaba como castellano por el literal `'es'`, que es justamente uno de los
 * dos valores que el comando acepta.
 */
export function fueraDeIdioma(prosa: string): string | null {
  const n = normalizar(prosa);
  if (/[áéíóúüñÁÉÍÓÚÜÑ¿¡]/.test(n)) {
    return 'acento o eñe';
  }
  const limpia = n
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/--?[a-zA-Z][\w-]*/g, ' ');
  for (const palabra of limpia.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
    if (palabra && PALABRAS_CASTELLANAS.has(palabra)) return `«${palabra}»`;
  }
  return null;
}

/**
 * LA PROSA QUE ENSEÑA: lo que un autor escribió para esta hoja, y nada más.
 *
 * Son tres fuentes. Dos son los bloques de `addHelpText`, y leerlos tiene su
 * detalle: `addHelpText` no guarda texto, registra un escucha del evento
 * `beforeHelp`/`afterHelp` que `outputHelp` emite, y `helpInformation()` no
 * emite nada. Midiendo sólo con `helpInformation()`, un bloque `Examples:`
 * añadido a una hoja no movería el número —que es justamente el arreglo que
 * este censo pide— y el trinquete sería inalcanzable: se podría trabajar todo
 * un día en ejemplos sin que la medida bajara ni uno. La tercera es la
 * descripción del propio comando, que a veces remata con la invocación
 * concreta («resume one with: mnemosine chat --resume <id>»): eso enseña.
 *
 * Se emiten sólo los eventos del propio nodo, no los `beforeAllHelp` /
 * `afterAllHelp` de sus ancestros: un pie de página puesto en la raíz sale en
 * las 210 pantallas y dejaría las 210 hojas «con ejemplo» sin que ninguna
 * enseñe a usarse.
 *
 * LO QUE QUEDA FUERA, Y POR QUÉ NO ES UN DETALLE: las columnas `Arguments:` y
 * `Options:` que Commander maqueta sola. Ahí el binario se nombra por razones
 * que no enseñan a invocar la hoja, y midiendo la ayuda ENTERA se colaban dos
 * falsos positivos de los 117 que el censo daba por resueltos el 2026-09-02:
 *
 *   · `pending define` contaba por una referencia cruzada en la descripción de
 *     un argumento: «key  Decision key (see: mnemosine pending)».
 *   · `backup create` contaba por una ADVERTENCIA de lo que NO hay que teclear:
 *     «NOT here: a per-entity archive is `mnemosine backup export --entity
 *     <idOrName>`». Es una hoja de ESCRITURA sin una sola invocación utilizable
 *     en su ayuda, y el censo la marcaba como resuelta.
 *
 * Un instrumento que mide una aproximación de lo que dice medir es la clase de
 * defecto que este censo existe para no tener.
 */
function prosaQueEnsena(cmd: Command): string {
  const trozos: string[] = [];
  const contexto = {
    error: false,
    write: (s: string): boolean => {
      trozos.push(s);
      return true;
    },
    command: cmd,
  };
  const emisor = cmd as unknown as { emit(evento: string, ctx: unknown): boolean };
  emisor.emit('beforeHelp', contexto);
  const descripcion = cmd.description();
  if (descripcion) trozos.push(`\n${descripcion}\n`);
  emisor.emit('afterHelp', contexto);
  return trozos.join('');
}

/**
 * ¿La ayuda de esta hoja muestra al menos una invocación?
 *
 * Se pide una línea que invoque el binario dentro de la prosa que un autor
 * escribió (ver `prosaQueEnsena`). Sirve tanto un bloque `Examples:` añadido
 * con `addHelpText` como una descripción que remata con la invocación concreta.
 *
 * La línea `Usage:` no cuenta NI CUANDO LA ESCRIBE UN AUTOR: es la sinopsis
 * —Commander ya la imprime sola encima de todo— y repetirla no enseña ninguna
 * invocación concreta. Copiarla en un bloque `Examples:` sería la forma más
 * barata de bajar este número sin enseñar nada.
 */
export function tieneEjemplo(cmd: Command, binario: string): boolean {
  const ayuda = prosaQueEnsena(cmd).replace(ANSI, '');
  // El nombre del binario se toma de la raíz del árbol, no se escribe aquí:
  // el censo tiene que poder recorrer un programa sintético en una prueba sin
  // que el detector dependa de cómo se llame el que se embarca.
  const invocacion = new RegExp(
    `(?:^|[\\s\`'"($])${binario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+[a-z]`
  );
  return ayuda
    .split('\n')
    .filter((linea) => !/^\s*Usage:/.test(linea))
    .some((linea) => invocacion.test(linea));
}

/**
 * ¿A esta hoja le falta su alias en castellano, y por qué?
 *
 * Dos formas de incumplir, y la segunda es la que una lista escrita a mano no
 * puede ver: la hoja SÍ tiene alias, pero no el que el vocabulario cerrado le
 * asigna a su verbo (`memory correct` se aliaba `corrige` cuando el verbo
 * `correct` es `corregir`).
 *
 * Todo lo que se compara pasa por NFC primero. `período` con la o precompuesta
 * y `período` con acento combinante son la misma palabra y distintas cadenas;
 * sin normalizar, un alias acentuado que existe contaría como ausente.
 *
 * LO QUE ESTA MEDIDA NO COMPRUEBA, DICHO POR ESCRITO
 *
 * Cuando el verbo de la hoja NO está en `VERBS` —`castellano` llega
 * `undefined`— aquí sólo se comprueba PRESENCIA: cualquier alias vale, incluso
 * uno inglés. `faltaAlias('run-due', ['whatever-in-english'], undefined)`
 * devuelve `null`, y el número se puede bajar sin poner una palabra en
 * castellano. No es un descuido: es el límite del instrumento, y se elige
 * declararlo en vez de fingir que no está.
 *
 * Se descartó exigir «castellano de verdad» porque decidir si un token suelto
 * es castellano necesita un diccionario que este repositorio no tiene, y la
 * heurística que sí cabría —acentos más una lista corta de palabras— daría
 * exactamente los falsos positivos que este censo existe para no dar:
 * `borradores` y `ejecutar-vencidos` no llevan acento ni están en ninguna
 * lista, y contarían como incumplimiento.
 *
 * El hueco está ACOTADO, y no por buena voluntad: el vocabulario es CERRADO, y
 * toda hoja cuyo verbo esté fuera de él ya está registrada en otro sitio —o en
 * `OBJECTLESS_COMMANDS`, o nombrada una a una en la `LINEA_BASE` de
 * src/cli/kernel/audit.ts, que también sólo puede encoger. Son 25 hojas de 210
 * el 2026-09-02, ninguna sin registrar, y hay prueba que lo ancla. El día que
 * un verbo entra en `VERBS`, esta función pasa sola a exigirle la palabra
 * exacta: el hueco se cierra por donde tiene que cerrarse, que es la lista de
 * verbos, no aquí.
 */
export function faltaAlias(
  nombre: string,
  alias: readonly string[],
  castellano: string | undefined
): string | null {
  const propios = alias.map(normalizar).filter((a) => a !== normalizar(nombre));
  if (propios.length === 0) return 'no declara ningún alias';
  if (castellano && normalizar(castellano) !== normalizar(nombre) && !propios.includes(normalizar(castellano))) {
    return `el vocabulario asigna «${castellano}» a «${nombre}»; declara ${propios.join(', ')}`;
  }
  return null;
}

/** Las banderas largas que un nodo declara. */
function largas(cmd: Command): Set<string> {
  return new Set(cmd.options.map((o) => o.long).filter((l): l is string => Boolean(l)));
}

/** Toda la prosa que un nodo pone en pantalla y que es suya: la propia y la de sus banderas y argumentos. */
function prosaDe(cmd: Command): Array<{ donde: string; texto: string }> {
  const trozos: Array<{ donde: string; texto: string }> = [];
  const desc = cmd.description();
  if (desc) trozos.push({ donde: 'descripción', texto: desc });
  for (const o of cmd.options) {
    if (o.description) trozos.push({ donde: o.long ?? o.flags, texto: o.description });
  }
  const args = (
    cmd as unknown as { registeredArguments?: Array<{ name(): string; description: string }> }
  ).registeredArguments;
  for (const a of args ?? []) {
    if (a.description) trozos.push({ donde: `<${a.name()}>`, texto: a.description });
  }
  return trozos;
}

// ============================================================
// EL CENSO
// ============================================================

/**
 * Recorre el árbol y cuenta. Recibe la raíz por parámetro para que se pueda
 * censar un programa sintético en una prueba: si esto tomara el `program`
 * importado por su cuenta, la prueba sólo podría afirmar los números de hoy y
 * no que el censo CUENTA sobre el árbol que se le da.
 *
 * `excepciones` entra por parámetro por la misma razón: una prueba tiene que
 * poder censar el árbol REAL con la lista vacía y ver que la excepción escrita
 * está tapando algo que existe. Una excepción que no tapa nada es deuda muerta
 * y sale por `excepcionesMuertas`.
 */
export function censar(
  raiz: Command,
  excepciones: Readonly<Record<string, string>> = SALIDA_NO_TABULAR
): Censo {
  const casos: Record<Clave, Caso[]> = {
    'hojas-sin-ejemplo': [],
    'hojas-sin-contrato-de-salida': [],
    'hojas-sin-alias-castellano': [],
    'nodos-fuera-del-idioma-canonico': [],
    'hojas-graves-sin-las-tres-banderas': [],
    'banderas-del-diccionario-sin-hoja': [],
  };
  const declaradas = new Set<string>();
  const binario = raiz.name();
  /** Excepciones que este árbol USA. Las que sobren son deuda muerta. */
  const excepcionesVivas = new Set<string>();
  let hojas = 0;
  let nodos = 0;

  /**
   * Idioma canónico: se cuenta el NODO una vez, aunque tenga varias frases
   * fuera de idioma, porque lo que se arregla de una vez es una pantalla.
   * Vive aparte del recorrido porque la RAÍZ también es un nodo con prosa en
   * pantalla y tiene que pasar por aquí (ver el final de esta función).
   */
  const censarIdioma = (cmd: Command, ruta: string): void => {
    for (const { donde, texto } of prosaDe(cmd)) {
      const motivo = fueraDeIdioma(texto);
      if (motivo) {
        casos['nodos-fuera-del-idioma-canonico'].push({
          sujeto: ruta,
          motivo: `${motivo} en ${donde}: ${texto}`,
        });
        break;
      }
    }
  };

  const andar = (cmd: Command, cadena: string[]): void => {
    const ruta = [...cadena, cmd.name()].join(' ');
    const hijos = cmd.commands ?? [];
    nodos += 1;

    for (const larga of largas(cmd)) declaradas.add(larga);

    censarIdioma(cmd, ruta);

    if (hijos.length === 0) {
      hojas += 1;
      const declara = largas(cmd);
      const riesgo = riskOf(cmd);

      if (!tieneEjemplo(cmd, binario)) {
        casos['hojas-sin-ejemplo'].push({
          sujeto: ruta,
          motivo: 'su ayuda no invoca el binario ni una vez',
        });
      }

      // Contrato de salida: sólo se le exige a lo DECLARADO de lectura. Una
      // hoja sin declaración de riesgo no se cuenta aquí — de esa ausencia se
      // ocupa `gateMutation`, que falla cerrado, y no este censo.
      if (riesgo?.risk === 'lectura') {
        const faltan = ['--format', '--json'].filter((f) => !declara.has(f));
        if (faltan.length > 0) {
          // La excepción escrita gana, y queda registrada como VIVA: una que
          // deje de hacer falta tiene que borrarse, no quedarse de permiso.
          if (Object.prototype.hasOwnProperty.call(excepciones, ruta)) {
            excepcionesVivas.add(ruta);
          } else {
            casos['hojas-sin-contrato-de-salida'].push({
              sujeto: ruta,
              motivo: `falta ${faltan.join(' y ')}`,
            });
          }
        }
      }

      // Las tres banderas de una hoja grave.
      if (riesgo && (riesgo.risk === 'irreversible' || riesgo.risk === 'externo')) {
        const faltan = ['--dry-run', '--yes', '--idempotency-key'].filter((f) => !declara.has(f));
        if (faltan.length > 0) {
          casos['hojas-graves-sin-las-tres-banderas'].push({
            sujeto: ruta,
            motivo: `riesgo "${riesgo.risk}" sin ${faltan.join(', ')}`,
          });
        }
      }

      // El alias en castellano que el vocabulario cerrado le asigna al verbo
      // de la hoja. La decisión vive en `faltaAlias`, aparte, porque es la que
      // tiene la trampa de los acentos y quiere prueba propia.
      const castellano = (VERBS as Record<string, string | undefined>)[cmd.name()];
      const motivoAlias = faltaAlias(cmd.name(), cmd.aliases(), castellano);
      if (motivoAlias) {
        casos['hojas-sin-alias-castellano'].push({ sujeto: ruta, motivo: motivoAlias });
      }
    }

    for (const hijo of hijos) andar(hijo, [...cadena, cmd.name()]);
  };

  for (const hijo of raiz.commands ?? []) andar(hijo, []);

  /**
   * LA RAÍZ TAMBIÉN ES UN NODO.
   *
   * Sus banderas globales ya entraban en `declaradas` —`-T/--tenant` sale de
   * `banderas-del-diccionario-sin-hoja` gracias a ella— pero su prosa no
   * entraba en ninguna cuenta: el censo la veía para un número y no para el
   * otro. La descripción del programa y la ayuda de sus banderas globales
   * salen en las 210 pantallas; si están fuera del idioma canónico, están mal
   * en las 210. Se comprobó con una raíz sintética escrita entera en
   * castellano: el censo daba 0.
   *
   * Se cuenta como NODO y nunca como HOJA, aunque no tenga hijos: la raíz no
   * tiene verbo del vocabulario, ni clase de riesgo, ni alias castellano que
   * exigirle. Contarla de hoja metería un caso falso en tres de los seis
   * números.
   */
  nodos += 1;
  for (const larga of largas(raiz)) declaradas.add(larga);
  censarIdioma(raiz, binario);

  // Banderas del diccionario que ningún nodo declara: o falta el comando que
  // las prometía, o la fila del diccionario es un concepto que ya nadie habla.
  for (const larga of Object.keys(FLAG_DICTIONARY)) {
    if (!declaradas.has(larga)) {
      casos['banderas-del-diccionario-sin-hoja'].push({
        sujeto: larga,
        motivo: 'está en FLAG_DICTIONARY y ningún nodo del árbol la declara',
      });
    }
  }

  const excepcionesMuertas = Object.keys(excepciones).filter((r) => !excepcionesVivas.has(r));

  const numeros = Object.fromEntries(CLAVES.map((c) => [c, casos[c].length])) as Record<Clave, number>;
  return { hojas, nodos, numeros, casos, excepcionesMuertas };
}

// ============================================================
// EL TRINQUETE
// ============================================================

export interface Movimiento {
  clave: Clave;
  medido: number;
  lineaBase: number;
}

export interface Veredicto {
  /** Números que CRECIERON sobre su línea base. `--check` falla por éstos. */
  crecidas: Movimiento[];
  /** Números que bajaron: la línea base quedó con holgura y hay que apretarla. */
  holguras: Movimiento[];
}

export function comparar(
  censo: Censo,
  base: Readonly<Record<Clave, number>> = LINEAS_BASE
): Veredicto {
  const crecidas: Movimiento[] = [];
  const holguras: Movimiento[] = [];
  for (const clave of CLAVES) {
    const medido = censo.numeros[clave];
    const lineaBase = base[clave];
    if (medido > lineaBase) crecidas.push({ clave, medido, lineaBase });
    else if (medido < lineaBase) holguras.push({ clave, medido, lineaBase });
  }
  return { crecidas, holguras };
}

/**
 * Reescribe en el fuente las líneas base que quedaron con holgura. NUNCA sube
 * ninguna: si un número creció, esta función no lo toca y quien llama tiene
 * que negarse.
 *
 * Existe porque el trinquete tiene que ser APRETABLE en un repositorio donde
 * varias manos editan la superficie a la vez. Sin esto, el día que alguien
 * añade ejemplos a nueve hojas —que es exactamente el trabajo que este censo
 * pide— la prueba se pone roja y el arreglo es teclear un número a mano en
 * este archivo. El precedente es `scripts/catalogo-estado.ts`, que regenera su
 * propio bloque en el documento por la misma razón.
 *
 * Lo que NO cambia: subir una línea base sigue siendo un acto manual que queda
 * en el diff. Bajarla también queda en el diff; sólo deja de teclearse.
 */
export function apretar(
  fuente: string,
  censo: Censo,
  base: Readonly<Record<Clave, number>> = LINEAS_BASE
): { texto: string; apretadas: Movimiento[] } {
  let texto = fuente;
  const apretadas: Movimiento[] = [];
  for (const clave of CLAVES) {
    const medido = censo.numeros[clave];
    const lineaBase = base[clave];
    if (medido >= lineaBase) continue;
    const re = new RegExp(`(^\\s*'${clave}':\\s*)\\d+(,)`, 'm');
    if (!re.test(texto)) {
      throw new Error(`no encuentro la línea base de "${clave}" en el fuente: apriétala a mano.`);
    }
    texto = texto.replace(re, `$1${medido}$2`);
    apretadas.push({ clave, medido, lineaBase });
  }
  return { texto, apretadas };
}

// ============================================================
// SALIDA
// ============================================================

/**
 * Contrato de máquina. No cambia por presentación, y es LO ÚNICO que sale por
 * stdout cuando se pide `--json`: todo lo demás va a stderr (ver `Efectos`).
 *
 * `ok` responde exactamente a la pregunta que hace `--check`, y por eso mira
 * también las excepciones muertas: si dijera sólo `crecidas.length === 0`,
 * habría salidas con `ok: true` y código 1.
 */
export function comoJson(censo: Censo, veredicto: Veredicto): string {
  return (
    JSON.stringify(
      {
        esquema: 1,
        hojas: censo.hojas,
        nodos: censo.nodos,
        medidas: CLAVES.map((clave) => ({
          clave,
          titulo: TITULOS[clave],
          medido: censo.numeros[clave],
          lineaBase: LINEAS_BASE[clave],
          delta: censo.numeros[clave] - LINEAS_BASE[clave],
          casos: censo.casos[clave],
        })),
        crecidas: veredicto.crecidas,
        holguras: veredicto.holguras,
        excepcionesMuertas: censo.excepcionesMuertas,
        ok: veredicto.crecidas.length === 0 && censo.excepcionesMuertas.length === 0,
      },
      null,
      2
    ) + '\n'
  );
}

function comoTabla(censo: Censo, veredicto: Veredicto): string {
  const filas = CLAVES.map((clave) => {
    const medido = censo.numeros[clave];
    const base = LINEAS_BASE[clave];
    const senal =
      medido > base ? 'CRECIO (+' + (medido - base) + ')' : medido < base ? 'aprieta la linea base' : 'igual';
    return { clave, medido: String(medido), base: String(base), senal, titulo: TITULOS[clave] };
  });
  const anchoClave = Math.max(...filas.map((f) => f.clave.length));
  const anchoMedido = Math.max(3, ...filas.map((f) => f.medido.length));
  const anchoBase = Math.max(4, ...filas.map((f) => f.base.length));

  const lineas: string[] = [];
  lineas.push(`Censo de superficie — ${censo.hojas} hojas, ${censo.nodos} nodos del program real.`);
  lineas.push('');
  lineas.push(
    `${'medida'.padEnd(anchoClave)}  ${'hoy'.padStart(anchoMedido)}  ${'base'.padStart(anchoBase)}  estado`
  );
  lineas.push(
    `${'-'.repeat(anchoClave)}  ${'-'.repeat(anchoMedido)}  ${'-'.repeat(anchoBase)}  ------`
  );
  for (const f of filas) {
    lineas.push(
      `${f.clave.padEnd(anchoClave)}  ${f.medido.padStart(anchoMedido)}  ${f.base.padStart(anchoBase)}  ${f.senal}`
    );
  }
  lineas.push('');
  for (const f of filas) lineas.push(`  ${f.clave}: ${f.titulo}`);

  if (veredicto.crecidas.length > 0) {
    lineas.push('');
    lineas.push('CRECIERON. La línea base sólo puede encoger:');
    for (const c of veredicto.crecidas) {
      lineas.push(`  ${c.clave}: ${c.lineaBase} -> ${c.medido}`);
      for (const caso of censo.casos[c.clave].slice(0, 10)) {
        lineas.push(`      ${caso.sujeto} — ${caso.motivo}`);
      }
      const resto = censo.casos[c.clave].length - 10;
      if (resto > 0) lineas.push(`      …y ${resto} más (usa --json para verlos todos)`);
    }
  }
  if (veredicto.holguras.length > 0) {
    lineas.push('');
    lineas.push(
      'Bajaron. Aprieta el trinquete con `npm run ux:status -- --apretar`, o la deuda deja de estar registrada:'
    );
    for (const h of veredicto.holguras) lineas.push(`  ${h.clave}: ${h.lineaBase} -> ${h.medido}`);
  }
  if (censo.excepcionesMuertas.length > 0) {
    lineas.push('');
    lineas.push('Excepciones de SALIDA_NO_TABULAR que ya no tapan nada. Bórralas:');
    for (const r of censo.excepcionesMuertas) lineas.push(`  ${r}`);
  }
  return lineas.join('\n') + '\n';
}

const ESTE_ARCHIVO = path.join(__dirname, 'ux-status.ts');

/**
 * LOS CUATRO EFECTOS DE `main`, POR PARÁMETRO.
 *
 * Entran por parámetro por dos razones, y la segunda es la que importa. La
 * primera es corriente: así una prueba ejerce `main` de verdad —incluido
 * `--apretar`— sin reescribir este archivo.
 *
 * La segunda es el contrato de máquina. `fuera` es stdout y ahí va SÓLO el
 * resultado: la tabla, o el JSON. Todo lo que es para una persona —la queja
 * del trinquete, el parte de lo apretado— va por `error`, que es stderr.
 * Hasta hoy no era así: `--json --apretar` imprimía el JSON y a continuación,
 * en el MISMO stdout, «Apretadas N línea(s) base:…». `JSON.parse` de esa
 * salida revienta con «Unexpected non-whitespace character after JSON at
 * position 16025», y estaba enmascarado sólo porque había una medida crecida
 * y `main` devolvía 1 antes de llegar. El día que se cerrara esa subida —hoy—
 * cualquiera que leyera el censo desde un guion se habría encontrado el JSON
 * roto sin haber tocado nada.
 */
export interface Efectos {
  /** stdout: el contrato de máquina, y nada más. */
  fuera(texto: string): void;
  /** stderr: todo lo que es para una persona. */
  error(texto: string): void;
  /** El fuente de este archivo, para `--apretar`. */
  leer(): string;
  /** Reescribe este archivo con las líneas base apretadas. */
  escribir(texto: string): void;
}

const EFECTOS_REALES: Efectos = {
  fuera: (texto) => void process.stdout.write(texto),
  error: (texto) => void process.stderr.write(texto),
  leer: () => fs.readFileSync(ESTE_ARCHIVO, 'utf-8'),
  escribir: (texto) => fs.writeFileSync(ESTE_ARCHIVO, texto),
};

export function main(argv: readonly string[], efectos: Efectos = EFECTOS_REALES): number {
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const apretarlo = argv.includes('--apretar');
  const censo = censar(program);
  const veredicto = comparar(censo);

  efectos.fuera(json ? comoJson(censo, veredicto) : comoTabla(censo, veredicto));

  let falla = false;

  if (veredicto.crecidas.length > 0 && (check || apretarlo)) {
    efectos.error(
      `\n${veredicto.crecidas.length} medida(s) de superficie crecieron sobre su línea base.\n` +
        'Arregla la hoja. Si el crecimiento es deliberado, sube la línea base A MANO en\n' +
        'scripts/ux-status.ts y dilo en el commit: `--apretar` nunca sube una línea base,\n' +
        'porque entonces el trinquete dejaría de serlo.\n'
    );
    falla = true;
  }

  if (censo.excepcionesMuertas.length > 0 && (check || apretarlo)) {
    efectos.error(
      `\n${censo.excepcionesMuertas.length} excepción(es) de SALIDA_NO_TABULAR ya no tapan nada:\n` +
        censo.excepcionesMuertas.map((r) => `  ${r}\n`).join('') +
        'Bórralas de scripts/ux-status.ts. La lista sólo puede encoger: una excepción que\n' +
        'deja de hacer falta y se queda escrita es un permiso permanente.\n'
    );
    falla = true;
  }

  if (falla) return 1;

  if (apretarlo) {
    const { texto, apretadas } = apretar(efectos.leer(), censo);
    if (apretadas.length === 0) {
      efectos.error('\nNo hay holgura que apretar.\n');
      return 0;
    }
    efectos.escribir(texto);
    efectos.error(
      `\nApretadas ${apretadas.length} línea(s) base:\n` +
        apretadas.map((a) => `  ${a.clave}: ${a.lineaBase} -> ${a.medido}`).join('\n') +
        '\n'
    );
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
