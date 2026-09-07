import type { Desglose } from './desglose.js';
import type { Hallazgo } from './hallazgos.js';
import type { TerceroDiot } from './tercero.js';

// ============================================================
// F07c · LA FORMA DE LA DECLARACIÓN, SEPARADA DE CÓMO SE ESCRIBE
//
// Estos tipos son el producto verificado del módulo: importes en cadena con
// cuatro decimales, desglosados por tasa, tercero por tercero, con el rastro
// de qué documentos los componen. Viven en su propio archivo porque el
// constructor y el serializador los comparten y ninguno de los dos debe
// depender del otro: la razón entera de que el serializador esté detrás de
// una interfaz es que la forma del ARCHIVO todavía no está fundamentada y la
// de los DATOS sí.
// ============================================================

export interface PeriodoDiot {
  anio: number;
  /** 1–12. La DIOT es mensual: no hay mes 13. */
  mes: number;
  desde: string;
  hasta: string;
}

/** Qué decidió cada política, y si la contestó alguien o es el defecto. */
export interface PoliticaAplicada {
  clave: string;
  valor: string;
  /** true = la contestó el usuario; false = se está usando el defecto. */
  definida: boolean;
}

/** El rastro: qué documento aportó qué. No se declara, se revisa. */
export interface DocumentoDelRenglon {
  billId: string;
  billNumber: string;
  metodo: 'PUE' | 'PPD';
  /** De dónde salió el método de pago: 'document' | 'cfdi' | 'terms' | 'default'. */
  origenDelMetodo: string;
  ivaPagado: string;
  ivaRetenido: string;
  desglose: Desglose;
}

export interface RenglonDiot {
  tercero: TerceroDiot;
  desglose: Desglose;
  /** IVA que la entidad RETUVO a este tercero en el mes. 4 decimales. */
  ivaRetenido: string;
  documentos: DocumentoDelRenglon[];
}

export interface TotalesDiot {
  desglose: Desglose;
  ivaRetenido: string;
  /** Suma del IVA de todas las casillas: lo que debe amarrar contra 1130. */
  ivaAcreditablePagado: string;
  terceros: number;
  documentos: number;
}

export interface DiotConstruida {
  periodo: PeriodoDiot;
  /** RFC del contribuyente que declara, ya normalizado. */
  rfc: string;
  razonSocial: string;
  /** Sólo los terceros DECLARABLES. Los demás están en `hallazgos`. */
  renglones: RenglonDiot[];
  totales: TotalesDiot;
  politicas: PoliticaAplicada[];
  hallazgos: Hallazgo[];
}
