import { XMLBuilder, XMLValidator } from 'fast-xml-parser';
import Decimal from 'decimal.js';
import { ValidationError } from '../../../utils/errors.js';

// ============================================================
// F07b · EL CONSTRUCTOR DE XML DEL ANEXO 24
//
// LA DECISIÓN, Y LA EVIDENCIA QUE LA SOSTIENE
//
// Había dos caminos y los dos están ya en este repositorio, así que la
// comparación no es de gustos: se midió cada uno contra lo que el Anexo 24
// exige — prefijos de espacio de nombres, orden de atributos, UTF-8 y bytes
// idénticos para entradas idénticas.
//
//   A · PLANTILLA DE CADENA con `escapeXml`, como
//       src/services/payroll/mx/cfdi-nomina-generator.ts:99-133. Sostiene los
//       prefijos y el orden trivialmente, porque los escribe uno a mano. Lo
//       que NO sostiene es el escapado, y no por teoría: en ese mismo archivo,
//       de los valores que se interpolan en atributos, `escapeXml` cubre seis
//       —los nombres y las descripciones— y NO cubre `r.emp_number`,
//       `r.entity_tax_id`, `r.emp_rfc`, `e.earning_type`, `d.deduction_type`
//       ni `e.cfdi_clave_sat`. En la plantilla el escapado es OPCIONAL EN CADA
//       INTERPOLACIÓN, y una que se olvida no se nota hasta que un cliente se
//       llama «Aceros & Cía» y el archivo sale roto. Ese es el fallo de
//       diseño, no el descuido: el camino permite olvidarlo.
//
//   B · XMLBuilder de fast-xml-parser (5.11.1, ya dependencia). Aquí el
//       escapado es ESTRUCTURAL: no hay forma de pasarle un valor que se lo
//       salte. Comprobado ejecutando:
//         · conserva el orden de inserción de los atributos, no los ordena
//           alfabéticamente: {z,a,10,2} sale `z="1" a="2" 10="3" 2="4"`;
//         · los prefijos de espacio de nombres son parte del nombre del nodo y
//           salen literales (`catalogocuentas:Ctas`, `xmlns:catalogocuentas`);
//         · emite la declaración `<?xml version="1.0" encoding="UTF-8"?>`;
//         · `suppressEmptyNode` da `<Ctas .../>`, que es la forma del Anexo 24;
//         · escapa `& < > " '` en atributos, y `&amp;` de entrada sale
//           `&amp;amp;`, que es lo correcto.
//
// SE ELIGE B. Pero XMLBuilder SOLO no basta, y esto también está medido:
//
//   1. NO escapa tabulador, salto de línea ni retorno de carro dentro de un
//      atributo. `{'@_Desc': 'Caja\ny bancos'}` sale con el salto CRUDO. El
//      documento es «bien formado», pero la normalización de valores de
//      atributo (XML 1.0 §3.3.3) obliga a TODO analizador conforme a
//      sustituir #x9, #xA y #xD por un espacio: el SAT lee «Caja y bancos».
//      El dato cambia por el camino y nada lo dice. Peor: el XMLParser de
//      esta misma librería NO normaliza y devuelve el salto intacto, así que
//      una prueba de ida y vuelta contra la propia librería DA VERDE. Las dos
//      mitades se dan la razón y las dos se equivocan.
//   2. Deja pasar caracteres de control (#x00, #x0B) que XML 1.0 no admite en
//      ningún sitio — y `XMLValidator.validate` devuelve `true` sobre el
//      resultado. El único chequeo de XML que hoy existe en el repositorio
//      (camt053.ts:85) bendeciría un archivo que ningún analizador puede leer.
//   3. Convierte números: `{'@_f': 1.10}` sale `f="1.1"`. Un importe que
//      llegue como number pierde el centavo antes de tocar el XML.
//
// Por eso el serializador NO SE EXPONE. La única puerta es `serializar`, y
// pasa por `exigirValorDeAtributo`, que rechaza los tres casos. Un valor que
// no puede viajar sin alterarse NO SE ALTERA EN SILENCIO: se rechaza y se
// dice por qué. Es una declaración a la autoridad; convertir un salto de
// línea en un espacio a espaldas del contribuyente no es una comodidad.
//
// LÍMITE CONOCIDO, DICHO AQUÍ Y NO DESCUBIERTO DESPUÉS: como consecuencia de
// (1), este constructor NO PUEDE emitir un atributo con salto de línea. Para
// el Anexo 24 no hace falta —todo son códigos, nombres de cuenta e importes—,
// pero el día que un nodo lo necesite habrá que emitir `&#10;`, que XMLBuilder
// no sabe hacer, y ese es el día de cambiar de serializador, no de relajar
// esta puerta.
//
// SOBRE «ATRIBUTOS EN ORDEN»: conviene decirlo con precisión. Un XSD NO PUEDE
// exigir orden de atributos — la recomendación XML declara los atributos como
// un conjunto sin orden, y `xsd:attribute` no lleva `sequence`. Lo ordenado es
// la SECUENCIA DE ELEMENTOS. El orden de atributos importa aquí por otra razón
// igual de real: `generate` debe producir BYTES IDÉNTICOS PARA ENTRADAS
// IDÉNTICAS (docs/cli-command-catalog.md), porque así es como un humano
// compara la presentación de este mes contra la del anterior. Por eso los
// atributos viajan como una LISTA ORDENADA de pares y no como un objeto: el
// orden queda escrito en el tipo, y no depende de que quien edite mañana
// recuerde que JavaScript conserva el orden de inserción de las claves.
// ============================================================

