import Decimal from 'decimal.js';
import { ivaToReclassify } from '../../accounting/iva-cash-basis.js';
import type { Hallazgo } from './hallazgos.js';

// ============================================================
// F07c · EL DESGLOSE POR TASA, SIN BASE DE DATOS DETRÁS
//
// La DIOT no declara «el IVA del proveedor»: declara, por proveedor, el VALOR
// DE LOS ACTOS y el IVA en renglones separados por tasa —16 %, 0 % y exento—
// más lo retenido. Toda la aritmética de ese reparto vive aquí y no toca
// Postgres, por la misma razón que `balanza-invariantes.ts`: sembrar una
// entidad, un ejercicio y cuatro asientos para preguntar cuánto es el 16 % de
// algo sólo consigue que la aritmética se pruebe despacio y mal.
//
// TRES DECISIONES QUE NO SON OBVIAS
//
// 1. EL TOTAL DEL REPARTO ES EL DEL MAYOR, NO LA SUMA DE LAS CASILLAS. El IVA
//    pagado entra ya calculado por la maquinaria de flujo (iva-cash-basis) y
//    aquí sólo se REPARTE. El residuo del redondeo se le echa a la casilla
//    más grande para que la suma de las casillas sea EXACTAMENTE lo que el
//    mayor movió. Si se dejara que cada casilla redondeara por su cuenta, el
//    archivo dejaría de amarrar contra la 1130 por unos centavos, que es
//    justo la conciliación que la lista de comprobación de la DIOT exige y
//    que nadie querría explicar con «así salió».
//
// 2. LA BASE SE PRORRATEA CON EL MISMO TELESCOPIO QUE EL IVA. `ivaToReclassify`
//    no es sólo «el IVA de un pago»: es un repartidor proporcional que
//    calcula por DIFERENCIA DE ACUMULADOS, y por eso la suma de todos los
//    tramos reproduce exacto el total y el último tramo se lleva el resto.
//    Reusarlo para la base —en vez de escribir una segunda regla de
//    redondeo— es lo que hace que el pago final de un gasto en parcialidades
//    declare la base completa y no la base menos tres diezmilésimos.
//
// 3. UNA TASA QUE NO ESTÁ EN EL CATÁLOGO NUNCA SE PLIEGA AL 16 %. Va a
//    `otras`, con su etiqueta, y con aviso. El 8 % de la región fronteriza
//    metido en la casilla del 16 % es un archivo que cuadra consigo mismo y
//    miente, y es exactamente el error que la lista de comprobación de la
//    DIOT manda buscar («verify they are not mixed into the 16% bucket»).
//
// SOBRE LA BASE DE UN RENGLÓN GRAVADO: es `line_amount`, y eso no es una
// derivación discutible sino la definición con la que el renglón se escribió
// —`computeBill` hace `line_amount = cantidad × precio` y suma el impuesto
// APARTE—. La política `diot_iva_exento_y_base` gobierna el otro caso, el
// EXENTO, que es donde no hay tasa de la que derivar nada.
// ============================================================

export const DECIMALES_DIOT = 4;

/**
 * Un centavo. La tolerancia con la que se acepta que un importe casa con una
 * tasa del catálogo: el CFDI redondea sus importes a dos decimales, así que
 * exigir igualdad exacta contra `base × tasa` rechazaría comprobantes
 * perfectamente válidos. Un centavo separa el ruido del redondeo de la
 * diferencia entre dos tasas, que es de puntos porcentuales.
 */
const TOLERANCIA = new Decimal('0.01');

const cero = (): Decimal => new Decimal(0);
const q = (d: Decimal): string => d.toDecimalPlaces(DECIMALES_DIOT).toFixed(DECIMALES_DIOT);

export type TipoFactor = 'tasa' | 'cuota' | 'exento';

/** Un renglón de `bill_lines`, con lo que la 063 le añadió. */
export interface RenglonDeGasto {
  /** `bill_lines.tipo_factor`. */
  tipoFactor: TipoFactor;
  /** `bill_lines.tax_rate`. NULL en todo lo anterior a la 063. */
  tasa: string | null;
  /** `bill_lines.valor_actos` — la base tal como la declaró el CFDI. */
  valorActos: string | null;
  /** `bill_lines.line_amount` — el neto del renglón, impuesto aparte. */
  importe: string;
  /** `bill_lines.tax_amount`. */
  iva: string;
}

