// ============================================================
// LAS DOS EXPRESIONES DEL ARBOL QUE LEEN IMPORTES *YA FORMATEADOS*
//
// Son exactamente dos, y hasta I6 las dos daban por hecho que el separador de
// miles era la COMA — porque lo era: el formato de los importes estaba escrito
// a mano dentro de `src/cli/kernel/output.ts` y no habia otra forma posible.
// Con el formateador de I6 el separador lo pone la JURISDICCION de la entidad
// (regla 5 del epic #141), asi que dejo de ser una constante del sistema y las
// dos expresiones se volvieron falsas sin que nadie las tocara.
//
//   · `MONTO_RE` (src/ai/compaction.ts) — el backstop determinista que
//     reinyecta en el resumen los importes que el modelo se dejo. Lo que no ve,
//     no lo reinyecta, y la parte vieja de la conversacion ya se descarto: el
//     importe no vuelve.
//   · el inferidor de columnas numericas (src/cli/kernel/output.ts) — decide
//     que columna se alinea a la derecha. Lo que no ve, se alinea a la
//     izquierda, con los digitos sin apilar en la columna de saldos.
//
// Las dos formas que tienen que entender:
//
//   A · miles con coma, decimal con punto — es-MX, en-US: 1,234,567.89
//   B · miles con punto, decimal con coma — pt-BR, es-ES, de-DE: 1.234.567,89
//
// Se prueban EN EL MISMO ARCHIVO a proposito. Son una sola propiedad del
// sistema partida en dos modulos, y el dia que entre una tercera jurisdiccion
// con otra convencion hay que mover las dos: una prueba por archivo dejaria que
// alguien arreglara la mitad y se fuera en verde.
// ============================================================
import { describe, it, expect } from 'vitest';
import { extractIdentifiers } from '../../src/ai/compaction.js';
import { render } from '../../src/cli/kernel/output.js';

function sink() {
  const out: string[] = [];
  return {
    stdout: { write: (s: string) => { out.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true, isTTY: false } as unknown as NodeJS.WriteStream,
    get text() { return out.join(''); },
  };
}

/** La cabecera y la primera fila de la tabla, ya alineadas. */
function tableLines(rows: Record<string, unknown>[]): string[] {
  const s = sink();
  render(rows, { stdout: s.stdout, stderr: s.stderr });
  return s.text.split('\n');
}

describe('MONTO_RE entiende las dos formas', () => {
  it('A — miles con coma y decimal con punto, que es lo que ya entendia', () => {
    const source = 'factura por 19720.00 con IVA de $3,155.20 sobre subtotal 1,234.56';
    expect(extractIdentifiers(source)).toEqual(['19720.00', '3,155.20', '1,234.56']);
  });

  it('B — miles con punto y decimal con coma, que es la que se perdia entera', () => {
    const source = 'nota por 1.234.567,89 y retencion de 19.720,00';
    expect(extractIdentifiers(source)).toEqual(['1.234.567,89', '19.720,00']);
  });

  it('el mismo importe escrito de las dos formas se extrae de las dos', () => {
    expect(extractIdentifiers('1,234,567.89 y 1.234.567,89')).toEqual([
      '1,234,567.89',
      '1.234.567,89',
    ]);
  });

  it('un importe con codigo ISO delante conserva la cifra (el codigo no es parte del token)', () => {
    // Lo que produce `formatMoney` con su display por omision: «MXN» + espacio
    // DURO + la cifra. El extractor se queda con la cifra, que es lo que el
    // resumen no puede perder; el codigo lo sostiene la instruccion al modelo.
    expect(extractIdentifiers('total MXN 12,458,930.55 del ejercicio')).toEqual([
      '12,458,930.55',
    ]);
  });

  it('lo que la expresion sigue dejando fuera, que es tan importante como lo que ve', () => {
    // Las tasas y las versiones no son dinero: la forma B no puede abrirles la
    // puerta. Y `19720,00` —sin separador de miles que desambigue— se queda
    // fuera a proposito: se confunde con una lista de enteros separada por comas.
    expect(extractIdentifiers('tasa 16.00 % y 0.08 de IEPS, version 1.0.4')).toEqual([]);
    expect(extractIdentifiers('fecha europea 31.12.2026 en el acuse')).toEqual([]);
    expect(extractIdentifiers('cadena 123456.789')).toEqual([]);
    expect(extractIdentifiers('cantidades 1234,56,78 en el renglon')).toEqual([]);
  });
});

describe('el inferidor de columnas numericas entiende las dos formas', () => {
  // La columna se llama `note` a proposito: no es una columna de dinero por
  // nombre, asi que el renderizador NO la reformatea y el valor llega a la
  // inferencia tal como lo escribio quien armo la fila. Es el caso real de una
  // celda ya formateada rio arriba.
  const rightAligned = (values: string[]): boolean => {
    const lines = tableLines(values.map((note) => ({ note })));
    // Alineada a la derecha: la fila mas corta lleva relleno DELANTE.
    const shortest = lines.find((l) => l.trim() === values[values.length - 1]);
    return shortest !== undefined && shortest.startsWith(' ');
  };

  it('A — 1,234,567.89 junto a 1.00 alinea a la derecha, como siempre', () => {
    expect(rightAligned(['1,234,567.89', '1.00'])).toBe(true);
  });

  it('B — 1.234.567,89 junto a 1,00 tambien, y antes no lo hacia', () => {
    expect(rightAligned(['1.234.567,89', '1,00'])).toBe(true);
  });

  it('una columna de texto sigue alineada a la izquierda', () => {
    // El contraejemplo importa: una expresion demasiado laxa alinearia a la
    // derecha cualquier cosa y la prueba de arriba pasaria sin probar nada.
    expect(rightAligned(['2026-01-31', 'ab'])).toBe(false);
  });
});
