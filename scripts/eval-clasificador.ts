import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
// ── LOS DOS ÚNICOS `src` QUE ENTRAN ESTÁTICAMENTE, Y POR QUÉ ──
//
// Todo lo demás de src se importa DINÁMICAMENTE y después del global-setup:
// los módulos que tocan la base arman el pool leyendo DATABASE_URL al ser
// cargados, y el arnés fija esa variable creando la base efímera.
//
// Estos dos son módulos HOJA —no importan nada, ni siquiera un tipo— así que
// traerlos arriba no arrastra nada que lea DATABASE_URL. La excepción no se
// sostiene sola: `tests/ai/eval/arnes-cableado.spec.ts` afirma que ninguno de
// los dos tiene un solo import, y se pone roja el día que alguno lo tenga.
import { ExitCode, type ExitCodeValue } from '../src/cli/kernel/exit.js';
import { SUPERFICIE_INGESTA } from '../src/ai/tools/superficie.js';
// De tipo: se borra al transpilar, así que no carga módulo ninguno.
import type { LlmSession } from '../src/ai/providers/types.js';

// ============================================================
// EVAL DEL CLASIFICADOR — la vara de medir del agente (A1)
//
//   npm run eval -- [--provider anthropic] [--model m]
//                   [--casos a,b] [--umbral 0.8]
//
// Corre el golden set (tests/golden/cfdi/) por el MISMO camino que
// `mnemosine ingest` — ingestCfdiFiles con sus compuertas intactas — contra
// un proveedor FIJADO: createLlmSession directo, sin cadena de failover
// (un eval que cambia de modelo a mitad de corrida no mide nada) y con el
// grounding apagado, como toda corrida desatendida. Nada se reimplementa:
// si el arnés reconstruyera las compuertas por su cuenta, divergiría del
// producto y mediría un clasificador que no existe.
//
// …Y ESO ES EXACTAMENTE LO QUE HACÍA. La llamada a createLlmSession no
// pasaba `herramientas`, y buildTools sin lista devuelve TODAS: 25. La hoja
// de `mnemosine ingest` embarca SUPERFICIE_INGESTA, que son 11. El arnés
// medía a un clasificador con catorce herramientas de más —external_pull,
// external_push, list_external_ops, los seis estados financieros, el ledger,
// session_search, list_drafts, get_entity_status, search_customers— es decir,
// a un agente que no existe. Hoy importa la MISMA lista que la ingesta, no
// una copia: una superficie copiada diverge en el primer diff que la toque.
//
// La base es EFÍMERA (el mismo global-setup de la suite de integración:
// se crea, se migra, se siembra un inquilino, se destruye) — el eval jamás
// ensucia una base real y el dedupe por UUID no acumula entre corridas.
//
// Necesita: TEST_ADMIN_DATABASE_URL (rol con CREATE DATABASE) y la
// credencial del proveedor elegido (p. ej. ANTHROPIC_API_KEY).
//
// El resultado se puntúa POR CLASE (src/ai/eval/puntuacion.ts) y se anexa
// a docs/evals/clasificador.jsonl; la corrida se compara contra la
// anterior del mismo proveedor+modelo — «mejoró/empeoró» es un dato, no
// una impresión. Con --umbral, un global por debajo sale con código 4.
//
// …SIEMPRE QUE LAS DOS CORRIDAS SEAN COMPARABLES, que es la condición que
// este arnés daba por supuesta. Comparar exige que el muestreo esté fijado
// y que el modelo no se mueva bajo los pies; cada perfil declara si puede
// (src/ai/providers/config.ts · Reproducibilidad) y aquí se LEE. Cuando no
// puede, la corrida se registra igual, marcada `comparable: false`, y no se
// dibuja ninguna flecha: un ▲ sobre dos corridas irreproducibles afirma una
// mejora que nadie midió.
//
// Y SIEMPRE QUE ESTA CORRIDA HAYA MEDIDO. Ver «EL VEREDICTO», abajo.
// ============================================================

interface Args {
  provider?: string;
  model?: string;
  casos?: string[];
  umbral?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--casos') args.casos = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--umbral') args.umbral = Number(argv[++i]);
    else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(ExitCode.USAGE);
    }
  }
  if (args.umbral !== undefined && !(args.umbral >= 0 && args.umbral <= 1)) {
    console.error('--umbral debe estar entre 0 y 1');
    process.exit(ExitCode.USAGE);
  }
  return args;
}

const GOLDEN_DIR = path.resolve('tests/golden/cfdi');
const BITACORA = path.resolve('docs/evals/clasificador.jsonl');

// ============================================================
// NINGUNA CREDENCIAL SALE POR AQUÍ — Y EL REDACTOR TAMPOCO LA LLEVA.
//
// El arnés corre con una llave de proveedor de verdad (resolveProfile la lee
// de api_key_env o la saca de api_key_cmd), y todo lo que el proveedor falla
// vuelve como texto: el mensaje de error viaja al `detalle` del caso, se
// imprime, y en una corrida de CI queda en el registro para siempre. Un SDK
// que eche la petición en el mensaje basta para publicarla.
//
// La primera versión de esto guardaba la llave para hacer `split(llave)` —
// y así el propio redactor pasaba a ser portador del secreto: cualquiera que
// siga el flujo de datos (CodeQL lo hizo) ve la credencial entrar al
// sanitizador y salir hacia un `console.error`. Que la salida no la contenga
// es cierto, pero no es demostrable desde el flujo.
//
// Ahora se compara por HUELLA: se guarda el sha256 de cada credencial, no la
// credencial. Un token del texto se tacha cuando su huella coincide. El valor
// sensible no entra nunca al camino de la salida, la comparación exacta se
// conserva, y de paso siguen tachándose las formas de llave más comunes por
// si el mensaje trae una que este proceso no resolvió.
// ============================================================
const HUELLAS = new Set<string>();
const OCULTO = '«credencial oculta»';