export type ClaveTasa = 'tasa16' | 'tasa8' | 'tasa0' | 'exento';

export interface Casilla {
  /** El valor de los actos o actividades. Cadena de 4 decimales. */
  base: string;
  /** El IVA efectivamente pagado sobre esa base. Cadena de 4 decimales. */
  iva: string;
}

/** Una tasa que el catálogo del formato no nombra. Nunca se pliega al 16 %. */
export interface OtraTasa extends Casilla {
  /** La tasa, con dos decimales ('11.00'), o 'cuota', o 'indeterminada'. */
  etiqueta: string;
}

export interface Desglose {
  tasa16: Casilla;
  tasa8: Casilla;
  tasa0: Casilla;
  exento: Casilla;
  otras: OtraTasa[];
}

const CLAVES: readonly ClaveTasa[] = ['tasa16', 'tasa8', 'tasa0', 'exento'];
const PREFIJO_OTRAS = 'otras:';

export function desgloseCero(): Desglose {
  return {
    tasa16: { base: q(cero()), iva: q(cero()) },
    tasa8: { base: q(cero()), iva: q(cero()) },
    tasa0: { base: q(cero()), iva: q(cero()) },
    exento: { base: q(cero()), iva: q(cero()) },
    otras: [],
  };
}

/** Suma dos desgloses casilla por casilla, uniendo `otras` por etiqueta. */
export function sumarDesgloses(a: Desglose, b: Desglose): Desglose {
  const suma = desgloseCero();
  for (const c of CLAVES) {
    suma[c] = {
      base: q(new Decimal(a[c].base).plus(b[c].base)),
      iva: q(new Decimal(a[c].iva).plus(b[c].iva)),
    };
  }
  const otras = new Map<string, { base: Decimal; iva: Decimal }>();
  for (const o of [...a.otras, ...b.otras]) {
    const previo = otras.get(o.etiqueta) ?? { base: cero(), iva: cero() };
    otras.set(o.etiqueta, {
      base: previo.base.plus(o.base),
      iva: previo.iva.plus(o.iva),
    });
  }
  suma.otras = [...otras.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([etiqueta, v]) => ({ etiqueta, base: q(v.base), iva: q(v.iva) }));
  return suma;
}

export function ivaDelDesglose(d: Desglose): string {
  let t = cero();
  for (const c of CLAVES) t = t.plus(d[c].iva);
  for (const o of d.otras) t = t.plus(o.iva);
  return q(t);
}

export function baseDelDesglose(d: Desglose): string {
  let t = cero();
  for (const c of CLAVES) t = t.plus(d[c].base);
  for (const o of d.otras) t = t.plus(o.base);
  return q(t);
}

// ------------------------------------------------------------
// EN QUÉ CASILLA CAE UN RENGLÓN
// ------------------------------------------------------------

export interface ClasificacionDeRenglon {
  /** La casilla, o `otras:<etiqueta>` cuando la tasa no está en el catálogo. */
  clave: string;
  /** Cuando cae en `otras`, cómo se llama. */
  etiqueta?: string;
  /** true cuando `tax_rate` venía NULL y la tasa se MIDIÓ contra los importes. */
  medida: boolean;
}

/** '16.00' → 16. Devuelve null si no es un número. */
function tasaComoNumero(tasa: string | null): Decimal | null {
  if (tasa === null || tasa.trim() === '') return null;
  const d = new Decimal(tasa);
  return d.isFinite() ? d : null;
}

function casillaDeTasa(pct: Decimal): { clave: string; etiqueta?: string } {
  if (pct.equals(16)) return { clave: 'tasa16' };
  if (pct.equals(8)) return { clave: 'tasa8' };
  if (pct.isZero()) return { clave: 'tasa0' };
  const etiqueta = pct.toFixed(2);
  return { clave: `${PREFIJO_OTRAS}${etiqueta}`, etiqueta };
}

