import * as fs from 'node:fs';
import * as path from 'node:path';
import { POLICY_CATALOG } from '../../services/policy/pending-catalog.js';

// ============================================================
// GOLDEN SET — el corpus con respuesta (A1)
//
// tests/golden/cfdi/ guarda pares `caso.xml` + `caso.esperado.json`: el
// comprobante y el asiento que un contador competente registraría — o la
// declaración de que la respuesta correcta es PREGUNTAR (resultado
// 'pregunta') o de que el archivo jamás debe llegar al modelo (resultado
// 'determinista', los REP). El esperado es la definición operativa de
// «clasificar bien»; el arnés (scripts/eval-clasificador.ts) lo compara
// contra lo que el modelo hizo y src/ai/eval/puntuacion.ts pone el número.
//
// A7·2 · UN ESPERADO PUEDE DEPENDER DEL PANEL, Y ENTONCES LO DECLARA.
//
// «Clasificar bien» no siempre es una función del CFDI solo. El mismo
// comprobante de equipo de cómputo tiene DOS respuestas correctas según lo
// que el despacho haya contestado en el panel de políticas: con el umbral
// de capitalización contestado, capitalizar y proponer el borrador; sin
// contestar, PREGUNTAR — porque el defecto del sistema es un paliativo,
// no el criterio de nadie. Hasta hoy el esquema no sabía decir esa
// diferencia, así que el corpus bendecía la segunda respuesta como si
// fuera la única, y con ella la ceguera del agente al panel.
//
// `precondicion.politicas` es esa declaración: clave → valor contestado,
// o null para «el despacho NO la ha contestado». Ausente significa que el
// caso no pende de ninguna respuesta del panel y corre bajo cualquiera.
// El arnés siembra el panel declarado ANTES de correr el caso; un caso
// que declara una clave que no existe en el catálogo rompe la carga, que
// es la misma vara chueca que un asiento descuadrado.
//
// Este módulo VALIDA el corpus al cargarlo: un xml sin esperado, un
// esperado sin xml, un lado inválido o un asiento descuadrado rompen la
// carga — un golden set con errores mide con una vara chueca, y eso es
// peor que no medir.
// ============================================================

export type ResultadoEsperado = 'draft' | 'pregunta' | 'determinista';

export interface LineaEsperada {
  /** Códigos aceptables para la línea (p. ej. cualquier banco: 1110 o 1111). */
  cuenta: string[];
  lado: 'cargo' | 'abono';
  monto: string;
}

/**
 * El estado del PANEL DE POLÍTICAS que el caso asume. Sin esto, un caso cuya
 * respuesta correcta depende de un criterio del despacho es ambiguo: mediría
 * al clasificador contra una respuesta que sólo vale bajo un panel concreto.
 */
export interface PrecondicionGolden {
  /** clave del panel → valor contestado, o null = «nadie la ha contestado». */
  politicas: Record<string, string | null>;
}

export interface EsperadoGolden {
  caso: string;
  resultado: ResultadoEsperado;
  tratamiento: 'PUE' | 'PPD' | null;
  sospecha: boolean;
  asiento: LineaEsperada[] | null;
  /** Ausente = el caso no pende de ninguna respuesta del panel. */
  precondicion?: PrecondicionGolden;
  nota: string;
}

export interface CasoGolden {
  nombre: string;
  xmlPath: string;
  xml: string;
  esperado: EsperadoGolden;
}

const RESULTADOS: ReadonlySet<string> = new Set(['draft', 'pregunta', 'determinista']);
const LADOS: ReadonlySet<string> = new Set(['cargo', 'abono']);
const CLAVES_DEL_PANEL: ReadonlySet<string> = new Set(POLICY_CATALOG.map((p) => p.key));

