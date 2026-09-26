// ============================================================
// THE BOARD'S SHARED HELPERS
//
// Types, the read seam and the source helpers every criterion uses. They
// lived at the top of `src/plan/criterios.ts`, which is now the index that
// concatenates the board (#294); this file is that block MOVED, not
// rewritten. Only `RAIZ` climbs one more level, two import paths gain a
// `../`, and a handful of names are exported because the criteria use them.
//
// There is ONE seam: every criterion file imports `leer`, `crudoDe`,
// `codigoDe` and `sinComentarios` from here, so a single module instance
// holds the single overlay the mutation harness writes to.
// ============================================================
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  headOf,
  problemsIn,
  type VocabularyClass,
  type VocabularyEntry,
} from '../../language/vocabulary-registry.js';

export type Estado = 'ok' | 'falla' | 'no-evaluable';

export interface Resultado {
  estado: Estado;
  /** Lo observado. Es lo que se imprime cuando falla, así que debe bastar para actuar. */
  detalle: string;
}

/**
 * Un mutante declarado: el cambio de fuente que este criterio EXISTE para
 * acusar. tests/plan/mutacion.spec.ts lo aplica sobre el seam de lectura
 * (jamás sobre el árbol real) y exige `falla` — el espejo que §7 prometía,
 * convertido de disciplina manual en prueba que corre en cada CI (S2).
 */
export interface Mutante {
  /** Ruta relativa a la raíz del archivo a mutar. */
  archivo: string;
  /** Literal a reemplazar (la primera aparición). Debe existir: un ancla ausente es un espejo roto. */
  de: string;
  /**
   * El reemplazo, o `null` para que el archivo DESAPAREZCA. La segunda forma
   * existe porque hay criterios cuyo modo de fallo no es que un texto cambie
   * sino que un archivo se borre —el registro de una auditoría, una
   * migración— y un espejo que no puede expresar el fallo que vigila no es
   * un espejo.
   */
  a: string | null;
  /** Qué clase de escape encarna (la familia de lecciones: sufijo, conteo, firma-como-llamada…). */
  porque: string;
}

/**
 * DE QUÉ HABLA UN CRITERIO (S4a).
 *
 * `lectura` mide el TEXTO del repositorio; `conducta` mide lo que el programa
 * HACE. No son grados de la misma cosa y presentarlos igual fue el error: un
 * verde de lectura dice «la línea que buscaba está escrita», y esa frase es
 * compatible con que el sistema entregue el número contrario. Tres veces esta
 * semana lo fue.
 *
 * El tablero cuenta las dos poblaciones por separado porque esa proporción —y
 * no el total de verdes— es lo que mide el avance de este tramo.
 */
export type Clase = 'lectura' | 'conducta';

export interface Criterio {
  paquete: string;
  /**
   * IDENTIDAD DE MÁQUINA, y por eso en inglés y estable.
   *
   * Hasta I0 la identidad de un criterio era su ENUNCIADO EN ESPAÑOL: el piso
   * (docs/criterios-minimos.json) guardaba esa prosa como llave de un
   * trinquete que sólo sube, y una prueba de ataque buscaba un criterio por su
   * texto literal. Con eso, reescribir una frase —o traducirla, que es lo que
   * el epic #141 va a hacer con todo el código— ponía el piso en rojo y
   * desanclaba el ataque sin que nadie hubiera tocado un instrumento.
   *
   * El id nombra LO QUE EL CRITERIO MIDE, no cómo está redactado hoy: la
   * prueba de un buen id es que sobreviva a una reescritura del enunciado. Es
   * opcional en el tipo para que un criterio nuevo no se caiga al compilar,
   * pero hay una prueba que exige que los ids sean únicos y otra que vigila
   * que el piso se apoye en ellos.
   */
  id?: string;
  /** Qué se afirma, en términos de comportamiento observable. */
  enunciado: string;
  /**
   * Precondición que el runner comprueba antes de evaluar.
   *
   * `base-efimera` es más exigente que `base-de-datos`: no basta con que haya
   * una base a la que preguntar, hace falta un rol que pueda CREAR una
   * desechable. Se distingue porque el motivo que el tablero imprime cuando no
   * se puede evaluar es distinto, y quien lo lee tiene que poder arreglarlo.
   */
  necesita?: 'base-de-datos' | 'red' | 'base-efimera';
  evaluar: () => Promise<Resultado> | Resultado;
  /** Por omisión `lectura`: es lo que era todo antes de S4a. */
  clase?: Clase;
  /**
   * Espejos: mutaciones que DEBEN poner este criterio en rojo. Se aplican
   * sobre el SEAM DE LECTURA (conFuenteMutada), en memoria, y por eso valen
   * sólo para criterios de `lectura`. La línea base de criterios sin espejo
   * sólo encoge (meta-criterio en E0.0).
   */
  mutantes?: Mutante[];
  /**
   * Espejos de un criterio de CONDUCTA, aplicados sobre el archivo REAL.
   *
   * Campo aparte y no una bandera dentro de `mutantes`, porque el arnés es
   * otro: un criterio de conducta no puede mutarse en memoria —lo que corre no
   * es lo que el criterio lee—, así que estos se escriben en disco y se
   * re-corren en un proceso nuevo. Los aplica
   * tests/integration/plan-conducta-mutacion.int.spec.ts, que corre en serie y
   * restaura en un `finally`. Mezclarlos habría hecho que el arnés en memoria
   * intentara evaluarlos sin base y los diera por muertos sin haberlos matado.
   */
  mutantesEnDisco?: Mutante[];
}

/** Un criterio sin `clase` es de lectura: era lo único que había antes de S4a. */
export const claseDe = (c: Criterio): Clase => c.clase ?? 'lectura';

/**
 * ¿Tiene espejo, del arnés que sea?
 *
 * Existe para que la línea base de «criterios sin espejo» no cuente como deuda
 * a un criterio de conducta que SÍ trae los suyos, sólo que en el otro campo.
 * Un trinquete que se dispara por dónde está escrito el espejo, y no por si
 * existe, mide la forma en vez del hecho.
 */
export const tieneEspejo = (c: Criterio): boolean =>
  (c.mutantes?.length ?? 0) > 0 || (c.mutantesEnDisco?.length ?? 0) > 0;

// ── Ayudas ──────────────────────────────────────────────────

export const RAIZ = path.resolve(__dirname, '..', '..', '..');

export function rutaDe(...p: string[]): string {
  return path.join(RAIZ, ...p);
}

/**
 * EL SEAM DE LECTURA (S2). Toda lectura de fuente que hacen los criterios
 * pasa por aquí, para que tests/plan/mutacion.spec.ts pueda aplicar un
 * mutante EN MEMORIA — sin tocar el árbol real jamás — y exigir el rojo.
 * Fuera de esa prueba, el overlay es null y leer() es fs.readFileSync.
 */
let sobreescrituras: Map<string, string | null> | null = null;

/**
 * SOLO PRUEBAS: corre fn con los archivos del overlay sustituidos en memoria.
 * Un valor `null` finge que el archivo NO EXISTE.
 */
export async function conFuenteMutada<T>(
  overlay: Record<string, string | null>,
  fn: () => Promise<T> | T
): Promise<T> {
  sobreescrituras = new Map(Object.entries(overlay));
  try {
    return await fn();
  } finally {
    sobreescrituras = null;
  }
}

export function leer(abs: string): string {
  if (sobreescrituras) {
    const rel = path.relative(RAIZ, abs);
    if (sobreescrituras.has(rel)) {
      const o = sobreescrituras.get(rel);
      if (o === null) throw new Error(`ENOENT (mutante): ${rel}`);
      return o as string;
    }
  }
  return fs.readFileSync(abs, 'utf-8');
}

/** El contenido crudo (con comentarios) de un archivo, por el seam. */
export function crudoDe(...p: string[]): string {
  return leer(rutaDe(...p));
}

/**
 * El SQL sin sus comentarios de línea.
 *
 * Un criterio que pregunta QUÉ HACE un archivo .sql tiene que leer el SQL, no
 * la prosa que lo rodea. Dos veces en el mismo tramo un comentario que CITABA
 * el ancla dejó su criterio verde: el que prohibía `CREATE OR REPLACE TRIGGER`
 * se disparó contra el comentario que explica por qué está prohibido, y el que
 * exigía el cambio de rol lo encontró en una tabla de mediciones comentada. Es
 * la misma familia que la lección `_f05d` del piso: un ancla de presencia
 * caduca en cuanto alguien escribe cerca.
 *
 * Sólo se quitan los comentarios que ABREN la línea: un `--` a media línea
 * puede vivir dentro de un literal.
 */