/**
 * Dónde va este renglón.
 *
 * EL CASO QUE OBLIGA A MEDIR: `bill_lines.tax_rate` nace con la 063, así que
 * TODO gasto anterior la tiene NULL. Bloquear por eso dejaría la DIOT sin
 * poder armarse sobre el histórico —un «no» disfrazado de rigor—, y meterlo
 * todo al 16 % es la mentira del punto 3 de la cabecera. La tercera salida es
 * la honesta: la tasa se MIDE contra los dos importes que sí están guardados
 * (base e impuesto) y sólo se acepta si el producto reproduce el impuesto con
 * un centavo de holgura. Eso no es adivinar: es comprobar. Y cuando no
 * reproduce ninguna tasa del catálogo, el renglón va a `otras` con la tasa
 * medida a la vista, no a una casilla cómoda.
 */
export function clasificarRenglon(r: RenglonDeGasto): ClasificacionDeRenglon {
  if (r.tipoFactor === 'exento') return { clave: 'exento', medida: false };
  if (r.tipoFactor === 'cuota') {
    // El IVA no tiene tipo de factor «cuota» —es del IEPS—, así que un
    // renglón así no pertenece a ninguna casilla de la DIOT. Se nombra.
    return { clave: `${PREFIJO_OTRAS}cuota`, etiqueta: 'cuota', medida: false };
  }

  const declarada = tasaComoNumero(r.tasa);
  if (declarada !== null) {
    return { ...casillaDeTasa(declarada), medida: false };
  }

  const iva = new Decimal(r.iva || '0');
  const base = new Decimal(r.valorActos ?? r.importe ?? '0');

  // Sin impuesto no hay nada que medir y el renglón se declara al 0 %.
  //
  // AQUÍ HAY UN LÍMITE REAL, y conviene decirlo: `tipo_factor` nace en la 063
  // con DEFAULT 'tasa', así que TODO renglón anterior afirma ser gravado
  // aunque fuese exento. Para esas filas el 0 % y lo exento son
  // indistinguibles —que es justo la asimetría que la 063 vino a cerrar— y
  // este módulo las manda al 0 %, que es la casilla que no inventa una
  // exención. Se corrige capturando el tipo de factor, no adivinando aquí.
  if (iva.isZero()) return { clave: 'tasa0', medida: true };

  if (base.lessThanOrEqualTo(0)) {
    return { clave: `${PREFIJO_OTRAS}indeterminada`, etiqueta: 'indeterminada', medida: true };
  }

  for (const candidata of [16, 8]) {
    const esperado = base.times(candidata).dividedBy(100);
    if (esperado.minus(iva).abs().lessThanOrEqualTo(TOLERANCIA)) {
      return { ...casillaDeTasa(new Decimal(candidata)), medida: true };
    }
  }

  const medida = iva.dividedBy(base).times(100).toDecimalPlaces(2);
  return { ...casillaDeTasa(medida), medida: true };
}

// ------------------------------------------------------------
// EL REPARTO DE UN TOTAL ENTRE CASILLAS
// ------------------------------------------------------------

export interface PesoDeCasilla {
  clave: string;
  /** Cadena de importe. Los pesos negativos se tratan como cero. */
  peso: string;
}

/**
 * Reparte `total` entre las casillas en proporción a sus pesos, de forma que
 * la suma de las partes sea EXACTAMENTE `total`.
 *
 * El residuo del redondeo va a la casilla de mayor peso —y, a igualdad, a la
 * primera— porque es donde menos pesa relativamente y porque la regla tiene
 * que ser determinista: dos corridas de la misma declaración no pueden
 * repartir el centavo en sitios distintos, o el hash del archivo cambia sin
 * que nada haya cambiado.
 */
export function repartirProporcional(total: string, pesos: readonly PesoDeCasilla[]): Map<string, string> {
  const objetivo = new Decimal(total || '0').toDecimalPlaces(DECIMALES_DIOT);
  const reparto = new Map<string, string>();
  const positivos = pesos.map((p) => ({
    clave: p.clave,
    peso: Decimal.max(new Decimal(p.peso || '0'), cero()),
  }));
  const suma = positivos.reduce((acc, p) => acc.plus(p.peso), cero());

  if (objetivo.isZero() || suma.lessThanOrEqualTo(0)) {
    for (const p of positivos) reparto.set(p.clave, q(cero()));
    return reparto;
  }

  let repartido = cero();
  let mayor: { clave: string; peso: Decimal } | null = null;
  for (const p of positivos) {
    const parte = objetivo.times(p.peso).dividedBy(suma).toDecimalPlaces(DECIMALES_DIOT);
    reparto.set(p.clave, q(parte));
    repartido = repartido.plus(parte);
    if (mayor === null || p.peso.greaterThan(mayor.peso)) mayor = p;
  }

  const residuo = objetivo.minus(repartido);
  if (!residuo.isZero() && mayor !== null) {
    reparto.set(mayor.clave, q(new Decimal(reparto.get(mayor.clave) ?? '0').plus(residuo)));
  }
  return reparto;
}

