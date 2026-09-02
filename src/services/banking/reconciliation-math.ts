import Decimal from 'decimal.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// LA ARITMÉTICA DE DOS LADOS, SIN BASE DE DATOS (F05c)
//
// Éste es el archivo del que habla el comentario más largo del módulo, el que
// acompaña al endpoint retirado: «toda la implementación era un UPDATE
// poniendo status = 'balanced'; nunca calculó el saldo de libros, nunca lo
// comparó con el del banco». Lo que faltaba no era una columna: era esta
// resta.
//
// NO TOCA POSTGRES, Y ESO ES UN REQUISITO. En F05a las siete pruebas del
// extracto se separaron de la base por la misma razón, y la razón no es
// comodidad: una comprobación que sólo se puede ejercitar con Postgres detrás
// es la que acaba mintiendo, porque el escenario cuesta tanto de sembrar que
// nadie escribe el caso incómodo. Aquí el caso incómodo —«los dos lados en
// cero porque nadie los miró»— es una llamada de cuatro líneas.
//
// EL CERO QUE NO ES UN CERO. El defecto histórico no fue una variación mal
// calculada, fue una variación NUNCA calculada que valía cero por DEFAULT y se
// leía como cuadre. Por eso aquí `null` y `'0.00'` son cosas distintas y el
// tipo lo obliga: `saldo`, `ajustado` y `variacion` son `string | null`, y el
// null significa «nadie observó este número». Un `variacion: string` habría
// obligado a inventar un cero justo en el único punto donde el cero es la
// mentira. Quien lea `variacion === null` no puede confundirlo con cuadre; el
// CHECK `sesion_balanceada_con_aritmetica` de la 053 es el mismo guardia visto
// desde el esquema.
//
// EL SIGNO VIVE EN EL DATO. `reconciling_items.importe` llega FIRMADO POR SU
// APORTACIÓN a la conciliación y no por el signo del movimiento, así que la
// aritmética real es una SUMA y no un árbol de casos por tipo. Es deliberado:
// quien tenga que recordar «el cheque en circulación resta» lo olvidará una
// vez y descuadrará en silencio. Aquí no hay dónde olvidarlo, porque no hay
// ninguna resta condicionada al tipo — sólo `LADO_DE`, que dice a cuál de las
// dos columnas se suma cada partida.
//
// LO QUE ESTE MÓDULO NO DECIDE. No aplica políticas. `cuadra` es aritmética
// pura —«la variación se observó y cabe en la tolerancia»— y los `reparos` son
// HECHOS, no un veredicto de cierre: si una línea de banco sin explicar impide
// cerrar o se arrastra como partida conciliatoria lo dice la política
// `linea_banco_sin_partida_al_cierre`, que se lee en el servicio. Un módulo
// puro que consultara el panel dejaría de ser puro por la puerta de atrás.
// ============================================================

/**
 * Los seis tipos del CHECK de `reconciling_items.tipo` (053).
 *
 * No se copian «por si acaso»: son el vocabulario del esquema, y una lista
 * local que se separe de él haría que una partida imposible de insertar
 * pareciera válida aquí.
 */
export const TIPOS_DE_PARTIDA = [
  'cheque-en-circulacion',
  'deposito-en-transito',
  'cargo-del-banco',
  'abono-del-banco',
  'error-del-banco',
  'error-de-libros',
] as const;
export type TipoDePartida = (typeof TIPOS_DE_PARTIDA)[number];

export type LadoDeLaConciliacion = 'banco' | 'libros';

/**
 * A qué lado se suma cada tipo. Es TODA la especialización por tipo que existe
 * en este archivo.
 *
 * El criterio no es «dónde está el dinero» sino QUIÉN NO LO SABE TODAVÍA:
 *   · El cheque en circulación y el depósito en tránsito están en LIBROS y el
 *     banco aún no los muestra, así que corrigen el SALDO DEL BANCO.
 *   · El cargo y el abono del banco están en el EXTRACTO y los libros aún no
 *     los registran, así que corrigen el SALDO DE LIBROS.
 *   · El error se corrige del lado que se equivocó, y por eso son dos tipos y
 *     no uno: al banco se le reclama, a los libros se les postea un ajuste.
 */
