// ============================================================
// F07c · LO QUE LA DIOT ENCUENTRA AL ARMARSE
//
// Mismo contrato que el validador del Anexo 24 (validador.ts): una lista de
// hallazgos con severidad, y una función que dice cuántos BLOQUEAN. La razón
// de que sea una lista y no una excepción está escrita en las propias
// políticas del panel: las dos que pueden negarse —`diot_tercero_sin_rfc` y
// `diot_iva_exento_y_base`— prometen «me niego Y NOMBRO a los proveedores»,
// en plural. Lanzar al primero cumpliría la mitad: el contador arreglaría un
// RFC, volvería a correr, y descubriría el segundo. Con veinte proveedores
// eso son veinte vueltas.
//
// Así que armar SIEMPRE termina, y lo que se niega es ENTREGAR: el
// serializador es el que mira `bloquean()` y se planta.
// ============================================================

export type Severidad = 'bloqueante' | 'aviso';

export interface Hallazgo {
  /** Código estable, para poder contarlos en una prueba sin casar prosa. */
  codigo: string;
  severidad: Severidad;
  /** En español, y nombrando SIEMPRE al proveedor o al documento culpable. */
  mensaje: string;
  /** La política que decidió esta severidad, cuando fue una política. */
  politica?: string;
  vendorId?: string;
  documentId?: string;
  documentNumber?: string;
}

export function bloquean(hallazgos: readonly Hallazgo[]): Hallazgo[] {
  return hallazgos.filter((h) => h.severidad === 'bloqueante');
}

export function contarHallazgos(hallazgos: readonly Hallazgo[]): Record<Severidad, number> {
  return {
    bloqueante: hallazgos.filter((h) => h.severidad === 'bloqueante').length,
    aviso: hallazgos.filter((h) => h.severidad === 'aviso').length,
  };
}