// ------------------------------------------------------------
// LA PORCIÓN DEL DOCUMENTO QUE UN TRAMO PAGÓ
// ------------------------------------------------------------

export interface PorcionPagada {
  /** Lo aplicado al documento ANTES de este tramo. */
  aplicadoPrevio: string;
  /** Lo aplicado en el tramo que se está declarando. */
  aplicadoAhora: string;
  /** El total del documento: el denominador de la razón. */
  totalDocumento: string;
  /**
   * `bills.exchange_rate`. La DIOT se declara en pesos y el gasto puede estar
   * en otra moneda; se convierte a la tasa HISTÓRICA del documento, que es la
   * misma con la que `postBillEntry` valuó el pasivo y aparcó el IVA. Ausente
   * o '1' cuando el gasto ya nació en moneda funcional.
   */
  tasaCambio?: string;
}

/**
 * Cuánto de `magnitud` corresponde a haber aplicado `aplicado` al documento,
 * ya en moneda funcional.
 *
 * ES `ivaToReclassify` con el acumulado como argumento, y el nombre de allá
 * engaña un poco: la función no sabe nada de IVA, es el repartidor
 * proporcional de la maquinaria de flujo. Se reusa aquí ADREDE en vez de
 * escribir una segunda regla de redondeo para la base: con dos reglas, el
 * último pago de un gasto en parcialidades declararía el IVA completo y la
 * base incompleta, y nadie sabría cuál de las dos mintió.
 */
export function acumuladoDelDocumento(
  magnitud: string,
  aplicado: string,
  totalDocumento: string,
  tasaCambio?: string
): string {
  const enMonedaDelDocumento = ivaToReclassify({
    ivaTotal: magnitud,
    documentTotal: totalDocumento,
    priorApplied: '0',
    appliedNow: aplicado,
  });
  return q(new Decimal(enMonedaDelDocumento).times(tasaCambio ?? '1'));
}

/**
 * Qué parte de `magnitud` corresponde a ESTE tramo del pago.
 *
 * SE RESTAN ACUMULADOS, NO SE CONVIERTE EL TRAMO. Es la corrección que R4
 * dejó escrita en iva-cash-basis: convertir cada tramo y redondearlo por
 * separado sumaba medio diezmilésimo de más por pago. Restar dos acumulados
 * TELESCOPA, así que la suma de todos los tramos reproduce exactamente el
 * total y el último se lleva el resto — que es lo que impide que la base
 * declarada de un gasto en parcialidades quede tres diezmilésimos corta.
 */
export function porcionDelDocumento(magnitud: string, porcion: PorcionPagada): string {
  const previo = new Decimal(porcion.aplicadoPrevio || '0');
  const ahora = new Decimal(porcion.aplicadoAhora || '0');
  const hasta = acumuladoDelDocumento(
    magnitud,
    previo.plus(ahora).toFixed(DECIMALES_DIOT),
    porcion.totalDocumento,
    porcion.tasaCambio
  );
  const desde = acumuladoDelDocumento(
    magnitud,
    previo.toFixed(DECIMALES_DIOT),
    porcion.totalDocumento,
    porcion.tasaCambio
  );
  return q(Decimal.max(new Decimal(hasta).minus(desde), cero()));
}

// ------------------------------------------------------------
// EL DESGLOSE DE UN DOCUMENTO
// ------------------------------------------------------------

export type PoliticaBaseExenta = 'exigir_base' | 'derivar_del_subtotal' | 'omitir_y_avisar';

export interface EntradaDesglose {
  documentId: string;
  documentNumber: string;
  renglones: readonly RenglonDeGasto[];
  /** `bills.tax_amount`: la cabecera, que es la que el mayor movió. */
  ivaCabecera: string;
  /** El IVA que el mayor reconoció como PAGADO por este documento en el mes. */
  ivaPagado: string;
  porcion: PorcionPagada;
  /** Valor efectivo de `diot_iva_exento_y_base`. */
  politicaBaseExenta: PoliticaBaseExenta;
}