/** Un atributo. `undefined` = opcional ausente; NO se emite. */
export type Atributo = readonly [nombre: string, valor: string | undefined];

/** Un nodo del árbol. Los hijos del mismo nombre han de ir contiguos. */
export interface NodoXml {
  /** Nombre cualificado con su prefijo, p. ej. `catalogocuentas:Ctas`. */
  nombre: string;
  atributos: readonly Atributo[];
  hijos?: readonly NodoXml[];
}

/**
 * El primer punto de código que XML 1.0 §2.2 no admite en ningún sitio, o
 * `null` si no hay ninguno. No son caracteres «raros»: #x00 llega de un CSV
 * mal codificado y #x0B de un pegado desde Word. XMLBuilder los deja pasar y
 * XMLValidator aprueba el resultado.
 *
 * Se recorre por PUNTO DE CÓDIGO y no con una expresión regular a propósito:
 * así entra en la misma pasada el sustituto suelto (D800–DFFF), que no es
 * codificable en UTF-8 y que `Buffer.from(xml, 'utf8')` convertiría en U+FFFD
 * al archivar — o sea, el hash se calcularía sobre unos bytes distintos de los
 * que el constructor creyó emitir.
 *
 * #x9, #xA y #xD SÍ son caracteres legales de XML: no van aquí, van en la
 * comprobación siguiente, que es de otra cosa.
 */
function puntoProhibidoXml10(valor: string): number | null {
  for (let i = 0; i < valor.length; i++) {
    const cp = valor.codePointAt(i);
    if (cp === undefined) continue;
    if (cp > 0xffff) {
      i++; // par sustituto bien formado: se consume entero
      continue;
    }
    const control = cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
    const sustitutoSuelto = cp >= 0xd800 && cp <= 0xdfff;
    const noCaracter = cp === 0xfffe || cp === 0xffff;
    if (control || sustitutoSuelto || noCaracter) return cp;
  }
  return null;
}

/** Los tres que la normalización de atributos convierte en espacio. */
const NORMALIZABLES = /[\t\n\r]/;

/**
 * La puerta. Todo valor de atributo pasa por aquí antes de llegar al
 * serializador, y los mensajes nombran el nodo y el atributo porque quien los
 * va a leer está mirando una cuenta concreta, no un documento.
 */
