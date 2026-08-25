import { AccountingError } from '../../../../utils/errors.js';
import { config } from '../../../../config/index.js';

/**
 * CERROJO ANTISIMULACIÓN DEL TIMBRADO.
 *
 * Los tres adaptadores de PAC fabrican el UUID y el sello con
 * crypto.randomBytes y devuelven éxito: ninguno habla con un PAC real. Sin
 * este cerrojo, `POST /v1/invoices/:id/cfdi/stamp` guardaba ese folio
 * inventado con cfdi_status='stamped', indistinguible de uno emitido por el
 * SAT. Una factura así se ve timbrada en el sistema y no existe ante la
 * autoridad.
 *
 * La regla es de dos capas:
 *  1. Un adaptador que se declara simulado NO puede timbrar salvo que se
 *     habilite explícitamente (CFDI_PERMITIR_SIMULACION=true) y el entorno no
 *     sea producción. En producción no hay forma de habilitarlo.
 *  2. Cuando sí se permite, el resultado viaja marcado y se persiste con
 *     cfdi_status='failed' más una nota, nunca como 'stamped'. El vocabulario
 *     de la columna no tiene un valor para «simulado», y añadir uno haría
 *     creer que es un estado fiscal legítimo.
 */

export interface ResultadoTimbre {
  uuid: string;
  xml_timbrado: string;
  cadena_original: string;
  fecha_timbrado: Date;
  no_certificado_sat: string;
  sello_sat: string;
  /** true cuando el folio lo fabricó un adaptador simulado. */
  simulado?: boolean;
}

export function simulacionPermitida(): boolean {
  if (config.env === 'production') return false;
  return process.env.CFDI_PERMITIR_SIMULACION === 'true';
}

/**
 * Se llama ANTES de pedir el timbre. Corta el camino si el adaptador elegido
 * no puede emitir un folio real y la simulación no está habilitada.
 */
export function assertPuedeTimbrar(proveedor: string, esSimulado: boolean): void {
  if (!esSimulado) return;
  if (simulacionPermitida()) return;

  throw new AccountingError(
    'PAC_SIMULADO',
    `El proveedor de timbrado "${proveedor}" es una simulación: fabrica el UUID y el ` +
      `sello, no los emite el SAT. Guardar ese folio como real dejaría facturas que ` +
      `el sistema da por timbradas y la autoridad desconoce. ` +
      (config.env === 'production'
        ? 'En producción no se puede habilitar: configura un PAC real (ver docs/pac-proveedores.md).'
        : 'Para pruebas locales: CFDI_PERMITIR_SIMULACION=true, y el folio quedará marcado como simulado, nunca como timbrado.')
  );
}

/**
 * Traduce un resultado de timbre al estado con que debe persistirse.
 * Un folio simulado NUNCA es 'stamped'.
 */
export function estadoParaPersistir(r: ResultadoTimbre): {
  cfdi_status: 'stamped' | 'failed';
  nota: string | null;
} {
  return r.simulado
    ? {
        cfdi_status: 'failed',
        nota: 'SIMULADO: folio fabricado por un adaptador de pruebas, no emitido por el SAT.',
      }
    : { cfdi_status: 'stamped', nota: null };
}
