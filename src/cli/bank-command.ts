import * as readline from 'node:readline/promises';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';
import { InvalidArgumentError, type Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { entityScope, tenantScope, type Scope } from '../database/scope.js';
import {
  CAMPOS_SENSIBLES,
  TIPOS_DE_CUENTA,
  createBankAccount,
  getBankAccount,
  listBankAccounts,
  setBankGlMapping,
  updateBankAccount,
  type FichaCuentaBancaria,
  type ParcheCuenta,
  type RenglonCuentaBancaria,
  type TipoDeCuenta,
} from '../services/banking/bank-account-service.js';
import {
  importarEstadoDeCuenta,
  listarEstadosDeCuenta,
  obtenerEstadoDeCuenta,
  resolverCuentaBancaria,
  verificarEstadosDeCuenta,
  type LeerExtracto,
  type ResultadoImportacion,
  type ResumenEstadoDeCuenta,
} from '../services/banking/bank-statement-service.js';
import {
  STATEMENT_CHECK_NAMES,
  type HallazgoEstado,
} from '../services/banking/statement-checks.js';
import { FORMATOS_DEL_CATALOGO, leerExtracto } from '../services/banking/parsers/index.js';
import {
  CAMPOS_SIN_EXTRACTOR,
  DIRECCIONES,
  TIPOS_DE_MOVIMIENTO,
  exigirTipoDeMovimiento,
  listarMovimientos,
  obtenerMovimiento,
  type CriterioImporte,
  type Direccion,
  type FichaMovimiento,
  type RenglonMovimiento,
} from '../services/banking/transactions.js';
import {
  listarPartidasDeLibros,
  type PartidaDeLibros,
} from '../services/banking/book-items.js';
import {
  MODOS_RESIDUAL,
  MOTIVOS_DESAPLICACION,
  aplicarCotejos,
  correrCotejo,
  crearGrupoDeCotejo,
  desaplicarCotejo,
  previsualizarCotejo,
  type AjusteDeGrupo,
  type ModoResidual,
  type MotivoDesaplicacion,
  type MovimientoPrevisto,
  type ReferenciaDeLibros,
  type ResultadoAplicacion,
  type TipoCotejable,
} from '../services/banking/match-service.js';
import {
  ESTADOS_DE_SESION,
  PASOS_DE_CORRIDA,
  abrirSesion,
  cerrarSesion,
  correrConciliacion,
  estadoDeSesion,
  listarSesiones,
  type EstadoDeSesion,
  type EstadoDeSesionConciliacion,
  type PasoDeCorrida,
  type RenglonSesion,
  type ResultadoCorridaGuiada,
} from '../services/banking/reconciliation-service.js';
import {
  listarPartidas,
  type PartidaConciliatoria,
  asignarPartida,
  reclasificarPartida,
  ESCALAMIENTOS,
} from '../services/banking/reconciling-items.js';
import {
  ROLES_QUE_FALTAN,
  TIPOS_DE_AJUSTE,
  crearAjuste,
  type AjusteDeSesion,
  type TipoDeAjuste,
} from '../services/banking/reconciliation-adjustments.js';
import {
  TIPOS_DE_PARTIDA,
  type LadoConciliado,
  type TipoDePartida,
} from '../services/banking/reconciliation-math.js';
import { MATCHED_ENTITY_TYPES } from '../database/enums.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  checkExitCode,
  declareRisk,
  exitCodeFor,
  gateMutation,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  withContext,
  withForce,
  withNote,
  withOutput,
  withSelection,
  withStrict,
  abortedByUser,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine bank · banco
//
// Cinco objetos y diecisiete hojas. F05a trajo dos: la CUENTA como dato
// maestro y el ESTADO DE CUENTA como documento. F05b trae los otros tres, que
// son los dos lados del cotejo y el cotejo mismo — el MOVIMIENTO (lo que el
// banco dice), la PARTIDA DE LIBROS (lo que nosotros dijimos) y el COTEJO (la
// aseveración de que hablan del mismo dinero).
//
// Toda la aritmética, la frontera de entidad y el cifrado viven en
// `services/banking/`; aquí se decide lo que sólo la terminal puede decidir —
// qué se imprime, qué se pregunta y con qué código se sale.
//
// TRES DECISIONES QUE NO SON DE ESTILO.
//
// LA PRIMERA · `bank statement import` ES ESCRITURA Y EL AGENTE PUEDE
// LLAMARLA. Es la única fila de esta familia con IA ✓ sobre un verbo que
// escribe, y `declareRisk` sólo la admite con `draftOnly: true`. Aquí eso es
// LITERALMENTE cierto, no una concesión: el importador escribe `bank_statements`
// y `bank_transactions`, que son staging bancario —la afirmación de un tercero
// sobre nuestro dinero, esperando cotejo—, y NO EXISTE CAMINO desde este
// comando al mayor. Ni con --force, que no declara, ni con un formato
// distinto, ni con un archivo enorme: `journal_entries` se escribe en el cotejo
// y en la conciliación, que son otros verbos con otra aprobación. Es
// exactamente lo que la fila del catálogo promete en negritas
// («**no contabiliza nada en el mayor**»), y por eso el agente puede traer un
// extracto sin que nadie lo autorice: lo peor que puede hacer es dejar un
// documento que un humano tendrá que mirar.
//
// LA SEGUNDA · `--format` EN `import` ES EL FORMATO DEL ARCHIVO. En el resto
// del CLI `--format` es la forma de la SALIDA, y el diccionario la gobierna con
// esa grafía. El catálogo escribe `--format <ofx|qfx|mt940|…>` en la fila de
// import, y ahí nombra lo que entra. Las dos no caben en una hoja, así que
// import lee el archivo con `--format` y emite con `--json`, y su descripción
// lo dice para que nadie descubra la diferencia por un error. El núcleo exige
// `--format` de salida en las hojas `list`, y las tres `list` de esta familia
// lo llevan completo.
//
// LA TERCERA · LA RAMA DE SALIDA MIRA `--fields`. `withOutput` declara
// `--format` con valor por omisión `'table'`, así que `opts.format` nunca es
// indefinido y la condición `if (opts.format)` deja muerta la rama humana; se
// compara contra `'table'`, como en `ap reconcile`. Y la ficha de `show` —un
// texto escrito a mano, no una tabla— cede el paso a `render` en cuanto llega
// un `--fields`: una bandera declarada que sólo se lee en json es una promesa
// incumplida, y ya cazaron esa exacta mentira en `ap reconcile`.
//
// Y TRES MÁS, DE F05b.
//
// LA CUARTA · `preview` Y `run` SON DOS HOJAS Y NO UNA CON BANDERA. Hacen la
// misma pregunta al mismo motor con las mismas cuatro compuertas; la única
// diferencia es que una escribe. Podrían ser `bank match run --dry-run`, y
// entonces el permiso del agente dependería del valor de una bandera:
// imposible de decidir al registrar y de hacer cumplir en ningún sitio. Por
// eso están partidas, `declareRisk` las declara ✓ y ✗ por separado, y las
// banderas de compuerta se escriben IGUAL en las dos (`--min-confidence`,
// `--max-amount`, `--rules-only`) para que la mitad de lectura siga prediciendo
// lo que hará la de escritura. Es literalmente lo que dice el catálogo en su
// nota sobre la columna IA, y la razón por la que `bank match preview` es la
// única hoja de cotejo que un agente puede invocar.
//
// LA QUINTA · `--bank` Y `--book` DEL CATÁLOGO SE LLAMAN AQUÍ `--transaction`
// Y `--book-item`. La fila 1227 escribe `--bank <ids>` para el lado de banco de
// un grupo, pero `--bank` YA existe en esta familia y significa la institución
// (`bank account create --bank BBVA`). Una grafía con dos significados en el
// mismo binario es exactamente lo que el diccionario de banderas existe para
// impedir, así que los dos lados se nombran por el sustantivo de su hoja:
// `bank transaction list` y `bank book-item list`. Es la única desviación de
// nombre de este tramo y está dicha aquí para que se pueda revertir a
// propósito, no descubrir por un error.
//
// LA SEXTA · LA CONFIRMACIÓN NO SE SALTA POR VENIR DE UNA TUBERÍA. `apply
// --stdin` consume la entrada estándar, así que no queda por dónde preguntar:
// `ask` devuelve `false` sin TTY y el acto se aborta pidiendo `-y` por su
// nombre. La alternativa —dar por buena la confirmación cuando nadie puede
// contestarla— convertiría la ausencia de humano en el permiso de escribir.
//
// Y CINCO MÁS, DE F05c — el tramo del que habla el comentario más largo del
// módulo, el del endpoint retirado: `status = 'balanced'` sin haber restado
// nada, leído por `period-close.ts` como la evidencia de que el efectivo se
// verificó contra el banco.
//
// LA SÉPTIMA · NINGUNA HOJA DE ESTA FAMILIA IMPRIME
// `reconciliation_sessions.variance` COMO LA RESPUESTA. `status`, `close` y
// `generate` recalculan la aritmética viva y enseñan la columna aparte,
// etiquetada como CONGELADA. Y donde el servicio devuelve `null` —«nadie
// observó este lado»— aquí se imprime «sin observar» y nunca un cero: el cero
// por DEFAULT presentado como cuadre ES el defecto histórico, y colapsar los
// dos en la superficie lo reintroduciría después de que la 053 lo volviera
// imposible en el esquema. En `list`, esa misma distinción es un HUECO en la
// columna `variance` cuando `arithmetic_computed_at` es NULL.
//
// LA OCTAVA · `open` Y `adjustment create` SON ESCRITURA CON IA ✓, Y
// `declareRisk` sólo lo admite con `draftOnly`. En las dos es literalmente
// cierto y está escrito junto a su declaración: `open` crea un CONTENEDOR DE
// TRABAJO —la sesión nace `in_progress` con `arithmetic_computed_at` en NULL, y
// el CHECK `sesion_balanceada_con_aritmetica` de la 053 impide que llegue a
// `balanced` por esta puerta— y `adjustment create` escribe un BORRADOR de
// `ai_drafts` que espera a `mnemosine review`, con `journal_entry_id` en NULL
// hasta que F05d lo contabilice. Ninguna de las dos tiene camino al mayor por
// ninguna bandera, y un criterio del plan lo verifica contra el servicio.
//
// LA NOVENA · `adjustment create --account` SE LLAMA AQUÍ `--gl-account`. El
// catálogo escribe `--account` para la cuenta de CONTRAPARTIDA del asiento,
// pero `--account` YA significa la cuenta BANCARIA en cinco hojas de esta misma
// familia (`statement import`, `match run`, `match create`, `reconciliation
// list`, `reconciliation status`). Una grafía con dos significados dentro del
// mismo sustantivo es lo que el diccionario existe para impedir —es el mismo
// caso que `--bank` en F05b—, así que se usa la grafía que ya nombra una cuenta
// de mayor en este binario: `bank account create --gl-account`.
//
// LA DÉCIMA · `generate --format pdf|xlsx` NO EXISTE Y SE DICE. El proyecto no
// tiene dependencia de PDF ni de XLSX y no se le añade una para fingir un
// documento: se rechaza nombrando lo que sí hay —json para el expediente
// entero, md/csv/tsv para el estado en renglones, y la salida de texto que se
// imprime y se archiva—. Un PDF inventado con un `console.log` sería peor que
// no tenerlo, porque acabaría en un expediente de auditoría.
//
// LA UNDÉCIMA · `close` PREGUNTA ANTES DE FIRMAR, y `adjustment create` SALE
// 11. Lo primero porque la orden es corta —tres palabras y un id— y el efecto
// es una aseveración firmada que el tablero de cierre lee como evidencia: se
// enseña la aritmética completa y después se pregunta (`-y` la salta, y sin
// TTY se nombra `-y` en vez de dejar un «abortado» que parece un fallo). Lo
// segundo porque el contrato de salida reserva el 11 para «no falló: espera a
// una persona», y eso es exactamente lo que deja un ajuste: un borrador en la
// cola de revisión.
// ============================================================

export interface BankCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Costura de prueba: responde la confirmación de `bank account edit`. */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Costura de prueba: la entrada estándar de `bank match apply --stdin`.
   *
   * Existe porque la alternativa es que una prueba escriba en el stdin del
   * proceso de vitest, que es del corredor y no del caso.
   */
  readStdin?: () => Promise<string>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  strict?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMPORTE_RE = /^-?\d+(\.\d+)?$/;

/**
 * Una bandera mal escrita es un error de USO (2), no una validación fallida del
 * dominio (4): un guion de cierre que confunde los dos trata un typo como si
 * los libros estuvieran mal. La comprobación de ida y vuelta rechaza los días
 * que no existen — JS acepta `2026-02-31` y lo desplaza al 3 de marzo.
 */
function exigirFecha(flag: string, valor: string): string {
  const d = new Date(`${valor}T00:00:00Z`);
  if (!FECHA_RE.test(valor) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw usageError(`${flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "${valor}".`);
  }
  return valor;
}

/**
 * Un entero para Commander. Va como `InvalidArgumentError` y no como
 * `usageError` porque una coerción de opción corre DENTRO de `parseAsync`,
 * fuera del `try` del manejador: cualquier otra excepción escaparía del
 * envoltorio que traduce errores a códigos de salida y se vería como un
 * volcado de pila. Es lo mismo que hace `parsePositiveInt` en el núcleo.
 */
function enteroPositivo(nombre: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new InvalidArgumentError(`${nombre} must be a whole number of 1 or more; got "${valor}".`);
    }
    return n;
  };
}

/** El dinero entra y sale como CADENA. Aquí sólo se comprueba la forma. */
function exigirImporte(flag: string, valor: string): string {
  const limpio = valor.trim().replace(/,/g, '');
  if (!IMPORTE_RE.test(limpio)) {
    throw usageError(`${flag} debe ser un importe decimal; llegó "${valor}".`);
  }
  return limpio;
}

function exigirTipo(valor: string): TipoDeCuenta {
  const tipo = valor.trim().toLowerCase();
  if (!(TIPOS_DE_CUENTA as readonly string[]).includes(tipo)) {
    throw usageError(
      `--type "${valor}" no es un tipo de cuenta. Los cinco son: ${TIPOS_DE_CUENTA.join(', ')}.`
    );
  }
  return tipo as TipoDeCuenta;
}

/**
 * `-s/--status` de una cuenta bancaria tiene dos estados y no un ciclo de vida:
 * la 003 le dio `is_active` y nada más. Se traduce aquí en vez de inventar una
 * columna, y un valor que no existe se rechaza nombrando los dos que sí.
 */
function estadoDeCuenta(status: string[] | undefined, all: boolean | undefined): boolean | undefined {
  if (all) return undefined;
  if (!status?.length) return true;
  const pedidos = new Set(status.map((s) => s.trim().toLowerCase()));
  const desconocidos = [...pedidos].filter((s) => s !== 'active' && s !== 'archived');
  if (desconocidos.length) {
    throw usageError(
      `--status ${desconocidos.join(', ')} no existe para una cuenta bancaria: sólo active y archived.`
    );
  }
  if (pedidos.size === 2) return undefined;
  return pedidos.has('active');
}

/** `''` significa «bórralo», y es distinto de no pasar la bandera. */
function opcionalNulo(valor: string | undefined): string | null | undefined {
  if (valor === undefined) return undefined;
  return valor.trim() === '' ? null : valor.trim();
}

/**
 * Un entero que admite el cero, para `--over-days 0` («sin antigüedad mínima»).
 * `enteroPositivo` rechazaría ese caso, que es legítimo y no un typo.
 */
