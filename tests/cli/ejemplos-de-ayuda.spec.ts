import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Command, OutputConfiguration } from 'commander';
import { program } from '../../src/cli/mnemosine.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { catalogoBasePara } from '../../src/services/accounting/chart-seed.js';
import { parseLineSpec, resolveLineTaxAmount } from '../../src/cli/bill-command.js';
import { parseInvoiceLine } from '../../src/cli/invoice-command.js';

// ============================================================
// LOS EJEMPLOS DE LA AYUDA TIENEN QUE PODER TECLEARSE
//
// `grep -rn addHelpText src/` devolvía UNA aparición sobre 179 nodos de
// ayuda. `entry create --help` enumeraba doce banderas y ni una póliza
// escrita: quien lo leía salía sin saber si <account> es el código, el nombre
// o un uuid, ni si el importe lleva coma de millares.
//
// Poner ejemplos arregla eso UNA vez. Lo que los mantiene ciertos es esta
// prueba, y su mitad importante no es «¿hay ejemplos?» —eso se ve a ojo— sino
// «¿el ejemplo se puede ejecutar?». Un ejemplo con una bandera que no existe
// es peor que ninguno: manda al usuario a un error de Commander citando la
// documentación del propio programa.
//
// Por eso aquí no hay ninguna lista escrita a mano de hojas ni de banderas.
// Todo se DERIVA del `program` que se embarca:
//
//   · las banderas legítimas de una hoja son las suyas más las de sus
//     ancestros (Commander las fusiona en optsWithGlobals);
//   · qué hojas DEBEN llevar ejemplos sale del registro de riesgo: si una
//     familia documenta una de sus hojas que mutan, las documenta todas —una
//     familia a medias enseña al usuario a esperar ejemplos y luego se los
//     niega justo en el comando que mueve el mayor;
//   · las cuentas que un ejemplo puede citar salen del catálogo base real
//     (chart-seed.ts), más las que otro ejemplo crea con `account create`.
// ============================================================

interface Hoja {
  ruta: string;
  cmd: Command;
}

/** Toda hoja del árbol embarcado, con su ruta como la teclea una persona. */
function hojas(cmd: Command, prefijo: string[] = []): Hoja[] {
  const hijos = cmd.commands as Command[];
  if (hijos.length === 0) {
    return prefijo.length > 0 ? [{ ruta: prefijo.join(' '), cmd }] : [];
  }
  return hijos.flatMap((h) => hojas(h, [...prefijo, h.name()]));
}

/**
 * El texto que `addHelpText('after', …)` imprimiría.
 *
 * Commander no lo guarda: lo registra como un oyente del evento `afterHelp`
 * que escribe en el `context.write` que le pasan (command.js:2670). Emitir el
 * evento con un `write` propio es la única forma de leerlo sin renderizar la
 * ayuda entera, y no depende de ningún campo privado.
 */
function textoPosterior(cmd: Command): string {
  const trozos: string[] = [];
  // `Command` extiende EventEmitter en tiempo de ejecución, pero sus tipos no
  // publican `emit`: el molde nombra exactamente el contrato que se usa
  // (HelpTextEventContext) y no abre la puerta a `any`.
  const emisor = cmd as unknown as {
    emit(evento: string, contexto: { error: boolean; command: Command; write: (s: string) => void }): boolean;
  };
  emisor.emit('afterHelp', {
    error: false,
    command: cmd,
    write: (s: string) => { trozos.push(s); },
  });
  return trozos.join('');
}

/** Las invocaciones de un bloque de ayuda: las líneas que empiezan por `mnemosine`. */
function ejemplosDe(cmd: Command): string[] {
  return textoPosterior(cmd)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('mnemosine '));
}

/** Trocea como lo haría un shell: respeta comillas simples y dobles. */
export function tokenizar(linea: string): string[] {
  const tokens: string[] = [];
  let actual = '';
  let comilla: '"' | "'" | null = null;
  let abierto = false;
  for (const ch of linea) {
    if (comilla) {
      if (ch === comilla) comilla = null;
      else actual += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      comilla = ch;
      abierto = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (actual !== '' || abierto) tokens.push(actual);
      actual = '';
      abierto = false;
      continue;
    }
    actual += ch;
  }
  if (actual !== '' || abierto) tokens.push(actual);
  return tokens;
}

