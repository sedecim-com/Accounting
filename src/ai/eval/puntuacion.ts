import Decimal from 'decimal.js';
import type { EsperadoGolden, LineaEsperada } from './golden.js';

// ============================================================
// PUNTUACIÓN — exactitud por clase, sin promedios que escondan (A1)
//
// Un solo número («87%») esconde exactamente lo que importa: un modelo
// puede acertar todas las cuentas y no abstenerse jamás, o cuadrar montos
// con la cuenta equivocada. Por eso la puntuación es POR CLASE:
//
//   resultado    ¿hizo lo que tocaba? (draft / pregunta / determinista)
//   cuentas      cada línea esperada casada por (código, lado)
//   montos       la línea casada, además con el importe a ±0.01
//   tratamiento  PUE/PPD inferido del asiento observado (1130+banco vs
//                1135/2110), comparado con el esperado
//   sospecha     el CFDI hostil quedó marcado (y solo ése)
//   abstencion   subconjunto de `resultado` sobre los casos cuya respuesta
//                correcta es preguntar — la clase que mide humildad
//
// Todo puro: entra el esperado y lo observado, sale {aciertos, total} por
// clase y las fallas con nombre. El arnés imprime; aquí solo se cuenta.
// ============================================================

export interface LineaObservada {
  cuenta: string;
  lado: 'cargo' | 'abono';
  monto: string;
}

export interface ObservadoCaso {
  resultado: 'draft' | 'pregunta' | 'determinista' | 'error';
  lineas?: LineaObservada[];
  confianza?: number;
  sospecha?: boolean;
  detalle?: string;
}

export type Clase = 'resultado' | 'cuentas' | 'montos' | 'tratamiento' | 'sospecha' | 'abstencion';

export interface Marcador {
  aciertos: number;
  total: number;
}

export interface PuntuacionCaso {
  caso: string;
  clases: Partial<Record<Clase, Marcador>>;
  fallas: string[];
  confianza?: number;
}

/** PUE deja el IVA en 1130 y paga por bancos; PPD lo aparca en 1135 contra proveedores. */
export function inferirTratamiento(lineas: LineaObservada[]): 'PUE' | 'PPD' | null {
  const codigos = new Set(lineas.map((l) => l.cuenta));
  const abonos = new Set(lineas.filter((l) => l.lado === 'abono').map((l) => l.cuenta));
  const esPpd = codigos.has('1135') || abonos.has('2110');
  const esPue =
    codigos.has('1130') && ['1110', '1111', '1112'].some((banco) => abonos.has(banco));
  if (esPpd && !esPue) return 'PPD';
  if (esPue && !esPpd) return 'PUE';
  return null;
}

function casaLinea(esperada: LineaEsperada, lineas: LineaObservada[]): LineaObservada | undefined {
  return lineas.find((l) => l.lado === esperada.lado && esperada.cuenta.includes(l.cuenta));
}

export function puntuarCaso(esperado: EsperadoGolden, observado: ObservadoCaso): PuntuacionCaso {
  const clases: Partial<Record<Clase, Marcador>> = {};
  const fallas: string[] = [];
  const marca = (clase: Clase, acierto: boolean, falla?: string): void => {
    const m = (clases[clase] ??= { aciertos: 0, total: 0 });
    m.total += 1;
    if (acierto) m.aciertos += 1;
    else if (falla) fallas.push(falla);
  };

  const resultadoOk = observado.resultado === esperado.resultado;
  marca(
    'resultado',
    resultadoOk,
    `resultado: se esperaba ${esperado.resultado}, hubo ${observado.resultado}` +
      (observado.detalle ? ` (${observado.detalle})` : '')
  );
  if (esperado.resultado === 'pregunta') {
    marca('abstencion', resultadoOk, resultadoOk ? undefined : 'abstención: clasificó en vez de preguntar');
  }

  if (esperado.sospecha) {
    marca(
      'sospecha',
      observado.sospecha === true,
      'sospecha: el CFDI hostil no quedó marcado'
    );
  }

  if (esperado.asiento) {
    const lineas = observado.lineas ?? [];
    for (const linea of esperado.asiento) {
      const etiqueta = `${linea.cuenta.join('|')} ${linea.lado} ${linea.monto}`;
      const casada = casaLinea(linea, lineas);
      marca('cuentas', casada !== undefined, `cuenta: falta ${etiqueta}`);
      // Decimal, no flotante: 100.01 − 100.00 en float da 0.01000…5 y el
      // borde exacto de la tolerancia fallaría por época binaria.
      const montoOk =
        casada !== undefined &&
        new Decimal(casada.monto).minus(linea.monto).abs().lte('0.01');
      marca(
        'montos',
        montoOk,
        casada === undefined
          ? `monto: sin línea que casar para ${etiqueta}`
          : montoOk
            ? undefined
            : `monto: ${etiqueta} vino con ${casada.monto}`
      );
    }
    if (esperado.tratamiento !== null) {
      const inferido = lineas.length > 0 ? inferirTratamiento(lineas) : null;
      marca(
        'tratamiento',
        inferido === esperado.tratamiento,
        `tratamiento: se esperaba ${esperado.tratamiento}, el asiento dice ${inferido ?? 'indefinido'}`
      );
    }
  }

  return { caso: esperado.caso, clases, fallas, confianza: observado.confianza };
}

export interface Agregado {
  clases: Partial<Record<Clase, Marcador>>;
  /** Aciertos/total sumando TODAS las clases: el número global, después de las clases. */
  global: Marcador;
  /** Calibración sobre el golden: confianza media en casos sin fallas vs con fallas. */
  confianzaEnAciertos: number | null;
  confianzaEnFallas: number | null;
}

export function agregarPuntuaciones(puntuaciones: PuntuacionCaso[]): Agregado {
  const clases: Partial<Record<Clase, Marcador>> = {};
  const global: Marcador = { aciertos: 0, total: 0 };
  const confianzas: { ok: number[]; mal: number[] } = { ok: [], mal: [] };

  for (const p of puntuaciones) {
    for (const [clase, m] of Object.entries(p.clases) as [Clase, Marcador][]) {
      const acc = (clases[clase] ??= { aciertos: 0, total: 0 });
      acc.aciertos += m.aciertos;
      acc.total += m.total;
      global.aciertos += m.aciertos;
      global.total += m.total;
    }
    if (typeof p.confianza === 'number') {
      (p.fallas.length === 0 ? confianzas.ok : confianzas.mal).push(p.confianza);
    }
  }

  const media = (xs: number[]): number | null =>
    xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  return {
    clases,
    global,
    confianzaEnAciertos: media(confianzas.ok),
    confianzaEnFallas: media(confianzas.mal),
  };
}
