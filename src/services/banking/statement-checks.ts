import crypto from 'crypto';
import Decimal from 'decimal.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// F05a · LAS SIETE PRUEBAS DEL ESTADO DE CUENTA
//
// El modelo es el de `ledger check` (src/services/accounting/ledger-checks.ts):
// verificaciones con NOMBRE, `--check a,b` corre exactamente ésas, y cada una
// devuelve filas señalables con el número que falla dentro. La diferencia está
// en dónde vive: aquí NO SE TOCA LA BASE.
//
// Eso no es aseo, es la condición para que las siete se prueben. Una
// comprobación que sólo corre con Postgres detrás es una comprobación que nadie
// ejercita: hay que sembrar dos entidades, tres estados y cuarenta líneas para
// preguntar si 100 + 20 son 120, y por eso el caso raro —el traslape de un día,
// el número de estado que retrocede, el par de reversos en el límite de la
// ventana— nunca se escribe. Con el contexto en memoria, cada prueba es una
// función de datos a hallazgos y el caso raro cuesta cuatro líneas.
//
// El servicio (bank-statement-service.ts) es quien arma ese contexto: lee de
// Postgres acotando por entidad DENTRO del SQL y llama aquí. Y lo arma también
// ANTES de escribir, con lo que el parser acaba de leer, para que el import
// pueda rechazar el archivo del banco equivocado sin haberlo guardado.
//
//   cadena-de-saldos    saldo inicial + Σ importes = saldo final
//   continuidad         el inicial de éste = el final del anterior
//   huecos-y-traslapes  los periodos de la cuenta cubren sin solaparse
//   identidad           la cuenta que declara el archivo es ESTA cuenta
//   moneda              la del archivo es la de la cuenta
//   secuencia           el número de estado no salta
//   reversos            pares de importe opuesto a pocos días (advertencia)
//
// LA SEVERIDAD VIVE EN EL HALLAZGO, NO EN LA PRUEBA. Una misma prueba dice
// «esto está roto» (bloqueante) y «esto no lo pude verificar» (advertencia), y
// aplanar las dos al mismo nivel obliga a elegir entre callar una limitación o
// fingir un defecto. `reversos` es la única que jamás bloquea: un par opuesto
// puede ser una devolución legítima, y quien decide es un humano mirándolo.
// ============================================================

export interface HallazgoEstado {
  check: StatementCheckName;
  severity: 'blocking' | 'warning';
  /** Con qué se busca el estado señalado: su número si lo hay, o su id. */
  referencia: string;
  /** El porqué, en español y CON EL NÚMERO que falla dentro. */
  detalle: string;
}

export const STATEMENT_CHECK_NAMES = [
  'cadena-de-saldos',
  'continuidad',
  'huecos-y-traslapes',
  'identidad',
  'moneda',
  'secuencia',
  'reversos',
] as const;
export type StatementCheckName = (typeof STATEMENT_CHECK_NAMES)[number];

export interface CuentaVerificable {
  id: string;
  nombre: string;
  /** ISO 4217 de la cuenta. */
  moneda: string;
  /** checking | savings | petty-cash | credit-card | escrow */
  tipo?: string;
  /** Últimos 4 del identificador registrado (CLABE o número de cuenta). */
  ultimos4: string | null;
  /**
   * sha256 del identificador COMPLETO ya normalizado — NUNCA el identificador.
   * La CLABE se guarda cifrada y no puede viajar en claro ni siquiera a una
   * comprobación; su huella compara igual de bien y no revela nada.
   */
  huella: string | null;
}

export interface LineaVerificable {
  /** YYYY-MM-DD. */
  fecha: string;
  /** Firmado: el cargo es negativo. Es lo que hace sumable la cadena de saldos. */
  importe: string;
  descripcion: string;
  referencia?: string | null;
}

export interface EstadoVerificable {
  id: string;
  numeroDeEstado: string | null;
  /** YYYY-MM-DD. */
  periodoInicio: string;
  periodoFin: string;
  saldoInicial: string;
  saldoFinal: string;
  moneda: string;
  /**
   * La cuenta que el ARCHIVO dice ser (CLABE, IBAN o número enmascarado).
   * `null` cuando el archivo no la declaró — o cuando el estado ya está
   * guardado, porque `bank_statements` no conserva ese dato.
   */
  cuentaDeclarada: string | null;
  /** Las líneas del documento que están en la base (o las recién parseadas). */
  lineas: LineaVerificable[];
  /** Cuántas líneas trae el DOCUMENTO. Puede exceder a `lineas` si hubo dedupe. */
  lineasDeclaradas: number;
}