export function sinProsa(sql: string): string {
  return sql.replace(/^[ \t]*--.*$/gm, '');
}

export function existe(rel: string): boolean {
  // El overlay también gobierna la EXISTENCIA: así un espejo puede fingir
  // que un registro de auditoría o una migración desaparecieron.
  if (sobreescrituras?.get(rel) === null) return false;
  return fs.existsSync(rutaDe(rel));
}

/**
 * ¿CORRE ESTE PASO DE CI, O SÓLO ESTÁ ESCRITO?
 *
 * El modo de fallo natural de un paso de CI es que alguien lo COMENTE, y
 * `# - run: npx tsx scripts/x.ts --check` contiene la cadena entera: un criterio
 * anclado por subcadena bendice al mutante que lo apaga. Pasó de verdad dos
 * veces —`ux-surface-census-ci-ratchet` casó su propio comentario en su primer
 * intento, y la compuerta del corpus vivió así hasta T2—, así que la plantilla
 * se escribe UNA vez aquí en vez de recordarla en cada sitio.
 *
 * Ancla la línea COMPLETA: `^` más la sangría admitida cierra por la izquierda
 * (un `#` delante ya no casa) y `$` cierra por la derecha (no vale como prefijo
 * de otro comando más largo). El `comando` llega como texto literal y se escapa,
 * porque un punto sin escapar en `scripts/x.ts` casaría cualquier carácter.
 *
 * `cola` es para el único paso cuya línea CAMBIA con causa: la lista de
 * `--exigir` crece al cerrar un paquete y encoge al reabrirlo. Anclarla entera
 * pondría el tablero en rojo por un acto legítimo, así que se admite una cola
 * ACOTADA en vez de dejar el ancla abierta por la derecha.
 */
export function stepRuns(yaml: string, command: string, tail = ''): boolean {
  const literal = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*- run: ${literal}${tail}[ \\t]*$`, 'm').test(yaml);
}

/**
 * El bloque de un job dentro de ci.yml, de su encabezado al del siguiente.
 *
 * Se corta por el encabezado y no por sangría porque entre dos jobs viven los
 * comentarios que explican al siguiente, también a dos espacios: un corte por
 * «la primera línea con menos sangría» se los llevaría al bloque anterior y un
 * `continue-on-error` citado en prosa contaría como declarado.
 */
export function ciJob(yaml: string, job: string): string | null {
  const start = yaml.search(new RegExp(`^  ${job}:[ \\t]*$`, 'm'));
  if (start < 0) return null;
  const rest = yaml.slice(start + 1);
  const end = rest.search(/^ {2}[a-z][a-z0-9_-]*:[ \t]*$/m);
  return end < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + end);
}

/**
 * Todos los .ts bajo un directorio, sin node_modules ni dist.
 *
 * `src/plan` queda fuera, y no es una comodidad: este archivo CITA los patrones
 * que persigue. Su primera corrida se acusó a sí misma —el criterio que busca
 * «TODO junto a un acto externo» encontró el literal de su propia expresión
 * regular— y una herramienta que se delata en su estreno no se lee dos veces.
 * El precio es explícito: src/plan es el instrumento de medida, no se mide.
 */
export function fuentes(rel = 'src'): string[] {
  const out: string[] = [];
  const raiz = rutaDe(rel);
  if (!fs.existsSync(raiz)) return out;
  const caminar = (dir: string): void => {
    if (path.relative(RAIZ, dir) === path.join('src', 'plan')) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) caminar(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  caminar(raiz);
  return out;
}

/**
 * Quita comentarios de línea y de bloque.
 *
 * Existe porque un criterio afirmó que dos políticas SÍ se consumían, y su
 * única evidencia era la frase «'umbral_capitalizacion_mxn' policy (see
 * mnemosine pending)» dentro de un comentario. Una mención en prosa no ejecuta
 * nada. Aproximación deliberada: no distingue un `//` dentro de una cadena, lo
 * que puede recortar de más — un criterio que se calla de más falla hacia el
 * rojo, que es el lado seguro.
 */
/**
 * El limpiador vive ahora en `src/utils/strip-comments.ts`, para que el
 * detector de código muerto use EXACTAMENTE éste y no su propia copia. Se
 * conserva el nombre local: 20 sitios de este archivo lo llaman.
 */
import { stripComments as sinComentarios } from '../../utils/strip-comments.js';
export { sinComentarios };

/**
 * Archivos (relativos a la raíz) donde aparece el patrón.
 * Con `soloCodigo`, ignora lo que sólo aparece en comentarios.
 */
export function dondeAparece(
  patron: RegExp,
  dirs: string[] = ['src'],
  soloCodigo = false
): string[] {
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const f of fuentes(dir)) {
      const bruto = leer(f);
      const texto = soloCodigo ? sinComentarios(bruto) : bruto;
      patron.lastIndex = 0;
      if (patron.test(texto)) hits.push(path.relative(RAIZ, f));
    }
  }
  return hits;
}

/** Cuántas veces aparece el patrón en total. */
export function apariciones(patron: RegExp, dirs: string[] = ['src']): number {
  let n = 0;
  for (const dir of dirs) {
    for (const f of fuentes(dir)) {
      const m = leer(f).match(patron);
      n += m ? m.length : 0;
    }
  }
  return n;
}

/**
 * Consumidores de un símbolo exportado: archivos que lo mencionan y que NO son
 * el que lo define ni una prueba. Es la forma de detectar capacidad huérfana —
 * código que existe, typechecka y no llama nadie.
 */
export function consumidoresDe(simbolo: string, definidoEn: string): string[] {
  const patron = new RegExp(`\\b${simbolo}\\b`);
  return dondeAparece(patron, ['src'], true).filter((f) => !f.endsWith(definidoEn));
}

/**
 * El código de un archivo, sin sus comentarios.
 *
 * Casi todo criterio afirma COMPORTAMIENTO, y para eso el comentario es ruido
 * que miente en las dos direcciones. Pasó en las dos: un comentario que citaba
 * una política dio un ✅ falso, y otro que narraba el código YA BORRADO
 * («la implementación entera era un UPDATE a status = 'balanced'») dio un ✘
 * falso contra un endpoint que hoy se niega a mentir. Leer prosa como si fuera
 * conducta es el error que este archivo existe para no cometer.
 */
export function codigoDe(...p: string[]): string {
  return sinComentarios(leer(rutaDe(...p)));
}

/**
 * PREGUNTARLE A LA BASE, no al fuente (S3).
 *
 * Los dos criterios que vigilaban la purga de la 040 y la siembra de la 043
 * leían el `.sql` y daban verde por que el DML estuviera ESCRITO. Ninguno
 * podía distinguir «la migración corrió» de «la migración no tocó nada» — y
 * no tocó nada: bajo FORCE ROW LEVEL SECURITY el migrador afectaba cero
 * filas en silencio. Un criterio que no distingue esas dos cosas informa de
 * su propio texto.
 *
 * Se comparte el cliente por llamada y se cierra siempre: estos criterios
 * corren dentro de `plan:status`, que no tiene el pool de la aplicación.
 */
