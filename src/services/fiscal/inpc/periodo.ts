import { ValidationError } from '../../../utils/errors.js';

// ============================================================
// F07c · EL PERIODO MENSUAL DEL INPC
//
// El INPC es una serie MENSUAL, y su unidad no es una fecha sino un mes: el
// «INPC de julio de 2024» no tiene día. Por eso aquí no se usa Date ni
// string ISO — un Date arrastra día, hora y zona, y en cuanto una zona
// horaria corre el 1 de julio a las 19:00 del 30 de junio, el índice que se
// divide es el del mes equivocado y el factor sale plausible. Un par de
// enteros no tiene ese modo de fallo.
//
// La aritmética vive aquí y no en el servicio porque es pura: se prueba sin
// Postgres, que es donde los casos incómodos —el cambio de año, el periodo
// invertido, el mes 13— se escriben de verdad.
// ============================================================

export interface Periodo {
  /** Año de cuatro dígitos. */
  anio: number;
  /** Mes 1-12. */
  mes: number;
}

/**
 * La serie del INPC del INEGI arranca en enero de 1969. Un año anterior no es
 * un periodo antiguo: es un error de captura, y aceptarlo produciría un
 * «índice faltante» donde la verdad es «ese mes nunca se publicó».
 */
export const PRIMER_ANIO_DE_LA_SERIE = 1969;
/** Cota superior de cordura; la columna es SMALLINT. */
export const ULTIMO_ANIO_ACEPTADO = 2999;

const RE_PERIODO = /^(\d{4})[-/](\d{1,2})$/;

/** Los meses en español, para mensajes que se leen. */
const NOMBRES_DE_MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;

/** «2024-07» (siempre dos dígitos de mes): la forma canónica de un periodo. */
export function formatearPeriodo(p: Periodo): string {
  return `${String(p.anio).padStart(4, '0')}-${String(p.mes).padStart(2, '0')}`;
}

/** «julio de 2024», para los mensajes de error que lee una persona. */
export function nombrarPeriodo(p: Periodo): string {
  return `${NOMBRES_DE_MES[p.mes - 1]} de ${p.anio}`;
}

/**
 * Valida un periodo ya desarmado en enteros. Se exporta porque el parser del
 * archivo arma los enteros por su cuenta y no debe repetir estas cotas.
 */
export function exigirPeriodoNumerico(anio: number, mes: number, contexto = 'El periodo'): Periodo {
  if (!Number.isInteger(anio) || !Number.isInteger(mes)) {
    throw new ValidationError(`${contexto} "${anio}-${mes}" debe traer año y mes enteros.`);
  }
  if (mes < 1 || mes > 12) {
    throw new ValidationError(`${contexto} "${anio}-${mes}" tiene un mes fuera de 1-12.`);
  }
  if (anio < PRIMER_ANIO_DE_LA_SERIE || anio > ULTIMO_ANIO_ACEPTADO) {
    throw new ValidationError(
      `${contexto} "${anio}-${mes}" está fuera de la serie: el INPC se publica desde ` +
        `enero de ${PRIMER_ANIO_DE_LA_SERIE}.`
    );
  }
  return { anio, mes };
}

/**
 * Parsea «2024-07» (también «2024/7») a un periodo validado. El texto llega
 * crudo de la terminal o de un archivo, así que el mensaje nombra la forma
 * esperada en vez de decir «inválido».
 */
export function exigirPeriodo(texto: string, contexto = 'El periodo'): Periodo {
  const m = RE_PERIODO.exec(texto.trim());
  if (!m) {
    throw new ValidationError(
      `${contexto} "${texto}" no se entiende: usa año y mes con la forma AAAA-MM, p. ej. 2024-07.`
    );
  }
  return exigirPeriodoNumerico(Number(m[1]), Number(m[2]), contexto);
}

/** Orden cronológico: negativo si a es anterior a b, 0 si es el mismo mes. */
export function compararPeriodos(a: Periodo, b: Periodo): number {
  return a.anio !== b.anio ? a.anio - b.anio : a.mes - b.mes;
}

export function mismoPeriodo(a: Periodo, b: Periodo): boolean {
  return compararPeriodos(a, b) === 0;
}

/** Meses de distancia (hasta − desde). Negativo si hasta es anterior. */
export function distanciaEnMeses(desde: Periodo, hasta: Periodo): number {
  return (hasta.anio - desde.anio) * 12 + (hasta.mes - desde.mes);
}

/**
 * Cuántos meses COMPRENDE el periodo, con las dos puntas dentro. Enero a
 * diciembre son doce, no once: la regla de la mitad del periodo (LISR art.
 * 31) cuenta meses comprendidos, y contarlos por diferencia es el error que
 * corre el mes de la actualización uno hacia atrás.
 */
export function mesesDelPeriodo(desde: Periodo, hasta: Periodo): number {
  const d = distanciaEnMeses(desde, hasta);
  if (d < 0) {
    throw new ValidationError(
      `El periodo ${formatearPeriodo(desde)}..${formatearPeriodo(hasta)} termina antes de empezar.`
    );
  }
  return d + 1;
}

/** Suma meses (acepta negativos) sin pasar por Date. */
export function sumarMeses(p: Periodo, meses: number): Periodo {
  const total = p.anio * 12 + (p.mes - 1) + meses;
  return { anio: Math.floor(total / 12), mes: (total % 12) + 1 };
}

/** Todos los meses del intervalo, ambas puntas incluidas. Para buscar huecos. */
export function periodosEntre(desde: Periodo, hasta: Periodo): Periodo[] {
  const n = mesesDelPeriodo(desde, hasta);
  const salida: Periodo[] = [];
  for (let i = 0; i < n; i++) salida.push(sumarMeses(desde, i));
  return salida;
}
