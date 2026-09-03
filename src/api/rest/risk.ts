import type { Express, RequestHandler, Router } from 'express';
import { bajoLlaveDeIdempotencia, LARGO_MAX_ALCANCE } from './middleware/idempotencia.js';

// ============================================================
// REGISTRO DE RIESGO DE RUTAS — el gemelo de cli/kernel/risk.ts
//
// El binario declara. Cada hoja de `mnemosine` dice de qué clase es
// —lectura, escritura, irreversible, externo— y esa declaración decide,
// entre otras cosas, si el agente puede invocarla. Un comando que
// declare a la vez «irreversible» y «accesible al agente» no arranca:
// `declareRisk` lanza al registrarse, antes de que exista una sola
// entrada de usuario.
//
// La API no declaraba NADA. 87 rutas de escritura repartidas en 17
// archivos, y ni una palabra sobre lo que hace cada una. La consecuencia
// no era hipotética: hasta G3 una de ellas posteaba al mayor saltándose
// el control de cuatro ojos que el CLI declaraba no exponer. Mientras un
// motor declare y el otro no, hay dos motores, y el que manda es el de
// menos reglas.
//
// Este módulo traduce el mecanismo del CLI a Express con las MISMAS
// prohibiciones y el MISMO argumento. Dos diferencias, ambas forzadas
// por el medio:
//
//   1. Commander tiene un objeto `Command` por hoja al que colgar la
//      declaración. Express no: tiene una cadena de manejadores. Así que
//      la declaración ES un manejador, el PRIMERO de la ruta, y viaja
//      dentro de lo que Express registra. No hay lista al lado del
//      código que pueda desincronizarse — el censo lee la pila real.
//
//   2. El CLI falla al construir el programa porque construir el
//      programa es registrar los comandos. Montar un router de Express
//      no comprueba nada, así que el equivalente hay que llamarlo:
//      `auditarRiesgoDeRutas(app)` corre en el arranque (src/index.ts),
//      después de montar y antes de escuchar. Un censo que sólo avisa es
//      un censo que nadie mira; éste lanza.
// ============================================================

/**
 * Las cuatro clases, con el vocabulario EXACTO del CLI
 * (src/cli/kernel/risk.ts). Que sean las mismas cuatro palabras no es
 * estética: una ruta y el comando que hace lo mismo tienen que poder
 * compararse sin traducir.
 */
export type RiesgoRuta =
  /** Sólo lee. No cambia ninguna fila en ninguna parte. */
  | 'lectura'
  /** Escribe algo reversible: un borrador, un dato maestro, una configuración. */
  | 'escritura'
  /** Postea al mayor, borra, o de otro modo no se deshace repitiéndolo. */
  | 'irreversible'
  /** Tiene efecto fuera de este sistema: un PAC, el SAT, un banco, un correo. */
  | 'externo';

export interface DeclaracionRuta {
  riesgo: RiesgoRuta;
  /**
   * Cierto sólo cuando el agente LLM puede llamar esta ruta por su cuenta.
   * Permitido siempre en `lectura`, y en `escritura` únicamente junto a
   * `soloBorrador`, porque la única garantía sobre la que se sostiene el
   * diseño del agente es que él propone y una persona dispone.
   */
  agente?: boolean;
  /**
   * Obligatorio junto a `agente` en una ruta de `escritura`: afirma que
   * todo lo que esta ruta escribe cae en una cola de revisión
   * (ai_drafts / ai_questions / ai_external_ops) y nunca en el mayor.
   */
  soloBorrador?: boolean;
  /** Resumen legible de lo que escribe, para el rastro de auditoría. */
  escribe?: string;
}

export interface RiesgoResueltoRuta extends DeclaracionRuta {
  /** Respuesta final y exigible a «¿puede llamarla el agente?». */
  agentePermitido: boolean;
  /** Lo irreversible y lo externo tienen que poder enseñar su efecto antes. */
  exigeMarchaSeca: boolean;
  /** El efecto externo es opt-in: por omisión se habla con el ambiente de pruebas. */
  exigeCompuertaEnVivo: boolean;
  /** Una mutación de este nivel viaja con llave de deduplicación del cliente. */
  exigeLlaveDeIdempotencia: boolean;
}

