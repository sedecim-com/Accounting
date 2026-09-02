// ============================================================
// LOS BYTES ANTES DEL TEXTO
//
// La codificación no es un detalle de presentación en un extracto mexicano: es
// la diferencia entre «DEPÓSITO» y «DEP�SITO», y esa segunda forma se propaga
// hasta `content_hash`. El hash de la 051 se calcula sobre la descripción, así
// que leer el MISMO archivo con dos codificaciones distintas produce DOS
// líneas donde había una, y el dedupe estructural deja de deduplicar sin que
// nada se queje.
//
// Node trae 'latin1' y 'utf16le' en Buffer.toString, así que esto no necesita
// ninguna dependencia; lo que necesita es decidir cuál usar y CONFESAR la
// decisión cuando fue una adivinanza.
// ============================================================

export type Codificacion = 'utf8' | 'latin1' | 'auto';

export interface TextoDecodificado {
  texto: string;
  /** La que se usó de verdad, que no siempre es la que se pidió. */
  codificacion: 'utf8' | 'latin1' | 'utf16le';
  avisos: string[];
}

/** U+FFFD: lo que Node escribe donde había un byte que UTF-8 no explica. */
const REEMPLAZO = '�';

export function decodificar(
  entrada: string | Buffer,
  preferida: Codificacion = 'auto'
): TextoDecodificado {
  // Un string ya pasó por el decodificador de alguien más; aquí sólo se le
  // quita la marca de orden de bytes, que sobrevive a la decodificación y
  // ensucia el primer encabezado del CSV.
  if (typeof entrada === 'string') {
    return { texto: quitarBom(entrada), codificacion: 'utf8', avisos: [] };
  }

  const avisos: string[] = [];

  // El BOM manda sobre cualquier preferencia: es el archivo declarando su
  // propia codificación, y contradecirlo garantiza basura.
  if (entrada.length >= 3 && entrada[0] === 0xef && entrada[1] === 0xbb && entrada[2] === 0xbf) {
    return { texto: entrada.subarray(3).toString('utf8'), codificacion: 'utf8', avisos };
  }
  if (entrada.length >= 2 && entrada[0] === 0xff && entrada[1] === 0xfe) {
    avisos.push('El archivo venía en UTF-16 LE (por su BOM).');
    return { texto: entrada.subarray(2).toString('utf16le'), codificacion: 'utf16le', avisos };
  }
  if (entrada.length >= 2 && entrada[0] === 0xfe && entrada[1] === 0xff) {
    // Node no tiene 'utf16be'. Voltear los pares y usar el decodificador LE es
    // exacto y cabe en tres líneas; la alternativa era rechazar el archivo.
    const volteado = Buffer.from(entrada.subarray(2));
    volteado.swap16();
    avisos.push('El archivo venía en UTF-16 BE (por su BOM); se convirtió a LE para leerlo.');
    return { texto: volteado.toString('utf16le'), codificacion: 'utf16le', avisos };
  }

  if (preferida === 'latin1') {
    return { texto: entrada.toString('latin1'), codificacion: 'latin1', avisos };
  }

  const comoUtf8 = entrada.toString('utf8');
  const rota = comoUtf8.includes(REEMPLAZO);

  if (preferida === 'utf8') {
    if (rota) {
      avisos.push(
        'Se leyó como UTF-8 porque el perfil lo exige, pero el archivo tiene bytes que UTF-8 ' +
          'no explica: hay caracteres perdidos. Revisa la codificación del perfil.'
      );
    }
    return { texto: comoUtf8, codificacion: 'utf8', avisos };
  }

  // `auto`. El carácter de reemplazo es evidencia dura de que estos bytes no
  // son UTF-8; latin1 nunca falla al decodificar, así que la única forma de
  // elegirlo con criterio es descartar UTF-8 primero.
  if (!rota) return { texto: comoUtf8, codificacion: 'utf8', avisos };

  avisos.push(
    'El archivo no es UTF-8 válido; se leyó como Latin-1 (ISO-8859-1). ' +
      'Si el banco exporta en otra codificación, fíjala en el perfil.'
  );
  return { texto: entrada.toString('latin1'), codificacion: 'latin1', avisos };
}

export function quitarBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/**
 * La forma canónica de un encabezado, para comparar «DESCRIPCIÓN», «Descripcion»
 * y «  descripción  » como la misma columna.
 *
 * Quita acentos por descomposición (NFD) en vez de con una tabla de
 * reemplazos: un exportador puede escribir «Ó» como U+00D3 o como O + U+0301
 * y las dos formas se ven idénticas en pantalla.
 */
export function normalizarEncabezado(texto: string): string {
  return quitarBom(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Corta en líneas físicas aceptando CRLF, LF y el CR suelto de exportadores viejos. */
export function enLineas(texto: string): string[] {
  return texto.split(/\r\n|\n|\r/);
}