async function conBase<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T | null> {
  const url =
    process.env.DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? process.env.BACKUP_DATABASE_URL;
  if (!url) return null;
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    return null;
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** ¿Queda alguna atestación con el importe y el factor de apertura dentro? */
export async function sinResiduoDelSecreto(): Promise<Resultado> {
  const r = await conBase(async (c) => {
    const q = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM blockchain_attestations
        WHERE (range_proof IS NOT NULL
               AND position('\\x5f746573745f76616c7565'::bytea in range_proof) > 0)
           OR (zkverify_proof IS NOT NULL
               AND position('\\x5f746573745f76616c7565'::bytea in zkverify_proof) > 0)`
    );
    return Number(q.rows[0]?.n ?? 0);
  });
  if (r === null) {
    return noEvaluable('sin base accesible: la purga sólo se puede comprobar contra los datos');
  }
  return r === 0
    ? ok('el generador no escribe el valor, la 040 purga ambos blobs y NO QUEDA una sola fila con el secreto')
    : falla(
        `${r} atestación(es) siguen llevando el importe y el factor de apertura dentro del compromiso: ` +
          'la purga está escrita y no surtió efecto (la clase que la 049 repara).'
      );
}

/** ¿La siembra de contadores anuales llegó a escribir algo donde hay folios? */
export async function contadoresAnualesSembrados(): Promise<Resultado> {
  const r = await conBase(async (c) => {
    const q = await c.query<{ con_folios: string; con_contador: string }>(
      `WITH emisoras AS (
         SELECT DISTINCT entity_id FROM journal_entries
       ), sembradas AS (
         SELECT DISTINCT entity_id FROM entity_sequences WHERE name ~ '_[0-9]{4}$'
       )
       SELECT (SELECT count(*)::text FROM emisoras)  AS con_folios,
              (SELECT count(*)::text FROM emisoras e
                WHERE EXISTS (SELECT 1 FROM sembradas s WHERE s.entity_id = e.entity_id)) AS con_contador`
    );
    return {
      conFolios: Number(q.rows[0]?.con_folios ?? 0),
      conContador: Number(q.rows[0]?.con_contador ?? 0),
    };
  });
  if (r === null) {
    return noEvaluable('sin base accesible: la siembra sólo se puede comprobar contra los datos');
  }
  if (r.conFolios === 0) {
    return ok('la llave anual está escrita; no hay entidades con folios emitidos que sembrar todavía');
  }
  return r.conContador === r.conFolios
    ? ok(
        `la llave anual está escrita y las ${r.conFolios} entidad(es) con folios emitidos tienen su contador sembrado`
      )
    : falla(
        `${r.conFolios - r.conContador} de ${r.conFolios} entidad(es) con folios emitidos NO tienen contador anual: ` +
          'la serie del ejercicio arrancaría en 1 y chocaría con lo ya emitido (la colisión que este defecto ya provocó).'
      );
}

/**
 * El trozo de un documento que va de un encabezado al siguiente, o `null` si
 * el encabezado ya no está.
 *
 * Existe por la lección de las anclas que no acotan: preguntar «¿dice "En
 * español"?» sobre un archivo ENTERO mide la oración equivocada en cuanto
 * alguien escribe esas dos palabras en cualquier otro párrafo — y CONTRIBUTING
 * las escribe, legítimamente, hablando de la línea base por archivo. Un
 * criterio que afirma algo de una sección tiene que leer esa sección.
 *
 * El segundo argumento es qué cuenta como «el siguiente encabezado», porque un
 * job de YAML termina donde empieza otra clave en columna dos y un apartado de
 * Markdown donde empieza otro `##`.
 */
export function sectionOf(text: string, heading: string, until = /^## /m): string | null {
  const from = text.indexOf(heading);
  if (from === -1) return null;
  const rest = text.slice(from + heading.length);
  const next = until.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

export const ok = (detalle: string): Resultado => ({ estado: 'ok', detalle });
export const falla = (detalle: string): Resultado => ({ estado: 'falla', detalle });
export const noEvaluable = (detalle: string): Resultado => ({ estado: 'no-evaluable', detalle });

// ── El trinquete de cobertura, leído como NÚMEROS (S4a) ─────
//
// EL DEFECTO QUE ESTO REPARA. El criterio «la cobertura del motor contable
// tiene trinquete por archivo» contaba llaves:
//
//     const archivos = (c.match(/'src\/[^']+\.ts':/g) ?? []).length;
//     return archivos >= 3 ? ok(...) : falla(...);
//
// Con esa vara, poner los tres umbrales EN CERO lo dejaba en verde: las tres
// llaves seguían ahí. Y bajar un umbral es exactamente el movimiento que un
// trinquete de cobertura existe para impedir — no hay otro. Un criterio que
// cuenta entradas mide la FORMA del archivo de configuración, no lo que ese
// archivo exige; es la misma familia de escape que el conteo de llaves de
// AUD-6 y que el criterio de maker-checker que anclaba en UNA puerta.
//
// QUÉ ES «BAJAR», Y POR QUÉ NO ES UN MÍNIMO ABSOLUTO. Se consideró exigir que
// todo umbral fuera >= N. No sirve, y el propio vitest.config.ts explica por
// qué: sus umbrales conviven entre 66 (sequence.ts, deuda declarada) y 100
// (criterio-cierre.ts). Cualquier N que deje pasar el 66 legítimo deja caer
// posting.ts de 99 a 67 sin decir nada, y cualquier N que proteja el 99 pone
// en rojo una deuda que se declaró a propósito. Un solo número no puede
// distinguir «esto siempre fue bajo» de «esto acaba de bajar».
//
// Lo que sí distingue las dos cosas es un SUELO POR ARCHIVO Y POR MÉTRICA,
// congelado en lo que la configuración declara hoy: la misma forma de
// trinquete que el repositorio ya usa en docs/catalogo-minimos.json y en
// SIN_ESPEJO_MAXIMO. Sólo sube, y sube en el mismo commit que gana el terreno.
//
// LO QUE UN SUELO ASÍ NO COMPRA, dicho antes de que alguien lo descubra: nada
// impide bajar el umbral Y el suelo en el mismo commit. Ningún trinquete de
// esta casa lo impide — tampoco el del catálogo ni el de los espejos. Lo que
// compra es que el descenso deje de ser INVISIBLE: hoy los tres ceros pasan
// sin que ninguna compuerta se mueva; con el suelo hay que escribir el número
// nuevo, con nombre, en un diff que alguien revisa.

export const METRICAS = ['statements', 'branches', 'functions', 'lines'] as const;
type Metrica = (typeof METRICAS)[number];
export type Umbrales = Record<Metrica, number>;

/**
 * Los umbrales por archivo que un vitest.config declara, como NÚMEROS.
 *
 * Se lee sobre el código sin comentarios (`codigoDe`): los bloques de arriba
 * de vitest.config.ts citan cifras en prosa —«medidos hoy: 88.23 / 76.29…»— y
 * leer prosa como si fuera conducta es el error que este archivo existe para
 * no cometer.
 */
export function umbralesDeclarados(config: string): Map<string, Partial<Umbrales>> {
  const declarados = new Map<string, Partial<Umbrales>>();
  // Sólo casa `'src/…ts': { … }`: las entradas de `include` son `'src/…ts',`
  // sin llave detrás, así que un archivo medido no se confunde con uno con
  // umbral. Es justo la diferencia que el criterio viejo no hacía.
  for (const entrada of config.matchAll(/'(src\/[^']+\.ts)':\s*\{([^}]*)\}/g)) {
    const valores: Partial<Umbrales> = {};
    for (const metrica of METRICAS) {
      const m = new RegExp(`\\b${metrica}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(entrada[2]);
      if (m) valores[metrica] = Number(m[1]);
    }
    declarados.set(entrada[1], valores);
  }
  return declarados;
}

/**
 * Los globs de `coverage.include`, que dicen QUÉ se mide.
 *
 * Se corta desde `coverage:` a propósito: `test.include` aparece ANTES en los
 * dos archivos y es la lista de pruebas, no la de fuentes medidas. Un regex
 * que casara la primera lista leería «tests/**» y bendeciría cualquier cosa.
 */
export function medidosPor(config: string): string[] {
  const desdeCobertura = config.slice(config.indexOf('coverage:'));
  const bloque = /include:\s*\[([^\]]*)\]/.exec(desdeCobertura);
  return [...(bloque?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const seMide = (globs: string[], archivo: string): boolean =>
  globs.some((g) => g === archivo || (g.endsWith('**') && archivo.startsWith(g.slice(0, -2))));

/**
 * El veredicto de un suelo contra lo que un vitest.config declara HOY.
 *
 * Tres direcciones, porque un trinquete que sólo mira una se vacía por las
 * otras dos —la lección del piso de criterios, aplicada a números—:
 *   1. un umbral por debajo del suelo → el descenso, que es el caso central;
 *   2. un archivo del suelo que perdió su entrada → el trinquete retirado por
 *      borrado en vez de por rebaja;
 *   3. un archivo del suelo que ya no se MIDE → un umbral sobre un archivo
 *      fuera de `include` no exige nada, y es la forma silenciosa de apagarlo.
 *
 * Y una cuarta sobre lo que el suelo todavía no cubre: un archivo nuevo con
 * una métrica en cero. Un umbral en cero es la ausencia de umbral escrita con
 * más letras, y nace protegido para que no haga falta un commit posterior.
 */
export function contraSuelo(config: string, suelo: Record<string, Umbrales>): string[] {
  const declarados = umbralesDeclarados(config);
  const globs = medidosPor(config);
  const problemas: string[] = [];

  for (const [archivo, piso] of Object.entries(suelo)) {
    const hoy = declarados.get(archivo);
    if (!hoy) {
      problemas.push(`${archivo} perdió su umbral por archivo (el suelo lo exige)`);
      continue;
    }
    if (!seMide(globs, archivo)) {
      problemas.push(
        `${archivo} tiene umbral pero coverage.include ya no lo alcanza: un umbral sobre un archivo que no se mide no exige nada`
      );
    }
    // Una línea por ARCHIVO, no por métrica: poner los cuatro umbrales de seis
    // archivos en cero produce veinticuatro quejas idénticas, y un detalle que
    // no se puede leer de un vistazo no sirve para actuar — que es lo único
    // para lo que existe el campo `detalle`.
    const bajaron = METRICAS.filter((m) => (hoy[m] ?? -1) < piso[m]).map((m) =>
      hoy[m] === undefined ? `${m} ya no se declara (suelo ${piso[m]})` : `${m} ${piso[m]}→${hoy[m]}`
    );
    if (bajaron.length > 0) {
      problemas.push(`${archivo}: el umbral bajó — ${bajaron.join(', ')}`);
    }
  }

  for (const [archivo, hoy] of declarados) {
    if (suelo[archivo]) continue;
    const flojas = METRICAS.filter((m) => (hoy[m] ?? 0) <= 0);
    if (flojas.length > 0) {
      problemas.push(
        `${archivo}: ${flojas.join(', ')} en cero o sin declarar — un umbral en cero es la ausencia de umbral escrita con más letras`
      );
    }
  }

  return problemas;
}

/**
 * SUELO DEL PROYECTO UNITARIO. Congelado en lo que vitest.config.ts declara
 * al escribirse este trinquete (2026-09-02). Sólo sube.
 */
export const SUELO_COBERTURA_UNITARIA: Record<string, Umbrales> = {
  'src/services/accounting/posting.ts': { statements: 99, branches: 95, functions: 100, lines: 99 },
  'src/services/accounting/validation.ts': { statements: 90, branches: 77, functions: 100, lines: 90 },
  'src/services/accounting/ar-ap-posting.ts': { statements: 99, branches: 89, functions: 100, lines: 99 },
  'src/utils/sequence.ts': { statements: 68, branches: 100, functions: 75, lines: 66 },
  'src/services/reporting/report-service.ts': { statements: 88, branches: 76, functions: 95, lines: 88 },
  'src/services/reporting/criterio-cierre.ts': { statements: 100, branches: 95, functions: 100, lines: 100 },
  // J0.1 · El conmutador de jurisdicción nace con su trinquete puesto, y en
  // 100 porque ahí lo dejó su tramo. Decide qué catálogo fiscal recibe una
  // entidad y qué filas entran en el censo que reclasifica IVA: un archivo
  // así no puede empezar a medirse el día que alguien se acuerde.
  'src/services/jurisdiction/jurisdiction.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  // T13. Nace protegido: un archivo nuevo sin renglón aquí puede perder su
  // umbral en un commit posterior sin que ninguna compuerta se mueva.
  'src/services/reporting/criterio-archivadas.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  // J0.2. La ley y su semilla nacen protegidas: un umbral que sólo vive en
  // vitest.config.ts se puede bajar sin que ninguna compuerta se mueva, y el
  // ataque 3e de s4a exige que toda entrada de `thresholds` esté también
  // aquí — lo cazó cuando faltaban estas dos.
  'src/services/jurisdiction/legal-parameters.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  'src/services/jurisdiction/legal-parameters-seed.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  // O1 · Las seis piezas por las que entra una contabilidad entera desde el
  // XML del SAT: los dos lectores, el importador del catálogo, el deductor de
  // tipo por agrupador, la carga de la apertura y su cotejo. Nacen con suelo
  // porque son las que deciden si un peso entra, con qué signo y bajo qué
  // padre; la cifra sale de la corrida completa, no del redondeo cómodo.
  'src/services/accounting/opening-balance.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  'src/services/accounting/opening-balance-check.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  'src/services/accounting/sat-chart-import.ts': { statements: 99, branches: 94, functions: 100, lines: 99 },
  'src/services/accounting/sat-agrupador-account-type.ts': { statements: 97, branches: 97, functions: 100, lines: 97 },
  'src/services/sat/anexo24/balance-reader.ts': { statements: 98, branches: 88, functions: 100, lines: 100 },
  'src/services/sat/anexo24/catalog-reader.ts': { statements: 98, branches: 81, functions: 100, lines: 100 },
  // La aritmética del devengo de prestaciones (D1) nace con el suelo arriba y no
  // puede bajar de ahí: es dinero por trabajador y por mes, se postea a un mayor
  // inmutable (041) y tiene que extinguirse al centavo contra el finiquito.
  'src/services/accruals/provisions-math.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
};

/**
 * SUELO DE LA SUITE DE INTEGRACIÓN. Nace en S4a con la primera medición real
 * de esa suite (984 pruebas contra Postgres, todas en verde): hasta hoy
 * vitest.integration.config.ts no declaraba cobertura, así que las pruebas que
 * de verdad ejercitan el dinero no contaban para ninguna medida.
 */
export const SUELO_COBERTURA_INTEGRACION: Record<string, Umbrales> = {
  'src/services/accounting/period-close.ts': { statements: 90, branches: 81, functions: 96, lines: 89 },
  'src/services/accounting/ledger-checks.ts': { statements: 90, branches: 86, functions: 75, lines: 92 },
  'src/services/accounting/posting.ts': { statements: 91, branches: 86, functions: 96, lines: 91 },
  'src/services/accounting/ar-ap-posting.ts': { statements: 87, branches: 75, functions: 96, lines: 91 },
  'src/services/accounting/validation.ts': { statements: 86, branches: 78, functions: 100, lines: 88 },
  // A6 · el conductor del cierre y su expediente, con el suelo donde lo dejó su suite.
  'src/services/accounting/closing-conductor.ts': { statements: 95, branches: 77, functions: 95, lines: 95 },
  'src/services/accounting/closing-pack.ts': { statements: 89, branches: 77, functions: 100, lines: 91 },
  'src/services/accounting/iva-cash-basis.ts': { statements: 96, branches: 84, functions: 100, lines: 98 },
  'src/services/reporting/report-service.ts': { statements: 84, branches: 75, functions: 77, lines: 86 },
  'src/services/reporting/criterio-cierre.ts': { statements: 91, branches: 80, functions: 85, lines: 91 },
  // T13 lo sube al medir el caso que faltaba: 95.12 / 90.10 / 96.55 / 95.45.
  'src/services/reporting/cash-flow-service.ts': { statements: 95, branches: 90, functions: 96, lines: 95 },
};

// ── El registro del vocabulario, leído por el mismo seam que todo lo demás ──
//
// SE LEE, NO SE IMPORTA, Y ESA ES LA DECISIÓN QUE HACE POSIBLE EL MUTANTE.
//
// `crudoDe` pasa por `leer()`, que honra el overlay de `sobreescrituras`: es
// lo que permite al arnés de mutación fingir que una fila del registro no
// está y comprobar que el criterio se pone rojo. Un `import` del módulo
// devolvería siempre el archivo de disco, el overlay no lo alcanzaría, y el
// mutante que la issue #146 exige moriría vivo — verde para siempre.
//
// De ese módulo se importa SÓLO `problemsIn`, que es lógica pura y no datos:
// así la validación no se duplica y la lectura sigue pasando por el seam.

interface LoadedRegistry {
  total: number;
  kept: number;
  problems: string[];
  has: (cls: VocabularyClass, where: string, es: string) => boolean;
}

export function readVocabularyRegistry(): LoadedRegistry | null {
  const rel = 'src/language/vocabulary-registry.json';
  if (!existe(rel)) return null;
  let entries: VocabularyEntry[];
  try {
    const doc = JSON.parse(crudoDe(rel)) as { entries?: VocabularyEntry[] };
    entries = Array.isArray(doc.entries) ? doc.entries : [];
  } catch {
    return { total: 0, kept: 0, problems: ['no es JSON válido'], has: () => false };
  }
  const problems = entries.flatMap((e, i) => problemsIn(e, i));
  const index = new Set(entries.map((e) => `${e.class}\u0000${headOf(e.where)}\u0000${e.es}`));
  return {
    total: entries.length,
    kept: entries.filter((e) => e.en === null).length,
    problems,
    has: (cls, where, es) => index.has(`${cls}\u0000${headOf(where)}\u0000${es}`),
  };
}

/**
 * El léxico de I1 tal como este archivo lo necesita: las raíces para decidir
 * español, los términos de dominio para exceptuar, y `known` —la unión de las
 * TRES listas— para que el corte por dígitos parta lo mismo que allá.
 */
interface Lexicon {
  roots: Set<string>;
  domain: Set<string>;
  known: Set<string>;
}

/**
 * El léxico de I1, leído de sus DATOS y no de su código.
 *
 * `scripts/language/lexicon.ts` no se puede importar desde aquí: `rootDir` es
 * `./src` y un import fuera de él no compila. Se lee el JSON, que es la misma
 * fuente que ese módulo carga.
 */
export function readLexicon(): Lexicon | null {
  const rel = 'scripts/language/lexicon.json';
  if (!existe(rel)) return null;
  try {
    const doc = JSON.parse(crudoDe(rel)) as {
      spanishRoots?: string[];
      // LAS OTRAS DOS LISTAS NO SON DECORADO: el corte por dígitos de
      // `tokenize` (#197) sólo parte lo que el léxico NO reconoce, y
      // «reconoce» son las TRES listas. Con sólo las raíces, `sha256` —neutro
      // curado— se partiría aquí y no allá, y las dos implementaciones
      // volverían a divergir justo en los acrónimos.
      neutralTokens?: string[];
      englishExtra?: string[];
      // OJO: es un MAPA término → razón escrita, no una lista. Lo que cuenta
      // son sus CLAVES, que es lo que `DOMAIN_TERMS.has(t)` consulta en
      // lexicon.ts. Leerlo como arreglo hacía explotar `new Set({})` y el
      // criterio salía «no evaluable» sin decir por qué — el catch se comía
      // el motivo.
      domainTerms?: Record<string, string>;
    };
    if (!Array.isArray(doc.spanishRoots)) return null;
    const domain = doc.domainTerms ?? {};
    return {
      roots: new Set(doc.spanishRoots),
      domain: new Set(Object.keys(domain)),
      known: new Set([
        ...doc.spanishRoots,
        ...(doc.neutralTokens ?? []),
        ...(doc.englishExtra ?? []),
      ]),
    };
  } catch {
    return null;
  }
}

/**
 * LA MISMA REGLA QUE `isFlagged`, aplicada aquí porque su módulo vive fuera
 * de `rootDir`. `isFlagged` es `classify(x) ∈ {es, mixed}`, y las dos clases
 * se producen exactamente cuando ALGÚN token es raíz española y no es término
 * de dominio: con eso `es` queda en verdadero, y el resto de tokens sólo
 * decide entre «es» y «mixed», que se señalan igual.
 *
 * Que las dos implementaciones coincidan NO SE SUPONE: lo prueba
 * tests/language/vocabulary-registry.spec.ts contra el `isFlagged` de verdad,
 * sobre las 200 declaraciones etiquetadas a mano y sobre todos los valores de
 * CHECK del esquema. Si alguien cambia el clasificador, esa prueba se pone
 * roja aquí antes de que este criterio empiece a mentir.
 */
export function tokenizeLikeLexicon(identifier: string, known: ReadonlySet<string>): string[] {
  return identifier
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+|\s+/u)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    .flatMap((t) => {
      if (!/\p{L}/u.test(t) || !/\p{N}/u.test(t) || known.has(t)) return [t];
      return t
        .replace(/(\p{L})(\p{N})/gu, '$1 $2')
        .replace(/(\p{N})(\p{L})/gu, '$1 $2')
        .split(' ')
        .filter((x) => x.length > 0);
    });
}

export function flagsAsSpanish(value: string, lexicon: Lexicon): boolean {
  return tokenizeLikeLexicon(value, lexicon.known).some(
    (t) => !lexicon.domain.has(t) && lexicon.roots.has(t)
  );
}

/**
 * Los vocabularios `CHECK (col IN (...))` de las migraciones, EN ORDEN: la
 * base se construye ejecutándolas así y dos columnas se redefinen más tarde.
 * Gana la última, igual que en Postgres.
 */
export function readSchemaVocabularies(): Map<string, string[]> {
  const literals = (s: string): string[] =>
    [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const dir = 'src/database/migrations';
  const out = new Map<string, string[]>();
  for (const f of fs.readdirSync(rutaDe(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = crudoDe(dir, f).replace(/--[^\n]*/g, '');
    const note = (table: string, column: string, list: string): void => {
      const values = literals(list);
      if (values.length) out.set(`${table.replace(/^public\./i, '')}.${column}`, values);
    };
    for (const t of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(([\s\S]*?)\n\);/gi)) {
      for (const c of t[2].matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi)) note(t[1], c[1], c[2]);
    }
    for (const a of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)[^;]*?ADD\s+(?:CONSTRAINT|COLUMN)[^;]*?CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi
    )) {
      note(a[1], a[2], a[3]);
    }
  }
  return out;
}

/**
 * Los valores de `AccountRole`. Se leen del FUENTE porque son una unión de
 * TypeScript: no existen en tiempo de ejecución y la base no los protege con
 * ningún CHECK — que es justo por lo que la issue los nombra aparte.
 */
export function readAccountRoleValues(): string[] {
  const rel = 'src/services/xml-ingestion/cfdi-taxonomy.ts';
  if (!existe(rel)) return [];
  const code = codigoDe(rel);
  const m = /export\s+type\s+AccountRole\s*=([\s\S]*?);/.exec(code);
  if (!m) return [];
  return [...new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))];
}

/**
 * RUTAS BAJO `src/` CON UN SEGMENTO ESPAÑOL DE LA JURISDICCIÓN, sin filtrar
 * por extensión.
 *
 * WIT-198-01. La primera versión usaba `fuentes('src')`, que enumera SÓLO
 * `.ts`. Una carpeta `src/**\/jurisdiccion/` que volviera con un `.sql`, un
 * `.json` o un `.md` dentro —y las migraciones y los catálogos sembrados son
 * exactamente eso— no la veía nadie, y el criterio seguía verde afirmando que
 * la carpeta está en cero. El enunciado promete la CARPETA, no los archivos
 * TypeScript de la carpeta.
 *
 * Se recorre el árbol y se mira el NOMBRE DEL DIRECTORIO, así que una carpeta
 * vacía de `.ts` cuenta igual. Se exporta para poder ejercitarla sobre un
 * árbol de mentira: un mutante no puede CREAR un archivo —el overlay sólo
 * sustituye o borra— así que la prueba de esta guarda tiene que ser una
 * prueba, no un espejo.
 */
export function spanishJurisdictionPaths(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (/^jurisdicci[oó]n$/i.test(e.name)) found.push(path.relative(root, full).split(path.sep).join('/'));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(path.join(root, 'src'));
  return found;
}

// ── Los criterios ───────────────────────────────────────────

// ============================================================
// EL ESCÁNER DE RUTAS QUE ESCRIBEN (TEN-11, #235).
//
// Parsea con el compilador de TypeScript y no con expresiones regulares, y no
// es un lujo: la trampa que dejó ciego a `route-entity-access-verified` —el
// nombre de la guarda buscado en los primeros 300 caracteres del bloque— se
// cumple con `requireEntityAccess` escrito DENTRO de una cadena. En un árbol
// sintáctico un literal de cadena y un identificador son nodos distintos, y la
// posición de un argumento es la posición de un argumento.
//
// Lee el texto por el seam (`leer`), así que los mutantes lo alcanzan.
// ============================================================

interface RouteFinding {
  route: string;
  issue: string;
}

/**
 * Rutas que actúan sobre tablas del INQUILINO, sin eje de entidad que
 * defender. Cada una nombra su tabla y el criterio COMPRUEBA contra las
 * migraciones que de verdad no tiene `entity_id` ni camino hasta una: meter
 * aquí una ruta de `pay_runs` —que llega a la entidad por periodo y calendario—
 * no la exime, la acusa. Es la exención de T9a con cerradura.
 */
const TENANT_TABLE_ROUTES: Record<string, string> = {
  'webhooks.ts DELETE /:id': 'webhook_subscriptions',
  'webhooks.ts POST /deliveries/:id/retry': 'webhook_deliveries',
  'integrations.ts PUT /:provider': 'integration_credentials',
  'integrations.ts POST /:provider/test': 'integration_credentials',
  'integrations.ts DELETE /:provider': 'integration_credentials',
};

export function scanWriteRoutes(): { reviewed: number; findings: RouteFinding[] } {
  const findings: RouteFinding[] = [];
  let reviewed = 0;
  const WRITE_VERBS = new Set(['post', 'put', 'patch', 'delete']);

  // Lo que las migraciones dicen de cada tabla, para cerrar la exención.
  const migrationsDir = 'src/database/migrations';
  const migrationsSql = fs
    .readdirSync(rutaDe(migrationsDir))
    .map((m) => crudoDe(migrationsDir, m))
    .join('\n');
  const payrollPaths = existe('src/services/payroll/common/alcance-nomina.ts')
    ? crudoDe('src/services/payroll/common/alcance-nomina.ts')
    : '';
  const tableHasEntity = (table: string): boolean => {
    const createTable = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(migrationsSql);
    if (createTable && /\bentity_id\b/.test(createTable[1])) return true;
    if (new RegExp(`ALTER TABLE ${table}\\b[^;]*ADD COLUMN[^;]*\\bentity_id\\b`, 'i').test(migrationsSql)) return true;
    // Sin columna, pero con CAMINO: las tablas de nómina que llegan a la
    // entidad por otra tabla, escritas en alcance-nomina.ts.
    return new RegExp(`\\b${table}\\b`).test(payrollPaths);
  };

  // Routers montados ANTES de `authenticate`: no hay sesión, no hay entidad.
  const indexSource = existe('src/index.ts') ? crudoDe('src/index.ts') : '';
  const authPos = indexSource.search(/app\.use\(\s*apiPrefix\s*,\s*authenticate\s*\)/);
  const mountedBeforeAuth = new Set<string>();
  if (authPos >= 0) {
    for (const m of indexSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/api\/rest\/routes\/([\w-]+)\.js'/g)) {
      const mountUse = indexSource.search(new RegExp(`app\\.use\\([^)]*\\b${m[1]}\\s*\\)`));
      if (mountUse >= 0 && mountUse < authPos) mountedBeforeAuth.add(`${m[2]}.ts`);
    }
  }

  function* walk(n: ts.Node): Generator<ts.Node> {
    yield n;
    for (const h of n.getChildren()) yield* walk(h);
  }
  const isReqEntityId = (n: ts.Node): boolean =>
    ts.isPropertyAccessExpression(n) && n.name.text === 'entityId' &&
    ts.isIdentifier(n.expression) && n.expression.text === 'req';
  const containsReqEntityId = (n: ts.Node): boolean => {
    for (const x of walk(n)) if (isReqEntityId(x)) return true;
    return false;
  };

  for (const abs of fuentes('src/api/rest/routes')) {
    const file = path.basename(abs);
    const sf = ts.createSourceFile(file, leer(abs), ts.ScriptTarget.Latest, true);

    const imported = new Set<string>();
    const localFunctions = new Map<string, ts.Node>();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) &&
          /\/(services|database)\//.test(st.moduleSpecifier.text)) {
        const nb = st.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imported.add(e.name.text);
        if (st.importClause?.name) imported.add(st.importClause.name.text);
      }
      if (ts.isFunctionDeclaration(st) && st.name) localFunctions.set(st.name.text, st);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer &&
              (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            localFunctions.set(d.name.text, d.initializer);
          }
        }
      }
    }
    const localUsesEntity = (routeName: string): boolean => {
      const f = localFunctions.get(routeName);
      return f !== undefined && containsReqEntityId(f);
    };

    for (const n of walk(sf)) {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) continue;
      const receiver = n.expression.expression;
      const verb = n.expression.name.text;
      if (!ts.isIdentifier(receiver) || receiver.text !== 'router') continue;
      // Una forma que el escáner no sabe leer NO se salta: se acusa.
      if (verb === 'route' || verb === 'all') {
        findings.push({ route: `${file} router.${verb}(`, issue: 'forma de ruta que este criterio no analiza' });
        continue;
      }
      if (!WRITE_VERBS.has(verb)) continue;
      const routeArgs = n.arguments;
      const route = routeArgs[0] && ts.isStringLiteral(routeArgs[0]) ? routeArgs[0].text : '?';
      const routeName = `${file} ${verb.toUpperCase()} ${route}`;
      reviewed += 1;

      const last = routeArgs[routeArgs.length - 1];
      let handler: ts.Node | undefined = last;
      if (last && ts.isCallExpression(last)) handler = last.arguments[last.arguments.length - 1];
      if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        findings.push({ route: routeName, issue: 'manejador que este criterio no analiza' });
        continue;
      }
      const body = handler.body;

      // Exención 501 POR POSICIÓN: sólo si la PRIMERA sentencia lanza.
      if (ts.isBlock(body) && body.statements[0] && ts.isThrowStatement(body.statements[0]) &&
          body.statements[0].expression && ts.isNewExpression(body.statements[0].expression) &&
          body.statements[0].expression.expression.getText() === 'NotImplementedError') {
        continue;
      }

      // El disparador: la ruta nombra un recurso por id.
      const reads = new Set<string>();
      let bodyEntity: string | null = null;
      for (const x of walk(body)) {
        if (ts.isPropertyAccessExpression(x) && ts.isPropertyAccessExpression(x.expression) &&
            ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'req' &&
            x.expression.name.text === 'params') {
          reads.add(x.getText());
        }
        if (ts.isVariableDeclaration(x) && ts.isObjectBindingPattern(x.name) && x.initializer) {
          let source: ts.Node = x.initializer;
          while (ts.isAsExpression(source) || ts.isParenthesizedExpression(source)) source = source.expression;
          if (!/^req\.(body|query|params)$/.test(source.getText())) continue;
          for (const el of x.name.elements) {
            const nm = el.name.getText();
            if (nm === 'entity_id') bodyEntity = nm;
            else if (/_id$/.test(nm)) reads.add(nm);
          }
        }
      }
      if (reads.size === 0) continue;
      if (mountedBeforeAuth.has(file)) continue;
      const table = TENANT_TABLE_ROUTES[routeName];
      if (table !== undefined) {
        if (tableHasEntity(table)) {
          findings.push({
            route: routeName,
            issue: `eximida como tabla del inquilino («${table}»), y esa tabla SÍ llega a una entidad`,
          });
        }
        continue;
      }

      // (i) La guarda, como ARGUMENTO de middleware antes del manejador —no
      // dentro de una cadena—, o `assertEntityAccess(` llamado en el manejador.
      const middlewares = routeArgs.slice(1, routeArgs.length - 1);
      const guardMounted = middlewares.some((m) => ts.isIdentifier(m) && m.text === 'requireEntityAccess');
      let guardInside = false;
      for (const x of walk(body)) {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'assertEntityAccess') guardInside = true;
      }
      if (!guardMounted && !guardInside) {
        findings.push({ route: routeName, issue: 'escribe sobre un recurso por id sin requireEntityAccess' });
        continue;
      }

      // (ii) Que la entidad llegue A CADA LLAMADA que resuelve la lectura —no
      // al manejador en general—: una variable ligada a `req.entityId` y sin
      // usar deja la llamada sin acotar.
      const bound = new Map<string, ts.Node>();
      for (const x of walk(body)) {
        if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer) bound.set(x.name.text, x.initializer);
      }
      const argCarriesEntity = (a: ts.Node): boolean => {
        if (containsReqEntityId(a)) return true;
        for (const x of walk(a)) {
          if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && localUsesEntity(x.expression.text)) return true;
          if (ts.isIdentifier(x)) {
            const init = bound.get(x.text);
            if (init !== undefined && containsReqEntityId(init)) return true;
            // El `entity_id` del cuerpo cuenta SÓLO con la guarda montada: es
            // ella quien lo valida contra el token.
            if (guardMounted && bodyEntity !== null && x.text === bodyEntity) return true;
          }
        }
        return false;
      };
      const readUsedBy = (call: ts.CallExpression): string | null => {
        for (const a of call.arguments) {
          for (const x of walk(a)) {
            const t = x.getText();
            if (reads.has(t)) return t;
          }
        }
        return null;
      };

      const scopedReads = new Set<string>();
      if (ts.isBlock(body)) {
        for (const x of walk(body)) {
          if (!ts.isCallExpression(x) || !ts.isIdentifier(x.expression)) continue;
          const read = readUsedBy(x);
          if (read === null) continue;
          const llamado = x.expression.text;
          // Una función LOCAL que usa req.entityId y recibe `req` acota la
          // lectura para lo que venga después (assertEntryAccess(req, id)).
          if (localUsesEntity(llamado) && x.arguments.some((a) => a.getText() === 'req')) {
            scopedReads.add(read);
            continue;
          }
          if (!imported.has(llamado)) continue;
          if (x.arguments.some(argCarriesEntity)) {
            scopedReads.add(read);
            continue;
          }
          if (scopedReads.has(read)) continue;
          findings.push({ route: routeName, issue: `${llamado}(${read}) no recibe la entidad validada` });
        }
      }
    }
  }
  return { reviewed, findings };
}