// Clave efímera, nueva en cada proceso y que no se persiste en ninguna parte.
//
// Convierte la huella en un MAC: fuera de este proceso no significa nada, así
// que un volcado de memoria o un depurador no entrega algo contra lo que
// comparar por diccionario. Con sha256 a secas la huella era estable entre
// corridas y entre máquinas, y eso sí es material para un ataque fuera de línea.
const CLAVE_HUELLA = randomBytes(32);

/**
 * La huella con la que se compara, NO un hash de contraseña.
 *
 * CodeQL lo marca como `js/insufficient-password-hash`, que es la regla del
 * almacenamiento de contraseñas: ahí la respuesta correcta es bcrypt o scrypt,
 * porque el hash se guarda y alguien lo atacará fuera de línea. Aquí no se
 * guarda nada: es una comparación de igualdad en memoria para tachar la
 * credencial de un mensaje de error, y el valor muere con el proceso.
 *
 * Una función de derivación sería además lo contrario de correcta. `sinSecretos`
 * hashea CADA trozo del texto que tenga pinta de token —doce caracteres o más—
 * para compararlo; con scrypt, redactar un mensaje de error largo costaría
 * segundos, y el redactor está en el camino de todo lo que se imprime.
 *
 * Lo que sí faltaba era la clave, y eso es lo que se corrige aquí.
 */
function huella(valor: string): string {
  // `js/insufficient-password-hash` queda DESCARTADA como falso positivo en el
  // panel de seguridad (alerta #22), no silenciada aquí: el escaneo por
  // omisión de GitHub no honra los comentarios `// codeql[regla]`, así que uno
  // puesto aquí aparentaría una supresión que no ocurre — creerse protegido
  // por un no-op es peor que no tener nada.
  //
  // El motivo del descarte, comprobado y no argumentado: una KDF con sal
  // devuelve digests DISTINTOS para el mismo valor en cada llamada, y la única
  // propiedad que este redactor necesita es que coincidan. El remedio de la
  // regla no es indeseable aquí — es inaplicable.
  return createHmac('sha256', CLAVE_HUELLA).update(valor).digest('hex');
}

/** Registra una credencial por su huella. La credencial no se conserva. */
// Exportados para que su conducta se pueda probar: un redactor que sólo se
// comprueba leyendo su regex es un redactor sin prueba.
export function recordarSecreto(valor: string | undefined): void {
  if (valor && valor.length >= 8) HUELLAS.add(huella(valor));
}

