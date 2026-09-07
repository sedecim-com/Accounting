import Decimal from 'decimal.js';
import { DECIMALES_IMPORTE_ANEXO24 } from './xml.js';
import type { NodoDePago, Poliza, Transaccion } from './polizas-xml.js';

// ============================================================
// F07d · LAS INVARIANTES DE LAS PÓLIZAS, SIN TOCAR LA BASE
//
// El modelo es el de `balanza-invariantes.ts` (F07b) y el de
// `statement-checks.ts`: verificaciones con NOMBRE, cada una una función de
// datos a hallazgos, y NINGUNA consulta. Eso no es aseo — es la condición
// para que el caso raro se pueda escribir en una prueba unitaria de cuatro
// líneas en vez de sembrando una entidad entera.
//
// LO QUE ESTE ARCHIVO DECIDE, Y POR QUÉ NO LO DECIDE EL PANEL
//
// El criterio «una póliza mueve dinero y no trae el rastro de pago: ¿se
// entrega igual o se para?» ES una bifurcación de criterio, y en esta casa
// eso va al panel. NO EXISTE esa política y este tramo NO la añade
// (pending-catalog.ts está fuera de mi frente). Así que se elige un defecto
// y se argumenta, que es lo que se pidió:
//
//   EL DEFECTO ES BLOQUEAR, y el argumento es el plazo. Una póliza que mueve
//   dinero sin nodo de pago es un rechazo del SAT, no una imperfección: el
//   Anexo 24 pide el rastro justamente para poder seguir la deducción hasta
//   el banco, y es el nodo que la autoridad revisa primero. Las pólizas se
//   entregan A REQUERIMIENTO, con un plazo corto ya corriendo; enterarse por
//   el rechazo gasta ese plazo entero. Bloquear cuesta una corrida más;
//   entregar cuesta el requerimiento.
//
//   Y BLOQUEAR AQUÍ NO ES CALLARSE: el generador NO lanza, devuelve el XML
//   construido con `puedeEntregarse: false` y la lista de pólizas nombradas
//   UNA A UNA por su NumUnIdenPol. Quien lo lea puede mirar el archivo y
//   saber exactamente a qué pago le falta el dato. Un `throw` habría
//   convertido esa lista en una cadena de texto, que es lo que F07b ya
//   aprendió con el catálogo.
//
// SOBRE EL CATÁLOGO DE BANCOS: si `sat_bancos` está vacío, la comprobación de
// la clave de banco NO PUEDE AFIRMAR NADA, y lo dice en un aviso en vez de
// aceptar en silencio. Es literalmente la lección de F07a con el c_CodAgrup:
// rechazar contra un catálogo ausente es inventarse una respuesta, y
// aprobar contra un catálogo ausente es inventarse la contraria.
// ============================================================

export const POLIZA_CHECK_NAMES = [
  'poliza-cuadra',
  'poliza-con-dinero-sin-rastro',
  'banco-en-catalogo',
  'uuid-de-comprobante',
  'comprobante-sin-rfc-usable',
  'renglon-con-un-solo-lado',
  'texto-normalizado',
] as const;

export type PolizaCheckName = (typeof POLIZA_CHECK_NAMES)[number];

export interface HallazgoPoliza {
  check: PolizaCheckName;
  severity: 'blocking' | 'warning';
  /** El NumUnIdenPol de la póliza señalada. Vacío si es del archivo entero. */
  referencia: string;
  /** El porqué, en español y CON LA CIFRA o el dato que falla dentro. */
  detalle: string;
}

/** Veredicto de una clave de banco contra el c_Banco. Los tres casos separados. */
export type EstadoDeBanco = 'valido' | 'fuera_de_catalogo' | 'sin_catalogo' | 'sin_clave';

/**
 * El c_Banco tal como se pudo leer, con la distinción que decide todo: no es
 * lo mismo «esa clave no está» que «no hay catálogo contra el que mirar».
 */