// ============================================================
// THE CALENDAR-DATE SCANNER (#211).
//
// Every entry is born at `createJournalEntry`, which since #211 normalises its
// date once with `toCalendarDate`. That makes a 'YYYY-MM-DD' string correct in
// every timezone — and it makes exactly one thing wrong again: a caller that
// turns the string into `new Date(str)` before handing it over, because that
// is UTC midnight and its LOCAL fields are the previous day west of Greenwich.
// Five callers did exactly that, each on a different surface.
//
// So this looks at the ARGUMENT that carries the date in each call — not at
// the file, where a harmless `new Date()` a few lines away would hide it — and
// follows it one hop through a `const` bound in the same function, which is
// the obvious way around a check that only reads the argument text.
// ============================================================

interface DateArgumentFinding {
  site: string;
  issue: string;
}

export function scanLedgerDateArguments(): { calls: number; findings: DateArgumentFinding[] } {
  const findings: DateArgumentFinding[] = [];
  let calls = 0;

  function* walk(n: ts.Node): Generator<ts.Node> {
    yield n;
    for (const child of n.getChildren()) yield* walk(child);
  }

  // `new Date()` is now, and the local-midnight template is the house's own
  // correct construction; anything else REPARSES a value into an instant.
  const reparses = (n: ts.Node): boolean => {
    if (!ts.isNewExpression(n) || n.expression.getText() !== 'Date') return false;
    const args = n.arguments ?? [];
    if (args.length === 0) return false;
    if (args.length === 1 && ts.isTemplateExpression(args[0]) && /T00:00:00`$/.test(args[0].getText())) return false;
    return true;
  };

  for (const abs of fuentes('src')) {
    const text = leer(abs);
    if (!/createJournalEntry\(|reverseWithinTransaction\(|reverseJournalEntry\(/.test(text)) continue;
    const sf = ts.createSourceFile(path.basename(abs), text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(RAIZ, abs);

    for (const n of walk(sf)) {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) continue;
      const callee = n.expression.text;
      let dateArg: ts.Node | undefined;
      if (callee === 'createJournalEntry') dateArg = n.arguments[1];
      else if (callee === 'reverseWithinTransaction') dateArg = n.arguments[4];
      else if (callee === 'reverseJournalEntry') {
        const opts = n.arguments[2];
        if (opts && ts.isObjectLiteralExpression(opts)) {
          const prop = opts.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'reversalDate');
          if (prop && ts.isPropertyAssignment(prop)) dateArg = prop.initializer;
        }
      } else continue;
      if (callee === 'createJournalEntry') calls += 1;
      if (!dateArg) continue;

      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const site = `${rel}:${line} ${callee}`;
      let flagged = false;
      for (const x of walk(dateArg)) {
        if (reparses(x)) {
          findings.push({ site, issue: `the date argument is ${x.getText().slice(0, 60)}` });
          flagged = true;
          break;
        }
      }
      if (flagged) continue;

      // One hop through a const bound in the enclosing function.
      if (ts.isIdentifier(dateArg)) {
        let scope: ts.Node | undefined = n.parent;
        while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        if (!scope) continue;
        for (const x of walk(scope)) {
          if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === dateArg.text &&
              x.initializer && reparses(x.initializer)) {
            findings.push({ site, issue: `the date argument «${dateArg.text}» is bound to ${x.initializer.getText().slice(0, 60)}` });
            break;
          }
        }
      }
    }
  }
  return { calls, findings };
}

// ============================================================
// W0 · THE WEB GATEWAY'S IMPORT CLOSURE (#117)
//
// The gateway is a separate process so that, if it is compromised, it holds
// browser sessions and nothing of the engine: no database pool, no signing
// secret, no service that writes the ledger. That property is a property of
// the TRANSITIVE import graph, not of any one file. A literal scan of
// src/gateway for `../database/` misses the day an allowed module
// (src/auth/oidc.ts, say) starts importing the pool, and misses a computed
// `import(name)` entirely.
//
// So the walk is a pure function over a source reader, exported and tested on
// in-memory trees in tests/plan/import-closure.spec.ts. That spec covers what
// a mutant cannot express: a mutant replaces or deletes a file, it cannot
// create one, and `fuentes()` lists the disk.
//
// Specifiers come from ts.preProcessFile (static imports, side-effect imports,
// export-from, import() with a literal, require). Three more things are
// findings by themselves, because the walk cannot know what they load:
//   · import() or require() with an argument that is not a literal;
//   · `require` used as anything but the callee of such a literal call
//     (`const load = require`, `require.call(…)`, handing it along);
//   · eval, the CommonJS `module` object, globalThis and global, which reach
//     the loader, `process` and `require` by another name.
// A builtin is allowed per file (a loader such as node:module or child_process
// is not a builtin like any other), and a package can be restricted to the
// named exports a file may bind: jose is how the gateway verifies tokens, and
// it is also how anyone would mint one, so what the closure binds from it is
// judged, not whether a name such as SignJWT appears.
// ============================================================

export interface ImportClosureSource {
  /** The text of a repository-relative file, or undefined when there is none. */
  get(rel: string): string | undefined;
}

export interface ImportClosureRules {
  /** May this repository-relative .ts file be part of the closure? */
  allowFile(rel: string): boolean;
  /** May the file `from` import this bare specifier (a package or a Node builtin)? */
  allowBare(specifier: string, from: string): boolean;
  /**
   * Packages that may be bound only by name, and the names allowed. A
   * namespace or default import, `export *`, require() or import() of one of
   * these binds the whole module and is a finding.
   */
  namedOnly?: Readonly<Record<string, readonly string[]>>;
}

export function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return builtinModules.includes(bare);
}

/** `./x.js` from `src/a/b.ts` → the .ts file it names, if the source has it. */
function resolveRelativeImport(from: string, specifier: string, source: ImportClosureSource): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:js|ts)$/, '');
  for (const candidate of [`${stem}.ts`, `${base}/index.ts`, `${stem}/index.ts`]) {
    if (source.get(candidate) !== undefined) return candidate;
  }
  return undefined;
}

export function isLiteralArgument(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

/**
 * True when an identifier names a binding rather than a property or a member:
 * `x.module` and `{ module: 1 }` are not the module object, `{ module }` is.
 */
export function isIdentifierReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return false;
  if ((ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p) || ts.isModuleDeclaration(p)) && p.name === id) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

const LOADER_ALIASES = new Set(['eval', 'module', 'globalThis', 'global']);

/** Loads whose target the walk cannot know: see the header of this section. */
function opaqueLoads(file: string, sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const where = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf).slice(0, 60)}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const dynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if ((dynamicImport || requireCall) && !isLiteralArgument(n.arguments[0])) {
        found.push(`computed specifier ${where(n)}`);
      }
    }
    if (ts.isIdentifier(n) && n.text === 'require') {
      const p = n.parent;
      const directCallee = ts.isCallExpression(p) && p.expression === n;
      const memberCallee =
        ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p && isLiteralArgument(p.parent.arguments[0]);
      if (!directCallee && !memberCallee) found.push(`require used as a value ${where(p)}`);
    }
    if (ts.isIdentifier(n) && LOADER_ALIASES.has(n.text) && isIdentifierReference(n)) {
      found.push(`loader reached through ${n.text} ${where(n.parent)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** What a file binds from `specifier`: export names, or '*' for the whole module. */
function bindingsFrom(sf: ts.SourceFile, specifier: string): string[] {
  const names: string[] = [];
  const named = (n: ts.Node | undefined): boolean => isLiteralArgument(n) && n.text === specifier;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && named(n.moduleSpecifier)) {
      const clause = n.importClause;
      if (clause?.name) names.push('default');
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
      if (bindings && ts.isNamedImports(bindings)) {
        for (const e of bindings.elements) names.push((e.propertyName ?? e.name).text);
      }
    } else if (ts.isExportDeclaration(n) && named(n.moduleSpecifier)) {
      const clause = n.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) names.push('*');
      else for (const e of clause.elements) names.push((e.propertyName ?? e.name).text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && named(n.moduleReference.expression)) {
      names.push('*');
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      named(n.arguments[0])
    ) {
      names.push('*');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/**
 * The closure of `roots`: every file the walk visited, and every way it leaves
 * what `rules` allows, each with the import chain that reaches it. No
 * violations means the closure is contained; `files` is what a caller must
 * also read to judge what the process holds, borrowed modules included.
 */
export function importClosure(
  source: ImportClosureSource,
  roots: readonly string[],
  rules: ImportClosureRules
): { files: string[]; violations: string[] } {
  const violations: string[] = [];
  const files: string[] = [];
  const parent = new Map<string, string | undefined>();
  const chainOf = (file: string): string => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = parent.get(at)) chain.unshift(at);
    return chain.join(' → ');
  };
  const queue: string[] = [];
  for (const root of roots) {
    if (parent.has(root)) continue;
    parent.set(root, undefined);
    queue.push(root);
  }
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i];
    const text = source.get(file);
    if (text === undefined) {
      violations.push(`${chainOf(file)}: the file cannot be read`);
      continue;
    }
    if (!rules.allowFile(file)) {
      violations.push(`${chainOf(file)}: outside the allowed closure`);
      continue;
    }
    files.push(file);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const opaque of opaqueLoads(file, sf)) {
      violations.push(`${chainOf(file)}: ${opaque}`);
    }
    const seenBare = new Set<string>();
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      if (specifier.startsWith('.')) {
        const target = resolveRelativeImport(file, specifier, source);
        if (target === undefined) {
          violations.push(`${chainOf(file)} → ${specifier}: resolves to no file`);
        } else if (!rules.allowFile(target)) {
          violations.push(`${chainOf(file)} → ${target}: outside the allowed closure`);
        } else if (!parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      } else if (!rules.allowBare(specifier, file)) {
        violations.push(`${chainOf(file)} → ${specifier}: package not allowed`);
      } else if (rules.namedOnly?.[specifier] && !seenBare.has(specifier)) {
        seenBare.add(specifier);
        const allowed = rules.namedOnly[specifier];
        for (const name of new Set(bindingsFrom(sf, specifier))) {
          if (name === '*') violations.push(`${chainOf(file)} → ${specifier}: binds the whole module`);
          else if (!allowed.includes(name)) violations.push(`${chainOf(file)} → ${specifier}: binds ${name}, outside the allowed exports`);
        }
      }
    }
  }
  return { files, violations };
}

