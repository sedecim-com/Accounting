import { Help, type Command, type Option } from 'commander';
import { t, type MessageParams, type TranslationKey } from '../../i18n/index.js';

// ============================================================
// EL CROMO DEL CLI, POR CLAVE (I7 · issue #149)
//
// Commander 15 maqueta sola una pantalla entera de ayuda: la línea `Usage:`,
// los encabezados `Arguments:` / `Options:` / `Global Options:` / `Commands:`,
// la descripción de `-h, --help`, la de `help [command]` y la de
// `-V, --version`. Nada de eso pasa por una cadena que este repositorio
// escriba, así que ningún catálogo lo alcanzaba: con `--locale es-MX` el
// binario imprimía «Uso» en ninguna parte y «display help for command» 389
// veces en `src/ai/docs/cli-reference.md`. Ese 389 NO es el número de nodos —el
// árbol tiene 311—: son 311 renglones `-h, --help` más 78 renglones
// `help [command]`, uno por nodo con hijos. Las tres cifras se recuentan con
// `grep -c` sobre ese documento.
//
// ────────────────────────────────────────────────────────────────────────
// LAS DOS CARAS DE UNA DESCRIPCIÓN, Y POR QUÉ ESTA SEPARACIÓN NO ES UN RODEO
//
// Una descripción de comando o de bandera tiene HOY dos lectores distintos:
//
//   · EL HUMANO, que lee `mnemosine bank --help` y merece leerlo en su idioma.
//   · LA MÁQUINA, que lee `Command.description()` y `Option.description` en
//     proceso: el censo de superficie (`scripts/ux-status.ts`, en `prosaDe` y
//     en el ayudante que arma la ayuda para `tieneEjemplo`) —que además ACUSA
//     como defecto toda prosa de ayuda que no esté en inglés— y el generador de
//     `src/ai/docs/cli-reference.md`. Se citan por NOMBRE y no por renglón: los
//     dos números que este párrafo daba antes apuntaban a otra cosa.
//
// Si la traducción se escribiera dentro del objeto de Commander, el segundo
// lector vería español y el censo se pondría rojo entero. Por eso aquí:
//
//   · lo que se GUARDA en Commander es el inglés del catálogo, `t(key, …, 'en')`
//     —no una prosa suelta: la misma clave, rendida en inglés—;
//   · lo que se TRADUCE es el RENDERIZADO, en los ganchos de `Help`.
//
// Una sola prosa en el árbol, dos lectores, y ninguno de los dos leyendo una
// copia. El precio está dicho: quien lea `cmd.description()` obtiene inglés
// SIEMPRE, aunque el usuario haya pedido español. Es deliberado y es lo que
// mantiene estable el contrato de máquina.
//
// ────────────────────────────────────────────────────────────────────────
// EL ORDEN IMPORTA, Y NO ES UNA PREFERENCIA
//
// `Command.copyInheritedSettings` (commander/lib/command.js:100) copia
// `_helpConfiguration`, `_outputConfiguration`, `_helpOption` y `_helpCommand`
// del padre AL CREAR el hijo, dentro de `.command()`. Un `configureHelp` puesto
// después de registrar las familias no llega a ninguna de ellas. Por eso
// `installHelpChrome(program)` se llama antes de la primera `.command()`, y por
// eso el locale se resuelve antes todavía.
// ============================================================

/** Lo que se guardó para poder volver a rendir una prosa en otro idioma. */
interface LocalizedText {
  readonly key: TranslationKey;
  readonly params: MessageParams;
  /**
   * EL INGLÉS QUE ESTE MÓDULO ESCRIBIÓ EN EL OBJETO DE COMMANDER, para poder
   * comprobar después que sigue ahí. Ver `stillOurs`.
   */
  readonly english: string;
}

