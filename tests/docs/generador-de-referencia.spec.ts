import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import {
  ayudaCompleta,
  conAnchoFijo,
  construirReferencia,
  nodos,
} from '../../scripts/generate-cli-reference.js';

// ============================================================
// EL DOCUMENTO QUE EL AGENTE LEE COMO «EL BINARIO EXACTO».
//
// scripts/generate-cli-reference.ts produce src/ai/docs/cli-reference.md, que
// se publica al agente bajo la orden «never invent a flag that is not listed
// here»: lo que no está ahí, para él no existe.
//
// Durante todo un lote el generador emitió `cmd.helpInformation()` y su
// cabecera prometía «byte-identical to what --help prints». Era falso.
// `addHelpText` no guarda texto: registra un oyente de los eventos
// beforeAllHelp/beforeHelp/afterHelp/afterAllHelp, y sólo `outputHelp` los
// emite — `helpInformation()` no emite ninguno. Resultado medido contra el
// binario, invocándolo 237 veces: coincidía en 121 de 236 nodos, y en los
// otros 115 se comía el bloque `Examples:` entero — 244 invocaciones que el
// binario SÍ imprime y el agente no veía.
//
// Por eso estas pruebas no miran el formato del documento: comparan contra la
// salida REAL del binario. Si alguien vuelve a `helpInformation()`, mueren.
// ============================================================

const RAIZ = path.join(__dirname, '..', '..');
const CLI = path.join(RAIZ, 'src', 'cli', 'mnemosine.ts');
const ARBOL = nodos(program);

