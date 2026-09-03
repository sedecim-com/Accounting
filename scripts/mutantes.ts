import { palette } from '../src/cli/palette.js';
import {
  CRITERIOS,
  conFuenteMutada,
  crudoDe,
  tieneEspejo,
  type Criterio,
  type Mutante,
  type Resultado,
} from '../src/plan/criterios.js';

// ============================================================
// npm run mutantes
//
// EL ARNÉS DE MUTACIÓN, CON PUERTA PROPIA.
//
// Cada criterio del tablero puede declarar `mutantes`: el cambio de fuente que
// ese criterio EXISTE para acusar. El arnés los aplica sobre el seam de lectura
// —un overlay en memoria; el árbol real no se toca jamás— y exige que el
// criterio pase a rojo. Un mutante que SOBREVIVE es un criterio que mide su
// propio texto: sigue en verde con la conducta que vigila neutralizada.
//
// Hasta S4a esto sólo existía dentro de la suite unitaria. Corría en cada CI, y
// eso está bien, pero no había forma de preguntárselo: quien quería saber si el
// tablero muerde tenía que correr 3 500 pruebas y leer nombres de casos. Aquí
// la pregunta tiene comando, y la respuesta tiene las tres cifras que un humano
// necesita —cuántos mutantes, cuántos mueren, y cuál no murió y por qué importa.
//
// POR QUÉ ESTE BUCLE NO ES EL DE tests/plan/mutacion.spec.ts, dicho para que
// nadie lo «arregle»: la puerta de CI sigue siendo esa prueba, y su bucle se
// deja intacto a propósito. El criterio E0.0 «los criterios tienen espejo
// ejecutable» ancla en su texto literal —`conFuenteMutada(overlay, () =>
// criterio.evaluar())` y `.toBe('falla')`—, así que reescribirla para compartir
// código con este script pondría en rojo el criterio que vigila al arnés. Lo
// que las dos comparten es lo que importa: el seam y la regla («rojo o no
// cuenta»). Este comando informa; aquella prueba cierra la puerta.
//
//   npm run mutantes              → informa y sale 1 si algún mutante vive
//   npm run mutantes -- --detalle → lista además los criterios sin espejo
// ============================================================

export type Suerte = 'muerto' | 'vivo' | 'mudo' | 'reventó' | 'ancla-rota';

export interface Caso {
  criterio: Criterio;
  mutante: Mutante;
  suerte: Suerte;
  /** Lo que el criterio dijo bajo la mutación. Es lo que hace falta para actuar. */
  dijo: string;
}

/**
 * Qué significa cada suerte, en una línea, para quien lee la salida sin haber
 * escrito el arnés. Los cuatro que no son «muerto» son fallos distintos y se
 * arreglan distinto: por eso no se colapsan en «no pasó».
 */
const PORQUE: Record<Exclude<Suerte, 'muerto'>, string> = {
  vivo: 'el criterio siguió en VERDE con la conducta neutralizada: mide texto que el mutante no toca',
  mudo: 'el criterio se declaró no evaluable en vez de rojo: un hueco no acusa la regresión',
  reventó: 'el criterio lanzó una excepción: no distingue «está mal» de «no pude mirar»',
  'ancla-rota': 'el texto que el espejo muta ya no existe: el código cambió y el espejo no',
};

/** Aplica UN mutante y juzga. Nunca escribe: el overlay vive en memoria. */
export async function correr(criterio: Criterio, mutante: Mutante): Promise<Caso> {
  const original = crudoDe(mutante.archivo);
  let overlay: Record<string, string | null>;

  if (mutante.a === null) {
    // El modo «el archivo desapareció»: hay criterios cuyo fallo no es que un
    // texto cambie sino que un registro o una migración se borre.
    overlay = { [mutante.archivo]: null };
  } else {
    if (!original.includes(mutante.de)) {
      return { criterio, mutante, suerte: 'ancla-rota', dijo: 'no se pudo mutar nada' };
    }
    overlay = { [mutante.archivo]: original.replace(mutante.de, mutante.a) };
  }

  let resultado: Resultado;
  try {
    resultado = await conFuenteMutada(overlay, () => criterio.evaluar());
  } catch (err) {
    return { criterio, mutante, suerte: 'reventó', dijo: (err as Error).message };
  }

  const suerte: Suerte =
    resultado.estado === 'falla' ? 'muerto' : resultado.estado === 'ok' ? 'vivo' : 'mudo';
  return { criterio, mutante, suerte, dijo: resultado.detalle };
}

export async function correrTodos(criterios: Criterio[] = CRITERIOS): Promise<Caso[]> {
  const casos: Caso[] = [];
  for (const criterio of criterios) {
    for (const mutante of criterio.mutantes ?? []) {
      casos.push(await correr(criterio, mutante));
    }
  }
  return casos;
}

