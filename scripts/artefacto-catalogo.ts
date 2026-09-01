/**
 * Compone el artefacto navegable del catálogo, inyectando los datos.
 *
 *   npx tsx scripts/artefacto-catalogo.ts [destino.html]
 *
 * POR QUÉ EXISTE
 *
 * El artefacto anterior llevaba los 1623 comandos COPIADOS dentro de su HTML.
 * Llegó a tener 20 citas a un archivo ya borrado, 1622 filas en vez de 1623, y
 * ninguna noción de qué comandos se pueden teclear. Era el tercer espejo del
 * repositorio mantenido a mano, después de la tabla de estado del plan y de la
 * portada del propio catálogo — y se rompió igual que los otros dos.
 *
 * Aquí la plantilla lleva el argumento y el diseño; los datos salen de
 * `filasCompletas()`, la misma función que la CI verifica. Regenerar es un
 * comando, y el desfase deja de ser posible.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { filasCompletas } from './catalogo-estado.js';

const RAIZ = path.resolve(__dirname, '..');
const CATALOGO = path.join(RAIZ, 'docs', 'cli-command-catalog.md');
const PLANTILLA = path.join(__dirname, 'artefacto', 'plantilla.html');
const MARCA = '__DATOS__';

/**
 * Lo que la página necesita, y nada más.
 *
 * Las claves van de una letra y se recorta `queHace` a 150 caracteres a
 * propósito: con las celdas completas de `backend` y `flags` el archivo pasaba
 * de 900 KB, y ninguna de las dos se muestra. La prosa larga vive en el
 * documento; el artefacto es para recorrer, no para citar.
 */
export interface FilaLigera {
  c: string; e: string; q: string; s: string;
  f: string; r: string; a: string; v: 0 | 1; m: string;
}

export function aligerar(md: string): FilaLigera[] {
  return filasCompletas(md).map((x) => ({
    c: x.invocacion,
    e: x.es,
    q: x.queHace.slice(0, 150),
    s: x.estado,
    f: x.fase,
    r: x.riesgo.slice(0, 12),
    a: x.ia,
    v: x.viva ? 1 : 0,
    m: x.familia,
  }));
}

export function componer(plantilla: string, filas: FilaLigera[]): string {
  if (!plantilla.includes(MARCA)) {
    throw new Error(`La plantilla no tiene el marcador ${MARCA}`);
  }
  // `</script` dentro de una cadena JSON cerraría la etiqueta que la contiene y
  // el resto de la página se pintaría como texto. Es la forma clásica de romper
  // un HTML con datos embebidos, y aquí hay 1623 celdas de prosa ajena.
  const json = JSON.stringify(filas).replace(/<\//g, '<\\/');
  return plantilla.replace(MARCA, json);
}

function main(argv: string[]): number {
  const destino = argv[0] ?? path.join(RAIZ, 'artefacto-catalogo.html');
  const md = fs.readFileSync(CATALOGO, 'utf-8');
  const filas = aligerar(md);
  const html = componer(fs.readFileSync(PLANTILLA, 'utf-8'), filas);
  fs.writeFileSync(destino, html);

  const vivas = filas.filter((f) => f.v === 1).length;
  const fase1 = filas.filter((f) => f.f === '1').length;
  process.stdout.write(
    `${destino}\n` +
      `  ${filas.length} filas · ${vivas} invocables · ${fase1} de fase 1 · ` +
      `${(html.length / 1024).toFixed(0)} KB\n`
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