export const LADO_DE: Readonly<Record<TipoDePartida, LadoDeLaConciliacion>> = {
  'cheque-en-circulacion': 'banco',
  'deposito-en-transito': 'banco',
  'cargo-del-banco': 'libros',
  'abono-del-banco': 'libros',
  'error-del-banco': 'banco',
  'error-de-libros': 'libros',
};

/**
 * Una partida conciliatoria tal como entra a la aritmética.
 *
 * `tipo` admite `null` porque la partida existe antes de estar clasificada:
 * `run` la levanta del extracto y del mayor, y hasta que alguien diga qué es,
 * no puede sumarse a ningún lado. Una partida sin tipo no descuadra la
 * aritmética —no entra en ella—, pero sí impide cerrar, que es distinto y es
 * lo que `sinClasificar` cuenta.
 */
export interface PartidaParaAritmetica {
  id?: string;
  tipo: TipoDePartida | null;
  /** Dinero como CADENA, firmado por su aportación. Nunca `number`. */
  importe: string;
  /** `fecha_esperada`: cuándo se espera que deje de ser una partida. */
  fechaEsperada?: string | null;
  /** `resuelta_at != null`: ya dejó de explicar una diferencia. */
  resuelta?: boolean;
}

export interface EntradaAritmetica {
  /**
   * `ending_balance_per_bank`, que sale del EXTRACTO y no de la columna de la
   * sesión. `null` cuando no hay extracto atado: ahí está el defecto que este
   * tramo existe para impedir, y por eso es `null` y no `'0'`.
   */
  saldoBanco: string | null;
  /**
   * Σ de las líneas posteadas contra `bank_accounts.gl_account_id` hasta el
   * cierre del periodo. `null` cuando no se consultó.
   */
  saldoLibros: string | null;
  partidas: readonly PartidaParaAritmetica[];
  /**
   * Movimientos del extracto que nadie explica todavía: ni cotejados, ni
   * levantados como partida. Cuentan en `sinClasificar` y producen su reparo;
   * si eso impide cerrar lo dice la política, no este módulo.
   */
  movimientosSinExplicar?: number;
  /**
   * Lo que la política `conciliacion_tolerancia` admite de residual. Por
   * omisión `'0'`, que es `cero_exacto`: la variación tiene que ser
   * EXACTAMENTE cero.
   */
  tolerancia?: string;
}

/** Un lado de la conciliación, con su desglose ya sumado por tipo. */
export interface LadoConciliado {
  /** El saldo observado. `null` cuando nadie lo observó, que no es cero. */
  saldo: string | null;
  /** El desglose POR TIPO, en el orden de `TIPOS_DE_PARTIDA`. */
  partidas: { tipo: TipoDePartida; importe: string }[];
  /** `saldo` + Σpartidas. `null` cuando el saldo no se observó. */
  ajustado: string | null;
}

/** Los reparos que la aritmética levanta. Hechos, no veredicto de cierre. */
export const CODIGOS_DE_REPARO = [
  /** Un lado no se observó. No hay resta posible, y el cero no la suple. */
  'saldo-no-observado',
  /** Se restó, y no dio cero (ni cabe en la tolerancia). */
  'variacion-fuera-de-tolerancia',
  /** Hay partidas sin tipo: no se pueden sumar a ningún lado. */
  'partida-sin-clasificar',
  /** Hay partidas abiertas sin `fecha_esperada`: no se pueden perseguir. */
  'partida-sin-fechar',
  /** El extracto trae movimientos que nada explica. */
  'linea-de-banco-sin-explicar',
] as const;
export type CodigoDeReparo = (typeof CODIGOS_DE_REPARO)[number];

export interface Reparo {
  codigo: CodigoDeReparo;
  /** En español y con los números dentro: un reparo que sólo se nombra se ignora. */
  detalle: string;
}