/** Un estado hermano, sin líneas: lo que basta para continuidad y periodos. */
export interface VecinoEstado {
  id: string;
  numeroDeEstado: string | null;
  periodoInicio: string;
  periodoFin: string;
  saldoInicial: string;
  saldoFinal: string;
}

export interface ContextoVerificacion {
  cuenta: CuentaVerificable;
  estado: EstadoVerificable;
  /**
   * TODOS los estados de la cuenta, el propio incluido, en cualquier orden:
   * aquí se ordenan. Se incluye el propio a propósito — quien arma el contexto
   * no tiene que acordarse de excluirlo, y excluirlo mal es un falso negativo
   * silencioso en tres de las siete pruebas.
   */
  vecinos: VecinoEstado[];
}

export interface OpcionesVerificacion {
  /** Ventana de `reversos`, en días. */
  diasReverso?: number;
}

const DIAS_REVERSO = 5;

/**
 * Tope de pares enumerados por `reversos`. Un estado con mil líneas de nómina
 * del mismo importe produce cientos de pares y ninguno se lee; el hallazgo
 * final dice cuántos quedaron fuera para que el tope no mienta por omisión.
 */
const MAX_REVERSOS = 50;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertFecha(valor: string, campo: string): string {
  if (!FECHA_RE.test(valor)) {
    throw new ValidationError(`Fecha ilegible en ${campo}: "${valor}". Se espera YYYY-MM-DD.`);
  }
  return valor;
}

function dec(valor: string, campo: string): Decimal {
  try {
    return new Decimal(valor);
  } catch {
    throw new ValidationError(`Importe ilegible en ${campo}: "${valor}".`);
  }
}