/** Banderas que Commander atiende sin que nadie las declare. */
const INTEGRADAS = new Set(['-h', '--help', '-V', '--version']);

/** Toda bandera que esta hoja acepta: las suyas y las de sus ancestros. */
function banderasDe(cmd: Command): Set<string> {
  const fuera = new Set<string>(INTEGRADAS);
  for (let nodo: Command | null = cmd; nodo; nodo = nodo.parent) {
    for (const o of nodo.options) {
      if (o.short) fuera.add(o.short);
      if (o.long) fuera.add(o.long);
    }
  }
  return fuera;
}

/** La hoja que un ejemplo invoca, resolviendo nombres y alias como Commander. */
function resolver(tokens: string[]): { cmd: Command; posicionales: string[] } | null {
  if (tokens[0] !== 'mnemosine') return null;
  let nodo: Command = program;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('-')) break;
    const hijo = (nodo.commands as Command[]).find(
      (c) => c.name() === t || c.aliases().includes(t)
    );
    if (!hijo) break;
    nodo = hijo;
    i += 1;
  }
  return { cmd: nodo, posicionales: tokens.slice(i) };
}

const TODAS = hojas(program);
const CON_EJEMPLOS = TODAS.map((h) => ({ ...h, ejemplos: ejemplosDe(h.cmd) })).filter(
  (h) => h.ejemplos.length > 0
);

/** Riesgos que escriben algo en algún sitio. `lectura` no muta nada. */
const MUTANTES = new Set(['escritura', 'irreversible', 'externo']);

/**
 * SUELO, no objetivo. Sube en el mismo commit que gana el terreno, igual que
 * docs/catalogo-minimos.json. Existe porque las dos reglas de abajo son
 * vacuamente ciertas sobre cero ejemplos: sin este número, borrar todos los
 * bloques dejaría la suite en verde.
 *
 * ESTUVO EN 97 SOBRE UN ÁRBOL QUE MEDÍA 115, y esos dieciocho de holgura eran
 * un permiso: comentar las quince llamadas `addHelpText` de account-command.ts
 * —una familia documentada ENTERA— dejaba 100, y 100 ≥ 97 pasaba en verde. La
 * regla de «familia a medias» tampoco la atrapaba: en cuanto la familia baja a
 * CERO deja de estar en `familiasDocumentadas` y sale del cálculo. Un suelo con
 * holgura no es un suelo, es una hoja de permiso por el hueco que deja.
 *
 * Puesto en el valor MEDIDO hoy, cualquier borrado —una familia, una hoja, un
 * bloque— baja el número y muere aquí.
 */
const SUELO_HOJAS_CON_EJEMPLOS = 115;

/**
 * Y el mismo trinquete para el árbol: `toBeGreaterThan(80)` sobre 179 hojas era
 * la misma holgura, en el sitio donde más duele, porque TODO lo de abajo
 * itera sobre `TODAS`. Un árbol que se lee a medias hace pasar en verde las
 * cinco pruebas que siguen sobre las hojas que sí se leyeron.
 */
const SUELO_HOJAS = 179;