/** Every way the closure of `roots` leaves what `rules` allows. Empty means contained. */
export function importClosureViolations(
  source: ImportClosureSource,
  roots: readonly string[],
  rules: ImportClosureRules
): string[] {
  return importClosure(source, roots, rules).violations;
}

/** The files the gateway's server process may load, besides its own. */
export const GATEWAY_SERVER_BORROWED_FILES: readonly string[] = [
  'src/auth/oidc.ts',
  'src/auth/login-flows.ts',
  'src/auth/token-store.ts',
  'src/api/rest/trust-proxy.ts',
];

/**
 * The builtins the gateway's server closure may load, named one by one. A
 * loader is not a builtin like any other: node:module hands out createRequire,
 * and vm, worker_threads and child_process run code the walk never sees. The
 * token store keeps child_process, where it already lives, for the macOS
 * keychain; nothing else in the closure may import it.
 */
export const GATEWAY_SERVER_BUILTINS: readonly string[] = ['crypto', 'fs', 'http', 'net', 'os', 'path', 'stream', 'stream/web', 'util'];

/** The verification half of jose, the only half the gateway has any use for. */
export const GATEWAY_JOSE_EXPORTS: readonly string[] = ['createRemoteJWKSet', 'customFetch', 'jwtVerify', 'decodeProtectedHeader', 'JWTPayload'];