/** Días de calendario entre dos fechas. UTC a propósito: sin hora no hay huso. */
function diasEntre(desde: string, hasta: string): number {
  const [ay, am, ad] = desde.split('-').map(Number);
  const [by, bm, bd] = hasta.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Pesos y centavos, y los diezmilésimos SÓLO cuando el número los trae.
 *
 * El mínimo de dos es para que un importe se lea como dinero. El máximo de
 * cuatro es porque `bank_transactions.amount` es DECIMAL(19,4) y la diferencia
 * que denuncia esta prueba puede vivir entera ahí: un hallazgo bloqueante cuyo
 * detalle dice «0.00 de diferencia» acusa y no enseña qué, que es la forma más
 * segura de que nadie vuelva a mirar el tablero.
 */
const money = (d: Decimal): string => d.toFixed(d.decimalPlaces() > 2 ? 4 : 2);

// ── identidad de cuenta ─────────────────────────────────────────────────

const MASCARA_RE = /[*•·]|[xX]{3,}/;

/** Sólo lo que identifica: mayúsculas y alfanuméricos. "0123 4567" = "01234567". */
function normalizarCuenta(valor: string): string {
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * La huella de un identificador de cuenta, para comparar sin transportarlo.
 * `null` cuando lo que queda es demasiado corto para identificar nada —cuatro
 * dígitos los comparte una de cada diez mil cuentas— o cuando viene enmascarado,
 * que es el caso en el que sólo la cola sirve.
 */
export function huellaDeCuenta(valor: string | null | undefined): string | null {
  if (!valor || MASCARA_RE.test(valor)) return null;
  const limpio = normalizarCuenta(valor);
  if (limpio.length < 8) return null;
  return crypto.createHash('sha256').update(limpio).digest('hex');
}

function colaDe(valor: string): string | null {
  const digitos = valor.replace(/\D/g, '');
  return digitos.length >= 4 ? digitos.slice(-4) : null;
}

// ── las siete ───────────────────────────────────────────────────────────

function ref(e: { numeroDeEstado: string | null; id: string }): string {
  return e.numeroDeEstado ?? e.id;
}

function cadenaDeSaldos(ctx: ContextoVerificacion): HallazgoEstado[] {
  const { estado } = ctx;
  const hallazgos: HallazgoEstado[] = [];
  const inicial = dec(estado.saldoInicial, 'saldo inicial');
  const final = dec(estado.saldoFinal, 'saldo final');
  const suma = estado.lineas.reduce(
    (acc, l, i) => acc.plus(dec(l.importe, `línea ${i + 1}`)),
    new Decimal(0)
  );
  const esperado = inicial.plus(suma);

  // Las líneas que faltan se explican solas cuando además la cadena no cierra,
  // pero pueden sumar cero y dejarla cerrando: entonces este aviso es el único
  // rastro de que el documento y la base no contienen lo mismo.
  const faltantes = estado.lineasDeclaradas - estado.lineas.length;
  if (faltantes > 0) {
    hallazgos.push({
      check: 'cadena-de-saldos',
      severity: 'warning',
      referencia: ref(estado),
      detalle:
        `el documento declara ${estado.lineasDeclaradas} líneas y en la base hay ${estado.lineas.length}: ` +
        `${faltantes} se dedujeron contra otro estado por hash de contenido (periodos traslapados) o no entraron`,
    });
  }

  if (!esperado.eq(final)) {
    hallazgos.push({
      check: 'cadena-de-saldos',
      severity: 'blocking',
      referencia: ref(estado),
      detalle:
        `saldo inicial ${money(inicial)} + ${estado.lineas.length} líneas por ${money(suma)} da ${money(esperado)}, ` +
        `y el documento declara ${money(final)}: ${money(final.minus(esperado))} de diferencia`,
    });
  }
  return hallazgos;
}

/** Orden canónico de los estados de una cuenta: por periodo y, a igualdad, por id. */
function ordenar(vecinos: VecinoEstado[]): VecinoEstado[] {
  return [...vecinos].sort((a, b) => {
    if (a.periodoInicio !== b.periodoInicio) return a.periodoInicio < b.periodoInicio ? -1 : 1;
    if (a.periodoFin !== b.periodoFin) return a.periodoFin < b.periodoFin ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Los estados que preceden al que se examina, en orden.
 *
 * Mirar SIEMPRE hacia atrás no es una simplificación: es lo que hace que
 * verificar la cuenta entera con `-a` no reporte cada pareja dos veces, una
 * desde cada lado.
 *
 * Se compara por PERIODO y no por posición en la lista porque el estado que se
 * examina puede no estar en `vecinos` todavía: en el import es un candidato sin
 * fila, y buscarlo por índice devolvía −1 y trataba a TODA la historia como
 * anterior. Importar un extracto viejo entre dos que ya estaban denunciaba
 * entonces un hueco que no existe.
 */
function claveDeOrden(v: { periodoInicio: string; periodoFin: string; id: string }): string {
  return `${v.periodoInicio}|${v.periodoFin}|${v.id}`;
}

function anteriores(ctx: ContextoVerificacion): VecinoEstado[] {
  const propia = claveDeOrden(ctx.estado);
  return ordenar(ctx.vecinos).filter(
    (v) => v.id !== ctx.estado.id && claveDeOrden(v) < propia
  );
}

function continuidad(ctx: ContextoVerificacion): HallazgoEstado[] {
  const previos = anteriores(ctx);
  const anterior = previos[previos.length - 1];
  // El primer estado de una cuenta no tiene con qué ser continuo. Callar aquí
  // es correcto; inventarle un cero de arranque sería un falso hallazgo.
  if (!anterior) return [];

  const inicial = dec(ctx.estado.saldoInicial, 'saldo inicial');
  const finalPrevio = dec(anterior.saldoFinal, 'saldo final del anterior');
  if (inicial.eq(finalPrevio)) return [];

  return [
    {
      check: 'continuidad',
      severity: 'blocking',
      referencia: ref(ctx.estado),
      detalle:
        `abre en ${money(inicial)} y el estado anterior (${ref(anterior)}, cerrado el ${anterior.periodoFin}) ` +
        `cerró en ${money(finalPrevio)}: faltan ${money(inicial.minus(finalPrevio))} sin documento que los explique`,
    },
  ];
}

function huecosYTraslapes(ctx: ContextoVerificacion): HallazgoEstado[] {
  const previos = anteriores(ctx);
  if (previos.length === 0) return [];

  // Marca de agua sobre TODOS los anteriores y no sólo sobre el inmediato: un
  // estado corto contenido dentro de uno largo deja al siguiente pareciendo
  // que abre un hueco que en realidad ya estaba cubierto.
  let cubiertoHasta = previos[0].periodoFin;
  let quienCubre = previos[0];
  for (const v of previos) {
    if (v.periodoFin > cubiertoHasta) {
      cubiertoHasta = v.periodoFin;
      quienCubre = v;
    }
  }

  const inicio = assertFecha(ctx.estado.periodoInicio, 'periodo de inicio');
  const dias = diasEntre(cubiertoHasta, inicio);
  if (dias > 1) {
    return [
      {
        check: 'huecos-y-traslapes',
        severity: 'blocking',
        referencia: ref(ctx.estado),
        detalle:
          `abre el ${inicio} y la cuenta estaba cubierta sólo hasta el ${cubiertoHasta} (${ref(quienCubre)}): ` +
          `${dias - 1} día(s) sin estado de cuenta`,
      },
    ];
  }
  if (dias <= 0) {
    return [
      {
        check: 'huecos-y-traslapes',
        severity: 'blocking',
        referencia: ref(ctx.estado),
        detalle:
          `abre el ${inicio}, dentro del periodo de ${ref(quienCubre)} que llega al ${cubiertoHasta}: ` +
          `${1 - dias} día(s) contados dos veces`,
      },
    ];
  }
  return [];
}

function identidad(ctx: ContextoVerificacion): HallazgoEstado[] {
  const { cuenta, estado } = ctx;
  const declarada = estado.cuentaDeclarada?.trim();
  if (!declarada) {
    return [
      {
        check: 'identidad',
        severity: 'warning',
        referencia: ref(estado),
        detalle:
          `no consta qué cuenta declaró el archivo, así que no se puede afirmar que sea la de ` +
          `${cuenta.nombre}${cuenta.ultimos4 ? ` (…${cuenta.ultimos4})` : ''}: la identidad se comprueba en el ` +
          `import y bank_statements no conserva ese dato`,
      },
    ];
  }

  const huellaArchivo = huellaDeCuenta(declarada);
  if (huellaArchivo && cuenta.huella) {
    if (huellaArchivo === cuenta.huella) return [];
    return [
      {
        check: 'identidad',
        severity: 'blocking',
        referencia: ref(estado),
        detalle:
          `el archivo declara la cuenta ${enmascarar(declarada)} y se está usando la de ${cuenta.nombre}` +
          `${cuenta.ultimos4 ? ` (…${cuenta.ultimos4})` : ''}: es el extracto de otra cuenta`,
      },
    ];
  }

  // Sin huella comparable —archivo enmascarado, o cuenta sin identificador
  // completo registrado— quedan los últimos cuatro. Distinguen mal (una de
  // cada diez mil cuentas los comparte) pero cazan lo que de verdad ocurre:
  // importar el extracto de OTRO banco en la cuenta equivocada.
  const colaArchivo = colaDe(declarada);
  if (!colaArchivo || !cuenta.ultimos4) {
    return [
      {
        check: 'identidad',
        severity: 'warning',
        referencia: ref(estado),
        detalle:
          `el archivo declara "${enmascarar(declarada)}" y la cuenta ${cuenta.nombre} ` +
          `${cuenta.ultimos4 ? 'sólo tiene registrados sus últimos 4' : 'no tiene identificador registrado'}: ` +
          `no hay con qué comparar`,
      },
    ];
  }
  if (colaArchivo === cuenta.ultimos4) return [];
  return [
    {
      check: 'identidad',
      severity: 'blocking',
      referencia: ref(estado),
      detalle:
        `el archivo termina en …${colaArchivo} y la cuenta ${cuenta.nombre} termina en …${cuenta.ultimos4}: ` +
        `es el extracto de otra cuenta`,
    },
  ];
}

/** Nunca se repite entero un identificador ajeno en un mensaje: sólo su cola. */
function enmascarar(valor: string): string {
  const limpio = normalizarCuenta(valor);
  return limpio.length <= 4 ? limpio : `…${limpio.slice(-4)}`;
}

function moneda(ctx: ContextoVerificacion): HallazgoEstado[] {
  const delEstado = ctx.estado.moneda?.toUpperCase();
  const deLaCuenta = ctx.cuenta.moneda?.toUpperCase();
  if (!delEstado || !deLaCuenta || delEstado === deLaCuenta) return [];
  return [
    {
      check: 'moneda',
      severity: 'blocking',
      referencia: ref(ctx.estado),
      detalle:
        `el estado viene en ${delEstado} y la cuenta ${ctx.cuenta.nombre} opera en ${deLaCuenta}: ` +
        `sumar los dos daría un saldo que no existe en ninguna de las dos monedas`,
    },
  ];
}

/** "2026-07" → { prefijo: "2026-", n: 7 }. "17" → { prefijo: "", n: 17 }. */
function partirNumero(valor: string | null): { prefijo: string; n: number } | null {
  if (!valor) return null;
  const m = /^(.*?)(\d+)$/.exec(valor.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) ? { prefijo: m[1].toUpperCase(), n } : null;
}

function secuencia(ctx: ContextoVerificacion): HallazgoEstado[] {
  const actual = partirNumero(ctx.estado.numeroDeEstado);
  if (!actual) return []; // El banco no los publica: la prueba no aplica.

  const previos = anteriores(ctx);
  // El anterior CON número, que no siempre es el inmediato.
  let anterior: { v: VecinoEstado; p: { prefijo: string; n: number } } | null = null;
  for (let i = previos.length - 1; i >= 0; i--) {
    const p = partirNumero(previos[i].numeroDeEstado);
    if (p) {
      anterior = { v: previos[i], p };
      break;
    }
  }
  if (!anterior) return [];

  // Series distintas no se comparan: cuando el banco reinicia la numeración
  // cada año, el 2026-01 después del 2025-12 no es un salto.
  if (anterior.p.prefijo !== actual.prefijo) return [];

  if (actual.n === anterior.p.n + 1) return [];
  if (actual.n <= anterior.p.n) {
    return [
      {
        check: 'secuencia',
        severity: 'blocking',
        referencia: ref(ctx.estado),
        detalle:
          `lleva el número ${actual.n} y el estado anterior ya llevaba el ${anterior.p.n}: ` +
          `la numeración no avanza, así que uno de los dos documentos está mal identificado`,
      },
    ];
  }
  const faltan = actual.n - anterior.p.n - 1;
  return [
    {
      check: 'secuencia',
      severity: 'blocking',
      referencia: ref(ctx.estado),
      detalle:
        `entre el ${anterior.p.n} y el ${actual.n} falta(n) ${faltan} estado(s) —` +
        `${anterior.p.prefijo}${anterior.p.n + 1}${faltan > 1 ? `…${anterior.p.prefijo}${actual.n - 1}` : ''}— ` +
        `aunque las fechas no dejen hueco`,
    },
  ];
}

function reversos(ctx: ContextoVerificacion, opts: OpcionesVerificacion): HallazgoEstado[] {
  const ventana = opts.diasReverso ?? DIAS_REVERSO;
  const lineas = ctx.estado.lineas
    .map((l, i) => ({ ...l, i }))
    .filter((l) => FECHA_RE.test(l.fecha))
    .sort((a, b) => (a.fecha === b.fecha ? a.i - b.i : a.fecha < b.fecha ? -1 : 1));

  // Por VALOR ABSOLUTO: sólo dentro de un mismo importe puede haber un par
  // opuesto, y agrupar primero evita comparar cada línea contra todas.
  const cubos = new Map<string, typeof lineas>();
  for (const l of lineas) {
    const clave = dec(l.importe, `línea ${l.i + 1}`).abs().toFixed(4);
    if (clave === '0.0000') continue; // Un cero no tiene contrario.
    const cubo = cubos.get(clave);
    if (cubo) cubo.push(l);
    else cubos.set(clave, [l]);
  }

  const pares: HallazgoEstado[] = [];
  let total = 0;
  for (const [clave, cubo] of cubos) {
    if (cubo.length < 2) continue;
    const usada = new Set<number>();
    for (let i = 0; i < cubo.length; i++) {
      if (usada.has(cubo[i].i)) continue;
      const signoI = dec(cubo[i].importe, 'importe').isNegative();
      for (let j = i + 1; j < cubo.length; j++) {
        if (usada.has(cubo[j].i)) continue;
        if (diasEntre(cubo[i].fecha, cubo[j].fecha) > ventana) break; // Ordenado: lo demás está más lejos.
        if (dec(cubo[j].importe, 'importe').isNegative() === signoI) continue;
        usada.add(cubo[i].i);
        usada.add(cubo[j].i);
        total++;
        if (pares.length < MAX_REVERSOS) {
          pares.push({
            check: 'reversos',
            severity: 'warning',
            referencia: ref(ctx.estado),
            detalle:
              `${cubo[i].fecha} «${recortar(cubo[i].descripcion)}» por ${cubo[i].importe} y ` +
              `${cubo[j].fecha} «${recortar(cubo[j].descripcion)}» por ${cubo[j].importe} ` +
              `(${clave} en sentidos opuestos, ${diasEntre(cubo[i].fecha, cubo[j].fecha)} día(s) aparte): ` +
              `devolución legítima o el mismo movimiento cargado dos veces`,
          });
        }
        break;
      }
    }
  }

  if (total > pares.length) {
    pares.push({
      check: 'reversos',
      severity: 'warning',
      referencia: ref(ctx.estado),
      detalle: `y ${total - pares.length} par(es) más no enumerado(s): el tope de la prueba es ${MAX_REVERSOS}`,
    });
  }
  return pares;
}

function recortar(texto: string): string {
  const t = (texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

const RUNNERS: Record<
  StatementCheckName,
  (ctx: ContextoVerificacion, opts: OpcionesVerificacion) => HallazgoEstado[]
> = {
  'cadena-de-saldos': (ctx) => cadenaDeSaldos(ctx),
  continuidad: (ctx) => continuidad(ctx),
  'huecos-y-traslapes': (ctx) => huecosYTraslapes(ctx),
  identidad: (ctx) => identidad(ctx),
  moneda: (ctx) => moneda(ctx),
  secuencia: (ctx) => secuencia(ctx),
  reversos,
};

/**
 * Valida los nombres pedidos. Sin nombres corren LAS SIETE: a diferencia de
 * `ledger check`, cuyo contrato es «sin bandera, las bloqueantes», el catálogo
 * promete aquí las siete pruebas, y `reversos` —la única que nunca bloquea— es
 * justamente la que un import quiere ver.
 */
export function resolverChecks(nombres: string[] | undefined): StatementCheckName[] {
  if (!nombres?.length) return [...STATEMENT_CHECK_NAMES];
  const pedidos = nombres.map((n) => n.trim()).filter((n) => n.length > 0);
  const desconocidos = pedidos.filter(
    (n) => !(STATEMENT_CHECK_NAMES as readonly string[]).includes(n)
  );
  if (desconocidos.length > 0) {
    throw new ValidationError(
      `Verificación desconocida: ${desconocidos.join(', ')}. Disponibles: ${STATEMENT_CHECK_NAMES.join(', ')}.`
    );
  }
  return pedidos as StatementCheckName[];
}

/** Corre las pruebas pedidas sobre UN estado. Sin base de datos, a propósito. */
export function runStatementChecks(
  ctx: ContextoVerificacion,
  nombres?: string[],
  opts: OpcionesVerificacion = {}
): HallazgoEstado[] {
  assertFecha(ctx.estado.periodoInicio, `periodo de inicio de ${ref(ctx.estado)}`);
  assertFecha(ctx.estado.periodoFin, `periodo de fin de ${ref(ctx.estado)}`);
  for (const v of ctx.vecinos) {
    assertFecha(v.periodoInicio, `periodo de inicio de ${ref(v)}`);
    assertFecha(v.periodoFin, `periodo de fin de ${ref(v)}`);
  }
  if (diasEntre(ctx.estado.periodoInicio, ctx.estado.periodoFin) < 0) {
    throw new ValidationError(
      `El periodo de ${ref(ctx.estado)} termina el ${ctx.estado.periodoFin}, antes de empezar el ${ctx.estado.periodoInicio}.`
    );
  }

  const hallazgos: HallazgoEstado[] = [];
  for (const nombre of resolverChecks(nombres)) {
    hallazgos.push(...RUNNERS[nombre](ctx, opts));
  }
  return hallazgos;
}

/** Un hallazgo bloqueante es lo que hace que `bank statement check` salga 4. */
export const hayBloqueantes = (h: HallazgoEstado[]): boolean =>
  h.some((x) => x.severity === 'blocking');