describe('la ayuda enseña invocaciones que se pueden teclear', () => {
  it('el árbol embarcado se lee entero: si no, nada de lo de abajo prueba nada', () => {
    expect(
      TODAS.length,
      'El árbol embarcado encogió. O alguien borró comandos —y entonces esto se sube ' +
        'con su porqué en el commit— o el recorrido dejó de ver una rama, y entonces las ' +
        'pruebas de abajo están pasando sobre las hojas que quedan.'
    ).toBeGreaterThanOrEqual(SUELO_HOJAS);
    expect(TODAS.map((h) => h.ruta)).toContain('entry create');
  });

  it('hay ejemplos, y su número sólo sube', () => {
    expect(
      CON_EJEMPLOS.length,
      'Este suelo se mueve hacia arriba en el mismo commit que documenta más hojas. ' +
        'Si bajó, alguien borró ejemplos que ya estaban ganados.'
    ).toBeGreaterThanOrEqual(SUELO_HOJAS_CON_EJEMPLOS);
  });

  // ── La mitad que atrapa al siguiente ejemplo podrido ────────────────
  it('toda bandera citada en un ejemplo existe en la hoja que lo aloja', () => {
    const rotos: string[] = [];
    for (const hoja of CON_EJEMPLOS) {
      for (const ejemplo of hoja.ejemplos) {
        const destino = resolver(tokenizar(ejemplo));
        if (!destino) continue;
        const validas = banderasDe(destino.cmd);
        for (const token of tokenizar(ejemplo)) {
          if (!token.startsWith('-') || token === '-' || /^-?\d/.test(token.slice(1))) continue;
          const nombre = token.split('=')[0];
          if (!validas.has(nombre)) {
            rotos.push(`${hoja.ruta}: "${nombre}" no existe en \`mnemosine ${destino.cmd.name()}\` — ${ejemplo}`);
          }
        }
      }
    }
    expect(
      rotos,
      'Un ejemplo con una bandera inexistente manda al usuario a un error de Commander ' +
        'citando la documentación del propio programa. Escribe otro ejemplo: no inventes la bandera.'
    ).toEqual([]);
  });

  it('cada ejemplo invoca la hoja en cuya ayuda vive, no otra', () => {
    const desviados: string[] = [];
    for (const hoja of CON_EJEMPLOS) {
      for (const ejemplo of hoja.ejemplos) {
        const tokens = tokenizar(ejemplo);
        const destino = resolver(tokens);
        const ruta = tokens.slice(1, 1 + hoja.ruta.split(' ').length).join(' ');
        if (!destino || destino.cmd !== hoja.cmd || ruta !== hoja.ruta) {
          desviados.push(`${hoja.ruta} ← ${ejemplo}`);
        }
      }
    }
    expect(
      desviados,
      'El ejemplo de una hoja tiene que invocarla A ELLA: pegado en la ayuda de otra, ' +
        'sus banderas dejan de comprobarse contra la hoja que las recibiría.'
    ).toEqual([]);
  });

  // ── Ninguna familia documentada a medias ───────────────────────────
  it('una familia que documenta una de sus hojas que mutan, las documenta todas', () => {
    const documentadas = new Set(CON_EJEMPLOS.map((h) => h.ruta));
    const familiasDocumentadas = new Set(CON_EJEMPLOS.map((h) => h.ruta.split(' ')[0]));
    const huecos = TODAS.filter((h) => {
      const familia = h.ruta.split(' ')[0];
      if (!familiasDocumentadas.has(familia)) return false;
      if (documentadas.has(h.ruta)) return false;
      return MUTANTES.has(riskOf(h.cmd)?.risk ?? '');
    }).map((h) => h.ruta);
    expect(
      huecos,
      'Estas hojas MUTAN y viven en una familia que ya enseña ejemplos en otra de sus hojas. ' +
        'Una familia a medias enseña al usuario a esperar ejemplos y se los niega justo donde ' +
        'el comando escribe. Añádeles su bloque addHelpText(\'after\', …).'
    ).toEqual([]);
  });

  // ── Los datos de los ejemplos son los del repositorio ───────────────
  it('toda cuenta citada en un ejemplo existe en el catálogo que el repo siembra', () => {
    const catalogo = new Set(
      [...catalogoBasePara(true), ...catalogoBasePara(false)].map((c) => c.code)
    );
    // Una cuenta que un ejemplo CREA no puede estar en el catálogo base: es
    // justo lo que `account create` hace. Se admiten, y sólo ésas.
    const creadas = new Set<string>();
    for (const hoja of CON_EJEMPLOS) {
      if (hoja.cmd.name() !== 'create') continue;
      for (const ejemplo of hoja.ejemplos) {
        const destino = resolver(tokenizar(ejemplo));
        const primerArg = (destino?.cmd.registeredArguments ?? [])[0];
        if (primerArg?.name() === 'code' && destino?.posicionales[0]) {
          creadas.add(destino.posicionales[0]);
        }
      }
    }
    const admisible = (codigo: string): boolean => catalogo.has(codigo) || creadas.has(codigo);

    const CON_CUENTA = ['--account', '--parent', '--default-account'];
    const inventadas: string[] = [];
    for (const hoja of CON_EJEMPLOS) {
      for (const ejemplo of hoja.ejemplos) {
        const tokens = tokenizar(ejemplo);
        const citadas: string[] = [];
        tokens.forEach((t, i) => {
          if (CON_CUENTA.includes(t) && tokens[i + 1]) citadas.push(tokens[i + 1]);
          // `--line "account=6100,price=…"` (bill) y `account=4200;…` (invoice)
          for (const m of t.matchAll(/(?:^|[,;])account=([^,;]+)/g)) citadas.push(m[1]);
          // `--line "6120:debit:45000.00"` (entry)
          const linea = /^(\d{3,6}):(?:debit|credit):/.exec(t);
          if (linea) citadas.push(linea[1]);
        });
        // El posicional que la propia hoja declara como <code> es una cuenta.
        const destino = resolver(tokens);
        (destino?.cmd.registeredArguments ?? []).forEach((arg, i) => {
          const valor = destino?.posicionales[i];
          if (arg.name() === 'code' && valor && /^\d{3,6}$/.test(valor)) citadas.push(valor);
        });
        for (const codigo of citadas) {
          if (!admisible(codigo)) {
            inventadas.push(`${hoja.ruta}: la cuenta ${codigo} no existe — ${ejemplo}`);
          }
        }
      }
    }
    expect(
      inventadas,
      'Un ejemplo que cita una cuenta inventada no se puede pegar en una terminal: el comando ' +
        'muere resolviéndola. Usa códigos del catálogo base (src/services/accounting/chart-seed.ts).'
    ).toEqual([]);
  });
});

