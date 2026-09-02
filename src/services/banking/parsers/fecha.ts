import type { ResultadoValor } from './tipos.js';

// ============================================================
// LA FECHA, DE TEXTO A YYYY-MM-DD
//
// «03/04/2026» son dos fechas distintas y el texto no dice cuál. El único
// lugar donde vive esa información es el PERFIL —el banco que exportó el
// archivo—, así que el formato se declara y no se descubre. `auto` existe para
// el archivo huérfano, y cuando `auto` tiene que elegir entre día y mes lo
// dice en un aviso en vez de callarse: una fecha invertida no rompe el import,
// rompe el corte del periodo tres pasos después, cuando ya nadie se acuerda de
// que hubo un archivo.
//
// La validación es de CALENDARIO, no de forma: «31/02/2026» tiene la forma
// correcta y no existe. Se comprueba por ida y vuelta contra Date.UTC, que es
// la manera de que febrero y los bisiestos salgan gratis.
// ============================================================

const MESES: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};

/**
 * Bisagra del año de dos dígitos. MT940 sólo publica YYMMDD, así que alguien
 * tiene que decidir qué siglo es «26». La bisagra en 69 es la convención de
 * POSIX y de la propia banca: 00-69 es 2000-2069, 70-99 es 1970-1999. Un
 * extracto de 1969 no existe; uno de 1998 sí.
 */
const BISAGRA_SIGLO = 69;

export function analizarFecha(bruto: string, formato = 'auto'): ResultadoValor {
  const original = (bruto ?? '').trim();
  if (original === '') return { ok: false, motivo: 'la fecha viene vacía' };

  // Un ISO con hora («2026-01-05T00:00:00-06:00») es lo que devuelve camt.053 y
  // lo que sueltan las hojas de cálculo. La hora no aporta nada a un extracto
  // diario y arrastra husos horarios que sí corren el día.
  const texto = original.split(/[T\s]/)[0].trim();

  if (formato === 'auto') return automatica(texto, original);

  const patron = compilar(formato);
  if (!patron) return { ok: false, motivo: `el perfil declara un formato de fecha que no se entiende: «${formato}»` };

  const m = patron.regex.exec(texto);
  if (!m) {
    return { ok: false, motivo: `«${original}» no tiene la forma «${formato}»` };
  }

  const partes = new Map<string, string>();
  patron.orden.forEach((clave, i) => partes.set(clave, m[i + 1]));

  const mes = leerMes(partes.get('M') ?? '');
  if (mes === null) return { ok: false, motivo: `«${original}»: mes no reconocido` };

  const armado = armar(leerAnio(partes.get('Y') ?? ''), mes, Number(partes.get('D') ?? ''));
  if (!armado) return { ok: false, motivo: `«${original}» no es una fecha del calendario` };
  return { ok: true, valor: armado };
}

/**
 * Deriva la fecha de operación de una fecha valor y un MMDD suelto, que es lo
 * único que MT940 publica en el campo :61:.
 *
 * El salto de año es real y muerde una vez al año: un movimiento con fecha
 * valor del 2 de enero y operación del 31 de diciembre pertenece al año
 * ANTERIOR, y leerlo como del año en curso lo saca del periodo por 365 días.
 */
export function fechaDeOperacionMt940(fechaValor: string, mmdd: string): ResultadoValor {
  const m = /^(\d{2})(\d{2})$/.exec(mmdd);
  if (!m) return { ok: false, motivo: `«${mmdd}» no es un MMDD` };

  const anioValor = Number(fechaValor.slice(0, 4));
  const mesValor = Number(fechaValor.slice(5, 7));
  const mes = Number(m[1]);
  const dia = Number(m[2]);

  let anio = anioValor;
  if (mes === 12 && mesValor === 1) anio = anioValor - 1;
  else if (mes === 1 && mesValor === 12) anio = anioValor + 1;

  const armado = armar(anio, mes, dia);
  if (!armado) return { ok: false, motivo: `«${mmdd}» no es una fecha del calendario` };
  return { ok: true, valor: armado };
}

