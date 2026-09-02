import Decimal from 'decimal.js';
import type { ResultadoValor, SeparadorDecimal } from './tipos.js';

// ============================================================
// EL DINERO, DE TEXTO A STRING CANÓNICO
//
// AQUÍ NO HAY UN SOLO `parseFloat`, Y NO ES UNA REGLA DE ESTILO. `parseFloat`
// sobre «1,234.56» devuelve 1 —se detiene en la coma y no avisa—, sobre
// «(500.00)» devuelve NaN, y sobre «1.234» devuelve 1.234 donde el banco
// escribió mil doscientos treinta y cuatro. Los tres son errores silenciosos,
// y los tres entran a un extracto que después cuadra contra el mayor.
//
// El método es al revés: primero se lleva el texto a un STRING CANÓNICO
// —signo, dígitos, punto decimal y nada más— decidiendo explícitamente qué
// separador era cuál, y sólo entonces se le entrega a decimal.js para que
// valide. Si el texto no se deja canonizar, la celda no se lee: no se
// aproxima, no se pone en cero, se devuelve el motivo y la fila se va a
// `avisos`.
//
// LA AMBIGÜEDAD SE CONFIESA. «1.234» con un solo separador y tres dígitos
// detrás no se puede resolver mirando el número; se resuelve mirando el
// perfil. Cuando el perfil no lo fija, el lector toma la lectura de miles
// —ningún extracto publica milésimos de peso— y lo DICE en un aviso, para que
// quien vea un importe raro sepa dónde se decidió.
// ============================================================

export interface OpcionesImporte {
  separadorDecimal?: SeparadorDecimal;
  /** `(1,234.56)` como negativo contable. Encendido por omisión. */
  parentesisNegativo?: boolean;
  invertirSigno?: boolean;
}

/**
 * Tope de DECIMAL(19,4): 15 enteros. Un importe que no cabe en la columna es
 * un error de lectura (una referencia leída como monto, un separador mal
 * decidido) mucho antes que un movimiento de mil billones de pesos, y vale
 * más rechazarlo aquí que verlo fallar como error de Postgres a mitad del
 * import.
 */
const MAXIMO = new Decimal('1e15');

/**
 * Los decimales de `bank_transactions.amount`. Un importe con más precisión se
 * redondea —no hay dónde guardarlo— pero el redondeo se avisa: es la única
 * pérdida de información que este módulo se permite.
 */
const DECIMALES_COLUMNA = 4;

/** Sufijos y prefijos de moneda que se toleran pegados al número. */
const MONEDA = /^(mxn|mxp|usd|eur|cad|m\.n\.|mn|pesos?)|(mxn|mxp|usd|eur|cad|m\.n\.|mn|pesos?)$/gi;

