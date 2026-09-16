// ============================================================
// UN SOLO LIMPIADOR DE COMENTARIOS PARA TODO EL ÁRBOL
//
// Vivía dentro de `src/plan/criterios.ts`, y ahí aprendió su lección a base de
// siete rojos falsos. El detector de código muerto (`src/ai/orphan-scan.ts`)
// tenía SU PROPIA copia, con las dos regex ingenuas que criterios.ts ya había
// desechado — y por eso acusaba de muerto a código vivo: un ejemplo de ayuda
// con el glob `./cfdi/julio/*.xml` abría un comentario de isBlock que no se
// cerraba hasta 171 líneas después, y todo lo que se llamaba ahí dentro
// desaparecía del análisis.
//
// Dos instrumentos que responden la misma pregunta con dos implementaciones es
// la forma exacta en que uno de los dos empieza a mentir sin que nada se ponga
// rojo. Aquí hay uno.
// ============================================================

/**
 * Memoria por CONTENIDO, no por ruta. Los 161 sitios de llamada releen los
 * mismos archivos una y otra vez, y el seam de mutación cambia el contenido sin
 * cambiar la ruta: cachear por ruta serviría el archivo sano a un mutante y el
 * espejo dejaría de morder. Con la clave en el propio source, un mutante es
 * simplemente otra entrada.
 */
const STRIPPED_CACHE = new Map<string, string>();

export function stripComments(source: string): string {
  // Recorrido con estado en vez de dos regex. Las regex se quedaron CIEGAS el
  // día que un ejemplo de ayuda citó un glob de shell: `./cfdi/julio/*.xml`
  // contiene `/*`, que abría un comentario de isBlock cerrado 94 499 bytes
  // después — el 80 % de mnemosine.ts desaparecía del criterio y `plan:status`
  // acusaba SIETE rojos falsos sobre familias que sí estaban en el binario. Un
  // instrumento que decide no puede cegarse con una cadena, así que las
  // cadenas se saltan en vez de mirarse.
  //
  // Se copia POR TRAMOS, no carácter a carácter: la primera versión de este
  // arreglo concatenaba de uno en uno y salía 8× más lenta, y con 161 sitios
  // de llamada eso llevó las pruebas de `main()` a agotar su presupuesto de
  // 30 s en CI. Correcto y lento sigue siendo un defecto cuando el instrumento
  // corre en cada empuje.
  //
  // Sirve para TypeScript y para SQL (`codigoDe` se usa sobre los dos): las
  // comillas simples que SQL duplica para escapar cierran y reabren, que deja
  // el mismo resultado. Las expresiones regulares de TS se tratan como
  // división —no se intenta desambiguar—, así que un `/*` dentro de un literal
  // de regex seguiría cegando; hoy no hay ninguno.
  const memo = STRIPPED_CACHE.get(source);
  if (memo !== undefined) return memo;

  const chunks: string[] = [];
  let i = 0;
  let copiedFrom = 0;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    // 0x2f '/'  0x2a '*'  0x2d '-'  0x27 "'"  0x22 '"'  0x60 '`'  0x5c '\\'
    if (c === 0x2f || c === 0x2d) {
      const d = source.charCodeAt(i + 1);
      const isBlock = c === 0x2f && d === 0x2a;
      const isLine = (c === 0x2f && d === 0x2f) || (c === 0x2d && d === 0x2d);
      if (isBlock || isLine) {
        chunks.push(source.slice(copiedFrom, i));
        const end = isBlock ? source.indexOf('*/', i + 2) : source.indexOf('\n', i);
        i = end === -1 ? source.length : isBlock ? end + 2 : end;
        copiedFrom = i;
        continue;
      }
    }
    if (c === 0x27 || c === 0x22 || c === 0x60) {
      // La cadena se CONSERVA: quitarla rompería los criterios que buscan un
      // literal («status = 'posted'»), que son casi todos. Sólo se salta, para
      // que un `/*` de su interior no abra un comentario.
      let j = i + 1;
      while (j < source.length && source.charCodeAt(j) !== c) {
        if (source.charCodeAt(j) === 0x5c) j++;
        j++;
      }
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  chunks.push(source.slice(copiedFrom));
  const stripped = chunks.join('');
  STRIPPED_CACHE.set(source, stripped);
  return stripped;
}