/**
 * ¿La prosa que hay HOY en el objeto de Commander es la que pusimos nosotros?
 *
 * Hace falta porque tres hojas de este árbol PISAN, a propósito, la descripción
 * de una bandera que el kernel les inyectó, y lo hacen después de la inyección:
 *
 *   · `src/cli/e-accounting-command.ts:449` — `-o, --output` deja de ser
 *     «write to a file instead of stdout» y pasa a nombrar el XML concreto.
 *   · `src/cli/audit-command.ts:162` — `-u, --user` no es «acting user» ahí:
 *     este comando no atribuye nada, filtra por autor.
 *   · `src/cli/payroll-isn-command.ts:1315` y `:1318` — `-a, --all` y
 *     `-s, --status` hablan de pasivos liquidados, no de «archived and closed».
 *
 * Sin esta comprobación el gancho de `Help` rendía la CLAVE y las cuatro
 * sobrescrituras desaparecían de la ayuda: la bandera volvía a describirse en
 * genérico y el documento de `src/ai/docs/cli-reference.md` lo enseñaba en
 * negro sobre blanco —así se encontró—. La clave sólo manda mientras nadie
 * haya escrito encima.
 *
 * LO QUE ESTO CUESTA, Y SE DICE PORQUE ES UNA PÉRDIDA REAL: una descripción
 * pisada NO se traduce. Vuelve a ser prosa escrita en el sitio de llamada, y
 * sale en inglés en las dos pantallas. Se arregla dándole su propia clave a esa
 * hoja —`describeOption(opcion, 'clave')` en vez de `opcion.description = …`—,
 * que es trabajo del tramo que adopte esa familia, no de éste.
 */
function stillOurs(current: string, text: LocalizedText): boolean {
  return current === text.english;
}

/**
 * Las claves, atadas al objeto de Commander que las usa.
 *
 * `WeakMap` y no un campo en el objeto: no se ensucia el `Command` ni la
 * `Option` de Commander con propiedades que su serialización no espera, y la
 * entrada se va sola con el objeto (importa en las pruebas, que arman y tiran
 * árboles enteros).
 */
const COMMAND_TEXT = new WeakMap<Command, LocalizedText>();
const OPTION_TEXT = new WeakMap<Option, LocalizedText>();

/** La instancia con las implementaciones DE FÁBRICA de `Help`, para delegar. */
const BASE_HELP = new Help();

/** El inglés de una clave: lo que se guarda en el objeto de Commander. */
export function englishOf(key: TranslationKey, params: MessageParams = {}): string {
  return t(key, params, 'en');
}

/**
 * Registra la descripción de un comando por su clave.
 *
 * Devuelve el propio comando para poder encadenar donde ya se encadenaba.
 */
export function describeCommand(
  cmd: Command,
  key: TranslationKey,
  params: MessageParams = {}
): Command {
  const english = englishOf(key, params);
  COMMAND_TEXT.set(cmd, { key, params, english });
  return cmd.description(english);
}

/** Registra la descripción de una opción ya construida, por su clave. */
export function describeOption(
  option: Option,
  key: TranslationKey,
  params: MessageParams = {}
): Option {
  const english = englishOf(key, params);
  OPTION_TEXT.set(option, { key, params, english });
  option.description = english;
  return option;
}

/**
 * La última opción que se registró en este comando, por su clave.
 *
 * Existe por `Command.version(str, flags, description)`, que construye su
 * `Option` por dentro y no la devuelve (command.js:2209). `program.options` la
 * acaba de recibir, así que la última es ésa. No se usa para nada más: para
 * declarar una bandera nueva está `optionByKey`, que no adivina.
 */
export function describeLastOption(
  cmd: Command,
  key: TranslationKey,
  params: MessageParams = {}
): Command {
  const last = cmd.options[cmd.options.length - 1];
  if (last) describeOption(last, key, params);
  return cmd;
}

/** Lo que `cmd.option(flags, desc, parser|default)` sabía hacer, más la clave. */
export interface OptionByKeyOptions {
  readonly params?: MessageParams;
  readonly parser?: (value: string) => unknown;
  readonly defaultValue?: unknown;
}

/**
 * Declara una bandera cuya ayuda vive en el catálogo.
 *
 * Sustituye a `cmd.option(flags, 'prosa', …)`: la prosa deja de estar escrita
 * en el sitio de llamada y pasa a ser una clave, sin cambiar ni la grafía de la
 * bandera ni su parser ni su valor por omisión —que son contrato de máquina y
 * no se traducen—.
 */
export function optionByKey(
  cmd: Command,
  flags: string,
  key: TranslationKey,
  options: OptionByKeyOptions = {}
): Command {
  const option = cmd.createOption(flags, englishOf(key, options.params ?? {}));
  describeOption(option, key, options.params ?? {});
  if (options.parser) option.argParser<unknown>(options.parser);
  if (options.defaultValue !== undefined) option.default(options.defaultValue);
  return cmd.addOption(option);
}