export function analizarImporte(bruto: string, opciones: OpcionesImporte = {}): ResultadoValor {
  const { separadorDecimal = 'auto', parentesisNegativo = true, invertirSigno = false } = opciones;

  const original = (bruto ?? '').trim();
  if (original === '') return { ok: false, motivo: 'el importe viene vacío' };

  // NFKC unifica el espacio duro y los dígitos de ancho completo que a veces
  // sueltan los exportadores de hoja de cálculo.
  let t = original.normalize('NFKC');
  let negativo = false;

  if (parentesisNegativo && /^\(.*\)$/.test(t)) {
    negativo = true;
    t = t.slice(1, -1);
  }

  t = t.replace(/[$€£¥¤\s]/g, '').replace(MONEDA, '');

  // El signo puede ir delante (lo normal) o detrás (exportadores de mainframe).
  const alFinal = /^(.*?)([-+])$/.exec(t);
  if (alFinal) {
    if (alFinal[2] === '-') negativo = !negativo;
    t = alFinal[1];
  }
  if (t.startsWith('-')) {
    negativo = !negativo;
    t = t.slice(1);
  } else if (t.startsWith('+')) {
    t = t.slice(1);
  }

  // DR/CR: la forma bancaria de escribir el signo con letras.
  const marca = /^(.*?)(dr|cr)$/i.exec(t);
  if (marca) {
    if (marca[2].toLowerCase() === 'dr') negativo = !negativo;
    t = marca[1];
  }

  if (t === '') return { ok: false, motivo: `«${original}» no tiene dígitos` };
  if (/[^0-9.,]/.test(t)) {
    return { ok: false, motivo: `«${original}» no se lee como importe` };
  }

  const decidido = decidirSeparadores(t, separadorDecimal);
  if (!decidido.ok) return { ok: false, motivo: `«${original}»: ${decidido.motivo}` };

  const { entero, fraccion } = decidido;
  if (!/^\d*$/.test(entero) || !/^\d*$/.test(fraccion)) {
    return { ok: false, motivo: `«${original}» no se lee como importe` };
  }
  if (entero === '' && fraccion === '') {
    return { ok: false, motivo: `«${original}» no tiene dígitos` };
  }

  const avisos: string[] = [];
  if (decidido.aviso) avisos.push(decidido.aviso);

  const canonico = `${negativo ? '-' : ''}${entero === '' ? '0' : entero}${
    fraccion === '' ? '' : `.${fraccion}`
  }`;

  let valor: Decimal;
  try {
    valor = new Decimal(canonico);
  } catch {
    return { ok: false, motivo: `«${original}» no se lee como importe` };
  }
  if (!valor.isFinite()) return { ok: false, motivo: `«${original}» no es un número finito` };
  if (valor.abs().gte(MAXIMO)) {
    return {
      ok: false,
      motivo: `«${original}» no cabe en DECIMAL(19,4); casi siempre significa que se leyó como importe algo que no lo era`,
    };
  }

  if (invertirSigno) valor = valor.neg();
  // decimal.js conserva el cero negativo, y «-0.00» en un extracto es ruido
  // que después no compara igual contra el 0 de la base.
  if (valor.isZero()) valor = new Decimal(0);

  if (fraccion.length > DECIMALES_COLUMNA) {
    avisos.push(
      `«${original}» traía ${fraccion.length} decimales y la columna guarda ${DECIMALES_COLUMNA}: se redondeó.`
    );
  }

  // Mínimo dos decimales para que el importe se LEA como dinero, máximo los
  // que caben en la columna.
  const decimales = Math.min(DECIMALES_COLUMNA, Math.max(2, fraccion.length));

  return {
    ok: true,
    valor: valor.toFixed(decimales),
    aviso: avisos.length > 0 ? avisos.join(' ') : undefined,
  };
}

/**
 * Combina las dos columnas del extracto que reparte el signo entre CARGO y
 * ABONO en un único importe firmado.
 *
 * El cargo sale SIEMPRE negativo por valor absoluto, no negando lo que venga:
 * hay exportaciones que ya escriben el cargo en negativo y negarlas otra vez
 * convertiría un retiro en un depósito. Un cero en la columna cuenta como
 * ausencia porque casi todos los exportadores rellenan con «0.00» la columna
 * que no aplica.
 */
export function combinarCargoAbono(
  cargo: string,
  abono: string,
  opciones: OpcionesImporte = {}
): ResultadoValor {
  const leerLado = (texto: string): ResultadoValor | null => {
    if ((texto ?? '').trim() === '') return null;
    return analizarImporte(texto, { ...opciones, invertirSigno: false });
  };

  const c = leerLado(cargo);
  const a = leerLado(abono);

  if (c !== null && !c.ok) return { ok: false, motivo: `cargo: ${c.motivo}` };
  if (a !== null && !a.ok) return { ok: false, motivo: `abono: ${a.motivo}` };

  const textoCargo = c !== null && c.ok ? c.valor : null;
  const textoAbono = a !== null && a.ok ? a.valor : null;
  const cargoVal = textoCargo === null ? null : new Decimal(textoCargo);
  const abonoVal = textoAbono === null ? null : new Decimal(textoAbono);

  const hayCargo = cargoVal !== null && !cargoVal.isZero();
  const hayAbono = abonoVal !== null && !abonoVal.isZero();

  if (hayCargo && hayAbono) {
    return {
      ok: false,
      motivo: `cargo «${cargo.trim()}» y abono «${abono.trim()}» vienen los dos con importe; la fila no dice en qué sentido se movió el dinero`,
    };
  }

  if (cargoVal !== null && hayCargo) {
    return {
      ok: true,
      valor: aplicar(cargoVal.abs().neg(), opciones).toFixed(
        Math.max(2, decimalesDe(textoCargo ?? ''))
      ),
    };
  }
  if (abonoVal !== null && hayAbono) {
    return {
      ok: true,
      valor: aplicar(abonoVal.abs(), opciones).toFixed(Math.max(2, decimalesDe(textoAbono ?? ''))),
    };
  }

  if (cargoVal === null && abonoVal === null) {
    return { ok: false, motivo: 'ni cargo ni abono traen importe' };
  }

  // Movimiento de cero: existe (una comisión condonada, un ajuste) y no es una
  // fila corrupta. Se deja pasar avisando, porque un cero en un extracto suele
  // ser una columna mal mapeada.
  return {
    ok: true,
    valor: aplicar(new Decimal(0), opciones).toFixed(2),
    aviso: 'la fila trae cargo y abono en cero; se importó como movimiento de 0.00',
  };
}