function validarEsperado(nombre: string, e: EsperadoGolden): void {
  const falla = (msg: string): never => {
    throw new Error(`Golden «${nombre}»: ${msg}`);
  };
  if (e.caso !== nombre) falla(`el campo caso ("${e.caso}") no coincide con el archivo`);
  if (!RESULTADOS.has(e.resultado)) falla(`resultado inválido "${e.resultado}"`);
  if (e.tratamiento !== null && e.tratamiento !== 'PUE' && e.tratamiento !== 'PPD') {
    falla(`tratamiento inválido "${e.tratamiento}"`);
  }
  if (e.precondicion !== undefined) {
    const pol = e.precondicion.politicas;
    if (pol === null || typeof pol !== 'object' || Array.isArray(pol)) {
      falla('precondicion.politicas debe ser un objeto clave → valor');
    }
    const claves = Object.keys(pol);
    if (claves.length === 0) {
      // Una precondición vacía dice «declaro que dependo del panel» y no
      // declara nada: se lee como si el caso estuviera cubierto y no lo está.
      falla('precondicion sin ninguna política: o declara cuál, o quítala');
    }
    for (const clave of claves) {
      if (!CLAVES_DEL_PANEL.has(clave)) {
        // Un caso que asume una política inexistente NO se puede montar: el
        // arnés sembraría una clave que nadie lee y mediría bajo un panel
        // distinto del que el esperado cree declarar.
        falla(`la precondición nombra "${clave}", que no está en el catálogo de políticas`);
      }
      const valor = pol[clave];
      if (valor !== null && (typeof valor !== 'string' || valor.trim() === '')) {
        falla(`el valor declarado para "${clave}" no es un texto ni null`);
      }
    }
  }
  if (e.resultado === 'draft') {
    if (!Array.isArray(e.asiento) || e.asiento.length < 2) {
      return falla('un caso draft necesita asiento esperado con al menos dos líneas');
    }
    let cargos = 0;
    let abonos = 0;
    for (const linea of e.asiento) {
      if (!Array.isArray(linea.cuenta) || linea.cuenta.length === 0) {
        falla('cada línea esperada lista al menos un código de cuenta aceptable');
      }
      if (!LADOS.has(linea.lado)) falla(`lado inválido "${linea.lado}"`);
      const monto = Number(linea.monto);
      if (!Number.isFinite(monto) || monto <= 0) falla(`monto ilegible "${linea.monto}"`);
      if (linea.lado === 'cargo') cargos += monto;
      else abonos += monto;
    }
    if (Math.abs(cargos - abonos) > 0.01) {
      falla(`el asiento esperado no cuadra (cargos ${cargos.toFixed(2)} vs abonos ${abonos.toFixed(2)})`);
    }
  } else if (e.asiento !== null) {
    falla(`un caso ${e.resultado} no lleva asiento esperado (es null)`);
  }
}

/** Carga y valida el corpus completo; opcionalmente filtra por nombres. */
export function cargarCasosGolden(dir: string, soloCasos?: string[]): CasoGolden[] {
  const archivos = fs.readdirSync(dir).sort();
  const xmls = archivos.filter((a) => a.endsWith('.xml')).map((a) => a.replace(/\.xml$/, ''));
  const esperados = archivos
    .filter((a) => a.endsWith('.esperado.json'))
    .map((a) => a.replace(/\.esperado\.json$/, ''));

  const sinEsperado = xmls.filter((n) => !esperados.includes(n));
  if (sinEsperado.length > 0) {
    throw new Error(`Golden sin esperado: ${sinEsperado.join(', ')} — un xml sin respuesta no mide nada`);
  }
  const sinXml = esperados.filter((n) => !xmls.includes(n));
  if (sinXml.length > 0) {
    throw new Error(`Esperado sin xml: ${sinXml.join(', ')}`);
  }

  const nombres = soloCasos?.length ? xmls.filter((n) => soloCasos.includes(n)) : xmls;
  if (soloCasos?.length) {
    const desconocidos = soloCasos.filter((n) => !xmls.includes(n));
    if (desconocidos.length > 0) {
      throw new Error(`Casos que no existen en el golden set: ${desconocidos.join(', ')}`);
    }
  }

  return nombres.map((nombre) => {
    const xmlPath = path.join(dir, `${nombre}.xml`);
    const esperado = JSON.parse(
      fs.readFileSync(path.join(dir, `${nombre}.esperado.json`), 'utf-8')
    ) as EsperadoGolden;
    validarEsperado(nombre, esperado);
    return { nombre, xmlPath, xml: fs.readFileSync(xmlPath, 'utf-8'), esperado };
  });
}

/**
 * El panel que hay que montar antes de correr el caso, como pares listos para
 * iterar: `[clave, valor]` con valor null = dejar la política SIN contestar.
 *
 * Vive aquí y no en el arnés a propósito: el corpus es quien sabe de qué panel
 * depende cada caso, y un arnés que lo dedujera por su cuenta volvería a
 * divergir del esperado — el defecto que este campo cierra.
 */
export function politicasRequeridas(caso: CasoGolden): Array<[string, string | null]> {
  return Object.entries(caso.esperado.precondicion?.politicas ?? {});
}
