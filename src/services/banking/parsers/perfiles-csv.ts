import type { PerfilCsv } from './tipos.js';

// ============================================================
// LOS PERFILES DE CSV
//
// ── PROCEDENCIA. LÉELA ANTES DE CONFIAR EN UNO ──────────────────────────
//
// De los cuatro perfiles de este archivo, sólo `generico` está VERIFICADO, y
// lo está por una razón tramposa: lo define este mismo archivo, así que no hay
// nada contra qué contrastarlo.
//
// Los tres de banco —BBVA México, Banorte y Santander México— están marcados
// `conjetura`, y la marca es literal: se construyeron a partir de la forma que
// suelen tener estas exportaciones, SIN un archivo real delante. No se
// verificó el orden de las columnas, ni el texto exacto de los encabezados, ni
// la codificación, ni si el banco reparte el importe en dos columnas o lo
// firma en una. Cualquiera de esas cuatro cosas puede estar mal.
//
// No se disfrazan de verificados porque el costo del disfraz es asimétrico: un
// perfil marcado `conjetura` que resulta correcto sólo cuesta una revisión; un
// perfil marcado `verificado` que resulta equivocado importa un extracto
// torcido que después se concilia contra el mayor.
//
// ── POR QUÉ SE PUEDEN PUBLICAR IGUAL ────────────────────────────────────
//
// Porque el modo de fallar sí está garantizado. La detección exige que TODAS
// las columnas requeridas del perfil aparezcan en el encabezado del archivo;
// si el encabezado real de BBVA no dice «CARGO» y «ABONO», el perfil bbva-mx
// NO casa y el lector se niega nombrando lo que vio. Un perfil equivocado
// produce un rechazo ruidoso, no una lectura silenciosamente torcida.
//
// La vía para corregirlos es la que el catálogo ya nombra: `bank format create
// --file <muestra>` deriva el esqueleto de un archivo real y `bank format test`
// lo contrasta línea por línea. Cuando eso ocurra, el perfil sube a
// `verificado` y estas notas se borran.
// ============================================================

/**
 * BBVA México — exportación de «Movimientos» a CSV.
 *
 * CONJETURA. Lo que se asume y no se comprobó:
 *  · encabezados FECHA / DESCRIPCIÓN / CARGO / ABONO / SALDO,
 *  · importe repartido en dos columnas (no firmado en una),
 *  · fecha DD/MM/YYYY y punto decimal,
 *  · codificación Latin-1, que es lo habitual en los exportadores de banca en
 *    línea mexicanos y lo que convierte «DEPÓSITO» en basura si se lee mal.
 * El membrete de arriba varía entre versiones del portal, por eso el
 * encabezado se busca hasta 15 filas abajo en vez de exigirse en una fija.
 */
const BBVA_MX: PerfilCsv = {
  nombre: 'bbva-mx',
  version: '1.0.0',
  confianza: 'conjetura',
  banco: 'BBVA México',
  pais: 'MX',
  notas:
    'Reconstruido sin archivo de muestra. Verifícalo con `bank format test` contra una ' +
    'exportación real antes de usarlo en un cierre.',
  delimitador: ',',
  codificacion: 'latin1',
  filaEncabezado: 1,
  maxDesplazamientoEncabezado: 15,
  columnas: {
    fecha: ['fecha', 'fecha operacion', 'fecha de operacion'],
    fechaValor: ['fecha liquidacion', 'fecha de liquidacion'],
    descripcion: ['descripcion', 'descripcion movimiento', 'concepto'],
    referencia: ['referencia', 'ref'],
    cargo: ['cargo', 'cargos'],
    abono: ['abono', 'abonos'],
    saldo: ['saldo'],
  },
  formatoFecha: 'DD/MM/YYYY',
  importe: { modo: 'cargo-abono', separadorDecimal: '.', parentesisNegativo: true },
  monedaAsumida: 'MXN',
};

/**
 * Banorte — exportación de movimientos a CSV.
 *
 * CONJETURA. Se asume la otra convención grande: UNA columna de importe ya
 * firmada («MONTO») en vez de dos. Es la diferencia que hace que dos archivos
 * llamados «CSV» necesiten dos perfiles, y es exactamente lo que hay que
 * confirmar con una muestra: si Banorte reparte en DEPÓSITO/RETIRO, este
 * perfil no casará —fallará en voz alta— y habrá que reescribirlo en modo
 * `cargo-abono`.
 */
