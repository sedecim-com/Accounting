import * as fs from 'node:fs';
import * as path from 'node:path';

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

export interface EsperadoGolden {
  caso: string;
  resultado: ResultadoEsperado;
  tratamiento: 'PUE' | 'PPD' | null;
  sospecha: boolean;
  asiento: LineaEsperada[] | null;
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

function validarEsperado(nombre: string, e: EsperadoGolden): void {
  const falla = (msg: string): never => {
    throw new Error(`Golden «${nombre}»: ${msg}`);
  };
  if (e.caso !== nombre) falla(`el campo caso ("${e.caso}") no coincide con el archivo`);
  if (!RESULTADOS.has(e.resultado)) falla(`resultado inválido "${e.resultado}"`);
  if (e.tratamiento !== null && e.tratamiento !== 'PUE' && e.tratamiento !== 'PPD') {
    falla(`tratamiento inválido "${e.tratamiento}"`);
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