function automatica(texto: string, original: string): ResultadoValor {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(texto);
  if (iso) {
    const armado = armar(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return armado
      ? { ok: true, valor: armado }
      : { ok: false, motivo: `«${original}» no es una fecha del calendario` };
  }

  const compacta = /^(\d{4})(\d{2})(\d{2})$/.exec(texto);
  if (compacta) {
    const armado = armar(Number(compacta[1]), Number(compacta[2]), Number(compacta[3]));
    return armado
      ? { ok: true, valor: armado }
      : { ok: false, motivo: `«${original}» no es una fecha del calendario` };
  }

  const conNombre = /^(\d{1,2})[/.-]([A-Za-zÁÉÍÓÚÑáéíóúñ]{3,})[/.-](\d{2,4})$/.exec(texto);
  if (conNombre) {
    const mes = leerMes(conNombre[2]);
    if (mes === null) return { ok: false, motivo: `«${original}»: mes no reconocido` };
    const armado = armar(leerAnio(conNombre[3]), mes, Number(conNombre[1]));
    return armado
      ? { ok: true, valor: armado }
      : { ok: false, motivo: `«${original}» no es una fecha del calendario` };
  }

  const numerica = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(texto);
  if (numerica) {
    const a = Number(numerica[1]);
    const b = Number(numerica[2]);
    const anio = leerAnio(numerica[3]);

    // El propio número desambigua en dos de cada tres fechas del mes.
    if (a > 12 && b <= 12) {
      const armado = armar(anio, b, a);
      return armado
        ? { ok: true, valor: armado }
        : { ok: false, motivo: `«${original}» no es una fecha del calendario` };
    }
    if (b > 12 && a <= 12) {
      const armado = armar(anio, a, b);
      return armado
        ? { ok: true, valor: armado }
        : { ok: false, motivo: `«${original}» no es una fecha del calendario` };
    }
    if (a > 12 && b > 12) {
      return { ok: false, motivo: `«${original}» no es una fecha del calendario` };
    }

    // Los dos caben como día y como mes. Se toma DD/MM —la convención de
    // México, que es de donde vienen estos archivos— y se confiesa.
    const armado = armar(anio, b, a);
    if (!armado) return { ok: false, motivo: `«${original}» no es una fecha del calendario` };
    return {
      ok: true,
      valor: armado,
      aviso:
        `«${original}» es ambigua: día y mes caben los dos. Se leyó como DD/MM (${armado}). ` +
        'Declara `formatoFecha` en el perfil para que no se adivine.',
    };
  }

  return { ok: false, motivo: `«${original}» no se reconoce como fecha` };
}

interface Patron {
  regex: RegExp;
  /** Qué campo captura cada grupo, en orden. */
  orden: string[];
}

/**
 * Compila «DD/MM/YYYY», «YYMMDD», «DD-MMM-YYYY»… a una expresión regular.
 *
 * Los formatos SIN separador (YYMMDD de MT940) exigen ancho exacto, porque sin
 * separador el ancho es lo único que delimita los campos. Los que sí lo tienen
 * aceptan uno o dos dígitos: hay exportadores que escriben «5/1/2026».
 */
function compilar(formato: string): Patron | null {
  const tokens = formato.match(/Y+|M+|D+|[^YMD]+/g);
  if (!tokens) return null;

  const anchoFijo = !/[^YMD]/.test(formato);
  const orden: string[] = [];
  let fuente = '^';

  for (const token of tokens) {
    const inicial = token[0];
    if (inicial === 'Y' || inicial === 'M' || inicial === 'D') {
      if (!/^(Y+|M+|D+)$/.test(token)) return null;
      if (inicial === 'M' && token.length >= 3) {
        fuente += '([A-Za-zÁÉÍÓÚÑáéíóúñ]{3,})';
      } else if (anchoFijo) {
        fuente += `(\\d{${token.length}})`;
      } else {
        fuente += `(\\d{1,${token.length}})`;
      }
      orden.push(inicial);
    } else {
      fuente += token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  if (orden.length !== 3) return null;
  return { regex: new RegExp(`${fuente}$`), orden };
}

function leerMes(texto: string): number | null {
  const limpio = texto.trim().toLowerCase().replace(/\.$/, '');
  if (/^\d+$/.test(limpio)) return Number(limpio);
  const sinAcentos = limpio.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MESES[sinAcentos] ?? null;
}

function leerAnio(texto: string): number {
  const n = Number(texto);
  if (texto.length > 2) return n;
  return n <= BISAGRA_SIGLO ? 2000 + n : 1900 + n;
}

function armar(anio: number, mes: number, dia: number): string | null {
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || !Number.isInteger(dia)) return null;
  if (anio < 1900 || anio > 2199 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}