// ============================================================
// LA OTRA MITAD: QUE COMMANDER LA ACEPTE
//
// Todo lo de arriba mira los TOKENS del ejemplo contra el árbol. Sabe decir
// «esa bandera no existe». No sabe decir «a esta invocación le falta el folio»:
// borrar el posicional de `mnemosine bill approve BILL-2026-00007 --dry-run`
// dejaba las cinco pruebas en verde, y commander la rechaza en la cara del
// usuario con «missing required argument 'bill'». Tampoco sabe leer DENTRO de
// `--line`, que es donde vive la brecha H3: cambiar `tax-amount=2000.00` por
// `tax=16` en el ejemplo de `bill create` no movía una sola prueba, y es un
// ejemplo copiable que registra 16 pesos de IVA donde van 2 000.
//
// Quien sabe si una invocación se parsea es commander. Así que cada ejemplo se
// PARSEA con el `program` embarcado —el mismo objeto que exporta el binario, no
// una réplica que se pareciera— con tres intervenciones y ninguna más:
//
//   · Las acciones se SUSTITUYEN por un sello; no se quitan. Por dos razones, y
//     la primera es la que hace la prueba posible: el sello es lo único que dice
//     EN QUÉ HOJA terminó el parseo, y sin eso «cada ejemplo invoca la hoja en
//     cuya ayuda vive» no se puede comprobar por aquí. La segunda es que un nodo
//     sin manejador se parsea por OTRA rama de `_parseCommand` —la de
//     command.js:1609 contra el `else` del final—; commander 15 valida los
//     argumentos en las dos, pero la que corre el binario es la primera, con sus
//     ganchos preAction/postAction, y comprobar la otra es comprobar otra cosa.
//   · Se vacían los ganchos de LA RAÍZ, y sólo los de la raíz: ahí vive el
//     `preAction` que levanta el túnel SSH e inicializa la base. Los de los
//     demás nodos se quedan puestos a propósito — una hoja que rechaza su
//     propia invocación tiene que seguir rechazándola aquí.
//   · Se captura la salida NODO A NODO. commander 15 no muta su objeto de
//     configuración: `configureOutput` lo SUSTITUYE por uno nuevo
//     (command.js:249), y los subcomandos siguen apuntando al viejo que
//     heredaron al crearse. Instalarla sólo en la raíz —que es lo que parece
//     bastar— deja al árbol entero escribiendo en el stderr de verdad. Y hace
//     falta capturarla porque commander imprime el error ANTES de que
//     `exitOverride` lo lance, y ese texto es justo el que sirve en el fallo.
//
// Acciones, ganchos y salida se devuelven a su sitio en afterAll: `program` es el
// objeto que el módulo exporta, no una copia de este archivo. Lo que queda tras
// el paso son los valores de opción del último parseo, y quedan sin más: desde
// commander 15 cada `parse` restaura el estado previo antes de empezar
// (`_prepareForParse`, command.js:1118), y aquí nadie lee `opts()`.
// ============================================================