export interface ResultadoDesglose {
  desglose: Desglose;
  hallazgos: Hallazgo[];
}

/**
 * El desglose por tasa de UN documento en UN tramo de pago.
 *
 * LA COMPROBACIÓN QUE VA PRIMERO: el IVA liberado se calcula sobre
 * `bills.tax_amount` —la CABECERA— y el reparto por tasa se calcula sobre los
 * RENGLONES. Si las dos cifras no coinciden, el reparto es una ficción bien
 * formada: las casillas sumarían lo que el mayor movió, pero repartido según
 * unas proporciones que no son las del documento. Se bloquea y se nombra el
 * documento, porque el arreglo está en el documento y no en la declaración.
 */
export function desglosarDocumento(e: EntradaDesglose): ResultadoDesglose {
  const hallazgos: Hallazgo[] = [];
  const ref = { documentId: e.documentId, documentNumber: e.documentNumber };

  const ivaRenglones = e.renglones.reduce((acc, r) => acc.plus(r.iva || '0'), cero());
  const ivaCabecera = new Decimal(e.ivaCabecera || '0');
  // Sin tolerancia cuando NINGÚN renglón trae impuesto: por debajo del
  // centavo la comprobación general dejaría pasar una cabecera con IVA que
  // no se puede repartir entre cero pesos de peso, y el reparto lo tiraría en
  // silencio — rompiendo el amarre contra 1130 por la cantidad exacta que
  // nadie va a buscar.
  const desajuste = ivaRenglones.isZero() && !ivaCabecera.isZero();
  if (desajuste || ivaRenglones.minus(ivaCabecera).abs().greaterThan(TOLERANCIA)) {
    hallazgos.push({
      codigo: 'DIOT-IVA-CABECERA',
      severidad: 'bloqueante',
      mensaje:
        `El gasto ${e.documentNumber} declara ${q(ivaCabecera)} de IVA en la cabecera y ` +
        `${q(ivaRenglones)} sumando sus renglones. El importe que se acredita sale de la ` +
        `cabecera y el desglose por tasa sale de los renglones: con esa diferencia, las ` +
        `casillas sumarían lo correcto repartido en las proporciones equivocadas.`,
      ...ref,
    });
    return { desglose: desgloseCero(), hallazgos };
  }

  // Acumulado por casilla sobre el documento COMPLETO. El prorrateo del tramo
  // viene después, para que el telescopio opere sobre totales estables.
  const acumulado = new Map<string, { base: Decimal; iva: Decimal; etiqueta?: string }>();
  const anota = (clave: string, etiqueta: string | undefined, base: Decimal, iva: Decimal): void => {
    const previo = acumulado.get(clave) ?? { base: cero(), iva: cero(), etiqueta };
    acumulado.set(clave, {
      base: previo.base.plus(base),
      iva: previo.iva.plus(iva),
      etiqueta: previo.etiqueta ?? etiqueta,
    });
  };

  for (const [i, r] of e.renglones.entries()) {
    const clas = clasificarRenglon(r);
    const iva = new Decimal(r.iva || '0');

    if (clas.medida && r.tipoFactor === 'tasa' && !iva.isZero()) {
      hallazgos.push({
        codigo: 'DIOT-TASA-MEDIDA',
        severidad: 'aviso',
        mensaje:
          `El renglón ${i + 1} del gasto ${e.documentNumber} no trae tasa declarada ` +
          `(bill_lines.tax_rate es NULL, como en todo lo anterior a la migración 063). ` +
          `Se midió contra sus importes y reproduce ${clas.etiqueta ?? clas.clave.replace('tasa', '')}%. ` +
          `Captúrala en el documento si la declaración va a firmarse.`,
        ...ref,
      });
    }
    if (clas.clave.startsWith(PREFIJO_OTRAS)) {
      hallazgos.push({
        codigo: 'DIOT-TASA-FUERA-DE-CATALOGO',
        severidad: 'aviso',
        mensaje:
          `El renglón ${i + 1} del gasto ${e.documentNumber} va a la tasa "${clas.etiqueta}", ` +
          `que no es 16 %, 0 % ni exento. Queda en su propia casilla y NO se suma al 16 %: ` +
          `una operación de región fronteriza o de tasa histórica metida en la casilla del ` +
          `16 % produce un archivo que cuadra consigo mismo y declara otra cosa.`,
        ...ref,
      });
    }

    // LA BASE. Para un renglón gravado es `line_amount` por construcción
    // (computeBill: cantidad × precio, impuesto aparte). El exento es el que
    // la política gobierna, porque ahí no hay tasa de la que derivar nada.
    let base: Decimal | null = r.valorActos !== null ? new Decimal(r.valorActos) : null;
    if (base === null && r.tipoFactor === 'exento') {
      if (e.politicaBaseExenta === 'exigir_base') {
        hallazgos.push({
          codigo: 'DIOT-BASE-EXENTA-DESCONOCIDA',
          severidad: 'bloqueante',
          politica: 'diot_iva_exento_y_base',
          mensaje:
            `El renglón ${i + 1} del gasto ${e.documentNumber} es EXENTO y no trae el valor de ` +
            `los actos (bill_lines.valor_actos está vacío). La DIOT declara la base, no sólo el ` +
            `impuesto, y derivarla del subtotal se rompe en silencio cuando el renglón mezcla ` +
            `conceptos exentos y gravados. Captúrala en el documento.`,
          ...ref,
        });
        continue;
      }
      if (e.politicaBaseExenta === 'omitir_y_avisar') {
        hallazgos.push({
          codigo: 'DIOT-BASE-EXENTA-OMITIDA',
          severidad: 'aviso',
          politica: 'diot_iva_exento_y_base',
          mensaje:
            `El renglón ${i + 1} del gasto ${e.documentNumber} es EXENTO, no trae el valor de los ` +
            `actos y queda FUERA de la declaración por política. El total declarado es menor que ` +
            `la actividad real por ese importe.`,
          ...ref,
        });
        continue;
      }
      base = new Decimal(r.importe || '0');
      hallazgos.push({
        codigo: 'DIOT-BASE-EXENTA-DERIVADA',
        severidad: 'aviso',
        politica: 'diot_iva_exento_y_base',
        mensaje:
          `El renglón ${i + 1} del gasto ${e.documentNumber} es EXENTO y su base se DERIVÓ del ` +
          `subtotal (${q(new Decimal(r.importe || '0'))}) por política: el documento no la traía.`,
        ...ref,
      });
    }
    if (base === null) base = new Decimal(r.importe || '0');

    if (r.tipoFactor === 'exento' && !iva.isZero()) {
      hallazgos.push({
        codigo: 'DIOT-EXENTO-CON-IVA',
        severidad: 'bloqueante',
        mensaje:
          `El renglón ${i + 1} del gasto ${e.documentNumber} se declara EXENTO y trae ` +
          `${q(iva)} de IVA. Una operación exenta no traslada impuesto: o el tipo de factor o ` +
          `el importe está mal, y la declaración heredaría el error.`,
        ...ref,
      });
    }

    anota(clas.clave, clas.etiqueta, base, iva);
  }

  // La BASE del tramo: cada casilla prorrateada por la porción pagada, con el
  // telescopio, para que la suma de los tramos reproduzca la base completa.
  const desglose = desgloseCero();
  const otras: OtraTasa[] = [];
  const baseDeCasilla = new Map<string, string>();
  for (const [clave, v] of acumulado) {
    baseDeCasilla.set(clave, porcionDelDocumento(q(v.base), e.porcion));
  }

  // El IVA del tramo: NO se prorratea, se REPARTE. El total es el que el mayor
  // movió (`ivaPagado`) y las casillas sólo dicen cómo se compone.
  const ivaDeCasilla = repartirProporcional(
    e.ivaPagado,
    [...acumulado.entries()].map(([clave, v]) => ({ clave, peso: q(v.iva) }))
  );

  for (const [clave, v] of acumulado) {
    const casilla: Casilla = {
      base: baseDeCasilla.get(clave) ?? q(cero()),
      iva: ivaDeCasilla.get(clave) ?? q(cero()),
    };
    if (clave.startsWith(PREFIJO_OTRAS)) {
      otras.push({ etiqueta: v.etiqueta ?? clave.slice(PREFIJO_OTRAS.length), ...casilla });
    } else {
      desglose[clave as ClaveTasa] = casilla;
    }
  }
  desglose.otras = otras.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));

  return { desglose, hallazgos };
}