export const GATEWAY_SERVER_CLOSURE: ImportClosureRules = {
  allowFile: (rel) =>
    (rel.startsWith('src/gateway/') && !rel.startsWith('src/gateway/app/')) || GATEWAY_SERVER_BORROWED_FILES.includes(rel),
  allowBare: (specifier, from) => {
    if (specifier === 'express' || specifier === 'jose') return true;
    if (!isNodeBuiltin(specifier)) return false;
    const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    return GATEWAY_SERVER_BUILTINS.includes(bare) || (bare === 'child_process' && from === 'src/auth/token-store.ts');
  },
  namedOnly: { jose: GATEWAY_JOSE_EXPORTS },
};

/** The browser program: its own modules and the two typed catalogs, and no package at all. */
export const GATEWAY_APP_CLOSURE: ImportClosureRules = {
  allowFile: (rel) => rel.startsWith('src/gateway/app/') || rel === 'src/i18n/en.ts' || rel === 'src/i18n/es.ts',
  allowBare: () => false,
};

/** The gateway's files on disk, split into the server process and the browser program. */
export function gatewayFiles(): { server: string[]; app: string[] } {
  const all = fuentes('src/gateway')
    .map((abs) => path.relative(RAIZ, abs).split(path.sep).join('/'))
    .filter((rel) => existe(rel))
    .sort();
  return {
    server: all.filter((rel) => !rel.startsWith('src/gateway/app/')),
    app: all.filter((rel) => rel.startsWith('src/gateway/app/')),
  };
}

