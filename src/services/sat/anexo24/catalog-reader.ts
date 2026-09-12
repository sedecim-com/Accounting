import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../../../utils/errors.js';
import { NS_CATALOGO, VERSION_CATALOGO } from './validador.js';

// ============================================================
// O1 · EL LECTOR DEL CtaCatalogo — LA PUERTA DE ENTRADA
//
// Este repositorio ESCRIBÍA el CtaCatalogo del Anexo 24 y no sabía leerlo.
// Este archivo es el espejo de `catalogo-cuentas.ts`, y el espejo no es una
// metáfora: cada campo que aquí se lee es un campo que allí se escribe, con
// el mismo nombre y el mismo significado. Si los dos no coincidieran, el
// sistema no podría releer lo que él mismo entrega, que es la primera prueba
// que cualquiera va a hacerle.
//
// POR QUÉ EL XML DEL SAT Y NO UN ADAPTADOR POR COMPETIDOR. La contabilidad
// electrónica es obligación fiscal, así que TODO sistema contable mexicano en
// operación exporta este archivo —CONTPAQi por `Contabilidad electrónica`,
// Aspel COI por `Fiscales → Generación de XML`—. Un solo lector de este
// formato llena código, nombre, agrupador, naturaleza y jerarquía de un golpe;
// un adaptador propietario por competidor sería trabajo repetido para llegar
// al mismo sitio con menos garantías.
//
// ── LAS DOS COSAS QUE fast-xml-parser HACE MAL AL LEER, MEDIDAS ─────────
//
// `xml.ts` documenta lo que el CONSTRUCTOR hace mal. Estas son las del
// ANALIZADOR, y las dos corrompen datos en silencio si no se corrigen aquí.
// Se comprobaron ejecutando la librería (5.11.1) sobre un atributo de prueba:
//
//   1. SIN `htmlEntities: true`, las referencias NUMÉRICAS de carácter NO se
//      decodifican. `Desc="Cr&#233;dito"` se lee como la cadena literal
//      `Cr&#233;dito`, y esa cadena entra a la base como nombre de la cuenta.
//      `&amp;` sí se decodifica, de modo que la mitad funciona y la mitad no:
//      es el peor reparto posible, porque una prueba con `&` da verde. Los
//      exportadores escriben acentos así con toda normalidad.
//   2. CON `htmlEntities: true`, `&#10;` se convierte en un salto de línea
//      REAL dentro del valor del atributo. Pero XML 1.0 §3.3.3 obliga a todo
//      analizador conforme a sustituir #x9, #xA y #xD por un ESPACIO al leer
//      un atributo: el SAT, que sí normaliza, leyó un espacio. Si aquí
//      guardáramos el salto, nuestro nombre de cuenta diferiría del que la
//      autoridad tiene por presentado. Por eso `normalizarAtributo` está
//      escrito a mano: es la mitad de la norma que la librería no implementa.
//
// La misma pareja de defectos vive en los demás lectores de XML del árbol
// (`catalogoDesdeXml` de balanza-service.ts, cfdi-parser.ts, camt053.ts):
// ninguno pasa `htmlEntities`. Aquí se corrige donde hace daño —un catálogo
// ajeno viene lleno de nombres acentuados— y se deja dicho para los demás.
//
// ── QUÉ FALLA Y QUÉ SE ANOTA ────────────────────────────────────────────
//
// LANZA sólo cuando el archivo no es un CtaCatalogo: XML mal formado, raíz
// que no es `Catalogo`, cabecera ausente. No hay nada que leer y no hay fila
// que nombrar.
//
// ANOTA todo lo demás, con NÚMERO DE FILA Y CAMPO, y sigue leyendo. Es
// deliberado: quien migra tiene un archivo de ochocientas cuentas exportado
// por otro sistema, y un lector que se detiene en el primer defecto lo obliga
// a mil corridas para descubrir mil problemas. La lista completa se entrega
// de una vez; `puedeImportarse` dice si alguno de los anotados impide seguir.
// ============================================================

/** `bloquea` impide importar el archivo entero; `aviso` se nombra y se sigue. */
export type ReadSeverity = 'bloquea' | 'aviso';