/** Los tres campos privados de Command que el arnés toca, nombrados uno a uno. */
type NodoDelArbol = {
  _actionHandler?: (args: unknown[]) => unknown;
  _lifeCycleHooks: Record<string, unknown[]>;
  _outputConfiguration: OutputConfiguration;
};

function nodosDe(cmd: Command, acc: Command[] = []): Command[] {
  acc.push(cmd);
  for (const h of cmd.commands as Command[]) nodosDe(h, acc);
  return acc;
}

/** La ruta tecleable de un comando, subiendo por sus padres hasta la raíz. */
function rutaDe(cmd: Command): string {
  const partes: string[] = [];
  for (let n: Command | null = cmd; n?.parent; n = n.parent) partes.unshift(n.name());
  return partes.join(' ');
}

/**
 * La parte que el binario llega a ver.
 *
 * `mnemosine completion bash > /usr/local/etc/bash_completion.d/mnemosine` es un
 * ejemplo legítimo y su redirección la resuelve el SHELL: al programa le llegan
 * dos argumentos, no cuatro. Cortar aquí es hacer lo que hace la terminal; no
 * es perdonarle tokens a nadie.
 */
const OPERADORES_DE_SHELL = new Set(['>', '>>', '<', '|', '||', '&&', ';', '2>', '&>']);
function invocacion(tokens: string[]): string[] {
  const corte = tokens.findIndex((t) => OPERADORES_DE_SHELL.has(t));
  return corte < 0 ? tokens : tokens.slice(0, corte);
}

/** Los valores que un ejemplo le pasa a `--line`. */
function valoresDeLinea(tokens: string[]): string[] {
  const fuera: string[] = [];
  tokens.forEach((t, i) => {
    if (t === '--line' && tokens[i + 1] !== undefined) fuera.push(tokens[i + 1]);
  });
  return fuera;
}

/**
 * Las claves que una hoja DICE aceptar dentro de `--line`, leídas del bloque
 * que ella misma imprime («Keys accepted in --line…», bill-command.ts).
 *
 * Se derivan del texto embarcado en vez de copiarse aquí por lo mismo que todo
 * lo demás de este archivo: una lista escrita a mano no cubre la clave que
 * alguien añada mañana, y peor, sigue verde el día que una desaparezca.
 */
function clavesDocumentadasDeLinea(cmd: Command): Set<string> | null {
  const texto = textoPosterior(cmd);
  const cabecera = texto.indexOf('Keys accepted in --line');
  if (cabecera < 0) return null;
  const claves = new Set<string>();
  for (const linea of texto.slice(cabecera).split('\n').slice(1)) {
    if (/^\S/.test(linea)) break; // el bloque acaba donde el texto vuelve al margen
    const m = /^\s+([a-z][a-z0-9-]*)\s\s+\S/.exec(linea);
    if (m) claves.add(m[1]);
  }
  return claves;
}

/** Cuántas invocaciones hay que parsear. Trinquete, como los otros dos. */
const SUELO_EJEMPLOS = 244;

