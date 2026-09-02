import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// CRITERIOS DE CIERRE, EJECUTABLES
//
// El plan de cierre lleva sus criterios en prosa y NADIE los ha corrido nunca
// como conjunto. El resultado fue predecible: su tabla de estado marcaba
// resueltos paquetes que no lo estaban, y marcaba pendientes otros que sí,
// porque era un espejo escrito a mano del repositorio.
//
// Aquí los criterios son CÓDIGO. El documento los cita; esta lista los decide.
//
// DOS REGLAS QUE VIENEN DE UN ERROR CONCRETO
//
// 1. Un criterio afirma COMPORTAMIENTO, no identificadores. El cerrojo
//    antisimulación del timbrado se construyó bien, quedó mejor documentado
//    que su especificación, y falla el 100% de sus criterios escritos porque
//    su autor eligió nombres en español. Un criterio puede nombrar un archivo
//    sólo cuando el plan está PRESCRIBIENDO dónde va el código.
//
// 2. Un criterio que no se puede evaluar se declara «no evaluable» y dice por
//    qué. Nunca se aproxima: un ✅ inventado es peor que un hueco confesado,
//    porque hace que un comando imposible parezca trabajo de una hora.
// ============================================================

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

export interface Criterio {
  paquete: string;
  /** Qué se afirma, en términos de comportamiento observable. */
  enunciado: string;
  /** Precondición que el runner comprueba antes de evaluar. */
  necesita?: 'base-de-datos' | 'red';
  evaluar: () => Promise<Resultado> | Resultado;
  /**
   * Espejos: mutaciones que DEBEN poner este criterio en rojo. Sólo para
   * criterios SIN `necesita` (los de conducta se juzgan contra la base, no
   * contra el fuente). La línea base de criterios sin espejo sólo encoge
   * (meta-criterio en E0.0).
   */
  mutantes?: Mutante[];
}

// ── Ayudas ──────────────────────────────────────────────────

const RAIZ = path.resolve(__dirname, '..', '..');

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