/**
 * Un defecto del ARCHIVO, no de una cuenta del mayor.
 *
 * No reutiliza el `Hallazgo` del validador a propósito: aquél apunta a una
 * cuenta (`numCta`) porque nace de un catálogo YA resuelto, y éste tiene que
 * apuntar a una LÍNEA del archivo —la fila 417— porque es lo único que
 * permite ir a arreglarla. Cuando falta el propio NumCta, o cuando aparece
 * dos veces, el número de cuenta no identifica nada y el de fila sí.
 */
export interface CatalogReadFinding {
  /** Identificador estable de la regla, para filtrar y silenciar. */
  regla: string;
  severidad: ReadSeverity;
  /** Posición del nodo `Ctas` en el archivo, empezando en 1. */
  fila?: number;
  /** El atributo culpable, cuando lo hay. */
  campo?: string;
  numCta?: string;
  mensaje: string;
}

/** Una fila `Ctas` leída y con la forma que el Anexo 24 declara. */
export interface CatalogFileRow {
  /** Posición en el archivo, empezando en 1. Es lo que el informe nombra. */
  fila: number;
  numCta: string;
  desc: string;
  /** El `NumCta` del padre, tal como el archivo lo declara. */
  subCtaDe: string | null;
  codAgrup: string;
  nivel: number;
  natur: 'D' | 'A';
}

export interface CatalogFileHeader {
  version: string;
  rfc: string;
  /** Dos dígitos, tal como viene. */
  mes: string;
  anio: string;
}

export interface CatalogFileRead {
  header: CatalogFileHeader;
  /**
   * Sólo las filas que tienen la forma completa. Una fila con `Natur="X"` no
   * está aquí —no se puede fabricar una naturaleza que el archivo no trae— y
   * sí está en `findings` con su número y su campo.
   */
  rows: readonly CatalogFileRow[];
  /** Cuántos nodos `Ctas` traía el archivo, incluidas las filas defectuosas. */
  rowsLeidas: number;
  findings: readonly CatalogReadFinding[];
  /** false en cuanto hay un hallazgo que bloquea. */
  puedeImportarse: boolean;
}

/**
 * El analizador, con las tres opciones que no son de estilo:
 *
 *  · `htmlEntities` — sin él los acentos escritos como `&#233;` entran
 *    literales a la base (medido arriba).
 *  · `trimValues: false` — se recorta A MANO para poder DENUNCIAR el recorte.
 *    Un código de cuenta con un espacio delante es una cuenta distinta de su
 *    gemela sin él y nadie las distingue en pantalla; recortar en silencio
 *    hace que dos filas del archivo se conviertan en una y que nadie se
 *    entere de cuál sobrevivió.
 *  · `removeNSPrefix` — el prefijo lo elige quien generó el archivo
 *    (`catalogocuentas:` es el habitual, no el obligatorio). Preguntar por un
 *    prefijo concreto es cómo un lector devuelve cero cuentas en silencio.
 *
 * SE EXPORTA COMO FÁBRICA, y ésa es la única razón por la que no es una
 * constante: la balanza de apertura (O1 · capa 2) lee OTRO archivo del mismo
 * Anexo 24 y necesita EXACTAMENTE estas opciones. Copiarlas allí produciría
 * dos lectores que hoy dicen lo mismo y que dentro de un año no: el que
 * olvidara `htmlEntities` metería `Cr&#233;dito` en la base, que es el defecto
 * medido que la cabecera de este archivo documenta. Una sola definición, y el
 * nodo que se repite como parámetro porque es lo único que cambia.
 */
export function anexo24Parser(nodoRepetido: string): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    htmlEntities: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (nombre) => nombre === nodoRepetido,
  });
}

const ANALIZADOR = anexo24Parser('Ctas');

export function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Un escalar de un objeto ajeno, como texto. El veredicto de `XMLValidator`
 * viene tipado como `unknown` y `String(x)` sobre un objeto rinde
 * «[object Object]», que en un mensaje de error es peor que no decir nada.
 */
export function scalarText(v: unknown, sifalta: string): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : sifalta;
}

/**
 * La normalización de valores de atributo de XML 1.0 §3.3.3, que la librería
 * no hace: tabulador, salto de línea y retorno de carro valen un espacio.
 *
 * Devuelve además si cambió algo, porque el cambio se anota. Un nombre de
 * cuenta que llevaba un salto se guarda con espacio —que es lo que el SAT
 * leyó— y quien migra se entera de que su archivo traía uno.
 */