/** Reads through the seam, so a mutant reaches the walk. */
export const seamSource: ImportClosureSource = {
  get: (rel) => (existe(rel) ? crudoDe(rel) : undefined),
};

/** The syntax tree of a repository file read through the seam, or undefined when it is gone. */
export function gatewaySyntaxOf(rel: string): ts.SourceFile | undefined {
  return existe(rel) ? ts.createSourceFile(rel, crudoDe(rel), ts.ScriptTarget.Latest, true) : undefined;
}

export function* gatewayNodes(n: ts.Node): Generator<ts.Node> {
  yield n;
  for (const child of n.getChildren()) yield* gatewayNodes(child);
}

/** The initializer of a top-level `const name = …`, with `as` and parentheses peeled off. */
export function topLevelInitializer(sf: ts.SourceFile, name: string): { node: ts.Expression; raw: ts.Expression } | undefined {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
      let node: ts.Expression = d.initializer;
      while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
        node = node.expression;
      }
      return { node, raw: d.initializer };
    }
  }
  return undefined;
}

/** The string elements of an array literal, or undefined if any element is not a string literal. */
export function stringElements(node: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(node)) return undefined;
  const out: string[] = [];
  for (const e of node.elements) {
    if (!ts.isStringLiteral(e)) return undefined;
    out.push(e.text);
  }
  return out;
}