/**
 * La marca va en el propio manejador, no en un mapa aparte indexado por
 * ruta: un mapa por ruta es otra vez una lista paralela, y una ruta
 * renombrada la deja mintiendo en silencio. Colgada del manejador, la
 * declaración no puede separarse de lo que declara.
 */
const MARCA = Symbol('riesgo-de-ruta');

type ManejadorMarcado = RequestHandler & { [MARCA]?: RiesgoResueltoRuta };

/** Los verbos que, por definición, cambian algo y por tanto deben declarar. */
export const VERBOS_QUE_MUTAN: readonly string[] = ['post', 'put', 'patch', 'delete'];

/**
 * Declara la clase de una ruta y devuelve el manejador que la lleva.
 * Se pone el PRIMERO en la cadena de la ruta —y no por estilo: el
 * manejador HACE cosas (res.locals, la llave de idempotencia), así que
 * detrás del que responde no llega a correr. `auditarRiesgoDeRutas` lo
 * exige y rompe el arranque si no se cumple.
 *
 * Lanza al declarar —o sea al importar el archivo de rutas, que en esta
 * API es tiempo de arranque— cuando la declaración es imposible.
 */
export function declararRiesgoRuta(decl: DeclaracionRuta): RequestHandler {
  const { riesgo, agente = false, soloBorrador = false } = decl;

  // Las dos prohibiciones son las del CLI, palabra por palabra, porque el
  // argumento es el mismo: el permiso del agente no puede depender de con
  // qué se llamó a la cosa. En el CLI eso era «del valor de una bandera»;
  // aquí es «del cuerpo de la petición», que es peor, porque el cuerpo lo
  // escribe quien llama. Una ruta cuya mitad es segura se PARTE en dos
  // rutas con dos declaraciones.
  if (agente && (riesgo === 'irreversible' || riesgo === 'externo')) {
    throw new Error(
      `Una ruta declara riesgo "${riesgo}" y acceso del agente a la vez. ` +
        'El agente no postea al mayor, no mueve dinero, no timbra, no cancela, no presenta ' +
        'ante una autoridad, no borra y no alcanza a un tercero con una credencial del ' +
        'cliente. Si una parte de esta ruta es genuinamente segura, pártela en dos rutas con ' +
        'dos declaraciones — el permiso no puede depender del contenido de la petición.'
    );
  }
  if (agente && riesgo === 'escritura' && !soloBorrador) {
    throw new Error(
      'Una ruta le concede al agente una escritura sin afirmar soloBorrador. ' +
        'Una escritura invocable por el agente cae en una cola de revisión, no en el mayor. ' +
        'Pon soloBorrador: true si eso es cierto en TODOS los caminos de la ruta; si no, agente: false.'
    );
  }
  // `soloBorrador` sin `agente` no es un error, pero tampoco significa nada:
  // es la afirmación que habilita al agente, y sin agente no habilita a
  // nadie. Se rechaza para que nadie la lea como una garantía que el código
  // no comprueba en ninguna parte.
  if (soloBorrador && !agente) {
    throw new Error(
      'Una ruta afirma soloBorrador sin declarar agente. soloBorrador existe para habilitar al ' +
        'agente sobre una escritura; sin agente no hay nada que habilitar y la afirmación queda ' +
        'como una garantía que nadie comprueba. Quítala, o declara agente: true.'
    );
  }

  const resuelto: RiesgoResueltoRuta = {
    ...decl,
    agente,
    soloBorrador,
    agentePermitido: agente,
    exigeMarchaSeca: riesgo === 'irreversible' || riesgo === 'externo',
    exigeCompuertaEnVivo: riesgo === 'externo',
    exigeLlaveDeIdempotencia: riesgo === 'irreversible' || riesgo === 'externo',
  };

  // LA DECLARACIÓN NO SÓLO DICE: HACE.
  //
  // El manejador deja la clase resuelta en `res.locals` —de ahí la toma el
  // renglón de auditoría— y, cuando la clase lo exige, aplica la llave de
  // idempotencia. Eso segundo es deliberado: `exigeLlaveDeIdempotencia` es
  // cierto para `irreversible` y `externo`, o sea para las rutas que no se
  // deshacen si se repiten, y montar la guarda a mano en cada una habría
  // sido otra lista paralela que se olvida en la ruta número 37. Declarar
  // la clase ES obtener la llave.
  //
  // Sin cabecera `Idempotency-Key` el guardián cede el paso sin tocar la
  // base: el coste de esto en una petición que no la manda es una
  // comparación.
  const guardia = resuelto.exigeLlaveDeIdempotencia ? bajoLlaveDeIdempotencia() : undefined;
  const marcador: ManejadorMarcado = (req, res, next) => {
    res.locals.riesgoDeLaRuta = resuelto;
    if (guardia) {
      guardia(req, res, next);
      return;
    }
    next();
  };
  marcador[MARCA] = resuelto;
  return marcador;
}