export function normalizarAtributo(valor: string): { texto: string; normalizado: boolean } {
  const texto = valor.replace(/[\t\n\r]/g, ' ');
  return { texto, normalizado: texto !== valor };
}

/** Lo que hace falta para leer un atributo y anotar lo que le pasó. */
export interface LecturaDeAtributo {
  /** El valor ya normalizado y recortado. Cadena vacía si el atributo falta. */
  valor: string;
  presente: boolean;
}

/**
 * Lee un atributo del nodo, lo normaliza según XML 1.0 §3.3.3, lo recorta, y
 * ANOTA las dos cosas que le hizo. Se comparte con el lector de la balanza
 * (O1 · capa 2) por la misma razón que el analizador: la normalización del
 * atributo no es una preferencia, es la mitad de la norma que la librería no
 * implementa, y dos copias de ella serían dos criterios distintos sobre qué
 * texto se guarda —uno con el salto de línea dentro y el otro no— para dos
 * archivos que la autoridad leyó con el mismo analizador.
 */
export function readAttribute(
  nodo: Record<string, unknown>,
  nombre: string,
  fila: number | undefined,
  numCta: string | undefined,
  findings: CatalogReadFinding[]
): LecturaDeAtributo {
  const crudo: unknown = nodo[`@_${nombre}`];
  if (typeof crudo !== 'string') return { valor: '', presente: false };

  const { texto, normalizado } = normalizarAtributo(crudo);
  if (normalizado) {
    findings.push({
      regla: 'LEC-ATRIBUTO-NORMALIZADO',
      severidad: 'aviso',
      ...(fila === undefined ? {} : { fila }),
      campo: nombre,
      ...(numCta === undefined ? {} : { numCta }),
      mensaje:
        `${nombre} traía un salto de línea o un tabulador y se lee con espacios en su lugar. ` +
        `No es una licencia nuestra: todo analizador conforme hace esa sustitución al leer un ` +
        `atributo (XML 1.0 §3.3.3), así que el SAT tampoco vio el original.`,
    });
  }

  const recortado = texto.trim();
  if (recortado !== texto) {
    findings.push({
      regla: 'LEC-ATRIBUTO-CON-ESPACIOS',
      severidad: 'aviso',
      ...(fila === undefined ? {} : { fila }),
      campo: nombre,
      ...(numCta === undefined ? {} : { numCta }),
      mensaje:
        `${nombre} empieza o acaba en espacio ("${texto}") y se importa recortado. Un código con ` +
        `un espacio invisible delante es una cuenta DISTINTA de su gemela sin él, y en pantalla ` +
        `las dos se ven igual.`,
    });
  }

  return { valor: recortado, presente: true };
}

/** Sólo un entero decimal. `Number("1.5")` da 1.5 y `parseInt("1x")` da 1. */
const ENTERO = /^[0-9]+$/;

/**
 * Lee un CtaCatalogo 1.3 y devuelve sus filas, su cabecera y sus defectos.
 *
 * Función PURA: recibe el texto, no abre archivos ni toca la base. Es lo que
 * permite fijar en una prueba unitaria el archivo exacto que produce cada
 * hallazgo, y lo que deja probar la ida y vuelta contra el generador sin
 * levantar un Postgres.
 */