function enteroDesdeCero(nombre: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${nombre} must be a whole number of 0 or more; got "${valor}".`);
    }
    return n;
  };
}

/**
 * La confianza del motor es un DECIMAL(3,2) entre 0 y 1, no dinero: se compara
 * como número a propósito y `matching.ts` lo dice en su sitio. Lo que sí hay
 * que impedir es un 85 tecleado por 0.85, que abriría la compuerta del todo en
 * vez de cerrarla.
 */
function confianzaCero1(nombre: string) {
  return (valor: string): number => {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new InvalidArgumentError(
        `${nombre} must be a confidence between 0 and 1 (0.85, not 85); got "${valor}".`
      );
    }
    return n;
  };
}

/**
 * El estado de cotejo de un movimiento, que sí es un estado de ciclo de vida y
 * por eso `-s` significa algo aquí (a diferencia de `bank statement list`).
 *
 * `--unmatched` es el atajo que nombra el catálogo, no un filtro paralelo: si
 * los dos llegan y se contradicen se rechaza en voz alta, porque obedecer a
 * uno de los dos en silencio devolvería un listado que no es el que se pidió.
 */
function estadoDeCotejo(status: string[] | undefined, unmatched: boolean | undefined): boolean | undefined {
  const pedidos = new Set((status ?? []).map((s) => s.trim().toLowerCase()));
  const desconocidos = [...pedidos].filter((s) => s !== 'matched' && s !== 'unmatched');
  if (desconocidos.length) {
    throw usageError(
      `-s ${desconocidos.join(', ')} no existe para un movimiento bancario: sólo matched y unmatched. ` +
        'El resto de su estado —de qué estado de cuenta vino, qué lo explica— se lee con ' +
        '`bank transaction show`.'
    );
  }
  if (unmatched) {
    if (pedidos.has('matched')) {
      throw usageError(
        '--unmatched y `-s matched` piden lo contrario. --unmatched es el atajo de `-s unmatched`: ' +
          'pasa uno de los dos.'
      );
    }
    return false;
  }
  if (pedidos.size !== 1) return undefined;
  return pedidos.has('matched');
}

function exigirDireccion(valor: string): Direccion {
  const d = valor.trim().toLowerCase();
  if (!(DIRECCIONES as readonly string[]).includes(d)) {
    throw usageError(
      `--direction "${valor}" no existe: in es dinero que entra (importe positivo) y out el que sale.`
    );
  }
  return d as Direccion;
}

// ── LA CONSULTA POSICIONAL ──────────────────────────────────────────────
//
// La fila 1198 pide `desc:` y `amt:` en un argumento posicional, con la
// sintaxis estilo hledger que el catálogo fija para TODOS los `list` (§4). La
// forma se copia del único precedente que hay en el repositorio,
// `bill inbox run --query`: lista de claves CERRADA, una clave desconocida se
// rechaza nombrando las que existen, y una consulta que no acota nada se
// rechaza en vez de significar «todo».
//
// La diferencia con aquel precedente es dónde vive: aquél es una bandera con
// pares `clave=valor` separados por comas; éste es el posicional con `clave:`
// separado por espacios, que es lo que el catálogo escribe para los listados.

/** Las dos claves que la fila 1198 nombra. Cerrada: una nueva se añade aquí. */
const CLAVES_DE_CONSULTA = ['desc', 'amt'] as const;

const AMT_RE = /^(>=|<=|>|<|=)?([+-]?\d+(?:\.\d+)?)$/;

export interface ConsultaDeMovimientos {
  texto: string[];
  importes: CriterioImporte[];
}

/**
 * Parte la consulta en términos respetando las comillas dobles.
 *
 * Sin esto, `desc:"pago de nomina"` se rompería en tres términos y los dos
 * últimos se leerían como búsquedas de texto sueltas: la consulta devolvería
 * de menos y nadie sabría por qué.
 */
function terminosDe(consulta: string): string[] {
  const terminos: string[] = [];
  let actual = '';
  let entreComillas = false;
  for (const ch of consulta) {
    if (ch === '"') {
      entreComillas = !entreComillas;
      continue;
    }
    if (!entreComillas && /\s/.test(ch)) {
      if (actual) terminos.push(actual);
      actual = '';
      continue;
    }
    actual += ch;
  }
  if (entreComillas) {
    throw usageError(`La consulta "${consulta}" abre una comilla y no la cierra.`);
  }
  if (actual) terminos.push(actual);
  return terminos;
}

export function consultaDeMovimientos(consulta: string): ConsultaDeMovimientos {
  const salida: ConsultaDeMovimientos = { texto: [], importes: [] };

  for (const termino of terminosDe(consulta)) {
    const corte = termino.indexOf(':');
    // Una palabra suelta es una búsqueda de texto. Es lo que cualquiera teclea
    // primero, y obligarla a llevar prefijo sólo enseña a nadie.
    const clave = corte === -1 ? 'desc' : termino.slice(0, corte).toLowerCase();
    const valor = corte === -1 ? termino : termino.slice(corte + 1);

    if (!(CLAVES_DE_CONSULTA as readonly string[]).includes(clave)) {
      throw usageError(
        `La consulta no conoce el término "${clave}:". Los que hay son ` +
          `${CLAVES_DE_CONSULTA.map((c) => `${c}:`).join(', ')}, y una palabra sin prefijo busca en ` +
          'la descripción. El resto se acota con banderas (--account, --since, --until, ' +
          '--direction, --type).'
      );
    }
    if (!valor) {
      throw usageError(`El término "${termino}" no trae valor: escribe ${clave}:<valor>.`);
    }

    if (clave === 'desc') {
      salida.texto.push(valor);
      continue;
    }

    const m = AMT_RE.exec(valor.replace(/,/g, ''));
    if (!m) {
      throw usageError(
        `"amt:${valor}" no es un importe. La forma es amt:250, amt:>1000, amt:<=99.99 o ` +
          'amt:-250 (con signo compara el importe tal cual; sin signo, la magnitud).'
      );
    }
    salida.importes.push({
      comparador: (m[1] ?? '=') as CriterioImporte['comparador'],
      // Dinero como CADENA de punta a punta: entra al SQL como texto y se
      // castea a numeric allí. Un Number() aquí es el redondeo que después
      // nadie encuentra.
      valor: m[2].replace(/^\+/, ''),
      firmado: /^[+-]/.test(m[2]),
    });
  }

  if (salida.texto.length === 0 && salida.importes.length === 0) {
    throw usageError(
      `La consulta "${consulta}" no acota nada. Nombra al menos un término ` +
        `(${CLAVES_DE_CONSULTA.map((c) => `${c}:`).join(', ')}), o quítala para listar todo.`
    );
  }
  return salida;
}

// ── LOS IDS QUE ENTRAN POR BANDERA ──────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Una lista de uuid separados por comas.
 *
 * Se valida la FORMA aquí, antes de abrir transacción, porque un id mal
 * tecleado dentro del acto abortaría un grupo a medio armar y el operador
 * tendría que volver a escribir los otros nueve. Los repetidos NO se filtran:
 * los rechaza el servicio nombrando cuál, y silenciarlos aquí haría que un
 * grupo que el usuario cree de tres patas se escribiera con dos.
 */
function idsDeBandera(flag: string, valor: string): string[] {
  const ids = valor.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw usageError(`${flag} llegó vacía: nombra al menos un identificador.`);
  const malos = ids.filter((id) => !UUID_RE.test(id));
  if (malos.length) {
    throw usageError(
      `${flag} ${malos.join(', ')} no es un identificador: se esperan uuid separados por comas, ` +
        'como los que imprime `bank transaction list -q`.'
    );
  }
  return ids;
}

/** Un solo identificador, comprobado antes de gastar una conexión en él. */
function uuidDeBandera(flag: string, valor: string): string {
  const id = valor.trim();
  if (!UUID_RE.test(id)) {
    throw usageError(`${flag} "${valor}" no es un identificador: se espera un uuid.`);
  }
  return id;
}

/**
 * El lado de libros: `<id>` o `<tipo>:<id>`.
 *
 * Sin tipo se asume `journal_entry_line`, que es lo que «M partidas de libros»
 * significa y lo que el servicio ya toma por omisión. Los otros cuatro tipos
 * existen porque el mismo grupo puede cotejar contra una factura o un pago.
 */
function referenciasDeLibros(valor: string): ReferenciaDeLibros[] {
  return valor.split(',').map((s) => s.trim()).filter(Boolean).map((parte) => {
    const corte = parte.lastIndexOf(':');
    const tipo = corte === -1 ? 'journal_entry_line' : parte.slice(0, corte).toLowerCase();
    const id = corte === -1 ? parte : parte.slice(corte + 1);
    if (!(MATCHED_ENTITY_TYPES as readonly string[]).includes(tipo)) {
      throw usageError(
        `"${tipo}" no es un tipo cotejable. Los cinco son: ${MATCHED_ENTITY_TYPES.join(', ')}. ` +
          'Escribe <tipo>:<id>, o sólo <id> para una partida de póliza.'
      );
    }
    if (!UUID_RE.test(id)) {
      throw usageError(`--book-item "${parte}" no trae un identificador válido después del tipo.`);
    }
    return { tipo: tipo as TipoCotejable, id };
  });
}

/** `--adjust "comision bancaria=-35.00"`, repetible. */
function ajusteDeGrupo(valor: string, previos: AjusteDeGrupo[]): AjusteDeGrupo[] {
  const corte = valor.lastIndexOf('=');
  if (corte <= 0) {
    throw new InvalidArgumentError(
      `--adjust must be "<concept>=<amount>", e.g. --adjust "bank fee=-35.00"; got "${valor}".`
    );
  }
  const concepto = valor.slice(0, corte).trim();
  const importe = valor.slice(corte + 1).trim().replace(/,/g, '');
  if (!concepto || !IMPORTE_RE.test(importe)) {
    throw new InvalidArgumentError(
      `--adjust must be "<concept>=<amount>", e.g. --adjust "bank fee=-35.00"; got "${valor}".`
    );
  }
  return [...previos, { concepto, importe }];
}

function exigirResidual(valor: string): ModoResidual {
  const m = valor.trim().toLowerCase();
  if (!(MODOS_RESIDUAL as readonly string[]).includes(m)) {
    throw usageError(
      `--residual "${valor}" no existe. keep deja el residual vivo como partida conciliatoria; ` +
        'write-off lo cancela contra la cuenta que diga --write-off-account.'
    );
  }
  return m as ModoResidual;
}

function exigirMotivo(valor: string | undefined): MotivoDesaplicacion {
  const codigo = (valor ?? '').trim().toLowerCase();
  if (!(MOTIVOS_DESAPLICACION as readonly string[]).includes(codigo)) {
    throw usageError(
      `--reason es obligatorio y es un CÓDIGO, no prosa: ${MOTIVOS_DESAPLICACION.join(', ')}. ` +
        'Una taxonomía cerrada es lo que permite preguntar cuántos cotejos se deshicieron por ' +
        'documento cancelado este trimestre; un campo libre contesta eso con un grep.'
    );
  }
  return codigo as MotivoDesaplicacion;
}

// ── F05c · LOS VALORES TIPIFICADOS DE LA SESIÓN ─────────────────────────
//
// Las cuatro listas cerradas de este tramo (los seis tipos de partida, los
// cinco de ajuste, los cinco pasos del pase guiado y los cuatro estados de la
// sesión) se validan CONTRA LA CONSTANTE DEL SERVICIO, nunca contra una copia
// local: la del servicio sale del CHECK de la 053, y una lista local que se
// separe de ella haría que un valor imposible de insertar pareciera válido
// aquí y muriera después contra la base con el error de Postgres.

function exigirTipoDePartida(valor: string): TipoDePartida {
  const tipo = valor.trim().toLowerCase();
  if (!(TIPOS_DE_PARTIDA as readonly string[]).includes(tipo)) {
    throw usageError(
      `--type "${valor}" no es un tipo de partida conciliatoria. Los seis son: ` +
        `${TIPOS_DE_PARTIDA.join(', ')}.`
    );
  }
  return tipo as TipoDePartida;
}

function exigirTipoDeAjuste(valor: string): TipoDeAjuste {
  const tipo = valor.trim().toLowerCase();
  if (!(TIPOS_DE_AJUSTE as readonly string[]).includes(tipo)) {
    throw usageError(
      `--type "${valor}" no es un tipo de ajuste de conciliación. Los cinco son: ` +
        `${TIPOS_DE_AJUSTE.join(', ')}.`
    );
  }
  return tipo as TipoDeAjuste;
}

function exigirPaso(valor: string): PasoDeCorrida {
  const paso = valor.trim().toLowerCase();
  if (!(PASOS_DE_CORRIDA as readonly string[]).includes(paso)) {
    throw usageError(
      `--stop-at "${valor}" no es un paso del pase guiado. Los cinco, en orden: ` +
        `${PASOS_DE_CORRIDA.join(' → ')}. Ninguno llega a \`approve\` ni a \`post\`.`
    );
  }
  return paso as PasoDeCorrida;
}

/**
 * `-s/--status` de una sesión SÍ es un ciclo de vida —los cuatro estados del
 * CHECK de la 003—, a diferencia del de un estado de cuenta.
 *
 * Se admite uno solo porque el servicio filtra por uno: aceptar dos y quedarse
 * con el primero devolvería un listado que no es el que se pidió, en silencio.
 */
function exigirEstadoDeSesion(status: string[] | undefined): EstadoDeSesionConciliacion | undefined {
  if (!status?.length) return undefined;
  if (status.length > 1) {
    throw usageError(
      `-s admite un estado a la vez en esta hoja (llegaron ${status.length}): ` +
        `${ESTADOS_DE_SESION.join(', ')}. Sin la bandera salen los cuatro.`
    );
  }
  const estado = status[0].trim().toLowerCase();
  if (!(ESTADOS_DE_SESION as readonly string[]).includes(estado)) {
    throw usageError(
      `-s "${status[0]}" no es un estado de sesión de conciliación. Los cuatro son: ` +
        `${ESTADOS_DE_SESION.join(', ')}.`
    );
  }
  return estado as EstadoDeSesionConciliacion;
}

/**
 * Abierta y resuelta son el ciclo de vida de una partida conciliatoria, así que
 * `-s` significa algo aquí. `--all` incluye las resueltas, que es lo que «no
 * default limit; include archived and closed» quiere decir para esta tabla.
 *
 * `resolved` a solas se filtra en JS y no en el SQL a propósito: el servicio
 * ofrece «con resueltas» y «sin resueltas», y las partidas de UNA sesión caben
 * en memoria por construcción. Inventar aquí un tercer filtro en SQL sería
 * duplicar la consulta de otro dueño para ahorrar un `filter`.
 */
function alcanceDePartidas(
  status: string[] | undefined,
  all: boolean | undefined
): { incluirResueltas: boolean; soloResueltas: boolean } {
  const pedidos = new Set((status ?? []).map((s) => s.trim().toLowerCase()));
  const desconocidos = [...pedidos].filter((s) => s !== 'open' && s !== 'resolved');
  if (desconocidos.length) {
    throw usageError(
      `-s ${desconocidos.join(', ')} no existe para una partida conciliatoria: sólo open y ` +
        'resolved. Una partida resuelta dejó de explicar una diferencia y por eso no sale por omisión.'
    );
  }
  if (all || pedidos.size === 2) return { incluirResueltas: true, soloResueltas: false };
  if (pedidos.has('resolved')) return { incluirResueltas: true, soloResueltas: true };
  return { incluirResueltas: false, soloResueltas: false };
}

const COLUMNAS_SESION = [
  'account', 'period', 'status', 'closing_bank', 'variance', 'open_items',
] as const;

function sesionComoFila(s: RenglonSesion): Row {
  return {
    account: s.cuenta,
    period: `${s.desde}..${s.hasta}`,
    status: s.estado,
    currency: s.moneda,
    opening: s.saldoInicial,
    closing_bank: s.saldoFinalBanco,
    // EL HUECO ES EL DATO. `varianceCongelada` llega `null` cuando
    // `arithmetic_computed_at` es NULL, y entonces la celda queda VACÍA en vez
    // de imprimir el 0.0000 que la columna guarda: ese cero significa «nadie
    // restó nada» y en una lista —donde no cabe un párrafo de contexto— se
    // leería como «cuadra». Es el defecto histórico, visto desde la columna.
    variance: s.varianceCongelada ?? '',
    computed_at: s.aritmeticaCalculadaEl ?? '',
    open_items: s.partidasAbiertas,
    entity_id: s.entityId,
    account_id: s.cuentaId,
    created: s.creadaEl,
    id: s.id,
  };
}

const COLUMNAS_PARTIDA_CONCILIATORIA = [
  'date', 'type', 'amount', 'age_days', 'owner', 'expected', 'escalation',
] as const;

function partidaConciliatoriaComoFila(p: PartidaConciliatoria): Row {
  return {
    date: p.fecha,
    type: p.tipo,
    side: p.lado,
    // Con los cuatro decimales de la columna: recortar a dos lo que después se
    // suma es el defecto que F05a cazó tres veces.
    amount: p.importe,
    age_days: p.antiguedadDias,
    owner: p.responsable ?? '',
    expected: p.fechaEsperada ?? '',
    // El VIVO —derivado de la fecha esperada contra hoy— y el GUARDADO, uno al
    // lado del otro. Cuando difieren, la diferencia es información: alguien
    // marcó algo que el calendario ya contradice.
    escalation: p.escalamiento,
    escalation_on_file: p.escalamientoRegistrado,
    transaction_id: p.bankTransactionId ?? '',
    book_item_id: p.journalEntryLineId ?? '',
    notes: p.notas ?? '',
    resolved: p.resuelta,
    resolved_at: p.resueltaEl ?? '',
    id: p.id,
  };
}

const COLUMNAS_AJUSTE = ['type', 'amount', 'draft', 'draft_status', 'journal_entry'] as const;

function ajusteComoFila(a: AjusteDeSesion): Row {
  return {
    type: a.tipo,
    amount: a.importe,
    draft: a.draftId ?? '',
    // `draft_status` y `journal_entry` viajan juntos a propósito: mientras el
    // segundo esté vacío y el primero diga `pending_review`, la promesa de que
    // esta hoja «nunca contabiliza por su cuenta» se COMPRUEBA mirando la
    // salida, no leyendo el código.
    draft_status: a.estadoDelBorrador ?? '',
    journal_entry: a.journalEntryId ?? '',
    reconciling_item: a.reconcilingItemId ?? '',
    created: a.creadoEl,
    created_by: a.creadoPor,
    id: a.id,
  };
}

/** Un lado de la conciliación, tal cual, con su `null` intacto. */
function ladoComoDocumento(l: LadoConciliado): Record<string, unknown> {
  return {
    // `null` y no `''`: en json la distinción entre «no observado» y «cero»
    // tiene que sobrevivir al serializador, que es justo donde un `?? 0` la
    // mataría para siempre.
    balance: l.saldo,
    items: l.partidas.map((p) => ({ type: p.tipo, amount: p.importe })),
    adjusted: l.ajustado,
  };
}

/**
 * La sesión entera como UN documento.
 *
 * Un documento por invocación, como en `bank statement show`: dos `render`
 * seguidos darían dos sobres pegados y eso no es JSON. Aquí importa más que
 * allá, porque lo que se está publicando es la aritmética que alguien va a
 * comparar contra la columna congelada.
 */
function estadoComoDocumento(e: EstadoDeSesion): Row {
  const a = e.aritmetica;
  return {
    account: e.sesion.cuenta.nombre,
    account_type: e.sesion.cuenta.tipo,
    currency: e.sesion.cuenta.moneda,
    period: `${e.sesion.desde}..${e.sesion.hasta}`,
    status: e.sesion.estado,
    statement_id: e.sesion.statementId ?? '',
    opening: e.sesion.saldoInicial,
    // Los DOS números del extracto: el que publica el banco y el normalizado al
    // marco del mayor. En una tarjeta de crédito no son el mismo —el saldo del
    // extracto es un pasivo y se niega—, y publicar sólo el segundo haría la
    // conversión silenciosa.
    bank_balance_as_published: e.saldoBancoDeclarado,
    bank: ladoComoDocumento(a.banco),
    books: ladoComoDocumento(a.libros),
    variance: a.variacion,
    balances: a.cuadra,
    tolerance: a.tolerancia,
    unclassified: a.sinClasificar,
    undated: a.sinFechar,
    resolved_items: a.resueltas,
    unexplained_lines: e.movimientosSinExplicar.cuantos,
    unexplained_amount: e.movimientosSinExplicar.importe,
    policy_tolerance: e.criterios.tolerancia.valor,
    policy_unexplained_line: e.criterios.lineaSinPartida.valor,
    items: e.partidas.map(partidaConciliatoriaComoFila),
    adjustments: e.ajustes.map(ajusteComoFila),
    findings: a.reparos.map((r) => ({ code: r.codigo, detail: r.detalle })),
    blockers: e.bloqueantes.map((r) => ({ code: r.codigo, detail: r.detalle })),
    ready_to_close: e.listaParaCerrar,
    // EL RESUMEN CONGELADO, aparte y etiquetado. Nunca es la respuesta: es la
    // aseveración que se hizo, y contrastarla con la aritmética de arriba es lo
    // que permite descubrir que la sesión de marzo ya no dice la verdad.
    frozen: {
      variance: e.congelado.variance,
      books_balance: e.congelado.saldoLibros,
      outstanding_checks: e.congelado.chequesEnCirculacion,
      deposits_in_transit: e.congelado.depositosEnTransito,
      bank_charges: e.congelado.cargosDelBanco,
      bank_credits: e.congelado.abonosDelBanco,
      other_adjustments: e.congelado.otrosAjustes,
      computed_at: e.congelado.aritmeticaCalculadaEl,
    },
    closed_at: e.sesion.cerradaEl ?? '',
    closed_by: e.sesion.cerradaPor ?? '',
    approved_by: e.sesion.aprobadaPor ?? '',
    notes: e.sesion.notas ?? '',
    id: e.sesion.id,
  };
}

/**
 * El estado de conciliación en RENGLONES, para los formatos de tabla.
 *
 * `generate --format json` publica el documento anidado entero; csv, tsv y md
 * no pueden llevarlo, así que llevan lo que un estado de conciliación ES en
 * papel: una columna de conceptos y una de importes, en el orden en que se
 * suman. Las dos formas salen de la MISMA aritmética, así que no pueden
 * discrepar.
 */
function renglonesDelEstado(e: EstadoDeSesion): Row[] {
  const a = e.aritmetica;
  const filas: Row[] = [];
  const agregar = (seccion: string, concepto: string, importe: string | null, nota = ''): void => {
    filas.push({
      section: seccion,
      concept: concepto,
      amount: importe ?? '',
      note: importe === null ? 'sin observar' : nota,
      line: `${seccion}:${concepto}`,
    });
  };

  agregar('bank', 'ending-balance-per-bank', a.banco.saldo);
  for (const p of a.banco.partidas) agregar('bank', p.tipo, p.importe);
  agregar('bank', 'adjusted', a.banco.ajustado);
  agregar('books', 'balance-per-books', a.libros.saldo);
  for (const p of a.libros.partidas) agregar('books', p.tipo, p.importe);
  agregar('books', 'adjusted', a.libros.ajustado);
  agregar(
    'variance',
    'bank-adjusted-minus-books-adjusted',
    a.variacion,
    `tolerancia ${a.tolerancia} · ${e.criterios.tolerancia.valor}`
  );
  return filas;
}

/** El pase guiado como UN documento, con el estado final anidado. */
function corridaComoDocumento(r: ResultadoCorridaGuiada): Row {
  return {
    account: r.cuenta.nombre,
    account_id: r.cuenta.id,
    period: `${r.desde}..${r.hasta}`,
    steps: r.pasos.map((p) => ({ step: p.paso, done: p.hecho, detail: p.detalle })),
    statement: r.importacion
      ? {
          statement_id: r.importacion.statementId,
          file: r.importacion.archivo,
          imported: r.importacion.importadas,
          duplicated: r.importacion.duplicadas,
        }
      : null,
    matching: r.cotejo
      ? {
          applied: r.cotejo.aplicados.length,
          evaluated: r.cotejo.evaluados,
          skipped: r.cotejo.omitidos.length,
          truncated: r.cotejo.truncado,
        }
      : null,
    session_id: r.sesionId ?? '',
    classification: r.clasificacion
      ? {
          raised: r.clasificacion.levantadas.length,
          without_due_date: r.clasificacion.sinFechaEsperada,
          skipped: r.clasificacion.omitidas.length,
          limit_reached: r.clasificacion.topeAlcanzado,
        }
      : null,
    status: r.estado ? estadoComoDocumento(r.estado) : null,
    missing: r.loQueFalta,
    // Viaja como DATO y no sólo como texto para que ninguna superficie —ni un
    // agente— pueda leer esta corrida como si hubiera aprobado o contabilizado
    // algo.
    stopped_before_approve: r.detenidaAntesDeAprobar,
    dry_run: r.ensayo,
    id: r.sesionId ?? r.cuenta.id,
  };
}

const COLUMNAS_CUENTA = [
  'account', 'bank', 'type', 'currency', 'gl_code', 'book_balance', 'last_reconciled', 'active',
] as const;

function renglonComoFila(r: RenglonCuentaBancaria): Row {
  return {
    account: r.accountName,
    bank: r.bankName,
    type: r.accountType,
    currency: r.currencyCode,
    gl_code: r.glAccount?.code ?? '',
    gl_name: r.glAccount?.name ?? '',
    book_balance: r.saldoLibro,
    bank_balance: r.saldoBanco ?? '',
    last_reconciled: r.ultimaConciliacionAprobada ?? '',
    active: r.isActive,
    // El uuid completo va al final y es el `idField`: es lo que `-q` escupe y
    // lo que `bank account show` acepta, así que la tubería
    // `list -q | xargs -n1 mnemosine bank account show` tiene que funcionar.
    id: r.id,
  };
}