export function formatear(
  casos: Caso[],
  criterios: Criterio[],
  stream: NodeJS.WriteStream,
  detalle: boolean
): { lineas: string[]; codigo: number } {
  const p = palette(stream);
  const lineas: string[] = [];

  // `tieneEspejo` y no `c.mutantes`: un criterio puede traer su mordida en
  // `mutantesEnDisco` —el arnés de conducta, que muta el archivo real porque
  // lo que corre no es lo que el criterio lee—. Contar sólo un campo diría
  // «sin espejo» de criterios que sí muerden, y una cifra que se equivoca por
  // DÓNDE está escrito el espejo mide la forma en vez del hecho.
  const conEspejo = criterios.filter((c) => tieneEspejo(c));
  const sinEspejo = criterios.filter((c) => !tieneEspejo(c));
  // Lo que ESTE comando no aplica, dicho en su propia salida: los espejos en
  // disco necesitan base y corren en la suite de integración, no aquí.
  const conEspejoEnDisco = criterios.filter((c) => (c.mutantesEnDisco?.length ?? 0) > 0);
  const muertos = casos.filter((c) => c.suerte === 'muerto');
  const sobrevivientes = casos.filter((c) => c.suerte !== 'muerto');

  lineas.push(p.bold('Espejos del tablero, aplicados de verdad'));
  lineas.push('');
  lineas.push(
    `  ${criterios.length} criterios · ${conEspejo.length} con espejo · ` +
      `${sinEspejo.length} sin espejo (deuda declarada: la línea base sólo encoge)`
  );
  lineas.push(
    `  ${casos.length} mutantes aplicados sobre el seam de lectura; el árbol real no se tocó`
  );
  if (conEspejoEnDisco.length > 0) {
    lineas.push(
      p.dim(
        `  (${conEspejoEnDisco.length} criterio(s) llevan además espejo EN DISCO: necesitan base y los aplica la suite de integración, no este comando)`
      )
    );
  }
  lineas.push('');
  lineas.push(
    `  ${p.green('✔')} ${muertos.length} murieron ` +
      p.dim('(el criterio pasó a rojo con su conducta neutralizada)')
  );

  if (sobrevivientes.length === 0) {
    lineas.push('');
    lineas.push(
      p.dim(
        'Todo mutante declarado muere. Lo que esto NO dice: los ' +
          `${sinEspejo.length} criterios sin espejo no se midieron aquí — nadie sabe si muerden.`
      )
    );
  } else {
    lineas.push(`  ${p.red('✘')} ${sobrevivientes.length} sobrevivieron:`);
    lineas.push('');
    for (const c of sobrevivientes) {
      lineas.push(
        `  ${p.red('✘')} ${p.bold(c.criterio.paquete)} «${c.criterio.enunciado}»  ${p.dim(`[${c.suerte}]`)}`
      );
      lineas.push(
        `      ${c.mutante.archivo}: ${p.dim(`«${recorta(c.mutante.de)}» → «${recorta(String(c.mutante.a))}»`)}`
      );
      lineas.push(`      el mutante encarna: ${c.mutante.porque}`);
      lineas.push(`      el criterio dijo:   ${c.dijo}`);
      lineas.push(`      ${p.yellow('por qué importa:')}    ${PORQUE[c.suerte as Exclude<Suerte, 'muerto'>]}`);
      lineas.push('');
    }
  }

  if (detalle && sinEspejo.length > 0) {
    lineas.push('');
    lineas.push(p.bold('Criterios sin espejo — no se midieron, y por eso siguen siendo deuda'));
    for (const c of sinEspejo) {
      lineas.push(`  ${p.dim('·')} ${c.paquete} · ${c.enunciado}`);
    }
  }

  return { lineas, codigo: sobrevivientes.length > 0 ? 1 : 0 };
}

/** Un mutante puede ser una línea entera; en la salida sólo cabe su forma. */
const recorta = (s: string): string => {
  const plano = s.replace(/\n/g, '⏎');
  return plano.length > 70 ? `${plano.slice(0, 67)}…` : plano;
};

async function main(argv: string[]): Promise<number> {
  const casos = await correrTodos();
  const { lineas, codigo } = formatear(casos, CRITERIOS, process.stdout, argv.includes('--detalle'));
  process.stdout.write(`${lineas.join('\n')}\n`);
  return codigo;
}

if (require.main === module) {
  // Sin process.exit(): el proceso termina solo y el código sale entero. Un
  // exit() aquí truncaría la escritura cuando la salida se redirige a archivo.
  void main(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