export interface CatalogoDeBancos {
  /** false = la tabla `sat_bancos` está vacía. */
  sembrado: boolean;
  /** Las claves vigentes. Vacío cuando no está sembrado. */
  claves: ReadonlySet<string>;
}

export function estadoDeBanco(clave: string | undefined, cat: CatalogoDeBancos): EstadoDeBanco {
  const c = (clave ?? '').trim();
  if (c === '') return 'sin_clave';
  if (!cat.sembrado) return 'sin_catalogo';
  return cat.claves.has(c) ? 'valido' : 'fuera_de_catalogo';
}

/** Lo que una verificación necesita saber y no puede deducir del árbol. */
export interface ContextoDePolizas {
  polizas: readonly Poliza[];
  /**
   * Los NumUnIdenPol de las pólizas que MUEVEN DINERO —tocan una cuenta de
   * banco o de caja— y a las que no se les pudo resolver ningún nodo de pago,
   * con el motivo por el que no se pudo. Lo calcula el servicio, que es quien
   * sabe qué cuenta es un banco; aquí sólo se convierte en hallazgo.
   */
  sinRastro: readonly { numUnIdenPol: string; motivo: string }[];
  bancos: CatalogoDeBancos;
  /** `--validate-uuids`: comprobar la forma de los UUID de los CFDI. */
  validarUuids: boolean;
  /**
   * Las pólizas cuyo CFDI EXISTE y se queda fuera del archivo porque el RFC de
   * la contraparte no tiene forma de RFC, con el porqué. Lo resuelve el
   * servicio, que es quien lee `vendors.tax_id`; aquí se convierte en aviso.
   */
  sinComprobante: readonly { numUnIdenPol: string; motivo: string }[];
  /**
   * Los textos a los que hubo que quitarles un salto de línea o una racha de
   * espacios para que pudieran viajar en un atributo. Lo hace el servicio, que
   * es quien tiene el dato crudo; aquí se convierte en aviso.
   */
  normalizados: readonly { numUnIdenPol: string; campo: string; texto: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hallazgo(
  check: PolizaCheckName,
  severity: 'blocking' | 'warning',
  referencia: string,
  detalle: string
): HallazgoPoliza {
  return { check, severity, referencia, detalle };
}

/**
 * LA PÓLIZA CUADRA **EN LAS CIFRAS QUE SE PRESENTAN**.
 *
 * No es lo mismo que el mayor cuadre. El mayor es DECIMAL(19,4) y el archivo
 * declara DOS decimales, así que entre el libro y el XML hay un redondeo por
 * renglón — y redondear cada renglón por separado puede romper una igualdad
 * que en el libro era exacta:
 *
 *     Debe 0.005 + 0.005 = 0.01   ·  Haber 0.01        (cuadra en el libro)
 *     redondeado: 0.01 + 0.01 = 0.02 ≠ 0.01            (NO cuadra en el archivo)
 *
 * La autoridad suma lo que se le entregó, no lo que hay en el libro. Es la
 * misma trampa que `balanza-invariantes` documenta para las cuatro columnas,
 * aquí a la escala del renglón.
 */
export function polizaCuadra(polizas: readonly Poliza[]): HallazgoPoliza[] {
  const hs: HallazgoPoliza[] = [];
  for (const p of polizas) {
    const debe = p.transacciones.reduce((a, t) => a.plus(t.debe), new Decimal(0));
    const haber = p.transacciones.reduce((a, t) => a.plus(t.haber), new Decimal(0));
    if (!debe.equals(haber)) {
      hs.push(
        hallazgo(
          'poliza-cuadra',
          'blocking',
          p.numUnIdenPol,
          `La póliza declara Debe ${debe.toFixed(DECIMALES_IMPORTE_ANEXO24)} y Haber ` +
            `${haber.toFixed(DECIMALES_IMPORTE_ANEXO24)}: una diferencia de ` +
            `${debe.minus(haber).toFixed(DECIMALES_IMPORTE_ANEXO24)} EN LAS CIFRAS DEL ARCHIVO. ` +
            `El mayor puede cuadrar y el archivo no: entre los cuatro decimales del libro y los dos ` +
            `del Anexo 24 hay un redondeo por renglón, y la autoridad suma lo que se le entregó.`
        )
      );
    }
  }
  return hs;
}

/**
 * LA PÓLIZA MUEVE DINERO Y NO DICE POR DÓNDE.
 *
 * El hallazgo nombra la póliza —eso es lo que se pidió— y dice el motivo
 * concreto, que no siempre es el mismo: a veces el pago existe y le falta la
 * cuenta destino, a veces el asiento de banco no viene de ningún pago
 * registrado (una conciliación, un ajuste) y entonces no hay de dónde sacar el
 * rastro sin inventárselo.
 */
export function polizaConDineroSinRastro(
  sinRastro: ContextoDePolizas['sinRastro']
): HallazgoPoliza[] {
  return sinRastro.map((s) =>
    hallazgo(
      'poliza-con-dinero-sin-rastro',
      'blocking',
      s.numUnIdenPol,
      `Mueve dinero y no lleva el nodo de pago que el Anexo 24 exige: ${s.motivo}. Sin ese nodo la ` +
        `autoridad no puede seguir el movimiento hasta el banco, que es exactamente para lo que ` +
        `pidió las pólizas. Captúralo en el pago (\`payment create --check-number/--to-account/--to-bank\`) ` +
        `y vuelve a generar.`
    )
  );
}

/**
 * LA CLAVE DE BANCO CONTRA EL c_Banco.
 *
 * Tres desenlaces y sólo uno bloquea. `sin_catalogo` NUNCA bloquea y NUNCA
 * aprueba en silencio: es un aviso que dice que la comprobación no corrió y
 * por qué. La alternativa —dar por buena cualquier clave de tres caracteres
 * porque la tabla está vacía— es la que entrega un archivo con `999` donde
 * iba `012` y lo llama validado.
 */
export function bancoEnCatalogo(
  polizas: readonly Poliza[],
  bancos: CatalogoDeBancos
): HallazgoPoliza[] {
  const hs: HallazgoPoliza[] = [];
  let avisadoSinCatalogo = false;

  for (const p of polizas) {
    for (const t of p.transacciones) {
      for (const pago of t.pagos ?? []) {
        for (const [campo, clave] of clavesDeBanco(pago)) {
          const estado = estadoDeBanco(clave, bancos);
          if (estado === 'fuera_de_catalogo') {
            hs.push(
              hallazgo(
                'banco-en-catalogo',
                'blocking',
                p.numUnIdenPol,
                `${campo}="${clave ?? ''}" no está en el c_Banco sembrado. Una clave de banco que la ` +
                  `autoridad no reconoce invalida el nodo de pago, y con él la póliza.`
              )
            );
          } else if (estado === 'sin_catalogo' && !avisadoSinCatalogo) {
            avisadoSinCatalogo = true;
            hs.push(
              hallazgo(
                'banco-en-catalogo',
                'warning',
                '',
                `Las claves de banco de este archivo SE EMITEN SIN VALIDAR: la tabla \`sat_bancos\` ` +
                  `(el c_Banco, migración 064) está vacía, así que comprobarlas sería comparar contra ` +
                  `la nada. Siembra el catálogo para que esta comprobación afirme algo; mientras tanto ` +
                  `no dice que las claves sean correctas, dice que no se miraron.`
              )
            );
          }
        }
      }
    }
  }
  return hs;
}

/** Los campos de clave de banco NACIONAL de cada nodo de pago, con su nombre. */
function clavesDeBanco(p: NodoDePago): Array<[string, string | undefined]> {
  switch (p.clase) {
    case 'cheque':
      return [['BanEmisNal', p.banEmisNal]];
    case 'transferencia':
      return [
        ['BancoOriNal', p.bancoOriNal],
        ['BancoDestNal', p.bancoDestNal],
      ];
    case 'otro':
      return [];
  }
}

/**
 * `--validate-uuids`: la forma del UUID del CFDI.
 *
 * Es una comprobación de FORMA y se dice así. Que el UUID exista en el espejo
 * de CFDI es otra cosa —más cara y más útil— y la hace el servicio, que tiene
 * base de datos; aquí sólo se caza el folio tecleado a mano y el campo que se
 * rellenó con el número de factura.
 */
export function uuidDeComprobante(
  polizas: readonly Poliza[],
  validar: boolean
): HallazgoPoliza[] {
  if (!validar) return [];
  const hs: HallazgoPoliza[] = [];
  for (const p of polizas) {
    for (const t of p.transacciones) {
      for (const c of t.comprobantes ?? []) {
        if (c.clase === 'nacional' && !UUID_RE.test(c.uuid)) {
          hs.push(
            hallazgo(
              'uuid-de-comprobante',
              'blocking',
              p.numUnIdenPol,
              `El comprobante nacional de la cuenta ${t.numCta} declara UUID_CFDI="${c.uuid}", que no ` +
                `tiene forma de folio fiscal. La autoridad cruza ese folio contra su propio registro: ` +
                `uno mal formado no encuentra nada y la deducción queda sin respaldo.`
            )
          );
        }
      }
    }
  }
  return hs;
}

/**
 * EL CFDI QUE EXISTE Y NO SE PUDO DECLARAR.
 *
 * AVISO Y NO BLOQUEO, y la razón es que la alternativa era peor de las dos
 * maneras. `CompNal/@RFC` tiene que pasar el patrón o el nodo es inválido, así
 * que un RFC malformado no puede viajar; hasta la verificación adversarial de
 * este tramo, lo que pasaba es que el constructor LANZABA y se llevaba por
 * delante el archivo del mes entero — sin dejar la lista de pólizas que es el
 * producto de este comando. Bloquear tampoco vale: el archivo SÍ se puede
 * entregar sin ese nodo (el esquema no exige comprobante en cada transacción),
 * y hasta hoy el caso hermano —contraparte SIN RFC— salía en silencio.
 *
 * Así que se emite, se dice cuál póliza perdió su comprobante y por qué, y
 * quien firma decide. Callarlo era lo único que no se podía hacer: un CFDI que
 * el archivo no declara es una deducción que la autoridad no ve respaldada.
 */
export function comprobanteSinRfcUsable(
  sinComprobante: ContextoDePolizas['sinComprobante']
): HallazgoPoliza[] {
  return sinComprobante.map((s) =>
    hallazgo(
      'comprobante-sin-rfc-usable',
      'warning',
      s.numUnIdenPol,
      `Esta póliza se emite SIN su nodo de comprobante: ${s.motivo} El archivo sale y la ` +
        `deducción queda en él sin el folio fiscal que la respalda, así que la autoridad no ` +
        `puede cruzarla.`
    )
  );
}

/**
 * UN RENGLÓN CARGA O ABONA, NO LAS DOS NI NINGUNA.
 *
 * En el libro esto lo garantiza un CHECK (001:284). En el archivo no hay
 * CHECK: `Debe` y `Haber` son dos atributos y los dos admiten 0.00, así que un
 * renglón con las dos cifras en cero se serializa perfectamente y declara un
 * movimiento de nada. Se caza aquí porque el archivo es otro sitio que el
 * libro y ya se ha visto en este proyecto que las dos mitades se den la razón.
 */
export function renglonConUnSoloLado(polizas: readonly Poliza[]): HallazgoPoliza[] {
  const hs: HallazgoPoliza[] = [];
  for (const p of polizas) {
    for (const t of p.transacciones) {
      const debe = new Decimal(t.debe);
      const haber = new Decimal(t.haber);
      if (debe.isZero() && haber.isZero()) {
        hs.push(
          hallazgo(
            'renglon-con-un-solo-lado',
            'warning',
            p.numUnIdenPol,
            `El renglón de la cuenta ${t.numCta} declara Debe 0.00 y Haber 0.00: no mueve nada. ` +
              `Suele ser un importe de cuatro decimales que al redondear a dos se quedó en cero.`
          )
        );
      } else if (!debe.isZero() && !haber.isZero()) {
        hs.push(
          hallazgo(
            'renglon-con-un-solo-lado',
            'blocking',
            p.numUnIdenPol,
            `El renglón de la cuenta ${t.numCta} declara Debe ${t.debe} Y Haber ${t.haber} a la vez. ` +
              `Un renglón carga o abona; declarar los dos hace ambiguo el signo del movimiento.`
          )
        );
      }
    }
  }
  return hs;
}

/**
 * EL TEXTO QUE HUBO QUE LIMPIAR, DICHO EN VEZ DE CALLADO.
 *
 * El constructor RECHAZA un salto de línea dentro de un atributo, y con razón:
 * todo analizador conforme lo convierte en espacio al leer (XML 1.0 §3.3.3), y
 * el SAT recibiría un texto distinto del que se firmó. Un concepto de asiento
 * con un salto pegado desde Excel es un accidente frecuente y no una
 * intención, así que se limpia para que el archivo salga — y se DENUNCIA, que
 * es el criterio exacto de `CAT-DESC-NORMALIZADA` en el catálogo de F07b.
 */
export function textoNormalizado(
  normalizados: ContextoDePolizas['normalizados']
): HallazgoPoliza[] {
  return normalizados.map((n) =>
    hallazgo(
      'texto-normalizado',
      'warning',
      n.numUnIdenPol,
      `${n.campo} llevaba saltos de línea o espacios repetidos y se emite como «${n.texto}». Un ` +
        `analizador conforme habría convertido esos caracteres en un espacio al leer el atributo, ` +
        `así que el SAT nunca habría visto el texto original; se dice en vez de callarlo.`
    )
  );
}

/** Corre las verificaciones pedidas, o todas. Ninguna se detiene en la primera. */
export function correrVerificaciones(
  ctx: ContextoDePolizas,
  checks: readonly PolizaCheckName[] = POLIZA_CHECK_NAMES
): HallazgoPoliza[] {
  const hs: HallazgoPoliza[] = [];
  if (checks.includes('poliza-cuadra')) hs.push(...polizaCuadra(ctx.polizas));
  if (checks.includes('poliza-con-dinero-sin-rastro')) {
    hs.push(...polizaConDineroSinRastro(ctx.sinRastro));
  }
  if (checks.includes('banco-en-catalogo')) hs.push(...bancoEnCatalogo(ctx.polizas, ctx.bancos));
  if (checks.includes('uuid-de-comprobante')) {
    hs.push(...uuidDeComprobante(ctx.polizas, ctx.validarUuids));
  }
  if (checks.includes('comprobante-sin-rfc-usable')) {
    hs.push(...comprobanteSinRfcUsable(ctx.sinComprobante));
  }
  if (checks.includes('renglon-con-un-solo-lado')) hs.push(...renglonConUnSoloLado(ctx.polizas));
  if (checks.includes('texto-normalizado')) hs.push(...textoNormalizado(ctx.normalizados));
  return hs;
}

export function contarHallazgos(hallazgos: readonly HallazgoPoliza[]): {
  blocking: number;
  warning: number;
} {
  return {
    blocking: hallazgos.filter((h) => h.severity === 'blocking').length,
    warning: hallazgos.filter((h) => h.severity === 'warning').length,
  };
}

/** Suma de control de las dos columnas, para quien imprime el archivo. */
export function totalesDePolizas(polizas: readonly Poliza[]): { debe: string; haber: string } {
  const sumar = (f: (t: Transaccion) => string): string =>
    polizas
      .flatMap((p) => p.transacciones)
      .reduce((a, t) => a.plus(f(t)), new Decimal(0))
      .toFixed(DECIMALES_IMPORTE_ANEXO24);
  return { debe: sumar((t) => t.debe), haber: sumar((t) => t.haber) };
}