describe('los ejemplos pasan por el commander de verdad', () => {
  const NODOS = nodosDe(program);
  const accionesOriginales = new Map<Command, NodoDelArbol['_actionHandler']>();
  const salidasOriginales = new Map<Command, OutputConfiguration>();
  let ganchosDeLaRaiz: Record<string, unknown[]> = {};
  let sello: Command | null = null;
  let impreso = '';

  beforeAll(() => {
    for (const nodo of NODOS) {
      const priv = nodo as unknown as NodoDelArbol;
      // Los nodos intermedios reparten y no actúan: darles acción los volvería
      // invocables, y `mnemosine bill` —hoy un error de uso— pasaría por bueno.
      if (!priv._actionHandler) continue;
      accionesOriginales.set(nodo, priv._actionHandler);
      // `.action()` es API pública y reemplaza el manejador. El último argumento
      // que commander le pasa es el propio comando (command.js, `action`).
      nodo.action((...args: unknown[]) => {
        sello = args[args.length - 1] as Command;
      });
    }
    const raiz = program as unknown as NodoDelArbol;
    ganchosDeLaRaiz = raiz._lifeCycleHooks;
    raiz._lifeCycleHooks = {};
    const capturar = (s: string): void => { impreso += s; };
    for (const nodo of NODOS) {
      salidasOriginales.set(nodo, (nodo as unknown as NodoDelArbol)._outputConfiguration);
      nodo.configureOutput({ writeOut: capturar, writeErr: capturar });
    }
  });

  afterAll(() => {
    for (const [nodo, accion] of accionesOriginales) {
      (nodo as unknown as NodoDelArbol)._actionHandler = accion;
    }
    (program as unknown as NodoDelArbol)._lifeCycleHooks = ganchosDeLaRaiz;
    // Se repone el OBJETO, no su contenido: los nodos compartían uno solo y
    // `configureOutput` le puso a cada uno el suyo. Devolver la referencia deja
    // el árbol exactamente como estaba.
    for (const [nodo, salida] of salidasOriginales) {
      (nodo as unknown as NodoDelArbol)._outputConfiguration = salida;
    }
  });

  function parsea(argv: string[]): { hoja: Command | null; error: Error | null; dijo: string } {
    sello = null;
    impreso = '';
    let error: Error | null = null;
    try {
      program.parse(argv, { from: 'user' });
    } catch (err) {
      // El `exitOverride` de mnemosine.ts siempre lanza un Error; la otra rama
      // existe para no perder un fallo raro convirtiéndolo en «no hubo fallo».
      error = err instanceof Error ? err : new Error('el parseo lanzó algo que no era un Error');
    }
    // La anotación explícita es a propósito: el flujo de tipos no ve que
    // `program.parse` llame al sello, y sin ella `hoja` se estrecharía a null.
    const hoja: Command | null = sello;
    return { hoja, error, dijo: impreso.trim() };
  }

  it('el arnés rechaza lo que commander rechaza: si no, lo de abajo pasa sobre nada', () => {
    // Ésta es la prueba de la prueba. Si el arnés se desarma —el sello deja de
    // ponerse, `parsea` se traga el error, la captura de salida se lleva por
    // delante el rechazo— las 244 invocaciones de abajo pasan en verde estén
    // rotas o no. Aquí se comprueba que muerde: que rechaza las cuatro formas de
    // uso mal escrito, y que a la buena la deja llegar A SU HOJA.
    expect(parsea(['bill', 'approve']).error, 'falta el folio y nadie protestó').not.toBeNull();
    expect(parsea(['bill', 'approve', 'BILL-2026-00007', '--nope']).error).not.toBeNull();
    expect(parsea(['bill', 'approve', 'BILL-2026-00007', 'sobra']).error).not.toBeNull();
    expect(parsea(['bill', 'inbox']).error, 'una familia no es una invocación').not.toBeNull();

    const bueno = parsea(['bill', 'approve', 'BILL-2026-00007']);
    expect(bueno.error, bueno.dijo).toBeNull();
    expect(
      bueno.hoja && rutaDe(bueno.hoja),
      'El sello no llegó: sin él nadie sabe en qué hoja terminó un parseo, y la ' +
        'prueba de abajo no puede afirmar que el ejemplo invoque a la suya.'
    ).toBe('bill approve');
  });

  it('commander acepta cada ejemplo, y lo acepta en la hoja que lo aloja', () => {
    const rechazados: string[] = [];
    let comprobadas = 0;
    for (const hoja of CON_EJEMPLOS) {
      for (const ejemplo of hoja.ejemplos) {
        comprobadas += 1;
        const r = parsea(invocacion(tokenizar(ejemplo)).slice(1));
        if (r.error) {
          rechazados.push(
            `${hoja.ruta}: ${r.dijo.split('\n').pop() || r.error.message}\n    ${ejemplo}`
          );
        } else if (r.hoja !== hoja.cmd) {
          const donde = r.hoja ? `«${rutaDe(r.hoja)}»` : 'ninguna hoja';
          rechazados.push(`${hoja.ruta}: el parseo terminó en ${donde}\n    ${ejemplo}`);
        }
      }
    }
    expect(
      comprobadas,
      'Sin invocaciones que parsear esto no prueba nada. Este suelo sube con los ejemplos.'
    ).toBeGreaterThanOrEqual(SUELO_EJEMPLOS);
    expect(
      rechazados,
      'Un ejemplo que commander rechaza es peor que ninguno: el usuario lo pega en su ' +
        'terminal y recibe un error de uso citando la documentación del propio programa. ' +
        'Arregla el ejemplo — no la prueba.'
    ).toEqual([]);
  });
});