function leer(abs: string): string {
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

export function existe(rel: string): boolean {
  // El overlay también gobierna la EXISTENCIA: así un espejo puede fingir
  // que un registro de auditoría o una migración desaparecieron.
  if (sobreescrituras?.get(rel) === null) return false;
  return fs.existsSync(rutaDe(rel));
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
 * Memoria por CONTENIDO, no por ruta. Los 161 sitios de llamada releen los
 * mismos archivos una y otra vez, y el seam de mutación cambia el contenido sin
 * cambiar la ruta: cachear por ruta serviría el archivo sano a un mutante y el
 * espejo dejaría de morder. Con la clave en el propio texto, un mutante es
 * simplemente otra entrada.
 */
const CACHE_SIN_COMENTARIOS = new Map<string, string>();

export function sinComentarios(texto: string): string {
  // Recorrido con estado en vez de dos regex. Las regex se quedaron CIEGAS el
  // día que un ejemplo de ayuda citó un glob de shell: `./cfdi/julio/*.xml`
  // contiene `/*`, que abría un comentario de bloque cerrado 94 499 bytes
  // después — el 80 % de mnemosine.ts desaparecía del criterio y `plan:status`
  // acusaba SIETE rojos falsos sobre familias que sí estaban en el binario. Un
  // instrumento que decide no puede cegarse con una cadena, así que las
  // cadenas se saltan en vez de mirarse.
  //
  // Se copia POR TRAMOS, no carácter a carácter: la primera versión de este
  // arreglo concatenaba de uno en uno y salía 8× más lenta, y con 161 sitios
  // de llamada eso llevó las pruebas de `main()` a agotar su presupuesto de
  // 30 s en CI. Correcto y lento sigue siendo un defecto cuando el instrumento
  // corre en cada empuje.
  //
  // Sirve para TypeScript y para SQL (`codigoDe` se usa sobre los dos): las
  // comillas simples que SQL duplica para escapar cierran y reabren, que deja
  // el mismo resultado. Las expresiones regulares de TS se tratan como
  // división —no se intenta desambiguar—, así que un `/*` dentro de un literal
  // de regex seguiría cegando; hoy no hay ninguno.
  const memo = CACHE_SIN_COMENTARIOS.get(texto);
  if (memo !== undefined) return memo;

  const trozos: string[] = [];
  let i = 0;
  let copiadoDesde = 0;
  while (i < texto.length) {
    const c = texto.charCodeAt(i);
    // 0x2f '/'  0x2a '*'  0x2d '-'  0x27 "'"  0x22 '"'  0x60 '`'  0x5c '\\'
    if (c === 0x2f || c === 0x2d) {
      const d = texto.charCodeAt(i + 1);
      const bloque = c === 0x2f && d === 0x2a;
      const linea = (c === 0x2f && d === 0x2f) || (c === 0x2d && d === 0x2d);
      if (bloque || linea) {
        trozos.push(texto.slice(copiadoDesde, i));
        const fin = bloque ? texto.indexOf('*/', i + 2) : texto.indexOf('\n', i);
        i = fin === -1 ? texto.length : bloque ? fin + 2 : fin;
        copiadoDesde = i;
        continue;
      }
    }
    if (c === 0x27 || c === 0x22 || c === 0x60) {
      // La cadena se CONSERVA: quitarla rompería los criterios que buscan un
      // literal («status = 'posted'»), que son casi todos. Sólo se salta, para
      // que un `/*` de su interior no abra un comentario.
      let j = i + 1;
      while (j < texto.length && texto.charCodeAt(j) !== c) {
        if (texto.charCodeAt(j) === 0x5c) j++;
        j++;
      }
      i = Math.min(j + 1, texto.length);
      continue;
    }
    i++;
  }
  trozos.push(texto.slice(copiadoDesde));
  const fuera = trozos.join('');
  CACHE_SIN_COMENTARIOS.set(texto, fuera);
  return fuera;
}

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

export const ok = (detalle: string): Resultado => ({ estado: 'ok', detalle });
export const falla = (detalle: string): Resultado => ({ estado: 'falla', detalle });
export const noEvaluable = (detalle: string): Resultado => ({ estado: 'no-evaluable', detalle });

// ── Los criterios ───────────────────────────────────────────

export const CRITERIOS: Criterio[] = [
  // ---- E0.0 · Control de versiones y CI ----
  {
    paquete: 'E0.0',
    enunciado: 'El repositorio tiene remoto, así que la CI puede dispararse',
    evaluar: () => {
      const cfg = rutaDe('.git', 'config');
      if (!fs.existsSync(cfg)) return falla('no hay .git');
      const tiene = /\[remote /.test(leer(cfg));
      return tiene
        ? ok('remoto configurado')
        : falla('sin remoto: ci.yml existe pero nunca puede ejecutarse');
    },
  },
  {
    paquete: 'E0.0',
    // Esto exigía la línea literal `^\.env$` y la cadena `.env.backup`. Se
    // puso en rojo el día que alguien SUSTITUYÓ esa lista por `.env*` con
    // `!.env.example` — un patrón estrictamente más fuerte, que además cubre
    // el `.env.old` que la lista no cubría. El criterio afirmaba la forma del
    // arreglo en vez de la propiedad, y castigó una mejora.
    //
    // Ahora se le pregunta a git, que es la autoridad: no importa cómo esté
    // escrito el .gitignore mientras la respuesta sea la correcta.
    enunciado: 'Ninguna variante de .env se puede versionar, salvo el ejemplo',
    evaluar: () => {
      const ignorado = (archivo: string): boolean => {
        const r = spawnSync('git', ['check-ignore', '-q', '--no-index', archivo], { cwd: rutaDe() });
        if (r.error || r.status === null || r.status > 1) return false;
        return r.status === 0;
      };
      const deben = ['.env', '.env.local', '.env.backup-2026-08-27', '.env.old', '.env.copia', '.env.produccion'];
      const sueltos = deben.filter((f) => !ignorado(f));
      if (sueltos.length > 0) {
        return falla(
          `git versionaría ${sueltos.join(', ')}: un secreto real entra al historial en el primer \`git add -A\``
        );
      }
      // La excepción tiene que seguir siendo excepción: sin .env.example nadie
      // sabe qué variables hacen falta, y el arreglo obvio es aflojar el patrón.
      return ignorado('.env.example')
        ? falla('.env.example también está ignorado: sin plantilla, el siguiente arreglo será aflojar el patrón')
        : ok(`${deben.length} variantes de .env ignoradas y .env.example versionable`);
    },
  },
  {
    paquete: 'E0.0',
    enunciado: 'Los checks viven en un solo ci.yml, que declara sus cinco jobs',
    evaluar: () => {
      // Lo que E0.0-b compró no fue «un archivo en .github/workflows»: fue que
      // la CI de *checks* no se reparta entre archivos —«los demás paquetes
      // AÑADEN jobs a ci.yml; ninguno lo crea de nuevo»—, porque dos pipelines
      // en paralelo es como se pierde de vista cuál puerta está roja.
      //
      // Contar archivos medía eso por accidente y castigaba lo que no es un
      // pipeline: un listener de eventos de PR (witness-triage.yml) no corre
      // ninguna puerta, no puede diluirlas y no puede quedarse desfasado
      // respecto a ellas. Así que se mide la propiedad, no el número: ci.yml
      // lleva los jobs de puerta y NINGÚN otro workflow corre una puerta.
      const dir = rutaDe('.github', 'workflows');
      if (!fs.existsSync(dir)) return falla('no existe .github/workflows');
      const archivos = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
      if (!archivos.includes('ci.yml')) {
        return falla(`no hay ci.yml: ${archivos.join(', ') || 'ningún workflow'}`);
      }
      // POR QUÉ ENTRÓ `restauracion` (S3). Los cuatro primeros son los que
      // E0.0-b nombró. El quinto se añade porque su ausencia era la misma
      // fuga un piso más abajo: el criterio «un respaldo se prueba
      // restaurándolo» afirma que `verificarRespaldo` restaura y corre los
      // chequeos del mayor, pero lo afirma LEYENDO EL FUENTE. Borrar el job
      // del YAML dejaba esa afirmación intacta y en verde con nadie que la
      // ejecutara nunca — código que dice la verdad sobre sí mismo y no corre.
      // Y no es una puerta cualquiera: el propio plan exige «respaldo
      // verificado» como condición de sus tres remediaciones destructivas
      // (E1.2-h, E1.4-a, E3.2-i, las que «corrompen el mayor de una entidad
      // viva» si salen mal), así que este job ES ese control ejecutándose.
      //
      // `lint` y `plan` siguen FUERA, y eso es deuda dicha en voz alta y no
      // olvido: ver «Lo que la CI no cubre» en docs/wiki/Pruebas-y-CI.md.
      const NOMBRES = ['typecheck', 'unit', 'integration', 'aislamiento', 'restauracion'];
      // Por el seam, no por fs: S2 exige que la única lectura directa de disco
      // en este archivo sea la de leer(), o el mutante de este criterio no lo
      // alcanzaría y su espejo mentiría en verde.
      const y = leer(path.join(dir, 'ci.yml'));
      const faltan = NOMBRES.filter((j) => !new RegExp(`^  ${j}:`, 'm').test(y));
      if (faltan.length > 0) return falla(`faltan jobs en ci.yml: ${faltan.join(', ')}`);

      // Una puerta corrida fuera de ci.yml es el pipeline partiéndose, se
      // llame como se llame el job que la corre.
      const PUERTAS = /tsc --noEmit|typecheck:tests|vitest run|test:integration|verify-isolation|plan\/status|catalogo-estado/;
      const intrusos = archivos
        .filter((f) => f !== 'ci.yml')
        .filter((f) => {
          const otro = leer(path.join(dir, f));
          return PUERTAS.test(otro) || NOMBRES.some((j) => new RegExp(`^  ${j}:`, 'm').test(otro));
        });
      // El número sale de la lista, no de la prosa: un conteo escrito a mano
      // en la salida es el que se queda diciendo «cuatro» cuando ya son cinco.
      return intrusos.length === 0
        ? ok(
            `ci.yml con sus ${NOMBRES.length} jobs de puerta` +
              (archivos.length > 1 ? `; ${archivos.length - 1} workflow(s) sin puertas` : '')
          )
        : falla(`la CI de checks se reparte fuera de ci.yml: ${intrusos.join(', ')}`);
    },
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: '  restauracion:',
        a: '  restauracion_retirada:',
        porque:
          'la puerta desaparece por RENOMBRE —la forma en que un job se va sin que ningún diff diga ' +
          'que lo borra— y el criterio que la nombraba tiene que acusarlo',
      },
    ],
  },
  {
    paquete: 'E0.0',
    enunciado: 'La aplicación conecta como rol NO privilegiado en el job que prueba el aislamiento',
    evaluar: () => {
      const y = crudoDe('.github', 'workflows', 'ci.yml');
      const bloque = y.slice(y.indexOf('aislamiento:'));
      return /DATABASE_URL:\s*postgresql:\/\/mnemosine_app/.test(bloque)
        ? ok('DATABASE_URL usa mnemosine_app')
        : falla('el job de aislamiento conecta como superusuario: la RLS no filtra y una política ausente no se detecta');
    },
  },
  {
    paquete: 'E0.0',
    enunciado: 'Un flujo no se declara cerrado sin su auditoría adversarial registrada',
    evaluar: () => {
      // S1 lo escribió como INVITACIÓN y por eso no acusó a nadie: la lista de
      // flujos cerrados era un objeto que había que poblar a mano, su único
      // renglón estaba comentado, y `[].filter(...).length === 0` es verdad
      // constante. Con la compuerta en verde por vacía, F01, F02 y A3-A4 se
      // declararon hechos sin un solo registro — la auditoría integral II lo
      // nombró como la meta-brecha: el instrumento que juzga a todos era el
      // único que nadie juzgaba.
      //
      // S2 la vuelve DERIVADA: lo cerrado no lo dice una lista que hay que
      // acordarse de poblar, lo dice EL CATÁLOGO. Cada celda «hecha en F0x»
      // es la declaración de que ese flujo cerró, y entonces su registro de
      // auditoría DEBE existir. Ya no se puede cerrar un flujo sin auditarlo:
      // habría que no reclamar ni una fila.
      //
      // Se derivó del catálogo y no del historial de git a propósito: el
      // primer intento leía los asuntos de los commits y el clon de esta
      // misma máquina resultó ser SUPERFICIAL —igual que el de
      // `actions/checkout` por omisión—, así que la compuerta habría visto un
      // solo commit y dado verde por no mirar. El catálogo está en el árbol,
      // lo versiona el mismo commit que cierra el flujo, y el arnés de
      // mutación puede tocarlo.
      const REGISTROS: Record<string, string> = {
        // Los tramos que la integral II verificó tarjeta por tarjeta.
        F01: 'docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md',
        F02: 'docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md',
        'A3-A4': 'docs/auditorias/2026-09-01-integral-ii/a3a4-entregado.md',
        // F03 se auditó por EJECUCIÓN contra la base (el abanico de escépticos
        // murió dos veces contra el límite de la cuenta): su registro dice eso
        // en su primera sección, porque el método es parte del veredicto.
        F03: 'docs/auditorias/F03.md',
        // F04 se auditó igual que F03 —por EJECUCIÓN contra la base— y además
        // sometiendo sus propios criterios al arnés de mutación, que devolvió
        // cinco anclas blandas antes de dar el verde. Las dos cosas están en
        // su registro, porque el método es parte del veredicto.
        F04: 'docs/auditorias/F04.md',
        // F05 va por TRAMOS, y la compuerta los admite: su expresión acepta
        // `F\d+[a-z]?`. Cada tramo cierra con su propio registro, y mientras
        // ninguno escriba «hecha en F05» a secas el mutante de esta compuerta
        // sigue matando sin reapuntarse.
        F05a: 'docs/auditorias/F05a.md',
        F05b: 'docs/auditorias/F05b.md',
        F05c: 'docs/auditorias/F05c.md',
        F05d: 'docs/auditorias/F05d.md',
        F06a: 'docs/auditorias/F06a.md',
        F06b: 'docs/auditorias/F06b.md',
        F06c: 'docs/auditorias/F06c.md',
        R4: 'docs/auditorias/R4.md',
        D1a: 'docs/auditorias/D1a.md',
        G1a: 'docs/auditorias/G1a.md',
        G1b: 'docs/auditorias/G1b.md',
        G0: 'docs/auditorias/G0.md',
      };

      if (!existe('docs/auditorias/2026-08-31-integral/README.md')) {
        return falla('el registro de auditorías desapareció: docs/auditorias/2026-08-31-integral');
      }

      const catalogo = crudoDe('docs/cli-command-catalog.md');
      const cerrados = [
        ...new Set(
          [...catalogo.matchAll(/hecha en (F\d+[a-z]?|A\d+(?:-A\d+)?|R\d+)\b/g)].map((m) => m[1])
        ),
      ].sort();

      if (cerrados.length === 0) {
        return falla(
          'ninguna fila del catálogo se declara hecha en un flujo: o la convención se abandonó ' +
            'y esta compuerta dejó de ver nada, o el catálogo perdió sus celdas.'
        );
      }

      const sinRegistro = cerrados.filter((f) => !REGISTROS[f] || !existe(REGISTROS[f]));
      return sinRegistro.length === 0
        ? ok(
            `${cerrados.length} flujo(s) reclamados por el catálogo (${cerrados.join(', ')}), ` +
              'cada uno con su registro de auditoría en el árbol'
          )
        : falla(
            `flujo(s) que el catálogo declara hechos SIN registro de auditoría: ${sinRegistro.join(', ')}. ` +
              'Cerrar un flujo es auditarlo y archivar el registro bajo docs/auditorias/ en el mismo commit.'
          );
    },
    mutantes: [
      {
        archivo: 'docs/auditorias/F03.md',
        de: '# Auditoría adversarial de F03',
        a: null,
        porque: 'el registro de un flujo cerrado desaparece: la compuerta debe acusarlo, que es lo único que vino a hacer',
      },
      {
        archivo: 'docs/cli-command-catalog.md',
        de: 'hecha en F03',
        // El destino tiene que ser un flujo que NO exista todavía. Este mutante
        // apuntaba a F04 y dejó de matar el día que F04 se cerró con su
        // registro: la mutación pasó a describir algo verdadero. Un mutante
        // caduca cuando su «mentira» se vuelve cierta, y hay que reapuntarlo al
        // siguiente flujo sin auditar — no borrarlo.
        a: 'hecha en F05',
        porque: 'el catálogo reclama un flujo NUEVO sin auditoría: cerrar sin registro es exactamente lo prohibido',
      },
    ],
  },

  // ---- E0.1 · Red de pruebas ----
  {
    paquete: 'E0.2',
    enunciado: 'Toda tabla muerta está enterrada o reclamada con nombre y dueño',
    evaluar: () => {
      // El censo de AUD-6 encontró siete tablas sin un solo escritor NI
      // lector, y S0.4 demostró el riesgo: capacidad muerta que sobrevive es
      // la que alguien cablea sin contexto. La 038 enterró seis; lo que se
      // conserva muerto tiene que estar RECLAMADO — una promesa con dueño
      // (el flujo que lo va a poblar) — o este criterio lo acusa. Y una
      // entrada reclamada cuya tabla gane escritor sobra: se reporta para
      // borrarla, como la línea base del auditor.
      const RECLAMADAS: Record<string, string> = {
        inventory_items: 'familia inventario: el esquema es el diseñado; el motor es neto nuevo (S0.4)',
        inventory_layers: 'familia inventario: capas de costeo',
        inventory_layer_consumption: 'familia inventario: consumo de capas',
        scheduled_payments: 'F04: la programación de pagos retirada con 501 escribe aquí cuando exista',
      };
      const dirMigraciones = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dirMigraciones))
        .map((m) => crudoDe(dirMigraciones, m))
        .join('\n');
      const creadas = new Set(
        [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi)].map((m) => m[1])
      );
      const enterradas = new Set(
        [...sql.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+(?:public\.)?(\w+)/gi)].map((m) => m[1])
      );
      const problemas: string[] = [];
      for (const t of creadas) {
        if (enterradas.has(t)) continue;
        // «Muerta» = ni una mención en el código. Un lector sin escritor es
        // otra clase de defecto (lo mide el criterio de la salida de nómina).
        const mencionada = dondeAparece(new RegExp(`\\b${t}\\b`), ['src'], true).length > 0;
        const sembrada = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${t}\\b`, 'i').test(sql);
        if (mencionada || sembrada) {
          if (RECLAMADAS[t]) {
            problemas.push(`${t}: reclamada pero ya tiene uso — borra su entrada de RECLAMADAS`);
          }
          continue;
        }
        if (!RECLAMADAS[t]) {
          problemas.push(`${t}: muerta sin reclamo — entiérrala en una migración o reclámala con dueño`);
        }
      }
      return problemas.length === 0
        ? ok(`${Object.keys(RECLAMADAS).length} tablas reclamadas con dueño; el resto o vive o está enterrado`)
        : falla(problemas.join('; '));
    },
  },
  {
    paquete: 'E0.2',
    enunciado: 'Ejecutar una migración y registrarla son un solo acto',
    evaluar: () => {
      // migrate.ts corría el .sql y lo anotaba en public.migrations en DOS
      // transacciones implícitas: un fallo entre ambas dejaba la migración
      // aplicada y sin registrar, y la corrida siguiente la re-ejecutaba —
      // incluidos sus rellenos de datos. Prescriptivo sobre el instrumento,
      // que es el caso en que un criterio puede nombrar el archivo.
      const s = codigoDe('src/database/migrate.ts');
      const transaccional =
        /BEGIN/.test(s) && /ROLLBACK/.test(s) && /INSERT INTO public\.migrations/.test(s);
      if (!transaccional) {
        return falla('migrate.ts no envuelve ejecutar+registrar en una transacción: un fallo entre ambas re-ejecuta la migración en la siguiente corrida');
      }
      // Y el endurecimiento de RLS corre aunque una migración falle: vivía
      // dentro del try y un fallo a mitad dejaba las tablas ya creadas sin
      // política — la fuga silenciosa que el propio bloque dice impedir.
      const finallyIdx = s.indexOf('finally');
      const rlsIdx = s.indexOf('rls-policies.sql');
      return finallyIdx >= 0 && rlsIdx > finallyIdx
        ? ok('transaccional, y el endurecimiento corre pase lo que pase')
        : falla('rls-policies.sql no corre en el finally: un fallo a mitad deja tablas sin política');
    },
  },
  {
    paquete: 'E0.2',
    enunciado: 'Una migración de datos que olvide la RLS truena en vez de correr filtrada',
    mutantes: [
      {
        archivo: 'src/database/migrate.ts',
        de: "await client.query('SET row_security = off');",
        a: "await client.query('SET row_security = on');",
        porque: 'apagar el piso es exactamente la regresión que costó cuatro siembras silenciosas',
      },
    ],
    evaluar: () => {
      // Tres veces una siembra corrió como dueño bajo FORCE RLS sin GUC de
      // inquilino y leyó cero filas «con éxito»: la 025 (confesada por la
      // 026), la 043 (colisión de folio, 2026-08-31) y con ellas la 037 y la
      // 040 — la purga de secretos que no purgó. El remedio no es acordarse:
      // el corredor pone row_security=off y Postgres LANZA 42501 donde antes
      // filtraba en silencio (el mismo default de pg_dump). Prescriptivo
      // sobre el instrumento, que es cuando un criterio nombra el archivo.
      const s = codigoDe('src/database/migrate.ts');
      const piso = s.indexOf("SET row_security = off");
      if (piso < 0) {
        return falla('migrate.ts ya no apaga row_security: la siguiente siembra olvidada volverá a leer cero filas en silencio');
      }
      const bucle = s.indexOf('for (const file of files)');
      if (bucle >= 0 && piso > bucle) {
        return falla('el piso row_security=off se pone DESPUÉS de correr los archivos: las migraciones corren sin él');
      }
      // Y el patrón santo sigue siendo transitable: toda migración que itera
      // inquilinos con el GUC debe declarar el opt-in, porque contra el piso
      // un bucle sin declaración muere con 42501 en el primer catch-up de
      // una base rezagada — una regresión que sólo muerde en el campo.
      const dir = rutaDe('src', 'database', 'migrations');
      const sinOptIn = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => {
          // Por el seam (crudoDe), no por fs directo: una lectura que rodea
          // el seam es un criterio que ningún espejo puede mutar — y el
          // criterio E0.0 del arnés cuenta esas lecturas y las acusa.
          const sql = crudoDe('src/database/migrations', f);
          return sql.includes("set_config('app.current_tenant'")
            && !/SET LOCAL row_security = on/.test(sql);
        });
      return sinOptIn.length === 0
        ? ok('el corredor convierte el filtrado silencioso en 42501 y las siembras por inquilino declaran su opt-in')
        : falla(`bucle por inquilino sin «SET LOCAL row_security = on» — contra el piso mueren en el catch-up: ${sinOptIn.join(', ')}`);
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'Los proyectos unitario y de integración están separados',
    evaluar: () =>
      existe('vitest.config.ts') && existe('vitest.integration.config.ts')
        ? ok('dos configuraciones')
        : falla('falta la separación entre pruebas con base y sin base'),
  },
  {
    paquete: 'E0.1',
    enunciado: 'La cobertura del motor contable tiene trinquete por archivo',
    evaluar: () => {
      const c = codigoDe('vitest.config.ts');
      if (!/thresholds/.test(c)) return falla('vitest.config.ts no define umbrales de cobertura');
      const archivos = (c.match(/'src\/[^']+\.ts':/g) ?? []).length;
      return archivos >= 3
        ? ok(`${archivos} archivos con umbral propio`)
        : falla(`sólo ${archivos} archivo(s) con umbral: un umbral global es un promedio que deja caer una pieza crítica`);
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'La suite de integración usa una base efímera, no la de desarrollo',
    evaluar: () => {
      if (!existe('tests/integration/global-setup.ts')) return falla('no hay global-setup de integración');
      const s = codigoDe('tests/integration/global-setup.ts');
      return /CREATE DATABASE/i.test(s) && /DROP DATABASE/i.test(s)
        ? ok('crea y destruye su propia base por corrida')
        : falla('el setup no crea ni destruye una base propia');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Ningún sello de periodo declara menos asientos de los que su periodo cerrado tiene',
    necesita: 'base-de-datos',
    evaluar: async () => {
      // POR QUÉ ESTE CRITERIO ES LA MITAD DE LO QUE FUE.
      //
      // La primera versión afirmaba además que «todo asiento posteado está en
      // la cadena donde el anclaje está activo». Eso no se puede medir sin un
      // inquilino anclado, así que sobre la base recién creada de CI salía NO
      // EVALUABLE — y `estadoDe` trata un criterio inevaluable como impedimento
      // para dar por cerrado el paquete, con razón: quien depende de E0.1 no
      // distingue «está mal» de «nadie sabe si está bien». El trinquete puso la
      // CI en rojo y tenía razón; lo que no encajaba era el criterio.
      //
      // Se parte, y aquí queda la mitad decidible sin datos previos: un sello
      // que declara menos de lo que su periodo cerrado tiene posteado es falso
      // con datos o sin ellos, y cuando no hay sellos no hay nada que
      // contradiga la afirmación. La otra mitad vive donde se puede medir de
      // verdad —tests/integration/sello-periodo.int.spec.ts, que siembra el
      // anclaje y comprueba que postear un borrador entra en la cadena y que
      // `commitPeriod` se niega ante una laguna—.
      //
      // Este criterio es, entonces, un detector de regresión sobre datos
      // reales, no la prueba del paquete. Por eso su detalle SIEMPRE dice
      // cuántos sellos llegó a inspeccionar: un verde que no diga eso sería
      // verde por no mirar, que es justo lo que el sprint persigue.
      const { query } = await import('../database/connection.js');

      let alcance = 'todos los inquilinos';
      try {
        const rol = await query<{ ve: boolean; rol: string }>(
          `SELECT current_user AS rol,
                  COALESCE(rolsuper OR rolbypassrls, false) AS ve
             FROM pg_roles WHERE rolname = current_user`
        );
        if (rol.rows[0] && !rol.rows[0].ve) {
          // Las tablas llevan RLS forzado: sin contexto de inquilino este rol
          // ve cero filas. No es motivo para declararse inevaluable —no hay
          // nada que contradiga la afirmación— pero sí para decirlo.
          alcance = `lo visible para "${rol.rows[0].rol}", que está sujeto a RLS`;
        }
      } catch {
        /* si pg_roles no se deja leer, lo dirá el catch de abajo */
      }

      let sellos;
      try {
        sellos = await query<{ period_id: string; declarados: number; posteados: string }>(
          // Sólo periodos CERRADOS. En uno abierto, un sello que cubre menos
          // no es una mentira sino una foto con fecha: se selló, y después
          // entraron asientos. El endpoint público sirve `committedAt` al
          // lado de la cifra, así que esa diferencia es legible.
          `SELECT pc.period_id,
                  pc.entry_count AS declarados,
                  (SELECT count(*) FROM journal_entries je
                    WHERE je.fiscal_period_id = pc.period_id
                      AND je.entity_id = pc.entity_id
                      AND je.status = 'posted')::text AS posteados
             FROM period_commitments pc
             JOIN fiscal_periods fp ON fp.id = pc.period_id
            WHERE fp.status IN ('soft_close', 'hard_close', 'locked')`
        );
      } catch (e) {
        const porque = (e as Error).message.slice(0, 60) || 'sin detalle';
        return noEvaluable(`no hay base de datos accesible para medirlo (${porque})`);
      }

      const mienten = sellos.rows.filter((x) => x.declarados !== Number(x.posteados));
      if (mienten.length > 0) {
        const m = mienten[0];
        return falla(
          `${mienten.length} sello(s) declaran menos asientos de los que su periodo tiene ` +
            `posteados — p. ej. el periodo ${m.period_id.slice(0, 8)} sella ${m.declarados} ` +
            `de ${m.posteados}. Esa cifra se publica como la cuenta del periodo.`
        );
      }
      return ok(
        sellos.rows.length === 0
          ? `sin sellos de periodos cerrados que revisar en ${alcance}`
          : `${sellos.rows.length} sello(s) de periodos cerrados coinciden con su periodo (${alcance})`
      );
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'El compromiso no persiste el valor que promete ocultar',
    evaluar: async () => {
      // S1 (E1.4-a rescatada): el range proof placeholder incluía
      // _test_value y _test_bf bajo el comentario «DO NOT store the value in
      // a real proof», y el orquestador lo persistía entero — el compromiso
      // que vende «prueba el rango SIN revelar el importe» llevaba dentro el
      // importe y el factor para abrirlo. El generador ya no las escribe y
      // la 040 purgó las filas; esto vigila que no vuelvan.
      const fuga = dondeAparece(/_test_value|_test_bf/, ['src'], true);
      if (fuga.length > 0) {
        return falla(`el valor volvió al blob del compromiso: ${fuga.join(', ')}`);
      }
      if (!existe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql')) {
        return falla('la migración de purga (040) desapareció: las filas históricas retendrían la fuga');
      }
      const purga = crudoDe('src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql');
      if (!/range_proof\s*=\s*NULL/.test(purga) || !/zkverify_proof\s*=\s*NULL/.test(purga)) {
        return falla('la 040 no purga los dos blobs (range_proof y zkverify_proof)');
      }
      // S3 · DE TEXTO A EFECTO. Este criterio leía el .sql y daba verde por
      // que la purga ESTUVIERA ESCRITA — sin poder distinguir «corrió» de «no
      // tocó nada». Y no tocó nada: bajo FORCE RLS el migrador afectaba cero
      // filas en silencio. Un criterio que no distingue esas dos cosas es
      // exactamente el falso verde que esta casa persigue, así que ahora se
      // le pregunta A LA BASE.
      return await sinResiduoDelSecreto();
    },
    necesita: 'base-de-datos',
  },
  {
    paquete: 'E0.1',
    enunciado: 'Un asiento posteado no admite UPDATE ni DELETE fuera de su lista blanca',
    evaluar: () => {
      // R1: la 033 blindó la bitácora y el mayor —lo que la bitácora
      // protege— seguía físicamente reescribible: un UPDATE balanceado sobre
      // una línea posteada no viola ningún CHECK y desalinea los saldos sin
      // rastro. La 041 pone el disparador condicional (lista blanca de
      // metadatos por resta de JSONB: una columna nueva nace protegida) en
      // las DOS tablas, más el candado de TRUNCATE.
      const m = 'src/database/migrations/041_el_mayor_inviolable.sql';
      if (!existe(m)) return falla('la 041 desapareció: el mayor vuelve a ser reescribible');
      const sql = crudoDe(m);
      const checks: Array<[boolean, string]> = [
        [/ON journal_entries\b[\s\S]{0,80}FOR EACH ROW/.test(sql) || /BEFORE UPDATE OR DELETE ON journal_entries/.test(sql), 'falta el disparador de journal_entries'],
        [/BEFORE UPDATE OR DELETE ON journal_entry_lines/.test(sql), 'falta el disparador de journal_entry_lines'],
        [(sql.match(/to_jsonb\(NEW\)\s*-\s*permitidas/g) ?? []).length >= 2, 'la comparación por resta de JSONB falta en alguna de las DOS funciones: una columna nueva nacería expuesta (la primera mutación de este criterio se escapó por contar una sola)'],
        [/BEFORE TRUNCATE ON journal_entries/.test(sql) && /BEFORE TRUNCATE ON journal_entry_lines/.test(sql), 'falta el candado de TRUNCATE'],
        [(sql.match(/RAISE EXCEPTION/g) ?? []).length >= 3, 'los disparadores no rechazan'],
      ];
      const roto = checks.find(([pasa]) => !pasa);
      return roto ? falla(roto[1]) : ok('el mayor posteado sólo admite su lista blanca de metadatos, en las dos tablas');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Los saldos materializados se verifican contra las líneas, y la deriva es fail',
    evaluar: () => {
      // R1: account_balances es tabla load-bearing del cierre y nada la
      // comprobaba contra Σ de líneas posteadas; doctor la vigila y —a
      // diferencia de la capacidad huérfana, informativa a propósito— aquí
      // fallar es 'fail': un mayor que no cuadra con sus líneas no opera.
      const d = codigoDe('src/ai/doctor-service.ts');
      if (!/checkLedgerIntegrity/.test(d)) {
        return falla('doctor perdió el chequeo de integridad del mayor');
      }
      const i = d.indexOf('function checkLedgerIntegrity');
      const cuerpo = d.slice(i, i + 3500);
      if (!/FULL OUTER JOIN/i.test(cuerpo) || !/status\s*=\s*'posted'/.test(cuerpo)) {
        return falla('el chequeo no compara account_balances contra Σ de líneas POSTEADAS por ambos lados');
      }
      if (!/level:\s*'fail'/.test(cuerpo)) {
        return falla('la deriva del mayor quedó degradada a warn: un número falso con aspecto de número');
      }
      return /checks\.push\(await checkLedgerIntegrity\(\)\)/.test(d)
        ? ok('doctor verifica saldos = Σ líneas y posteados con rastro, y la deriva es fail')
        : falla('el chequeo existe y runDoctor no lo corre');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'El posteo y el cierre no se cruzan: el candado del periodo vive en ambas transacciones',
    mutantes: [
      {
        archivo: 'src/services/accounting/posting.ts',
        de: 'bloquearPeriodoParaPostear(client',
        a: 'bloquearPeriodoParaPostearSin(client',
        porque: 'una de las dos transacciones suelta el candado: el conteo ×2 debe acusarlo',
      },
    ],
    evaluar: () => {
      // R1 (TOCTOU): la validación leía el periodo FUERA de la transacción
      // del posteo, y el checklist del cierre suave se fotografiaba FUERA de
      // la suya — un posteo en vuelo podía aterrizar en un periodo que
      // cerraba, con un checklist que no lo contaba. FOR SHARE (posteo) ×
      // FOR UPDATE (cierre) sobre la misma fila cierran la carrera.
      const p = codigoDe('src/services/accounting/posting.ts');
      const consumos = (p.match(/bloquearPeriodoParaPostear\(client/g) ?? []).length;
      if (!/FOR SHARE/.test(p) || consumos < 2) {
        return falla(
          `el posteo no toma el candado compartido del periodo en sus dos transacciones (consumos: ${consumos})`
        );
      }
      const c = codigoDe('src/services/accounting/period-close.ts');
      return /FOR UPDATE/.test(c) && /getPeriodCloseStatus\(periodId,\s*entityId,\s*client\)/.test(c)
        ? ok('FOR SHARE en el posteo (×2) y checklist bajo FOR UPDATE en el cierre suave')
        : falla('el cierre suave volvió a fotografiar el checklist fuera de su transacción');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'Ningún posteo paga el refresco de las vistas de reporte de todos',
    evaluar: () => {
      // R3 (decidido en el plan de cierre, ejecutado aquí): el trigger de la
      // 004 refrescaba DOS vistas globales —cross-join de todos los
      // inquilinos— dentro de cada transacción de posteo, serializando
      // posteos de inquilinos distintos entre sí. El orden de migraciones es
      // la verdad: el último acto sobre el trigger debe ser el DROP, y el
      // camino de reemplazo (refresh_reporting_views + report view sync +
      // detector de deriva) debe seguir vivo.
      const dir = 'src/database/migrations';
      const sql = fs
        .readdirSync(rutaDe(dir))
        .sort()
        .map((m) => crudoDe(dir, m))
        .join('\n');
      const ultimaCreacion = sql.lastIndexOf('CREATE TRIGGER trg_refresh_materialized_views');
      const ultimoDrop = sql.lastIndexOf('DROP TRIGGER IF EXISTS trg_refresh_materialized_views');
      if (ultimoDrop < 0 || ultimoDrop < ultimaCreacion) {
        return falla(
          'el trigger de refresco sigue vivo al final de la cadena de migraciones: cada posteo vuelve a pagar el reporte de todos'
        );
      }
      if (!/refresh_reporting_views/.test(sql)) {
        return falla('el refresco callable (031) desapareció: no queda camino de refresco');
      }
      return /refreshReportingViews/.test(codigoDe('src/cli/report-command.ts'))
        ? ok('el trigger cayó (042) y el refresco vive en el callable + report view sync + detector de deriva')
        : falla('el comando de refresco desapareció: las vistas sólo se refrescarían a mano por SQL');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'La serie del folio la fija la fecha del documento, no el reloj',
    evaluar: async () => {
      // R3: «JE-2026-00042» insinuaba serie anual y el año lo ponía el
      // reloj, con un contador que jamás se reiniciaba — un asiento de
      // diciembre capturado en enero salía en la serie del año nuevo
      // continuando la cuenta del viejo. Decidido ANTES del primer cruce de
      // ejercicio con datos reales.
      const s = codigoDe('src/utils/sequence.ts');
      // El tramo de nextEntityNumber en concreto: la firma de añoDeDocumento
      // también dice `fecha: Date | string` y dio verde a la mutación que
      // volvía opcional la fecha del folio — anclar al símbolo equivocado es
      // el primo del regex que casa el import.
      const iNext = s.indexOf('export async function nextEntityNumber');
      const tramoNext = iNext >= 0 ? s.slice(iNext, s.indexOf('export', iNext + 10)) : '';
      if (!/fecha:\s*Date \| string/.test(tramoNext)) {
        return falla('nextEntityNumber ya no exige la fecha del documento: el reloj vuelve a foliar');
      }
      if (!/\$\{name\}_\$\{año\}/.test(s)) {
        return falla('la llave del contador perdió el año: la serie vuelve a ser una sola cuenta eterna');
      }
      if (!/^\s*const m = \/\^\(\\d\{4\}\)-\\d\{2\}-\\d\{2\}\/\.exec/m.test(s) && !/exec\(String\(fecha\)/.test(s)) {
        return falla('añoDeDocumento dejó de leer la cadena sin pasar por Date: el 31-dic retrocede de año al oeste de Greenwich');
      }
      const m = 'src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql';
      if (!existe(m)) return falla('la 043 desapareció: los contadores anuales arrancarían en 1 y colisionarían con lo emitido');
      const siembra = crudoDe(m);
      const inserts = (siembra.match(/INSERT INTO entity_sequences/g) ?? []).length;
      if (inserts < 5 || !/GREATEST/.test(siembra)) {
        return falla(`la siembra de la 043 no cubre las cinco series (${inserts}) o perdió el GREATEST`);
      }
      // S3 · DE TEXTO A EFECTO, por la misma razón que la 040: la siembra
      // estaba escrita y había sembrado CERO contadores, que es lo que
      // provocó la colisión de folios real. Ahora se comprueba el estado.
      return await contadoresAnualesSembrados();
    },
    necesita: 'base-de-datos',
  },

  {
    paquete: 'E0.1',
    enunciado: 'El refresco de las materializadas ve el clúster entero, no el inquilino de la sesión',
    evaluar: () => {
      // R3, medido por el detector de deriva: con las 'm' reasignadas a
      // mnemosine_owner (NOBYPASSRLS, RLS forzada), REFRESH corría la
      // consulta definitoria con los lentes del inquilino casual de la
      // sesión — refresh_reporting_views() devolvía «hecho» y dejaba la
      // vista global VACÍA. El dueño de régimen de una materializada es
      // mnemosine_refresher: NOLOGIN (nadie se conecta con él) y BYPASSRLS
      // (el refresco ve a todos, que es su única función). Las planas
      // siguen con el operador: ésas SÍ re-corren su consulta al leerse.
      const prov = codigoDe('scripts/provision-roles.sql');
      const lineaRol = /CREATE ROLE mnemosine_refresher[^;]*;/.exec(prov)?.[0] ?? '';
      // (?<!NO)BYPASSRLS: «NOBYPASSRLS» contiene «BYPASSRLS» y un regex
      // ingenuo daría verde al mutante que apaga el bypass.
      if (!/NOLOGIN/.test(lineaRol) || !/(?<!NO)BYPASSRLS/.test(lineaRol)) {
        return falla('mnemosine_refresher perdió NOLOGIN o BYPASSRLS: el refresco vuelve a mirar por los lentes de un inquilino');
      }
      if (!/GRANT mnemosine_refresher TO mnemosine_owner/.test(prov)) {
        return falla('sin la membresía, refresh_reporting_views() (definer del operador) no pasa el chequeo de propiedad del REFRESH');
      }
      const pol = codigoDe('src/database/rls-policies.sql');
      if (!/'m' THEN 'mnemosine_refresher'/.test(pol) || !/ELSE 'mnemosine_owner'/.test(pol)) {
        return falla('el reconciliador dejó de repartir dueños por tipo: o la materializada refresca filtrada o la plana vuelve a leer sin RLS');
      }
      const ver = codigoDe('scripts/verify-isolation.sh');
      if (!/relkind = 'm'/.test(ver) || !/<> 'mnemosine_refresher'/.test(ver)) {
        return falla('verify-isolation dejó de comprobar el dueño de las materializadas');
      }
      return /CREATE ROLE mnemosine_refresher/.test(codigoDe('tests/integration/global-setup.ts'))
        ? ok('las «m» son del refresher (NOLOGIN+BYPASSRLS), las «v» del operador, y CI lo prueba de punta a punta')
        : falla('la base efímera de integración nace sin refresher: la suite dejaría de probar el refresco real');
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'El maker-checker vive en el panel y muerde solo la póliza manual',
    mutantes: [
      {
        archivo: 'src/services/accounting/posting.ts',
        de: "politica.value === 'exigir'",
        a: "politica.value === 'siempre'",
        porque: 'el lector deja de comparar contra el literal del panel: la política existiría sin morder',
      },
    ],
    evaluar: () => {
      // F01: la decisión §5 no se difirió tácitamente ni se decidió en
      // código — es política del panel (segregacion_de_funciones) con
      // default off, y su lector está DENTRO del motor de posteo: con
      // 'exigir', quien creó el borrador MANUAL no lo postea. Las pólizas
      // del sistema (source_type no nulo: nómina, ai_draft, reversas)
      // quedan exentas por construcción — ahí creador=posteador es
      // intencional y exigir separación produciría falsos positivos.
      const panel = codigoDe('src/services/policy/pending-catalog.ts');
      if (!/key: 'segregacion_de_funciones'/.test(panel) || !/'exigir'/.test(panel)) {
        return falla('la clave segregacion_de_funciones salió del panel: la decisión §5 vuelve a estar diferida tácitamente');
      }
      const p = codigoDe('src/services/accounting/posting.ts');
      const iPost = p.indexOf('export async function postJournalEntry');
      const tramo = iPost >= 0 ? p.slice(iPost, p.indexOf('export', iPost + 10)) : '';
      if (!/!entry\.source_type && entry\.created_by === userId/.test(tramo)) {
        return falla('la compuerta perdió su forma (manual + coincidencia): o muerde a nómina/reversas o dejó de morder');
      }
      if (!/politica\.value === 'exigir'/.test(tramo) || !/SOD_QUIEN_CREA_NO_POSTEA/.test(tramo)) {
        return falla('el lector dejó de comparar contra el literal exigir o perdió su código de dominio');
      }
      if (!/'SOD_QUIEN_CREA_NO_POSTEA'/.test(codigoDe('src/cli/entry-command.ts'))) {
        return falla('el rechazo SoD dejó de salir como BLOQUEADO (5): se leería como entrada inválida');
      }
      // El huérfano pagado: checkSoDViolations con LLAMADA real en doctor
      // (composición de permisos), y el check enchufado a runDoctor.
      // El push, no el nombre: la FIRMA de checkPermisosEnConflicto() también
      // casa `nombre()` — cuarta aparición del regex que muerde el símbolo
      // equivocado en esta serie de sprints.
      const doctor = codigoDe('src/ai/doctor-service.ts');
      return /checkSoDViolations\(permisos\)/.test(doctor) &&
        /checks\.push\(await checkPermisosEnConflicto\(\)\)/.test(doctor)
        ? ok('panel + lector en el motor (solo manual), salida bloqueada, y la composición de permisos vigilada en doctor')
        : falla('checkSoDViolations volvió a quedarse sin consumidor o el check salió de runDoctor');
    },
  },

  {
    paquete: 'E0.1',
    enunciado: 'El espejo del CFDI es por entidad y el estatus SAT dice la verdad',
    evaluar: () => {
      // F02: la unicidad fiscal era GLOBAL (005) y mataba el caso normal de
      // un despacho — las dos partes de la operación como clientes, el mismo
      // XML entrando como 'emitido' y como 'recibido'. Y el estatus SAT era
      // un «Vigente» simulado: un CFDI cancelado se clasificaba vigente. La
      // 046 vuelve la unicidad (entity_id, cfdi_uuid) — y respalda xml_hash
      // en esquema —, el dedupe filtra por entidad en sus DOS sitios, y el
      // estatus sale del ConsultaCFDIService real (público y anónimo:
      // ningún bloqueo de E3.x le aplicó jamás), con apagado que LO DICE.
      const m = 'src/database/migrations/046_el_espejo_del_cfdi.sql';
      if (!existe(m)) return falla('la 046 desapareció: la unicidad fiscal vuelve a ser global');
      const sql = crudoDe(m);
      if (!/DROP CONSTRAINT xml_documents_cfdi_uuid_key/.test(sql) ||
          // \b tras el nombre: un sufijo _x seguiría casando el regex desnudo
          // — quinta variante de la familia del ancla en estos sprints.
          !/uq_xml_documents_entity_cfdi\b[\s\S]{0,80}\(entity_id, cfdi_uuid\)/.test(sql) ||
          !/uq_xml_documents_entity_hash\b[\s\S]{0,80}\(entity_id, xml_hash\)/.test(sql)) {
        return falla('la 046 perdió una de sus tres piezas (drop global, unique uuid, unique hash)');
      }
      const dedupe = /WHERE entity_id = \$1 AND \(cfdi_uuid = \$2 OR xml_hash = \$3\)/;
      if (!dedupe.test(codigoDe('src/services/xml-ingestion/pre-registration-service.ts'))) {
        return falla('el dedupe del registro dejó de filtrar por entidad: el espejo vuelve a chocar');
      }
      const ingest = codigoDe('src/ai/ingest-service.ts');
      const iPrev = ingest.indexOf('export async function previewCfdiFiles');
      const tramoPrev = iPrev >= 0 ? ingest.slice(iPrev, iPrev + 2500) : '';
      if (!/entityId: string/.test(tramoPrev) || !dedupe.test(tramoPrev)) {
        return falla('previewCfdiFiles perdió la entidad: su veredicto de duplicado sería mentira');
      }
      const stub = codigoDe('src/services/xml-ingestion/sat-validation.ts');
      if (/'Vigente'/.test(stub)) {
        return falla('sat-validation volvió a fabricar un Vigente: un cancelado se clasificaría vigente');
      }
      if (!/consultaCfdi\(/.test(stub)) {
        return falla('sat-validation dejó de delegar en el cliente real');
      }
      const cliente = codigoDe('src/services/sat/cfdi-status.ts');
      return /IConsultaCFDIService\/Consulta/.test(cliente) &&
        /toFixed\(6\)/.test(cliente) && /'DISABLED'/.test(cliente)
        ? ok('unicidad (entidad, uuid) con hash respaldado, dedupe escopado en los dos sitios, y el SOAP real con apagado honesto')
        : falla('el cliente SAT perdió el sobre, el relleno del total o el apagado que lo dice');
    },
  },

  {
    paquete: 'E0.2',
    enunciado: 'La capacidad huérfana conocida sólo encoge',
    evaluar: () => {
      // S1: §7 prometía «doctor sin huérfanos nuevos entra como criterio» y
      // el criterio no existía — mientras tanto, cuatro exports vivían sin un
      // solo llamador de producción, incluido uno en la capa más delicada
      // (autoApproveDraftByPolicy, con docstring que afirmaba en falso ser el
      // camino de la ingesta). El patrón es la línea base del auditor: la
      // lista CONGELA los huérfanos conocidos y sólo puede encoger — un
      // export que gana consumidor obliga a borrar su línea, y borrar la
      // línea es el registro de que la deuda se pagó (o el export se retiró).
      //
      // Los huérfanos NUEVOS los barre doctor a nivel capacidad (nunca fail);
      // esta lista fija los conocidos para que cerrarlos sea visible y
      // olvidarlos imposible. Destinos: calculateBenefitsForPaycheck → F08;
      // checkSoDViolations → decisión §5 (maker-checker);
      // autoApproveDraftByPolicy → A3 (un solo autorizador).
      //
      // PAGADO EN F04: earlyPaymentDiscount. Llevaba sin llamador desde que se
      // retiró el programador de pagos que lo usaba, mientras el descuento por
      // pronto pago se aceptaba a ojo en el otro extremo del sistema. Ahora es
      // quien decide cuánto descuento CONCEDEN las condiciones del gasto, y
      // tomar más que eso se rechaza señalando `--mode residual`. Su línea se
      // borra aquí, que es el registro de que la deuda se pagó.
      const HUERFANOS_CONGELADOS: Record<string, string> = {
        // El gemelo del que pagó en A3: mismo motor (matchApproval), brazo
        // external_op. Su consumidor llega con el ejecutor DESATENDIDO del
        // outbox (hoy `outbox run` es humano y no necesita política).
        autoExecuteOpByPolicy: 'external-service.ts',
        calculateBenefitsForPaycheck: 'benefits-service.ts',
      };
      const conConsumidor = Object.entries(HUERFANOS_CONGELADOS)
        .filter(([simbolo, archivo]) => consumidoresDe(simbolo, archivo).length > 0)
        .map(([simbolo]) => simbolo);
      return conConsumidor.length === 0
        ? ok(`${Object.keys(HUERFANOS_CONGELADOS).length} huérfanos congelados, ninguno resuelto aún`)
        : falla(
            `ya tienen consumidor — borra su línea de HUERFANOS_CONGELADOS: ${conConsumidor.join(', ')}`
          );
    },
  },

  // ---- E0.2 · Contrato código ↔ esquema ----
  {
    paquete: 'E0.2',
    enunciado: 'El escáner resuelve columnas calificadas por alias, no sólo consultas de una tabla',
    evaluar: () => {
      const p = 'tests/integration/helpers/sql-scan.ts';
      if (!existe(p)) return falla('no existe el escáner');
      return /columnasCalificadas/.test(codigoDe(p))
        ? ok('cubre consultas con alias y JOIN')
        : falla('el escáner sólo mira SELECT de una tabla sin alias: un p.columna_inexistente pasa en verde');
    },
  },
  {
    paquete: 'E0.2',
    enunciado: 'Ninguna consulta nombra la tabla `entities`, que no existe',
    evaluar: () => {
      const hits = dondeAparece(/\b(?:FROM|JOIN|INTO|UPDATE)\s+entities\b/i, ['src'], true);
      return hits.length === 0
        ? ok('cero referencias')
        : falla(`${hits.length} archivo(s): ${hits.slice(0, 3).join(', ')}`);
    },
  },
  {
    paquete: 'E0.2',
    // Nació como el único criterio NO EVALUABLE de los quince paquetes, y su
    // detalle nombraba cinco «divergencias conocidas» — una de ellas mal, era
    // matched_entity_type y no match_type. E0.2-j las cerró todas y creó lo
    // que faltaba para poder medir: un censo que dice a QUÉ COLUMNA pertenece
    // cada vocabulario. Sin ese dato la comparación es imposible; con él es
    // aritmética.
    //
    // No nombra ningún archivo: persigue la FORMA del censo, no su ubicación.
    // Si alguien lo mueve o lo parte en dos, el criterio lo sigue.
    enunciado: 'Ningún vocabulario del código admite un valor que el CHECK rechaza ni esconde uno que admite',
    evaluar: () => {
      const literales = (s: string): string[] =>
        [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

      // Los CHECK, leídos de las migraciones EN ORDEN: la base contra la que
      // corre la suite de integración se construye ejecutándolas así, y dos
      // columnas se redefinen más tarde (journal_entries.entry_type, en 023 y
      // 025). Gana la última, igual que en Postgres.
      const dir = 'src/database/migrations';
      const enElEsquema = new Map<string, string[]>();
      for (const f of fs.readdirSync(rutaDe(dir)).filter((n) => n.endsWith('.sql')).sort()) {
        const sql = crudoDe(dir, f).replace(/--[^\n]*/g, '');
        const anota = (tabla: string, columna: string, lista: string): void => {
          const valores = literales(lista);
          if (valores.length) enElEsquema.set(`${tabla.replace(/^public\./i, '')}.${columna}`, valores);
        };
        for (const t of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(([\s\S]*?)\n\);/gi)) {
          for (const c of t[2].matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi)) anota(t[1], c[1], c[2]);
        }
        // `[^;]*?` y no `[\s\S]*?`: con el segundo, un ALTER sin CHECK se
        // engancha al CHECK de otra tabla más abajo del archivo y le atribuye
        // un vocabulario ajeno. Costó tres atribuciones falsas descubrirlo.
        //
        // Y `ADD (CONSTRAINT|COLUMN)`, no sólo CONSTRAINT: un vocabulario
        // puede nacer con su columna en el mismo ALTER —
        // `ADD COLUMN account_type VARCHAR(20) ... CHECK (account_type IN (...))`—
        // y ésa es la tercera forma de declarar un CHECK que este criterio no
        // leía. El síntoma era el contrario del defecto: la 051 censó
        // `bank_accounts.account_type` correctamente y el criterio la acusó de
        // «vocabulario declarado sin decir de qué columna es», porque su
        // columna no existía en el esquema QUE ÉL SABE LEER. Un criterio que
        // no reconoce una sintaxis válida no protege menos: acusa en falso.
        for (const a of sql.matchAll(
          /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.]+)[^;]*?ADD\s+(?:CONSTRAINT|COLUMN)[^;]*?CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/gi
        )) {
          anota(a[1], a[2], a[3]);
        }
      }
      if (enElEsquema.size < 20) {
        return noEvaluable(
          `sólo se leyeron ${enElEsquema.size} CHECK de vocabulario en las migraciones: ` +
            'ya no tienen la forma que este criterio sabe leer'
        );
      }

      // El censo: una terna (tabla, columna, CONSTANTE). Es el único dato que
      // hace comparable un vocabulario, porque `status` tiene CHECK en 37
      // tablas distintas y adivinar por el nombre de la columna produce más de
      // cien falsos positivos.
      const TERNA = /'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*([A-Z][A-Z0-9_]*)\s*\)/;
      const declarado = new Map<string, string[]>();
      const sinCensar: string[] = [];
      for (const archivo of dondeAparece(TERNA, ['src'], true)) {
        const codigo = codigoDe(archivo);
        const constantes = new Map<string, string[]>();
        for (const c of codigo.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[([^\]]*)\]\s*as\s+const/g)) {
          constantes.set(c[1], literales(c[2]));
        }
        const censadas = new Set<string>();
        for (const t of codigo.matchAll(new RegExp(TERNA, 'g'))) {
          const clave = `${t[1]}.${t[2]}`;
          if (!enElEsquema.has(clave)) continue;
          censadas.add(t[3]);
          declarado.set(clave, constantes.get(t[3]) ?? []);
        }
        // Declarar la constante y no censarla la deja fuera de vigilancia sin
        // que nada lo note: es la forma silenciosa de volver al problema.
        if (censadas.size > 0) {
          for (const nombre of constantes.keys()) {
            if (!censadas.has(nombre)) sinCensar.push(`${archivo}:${nombre}`);
          }
        }
      }
      if (declarado.size === 0) {
        return falla(
          'ninguna parte del código dice a qué columna pertenece un vocabulario: ' +
            'cada validador guarda su copia a mano y nada la compara con el CHECK'
        );
      }

      // Los dos sentidos, porque fallan distinto: de más es un 500 en la cara
      // del usuario, de menos es una capacidad que existe y nadie alcanza.
      const problemas: string[] = [];
      for (const [clave, valores] of declarado) {
        const reales = enElEsquema.get(clave)!;
        const sobran = valores.filter((x) => !reales.includes(x));
        const faltan = reales.filter((x) => !valores.includes(x));
        if (sobran.length) {
          problemas.push(
            `${clave} acepta ${sobran.join(', ')} que el CHECK rechaza: Postgres lanza 23514 y el usuario ve un 500`
          );
        }
        if (faltan.length) {
          problemas.push(
            `${clave} esconde ${faltan.join(', ')} que el CHECK admite: esa capacidad existe en la base y es inalcanzable`
          );
        }
      }
      if (problemas.length) return falla(problemas.slice(0, 4).join(' · '));
      if (sinCensar.length) {
        return falla(
          `vocabulario declarado sin decir de qué columna es, así que nada lo compara: ${sinCensar.join(', ')}`
        );
      }
      return ok(
        `${declarado.size} vocabularios coinciden exactamente con su CHECK, ` +
          `de ${enElEsquema.size} leídos de las migraciones`
      );
    },
  },

  // ---- E0.3 · Bitácora de auditoría ----
  {
    paquete: 'E0.3',
    enunciado: 'El motor de posteo deja rastro en la misma transacción que el asiento',
    evaluar: () => {
      const p = 'src/services/accounting/posting.ts';
      const s = codigoDe(p);
      const n = (s.match(/registrarAuditoria/g) ?? []).length;
      return n >= 4
        ? ok(`${n} puntos de auditoría en posting.ts`)
        : falla(`sólo ${n}: un asiento creado por la CLI o el agente no deja rastro`);
    },
  },
  {
    paquete: 'E0.3',
    enunciado: 'La bitácora no se puede reescribir: UPDATE y DELETE fallan en Postgres',
    evaluar: () => {
      const migs = fs.readdirSync(rutaDe('src/database/migrations'));
      const protege = migs.some((m) => {
        const s = crudoDe('src/database/migrations', m);
        return /audit_log/.test(s) && /(REVOKE|CREATE RULE|BEFORE UPDATE OR DELETE)/i.test(s);
      });
      return protege
        ? ok('una migración revoca la reescritura')
        : falla('ninguna migración protege audit_log: el rastro es borrable');
    },
  },
  {
    paquete: 'E0.3',
    enunciado:
      'Toda bitácora de sólo agregar lleva disparador, y la lista de privilegios la refleja',
    evaluar: () => {
      // Este criterio existe porque el anterior no bastaba, y la forma en que
      // no bastaba es instructiva: `/audit_log/ && /REVOKE/` da verde con un
      // archivo que sólo REVOCA. La migración 014 hacía exactamente eso sobre
      // fiscal_credential_access_log —y sólo FROM PUBLIC, que no toca el GRANT
      // explícito a mnemosine_app—, así que un criterio calcado habría
      // declarado protegida una bitácora que cualquiera podía reescribir.
      //
      // Aquí se exige la capa que aguanta: el disparador. Y se cruzan las TRES
      // listas que hoy tienen que decir lo mismo y que nadie comparaba:
      //   · las tablas con disparador, leídas de las migraciones;
      //   · el array `append_only` de rls-policies.sql, que corre DESPUÉS de
      //     todas las migraciones y devuelve la escritura a lo que no esté;
      //   · el mismo array en scripts/provision-roles.sql, cuyo GRANT sobre
      //     ALL TABLES la devuelve otra vez en cada reprovisionado.
      // Una tabla con disparador que falte de cualquiera de los dos arrays
      // pierde la capa barata en silencio; un nombre en un array sin
      // disparador es una protección que sólo existe en la lista.
      //
      // El SQL se lee SIN comentarios. `codigoDe` no sirve aquí: su
      // `sinComentarios` quita `/* */` y `//` —los de TypeScript— y deja
      // pasar `--`, que es el de SQL. Con la versión anterior, comentar la
      // tabla dentro del array bastaba para que este criterio siguiera en
      // verde mientras Postgres la dejaba fuera. Se comprobó ejecutándolo.
      const sinComentariosSql = (t: string): string =>
        t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

      const dir = 'src/database/migrations';
      const sql = sinComentariosSql(
        fs
          .readdirSync(rutaDe(dir))
          .map((m) => crudoDe(dir, m))
          .join('\n')
      );

      // Se aceptan las formas equivalentes que Postgres acepta: `CREATE OR
      // REPLACE TRIGGER`, el nombre de tabla entrecomillado, y los eventos en
      // cualquier orden. Exigir la secuencia literal `UPDATE OR DELETE` ponía
      // en rojo código correcto escrito `DELETE OR UPDATE`, que es el modo en
      // que un criterio deja de creerse y se desactiva.
      const eventos = new Map<string, Set<string>>();
      const funcionDe = new Map<string, Set<string>>();
      const RE_TRIGGER =
        /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?\w+"?\s+BEFORE\s+([A-Za-z\s]+?)\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*?);/gi;
      for (const m of sql.matchAll(RE_TRIGGER)) {
        const tabla = m[2];
        const evs = m[1].toUpperCase().split(/\s+OR\s+/).map((e) => e.trim());
        const set = eventos.get(tabla) ?? new Set<string>();
        for (const e of evs) set.add(e);
        eventos.set(tabla, set);
        const fn = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?/i.exec(m[3]);
        if (fn) {
          const fns = funcionDe.get(tabla) ?? new Set<string>();
          fns.add(fn[1]);
          funcionDe.set(tabla, fns);
        }
      }

      // «Hay disparador» y «el disparador rechaza» son cosas distintas: uno
      // cuyo cuerpo hiciera `RETURN NEW` satisfaría lo primero y no protegería
      // nada. Se exige que la función que cuelga del disparador levante
      // excepción — Y que rechace SIEMPRE: desde la 041 (R1) existe una
      // segunda clase de protección, la inmutabilidad CONDICIONAL del mayor
      // (rechaza lo posteado, deja pasar el resto con RETURN NEW). Esa clase
      // NO es una bitácora de sólo-agregar y no debe entrar a los arrays
      // append_only, que le revocarían el UPDATE que el posteo necesita. El
      // discriminador es estructural: una función de sólo-agregar no tiene
      // ningún camino que devuelva NEW.
      const rechaza = (fn: string): boolean => {
        const i = new RegExp(
          `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?`,
          'i'
        ).exec(sql);
        if (i === null) return false;
        const cuerpo = sql.slice(i.index, i.index + 2000);
        return /RAISE\s+EXCEPTION/i.test(cuerpo) && !/RETURN\s+NEW/i.test(cuerpo);
      };

      const protegidas = new Set<string>();
      const parciales: string[] = [];
      for (const [tabla, evs] of eventos) {
        const completa =
          evs.has('UPDATE') && evs.has('DELETE') && evs.has('TRUNCATE');
        const fns = [...(funcionDe.get(tabla) ?? [])];
        const muerden = fns.length > 0 && fns.every(rechaza);
        if (completa && muerden) {
          protegidas.add(tabla);
        } else if (evs.has('UPDATE') || evs.has('DELETE')) {
          // Sólo se reporta lo que PARECE una bitácora cerrada y no lo está.
          // Un disparador BEFORE UPDATE cualquiera —hay varios de
          // `updated_at`— no entra aquí porque su función no levanta excepción.
          if (muerden) {
            parciales.push(
              `${tabla}: rechaza ${[...evs].sort().join('/')} pero le falta ` +
                `${['UPDATE', 'DELETE', 'TRUNCATE'].filter((e) => !evs.has(e)).join(' y ')}` +
                (evs.has('TRUNCATE') ? '' : ' — un TRUNCATE no dispara triggers de fila')
            );
          }
        }
      }
      if (parciales.length > 0) return falla(parciales.join('; '));
      if (protegidas.size === 0) {
        return falla('ninguna tabla lleva disparador de sólo-agregar que rechace');
      }

      const arrayDe = (rel: string): Set<string> | null => {
        const txt = sinComentariosSql(crudoDe(rel));
        const m = /append_only\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(txt);
        if (!m) return null;
        return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
      };

      const fuentes: Array<{ rel: string; porque: string }> = [
        {
          rel: 'src/database/rls-policies.sql',
          porque: 'corre después de migrar y su GRANT general les devuelve la escritura',
        },
        {
          rel: 'scripts/provision-roles.sql',
          porque: 'su GRANT sobre ALL TABLES se la devuelve en cada reprovisionado',
        },
      ];

      const problemas: string[] = [];
      for (const f of fuentes) {
        const lista = arrayDe(f.rel);
        if (!lista) {
          problemas.push(`${f.rel}: no se encontró el array append_only — ${f.porque}`);
          continue;
        }
        const faltan = [...protegidas].filter((t) => !lista.has(t));
        const sobran = [...lista].filter((t) => !protegidas.has(t));
        if (faltan.length > 0) {
          problemas.push(`${f.rel}: falta ${faltan.join(', ')} — ${f.porque}`);
        }
        if (sobran.length > 0) {
          problemas.push(
            `${f.rel}: nombra ${sobran.join(', ')} sin disparador que lo respalde ` +
              '(el dueño del esquema ignora los privilegios de tabla)'
          );
        }
      }
      if (problemas.length > 0) return falla(problemas.join('; '));

      return ok(
        `${protegidas.size} bitácoras con disparador que rechaza y las dos listas de ` +
          `privilegios al día: ${[...protegidas].sort().join(', ')}`
      );
    },
  },
  {
    paquete: 'E0.3',
    enunciado: 'La bitácora no guarda en claro lo que las tablas cifran',
    evaluar: () => {
      // S1: el middleware de auditoría escribía JSON.stringify(req.body)
      // entero en audit_log.new_values — un alta de empleado dejaba ssn y
      // bank_account EN CLARO en la única tabla que, por diseño de la 033,
      // no admite remediación. Lo que se exige: el stringify crudo no existe
      // y la redacción cubre, como mínimo, los campos que los servicios
      // cifran hoy (ssn, clabe, bank_account*, password, key/cer).
      const m = codigoDe('src/api/rest/middleware/audit.ts');
      if (/JSON\.stringify\(req\.body\)/.test(m)) {
        return falla('el middleware volvió al stringify crudo: los secretos vuelven a la bitácora inmutable');
      }
      if (!/redactarSensibles/.test(m)) {
        return falla('no hay redacción en el middleware de auditoría');
      }
      const minimos = ['ssn', 'clabe', 'bank_account', 'password', 'key', 'cer'];
      const faltan = minimos.filter((c) => !new RegExp(`'${c}'`).test(m));
      return faltan.length === 0
        ? ok('el cuerpo se redacta antes de tocar la bitácora, con los campos cifrados cubiertos')
        : falla(`la lista de redacción no cubre: ${faltan.join(', ')} — un campo que se cifra en tabla no puede viajar en claro al rastro`);
    },
  },
  {
    paquete: 'E0.3',
    enunciado: 'Los ciclos de vida del dinero dejan su propio rastro, no sólo su asiento',
    evaluar: () => {
      // R1: emitir/anular una factura, aprobar la del proveedor y registrar
      // un pago sólo auditaban su asiento derivado — «quién emitió» o «quién
      // registró el pago» no estaba en ninguna parte. Los tres servicios
      // escriben registrarAuditoria DENTRO de sus transacciones existentes.
      const consumidores = consumidoresDe('registrarAuditoria', 'audit-log.ts');
      const exigidos = [
        'src/services/ar/invoice-service.ts',
        'src/services/ap/bill-service.ts',
        'src/services/payments/payment-service.ts',
      ];
      const faltan = exigidos.filter((f) => !consumidores.includes(f));
      return faltan.length === 0
        ? ok(`el rastro cubre los ciclos de vida (${consumidores.length} escritores en total)`)
        : falla(`ciclos de vida sin rastro propio: ${faltan.join(', ')}`);
    },
  },

  // ---- E1.1 · Roles de cuenta ----
  {
    paquete: 'E1.1',
    enunciado: 'Toda ruta de alta de entidad siembra los roles, no sólo el asistente',
    evaluar: () => {
      if (!existe('src/services/entity/entity-service.ts')) {
        return falla('crear una entidad sigue siendo privado del asistente init');
      }
      const s = codigoDe('src/services/entity/entity-service.ts');
      return /ensureEntityAccounting/.test(s)
        ? ok('el servicio de alta siembra catálogo y roles')
        : falla('entity-service no siembra la contabilidad de la entidad');
    },
  },
  {
    paquete: 'E1.1',
    enunciado:
      'Las cuatro cuentas de IVA se siembran en toda entidad MEXICANA, también sobre catálogo importado',
    mutantes: [
      {
        archivo: 'src/services/xml-ingestion/account-roles-seed.ts',
        de: "code: '1135', name: 'IVA Pendiente de Acreditar'",
        a: "code: '1136', name: 'IVA Pendiente de Acreditar'",
        porque:
          'el IVA de una factura PPD se queda sin cuenta donde esperar al pago; el mutante ' +
          'renumera en vez de borrar porque borrar el renglón entero también movería otras ' +
          'anclas, y un espejo debe fallar por la razón que dice',
      },
    ],
    evaluar: async () => {
      // El enunciado decía «siempre» y se volvió falso el día que la siembra
      // empezó a ramificar por país: una entidad estadounidense ya no recibe
      // cuentas de IVA, y debe ser así. Pero el criterio no se relaja, se
      // AFINA — lo que protegía sigue protegido y ahora además se comprueba
      // que la ramificación no se lleve por delante el caso mexicano, que es
      // el 100% de los clientes de este producto.
      const s = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      const faltan = ['1130', '1135', '2120', '2125'].filter(
        (c) => !new RegExp(`code:\\s*'${c}'`).test(s)
      );
      if (faltan.length > 0) {
        return falla(
          `no se siembran: ${faltan.join(', ')} — una entidad onboardeada revienta con MISSING_ROLE_ACCOUNT`
        );
      }
      // Y que sigan llegando a una entidad mexicana pese al filtro por país.
      // Sin esto, marcar los cuatro códigos como fiscales-mexicanos-y-fuera
      // dejaría el criterio en verde con las cuentas fuera del catálogo.
      const { cuentasRequeridasPara } = await import(
        '../services/xml-ingestion/account-roles-seed.js'
      );
      const mexicanas = new Set(cuentasRequeridasPara(true).map((a) => a.code));
      const perdidas = ['1130', '1135', '2120', '2125'].filter((c) => !mexicanas.has(c));
      return perdidas.length === 0
        ? ok('1130, 1135, 2120 y 2125 declaradas y entregadas a toda entidad mexicana')
        : falla(
            `${perdidas.join(', ')} están declaradas pero el filtro por país no se las entrega ` +
              'a una entidad mexicana: el IVA dejaría de acreditarse'
          );
    },
  },

  {
    paquete: 'E1.1',
    enunciado: 'Un código de cuenta significa UNA cuenta en todas las semillas',
    mutantes: [
      {
        archivo: 'src/services/payroll/common/payroll-account-mapping-seed.ts',
        de: "code: '6110', name: 'Sueldos y Salarios'",
        a: "code: '5200', name: 'Sueldos y Salarios'",
        porque:
          'devolver la nómina al código de las devoluciones sobre compras es EL fallo que ' +
          'este criterio vino a impedir: el sueldo bruto cargado a un contra-costo acreedor',
      },
      {
        archivo: 'src/services/accounting/chart-seed.ts',
        de: "code: '6110', name: 'Sueldos y Salarios'",
        a: "code: '6110', name: 'Nomina'",
        porque:
          'la colisión tiene dos lados y el criterio debe morder por los dos: renombrar la ' +
          'cuenta del catálogo base sin tocar las otras semillas es la mitad que un espejo ' +
          'de un solo sentido bendeciría',
      },
    ],
    evaluar: () => {
      // EL FALLO QUE ESTE CRITERIO PERSIGUE. Cuatro semillas escriben en el
      // catálogo de la MISMA entidad —el catálogo base, los roles del CFDI, el
      // mapeo de nómina y el sembrador de `npm run seed`— y las tres que
      // corren después se guardan de pisar a la anterior COMPARANDO CÓDIGOS:
      // `if (byCode.has(spec.code)) continue`. La guarda funciona; lo que no
      // vigila nadie es que dos semillas llamen cosas distintas al mismo
      // número. Cuando pasa, la segunda no crea su cuenta, hereda la ajena, y
      // el error es de SIGNIFICADO: no hay excepción, no hay fila de más, y
      // UNIQUE(code, entity_id) tampoco puede acusarlo porque desde la base
      // sólo hay una cuenta con ese código, que es justo lo que exige.
      //
      // Ocurrió con seis códigos a la vez: 5200 mandaba el sueldo bruto a
      // «Devoluciones y Descuentos sobre Compras», y 2150/2160/2170/2180
      // repartían los pasivos de nómina entre anticipos de clientes, sueldos
      // por pagar e IEPS.
      //
      // El criterio DESCUBRE los catálogos en vez de enumerarlos: la lección
      // que este archivo ya pagó una vez es que un detector de clases
      // enumeradas sólo ve las clases que enumeró, y una quinta semilla
      // añadida mañana tiene que quedar vigilada sin tocar esto.
      const decl = /code:\s*'([^']+)'\s*,\s*name:\s*'([^']*)'/g;
      const porCodigo = new Map<string, Map<string, string[]>>();
      for (const f of fuentes('src')) {
        // Por el seam (crudoDe) y no por fs directo: una lectura que lo rodea
        // deja el criterio fuera del arnés de mutación, y un criterio que
        // ningún mutante puede matar es prosa con forma de compuerta.
        const rel = path.relative(RAIZ, f);
        const texto = sinComentarios(crudoDe(rel));
        decl.lastIndex = 0;
        for (const m of texto.matchAll(decl)) {
          const [, codigo, nombre] = m;
          const nombres = porCodigo.get(codigo) ?? new Map<string, string[]>();
          nombres.set(nombre, [...(nombres.get(nombre) ?? []), rel]);
          porCodigo.set(codigo, nombres);
        }
      }
      if (porCodigo.size === 0) {
        return noEvaluable('ninguna fuente declara pares código/nombre de cuenta');
      }

      // La comparación es TOTAL, también entre el catálogo mexicano y el
      // estadounidense, que hoy no coexisten en una misma entidad. Es a
      // propósito y tiene precio: obliga a que MX y EE. UU. no compartan
      // número aunque podrían. A cambio, el criterio no necesita un modelo de
      // qué semillas son mutuamente excluyentes —el modelo que estaba mal era
      // justamente ése: `ensureEntityAccounting` siembra el catálogo base
      // mexicano en TODA entidad, país incluido o no— y la regla que enuncia
      // se puede leer sin saberse el pipeline: un número, un nombre.
      const choques = [...porCodigo.entries()]
        .filter(([, nombres]) => nombres.size > 1)
        .map(([codigo, nombres]) => {
          const partes = [...nombres.entries()].map(
            ([nombre, archivos]) => `«${nombre}» (${[...new Set(archivos)].join(', ')})`
          );
          return `${codigo}: ${partes.join(' vs ')}`;
        });

      return choques.length === 0
        ? ok(`${porCodigo.size} códigos de cuenta declarados, cada uno con un solo nombre`)
        : falla(
            `${choques.length} código(s) con dos significados — la semilla que corre después ` +
              `no crea su cuenta y hereda la ajena, sin error: ${choques.join(' · ')}`
          );
    },
  },

  // ---- E1.2 · Cerebro fiscal del CFDI ----
  {
    paquete: 'E1.2',
    enunciado: 'El IVA de un documento PPD se aparca y sólo el pago lo acredita',
    evaluar: () => {
      if (!existe('src/services/accounting/iva-cash-basis.ts')) {
        return falla('no existe el módulo de IVA sobre flujo');
      }
      const arap = codigoDe('src/services/accounting/ar-ap-posting.ts');
      return /iva-cash-basis/.test(arap)
        ? ok('el posteo de AR/AP consulta el método de pago')
        : falla('ar-ap-posting acredita el IVA al facturar: la declaración mensual no va a cuadrar');
    },
  },
  {
    paquete: 'E1.2',
    enunciado: 'No se libera IVA que el documento nunca aparcó',
    evaluar: () => {
      const p = 'src/services/accounting/iva-cash-basis.ts';
      if (!existe(p)) return falla('no existe el módulo');
      return /ivaStillParked/.test(codigoDe(p))
        ? ok('la liberación se topa contra lo realmente aparcado')
        : falla('una factura anterior al corte abonaría por segunda vez y dejaría la cuenta pendiente en negativo');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'El cerebro fiscal deja el rastro que prometió',
    evaluar: () => {
      // ROJO HONESTO NUEVO. E1.2 figura cerrado porque sus criterios miden la
      // decisión (PUE/PPD, las cuentas puente) — y esa parte es real. Pero la
      // salida prometida «queda rastro en cfdi_classifications» no ocurrió
      // jamás: la tabla existe desde la migración 015 y tiene CERO menciones
      // en src. Una clasificación que no se persiste no se puede auditar ni
      // reprocesar, y la fila del catálogo que la exige no se puede construir
      // encima de nada. F02 decide: escribirla o retirar la tabla — y este
      // criterio cambia con esa decisión, no antes.
      const escritor = dondeAparece(/INSERT\s+INTO\s+cfdi_classifications\b/i, ['src'], true);
      return escritor.length > 0
        ? ok(`el rastro se escribe desde ${escritor.join(', ')}`)
        : falla(
            'cfdi_classifications: creada en la migración 015, prometida como rastro del ' +
              'clasificador, y con cero menciones en src — la clasificación no se persiste'
          );
    },
  },


  // ---- E1.3 · Políticas con consumidor ----
  {
    paquete: 'E1.3',
    // La versión anterior de este criterio preguntaba si `getPolicy` tenía
    // llamadores. Es un proxy, y uno malo: se puede llamar getPolicy una vez y
    // dejar nueve políticas muertas, y el criterio quedaría en verde. Lo que
    // importa es lo otro — que contestar una política cambie algo.
    enunciado: 'Contestar una política cambia el comportamiento de alguien',
    evaluar: () => {
      const catalogo = rutaDe('src', 'services', 'policy', 'pending-catalog.ts');
      if (!fs.existsSync(catalogo)) return noEvaluable('no existe el catálogo de políticas');
      const claves = [...leer(catalogo).matchAll(/key:\s*'([a-z0-9_]+)'/g)]
        .map((m) => m[1]);
      if (claves.length === 0) return noEvaluable('el catálogo no declara ninguna clave legible');

      // El módulo de políticas y las pantallas que las PREGUNTAN no cuentan
      // como consumidores: presentar la pregunta no es usar la respuesta.
      const preguntan = [
        path.join('src', 'services', 'policy'),
        path.join('src', 'cli', 'init', 's4-policies.ts'),
        path.join('src', 'cli', 'pending-command.ts'),
      ];
      const ajeno = (f: string): boolean => !preguntan.some((pre) => f.startsWith(pre));

      // Primero lo exacto: consumir una política es pasar su clave a un LECTOR.
      // Si nadie llama a un lector, ninguna clave se lee, y contarlas una por
      // una sólo puede producir falsos verdes.
      const lectores = dondeAparece(/\bgetPolicy(Number)?\s*\(/, ['src'], true).filter(ajeno);
      if (lectores.length === 0) {
        return falla(
          `ninguna de las ${claves.length} políticas se lee: nadie llama a getPolicy ` +
            `fuera del módulo, así que el catálogo entero es decorativo`
        );
      }

      // Y «leída» significa DENTRO de una llamada a un lector, no que la
      // cadena aparezca en alguna parte. El falso verde que esto corrige:
      // `cfdi_periodo_cerrado` contaba como consumida porque su nombre
      // aparece como etiqueta `topic` de una decisión del clasificador — que
      // además nunca aplica—, no porque nadie llame a getPolicy con ella. Una
      // coincidencia de cadena no es un consumidor, igual que un re-export de
      // barril no es un puente.
      const huerfanas = claves.filter(
        (k) =>
          dondeAparece(
            new RegExp(`getPolicy(Number)?\\s*\\([\\s\\S]{0,120}?['\`"]${k}['\`"]`),
            ['src'],
            true
          ).filter(ajeno).length === 0
      );
      return huerfanas.length === 0
        ? ok(`${claves.length} políticas, todas leídas por algún consumidor`)
        : falla(
            `${huerfanas.length} de ${claves.length} políticas no las lee nadie ` +
              `(${huerfanas.join(', ')}): el usuario las contesta y no cambian nada`
          );
    },
  },

  // ---- E1.4 · Módulos sin puerta ----
  {
    paquete: 'E1.4',
    enunciado: 'La depreciación mensual tiene por dónde invocarse, y la puerta llega al binario',
    mutantes: [
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerDepreciationCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerDepreciationCommand fuera del binario',
        porque: 'la familia entera vuelve a estar verificada y no entregada: 76 pruebas verdes sobre un programa que sólo construye el spec, y una puerta que nadie puede empujar',
      },
      {
        archivo: 'src/services/assets/depreciation-math.ts',
        de: 'export function indiceDeCalendario(',
        a: 'export function indiceDeCalendario_(',
        porque: 'el índice de calendario desaparece del módulo puro: el motor volvería a indexar por su cuenta, que es como marzo repetía la fila de febrero',
      },
    ],
    evaluar: () => {
      // LA HISTORIA DE ESTE CRITERIO ES LA DE SU PROPIA DEBILIDAD. Su primera
      // versión sólo pedía «un llamador», y F06a lo demostró en vivo: el
      // llamador existió en depreciation-command.ts, E1.4 se puso VERDE, y el
      // binario no cargaba ese archivo — una puerta que nadie podía empujar,
      // exactamente el «verde no es entregado» que F05a ya había enseñado.
      // consumidoresDe hace grep sobre src/ y no distingue código alcanzable
      // de código muerto, ni motor correcto de motor roto.
      const cons = consumidoresDe('runMonthlyDepreciation', 'depreciation.ts');
      if (cons.length === 0) {
        return falla('runMonthlyDepreciation no tiene llamador: el motor existe y no hay puerta');
      }
      // 1 · ALCANZABLE: la puerta está registrada en el binario de verdad.
      if (!/registerDepreciationCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'))) {
        return falla('registerDepreciationCommand no está en el binario: el llamador vive en un archivo que mnemosine.ts no carga');
      }
      // 2 · EL ÍNDICE ES CALENDARIO, NO PROMEDIO. Dividir por 30,44 días
      // —la longitud MEDIA de un mes— hacía que marzo repitiera la fila de
      // febrero y que la última no se consumiera nunca: once filas en doce
      // meses, y la suma posteada jamás daba costo menos salvamento.
      const math = codigoDe('src/services/assets/depreciation-math.ts');
      if (!/export function indiceDeCalendario\(/.test(math) || /30\.44/.test(math)) {
        return falla('la aritmética volvió a medir meses con un promedio (30,44 d): marzo repite febrero y la última fila no se consume nunca');
      }
      // 3 · Y EL MOTOR LA USA. Que la función correcta exista no basta si
      // runMonthlyDepreciation sigue indexando por su cuenta.
      if (!/indiceDeCalendario\(/.test(codigoDe('src/services/assets/depreciation.ts'))) {
        return falla('runMonthlyDepreciation dejó de indexar por calendario: el motor no consume la aritmética que sí está bien');
      }
      return ok(`invocable desde ${cons.join(', ')}, registrado en el binario, e indexando por calendario`);
    },
  },
  {
    paquete: 'E1.4',
    enunciado: 'Ninguna función reporta éxito de un acto externo que no realiza',
    evaluar: () => {
      // «email service» no estaba en la lista y por eso el TODO de
      // POST /invoices/:id/send —que respondía sent:true sin transmitir
      // nada— pasó este criterio durante meses. La lección es la de siempre:
      // un detector de clases enumeradas sólo ve las clases que enumeró.
      const sospechosos = dondeAparece(
        /TODO:[^\n]*(PAC|SAT|IRS|SSA|IMSS|enviar|send|email|correo|transmit|integrate)/i
      );
      return sospechosos.length === 0
        ? ok('sin TODO sobre un acto externo en el camino de escritura')
        : falla(`${sospechosos.join(', ')} — un TODO junto a un UPDATE de estado es un acto que se reporta y no ocurre`);
    },
  },

  // ---- E2.1 · Perímetro ----
  {
    paquete: 'E2.1',
    enunciado: 'El contexto de inquilino se monta una sola vez para todo /v1',
    evaluar: () => {
      if (!existe('src/api/rest/middleware/tenant-context.ts')) return falla('no existe el middleware');
      const idx = codigoDe('src/index.ts');
      return /tenantContext/.test(idx)
        ? ok('montado en index.ts')
        : falla('el middleware existe y no está montado: cada router puede olvidarlo');
    },
  },
  {
    paquete: 'E2.1',
    // La primera versión decía que la guarda «es un no-op porque req.entityId
    // sale del encabezado». Era falso: la guarda SÍ comprueba que la entidad
    // del encabezado pertenezca al usuario. El defecto es otro, y peor —
    // comprueba una entidad y el handler trabaja con otra.
    // CUARTA REDACCIÓN, Y LA PRIMERA QUE NO SE ROMPE SOLA.
    //
    // Las tres anteriores leían las TRIPAS de requireEntityAccess: qué fuentes
    // listaba, si encadenaba con `||`, cómo se llamaba su variable. Cada
    // arreglo de la guarda —hubo tres— dejó ciega a la redacción vigente, y un
    // criterio ciego no protege nada mientras nadie lo mira.
    //
    // Esto pregunta lo único que importa y que ningún refactor de la guarda
    // cambia: ¿queda alguna ruta que acote su trabajo por una entidad que
    // NADIE comprobó? Da igual cómo compruebe la guarda; lo que no puede
    // pasar es que no se monte.
    enunciado: 'Ninguna ruta acota su trabajo por una entidad que nadie comprobó',
    evaluar: () => {
      const dir = 'src/api/rest/routes';
      const archivos = fuentes(dir);
      if (archivos.length === 0) return noEvaluable('no hay rutas REST que revisar');

      // Cada bloque de ruta va desde su `router.verbo(` hasta el siguiente.
      // La cadena de middlewares vive al principio; el manejador, detrás.
      const ROUTER = /router\.(get|post|patch|put|delete)\(\s*'([^']*)'([\s\S]*?)(?=\nrouter\.|\nexport default)/g;
      const desprotegidas: string[] = [];
      let revisadas = 0;

      for (const f of archivos) {
        const texto = sinComentarios(leer(f));
        for (const m of texto.matchAll(ROUTER)) {
          revisadas += 1;
          const cuerpo = m[3];
          // La entidad la trae la petición: la cabecera ya resuelta en
          // req.entityId, o la query, o el cuerpo, o el parámetro de ruta.
          const derivaDeLaPeticion =
            /req\.entityId/.test(cuerpo) ||
            /\bentity_id[^;\n]*=\s*req\.(query|body)/.test(cuerpo) ||
            /req\.(query|body)\.entity_id\b/.test(cuerpo) ||
            /\{[^}]*\bentity_id\b[^}]*\}\s*=\s*req\.(query|body)/.test(cuerpo);
          if (!derivaDeLaPeticion) continue;
          // Hay DOS formas legítimas de protegerla, y el repositorio usa las
          // dos: montar requireEntityAccess en la cadena de middlewares, o
          // llamar a assertEntityAccess dentro del manejador sobre el valor
          // que se va a usar —lo que hacen /commit-period y /publish-aggregates
          // en blockchain.ts—. Exigir sólo la primera las acusaba en falso, y
          // una acusación falsa es lo que hace que se deje de leer el informe.
          //
          // La cadena de middlewares se busca sólo al principio del bloque:
          // buscarla entera daría por montada la guarda cuando el nombre
          // aparece dentro del cuerpo por cualquier otra razón.
          const montada = /requireEntityAccess/.test(cuerpo.slice(0, 300));
          const comprobadaDentro = /assertEntityAccess\s*\(/.test(cuerpo);
          if (!montada && !comprobadaDentro) {
            desprotegidas.push(`${path.basename(f)} ${m[1].toUpperCase()} ${m[2]}`);
          }
        }
      }

      return desprotegidas.length === 0
        ? ok(`${revisadas} rutas revisadas; todas las que derivan su entidad de la petición montan la guarda`)
        : falla(
            `${desprotegidas.length} de ${revisadas} rutas acotan por una entidad de la petición sin ` +
              `montar requireEntityAccess: ${desprotegidas.slice(0, 6).join(' · ')}` +
              (desprotegidas.length > 6 ? ` y ${desprotegidas.length - 6} más` : '') +
              '. Basta la cabecera x-entity-id para trabajar sobre otra entidad del mismo inquilino'
          );
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'GraphQL no expone mutaciones al mayor fuera del prefijo auditado',
    evaluar: () => {
      const idx = codigoDe('src/index.ts');
      if (!/graphql/i.test(idx)) return ok('GraphQL no está montado');
      return /graphqlEnabled/.test(idx)
        ? ok('montado sólo tras GRAPHQL_ENABLED, apagado por omisión')
        : falla('GraphQL montado sin compuerta: dos mutaciones llegan al motor de posteo sin permisos');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'Ninguna mutación de GraphQL entra al motor sin permiso, y una nueva no puede nacer sin él',
    evaluar: () => {
      // La bandera del criterio anterior compra tiempo, no seguridad: el día
      // que alguien la encienda, lo que decide es esto. Los resolutores
      // declaraban `permissions` en su contexto y NO LO LEÍAN: las cinco
      // mutaciones comprobaban pertenencia de entidad y ninguna comprobaba
      // permiso, de modo que un `viewer` posteaba al mayor y cerraba el
      // ejercicio en duro donde REST le habría dado 403.
      //
      // Lo que se vigila aquí NO es que las de hoy estén tapadas —eso lo
      // prueban las pruebas—: es que la SIGUIENTE no pueda nacer abierta. El
      // esquema declara quince mutaciones; cuando esto se escribió había cinco
      // y entre las diez ausentes estaban timbrar y cancelar un CFDI ante el
      // SAT. Hoy hay doce y TRES ausencias dichas: las dos del SAT se
      // implementaron y se retiraron al ver que no hay servicio en el que
      // delegar —copiarían una regla fiscal— y que por esta puerta el acto
      // irreversible quedaría sin autor. Así que se lee el
      // ESQUEMA, que es el contrato, y se exige de cada mutación declarada una
      // de dos cosas: resolutor CON permiso declarado, o ausencia dicha con su
      // motivo. Y que la puerta siga siendo una, y siga lanzando.
      const esquema = crudoDe('src/api/graphql/schemas/schema.ts');
      const bloque = /type Mutation \{([\s\S]*?)\n {2}\}/.exec(esquema);
      if (!bloque) {
        return falla('no se pudo leer `type Mutation` del esquema: sin contrato que leer, la compuerta no juzga nada');
      }
      const declaradas = [...bloque[1].matchAll(/^\s+(\w+)\s*[(:]/gm)].map((m) => m[1]);
      if (declaradas.length === 0) return falla('el esquema no declara ninguna mutación: el bloque se leyó vacío');

      const puerta = codigoDe('src/api/graphql/permisos.ts');
      const resolutores = codigoDe('src/api/graphql/resolvers/index.ts');

      // UNA sola puerta, no cinco comprobaciones repartidas: las raíces
      // enteras entran por ella, o el resto de este criterio no significa nada.
      // Se miran las TRES —Subscription incluida, que hoy no tiene resolutores
      // y declara cuatro campos en el esquema—: una suscripción es una lectura
      // continua, y el día que alguien escriba `Subscription: {` por fuera,
      // esto es lo que lo acusa.
      const sueltas = ['Query', 'Mutation', 'Subscription'].filter(
        (r) =>
          new RegExp(`^ {2}${r}:`, 'm').test(resolutores) &&
          !new RegExp(`${r}:\\s*blindar\\(\\s*'${r}'`).test(resolutores)
      );
      if (sueltas.length > 0) {
        return falla(
          `${sueltas.join(', ')}: raíz de GraphQL servida por fuera de la puerta única. Cada resolutor vuelve ` +
            'a decidir por su cuenta, que es como se olvidó el permiso en las cinco primeras'
        );
      }
      if (!/Mutation:\s*blindar\(\s*'Mutation'/.test(resolutores) ||
          !/Query:\s*blindar\(\s*'Query'/.test(resolutores)) {
        return falla(
          'las dos raíces que hoy se sirven dejaron de pasar por la puerta única de permisos'
        );
      }

      // Y la compuerta se alimenta del esquema y LANZA. Si sólo avisara, la
      // mutación nueva sin permiso se montaría igual.
      // El ancla nombra la llamada EXACTA que audita la raíz y lanza. Bastaba
      // con «hay un throw de CompuertaAbiertaError en el archivo» hasta que
      // `blindarCampos` añadió el suyo para los resolutores de campo: entonces
      // desarmar el de la raíz dejaba el criterio en verde porque seguía viendo
      // el otro. Un criterio que se satisface con el guardia de al lado no
      // vigila al suyo.
      const raizAuditaYLanza =
        /auditarRaiz\(\s*typeDefs/.test(puerta) &&
        /throw new CompuertaAbiertaError\(huecos\);/.test(puerta);
      const camposLanzan = /sinCatalogo\.length > 0[\s\S]{0,200}?throw new CompuertaAbiertaError/.test(
        puerta
      );
      if (!raizAuditaYLanza || !camposLanzan) {
        return falla(
          'la compuerta dejó de contrastar el esquema o de lanzar al cargar: una mutación sin permiso volvería ' +
            'a poder montarse'
        );
      }

      const implementada = (n: string): boolean => new RegExp(`\\basync ${n}\\s*\\(`).test(resolutores);
      // Un permiso declarado es una lista con al menos un `recurso:accion`
      // dentro: `n: []` es una puerta que pregunta por nada.
      const conPermiso = (n: string): boolean => new RegExp(`\\b${n}:\\s*\\['[a-z_]+:[a-z_*]+'`).test(puerta);
      // Una ausencia declarada es el nombre seguido de su motivo en prosa.
      const ausenciaDicha = (n: string): boolean => new RegExp(`\\b${n}:\\s*'`).test(puerta);

      const sinPuerta = declaradas.filter((n) => implementada(n) && !conPermiso(n));
      if (sinPuerta.length > 0) {
        return falla(
          `${sinPuerta.join(', ')}: tienen resolutor y ningún permiso declarado. Llegan al motor con sólo ` +
            'pertenencia de entidad, igual que antes'
        );
      }

      const huerfanas = declaradas.filter((n) => !implementada(n) && !ausenciaDicha(n));
      if (huerfanas.length > 0) {
        return falla(
          `${huerfanas.join(', ')}: el esquema las declara y no están ni implementadas con permiso ni ` +
            'declaradas ausentes con su motivo. La siguiente se implementa sin puerta'
        );
      }

      const conResolutor = declaradas.filter(implementada).length;
      return ok(
        `${declaradas.length} mutaciones declaradas: ${conResolutor} con permiso exigido por la puerta única y ` +
          `${declaradas.length - conResolutor} con su ausencia dicha`
      );
    },
    mutantes: [
      {
        archivo: 'src/api/graphql/resolvers/index.ts',
        de: "Mutation: blindar('Mutation', {",
        a: 'Mutation: ({',
        porque: 'la puerta se desmonta y cada resolutor vuelve a decidir solo: el criterio no puede medir el catálogo y bendecirlo',
      },
      {
        archivo: 'src/api/graphql/permisos.ts',
        de: 'throw new CompuertaAbiertaError(huecos);',
        a: 'void huecos;',
        porque: 'la compuerta pasa de lanzar a callar: un aviso que nadie lee no impide montar la mutación nueva',
      },
      {
        archivo: 'src/api/graphql/permisos.ts',
        de: "postJournalEntry: ['journal_entries:post'],",
        a: 'postJournalEntry: [],',
        porque: 'el permiso se vacía sin quitar la entrada: la puerta sigue puesta y no pregunta nada (presencia donde hacía falta contenido)',
      },
      {
        archivo: 'src/api/graphql/schemas/schema.ts',
        de: '    hardClosePeriod(periodId: ID!, entityId: ID!): FiscalPeriod!',
        a: '    hardClosePeriod(periodId: ID!, entityId: ID!): FiscalPeriod!\n    approveBill(id: ID!): Boolean!',
        porque: 'la mutación nueva que nadie declaró en el catálogo: es el escape que este criterio existe para acusar',
      },
    ],
  },
  {
    paquete: 'E2.1',
    enunciado: 'El arranque falla cerrado ante un rol que ignora RLS',
    evaluar: () => {
      // S1 (E2.1-e rescatada): el aislamiento entero cuelga de que el rol de
      // conexión esté SUJETO a RLS, y detectarlo era un logger.warn — también
      // en producción. Un aviso que nadie lee no es una defensa. Ahora, en
      // producción, un rol con BYPASSRLS/superusuario impide arrancar salvo
      // la válvula explícita ALLOW_RLS_BYPASS_ROLE (break-glass que queda
      // escrito). En desarrollo sigue siendo warn: la suite de integración
      // corre como superusuario a propósito.
      if (!existe('src/database/rls-guard.ts')) {
        return falla('no existe el guardián del rol (src/database/rls-guard.ts): volvió a ser sólo un warn');
      }
      const g = codigoDe('src/database/rls-guard.ts');
      const lanza = /production/.test(g) && /throw new RolIgnoraRlsError/.test(g);
      const valvula = /ALLOW_RLS_BYPASS_ROLE/.test(g);
      const cableado = /verificarRolSujetoARls/.test(codigoDe('src/index.ts'));
      if (!lanza) return falla('el guardián no lanza en producción: el aislamiento vuelve a colgar de un log');
      if (!valvula) return falla('sin válvula de break-glass explícita, el guardián se puentea comentándolo');
      if (!cableado) return falla('el guardián existe y el arranque no lo llama');
      return ok('producción no arranca con un rol que ignora RLS, salvo break-glass explícito');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'Las contrapartes y los webhooks por id llevan la frontera dentro del SQL',
    evaluar: () => {
      // R2: dentro de un inquilino multi-entidad, conocer el UUID bastaba
      // para leer o parchar contrapartes de OTRA entidad (customers/vendors
      // por id sin alcance), y el ciclo entero de webhooks (borrar,
      // re-disparar, historial) filtraba sólo por id. scope.ts existía
      // exactamente para esto y estos caminos no lo usaban.
      const cust = codigoDe('src/services/ar/customer-service.ts');
      const vend = codigoDe('src/services/ap/vendor-service.ts');
      const wh = codigoDe('src/services/webhooks/webhook-service.ts');
      // Forma de LLAMADA, no de import: un import huérfano dio verde en la
      // primera mutación de este criterio — la lección del barril de AUD-6.
      if (!/findByIdInScope[<(]/.test(cust) || !/condicionDeAlcance\(/.test(cust)) {
        return falla('customer-service volvió al id sin frontera (lectura o UPDATE de un viaje)');
      }
      if (!/ByIdInScope[<(]/.test(vend)) {
        return falla('vendor-service volvió al id sin frontera');
      }
      const whChecks: Array<[RegExp, string]> = [
        [/DELETE FROM webhook_subscriptions WHERE id = \$1 AND tenant_id = \$2/, 'borrar un webhook'],
        [/JOIN webhook_subscriptions s ON s\.id = d\.webhook_id\s+WHERE d\.id = \$1 AND s\.tenant_id = \$2/, 're-disparar una entrega'],
        [/WHERE d\.webhook_id = \$1 AND s\.tenant_id = \$2/, 'el historial de entregas'],
      ];
      const roto = whChecks.find(([re]) => !re.test(wh));
      return roto
        ? falla(`webhook-service perdió la frontera de inquilino en: ${roto[1]}`)
        : ok('customers/vendors por scope.ts y el ciclo de webhooks acotado por inquilino en el SQL');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'Los webhooks salientes no alcanzan la red privada, firman contra el replay y no regalan su secreto',
    evaluar: () => {
      // R2: la URL de suscripción sólo pasaba un .url() de zod y el servidor
      // le hacía POST — SSRF hacia el metadata endpoint con las credenciales
      // del servidor; la firma cubría sólo el cuerpo (la cabecera de tiempo
      // viajaba sin firmar: replay libre); y el secreto salía ENTERO en cada
      // listado.
      if (!existe('src/services/webhooks/url-guard.ts')) {
        return falla('el guardián de URL desapareció: SSRF de libro con las credenciales del servidor');
      }
      const g = codigoDe('src/services/webhooks/url-guard.ts');
      if (!/a === 169 && b === 254/.test(g) || !/ipPrivada/.test(g)) {
        return falla('el guardián no conoce los rangos privados o el metadata endpoint');
      }
      const s = codigoDe('src/services/webhooks/webhook-service.ts');
      if (!/assertUrlDeWebhook\(url\)/.test(s)) {
        return falla('crear una suscripción ya no valida la URL');
      }
      if (!/assertDestinoPublico\(subscription\.url\)/.test(s)) {
        return falla('la entrega ya no resuelve y verifica el destino: un dominio público que apunte adentro se entrega');
      }
      if (!/t=\$\{timestamp\},v1=/.test(s)) {
        return falla('la firma dejó de cubrir el timestamp: el receptor no puede rechazar un replay por firma');
      }
      return /SELECT id, tenant_id, url, events/.test(s) && !/SELECT \* FROM webhook_subscriptions WHERE tenant_id/.test(s)
        ? ok('URL vigilada dos veces, firma t=…,v1=… y el secreto sólo en el 201')
        : falla('el listado volvió al asterisco: el secreto viaja en cada GET');
    },
  },
  {
    paquete: 'E2.1',
    enunciado: 'La verificación pública tiene camino sancionado, no un empujón al rol que ignora RLS',
    evaluar: () => {
      // R2: /public/v1 corre sin contexto de inquilino y bajo RLS forzada
      // eso era cero filas — el feature sólo podía funcionar conectando el
      // proceso con un rol que ignora RLS, exactamente el despliegue que el
      // guardián de arranque impide. El camino sancionado: mnemosine_verifier
      // (provision-roles) + políticas propias (rls-policies, reconciliadas
      // tras cada migración) + SET LOCAL ROLE por transacción.
      if (!existe('src/database/consulta-publica.ts')) {
        return falla('no existe consulta-publica.ts: el router público vuelve a consultar sin camino');
      }
      const cp = codigoDe('src/database/consulta-publica.ts');
      if (!/SET LOCAL ROLE mnemosine_verifier/.test(cp)) {
        return falla('la consulta pública no asume el rol verificador');
      }
      const router = codigoDe('src/api/rest/routes/public-verification.ts');
      if (/from '..\/..\/..\/database\/connection.js'/.test(router)) {
        return falla('el router público volvió a consultar por el pool directo, fuera del camino sancionado');
      }
      const politicas = crudoDe('src/database/rls-policies.sql');
      const n = (politicas.match(/CREATE POLICY verificacion_publica/g) ?? []).length;
      if (n < 5) {
        return falla(`las políticas del verificador no cubren las cinco tablas (hay ${n})`);
      }
      if (!/GRANT SELECT \(id, name, entity_type/.test(politicas)) {
        return falla('legal_entities perdió el GRANT de columnas enumeradas: un SELECT * nuevo expondría en vez de tronar');
      }
      return /mnemosine_verifier/.test(crudoDe('scripts/provision-roles.sql'))
        ? ok('rol verificador aprovisionado, políticas en el reconciliador y el router por SET LOCAL ROLE')
        : falla('provision-roles.sql no crea mnemosine_verifier: el camino existe sólo donde alguien lo creó a mano');
    },
  },

  // ---- E2.2 · Catálogo de autorización ----
  {
    paquete: 'E2.2',
    // No pregunta si existe src/auth/roles.ts. Que exista un archivo no le da
    // permisos a nadie; lo que importa es si el rol que el CLI reparte
    // significa algo del otro lado.
    // Antes comparaba dos catálogos y nombraba los roles que sólo existían en
    // uno (contador, revisor). AUD-3 los unificó en src/auth/roles.ts, así que
    // la pregunta ya no es si coinciden: es si vuelve a haber dos.
    enunciado: 'Los permisos de un rol se declaran en un solo sitio',
    evaluar: () => {
      // Un catálogo es un mapa de roles cuyos valores traen `permissions`.
      // Derivarlo de otro —lo que hace hoy middleware/auth.ts— no cuenta:
      // eso es un consumidor con otra forma, no una segunda verdad.
      const declaran = fuentes('src')
        .map((f) => ({ rel: path.relative(rutaDe(), f), texto: sinComentarios(leer(f)) }))
        .filter(({ texto }) => /^\s*[a-z_]+:\s*\{[\s\S]{0,400}?permissions:\s*\[/m.test(texto))
        .map(({ rel }) => rel);

      if (declaran.length === 0) {
        return noEvaluable('ningún archivo declara permisos por rol con la forma que este criterio lee');
      }
      return declaran.length === 1
        ? ok(`un solo catálogo: ${declaran[0]}`)
        : falla(
            `${declaran.length} catálogos declaran los permisos de un rol por su cuenta ` +
              `(${declaran.join(', ')}): un usuario creado por uno llega al otro con permisos distintos`
          );
    },
  },
  {
    paquete: 'E2.2',
    enunciado: 'La aplicación no arranca en producción con el secreto de desarrollo',
    evaluar: () => {
      const s = codigoDe('src/config/index.ts');
      return /production/.test(s) && /(jwt|secret)/i.test(s) && /throw/i.test(s)
        ? ok('falla rápido con el valor de ejemplo')
        : falla('un default de desarrollo sobrevive callado a producción');
    },
  },

  // ---- E3.1 · Timbrado real ----
  {
    paquete: 'E3.1',
    enunciado: 'Un adaptador simulado no puede producir un timbre ni un acuse',
    evaluar: () => {
      const p = 'src/services/integrations/mexico/pac/pac-router.ts';
      if (!existe(p)) return falla('no existe el router de PAC');
      const s = codigoDe(p);
      const guardas = (s.match(/assertPuedeTimbrar/g) ?? []).length;
      // Dos: timbrar y cancelar. Cancelar es irreversible ante el SAT, así que
      // un acuse fabricado es peor que un timbre fabricado.
      return guardas >= 3
        ? ok('timbrado y cancelación con cerrojo')
        : falla(`sólo ${guardas - 1} de las 2 vías con cerrojo: la que falta puede fabricar un folio`);
    },
  },
  {
    paquete: 'E3.1',
    enunciado: 'Cancelar un CFDI no marca la factura como cancelada sin llamar al PAC',
    evaluar: () => {
      const s = codigoDe('src/api/rest/routes/invoices.ts');
      return /cfdi_status\s*=\s*'cancelled'/.test(s)
        ? falla('la ruta marca cancelado sin acuse: el mayor cree cancelado un CFDI vigente ante el SAT')
        : ok('la ruta no finge cancelar');
    },
  },

  // ---- E3.2 · Descarga del SAT ----
  {
    paquete: 'E3.2',
    enunciado: 'El despacho puede traer del SAT los CFDI que no le llegaron',
    evaluar: () => {
      // ROJO HONESTO (S1). La versión anterior de este criterio pasó VERDE
      // durante semanas porque su regex matcheaba dos cadenas de PROSA en una
      // pregunta de política (pending-catalog.ts: «direct SAT download …») —
      // la clase exacta de falso verde que AUD-6 purgó, cometida por el
      // propio instrumento. La descarga masiva NO existe: ni cliente SOAP
      // (SolicitaDescarga/VerificaSolicitud), ni lector de paquetes ZIP, ni
      // comando `sat download`, ni la reversa de facturas contabilizadas
      // cuyo CFDI el emisor canceló. Son ~11 tareas de motor (plan de
      // cierre E3.2), no «cargar una credencial».
      //
      // Verde exige el SERVICIO con transporte: un módulo bajo
      // src/services/sat-download/ que el camino de políticas no pueda
      // imitar con una cadena.
      if (!existe('src/services/sat-download')) {
        return falla(
          'la descarga masiva del SAT no existe (ni SOAP, ni ZIP, ni comando): el despacho no ' +
            'puede afirmar completitud, que es lo que vende. El criterio anterior pasaba por dos ' +
            'cadenas de prosa en pending-catalog.ts — este rojo es la corrección'
        );
      }
      if (!existe('src/services/sat-download/descarga-masiva.ts')) {
        return falla('src/services/sat-download existe pero sin descarga-masiva.ts (el motor)');
      }
      const motor = codigoDe('src/services/sat-download/descarga-masiva.ts');
      return /SolicitaDescarga/i.test(motor) && /Verifica/i.test(motor)
        ? ok('el motor de descarga masiva existe con su transporte')
        : falla('src/services/sat-download existe pero sin el ciclo solicitar/verificar/descargar');
    },
  },

  // ---- E4.1 · Ciclos de banca y nómina ----
  {
    paquete: 'E4.1',
    enunciado: 'Una conciliación no se declara cuadrada sin postear su diferencia',
    evaluar: () => {
      const p = 'src/api/rest/routes/bank-reconciliation.ts';
      const s = codigoDe(p);
      const marca = /status\s*=\s*'balanced'/.test(s);
      const postea = /createJournalEntry|postJournalEntry/.test(s);
      if (!marca) return ok('ninguna ruta marca cuadrado sin más');
      return postea
        ? ok('marca cuadrado y postea')
        : falla('marca cuadrado sin postear, y la compuerta de cierre lo acepta como prueba');
    },
  },
  {
    paquete: 'E4.1',
    enunciado: 'El mapeo contable de nómina se siembra en el alta',
    evaluar: () => {
      const cons = consumidoresDe('seedPayrollAccountMapping', 'payroll-account-mapping-seed.ts');
      return cons.length > 0
        ? ok(`sembrado desde ${cons.join(', ')}`)
        : falla('payroll_account_mapping sin escritor: la primera corrida de nómina muere');
    },
  },

  {
    paquete: 'E4.1',
    enunciado: 'La nómina escribe los impuestos que sus formularios reportan',
    evaluar: () => {
      // ROJO HONESTO NUEVO. Los dos criterios anteriores de E4.1 miden la
      // conciliación y la siembra del mapeo — y con ellos en verde el paquete
      // entero figuraba cerrado mientras su salida no ocurre: paycheck_taxes,
      // employer_tax_liabilities y garnishments se LEEN (los formularios
      // 941/940, el posteo al mayor, el motor de embargos) y ningún camino
      // las escribe. El resultado es un número falso con aspecto de número:
      // los formularios reportan ceros y los embargos se descuentan de una
      // tabla que nadie puede poblar. `doctor` ya lo clasifica así; el
      // tablero tiene que decirlo también, porque es el que ordena sprints.
      const tablas = ['paycheck_taxes', 'employer_tax_liabilities', 'garnishments'];
      const sinEscritor = tablas.filter(
        (t) => dondeAparece(new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i'), ['src'], true).length === 0
      );
      return sinEscritor.length === 0
        ? ok('las tres tablas de la salida de nómina tienen escritor')
        : falla(
            `${sinEscritor.join(', ')}: se leen y nadie las escribe — los 941/940 reportan ` +
              'ceros y los embargos salen de una tabla que ningún camino puebla'
          );
    },
  },

  // ---- E4.2 · Trabajos y reportes ----
  {
    paquete: 'E4.2',
    enunciado: 'Postear no dispara el refresco de vistas materializadas',
    evaluar: () => {
      const s = codigoDe('src/services/accounting/posting.ts');
      return /REFRESH\s+MATERIALIZED/i.test(s)
        ? falla('cada posteo refresca las vistas: el coste crece con el volumen y bloquea')
        : ok('el refresco no vive en el camino de posteo');
    },
  },
  {
    paquete: 'E4.2',
    enunciado: 'Las superficies de reportes consumen una sola capa de consulta',
    evaluar: () => {
      const cons = consumidoresDe('getTrialBalance', 'report-service.ts');
      const copias = dondeAparece(/SUM\(\s*COALESCE\(jel\.debit_amount/i, ['src'], true).filter(
        (f) => !f.includes('report-service')
      );
      return copias.length === 0
        ? ok(`una sola capa, consumida por ${cons.length} superficie(s)`)
        : falla(`${copias.length} copia(s) del SQL de saldos fuera de report-service: ${copias.join(', ')}`);
    },
  },

  // ---- E5.1 · Madurez del agente ----
  {
    paquete: 'E5.1',
    enunciado: 'La auditoría de consistencia corre contra el binario que se embarca, y su deuda no crece',
    evaluar: async () => {
      // `auditProgram` existía desde el principio y el programa real nunca
      // pasó por ella: vivía en un `.spec.ts` y cada prueba se construía un
      // árbol de juguete. Peor, importarla desde el spec arrastraba su suite,
      // cuyos `resetDeclarations()` vacían el registro de riesgo — así que
      // cualquier prueba que la importara auditaba un programa con cero
      // declaraciones y pasaba en el vacío.
      const { program } = await import('../cli/mnemosine.js');
      const { auditarContraLineaBase, LINEA_BASE } = await import('../cli/kernel/audit.js');

      const { nuevas, obsoletas, heredadas } = auditarContraLineaBase(program);
      if (nuevas.length > 0) {
        return falla(
          `${nuevas.length} violación(es) que no están en la línea base — p. ej. ` +
            `${nuevas[0].command}: ${nuevas[0].detail}`
        );
      }
      if (obsoletas.length > 0) {
        return falla(
          `${obsoletas.length} entrada(s) de la línea base ya no se violan y siguen ahí: una lista ` +
            'que no encoge deja de ser deuda registrada y se vuelve un permiso permanente'
        );
      }
      return ok(
        `sin violaciones nuevas; ${heredadas} de ${LINEA_BASE.length} heredadas siguen vivas`
      );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Toda hoja del CLI declara su riesgo, así que hay algo sobre lo que aplicar la compuerta',
    evaluar: async () => {
      // Se mide sobre el PROGRAMA EMBARCADO, no sobre un árbol de juguete.
      // 49 de 106 hojas no declaraban nada —entre ellas las que postean al
      // mayor y la que ejecuta contra el sistema del cliente— y por eso la
      // regla R11 del auditor devolvía cero violaciones: no tenía sobre qué
      // correr. Un verde por no tener nada que mirar es el defecto que este
      // sprint persigue, y aquí estaba en el instrumento mismo.
      const { program } = await import('../cli/mnemosine.js');
      const { riskOf } = await import('../cli/kernel/risk.js');
      const { hojasDe } = await import('../cli/kernel/riesgos-retrofit.js');

      const hojas = hojasDe(program);
      if (hojas.length < 80) {
        return noEvaluable(`sólo se leyeron ${hojas.length} hojas: el árbol no se montó entero`);
      }
      const sin = hojas.filter((h) => !riskOf(h.cmd)).map((h) => h.ruta);
      if (sin.length > 0) {
        return falla(
          `${sin.length} de ${hojas.length} hojas sin declarar (${sin.slice(0, 4).join(', ')}` +
            `${sin.length > 4 ? ', …' : ''}): a lo que no declara no se le aplica ninguna compuerta`
        );
      }
      // Y la garantía que sostiene el diseño del asistente.
      const agenteEnGrave = hojas.filter((h) => {
        const r = riskOf(h.cmd)!;
        return r.agentAllowed && (r.risk === 'irreversible' || r.risk === 'externo');
      });
      return agenteEnGrave.length === 0
        ? ok(`las ${hojas.length} hojas declaran, y ninguna grave es invocable por el agente`)
        : falla(
            `${agenteEnGrave.map((h) => h.ruta).join(', ')}: el agente puede invocar algo irreversible o externo`
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Las herramientas del agente se derivan del registro de riesgo del CLI',
    evaluar: () => {
      // FALSO VERDE CORREGIDO. La versión anterior contaba cualquier mención
      // de `allDeclarations` fuera de risk.ts como «consumidor», y eso
      // incluía el re-export del barril (kernel/index.ts) — un archivo que no
      // consume nada, sólo reexporta. El tablero decía «el puente existe»
      // mientras las herramientas del agente seguían escritas a mano. Un
      // criterio cuyo verde puede producirlo un `export {...} from` no mide
      // un puente: mide que el símbolo exista, que ya lo mide el compilador.
      //
      // Consumidor de verdad = un archivo FUERA del núcleo del CLI que nombre
      // el símbolo. El puente será real cuando src/ai derive su superficie de
      // herramientas del registro; hasta entonces, rojo honesto.
      const cons = consumidoresDe('allDeclarations', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      return cons.length > 0
        ? ok(`el puente existe: ${cons.join(', ')}`)
        : falla(
            'allDeclarations no tiene consumidor fuera del núcleo (el re-export del barril no ' +
              'consume nada): las herramientas del agente siguen escritas a mano en vez de ' +
              'derivarse del registro de riesgo. La sesión desatendida ya corre con superficie ' +
              'nombrada (S0.3), pero esa lista también es a mano — el puente que las derive es ' +
              'una aspiración, y este rojo es su registro'
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'La corrida desatendida corre con una superficie nombrada, no con «todas»',
    evaluar: () => {
      // La sesión desatendida recibía todas las herramientas porque la
      // fábrica ni siquiera admitía recorte. Hoy pasa una lista EXPLÍCITA
      // (tools/superficie.ts) y buildTools lanza ante nombres que no existen:
      // una herramienta nueva nace excluida de lo desatendido hasta que
      // alguien la añada a la lista, y un renombre rompe en el arranque en
      // vez de encoger la superficie en silencio.
      if (!existe('src/ai/tools/superficie.ts')) {
        return falla('no existe la superficie nombrada: la desatendida vuelve a recibir todo por omisión');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      // La expresión admite el ternario de S0.6: con --live viaja la
      // superficie completa y sin ella la variante SANDBOX (misma lista menos
      // las dos lecturas externas). Lo que se afirma es que la opción
      // `herramientas` se alimenta de la lista NOMBRADA, nunca de una omisión.
      if (!/herramientas:[^\n]*SUPERFICIE_DESATENDIDA/.test(cli)) {
        return falla(
          'makeRunAgentTurn no pasa SUPERFICIE_DESATENDIDA: la sesión desatendida recibe la ' +
            'superficie completa por omisión, y una herramienta futura entraría sin que nadie lo decida'
        );
      }
      const fabrica = codigoDe('src/ai/tools/index.ts');
      return /permitidas/.test(fabrica) && /throw new Error/.test(fabrica)
        ? ok('la desatendida corre con lista explícita, y un nombre fantasma rompe en el arranque')
        : falla('buildTools no valida la lista: un nombre renombrado filtraría en silencio');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los graves declaran junto a su registro, con la compuerta cableada y la llave guardada',
    evaluar: () => {
      // S0.6, tres afirmaciones mecánicas sobre el mismo borde.
      //
      // 1) La tabla de retrofit no declara ningún grave. Un irreversible o
      //    externo declarado por tabla es un manejador que nadie cableó: el
      //    preAction de la tabla sólo sabía rechazar --dry-run/--live en voz
      //    alta, nunca honrarlas. Una fila grave nueva sería ese retroceso.
      const tabla = codigoDe('src/cli/kernel/riesgos-retrofit.ts');
      if (/risk:\s*'(irreversible|externo)'/.test(tabla)) {
        return falla(
          'la tabla de retrofit volvió a declarar un grave: su manejador no honra --dry-run/--live — declara junto al registro y cablea gateMutation'
        );
      }
      // 2) La compuerta tiene consumidores reales fuera del kernel: los ocho
      //    graves migrados más las familias que ya nacieron cableadas.
      const consumidores = consumidoresDe('gateMutation', 'risk.ts').filter(
        (f) => !f.startsWith('src/cli/kernel/')
      );
      if (consumidores.length < 8) {
        return falla(
          `gateMutation se consume en ${consumidores.length} archivo(s) fuera del kernel; con los ocho graves cableados deben ser al menos 8`
        );
      }
      // 3) La llave de idempotencia se guarda de verdad: hay quien escribe
      //    idempotency_keys y más de un comando pasa por el almacén. Sin
      //    esto, --idempotency-key vuelve a ser un aviso que promete de más.
      const escritores = dondeAparece(/INSERT\s+INTO\s+idempotency_keys/i, ['src'], true);
      if (escritores.length === 0) {
        return falla('nadie escribe idempotency_keys: la bandera vuelve a ser un aviso sin almacén');
      }
      const usos = consumidoresDe('conLlave', 'idempotency-store.ts');
      return usos.length >= 3
        ? ok(
            `graves fuera de la tabla; compuerta consumida en ${consumidores.length} archivos; llave guardada (${escritores[0]}) y consumida en ${usos.length}`
          )
        : falla(
            `conLlave se consume en ${usos.length} archivo(s); entry post/reverse/void, close y onboard exigen al menos 3`
          );
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los importes sobreviven a la compactación por construcción',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-c): el backstop determinista de la
      // compactación cubría UUIDs, RFCs y folios, y los IMPORTES —la carga
      // útil de un agente contable— quedaban «protegidos por instrucción
      // solamente», según confesaba el propio comentario del módulo. Verde
      // exige que MONTO_RE exista y esté en la lista del extractor.
      const c = codigoDe('src/ai/compaction.ts');
      if (!/MONTO_RE/.test(c)) {
        return falla('no existe MONTO_RE: los importes vuelven a depender de que el modelo se porte bien');
      }
      return /\[UUID_RE,\s*RFC_RE,\s*FOLIO_RE,\s*MONTO_RE\]/.test(c)
        ? ok('el extractor incluye importes: lo que el resumen tire, el backstop lo re-adjunta')
        : falla('MONTO_RE existe pero el extractor no lo usa: es un regex decorativo');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'El «--continue» rehidrata el contexto que promete',
    evaluar: () => {
      // ROJO HONESTO (S1, hueco confesado de E5.1-b): la propia opción lo
      // dice — «transcript continuity; the model context starts fresh». Un
      // usuario que retoma su sesión espera que el agente recuerde la
      // conversación, no sólo que el transcript se anexe. Verde exige que
      // las opciones de sesión acepten un historial y que el camino de
      // --continue lo alimente desde getSessionMessages.
      const tipos = codigoDe('src/ai/providers/index.ts');
      const cli = codigoDe('src/cli/mnemosine.ts');
      if (!/historial/.test(tipos)) {
        return falla(
          'CreateLlmSessionOptions no acepta historial: --continue anexa transcript pero el ' +
            'modelo arranca en blanco — la rehidratación es trabajo de la familia del agente'
        );
      }
      return /historial/.test(cli)
        ? ok('el camino de --continue alimenta el historial de la sesión')
        : falla('las opciones aceptan historial y el CLI no lo alimenta');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Los precios del ledger declaran su vigencia, y el reporte la muestra',
    evaluar: () => {
      // S1 (hueco confesado de E5.1-f): la tabla de precios llevaba su fecha
      // de corte en un COMENTARIO. Un costo estimado con precios de hace un
      // año se lee como costo de hoy si nadie lo dice en la salida.
      const p = codigoDe('src/ai/providers/prices.ts');
      if (!/PRECIOS_VIGENTES_A\s*=\s*'\d{4}-\d{2}-\d{2}'/.test(p)) {
        return falla('la fecha de corte volvió a ser prosa: PRECIOS_VIGENTES_A no existe como dato');
      }
      return /PRECIOS_VIGENTES_A/.test(codigoDe('src/cli/usage-command.ts'))
        ? ok('la vigencia es un dato y cada reporte de uso la muestra')
        : falla('la fecha existe y el reporte de uso no la enseña');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera',
    mutantes: [
      {
        archivo: 'src/ai/tools/ledger-tools.ts',
        de: 'envolverDatosDeTerceros(',
        a: 'envolverDatosDeTerceros(postJournalEntry, ',
        porque: 'una herramienta que NOMBRA una puerta de dinero debe enrojecer, aunque no la llame (la lección del import)',
      },
    ],
    evaluar: () => {
      // ESTE CRITERIO ESTABA EN ROJO POR UNA AFIRMACIÓN FALSA.
      //
      // Decía que `makeRunAgentTurn` construye la sesión sin recortar
      // herramientas y concluía que «un modelo que ignora el prompt escribe de
      // verdad». Lo primero es cierto; lo segundo no, y se comprueba mirando
      // la superficie: ninguna herramienta emite INSERT, UPDATE ni DELETE, la
      // familia del mayor sólo tiene SELECT, y lo que sí escribe lo hace en
      // `ai_drafts`, `ai_questions` o la bandeja de salida — que ENCOLA, no
      // ejecuta. La garantía «el agente propone y un humano dispone» se cumple
      // por construcción de las herramientas, no por una frase del prompt.
      //
      // Un rojo falso en el tablero que ordena los sprints es la misma
      // patología que el sprint persigue, cometida sobre el instrumento: se
      // convierte en paisaje, y el día que haya un rojo verdadero nadie lo
      // distinguirá. Así que el criterio pasa a afirmar la propiedad que de
      // verdad sostiene el diseño, y es falsable: una herramienta nueva que
      // llame al motor de posteo lo pone en rojo.
      const dir = 'src/ai/tools';
      const archivos = fuentes(dir);
      if (archivos.length === 0) return noEvaluable('no existe la superficie de herramientas');

      // Tres cercas, porque la auditoría demostró que una sola se salta.
      //
      // 1. NOMBRES prohibidos, por identificador y no por llamada: la
      //    primera versión exigía `nombre(` y un `import { x as y }` la
      //    evadía. Una herramienta no tiene razón legítima ni para NOMBRAR
      //    estos símbolos. La lista incluye las puertas de dinero creadas en
      //    este mismo sprint — la versión anterior vigilaba las viejas y era
      //    ciega a ligarPagoREP y procesarREP, recién nacidas.
      const PROHIBIDOS = [
        'postJournalEntry',
        'createJournalEntry',
        'recordVendorPayment',
        'recordCustomerPayment',
        'issueInvoice',
        'approveBill',
        'approveDraft',
        'hardClosePeriod',
        'commitPeriod',
        'executeExternalOp',
        'ligarPagoREP',
        'procesarREP',
        'processToAccounting',
        'createBankTransaction',
      ];
      // 2. MÓDULOS prohibidos: llamar a un servicio que a su vez postea es la
      //    evasión transitiva. Los módulos de dinero no se importan desde las
      //    herramientas, con ningún nombre.
      const MODULOS_PROHIBIDOS =
        /from\s+'[^']*(accounting\/posting|payments\/payment-service|xml-ingestion\/rep-linkage|accounting\/period-close|xml-ingestion\/pre-registration-service)/;
      const culpables: string[] = [];
      for (const f of archivos) {
        const codigo = sinComentarios(leer(f));
        const rel = path.relative(rutaDe(), f);
        for (const nombre of PROHIBIDOS) {
          if (new RegExp(`\\b${nombre}\\b`).test(codigo)) culpables.push(`${rel} → ${nombre}`);
        }
        if (MODULOS_PROHIBIDOS.test(codigo)) {
          culpables.push(`${rel} → importa un módulo de dinero`);
        }
        // 3. SQL de escritura directo, con el UPDATE multilínea incluido: el
        //    regex viejo exigía `UPDATE x SET` en una línea y una plantilla
        //    con salto de línea pasaba.
        if (/INSERT\s+INTO|UPDATE[\s\S]{0,80}?\bSET\b|DELETE\s+FROM|TRUNCATE\s|MERGE\s+INTO/i.test(codigo)) {
          culpables.push(`${rel} → SQL de escritura directo`);
        }
      }
      return culpables.length === 0
        ? ok(
            `${archivos.length} archivos de herramientas: ninguno postea, cobra, paga, timbra ni ` +
              'ejecuta hacia fuera; lo que escriben va a borradores, preguntas o la bandeja de salida'
          )
        : falla(
            `una herramienta del agente alcanza un camino que no debería: ${culpables.join(', ')}`
          );
    },
  },

  {
    paquete: 'E5.1',
    enunciado: 'El clasificador tiene vara de medir: golden set con esperado y arnés fijado',
    evaluar: () => {
      // A1: «medir antes de soltar» era doctrina sin instrumento — la brecha
      // madre de la auditoría integral. La vara: un corpus con respuesta
      // (tests/golden/cfdi, pares xml + esperado.json que incluyen los casos
      // donde lo correcto es PREGUNTAR) y un arnés que corre el MISMO camino
      // que la ingesta —ingestCfdiFiles con sus compuertas— contra un
      // proveedor FIJADO: createLlmSession directo, sin cadena de failover
      // (un eval que cambia de modelo a mitad de corrida no mide nada).
      const dir = rutaDe('tests/golden/cfdi');
      if (!fs.existsSync(dir)) return falla('el golden set no existe: no hay contra qué medir al clasificador');
      const archivos = fs.readdirSync(dir);
      const xmls = archivos.filter((a) => a.endsWith('.xml'));
      const huerfanos = xmls.filter((a) => !archivos.includes(a.replace(/\.xml$/, '.esperado.json')));
      if (xmls.length < 9 || huerfanos.length > 0) {
        return falla(`el corpus perdió casos o respuestas (${xmls.length} xml, sin esperado: ${huerfanos.join(', ') || 'ninguno'})`);
      }
      const arnes = codigoDe('scripts/eval-clasificador.ts');
      if (!/createLlmSession\(/.test(arnes) || /createLlmSessionWithFailover/.test(arnes)) {
        return falla('el arnés dejó de fijar proveedor: con cadena de failover la corrida no es comparable');
      }
      if (!/ingestCfdiFiles\(/.test(arnes)) {
        return falla('el arnés ya no corre el camino real de la ingesta: mediría un clasificador que no existe');
      }
      if (!/clasificador\.jsonl/.test(arnes) || !/agregarPuntuaciones\(/.test(arnes)) {
        return falla('el arnés perdió la bitácora o la puntuación: sin «contra la corrida anterior» no hay tendencia');
      }
      // Forma de LLAMADA (marca('abstencion', …)), no el símbolo: la unión de
      // tipos también dice 'abstencion' y un regex laxo bendice al mutante
      // que renombra la marcación real — el primo del import (AUD-6).
      return /marca\(\s*\n?\s*'abstencion'/.test(codigoDe('src/ai/eval/puntuacion.ts'))
        ? ok(`${xmls.length} casos con esperado, arnés por el camino real, proveedor fijado y bitácora comparable`)
        : falla('la puntuación perdió la clase abstención: dejaría de medirse la humildad de preguntar');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'La calibración se lee del rastro: ai stats por bucket, con delta',
    evaluar: () => {
      // A2: la confianza que el modelo reporta contra lo que el despacho
      // decidió, bucket por bucket — y el DELTA que exhibe el exceso de
      // confianza. El destino se reconstruye del rastro de atribución que
      // los caminos de aprobación dejan a propósito (la nota del auto-post,
      // el reviewed_by 'policy:'), no de una columna que no existe.
      const svc = codigoDe('src/ai/stats-service.ts');
      // Conteos, no presencia: la nota del auto-post aparece en TRES brazos
      // del CASE (el filtro de auto y los dos NOT LIKE que separan política
      // y humano) y el prefijo 'policy:' en DOS. Mutar uno deja los demás y
      // un chequeo de presencia lo bendice — la lección de R1 (la resta
      // JSONB contada una vez, existiendo en dos funciones).
      const notasAuto = (svc.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefijosPolitica = (svc.match(/'policy:%'/g) ?? []).length;
      if (!/FROM ai_drafts/.test(svc) || notasAuto < 3 || prefijosPolitica < 2) {
        return falla(
          `las estadísticas dejaron de leer el rastro de atribución completo (nota auto ×${notasAuto}, prefijo policy ×${prefijosPolitica}): auto, política y humano se confundirían`
        );
      }
      if (!/media\.minus\(tasa\)/.test(svc)) {
        return falla('el delta confianza-vs-realidad desapareció: los buckets sin delta son un conteo, no una calibración');
      }
      const cmd = codigoDe('src/cli/ai-command.ts');
      if (!/declareRisk\(stats,\s*\{\s*risk:\s*'lectura',\s*agent:\s*true/.test(cmd)) {
        return falla('ai stats dejó de ser lectura abierta al agente: medirse a sí mismo es el único privilegio que debe tener');
      }
      return /registerAiCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'))
        ? ok('ai stats registrado: buckets sobre ai_drafts, atribución por rastro y delta a la vista')
        : falla('registerAiCommand no está en el binario: la calibración existiría sin superficie');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'Lo que el agente hace deja rastro medible: duración, corridas y eventos',
    evaluar: () => {
      // A2: las métricas que faltaban. duration_ms en el ledger de uso (los
      // DOS runners miden alrededor de su llamada), los counts de la ingesta
      // persistidos por corrida (con consumo, para que costo-por-borrador
      // sea una división), y sospecha/nudge/failover como filas — el delito
      // menor deja rastro ANTES de discutir la autonomía mayor.
      const m = 'src/database/migrations/044_el_agente_medible.sql';
      if (!existe(m)) return falla('la 044 desapareció: sin tablas no hay rastro');
      const sql = crudoDe(m);
      if (!/ADD COLUMN duration_ms/.test(sql) || !/CREATE TABLE ai_ingest_runs/.test(sql) || !/CREATE TABLE ai_agent_events/.test(sql)) {
        return falla('la 044 perdió una de sus tres piezas (duration_ms, ai_ingest_runs, ai_agent_events)');
      }
      // Conteo por archivo, no presencia: el agente emite en DOS sitios
      // (bucle del runner y summarize) y el compat en TRES (summarize,
      // no-stream, stream) — mutar el sitio principal dejando el secundario
      // pasa un chequeo de presencia. Tercera aparición de la lección del
      // conteo en esta misma corrida.
      // Sólo Date.now() cuenta como medición: una alternativa `durationMs`
      // casaba la FIRMA de emitUsage(usage, durationMs?) y la declaración
      // pasaba por sitio medido — el regex mordiéndose la cola.
      const emisionesMedidas = (f: string): number =>
        (codigoDe(f).match(/emitUsage\([^)]*,\s*Date\.now\(\)/g) ?? []).length;
      const enAgente = emisionesMedidas('src/ai/agent.ts');
      const enCompat = emisionesMedidas('src/ai/providers/openai-compat.ts');
      if (enAgente < 2 || enCompat < 3) {
        return falla(
          `un runner dejó de medir alguna de sus llamadas (agente ${enAgente}/2, compat ${enCompat}/3)`
        );
      }
      if (!/duration_ms/.test(codigoDe('src/ai/usage-ledger.ts'))) {
        return falla('el ledger de uso dejó de persistir la duración que los runners miden');
      }
      const cli = codigoDe('src/cli/mnemosine.ts');
      // El criterio afirma la CONDUCTA —que la corrida quede registrada—, no
      // el nombre de la función que la registra. Afirmaba
      // `registrarCorridaIngesta(ctx` y se puso rojo el día que A7·3 partió
      // esa función en abrir/cerrar para que la fila naciera ANTES del bucle:
      // acusaba «la ingesta volvió a imprimir y evaporar» sobre una capacidad
      // que acababa de mejorar. Un criterio que nombra un identificador
      // castiga el refactor que lo cumple mejor — la lección de la casa que
      // la cabecera de este archivo abre, cobrada otra vez.
      if (!/conCorridaRegistrada\(|registrarCorridaIngesta\(ctx/.test(cli)) {
        return falla('la ingesta volvió a imprimir y evaporar: nadie registra la corrida');
      }
      if ((cli.match(/registrarEventoEnSegundoPlano\(ctx/g) ?? []).length < 3) {
        return falla('los eventos del agente (sospecha/nudge/failover) perdieron cableado en el CLI');
      }
      return /this\.onNudge\?\.\(\)/.test(codigoDe('src/ai/grounding.ts'))
        ? ok('duración en los dos runners y el ledger, corridas de ingesta con consumo, y los tres eventos cableados')
        : falla('el guard de grounding dejó de avisar el nudge: el contador quedaría siempre en cero');
    },
  },

  {
    paquete: 'E5.1',
    enunciado: 'Un solo autorizador: la vía de política lleva tope obligatorio y su «no casó» tiene nombre',
    mutantes: [
      {
        archivo: 'src/ai/ingest-service.ts',
        de: 'opts.deps?.autoApproveByPolicy ?? autoApproveDraftByPolicy',
        a: 'opts.deps!.autoApproveByPolicy',
        porque: 'el seam de pruebas se vuelve el camino de producción: el default al autorizador real desaparece',
      },
    ],
    evaluar: () => {
      // A3: había DOS autorizadores — matchApprovalPolicy con toda la
      // jurisprudencia (tope del operador vía Math.min, revocación,
      // last_used_at) y un gemelo huérfano que la ingesta no usaba. La
      // ingesta migró a la vía única: cuando una compuerta DISCRECIONAL no
      // basta, autoApproveDraftByPolicy tiene su oportunidad; las de
      // INTEGRIDAD retornan antes y jamás llegan ahí.
      const ing = codigoDe('src/ai/ingest-service.ts');
      // Forma de LLAMADA con el default (la lección de la firma-como-
      // callsite): el seam de pruebas debe caer al autorizador real, no a
      // un stub que aprobaría sin jurisprudencia.
      if (!/opts\.deps\?\.autoApproveByPolicy \?\? autoApproveDraftByPolicy/.test(ing)) {
        return falla('la ingesta dejó de caer al autorizador real: el seam de pruebas se volvió el camino de producción');
      }
      if (!/configuredMaxAmount: floorMaxAutoAmount\(thresholds\.maxAmount\)/.test(ing)) {
        return falla('la vía de política perdió el tope obligatorio del operador: una política podría autorizar por encima');
      }
      if (!/if \(veredicto\.integridad\)/.test(ing)) {
        return falla('la integridad dejó de retornar antes de la política: sospecha, multi-draft, moneda o cuadre se volverían negociables');
      }
      if (!/instanceof NoMatchingApprovalPolicyError/.test(ing)) {
        return falla('el «no casó» perdió el nombre: no se distinguiría de «casó y falló al aplicarse»');
      }
      // El huérfano pagó: la ingesta IMPORTA el autorizador del servicio de
      // borradores (si este import muere, E0.2 debe recongelar el símbolo).
      if (!/import\s*\{[^}]*\bautoApproveDraftByPolicy\b[^}]*\}\s*from '\.\/draft-service\.js'/.test(ing)) {
        return falla('la ingesta ya no importa autoApproveDraftByPolicy: volvería a haber dos autorizadores o ninguno');
      }
      return /code = 'NO_MATCHING_APPROVAL_POLICY'/.test(codigoDe('src/ai/draft-service.ts'))
        ? ok('vía única con tope floor-clampeado, integridad no negociable y NoMatchingApprovalPolicyError con código')
        : falla('el error de política sin casar perdió su código: los llamadores volverían a comparar strings');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'El presupuesto corta donde nacen las sesiones, y desatendido el tope es tope',
    mutantes: [
      {
        archivo: 'src/ai/budget.ts',
        de: "opts.unattended ? 'block' : 'warn'",
        a: "'warn'",
        porque: 'la ruta desatendida pierde su default block: «solo avisa» significa que no hay tope',
      },
    ],
    evaluar: () => {
      // A3 (spec E5.1-e): presupuesto opt-in por archivo de config, pero con
      // un default que distingue rutas: con humano enfrente, warn; en ruta
      // DESATENDIDA (grounding apagado = nadie mira), block — «solo avisa»
      // significa que no hay tope. Y el corte vive en el ÚNICO sitio donde
      // nacen las sesiones, no repartido por los llamadores.
      if (!existe('src/ai/budget.ts')) return falla('budget.ts no existe: el gasto del agente no tiene tope posible');
      const b = codigoDe('src/ai/budget.ts');
      if (!/opts\.unattended \? 'block' : 'warn'/.test(b)) {
        return falla('la ruta desatendida perdió su default block: un agente sin humano enfrente correría sin tope real');
      }
      if (!/code = 'AI_BUDGET_EXCEEDED'/.test(b)) {
        return falla('BudgetExceededError perdió su código: los llamadores no distinguirían tope de cualquier otro error');
      }
      // Declarado Y usado en la comparación (conteo, no presencia): mutar el
      // umbral del aviso dejando la constante viva pasa un chequeo laxo.
      if ((b.match(/BUDGET_WARN_RATIO/g) ?? []).length < 2) {
        return falla('el aviso del 80% dejó de compararse: el usuario se enteraría del tope al chocar con él');
      }
      if (!/sin medición/.test(b)) {
        return falla('block dejó de ser cerrado ante una base que no responde: un tope que no puede medirse no debe fingir que midió');
      }
      const prov = codigoDe('src/ai/providers/index.ts');
      if (!/const unattended = opts\.grounding\?\.enabled === false/.test(prov)) {
        return falla('la señal de desatendido se desconectó del grounding: la ruta sin humano dejaría de reconocerse');
      }
      if (!/await assertWithinBudget\(ctx, opts\.cwd, \{ unattended \}\)/.test(prov)) {
        return falla('createLlmSession dejó de pasar por el presupuesto: el chokepoint tiene un desvío');
      }
      // El decorador muerde al ENTRAR a cada turno: un cruce a mitad de
      // sesión corta sin esperar a la siguiente sesión.
      if (!/guard\.check\(\);\s*return session\.runTurn\(/.test(prov)) {
        return falla('withBudgetGuard dejó de checar por turno: un cruce a mitad de sesión seguiría gastando');
      }
      return /return withBudgetGuard\(session, guard\)/.test(prov)
        ? ok('presupuesto opt-in con block por default en desatendido, cerrado sin medición, y el guard muerde cada turno en el chokepoint')
        : falla('la sesión sale sin decorar: el guard existiría sin morder');
    },
  },
  {
    paquete: 'E5.1',
    enunciado: 'La sombra opina sin postear, y encender el auto-posteo exige su historial',
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: 'c.decididos < FLOOR_SOMBRA_VEREDICTOS ||',
        a: '',
        porque: 'el piso pierde la vara del volumen decidido: tres comparaciones, cada una con ancla propia',
      },
    ],
    evaluar: () => {
      // A4: autoPost 'shadow' corre TODAS las compuertas, registra el
      // veredicto y no postea nada. La concordancia cruza esos veredictos
      // contra decisiones HUMANAS (nunca contra el propio umbral ni contra
      // políticas), y resolvePolicy exige ese historial antes de aceptar
      // 'on': el encendido es una decisión con evidencia, no una casilla.
      const m = 'src/database/migrations/047_el_veredicto_de_la_sombra.sql';
      if (!existe(m)) return falla('la 047 desapareció: la sombra no tendría dónde opinar');
      const sql = crudoDe(m);
      if (!/CREATE TABLE ai_shadow_verdicts/.test(sql) || !/UNIQUE \(draft_id\)/.test(sql)) {
        return falla('ai_shadow_verdicts perdió la unicidad por borrador: una sombra que opina dos veces infla su propia concordancia');
      }
      const ing = codigoDe('src/ai/ingest-service.ts');
      if (!/const modoSombra = thresholds\.sombra === true && !thresholds\.autoPost/.test(ing)) {
        return falla("la sombra dejó de excluir autoPost encendido: 'shadow' sólo tiene sentido cuando nada postea");
      }
      // El MISMO evaluador para el modo real y la sombra: el veredicto
      // registrado sale de evaluarAutoPost, no de una copia que diverge.
      //
      // EL ANCLA CAMBIÓ EN A7, Y ES LA MITAD DE LA HISTORIA. Pedía
      // literalmente `wouldAutoPost: veredicto.procede`, y eso era exacto
      // mientras el modo encendido tuviera UNA sola vía. A3 le añadió la
      // segunda —la política otorgada, cuando una compuerta discrecional no
      // basta— y entonces la fidelidad exigía lo contrario de lo que el
      // criterio pedía: registrar sólo el umbral mide un clasificador MÁS
      // CONSERVADOR que el que se enciende. El piso por criterio (S2) cazó
      // este cambio en el mismo commit, que es exactamente para lo que se
      // construyó. Se sigue exigiendo que el veredicto salga del evaluador
      // compartido, ahora componiéndolo con la vía de política.
      if (!/const habriaPosteado = veredicto\.procede \|\| porPolitica !== null/.test(ing)) {
        return falla('la sombra dejó de componer su veredicto con el evaluador compartido y la vía de política: mediría un clasificador que no es el real');
      }
      const sv = codigoDe('src/ai/shadow-verdicts.ts');
      if (!/ON CONFLICT \(draft_id\) DO NOTHING/.test(sv)) {
        return falla('el registro del veredicto perdió su idempotencia: reintentos duplicarían opiniones');
      }
      // Conteos ×2 (numerador Y denominador excluyen máquina): mutar uno
      // dejando el otro pasa un chequeo de presencia — la lección de R1.
      const notasAuto = (sv.match(/'auto-post by threshold%'/g) ?? []).length;
      const prefPol = (sv.match(/'policy:%'/g) ?? []).length;
      if (notasAuto < 2 || prefPol < 2) {
        return falla(
          `la concordancia volvería a contar decisiones de máquina (nota auto ×${notasAuto}, prefijo policy ×${prefPol}): el agente se calificaría a sí mismo`
        );
      }
      const ps = codigoDe('src/services/policy/policy-service.ts');
      if (!/key === 'ingest_auto_post' && value === 'on'/.test(ps)) {
        return falla("la compuerta de evidencia desapareció de resolvePolicy: 'on' volvería a ser una casilla sin historial");
      }
      // Las TRES varas del piso, cada una comparada de verdad.
      if (
        !/c\.dias_con_veredictos < FLOOR_SOMBRA_DIAS/.test(ps) ||
        !/c\.decididos < FLOOR_SOMBRA_VEREDICTOS/.test(ps) ||
        !/acuerdo < FLOOR_SOMBRA_ACUERDO/.test(ps)
      ) {
        return falla('el piso del encendido perdió una de sus tres varas (días, volumen decidido, acuerdo)');
      }
      if (!/polAuto\.defined && polAuto\.value === 'shadow'/.test(codigoDe('src/ai/ingest-thresholds.ts'))) {
        return falla('la sombra dejó de ser SOLO del panel: un literal suelto en el archivo de config no debe encenderla');
      }
      return /value: 'shadow'/.test(codigoDe('src/services/policy/pending-catalog.ts'))
        ? ok('sombra panel-only con veredicto único por borrador, concordancia sobre humanos y encendido con peaje de evidencia')
        : falla('el panel perdió la opción shadow: el camino al encendido quedaría sin puerta');
    },
  },

  // ---- F03 · Cobrar ----

  {
    paquete: 'E0.1',
    enunciado: 'La nota de crédito postea al emitir por la vía única, y su aplicación no toca efectivo',
    mutantes: [
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "sourceType: 'credit_note'",
        a: "sourceType: 'nota'",
        porque: 'la nota pierde su source_type: el asiento quedaría sin documento',
      },
    ],
    evaluar: () => {
      // F03: la nota es documento con folio (CN), posteada por el MISMO
      // motor AR→GL que la factura (ar-ap-posting), idempotente tras su
      // journal_entry_id. La aplicación reparte en el auxiliar SIN asiento
      // (el mayor se movió al emitir) y SIN tocar amount_paid — una nota no
      // es efectivo, y confundirlos infla el cobrado que el REP reporta.
      const posting = codigoDe('src/services/accounting/ar-ap-posting.ts');
      if (!/sourceType: 'credit_note'/.test(posting)) {
        return falla('la nota dejó de postear por la vía única con su source_type: el asiento perdería su documento');
      }
      if (!/if \(note\.journal_entry_id\) return null/.test(posting)) {
        return falla('postCreditNoteEntry perdió la idempotencia: reemitir duplicaría el crédito contra CxC');
      }
      if (!/requireRole\(roles, 'devolucion_ventas'\)/.test(posting)) {
        return falla('la nota dejó de cargar al contra-ingreso por rol: caería a una cuenta adivinada');
      }
      const svc = codigoDe('src/services/ar/credit-note-service.ts');
      // La forma EXACTA del UPDATE de aplicación: baja amount_due, conserva
      // el status salvo saldado, y NO nombra amount_paid. Un mutante que
      // sume amount_paid ahí rompe este regex por construcción.
      if (!/amount_due = amount_due - \$1,\s*\n\s*status = CASE WHEN amount_due - \$1 <= 0 THEN 'paid' ELSE status END/.test(svc)) {
        return falla('la aplicación de la nota cambió su UPDATE: o toca amount_paid (una nota no es efectivo) o perdió el estado saldado');
      }
      // La liga fiscal, con sus dos guardas: ligada→sólo su factura, y
      // suelta→jamás a una PPD (el IVA quedaría varado en la 2125).
      if (!/nota\.invoice_id && nota\.invoice_id !== factura\.id/.test(svc)) {
        return falla('una nota ligada volvería a aplicarse a cualquier factura: el IVA por método de pago se descuadraría');
      }
      if (!/metodo\.metodo === 'PPD'/.test(svc)) {
        return falla('la nota suelta dejó de rechazar facturas PPD: aplicarla dejaría IVA aparcado para siempre');
      }
      return /SUM\(total_amount - amount_applied\)/.test(codigoDe('src/services/ar/ar-controls.ts'))
        ? ok('vía única con idempotencia, aplicación sin efectivo con liga fiscal, y la conciliación resta las notas por aplicar')
        : falla('ar reconcile dejó de restar las notas emitidas por aplicar: el descuadre legítimo se volvería hallazgo falso');
    },
  },
  {
    paquete: 'E0.1',
    enunciado: 'El folio eliminado deja hueco explicado, y el perfil fiscal se valida contra catálogo antes de escribir',
    mutantes: [
      {
        archivo: 'src/database/migrations/049_cobrar.sql',
        de: 'ADD COLUMN tax_regime VARCHAR(3),',
        a: 'ADD COLUMN tax_regimen VARCHAR(3),',
        porque: 'el mutante-sufijo: «tax_regimen» CONTIENE «tax_regime» y solo \\b lo mata',
      },
    ],
    evaluar: () => {
      // F03: borrar un borrador es legal; borrar su rastro no. El DELETE
      // guarda el documento completo en audit_log y la serie cruza sus
      // huecos contra ese rastro: hueco con motivo = explicado; sin motivo
      // = hallazgo. Y el perfil fiscal (régimen/CP/UsoCFDI, 049) valida
      // contra los catálogos del SAT ANTES del UPDATE: un código inventado
      // fallaría el timbrado semanas después, donde ya nadie recuerda.
      const inv = codigoDe('src/services/ar/invoice-service.ts');
      // Conteo ×2: el folio del muerto se escribe en el audit (delete) Y se
      // busca desde la serie — mutar uno deja al otro y un chequeo de
      // presencia lo bendice.
      const rastroFolio = (inv.match(/invoice_number/g) ?? []).length;
      if (!/action: 'delete',\s*\n\s*entityType: 'invoices'/.test(inv)) {
        return falla('deleteDraftInvoice dejó de auditar el DELETE: el hueco de la serie quedaría sin explicación posible');
      }
      // Conteo ×2: el folio del audit se LEE (SELECT) y se CRUZA (WHERE);
      // mutar uno deja al otro y la presencia lo bendice.
      if ((inv.match(/old_values->>'invoice_number'/g) ?? []).length < 2) {
        return falla('checkInvoiceSeries dejó de cruzar los huecos contra el audit_log: todo hueco sería hallazgo, o peor, ninguno');
      }
      if (rastroFolio < 10) {
        return falla(`invoice_number aparece ×${rastroFolio} en invoice-service: la serie o el rastro perdieron piezas`);
      }
      // Las TRES guardas del DELETE, cada una con su ancla propia (una
      // alternativa compartida bendeciría al mutante que borre una sola).
      if (!/if \(factura\.journal_entry_id\)/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda del asiento: se podría borrar un documento que tocó el mayor');
      }
      if (!/if \(factura\.cfdi_uuid\)/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda del CFDI: un timbrado se cancela ante el SAT, no se borra');
      }
      if (!/FROM payment_allocations WHERE invoice_id = \$1/.test(inv)) {
        return falla('deleteDraftInvoice perdió la guarda de cobros: se borraría una factura con dinero aplicado');
      }
      const cust = codigoDe('src/services/ar/customer-service.ts');
      // Conteo ×2 por catálogo: se usa al MOSTRAR (nombre legible) y al
      // ESCRIBIR (validación) — la validación es la que salva el timbrado.
      if (
        (cust.match(/SAT_CATALOGS\.REGIMEN_FISCAL/g) ?? []).length < 2 ||
        (cust.match(/SAT_CATALOGS\.USO_CFDI/g) ?? []).length < 2
      ) {
        return falla('el perfil fiscal dejó de validar contra los catálogos del SAT: un código inventado se guardaría y fallaría al timbrar');
      }
      if (!/RFC_CLIENTE_RE\.test\(rfc\)/.test(cust)) {
        return falla('el RFC del cliente dejó de validarse en forma antes de escribirse');
      }
      // \b: la lección del mutante-sufijo — «tax_regimen» CONTIENE
      // «tax_regime» y un regex sin frontera lo bendice.
      return /ADD COLUMN tax_regime\b/.test(
        crudoDe('src/database/migrations/049_cobrar.sql')
      )
        ? ok('DELETE con rastro completo y serie que lo lee; perfil fiscal validado contra catálogo antes del UPDATE')
        : falla('la 049 perdió las columnas del perfil fiscal: el control previo a facturar no tendría dónde vivir');
    },
  },
  {
    paquete: 'E1.2',
    enunciado: 'El cobro es historia: la aplicación se clausura, su IVA viaja en la fila y la reversa es por espejos',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "SET status = 'reversed', reversed_at = NOW()",
        a: "SET status = 'void', reversed_at = NOW()",
        porque: "«reversed» degradado a «void»: ocurrió-y-rebotó es otra afirmación ante un auditor",
      },
    ],
    evaluar: () => {
      // F03: tres propiedades que mantienen el IVA de flujo de efectivo
      // verdadero cuando el cobro deja de ser una instantánea:
      // 1. SÓLO las aplicaciones VIVAS cuentan — una clausurada que siguiera
      //    contando re-liberaría el IVA que su desaplicación ya re-aparcó;
      // 2. el IVA liberado se guarda POR APLICACIÓN, para desaplicar el
      //    importe EXACTO y no re-derivarlo bajo otro contexto;
      // 3. la reversa NSF refleja CADA asiento del cobro (espejo NIF B-1) y
      //    el estado queda 'reversed' — ocurrió y rebotó, no 'void'.
      const iva = codigoDe('src/services/accounting/iva-cash-basis.ts');
      // Los DOS filtros de vida (pa y pa2): mutar uno deja al otro.
      if (!/pa\.unapplied_at IS NULL/.test(iva) || !/pa2\.unapplied_at IS NULL/.test(iva)) {
        return falla('invoicesAppliedBy volvió a contar aplicaciones clausuradas: el IVA se liberaría dos veces');
      }
      // Las DOS vías persisten el IVA de la fila, cada una donde vive: el
      // registro (posting escribe tras armar sus líneas) y la aplicación
      // posterior (el servicio, sobre las filas recién insertadas).
      const posting = codigoDe('src/services/accounting/ar-ap-posting.ts');
      const pagosSvc = codigoDe('src/services/payments/payment-service.ts');
      if (
        !/SET iva_reclass_amount = \$1/.test(posting) ||
        !/SET iva_reclass_amount = \$1 WHERE id = \$2/.test(pagosSvc)
      ) {
        return falla('el IVA por aplicación dejó de persistirse en las DOS vías (registro y aplicación posterior): desaplicar volvería a adivinar');
      }
      // El rol de anticipos se EXIGE en las tres vías (registro con
      // remanente, aplicación posterior, desaplicación): conteo de la forma
      // de llamada, no presencia — quitar una vía deja las otras dos y un
      // chequeo laxo lo bendice.
      if ((posting.match(/requireRole\(roles, 'anticipo_clientes'\)/g) ?? []).length < 3) {
        return falla('el remanente a cuenta perdió una de sus tres vías: lo no aplicado volvería a colgar de la cuenta de control');
      }
      const pagos = pagosSvc;
      if (!/voidJournalEntryInTx\(client, je\.id, userId, `NSF: /.test(pagos)) {
        return falla('la reversa NSF dejó de reflejar los asientos por la vía NIF B-1: quedaría dinero contado sin espejo');
      }
      if (!/SET status = 'reversed', reversed_at = NOW\(\)/.test(pagos)) {
        return falla("el cobro devuelto dejó de quedar 'reversed': se confundiría con 'void', que es otra afirmación ante un auditor");
      }
      // Conteo ×2: la clausura con motivo vive en DOS vías (desaplicar y
      // reversa NSF); mutar una deja la otra y la presencia lo bendice.
      return (pagos.match(/SET unapplied_at = NOW\(\), unapplied_by = \$1, unapply_reason = \$2/g) ?? []).length >= 2
        ? ok('aplicaciones con clausura (nunca DELETE), IVA exacto por fila, remanente en anticipos y reversa por espejos')
        : falla('la desaplicación dejó de clausurar con rastro: borraría historia en lugar de cerrarla');
    },
  },
  {
    paquete: 'E3.1',
    enunciado: 'Lo que no envía no existe: el adaptador de correo simulado está retirado',
    mutantes: [
      {
        archivo: 'src/api/rest/routes/invoices.ts',
        de: 'transmitted: false',
        a: 'transmitted: true',
        porque: 'la ruta vuelve a mentir que transmite: el «sent:true sin envío» que CLI-5 purgó',
      },
    ],
    evaluar: () => {
      // F03: el plan preguntaba «¿cablear invoice send al adaptador SendGrid
      // o retirar la promesa?» y el reconocimiento volteó la premisa: el
      // adaptador era simulación doble — send() fabricaba el messageId con
      // crypto.randomBytes sin llamar a la API, healthCheck() devolvía sano
      // fijo, y los adjuntos se descartaban. Cablearlo habría recreado el
      // «sent:true sin envío» que CLI-5 purgó y que el cerrojo
      // antisimulación del timbrado existe para impedir. Se retiró entero;
      // la ruta REST conserva su contrato honesto: marca, no transmite.
      if (existe('src/services/integrations/email/sendgrid-adapter.ts')) {
        return falla('el adaptador simulado volvió: un send() que fabrica messageId sin llamar a la API es la mentira que este criterio veta');
      }
      if (/sendGrid/i.test(codigoDe('src/services/integrations/index.ts'))) {
        return falla('el registro de integraciones volvió a anunciar un correo que no existe: el panel aceptaría credenciales para nada');
      }
      const rutas = codigoDe('src/api/rest/routes/invoices.ts');
      // El contrato honesto de /send, con sus dos mitades: marca Y confiesa.
      if (!/transmitted: false/.test(rutas)) {
        return falla('POST /:id/send dejó de confesar que no transmite: volvería el «sent» que no envió nada');
      }
      return /marked_sent: true/.test(rutas)
        ? ok('adaptador retirado, registro limpio y la ruta de envío marca confesando que no transmite')
        : falla('la ruta de envío perdió su mitad honesta: marcar sin decir qué significó');
    },
  },

  // ---- S2 · El instrumento se somete al instrumento ----

  {
    paquete: 'E0.0',
    enunciado: 'Los criterios tienen espejo ejecutable: un mutante declarado los pone en rojo',
    evaluar: () => {
      // S2: §7 prometía desde el principio que «cada criterio llega con su
      // espejo que neutraliza la conducta medida y afirma el rojo». Era verdad
      // a medias — los espejos existían como PASE MANUAL, corrido a mano cada
      // fase, cuyo resultado vivía en el mensaje del commit. Nada impedía que
      // un criterio naciera sin ninguno ni que uno viejo dejara de morder.
      //
      // Ahora el espejo es una prueba: cada `mutante` se aplica sobre el seam
      // de lectura (overlay en memoria, el árbol jamás se toca) y se exige
      // `falla`. Este criterio vigila que el arnés siga existiendo, que el
      // seam siga siendo la única puerta de lectura, y que la deuda encoja.
      if (!existe('tests/plan/mutacion.spec.ts')) {
        return falla('el arnés de mutación desapareció: los espejos volverían a ser un pase manual');
      }
      const arnes = codigoDe('tests/plan/mutacion.spec.ts');
      if (!/conFuenteMutada\(overlay, \(\) => criterio\.evaluar\(\)\)/.test(arnes)) {
        return falla('el arnés dejó de evaluar el criterio BAJO la mutación: mediría el árbol limpio');
      }
      if (!/\.toBe\('falla'\)/.test(arnes)) {
        return falla('el arnés dejó de EXIGIR el rojo: un mutante que sobrevive pasaría inadvertido');
      }
      // El seam es la única puerta: si un criterio vuelve a leer el disco
      // directo, su mutante no lo toca y el espejo miente en verde. Se cuenta
      // sobre el fuente CRUDO porque el comentario que lo explica también
      // nombra fs.readFileSync — y aquí importa el conteo, no la presencia.
      const cru = crudoDe('src/plan/criterios.ts');
      const lecturasDirectas = (cru.match(/fs\.readFileSync\(/g) ?? []).length;
      if (lecturasDirectas > 1) {
        return falla(
          `${lecturasDirectas} lectura(s) directa(s) de disco en los criterios: sólo puede quedar la ` +
            'de leer() (el seam). Una lectura que rodea el seam es un criterio que ningún espejo puede mutar.'
        );
      }
      // La línea base sólo SUBE: S2 nace con catorce espejos y ninguno se
      // retira sin bajar este número a la vista, en el mismo commit.
      const conEspejo = CRITERIOS.filter((c) => (c.mutantes?.length ?? 0) > 0).length;
      return conEspejo >= 14
        ? ok(`${conEspejo} criterios con espejo ejecutable; toda lectura de fuente pasa por el seam`)
        : falla(`sólo ${conEspejo} criterios con espejo declarado: la línea base de S2 eran 14 y sólo sube`);
    },
    mutantes: [
      {
        archivo: 'tests/plan/mutacion.spec.ts',
        de: ".toBe('falla')",
        a: ".toBe('ok')",
        porque: 'el arnés deja de exigir el rojo: los espejos pasarían a bendecir a los mutantes vivos',
      },
    ],
  },
  {
    paquete: 'E0.0',
    enunciado: 'El corpus que instruye al agente tiene compuerta de caducidad',
    evaluar: () => {
      // S2: el agente lee src/ai/docs como VERDAD —grounding.ts incluso lo
      // manda a leerlos para *verificar*— y la auditoría II encontró dos
      // páginas que le enseñaban lo que el sistema tiene módulos para
      // corregir: el IVA acreditado de inmediato (el defecto que
      // iva-ppd-reclass repara) y una anulación con auto-posteo que R1 hizo
      // imposible. No estaban desactualizadas: MAL-INSTRUÍAN, y su lector no
      // puede dudar como dudaría una persona.
      if (!existe('src/ai/docs/manifiesto.json') || !existe('scripts/corpus-manifiesto.ts')) {
        return falla('el manifiesto del corpus desapareció: los manuales del agente volverían a caducar en silencio');
      }
      const script = codigoDe('scripts/corpus-manifiesto.ts');
      if (!/sellado !== hoy/.test(script)) {
        return falla('el manifiesto dejó de comparar hashes: no detectaría que una fuente cambió');
      }
      if (!/m\.sin_revisar\.length > SIN_REVISAR_MAXIMO/.test(script)) {
        return falla('la deuda de manuales sin revisar dejó de tener trinquete: podría crecer en silencio');
      }
      // La compuerta corre en CI o es un comando que nadie teclea.
      if (!/corpus-manifiesto\.ts --check/.test(crudoDe('.github', 'workflows', 'ci.yml'))) {
        return falla('la compuerta del corpus no está en CI: sería una comprobación optativa');
      }
      // Y los dos pasajes que mal-instruían quedaron corregidos: el manual
      // debe NOMBRAR la cuenta donde el IVA de un PPD aparca, y decir que un
      // asiento posteado no cambia de estado.
      const cfdi = crudoDe('src/ai/docs/mexico-cfdi.md');
      // La FRASE, no el número. Bastaba con que «1135» apareciera en alguna
      // parte, y F05d añadió una segunda mención (la regla del cheque
      // cobrado): mutar la del PPD dejaba la otra en pie y el criterio seguía
      // en verde mientras el manual enseñaba justo lo contrario de lo que
      // vigila. Un número suelto no es una lección; la lección es a qué cuenta
      // va el IVA de un PPD.
      if (!/PPD received → DR 1135/.test(cfdi) || !/2125/.test(cfdi)) {
        return falla('mexico-cfdi.md volvió a enseñar el IVA sin las cuentas de aparcado (1135/2125)');
      }
      return /IMMUTABLE|inmutable/i.test(crudoDe('src/ai/docs/accounting.md'))
        ? ok('manifiesto con hashes y deuda que sólo encoge, en CI, y los dos manuales que mal-instruían corregidos')
        : falla('accounting.md volvió a prometer que un asiento posteado cambia de estado');
    },
    mutantes: [
      {
        // Anclado en la FRASE del PPD y no en el número suelto. Con `de: '1135'`
        // el mutante cambiaba la primera aparición del documento, y F05d añadió
        // otra antes (la regla del cheque cobrado): el criterio encontraba la
        // que quedaba y el mutante sobrevivía. El gemelo de siempre.
        archivo: 'src/ai/docs/mexico-cfdi.md',
        de: 'PPD received → DR 1135',
        a: 'PPD received → DR 1130',
        porque: 'el manual vuelve a enseñar que el IVA de un PPD se acredita de inmediato: el defecto que iva-ppd-reclass existe para reparar',
      },
      {
        archivo: 'scripts/corpus-manifiesto.ts',
        de: 'sellado !== hoy',
        a: 'sellado === hoy',
        porque: 'la comparación de hashes se invierte: la compuerta pasaría a acusar lo que NO cambió',
      },
    ],
  },
  // ---- S3 · Respaldo, restauración y el corredor que no rellenaba ----

  {
    paquete: 'E0.0',
    enunciado: 'El migrador no puede rellenar cero filas en silencio: Postgres se lo impide',
    evaluar: () => {
      // EL DEFECTO. Las migraciones corren como un rol NOBYPASSRLS que además
      // es DUEÑO de tablas con FORCE ROW LEVEL SECURITY — lo que le quita su
      // exención implícita. Sin contexto de inquilino, todo DML de migración
      // sobre una tabla acotada afecta CERO FILAS, sin error, y la migración
      // se registra como aplicada. Reproducido: el rol ve 0 de 4 entidades.
      // Tres migraciones lo sufrieron (037, 040, 043) y una ya provocó una
      // colisión de folios en un despliegue real.
      //
      // POR QUÉ NO BASTA DOCUMENTARLO: la 026 ya había escrito el patrón
      // correcto —el bucle por inquilino— y la 043 lo repitió sin él
      // dieciocho migraciones después. Es reincidencia, no descuido.
      //
      // LA GUARDA ES DE POSTGRES, NO NUESTRA, y esa es su virtud. Con
      // `row_security = off` el motor no desactiva RLS: LANZA 42501 cuando
      // una consulta habría sido filtrada. El cuarto olvido no podrá callar,
      // porque quien se niega es el motor y no un regex sobre el .sql. Una
      // migración que SÍ maneja inquilinos hace opt-in explícito con
      // `SET LOCAL row_security = on` y su bucle.
      const m = codigoDe('src/database/migrate.ts');
      if (!/SET row_security = off/.test(m)) {
        return falla(
          'el migrador dejó de correr con row_security=off: el filtrado silencioso volvería a ser ' +
            'silencioso, y la clase que ya costó una colisión de folios podría repetirse'
        );
      }
      // Y la reparación de lo que se perdió, con el patrón que la 026
      // consagró: iterar inquilinos fijando el contexto.
      const reparacion = 'src/database/migrations/048_reparar_lo_que_rls_filtro_en_silencio.sql';
      if (!existe(reparacion)) {
        return falla('la migración de reparación desapareció: las tres siembras mudas seguirían mudas');
      }
      const r = crudoDe(reparacion);
      const cubre =
        /range_proof = NULL/.test(r) &&
        /zkverify_proof = NULL/.test(r) &&
        (r.match(/INSERT INTO entity_sequences/g) ?? []).length >= 5 &&
        /UPDATE bills/.test(r);
      if (!cubre) {
        return falla('la reparación dejó de cubrir las tres migraciones (037 etiquetado, 040 purga, 043 siembra)');
      }
      return /SET LOCAL row_security = on/.test(r) && /set_config\('app\.current_tenant'/.test(r)
        ? ok('el motor lanza 42501 ante el filtrado silencioso, y la reparación re-corre las tres con el bucle por inquilino')
        : falla('la reparación no declara su opt-in ni fija contexto: correría bajo el piso y fallaría, o volvería a rellenar cero');
    },
    mutantes: [
      {
        archivo: 'src/database/migrate.ts',
        de: "await client.query('SET row_security = off');",
        a: "await client.query('SELECT 1');",
        porque: 'el piso desaparece y el filtrado silencioso vuelve a ser silencioso: la clase que ya costó una colisión de folios',
      },
      {
        archivo: 'src/database/migrations/048_reparar_lo_que_rls_filtro_en_silencio.sql',
        de: 'SET LOCAL row_security = on',
        a: 'SET LOCAL row_security = off',
        porque: 'la reparación pierde su opt-in: correría bajo el piso y ni siquiera podría leer lo que viene a reparar',
      },
    ],
  },
  {
    paquete: 'E0.0',
    enunciado: 'Un respaldo se prueba restaurándolo, y dice lo que no lleva',
    evaluar: () => {
      // S3: el mayor es inmutable a propósito (041 no admite UPDATE ni
      // DELETE sobre lo posteado; 033 deja la bitácora en sólo-agregar), y
      // esa misma inmutabilidad impide repararlo a mano — la 041 llega a
      // prescribir «bórrala entera y vuelve a migrar». La vía de recuperación
      // que el esquema NOMBRA es la restauración, y no existía ni una línea
      // sobre ella en todo el árbol.
      if (!existe('src/services/backup/backup-service.ts')) {
        return falla('no hay camino de respaldo: la inmutabilidad del mayor deja de ser una garantía y pasa a ser una trampa');
      }
      const b = codigoDe('src/services/backup/backup-service.ts');
      // La verificación que importa RESTAURA. Un verificador que sólo mira el
      // archivo comprueba que existe, no que sirva.
      // Forma de LLAMADA, no el símbolo: el nombre también aparece en el
      // import, y un regex laxo bendice al mutante que deja el import y
      // desconecta la llamada — la lección de AUD-6, cometida aquí mismo al
      // escribir este criterio y cazada por su propio espejo.
      if (!/pg_restore/.test(b) || !/await runLedgerChecksEn\(/.test(b)) {
        return falla('la verificación dejó de restaurar y de correr los chequeos: un respaldo no probado no es un respaldo');
      }
      // Y falla cerrado si el rol no puede volcar: se descubrió construyéndolo
      // que pg_dump como dueño REVIENTA por FORCE RLS — la misma clase que
      // silenciaba el DML, ahora sobre la recuperación.
      // El ANCLA ES LA NEGATIVA, no la existencia del comprobador: dejar la
      // función y borrar el `throw` es exactamente el mutante que sobrevivió
      // a la primera versión de este criterio.
      if (!/if \(!capacidad\.puede\) throw new ValidationError/.test(b) || !/rolbypassrls/.test(b)) {
        return falla('el respaldo dejó de NEGARSE cuando el rol no puede volcar: produciría un volcado parcial con nombre de respaldo');
      }
      // Lo que el volcado NO lleva se declara SIEMPRE: el material
      // criptográfico vive fuera de la base y sin él lo restaurado queda
      // ilegible.
      if (!/noIncluye/.test(b) || !/ENCRYPTION_KEY/.test(b)) {
        return falla('el manifiesto dejó de declarar lo que el volcado no lleva: prometería un respaldo completo que no lo es');
      }
      return /restaurar encima de una viva|ya existe/.test(b)
        ? ok('respaldo con manifiesto, verificación que restaura y corre los chequeos, y lo que no lleva declarado')
        : falla('la restauración dejó de exigir base NUEVA: sobrescribir una viva destruye lo que se intenta salvar');
    },
    mutantes: [
      {
        archivo: 'src/services/backup/backup-service.ts',
        de: 'if (!capacidad.puede) throw new ValidationError(capacidad.motivo);',
        a: 'void capacidad;',
        porque: 'el respaldo deja de fallar cerrado y produce un volcado parcial con nombre de respaldo',
      },
      {
        // Sobre la LLAMADA, no sobre el import: mutar el import deja la
        // llamada viva y el criterio la sigue viendo — lo comprobó este mismo
        // espejo, que en su primera versión declaró el mutante flojo.
        archivo: 'src/services/backup/backup-service.ts',
        de: 'await runLedgerChecksEn(',
        a: 'await noVerificarNada(',
        porque: 'la verificación deja de correr los chequeos del mayor: comprobaría que el archivo existe, no que sirva',
      },
    ],
  },

  // ---- A7 · Una sola puerta al auto-posteo ----

  {
    paquete: 'E1.3',
    enunciado: 'Encender el auto-posteo es del panel: la bandera y el archivo sólo pueden ser más estrictos',
    evaluar: () => {
      // A7: el piso de evidencia (A4) vive en el panel, así que cualquier capa
      // que encienda por su cuenta lo rodea ENTERO. La auditoría integral II
      // lo ejecutó: panel en 'shadow' + archivo en true = posteo real, sin un
      // solo veredicto de sombra registrado. Contestar «mídelo primero»
      // producía posteo con cero evidencia, en silencio.
      //
      // La regla ya existía para el tope de monto y ahora rige las tres
      // decisiones: apagar y apretar son de cualquiera; encender y aflojar,
      // sólo del despacho.
      const t = codigoDe('src/ai/ingest-thresholds.ts');
      // La forma exacta de la asimetría: encender exige que el panel ya lo
      // hubiera autorizado. Un `autoPost = valor` suelto la rompe.
      if (!/const autorizado = polAuto\.defined/.test(t)) {
        return falla('el interruptor dejó de derivarse del panel: la capa local volvería a poder encender');
      }
      if (!/if \(valor === false\) \{/.test(t) || !/if \(autorizado\) \{/.test(t)) {
        return falla('la asimetría perdió su forma: apagar y encender volverían a tratarse igual');
      }
      // Y el intento ignorado no desaparece: el operador tiene que poder
      // entender por qué su `true` no hizo nada.
      if (!/encendidoIgnorado/.test(t) || !/encendidoIgnorado/.test(codigoDe('src/cli/mnemosine.ts'))) {
        return falla('un encendido ignorado volvería a ser silencioso: el operador no sabría por qué su archivo no hace nada');
      }
      // El tope: la bandera vivía FUERA de la regla que el archivo ya
      // respetaba, así que --max-amount subía el techo del panel.
      return /const tope = maxPolitica \?\? Infinity/.test(t)
        ? ok('encender y aflojar el tope son del panel; apagar y apretar, de cualquier capa, y lo ignorado se dice')
        : falla('la bandera puede volver a aflojar el tope por encima de lo que el despacho contestó');
    },
    mutantes: [
      {
        archivo: 'src/ai/ingest-thresholds.ts',
        de: 'if (autorizado) {',
        a: 'if (true) {',
        porque: 'la capa local vuelve a encender sobre un panel que no lo autorizó: la puerta que A7 cerró',
      },
      {
        archivo: 'src/ai/ingest-thresholds.ts',
        de: 'const tope = maxPolitica ?? Infinity;',
        a: 'const tope = Infinity;',
        porque: 'la bandera vuelve a aflojar el tope por encima del panel',
      },
    ],
  },
  {
    paquete: 'E1.3',
    enunciado: 'La sombra mide el modo que se va a encender, y la decisión se escribe donde se midió',
    evaluar: () => {
      // A7, dos mitades de la misma idea: la evidencia sólo autoriza si mide
      // LO MISMO que se enciende, y en el MISMO alcance.
      //
      // (1) Desde A3 el modo encendido tiene dos vías: el umbral y, cuando una
      //     compuerta discrecional no basta, la política otorgada. Una sombra
      //     ciega a la segunda acumula evidencia sobre un clasificador más
      //     conservador que el real.
      const ing = codigoDe('src/ai/ingest-service.ts');
      if (!/wouldMatchApproval\(/.test(ing)) {
        return falla('la sombra volvió a medir sólo el umbral: la evidencia validaría un clasificador que no es el que se enciende');
      }
      if (!/wouldAutoPost: habriaPosteado/.test(ing)) {
        return falla('el veredicto registrado dejó de incluir la vía de política');
      }
      // La sombra NO puede gastar políticas: el emparejador de solo lectura
      // existe justo para eso, y debe seguir sin tocar last_used_at.
      const ap = codigoDe('src/ai/approval-policy.ts');
      const iWould = ap.indexOf('export async function wouldMatchApproval');
      const cuerpo = iWould >= 0 ? ap.slice(iWould, ap.indexOf('export async function matchApproval')) : '';
      if (!cuerpo || /UPDATE ai_approval_policies/.test(cuerpo)) {
        return falla('el emparejador de sombra escribe: una sombra con efectos gasta las políticas que dice sólo observar');
      }
      // (2) El alcance: la evidencia se mide por entidad y la decisión se
      //     escribía sin acotar, así que siete días de sombra en UNA entidad
      //     encendían el auto-posteo de todas.
      const ps = codigoDe('src/services/policy/policy-service.ts');
      return /AND entity_id IS NOT DISTINCT FROM \$6::uuid/.test(ps)
        ? ok('la sombra consulta la vía de política sin consumirla, y la decisión se resuelve en el alcance que se midió')
        : falla('resolvePolicy volvió a escribir sin acotar por entidad: la evidencia de una entidad encendería a todas');
    },
    mutantes: [
      {
        archivo: 'src/services/policy/policy-service.ts',
        de: 'AND entity_id IS NOT DISTINCT FROM $6::uuid',
        a: '',
        porque: 'la decisión vuelve a escribirse sin alcance: la evidencia de una entidad enciende a todas (pilar 6 del plan)',
      },
      {
        archivo: 'src/ai/ingest-service.ts',
        de: 'wouldAutoPost: habriaPosteado',
        a: 'wouldAutoPost: veredicto.procede',
        porque: 'la sombra vuelve a registrar sólo el umbral y la evidencia mide un modo distinto del que se enciende',
      },
    ],
  },
  {
    paquete: 'E0.0',
    enunciado: 'El costo por fila publica su banda y separa entrega de garantía',
    evaluar: () => {
      // S2: el instrumento publicaba 0,7 % de cola correctiva —y bajando,
      // porque su regex sobre el asunto sólo casaba uno de cada dieciocho
      // commits correctivos— donde la medición a mano de la auditoría II da
      // entre 11,8 % y 51,7 %. Subestimaba por un factor de 17× a 74× y lo
      // hacía dos líneas encima de la referencia fundacional del 12,3 %, como
      // invitando a concluir que la cola se había resuelto sola.
      const s = codigoDe('scripts/costo-por-fila.ts');
      // La banda son DOS convenciones publicadas juntas: una sola volvería a
      // cerrar la pregunta con un número.
      if (!/estricta/.test(s) || !/amplia/.test(s)) {
        return falla('la cola volvió a publicarse como un número solo: cerraría la pregunta con la cifra equivocada');
      }
      if (!/TRAILER_CORRIGE/.test(s)) {
        return falla('el clasificador perdió el trailer declarado y volvería a depender sólo de adivinar el asunto');
      }
      // Entrega y garantía MEDIDAS por ruta, no derivadas de un porcentaje.
      if (!/export function entregaYGarantia/.test(s) || !/insercionesEn\(a, b, 'tests', 'scripts'\)/.test(s)) {
        return falla('entrega y garantía dejaron de medirse por ruta: volverían a ser una estimación de una estimación');
      }
      return /ENTREGA/.test(s) && /GARANTÍA/.test(s)
        ? ok('la cola se publica como banda con su trailer, y entrega/garantía salen medidas por ruta')
        : falla('la salida dejó de separar entrega de garantía: presupuestar una fase con el número junto la presupuesta mal');
    },
    mutantes: [
      {
        archivo: 'scripts/costo-por-fila.ts',
        de: "insercionesEn(a, b, 'tests', 'scripts')",
        a: 'insercionesEn(a, b)',
        porque: 'la garantía deja de medirse por ruta y se cuenta el árbol entero: la separación se vuelve ruido',
      },
    ],
  },





  // ---- F05d · La firma y el sello ----

  {
    paquete: 'E1.2',
    enunciado: 'El asiento de tesorería cae en el día que ocurrió, no en la víspera',
    mutantes: [
      {
        archivo: 'src/services/banking/treasury-posting.ts',
        de: "  return new Date(`${iso}T00:00:00`);",
        a: "  return new Date(`${iso}T00:00:00Z`);",
        porque: 'vuelve la medianoche UTC: en México el asiento se fecha el día ANTERIOR, y el día 1 de mes eso lo manda al mes anterior con su IVA a otra declaración, cuadrando igual de bien',
      },
    ],
    evaluar: () => {
      // EL DEFECTO QUE CASI SE VA VIVO, y el único de F05d que era de
      // gravedad 1. `new Date('2026-06-01T00:00:00Z')` es medianoche UTC, y
      // `createJournalEntry` pasa ese Date al driver, que lo serializa en la
      // zona del PROCESO: en México (UTC−6) esa medianoche es el 31 de mayo a
      // las 18:00. El asiento se guardaba fechado un día antes Y colgado del
      // periodo fiscal de ese día.
      //
      // Medido: un cheque cobrado el 1 de junio posteaba su reclasificación de
      // IVA en MAYO — es decir, en otra declaración mensual—, y el 1 de enero
      // se lleva además el folio al ejercicio anterior. Y cuadra igual de
      // bien, que es lo que lo hacía invisible.
      //
      // Afectaba a los TRES verbos de tesorería. `treasury-posting.ts` era el
      // único de los cuatro sitios del sistema que crean asientos desde una
      // fecha ISO que lo hacía en UTC.
      const t = codigoDe('src/services/banking/treasury-posting.ts');
      if (!/function fechaDelAsiento\(/.test(t)) {
        return falla('desapareció el constructor único de la fecha del asiento: cada verbo volvería a fabricarla por su cuenta');
      }
      if (/new Date\(`\$\{[a-zA-Z.]+\}T00:00:00Z`\)/.test(t)) {
        return falla('volvió la medianoche UTC: el asiento se fecharía un día antes, y el día 1 de mes eso es el mes anterior');
      }
      // Y LO USAN LOS TRES. Que exista el helper no sirve si un verbo se lo
      // salta: el defecto original era exactamente un sitio de cuatro.
      const usos = (t.match(/fechaDelAsiento\(/g) ?? []).length;
      return usos >= 4
        ? ok('la fecha del asiento la construye un solo sitio, en medianoche local, y los tres verbos la usan')
        : falla(
            `sólo ${usos - 1} verbo(s) de tesorería usan el constructor de fecha: el que se lo salte volverá a fechar en la víspera`
          );
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'La firma congela lo que se firmó, y su hash no depende del orden',
    mutantes: [
      {
        archivo: 'src/database/migrations/055_la_firma_y_el_sello.sql',
        de: "CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL))",
        a: 'CHECK (true)',
        porque: 'una sesión podría quedar contabilizada sin decir cuándo ni por quién',
      },
      {
        archivo: 'src/database/migrations/055_la_firma_y_el_sello.sql',
        de: "CHECK (status NOT IN ('approved', 'posted') OR approval_hash IS NOT NULL)",
        a: 'CHECK (true)',
        porque: 'se llegaría a approved sin instantánea sellada: la firma vuelve a ser una palabra que alguien escribe, que es de lo que este módulo viene',
      },
    ],
    evaluar: () => {
      // Una aprobación sin fecha, sin firmante y sin instantánea es
      // indistinguible de un UPDATE — que es la forma exacta del defecto
      // histórico de este módulo. Y la instantánea es lo que permite que un
      // auditor pregunte «¿esto es lo que se aprobó?» seis meses después, en
      // vez de mirar el estado de HOY con las partidas ya reclasificadas.
      const sql = crudoDe('src/database/migrations/055_la_firma_y_el_sello.sql');
      const svc = codigoDe('src/services/banking/reconciliation-service.ts');

      // Se ancla el CUERPO de cada guardia y no su nombre. Un CHECK puede
      // conservar el nombre y quedarse en `CHECK (true)`, que es exactamente
      // el mutante que sobrevivió a la primera versión de este criterio.
      const guardias: Array<[string, RegExp]> = [
        ['sesion_firma_coherente', /approved_by IS NOT NULL AND approved_at IS NOT NULL/],
        ['sesion_aprobada_con_firma', /status NOT IN \('approved', 'posted'\) OR approval_hash IS NOT NULL/],
        ['sesion_contabilizada_con_rastro', /status <> 'posted' OR \(posted_at IS NOT NULL AND posted_by IS NOT NULL\)/],
      ];
      const faltan = guardias
        .filter(([nombre, cuerpo]) => !new RegExp(`CONSTRAINT ${nombre}`).test(sql) || !cuerpo.test(sql))
        .map(([nombre]) => nombre);
      if (faltan.length > 0) {
        return falla(`la firma perdió guardias en la base (o quedaron vacíos de contenido): ${faltan.join(', ')}`);
      }
      // EL HASH TIENE QUE SER DETERMINISTA o la pregunta no se puede
      // contestar: el mismo contenido serializado en otro orden daría otro
      // hash, y «no casa» dejaría de significar «alguien lo cambió».
      if (!/export function hashDeInstantanea\(/.test(svc)) {
        return falla('no hay una función única que selle la instantánea: dos llamadores producirían dos hashes del mismo contenido');
      }
      // Y LA TOLERANCIA CON LA QUE SE CERRÓ SE PERSISTE. Sin ella, la firma
      // reevaluaba el cuadre con la de hoy y la instantánea sellada de un
      // cierre legítimo con residual decía que la cuenta NO cuadraba: el único
      // documento cuyo trabajo es no contradecir al cierre lo contradecía.
      const persiste = /closing_tolerance DECIMAL\(19,4\)/.test(sql) && /closing_tolerance = \$\d+/.test(svc);
      return persiste
        ? ok('la firma va entera o no va, su hash es determinista, y reevalúa con la tolerancia del cierre y no con la de hoy')
        : falla('la tolerancia del cierre no se persiste o no se escribe: la instantánea firmada volvería a contradecir al cierre que firma');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Contabilizar una comisión ata su movimiento, o el mismo cargo se cuenta dos veces',
    mutantes: [
      {
        archivo: 'src/services/banking/treasury-posting.ts',
        de: '      await cotejarMovimientoConSuLinea(client, {',
        a: '      await Promise.resolve({',
        porque: 'el cargo contabilizado vuelve a levantar DOS partidas conciliatorias que se anulan entre sí: la sesión informa que cuadra y la comisión se puede contabilizar otra vez',
      },
    ],
    evaluar: () => {
      // `clasificarPartidas` y `movimientosSinExplicar` preguntan por COTEJOS
      // VIVOS, no por la caché `is_matched`. Un cargo contabilizado sin cotejo
      // levantaba `cargo-del-banco` del lado del banco y su gemela del lado de
      // libros: el MISMO hecho contado dos veces, anulándose. Medido, un cargo
      // de −348 daba dos partidas por −696 y la sesión decía `cuadra: true` —
      // y sobre esa base la comisión se podía contabilizar por segunda vez,
      // porque la segunda partida absorbía el desvío.
      //
      // La única defensa era acordarse de correr el motor de cotejo antes de
      // clasificar. Un invariante que depende de que alguien recuerde un paso
      // no es un invariante.
      const t = codigoDe('src/services/banking/treasury-posting.ts');
      if (!/async function cotejarMovimientoConSuLinea\(/.test(t)) {
        return falla('desapareció el cotejo que ata el movimiento a la línea que lo explica');
      }
      // LOS DOS VERBOS que crean línea contra el banco lo llaman: la comisión y
      // el interés. Se CUENTAN porque son gemelos y anclar «alguna» llamada
      // dejaría vivo al que rompa el otro.
      const llamadas = (t.match(/await cotejarMovimientoConSuLinea\(/g) ?? []).length;
      if (llamadas < 2) {
        return falla(
          `sólo ${llamadas} de los 2 verbos que crean línea de banco atan su movimiento: el que no lo ate lo levantará dos veces`
        );
      }
      // Y EL OTRO LADO LO RESPETA: una línea con cotejo vivo está explicada
      // aunque el sello aún no esté puesto. Sin esto, la línea de la comisión
      // seguía saliendo como partida hasta contabilizar la sesión.
      const libros = /rm\.matched_entity_type = 'journal_entry_line'[\s\S]{0,200}?rm\.unapplied_at IS NULL/.test(
        codigoDe('src/services/banking/reconciling-items.ts')
      );
      return libros
        ? ok('los dos verbos atan su movimiento y un cotejo vivo explica la línea aunque el sello llegue después')
        : falla('el clasificador volvió a juzgar la partida de libros sólo por el sello: la línea ya cotejada seguiría levantándose');
    },
  },

  // ---- F05c · La sesión que cuadra ----

  {
    paquete: 'E0.3',
    enunciado: 'Una sesión no puede declararse cuadrada sin que la aritmética conste',
    mutantes: [
      {
        archivo: 'src/database/migrations/054_la_sesion_que_cuadra.sql',
        de: '            OR arithmetic_computed_at IS NOT NULL',
        a: '            OR true',
        porque: 'vuelve a caber el defecto histórico: un UPDATE poniendo balanced sin haber calculado nada, que el cierre de periodo lee como prueba de que la cuenta se verificó',
      },
      {
        archivo: 'src/services/banking/reconciliation-service.ts',
        de: '              arithmetic_computed_at = NOW(),',
        a: '              beginning_balance = beginning_balance,',
        porque: 'el único escritor legítimo deja de dejar constancia: la base rechazaría el cierre y `close` quedaría roto, que es mejor que cerrar en falso pero sigue siendo un fallo',
      },
    ],
    evaluar: () => {
      // EL DEFECTO HISTÓRICO DE ESTE MÓDULO, escrito por su propio código:
      // `POST /reconciliations/:id/complete` era un UPDATE poniendo
      // status='balanced' y nada más. Nunca calculó el saldo de libros, nunca
      // lo comparó con el del banco, nunca miró si quedaba un movimiento sin
      // cotejar. Las columnas conservaban su DEFAULT 0 y la sesión reportaba
      // «variance 0» — un cero que significa «nadie restó nada», mostrado como
      // «la cuenta cuadra». Y period-close lo lee como evidencia de cierre.
      //
      // POR ESO EL INVARIANTE NO ES «VARIACIÓN CERO». La variación valía cero,
      // y valía cero por DEFAULT, que es justo lo contrario de haberla
      // calculado: un CHECK sobre ella habría dejado pasar el defecto entero.
      // Lo que se exige es que la aritmética CONSTE.
      const sql = crudoDe('src/database/migrations/054_la_sesion_que_cuadra.sql');

      if (!/CONSTRAINT sesion_balanceada_con_aritmetica/.test(sql)) {
        return falla('desapareció el guardia del cuadre: vuelve a poderse declarar balanceada una sesión que nadie calculó');
      }
      if (!/OR arithmetic_computed_at IS NOT NULL/.test(sql)) {
        return falla('el CHECK dejó de exigir constancia de la aritmética: es exactamente el hueco por el que pasó el defecto histórico');
      }
      // Y VIVE EN LA BASE, no en el servicio. Un guardia que sólo vive en el
      // servicio protege el camino que alguien recordó, no la tabla — y lo que
      // impidió esto durante un año fue exactamente nada.
      const svc = codigoDe('src/services/banking/reconciliation-service.ts');
      const escribe = /SET status = 'balanced',\s*\n\s*arithmetic_computed_at = NOW\(\),/.test(svc);
      return escribe
        ? ok('«balanceada» exige constancia de la aritmética, y el guardia vive en la base y no en el camino que alguien recuerde')
        : falla('el cierre dejó de dejar constancia de la aritmética al marcar balanced');
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'Crear un ajuste de conciliación no alcanza el mayor: nace borrador',
    mutantes: [
      {
        // Inserta CÓDIGO, no un comentario. La primera versión metía
        // `/* createJournalEntry */` y sobrevivía con razón —`codigoDe` quita
        // los comentarios, y un comentario que nombra el mayor no es un camino
        // al mayor—, pero el arnés exige que TODO mutante mate: un control
        // negativo deliberado no cabe en su contrato, así que se sustituye.
        archivo: 'src/services/banking/reconciliation-adjustments.ts',
        de: '    await query(',
        a: '    await createJournalEntry(); await query(',
        porque: 'basta un camino al mayor dentro del creador de ajustes para que su promesa de «nunca contabiliza por su cuenta» sea falsa',
      },
    ],
    evaluar: () => {
      // «Crea COMO BORRADORES … nunca contabiliza por su cuenta» es la promesa
      // literal de la fila 1246. Contabilizar es de F05d, detrás de una firma.
      // La promesa se verifica contra el SERVICIO, no contra la declaración:
      // en F05a la misma comprobación destapó que una familia entera estaba
      // probada y no entregada.
      const svc = codigoDe('src/services/banking/reconciliation-adjustments.ts');
      const alMayor = /createJournalEntry|postJournalEntry|INSERT INTO journal_entries/.exec(svc);
      if (alMayor !== null) {
        return falla(
          `el creador de ajustes alcanza el mayor ("${alMayor[0]}"): la fila promete que nunca contabiliza por su cuenta`
        );
      }
      // Y la columna que lo demuestra queda vacía hasta F05d.
      const sql = crudoDe('src/database/migrations/054_la_sesion_que_cuadra.sql');
      const nace = /journal_entry_id UUID REFERENCES journal_entries\(id\)/.test(sql);
      return nace
        ? ok('el ajuste nace borrador y su asiento queda en NULL hasta que F05d lo contabilice tras una firma')
        : falla('el ajuste perdió el vínculo con su asiento: no se podría saber cuál contabilizó cuál');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'La partida conciliatoria se puede fechar y corregir, o `close` es inalcanzable',
    mutantes: [
      {
        archivo: 'src/cli/bank-command.ts',
        de: "    .command('assign')",
        a: "    .command('assign-x')",
        porque: 'sin la hoja que fecha una partida, `close` exige una fecha que nadie puede escribir y la primera sesión con una partida queda bloqueada para siempre',
      },
    ],
    evaluar: () => {
      // EL HUECO QUE F05C TUVO QUE CERRAR AÑADIENDO FILAS AL CATÁLOGO.
      // `close` exige toda partida CLASIFICADA Y FECHADA;
      // `clasificarPartidas` levanta toda partida sin fecha —a propósito: nada
      // en el extracto sabe cuándo se cobrará un cheque—; y el catálogo
      // publicaba «responsable, fecha esperada y escalamiento» en el listado
      // sin dar forma de fijar ninguno. La primera sesión con una sola partida
      // se quedaba bloqueada para siempre, y cuatro de los seis tipos —los dos
      // errores entre ellos— eran inalcanzables, porque el signo no distingue
      // una comisión de un error del banco.
      const cli = codigoDe('src/cli/bank-command.ts');
      const svc = codigoDe('src/services/banking/reconciling-items.ts');

      const faltan = ['asignarPartida', 'reclasificarPartida'].filter(
        (f) => !new RegExp(`export async function ${f}\\(`).test(svc)
      );
      if (faltan.length > 0) {
        return falla(`el servicio perdió ${faltan.join(', ')}: no habría con qué fechar ni corregir una partida`);
      }
      // Y CON PUERTA. Los dos existían, estaban probados, y ninguno tenía
      // comando: es la forma exacta de «verde no es entregado».
      const conPuerta = ['assign', 'correct'].filter((v) =>
        new RegExp(`\\.command\\('${v}'\\)`).test(cli)
      );
      return conPuerta.length === 2
        ? ok('fechar y corregir una partida tienen servicio Y hoja: `close` es alcanzable desde el binario')
        : falla(
            `de las dos hojas que desbloquean \`close\` sólo hay ${conPuerta.length}: sin ellas, la primera sesión con una partida no se cierra nunca`
          );
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'La casilla del cierre exige que la sesión CUBRA el periodo, no que termine después',
    mutantes: [
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: '       AND rs.start_date <= (SELECT start_date FROM fiscal_periods WHERE id = $2)',
        a: '       AND true',
        porque: 'la sesión de septiembre volvería a tildar la casilla de agosto: la casilla diría «conciliado» sobre un mes que nadie miró',
      },
    ],
    evaluar: () => {
      // `period-close.ts` lee una sesión balanceada como la evidencia de que la
      // cuenta se verificó contra el banco. Su predicado era «alguna sesión
      // balanceada que TERMINE después del cierre», y con eso la de septiembre
      // tildaba la de agosto —30/09 es posterior a 31/08— aunque agosto no se
      // hubiera conciliado nunca.
      //
      // Importa más desde F05c que antes: hasta este tramo la casilla mentía
      // por su ORIGEN, porque `balanced` se ponía sin aritmética. Ahora
      // `balanced` se gana, así que lo único que puede estropearla es leerla
      // mal. Una afirmación que se vuelve cierta merece un lector que no la
      // arruine.
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const cubre =
        /AND rs\.start_date <= \(SELECT start_date FROM fiscal_periods WHERE id = \$2\)/.test(pc) &&
        /AND rs\.end_date\s+>= \(SELECT end_date\s+FROM fiscal_periods WHERE id = \$2\)/.test(pc);
      return cubre
        ? ok('la casilla exige una sesión que cubra el periodo por los dos extremos')
        : falla('la casilla del cierre volvió a conformarse con una sesión que termine después: un mes sin conciliar se tildaría con la conciliación del siguiente');
    },
  },

  // ---- F05b · Los dos lados y el cotejo ----

  {
    paquete: 'E1.2',
    enunciado: 'Ningún cotejo se aplica solo cuando su única señal es el parecido del texto',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '  if (!result.auto_applicable) return false;',
        a: '  if (false) return false;',
        porque: 'la compuerta deja de mirar el veto de la regla: un desempate decidido por la descripción vuelve a aplicarse en firme y a sellar la partida de libros',
      },
      {
        archivo: 'src/services/banking/matching.ts',
        de: '        auto_applicable: importeExacto && empatanEnImporte === 1,',
        a: '        auto_applicable: true,',
        porque: 'la regla que desempata por texto se autoriza a sí misma: es exactamente lo que el catálogo prohíbe en la fila 1225',
      },
    ],
    evaluar: () => {
      // «Nunca aplica un cotejo cuya única señal sea similitud de descripción»
      // es una promesa LITERAL del catálogo (fila 1225), y estaba viva al
      // revés: la regla marcaba su hallazgo como no-aplicable y el servicio
      // NUNCA LEÍA esa marca. Medido: dos facturas del mismo importe y la
      // misma fecha, desempatadas por el texto, se aplicaban en firme y
      // sellaban la partida.
      //
      // Por eso el veto se ancla en las DOS mitades: quien lo pone y quien lo
      // obedece. Anclar sólo una deja pasar el defecto original, que era
      // exactamente una mitad sin la otra.
      const motor = codigoDe('src/services/banking/matching.ts');
      const svc = codigoDe('src/services/banking/match-service.ts');

      // 1. La regla que desempata por texto NO se autoriza: su `auto_applicable`
      //    depende de que el importe sea exacto y de que nadie más empate.
      if (!/auto_applicable: importeExacto && empatanEnImporte === 1,/.test(motor)) {
        return falla('la regla de similitud dejó de vetarse: puede volver a decidir sola un desempate que las reglas duras rechazaron');
      }
      // 2. Y la compuerta lo OBEDECE. Es la mitad que faltaba.
      if (!/if \(!result\.auto_applicable\) return false;/.test(motor)) {
        return falla('la compuerta de aplicación dejó de leer el veto de la regla: el motor lo pone y nadie lo mira, que es el defecto original');
      }
      // 3. Y la omisión tiene MOTIVO CONTABLE, no un silencio: una causa que no
      //    se puede contar no se puede corregir.
      const motivo = /'solo-similitud',/.test(svc);
      return motivo
        ? ok('la regla de texto se veta a sí misma, la compuerta obedece el veto y la omisión se cuenta con su motivo')
        : falla('desapareció el motivo «solo-similitud»: la omisión ocurriría en silencio y nadie podría contarla');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Una partida de libros sólo se coteja si es de la cuenta de mayor del banco',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: '       AND jel.account_id = $4',
        a: '       AND jel.account_id IS NOT NULL',
        porque: 'el motor vuelve a proponer CUALQUIER línea posteada de la entidad: sellaría un gasto de renta como conciliado contra un banco que nunca lo vio, y esa línea queda inservible para la conciliación que sí le tocaba',
      },
    ],
    evaluar: () => {
      // `getCandidates` no filtraba por `jel.account_id`: devolvía cualquier
      // línea posteada sin sellar de la entidad que cayera en la banda de
      // importe. Medido: un depósito de 300 sellaba la línea de RENTA de una
      // póliza que no tocaba el banco. Y el sello es irreversible en la
      // práctica —esa línea ya no volvería a ofrecerse a su conciliación real—.
      //
      // Lo que lo delata como defecto y no como criterio: `bank book-item list`
      // SÍ unía por `ba.gl_account_id` desde el primer día. Los dos lados del
      // mismo tramo discrepaban sobre qué es una partida de libros.
      const motor = codigoDe('src/services/banking/matching.ts');
      const libros = codigoDe('src/services/banking/book-items.ts');

      if (!/AND jel\.account_id = \$\d/.test(motor)) {
        return falla('el motor volvió a proponer líneas de póliza ajenas a la cuenta del banco: sellarlas las inutiliza para su conciliación real');
      }
      // Y EL OTRO LADO USA LA MISMA DEFINICIÓN. Que las dos superficies
      // coincidan es lo que hace que el cotejo signifique algo.
      const mismoLado = /ba\.gl_account_id/.test(libros);
      return mismoLado
        ? ok('el motor y el listado de partidas de libros coinciden en qué es una partida: la cuenta de mayor del banco')
        : falla('el listado de partidas de libros dejó de unir por la cuenta de mayor del banco: los dos lados del cotejo volverían a discrepar');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Una factura cobrada a medias puede casar, porque el candidato se compara contra su saldo',
    mutantes: [
      {
        archivo: 'src/services/banking/matching.ts',
        de: "`SELECT id, 'invoice' as type, amount_due as amount, invoice_date as date,",
        a: "`SELECT id, 'invoice' as type, total_amount as amount, invoice_date as date,",
        porque: 'vuelve el defecto: se filtra por el saldo y se compara contra el total, así que una factura parcialmente cobrada no puede casar jamás — y es el caso más común de una conciliación real',
      },
    ],
    evaluar: () => {
      // `getCandidates` FILTRABA por `ABS(amount_due) BETWEEN $2 AND $3` y
      // PROYECTABA `total_amount as amount`: una factura con saldo 500 y total
      // 1160 entraba en el rango por su saldo y después el motor la comparaba
      // contra 1160. El resultado no era que casara mal — es que **no podía
      // casar nunca**, en silencio y para siempre.
      const motor = codigoDe('src/services/banking/matching.ts');
      const proyecta = (motor.match(/amount_due as amount/g) ?? []).length;
      // DOS: la factura y el gasto. Son gemelos y el mutante muta el primero;
      // buscar «alguna» ocurrencia encontraría el otro y daría verde.
      return proyecta === 2
        ? ok('los dos candidatos —factura y gasto— se comparan contra su saldo, que es por lo que se los filtró')
        : falla(
            `${proyecta} de 2 candidatos se proyectan por su saldo: el que se filtre por saldo y se compare contra el total no podrá casar nunca`
          );
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'El sello de una partida es todo o nada, y desaplicar lo libera sin borrar el cotejo',
    mutantes: [
      {
        archivo: 'src/database/migrations/052_el_cotejo.sql',
        de: '            (is_reconciled = true AND reconciled_at IS NOT NULL AND reconciliation_id IS NOT NULL)',
        a: '            (is_reconciled = true)',
        porque: 'una partida puede quedar marcada como conciliada sin decir cuándo ni por quién: el sello deja de ser rastreable y nadie puede deshacerlo',
      },
      {
        archivo: 'src/services/banking/match-service.ts',
        de: '          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2',
        a: '          SET unapplied_by = $1, unapply_reason = $2',
        porque: 'la clausura pierde su fecha y el cotejo deshecho sigue contando como vivo en todo índice que filtre por unapplied_at IS NULL',
      },
    ],
    evaluar: () => {
      // El esquema lleva desde 001 reservando `is_reconciled`, `reconciled_at`
      // y `reconciliation_id`, y la 041 las declara el ÚNICO hueco de escritura
      // sobre una línea posteada. Nadie las había escrito nunca. Al escribirlas
      // por primera vez, lo que importa es que vayan JUNTAS: una marca sin
      // fecha ni dueño es una conciliación que no se puede auditar ni deshacer.
      const sql = crudoDe('src/database/migrations/052_el_cotejo.sql');
      const svc = codigoDe('src/services/banking/match-service.ts');

      if (!/CONSTRAINT jel_sello_coherente/.test(sql)) {
        return falla('desapareció el CHECK del sello: una partida podría quedar «conciliada» sin decir cuándo ni por quién');
      }
      if (!/\(is_reconciled = true AND reconciled_at IS NOT NULL AND reconciliation_id IS NOT NULL\)/.test(sql)) {
        return falla('el CHECK dejó de exigir las tres columnas juntas: vuelve a caber el sello a medias');
      }
      // Desaplicar CLAUSURA, no borra — la misma decisión que la 049 tomó para
      // la aplicación de un cobro. Un cotejo deshecho es historia: el auditor
      // pregunta por qué se deshizo y una fila borrada no contesta.
      if (/DELETE FROM reconciliation_matches/.test(svc)) {
        return falla('desaplicar volvió a borrar el cotejo: la pregunta «por qué se deshizo» se queda sin respuesta');
      }
      const clausura = /SET unapplied_at = NOW\(\), unapplied_by = \$\d, unapply_reason = \$\d/.test(svc);
      return clausura
        ? ok('el sello va con fecha y dueño o no va, y desaplicar clausura el cotejo en vez de borrarlo')
        : falla('la clausura del cotejo perdió su fecha: un cotejo deshecho seguiría contando como vivo');
    },
  },




  // ---- F06b · El cierre deja de mirar por la ventana equivocada ----

  {
    paquete: 'E1.2',
    enunciado: 'El checklist del cierre mira su propio periodo, consume el mayor y no fabrica veredictos ajenos',
    mutantes: [
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: '        AND document_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)',
        a: '        AND document_date IS NOT NULL',
        porque: 'vuelve el vicio de F05c en su forma pura: un CFDI pendiente de NOVIEMBRE bloquearía el cierre de AGOSTO, porque la casilla contaría sin filtro de periodo',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerClosingCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerClosingCommand fuera del binario',
        porque: 'cuarta repetición del defecto de la casa: la lectura del cierre pasa sus pruebas sobre un programa que sólo construye el spec, y el binario no la carga',
      },
    ],
    evaluar: () => {
      // TRES MENTIRAS DEL CHECKLIST, cerradas en F06b y ancladas aquí:
      const pc = codigoDe('src/services/accounting/period-close.ts');

      // 1. Cada casilla mira SU periodo. La de pre-registros contaba sin
      //    filtro de fecha — el vicio que F05c cazó en la de banco, en su
      //    forma pura: lo pendiente de noviembre ensuciaba el cierre de agosto.
      if (!/AND document_date BETWEEN \(SELECT start_date FROM fiscal_periods WHERE id = \$2\)/.test(pc)) {
        return falla('la casilla de pre-registros volvió a contar sin filtro de periodo: lo pendiente de otro mes ensuciaría este cierre');
      }
      // 2. El cierre CONSUME el mayor. runLedgerChecks existía y sólo lo
      //    llamaban el comando de ledger y el verificador de respaldo: un
      //    periodo podía cerrarse con el mayor descuadrado sin que ninguna
      //    casilla lo mirara.
      if (!/runLedgerChecks/.test(pc)) {
        return falla('el checklist dejó de correr los chequeos del mayor: un periodo podría cerrarse descuadrado');
      }
      // 3. La secuencia: el hueco más viejo, no sólo el vecino. Mirar sólo el
      //    inmediato anterior hacía invisible reabrir enero detrás de un
      //    febrero cerrado — el hueco quedaba tapado al cerrar marzo.
      if (!/'previous-period-closed'/.test(pc)) {
        return falla('desapareció la casilla de secuencia: cerrar octubre con septiembre abierto volvería a pasar en silencio');
      }
      // 4. Y NO SE FABRICAN VEREDICTOS AJENOS: el periodo se resuelve por
      //    PERTENENCIA (serie TEN) antes de contestar. `explainCloseCheck` de
      //    la entidad A sobre el periodo de B devolvía «0 ofensores» limpio, y
      //    la ruta REST servía can_close:true sobre un UUID inventado.
      const guard = /throw new NotFoundError\('Fiscal period', periodId\)/.test(pc);
      const entregada = /registerClosingCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      if (!guard) {
        return falla('el checklist volvió a contestar sobre periodos que no son de la entidad: un UUID inventado recibiría can_close verdadero');
      }
      return entregada
        ? ok('cada casilla mira su periodo, el mayor se consume, la secuencia se vigila desde el hueco más viejo, la pertenencia se exige y la familia está en el binario')
        : falla('registerClosingCommand no está en el binario: la lectura del cierre quedó verificada y no entregada');
    },
  },

  // ---- F06c · El lote importado por fin se puede aplicar ----

  {
    paquete: 'E1.2',
    enunciado: 'El lote respeta su flujo —staged, checked, posted— y se reversa como unidad',
    mutantes: [
      {
        // El diente, no la boca. La primera versión mutaba la APERTURA de la
        // función añadiendo `return;` — el throw quedaba como código muerto y
        // toda ancla textual seguía encontrándolo. Un criterio de texto no ve
        // código muerto: hay que mutar lo que se ancla.
        archivo: 'src/services/accounting/batch-service.ts',
        de: '  if (permitidos.includes(lote.status)) return;',
        a: '  return;',
        porque: 'la guarda deja pasar TODO estado: un lote staged se postearía sin verificar, que es exactamente lo que el flujo de la 045 existe para impedir',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerBatchCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerBatchCommand fuera del binario',
        porque: 'tercera repetición del defecto de la casa: la familia pasa sus 72 pruebas sobre un programa que sólo construye el spec, y el staging de F01 vuelve a no tener salida',
      },
    ],
    evaluar: () => {
      // F01 dejó una puerta de entrada a un almacén sin salida: `entry import`
      // deposita pólizas en el staging de la 045 y hasta F06c ningún comando
      // podía aplicarlas, verificarlas ni reversarlas. El flujo
      // staged→checked→posted del CHECK de la 045 era un dibujo.
      const svc = codigoDe('src/services/accounting/batch-service.ts');

      // 1. La guarda de estado existe y es ÚNICA: cada verbo la llama en vez de
      //    comparar por su cuenta, que es como las máquinas de estados se
      //    desincronizan.
      // Se ancla el CUERPO de la guarda —la condición Y el throw—, no su
      // nombre: una guarda que existe y no muerde es la forma exacta del
      // mutante que sobrevivió a la primera versión de este criterio.
      if (!/if \(permitidos\.includes\(lote\.status\)\) return;[\s\S]{0,200}?throw new ConflictError\(/.test(svc)) {
        return falla('la guarda de estado del lote perdió su diente: existe pero deja pasar, y un lote staged se postearía sin verificar');
      }
      const usos = (svc.match(/exigirEstado\(/g) ?? []).length;
      if (usos < 4) {
        return falla(`sólo ${usos - 1} verbos pasan por la guarda de estado: el que no pase podrá saltarse el flujo`);
      }
      // 2. El origen propio: las pólizas del lote se distinguen de las
      //    manuales, y la reversa encuentra EXACTAMENTE las suyas.
      if (!/ORIGEN_LOTE_IMPORTADO = 'import_batch'/.test(svc)) {
        return falla('las pólizas del lote perdieron su origen propio: la reversa no sabría cuáles son suyas y los informes las contarían como manuales');
      }
      // 3. La reversa en bloque usa la transacción del llamador — N espejos,
      //    todo o nada — y no N transacciones sueltas.
      const enBloque = /await reverseWithinTransaction\(/.test(svc);
      // 4. Y está en el binario: tercera vez que una familia entera pasa sus
      //    pruebas sin que mnemosine la cargue.
      const entregada = /registerBatchCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      if (!enBloque) {
        return falla('la reversa del lote dejó de usar la transacción compartida: N espejos en N transacciones puede dejar medio lote reversado');
      }
      return entregada
        ? ok('la guarda de estado es única y la usan todos los verbos, el origen es propio, la reversa es todo-o-nada y la familia está en el binario')
        : falla('registerBatchCommand no está en el binario: el staging de F01 vuelve a ser un almacén sin salida');
    },
  },

  // ---- D1a · El devengo existe, y lo que ya se pagaba se paga bien ----

  {
    paquete: 'E1.2',
    enunciado: 'La amortización vale lo que el mayor respalda, y las prestaciones se calculan como manda la ley',
    mutantes: [
      {
        // El defecto de gravedad 1 que el adversarial cazó: reversar el
        // asiento de una amortización devolvía el importe a la 1160, pero el
        // renglón seguía contando como posteado. Cuatro instrumentos mentían
        // a la vez y el gasto no volvía NUNCA, porque el freno de doble
        // corrida lo daba por hecho.
        archivo: 'src/services/accruals/prepaid-service.ts',
        de: 'export const RENGLON_VIGENTE = `s.is_posted = true AND EXISTS (',
        a: 'export const RENGLON_VIGENTE = `s.is_posted = true AND NOT EXISTS (',
        porque: 'un renglón dejaría de exigir respaldo en el mayor: la ficha afirmaría gasto devengado que una reversa ya deshizo, y el saldo revertido se ofrecería otra vez como libre',
      },
      {
        // La tabla del art. 76 tras la reforma de 2023 sube DOS DÍAS CADA
        // QUINQUENIO a partir del sexto año, no cada año. Contarlo por año
        // pagaba de menos en cuatro de cada cinco ejercicios.
        archivo: 'src/services/payroll/mx/finiquito-math.ts',
        de: '  const quinquenios = Math.ceil((anio - 5) / 5);',
        a: '  const quinquenios = Math.floor((anio - 5) / 5);',
        porque: 'devuelve la tabla del art. 76 al defecto que D1a reparó: paga dos días de vacaciones DE MENOS en cuatro de cada cinco años de antigüedad a partir del sexto, en el finiquito de una persona',
      },
    ],
    evaluar: () => {
      const svc = codigoDe('src/services/accruals/prepaid-service.ts');
      const mate = codigoDe('src/services/payroll/mx/finiquito-math.ts');

      // 1. UN RENGLÓN VALE MIENTRAS EL MAYOR LO RESPALDE. El mayor es
      //    inmutable (041) y sólo se corrige por reversa, así que la reversa
      //    es un camino NORMAL, no una excepción: cualquier caché que no la
      //    mire acaba afirmando un gasto que ya se deshizo.
      if (!/RENGLON_VIGENTE/.test(svc) || !/is_posted = true AND EXISTS \(/.test(svc)) {
        return falla('la amortización volvió a fiarse de is_posted sin mirar el mayor: una reversa dejaría la ficha, el respaldo disponible y la casilla del cierre afirmando un gasto que ya no existe');
      }
      // 2. Y EL RESPALDO SE MIDE Y SE CONSUME EN LA MISMA TRANSACCIÓN. Sin el
      //    cerrojo, dos altas simultáneas sobre el mismo cargo pasaban las
      //    dos: 48 000 amortizables sobre 24 000 pagados, la 1160 en negativo
      //    —un activo con saldo acreedor— y el balance cuadrando.
      if (!/FOR UPDATE/.test(svc)) {
        return falla('desapareció el cerrojo del respaldo: dos altas concurrentes sobre el mismo cargo volverían a pasar las dos y la 1160 quedaría en negativo');
      }
      // 3. LA LEY, COMO ESTÁ ESCRITA. El art. 76 reformado sube dos días por
      //    QUINQUENIO desde el sexto año; el aguinaldo se prorratea por días
      //    trabajados (art. 87); y la base es el salario diario, no el
      //    integrado, que ya lleva dentro el factor de estas prestaciones.
      const quinquenios = /Math\.ceil\(\(anio - 5\) \/ 5\)/.test(mate);
      return quinquenios
        ? ok('la amortización se apoya en el mayor y se serializa, y la tabla del art. 76 sube por quinquenio como la ley dice')
        : falla('la tabla del art. 76 volvió a contar por año en vez de por quinquenio: paga de menos a partir del sexto año de antigüedad');
    },
  },

  // ---- S3·sello · El libro que no se puede apagar en silencio ----

  {
    paquete: 'E0.3',
    enunciado: 'Toda garantía del esquema está sellada con ENABLE ALWAYS, y doctor vigila que siga estándolo',
    mutantes: [
      {
        archivo: 'src/database/migrations/058_el_sello_de_las_garantias.sql',
        de: 'ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER journal_entry_lines_posteada_inmutable;',
        a: '-- (sin sellar)',
        porque: 'deja una garantía del mayor en disparador ordinario: una línea de SET session_replication_role la apagaría con las demás y la inmutabilidad de la línea posteada se evapora sin dejar rastro',
      },
      {
        archivo: 'src/ai/doctor-service.ts',
        de: "    checks.push(await checkSelloDeGarantias());",
        a: '    // sin vigilancia del sello',
        porque: 'el sello deja de vigilarse: ENABLE ALWAYS no impide DISABLE TRIGGER, así que sin este chequeo un break-glass no se distingue de un sabotaje y doctor sigue diciendo ok',
      },
    ],
    evaluar: () => {
      const sello = crudoDe('src/database/migrations/058_el_sello_de_las_garantias.sql');
      const doctor = codigoDe('src/ai/doctor-service.ts');

      // LA LISTA SE DERIVA, NO SE ESCRIBE. Los disparadores de garantía se
      // leen de las migraciones que los crean; si mañana alguien añade la
      // garantía número diez y no la sella, este criterio la echa en falta
      // sin que nadie tenga que acordarse de apuntarla. Una lista paralela
      // es justo lo que este proyecto ha pagado ya varias veces.
      const DE_GARANTIA = [
        '033_audit_log_append_only.sql',
        '035_fiscal_credential_log_append_only.sql',
        '041_el_mayor_inviolable.sql',
        '051_la_cuenta_y_el_extracto.sql',
      ];
      const declarados: string[] = [];
      for (const archivo of DE_GARANTIA) {
        const sql = crudoDe(`src/database/migrations/${archivo}`);
        for (const m of sql.matchAll(/CREATE TRIGGER\s+(\w+)/g)) declarados.push(m[1]);
      }
      if (declarados.length === 0) {
        return falla('no se encontró ni un disparador de garantía en las migraciones: el criterio quedó ciego, revisa los nombres de archivo');
      }

      const sinSellar = declarados.filter(
        (t) => !new RegExp(`ENABLE ALWAYS TRIGGER ${t}\\b`).test(sello)
      );
      if (sinSellar.length > 0) {
        return falla(
          `${sinSellar.length} de ${declarados.length} garantías sin ENABLE ALWAYS (${sinSellar.join(', ')}): ` +
            'una línea de SET session_replication_role las apagaría sin tocar el esquema y sin dejar rastro'
        );
      }
      // Y el sello se VIGILA: ENABLE ALWAYS no impide DISABLE TRIGGER, que es
      // legítimo como break-glass. Lo que no puede ser es que no se note.
      // Se ancla la LLAMADA, no el nombre: la afirmación es que doctor lo
      // CORRE, y buscar `checkSelloDeGarantias` a secas la da por cierta con
      // sólo que la función exista definida y sin llamador — que es capacidad
      // huérfana disfrazada de garantía. Tercera vez en este proyecto que la
      // presencia se hace pasar por conducta.
      const vigilado =
        /checks\.push\(await checkSelloDeGarantias\(\)\)/.test(doctor) &&
        /garantia-sellada/.test(doctor) &&
        /tgenabled/.test(doctor);
      return vigilado
        ? ok(`las ${declarados.length} garantías del esquema están selladas, y doctor falla si alguna deja de estarlo`)
        : falla('doctor dejó de leer pg_trigger.tgenabled: apagar una garantía volvería a ser indetectable');
    },
  },

  // ---- G0 · La tarde que se paga sola ----

  {
    paquete: 'E1.2',
    enunciado: 'El candado del cierre bloquea sin reescribir la tabla, y el perímetro no confía en una cabecera que escribe quien llama',
    mutantes: [
      {
        // Volver al UPDATE. El diente exacto: la sentencia que asignaba a cada
        // fila el valor que ya tenía.
        archivo: 'src/services/accounting/period-close.ts',
        de: '      `SELECT id FROM journal_entries\n       WHERE fiscal_period_id = $1 AND entity_id = $2\n       FOR UPDATE`,',
        a: "      `UPDATE journal_entries SET status = CASE WHEN status = 'posted' THEN 'posted' ELSE status END\n       WHERE fiscal_period_id = $1 AND entity_id = $2`,",
        porque: 'el candado vuelve a reescribir cada fila para no cambiar nada: Postgres versiona, rehace los índices y dispara el guardián de inmutabilidad una vez POR FILA, y con 800 000 asientos el cierre de mes muere contra su propio statement_timeout',
      },
      {
        archivo: 'src/api/rest/trust-proxy.ts',
        de: "export function resolverTrustProxy(",
        a: "export function resolverTrustProxy_desactivado(",
        porque: 'el perímetro se queda sin resolutor de proxy: o se confía en todo —y entonces req.ip lo escribe quien llama y el freno deja de existir— o se confía en nada y todos los inquilinos comparten un cubo',
      },
    ],
    evaluar: () => {
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const tp = codigoDe('src/api/rest/trust-proxy.ts');
      const cx = codigoDe('src/database/connection.ts');

      // 1. EL CANDADO PIDE EL CANDADO, no lo consigue de rebote. El cierre
      //    duro bloqueaba los asientos del periodo con un UPDATE que asignaba
      //    a cada fila el valor que ya tenía: cero filas cambiadas de
      //    1 500 000, y aun así Postgres versiona cada una, rehace sus doce
      //    índices —`status` está indexado tres veces, así que no hay
      //    actualización HOT que lo salve— y dispara el guardián de
      //    inmutabilidad por fila. Medido: 87 s contra un tope de 60. El
      //    tramo que puso el tope encontró lo que el tope mataba.
      //    Se ancla la consulta ENTERA y no las dos palabras `FOR UPDATE`:
      //    el archivo tiene otros candados legítimos, y un ancla que casa con
      //    cualquiera de ellos sobrevive al mutante que devuelve el UPDATE.
      if (!/SELECT id FROM journal_entries\s+WHERE fiscal_period_id = \$1 AND entity_id = \$2\s+FOR UPDATE/.test(pc)) {
        return falla('el candado del cierre dejó de pedirse directo: si vuelve a lograrse con un UPDATE que no escribe nada, el cierre de un ejercicio grande muere contra su propio tope de sentencia');
      }
      // 2. EL PERÍMETRO NO CONFÍA A CIEGAS. `trust proxy` en true hace que
      //    req.ip sea la entrada más a la izquierda de X-Forwarded-For, que
      //    la escribe quien llama: cada petición estrena cubo y el freno de
      //    /public/v1 deja de existir. El defecto es `false` porque es el
      //    único valor NO ELUDIBLE: su coste —un cubo compartido— es ruidoso
      //    y se nota; un limitador que no limita, no.
      //    Con el paréntesis: sin él, el ancla casa igual con un
      //    `resolverTrustProxy_desactivado` y el mutante que lo renombra
      //    sobrevive. Es la lección que el arnés cobró en F06a.
      if (!/export function resolverTrustProxy\(/.test(tp)) {
        return falla('desapareció el resolutor de trust proxy: el perímetro vuelve a confiar en la cabecera o a meter a todos los inquilinos en un cubo');
      }
      // 3. Y EL POOL TIENE LOS TRES TOPES. Sin ellos la petición 21 del día de
      //    cierre espera para siempre.
      const topes = ['statement_timeout', 'lock_timeout', 'connectionTimeoutMillis'].filter((t) => cx.includes(t));
      return topes.length === 3
        ? ok('el candado del cierre se pide directo, el perímetro declara en quién confía, y el pool tiene sus tres topes')
        : falla(`al pool le faltan topes (${3 - topes.length} de 3): la petición 21 del día de cierre vuelve a esperar para siempre`);
    },
  },

  // ---- G1b · El flujo de efectivo, amarrado al efectivo ----

  {
    paquete: 'E1.2',
    enunciado: 'El estado de flujos clasifica por ROL, no por el nombre en inglés de la cuenta, y se amarra contra el efectivo real',
    mutantes: [
      {
        // El diente exacto del tramo: volver a preguntar por el NOMBRE. El
        // motor viejo hacía `name ILIKE '%receivable%'` contra un catálogo
        // que este mismo producto siembra en español, así que no casaba nada
        // y el capital de trabajo salía en cero — sin que ninguna prueba lo
        // notara, porque cero es un número perfectamente presentable.
        archivo: 'src/services/reporting/cash-flow-service.ts',
        de: '               FROM account_roles ar',
        a: '               FROM accounts ar_por_nombre',
        porque: 'la clasificación vuelve a colgar del NOMBRE de la cuenta en vez del rol, que es el defecto histórico exacto: contra un catálogo sembrado en español no casa nada y el capital de trabajo sale en cero, que es un número perfectamente presentable',
      },
    ],
    evaluar: () => {
      const cf = codigoDe('src/services/reporting/cash-flow-service.ts');
      const rc = codigoDe('src/services/reporting/cash-flow-reconcile.ts');

      // 1. EL MOTOR SALIÓ DE LA RUTA. Era el ÚNICO informe que nunca se
      //    extrajo a la capa de servicios: vivía dentro de src/api/rest, así
      //    que el CLI y el agente no lo tenían y REST era un segundo motor.
      if (!/export async function politicasDeFlujo/.test(cf)) {
        return falla('el estado de flujos volvió a vivir sólo en la ruta REST: el CLI y el agente se quedan sin él, y REST vuelve a ser un motor aparte');
      }
      // 2. SE CLASIFICA POR ROL, NO POR NOMBRE. El mapa de roles sobrevive a
      //    renombres, traducciones y catálogos importados; los nombres no.
      if (!/FROM account_roles ar/.test(cf)) {
        return falla('la clasificación del flujo dejó de pasar por el mapa de roles: si vuelve a preguntar por el nombre, el capital de trabajo saldrá en cero contra cualquier catálogo en español');
      }
      // 3. Y EL RESIDUO SE IMPRIME, NO SE ABSORBE. Es el único estado
      //    financiero cuyo error se comprueba desde fuera: cualquiera lo
      //    contrasta contra su banco. Meterlo dentro de un renglón esconde
      //    justo lo que el lector habría cazado.
      const amarre = /export async function conciliarFlujoDeEfectivo/.test(rc);
      return amarre
        ? ok('el flujo vive en la capa compartida, clasifica por rol y se contrasta contra el efectivo real con el residuo a la vista')
        : falla('desapareció el amarre contra el efectivo real: el estado de flujos vuelve a poder no tener ninguna relación con el banco sin que nadie lo diga');
    },
  },

  // ---- G1a · Los estados que ya se firman, y que hoy mentían ----

  {
    paquete: 'E1.2',
    enunciado: 'El cierre barre por el SIGNO del saldo, comprueba que barrió, y los informes no cuentan el cierre como actividad',
    mutantes: [
      {
        // El signo del saldo, no la forma de la consulta. El banco unitario
        // FABRICA ending_balance recomponiendo la resta que la consulta
        // declara (report-service.spec.ts:62), así que invertirla pasaba las
        // 3 500 pruebas en verde y sólo la acusaba un regex sobre el TEXTO
        // del SQL. La prueba de conducta de G1a es la que ahora la mata.
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS ending_balance',
        a: 'COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) AS ending_balance',
        porque: 'invierte el signo de TODO saldo publicado: la balanza, el estado de resultados y el balance general dirían lo contrario de lo que los libros dicen, y hasta G1a ninguna prueba de cifras lo notaba',
      },
      {
        // La línea que el reconocimiento de S4 demostró desprotegida: invirtió
        // ÉSTA —la del balance general, no la anclada— y el arnés, el plan y
        // las 3 435 unitarias siguieron en verde. Una utilidad de 3 000
        // publicada como pérdida de 2 000, otra vez, por la puerta de al lado.
        archivo: 'src/services/reporting/report-service.ts',
        de: 'COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as balance',
        a: 'COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) as balance',
        porque: 'invierte el signo en la consulta del BALANCE GENERAL: el capital contable se publica del revés y ninguna prueba de la vía rápida lo nota',
      },
      {
        // El diente, no la boca: el saldo se consulta DOS veces (ingresos y
        // gastos) y mutar una sola basta, porque el barrido de esa mitad cae
        // del lado contrario y el ejercicio queda sin barrer.
        archivo: 'src/services/accounting/period-close.ts',
        de: 'SUM(ab.debit_total - ab.credit_total) as balance',
        a: 'SUM(ab.credit_total - ab.debit_total) as balance',
        porque: 'el cierre barrería los ingresos por el lado equivocado: las cuentas quedan al doble en vez de en cero y el resultado entra invertido al capital, que es el defecto exacto que este tramo vino a matar',
      },
    ],
    evaluar: () => {
      const pc = codigoDe('src/services/accounting/period-close.ts');
      const cc = codigoDe('src/services/reporting/criterio-cierre.ts');
      const lc = codigoDe('src/services/accounting/ledger-checks.ts');
      const rs = codigoDe('src/services/reporting/report-service.ts');

      // 0. EL ORDEN DE LA RESTA ES LA AFIRMACIÓN, y por eso se ancla literal:
      //    un saldo es cargos MENOS abonos, en ese orden, y al revés todo lo
      //    publicado dice lo contrario de lo que los libros dicen. Se ancla
      //    aquí —y no sólo en la prueba de conducta— porque un criterio sólo
      //    mata lo que inspecciona: la primera versión de este bloque no
      //    leía report-service, y sus dos mutantes sobrevivieron.
      // SE CUENTAN LAS CINCO. La primera versión ancló sólo la de
      // `AS ending_balance` y dejó fuera las otras cuatro —entre ellas la del
      // BALANCE GENERAL (:445)—, así que invertir el signo una línea más abajo
      // pasaba el arnés, el plan y las 3 435 unitarias: sólo lo acusaba un job
      // de integración de cuatro minutos que nadie corre antes de empujar. Es
      // la lección que este mismo criterio aplica a period-close doce líneas
      // más abajo, y que no se aplicó al archivo que acababa de añadir.
      const saldosPublicados = (
        rs.match(/COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\) - COALESCE\(jel\.credit_amount, 0\)\)/g) ?? []
      ).length;
      if (saldosPublicados !== 5) {
        return falla(
          `${5 - saldosPublicados} de las cinco consultas del saldo publicado tienen la resta invertida: ` +
            'la balanza, el estado de resultados o el balance general dirían lo contrario de lo que dicen los libros'
        );
      }
      // Se CUENTAN las dos apariciones —ingresos y gastos— en vez de
      //    comprobar que haya una: son gemelas textuales, y un mutante que
      //    invierta sólo la primera deja la segunda en pie, así que la
      //    presencia seguiría siendo cierta mientras el cierre barre medio
      //    ejercicio del revés. Es la trampa que ya cobró piezas en F04.
      const consultasDelSaldo = (pc.match(/SUM\(ab\.debit_total - ab\.credit_total\) as balance/g) ?? []).length;
      if (consultasDelSaldo !== 2) {
        return falla(
          `el cierre consulta el saldo con la resta invertida en ${2 - consultasDelSaldo} de sus dos mitades: ` +
            'barrería por el lado equivocado y el resultado entraría invertido al capital'
        );
      }

      // 1. EL LADO LO DECIDE EL SIGNO. Durante un año el emisor usó abs(),
      //    que acierta por casualidad en la cuenta de naturaleza normal y
      //    DUPLICA la contra-natural: la 4400 (revenue deudora) recibía otro
      //    cargo y la 5200 (expense acreedora) otro abono. Con ventas 10 000,
      //    devolución 2 000, costo 6 000 y devolución de compras 1 000, una
      //    utilidad de 3 000 se publicaba como PÉRDIDA de 2 000 — y el
      //    balance decía is_balanced true, porque el renglón del resultado
      //    cancelaba exactamente el exceso.
      if (!/function lineaQueBarre/.test(pc) || !/balance\.greaterThan\(0\)/.test(pc)) {
        return falla('el barrido del cierre dejó de decidir el lado por el signo: las cuentas contra-naturales volverían a duplicarse en vez de barrerse');
      }
      // 2. Y SE COMPRUEBA QUE BARRIÓ. Nada lo comprobaba, que es por lo que
      //    el defecto anterior vivió tanto: el asiento cuadraba.
      if (!/verificarQueElEjercicioBarrio/.test(pc)) {
        return falla('nadie comprueba que el ejercicio cerrado quede en cero: un cierre que no barre volvería a pasar inadvertido');
      }
      // 3. EL INFORME NO CUENTA EL CIERRE COMO ACTIVIDAD. El asiento se fecha
      //    al final del periodo que cierra —dentro del rango que el propio
      //    informe consulta—, así que un ejercicio cerrado imprimía «Net
      //    income 0.0000» en las TRES superficies, que comparten la consulta.
      if (!/export function predicadoSinCierre/.test(cc)) {
        return falla('desapareció el criterio compartido del cierre: el estado de resultados de un ejercicio cerrado volvería a salir en ceros');
      }
      // 4. LOS SALDOS MATERIALIZADOS SE VERIFICAN CONTRA SU PROPIO
      //    INVARIANTE. checkBalance sólo miraba debit_total/credit_total:
      //    inyectar 99 999 en ending_balance —la columna que el cierre
      //    escribe y el ejercicio siguiente HEREDA— devolvía cero hallazgos.
      const invariante = /ab\.beginning_balance \+ ab\.debit_total - ab\.credit_total/.test(lc);
      return invariante
        ? ok('el cierre barre por el signo y se comprueba, los informes no cuentan el cierre como actividad, y ending_balance ya no es una columna que nadie verifica')
        : falla('ending_balance volvió a ser invisible para el chequeo del mayor: inyectarle una cifra falsa no daría hallazgo');
    },
  },

  // ---- R4 · La moneda extranjera, convertida en el origen ----

  {
    paquete: 'E1.2',
    enunciado: 'El asiento en moneda extranjera nace con su origen, la conversión se verifica y la reversa lo conserva cruzado',
    mutantes: [
      {
        // El diente: la reversa de un asiento USD construía el espejo sólo en
        // funcional — la pérdida de origen que R4 existe para matar,
        // reintroducida por la puerta de la reversión (afecta reverse, void y
        // batch reverse). El adversarial la cazó con prueba que fallaba.
        archivo: 'src/services/accounting/posting.ts',
        de: '    foreign_debit: line.foreign_credit ?? undefined,',
        a: '    foreign_debit: undefined,',
        porque: 'el espejo pierde el lado extranjero: reversar un asiento en dólares vuelve a parir un asiento sólo-funcional, y el importe original muere en silencio por la puerta de atrás',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerFxCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerFxCommand fuera del binario',
        porque: 'quinta repetición del defecto de la casa: fx-command.ts pasa su spec sobre un Command propio mientras el binario no lo carga — el segundo verificador de R4 lo encontró exactamente así',
      },
    ],
    evaluar: () => {
      const post = codigoDe('src/services/accounting/posting.ts');

      // 1. Las cuatro columnas FX de la 001 POR FIN se escriben. Antes el
      //    INSERT escribía nueve columnas y todo asiento en dólares perdía su
      //    origen al nacer — currencyRule no podía dispararse jamás.
      if (!/currency_code, foreign_debit, foreign_credit, exchange_rate/.test(post)) {
        return falla('el INSERT de createJournalEntry dejó de escribir las columnas FX: el asiento en moneda extranjera vuelve a nacer sin origen');
      }
      // 2. La conversión se VERIFICA, no se confía: cada línea pasa por
      //    verificarOrigenFx (funcional = extranjero × tasa, half-up a 4) y el
      //    rechazo trae los tres números. Sin esto, un llamador puede declarar
      //    un origen que no casa y el mayor archiva la mentira con CHECK verde.
      if (!/verificarOrigenFx\(line, monedaFuncional, i \+ 1\)/.test(post)) {
        return falla('createJournalEntry dejó de verificar el origen contra la conversión: una línea podría declarar un extranjero que no casa con su funcional');
      }
      // 3. La reversa CRUZA los lados extranjeros igual que los funcionales.
      if (!/foreign_debit: line\.foreign_credit \?\? undefined,/.test(post)) {
        return falla('la reversa dejó de cruzar el origen: el espejo de un asiento en dólares nacería sólo-funcional');
      }
      // 4. La fluctuación se identifica (B-15): utilidad y pérdida cambiaria
      //    tienen cuenta PROPIA — compartir la 4300/6300 con otros ingresos y
      //    gastos financieros las hacía invisibles, y el neteo es del reporte,
      //    no de las cuentas.
      const seed = codigoDe('src/services/xml-ingestion/account-roles-seed.ts');
      if (!/utilidad_cambiaria: '4320'/.test(seed) || !/perdida_cambiaria: '6320'/.test(seed)) {
        return falla('los roles cambiarios volvieron a compartir cuenta: la fluctuación deja de poder identificarse (NIF B-15)');
      }
      const entregada = /registerFxCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      return entregada
        ? ok('las cuatro columnas se escriben, la conversión se verifica con los tres números, la reversa cruza el origen, la fluctuación tiene cuenta propia y la familia está en el binario')
        : falla('registerFxCommand no está en el binario: R4 quedó verificada y no entregada');
    },
  },

  // ---- F06a · El activo y su corrida ----

  {
    paquete: 'E1.2',
    enunciado: 'El mismo mes no se carga dos veces al mayor, ni cambiando la política entre corridas',
    mutantes: [
      {
        archivo: 'src/services/assets/depreciation.ts',
        de: "            AND (ds.is_posted = true OR ds.schedule_type = $3)",
        a: "            AND ds.schedule_type = $3",
        porque: 'el freno vuelve a acotarse por libro: correr marzo, contestar el panel con la otra base y correr marzo otra vez postea un SEGUNDO asiento — 20.000 en el mayor para un mes que vale 10.000, y con la 041 eso son reversas, no ediciones',
      },
    ],
    evaluar: () => {
      // MEDIDO por el verificador adversarial, y la secuencia es la que el
      // propio sistema invita a hacer: correr el mes con `vida_util_nif`,
      // contestar el panel con `tasa_lisr` —literalmente lo que sugiere el
      // mensaje de criteriosDeLaCorrida— y correr otra vez. El freno estaba
      // acotado por `schedule_type`, así que la segunda corrida no encontraba
      // fila `tax` y debitaba la misma cuenta de gasto por segunda vez.
      //
      // Por eso el freno tiene dos mitades: un renglón `is_posted` de
      // CUALQUIER libro cierra el mayor para ese mes, y el tipo sigue cerrando
      // la UNIQUE para el calendario.
      const svc = codigoDe('src/services/assets/depreciation.ts');
      if (!/AND \(ds\.is_posted = true OR ds\.schedule_type = \$\d\)/.test(svc)) {
        return falla('el freno de la corrida volvió a acotarse por libro: cambiar la política entre corridas cargaría el mismo mes dos veces');
      }
      // Y LA FICHA SE DERIVA DE LO POSTEADO, no del calendario teórico. Los
      // meses no tienen por qué correrse en orden: con el acumulado teórico,
      // correr marzo→enero→febrero dejaba la ficha un mes por debajo PARA
      // SIEMPRE y last_depreciation_date retrocedía. Derivada de la suma de
      // renglones posteados —que la 056 garantiza con asiento detrás—, ficha
      // y mayor coinciden por construcción en cualquier orden.
      const derivada = /current_book_value = fa\.acquisition_cost - p\.acumulada,/.test(svc) &&
        /SELECT COALESCE\(SUM\(ds\.depreciation_expense\), 0\) AS acumulada,/.test(svc);
      return derivada
        ? ok('el freno mira lo posteado de cualquier libro y la ficha es la suma de lo posteado: mayor y ficha no pueden separarse')
        : falla('la ficha volvió a copiar el renglón teórico del calendario: correr los meses en desorden la separa del mayor para siempre');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'La vida del activo suma exacta: doce filas en doce meses y el tapón cierra al peso',
    mutantes: [
      {
        archivo: 'src/services/assets/depreciation-math.ts',
        de: '    const restante = base.minus(acumulado);',
        a: '    const restante = base.dividedBy(2);',
        porque: 'el último renglón deja de absorber la diferencia de redondeo: 100.000 a 36 meses vuelve a acumular 100.000,0008 y el activo nunca llega a cero exacto',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'registerAssetCommand(program, { palette: c, shutdown, reportError });',
        a: '// registerAssetCommand fuera del binario',
        porque: 'el alta se queda verificada y no entregada: sin ficha no hay activo, y sin activo toda la aritmética de este criterio es letra muerta',
      },
    ],
    evaluar: () => {
      // El defecto original: el índice del calendario dividía milisegundos
      // entre 30,44 días —la longitud MEDIA de un mes—, así que marzo repetía
      // la fila de febrero y la última no se consumía nunca: once filas en
      // doce meses, y la suma posteada jamás daba costo menos salvamento.
      // E1.4 ancla el índice; aquí se ancla LO OTRO que hace exacta la vida.
      const math = codigoDe('src/services/assets/depreciation-math.ts');
      // El tapón: el último renglón es base − acumulado, no una división más.
      // Aparece en dos series (línea recta y decrecientes); se CUENTAN porque
      // son gemelos y un ancla de presencia se conforma con encontrar el otro.
      const tapones = (math.match(/const restante = base\.minus\(acumulado\);/g) ?? []).length;
      if (tapones < 2) {
        return falla(
          `el tapón del último renglón sobrevive en ${tapones} de las 2 series que agotan la base: la que lo pierda dejará residuo de redondeo para siempre`
        );
      }
      // Y el dinero entra como STRING: el motor viejo pasaba DECIMAL(19,4) por
      // parseFloat, que es por donde se cuelan los centavos.
      if (!/acquisition_cost: string;[\s\S]{0,80}?salvage_value: string;/.test(math)) {
        return falla('el costo o el salvamento volvieron a ser number: los centavos se pierden en el parseFloat de entrada');
      }
      // Y EL ALTA ESTÁ EN EL BINARIO. Sin ficha no hay activo, y sin activo
      // toda la aritmética de arriba es letra muerta — el «verde no es
      // entregado» que F05a enseñó y F06a repitió con la otra familia.
      const entregada = /registerAssetCommand\(program/.test(codigoDe('src/cli/mnemosine.ts'));
      return entregada
        ? ok('el tapón cierra las dos series al peso, el dinero viaja como cadena y el alta está en el binario')
        : falla('registerAssetCommand no está en el binario: el alta quedó verificada y no entregada, y nadie puede crear la ficha');
    },
  },

  // ---- F05a · La cuenta y el extracto ----

  {
    paquete: 'E1.2',
    enunciado: 'El extracto es un documento con sus dos saldos, y el mismo archivo no entra dos veces',
    mutantes: [
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '    UNIQUE (bank_account_id, file_sha256)',
        a: '    CHECK (line_count >= 0)',
        porque: 'el mismo archivo del banco vuelve a poder importarse entero: el extracto se duplica y el saldo de banco deja de ser el del banco',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '    opening_balance DECIMAL(19,4) NOT NULL,',
        a: '    opening_balance DECIMAL(19,4),',
        porque: 'el saldo inicial vuelve a poder faltar, que es exactamente por lo que la sesión de conciliación llevaba un cero fijo en su lugar',
      },
    ],
    evaluar: () => {
      // Hasta F05a el módulo bancario tenía movimientos sueltos colgando de un
      // `import_batch_id` que era un UUID sin tabla, y una sesión que insertaba
      // su `beginning_balance` FIJO EN CERO porque no tenía de dónde sacarlo.
      // Las siete pruebas de integridad son preguntas sobre un DOCUMENTO con
      // saldo inicial y final; sin él no hay ninguna que se pueda formular.
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');

      if (!/CREATE TABLE bank_statements/.test(sql)) {
        return falla('no existe la tabla del estado de cuenta: sin documento no hay conciliación posible');
      }
      // Los dos saldos, OBLIGATORIOS. Un saldo que puede faltar reproduce el
      // cero-que-significa-nada del que venimos.
      const obligatorias = ['opening_balance', 'closing_balance'].filter(
        (c) => !new RegExp(`${c} DECIMAL\\(19,4\\) NOT NULL`).test(sql)
      );
      if (obligatorias.length > 0) {
        return falla(`el estado de cuenta admite saldo ausente en: ${obligatorias.join(', ')}`);
      }
      // El hash del archivo ORIGINAL: el extracto es evidencia fiscal y quien
      // lo audite tiene que poder atar el PDF del banco con lo que entró.
      if (!/file_sha256 CHAR\(64\) NOT NULL/.test(sql)) {
        return falla('el estado de cuenta no guarda el hash de su archivo: deja de ser evidencia atable');
      }
      const dedupe = /UNIQUE \(bank_account_id, file_sha256\)/.test(sql);
      return dedupe
        ? ok('el estado de cuenta lleva sus dos saldos obligatorios y el hash de su archivo, y el mismo archivo no entra dos veces')
        : falla('desapareció el dedupe por archivo: reimportar el mismo extracto volvería a duplicarlo entero');
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'La deduplicación de movimientos la calcula la base, no quien escribe',
    mutantes: [
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: '  NEW.content_hash := encode(',
        a: '  NEW.content_hash := COALESCE(NEW.content_hash, encode(',
        porque: 'el llamador recupera el control del hash: mandando uno inventado en cada fila, el índice único deja de reconocer el duplicado y el dedupe se apaga desde fuera',
      },
      {
        archivo: 'src/database/migrations/051_la_cuenta_y_el_extracto.sql',
        de: 'CREATE UNIQUE INDEX uq_bank_tx_contenido ON bank_transactions(bank_account_id, content_hash);',
        a: 'CREATE INDEX uq_bank_tx_contenido ON bank_transactions(bank_account_id, content_hash);',
        porque: 'el índice deja de ser único y vuelve el defecto de la 003: se calcula un hash que a nadie le impide nada',
      },
    ],
    evaluar: () => {
      // EL DEDUPE QUE NO DEDUPLICABA. La 003 declaraba
      // `UNIQUE(bank_account_id, bank_transaction_id)` sobre una columna
      // NULLABLE, y en Postgres dos NULL no colisionan: no impedía nada en
      // cuanto el banco no publicaba id nativo, que es el caso de todo CSV. Y
      // el guardia de aplicación fallaba por el otro lado —
      // `WHERE bank_transaction_id = $1` con $1 nulo no casa nunca—. Dos
      // capas, el mismo agujero: reimportar duplicaba el extracto entero.
      //
      // Se reparó donde no se puede rodear. Un hash que el llamador PROVEE es
      // un hash que el llamador puede equivocar o falsear, y entonces el
      // índice único deja de significar «esta línea ya está».
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');

      if (!/CREATE TRIGGER bank_transactions_content_hash/.test(sql)) {
        return falla('el hash de contenido dejó de calcularlo la base: vuelve a depender de que cada superficie lo mande bien');
      }
      // Y lo IMPONE: una asignación directa, no un COALESCE que respetaría lo
      // que venga de fuera. Es la diferencia entre calcularlo y aceptarlo.
      if (!/NEW\.content_hash := encode\(/.test(sql)) {
        return falla('el disparador dejó de imponer el hash: si respeta el que manda el llamador, el dedupe se apaga desde fuera');
      }
      if (!/ALTER COLUMN content_hash SET NOT NULL/.test(sql)) {
        return falla('content_hash volvió a admitir NULL, que es la forma exacta del defecto que se venía a reparar');
      }
      const unico = /CREATE UNIQUE INDEX uq_bank_tx_contenido/.test(sql);
      return unico
        ? ok('el hash lo impone un disparador y el índice único lo hace valer: el dedupe no se puede rodear desde ninguna superficie')
        : falla('el índice de contenido dejó de ser único: se calcularía un hash que no impide ningún duplicado');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Las siete pruebas del extracto existen todas y su hallazgo bloqueante sale 4',
    mutantes: [
      {
        archivo: 'src/services/banking/statement-checks.ts',
        de: "      check: 'continuidad',",
        a: "      check: 'cadena-de-saldos',",
        porque: 'la prueba que detecta un estado FALTANTE se disfraza de otra: el hueco entre el saldo final de un mes y el inicial del siguiente dejaría de tener nombre propio',
      },
      {
        archivo: 'src/cli/bank-command.ts',
        de: 'return checkExitCode(',
        a: 'return 0 || checkExitCode(',
        porque: 'un extracto con hallazgo bloqueante sale 0 y cualquier guion de cierre lo da por bueno: el §4.1 del catálogo exige 4',
      },
    ],
    evaluar: () => {
      // El catálogo las nombra una por una (fila 1165) y exige salida 4. Son
      // el producto entero de este tramo: importar un extracto sin poder
      // comprobarlo es volver a creerle al archivo.
      const checks = codigoDe('src/services/banking/statement-checks.ts');
      const LAS_SIETE = [
        'cadena-de-saldos',
        'continuidad',
        'huecos-y-traslapes',
        'identidad',
        'moneda',
        'secuencia',
        'reversos',
      ];
      const faltan = LAS_SIETE.filter((c) => !new RegExp(`check: '${c}'`).test(checks));
      if (faltan.length > 0) {
        return falla(`de las siete pruebas de integridad del extracto faltan: ${faltan.join(', ')}`);
      }

      // Y VIVEN SEPARADAS DE LA BASE. Una comprobación que sólo se puede
      // ejercitar con Postgres detrás es una comprobación que nadie prueba, y
      // acaba siendo la que miente.
      if (/\bfrom '\.\.\/\.\.\/database\/connection\.js'/.test(checks)) {
        return falla('las siete pruebas se ataron a la base: dejan de poder ejercitarse sobre datos en memoria');
      }

      // El 4 se ancla en la LLAMADA, no en el import: importar checkExitCode y
      // no usar su resultado es el falso verde clásico de esta familia.
      const sale4 = /return checkExitCode\(\s*\n?\s*\{ blocking:/.test(codigoDe('src/cli/bank-command.ts'));
      return sale4
        ? ok('las siete pruebas están, viven fuera de la base y el hallazgo bloqueante sale 4')
        : falla('`bank statement check` dejó de devolver el código de checkExitCode: un extracto roto saldría 0');
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'Importar un extracto no alcanza el mayor, que es lo único que se lo permite al agente',
    mutantes: [
      {
        // El mutante inserta CÓDIGO, no un comentario. La primera versión
        // metía `/* createJournalEntry( */` y sobrevivía con razón:
        // `codigoDe` quita los comentarios antes de mirar, y un comentario
        // que nombra el mayor no es un camino al mayor. El mutante estaba
        // mal, no el ancla.
        archivo: 'src/services/banking/bank-statement-service.ts',
        de: '    await client.query(',
        a: '    await createJournalEntry(); await client.query(',
        porque: 'basta un camino al mayor dentro del importador para que su `draftOnly` sea falso, y con él la única razón por la que el agente puede invocarlo',
      },
      {
        archivo: 'src/cli/bank-command.ts',
        de: '    draftOnly: true,',
        a: '    draftOnly: false,',
        porque: 'el agente conservaría la escritura sin la afirmación que la justifica — es la combinación que declareRisk existe para negar',
      },
    ],
    evaluar: () => {
      // `bank statement import` es la ÚNICA fila de esta familia con IA ✓
      // sobre un verbo que escribe, y `declareRisk` sólo lo admite con
      // `draftOnly: true` (kernel/risk.ts:103). Esa afirmación no se cree: se
      // comprueba. Lo que la sostiene es que el importador escribe staging
      // bancario —la afirmación de un tercero sobre nuestro dinero, esperando
      // cotejo— y no tiene camino al mayor por ninguna bandera.
      const cli = codigoDe('src/cli/bank-command.ts');
      const svc = codigoDe('src/services/banking/bank-statement-service.ts');

      const declara = /declareRisk\(importar, \{[\s\S]{0,200}?risk: 'escritura',[\s\S]{0,120}?agent: true,[\s\S]{0,120}?draftOnly: true,/.test(cli);
      if (!declara) {
        return falla('`bank statement import` dejó de declararse escritura+agente+draftOnly: o el agente perdió la fila, o la ganó sin la afirmación que la justifica');
      }

      // Y LA AFIRMACIÓN SE VERIFICA CONTRA EL SERVICIO. Un `draftOnly: true`
      // es una promesa sobre lo que el código hace; anclarlo sin mirar el
      // servicio sería creerle a la declaración.
      const alMayor = /createJournalEntry|postJournalEntry|INSERT INTO journal_entries/.exec(svc);
      return alMayor === null
        ? ok('el importador declara draftOnly y lo cumple: no hay un solo camino desde él al mayor')
        : falla(
            `el importador alcanza el mayor ("${alMayor[0]}"): su draftOnly es falso y con él la razón por la que el agente puede llamarlo`
          );
    },
  },

  {
    paquete: 'E0.3',
    enunciado: 'La CLABE se guarda cifrada, como el número de cuenta que es',
    mutantes: [
      {
        archivo: 'src/services/banking/bank-account-service.ts',
        de: '            clabe ? encrypt(clabe.clabe) : null,',
        a: '            clabe ? clabe.clabe : null,',
        porque: 'la CLABE vuelve a la base en claro, que es exactamente el defecto de la 003 que este tramo repara',
      },
    ],
    evaluar: () => {
      // La 003 cifraba el número de cuenta y el routing y dejaba la CLABE en
      // `VARCHAR(18)` a la vista, al lado de las otras dos. La CLABE ES el
      // número de cuenta en México: era el mismo dato que las columnas
      // vecinas protegían, guardado sin protección. El criterio E0.3 de la
      // bitácora ya la nombraba entre «los campos que los servicios cifran
      // hoy» — daba por hecho un cifrado que no existía.
      const sql = crudoDe('src/database/migrations/051_la_cuenta_y_el_extracto.sql');
      if (!/ALTER TABLE bank_accounts DROP COLUMN clabe;/.test(sql)) {
        return falla('la columna clabe en claro sigue en pie');
      }
      const svc = codigoDe('src/services/banking/bank-account-service.ts');
      if (!/encrypt\(clabe\.clabe\)/.test(svc)) {
        return falla('la CLABE se escribe sin cifrar: vuelve a estar en claro en la base');
      }
      // Y NO SALE ENTERA POR NINGUNA SUPERFICIE: lo que se muestra son los
      // últimos cuatro. Cifrarla y luego imprimirla no protege nada.
      const enmascara = /clabe: enmascarar\(fila\.clabe_last4\)/.test(svc);
      return enmascara
        ? ok('la CLABE se cifra al escribir y sólo salen sus últimos cuatro dígitos al leer')
        : falla('la ficha de la cuenta dejó de enmascarar la CLABE: cifrarla y luego imprimirla no protege nada');
    },
  },

  // ---- F04 · Pagar ----

  {
    paquete: 'E0.3',
    enunciado: 'Un CFDI de fuera no da de alta a su propio emisor: el alta de contraparte la autoriza quien llama',
    mutantes: [
      {
        archivo: 'src/services/xml-ingestion/pre-registration-service.ts',
        de: '} else if (!opciones.permitirProveedorNuevo) {',
        a: '} else if (false) {',
        porque: 'la puerta se abre de par en par: cualquier XML volvería a fabricar la contraparte y su pasivo sin que nadie lo apruebe',
      },
      {
        archivo: 'src/services/xml-ingestion/pre-registration-service.ts',
        de: 'await this.processToAccounting(preReg, userId, { permitirProveedorNuevo: false });',
        a: 'await this.processToAccounting(preReg, userId, { permitirProveedorNuevo: true });',
        porque: 'el lote programado —que corre desatendido sobre N documentos— se autoconcede crear proveedores: quien lanzó el lote aprobó el lote, no al emisor de cada comprobante',
      },
    ],
    evaluar: () => {
      // EL HUECO QUE EL PROPIO CATÁLOGO TENÍA ESCRITO. `createBillFromPreReg`
      // daba de alta al emisor del comprobante con el nombre y el RFC que
      // venían DENTRO del XML —dato maestro redactado por un tercero— y en la
      // misma llamada reconocía el pasivo a su favor y posteaba su póliza.
      // Bastaba con que un CFDI llegara, por cualquier vía, para que el
      // catálogo de proveedores creciera solo. Es el ejemplo de manual de por
      // qué un control interno existe.
      const svc = codigoDe('src/services/xml-ingestion/pre-registration-service.ts');

      // 1. La puerta existe y es FAIL-CLOSED: se ancla el throw, no el `if`.
      //    Un guardia que comprueba y no actúa es la fuga clásica.
      if (!/else if \(!opciones\.permitirProveedorNuevo\) \{[\s\S]{0,400}?throw new ProveedorNuevoSinAutorizar\(/.test(svc)) {
        return falla(
          'el alta del emisor del CFDI ya no exige autorización del llamador: un XML de fuera ' +
            'volvería a crear la contraparte y su pasivo sin que nadie lo apruebe'
        );
      }

      // 2. El defecto es NO. Una opción cuyo tipo admite `undefined` y que se
      //    lee sin `?? false` sería fail-open el día que alguien pase `{}`.
      if (!/permitirProveedorNuevo\?: boolean;/.test(svc)) {
        return falla('la autorización dejó de ser opcional-negativa: el que no dice nada tiene que NO crear proveedores');
      }

      // 3. NINGÚN camino automático la concede. Se listan por ruta y se exige
      //    que todos pasen `false` literal: el motor de reglas (que un renglón
      //    antes pudo ponerse processing_mode='auto' él mismo), el lote
      //    programado, la ingesta del agente y el barrido de REP pendientes.
      const AUTOMATICOS: Record<string, string> = {
        'src/ai/ingest-service.ts': 'la ingesta del agente',
        'src/services/xml-ingestion/rep-pendientes.ts': 'el barrido de REP pendientes',
      };
      const concedidos = Object.entries(AUTOMATICOS)
        .filter(([archivo]) => {
          const f = codigoDe(archivo);
          return (
            /processToAccounting\(/.test(f) &&
            !/permitirProveedorNuevo:\s*false/.test(f)
          );
        })
        .map(([, quien]) => quien);
      if (concedidos.length > 0) {
        return falla(
          `camino(s) automático(s) que contabilizan sin negar el alta de proveedor: ${concedidos.join(', ')}`
        );
      }

      // Y dentro del propio servicio, las DOS ramas desatendidas —la del motor
      // de reglas y la del lote programado— la niegan. Se CUENTAN: son gemelas
      // textuales, y un ancla de presencia se conforma con encontrar la otra.
      const negaciones = (svc.match(/permitirProveedorNuevo:\s*false/g) ?? []).length;
      return negaciones >= 2
        ? ok(
            'el alta del emisor exige autorización explícita del llamador, el defecto es negarla ' +
              'y ningún camino desatendido la concede'
          )
        : falla(
            `sólo ${negaciones} de las 2 ramas desatendidas del servicio niegan el alta de proveedor ` +
              '(el motor de reglas y el lote programado)'
          );
    },
  },


  {
    paquete: 'E1.2',
    enunciado: 'El descuento por pronto pago tiene cuenta, asiento y un techo que las condiciones fijan',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'if (derecho.applied && descuento.greaterThan(derecho.discountAmount)) {',
        a: 'if (false) {',
        porque: 'el techo del descuento se apaga: tomar más de lo pactado volvería a pasar por pronto pago en vez de por pago corto',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "account_id: requireRole(roles, 'devolucion_compras'),",
        a: "account_id: requireRole(roles, 'cxp'),",
        porque: 'el contra-costo se convierte en la propia cuenta de control: el descuento dejaría de reducir la compra y el pasivo se cancelaría solo',
      },
    ],
    evaluar: () => {
      // El descuento se INSERTABA en payment_applications y no participaba en
      // nada más: ni bajaba el saldo ni entraba en el asiento, así que el
      // proveedor quedaba debiendo el descuento para siempre. Se rechazaba en
      // voz alta alegando que faltaba «una cuenta de ingreso por descuentos en
      // la capa de roles» — y la cuenta llevaba sembrada desde el principio
      // (5200, contra-costo, espejo del 4400 de las ventas). Lo que faltaba no
      // era la cuenta: era atarla.
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // 1. La cuenta existe en el mapa de roles, que es de donde el asiento la saca.
      if (!/devolucion_compras:\s*'5200'/.test(codigoDe('src/services/xml-ingestion/account-roles-seed.ts'))) {
        return falla('el rol devolucion_compras perdió su cuenta: el descuento no tendría dónde abonarse');
      }

      // 2. Los DOS asientos lo abonan de verdad: el del pago directo y el de
      //    la aplicación posterior. Se CUENTAN, no se busca «alguna»
      //    ocurrencia — son gemelos textuales, y un ancla de presencia se
      //    conforma con encontrar el otro. El arnés lo cobró: mutar la línea
      //    del primero dejaba el criterio en verde señalando al segundo.
      const abonos = (
        post.match(
          /account_id: requireRole\(roles, 'devolucion_compras'\),\s*\n\s*debit_amount: null,\s*\n\s*credit_amount: descuento/g
        ) ?? []
      ).length;
      if (abonos !== 2) {
        return falla(
          `el descuento se abona a devolucion_compras en ${abonos} de los 2 asientos que lo admiten ` +
            '(el del pago y el de la aplicación posterior)'
        );
      }

      // 3. El pasivo se extingue por efectivo + descuento (+ condonación): si
      //    el cargo a cxp fuera sólo del efectivo, el asiento cuadraría igual
      //    y el gasto quedaría abierto por el descuento — mudo.
      if (!/debit_amount: total\.plus\(descuento\)\.plus\(condonado\)\.toFixed\(4\)/.test(post)) {
        return falla('el cargo a la cuenta de control dejó de cubrir todo lo que deja de deberse');
      }

      // 4. Y EL TECHO. `earlyPaymentDiscount` sabe cuánto conceden unas
      //    condiciones «2/10 net 30»; sin este guardia, tomar 500 sobre un
      //    descuento de 20 pasaría por pronto pago en vez de por el pago corto
      //    que es —el que exige motivo escrito. Se ancla el `throw`, no la
      //    llamada: comprobar y no actuar es la fuga clásica.
      const techo = /if \(derecho\.applied && descuento\.greaterThan\(derecho\.discountAmount\)\) \{[\s\S]{0,400}?throw new ValidationError\(/.test(svc);
      return techo
        ? ok('5200 recibe el descuento en el asiento, el pasivo se extingue entero y el techo lo fijan las condiciones del gasto')
        : falla('el descuento ya no se topa contra lo que las condiciones conceden: tomar de más volvería a pasar por pronto pago');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Un gasto cerrado con pago corto no deja IVA vivo en la cuenta de pendientes',
    mutantes: [
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: 'ivaNoAcreditablePorGasto.set(app.invoiceId, ivaCondonado.toFixed(4));',
        a: 'ivaCondonado = new Decimal(0);',
        porque: 'el IVA de la parte condonada deja de salir de 1135: un gasto CERRADO conservaría impuesto aparcado que nadie podrá vaciar nunca',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: 'const costoCondonado = condonado.minus(ivaYaSalido);',
        a: 'const costoCondonado = condonado;',
        porque: 'la parte de IVA se abonaría DOS veces —a 1135 y a la cuenta del pago corto— y el asiento saldría descuadrado por el importe del impuesto',
      },
    ],
    evaluar: () => {
      // Bajo flujo de efectivo el IVA acreditable espera en 1135 hasta que se
      // paga. Cerrar un gasto pagando de menos crea un caso que el sistema no
      // tenía: el impuesto de la parte que NO se pagó nunca va a ser
      // acreditable, y si sólo se libera la parte pagada queda un resto vivo
      // en 1135 de un documento sin saldo — un residuo que ningún informe
      // sabe explicar y que ya no se puede vaciar, porque el gasto que lo
      // justificaba está cerrado. Sale en el mismo asiento, y NO hacia 1130:
      // no se acredita lo que no se pagó.
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // El reparto es proporcional al peso del IVA en el total del gasto...
      if (!/condonadoAqui\s*\n?\s*\.times\(app\.taxAmount\)\s*\n?\s*\.dividedBy\(app\.totalAmount\)/.test(post)) {
        return falla('el IVA condonado dejó de repartirse en proporción al impuesto del gasto');
      }
      // ...y se topa con lo que de verdad queda aparcado tras la liberación:
      // sacar de 1135 más de lo que hay dejaría la cuenta en negativo.
      if (!/const restaAparcado = new Decimal\(parked\)\.minus\(liberable\);/.test(post)) {
        return falla('el IVA condonado ya no se topa contra lo que queda aparcado: podría vaciar 1135 por debajo de cero');
      }
      // Va contra `from` (1135), no contra `to` (1130): acreditarlo sería
      // deducir un impuesto que nadie pagó.
      if (!/account_id: requireRole\(ivaRoles, from\),\s*\n\s*debit_amount: null,\s*\n\s*credit_amount: ivaCondonado\.toFixed\(4\)/.test(post)) {
        return falla('el IVA de la parte condonada ya no sale de la cuenta de pendientes');
      }

      // Y SE ANOTA POR GASTO. Sin esta línea el importe sigue posteándose,
      // pero en CERO —el arnés lo demostró: anular ivaCondonado justo antes
      // del push dejaba las tres anclas anteriores intactas y el criterio en
      // verde—. El mapa no es contabilidad de adorno: es lo que el llamador
      // resta del costo condonado para no abonar el impuesto dos veces.
      if (!/ivaNoAcreditablePorGasto\.set\(app\.invoiceId, ivaCondonado\.toFixed\(4\)\);/.test(post)) {
        return falla('el IVA condonado ya no se anota por gasto: el asiento lo abonaría en cero y el residuo volvería a 1135');
      }

      // Y ESE RESTO se descuenta del abono al pago corto. Si no, la parte de
      // impuesto se abonaría dos veces —a 1135 y a la cuenta de condonación—
      // y el asiento saldría descuadrado justo por el IVA.
      const resta = /const costoCondonado = condonado\.minus\(ivaYaSalido\);/.test(post);
      return resta
        ? ok('el IVA de lo condonado sale de 1135 proporcional, topado y anotado, y no se abona dos veces')
        : falla('el abono del pago corto dejó de restar el IVA que ya salió de 1135: el asiento se descuadraría por el impuesto');
    },
  },

  {
    paquete: 'E1.3',
    enunciado: 'A qué cuenta va un saldo condonado lo decide el panel, y sin motivo escrito no se condona',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "if (residual && !opts.shortPayReason?.trim()) {",
        a: 'if (false) {',
        porque: 'un pasivo podría desaparecer sin una línea que explique por qué: es lo único que el auditor tiene',
      },
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: "      ? await getPolicy({ tenantId, entityId }, 'pago_corto_residual')",
        a: "      ? { key: 'x', value: 'descuento_compras', defined: true, question: '', rationale: null }",
        porque: 'la cuenta se cablea en el código y el panel deja de gobernarla: la opción «prohibir» del despacho no se aplicaría nunca',
      },
    ],
    evaluar: () => {
      // Una bifurcación de criterio contable no se pregunta por chat ni se
      // elige en el código: se añade al panel. Aquí la bifurcación es a dónde
      // va el saldo que deja de deberse —menos costo (5200) u otro ingreso
      // (4200)—, y hasta puede estar prohibido cerrar corto. El código postea
      // lo que el panel dicte.
      const cat = codigoDe('src/services/policy/pending-catalog.ts');
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      // 1. La decisión está en el panel, con sus tres salidas.
      //
      // El recorte va de SU clave a la siguiente entrada del catálogo (o al
      // final), no por una ventana de N caracteres: la primera versión usaba
      // 1400 y la prosa de `whyAsking`/`whatIDo` empujaba `priority:` más
      // allá, así que el criterio fallaba por la longitud del texto y no por
      // lo que mide. Una ventana fija es una ancla que caduca cuando alguien
      // escribe de más.
      const desde = cat.indexOf("key: 'pago_corto_residual'");
      if (desde < 0) {
        return falla('la decisión pago_corto_residual desapareció del panel');
      }
      const siguiente = cat.indexOf("\n    key: '", desde);
      const spec = cat.slice(desde, siguiente < 0 ? cat.length : siguiente);
      const opciones = ['descuento_compras', 'otros_ingresos', 'prohibir'].filter(
        (o) => !new RegExp(`value: '${o}'`).test(spec)
      );
      if (opciones.length > 0) {
        return falla(
          `la decisión pago_corto_residual perdió opciones del panel: ${opciones.join(', ')}`
        );
      }

      // 2. Y TIENE LECTOR. Un panel sin lector es decoración: la regla de la
      //    casa es que la decisión y quien la obedece viajan en el mismo
      //    commit.
      if (!/getPolicy\([\s\S]{0,80}?'pago_corto_residual'\)/.test(svc)) {
        return falla('pago_corto_residual no se lee en ninguna parte: sería una pregunta sin consecuencia');
      }

      // 3. «prohibir» PROHÍBE de verdad. Se ancla el throw, no el `if`.
      if (!/politica\?\.value === 'prohibir'[\s\S]{0,300}?throw new ValidationError\(/.test(svc)) {
        return falla('la opción «prohibir» del panel ya no impide cerrar un gasto pagando de menos');
      }

      // 4. La capa de asiento NO decide: recibe la cuenta y se niega a postear
      //    sin ella, en vez de suponer una.
      if (!/writeOffRole\?: 'devolucion_compras' \| 'otros_ingresos'/.test(post)) {
        return falla('el asiento dejó de recibir la cuenta del pago corto como parámetro: la estaría eligiendo él');
      }
      if (!/condonado\.greaterThan\(0\) && !writeOffRole[\s\S]{0,300}?throw new AccountingError\(/.test(post)) {
        return falla('el asiento postearía un pago corto sin saber a qué cuenta: elegiría una por su cuenta o descuadraría');
      }

      // 5. Sin motivo escrito no se condona.
      const motivo = /if \(residual && !opts\.shortPayReason\?\.trim\(\)\) \{[\s\S]{0,300}?throw new ValidationError\(/.test(svc);
      return motivo
        ? ok('la cuenta del pago corto la dicta el panel (con «prohibir» que prohíbe), el asiento la recibe y sin motivo escrito no se condona')
        : falla('cerrar un gasto pagando de menos ya no exige motivo: el pasivo desaparecería sin explicación');
    },
  },

  {
    paquete: 'E1.2',
    enunciado: 'Un pago ya hecho se puede repartir después, sin volver a mover el efectivo',
    mutantes: [
      {
        archivo: 'src/services/payments/payment-service.ts',
        de: 'if (total.greaterThan(remanente)) {',
        a: 'if (false) {',
        porque: 'se podría aplicar más de lo que el pago tiene sin repartir: el anticipo quedaría en negativo y el auxiliar dejaría de cuadrar',
      },
      {
        archivo: 'src/services/accounting/ar-ap-posting.ts',
        de: "sourceType: 'vendor_application'",
        a: "sourceType: 'vendor_payment'",
        porque: 'la aplicación se disfraza del pago que la originó: la conciliación contaría dos veces el mismo movimiento de efectivo',
      },
    ],
    evaluar: () => {
      // Una tesorería real transfiere PRIMERO —un importe global al proveedor,
      // cerrando la semana— y decide DESPUÉS contra cuáles de sus facturas
      // abiertas iba. Hasta F04 el único instante en que un pago podía tocar
      // un gasto era el de registrarlo, así que ese dinero quedaba en 1150 sin
      // forma de repartirlo nunca.
      const svc = codigoDe('src/services/payments/payment-service.ts');
      const post = codigoDe('src/services/accounting/ar-ap-posting.ts');

      if (!/export async function applyVendorPayment\(/.test(svc)) {
        return falla('no existe applyVendorPayment: un pago global seguiría sin poder repartirse');
      }
      // El efectivo NO se vuelve a mover: el asiento de la aplicación cambia
      // anticipo por cuenta de control, y nada más. Si tocara el banco,
      // contaría dos veces una salida que ya se posteó.
      const cuerpo = /export async function postVendorApplicationEntry\(([\s\S]*?)\n\}/.exec(post)?.[1] ?? '';
      if (/requireRole\((?:roles|[a-zA-Z]+), 'banco'\)/.test(cuerpo)) {
        return falla('el asiento de la aplicación toca el banco: el efectivo ya salió con el pago y se estaría contando dos veces');
      }
      // Y la lectura del pago va ACOTADA POR ENTIDAD dentro del SQL: un pago
      // de otro inquilino no se aplica ni conociendo su id.
      if (!/FROM vendor_payments WHERE id = \$1 AND entity_id = \$2 FOR UPDATE/.test(svc)) {
        return falla('el pago se lee sin acotar por entidad o sin candado: la frontera del inquilino se cruzaría por id');
      }
      // La aplicación lleva su PROPIO source_type. Disfrazarla del pago que
      // la originó haría que cualquier conciliación que agrupe por origen
      // contara dos veces el mismo movimiento de efectivo.
      if (!/sourceType: 'vendor_application'/.test(post)) {
        return falla('el asiento de la aplicación perdió su source_type propio: se confundiría con el del pago');
      }

      // El tope contra el remanente, CONTADO en los dos eventos que reparten
      // saldo a cuenta (cobro y pago). Son gemelos textuales: buscar «alguno»
      // deja vivo al mutante que rompe el otro, y el arnés lo cobró.
      const topes = (svc.match(/if \(total\.greaterThan\(remanente\)\) \{\s*\n\s*throw new ValidationError\(/g) ?? []).length;
      return topes === 2
        ? ok('applyVendorPayment reparte un pago vivo sin tocar el banco, acotado por entidad, con source_type propio y topado en los dos eventos')
        : falla(
            `el tope contra el remanente sobrevive en ${topes} de los 2 eventos que reparten saldo a cuenta: ` +
              'sin él se repartiría dinero que el pago no tiene'
          );
    },
  },

  // ══════════════════════════════════════════════════════════
  // S-UX · lote 2. Seis criterios que nacen de una lección repetida:
  // el guardián se deriva del ÁRBOL, nunca de una lista paralela. Los
  // cinco entregables de este tramo pasaron por un adversario con el
  // encargo de tumbarlos, y los cinco tenían el mismo defecto de
  // familia — la prueba miraba un árbol de juguete, una sola fila, o
  // un suelo con holgura. Cada criterio de abajo cita el mutante que
  // SOBREVIVÍA antes de armarlo.
  // ══════════════════════════════════════════════════════════
  {
    paquete: 'E5.1',
    enunciado:
      'El guion de completado se genera del árbol embarcado entero, y su cuerpo no le devuelve la lista al shell para que la expanda',
    mutantes: [
      {
        archivo: 'src/cli/completion-command.ts',
        de: '      visit(child, childPath);',
        a: '      if (childPath.length < 3) visit(child, childPath);',
        porque:
          'profundidad-truncada: un generador que se detiene un nivel antes pierde las 53 tablas de tercer nivel (el guion cae de 597 a 544 líneas) y una prueba sobre un árbol sintético de dos niveles no tiene tercer nivel que perder',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('src/cli/completion-command.ts');
      // El recorrido no se topa: un tope de profundidad es el modo de
      // fallo que deja `sat cred add --<TAB>` sin ofrecer --dry-run.
      if (/childPath\.length\s*<\s*\d/.test(gen)) {
        return falla('el generador de completado topó la profundidad del recorrido: las hojas de tercer nivel perderían su tabla de banderas');
      }
      // Escape con bandera GLOBAL. Sin /g sólo se escapa la primera
      // comilla, y un nombre con dos deja el resto del texto donde el
      // shell lo expande. Demostrado en bash 3.2: se ejecuta.
      if (!/\.replace\(\/'\/g,/.test(gen)) {
        return falla('shellQuote perdió la bandera global del escape: un nombre con dos comillas deja carga ejecutable en el guion');
      }
      // El cuerpo consumidor lee palabra a palabra. `compgen -W` EXPANDE
      // la lista, así que devuelve al shell justo lo que las tablas
      // habían entrecomillado bien. OJO al ancla: el módulo NOMBRA
      // «compgen -W» dentro del comentario BASH que lo prohíbe, y ese
      // comentario viaja en una cadena de TypeScript, así que
      // codigoDe() no lo quita. Buscar el nombre acusaría a la frase
      // que previene el defecto — el primer intento de este criterio
      // hizo justo eso. Se ancla en la CONDUCTA: ninguna línea que
      // abra `candidates=(` puede continuar con una expansión.
      if (/candidates=\(\s*\$\(/.test(gen)) {
        return falla('el consumidor del guion volvió a construir la lista con una expansión: un alias hostil ejecuta código al pulsar TAB');
      }
      if (!/while IFS= read -r word/.test(gen)) {
        return falla('el cuerpo del guion perdió el lector línea a línea: es la pieza que impide que el shell expanda lo que se le ofrece');
      }
      // Y el guardián mira el objeto que la pieza produce: el program
      // EMBARCADO, no un árbol inventado. Ésta es la lección entera.
      const spec = codigoDe('tests/cli/completion-command.spec.ts');
      return /from '\.\.\/\.\.\/src\/cli\/mnemosine\.js'/.test(spec)
        ? ok('el completado se genera del árbol embarcado, con escape global y sin reexpansión en el consumidor')
        : falla('la prueba del completado dejó de importar el program embarcado: volvería a certificar un árbol de juguete');
    },
  },
  {
    paquete: 'E5.1',
    enunciado:
      'El documento que el agente lee como «el binario exacto» reproduce la ayuda real, con los ejemplos incluidos',
    mutantes: [
      {
        archivo: 'scripts/generate-cli-reference.ts',
        de: "  emitir(cmd, 'afterHelp', contexto);",
        a: '  // emitir(cmd, contexto);',
        porque:
          'ayuda-a-medias: helpInformation() no dispara afterHelp, así que las 244 invocaciones de ejemplo desaparecen del documento mientras el generador sigue prometiendo fidelidad byte a byte',
      },
    ],
    evaluar: () => {
      const gen = codigoDe('scripts/generate-cli-reference.ts');
      if (!/emitir\(cmd, 'afterHelp', contexto\)/.test(gen)) {
        return falla('el generador volvió a la ayuda sin afterHelp: los ejemplos no llegarían al documento que el agente lee como el binario');
      }
      // Conteo sobre el ARTEFACTO, no sobre el generador: un generador
      // correcto con un documento sin regenerar es el mismo hueco.
      const doc = crudoDe('src/ai/docs/cli-reference.md');
      const ejemplos = (doc.match(/Examples:/g) ?? []).length;
      if (ejemplos < 100) {
        return falla(
          `cli-reference.md sólo trae ${ejemplos} bloques de ejemplos: el documento está sin regenerar y el agente no ve la mitad visible de la ayuda`
        );
      }
      return ok(`el documento del agente reproduce la ayuda real: ${ejemplos} bloques de ejemplos`);
    },
  },
  {
    paquete: 'E5.1',
    enunciado:
      'Todo ejemplo de la ayuda lo acepta el Commander embarcado, en la hoja en cuya ayuda vive, y ninguno enseña la clave legada tax=',
    mutantes: [
      {
        archivo: 'src/cli/bill-command.ts',
        de: 'tax-amount=2000.00',
        a: 'tax=16',
        porque:
          'ejemplo-que-miente: tax= es TASA en invoice y MONTO en bill, así que el ejemplo copiable registraría 16 pesos de IVA donde van 2 000 — la confusión H3 que este tramo existe para curar, en el propio texto que la cura',
      },
    ],
    evaluar: () => {
      const spec = codigoDe('tests/cli/ejemplos-de-ayuda.spec.ts');
      // La prueba PARSEA con el Commander real: comprobar que la bandera
      // existe deja pasar el ejemplo al que le falta el argumento
      // posicional, y ése muere en el parser del usuario, no en CI.
      if (!/\.parse\(argv, \{ from: 'user' \}\)/.test(spec)) {
        return falla('el guardián de ejemplos dejó de pasar las invocaciones por el Commander real: un ejemplo sin su argumento posicional volvería a pasar en verde');
      }
      // Los suelos van en el valor MEDIDO. Un suelo con holgura no es un
      // trinquete: es un permiso — con 97 sobre 115 se podía borrar una
      // familia documentada entera sin un solo rojo.
      const suelos = spec.match(/(?:SUELO|MINIMO)_[A-Z_]+\s*=\s*(\d+)/g) ?? [];
      if (suelos.length < 2) {
        return falla('el guardián de ejemplos perdió sus suelos medidos: sin ellos un revert parcial pasa en verde');
      }
      const bill = codigoDe('src/cli/bill-command.ts');
      const ejemplosDeBill = bill.slice(bill.indexOf('EJEMPLOS'));
      return /tax-amount=/.test(ejemplosDeBill) && !/--line "[^"]*[,"]tax=/.test(ejemplosDeBill)
        ? ok('los ejemplos parsean contra el Commander embarcado y bill enseña tax-amount, no la clave legada')
        : falla('un ejemplo de bill volvió a la clave legada tax=: registraría el IVA con un factor de diez');
    },
  },
  {
    paquete: 'E5.1',
    enunciado:
      'Ninguna hoja del CLI aplasta su código de salida: el catch devuelve el código del contrato, y el error de uso de Commander pasa por la puerta que cierra el pool',
    mutantes: [
      {
        archivo: 'src/cli/memory-command.ts',
        de: '        await deps.shutdown(exitCodeFor(err));',
        a: '        await deps.shutdown(1);',
        porque:
          'código-aplastado: una hoja que ninguna fila conductual visita, con un texto que ningún grep de «shutdown(1)» esperaba encontrar de vuelta — 39 de 179 hojas vivían así y el contrato de trece códigos era papel',
      },
    ],
    evaluar: () => {
      // Barrido de la clase entera, no de la instancia: el defecto que
      // este criterio vigila vivía en 14 archivos a la vez.
      const archivos = fs
        .readdirSync(rutaDe('src/cli'))
        .filter((n) => n.endsWith('.ts'))
        .sort();
      const aplastan: string[] = [];
      for (const nombre of archivos) {
        if (/shutdown\(1\)/.test(codigoDe('src/cli', nombre))) aplastan.push(nombre);
      }
      if (aplastan.length > 0) {
        return falla(
          `${aplastan.length} archivo(s) del CLI vuelven a aplastar el código de salida a 1: ${aplastan.slice(0, 4).join(', ')} — el contrato de trece códigos vuelve a ser papel`
        );
      }
      // Y la capa de Commander: sin exitOverride, un error de uso sale
      // por el process.exit() propio de Commander, con código 1 y sin
      // drenar las atestaciones ni cerrar el pool.
      const raiz = codigoDe('src/cli/mnemosine.ts');
      return /exitOverride/.test(raiz)
        ? ok(`ninguna hoja aplasta su código de salida (${archivos.length} archivos barridos) y Commander pasa por la puerta del kernel`)
        : falla('el program perdió exitOverride: los errores de uso saldrían con 1 y sin cerrar el pool');
    },
  },
  {
    paquete: 'E1.3',
    enunciado:
      'La capa explicativa vive donde se decide, no sólo en el alta: pending imprime los tres campos del catálogo, pide el preview con el contexto de la entidad y no enseña prosa sin envolver',
    mutantes: [
      {
        archivo: 'src/cli/pending-command.ts',
        de: "    out.push(...wrapLines('   ', '   ', p.question));",
        a: '    out.push(`   ${p.question}`);',
        porque:
          'prosa-sin-envolver: las 21 políticas del catálogo tienen impact de más de 72 caracteres (la más larga, 406) y el terminal las reflowa a columna cero, perdiendo la sangría que dice a qué clave pertenece cada cosa',
      },
    ],
    evaluar: () => {
      const cli = codigoDe('src/cli/pending-command.ts');
      // Del CATÁLOGO, no de la fila sembrada: el texto congelado al
      // sembrar caduca en cuanto alguien reescribe el catálogo.
      if (!/getPolicySpec\(/.test(cli)) {
        return falla('pending dejó de leer el catálogo: imprimiría el texto congelado al sembrar, que caduca sin avisar');
      }
      for (const campo of ['whyAsking', 'whatIDo', 'ifSkipped']) {
        if (!new RegExp(`spec\\??\\.${campo}`).test(cli)) {
          return falla(
            `pending dejó de imprimir ${campo}: la capa explicativa volvería a existir sólo en el alta, el único momento en que no tiene datos que enseñar`
          );
        }
      }
      // El preview, con el contexto de la ENTIDAD: sin él el ejemplo
      // deja de ser el del cliente, que es lo único que lo hace valer.
      if (!/previewFor\(/.test(cli)) {
        return falla('pending dejó de pedir la vista previa: el contador vería la pregunta sin sus propios datos debajo');
      }
      // Envoltura en las DOS pantallas, cada una con su ancla PROPIA.
      // Contar llamadas con un umbral era holgura: sobran sitios
      // envueltos, así que quitar uno dejaba el conteo por encima del
      // tope y el mutante pasaba en verde. Arreglar el listado y no el
      // prompt de define es reparar la instancia: son la misma decisión
      // vista dos veces, y el prompt es el instante en que se toma.
      if (!/wrapLines\('   ', '   ', p\.question\)/.test(cli)) {
        return falla('el listado de pending dejó de envolver la pregunta: la prosa del catálogo saldría a columna cero, sin la sangría que dice a qué clave pertenece');
      }
      if (!/for \(const l of wrapLines\('', '', p\.question\)\)/.test(cli)) {
        return falla('el prompt de «pending define» dejó de envolver la pregunta: la mitad de la envoltura volvería a llegar a una sola de las dos pantallas');
      }
      const envueltos = (cli.match(/wrapLines\(/g) ?? []).length;
      return ok(`la capa explicativa vive en pending con su preview y ${envueltos - 1} campos envueltos en las dos pantallas`);
    },
  },
  {
    paquete: 'E0.0',
    enunciado:
      'El censo de superficie corre en CI, y su trinquete está apretado contra lo medido',
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/ux-status.ts --check',
        a: '      # - run: npx tsx scripts/ux-status.ts --check',
        porque:
          'puerta-declarada-y-no-cableada: el instrumento existía, la prueba lo importaba, y la degradación de superficie entraba igual porque nada lo corría en el único sitio que decide una fusión',
      },
    ],
    evaluar: () => {
      const ci = crudoDe('.github/workflows/ci.yml');
      // Ancla al PASO, no al texto: el modo de fallo natural de un paso de
      // CI es que alguien lo comente, y `# - run: … --check` contiene la
      // cadena entera. El primer intento de este criterio casaba su propio
      // comentario y bendecía al mutante que lo apagaba.
      if (!/^\s*- run: npx tsx scripts\/ux-status\.ts --check\s*$/m.test(ci)) {
        return falla('el censo de superficie salió de CI: la degradación de usabilidad volvería a entrar sin que nada la detenga en la fusión');
      }
      // Y las seis líneas base existen. Un censo sin línea base mide y
      // no acusa; el trinquete es la mitad que sirve.
      const censo = codigoDe('scripts/ux-status.ts');
      const base = censo.match(/LINEAS_BASE[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
      if (!base) {
        return falla('el censo perdió sus líneas base: mediría sin acusar, que es la mitad que no sirve');
      }
      const cuantas = (base[1].match(/:\s*\d+/g) ?? []).length;
      return cuantas === 6
        ? ok('el censo de superficie corre en CI con sus seis líneas base sembradas en lo medido')
        : falla(`el censo declara ${cuantas} líneas base de las 6 medidas: una medida sin trinquete no frena nada`);
    },
  },


];