/** Visits every node below `n` through ts.forEachChild (JSDoc stays out). */
export function forEachGatewayNode(n: ts.Node, visit: (node: ts.Node) => void): void {
  ts.forEachChild(n, (child) => {
    visit(child);
    forEachGatewayNode(child, visit);
  });
}

export const GATEWAY_CODE_PRINTER = ts.createPrinter({ removeComments: true });

function printedStatements(statements: readonly ts.Statement[], sf: ts.SourceFile): string {
  return statements.map((st) => GATEWAY_CODE_PRINTER.printNode(ts.EmitHint.Unspecified, st, sf)).join('\n');
}

/**
 * True when `statements` are exactly `expected`, compared as printed code:
 * layout and comments do not count, a dropped `!` or a flipped `!==` does.
 */
export function sameStatements(statements: readonly ts.Statement[] | undefined, sf: ts.SourceFile, expected: string): boolean {
  if (!statements) return false;
  const want = ts.createSourceFile('expected.ts', expected, ts.ScriptTarget.Latest, true);
  return printedStatements(statements, sf) === printedStatements(want.statements, want);
}

/** The top-level function declaration `name` of a file, if there is exactly one. */
export function soleFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const found = sf.statements.filter((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name);
  return found.length === 1 ? found[0] : undefined;
}

/** Names a file imports from `specifier` without renaming them. */
export function plainImportsFrom(sf: ts.SourceFile, specifier: string): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== specifier) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const e of bindings.elements) if (!e.propertyName) names.add(e.name.text);
  }
  return names;
}

/** Declarations in a file (functions, variables, parameters, classes) that bind `name`. */
export function localDeclarationsOf(sf: ts.SourceFile, name: string): number {
  let count = 0;
  forEachGatewayNode(sf, (n) => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n) || ts.isBindingElement(n)) &&
      n.name !== undefined &&
      ts.isIdentifier(n.name) &&
      n.name.text === name
    ) {
      count += 1;
    }
  });
  return count;
}

/** The first handler of `name` in server.ts's `handlers` table, as written. */
export function handlersTableEntry(sf: ts.SourceFile, name: string): string | undefined {
  for (const n of gatewayNodes(sf)) {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'handlers') continue;
    if (!n.initializer || !ts.isObjectLiteralExpression(n.initializer)) return undefined;
    for (const p of n.initializer.properties) {
      if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== name) continue;
      if (!ts.isArrayLiteralExpression(p.initializer)) return undefined;
      return p.initializer.elements[0]?.getText(sf);
    }
  }
  return undefined;
}

/** `[…strings].join('; ')` as a top-level initializer: its directives, or undefined for any other shape. */
export function joinedPolicy(sf: ts.SourceFile, name: string): string[] | undefined {
  const init = topLevelInitializer(sf, name);
  const call = init?.node;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text !== 'join' || call.arguments.length !== 1) return undefined;
  const separator = call.arguments[0];
  if (!ts.isStringLiteral(separator) || separator.text !== '; ') return undefined;
  return stringElements(call.expression.expression);
}

/** The text of a string-like literal node, template pieces included, or undefined. */
export function literalText(n: ts.Node): string | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) return n.text;
  return undefined;
}