const BANORTE_MX: PerfilCsv = {
  nombre: 'banorte-mx',
  version: '1.0.0',
  confianza: 'conjetura',
  banco: 'Banorte',
  pais: 'MX',
  notas:
    'Reconstruido sin archivo de muestra, en modo `firmado`. Si la exportación real reparte ' +
    'el importe en dos columnas, este perfil NO casará y hay que rehacerlo.',
  delimitador: ',',
  codificacion: 'auto',
  filaEncabezado: 1,
  maxDesplazamientoEncabezado: 15,
  columnas: {
    fecha: ['fecha', 'fecha de operacion'],
    descripcion: ['descripcion', 'concepto', 'movimiento'],
    referencia: ['referencia', 'folio'],
    // Sólo «monto»: aceptar también «importe» haría que banorte-mx se quedara
    // con cualquier CSV genérico antes de que `generico` pudiera verlo.
    importe: ['monto'],
    saldo: ['saldo'],
  },
  formatoFecha: 'DD/MM/YYYY',
  importe: { modo: 'firmado', separadorDecimal: '.', parentesisNegativo: true },
  monedaAsumida: 'MXN',
};

/**
 * Santander México — exportación de estado de cuenta a CSV.
 *
 * CONJETURA, y la más aventurada de las tres. Se asume:
 *  · un MEMBRETE encima del encabezado con el número de cuenta, del que se
 *    saca `cuentaDeclarada` —el dato con el que después se prueba la identidad
 *    de la cuenta, que es lo único que impide importar el extracto de una
 *    cuenta contra otra—,
 *  · columnas RETIRO / DEPÓSITO (no CARGO / ABONO: los alias se mantienen
 *    disjuntos de los de BBVA a propósito, para que un mismo archivo no case
 *    con dos perfiles y la detección tenga que rendirse),
 *  · fecha con mes en letras («15-ENE-2026»).
 */
const SANTANDER_MX: PerfilCsv = {
  nombre: 'santander-mx',
  version: '1.0.0',
  confianza: 'conjetura',
  banco: 'Santander México',
  pais: 'MX',
  notas:
    'Reconstruido sin archivo de muestra. La lectura del membrete (cuenta, moneda, número de ' +
    'estado) es la parte más frágil: son expresiones regulares sobre texto libre del banco.',
  delimitador: ',',
  codificacion: 'latin1',
  filaEncabezado: 4,
  maxDesplazamientoEncabezado: 20,
  columnas: {
    fecha: ['fecha', 'fecha operacion'],
    descripcion: ['descripcion', 'concepto'],
    referencia: ['folio', 'referencia'],
    cargo: ['retiro', 'retiros'],
    abono: ['deposito', 'depositos'],
    saldo: ['saldo'],
  },
  formatoFecha: 'DD-MMM-YYYY',
  importe: { modo: 'cargo-abono', separadorDecimal: '.', parentesisNegativo: true },
  monedaAsumida: 'MXN',
  preambulo: {
    cuenta: /(?:cuenta|clabe)\s*[:#]?\s*([0-9]{10,20})/i,
    moneda: /\b(MXN|USD|EUR)\b/,
    numeroDeEstado: /(?:estado|periodo|folio)\s*(?:de cuenta)?\s*[:#]\s*([A-Za-z0-9/-]{1,50})/i,
  },
};

/**
 * El perfil de la casa: el CSV que mnemosine define, no el que un banco
 * exporta.
 *
 * Es el destino de `bank format create` cuando nadie ha escrito todavía el
 * perfil del banco, y el formato que se le puede pedir a un cliente que
 * transcriba a mano un extracto en papel. Por eso acepta alias amplios y
 * `separadorDecimal: 'auto'`: quien lo llena no está siguiendo una
 * especificación, y cada adivinanza que haga el lector queda en `avisos`.
 *
 * `ultimoRecurso` lo mantiene fuera del camino: por amplio, casaría con
 * archivos que un perfil de banco explica mejor, así que sólo gana cuando
 * ningún otro perfil reconoció el archivo.
 */
const GENERICO: PerfilCsv = {
  nombre: 'generico',
  version: '1.0.0',
  confianza: 'verificado',
  pais: 'MX',
  notas: 'Formato propio de mnemosine. No describe la exportación de ningún banco.',
  delimitador: ',',
  codificacion: 'auto',
  filaEncabezado: 1,
  maxDesplazamientoEncabezado: 5,
  columnas: {
    fecha: ['fecha', 'date', 'fecha operacion'],
    fechaValor: ['fecha valor', 'value date'],
    descripcion: ['descripcion', 'concepto', 'description', 'detalle'],
    referencia: ['referencia', 'reference', 'folio', 'id'],
    tipo: ['tipo', 'type'],
    importe: ['importe', 'monto', 'amount'],
    saldo: ['saldo', 'balance'],
  },
  formatoFecha: 'auto',
  importe: { modo: 'firmado', separadorDecimal: 'auto', parentesisNegativo: true },
  ultimoRecurso: true,
};

/** El registro que consulta la detección. El orden no decide nada: la especificidad sí. */
export const PERFILES_CSV: readonly PerfilCsv[] = Object.freeze([
  BBVA_MX,
  BANORTE_MX,
  SANTANDER_MX,
  GENERICO,
]);

export function perfilPorNombre(
  nombre: string,
  perfiles: readonly PerfilCsv[] = PERFILES_CSV
): PerfilCsv | undefined {
  return perfiles.find((p) => p.nombre === nombre);
}