export function exigirValorDeAtributo(nodo: string, atributo: string, valor: unknown): string {
  if (typeof valor !== 'string') {
    // El dinero es cadena en esta casa (decimal.js, cuatro decimales). Si
    // llega un number, XMLBuilder lo imprime con la aritmética de coma
    // flotante y 1.10 se convierte en "1.1": el centavo se pierde ANTES del
    // XML, donde ya nadie lo busca.
    throw new ValidationError(
      `${nodo}/@${atributo}: el valor ha de ser cadena y llegó ${typeof valor}. ` +
        `Los importes se formatean con importeAnexo24() antes de construir el nodo.`
    );
  }
  const prohibido = puntoProhibidoXml10(valor);
  if (prohibido !== null) {
    const punto = `U+${prohibido.toString(16).toUpperCase().padStart(4, '0')}`;
    throw new ValidationError(
      `${nodo}/@${atributo}: el valor contiene ${punto}, que XML 1.0 no admite en ningún sitio. ` +
        `El documento saldría ilegible para el SAT y el validador de esta librería NO lo detecta.`
    );
  }
  if (NORMALIZABLES.test(valor)) {
    throw new ValidationError(
      `${nodo}/@${atributo}: el valor contiene un salto de línea o un tabulador. ` +
        `Todo analizador conforme los sustituye por un espacio al leer el atributo (XML 1.0 §3.3.3), ` +
        `así que el SAT recibiría un texto distinto del que se firmó. Limpia el dato en el origen.`
    );
  }
  return valor;
}

/**
 * Una sola instancia, con las opciones fijadas aquí y no en cada llamada: el
 * formato es parte de los bytes, y los bytes son lo que se compara mes a mes.
 */
const SERIALIZADOR = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  // Explícito aunque sea el valor por omisión: es la opción que hace que el
  // escapado sea estructural, y una edición futura que la apague dejaría de
  // escapar sin que ninguna prueba de forma lo notara.
  processEntities: true,
});

/** Traduce un nodo al objeto que XMLBuilder entiende, conservando el orden. */
function aObjeto(nodo: NodoXml): Record<string, unknown> {
  const objeto: Record<string, unknown> = {};

  for (const [nombre, valor] of nodo.atributos) {
    if (valor === undefined) continue;
    objeto[`@_${nombre}`] = exigirValorDeAtributo(nodo.nombre, nombre, valor);
  }

  const hijos = nodo.hijos ?? [];
  if (hijos.length > 0) {
    // Los hijos se agrupan por nombre porque XMLBuilder emite una clave por
    // nombre de elemento. Eso conserva `xsd:sequence` SÓLO si los del mismo
    // nombre ya venían contiguos; si no, el objeto los reagruparía y el orden
    // de la secuencia cambiaría en silencio. Se comprueba en vez de confiar.
    const vistos = new Set<string>();
    let anterior: string | null = null;
    for (const hijo of hijos) {
      if (hijo.nombre !== anterior) {
        if (vistos.has(hijo.nombre)) {
          throw new ValidationError(
            `${nodo.nombre}: los hijos <${hijo.nombre}> no están contiguos. ` +
              `El serializador los agruparía y alteraría el orden de la secuencia, que sí es ` +
              `parte del esquema. Ordena los hijos por tipo antes de construir el nodo.`
          );
        }
        vistos.add(hijo.nombre);
        anterior = hijo.nombre;
      }
    }

    const porNombre = new Map<string, Record<string, unknown>[]>();
    for (const hijo of hijos) {
      const lista = porNombre.get(hijo.nombre) ?? [];
      lista.push(aObjeto(hijo));
      porNombre.set(hijo.nombre, lista);
    }
    for (const [nombre, lista] of porNombre) objeto[nombre] = lista;
  }

  return objeto;
}

/**
 * Serializa el árbol. Es la ÚNICA salida del módulo hacia XML: no se exporta
 * el XMLBuilder ni ninguna forma de saltarse `exigirValorDeAtributo`.
 *
 * La comprobación final con `XMLValidator` es el escalón débil y se deja a
 * propósito como segundo cinturón (es el que camt053.ts ya usa para la
 * lectura). El fuerte es la puerta de arriba: se midió que XMLValidator
 * aprueba un documento con `#x00` dentro de un atributo.
 */
