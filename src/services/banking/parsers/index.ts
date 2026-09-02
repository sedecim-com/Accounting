import { ValidationError } from '../../../utils/errors.js';
import { leerCamt053, type OpcionesCamt053 } from './camt053.js';
import { leerCsv, type OpcionesCsv } from './csv.js';
import { leerMt940, type OpcionesMt940 } from './mt940.js';
import { decodificar, enLineas } from './texto.js';
import type { ExtractoLeido, FormatoLeible } from './tipos.js';

// ============================================================
// LA PUERTA DE LOS LECTORES DE EXTRACTO (F05a)
//
// El catálogo promete nueve formatos en `bank statement import --format`. Este
// módulo lee TRES, y la tabla de abajo lo dice en voz alta en vez de dejar que
// se descubra con un error raro seis pantallas más adentro.
//
// Los tres elegidos no son arbitrarios: CSV es lo que de verdad entrega un
// banco mexicano, y camt.053 y MT940 son los dos únicos formatos normados que
// traen SALDO DE APERTURA Y DE CIERRE, que es el dato sin el cual
// `bank_statements` no se puede escribir y la conciliación se queda comparando
// contra el cero de su DEFAULT.
//
// Los seis que faltan (ofx, qfx, mt942, camt054, bai2, xlsx) no están
// empezados. `formatoDeclarado` los reconoce como nombres válidos del catálogo
// y responde que no hay lector, para que el mensaje sea «este formato todavía
// no» y no «formato desconocido»: son promesas pendientes, no errores del
// usuario.
// ============================================================

export type EstadoDeFormato = 'disponible' | 'pendiente';

export interface FormatoDelCatalogo {
  nombre: string;
  estado: EstadoDeFormato;
  /** Qué falta, o por qué éste sí está. */
  nota: string;
}

export const FORMATOS_DEL_CATALOGO: readonly FormatoDelCatalogo[] = Object.freeze([
  {
    nombre: 'csv',
    estado: 'disponible',
    nota: 'Con perfiles por banco. No trae saldos: se derivan del saldo corrido cuando el perfil mapea esa columna.',
  },
  {
    nombre: 'camt053',
    estado: 'disponible',
    nota: 'ISO 20022. Trae saldos OPBD/CLBD, periodo y secuencia electrónica.',
  },
  {
    nombre: 'mt940',
    estado: 'disponible',
    nota: 'SWIFT. Trae saldos :60F:/:62F: con fecha y moneda.',
  },
  {
    nombre: 'ofx',
    estado: 'pendiente',
    nota: 'SGML/XML de Quicken. Sin lector: no se ha escrito.',
  },
  {
    nombre: 'qfx',
    estado: 'pendiente',
    nota: 'Variante propietaria de OFX. Sin lector: no se ha escrito.',
  },
  {
    nombre: 'mt942',
    estado: 'pendiente',
    nota: 'Informe intradía. Sin lector, y además NO trae saldo de cierre: no puede escribir un bank_statements por sí solo.',
  },
  {
    nombre: 'camt054',
    estado: 'pendiente',
    nota: 'Notificación de abono/cargo, no estado de cuenta: no trae saldos. Sin lector.',
  },
  {
    nombre: 'bai2',
    estado: 'pendiente',
    nota: 'Formato de tesorería estadounidense. Sin lector: no se ha escrito.',
  },
  {
    nombre: 'xlsx',
    estado: 'pendiente',
    nota: 'Necesitaría una dependencia de lectura de hoja de cálculo, y el proyecto no la tiene.',
  },
]);

const LEIBLES = new Set<string>(['csv', 'camt053', 'mt940']);

export interface OpcionesLectura extends OpcionesCsv, OpcionesCamt053, OpcionesMt940 {
  formato?: string;
}

/**
 * Lee un extracto en el formato que se le diga, o en el que reconozca.
 *
 * Cuando el formato no se declara se OLFATEA, pero el olfato sólo decide entre
 * los tres que sabemos leer y no adivina el perfil de CSV: eso lo decide
 * `detectarPerfilCsv`, con el encabezado delante.
 */