export interface Aritmetica {
  banco: LadoConciliado;
  libros: LadoConciliado;
  /** banco.ajustado − libros.ajustado. `null` si algún lado no se observó. */
  variacion: string | null;
  /** La variación se OBSERVÓ y cabe en la tolerancia. Nunca cierto con `variacion === null`. */
  cuadra: boolean;
  /** Partidas sin tipo + movimientos del extracto que nadie explica. */
  sinClasificar: number;
  /** Partidas abiertas sin `fecha_esperada`. */
  sinFechar: number;
  /** La tolerancia efectivamente aplicada, para que la salida diga bajo qué regla cuadró. */
  tolerancia: string;
  /**
   * Partidas ya resueltas, EXCLUIDAS de la suma. Se cuentan para que su
   * exclusión no sea silenciosa: una partida resuelta dejó de explicar una
   * diferencia, y seguir sumándola inventaría una.
   */
  resueltas: number;
  reparos: Reparo[];
}

/**
 * Pesos y centavos SIN tirar los diezmilésimos que la columna guarda.
 *
 * Es el mismo criterio de `bank-statement-service.monto` y por la misma razón:
 * `reconciling_items.importe` y los saldos son DECIMAL(19,4), y un `toFixed(2)`
 * sobre lo que sale de la base no es formato, es una PÉRDIDA que después se
 * suma. Dos intereses de 0.1250 recortados a la salida son 0.13 + 0.13 = 0.26
 * contra un abono real de 0.25, y la conciliación denuncia un centavo que no
 * falta. En F05a este mismo recorte produjo tres defectos, y el peor hacía que
 * dos verbos contestaran cosas distintas sobre el mismo documento.
 *
 * Se exporta para que el servicio formatee con ESTA función y no con una copia
 * que se separe de ella.
 */
export function monto(valor: Decimal): string {
  return valor.toFixed(valor.decimalPlaces() > 2 ? 4 : 2);
}

/**
 * Un importe a Decimal, rechazando lo ilegible en vez de dejar pasar un NaN.
 *
 * Un `new Decimal('')` lanza y un `Number('')` da 0: la segunda forma es
 * exactamente cómo un campo vacío se convierte en un cuadre falso.
 */
function dec(valor: string, campo: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(valor);
  } catch {
    throw new ValidationError(`Importe ilegible en ${campo}: "${valor}".`);
  }
  if (!d.isFinite()) {
    throw new ValidationError(`Importe no finito en ${campo}: "${valor}".`);
  }
  return d;
}

function esTipoConocido(tipo: string): tipo is TipoDePartida {
  return (TIPOS_DE_PARTIDA as readonly string[]).includes(tipo);
}

/**
 * LA ARITMÉTICA DE DOS LADOS, VIVA.
 *
 *   saldo banco (del extracto)
 *     − cheques en circulación   (en libros, el banco aún no los muestra)
 *     + depósitos en tránsito    (en libros, el banco aún no los abona)
 *     ± errores del banco
 *     = SALDO BANCO AJUSTADO
 *
 *   saldo libros (líneas posteadas contra la cuenta de mayor de la cuenta)
 *     − cargos del banco no registrados   (comisión, IVA, ISR retenido)
 *     + abonos del banco no registrados   (intereses)
 *     ± errores de libros
 *     = SALDO LIBROS AJUSTADO
 *
 *   variación = saldo banco ajustado − saldo libros ajustado
 *
 * Las restas y las sumas de arriba NO aparecen en el cuerpo: el signo ya vive
 * en `importe`, así que cada lado es `saldo.plus(Σ)`. Si algún día alguien
 * añade aquí un `if (tipo === 'cheque-en-circulacion') menos(...)`, habrá
 * duplicado la regla en dos sitios y uno de los dos envejecerá.
 *
 * Se llama SIEMPRE en `bank reconciliation status` y SIEMPRE en
 * `bank reconciliation close`. Ninguna superficie lee `reconciliation_sessions.
 * variance` como la respuesta: esa columna es el resumen CONGELADO al cerrar
 * —la aseveración que se hizo—, y contrastarla con esto es justo lo que
 * permite descubrir que la sesión de marzo ya no dice la verdad.
 */