/** La declaración que lleva un manejador, si la lleva. */
export function riesgoDeManejador(h: unknown): RiesgoResueltoRuta | undefined {
  return typeof h === 'function' ? (h as ManejadorMarcado)[MARCA] : undefined;
}

export interface RutaCensada {
  /** Verbo en minúsculas: 'get', 'post', … */
  metodo: string;
  /** Prefijo de montaje + ruta propia, reconstruido al recorrer. */
  ruta: string;
  /** La declaración, si la ruta declaró. */
  riesgo?: RiesgoResueltoRuta;
  /**
   * DÓNDE está la declaración en la cadena de la ruta. -1 si no hay.
   *
   * Se guarda porque «declarada» y «declarada donde la declaración actúa»
   * no son lo mismo, y sólo lo segundo protege: ver `auditarRiesgoDeRutas`.
   */
  posicionDeclaracion: number;
  /** Cuántos manejadores de la cadena llevan declaración. */
  declaraciones: number;
}

// ============================================================
// EL CENSO ES DERIVADO.
//
// Se recorre la pila REAL de Express: `stack → layer.route → route.stack`.
// De ahí salen exactos el método, la ruta propia y el manejador marcado —
// que es lo único que la comprobación necesita. Lo ÚNICO que hay que
// reconstruir es el prefijo de montaje, porque Express 4 no lo guarda: lo
// compila a la expresión regular de la capa y tira la cadena.
//
// Para los montajes de esta API —todos literales: '/v1/accounts',
// '/v1/admin/blockchain'— la reconstrucción es exacta. Un montaje con
// parámetro ('/v1/:algo') no lo sería, y por eso `prefijoDeCapa` devuelve
// un marcador visible en vez de adivinar: si algún día aparece uno, el
// censo lo enseña en vez de imprimir una ruta falsa. Nada de eso afecta a
// la comprobación, que no mira la ruta: mira el verbo y la declaración.
//
// La alternativa, si Express dejara de exponer `_router`, es envolver
// `Router()` y quedarse con lo que se registra. Es más invasivo y hoy no
// hace falta.
// ============================================================

const PREFIJO_NO_LITERAL = '(prefijo no literal)';