export function serializar(raiz: NodoXml): string {
  const documento: Record<string, unknown> = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    [raiz.nombre]: aObjeto(raiz),
  };

  const xml: string = SERIALIZADOR.build(documento);

  const veredicto: unknown = XMLValidator.validate(xml);
  if (veredicto !== true) {
    throw new ValidationError(
      `El XML construido no es bien formado, lo que es un defecto de este constructor y no del dato: ${JSON.stringify(veredicto)}`
    );
  }
  return xml;
}

/** Los bytes UTF-8 exactos que se archivan y sobre los que se calcula el hash. */
export function bytesDe(xml: string): Buffer {
  return Buffer.from(xml, 'utf8');
}

// ── LOS IMPORTES ────────────────────────────────────────────────────────
//
// LA CASA guarda dinero como cadena con decimal.js y CUATRO decimales. El
// Anexo 24 NO acepta cuatro: `tImporte` de la balanza es un decimal de DOS.
// Así que hay una conversión, y una conversión de dinero que nadie mira es
// como se descuadra una balanza firmada.
//
// LO QUE ESTÁ COMPROBADO Y LO QUE NO. Que la balanza del Anexo 24 lleva dos
// decimales es la forma en que la publica el SAT y en la que la reciben todos
// los validadores; lo damos por firme. Lo que NO se ha podido comprobar contra
// el XSD real —porque no hay ningún .xsd en este repositorio— son las facetas
// exactas: si `tImporte` admite negativos y cuál es su `totalDigits`. Por eso
// el negativo sale como AVISO del validador de reglas y no como bloqueo.
//
// Y el residuo VIAJA CON EL IMPORTE, no se tira. Redondear por separado
// SaldoIni, Debe, Haber y SaldoFin puede romper `SaldoIni + Debe − Haber =
// SaldoFin` por un centavo aunque las cuatro cifras de cuatro decimales
// cuadren perfectamente. Quien formatea tiene que poder verlo; por eso la
// función no devuelve una cadena, devuelve la cadena Y lo que se dejó atrás.

/** Los decimales que el Anexo 24 espera en un importe. */
export const DECIMALES_IMPORTE_ANEXO24 = 2;

export interface ImporteAnexo24 {
  /** El texto que va al atributo, con exactamente dos decimales. */
  texto: string;
  /** Lo que el redondeo se comió, con signo. '0' cuando no se perdió nada. */
  residuo: string;
  /** true = el redondeo movió el importe. El llamador decide si lo denuncia. */
  redondeado: boolean;
}

/**
 * Formatea un importe de cuatro decimales al de dos que exige el Anexo 24.
 *
 * Redondeo MITAD ARRIBA EN VALOR ABSOLUTO (`ROUND_HALF_UP` de decimal.js):
 * 0.125 → 0.13 y −0.125 → −0.13. Es el criterio del redondeo comercial y el
 * que aplican los validadores fiscales mexicanos; se fija aquí, con nombre,
 * para que no dependa de la configuración global de Decimal que otro módulo
 * pudiera haber cambiado.
 */
export function importeAnexo24(monto: string): ImporteAnexo24 {
  let d: Decimal;
  try {
    d = new Decimal(monto);
  } catch {
    throw new ValidationError(`Importe no numérico para el Anexo 24: "${monto}".`);
  }
  if (!d.isFinite()) {
    throw new ValidationError(`Importe no finito para el Anexo 24: "${monto}".`);
  }

  const redondeado = d.toDecimalPlaces(DECIMALES_IMPORTE_ANEXO24, Decimal.ROUND_HALF_UP);
  const residuo = d.minus(redondeado);

  return {
    texto: redondeado.toFixed(DECIMALES_IMPORTE_ANEXO24),
    residuo: residuo.isZero() ? '0' : residuo.toString(),
    redondeado: !residuo.isZero(),
  };
}