/** La ayuda que imprime el binario de verdad. Con la salida en tubería, o sea a 80 columnas. */
function ayudaDelBinario(ruta: string[]): string {
  return execFileSync('npx', ['tsx', CLI, ...ruta, '--help'], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function ruta(cmd: Command): string[] {
  const r: string[] = [];
  for (let n: Command | null = cmd; n && n.parent; n = n.parent) r.unshift(n.name());
  return r;
}

function buscar(camino: string): Command {
  const encontrado = ARBOL.find((c) => ruta(c).join(' ') === camino);
  if (!encontrado) throw new Error(`no existe el nodo "${camino}"`);
  return encontrado;
}

describe('el generador de cli-reference emite la ayuda REAL', () => {
  it('el árbol se lee entero: si no, lo de abajo no prueba nada', () => {
    expect(ARBOL.length).toBeGreaterThan(200);
    expect(ARBOL.map((c) => ruta(c).join(' '))).toContain('bill create');
  });

  // EL MUTANTE: volver a `cmd.helpInformation()` en section()/construirReferencia.
  // Con él este número cae a 0 y la prueba muere.
  it('el documento trae los bloques Examples: que hoy se perdían', () => {
    const doc = construirReferencia(program);
    const bloques = doc.split('\n').filter((l) => l.includes('Examples:')).length;
    expect(
      bloques,
      'El documento perdió los bloques Examples:. Casi seguro alguien volvió a ' +
        'helpInformation(), que no emite el evento afterHelp donde vive addHelpText.'
    ).toBeGreaterThanOrEqual(100);

    const invocaciones = doc.split('\n').filter((l) => l.trim().startsWith('mnemosine ')).length;
    expect(invocaciones).toBeGreaterThanOrEqual(200);
  });

  it('ningún nodo entra al documento con la ayuda recortada', () => {
    const doc = construirReferencia(program);
    const recortados = conAnchoFijo(ARBOL, 80, () =>
      ARBOL.filter((c) => !doc.includes(ayudaCompleta(c).trimEnd())).map((c) =>
        ruta(c).join(' ')
      )
    );
    expect(recortados).toEqual([]);
  });

  it('helpInformation() NO basta: hay más de cien nodos con texto añadido', () => {
    // El guardia del mutante. Si esto diera 0, la prueba de arriba pasaría
    // sola con un generador roto, porque no habría nada que perder.
    const conTextoAnadido = conAnchoFijo(ARBOL, 80, () =>
      ARBOL.filter((c) => c.helpInformation() !== ayudaCompleta(c))
    );
    expect(conTextoAnadido.length).toBeGreaterThanOrEqual(100);
  });

  // Nota para quien vea un rojo raro: esta prueba compara el `program` que se
  // importó en memoria contra un binario que se LANZA ahora y relee el código
  // del disco. Si alguien guarda un src/cli/*.ts mientras corre, las dos
  // fotos son de instantes distintos y da un falso rojo. En un árbol quieto
  // (CI) es determinista; se comprobó lanzando el binario 237 veces.
  it(
    'byte a byte contra el binario, en un nodo con ejemplos y otro sin ellos',
    () => {
      const doc = construirReferencia(program);
      for (const camino of ['bill create', 'report trial-balance']) {
        const real = ayudaDelBinario(camino.split(' '));
        const nuestra = conAnchoFijo(ARBOL, 80, () => ayudaCompleta(buscar(camino)));
        expect(nuestra, `"${camino}" no coincide con lo que imprime el binario`).toBe(real);
        expect(doc, `"${camino}" no entra completo en el documento`).toContain(real.trimEnd());
      }
    },
    180_000
  );

  it('un pie puesto en la raíz llega a las hojas, como en el binario', () => {
    // Hoy nadie registra beforeAll/afterAll —las 114 llamadas de src/ son
    // 'after'—, así que sin esta prueba omitir los eventos de los ancestros
    // no rompería nada y el generador volvería a desviarse en silencio. El
    // día que la raíz cuelgue un pie de página, `--help` lo imprime en las
    // 237 pantallas y el documento tiene que imprimirlo también.
    const PIE = '~~pie-de-la-raiz-para-la-prueba~~';
    const hoja = buscar('bill create');
    const raiz = program as unknown as {
      on(e: string, f: (c: { write: (s: string) => void }) => void): unknown;
      removeListener(e: string, f: (c: { write: (s: string) => void }) => void): unknown;
    };
    const oyente = (c: { write: (s: string) => void }): void => c.write(`${PIE}\n`);
    raiz.on('afterAllHelp', oyente);
    try {
      const conPie = conAnchoFijo(ARBOL, 80, () => ayudaCompleta(hoja));
      expect(conPie).toContain(PIE);
      expect(conPie.trimEnd().endsWith(PIE)).toBe(true);
      expect(conAnchoFijo(ARBOL, 80, () => hoja.helpInformation())).not.toContain(PIE);
    } finally {
      raiz.removeListener('afterAllHelp', oyente);
    }
    // Y no queda nada colgando para las demás pruebas.
    expect(conAnchoFijo(ARBOL, 80, () => ayudaCompleta(hoja))).not.toContain(PIE);
  });

  it('fijar el ancho no desengancha la salida de la raíz de sus hojas', () => {
    // conAnchoFijo NO puede usar configureOutput({…}) para poner el ancho:
    // ese método REEMPLAZA el objeto de configuración, y los hijos creados con
    // .command() lo comparten por referencia con el padre. Al reemplazarlo se
    // quedarían con el viejo, y un program.configureOutput({ writeOut }) en la
    // raíz dejaría de llegar a las hojas — de lo que vive
    // tests/cli/ejemplos-de-ayuda.spec.ts para capturar lo que imprimen.
    const antes = ARBOL.map((c) => c.configureOutput());
    conAnchoFijo(ARBOL, 80, () => construirReferencia(program));
    const despues = ARBOL.map((c) => c.configureOutput());
    const desenganchados = ARBOL.filter((_, i) => antes[i] !== despues[i]).map((c) =>
      ruta(c).join(' ')
    );
    expect(desenganchados).toEqual([]);

    // Y el ancho quedó como estaba: sin terminal, commander cae a 80 solo.
    const objetosDistintos = antes.filter((cfg, i) => antes.indexOf(cfg) === i).length;
    // Hoy es 1 para 237 nodos: `.command()` asigna el objeto del padre POR
    // REFERENCIA (copyInheritedSettings, command.js:101). Sin sharing que
    // perder, la comprobación de arriba no probaría nada.
    expect(objetosDistintos).toBeLessThan(ARBOL.length);
    expect(program.configureOutput().getOutHelpWidth?.()).toBe(
      process.stdout.isTTY ? process.stdout.columns : undefined
    );
  });

  it('construirReferencia fija el ancho en TODO el árbol, no sólo en la raíz', () => {
    // EL MUTANTE: `conAnchoFijo([raiz], …)` en vez de `conAnchoFijo(nodos(raiz), …)`.
    //
    // Contra el árbol REAL ese mutante SOBREVIVE, y hay que decir por qué en
    // vez de fingir que no: src/cli no tiene ni una llamada a `.addCommand()`
    // (medido: 0 en todo src/), todo se arma con `.command()`, y `.command()`
    // asigna el `_outputConfiguration` del padre POR REFERENCIA
    // (copyInheritedSettings, command.js:101). Medido: los 237 nodos comparten
    // UN objeto, así que tocar la raíz los toca a todos — por accidente.
    //
    // `.addCommand()` no copia esa configuración (command.js:addCommand no
    // llama a copyInheritedSettings). La primera familia que se enganche así
    // traerá la suya, y un generador que fijara sólo la raíz dejaría su ayuda
    // al ancho de la terminal de quien corre el guion, en silencio y sin que
    // ninguna prueba lo viera. Este árbol de juguete es ese futuro,
    // disponible hoy: aquí el mutante muere.
    // Con palabras y no con una tira de letras: commander sólo parte en
    // espacios (Help.wrap), y una palabra de 180 caracteres saldría igual a
    // 80 que a 200 — la prueba pasaría sola sin medir nada.
    const PALABRAS = 'palabra '.repeat(30).trim();
    const raiz = new Command('juguete');
    const rama = new Command('rama').description(PALABRAS);
    rama.option('--bandera <valor>', PALABRAS);
    raiz.addCommand(rama);

    // El supuesto de todo lo anterior, medido aquí y no dado por bueno.
    expect(rama.configureOutput()).not.toBe(raiz.configureOutput());

    const normal = construirReferencia(raiz);
    const desdeOtraTerminal = conAnchoFijo(nodos(raiz), 200, () => construirReferencia(raiz));
    expect(
      desdeOtraTerminal,
      'Una familia enganchada con addCommand se quedó con el ancho de la terminal ' +
        'de quien generó: casi seguro alguien fijó el ancho sólo en la raíz.'
    ).toBe(normal);

    // Y el juguete envuelve de verdad a 80: si no, lo de arriba pasaría solo
    // con cualquier generador. (El encabezado de la raíz dice «mnemosine»
    // porque `construirReferencia` lo trae fijo; aquí sólo importa el ancho.)
    const lineaMasLarga = Math.max(...normal.split('\n').map((l) => l.length));
    expect(lineaMasLarga).toBeLessThanOrEqual(80);
  });

  it('el documento no depende del ancho de la terminal de quien lo genera', () => {
    const normal = construirReferencia(program);
    // Como si se generara desde una terminal de 200 columnas.
    const desdeOtraTerminal = conAnchoFijo(ARBOL, 200, () => construirReferencia(program));
    expect(desdeOtraTerminal).toBe(normal);
  });

  it('y el ancho SÍ cambia la ayuda: por eso hay que fijarlo', () => {
    // Guardia del mutante anterior: sin esto, quitar conAnchoFijo pasaría
    // inadvertido si commander resultara insensible al ancho.
    const a80 = conAnchoFijo(ARBOL, 80, () => ARBOL.map((c) => c.helpInformation()).join(''));
    const a200 = conAnchoFijo(ARBOL, 200, () => ARBOL.map((c) => c.helpInformation()).join(''));
    expect(a200).not.toBe(a80);
  });
});