function aplicar(valor: Decimal, opciones: OpcionesImporte): Decimal {
  const v = opciones.invertirSigno ? valor.neg() : valor;
  return v.isZero() ? new Decimal(0) : v;
}

function decimalesDe(valor: string): number {
  const punto = valor.indexOf('.');
  return punto === -1 ? 0 : valor.length - punto - 1;
}

type Separadores =
  | { ok: true; entero: string; fraccion: string; aviso?: string }
  | { ok: false; motivo: string };

/**
 * Decide cuál de los dos separadores era el decimal y cuál el de miles, y
 * valida la agrupación.
 *
 * La validación de grupos no es adorno: es lo que convierte «1,2345.67» en un
 * error en vez de en 12 345.67. Cuando un separador de miles aparece, todos
 * sus grupos menos el primero miden exactamente tres dígitos; si no, la
 * lectura elegida era la equivocada.
 */
function decidirSeparadores(t: string, preferido: SeparadorDecimal): Separadores {
  const tieneComa = t.includes(',');
  const tienePunto = t.includes('.');

  let decimal: '.' | ',' | null = null;
  let aviso: string | undefined;

  if (preferido !== 'auto') {
    const otro = preferido === '.' ? ',' : '.';
    // El perfil dice que el decimal es uno, y el archivo pone el OTRO más a la
    // derecha: eso no es una lectura difícil, es un perfil equivocado.
    if (t.includes(preferido) && t.includes(otro) && t.lastIndexOf(otro) > t.lastIndexOf(preferido)) {
      return {
        ok: false,
        motivo: `el perfil declara «${preferido}» como separador decimal y el importe lo contradice`,
      };
    }
    decimal = t.includes(preferido) ? preferido : null;
  } else if (tieneComa && tienePunto) {
    // Con los dos presentes no hay ambigüedad: el de más a la derecha es el
    // decimal en toda convención conocida.
    decimal = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
  } else if (tieneComa || tienePunto) {
    const sep: '.' | ',' = tieneComa ? ',' : '.';
    const veces = t.split(sep).length - 1;
    const digitosDetras = t.length - t.lastIndexOf(sep) - 1;
    if (veces > 1) {
      decimal = null; // repetido: sólo puede ser separador de miles
    } else if (digitosDetras === 3) {
      decimal = null;
      aviso =
        `«${t}» es ambiguo (un solo «${sep}» con tres dígitos detrás): se leyó como separador de ` +
        'miles. Fija `separadorDecimal` en el perfil para que no se adivine.';
    } else {
      decimal = sep;
    }
  }

  const miles = decimal === '.' ? ',' : decimal === ',' ? '.' : tieneComa ? ',' : tienePunto ? '.' : null;

  let entero: string;
  let fraccion = '';
  if (decimal) {
    const corte = t.lastIndexOf(decimal);
    entero = t.slice(0, corte);
    fraccion = t.slice(corte + 1);
  } else {
    entero = t;
  }

  if (miles && entero.includes(miles)) {
    const grupos = entero.split(miles);
    if (grupos[0].length < 1 || grupos[0].length > 3 || grupos.slice(1).some((g) => g.length !== 3)) {
      return {
        ok: false,
        motivo: `la agrupación de miles no cuadra («${entero}»); el separador decidido no era el correcto`,
      };
    }
    entero = grupos.join('');
  }

  return { ok: true, entero, fraccion, aviso };
}
