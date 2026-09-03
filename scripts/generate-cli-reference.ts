/**
 * Generates src/ai/docs/cli-reference.md from the commander program itself.
 *
 * Walks the exported `program` object (src/cli/mnemosine.ts) and emits, for
 * every node, the help that `mnemosine <cmd> --help` REALLY prints — without
 * spawning one process per command and without parsing help text (both
 * failure modes of the earlier shell generator).
 *
 * Run: npx tsx scripts/generate-cli-reference.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command, OutputConfiguration } from 'commander';
import { program } from '../src/cli/mnemosine.js';

const HEADER = `# CLI reference (auto-generated — do not edit by hand)

Regenerate with: \`npx tsx scripts/generate-cli-reference.ts\`.

This is the EXACT surface of the \`mnemosine\` binary: quote commands and
flags verbatim when guiding a human — never invent a flag that is not
listed here. When a flow needs several commands, give them in order.

Notes for the agent:
- The global option \`-T, --tenant <uuid>\` (or the \`MNEMOSINE_TENANT\` env
  var) scopes EVERY command under row-level security. It appears only on
  the root help below, but it works before any subcommand.
- Spanish aliases (shown as \`name|alias\`) are equivalent to the English
  names; use whichever matches the user's language.
`;

/**
 * El ancho con el que se renderiza la ayuda del documento.
 *
 * No es una preferencia estética: sin fijarlo, el documento depende de la
 * ventana de quien corre el guion. Commander toma el ancho de
 * `process.stdout.isTTY ? process.stdout.columns : undefined` (command.js:66)
 * y `Help.prepareContext` cae a 80 cuando llega `undefined` (help.js:31). Es
 * decir: generado desde una terminal de 120 columnas el documento sale con
 * 9 557 caracteres MENOS que generado por una tubería, y las dos versiones se
 * pisan en cada commit. 80 es exactamente lo que produce el propio commander
 * cuando la salida no es una terminal — el caso canónico y reproducible.
 */
const ANCHO_CANONICO = 80;

/** El contexto que `outputHelp` pasa a los oyentes de ayuda (HelpTextEventContext). */
type ContextoDeAyuda = { error: boolean; command: Command; write: (s: string) => void };

/**
 * `Command` extiende EventEmitter en tiempo de ejecución, pero sus tipos no
 * publican `emit`: el molde nombra exactamente el contrato que se usa y no
 * abre la puerta a `any`.
 */
function emitir(cmd: Command, evento: string, contexto: ContextoDeAyuda): void {
  (cmd as unknown as { emit(evento: string, contexto: ContextoDeAyuda): boolean }).emit(
    evento,
    contexto
  );
}

/** El propio nodo y luego sus ancestros, como `_getCommandAndAncestors()`. */
function conAncestros(cmd: Command): Command[] {
  const cadena: Command[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) cadena.push(c);
  return cadena;
}

/**
 * La ayuda ENTERA de un nodo: la que Commander arma sola MÁS lo que el comando
 * añadió con `addHelpText`.
 *
 * `helpInformation()` NO basta, y el detalle no es cosmético. `addHelpText` no
 * guarda texto: registra un oyente del evento `beforeAllHelp` / `beforeHelp` /
 * `afterHelp` / `afterAllHelp` que escribe en el `context.write` que le pasan
 * (command.js:addHelpText), y sólo `outputHelp` emite esos eventos.
 * `helpInformation()` no emite ninguno. Por eso la cabecera de este guion
 * prometía «byte-identical to what --help prints» y mentía justo donde más
 * caro sale: 115 de los 236 nodos perdían su bloque `Examples:` entero —
 * 244 invocaciones que el agente NO veía mientras el binario sí las imprime.
 * Y el agente lee este documento bajo la orden «never invent a flag that is
 * not listed here»: lo que no está aquí, para él no existe.
 *
 * El orden replica `outputHelp` (command.js) al pie de la letra, incluidos los
 * `beforeAllHelp` / `afterAllHelp` de los ancestros: hoy nadie los registra
 * —las 114 llamadas de src/ son todas `'after'`— pero el día que la raíz
 * cuelgue un pie de página, `--help` lo imprimirá en las 237 pantallas y este
 * documento tiene que imprimirlo también. Aquí sí se emiten, al revés que en
 * el censo de scripts/ux-status.ts, que los omite a propósito: aquel MIDE si
 * cada hoja enseña a usarse (un pie de la raíz falsearía las 179 hojas), éste
 * REPRODUCE lo que el binario escribe. Contratos distintos, decisión distinta.
 */
export function ayudaCompleta(cmd: Command): string {
  const trozos: string[] = [];
  const contexto: ContextoDeAyuda = {
    error: false,
    command: cmd,
    write: (s: string) => {
      trozos.push(s);
    },
  };
  conAncestros(cmd)
    .reverse()
    .forEach((c) => emitir(c, 'beforeAllHelp', contexto));
  emitir(cmd, 'beforeHelp', contexto);
  trozos.push(cmd.helpInformation());
  emitir(cmd, 'afterHelp', contexto);
  conAncestros(cmd).forEach((c) => emitir(c, 'afterAllHelp', contexto));
  return trozos.join('');
}

/** Todo el árbol en preorden: la raíz primero, luego cada rama. */
export function nodos(cmd: Command): Command[] {
  return [cmd, ...(cmd.commands as Command[]).flatMap((h) => nodos(h))];
}