/**
 * La ficha, aplanada.
 *
 * `redactado` no es lo mismo que enmascarado. El servicio NUNCA devuelve un
 * identificador completo —la CLABE se guarda cifrada por la 051 y sólo salen
 * sus últimos 4—, así que `--redacted` no protege de una fuga: quita también
 * esos cuatro dígitos, que es lo que hace falta cuando la pantalla se comparte
 * o la salida se pega en un ticket. La clave de banco del SAT y el SWIFT se
 * quedan: identifican al BANCO, no a la cuenta, y sin ellos la ficha deja de
 * servir para lo único que se usa compartida, que es pedir ayuda con ella.
 *
 * Redactado NO es lo mismo que vacío, y por eso el valor oculto es una palabra
 * y no una cadena en blanco: «no hay CLABE en archivo» y «hay una y no te la
 * enseño» son hechos distintos, y colapsarlos haría que una cuenta sin
 * identificador registrado —que es un defecto— pasara por una cuenta discreta.
 */
const OCULTO = '(redacted)';

function fichaComoFila(f: FichaCuentaBancaria, redactado: boolean): Row {
  const identificador = (valor: string | null): string =>
    valor === null ? '' : redactado ? OCULTO : valor;
  return {
    account: f.accountName,
    bank: f.bankName,
    branch: f.bankBranch ?? '',
    type: f.accountType,
    liability: f.esPasivo,
    currency: f.currencyCode,
    gl_code: f.glAccount?.code ?? '',
    gl_name: f.glAccount?.name ?? '',
    clabe: identificador(f.clabe),
    account_number: identificador(f.accountNumber),
    iban: identificador(f.iban),
    routing_on_file: f.routingEnArchivo,
    sat_bank_code: f.satBankCode ?? '',
    swift: f.swiftCode ?? '',
    book_balance: f.saldoLibro,
    bank_balance: f.saldoBanco ?? '',
    difference: f.diferencia ?? '',
    last_reconciled: f.ultimaConciliacionAprobada ?? '',
    active: f.isActive,
    warnings: f.advertencias,
    id: f.id,
  };
}

const COLUMNAS_ESTADO = [
  'account', 'number', 'period', 'opening', 'closing', 'lines', 'chain',
] as const;

function estadoComoFila(s: ResumenEstadoDeCuenta): Row {
  return {
    account: s.cuenta,
    number: s.numeroDeEstado ?? '',
    period: `${s.periodoInicio}..${s.periodoFin}`,
    currency: s.moneda,
    opening: s.saldoInicial,
    closing: s.saldoFinal,
    lines: s.lineCount,
    stored: s.lineasEnBase,
    format: s.formato,
    profile: s.perfil ?? '',
    // El veredicto de la cadena de saldos se CALCULA al leer: `bank_statements`
    // no guarda ninguno, y un veredicto guardado envejece con cada import.
    chain: s.cadenaDeSaldos.cuadra ? 'ok' : s.cadenaDeSaldos.diferencia,
    imported: s.importadoEl,
    id: s.id,
  };
}

function hallazgoComoFila(h: HallazgoEstado, estado: string, cuenta: string): Row {
  return {
    statement: estado,
    account: cuenta,
    check: h.check,
    severity: h.severity,
    reference: h.referencia,
    detail: h.detalle,
  };
}

const COLUMNAS_MOVIMIENTO = [
  'date', 'amount', 'currency', 'type', 'description', 'counterparty', 'matched',
] as const;

function movimientoComoFila(m: RenglonMovimiento): Row {
  return {
    date: m.fecha,
    value_date: m.fechaValor ?? '',
    // El importe sale con los cuatro decimales de la columna. Recortarlo a dos
    // aquí es el defecto que F05a cazó tres veces.
    amount: m.importe,
    currency: m.moneda,
    type: m.tipo,
    description: m.descripcion ?? '',
    counterparty: m.contraparte ?? '',
    category: m.categoria ?? '',
    reference: m.referencia ?? '',
    account: m.cuenta,
    matched: m.cotejada,
    confidence: m.confianza ?? '',
    statement_id: m.statementId ?? '',
    imported: m.importadoEl,
    id: m.id,
  };
}

function fichaMovimientoComoFila(f: FichaMovimiento, crudo: boolean): Row {
  return {
    ...movimientoComoFila(f),
    entity_id: f.entityId,
    content_hash: f.contentHash,
    matched_at: f.cotejadoEl ?? '',
    matched_by: f.cotejadoPor ?? '',
    import_batch_id: f.loteId ?? '',
    statement_number: f.estadoDeCuenta?.numero ?? '',
    statement_period: f.estadoDeCuenta?.periodo ?? '',
    // Los campos que el catálogo promete normalizados y que nadie extrae aún.
    // Van como lista de nombres y no como cuatro columnas vacías: «no lo trae»
    // y «nadie lo ha buscado» son hechos distintos.
    unextracted_fields: [...CAMPOS_SIN_EXTRACTOR],
    // Anidados y no en un segundo `render`: un documento por invocación.
    matches: f.cotejos,
    ...(crudo ? { raw: f.crudo } : {}),
    id: f.id,
  };
}

const COLUMNAS_PARTIDA = ['date', 'entry', 'amount', 'description', 'age_days'] as const;

function partidaComoFila(p: PartidaDeLibros): Row {
  return {
    date: p.fecha,
    entry: p.entryNumber,
    amount: p.importe,
    description: p.descripcion,
    age_days: p.antiguedadDias,
    sealed: p.sellada,
    entry_id: p.entryId,
    id: p.lineId,
  };
}

/**
 * La descomposición, en columnas.
 *
 * NO es el desglose interno del puntaje: `findBestMatch` devuelve un escalar y
 * los pesos .45/.25/.30 se quedan dentro del motor. Lo que sí se puede afirmar
 * son los HECHOS de la pareja que el motor mira —cuánto difiere el importe,
 * cuántos días hay entre las fechas, cuánto se parecen los textos— más la
 * regla que disparó y el veredicto de cada compuerta. Es lo que hace revisable
 * una propuesta: quien la lee puede rehacer el juicio sin creerle al número.
 */
function previstoComoFila(p: MovimientoPrevisto): Row {
  const s = p.senales;
  const c = p.propuesta;
  return {
    date: p.fecha,
    amount: p.importe,
    description: p.descripcion ?? '',
    candidate_type: c?.tipo ?? '',
    candidate: c?.referencia ?? c?.id ?? '',
    candidate_amount: c?.importe ?? '',
    candidate_date: c?.fecha ?? '',
    // La confianza es un DECIMAL(3,2), no dinero: dos decimales es su
    // precisión completa y no un recorte.
    confidence: c ? c.confianza.toFixed(2) : '',
    rule: c?.regla ?? '',
    amount_diff: s?.diferenciaImporte ?? '',
    exact_amount: s ? s.importeExacto : '',
    same_direction: s ? s.mismaDireccion : '',
    days_apart: s ? s.diasDeDiferencia : '',
    within_window: s ? s.dentroDeVentana : '',
    description_similarity: s ? s.similitudDescripcion.toFixed(2) : '',
    period: p.periodo ? `${p.periodo.nombre} (${p.periodo.estado})` : '',
    applicable: p.aplicable,
    reason: p.motivo ?? '',
    id: p.txId,
  };
}

function aplicacionComoFilas(r: ResultadoAplicacion): Row[] {
  return [
    ...r.aplicados.map((a) => ({
      outcome: 'applied',
      transaction: a.txId,
      match: a.matchId,
      group: a.groupId,
      type: a.tipo,
      matched_entity: a.entidadId,
      amount: a.importe,
      confidence: a.confianza === null ? '' : a.confianza.toFixed(2),
      sealed: a.selloEscrito,
      id: a.matchId,
    })),
    // Un reintento tiene que poder ver que NO hizo falta, y con qué cotejo.
    ...r.yaAplicados.map((y) => ({
      outcome: 'already-applied',
      transaction: y.txId,
      match: y.matchId,
      group: '',
      type: '',
      matched_entity: '',
      amount: '',
      confidence: '',
      sealed: false,
      id: y.matchId,
    })),
    ...r.omitidos.map((o) => ({
      outcome: 'skipped',
      transaction: o.txId,
      match: '',
      group: '',
      type: '',
      matched_entity: '',
      amount: '',
      confidence: '',
      sealed: false,
      reason: o.motivo,
      id: o.txId,
    })),
  ];
}

/**
 * El puerto del lector, cableado.
 *
 * `bank-statement-service` recibe el lector por parámetro y no lo importa: así
 * el importador entero —dedupe, transacción, ensayo, las siete pruebas— se
 * ejercita sobre un extracto escrito a mano. El único sitio donde las dos
 * mitades se juntan es éste, y es una línea.
 */
const leerConParsers: LeerExtracto = ({ contenido, formato, perfil }) =>
  leerExtracto(contenido, { formato, perfil });

/** Los posicionales más `--dir`, sin repetidos y en orden estable. */
function archivosAImportar(posicionales: string[], dir: string | undefined): string[] {
  const candidatos = [...posicionales];
  if (dir !== undefined) {
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw usageError(`No se pudo leer --dir ${dir}: ${(err as Error).message}`);
    }
    const dentro = entradas
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name))
      .sort();
    if (dentro.length === 0) throw usageError(`--dir ${dir} no tiene archivos que importar.`);
    candidatos.push(...dentro);
  }
  if (candidatos.length === 0) {
    throw usageError('Qué archivo. Pásalo como argumento o apunta a un directorio con --dir.');
  }
  // La deduplicación por ruta absoluta NO es cosmética: `import extracto.csv
  // --dir .` nombraría el mismo archivo dos veces, y la segunda moriría contra
  // el UNIQUE(bank_account_id, file_sha256) de la 051 — un conflicto inventado
  // por la línea de órdenes que el operador tendría que ir a entender.
  return [...new Set(candidatos.map((c) => path.resolve(c)))];
}

/**
 * La entrada estándar, entera, como texto.
 *
 * Se escribe con eventos y no con `for await (const trozo of stdin)` porque
 * ahí el trozo llega tipado `any` y el archivo entero dejaría de compilar
 * limpio bajo las reglas de tipos; con `setEncoding` el manejador recibe
 * `string` y no hay ninguna aserción que revisar.
 */
function leerEntradaEstandar(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let texto = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (trozo: string) => {
      texto += trozo;
    });
    stdin.on('end', () => resolve(texto));
    stdin.on('error', (err: Error) => reject(err));
  });
}