// ── Los valores DENTRO de --line ────────────────────────────────────
//
// Para commander `--line` es una cadena y con eso se da por satisfecho: la
// gramática vive dentro. Y no hay una, hay TRES —bill separa por COMAS, invoice
// por PUNTO Y COMA, entry es posicional con DOS PUNTOS—, que es exactamente la
// brecha H3 y la razón por la que un ejemplo mal escrito aquí no lo caza nadie.
//
// Así que el valor de cada ejemplo se pasa por el parser que su comando usa DE
// VERDAD (`parseLineSpec`, `parseInvoiceLine`), no por una copia de la gramática
// escrita en esta prueba, que se quedaría atrás en cuanto el comando cambie.

describe('lo que va dentro de --line también se puede teclear', () => {
  it('las claves de --line son las que la propia hoja documenta aceptar', () => {
    const conBloque = CON_EJEMPLOS.filter((h) => clavesDocumentadasDeLinea(h.cmd) !== null);
    expect(
      conBloque.map((h) => h.ruta),
      'Si ninguna hoja publica su bloque de claves, esta prueba no compara nada.'
    ).toContain('bill create');

    const rotas: string[] = [];
    for (const hoja of conBloque) {
      const claves = clavesDocumentadasDeLinea(hoja.cmd);
      if (!claves) continue;
      expect(
        [...claves],
        `${hoja.ruta}: el bloque de claves se leyó vacío o mal, y entonces esto no compara nada`
      ).toContain('account');
      for (const ejemplo of hoja.ejemplos) {
        for (const valor of valoresDeLinea(invocacion(tokenizar(ejemplo)))) {
          for (const clave of Object.keys(parseLineSpec(valor))) {
            if (!claves.has(clave)) {
              rotas.push(
                `${hoja.ruta}: "${clave}" no está entre las claves que --line acepta ` +
                  `(${[...claves].join(', ')}) — ${ejemplo}`
              );
            }
          }
        }
      }
    }
    expect(
      rotas,
      'El comando muere con «Unknown key(s) in --line» en cuanto alguien pega el ejemplo.'
    ).toEqual([]);
  });

  it('ningún ejemplo de bill enseña la clave legada tax=', () => {
    // `tax=` en bill es un MONTO; el `tax=` de invoice es una TASA. Un ejemplo
    // copiable que dijera `tax=16` en un bill registra 16 pesos de IVA donde van
    // 2 000 —la confusión H3 que el par `tax-amount=` + aviso existe para
    // cerrar—, y ni commander ni el bloque de claves lo verían: `tax` es una
    // clave ACEPTADA. Quien lo sabe es el resolutor que el comando usa, y es a
    // él a quien se le pregunta.
    const legados: string[] = [];
    let miradas = 0;
    for (const hoja of CON_EJEMPLOS) {
      if (hoja.ruta.split(' ')[0] !== 'bill') continue;
      if (clavesDocumentadasDeLinea(hoja.cmd) === null) continue;
      for (const ejemplo of hoja.ejemplos) {
        for (const valor of valoresDeLinea(invocacion(tokenizar(ejemplo)))) {
          miradas += 1;
          const resuelto = resolveLineTaxAmount(parseLineSpec(valor));
          if (resuelto.usedLegacyTaxKey) {
            legados.push(
              `${hoja.ruta}: "${valor}" deja tax_amount=${resuelto.tax_amount} por la clave ` +
                `legada tax=; escríbelo tax-amount= — ${ejemplo}`
            );
          }
        }
      }
    }
    expect(miradas, 'ninguna línea de bill mirada: esto pasaría sobre cero').toBeGreaterThanOrEqual(3);
    expect(
      legados,
      'La ayuda no puede enseñar la clave que el propio comando avisa de no usar: quien la ' +
        'copia cree que 16 es la tasa y registra 16 pesos de IVA.'
    ).toEqual([]);
  });

  it('cada --line de invoice lo acepta el parser que invoice usa de verdad', () => {
    const rotas: string[] = [];
    let miradas = 0;
    for (const hoja of CON_EJEMPLOS) {
      if (hoja.ruta.split(' ')[0] !== 'invoice') continue;
      for (const ejemplo of hoja.ejemplos) {
        for (const valor of valoresDeLinea(invocacion(tokenizar(ejemplo)))) {
          miradas += 1;
          try {
            parseInvoiceLine(valor);
          } catch (err) {
            rotas.push(`${hoja.ruta}: ${(err as Error).message} — ${ejemplo}`);
          }
        }
      }
    }
    expect(miradas, 'ninguna línea de invoice mirada').toBeGreaterThanOrEqual(4);
    expect(rotas, 'El separador de invoice es el PUNTO Y COMA, y account= y price= no son opcionales.').toEqual([]);
  });

  it('cada --line de entry tiene la forma que entry documenta, y la póliza cuadra', () => {
    // entry no tiene claves: su gramática es `<cuenta>:<debit|credit>:<importe>`
    // con descripción opcional al final, y la publica en la descripción de la
    // bandera. Un ejemplo descuadrado es tan intecleable como uno con una
    // bandera inventada: el comando lo rechaza al validar la partida doble.
    const FORMA = /^(\d{3,6}):(debit|credit):(\d+(?:\.\d+)?)(?::(.*))?$/;
    const rotas: string[] = [];
    let miradas = 0;
    for (const hoja of CON_EJEMPLOS) {
      if (hoja.ruta.split(' ')[0] !== 'entry') continue;
      for (const ejemplo of hoja.ejemplos) {
        const valores = valoresDeLinea(invocacion(tokenizar(ejemplo)));
        if (valores.length === 0) continue;
        let debe = 0;
        let haber = 0;
        for (const valor of valores) {
          miradas += 1;
          const m = FORMA.exec(valor);
          if (!m) {
            rotas.push(
              `${hoja.ruta}: "${valor}" no tiene la forma <cuenta>:<debit|credit>:<importe>[:texto] — ${ejemplo}`
            );
            continue;
          }
          // En centavos: sumar pesos en coma flotante es la manera de que un
          // ejemplo descuadrado por un centavo pase por cuadrado.
          const centavos = Math.round(Number(m[3]) * 100);
          if (m[2] === 'debit') debe += centavos;
          else haber += centavos;
        }
        if (debe !== haber) {
          rotas.push(
            `${hoja.ruta}: la póliza del ejemplo no cuadra (debe ${debe / 100}, haber ${haber / 100}) — ${ejemplo}`
          );
        }
      }
    }
    expect(miradas, 'ninguna línea de entry mirada').toBeGreaterThanOrEqual(8);
    expect(
      rotas,
      'Una póliza de ejemplo que no cuadra no se puede pegar: el comando la rechaza al ' +
        'validar la partida doble, y de paso enseña una partida doble falsa.'
    ).toEqual([]);
  });
});