/**
 * Fija el ancho de ayuda en todo el árbol mientras corre `fn`, y lo repone.
 *
 * Se recorren TODOS los nodos, no sólo la raíz, y conviene decir con exactitud
 * qué se gana HOY y qué se asegura para mañana, porque no es lo mismo.
 *
 * HOY no se gana nada: `src/cli` no tiene ni una llamada a `.addCommand()`
 * (medido: 0 en todo `src/`), el árbol entero se arma con `.command()`, y
 * `.command()` llama a `copyInheritedSettings`, que asigna el objeto del padre
 * POR REFERENCIA (command.js:101). Medido: los 237 nodos comparten UN solo
 * `_outputConfiguration`. Fijar el ancho sólo en la raíz daría exactamente el
 * mismo documento — por accidente.
 *
 * MAÑANA sí: `.addCommand()` NO copia esa configuración (command.js:addCommand
 * no llama a `copyInheritedSettings`), así que la primera familia que se
 * enganche así traerá su `_outputConfiguration` propio, y un generador que
 * fijara sólo la raíz dejaría su ayuda al ancho de la terminal de quien corre
 * el guion, en silencio. Recorrer el árbol es el seguro; el árbol de juguete de
 * tests/docs/generador-de-referencia.spec.ts lo cobra hoy, para que el seguro
 * no caduque mientras nadie mira.
 *
 * Se parchean las dos funciones DENTRO del objeto de configuración, en vez de
 * llamar a `configureOutput({…})`, porque ese método REEMPLAZA el objeto por
 * uno nuevo. Los nodos hermanos creados con `.command()` comparten el objeto
 * del padre por referencia, y reemplazarlo los desengancharía: a partir de ahí
 * un `program.configureOutput({ writeOut })` en la raíz ya no llegaría a las
 * hojas — que es justo de lo que vive tests/cli/ejemplos-de-ayuda.spec.ts para
 * capturar lo que imprime cada hoja. El `Set` deduplica ese objeto compartido;
 * el `finally` repone los valores exactos que había, `undefined` incluido.
 */
const CLAVES_DE_ANCHO = ['getOutHelpWidth', 'getErrHelpWidth'] as const;

export function conAnchoFijo<T>(arbol: Command[], ancho: number, fn: () => T): T {
  const configuraciones = new Set<OutputConfiguration>(arbol.map((c) => c.configureOutput()));
  // Descriptores y no el valor suelto: reponen la propiedad EXACTA que había,
  // y distinguen «estaba puesta a undefined» de «no estaba» — un
  // `cfg.getOutHelpWidth = undefined` deja la clave presente y commander la
  // llamaría. (De paso evita leer el método suelto, que es lo que la regla
  // @typescript-eslint/unbound-method señala con razón.)
  const previas = [...configuraciones].map((cfg) => ({
    cfg,
    descriptores: CLAVES_DE_ANCHO.map((clave) => Object.getOwnPropertyDescriptor(cfg, clave)),
  }));
  for (const { cfg } of previas) {
    for (const clave of CLAVES_DE_ANCHO) {
      Object.defineProperty(cfg, clave, {
        value: () => ancho,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  try {
    return fn();
  } finally {
    for (const { cfg, descriptores } of previas) {
      CLAVES_DE_ANCHO.forEach((clave, i) => {
        const descriptor = descriptores[i];
        if (descriptor) Object.defineProperty(cfg, clave, descriptor);
        else delete cfg[clave];
      });
    }
  }
}

function heading(depth: number): string {
  return '#'.repeat(Math.min(depth, 6));
}

function section(cmd: Command, chain: string[], depth: number, out: string[]): void {
  const fullName = [...chain, cmd.name()].join(' ');
  const aliases = cmd.aliases().filter(Boolean);
  const alias = aliases.length ? ` (alias: ${aliases.join(', ')})` : '';
  out.push(`${heading(depth)} \`${fullName}\`${alias}`, '');
  out.push('```', ayudaCompleta(cmd).trimEnd(), '```', '');
  for (const sub of cmd.commands) {
    section(sub, [...chain, cmd.name()], depth + 1, out);
  }
}

/** El documento entero, con el ancho ya fijado. */
export function construirReferencia(raiz: Command): string {
  return conAnchoFijo(nodos(raiz), ANCHO_CANONICO, () => {
    const out: string[] = [HEADER];
    out.push('## `mnemosine` (root)', '');
    out.push('```', ayudaCompleta(raiz).trimEnd(), '```', '');
    for (const cmd of raiz.commands) {
      section(cmd, ['mnemosine'], 2, out);
    }
    return out.join('\n') + '\n';
  });
}

// __dirname nativo en lugar de import.meta, igual que build-niif-indice.ts:
// el proyecto compila a CommonJS (tsconfig NodeNext sin "type": "module"),
// donde import.meta es un error de compilación (TS1470).
export const DESTINO = path.join(__dirname, '..', 'src', 'ai', 'docs', 'cli-reference.md');

// Tras el guardia, como los cinco hermanos de scripts/: importar este módulo
// —la prueba lo hace— no debe reescribir el documento ni matar el proceso.
if (require.main === module) {
  const documento = construirReferencia(program);
  fs.writeFileSync(DESTINO, documento);
  const commandCount = (documento.match(/^#{2,6} `/gm) ?? []).length - 1;
  console.log(`Wrote ${DESTINO} — ${commandCount} command sections.`);
  process.exit(0);
}