export function readCtaCatalogo(xml: string): CatalogFileRead {
  const veredicto: unknown = XMLValidator.validate(xml);
  if (veredicto !== true) {
    const err = esObjeto(veredicto) ? veredicto['err'] : undefined;
    const detalle = esObjeto(err)
      ? `${scalarText(err['msg'], 'error desconocido')} (línea ${scalarText(err['line'], '?')})`
      : JSON.stringify(veredicto);
    throw new ValidationError(
      `El archivo no es XML bien formado, así que no hay catálogo que leer: ${detalle}. ` +
        `Vuelve a exportarlo desde el sistema de origen; un XML truncado suele venir de una ` +
        `descarga interrumpida.`
    );
  }

  const crudo: unknown = ANALIZADOR.parse(xml) as unknown;
  const raiz = esObjeto(crudo) ? crudo['Catalogo'] : undefined;
  if (!esObjeto(raiz)) {
    // Nombrar lo que SÍ trae: el error más común de esta puerta es entregar
    // la balanza en vez del catálogo, y «falta Catalogo» no lo dice.
    const nombres = esObjeto(crudo)
      ? Object.keys(crudo).filter((k) => !k.startsWith('?') && !k.startsWith('#'))
      : [];
    throw new ValidationError(
      `El archivo no es un catálogo de cuentas del Anexo 24: su raíz ${
        nombres.length > 0 ? `es <${nombres.join('>, <')}>` : 'no tiene elementos'
      } y se esperaba <Catalogo>. El CtaCatalogo y la BalanzaComprobacion son archivos distintos; ` +
        `esta puerta lee el primero.`
    );
  }

  const findings: CatalogReadFinding[] = [];

  // ── LA CABECERA ───────────────────────────────────────────────────────
  //
  // Sin RFC no se puede comprobar que el archivo sea de esta entidad, que es
  // la protección que impide cargar la contabilidad de otro contribuyente.
  // Por eso su ausencia LANZA en vez de anotarse.
  const rfc = readAttribute(raiz, 'RFC', undefined, undefined, findings);
  if (!rfc.presente || rfc.valor === '') {
    throw new ValidationError(
      `El catálogo no declara RFC en su nodo raíz. Sin él no se puede comprobar que el archivo ` +
        `sea de esta entidad, y cargar el catálogo de otro contribuyente es la equivocación más ` +
        `cara de una migración.`
    );
  }
  const version = readAttribute(raiz, 'Version', undefined, undefined, findings);
  const mes = readAttribute(raiz, 'Mes', undefined, undefined, findings);
  const anio = readAttribute(raiz, 'Anio', undefined, undefined, findings);

  if (version.valor !== VERSION_CATALOGO) {
    findings.push({
      regla: 'LEC-VERSION',
      severidad: 'aviso',
      campo: 'Version',
      mensaje:
        `El archivo declara Version="${version.valor}" y este lector está escrito contra la ${VERSION_CATALOGO}, ` +
        `que es la vigente. Se lee de todas formas —los campos del nodo Ctas no han cambiado— y se ` +
        `dice para que nadie dé por verificado lo que no se verificó.`,
    });
  }
  if (!xml.includes(NS_CATALOGO)) {
    findings.push({
      regla: 'LEC-SIN-ESPACIO-DE-NOMBRES',
      severidad: 'aviso',
      mensaje:
        `El archivo no declara el espacio de nombres ${NS_CATALOGO}. Tiene la forma de un ` +
        `CtaCatalogo y se lee como tal, pero no se identifica como uno: revisa de dónde salió.`,
    });
  }

  // ── LAS FILAS ─────────────────────────────────────────────────────────
  const nodos = raiz['Ctas'];
  const lista = Array.isArray(nodos) ? nodos : [];
  if (lista.length === 0) {
    findings.push({
      regla: 'LEC-VACIO',
      severidad: 'bloquea',
      mensaje:
        `El catálogo no declara ni una cuenta. Importar un archivo vacío no crea nada y deja la ` +
        `entidad exactamente igual, así que se rehúsa en vez de informar de un éxito sin efecto.`,
    });
  }

  const rows: CatalogFileRow[] = [];
  const vistas = new Map<string, number>();

  for (let i = 0; i < lista.length; i++) {
    const fila = i + 1;
    const nodo: unknown = lista[i];
    if (!esObjeto(nodo)) continue;

    const numCta = readAttribute(nodo, 'NumCta', fila, undefined, findings);
    const codigo = numCta.valor === '' ? undefined : numCta.valor;
    const desc = readAttribute(nodo, 'Desc', fila, codigo, findings);
    const codAgrup = readAttribute(nodo, 'CodAgrup', fila, codigo, findings);
    const nivel = readAttribute(nodo, 'Nivel', fila, codigo, findings);
    const natur = readAttribute(nodo, 'Natur', fila, codigo, findings);
    const subCtaDe = readAttribute(nodo, 'SubCtaDe', fila, codigo, findings);

    let completa = true;

    if (codigo === undefined) {
      findings.push({
        regla: 'LEC-NUMCTA-AUSENTE',
        severidad: 'bloquea',
        fila,
        campo: 'NumCta',
        mensaje:
          `La fila ${fila} no trae NumCta. Es el número con el que la balanza y las pólizas apuntan ` +
          `a esta cuenta: sin él la fila no identifica nada y no hay cuenta que crear.`,
      });
      completa = false;
    } else {
      const anterior = vistas.get(codigo);
      if (anterior !== undefined) {
        findings.push({
          regla: 'LEC-NUMCTA-DUPLICADO',
          severidad: 'bloquea',
          fila,
          campo: 'NumCta',
          numCta: codigo,
          mensaje:
            `NumCta "${codigo}" aparece en la fila ${fila} y ya estaba en la ${anterior}. No se importa ` +
            `nada: con el número duplicado no se puede saber cuál de las dos filas describe la cuenta, ` +
            `y elegir una es inventarse la respuesta.`,
        });
        completa = false;
      } else {
        vistas.set(codigo, fila);
      }
    }

    if (desc.valor === '') {
      findings.push({
        regla: 'LEC-DESC-AUSENTE',
        severidad: 'bloquea',
        fila,
        campo: 'Desc',
        ...(codigo === undefined ? {} : { numCta: codigo }),
        mensaje:
          `La fila ${fila}${codigo === undefined ? '' : ` (NumCta "${codigo}")`} no trae Desc. El nombre ` +
          `de la cuenta es obligatorio en el nodo Ctas y es lo único que un contador lee en pantalla.`,
      });
      completa = false;
    }

    if (!ENTERO.test(nivel.valor) || Number(nivel.valor) < 1) {
      findings.push({
        regla: 'LEC-NIVEL',
        severidad: 'bloquea',
        fila,
        campo: 'Nivel',
        ...(codigo === undefined ? {} : { numCta: codigo }),
        mensaje:
          `Nivel "${nivel.valor}" en la fila ${fila}${codigo === undefined ? '' : ` (NumCta "${codigo}")`}: ` +
          `ha de ser un entero mayor o igual que 1. Es la profundidad que el SAT lee para reconstruir ` +
          `la jerarquía del catálogo.`,
      });
      completa = false;
    }

    if (natur.valor !== 'D' && natur.valor !== 'A') {
      findings.push({
        regla: 'LEC-NATUR',
        severidad: 'bloquea',
        fila,
        campo: 'Natur',
        ...(codigo === undefined ? {} : { numCta: codigo }),
        mensaje:
          `Natur "${natur.valor}" en la fila ${fila}${codigo === undefined ? '' : ` (NumCta "${codigo}")`}: ` +
          `sólo admite D (deudora) o A (acreedora). La naturaleza decide el signo del saldo de la ` +
          `cuenta, así que no se puede suponer: una cuenta con la naturaleza cambiada descuadra la ` +
          `balanza por el doble de su saldo.`,
      });
      completa = false;
    }

    if (codAgrup.valor === '') {
      // NO bloquea, y es una decisión: el encargo dice que un agrupador
      // ausente es un HALLAZGO QUE EL INFORME NOMBRA, no un valor por
      // omisión ni un portazo. La cuenta puede entrar igual si su sitio en la
      // jerarquía la define; lo que no puede es entrar sin que se sepa.
      findings.push({
        regla: 'LEC-CODAGRUP-AUSENTE',
        severidad: 'aviso',
        fila,
        campo: 'CodAgrup',
        ...(codigo === undefined ? {} : { numCta: codigo }),
        mensaje:
          `La fila ${fila}${codigo === undefined ? '' : ` (NumCta "${codigo}")`} no trae CodAgrup. Es ` +
          `obligatorio en el Anexo 24: esta cuenta no se podrá declarar al SAT hasta que se le mapee ` +
          `un código agrupador.`,
      });
    }

    if (!completa || codigo === undefined) continue;

    rows.push({
      fila,
      numCta: codigo,
      desc: desc.valor,
      subCtaDe: subCtaDe.presente && subCtaDe.valor !== '' ? subCtaDe.valor : null,
      codAgrup: codAgrup.valor,
      nivel: Number(nivel.valor),
      natur: natur.valor === 'D' ? 'D' : 'A',
    });
  }

  return {
    header: { version: version.valor, rfc: rfc.valor.toUpperCase(), mes: mes.valor, anio: anio.valor },
    rows,
    rowsLeidas: lista.length,
    findings,
    puedeImportarse: findings.every((f) => f.severidad !== 'bloquea'),
  };
}