/**
 * Los cinco títulos que `Help.styleTitle` recibe, cada uno con su clave.
 *
 * Se indexan por el LITERAL inglés porque es lo que Commander pasa
 * (help.js:454, :478, :485, :507, :515). Un encabezado de grupo propio
 * —`commandsGroup()`, `optionsGroup()`— también entra por aquí y NO está en la
 * tabla: pasa intacto, que es lo correcto. Ningún nodo de este árbol declara
 * grupos hoy; el día que declare uno, su encabezado se traduce añadiéndolo a
 * esta tabla y a las dos columnas del catálogo.
 */
const TITLE_KEYS = new Map<string, TranslationKey>([
  ['Usage:', 'cli.chrome.usage'],
  ['Arguments:', 'cli.chrome.arguments'],
  ['Options:', 'cli.chrome.options'],
  ['Global Options:', 'cli.chrome.global_options'],
  ['Commands:', 'cli.chrome.commands'],
]);

/**
 * El texto traducido de un comando, o `null` si su prosa no tiene clave —o si
 * alguien la sobrescribió después de registrarla (ver `stillOurs`).
 */
function localizedCommandText(cmd: Command): string | null {
  const text = COMMAND_TEXT.get(cmd);
  if (!text || !stillOurs(cmd.description(), text)) return null;
  return t(text.key, text.params);
}

/**
 * Los mensajes de error que Commander escribe ÉL, reconocidos por su forma.
 *
 * Commander no expone su prosa: `Command.error()` recibe la cadena ya armada y
 * el único gancho que la ve es `configureOutput.outputError`, que recibe TEXTO
 * y no un código (command.js:2047, :2059, :2071, :2147, :2192). Traducir por
 * reconocimiento es feo y se hace a sabiendas; la alternativa —dejar la mitad
 * de los errores del binario en inglés— es peor para quien los lee.
 *
 * LO QUE ESTA TABLA NO CUBRE, dicho aquí para que nadie lo suponga cubierto:
 *
 *   · `error: too many arguments…` (command.js:2166), cuya frase compone un
 *     plural inglés a mano (`argument${s}`) y dos cuentas; traducirla pide una
 *     clave con plural propio y su prueba, y este tramo no la trae.
 *   · `error: <a> cannot be used with <b>` (command.js:2115), el conflicto de
 *     opciones, que ningún nodo de este árbol declara hoy.
 *   · El mensaje de un `InvalidArgumentError` (command.js:605), que lo escribe
 *     quien lanza —`flags.ts` lo hace ya por clave— y aquí sólo llega envuelto.
 *
 * Todo lo que no encaja PASA INTACTO. Un error a medio traducir sería peor que
 * uno en inglés: el lector no sabría si la parte que no entiende es prosa o dato.
 */
const COMMANDER_ERRORS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly key: TranslationKey;
  readonly names: readonly string[];
}> = [
  { pattern: /^error: unknown command '(.*)'$/, key: 'cli.error.unknown_command', names: ['name'] },
  { pattern: /^error: unknown option '(.*)'$/, key: 'cli.error.unknown_option', names: ['flag'] },
  {
    pattern: /^error: missing required argument '(.*)'$/,
    key: 'cli.error.missing_argument',
    names: ['name'],
  },
  {
    pattern: /^error: option '(.*)' argument missing$/,
    key: 'cli.error.option_missing_argument',
    names: ['flags'],
  },
  {
    pattern: /^error: required option '(.*)' not specified$/,
    key: 'cli.error.missing_mandatory_option',
    names: ['flags'],
  },
  {
    pattern: /^\(Did you mean one of (.*)\?\)$/,
    key: 'cli.error.did_you_mean_one_of',
    names: ['suggestions'],
  },
  { pattern: /^\(Did you mean (.*)\?\)$/, key: 'cli.error.did_you_mean', names: ['suggestion'] },
];

/**
 * Traduce lo que Commander escribió, renglón por renglón.
 *
 * Renglón por renglón porque el sufijo de sugerencia viaja pegado al mensaje
 * con un `\n` en medio (suggestSimilar.js:93, :96) y son dos frases distintas.
 * Se exporta para que `tests/` pueda ejercitar la tabla sin arrancar el
 * binario: una tabla de expresiones regulares que nadie prueba es una tabla que
 * caduca en silencio el día que Commander cambie una coma.
 */
export function localizeCommanderError(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (const entry of COMMANDER_ERRORS) {
        const hit = entry.pattern.exec(line);
        if (!hit) continue;
        const params: Record<string, string> = {};
        entry.names.forEach((name, index) => {
          params[name] = hit[index + 1] ?? '';
        });
        return t(entry.key, params);
      }
      return line;
    })
    .join('\n');
}