function prefijoDeCapa(capa: { regexp?: RegExp; keys?: unknown[] }): string {
  if (!capa.regexp) return '';
  if (Array.isArray(capa.keys) && capa.keys.length > 0) return PREFIJO_NO_LITERAL;
  const fuente = capa.regexp.source;
  // La forma que Express 4 genera para `app.use('/v1/xml', r)`:
  //   ^\/v1\/xml\/?(?=\/|$)
  if (fuente === '^\\/?(?=\\/|$)') return ''; // montaje en la raíz
  const m = /^\^((?:\\\/[^\\^$*+?()[\]{}|]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(fuente);
  return m ? m[1].replace(/\\\//g, '/') : PREFIJO_NO_LITERAL;
}

interface CapaExpress {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
  regexp?: RegExp;
  keys?: unknown[];
  handle?: { stack?: CapaExpress[] };
}

function recorrer(pila: CapaExpress[], prefijo: string, salida: RutaCensada[]): void {
  for (const capa of pila) {
    if (capa.route) {
      const rutas = Array.isArray(capa.route.path) ? capa.route.path : [capa.route.path];
      const enCadena = capa.route.stack.map((h) => riesgoDeManejador(h.handle));
      const posicion = enCadena.findIndex((r) => r !== undefined);
      const cuantas = enCadena.filter((r) => r !== undefined).length;
      const declarado = posicion === -1 ? undefined : enCadena[posicion];
      for (const metodo of Object.keys(capa.route.methods)) {
        // Express registra `_all` junto a los verbos reales; no es un verbo.
        if (metodo === '_all') continue;
        for (const p of rutas) {
          salida.push({
            metodo,
            ruta: `${prefijo}${p === '/' ? '' : p}` || '/',
            riesgo: declarado,
            posicionDeclaracion: posicion,
            declaraciones: cuantas,
          });
        }
      }
    } else if (capa.handle?.stack) {
      recorrer(capa.handle.stack, prefijo + prefijoDeCapa(capa), salida);
    }
  }
}

/** Recorre una app o un router y devuelve TODAS sus rutas con lo que declararon. */
export function censarRutas(destino: Express | Router): RutaCensada[] {
  const raiz =
    (destino as unknown as { _router?: { stack?: CapaExpress[] } })._router?.stack ??
    (destino as unknown as { stack?: CapaExpress[] }).stack ??
    [];
  const salida: RutaCensada[] = [];
  recorrer(raiz, '', salida);
  return salida;
}

export interface ResumenDelCenso {
  rutas: RutaCensada[];
  /** Cuántas rutas hay de cada clase. Las lecturas sin declarar no se cuentan. */
  porClase: Record<RiesgoRuta, number>;
  /** Rutas que mutan y no declararon. Si esto no está vacío, no se arranca. */
  sinDeclarar: RutaCensada[];
  /**
   * Rutas que declararon en un lugar donde la declaración no llega a correr:
   * detrás del manejador que responde. Pasan por declaradas y no protegen.
   */
  malColocadas: RutaCensada[];
  /** Rutas con más de una declaración: cuál manda lo decidiría el orden. */
  declaradasDosVeces: RutaCensada[];
}

export function resumirCenso(destino: Express | Router): ResumenDelCenso {
  const rutas = censarRutas(destino);
  const porClase: Record<RiesgoRuta, number> = {
    lectura: 0, escritura: 0, irreversible: 0, externo: 0,
  };
  for (const r of rutas) if (r.riesgo) porClase[r.riesgo.riesgo] += 1;
  const sinDeclarar = rutas.filter(
    (r) => VERBOS_QUE_MUTAN.includes(r.metodo) && !r.riesgo
  );
  const malColocadas = rutas.filter((r) => r.riesgo && r.posicionDeclaracion !== 0);
  const declaradasDosVeces = rutas.filter((r) => r.declaraciones > 1);
  return { rutas, porClase, sinDeclarar, malColocadas, declaradasDosVeces };
}

/**
 * LA COMPUERTA DE ARRANQUE. Se llama en src/index.ts después de montar y
 * antes de escuchar.
 *
 * Un GET sin declarar se toma por `lectura`: es lo que un GET es, y si
 * alguno escribe, ése es un defecto que la declaración pondría a la vista
 * en vez de taparlo. Un POST, PUT, PATCH o DELETE sin declarar, en cambio,
 * no tiene lectura por omisión posible —podría ser un borrador o podría
 * ser el mayor— así que no se adivina: se rompe.
 */
/**
 * El alcance con el que una ruta guarda su llave de idempotencia:
 * «MÉTODO ruta». Es la MISMA cadena que `alcanceDeLaRuta` compone en
 * tiempo de petición desde `req.baseUrl` + `req.route.path`; aquí se
 * arma desde el censo para poder medirla antes de que exista una
 * petición.
 */
export function alcanceDeIdempotencia(r: RutaCensada): string {
  return `${r.metodo.toUpperCase()} ${r.ruta}`;
}

export function auditarRiesgoDeRutas(destino: Express | Router): ResumenDelCenso {
  const resumen = resumirCenso(destino);

  // EL ALCANCE TIENE QUE CABER EN LA COLUMNA, y se comprueba aquí porque
  // aquí no hay nada que perder. `idempotency_keys.scope` es VARCHAR(80)
  // (migración 039); si una ruta irreversible nueva se pasa de largo, el
  // error saldría de Postgres al GRABAR la llave — o sea después de
  // postear al mayor, con la respuesta ya en camino y nada que deshacer.
  // La ruta más larga de hoy mide 50.
  const noCaben = resumen.rutas.filter(
    (r) => r.riesgo?.exigeLlaveDeIdempotencia && alcanceDeIdempotencia(r).length > LARGO_MAX_ALCANCE
  );
  if (noCaben.length > 0) {
    throw new Error(
      `${noCaben.length} ruta(s) que exigen llave de idempotencia tienen un alcance más largo que ` +
        `los ${LARGO_MAX_ALCANCE} caracteres de idempotency_keys.scope:\n` +
        noCaben.map((r) => `  ${alcanceDeIdempotencia(r)} (${alcanceDeIdempotencia(r).length})`).join('\n') +
        '\n\nAcorta la ruta, o amplía la columna con una migración. Dejarlo pasar significa que la ' +
        'llave se rechaza al GRABARSE, que es después de que el acto irreversible ya ocurrió.'
    );
  }

  // LA DECLARACIÓN TIENE QUE PODER CORRER.
  //
  // El censo buscaba la marca en TODA la cadena de la ruta, así que
  // `router.post('/x', manejador, declararRiesgoRuta({...}))` pasaba por
  // declarada. Y no lo estaba en ningún sentido útil: el manejador ya
  // respondió cuando le tocaría correr al marcador, de modo que la ruta se
  // quedaba sin la llave de idempotencia que su clase exige y sin el
  // `res.locals.riesgoDeLaRuta` del que sale el renglón de auditoría. Medido
  // con dos rutas idénticas salvo por el orden: la de la declaración
  // delante deduplica el acto con la misma llave; la de la declaración
  // detrás lo ejecuta DOS VECES (tests/integration/g4a-ataque.int.spec.ts).
  //
  // Una declaración que certifica sin proteger es peor que ninguna, porque
  // el censo la cuenta como cerrada. Así que la posición se exige, no se
  // sugiere: primer manejador de la ruta, que es además lo que este archivo
  // decía de sí mismo desde el principio.
  if (resumen.malColocadas.length > 0) {
    const lista = resumen.malColocadas
      .map((r) => `  ${r.metodo.toUpperCase()} ${r.ruta} (posición ${r.posicionDeclaracion})`)
      .join('\n');
    throw new Error(
      `${resumen.malColocadas.length} ruta(s) declaran su riesgo fuera del PRIMER manejador:\n${lista}\n\n` +
        '`declararRiesgoRuta` no es un marcador inerte: deja la clase en res.locals y, cuando la ' +
        'clase lo exige, aplica la llave de idempotencia. Detrás del manejador que responde no ' +
        'llega a correr, así que la ruta queda declarada y desprotegida a la vez. Muévela al ' +
        'primer lugar de la cadena.'
    );
  }

  // DOS DECLARACIONES SON NINGUNA. El censo se queda con la primera, así que
  // «lectura» delante y «irreversible» detrás dejaba la ruta censada como
  // lectura — el permiso del agente dependería de en qué orden se escribieron
  // dos líneas. Se rompe en vez de elegir.
  if (resumen.declaradasDosVeces.length > 0) {
    const lista = resumen.declaradasDosVeces
      .map((r) => `  ${r.metodo.toUpperCase()} ${r.ruta} (${r.declaraciones} declaraciones)`)
      .join('\n');
    throw new Error(
      `${resumen.declaradasDosVeces.length} ruta(s) declaran su riesgo más de una vez:\n${lista}\n\n` +
        'Una ruta tiene UNA clase. Con dos declaraciones, cuál manda lo decide el orden de dos ' +
        'líneas y no el acto que la ruta ejecuta. Deja una sola; si de verdad hay dos actos de ' +
        'clases distintas, son dos rutas.'
    );
  }

  if (resumen.sinDeclarar.length > 0) {
    const lista = resumen.sinDeclarar
      .map((r) => `  ${r.metodo.toUpperCase()} ${r.ruta}`)
      .join('\n');
    throw new Error(
      `${resumen.sinDeclarar.length} ruta(s) que mutan no declararon su riesgo:\n${lista}\n\n` +
        'Toda ruta POST, PUT, PATCH o DELETE declara su clase con `declararRiesgoRuta` como ' +
        'PRIMER manejador, igual que toda hoja del CLI la declara junto a su registro ' +
        '(src/cli/kernel/risk.ts). Sin declaración no se sabe si esa ruta escribe un borrador o ' +
        'postea al mayor, y el agente no tiene con qué distinguirlas — que es exactamente cómo ' +
        'la API llegó a postear saltándose el control que el CLI declaraba no exponer.'
    );
  }
  return resumen;
}
