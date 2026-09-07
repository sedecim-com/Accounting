// ============================================================
// F07c · EL RFC DEL TERCERO, CLASIFICADO EN VEZ DE SÓLO CONTADO
//
// Lo que hay hoy es la detección del VACÍO y nada más: `vendor list
// --no-tax-id` enumera a los proveedores sin RFC en el expediente, y la wiki
// lo presenta como «la lista de bloqueadores» de la DIOT. Es un tercio de la
// lista. Faltan los dos casos que sí llegan hasta el archivo:
//
//   · EL MALFORMADO. `normalizeTaxId` (ap/vendor-service.ts) valida la forma
//     al ALTA, pero `vendors.tax_id` es un VARCHAR(50) sin CHECK y sin
//     normalización de escritura, y las altas por importación, por ingesta o
//     por SQL directo no pasan por ahí. Un RFC con un carácter de más entra,
//     y el vacío no lo detecta porque no está vacío.
//
//   · EL GENÉRICO. Es el peor de los tres justamente porque tiene forma de
//     RFC y pasa cualquier patrón: XAXX010101000 es el RFC del PÚBLICO EN
//     GENERAL. Declarar con él a un proveedor real no es un error de captura
//     que la autoridad devuelva, es una afirmación —que esa compra no tuvo
//     contraparte identificable— que además la autoridad puede cruzar contra
//     lo que ese proveedor declaró por su lado.
//
// EL PATRÓN ES EL MISMO QUE EL DEL ALTA, A PROPÓSITO. No se importa
// `normalizeTaxId` porque aquella LANZA —es una puerta de escritura— y aquí
// hace falta un diagnóstico de cuatro respuestas sobre datos que ya están
// guardados: lanzar al primer proveedor roto rompería la promesa de
// nombrarlos a todos. Que las dos reglas no se separen no se deja a la buena
// fe: la prueba unitaria coteja este clasificador contra `normalizeTaxId`
// caso por caso, así que el día que una cambie sin la otra, falla.
// ============================================================

/** Público en general. El que convierte a un proveedor real en anónimo. */
export const RFC_GENERICO_NACIONAL = 'XAXX010101000';
/** Residentes en el extranjero sin RFC. Legítimo en el CFDI, no identifica. */
export const RFC_GENERICO_EXTRANJERO = 'XEXX010101000';

/**
 * Persona moral: 3 letras. Persona física: 4. Luego AAMMDD y la homoclave de
 * tres. Idéntico a `RFC_RE` de ap/vendor-service.ts.
 */
const PATRON_RFC = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/;

export type EstadoRfc =
  | 'valido'
  | 'vacio'
  | 'malformado'
  | 'generico_nacional'
  | 'generico_extranjero';

export interface DiagnosticoRfc {
  estado: EstadoRfc;
  /** Normalizado: sin espacios y en mayúsculas. Cadena vacía si no había. */
  rfc: string;
  /** Una línea, en español, para el mensaje que nombra al proveedor. */
  motivo: string;
}

/**
 * Sin espacios interiores y en mayúsculas.
 *
 * La normalización va aquí y no en el llamador por el defecto que la
 * auditoría de F07b documenta: el catálogo del Anexo 24 normalizaba el RFC de
 * la entidad y la balanza no, así que el mismo dato guardado con espacios
 * producía un archivo correcto por un camino y un error que culpaba al dato
 * equivocado por el otro. Una sola función, y los dos lados leen igual.
 */
export function normalizarRfc(crudo: string | null | undefined): string {
  return (crudo ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export function clasificarRfc(crudo: string | null | undefined): DiagnosticoRfc {
  const rfc = normalizarRfc(crudo);

  if (rfc === '') {
    return { estado: 'vacio', rfc, motivo: 'no tiene RFC en el expediente' };
  }
  if (rfc === RFC_GENERICO_NACIONAL) {
    return {
      estado: 'generico_nacional',
      rfc,
      motivo:
        `tiene el RFC genérico ${RFC_GENERICO_NACIONAL}, que es el del público en general ` +
        `y no identifica a nadie`,
    };
  }
  if (rfc === RFC_GENERICO_EXTRANJERO) {
    return {
      estado: 'generico_extranjero',
      rfc,
      motivo:
        `tiene el RFC genérico ${RFC_GENERICO_EXTRANJERO}, que es el de los residentes en el ` +
        `extranjero: la DIOT los identifica por su número de identificación fiscal, no por él`,
    };
  }

  const m = PATRON_RFC.exec(rfc);
  if (!m) {
    return {
      estado: 'malformado',
      rfc,
      motivo:
        `tiene "${rfc}" como RFC, que no tiene forma de RFC mexicano (12 caracteres persona ` +
        `moral o 13 persona física: 3 o 4 letras, AAMMDD y homoclave de 3)`,
    };
  }

  // La misma comprobación de fecha imposible que hace el alta. Un 20261301
  // pasa el patrón y no es una fecha, y ése es exactamente el error de
  // tecleo que produce un proveedor con el que ningún CFDI casa nunca.
  const mes = Number(m[3]);
  const dia = Number(m[4]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    return {
      estado: 'malformado',
      rfc,
      motivo: `tiene "${rfc}" como RFC, cuya fecha (${m[2]}-${m[3]}-${m[4]}) no existe`,
    };
  }

  return { estado: 'valido', rfc, motivo: 'RFC con forma válida' };
}

/**
 * Si este RFC IDENTIFICA al tercero. Es la pregunta que la DIOT hace, y no es
 * la misma que «si es un RFC»: los dos genéricos son RFC perfectamente
 * formados y no identifican a nadie.
 *
 * Ojo con lo que esto NO dice: la forma no comprueba el dígito verificador ni
 * pregunta al SAT si el contribuyente existe. Un RFC bien formado de alguien
 * que no existe pasa por aquí, y sólo el cruce del SAT lo caza.
 */
export function rfcIdentificaAlTercero(d: DiagnosticoRfc): boolean {
  return d.estado === 'valido';
}