/**
 * Instala el cromo traducido en la raíz, para todo el árbol.
 *
 * SE LLAMA ANTES DE LA PRIMERA `.command()`: ver la cabecera de este archivo.
 * Los cuatro ganchos y por qué cada uno:
 *
 *   · `configureHelp` — los títulos y las descripciones, EN EL MOMENTO DE
 *     RENDIR. Nada aquí se congela al arrancar, así que un proceso que cambie
 *     de idioma entre dos pantallas (las pruebas, el generador de la
 *     referencia) obtiene la segunda en el idioma nuevo.
 *   · `addHelpOption` / `addHelpCommand` — `-h, --help` y `help [command]`, que
 *     Commander fabrica solo con la misma frase inglesa. Se construyen aquí
 *     UNA vez y `copyInheritedSettings` reparte la MISMA instancia a TODOS los
 *     nodos del árbol —311 hoy; el censo de `scripts/ux-status.ts` publica la
 *     cuenta, y por eso no se clava aquí—, así que la clave registrada aquí les
 *     sirve a todos.
 *   · `configureOutput` — los errores del parser, que no pasan por `Help`.
 */
export function installHelpChrome(program: Command): void {
  program.configureHelp({
    styleTitle: (title: string): string => {
      const key = TITLE_KEYS.get(title);
      return key ? t(key) : title;
    },

    commandDescription: (cmd: Command): string =>
      localizedCommandText(cmd) ?? cmd.description(),

    // El `summary()` gana al `description()` cuando existe, igual que en
    // Help.subcommandDescription (help.js): no se cambia esa precedencia, sólo
    // se traduce el escalón que sí tiene clave.
    subcommandDescription: (cmd: Command): string =>
      cmd.summary() || (localizedCommandText(cmd) ?? cmd.description()),

    optionDescription: (option: Option): string => {
      const text = OPTION_TEXT.get(option);
      // Sin clave, o con la prosa ya pisada por su hoja: manda lo que hay
      // escrito en la opción. Ver `stillOurs` y las cuatro sobrescrituras que
      // cita.
      if (!text || !stillOurs(option.description, text)) {
        return BASE_HELP.optionDescription(option);
      }
      // NO SE MUTA LA OPCIÓN. `Help.optionDescription` cuelga de la prosa los
      // sufijos `(default: …)`, `(choices: …)` y `(env: …)`, y reescribir esa
      // lógica aquí sería una segunda copia que se desincroniza con Commander.
      //
      // Y ESOS TRES SUFIJOS SIGUEN EN INGLÉS, medido: con `--locale es-MX`,
      // `bank account list --help` imprime «formato de salida (default:
      // "table")». Las palabras `default`, `choices` y `env` las escribe
      // Commander dentro de `optionDescription` (help.js) sin pasar por ningún
      // gancho; traducirlas pide reimplementar el método entero aquí, y este
      // tramo eligió no hacerlo. Queda dicho para que nadie lo cuente como
      // cubierto.
      // Un objeto que HEREDA de la opción deja intacto el original y le da a la
      // implementación de fábrica todo lo que mira —`argChoices`,
      // `defaultValue`, `isBoolean()`— por la cadena de prototipos.
      const shadow: Option = Object.create(option) as Option;
      shadow.description = t(text.key, text.params);
      return BASE_HELP.optionDescription(shadow);
    },
  });

  const helpOption = program.createOption(
    '-h, --help',
    englishOf('cli.chrome.help_description')
  );
  describeOption(helpOption, 'cli.chrome.help_description');
  program.addHelpOption(helpOption);

  // `createCommand` + `copyInheritedSettings` es lo que hace `.command()` por
  // dentro (command.js:177); `helpOption(false)` y `arguments('[command]')` es
  // lo que hace `helpCommand()` por dentro (command.js:425-428). Se replica
  // aquí en vez de llamar a `helpCommand()` porque ése no devuelve el `Command`
  // que fabrica y hay que registrarle la clave.
  const helpCommand = program.createCommand('help');
  helpCommand.copyInheritedSettings(program);
  helpCommand.helpOption(false);
  helpCommand.arguments('[command]');
  describeCommand(helpCommand, 'cli.chrome.help_description');
  program.addHelpCommand(helpCommand);

  program.configureOutput({
    outputError: (str: string, write: (s: string) => void) => {
      write(localizeCommanderError(str));
    },
  });
}