export function leerExtracto(
  entrada: string | Buffer,
  opciones: OpcionesLectura = {}
): ExtractoLeido {
  const pedido = (opciones.formato ?? '').trim().toLowerCase();
  const formato = pedido === '' ? olfatear(entrada) : normalizar(pedido);

  if (!formato) {
    throw new ValidationError(
      'No se reconoce el formato del archivo. Dilo con --format ' +
        `(hoy se leen: ${[...LEIBLES].join(', ')}).`
    );
  }

  switch (formato) {
    case 'csv':
      return leerCsv(entrada, opciones);
    case 'camt053':
      return leerCamt053(entrada, opciones);
    case 'mt940':
      return leerMt940(entrada, opciones);
  }
}

/**
 * Traduce el nombre que trae `--format` a un lector, o explica por qué no.
 *
 * Distingue tres respuestas donde una sola sería más simple y peor: el formato
 * que se lee, el que el catálogo promete pero nadie ha escrito, y el que no
 * existe. Sólo la del medio le dice al usuario que espere en vez de que
 * corrija.
 */
function normalizar(pedido: string): FormatoLeible {
  const alias: Record<string, string> = {
    'camt.053': 'camt053',
    camt53: 'camt053',
    'camt.054': 'camt054',
    'mt-940': 'mt940',
    'mt-942': 'mt942',
  };
  const nombre = alias[pedido] ?? pedido;

  if (LEIBLES.has(nombre)) return nombre as FormatoLeible;

  const declarado = FORMATOS_DEL_CATALOGO.find((f) => f.nombre === nombre);
  if (declarado) {
    throw new ValidationError(
      `El formato «${nombre}» está en el catálogo pero todavía no tiene lector: ${declarado.nota} ` +
        `Hoy se leen: ${[...LEIBLES].join(', ')}.`
    );
  }
  throw new ValidationError(
    `«${pedido}» no es un formato de estado de cuenta. Formatos del catálogo: ` +
      `${FORMATOS_DEL_CATALOGO.map((f) => f.nombre).join(', ')}.`
  );
}

/**
 * Reconoce el formato por lo que el archivo ES, no por su extensión.
 *
 * La extensión miente con frecuencia —un `.txt` que es MT940, un `.csv` que es
 * un XML exportado a mano— y aquí mentir sale caro: leer un camt.053 con el
 * lector de CSV no falla, produce un extracto de cero líneas. Sólo se miran
 * los primeros kilobytes: basta para decidir y no obliga a decodificar un
 * archivo de cien mil movimientos dos veces.
 */
export function olfatear(entrada: string | Buffer): FormatoLeible | null {
  const muestra = decodificar(
    typeof entrada === 'string' ? entrada.slice(0, 8192) : entrada.subarray(0, 8192)
  ).texto;

  if (/^\s*<\?xml|^\s*<[A-Za-z_][\w.-]*:?Document\b/.test(muestra)) return 'camt053';
  if (enLineas(muestra).some((l) => /^:(20|25|28C?|60[FM]|61):/.test(l.trim()))) return 'mt940';
  if (muestra.trim() !== '') return 'csv';
  return null;
}

export { leerCsv, detectarPerfilCsv, type OpcionesCsv, type PerfilDetectado } from './csv.js';
export { leerCamt053, type OpcionesCamt053 } from './camt053.js';
export { leerMt940, type OpcionesMt940 } from './mt940.js';
export { PERFILES_CSV, perfilPorNombre } from './perfiles-csv.js';
export { analizarImporte, combinarCargoAbono, type OpcionesImporte } from './importe.js';
export { analizarFecha, fechaDeOperacionMt940 } from './fecha.js';
export { decodificar, normalizarEncabezado, type Codificacion } from './texto.js';
export { crearAvisos, type ColectorAvisos } from './avisos.js';
export type {
  ConfianzaPerfil,
  ExtractoLeido,
  FormatoLeible,
  LecturaImporte,
  LineaLeida,
  MapaColumnas,
  PerfilCsv,
  ResultadoValor,
  SelectorColumna,
  SeparadorDecimal,
} from './tipos.js';