export function calcularAritmetica(entrada: EntradaAritmetica): Aritmetica {
  const tolerancia = dec(entrada.tolerancia ?? '0', 'tolerancia').abs();

  const sumas = new Map<TipoDePartida, Decimal>();
  let sinTipo = 0;
  let sinFechar = 0;
  let resueltas = 0;

  for (const [i, p] of entrada.partidas.entries()) {
    const donde = p.id ? `partida ${p.id}` : `partida #${i + 1}`;

    // LA PARTIDA RESUELTA NO SUMA. Dejó de explicar una diferencia —el cheque
    // se cobró, el depósito llegó—, y seguir sumándola inventaría la
    // diferencia que ya no existe. Se cuenta para que la exclusión se vea.
    if (p.resuelta) {
      resueltas++;
      continue;
    }

    if (p.tipo === null) {
      // No se suma a ningún lado: no se sabe a cuál. Sumarla «a lo que
      // parezca» por el signo del importe sería adivinar, y el signo del dato
      // es su APORTACIÓN, que es justo lo que todavía nadie ha decidido.
      sinTipo++;
      if (!p.fechaEsperada) sinFechar++;
      continue;
    }
    if (!esTipoConocido(p.tipo)) {
      // Un tipo que el CHECK de la 053 no admite no puede venir de la base:
      // viene de un llamador que se lo inventó, y tratarlo como «sin
      // clasificar» lo escondería dentro de un conteo.
      throw new ValidationError(
        `Tipo de partida conciliatoria desconocido en ${donde}: "${String(p.tipo)}". ` +
          `Los admitidos son: ${TIPOS_DE_PARTIDA.join(', ')}.`
      );
    }

    if (!p.fechaEsperada) sinFechar++;

    const importe = dec(p.importe, `${donde}.importe`);
    sumas.set(p.tipo, (sumas.get(p.tipo) ?? new Decimal(0)).plus(importe));
  }

  const saldoBanco = entrada.saldoBanco === null ? null : dec(entrada.saldoBanco, 'saldoBanco');
  const saldoLibros = entrada.saldoLibros === null ? null : dec(entrada.saldoLibros, 'saldoLibros');

  const lado = (cual: LadoDeLaConciliacion, saldo: Decimal | null): LadoConciliado => {
    // El orden es el de `TIPOS_DE_PARTIDA` y no el de llegada: el desglose se
    // imprime, y un desglose que cambia de orden entre dos corridas no se
    // puede comparar de un vistazo.
    const desglose = TIPOS_DE_PARTIDA.filter((t) => LADO_DE[t] === cual && sumas.has(t)).map((t) => ({
      tipo: t,
      importe: monto(sumas.get(t) as Decimal),
    }));
    const total = TIPOS_DE_PARTIDA.filter((t) => LADO_DE[t] === cual).reduce(
      (acc, t) => acc.plus(sumas.get(t) ?? 0),
      new Decimal(0)
    );
    return {
      saldo: saldo === null ? null : monto(saldo),
      partidas: desglose,
      ajustado: saldo === null ? null : monto(saldo.plus(total)),
    };
  };

  const banco = lado('banco', saldoBanco);
  const libros = lado('libros', saldoLibros);

  // LA RESTA SÓLO EXISTE SI LOS DOS LADOS SE OBSERVARON. Rellenar el lado que
  // falta con cero produciría una variación que parece calculada y no lo está:
  // es, literalmente, el defecto que la 053 vino a volver imposible.
  const variacionDec =
    banco.ajustado === null || libros.ajustado === null
      ? null
      : new Decimal(banco.ajustado).minus(libros.ajustado);

  const sinClasificar = sinTipo + (entrada.movimientosSinExplicar ?? 0);

  const reparos: Reparo[] = [];
  if (saldoBanco === null || saldoLibros === null) {
    const faltan = [
      saldoBanco === null ? 'el del banco (no hay extracto atado a la sesión)' : null,
      saldoLibros === null ? 'el de libros (no se consultó el mayor)' : null,
    ].filter((x): x is string => x !== null);
    reparos.push({
      codigo: 'saldo-no-observado',
      detalle:
        `No hay variación que reportar porque falta ${faltan.join(' y ')}. ` +
        `Un cero aquí significaría "nadie restó nada", que es lo contrario de un cuadre.`,
    });
  } else if (variacionDec !== null && variacionDec.abs().greaterThan(tolerancia)) {
    reparos.push({
      codigo: 'variacion-fuera-de-tolerancia',
      detalle:
        `El saldo de banco ajustado (${banco.ajustado ?? '—'}) y el de libros ajustado ` +
        `(${libros.ajustado ?? '—'}) difieren en ${monto(variacionDec)}` +
        (tolerancia.isZero() ? '.' : `, por encima de la tolerancia ${monto(tolerancia)}.`),
    });
  }
  if (sinTipo > 0) {
    reparos.push({
      codigo: 'partida-sin-clasificar',
      detalle:
        `${sinTipo} partida(s) conciliatoria(s) sin tipo. Mientras no se diga qué son, ` +
        `no se suman a ningún lado y la variación de arriba está incompleta.`,
    });
  }
  if (sinFechar > 0) {
    reparos.push({
      codigo: 'partida-sin-fechar',
      detalle:
        `${sinFechar} partida(s) abierta(s) sin fecha esperada. Una partida sin fecha no se ` +
        `persigue: envejece hasta que alguien la note.`,
    });
  }
  if ((entrada.movimientosSinExplicar ?? 0) > 0) {
    reparos.push({
      codigo: 'linea-de-banco-sin-explicar',
      detalle:
        `${entrada.movimientosSinExplicar ?? 0} movimiento(s) del extracto sin cotejo y sin ` +
        `partida que los explique. Qué hacer con ellos lo decide la política ` +
        `\`linea_banco_sin_partida_al_cierre\`.`,
    });
  }

  return {
    banco,
    libros,
    variacion: variacionDec === null ? null : monto(variacionDec),
    // `cuadra` NUNCA es cierto con la variación sin observar. Es la única
    // afirmación de este archivo que alguien va a leer como «la cuenta cuadra».
    cuadra: variacionDec !== null && variacionDec.abs().lessThanOrEqualTo(tolerancia),
    sinClasificar,
    sinFechar,
    tolerancia: monto(tolerancia),
    resueltas,
    reparos,
  };
}

