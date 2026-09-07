import Decimal from 'decimal.js';
import { ValidationError } from '../../../utils/errors.js';
import { normalizarBase } from './factor.js';
import {
  exigirPeriodo,
  exigirPeriodoNumerico,
  formatearPeriodo,
  type Periodo,
} from './periodo.js';

// ============================================================
// F07c · EL ARCHIVO DEL INPC, LEÍDO SIN POSTGRES
//
// El catálogo reserva `inpc import --file <path>` y lo marca no hecho. Este
// módulo es la mitad que se puede probar: texto entra, filas validadas salen,
// y ni una consulta de por medio. La razón es la misma que en R4 y en F05c —
// el caso incómodo (la línea 47 con el mes 13, el archivo con la misma fila
// dos veces y valores distintos) cuesta una llamada de tres líneas aquí y una
// siembra completa si vive dentro del servicio; el que cuesta caro no se
// escribe nunca.
//
// TODO ERROR NOMBRA LA LÍNEA. Un importador que dice «archivo inválido» sobre
// un archivo de trescientas filas obliga a adivinar, y quien adivina acaba
// borrando filas hasta que pasa.
//
// LA BASE NO SE ADIVINA. Si ni la fila ni la invocación la declaran, la carga
// se rechaza: un INPC sin base es un número que más tarde se dividirá contra
// otro de otra serie. Ver la cabecera de factor.ts.
// ============================================================

/** Precisión de la columna: DECIMAL(12,6) en la 065. */
const DECIMALES_INDICE = 6;
const DIGITOS_INDICE = 12;

const RE_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface FilaDeArchivo {
  periodo: Periodo;
  /** El índice tal cual, como string. */
  valor: string;
  base: string;
  /** Fecha de publicación en el DOF/INEGI, si el archivo la trae. */
  publicadoEl: string | null;
  /** Línea del archivo (base 1), para que el error se pueda ir a corregir. */
  linea: number;
}

export interface OpcionesParseo {
  /**
   * Base para las filas que no la traigan. Es el `--base` de la invocación;
   * sin ella y sin columna, la fila se rechaza.
   */
  base?: string;
}

/** Encabezados que este parser reconoce, ya en minúsculas y sin acentos. */
const ALIAS: Record<string, 'anio' | 'mes' | 'periodo' | 'valor' | 'base' | 'publicado'> = {
  anio: 'anio', ano: 'anio', year: 'anio', ejercicio: 'anio',
  mes: 'mes', month: 'mes',
  periodo: 'periodo', fecha: 'periodo',
  valor: 'valor', indice: 'valor', inpc: 'valor', value: 'valor',
  base: 'base',
  publicado_el: 'publicado', publicacion: 'publicado', publicado: 'publicado', dof: 'publicado',
};