export function registerBankCommand(program: Command, deps: BankCommandDeps): void {
  const bank = program
    .command('bank')
    .alias('banco')
    .description('Bank accounts and bank statements: master data and imported statements');

  /**
   * El manejador DEVUELVE su código y `run` lo cierra UNA vez.
   *
   * La forma heredada —`shutdown(4)` dentro del manejador y otro `shutdown(0)`
   * al volver— sólo funciona porque el `shutdown` real llama a `process.exit` y
   * nunca regresa. Contra un doble de prueba el segundo se ejecuta y el código
   * observado es 0: `bank statement check` informaría un extracto roto y el
   * guion que lo vigila lo leería como limpio.
   */
  /** Las advertencias van SIEMPRE a stderr, también en formato máquina. */
  const avisar = (mensajes: readonly string[]): void => {
    for (const m of mensajes) process.stderr.write(deps.palette.yellow(`  ${m}\n`));
  };

  /**
   * Ni `listBankAccounts` ni `listarEstadosDeCuenta` devuelven un total, así
   * que `render` no puede anunciar el truncado por su cuenta. Un `--limit` que
   * deja filas fuera EN SILENCIO es la falla que el contrato de salida nombra
   * primero: produce un estado financiero incompleto sin que nadie lo note.
   * Llegar justo al tope no demuestra que sobren filas, pero es la única señal
   * disponible, y decirla de más cuesta un renglón en stderr.
   */
  const avisarTope = (obtenidas: number, tope: number | undefined, comando: string): void => {
    if (tope !== undefined && obtenidas >= tope) {
      process.stderr.write(
        deps.palette.yellow(
          `Se listaron ${obtenidas} fila(s), que es el tope de --limit: puede haber más. ` +
            `Sube --limit, o usa --all en \`${comando}\`.\n`
        )
      );
    }
  };

  /**
   * `--offset` no se puede honrar: ninguno de los dos servicios pagina por
   * desplazamiento. Traer de más y recortar en JS daría un `--limit` que miente
   * sobre cuántas filas existen, así que se rechaza en voz alta.
   */
  const rechazarOffset = (opts: CommonOpts, alternativa: string): void => {
    if (opts.offset !== undefined) {
      throw usageError(
        `--offset no está implementado en esta familia: la consulta ordena y acota con --limit, ` +
          `sin cursor estable. ${alternativa}`
      );
    }
  };

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  /** Una escritura no adivina la entidad: la nombra o la tiene fijada. */
  const entityForWrite = async (opts: CommonOpts) => {
    // Inquilino PRIMERO: la resolución de entidad va acotada por RLS, así que
    // un --tenant aplicado después no resuelve nada.
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
  };

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(deps.palette.cyan(`${question} [y/N] `)).catch(() => '');
      return /^y(es)?$/i.test((answer ?? '').trim());
    } finally {
      rl.close();
    }
  };

  /** Cede la ficha escrita a mano en cuanto el usuario pide otra forma. */
  const legible = (opts: CommonOpts): boolean =>
    !opts.json &&
    (opts.format ?? 'table') === 'table' &&
    !opts.quiet &&
    opts.output === undefined &&
    opts.fields === undefined;

  const account = bank
    .command('account')
    .alias('cuenta')
    .description('Bank accounts as master data: identifiers, currency and the 1:1 GL mapping');

  const statement = bank
    .command('statement')
    .alias('estado-cuenta')
    .description('Bank statements as documents: import, inspect and check their integrity');

  // ---- bank account create -----------------------------------------
  const create = account
    .command('create')
    .alias('crear')
    .argument('<name>', 'name this account is known by inside the books')
    .description(
      'Register a bank account, validating the CLABE check digit, the ABA routing checksum, ' +
        'the currency against the GL account and the 1:1 mapping'
    );
  withContext(create);
  create
    .requiredOption('--bank <name>', 'name of the institution')
    .requiredOption('--gl-account <code>', 'GL account this bank account maps to, 1:1 (code or id)')
    .requiredOption('--currency <code>', '3-letter ISO code; must equal the GL account currency')
    .option(
      `--type <${TIPOS_DE_CUENTA.join('|')}>`,
      'account nature; credit-card is a LIABILITY and maps to a liability GL account',
      'checking'
    )
    .option('--clabe <18 digits>', 'CLABE; stored encrypted, only the last 4 are ever shown')
    .option('--account-number <number>', 'account number; stored encrypted')
    .option('--routing-ach <9 digits>', 'ABA routing number for ACH')
    .option('--routing-wire <9 digits>', 'ABA routing number for wires')
    .option('--sat-bank-code <ccc>', 'SAT c_Banco key; derived from the CLABE when omitted')
    .option('--branch <text>', 'branch')
    .option('--swift <code>', 'SWIFT/BIC')
    .option('--iban <code>', 'IBAN')
    .option('--dry-run', 'run every validation and the insert, then roll it back')
    .option('--json', 'JSON output');
  declareRisk(create, {
    risk: 'escritura',
    agent: false,
    writes: 'bank_accounts (con clabe_encrypted / account_number_encrypted)',
  });
  create.action(
    (
      nombre: string,
      opts: CommonOpts & {
        bank: string; glAccount: string; currency: string; type?: string;
        clabe?: string; accountNumber?: string; routingAch?: string; routingWire?: string;
        satBankCode?: string; branch?: string; swift?: string; iban?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(create, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await createBankAccount(
          entityScope(ctx.tenantId, ctx.entityId),
          {
            accountName: nombre,
            bankName: opts.bank,
            glAccount: opts.glAccount,
            currencyCode: opts.currency,
            accountType: opts.type ? exigirTipo(opts.type) : undefined,
            clabe: opts.clabe ?? null,
            accountNumber: opts.accountNumber ?? null,
            routingAch: opts.routingAch ?? null,
            routingWire: opts.routingWire ?? null,
            satBankCode: opts.satBankCode ?? null,
            bankBranch: opts.branch ?? null,
            swiftCode: opts.swift ?? null,
            iban: opts.iban ?? null,
          },
          { userId: reviewer.userId, dryRun }
        );

        if (opts.json) {
          render([fichaComoFila(r.cuenta, false)], { json: true, idField: 'id' });
        } else {
          const p = deps.palette;
          const gl = r.cuenta.glAccount;
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.cuenta.accountName)} ` +
              `${p.dim(
                `· ${r.cuenta.bankName} · ${r.cuenta.accountType} · ${r.cuenta.currencyCode}` +
                  (gl ? ` · ${gl.code} ${gl.name}` : '') +
                  (r.cuenta.clabe ? ` · CLABE ${r.cuenta.clabe}` : '')
              )}\n`
          );
        }
        avisar(r.advertencias);
        if (dryRun) {
          process.stderr.write(
            deps.palette.yellow(
              '  Ensayo: el alta se ejecutó de verdad —índice único incluido— y se deshizo. Nada quedó escrito.\n'
            )
          );
        }
      })
  );

  // ---- bank account list -------------------------------------------
  const list = account
    .command('list')
    .alias('listar')
    .argument('[query]', 'match against the account name or the bank name')
    .description(
      'List the accounts with currency, type, GL account, book balance and the last approved reconciliation'
    );
  withOutput(withSelection(withContext(list)));
  list
    .option(`--type <${TIPOS_DE_CUENTA.join('|')}>`, 'only accounts of this nature')
    .option('--currency <code>', 'only accounts in this currency')
    .option(
      '--all-entities',
      "every entity of the tenant, for a firm's overview; still bounded inside the SQL"
    );
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action(
    (busqueda: string | undefined, opts: CommonOpts & { type?: string; currency?: string; allEntities?: boolean }) =>
      run(async () => {
        rechazarOffset(opts, 'Acota con [query], --type o --currency, o pide todo con --all.');
        const ctx = await entityOf(opts);
        // El alcance de inquilino sigue yendo DENTRO del SQL —`entity_id IN
        // (SELECT id FROM legal_entities WHERE tenant_id = $1)`—, nunca
        // filtrando en JS después de traer de más.
        const scope: Scope = opts.allEntities
          ? tenantScope(ctx.tenantId)
          : entityScope(ctx.tenantId, ctx.entityId);

        const tope = opts.all ? undefined : (opts.limit ?? 50);
        const filas = await listBankAccounts(scope, {
          search: busqueda,
          accountType: opts.type ? exigirTipo(opts.type) : undefined,
          currencyCode: opts.currency,
          isActive: estadoDeCuenta(opts.status, opts.all),
          limit: tope,
        });

        render(filas.map(renglonComoFila), {
          ...opts,
          idField: 'id',
          numeric: ['book_balance', 'bank_balance'],
          fields: opts.fields ?? (filas.length ? COLUMNAS_CUENTA.join(',') : undefined),
        });
        avisarTope(filas.length, tope, 'bank account list');
      })
  );

  // ---- bank account show -------------------------------------------
  const show = account
    .command('show')
    .alias('ver')
    .argument('<account>', 'account name or id')
    .description(
      'Show one account: masked identifiers, SAT bank key, book vs bank balance and the reconciliation anchor'
    );
  withOutput(withContext(show));
  show.option(
    '--redacted',
    'drop even the last 4 digits of the identifiers, for a shared screen'
  );
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((ref: string, opts: CommonOpts & { redacted?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const f = await getBankAccount(entityScope(ctx.tenantId, ctx.entityId), ref);
      const redactado = opts.redacted === true;

      if (!legible(opts)) {
        render([fichaComoFila(f, redactado)], { ...opts, idField: 'id' });
      } else {
        const p = deps.palette;
        const out = process.stdout;
        out.write(
          `\n${p.bold(f.accountName)} ${p.dim(
            `· ${f.bankName}${f.bankBranch ? ` (${f.bankBranch})` : ''} · ${f.accountType}` +
              `${f.esPasivo ? ' · PASIVO' : ''} · ${f.currencyCode}`
          )}\n\n`
        );
        const linea = (etiqueta: string, valor: string) => {
          if (valor !== '') out.write(`  ${p.dim(etiqueta.padEnd(24))}${valor}\n`);
        };
        // El renglón desaparece cuando el dato NO EXISTE, y dice `(redacted)`
        // cuando existe y se está ocultando: son dos cosas distintas.
        const identificador = (valor: string | null): string =>
          valor === null ? '' : redactado ? p.dim(OCULTO) : valor;
        linea('CLABE', identificador(f.clabe));
        linea('Account number', identificador(f.accountNumber));
        linea('IBAN', identificador(f.iban));
        linea('Routing', f.routingEnArchivo ? 'on file (encrypted)' : '');
        linea('SAT bank key', f.satBankCode ?? '');
        linea('SWIFT/BIC', f.swiftCode ?? '');
        linea('GL account', f.glAccount ? `${f.glAccount.code} ${f.glAccount.name}` : p.red('unmapped'));
        out.write('\n');
        linea('Book balance', f.saldoLibro);
        linea('Bank balance', f.saldoBanco ?? p.dim('never synced'));
        linea('Difference', f.diferencia ?? '');
        linea('Last reconciled', f.ultimaConciliacionAprobada ?? p.dim('never'));
        linea('Status', f.isActive ? 'active' : 'archived');
        out.write('\n');
        // Ni firmantes ni límites: no hay columnas ni tablas para ninguno de
        // los dos (`bank signer` y `bank limit` son fase 3). Se omiten en vez
        // de inventarles una forma vacía que luego habría que migrar.
      }
      avisar(f.advertencias);
    })
  );

  // ---- bank account edit -------------------------------------------
  const edit = account
    .command('edit')
    .alias('editar')
    .argument('<account>', 'account name or id')
    .description('Change master data, recording the before and after field by field');
  withContext(edit);
  edit
    .option('--name <text>', 'new account name')
    .option('--bank <name>', 'new institution name')
    .option('--branch <text>', 'branch; empty clears it')
    .option(`--type <${TIPOS_DE_CUENTA.join('|')}>`, 'account nature')
    .option('--currency <code>', 'currency; re-checked against the GL account')
    .option('--clabe <18 digits>', 'CLABE; requires --reason. Empty clears it')
    .option('--account-number <number>', 'account number; requires --reason. Empty clears it')
    .option('--routing-ach <9 digits>', 'ABA routing for ACH; requires --reason. Empty clears it')
    .option('--routing-wire <9 digits>', 'ABA routing for wires; requires --reason. Empty clears it')
    .option('--sat-bank-code <ccc>', 'SAT c_Banco key; empty clears it')
    .option('--swift <code>', 'SWIFT/BIC; empty clears it')
    .option('--iban <code>', 'IBAN; empty clears it')
    .option('--reason <text>', 'justification recorded in the audit trail; required for identifiers')
    .option('--dry-run', 'apply the change and roll it back, showing what would differ')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'JSON output');
  // El catálogo (fila 1140) clasifica esta hoja `irreversible` y pide además
  // `--idempotency-key` y una SEGUNDA APROBACIÓN de otro usuario. Se declara
  // `escritura` porque es lo que la orden de este tramo comete, y las dos
  // diferencias quedan dichas aquí en vez de calladas: no hay clave de
  // idempotencia —no la habría cómo honrar sin `idempotency_keys` en la ruta, y
  // una bandera aceptada y no leída es peor que ninguna— y no hay segunda
  // firma, porque no existe tabla donde registrarla. Lo que sí hay: `--reason`
  // obligatorio para los tres identificadores, bitácora campo por campo con el
  // antes y el después ENMASCARADOS, y una confirmación cuando el dato que
  // cambia es aquel por el que sale el dinero.
  declareRisk(edit, {
    risk: 'escritura',
    agent: false,
    writes: 'bank_accounts + audit_log (campo por campo, con los identificadores enmascarados)',
  });
  edit.action(
    (
      ref: string,
      opts: CommonOpts & {
        name?: string; bank?: string; branch?: string; type?: string; currency?: string;
        clabe?: string; accountNumber?: string; routingAch?: string; routingWire?: string;
        satBankCode?: string; swift?: string; iban?: string;
        reason?: string; dryRun?: boolean; yes?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(edit, opts as unknown as Record<string, unknown>);

        const patch: ParcheCuenta = {};
        if (opts.name !== undefined) patch.accountName = opts.name;
        if (opts.bank !== undefined) patch.bankName = opts.bank;
        if (opts.branch !== undefined) patch.bankBranch = opcionalNulo(opts.branch) ?? null;
        if (opts.type !== undefined) patch.accountType = exigirTipo(opts.type);
        if (opts.currency !== undefined) patch.currencyCode = opts.currency;
        if (opts.satBankCode !== undefined) patch.satBankCode = opcionalNulo(opts.satBankCode) ?? null;
        if (opts.swift !== undefined) patch.swiftCode = opcionalNulo(opts.swift) ?? null;
        if (opts.iban !== undefined) patch.iban = opcionalNulo(opts.iban) ?? null;

        const sensibles: string[] = [];
        if (opts.clabe !== undefined) {
          patch.clabe = opcionalNulo(opts.clabe) ?? null;
          sensibles.push('--clabe');
        }
        if (opts.accountNumber !== undefined) {
          patch.accountNumber = opcionalNulo(opts.accountNumber) ?? null;
          sensibles.push('--account-number');
        }
        if (opts.routingAch !== undefined) {
          patch.routingAch = opcionalNulo(opts.routingAch) ?? null;
          sensibles.push('--routing-ach');
        }
        if (opts.routingWire !== undefined) {
          patch.routingWire = opcionalNulo(opts.routingWire) ?? null;
          sensibles.push('--routing-wire');
        }

        if (Object.keys(patch).length === 0) {
          throw usageError(
            'Nada que cambiar. Pasa --name, --bank, --branch, --type, --currency, --clabe, ' +
              '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift o --iban.'
          );
        }
        // El servicio también lo exige, y ahí es una ValidationError (4). Aquí
        // se adelanta como error de USO (2), que es lo que de verdad pasó:
        // falta una bandera, no falla una regla contable.
        if (sensibles.length && !opts.reason?.trim()) {
          throw usageError(
            `${sensibles.join(', ')} cambia uno de los identificadores por los que sale el dinero ` +
              `(${CAMPOS_SENSIBLES.join(', ')}): exige --reason "<por qué>". El motivo se guarda en la ` +
              'bitácora, que es append-only.'
          );
        }
        if (sensibles.length && !dryRun && opts.yes !== true) {
          const ok = await ask(
            `Vas a cambiar ${sensibles.join(', ')} de "${ref}". ¿Continuar?`
          );
          if (!ok) throw abortedByUser('Sin cambios.');
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const r = await updateBankAccount(entityScope(ctx.tenantId, ctx.entityId), ref, patch, {
          userId: reviewer.userId,
          reason: opts.reason ?? null,
          dryRun,
        });

        if (opts.json) {
          render(
            r.cambios.map((c) => ({ field: c.campo, before: c.antes, after: c.despues })),
            { json: true, idField: 'field' }
          );
        } else if (r.cambios.length === 0) {
          process.stderr.write(deps.palette.dim('  Nada cambió: los valores ya eran esos.\n'));
        } else {
          const p = deps.palette;
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.cuenta.accountName)} ` +
              `${p.dim(`· ${r.cambios.length} campo(s)`)}\n`
          );
          render(
            r.cambios.map((c) => ({ field: c.campo, before: c.antes, after: c.despues })),
            { format: 'table', idField: 'field' }
          );
        }
        avisar(r.advertencias);
        if (dryRun) {
          process.stderr.write(
            deps.palette.yellow('  Ensayo: el UPDATE corrió de verdad y se deshizo.\n')
          );
        }
      })
  );

  // ---- bank account set --------------------------------------------
  const set = account
    .command('set')
    .alias('fijar')
    .argument('<account>', 'account name or id')
    .description('Write the 1:1 GL mapping, refusing the change when the old account has posted entries');
  withContext(set);
  withForce(set);
  set
    .requiredOption('--gl-account <code>', 'GL account to map to (code or id)')
    .option('--reason <text>', 'justification recorded in the audit trail; required by --force')
    .option('--dry-run', 'apply the remap and roll it back')
    .option('--json', 'JSON output');
  declareRisk(set, {
    risk: 'escritura',
    agent: false,
    writes: 'bank_accounts.gl_account_id + audit_log',
  });
  set.action(
    (ref: string, opts: CommonOpts & { glAccount: string; reason?: string; force?: boolean; dryRun?: boolean }) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        // La compuerta es la que exige --reason con --force: ese es exactamente
        // su trabajo, y duplicar la comprobación aquí sería la segunda copia
        // que diverge en la primera prisa.
        const { dryRun, reason } = gateMutation(set, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await setBankGlMapping(
          entityScope(ctx.tenantId, ctx.entityId),
          ref,
          opts.glAccount,
          { userId: reviewer.userId, reason: reason ?? null, force: opts.force === true, dryRun }
        );

        if (opts.json) {
          render(
            [
              {
                account: r.cuenta.accountName,
                previous: r.anterior ? `${r.anterior.code} ${r.anterior.name}` : '',
                current: `${r.nueva.code} ${r.nueva.name}`,
                posted_lines: r.movimientosPosteados,
                forced: r.forzado,
                changed: r.cambio,
                dry_run: r.dryRun,
                id: r.cuenta.id,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          const p = deps.palette;
          if (!r.cambio) {
            process.stderr.write(
              p.dim(`  ${r.cuenta.accountName} ya estaba mapeada a ${r.nueva.code}: nada que escribir.\n`)
            );
          } else {
            process.stdout.write(
              `${r.dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.cuenta.accountName)} ` +
                `${p.dim(
                  `· ${r.anterior ? `${r.anterior.code} → ` : ''}${r.nueva.code} ${r.nueva.name}` +
                    (r.forzado ? ` · FORZADO sobre ${r.movimientosPosteados} línea(s) contabilizada(s)` : '')
                )}\n`
            );
          }
        }
        avisar(r.advertencias);
      })
  );

  // ---- bank statement import ---------------------------------------
  const importar = statement
    .command('import')
    .alias('importar')
    .argument('<file...>', 'statement files; combine with --dir to take a whole folder')
    .description(
      'Parse, normalize and stage a bank statement, deduplicating by native id or content hash; ' +
        'posts NOTHING to the ledger'
    );
  withContext(importar);
  importar
    .requiredOption('--account <ref>', 'bank account these statements belong to (name or id)')
    .option(
      `--format <${FORMATOS_DEL_CATALOGO.map((f) => f.nombre).join('|')}>`,
      'format of the FILE (not of the output; use --json for that); sniffed from the content when omitted'
    )
    .option('--profile <name>', 'CSV column profile to read the file with')
    .option('--dir <path>', 'import every file in this folder as well')
    .option(
      '--closing-balance <amount>',
      'closing balance you assert, for a format that carries none (a CSV); refused if the file says otherwise'
    )
    .option('--dry-run', 'parse, run the seven checks and roll the write back')
    .option('--json', 'JSON output');
  // ESCRITURA + IA ✓, y `declareRisk` sólo lo admite con `draftOnly`. Aquí es
  // HONESTO y no una concesión: todo lo que este comando escribe es staging
  // bancario (`bank_statements`, `bank_transactions`) y no hay camino desde
  // aquí al mayor por ninguna bandera. El asiento nace en el cotejo y en la
  // conciliación, que son otros verbos con otra aprobación humana. Es lo que
  // la fila 1161 del catálogo promete en negritas, y la razón por la que el
  // agente puede traer un extracto sin que nadie lo autorice: lo peor que
  // puede hacer es dejar un documento que un humano tendrá que mirar.
  declareRisk(importar, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes: 'bank_statements y bank_transactions (staging bancario); NUNCA journal_entries',
  });
  importar.action(
    (
      archivos: string[],
      opts: CommonOpts & {
        account: string; format?: string; profile?: string; dir?: string;
        closingBalance?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(importar, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const rutas = archivosAImportar(archivos, opts.dir);
        const cuenta = await resolverCuentaBancaria(ctx.entityId, opts.account);

        const hechos: ResultadoImportacion[] = [];
        const fallidos: Array<{ archivo: string; err: unknown }> = [];
        for (const ruta of rutas) {
          try {
            hechos.push(
              await importarEstadoDeCuenta(
                { entityId: ctx.entityId, userId: reviewer.userId, bankAccountId: cuenta.id, ruta },
                {
                  formato: opts.format,
                  perfil: opts.profile,
                  saldoFinalEsperado: opts.closingBalance
                    ? exigirImporte('--closing-balance', opts.closingBalance)
                    : undefined,
                  dryRun,
                  leer: leerConParsers,
                }
              )
            );
          } catch (err) {
            // Un solo archivo se comporta como cualquier otro comando: el error
            // sube y su código de salida es el suyo (un duplicado es 6, no 1).
            // Con varios eso no cabe, así que se informan TODOS y se sale con el
            // código del primero: un lote a medias que saliera 0 escondería
            // justo lo que hay que ir a mirar.
            if (rutas.length === 1) throw err;
            fallidos.push({ archivo: path.basename(ruta), err });
          }
        }

        const p = deps.palette;
        if (opts.json) {
          render(
            hechos.map((r) => ({
              statement_id: r.statementId,
              file: r.archivo,
              sha256: r.sha256,
              format: r.formato,
              profile: r.perfil ?? '',
              account: r.cuenta.nombre,
              number: r.numeroDeEstado ?? '',
              period: `${r.periodoInicio}..${r.periodoFin}`,
              currency: r.moneda,
              opening: r.saldoInicial,
              closing: r.saldoFinal,
              read: r.lineasLeidas,
              imported: r.importadas,
              duplicated: r.duplicadas,
              findings: r.hallazgos.length,
              dry_run: r.ensayo,
            })),
            { json: true, idField: 'statement_id' }
          );
        } else {
          for (const r of hechos) {
            process.stdout.write(
              `${r.ensayo ? p.yellow('◑') : p.green('✔')} ${p.bold(r.archivo)} ` +
                `${p.dim(
                  `· ${r.cuenta.nombre} · ${r.periodoInicio}..${r.periodoFin} · ` +
                    `${r.saldoInicial} → ${r.saldoFinal} ${r.moneda} · ` +
                    `${r.importadas} nueva(s), ${r.duplicadas} ya estaba(n)`
                )}\n`
            );
          }
        }

        for (const r of hechos) {
          avisar(r.avisos);
          if (r.hallazgos.length) {
            process.stderr.write(
              p.yellow(
                `  ${r.archivo}: ${r.hallazgos.length} hallazgo(s) de integridad. ` +
                  `Están en staging igual — es \`bank statement check\` quien sale 4.\n`
              )
            );
            for (const h of r.hallazgos) {
              process.stderr.write(`    ${h.severity === 'blocking' ? p.red('✘') : p.yellow('!')} ${h.check}: ${h.detalle}\n`);
            }
          }
        }
        if (dryRun) {
          process.stderr.write(
            p.yellow('  Ensayo: se parseó, se verificó y la escritura se deshizo.\n')
          );
        }
        process.stderr.write(
          p.dim('  Staging bancario: nada de esto está en el mayor hasta que se cotee y se concilie.\n')
        );

        if (fallidos.length) {
          for (const f of fallidos) {
            process.stderr.write(`${p.red('✘')} ${f.archivo}: ${(f.err as Error).message}\n`);
          }
          return exitCodeFor(fallidos[0].err);
        }
      })
  );

  // ---- bank statement list -----------------------------------------
  const statementList = statement
    .command('list')
    .alias('listar')
    .description(
      'List imported statements by account and period, with opening and closing balance, line count and the balance chain'
    );
  withOutput(withSelection(withContext(statementList)));
  // `--since`/`--until` sueltas y no con `withTime()`: el grupo entero arrastra
  // `--period`, `--as-of` y `--date-basis`, y un estado de cuenta no tiene base
  // de fecha que elegir —su fecha ES su periodo—. Declarar cinco banderas para
  // rechazar tres es peor superficie que declarar dos; el diccionario gobierna
  // la grafía y la forma corta (ninguna), no el grupo. Mismo criterio que
  // `ap reconcile` con `--as-of`.
  statementList
    .option('--account <ref>', 'only this bank account (name or id)')
    .option('--since <date>', 'statements whose period ENDS on or after this date (YYYY-MM-DD)')
    .option('--until <date>', 'statements whose period STARTS on or before this date (YYYY-MM-DD)');
  declareRisk(statementList, { risk: 'lectura', agent: true });
  statementList.action((opts: CommonOpts & { account?: string; since?: string; until?: string }) =>
    run(async () => {
      rechazarOffset(opts, 'Acota con --account, --since o --until.');
      // Un estado de cuenta no tiene ciclo de vida: su único veredicto —la
      // cadena de saldos— se CALCULA al leerlo y vive en la columna `chain`.
      // Aceptar `-s` en silencio haría creer que se filtró por algo.
      if (opts.status?.length) {
        throw usageError(
          '-s/--status no aplica a un estado de cuenta: no tiene estado de ciclo de vida. ' +
            'Su veredicto se calcula al leerlo (columna `chain`), y quien lo juzga es ' +
            '`bank statement check`, que sale 4.'
        );
      }
      const ctx = await entityOf(opts);
      const tope = opts.all ? 500 : (opts.limit ?? 50);
      const filas = await listarEstadosDeCuenta(ctx.entityId, {
        account: opts.account,
        since: opts.since ? exigirFecha('--since', opts.since) : undefined,
        until: opts.until ? exigirFecha('--until', opts.until) : undefined,
        limit: tope,
      });

      render(filas.map(estadoComoFila), {
        ...opts,
        idField: 'id',
        numeric: ['opening', 'closing', 'lines', 'stored'],
        fields: opts.fields ?? (filas.length ? COLUMNAS_ESTADO.join(',') : undefined),
      });
      avisarTope(filas.length, tope, 'bank statement list');

      const rotas = filas.filter((s) => !s.cadenaDeSaldos.cuadra);
      if (rotas.length) {
        process.stderr.write(
          deps.palette.yellow(
            `${rotas.length} estado(s) con la cadena de saldos rota. ` +
              '`bank statement check` dice cuál prueba falló y sale 4.\n'
          )
        );
      }
    })
  );

  // ---- bank statement show -----------------------------------------
  const statementShow = statement
    .command('show')
    .alias('ver')
    .argument('<id>', 'statement id')
    .description(
      'Show one statement: electronic sequence number, date range, hash of the original file and the profile applied'
    );
  withOutput(withContext(statementShow));
  statementShow
    .option('--lines', 'include the statement lines')
    .option('-n, --limit <n>', 'maximum lines to list with --lines (default 500)', enteroPositivo('--limit'));
  declareRisk(statementShow, { risk: 'lectura', agent: true });
  statementShow.action((id: string, opts: CommonOpts & { lines?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const d = await obtenerEstadoDeCuenta(ctx.entityId, id, {
        lineas: opts.lines === true,
        limiteLineas: opts.limit,
      });

      const cabecera: Row = {
        ...estadoComoFila(d),
        entity_id: d.entityId,
        file: d.archivo ?? '',
        sha256: d.sha256,
        imported_by: d.importadoPor,
        chain_sum: d.cadenaDeSaldos.suma,
        chain_expected: d.cadenaDeSaldos.esperado,
        chain_difference: d.cadenaDeSaldos.diferencia,
        // Las líneas van ANIDADAS y no en un segundo `render`: dos llamadas
        // escribirían dos sobres JSON pegados en stdout, y eso no es JSON. Un
        // documento por invocación, siempre.
        ...(d.lineas ? { lines: d.lineas, lines_omitted: d.lineasOmitidas } : {}),
      };

      if (!legible(opts)) {
        render([cabecera], { ...opts, idField: 'id' });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(d.numeroDeEstado ?? d.id)} ${p.dim(
          `· ${d.cuenta} · ${d.periodoInicio}..${d.periodoFin} · ${d.formato}` +
            (d.perfil ? ` (${d.perfil})` : '')
        )}\n\n`
      );
      const linea = (etiqueta: string, valor: string) =>
        out.write(`  ${p.dim(etiqueta.padEnd(22))}${valor}\n`);
      linea('Opening', `${d.saldoInicial} ${d.moneda}`);
      linea('Closing', `${d.saldoFinal} ${d.moneda}`);
      linea('Lines (document)', String(d.lineCount));
      linea('Lines (stored)', String(d.lineasEnBase));
      linea('File', d.archivo ?? '—');
      linea('sha256', d.sha256);
      linea('Imported', d.importadoEl);
      out.write(
        d.cadenaDeSaldos.cuadra
          ? `\n${p.green('✔')} Balance chain closes.\n`
          : `\n${p.red('✘')} Balance chain off by ${p.bold(d.cadenaDeSaldos.diferencia)}: ` +
            `${d.saldoInicial} + ${d.cadenaDeSaldos.suma} = ${d.cadenaDeSaldos.esperado}, ` +
            `document says ${d.cadenaDeSaldos.declarado}.\n`
      );
      if (d.lineCount !== d.lineasEnBase) {
        process.stderr.write(
          p.yellow(
            `  El documento trae ${d.lineCount} línea(s) y la base le atribuye ${d.lineasEnBase}: ` +
              'las que faltan se dedujeron contra un estado anterior y conservan el statement_id de aquél.\n'
          )
        );
      }
      if (d.lineas) {
        out.write(`\n${p.bold('Lines')} ${p.dim(`(${d.lineas.length})`)}\n`);
        render(d.lineas as unknown as Row[], {
          format: 'table',
          idField: 'id',
          numeric: ['importe'],
          fields: 'fecha,fechaValor,tipo,importe,descripcion,referencia,cotejada',
        });
        if (d.lineasOmitidas > 0) {
          process.stderr.write(
            p.yellow(`  ${d.lineasOmitidas} línea(s) más no se listaron. Sube --limit.\n`)
          );
        }
      }
    })
  );

  // ---- bank statement check ----------------------------------------
  const check = statement
    .command('check')
    .alias('verificar')
    .argument('[id]', 'one statement; without it, the latest of each account')
    .description('Run the seven integrity checks and EXIT 4 naming which one broke');
  withStrict(withOutput(withContext(check)));
  check
    .option(
      '--check [names]',
      `comma-separated checks to run; bare --check lists them (${STATEMENT_CHECK_NAMES.join(', ')})`
    )
    .option('-a, --all', 'every statement of the entity, not just the latest per account')
    .option('--account <ref>', 'every statement of this bank account (name or id)')
    .option('--since <date>', 'only statements whose period ends on or after this date (YYYY-MM-DD)');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.action(
    (id: string | undefined, opts: CommonOpts & { check?: string | boolean; account?: string; since?: string }) =>
      run(async () => {
        // `--check` a secas es el catálogo de la batería y no toca la base: la
        // pregunta «¿qué se puede verificar?» no debería costar una conexión.
        if (opts.check === true) {
          render(
            STATEMENT_CHECK_NAMES.map((n) => ({ check: n })),
            { ...opts, idField: 'check' }
          );
          return;
        }
        const ctx = await entityOf(opts);
        const r = await verificarEstadosDeCuenta(ctx.entityId, id, {
          checks: typeof opts.check === 'string' ? opts.check.split(',') : undefined,
          account: opts.account,
          since: opts.since ? exigirFecha('--since', opts.since) : undefined,
          all: opts.all === true,
        });

        const p = deps.palette;
        const filas = r.estados.flatMap((e) =>
          e.hallazgos.map((h) => hallazgoComoFila(h, e.numeroDeEstado ?? e.id, e.cuenta))
        );

        if (!legible(opts)) {
          render(filas, { ...opts, idField: 'reference' });
        } else {
          const out = process.stdout;
          out.write(
            `\n${p.bold('Statement integrity')} ${p.dim(
              `· ${r.estados.length} statement(s) · ${r.checks.length} check(s): ${r.checks.join(', ')}`
            )}\n\n`
          );
          for (const e of r.estados) {
            const roto = e.hallazgos.some((h) => h.severity === 'blocking');
            out.write(
              `  ${roto ? p.red('✘') : e.hallazgos.length ? p.yellow('!') : p.green('✔')} ` +
                `${p.bold(e.numeroDeEstado ?? e.id)} ${p.dim(`· ${e.cuenta} · ${e.periodoInicio}..${e.periodoFin}`)}\n`
            );
            for (const h of e.hallazgos) {
              out.write(
                `      ${h.severity === 'blocking' ? p.red('blocking') : p.yellow('warning ')} ` +
                  `${p.bold(h.check)} — ${h.detalle}\n`
              );
            }
          }
          out.write(
            r.cuadra
              ? `\n${p.green('✔')} ${r.advertencias} warning(s), no blocking finding.\n`
              : `\n${p.red('✘')} ${r.bloqueantes} blocking finding(s) and ${r.advertencias} warning(s).\n`
          );
        }

        if (r.omitidos > 0) {
          process.stderr.write(
            p.yellow(
              `\n${r.omitidos} estado(s) más cumplían el filtro y no se verificaron: la corrida tiene tope. ` +
                'Acota con --account o con --since.\n'
            )
          );
        }
        // 4 es «encontré algo», no «fallé»: es lo que permite que esto entre en
        // un guion de cierre sin envolverlo. Un check que NO PUDO correr sale
        // 1/2/3, nunca 4, y de eso se encargan los errores que suben.
        return checkExitCode(
          { blocking: r.bloqueantes, warning: r.advertencias },
          { strict: opts.strict === true }
        );
      })
  );

  // ============================================================
  // F05b · LOS DOS LADOS Y EL COTEJO
  // ============================================================

  const transaction = bank
    .command('transaction')
    .alias('movimiento')
    .description('Bank transactions: what the bank says happened, before anyone explains it');

  const bookItem = bank
    .command('book-item')
    .alias('partida-libros')
    .description('The other side: posted journal lines against the bank GL account, still unsealed');

  const match = bank
    .command('match')
    .alias('cotejo')
    .description('Matching a bank transaction to what the books already say about it');

  // ---- bank transaction list ---------------------------------------
  const txList = transaction
    .command('list')
    .alias('listar')
    .argument(
      '[query]',
      'hledger-style terms: desc:<text>, amt:[>|<|>=|<=]<amount>; a bare word means desc:'
    )
    .description(
      'List bank transactions filtered by account, date range, direction, amount, text, type and match state'
    );
  withOutput(withSelection(withContext(txList)));
  txList
    .option('--account <ref>', 'only this bank account (name or id)')
    .option('--since <date>', 'transactions on or after this date (YYYY-MM-DD)')
    .option('--until <date>', 'transactions on or before this date (YYYY-MM-DD)')
    .option('--unmatched', 'only transactions with no live match; shorthand for -s unmatched')
    .option('--direction <in|out>', 'money in (positive amount) or out (negative amount)')
    .option(
      `--type <${TIPOS_DE_MOVIMIENTO.join('|')}>`,
      'transaction nature as the bank classified it (not its direction)'
    );
  declareRisk(txList, { risk: 'lectura', agent: true });
  txList.action(
    (
      consulta: string | undefined,
      opts: CommonOpts & { account?: string; since?: string; until?: string; unmatched?: boolean; direction?: string; type?: string }
    ) =>
      run(async () => {
        const ctx = await entityOf(opts);
        // A diferencia de las otras dos listas de la familia, ésta SÍ pagina por
        // desplazamiento: su consulta la escribe este tramo y ordena por fecha
        // con el id de desempate, así que `--offset` significa algo y no hay
        // razón para rechazarlo.
        const q = consulta ? consultaDeMovimientos(consulta) : undefined;
        const tope = opts.all ? 1000 : (opts.limit ?? 50);

        const filas = await listarMovimientos(ctx.entityId, {
          account: opts.account,
          since: opts.since ? exigirFecha('--since', opts.since) : undefined,
          until: opts.until ? exigirFecha('--until', opts.until) : undefined,
          cotejada: estadoDeCotejo(opts.status, opts.unmatched),
          direccion: opts.direction ? exigirDireccion(opts.direction) : undefined,
          tipo: opts.type ? exigirTipoDeMovimiento(opts.type) : undefined,
          texto: q?.texto,
          importes: q?.importes,
          limit: tope,
          offset: opts.offset,
        });

        render(filas.map(movimientoComoFila), {
          ...opts,
          idField: 'id',
          numeric: ['amount', 'confidence'],
          fields: opts.fields ?? (filas.length ? COLUMNAS_MOVIMIENTO.join(',') : undefined),
        });
        avisarTope(filas.length, tope, 'bank transaction list');
      })
  );

  // ---- bank transaction show ---------------------------------------
  const txShow = transaction
    .command('show')
    .alias('ver')
    .argument('<id>', 'transaction id')
    .description(
      'Show one transaction: the normalized line, the statement it came from and the live matches that explain it'
    );
  withOutput(withContext(txShow));
  txShow.option(
    '--raw',
    'include raw_data exactly as the bank published it; it can carry the counterparty in the clear'
  );
  declareRisk(txShow, { risk: 'lectura', agent: true });
  txShow.action((id: string, opts: CommonOpts & { raw?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const crudo = opts.raw === true;
      const m = await obtenerMovimiento(ctx.entityId, id, { crudo });

      if (!legible(opts)) {
        render([fichaMovimientoComoFila(m, crudo)], { ...opts, idField: 'id' });
      } else {
        const p = deps.palette;
        const out = process.stdout;
        out.write(
          `\n${p.bold(m.importe)} ${p.dim(
            `${m.moneda} · ${m.fecha} · ${m.cuenta} · ${m.tipo}` +
              (m.cotejada ? '' : ` · ${p.yellow('sin cotejar')}`)
          )}\n\n`
        );
        const linea = (etiqueta: string, valor: string) => {
          if (valor !== '') out.write(`  ${p.dim(etiqueta.padEnd(22))}${valor}\n`);
        };
        linea('Description', m.descripcion ?? '');
        linea('Counterparty', m.contraparte ?? '');
        linea('Category', m.categoria ?? '');
        linea('Bank reference', m.referencia ?? '');
        linea('Value date', m.fechaValor ?? '');
        linea(
          'Statement',
          m.estadoDeCuenta ? `${m.estadoDeCuenta.numero ?? m.estadoDeCuenta.id} · ${m.estadoDeCuenta.periodo}` : ''
        );
        linea('content_hash', m.contentHash);
        linea('Imported', m.importadoEl);
        out.write('\n');

        if (m.cotejos.length === 0) {
          out.write(`  ${p.dim('No live match. `bank match preview` says what the engine would propose.')}\n`);
        } else {
          out.write(`  ${p.bold('Matches')} ${p.dim(`(${m.cotejos.length})`)}\n`);
          for (const c of m.cotejos) {
            out.write(
              `    ${p.green('✔')} ${c.tipo} ${c.entidadId} ${p.dim(
                `· ${c.importe}${c.parcial ? ' (partial)' : ''} · ${c.origen}` +
                  (c.groupId ? ` · group ${c.groupId}` : '')
              )}\n`
            );
          }
        }
        if (crudo) {
          out.write(`\n  ${p.bold('raw_data')}\n${JSON.stringify(m.crudo, null, 2)}\n`);
        }
        // La fila 1199 promete además clave de rastreo, CLABE y RFC de la
        // contraparte y número de cheque. No existen: `raw_data` está ahí desde
        // la 003 y no hay extractores ni columnas donde poner lo extraído.
        // Decirlo es más honesto que enseñar cuatro renglones vacíos, que se
        // leerían como «este movimiento no los trae».
        process.stderr.write(
          p.dim(
            `  Sin extractores todavía (${CAMPOS_SIN_EXTRACTOR.join(', ')}): lo que el banco escribió ` +
              'está en --raw. Los poblará `bank transaction apply`.\n'
          )
        );
      }
    })
  );

  // ---- bank book-item list -----------------------------------------
  const bookList = bookItem
    .command('list')
    .alias('listar')
    .argument('<account>', 'bank account whose GL account the entries were posted to (name or id)')
    .description(
      'List posted journal lines against the bank GL account that are still unsealed, oldest first, with their age'
    );
  withOutput(withSelection(withContext(bookList)));
  bookList
    .option('--since <date>', 'entries on or after this entry date (YYYY-MM-DD)')
    .option('--until <date>', 'entries on or before this entry date (YYYY-MM-DD)')
    .option(
      '--over-days <n>',
      'only what has gone MORE than this many days without showing up at the bank',
      enteroDesdeCero('--over-days')
    );
  declareRisk(bookList, { risk: 'lectura', agent: true });
  bookList.action(
    (ref: string, opts: CommonOpts & { since?: string; until?: string; overDays?: number }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const cuenta = await resolverCuentaBancaria(ctx.entityId, ref);
        const todas = await listarPartidasDeLibros(ctx.entityId, cuenta.id, {
          since: opts.since ? exigirFecha('--since', opts.since) : undefined,
          until: opts.until ? exigirFecha('--until', opts.until) : undefined,
          overDays: opts.overDays,
        });

        // EL TOPE SE APLICA AQUÍ Y SE DICE. `listarPartidasDeLibros` no pagina:
        // devuelve las partidas sin sellar de UNA cuenta, que es un conjunto
        // acotado por construcción —lo que no se ha conciliado— y no la tabla
        // de pólizas entera. Recortar en JS sería una mentira si no se
        // reportara el total; como sí se conoce, `render` anuncia el truncado
        // en las tres formas de salida y `--offset` significa algo.
        const desde = opts.offset ?? 0;
        const tope = opts.all ? todas.length : (opts.limit ?? 50);
        const filas = todas.slice(desde, desde + tope);

        render(filas.map(partidaComoFila), {
          ...opts,
          idField: 'id',
          numeric: ['amount', 'age_days'],
          total: todas.length,
          fields: opts.fields ?? (filas.length ? COLUMNAS_PARTIDA.join(',') : undefined),
        });

        if (todas.length && legible(opts)) {
          const vieja = todas[0];
          process.stderr.write(
            deps.palette.dim(
              `  La más antigua lleva ${vieja.antiguedadDias} día(s) sin aparecer en el banco ` +
                `(${vieja.entryNumber}). Un cheque expedido y no cobrado vive aquí y nunca en el extracto.\n`
            )
          );
        }
      })
  );

  // ---- bank match preview ------------------------------------------
  const preview = match
    .command('preview')
    .alias('previsualizar')
    .argument('[tx-id]', 'one transaction; without it, every unmatched one of --account')
    .description(
      'Show what the engine would propose, with the score broken into its signals and every gate’s verdict, WITHOUT applying anything'
    );
  withOutput(withContext(preview));
  preview
    .option('--account <ref>', 'bank account to sweep when no transaction id is given')
    .option('--since <date>', 'transactions on or after this date (YYYY-MM-DD)')
    .option('--until <date>', 'transactions on or before this date (YYYY-MM-DD)')
    .option(
      '--top <n>',
      'maximum TRANSACTIONS to preview (not candidates per transaction)',
      enteroPositivo('--top')
    )
    .option(
      '--min-confidence <n>',
      'engine confidence a proposal needs before `run` would apply it (0..1)',
      confianzaCero1('--min-confidence')
    )
    .option('--max-amount <amount>', 'ceiling for an automatic match; the hard floor still wins')
    .option('--rules-only', 'a proposal outside the date window counts as not applicable');
  // LA MITAD DE LECTURA. Es ✓ mientras `run` es ✗ y las dos hacen la misma
  // pregunta: por eso son dos hojas y no una con bandera (regla R11).
  declareRisk(preview, { risk: 'lectura', agent: true });
  preview.action(
    (
      txId: string | undefined,
      opts: CommonOpts & {
        account?: string; since?: string; until?: string; top?: number;
        minConfidence?: number; maxAmount?: string; rulesOnly?: boolean;
      }
    ) =>
      run(async () => {
        if (!txId && !opts.account) {
          throw usageError(
            'Previsualizar necesita saber sobre qué: pasa el id de un movimiento, o --account ' +
              'para recorrer los no cotejados de una cuenta.'
          );
        }
        const ctx = await entityOf(opts);
        const cuenta = opts.account
          ? await resolverCuentaBancaria(ctx.entityId, opts.account)
          : null;

        const previstos = await previsualizarCotejo(entityScope(ctx.tenantId, ctx.entityId), {
          cuentaId: cuenta?.id,
          txId,
          desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
          hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
          top: opts.top,
          minConfianza: opts.minConfidence,
          maxMonto: opts.maxAmount ? exigirImporte('--max-amount', opts.maxAmount) : undefined,
          soloReglas: opts.rulesOnly === true,
        });

        if (!legible(opts)) {
          // SIN JUEGO DE COLUMNAS POR OMISIÓN, a diferencia de las tres listas
          // de esta familia. Aquí sólo se llega pidiendo una forma de máquina
          // (o `--fields` a mano), y lo que hace valer a esta hoja es
          // justamente la descomposición: recortarla a las ocho columnas
          // «bonitas» le quitaría al agente exactamente lo que vino a leer.
          render(previstos.map(previstoComoFila), {
            ...opts,
            idField: 'id',
            numeric: ['amount', 'candidate_amount', 'confidence', 'amount_diff', 'days_apart'],
          });
          return;
        }

        const p = deps.palette;
        const out = process.stdout;
        for (const m of previstos) {
          out.write(
            `\n${p.bold(m.importe)} ${p.dim(`· ${m.fecha} · ${m.descripcion ?? ''}`)}\n`
          );
          const c = m.propuesta;
          const s = m.senales;
          if (!c || !s) {
            out.write(`  ${p.dim('—')} sin propuesta ${p.dim(`(${m.motivo ?? 'sin-candidato'})`)}\n`);
            continue;
          }
          out.write(
            `  ${m.aplicable ? p.green('✔') : p.yellow('◑')} ${c.tipo} ` +
              `${p.bold(c.referencia ?? c.id)} ${p.dim(
                `· ${c.importe} · ${c.fecha} · confianza ${c.confianza.toFixed(2)} · regla ${c.regla}`
              )}\n`
          );
          // LA DESCOMPOSICIÓN. No son los pesos internos del motor —devuelve un
          // escalar y los .45/.25/.30 se quedan dentro—: son los tres hechos
          // que las cuatro reglas miran, cada uno con su veredicto. Con esto
          // quien lee puede rehacer el juicio sin creerle al número.
          const marca = (ok: boolean) => (ok ? p.green('✔') : p.red('✘'));
          out.write(
            `      ${p.dim('importe    ')} ${s.importeBanco} vs ${s.importeCandidato} · ` +
              `diferencia ${s.diferenciaImporte} · exacto ${marca(s.importeExacto)} · ` +
              `misma dirección ${marca(s.mismaDireccion)}\n`
          );
          out.write(
            `      ${p.dim('fecha      ')} ${s.diasDeDiferencia} día(s) · ` +
              `dentro de ventana ${marca(s.dentroDeVentana)}\n`
          );
          out.write(
            `      ${p.dim('descripción')} similitud ${s.similitudDescripcion.toFixed(2)} ` +
              `${p.dim('(señal blanda: nunca aplica sola)')}\n`
          );
          if (m.periodo) {
            out.write(`      ${p.dim('periodo    ')} ${m.periodo.nombre} (${m.periodo.estado})\n`);
          }
          out.write(
            `      ${p.dim('veredicto  ')} ${
              m.aplicable ? p.green('`run` lo aplicaría') : `${p.yellow('no se aplica')} — ${m.motivo ?? ''}`
            }\n`
          );
        }

        const aplicables = previstos.filter((m) => m.aplicable).length;
        out.write(
          `\n${p.bold(String(previstos.length))} movimiento(s) · ` +
            `${aplicables} que \`bank match run\` aplicaría.\n`
        );
        if (opts.top !== undefined && previstos.length >= opts.top) {
          process.stderr.write(
            p.yellow(
              `  Se previsualizaron ${previstos.length}, que es el tope de --top: puede haber más.\n`
            )
          );
        }
      })
  );

  // ---- bank match run ----------------------------------------------
  const matchRun = match
    .command('run')
    .alias('ejecutar')
    .description(
      'Run the engine over one account and period, applying ONLY what clears the confidence threshold, ' +
        'the amount floor, an open period and an exact-amount hard signal'
    );
  withContext(matchRun);
  matchRun
    .requiredOption('--account <ref>', 'bank account to sweep (name or id)')
    .option('--since <date>', 'transactions on or after this date (YYYY-MM-DD)')
    .option('--until <date>', 'transactions on or before this date (YYYY-MM-DD)')
    .option(
      '--min-confidence <n>',
      'engine confidence a proposal needs to be applied (0..1)',
      confianzaCero1('--min-confidence')
    )
    .option('--max-amount <amount>', 'ceiling for an automatic match; the hard floor still wins')
    .option('--rules-only', 'refuse a proposal outside the date window')
    .option('--top <n>', 'maximum transactions to evaluate in this run', enteroPositivo('--top'))
    .option('--session <id>', 'reconciliation session these matches belong to')
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('--json', 'JSON output');
  // ESCRITURA Y ✗. Escribe una aseveración sobre el dinero de un tercero y
  // SELLA la línea de póliza, que es la única mutación que la 041 admite sobre
  // un asiento contabilizado. No es `irreversible` porque `bank match unapply`
  // la deshace por diseño, y por eso tampoco lleva --idempotency-key: la
  // idempotencia aquí es del acto (no crea un segundo cotejo vivo) y no de una
  // clave de cliente.
  declareRisk(matchRun, {
    risk: 'escritura',
    agent: false,
    writes:
      'reconciliation_match_groups + reconciliation_matches + el sello de journal_entry_lines ' +
      '(is_reconciled/reconciled_at/reconciliation_id); NUNCA una póliza',
  });
  matchRun.action(
    (
      opts: CommonOpts & {
        account: string; since?: string; until?: string; top?: number;
        minConfidence?: number; maxAmount?: string; rulesOnly?: boolean;
        session?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(matchRun, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const cuenta = await resolverCuentaBancaria(ctx.entityId, opts.account);

        const r = await correrCotejo(
          entityScope(ctx.tenantId, ctx.entityId),
          {
            cuentaId: cuenta.id,
            desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
            hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
            top: opts.top,
            minConfianza: opts.minConfidence,
            maxMonto: opts.maxAmount ? exigirImporte('--max-amount', opts.maxAmount) : undefined,
            soloReglas: opts.rulesOnly === true,
            sesionId: opts.session ? uuidDeBandera('--session', opts.session) : undefined,
          },
          { userId: reviewer.userId, dryRun }
        );

        const p = deps.palette;
        if (opts.json) {
          render(aplicacionComoFilas(r), { json: true, idField: 'id' });
        } else {
          render(
            aplicacionComoFilas(r).filter((f) => f.outcome === 'applied'),
            { format: 'table', idField: 'id', numeric: ['amount', 'confidence'] }
          );
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(String(r.aplicados.length))} aplicado(s) ` +
              `${p.dim(
                `· ${r.yaAplicados.length} ya lo estaba(n) · ${r.omitidos.length} omitido(s) ` +
                  `· ${r.evaluados} evaluado(s)`
              )}\n`
          );
        }

        // POR QUÉ NO SE APLICÓ, AGRUPADO. Una corrida que dice «3 de 200» y
        // calla las 197 obliga a previsualizar de nuevo para enterarse; los
        // motivos son una taxonomía cerrada justamente para poder contarse.
        const porMotivo = new Map<string, number>();
        for (const o of r.omitidos) porMotivo.set(o.motivo, (porMotivo.get(o.motivo) ?? 0) + 1);
        for (const [motivo, n] of [...porMotivo].sort((a, b) => b[1] - a[1])) {
          process.stderr.write(p.dim(`  ${String(n).padStart(5)}  ${motivo}\n`));
        }
        if (r.truncado) {
          process.stderr.write(
            p.yellow('  La corrida llegó a su tope: quedan movimientos sin evaluar. Vuelve a correrla.\n')
          );
        }
        if (dryRun) {
          process.stderr.write(p.yellow('  Ensayo: se escribió de verdad y se deshizo.\n'));
        }
      })
  );

  // ---- bank match apply --------------------------------------------
  const matchApply = match
    .command('apply')
    .alias('aplicar')
    .argument('[id...]', 'bank transaction ids; or feed them through --stdin')
    .description(
      'Apply the engine’s proposal for the named transactions in ONE transaction, idempotently, ' +
        'linked to the session'
    );
  withContext(matchApply);
  matchApply
    .option('--stdin', 'read the ids from standard input, whitespace separated')
    .option('--session <id>', 'reconciliation session these matches belong to')
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('-y, --yes', 'skip the grouped confirmation')
    .option('--json', 'JSON output');
  declareRisk(matchApply, {
    risk: 'escritura',
    agent: false,
    writes:
      'reconciliation_match_groups + reconciliation_matches + el sello de journal_entry_lines; ' +
      'NUNCA una póliza',
  });
  matchApply.action(
    (
      ids: string[],
      opts: CommonOpts & { stdin?: boolean; session?: string; dryRun?: boolean; yes?: boolean }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(matchApply, opts as unknown as Record<string, unknown>);

        // Los dos orígenes se SUMAN en vez de excluirse: `preview -q | apply
        // --stdin <uno-más>` es una corrección normal y prohibirla no protege
        // de nada. Lo que no se admite es ninguno de los dos.
        const desdeStdin = opts.stdin
          ? (deps.readStdin ? await deps.readStdin() : await leerEntradaEstandar())
            .split(/\s+/)
            .filter(Boolean)
          : [];
        const todos = [...ids, ...desdeStdin];
        if (todos.length === 0) {
          throw usageError(
            opts.stdin
              ? 'La entrada estándar no trajo ningún id. `bank match preview -q` los escupe uno por línea.'
              : 'Qué movimientos. Pásalos como argumento, o encadena `bank match preview -q | ' +
                'mnemosine bank match apply --stdin`.'
          );
        }
        for (const id of todos) uuidDeBandera('<id>', id);

        if (!dryRun && opts.yes !== true) {
          const ok = await ask(
            `Vas a aplicar el cotejo que el motor propone para ${todos.length} movimiento(s). ¿Continuar?`
          );
          if (!ok) {
            // Sin TTY —que es justo el caso de `--stdin`— `ask` contesta que
            // no. Se nombra `-y` en vez de dejar un «abortado» que parece un
            // fallo del guion.
            throw abortedByUser(
              stdin.isTTY
                ? 'Sin cambios.'
                : 'Sin cambios: no hay terminal donde confirmar (la entrada estándar es la tubería). ' +
                  'Añade -y para aplicar sin preguntar.'
            );
          }
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const r = await aplicarCotejos(
          entityScope(ctx.tenantId, ctx.entityId),
          todos,
          { userId: reviewer.userId, dryRun },
          { sesionId: opts.session ? uuidDeBandera('--session', opts.session) : undefined }
        );

        const p = deps.palette;
        const filas = aplicacionComoFilas(r);
        if (opts.json) {
          render(filas, { json: true, idField: 'id' });
        } else {
          render(filas, { format: 'table', idField: 'id', numeric: ['amount', 'confidence'] });
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(String(r.aplicados.length))} aplicado(s) ` +
              `${p.dim(`· ${r.yaAplicados.length} ya lo estaba(n) · ${r.omitidos.length} omitido(s)`)}\n`
          );
        }
        if (dryRun) {
          process.stderr.write(p.yellow('  Ensayo: se escribió de verdad y se deshizo.\n'));
        }
        // Un `apply` que pide diez y aplica tres no puede salir 0 en silencio:
        // el guion que lo llama tiene que poder notarlo. 4 es «encontré algo
        // que mirar», el mismo código con el que `statement check` informa.
        if (r.omitidos.length > 0 && r.aplicados.length === 0) {
          return exitCodeFor({ statusCode: 422 });
        }
      })
  );

  // ---- bank match create -------------------------------------------
  const matchCreate = match
    .command('create')
    .alias('crear')
    .description(
      'Build an explicit match group of N bank transactions against M book items plus adjustments, ' +
        'requiring Σbank = Σbooks + Σadjustments'
    );
  withContext(matchCreate);
  matchCreate
    .requiredOption('--account <ref>', 'bank account the whole group belongs to (name or id)')
    .requiredOption('--transaction <ids>', 'comma-separated bank transaction ids: the bank side')
    .requiredOption(
      '--book-item <ids>',
      'comma-separated book side: <id> for a journal line, or <type>:<id> ' +
        `(${MATCHED_ENTITY_TYPES.join(', ')})`
    )
    .option(
      '--adjust <concept=amount>',
      'declared adjustment (bank fee, FX difference); repeatable',
      ajusteDeGrupo,
      [] as AjusteDeGrupo[]
    )
    .option(
      `--residual <${MODOS_RESIDUAL.join('|')}>`,
      'what happens to what is left over: keep it live, or write it off against an account'
    )
    .option('--write-off-account <account>', 'GL account the residual is written off against')
    .option('--session <id>', 'reconciliation session this group belongs to')
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('--json', 'JSON output');
  // Sin `-y`: aquí no hay nada que confirmar que el operador no haya escrito ya
  // —los ids de los dos lados, los ajustes y qué hacer con el residual—, y
  // `--dry-run` enseña el cuadre antes de comprometerlo. La confirmación existe
  // donde la orden es corta y el efecto largo, que es `apply` y `unapply`.
  declareRisk(matchCreate, {
    risk: 'escritura',
    agent: false,
    writes:
      'reconciliation_match_groups + reconciliation_matches + el sello de journal_entry_lines; ' +
      'NUNCA una póliza (el write-off se DECLARA y no se contabiliza)',
  });
  matchCreate.action(
    (
      opts: CommonOpts & {
        account: string; transaction: string; bookItem: string; adjust: AjusteDeGrupo[];
        residual?: string; writeOffAccount?: string; session?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(matchCreate, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const cuenta = await resolverCuentaBancaria(ctx.entityId, opts.account);

        const r = await crearGrupoDeCotejo(
          entityScope(ctx.tenantId, ctx.entityId),
          {
            cuentaId: cuenta.id,
            banco: idsDeBandera('--transaction', opts.transaction),
            libros: referenciasDeLibros(opts.bookItem),
            ajustes: opts.adjust,
            residual: opts.residual ? exigirResidual(opts.residual) : undefined,
            cuentaWriteOff: opts.writeOffAccount
              ? uuidDeBandera('--write-off-account', opts.writeOffAccount)
              : undefined,
            sesionId: opts.session ? uuidDeBandera('--session', opts.session) : undefined,
          },
          { userId: reviewer.userId, dryRun }
        );

        const p = deps.palette;
        if (opts.json) {
          render(
            [
              {
                group: r.groupId,
                total_bank: r.cuadre.totalBanco,
                total_books: r.cuadre.totalLibros,
                total_adjustments: r.cuadre.totalAjustes,
                residual: r.residual,
                residual_mode: r.residualMode,
                write_off_account: r.cuentaWriteOff ?? '',
                matches: r.cotejos,
                sealed_lines: r.partidasSelladas,
                dry_run: r.dryRun,
                id: r.groupId,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.groupId)} ` +
              `${p.dim(
                `· banco ${r.cuadre.totalBanco} = libros ${r.cuadre.totalLibros} + ` +
                  `ajustes ${r.cuadre.totalAjustes} · residual ${r.residual} (${r.residualMode}) ` +
                  `· ${r.cotejos.length} cotejo(s) · ${r.partidasSelladas.length} partida(s) sellada(s)`
              )}\n`
          );
          render(
            r.cotejos.map((c) => ({
              transaction: c.txId,
              type: c.tipo,
              matched_entity: c.entidadId,
              amount: c.importe,
              partial: c.parcial,
              id: c.matchId,
            })),
            { format: 'table', idField: 'id', numeric: ['amount'] }
          );
        }
        if (r.residualMode === 'write-off') {
          // La 052 guarda `write_off_account_id` y no hay póliza detrás. Un
          // residual cancelado que nunca toca el mayor es media promesa, y
          // callarla la volvería una mentira.
          process.stderr.write(
            p.yellow(
              `  El residual de ${r.residual} queda DECLARADO como cancelado contra la cuenta, ` +
                'pero no se contabiliza: no hay póliza detrás todavía. Regístrala a mano o espera a F05c.\n'
            )
          );
        }
        if (dryRun) {
          process.stderr.write(p.yellow('  Ensayo: el grupo se escribió de verdad y se deshizo.\n'));
        }
      })
  );

  // ---- bank match unapply ------------------------------------------
  const matchUnapply = match
    .command('unapply')
    .alias('desaplicar')
    .argument('<match-id>', 'the match to undo; its whole group goes with it')
    .description(
      'Undo a match with a typed reason, releasing the book-item seal; refuses if the session is ' +
        'already approved or posted, and touches no posted journal entry'
    );
  withContext(matchUnapply);
  matchUnapply
    .option(
      '--reason <code>',
      `typed reason, required: ${MOTIVOS_DESAPLICACION.join(' | ')}`
    )
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('-y, --yes', 'skip the confirmation')
    .option('--json', 'JSON output');
  declareRisk(matchUnapply, {
    risk: 'escritura',
    agent: false,
    writes:
      'reconciliation_matches (CLAUSURA: unapplied_at/by/reason, ninguna fila se borra) + ' +
      'libera el sello de journal_entry_lines',
  });
  matchUnapply.action(
    (matchId: string, opts: CommonOpts & { reason?: string; dryRun?: boolean; yes?: boolean }) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        gateMutation(matchUnapply, opts as unknown as Record<string, unknown>);
        const dryRun = opts.dryRun === true;
        // `unapply` no está en los REASON_VERBS del núcleo, así que la
        // compuerta no exige el motivo por él: se exige aquí, y además
        // TIPIFICADO, que es lo que la 052 pide y lo que su columna de 40
        // caracteres admite.
        const motivo = exigirMotivo(opts.reason);
        const id = uuidDeBandera('<match-id>', matchId);

        if (!dryRun && opts.yes !== true) {
          const ok = await ask(
            `Vas a desaplicar el cotejo ${id} y todos los de su grupo (la igualdad ` +
              `Σbanco = Σlibros + Σajustes no sobrevive a que le quiten una pata). ¿Continuar?`
          );
          if (!ok) throw abortedByUser('Sin cambios.');
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const r = await desaplicarCotejo(entityScope(ctx.tenantId, ctx.entityId), id, {
          userId: reviewer.userId,
          motivo,
          dryRun,
        });

        const p = deps.palette;
        if (opts.json) {
          render(
            [
              {
                group: r.groupId ?? '',
                closed_matches: r.cotejos,
                released_transactions: r.movimientosLiberados,
                released_book_items: r.partidasLiberadas,
                reason: r.motivo,
                dry_run: r.dryRun,
                id,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(String(r.cotejos.length))} cotejo(s) clausurado(s) ` +
              `${p.dim(
                `· ${r.movimientosLiberados.length} movimiento(s) y ${r.partidasLiberadas.length} ` +
                  `partida(s) de vuelta al flujo · motivo ${r.motivo}` +
                  (r.groupId ? ` · grupo ${r.groupId}` : '')
              )}\n`
          );
        }
        process.stderr.write(
          p.dim(
            '  Clausura, no borrado: la fila se queda en el expediente con su motivo, porque el ' +
              'auditor pregunta por qué se deshizo y una fila borrada no contesta.\n'
          )
        );
        if (dryRun) {
          process.stderr.write(p.yellow('  Ensayo: se clausuró de verdad y se deshizo.\n'));
        }
      })
  );

  // ============================================================
  // F05c · LA SESIÓN QUE CUADRA
  //
  // Tres sustantivos y ocho hojas. La sesión es el contenedor del mes, la
  // partida conciliatoria es lo que explica la diferencia, y el ajuste es lo
  // que la conciliación descubre y deja como BORRADOR.
  //
  // Toda la aritmética vive en `services/banking/reconciliation-math.ts` y en
  // `reconciliation-service.ts`; aquí no se resta nada. Lo único que esta capa
  // decide es cómo se enseña —y esa decisión es el tramo entero: un `null` que
  // se imprime como cero vuelve a convertir «nadie restó nada» en «la cuenta
  // cuadra», que es el defecto que la 053 hizo imposible en el esquema.
  // ============================================================

  const reconciliation = bank
    .command('reconciliation')
    .alias('conciliacion')
    .description(
      'The reconciliation session: the two-sided arithmetic that makes `balanced` mean something'
    );

  const reconcilingItem = bank
    .command('reconciling-item')
    .alias('partida-conciliatoria')
    .description(
      'Reconciling items as rows: what explains the difference, with age, owner, due date and escalation'
    );

  const adjustment = bank
    .command('adjustment')
    .alias('ajuste')
    .description(
      'The fees, VAT, interest and withholdings a reconciliation uncovers, created as DRAFTS'
    );

  /** Un lado que nadie observó NUNCA se imprime como cero. */
  const NO_OBSERVADO = 'sin observar';

  /**
   * EL DESGLOSE DE LOS DOS LADOS, que es lo que hace auditable una
   * conciliación: saldo, sus partidas una por una, y el ajustado.
   *
   * Un número solo no sirve. Con esto, quien lo lee puede rehacer la resta a
   * mano y descubrir dónde se separan los dos lados; sin esto tendría que
   * creerle a una variación.
   */
  const imprimirAritmetica = (e: EstadoDeSesion): void => {
    const p = deps.palette;
    const out = process.stdout;
    const a = e.aritmetica;

    // Las tintas se envuelven en flechas: pasar `p.red` como valor separaría el
    // método de su objeto, que es lo que `unbound-method` prohíbe.
    const rojo = (s: string): string => p.red(s);
    const fuerte = (s: string): string => p.bold(s);

    // El texto se compone y DESPUÉS se colorea: al revés, los códigos de
    // escape cuentan como caracteres y las columnas dejan de alinearse.
    const renglon = (etiqueta: string, valor: string, estilo?: (s: string) => string): void => {
      const texto = `    ${etiqueta.padEnd(34)}${valor.padStart(18)}`;
      out.write(`${estilo ? estilo(texto) : texto}\n`);
    };

    const lado = (titulo: string, etiqueta: string, l: LadoConciliado): void => {
      out.write(`\n  ${p.bold(titulo)}\n`);
      renglon(etiqueta, l.saldo ?? NO_OBSERVADO, l.saldo === null ? rojo : undefined);
      // Una por una y en el orden de `TIPOS_DE_PARTIDA`, que es estable entre
      // corridas: un desglose que cambia de orden no se compara de un vistazo.
      for (const partida of l.partidas) renglon(partida.tipo, partida.importe);
      renglon('= ajustado', l.ajustado ?? NO_OBSERVADO, l.ajustado === null ? rojo : fuerte);
    };

    lado('BANCO', 'saldo del extracto', a.banco);
    lado('LIBROS', 'saldo de libros', a.libros);
    out.write('\n');

    if (a.variacion === null) {
      renglon('VARIACIÓN', 'NO CALCULADA', rojo);
      out.write(
        `    ${p.dim(
          'No es cero: es que falta un lado. Un cero aquí significaría «nadie restó nada».'
        )}\n`
      );
      return;
    }
    renglon('VARIACIÓN', a.variacion, (s) => (a.cuadra ? p.green(s) : p.yellow(s)));
    out.write(
      `    ${p.dim(`tolerancia ${a.tolerancia} · política ${e.criterios.tolerancia.valor}`)}\n`
    );
  };

  /** Los conteos que la aritmética levanta, y el extracto sin explicar. */
  const imprimirContadores = (e: EstadoDeSesion): void => {
    const p = deps.palette;
    const a = e.aritmetica;
    process.stdout.write(
      `\n  ${p.dim('partidas')} ${e.partidas.length} · ${a.sinClasificar} sin clasificar · ` +
        `${a.sinFechar} sin fechar · ${a.resueltas} resuelta(s)\n` +
        `  ${p.dim('extracto')} ${e.movimientosSinExplicar.cuantos} movimiento(s) sin cotejo y ` +
        `sin partida (${e.movimientosSinExplicar.importe})\n`
    );
  };

  /**
   * El resumen congelado, CONTRASTADO con la aritmética viva.
   *
   * Es la única superficie donde `reconciliation_sessions.variance` aparece, y
   * aparece etiquetada: la columna es la aseveración que se hizo, no la
   * respuesta. Cuando nadie ha hecho la aritmética, el cero de la columna se
   * NOMBRA como lo que es.
   */
  const imprimirCongelado = (e: EstadoDeSesion): void => {
    const p = deps.palette;
    const out = process.stdout;
    const c = e.congelado;
    out.write(`\n  ${p.bold('RESUMEN CONGELADO')} ${p.dim('(la aseveración, no la respuesta)')}\n`);
    if (c.aritmeticaCalculadaEl === null) {
      out.write(
        `    ${p.yellow(
          `nadie ha hecho la aritmética de esta sesión: la fila guarda variance ${c.variance} por DEFAULT`
        )}\n`
      );
      return;
    }
    out.write(
      `    variance ${c.variance} · libros ${c.saldoLibros} · cheques ${c.chequesEnCirculacion} · ` +
        `depósitos ${c.depositosEnTransito} · cargos ${c.cargosDelBanco} · ` +
        `abonos ${c.abonosDelBanco} · otros ${c.otrosAjustes}\n` +
        `    ${p.dim(`calculada el ${c.aritmeticaCalculadaEl}`)}\n`
    );
    if (e.aritmetica.variacion !== null && e.aritmetica.variacion !== c.variance) {
      // Justo para esto existe el contraste: la sesión de marzo puede haber
      // dejado de decir la verdad sin que nadie tocara su fila.
      out.write(
        `    ${p.yellow('!')} la aritmética viva dice ${e.aritmetica.variacion} y la sesión ` +
          `afirmó ${c.variance}: algo cambió debajo desde que se cerró.\n`
      );
    }
  };

  /** El veredicto de cierre con sus reparos, cada uno con su código. */
  const imprimirBloqueantes = (e: EstadoDeSesion): void => {
    const p = deps.palette;
    const out = process.stdout;
    if (e.listaParaCerrar) {
      out.write(`\n  ${p.green('✔')} lista para \`bank reconciliation close\`.\n`);
      return;
    }
    out.write(`\n  ${p.bold('LO QUE FALTA')}\n`);
    for (const r of e.bloqueantes) {
      out.write(`    ${p.red('✘')} ${p.dim(`[${r.codigo}]`)} ${r.detalle}\n`);
    }
  };

  // ---- bank reconciliation run -------------------------------------
  const reconRun = reconciliation
    .command('run')
    .alias('ejecutar')
    .argument('<account>', 'bank account to reconcile (name or id)')
    .description(
      'Guided monthly pass over one account: statement, matching engine, session and reconciling ' +
        'items; it ALWAYS stops before approve and post, and prints what is missing'
    );
  withContext(reconRun);
  withNote(reconRun);
  reconRun
    .option('--period <yyyy-mm>', 'period to reconcile; or give --since and --until together')
    .option('--since <date>', 'first day of the period (YYYY-MM-DD)')
    .option('--until <date>', 'last day of the period (YYYY-MM-DD)')
    .option(
      '--file <path>',
      'statement to import first; without it, the one already imported for the period is used'
    )
    .option(
      `--format <${FORMATOS_DEL_CATALOGO.map((f) => f.nombre).join('|')}>`,
      'format of the FILE given in --file (not of the output; use --json for that), as in `bank statement import`'
    )
    .option('--profile <name>', 'CSV column profile to read --file with')
    .option(
      '--min-confidence <n>',
      'engine confidence a proposal needs to be applied (0..1)',
      confianzaCero1('--min-confidence')
    )
    .option('--max-amount <amount>', 'ceiling for an automatic match; the hard floor still wins')
    .option(
      `--stop-at <${PASOS_DE_CORRIDA.join('|')}>`,
      'stop after this step; it never goes past `estado`, and never reaches approve or post'
    )
    .option('--resume', 'continue the session already open for this period instead of refusing')
    .option('--dry-run', 'walk the real path and roll it back')
    .option('--json', 'JSON output');
  // ESCRITURA Y ✗, aunque cada uno de sus pasos ya tenga su propia
  // declaración: el pase encadena un import, un cotejo que sella líneas de
  // póliza y la apertura de una sesión, y el agente no invoca esa cadena. La
  // mitad que sí puede leer es `bank reconciliation status`.
  declareRisk(reconRun, {
    risk: 'escritura',
    agent: false,
    writes:
      'bank_statements + bank_transactions (con --file) + reconciliation_match_groups/matches + ' +
      'el sello de journal_entry_lines + reconciliation_sessions + reconciling_items; ' +
      'NUNCA una póliza, y NUNCA approve ni post',
  });
  reconRun.action(
    (
      ref: string,
      opts: CommonOpts & {
        period?: string; since?: string; until?: string; file?: string; profile?: string;
        minConfidence?: number; maxAmount?: string; stopAt?: string; resume?: boolean;
        note?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(reconRun, opts as unknown as Record<string, unknown>);
        // `--format` y `--profile` describen el archivo de `--file`. Sin
        // archivo no describen nada, y aceptarlas en silencio haría creer que
        // se leyó un extracto que nadie pasó.
        if (opts.file === undefined && (opts.format !== undefined || opts.profile !== undefined)) {
          throw usageError(
            '--format y --profile describen el archivo de --file, y no hay archivo. Pasa --file, ' +
              'o quítalas para tomar el extracto que ya esté importado.'
          );
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await correrConciliacion(
          entityScope(ctx.tenantId, ctx.entityId),
          {
            cuenta: ref,
            periodo: opts.period,
            desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
            hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
            archivo: opts.file,
            formato: opts.format,
            perfil: opts.profile,
            minConfianza: opts.minConfidence,
            maxMonto: opts.maxAmount ? exigirImporte('--max-amount', opts.maxAmount) : undefined,
            detenerEn: opts.stopAt ? exigirPaso(opts.stopAt) : undefined,
            reanudar: opts.resume === true,
            // El lector de formatos se CABLEA aquí, como en `import`: el
            // servicio lo recibe y no lo importa, que es lo que permite
            // ejercitar el pase entero sobre un extracto escrito a mano.
            leer: opts.file ? leerConParsers : undefined,
            notas: opts.note,
          },
          { userId: reviewer.userId, dryRun }
        );

        const p = deps.palette;
        if (opts.json) {
          render([corridaComoDocumento(r)], { json: true, idField: 'id' });
        } else {
          const out = process.stdout;
          out.write(
            `\n${p.bold(r.cuenta.nombre)} ${p.dim(`· ${r.desde} → ${r.hasta}`)}` +
              `${r.sesionId ? p.dim(` · sesión ${r.sesionId}`) : ''}\n\n`
          );
          for (const paso of r.pasos) {
            out.write(
              `  ${paso.hecho ? p.green('✔') : p.yellow('◑')} ${p.bold(paso.paso.padEnd(9))} ` +
                `${paso.detalle}\n`
            );
          }
          if (r.estado) {
            imprimirAritmetica(r.estado);
            imprimirContadores(r.estado);
          }
          // LO QUE FALTA ES LA SALIDA DE ESTA HOJA, no una advertencia: por eso
          // va a stdout, y va al final, que es donde se lee. Una corrida que
          // termina en verde y calla lo que queda se lee como una conciliación
          // terminada.
          out.write(`\n  ${p.bold('LO QUE FALTA')}\n`);
          for (const falta of r.loQueFalta) out.write(`    · ${falta}\n`);
        }
        if (r.ensayo) {
          process.stderr.write(
            p.yellow('  Ensayo: los pasos que escriben se ejecutaron de verdad y se deshicieron.\n')
          );
        }
        // Un paso que NO SE PUDO hacer —no hay extracto del periodo— es un
        // hallazgo, no un fallo: 4 es el código con el que esta familia informa
        // «encontré algo que mirar», y un guion que encadena el mes tiene que
        // poder notarlo sin leer la prosa.
        if (r.pasos.some((paso) => !paso.hecho)) return exitCodeFor({ statusCode: 422 });
      })
  );

  // ---- bank reconciliation open ------------------------------------
  const reconOpen = reconciliation
    .command('open')
    .alias('abrir')
    .argument('<account>', 'bank account to open the session on (name or id)')
    .description(
      'Open the period session, asserting the opening balance equals the previous session closing ' +
        'and refusing date gaps and overlaps'
    );
  withContext(reconOpen);
  withNote(reconOpen);
  reconOpen
    .option('--period <yyyy-mm>', 'period of the session; or give --since and --until together')
    .option('--since <date>', 'first day of the period (YYYY-MM-DD)')
    .option('--until <date>', 'last day of the period (YYYY-MM-DD)')
    .option(
      '--closing-balance <amount>',
      'closing balance you assert; it is COMPARED against the statement, never substituted for it'
    )
    .option('--statement <id>', 'the statement to tie the session to, when the period has more than one')
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('--json', 'JSON output');
  // ESCRITURA + IA ✓, y `declareRisk` sólo lo admite con `draftOnly`. Aquí es
  // HONESTO y no una concesión: lo único que esta hoja escribe es el
  // CONTENEDOR DE TRABAJO del mes. La sesión nace `in_progress` con
  // `arithmetic_computed_at` en NULL, y el CHECK
  // `sesion_balanceada_con_aritmetica` de la 053 hace que con ese NULL la fila
  // no pueda llegar a 'balanced' por ninguna puerta —así que abrir no puede
  // producir lo que `period-close.ts` lee como evidencia de que el efectivo se
  // verificó—. No hay camino de aquí al mayor por ninguna bandera: quien firma
  // es `close`, que es ✗, y quien contabiliza es `post`, que es de F05d.
  declareRisk(reconOpen, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes:
      'reconciliation_sessions (in_progress, con arithmetic_computed_at NULL: el CHECK de la 053 ' +
      'impide que llegue a balanced por esta puerta); NUNCA journal_entries',
  });
  reconOpen.action(
    (
      ref: string,
      opts: CommonOpts & {
        period?: string; since?: string; until?: string; closingBalance?: string;
        statement?: string; note?: string; dryRun?: boolean;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(reconOpen, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await abrirSesion(
          entityScope(ctx.tenantId, ctx.entityId),
          {
            cuenta: ref,
            periodo: opts.period,
            desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
            hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
            saldoFinalDeclarado: opts.closingBalance
              ? exigirImporte('--closing-balance', opts.closingBalance)
              : undefined,
            statementId: opts.statement ? uuidDeBandera('--statement', opts.statement) : undefined,
            notas: opts.note,
          },
          { userId: reviewer.userId, dryRun }
        );

        const p = deps.palette;
        if (opts.json) {
          render(
            [
              {
                account: r.cuenta.nombre,
                account_id: r.cuenta.id,
                account_type: r.cuenta.tipo,
                currency: r.cuenta.moneda,
                period: `${r.desde}..${r.hasta}`,
                statement_id: r.statementId,
                statements: r.extractos,
                opening: r.saldoInicial,
                closing_bank: r.saldoFinalBanco,
                // Los dos números del extracto, como en `status`: en una
                // tarjeta de crédito el declarado y el normalizado no son el
                // mismo, y publicar sólo uno haría silenciosa la conversión.
                closing_as_published: r.saldoFinalDeclaradoPorElBanco,
                previous_session: r.sesionAnterior?.id ?? '',
                previous_closing: r.sesionAnterior?.saldoFinal ?? '',
                warnings: r.avisos,
                dry_run: r.ensayo,
                id: r.sesionId,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.sesionId)} ` +
              `${p.dim(
                `· ${r.cuenta.nombre} · ${r.desde} → ${r.hasta} · saldo inicial ${r.saldoInicial} ` +
                  `· cierre de banco ${r.saldoFinalBanco} ${r.cuenta.moneda} · extracto ${r.statementId}` +
                  (r.sesionAnterior ? ` · continúa ${r.sesionAnterior.id}` : '')
              )}\n`
          );
        }
        avisar(r.avisos);
        // La frase que impide leer una sesión abierta como una cuenta
        // verificada: abrir NO es calcular, y el CHECK de la 053 lo sostiene.
        process.stderr.write(
          p.dim(
            '  La sesión nace sin aritmética (`arithmetic_computed_at` NULL): `bank reconciliation ' +
              'status` la calcula viva y `close` la firma. Nada de esto toca el mayor.\n'
          )
        );
        if (dryRun) {
          process.stderr.write(
            p.yellow('  Ensayo: la sesión se abrió de verdad —continuidad incluida— y se deshizo.\n')
          );
        }
      })
  );

  // ---- bank reconciliation list ------------------------------------
  const reconList = reconciliation
    .command('list')
    .alias('listar')
    .description(
      'List sessions by account, state and period, with the FROZEN variance and how many items are still open'
    );
  withOutput(withSelection(withContext(reconList)));
  reconList
    .option('--account <ref>', 'only sessions of this bank account (name or id)')
    .option('--period <yyyy-mm>', 'sessions that overlap this period')
    .option('--since <date>', 'sessions ending on or after this date (YYYY-MM-DD)')
    .option('--until <date>', 'sessions starting on or before this date (YYYY-MM-DD)')
    .option(
      '--all-entities',
      "every entity of the tenant, for a firm's overview; still bounded inside the SQL"
    );
  declareRisk(reconList, { risk: 'lectura', agent: true });
  reconList.action(
    (
      opts: CommonOpts & {
        account?: string; period?: string; since?: string; until?: string; allEntities?: boolean;
      }
    ) =>
      run(async () => {
        rechazarOffset(opts, 'Acota con --account, --period o -s, o pide todo con --all.');
        const ctx = await entityOf(opts);
        const scope: Scope = opts.allEntities
          ? tenantScope(ctx.tenantId)
          : entityScope(ctx.tenantId, ctx.entityId);

        const tope = opts.all ? undefined : (opts.limit ?? 50);
        const filas = await listarSesiones(scope, {
          cuenta: opts.account,
          estado: exigirEstadoDeSesion(opts.status),
          periodo: opts.period,
          desde: opts.since ? exigirFecha('--since', opts.since) : undefined,
          hasta: opts.until ? exigirFecha('--until', opts.until) : undefined,
          limit: tope,
        });

        render(filas.map(sesionComoFila), {
          ...opts,
          idField: 'id',
          numeric: ['opening', 'closing_bank', 'variance', 'open_items'],
          fields: opts.fields ?? (filas.length ? COLUMNAS_SESION.join(',') : undefined),
        });
        avisarTope(filas.length, tope, 'bank reconciliation list');

        // El hueco necesita una frase la primera vez que se ve, y sólo cuando
        // lo hay: una celda vacía en `variance` no es «cero», es «nadie hizo la
        // aritmética». Sin esto, la columna vacía se lee como un cuadre igual
        // que se leía el 0.0000 de la fila.
        const sinCalcular = filas.filter((f) => f.varianceCongelada === null).length;
        if (sinCalcular > 0 && legible(opts)) {
          process.stderr.write(
            deps.palette.dim(
              `  ${sinCalcular} sesión(es) con la variación en blanco: nadie ha hecho su aritmética. ` +
                'La columna de la fila vale 0 por DEFAULT y por eso no se imprime.\n'
            )
          );
        }
      })
  );

  // ---- bank reconciliation status ----------------------------------
  const reconStatus = reconciliation
    .command('status')
    .alias('estado')
    .argument('[session]', 'session id; without it, the one in progress for --account')
    .description(
      'Recompute the variance LIVE and print the two-sided breakdown: bank balance, its items one ' +
        'by one, adjusted; books balance, its items, adjusted; and the difference'
    );
  withOutput(withContext(reconStatus));
  reconStatus
    .option('--account <ref>', 'bank account whose in-progress session to read (name or id)')
    .option(
      '--tolerance <amount>',
      'residual the close may absorb; only valid where the tolerance policy admits one'
    );
  declareRisk(reconStatus, { risk: 'lectura', agent: true });
  reconStatus.action(
    (sesion: string | undefined, opts: CommonOpts & { account?: string; tolerance?: string }) =>
      run(async () => {
        if (!sesion && !opts.account) {
          throw usageError(
            'Di qué sesión: `bank reconciliation status <session>`, o --account para la que esté ' +
              'en curso en esa cuenta.'
          );
        }
        if (sesion && opts.account) {
          // Las dos formas nombran una sesión, y obedecer a una en silencio
          // enseñaría la aritmética de una sesión que no es la que se pidió.
          throw usageError(
            'El identificador y --account dicen lo mismo de dos maneras: da uno de los dos. ' +
              'Con --account se lee la sesión EN CURSO de esa cuenta.'
          );
        }
        const ctx = await entityOf(opts);
        const e = await estadoDeSesion(entityScope(ctx.tenantId, ctx.entityId), {
          sesionId: sesion,
          cuenta: opts.account,
          tolerancia: opts.tolerance
            ? exigirImporte('--tolerance', opts.tolerance)
            : undefined,
        });

        if (!legible(opts)) {
          render([estadoComoDocumento(e)], { ...opts, idField: 'id' });
          return;
        }

        const p = deps.palette;
        const out = process.stdout;
        out.write(
          `\n${p.bold(e.sesion.id)} ${p.dim(
            `· ${e.sesion.cuenta.nombre} (${e.sesion.cuenta.tipo}) · ${e.sesion.desde} → ` +
              `${e.sesion.hasta} · ${e.sesion.estado} · ${e.sesion.cuenta.moneda}`
          )}\n`
        );
        out.write(
          `  ${p.dim(
            e.sesion.statementId
              ? `extracto ${e.sesion.statementId} · declarado por el banco ` +
                `${e.saldoBancoDeclarado ?? '—'} · saldo inicial ${e.sesion.saldoInicial}`
              : 'sin extracto atado: el saldo del banco NO se puede observar'
          )}\n`
        );

        imprimirAritmetica(e);
        imprimirContadores(e);

        if (e.partidas.length) {
          out.write(`\n  ${p.bold('PARTIDAS')}\n`);
          render(e.partidas.map(partidaConciliatoriaComoFila), {
            format: 'table',
            idField: 'id',
            numeric: ['amount', 'age_days'],
            fields: COLUMNAS_PARTIDA_CONCILIATORIA.join(','),
          });
        }
        if (e.ajustes.length) {
          out.write(`\n  ${p.bold('AJUSTES')} ${p.dim('(borradores: nada se contabilizó solo)')}\n`);
          render(e.ajustes.map(ajusteComoFila), {
            format: 'table',
            idField: 'id',
            numeric: ['amount'],
            fields: COLUMNAS_AJUSTE.join(','),
          });
        }

        imprimirCongelado(e);
        imprimirBloqueantes(e);
        out.write('\n');
      })
  );

  // ---- bank reconciling-item list ----------------------------------
  const itemList = reconcilingItem
    .command('list')
    .alias('listar')
    .argument('<session>', 'reconciliation session id')
    .description(
      'List the typed reconciling items of a session — outstanding checks, deposits in transit, ' +
        'bank charges, errors — with age, owner, expected settlement date and escalation'
    );
  withOutput(withSelection(withContext(itemList)));
  itemList
    // Los seis tipos van en la DESCRIPCIÓN y no en el marcador: escritos ahí,
    // el marcador mide 117 caracteres y descuadra la columna entera de la
    // ayuda, que es la única superficie donde alguien los va a leer.
    .option('--type <name>', `only items of this type: ${TIPOS_DE_PARTIDA.join(', ')}`)
    .option(
      '--over-days <n>',
      'only what has gone MORE than this many days since its date',
      enteroDesdeCero('--over-days')
    );
  declareRisk(itemList, { risk: 'lectura', agent: true });
  itemList.action(
    (sesion: string, opts: CommonOpts & { type?: string; overDays?: number }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const alcance = alcanceDePartidas(opts.status, opts.all);
        // La forma del identificador se comprueba aquí porque este servicio no
        // lo hace: sin esto, un id mal tecleado sale como el error crudo de
        // Postgres («invalid input syntax for type uuid»), que no le dice nada
        // a quien lo tecleó.
        const todas = await listarPartidas(ctx.entityId, uuidDeBandera('<session>', sesion), {
          tipo: opts.type ? exigirTipoDePartida(opts.type) : undefined,
          overDays: opts.overDays,
          incluirResueltas: alcance.incluirResueltas,
        });
        const vivas = alcance.soloResueltas ? todas.filter((x) => x.resuelta) : todas;

        // EL TOPE SE APLICA AQUÍ Y SE DICE, como en `bank book-item list`:
        // `listarPartidas` devuelve las partidas de UNA sesión, que es un
        // conjunto acotado por construcción, así que el total se conoce y
        // `render` puede anunciar el truncado en las tres formas de salida —lo
        // que hace que `--offset` signifique algo en vez de mentir—.
        const desde = opts.offset ?? 0;
        const tope = opts.all ? vivas.length : (opts.limit ?? 50);
        const filas = vivas.slice(desde, desde + tope);

        render(filas.map(partidaConciliatoriaComoFila), {
          ...opts,
          idField: 'id',
          numeric: ['amount', 'age_days'],
          total: vivas.length,
          fields: opts.fields ?? (filas.length ? COLUMNAS_PARTIDA_CONCILIATORIA.join(',') : undefined),
        });

        if (legible(opts) && vivas.length) {
          const p = deps.palette;
          const vencidas = vivas.filter((x) => x.escalamiento === 'vencido').length;
          const sinFecha = vivas.filter((x) => !x.resuelta && x.fechaEsperada === null).length;
          process.stderr.write(
            p.dim(
              `  La más antigua lleva ${vivas[0].antiguedadDias} día(s). ${vencidas} vencida(s) y ` +
                `${sinFecha} sin fecha esperada: una partida sin fecha no se persigue, envejece.\n`
            )
          );
        }
      })
  );

  // ---- bank reconciling-item assign --------------------------------
  //
  // LO QUE HACÍA `close` INALCANZABLE DESDE EL BINARIO.
  //
  // `clasificarPartidas` levanta TODA partida sin `fecha_esperada` —a
  // propósito: nada en el extracto ni en el mayor sabe cuándo se cobrará un
  // cheque, e inventarla sería fabricar el patrón contra el que después se mide
  // el escalamiento—. Y `close` exige toda partida CLASIFICADA Y FECHADA. El
  // único escritor de esa fecha vivía sin puerta, así que la primera sesión con
  // una sola partida se quedaba bloqueada para siempre.
  //
  // El catálogo tampoco tenía fila: publicaba «responsable, fecha esperada y
  // estado de escalamiento» en el listado y no daba forma de fijar ninguno de
  // los tres. La fila se añadió en F05c con ese motivo escrito en su celda.
  const itemAssign = reconcilingItem
    .command('assign')
    .alias('asignar')
    .argument('<session>', 'reconciliation session id')
    .argument('<item>', 'reconciling item id')
    .description('Give a reconciling item an owner, an expected settlement date and notes');
  withContext(itemAssign);
  itemAssign
    .option('--owner <name>', 'who is chasing this item')
    .option('--expected <date>', 'expected settlement date (YYYY-MM-DD)')
    .option('--clear-expected', 'remove the expected date instead of setting one')
    .option('--escalation <level>', `escalation state: ${ESCALAMIENTOS.join(', ')}`)
    .option('--note <text>', 'note stored with the item')
    .option('--json', 'JSON output');
  // ✗ y no ✓: la fecha esperada es LA PROMESA DE ALGUIEN. Un agente que la
  // invente fabrica justo el patrón contra el que luego se mide si una partida
  // se está persiguiendo o envejeciendo sola.
  declareRisk(itemAssign, {
    risk: 'escritura',
    agent: false,
    writes: 'reconciling_items.responsable, fecha_esperada, escalamiento, notas',
  });
  itemAssign.action(
    (
      sesion: string,
      item: string,
      opts: CommonOpts & {
        owner?: string;
        expected?: string;
        clearExpected?: boolean;
        escalation?: string;
        note?: string;
      }
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(itemAssign, opts as unknown as Record<string, unknown>);
        const ctx = await entityOf(opts);

        if (opts.expected && opts.clearExpected) {
          throw usageError(
            '`--expected` y `--clear-expected` piden lo contrario: o se fija una fecha o se quita.'
          );
        }
        if (
          opts.owner === undefined && opts.expected === undefined &&
          !opts.clearExpected && opts.escalation === undefined && opts.note === undefined
        ) {
          throw usageError(
            'No hay nada que asignar: indica al menos --owner, --expected, --clear-expected, ' +
              '--escalation o --note.'
          );
        }
        if (opts.escalation && !ESCALAMIENTOS.includes(opts.escalation as never)) {
          throw usageError(
            `--escalation admite ${ESCALAMIENTOS.join(', ')}; llegó "${opts.escalation}".`
          );
        }

        // `--clear-expected` manda un null EXPLÍCITO. Sin distinguirlo de
        // «no lo mencionó», quitar la fecha sería imposible: el servicio sólo
        // toca los campos presentes.
        const seguimiento = {
          ...(opts.owner !== undefined ? { responsable: opts.owner } : {}),
          ...(opts.clearExpected
            ? { fechaEsperada: null }
            : opts.expected !== undefined
              ? { fechaEsperada: opts.expected }
              : {}),
          ...(opts.escalation !== undefined
            ? { escalamiento: opts.escalation as (typeof ESCALAMIENTOS)[number] }
            : {}),
          ...(opts.note !== undefined ? { notas: opts.note } : {}),
        };

        if (dryRun) {
          process.stdout.write(
            `${deps.palette.bold('Would assign')} ${deps.palette.dim(JSON.stringify(seguimiento))}\n`
          );
          return;
        }

        const r = await asignarPartida(
          ctx.entityId,
          uuidDeBandera('<session>', sesion),
          uuidDeBandera('<item>', item),
          seguimiento
        );
        render([partidaConciliatoriaComoFila(r)], { ...opts, idField: 'id' });
      })
  );

  // ---- bank reconciling-item correct -------------------------------
  //
  // La clasificación automática propone POR SIGNO, y el signo no distingue una
  // comisión de un error del banco. Sin esta hoja, cuatro de los seis tipos
  // —los dos errores entre ellos— eran inalcanzables desde el binario.
  const itemCorrect = reconcilingItem
    .command('correct')
    .alias('corregir')
    .argument('<session>', 'reconciliation session id')
    .argument('<item>', 'reconciling item id')
    .description('Say what a reconciling item really was, when the automatic proposal got it wrong');
  withContext(itemCorrect);
  itemCorrect
    .requiredOption('--type <name>', `what it really is: ${TIPOS_DE_PARTIDA.join(', ')}`)
    .option(
      '--amount <amount>',
      'its new contribution to the reconciliation; required when the type changes side'
    )
    .option('--json', 'JSON output');
  // ✗: decidir que una diferencia fue error DEL BANCO y no DE LOS LIBROS
  // decide a quién se le reclama.
  declareRisk(itemCorrect, {
    risk: 'escritura',
    agent: false,
    writes: 'reconciling_items.tipo, importe',
  });
  itemCorrect.action(
    (sesion: string, item: string, opts: CommonOpts & { type: string; amount?: string }) =>
      run(async () => {
        const { dryRun } = gateMutation(itemCorrect, opts as unknown as Record<string, unknown>);
        const ctx = await entityOf(opts);
        const tipo = exigirTipoDePartida(opts.type);

        if (dryRun) {
          process.stdout.write(
            `${deps.palette.bold(`Would reclassify as ${tipo}`)}` +
              (opts.amount ? deps.palette.dim(` with contribution ${opts.amount}`) : '') +
              '\n'
          );
          return;
        }

        const r = await reclasificarPartida(
          ctx.entityId,
          uuidDeBandera('<session>', sesion),
          uuidDeBandera('<item>', item),
          { tipo, ...(opts.amount !== undefined ? { importe: opts.amount } : {}) }
        );
        render([partidaConciliatoriaComoFila(r)], { ...opts, idField: 'id' });
      })
  );

  // ---- bank adjustment create --------------------------------------
  const adjCreate = adjustment
    .command('create')
    .alias('crear')
    .argument('<session>', 'reconciliation session the adjustment belongs to')
    .description(
      'Create the fee, VAT, interest, ISR withholding or error correction found in the session AS A ' +
        'DRAFT waiting for `mnemosine review`; it never posts anything itself'
    );
  withContext(adjCreate);
  withNote(adjCreate);
  adjCreate
    .requiredOption(`--type <${TIPOS_DE_AJUSTE.join('|')}>`, 'what the adjustment is')
    .requiredOption(
      '--amount <amount>',
      'SIGNED by its effect on the bank account: negative leaves the account, positive enters it'
    )
    .option(
      '--gl-account <code>',
      'counterparty GL account; required for the types whose accounting role is not seeded yet ' +
        `(${ROLES_QUE_FALTAN.map((r) => r.tipo).join(', ')})`
    )
    .option('--item <id>', 'the reconciling item this adjustment explains')
    .option('--json', 'JSON output');
  // ESCRITURA + IA ✓ con `draftOnly`, y aquí también es literal: lo que se
  // escribe es una fila en `reconciliation_adjustments` con
  // `journal_entry_id` NULL y un BORRADOR en `ai_drafts` que espera a
  // `mnemosine review`. La columna se rellena en F05d, al contabilizar detrás
  // de una firma; ninguna bandera de esta hoja abre ese camino. Es lo que el
  // catálogo promete en negritas («crea **como borradores**; nunca contabiliza
  // por su cuenta») y lo que `bank reconciliation status` deja COMPROBAR fila a
  // fila, enseñando `draft_status` junto a `journal_entry` vacío.
  declareRisk(adjCreate, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes:
      'reconciliation_adjustments (journal_entry_id NULL) + ai_drafts (borrador pendiente de ' +
      'revisión); NUNCA journal_entries',
  });
  adjCreate.action(
    (
      sesion: string,
      opts: CommonOpts & {
        type: string; amount: string; glAccount?: string; item?: string; note?: string;
      }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        gateMutation(adjCreate, opts as unknown as Record<string, unknown>);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const r = await crearAjuste(
          ctx.entityId,
          uuidDeBandera('<session>', sesion),
          {
            tipo: exigirTipoDeAjuste(opts.type),
            cuenta: opts.glAccount,
            // Firmado y como CADENA: el servicio comprueba que el signo y el
            // tipo estén de acuerdo y RECHAZA en vez de voltearlo, porque
            // voltear un signo por su cuenta es cómo un dato equivocado se
            // convierte en un asiento correcto de algo que no pasó.
            importe: exigirImporte('--amount', opts.amount),
          },
          reviewer.userId,
          {
            reconcilingItemId: opts.item ? uuidDeBandera('--item', opts.item) : undefined,
            descripcion: opts.note,
          }
        );

        const p = deps.palette;
        if (opts.json) {
          render(
            [
              {
                type: r.tipo,
                amount: r.importe,
                counterparty_account: r.cuenta,
                bank_account: r.cuentaDeBanco,
                draft: r.draftId,
                // SIEMPRE null aquí, y sale en la salida para que la promesa se
                // pueda comprobar sin abrir el código.
                journal_entry: r.journalEntryId,
                lines: r.lineas,
                id: r.id,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          process.stdout.write(
            `${p.green('✔')} ${p.bold(r.id)} ${p.dim(
              `· ${r.tipo} · ${r.importe} · contrapartida ${r.cuenta} · banco ${r.cuentaDeBanco} ` +
                `· borrador ${r.draftId}`
            )}\n`
          );
          for (const l of r.lineas) {
            process.stdout.write(
              `    ${l.account_code.padEnd(12)}${
                l.debit === undefined ? ''.padStart(14) : String(l.debit).padStart(14)
              }${l.credit === undefined ? '' : String(l.credit).padStart(14)}\n`
            );
          }
        }
        process.stderr.write(
          p.dim(
            `  Es un BORRADOR: espera a \`mnemosine review\`. \`journal_entry_id\` queda NULL hasta ` +
              `que \`bank reconciliation post\` (F05d) lo contabilice detrás de una firma.\n`
          )
        );
        // 11 es «no falló: espera a una persona», que es exactamente lo que
        // deja esta hoja. Un 0 diría que el ajuste ya está en los libros.
        return ExitCode.NEEDS_HUMAN;
      })
  );

  // ---- bank reconciliation close -----------------------------------
  const reconClose = reconciliation
    .command('close')
    .alias('cerrar')
    .argument('<session>', 'session to close')
    .description(
      'Recompute the whole arithmetic and move the session to `balanced` ONLY if the variance is ' +
        'exactly zero (or within the policy tolerance) and every item is classified and dated'
    );
  withContext(reconClose);
  withNote(reconClose);
  reconClose
    .option(
      '--tolerance <amount>',
      'residual this close may absorb; refused unless the tolerance policy admits one'
    )
    .option('--dry-run', 'do the whole thing and roll it back')
    .option('-y, --yes', 'skip the confirmation')
    .option('--json', 'JSON output');
  // ESCRITURA Y ✗, y es la hoja que el tramo entero existe para hacer
  // verdadera: mueve `status` a 'balanced', que es lo que `period-close.ts` lee
  // como la evidencia de que el efectivo de esta cuenta se verificó contra el
  // banco. Un agente no firma eso.
  declareRisk(reconClose, {
    risk: 'escritura',
    agent: false,
    writes:
      'reconciliation_sessions (status=balanced + arithmetic_computed_at + closed_at/by + las seis ' +
      'columnas del resumen CONGELADO); NUNCA una póliza — los ajustes siguen siendo borradores',
  });
  reconClose.action(
    (
      sesion: string,
      opts: CommonOpts & { tolerance?: string; note?: string; dryRun?: boolean; yes?: boolean }
    ) =>
      run(async () => {
        const ctx = await entityForWrite(opts);
        const { dryRun } = gateMutation(reconClose, opts as unknown as Record<string, unknown>);
        const scope = entityScope(ctx.tenantId, ctx.entityId);
        const tolerancia = opts.tolerance
          ? exigirImporte('--tolerance', opts.tolerance)
          : undefined;

        // SE LEE ANTES DE ACTUAR, y por una razón que no es la comodidad: un
        // rechazo que sólo dice «no cuadra» obliga a rehacer la resta a mano.
        // La verificación que MANDA sigue siendo la del servicio —recalcula
        // dentro de la transacción, con la fila bajo candado—; esto es la misma
        // lectura, para poder enseñar la aritmética completa antes de pedir la
        // firma y para nombrar lo que falta cuando no se puede dar.
        const previo = await estadoDeSesion(scope, { sesionId: sesion, tolerancia });
        if (previo.sesion.estado === 'in_progress' && !previo.listaParaCerrar) {
          const a = previo.aritmetica;
          if (opts.json) {
            render([{ ...estadoComoDocumento(previo), closed: false }], {
              json: true,
              idField: 'id',
            });
          } else {
            imprimirAritmetica(previo);
            imprimirContadores(previo);
            imprimirBloqueantes(previo);
            process.stdout.write(
              `\n  ${deps.palette.red('✘')} La sesión ${previo.sesion.id} no cierra: variación ` +
                `${a.variacion ?? 'NO CALCULADA (no es cero: falta un lado)'}, ` +
                `${a.sinClasificar} partida(s) sin clasificar y ${a.sinFechar} sin fechar.\n`
            );
          }
          process.stderr.write(
            deps.palette.dim(
              '  Marcarla "balanced" con esto abierto le diría al tablero de cierre que el efectivo ' +
                'de esta cuenta está verificado contra el banco.\n'
            )
          );
          return exitCodeFor({ statusCode: 422 });
        }

        // No se pregunta por una sesión que ya está firmada: la respuesta no
        // podría cambiar nada, y quien la conteste creería que sí. `cerrarSesion`
        // la rechaza con el conflicto que corresponde.
        if (!dryRun && opts.yes !== true && previo.sesion.estado === 'in_progress') {
          // La aritmética se enseña ANTES de preguntar: la orden es corta —tres
          // palabras y un id— y lo que se firma es una aseveración que otro
          // tablero lee como evidencia.
          if (legible(opts)) {
            imprimirAritmetica(previo);
            imprimirContadores(previo);
          }
          const ok = await ask(
            `Vas a firmar que la cuenta ${previo.sesion.cuenta.nombre} cuadra con el banco al ` +
              `${previo.sesion.hasta} (variación ${previo.aritmetica.variacion ?? '—'}). ` +
              '`period-close` lo leerá como la evidencia de que el efectivo se verificó. ¿Continuar?'
          );
          if (!ok) {
            throw abortedByUser(
              stdin.isTTY
                ? 'Sin cambios.'
                : 'Sin cambios: no hay terminal donde confirmar. Añade -y para cerrar sin preguntar.'
            );
          }
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const r = await cerrarSesion(
          scope,
          sesion,
          { tolerancia, notas: opts.note },
          { userId: reviewer.userId, dryRun }
        );

        const p = deps.palette;
        if (opts.json) {
          render(
            [
              {
                status: r.estado,
                variance: r.congelado.variance,
                books_balance: r.congelado.saldoLibros,
                outstanding_checks: r.congelado.chequesEnCirculacion,
                deposits_in_transit: r.congelado.depositosEnTransito,
                bank_charges: r.congelado.cargosDelBanco,
                bank_credits: r.congelado.abonosDelBanco,
                other_adjustments: r.congelado.otrosAjustes,
                arithmetic_computed_at: r.congelado.aritmeticaCalculadaEl,
                tolerance: r.aritmetica.tolerancia,
                policy_tolerance: r.criterios.tolerancia.valor,
                policy_unexplained_line: r.criterios.lineaSinPartida.valor,
                bank_adjusted: r.aritmetica.banco.ajustado,
                books_adjusted: r.aritmetica.libros.ajustado,
                closed: true,
                dry_run: r.ensayo,
                id: r.sesionId,
              },
            ],
            { json: true, idField: 'id' }
          );
        } else {
          process.stdout.write(
            `${dryRun ? p.yellow('◑') : p.green('✔')} ${p.bold(r.sesionId)} ${p.dim(
              `· ${r.estado} · variación ${r.aritmetica.variacion ?? '—'} · banco ajustado ` +
                `${r.aritmetica.banco.ajustado ?? '—'} = libros ajustado ` +
                `${r.aritmetica.libros.ajustado ?? '—'}`
            )}\n`
          );
          process.stdout.write(
            `  ${p.dim(
              `resumen congelado: libros ${r.congelado.saldoLibros} · cheques ` +
                `${r.congelado.chequesEnCirculacion} · depósitos ${r.congelado.depositosEnTransito} · ` +
                `cargos ${r.congelado.cargosDelBanco} · abonos ${r.congelado.abonosDelBanco} · ` +
                `otros ${r.congelado.otrosAjustes}`
            )}\n`
          );
        }
        // La marca que salió DE LA BASE: es la que el CHECK
        // `sesion_balanceada_con_aritmetica` de la 053 acaba de aceptar, y sin
        // ella la fila no habría podido llegar a 'balanced'.
        process.stderr.write(
          p.dim(
            `  Aritmética calculada el ${r.congelado.aritmeticaCalculadaEl ?? '—'}. ` +
              'Balanceada NO es aprobada ni contabilizada: `approve` exige que el aprobador no sea ' +
              'el preparador, y `post` es lo que mueve el mayor.\n'
          )
        );
        if (dryRun) {
          process.stderr.write(p.yellow('  Ensayo: se cerró de verdad y se deshizo.\n'));
        }
      })
  );

  // ---- bank reconciliation generate --------------------------------
  const reconGenerate = reconciliation
    .command('generate')
    .alias('generar')
    .argument('<session>', 'session to write the statement for')
    .description(
      'Produce the two-sided bank reconciliation statement for the audit file: json for the whole ' +
        'document, md/csv/tsv for the line-by-line statement, plain text to print'
    );
  withOutput(withContext(reconGenerate));
  declareRisk(reconGenerate, { risk: 'lectura', agent: true });
  reconGenerate.action((sesion: string, opts: CommonOpts) =>
    run(async () => {
      // EL PDF Y EL XLSX QUE NO SE FINGEN. El catálogo escribe
      // `--format <pdf|xlsx|json>` y el proyecto no tiene dependencia de
      // ninguno de los dos. Añadir una para este tramo, o peor, escribir un
      // archivo con extensión .pdf que no lo sea, pondría un documento falso en
      // un expediente de auditoría. Se rechaza nombrando lo que sí hay.
      const pedido = (opts.format ?? 'table').trim().toLowerCase();
      if (pedido === 'pdf' || pedido === 'xlsx') {
        throw usageError(
          `--format ${pedido} no existe todavía: el proyecto no tiene dependencia de PDF ni de ` +
            'XLSX y no se le añade una para fingir un documento que acabaría en un expediente. ' +
            'Lo que hay: --format json (el estado entero, con las dos columnas y el resumen ' +
            'congelado), --format md|csv|tsv (el estado en renglones) y la salida de texto por ' +
            'omisión, que es la que se imprime y se archiva.'
        );
      }

      const ctx = await entityOf(opts);
      const e = await estadoDeSesion(entityScope(ctx.tenantId, ctx.entityId), { sesionId: sesion });

      if (opts.json || pedido === 'json') {
        render([estadoComoDocumento(e)], { ...opts, json: true, idField: 'id' });
        return;
      }
      if (!legible(opts)) {
        // Un formato de tabla no puede llevar un documento anidado, así que
        // lleva lo que un estado de conciliación ES en papel: conceptos e
        // importes en el orden en que se suman. Sale de la MISMA aritmética que
        // el json, así que los dos no pueden discrepar.
        render(renglonesDelEstado(e), {
          ...opts,
          idField: 'line',
          numeric: ['amount'],
        });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(`\n${p.bold('ESTADO DE CONCILIACIÓN BANCARIA')}\n`);
      out.write(
        `  ${p.dim('cuenta')}   ${e.sesion.cuenta.nombre} (${e.sesion.cuenta.tipo}, ` +
          `${e.sesion.cuenta.moneda})\n` +
          `  ${p.dim('periodo')}  ${e.sesion.desde} → ${e.sesion.hasta}\n` +
          `  ${p.dim('extracto')} ${e.sesion.statementId ?? 'ninguno atado a la sesión'}\n` +
          `  ${p.dim('sesión')}   ${e.sesion.id} · ${e.sesion.estado}\n`
      );
      imprimirAritmetica(e);
      imprimirContadores(e);

      if (e.partidas.length) {
        out.write(`\n  ${p.bold('PARTIDAS CONCILIATORIAS')}\n`);
        render(e.partidas.map(partidaConciliatoriaComoFila), {
          format: 'table',
          idField: 'id',
          numeric: ['amount', 'age_days'],
          fields: COLUMNAS_PARTIDA_CONCILIATORIA.join(','),
        });
      }
      if (e.ajustes.length) {
        out.write(`\n  ${p.bold('AJUSTES')} ${p.dim('(borradores)')}\n`);
        render(e.ajustes.map(ajusteComoFila), {
          format: 'table',
          idField: 'id',
          numeric: ['amount'],
          fields: COLUMNAS_AJUSTE.join(','),
        });
      }
      imprimirCongelado(e);
      imprimirBloqueantes(e);

      // EL PIE DEL EXPEDIENTE. Se escribe lo que la fila DICE, sin inventar
      // firmas: una sesión sin `approved_by` sale como no aprobada, que es la
      // información que un auditor viene a buscar aquí.
      out.write(
        `\n  ${p.dim('preparó')}   ${e.sesion.cerradaPor ?? 'sin cerrar'}` +
          `${e.sesion.cerradaEl ? ` (${e.sesion.cerradaEl})` : ''}\n` +
          `  ${p.dim('aprobó')}    ${e.sesion.aprobadaPor ?? 'sin aprobar'}\n\n`
      );
    })
  );
}