export function sinSecretos(texto: string): string {
  const porPatron = texto
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, OCULTO)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${OCULTO}`);
  if (HUELLAS.size === 0) return porPatron;
  // Sólo los trozos con pinta de token se hashean: barrer cada palabra del
  // mensaje sería caro y no aportaría — una credencial no tiene 4 caracteres.
  // LA CLASE INCLUYE base64 CON RELLENO, y hasta hoy no. Era
  // `[A-Za-z0-9._-]`, que parte una llave con `+`, `/` o `=` en trozos: la
  // huella de un trozo no casa la del valor entero, así que la credencial
  // salía SIN TACHAR. Medido: una llave estilo OpenAI o Google se tachaba
  // entera, y una base64 con relleno —las de varios compatibles y las de
  // portador— no. Ensanchar no cuesta falsos positivos: lo que decide es el
  // HMAC, no el parecido, así que una ruta con barras se mira y se deja pasar.
  return porPatron.replace(/[A-Za-z0-9._~+/=-]{12,}/g, (t) => (HUELLAS.has(huella(t)) ? OCULTO : t));
}

const tasa = (m: { aciertos: number; total: number }): string =>
  m.total === 0 ? '—' : (m.aciertos / m.total).toFixed(3);

// ============================================================
// EL VEREDICTO — «MEDÍ Y SALIÓ MAL» NO ES «NO PUDE MEDIR».
//
// Este arnés salía con código 0 aunque el proveedor fallara el CIEN POR
// CIENTO de los casos. El único camino a un código distinto de 0 era el
// bloque de --umbral, y el paso de CI corre a propósito SIN --umbral: una
// ANTHROPIC_API_KEY caducada, un id de modelo repuntado o una caída del
// proveedor daban ocho clases en 0.000 y una casilla VERDE en el PR. Se
// comprobó ejecutándolo: `--provider ollama` con un modelo inexistente
// devolvió «Model failure: 404», global 0.000 y salida 0.
//
// La doctrina ya estaba escrita, en la cabecera de src/cli/kernel/exit.ts:
// «conflating "I found problems" with "I could not look" is how a green
// pipeline lies». Aquí se aplica con la tabla de códigos de ese archivo:
//
//   0  OK               midió el corpus entero y (con --umbral) da la talla
//   4  VALIDATION       MIDIÓ, y el clasificador está por debajo del umbral
//   8  EXTERNAL_FAILED  NO PUDO MEDIR: el proveedor falló. Reintentable
//   1  FAILURE          NO PUDO MEDIR por su culpa o la del corpus: un caso
//                       declara un panel que no se puede montar, el golden
//                       set está vacío, o no se puntuó nada. NO reintentable
//
// La precedencia está ordenada por lo que el operador tiene que hacer
// después: primero lo que hay que ARREGLAR (1), luego lo que se puede
// REINTENTAR (8), y sólo al final el juicio sobre el clasificador (4).
// Un cero por debajo de todo eso sería el verde comprado que esto cierra.
// ============================================================

export type ClaseDeNoMedido = 'proveedor' | 'precondicion';

export interface CasoNoMedido {
  caso: string;
  clase: ClaseDeNoMedido;
  motivo: string;
}

export interface Balance {
  /** Casos que el corpus entregó para esta corrida. */
  declarados: number;
  /** Casos que llegaron a puntuarse. */
  medidos: number;
  noMedidos: readonly CasoNoMedido[];
  umbral?: number;
  global: { aciertos: number; total: number };
}

/**
 * ¿Esta corrida es una LECTURA, o un montón de casillas a medio llenar?
 *
 * Se usa para dos cosas y las dos importan: decidir el código de salida y
 * decidir si la línea entra a la bitácora. Una corrida parcial escrita en el
 * archivo es peor que ninguna — la de mañana la compararía como si midiera lo
 * mismo, y la flecha diría del modelo lo que fue del proveedor.
 */
export function laCorridaMidio(b: Balance): boolean {
  return (
    b.declarados > 0 &&
    b.noMedidos.length === 0 &&
    b.medidos === b.declarados &&
    b.global.total > 0
  );
}

export function codigoDeSalida(b: Balance): ExitCodeValue {
  // Un corpus vacío puntúa 0 de 0 y eso es 100% de nada: el «ÉXITO SOBRE
  // CERO» que un filtro que no casa nada produce sin decir palabra.
  if (b.declarados === 0) return ExitCode.FAILURE;
  // El corpus declara un panel que este arnés no supo montar. No se arregla
  // reintentando: o el caso pide algo imposible, o el arnés perdió el modo
  // de montarlo. Puntuar bajo OTRO panel sería medir con una vara chueca.
  if (b.noMedidos.some((n) => n.clase === 'precondicion')) return ExitCode.FAILURE;
  // El proveedor no contestó. No es el clasificador: es que nadie miró.
  if (b.noMedidos.some((n) => n.clase === 'proveedor')) return ExitCode.EXTERNAL_FAILED;
  // Red de seguridad: un caso que se cayó del recuento sin motivo declarado
  // sigue siendo un caso sin medir, y la salida no puede fingir lo contrario.
  if (b.medidos !== b.declarados || b.global.total === 0) return ExitCode.FAILURE;
  if (b.umbral !== undefined && b.global.aciertos / b.global.total < b.umbral) {
    return ExitCode.VALIDATION;
  }
  return ExitCode.OK;
}

// ============================================================
// EL PANEL QUE EL CORPUS DECLARA, MONTADO ANTES DE MEDIR (A7·2).
//
// `capitaliza-equipo-computo` declara `umbral_capitalizacion_mxn: "5000"` y
// su gemelo `ask-equipo-computo` declara la MISMA clave en null («nadie la ha
// contestado»): mismo emisor, mismo importe, mismo concepto, y dos respuestas
// correctas distintas. El arnés no leía `precondicion` en absoluto, así que
// puntuaba los dos bajo el panel POR OMISIÓN (20000) — es decir, embarcaba en
// el corpus un caso que el clasificador no podía pasar, y la comparación
// «contra la corrida anterior» habría exhibido una regresión que no es del
// modelo.
//
// El plan sale de `politicasRequeridas` (src/ai/eval/golden.ts), que es de
// donde tiene que salir: el corpus sabe de qué panel depende cada caso, y un
// arnés que lo dedujera por su cuenta volvería a divergir del esperado.
// ============================================================

export type PasoDePanel =
  | { op: 'contestar'; clave: string; valor: string }
  | { op: 'dejar-sin-contestar'; clave: string };

/**
 * Traduce lo que el caso DECLARA a lo que hay que hacerle al panel.
 *
 * `dejar-sin-contestar` no es un no-op: el caso anterior pudo haber contestado
 * esa misma clave, y «sin contestar» es un estado que hay que GARANTIZAR.
 */
export function planDePanel(pares: ReadonlyArray<[string, string | null]>): PasoDePanel[] {
  return pares.map(([clave, valor]) =>
    valor === null
      ? ({ op: 'dejar-sin-contestar', clave } as const)
      : ({ op: 'contestar', clave, valor } as const)
  );
}

// ============================================================
// QUIÉN VE FALLAR AL PROVEEDOR.
//
// `ingestCfdiFiles` atrapa el fallo del modelo y lo devuelve como un resultado
// más: `status: 'error'` con el texto «Model failure: …». Visto desde ahí es
// indistinguible de una clasificación mala salvo por una subcadena, y juzgar
// por subcadenas es cómo el arnés acabó puntuando un 0.000 que no era del
// clasificador. Este envoltorio lo ve LANZAR, que es un hecho y no una
// conjetura, y de paso lleva la cuenta de turnos que separa «el modelo
// clasificó» de «la ruta determinista se lo comió antes».
//
// Vive fuera de main() y se exporta para que se pueda ejercitar sin base de
// datos: una sesión falsa que lanza, y la afirmación de que el fallo queda
// registrado. Un envoltorio que se traga el error o que no lo limpia entre
// casos no es un detalle — es el defecto entero, otra vez.
// ============================================================

export interface Vigilancia {
  /** La sesión que se le entrega a la ingesta. */
  session: LlmSession;
  /** Mensaje del fallo del proveedor en el caso EN CURSO, o null. */
  fallo: () => string | null;
  /** Empieza a mirar un caso nuevo: olvida el fallo y fija el contador. */
  nuevoCaso: () => void;
  /** ¿Llegó a llamarse al modelo en el caso en curso? */
  llamoAlModelo: () => boolean;
}

export function vigilarProveedor(base: LlmSession): Vigilancia {
  let fallo: string | null = null;
  let turnos = 0;
  let turnosAlEmpezar = 0;
  return {
    session: {
      get label() {
        return base.label;
      },
      runTurn: async (input, signal) => {
        turnos += 1;
        try {
          return await base.runTurn(input, signal);
        } catch (err) {
          // AQUÍ SE SEPARA «MEDÍ Y SALIÓ MAL» DE «NO PUDE MEDIR».
          fallo = (err as Error).message;
          throw err;
        }
      },
      reset: () => base.reset(),
    },
    fallo: () => fallo,
    nuevoCaso: () => {
      // Olvidar el fallo anterior no es higiene: sin esto, el primer caso que
      // falla deja a TODOS los siguientes marcados como no medidos.
      fallo = null;
      turnosAlEmpezar = turnos;
    },
    llamoAlModelo: () => turnos > turnosAlEmpezar,
  };
}

/**
 * «NO PUDE MEDIR» lanzado desde el montaje del instrumento — la sesión que no
 * abre, la credencial que el SDK rechaza antes del primer turno. Sale por 8
 * (EXTERNAL_FAILED) y no por 1: es reintentable, y decirlo ahorra el rato de
 * buscar un defecto en el repositorio que no está ahí.
 */
class NoPudeMedir extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoPudeMedir';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // La base efímera PRIMERO: los módulos de src leen DATABASE_URL al armar
  // el pool, así que todo import de src es dinámico y posterior al setup.
  const { setup, teardown } = await import('../tests/integration/global-setup.js');
  await setup();

  try {
    const { cargarCasosGolden, politicasRequeridas } = await import('../src/ai/eval/golden.js');
    const { puntuarCaso, agregarPuntuaciones } = await import('../src/ai/eval/puntuacion.js');
    const { crearInquilino } = await import('../tests/integration/helpers/tenant-fixture.js');
    const { resolveProfile, listProfiles, createLlmSession } = await import('../src/ai/providers/index.js');
    const { ingestCfdiFiles } = await import('../src/ai/ingest-service.js');
    const { seedPolicies, resolvePolicy, reopenPolicy } = await import(
      '../src/services/policy/policy-service.js'
    );
    const { query, closeDatabase } = await import('../src/database/connection.js');
    type ObservadoCaso = import('../src/ai/eval/puntuacion.js').ObservadoCaso;
    type LineaObservada = import('../src/ai/eval/puntuacion.js').LineaObservada;
    type DraftCapture = import('../src/ai/ingest-service.js').DraftCapture;

    const casos = cargarCasosGolden(GOLDEN_DIR, args.casos);
    console.log(`\neval-clasificador · ${casos.length} caso(s) del golden set`);

    const f = await crearInquilino('Eval clasificador');
    const ctx = {
      entityId: f.entityId,
      entityName: 'Eval clasificador',
      tenantId: f.tenantId,
      currency: 'MXN',
      country: 'MX',
      accountingStandard: 'mx_nif',
      taxId: 'XAXX010101000',
    };

    // Las cuentas que el esperado cita deben existir en el catálogo sembrado:
    // si el fixture cambia, que el eval lo diga aquí y no como fallo del modelo.
    const citadas = [...new Set(casos.flatMap((c) => c.esperado.asiento ?? []).flatMap((l) => l.cuenta))];
    if (citadas.length > 0) {
      const existentes = await query<{ code: string }>(
        `SELECT code FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
        [f.entityId, citadas]
      );
      const faltan = citadas.filter((c) => !existentes.rows.some((r) => r.code === c));
      if (faltan.length > 0) {
        throw new Error(
          `El catálogo sembrado no tiene las cuentas que el golden espera: ${faltan.join(', ')}`
        );
      }
    }

    // Proveedor FIJADO: sesión directa, sin failover, grounding apagado.
    // LA IDENTIDAD DEL PERFIL NO SALE DEL OBJETO QUE LLEVA LA CREDENCIAL.
    //
    // `resolveProfile` hace `process.env[profile.api_key_env]` y devuelve la
    // llave en el MISMO objeto que el nombre y el modelo. Copiar `profile.name`
    // al registro metía en la bitácora un valor que el análisis considera
    // derivado de la credencial — y tiene razón sobre la forma: ese archivo se
    // relee y se imprime. Pasarlo por `sinSecretos()` no basta, porque es un
    // filtro propio que ningún analizador reconoce como saneador: el flujo
    // seguía ahí.
    //
    // `listProfiles` resuelve el mismo nombre y el mismo modelo SIN leer
    // ninguna credencial. No es una anotación para callar la alerta: es que el
    // registro deja de tocar el objeto que la lleva.
    const { profiles: perfilesDeclarados, defaultName } = listProfiles();
    const nombrePerfil = args.provider || defaultName;

    // ── EL MUESTREO Y LA INSTANTÁNEA (lo que hace comparables dos corridas) ──
    //
    // Este arnés compara cada corrida contra la anterior del mismo
    // proveedor+modelo. Esa comparación presupone que entre las dos sólo cambió
    // el clasificador; si el muestreo no está fijado, lo que cambió también pudo
    // ser el azar, y la flecha mide ruido. El perfil declara su postura
    // (src/ai/providers/config.ts) y aquí se LEE: no se supone, no se finge.
    const { reproducibilidadDe, MUESTREO_CABLEADO } = await import(
      '../src/ai/providers/config.js'
    );
    const repro = reproducibilidadDe(nombrePerfil);
    // La instantánea fechada manda sobre el alias —pedir el mismo modelo en cada
    // corrida es media reproducibilidad—, salvo que el operador pase --model.
    const modeloPedido = args.model || repro?.instantanea || undefined;
    const modeloPerfil =
      modeloPedido || perfilesDeclarados[nombrePerfil]?.model || '(sin modelo declarado)';
    // EL REDACTOR SE ARMA ANTES DE QUE ALGO PUEDA ROMPERSE, no después.
    //
    // `recordarSecreto(profile.apiKey)` iba DESPUÉS de `resolveProfile`, y ésa
    // es la llamada que lee `process.env[profile.api_key_env]`. Si reventaba
    // con la llave dentro del mensaje —una URL mal formada, una validación del
    // proveedor que cita el valor— el catch de la entrada la imprimía con la
    // única defensa que quedaba armada: el patrón `sk-`/`Bearer`. Una llave de
    // Google, de Azure o de un compatible no lleva ese prefijo y salía entera
    // al registro de CI. CodeQL lo marcó por la ruta correcta (alerta #24) y
    // tenía razón sobre la ventana, aunque no pueda ver el redactor.
    //
    // Se registran TODAS las que los perfiles declaran, no la de esta corrida:
    // la que se filtre en un mensaje puede ser la de un perfil que ni se pidió
    // —el failover, un mensaje de configuración que las enumera— y tacharlas
    // todas cuesta un HMAC por variable de entorno.
    for (const p of Object.values(perfilesDeclarados)) {
      const nombreDeVariable = (p as { api_key_env?: string }).api_key_env;
      if (nombreDeVariable) recordarSecreto(process.env[nombreDeVariable]);
    }
    const profile = resolveProfile(args.provider, modeloPedido);
    // Y la de ESTA corrida, que puede venir de `api_key_cmd` y no de una
    // variable: el bucle de arriba no la habría visto.
    recordarSecreto(profile.apiKey);
    const capture: DraftCapture = { drafts: [] };
    let base: LlmSession;
    try {
      base = await createLlmSession(
        profile,
        ctx,
        { onDraftCreated: (info) => capture.drafts.push(info) },
        {
          grounding: { enabled: false },
          // LA MISMA SUPERFICIE QUE LA INGESTA, IMPORTADA Y NO COPIADA.
          //
          // Sin esta línea buildTools devuelve las 25 herramientas y el arnés
          // mide a un agente que nadie embarca: la hoja de `mnemosine ingest`
          // (src/cli/mnemosine.ts) pasa esta MISMA constante. Copiar la lista
          // aquí sería el defecto de vuelta con otra forma — divergiría en el
          // primer diff que toque una de las dos.
          herramientas: SUPERFICIE_INGESTA,
        }
      );
    } catch (err) {
      throw new NoPudeMedir(
        `la sesión con «${nombrePerfil}» no se pudo abrir: ${(err as Error).message}`
      );
    }
    const vigilancia = vigilarProveedor(base);
    const session = vigilancia.session;
    console.log(`proveedor fijado: ${session.label}`);

    // ── LO QUE ESTA CORRIDA PUEDE Y NO PUEDE PROMETER, DICHO ANTES DE MEDIR ──
    //
    // Dos condiciones, y las dos tienen que cumplirse para que comparar esta
    // corrida con otra signifique algo:
    //
    //  1. que el PERFIL admita fijar el muestreo (lo declara él), y
    //  2. que el muestreo declarado VIAJE de verdad en la petición.
    //
    // La segunda hoy es `false` y no se disimula: los constructores de petición
    // (src/ai/agent.ts, src/ai/providers/openai-compat.ts) arman el cuerpo sin
    // `temperature`. Un arnés que callara esto imprimiría flechas de tendencia
    // sobre ruido de muestreo, que es exactamente la clase de verde comprado
    // que kernel/exit.ts denuncia en su cabecera.
    const comparable = repro?.muestreo === 'fijado' && MUESTREO_CABLEADO;
    if (!repro) {
      console.log(
        `muestreo: SIN DECLARAR — «${nombrePerfil}» no es un perfil de fábrica, así que nadie ` +
          'ha establecido si su muestreo se puede fijar. Esta corrida no se comparará con ninguna.'
      );
    } else if (repro.muestreo === 'no-admite') {
      console.log(`muestreo: NO SE PUEDE FIJAR — ${repro.razon}`);
    } else if (!MUESTREO_CABLEADO) {
      console.log(
        `muestreo: declarado temperature ${repro.temperature} pero AÚN NO CABLEADO — el perfil lo ` +
          'admite y la petición todavía no lo envía (agent.ts / openai-compat.ts arman el cuerpo ' +
          'sin él). Hasta que se cablee, esta corrida tampoco es reproducible.'
      );
    } else {
      console.log(`muestreo: fijado en temperature ${repro.temperature}`);
    }
    console.log(
      `instantánea: ${repro?.instantanea ?? 'ninguna fijada — el alias del modelo puede repuntarse bajo los pies'}`
    );
    if (!comparable) {
      console.error(
        '\nAVISO: esta corrida NO es reproducible. El número que salga es válido para HOY y para ' +
          'este proceso; no es una lectura que se pueda contrastar contra otra corrida.'
      );
    }
    console.log('');

    const thresholds = { autoPost: false, minConfidence: 0.95, maxAmount: 10000 };
    const reviewer = { userId: f.userId, email: 'eval@mnemosine.local' };

    // ── EL PANEL DEL DESPACHO, EN EL MISMO ALCANCE QUE LO LEE LA INGESTA ──
    //
    // pre-registration-service resuelve las políticas con
    // {tenantId, entityId}: sembrar y contestar en cualquier otro alcance
    // dejaría al clasificador leyendo el panel por omisión igual que antes.
    const panelCtx = { tenantId: f.tenantId, entityId: f.entityId };

    const yaContestada = async (clave: string): Promise<boolean> => {
      const r = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM policy_decisions
          WHERE tenant_id = $1 AND entity_id = $2 AND key = $3 AND status <> 'pending'`,
        [f.tenantId, f.entityId, clave]
      );
      return r.rows[0].n !== '0';
    };

    const montarPanel = async (plan: PasoDePanel[]): Promise<void> => {
      if (plan.length === 0) return;
      // Idempotente: crea las filas que falten y no revive ninguna resuelta.
      await seedPolicies(panelCtx);
      for (const paso of plan) {
        // Se reabre SIEMPRE primero, también para 'dejar-sin-contestar': el caso
        // anterior pudo contestar esta misma clave, y «sin contestar» es un
        // estado que hay que garantizar, no suponer. (`reopenPolicy` acota por
        // inquilino y no por entidad; aquí da igual porque el inquilino es
        // efímero y sólo existen las filas de esta entidad, pero conviene saber
        // que el día que el arnés siembre a nivel de inquilino habrá que mirarlo.)
        if (await yaContestada(paso.clave)) await reopenPolicy(panelCtx, paso.clave);
        if (paso.op === 'contestar') {
          await resolvePolicy(
            panelCtx,
            paso.clave,
            paso.valor,
            reviewer.email,
            'panel declarado por el golden set (precondicion del caso)'
          );
        }
      }
    };

    // Devolver el panel a como estaba: pendiente, que es el estado en que el
    // fixture entrega un inquilino nuevo. Sin esto, el caso que contesta una
    // clave se la deja contestada al SIGUIENTE, y su gemelo «sin contestar»
    // mediría bajo un panel que nadie declaró.
    const desmontarPanel = async (plan: PasoDePanel[]): Promise<void> => {
      for (const paso of plan) {
        if (paso.op !== 'contestar') continue;
        if (await yaContestada(paso.clave)) await reopenPolicy(panelCtx, paso.clave);
      }
    };

    const puntuaciones = [];
    const noMedidos: CasoNoMedido[] = [];
    for (const caso of casos) {
      const plan = planDePanel(politicasRequeridas(caso));
      if (plan.length > 0) {
        console.log(
          `  panel de ${caso.nombre}: ` +
            plan
              .map((p) => (p.op === 'contestar' ? `${p.clave} = ${p.valor}` : `${p.clave} SIN CONTESTAR`))
              .join(' · ')
        );
      }
      // EL MONTAJE VA DENTRO DEL try QUE TIENE EL finally. Un montaje que
      // revienta a mitad —dos claves declaradas, la segunda rechazada— deja la
      // primera contestada, y el caso siguiente mediría bajo un panel que nadie
      // declaró. Aquí el `continue` de abajo también pasa por el desmontaje.
      try {
        try {
          await montarPanel(plan);
        } catch (err) {
          // NO SE PUNTÚA. Medir este caso ahora sería medirlo bajo un panel
          // distinto del que declara, que es exactamente la vara chueca que
          // `precondicion` vino a evitar.
          noMedidos.push({ caso: caso.nombre, clase: 'precondicion', motivo: (err as Error).message });
          console.log(sinSecretos(`✗ ${caso.nombre} → NO MEDIDO (no pude montar el panel que declara)`));
          continue;
        }

        vigilancia.nuevoCaso();
        const report = await ingestCfdiFiles({
          ctx, reviewer, files: [caso.xmlPath], thresholds, session, capture,
        });
        const r = report.results[0];
        const fallo = vigilancia.fallo();
        if (fallo !== null) {
          // NO SE PUNTÚA. Un 0.000 de un caso que el proveedor nunca contestó
          // no es una lectura del clasificador: es que nadie miró.
          noMedidos.push({ caso: caso.nombre, clase: 'proveedor', motivo: fallo });
          console.log(sinSecretos(`✗ ${caso.nombre} → NO MEDIDO (el proveedor falló)`));
          continue;
        }
        const clasificoElModelo = vigilancia.llamoAlModelo();

        let observado: ObservadoCaso;
        if (!clasificoElModelo) {
          observado = { resultado: 'determinista', detalle: r.detail };
        } else if (r.status === 'draft' && r.draftId) {
          const fila = await query<{ payload: unknown; ai_confidence: string }>(
            `SELECT payload, ai_confidence FROM ai_drafts WHERE id = $1`,
            [r.draftId]
          );
          const payload = fila.rows[0].payload as {
            lines: { account_code: string; debit?: string | null; credit?: string | null }[];
          };
          const lineas: LineaObservada[] = payload.lines.map((l) => ({
            cuenta: l.account_code,
            lado: l.debit != null && Number(l.debit) > 0 ? 'cargo' : 'abono',
            monto: String(l.debit != null && Number(l.debit) > 0 ? l.debit : l.credit),
          }));
          observado = {
            resultado: 'draft',
            lineas,
            confianza: Number(fila.rows[0].ai_confidence),
            sospecha: (r.sospechas?.length ?? 0) > 0,
            detalle: r.detail,
          };
        } else if (r.status === 'blocked') {
          observado = { resultado: 'pregunta', sospecha: (r.sospechas?.length ?? 0) > 0, detalle: r.detail };
        } else {
          observado = { resultado: 'error', detalle: `${r.status}: ${r.detail ?? ''}` };
        }

        const p = puntuarCaso(caso.esperado, observado);
        puntuaciones.push(p);
        const icono = p.fallas.length === 0 ? '✓' : '✗';
        console.log(sinSecretos(`${icono} ${caso.nombre} → ${observado.resultado}` +
          (observado.confianza !== undefined ? ` (confianza ${observado.confianza.toFixed(2)})` : '')));
        for (const falla of p.fallas) console.log(sinSecretos(`    · ${falla}`));
      } finally {
        await desmontarPanel(plan);
      }
    }

    const agregado = agregarPuntuaciones(puntuaciones);
    const balance: Balance = {
      declarados: casos.length,
      medidos: puntuaciones.length,
      noMedidos,
      umbral: args.umbral,
      global: agregado.global,
    };

    console.log('\nExactitud por clase:');
    for (const [clase, m] of Object.entries(agregado.clases)) {
      console.log(`  ${clase.padEnd(12)} ${tasa(m)}  (${m.aciertos}/${m.total})`);
    }
    console.log(`  ${'global'.padEnd(12)} ${tasa(agregado.global)}  (${agregado.global.aciertos}/${agregado.global.total})`);
    if (agregado.confianzaEnAciertos !== null || agregado.confianzaEnFallas !== null) {
      console.log(
        `  calibración: confianza media ${agregado.confianzaEnAciertos?.toFixed(2) ?? '—'} en casos ` +
          `limpios vs ${agregado.confianzaEnFallas?.toFixed(2) ?? '—'} en casos con fallas`
      );
    }

    if (noMedidos.length > 0) {
      console.error(`\nNO MEDIDOS — ${noMedidos.length} de ${casos.length} caso(s):`);
      for (const n of noMedidos) {
        const que = n.clase === 'proveedor' ? 'el proveedor falló' : 'no se pudo montar su panel';
        console.error(sinSecretos(`  · ${n.caso} — ${que}: ${n.motivo}`));
      }
      console.error(
        '  Las clases de arriba se calcularon SOBRE LOS DEMÁS. Un 0.000 de un caso no medido no ' +
          'sería del clasificador: sería de que nadie miró.'
      );
    }

    // Bitácora y comparación contra la corrida anterior del mismo proveedor+modelo.
    //
    // LA LÍNEA LLEVA LAS CONDICIONES EN QUE SE MIDIÓ, NO SÓLO EL NÚMERO.
    //
    // Una bitácora que sólo guarda proveedor+modelo+exactitud no puede decidir
    // si dos de sus líneas son comparables, y compararlas igual es lo que hacía
    // antes. Con el muestreo escrito en la línea, la corrida de mañana sabe si
    // la de hoy medía lo mismo — y las corridas viejas (sin estos campos) se
    // quedan fuera de la comparación en vez de contaminarla.
    const registro = {
      fecha: new Date().toISOString(),
      provider: nombrePerfil,
      model: modeloPerfil,
      casos: casos.length,
      muestreo: repro?.muestreo ?? 'sin-declarar',
      temperature: repro?.temperature ?? null,
      instantanea: repro?.instantanea ?? null,
      cableado: MUESTREO_CABLEADO,
      comparable,
      clases: agregado.clases,
      global: agregado.global,
    };

    if (!laCorridaMidio(balance)) {
      // NI UNA LÍNEA. La bitácora es la memoria del «mejoró/empeoró»; una
      // corrida a medias escrita ahí es un número que la de mañana leería como
      // una lectura completa, y la flecha diría del modelo lo que fue del
      // proveedor. No medir se dice, no se archiva.
      console.error(
        '\nSIN BITÁCORA: esta corrida no midió el corpus completo, así que no deja línea. Un ' +
          'archivo que existe para comparar no puede guardar medias lecturas.'
      );
    } else {
      let anterior: typeof registro | undefined;
      // Sólo se busca antecedente si ESTA corrida es comparable: si no lo es, no
      // hay nada contra lo que contrastarla y buscarlo sería preparar la flecha.
      if (comparable && fs.existsSync(BITACORA)) {
        const lineas = fs.readFileSync(BITACORA, 'utf-8').trim().split('\n').filter(Boolean);
        for (let i = lineas.length - 1; i >= 0; i--) {
          const l = JSON.parse(lineas[i]) as Partial<typeof registro>;
          if (
            l.provider === registro.provider &&
            l.model === registro.model &&
            // El mismo NÚMERO de casos, o el global compara dos corpus distintos.
            l.casos === registro.casos &&
            // Las mismas condiciones de medición, o no es la misma vara.
            l.comparable === true &&
            l.muestreo === registro.muestreo &&
            l.temperature === registro.temperature &&
            l.instantanea === registro.instantanea
          ) {
            anterior = l as typeof registro;
            break;
          }
        }
      }
      fs.mkdirSync(path.dirname(BITACORA), { recursive: true });
      // La bitácora pasa por el mismo filtro que la salida por pantalla.
      //
      // Hoy `registro` sólo copia el nombre y el modelo del perfil, así que no
      // hay clave que ocultar — pero eso es INCIDENTAL: depende de que nadie
      // añada un campo más adelante, y el perfil del que se copia sí lleva la
      // credencial. Un archivo que se relee y se imprime no puede depender de
      // la disciplina de quien edite el objeto.
      fs.appendFileSync(BITACORA, sinSecretos(JSON.stringify(registro)) + '\n');

      if (!comparable) {
        // NI UNA FLECHA. Un ▲ dice «mejoró», y sin muestreo fijado eso es una
        // afirmación que esta corrida no puede sostener: el mismo caso, el mismo
        // perfil y el mismo modelo ya devolvieron confianzas distintas entre dos
        // corridas seguidas. Se guarda la lectura, no se le dibuja tendencia.
        console.log(
          '\nSin comparación: esta corrida no es reproducible, y una flecha sobre dos corridas ' +
            'irreproducibles afirma una mejora que nadie midió. La línea queda en la bitácora ' +
            'marcada `comparable: false`, y no entrará en ninguna comparación futura.'
        );
      } else if (anterior) {
        console.log(`\nContra la corrida anterior (${anterior.fecha}, mismas condiciones):`);
        for (const [clase, m] of Object.entries(agregado.clases)) {
          const prev = anterior.clases[clase as keyof typeof anterior.clases];
          if (!prev || prev.total === 0 || m.total === 0) continue;
          const delta = m.aciertos / m.total - prev.aciertos / prev.total;
          const signo = delta > 0.0005 ? '▲' : delta < -0.0005 ? '▼' : '=';
          console.log(`  ${clase.padEnd(12)} ${signo} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`);
        }
      } else {
        console.log('\n(primera corrida comparable registrada para este proveedor+modelo)');
      }
    }

    await closeDatabase();

    // EL ÚNICO SITIO DONDE ESTE PROCESO DECIDE SU CÓDIGO DE SALIDA.
    process.exitCode = codigoDeSalida(balance);
    if (process.exitCode !== ExitCode.OK) {
      const global = agregado.global.total > 0 ? tasa(agregado.global) : '—';
      const porque =
        casos.length === 0
          ? 'NO PUDE MEDIR: el golden set no entregó ni un caso. Cero de cero es 100% de nada.'
          : noMedidos.some((n) => n.clase === 'precondicion')
            ? 'NO PUDE MEDIR: un caso declara un panel que este arnés no pudo montar. Arréglalo; ' +
              'reintentar no cambia nada.'
            : noMedidos.length > 0
              ? `NO PUDE MEDIR: el proveedor falló en ${noMedidos.length} de ${casos.length} caso(s). ` +
                'Esto es reintentable, y NO es una lectura del clasificador.'
              : agregado.global.total === 0
                ? 'NO PUDE MEDIR: no se puntuó ni una clase.'
                : `MEDÍ, Y NO DA LA TALLA: global ${global} < umbral ${args.umbral}.`;
      console.error(sinSecretos(`\nsalida ${process.exitCode} · ${porque}`));
    }
  } finally {
    await teardown();
  }
}

/**
 * ¿Este proceso ES el arnés, o alguien lo IMPORTÓ?
 *
 * `main()` monta una base de datos efímera; ejecutarlo por el mero hecho de
 * importar el módulo haría imposible probar desde una prueba unitaria las
 * funciones puras que deciden el código de salida — y esas son justo las que
 * hay que probar, porque su defecto era salir en verde sin haber medido.
 *
 * La otra mitad del riesgo es que esta guarda deje de casar y `npm run eval`
 * se vuelva un no-op silencioso: el arnés más verde de todos. Por eso
 * `arnes-cableado.spec.ts` LANZA el guion como programa y comprueba que
 * responde — que no es lo mismo que comprobar que el archivo existe.
 */
function invocadoComoPrograma(): boolean {
  return /(^|[\\/])eval-clasificador\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
}

if (invocadoComoPrograma()) {
  main().catch((err) => {
    console.error(sinSecretos(`\neval-clasificador: ${(err as Error).message}`));
    // «No pude medir» por el instrumento (8, reintentable) contra «me rompí»
    // (1). Ninguno de los dos es 0, que es lo que este arnés hacía antes.
    process.exit(err instanceof NoPudeMedir ? ExitCode.EXTERNAL_FAILED : ExitCode.FAILURE);
  });
}