function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Recorta comillas de campo y espacios: los exportadores las ponen. */
function limpiar(campo: string): string {
  const t = campo.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

/**
 * El separador se deduce de la primera línea con contenido: coma, punto y coma
 * o tabulador, el que más aparezca. No se acepta el espacio: los nombres de
 * base traen espacios ("2018-Jul2 = 100") y partirlos ahí rompería la base
 * justo en el dato que no se puede adivinar.
 */
function deducirSeparador(linea: string): string {
  const candidatos = [',', ';', '\t'];
  let mejor = ',';
  let max = 0;
  for (const c of candidatos) {
    const n = linea.split(c).length - 1;
    if (n > max) {
      max = n;
      mejor = c;
    }
  }
  return mejor;
}

function esEncabezado(campos: string[]): boolean {
  // La primera columna de una fila de datos empieza por dígito (el año o el
  // periodo). Si no, es encabezado. No se busca la palabra «anio» porque hay
  // exportaciones que titulan las columnas en inglés o con acentos.
  return !/^\d/.test(campos[0] ?? '');
}

function exigirValor(crudo: string, linea: number): string {
  let d: Decimal;
  try {
    d = new Decimal(crudo);
  } catch {
    throw new ValidationError(`Línea ${linea}: el índice "${crudo}" no es un número.`);
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new ValidationError(`Línea ${linea}: el índice "${crudo}" debe ser un número positivo.`);
  }
  if (d.decimalPlaces() > DECIMALES_INDICE) {
    throw new ValidationError(
      `Línea ${linea}: el índice "${crudo}" trae más de ${DECIMALES_INDICE} decimales y la ` +
        'columna es DECIMAL(12,6); Postgres lo redondearía en silencio.'
    );
  }
  if (d.precision(true) > DIGITOS_INDICE) {
    throw new ValidationError(
      `Línea ${linea}: el índice "${crudo}" excede los ${DIGITOS_INDICE} dígitos de DECIMAL(12,6).`
    );
  }
  return d.toString();
}

/**
 * Lee la serie de un archivo de texto separado por comas, punto y coma o
 * tabuladores. Acepta encabezado (por nombre) o el orden fijo
 * `anio, mes, valor [, base [, publicado_el]]`. Las líneas en blanco y las que
 * empiezan por `#` se ignoran.
 *
 * Devuelve las filas EN EL ORDEN DEL ARCHIVO. No toca la base de datos: quien
 * escribe es `importarSerie`.
 */
export function parsearSerieInpc(texto: string, opts: OpcionesParseo = {}): FilaDeArchivo[] {
  const basePorOmision = opts.base === undefined ? null : normalizarBase(opts.base);
  if (basePorOmision === '') {
    throw new ValidationError('La base indicada está vacía; una base en blanco no identifica serie.');
  }

  const lineas = texto.split(/\r?\n/);
  const utiles: Array<{ n: number; campos: string[] }> = [];
  let separador: string | null = null;

  for (let i = 0; i < lineas.length; i++) {
    const cruda = lineas[i];
    if (cruda.trim() === '' || cruda.trimStart().startsWith('#')) continue;
    separador ??= deducirSeparador(cruda);
    utiles.push({ n: i + 1, campos: cruda.split(separador).map(limpiar) });
  }

  if (utiles.length === 0) {
    throw new ValidationError('El archivo no trae ninguna fila con datos.');
  }

  // Posición de cada campo. Sin encabezado, el orden fijo del catálogo.
  let columnas: Partial<Record<'anio' | 'mes' | 'periodo' | 'valor' | 'base' | 'publicado', number>>;
  let primera = 0;
  if (esEncabezado(utiles[0].campos)) {
    columnas = {};
    utiles[0].campos.forEach((titulo, idx) => {
      const clave = ALIAS[sinAcentos(titulo.toLowerCase()).replace(/\s+/g, '_')];
      if (clave !== undefined && columnas[clave] === undefined) columnas[clave] = idx;
    });
    primera = 1;
    const tienePeriodo = columnas.periodo !== undefined ||
      (columnas.anio !== undefined && columnas.mes !== undefined);
    if (!tienePeriodo || columnas.valor === undefined) {
      throw new ValidationError(
        `Línea ${utiles[0].n}: el encabezado no dice cuál columna es el periodo y cuál el ` +
          'índice. Se esperan «anio,mes,valor» o «periodo,valor», con «base» y «publicado_el» ' +
          'opcionales.'
      );
    }
    if (utiles.length === 1) {
      throw new ValidationError('El archivo trae encabezado y ninguna fila de datos.');
    }
  } else {
    columnas = { anio: 0, mes: 1, valor: 2, base: 3, publicado: 4 };
  }

  const filas: FilaDeArchivo[] = [];
  const vistas = new Map<string, FilaDeArchivo>();

  for (let i = primera; i < utiles.length; i++) {
    const { n, campos } = utiles[i];
    const dame = (clave: keyof typeof columnas): string => {
      const idx = columnas[clave];
      return idx === undefined ? '' : (campos[idx] ?? '');
    };

    let periodo: Periodo;
    if (columnas.periodo !== undefined) {
      periodo = exigirPeriodo(dame('periodo'), `Línea ${n}: el periodo`);
    } else {
      const anio = dame('anio');
      const mes = dame('mes');
      if (!/^\d+$/.test(anio) || !/^\d+$/.test(mes)) {
        throw new ValidationError(`Línea ${n}: año "${anio}" y mes "${mes}" deben ser enteros.`);
      }
      periodo = exigirPeriodoNumerico(Number(anio), Number(mes), `Línea ${n}: el periodo`);
    }

    const valor = exigirValor(dame('valor'), n);

    const baseCruda = normalizarBase(dame('base'));
    const base = baseCruda !== '' ? baseCruda : basePorOmision;
    if (base === null) {
      throw new ValidationError(
        `Línea ${n}: la fila no declara base y la invocación tampoco. Un INPC sin base no se ` +
          'puede dividir contra otro: pásala con --base o añade la columna.'
      );
    }

    const publicadoCrudo = dame('publicado');
    if (publicadoCrudo !== '' && !RE_FECHA_ISO.test(publicadoCrudo)) {
      throw new ValidationError(
        `Línea ${n}: la fecha de publicación "${publicadoCrudo}" no tiene la forma AAAA-MM-DD.`
      );
    }

    const fila: FilaDeArchivo = {
      periodo,
      valor,
      base,
      publicadoEl: publicadoCrudo === '' ? null : publicadoCrudo,
      linea: n,
    };

    // Un archivo que repite (mes, base) es un archivo mal armado, y da igual
    // si los dos valores coinciden: la duda de cuál mandaba no se resuelve
    // eligiendo el último.
    const llave = `${formatearPeriodo(periodo)}|${base}`;
    const previa = vistas.get(llave);
    if (previa) {
      throw new ValidationError(
        `Línea ${n}: ${formatearPeriodo(periodo)} en base "${base}" ya venía en la línea ` +
          `${previa.linea} (${previa.valor} contra ${valor}). Un mes se declara una vez.`
      );
    }
    vistas.set(llave, fila);
    filas.push(fila);
  }

  return filas;
}