/**
 * El tipo que le corresponde a un movimiento del EXTRACTO que nadie registró
 * en libros, por su signo.
 *
 * Un cargo que los libros no tienen (comisión, IVA de la comisión, ISR
 * retenido) resta del saldo de libros; un abono que no tienen (interés) suma.
 * Es la clasificación por omisión de `run`, no un veredicto: `error-del-banco`
 * y `error-de-libros` los dice una persona mirando el movimiento.
 */
export function tipoPorOmisionDeMovimiento(importe: string): TipoDePartida {
  return dec(importe, 'importe').isNegative() ? 'cargo-del-banco' : 'abono-del-banco';
}

/**
 * El tipo que le corresponde a una línea de LIBROS que el banco nunca mostró.
 *
 * Contra la cuenta de banco un crédito es dinero que salió según los libros
 * —un cheque expedido que no han cobrado— y un débito es dinero que entró
 * —un depósito que el banco aún no abona—. `listarPartidasDeLibros` ya devuelve
 * el importe firmado así (débito positivo, crédito negativo), y ese mismo signo
 * es YA la aportación a la conciliación: el cheque resta del saldo de banco y
 * el depósito suma. No hay conversión, y no haberla es el punto.
 */
export function tipoPorOmisionDeLibros(importe: string): TipoDePartida {
  return dec(importe, 'importe').isNegative() ? 'cheque-en-circulacion' : 'deposito-en-transito';
}
