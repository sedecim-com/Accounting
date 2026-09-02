import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';

import { ExitCode } from '../../src/cli/kernel/exit.js';
import { program, codigoDeSalidaDeCommander } from '../../src/cli/mnemosine.js';

// ============================================================
// EL CONTRATO DE CÓDIGOS DE SALIDA, EN LOS ERRORES DE COMMANDER
//
// exit.ts publica trece códigos, y hasta esta pieza había DOCE caminos
// que no pasaban por él: todo error de USO —subcomando inexistente,
// bandera mal escrita, argumento faltante, opción obligatoria sin
// valor— moría en el `process.exit(1)` que commander lleva dentro.
// Dos daños:
//   · el código era 1 donde el contrato promete 2 (USAGE), así que un
//     guion no podía distinguir un dedazo de un fallo real; y
//   · el proceso se iba SIN pasar por shutdown(): sin drenar las
//     atestaciones en vuelo ni cerrar el pool.
//
// Lo que arregla eso es `program.exitOverride()`. Lo que lo MANTIENE
// arreglado es la batería de abajo, y su forma no es negociable:
// LANZA EL BINARIO DE VERDAD como proceso hijo y lee `status`. Un
// doble de `process.exit` probaría que el traductor devuelve 2 y no
// que el proceso sale con 2, que es lo único que un guion ve.
//
// La trampa que esta batería vigila de cerca: exitOverride TAMBIÉN
// dispara en --help y --version, que son salidas de ÉXITO. Mandarlas a
// 2 rompería todo guion que pida ayuda antes de decidir, y sería un
// fallo invisible en la prueba de los errores.
// ============================================================

const RAIZ_REPO = path.join(__dirname, '..', '..');
const TSX = path.join(RAIZ_REPO, 'node_modules', '.bin', 'tsx');
const CLI = path.join(RAIZ_REPO, 'src', 'cli', 'mnemosine.ts');

/**
 * El CLI real, con HOME vacío y base inalcanzable: lo que ve un usuario el
 * primer día. stdin cerrado para que nada interactivo pueda colgar.
 *
 * Ninguna de las invocaciones de esta batería llega a tocar la base —todas
 * mueren en el parseo o imprimen ayuda— pero la URL inalcanzable está puesta
 * a propósito: si alguna empezara a conectarse, el código cambiaría y la
 * prueba lo diría en vez de pasar apoyada en la base de quien la corre.
 */
/**
 * Tope para toda prueba que LANZA EL BINARIO como proceso hijo.
 *
 * Cada `corre()` arranca un `tsx` entero: en esta máquina tarda ~3 s y en el
 * corredor de CI bastante más. El tope por omisión de vitest son 5 000 ms, así
 * que una prueba con dos invocaciones —`completion bash` y `completion zsh`—
 * revienta por tiempo en CI mientras pasa en local. La batería `it.each` de
 * abajo ya llevaba su tope de 60 s; sus cuatro hermanas, que lanzan el mismo
 * proceso hijo veinte líneas más abajo, no. Se arregla la CLASE: el tope vive
 * en una constante y lo lleva TODA prueba que lance el binario, para que la
 * siguiente que se escriba lo herede en vez de volver a descubrirlo en rojo.
 */
const LANZA_EL_BINARIO = 60_000;

function corre(args: string[]): { status: number; stdout: string; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-exit-'));
  try {
    const env = { ...process.env };
    delete env.MNEMOSINE_TENANT;
    delete env.MNEMOSINE_ENTITY;
    const r = spawnSync(TSX, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: RAIZ_REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: {
        ...env,
        HOME: home,
        DATABASE_URL: 'postgresql://127.0.0.1:1/inalcanzable',
        MNEMOSINE_NO_BANNER: '1',
        NO_COLOR: '1',
      },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ── Los códigos de commander, enumerados de su propio fuente ─────────
//
// Escribirlos a mano sería inventar la lista que esta prueba existe para
// comprobar: si commander añade un `err.code` en una versión nueva, una lista
// escrita a mano lo ignoraría en silencio y el código nuevo saldría por el
// `return` genérico del traductor sin que nadie se enterase.
function codigosDeCommander(): string[] {
  const dir = path.join(RAIZ_REPO, 'node_modules', 'commander', 'lib');
  const encontrados = new Set<string>();
  for (const archivo of fs.readdirSync(dir)) {
    if (!archivo.endsWith('.js')) continue;
    const fuente = fs.readFileSync(path.join(dir, archivo), 'utf-8');
    for (const m of fuente.matchAll(/'(commander\.[a-zA-Z]+)'/g)) encontrados.add(m[1]);
  }
  return [...encontrados].sort();
}

/** Los tres que NO son un error: la ayuda (dos caminos) y la versión. */
const EXITO = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

describe('el traductor: qué código del contrato le toca a cada salida de commander', () => {
  const codigos = codigosDeCommander();

  it('la enumeración sale del fuente de commander y no está vacía', () => {
    // Si el escaneo dejara de encontrar nada (commander reorganiza lib/,
    // minifica, cambia de comillas), las dos pruebas de abajo pasarían
    // vacuamente sobre cero códigos. Ésta es la que lo impide.
    expect(codigos.length).toBeGreaterThanOrEqual(10);
    expect(codigos).toEqual(expect.arrayContaining([...EXITO]));
    expect(codigos).toContain('commander.unknownOption');
  });

  it('todo código que commander puede emitir cae en la tabla publicada de exit.ts', () => {
    const publicados = new Set<number>(Object.values(ExitCode));
    for (const code of codigos) {
      expect(publicados, `${code} salió de la tabla`).toContain(
        codigoDeSalidaDeCommander({ code, exitCode: 1 })
      );
    }
  });

  it('la ayuda y la versión son ÉXITO (0), y todo lo demás es USAGE (2)', () => {
    for (const code of codigos) {
      const esperado = EXITO.has(code) ? ExitCode.OK : ExitCode.USAGE;
      expect(codigoDeSalidaDeCommander({ code, exitCode: 0 }), code).toBe(esperado);
    }
  });

  it('la ayuda pedida A RAÍZ de un fallo no se disfraza de éxito', () => {
    // `mnemosine help nosuchcmd` imprime la ayuda en stderr y sale != 0:
    // commander lo marca `commander.help`, pero es un uso mal escrito.
    expect(codigoDeSalidaDeCommander({ code: 'commander.help', exitCode: 1 })).toBe(
      ExitCode.USAGE
    );
    expect(codigoDeSalidaDeCommander({ code: 'commander.help', exitCode: 0 })).toBe(ExitCode.OK);
  });
});

describe('el árbol no tiene subcomandos EJECUTABLES', () => {
  // El único `err.code` de commander que no es una salida del proceso es
  // `commander.executeSubCommandAsync`: el cierre de un subcomando lanzado
  // con spawn, cuyo código es el del hijo y no un código de uso. El traductor
  // lo manda a USAGE porque en este árbol no puede dispararse — y eso es lo
  // que fija esta prueba. Si alguien registra el primer subcomando ejecutable
  // (`.command('foo', 'descripción')`), esto se pone rojo y hay que darle su
  // rama al traductor en vez de descubrirlo en producción.
  it('ninguna hoja se declara con la forma ejecutable de .command()', () => {
    const ejecutables: string[] = [];
    const recorre = (cmd: Command, ruta: string[]): void => {
      // `_executableHandler` es el único testigo de esa forma y commander no
      // lo publica; el molde nombra exactamente el campo que se lee.
      if ((cmd as unknown as { _executableHandler?: boolean })._executableHandler) {
        ejecutables.push(ruta.join(' '));
      }
      for (const h of cmd.commands as Command[]) recorre(h, [...ruta, h.name()]);
    };
    recorre(program, []);
    expect(ejecutables).toEqual([]);
  });
});

// ── La batería: el binario de verdad, y su código de salida ──────────

interface Caso {
  args: string[];
  codigo: number;
  porque: string;
}

const BATERIA: Caso[] = [
  // Éxitos. Van primero porque son los que un cambio descuidado rompe.
  { args: ['--help'], codigo: ExitCode.OK, porque: 'commander.helpDisplayed en la raíz' },
  { args: ['-h'], codigo: ExitCode.OK, porque: 'la forma corta hace lo mismo' },
  { args: ['--version'], codigo: ExitCode.OK, porque: 'commander.version' },
  { args: ['-V'], codigo: ExitCode.OK, porque: 'la forma corta de la versión' },
  { args: ['help'], codigo: ExitCode.OK, porque: 'el comando help implícito' },
  { args: ['help', 'report'], codigo: ExitCode.OK, porque: 'help de una familia' },
  { args: ['report', '--help'], codigo: ExitCode.OK, porque: 'ayuda un nivel abajo' },
  {
    args: ['entity', 'list', '--help'],
    codigo: ExitCode.OK,
    porque: 'ayuda dos niveles abajo: la herencia de exitOverride llega al fondo',
  },
  { args: ['completion', 'bash'], codigo: ExitCode.OK, porque: 'una hoja que sí corre' },

  // Errores de uso. Los ocho caminos que commander decidía por su cuenta.
  {
    args: ['nosuchcommand'],
    codigo: ExitCode.USAGE,
    porque: 'token desconocido en la raíz (la compuerta previa al parseo)',
  },
  {
    args: ['report', 'nosuchsub'],
    codigo: ExitCode.USAGE,
    porque: 'commander.unknownCommand un nivel abajo',
  },
  { args: ['report', '--nosuchflag'], codigo: ExitCode.USAGE, porque: 'commander.unknownOption' },
  {
    args: ['entity', 'list', '--nosuch'],
    codigo: ExitCode.USAGE,
    porque: 'bandera desconocida dos niveles abajo',
  },
  { args: ['--nosuchglobal'], codigo: ExitCode.USAGE, porque: 'bandera desconocida en la raíz' },
  { args: ['ingest'], codigo: ExitCode.USAGE, porque: 'commander.missingArgument' },
  { args: ['onboard'], codigo: ExitCode.USAGE, porque: 'commander.missingMandatoryOptionValue' },
  { args: ['sessions', '-n'], codigo: ExitCode.USAGE, porque: 'commander.optionMissingArgument' },
  {
    args: ['sessions', '-n', 'abc'],
    codigo: ExitCode.USAGE,
    porque: 'commander.invalidArgument (el parser de -n rechaza el valor)',
  },
  { args: ['entities', 'sobra'], codigo: ExitCode.USAGE, porque: 'commander.excessArguments' },
  {
    args: ['help', 'nosuchcmd'],
    codigo: ExitCode.USAGE,
    porque: 'commander.help con código != 0: ayuda a raíz de un fallo',
  },
  {
    args: ['completion'],
    codigo: ExitCode.USAGE,
    porque: 'el usageError que la propia hoja lanza sale por el mismo número',
  },
  { args: ['completion', 'fish'], codigo: ExitCode.USAGE, porque: 'un shell que no existe' },
];

describe('el binario de verdad sale con el código del contrato', () => {
  it.each(BATERIA)(
    'mnemosine $args → $codigo ($porque)',
    ({ args, codigo }) => {
      const r = corre(args);
      expect(r.status, `stderr:\n${r.stderr}\nstdout:\n${r.stdout.slice(0, 400)}`).toBe(codigo);
    },
    LANZA_EL_BINARIO
  );

  it('el mensaje de commander se imprime UNA vez y sin remedio inventado', () => {
    const r = corre(['report', '--nosuchflag']);
    expect(r.status).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain("unknown option '--nosuchflag'");
    // commander escribe su línea ANTES de salir. Si el catch de la entrada
    // volviera a pasarla por reportError, saldría dos veces y encima con el
    // texto interno del envoltorio.
    expect(r.stderr.match(/unknown option/g)).toHaveLength(1);
    expect(r.stderr).not.toContain('commander exit');
  }, LANZA_EL_BINARIO);

  it('--help sigue imprimiendo la ayuda en stdout, no un error en stderr', () => {
    const r = corre(['--help']);
    expect(r.status).toBe(ExitCode.OK);
    expect(r.stdout).toContain('Usage: mnemosine');
    expect(r.stderr).not.toContain('commander exit');
  }, LANZA_EL_BINARIO);
});

// ── `completion` quedó registrado y responde ─────────────────────────

describe('mnemosine completion está cableado en el programa', () => {
  it('existe como hoja de primer nivel del árbol embarcado', () => {
    const nombres = (program.commands as Command[]).map((c) => c.name());
    expect(nombres).toContain('completion');
  });

  it('genera un guion de bash que nombra el binario y sus alias españoles', () => {
    const r = corre(['completion', 'bash']);
    expect(r.status).toBe(ExitCode.OK);
    expect(r.stdout).toContain('mnemosine');
    // Un guion derivado del árbol REAL trae los alias; uno escrito a mano
    // (o generado de un árbol a medio montar) no los tendría.
    expect(r.stdout).toContain('balanza');
    // stdout es el guion y nada más: la documentación del comando promete un
    // redirect, y un banner haría el archivo insourceable.
    expect(r.stdout.split('\n')[0].startsWith('#')).toBe(true);
  }, LANZA_EL_BINARIO);

  it('zsh también, y los dos guiones son distintos', () => {
    const bash = corre(['completion', 'bash']);
    const zsh = corre(['completion', 'zsh']);
    expect(zsh.status).toBe(ExitCode.OK);
    expect(zsh.stdout).toContain('compdef');
    expect(zsh.stdout).not.toBe(bash.stdout);
  }, LANZA_EL_BINARIO);
});

// ── Las hojas de ESTE archivo, derivadas del ÁRBOL y no de su texto ──
//
// EL DEFECTO QUE ESTA SECCIÓN TUVO: el conjunto vigilado salía de correr
// /\.command\(\s*'([^']+)'/g sobre el TEXTO de mnemosine.ts. Una expresión
// regular no distingue código de comentario, y la decimoctava hoja del
// conjunto —`completion`, que en realidad registra completion-command.ts—
// entraba ÚNICAMENTE por una línea de PROSA que menciona `.command('completion')`
// al anotar una deuda. Con el aserto puesto en `>= 15` sobre 18, borrar ese
// comentario sacaba una hoja de la vigilancia y la prueba seguía verde: el
// guardián decidía a quién mirar leyendo comentarios, y tenía tres de holgura
// para no enterarse.
//
// LO QUE SE HACE AHORA es la lección del censo (censo-superficie.spec.ts):
// medir sobre el árbol. Cada uno de los demás archivos de src/cli publica su
// registrador (`registerXCommand`); se le da a cada uno una raíz VACÍA y se
// anota qué familias de primer nivel planta. Lo que está en el programa real y
// ningún registrador ajeno reclamó, lo declaró mnemosine.ts. Ningún byte de
// prosa entra en la cuenta, y el número de abajo es exacto: una hoja que
// desaparezca del conjunto pone esto rojo.

const DIR_CLI = path.join(RAIZ_REPO, 'src', 'cli');

/**
 * Dependencias de mentira para los registradores ajenos.
 *
 * En el REGISTRO nadie las usa: cada registrador las guarda en el cierre de su
 * `.action()`, que aquí no se ejecuta jamás. Aun así el apoderado responde a
 * cualquier propiedad y a cualquier llamada —para que uno que lea
 * `deps.palette.dim(...)` al montar su ayuda no se caiga— y se coacciona a
 * cadena vacía, para que tampoco se caiga el que la meta en una plantilla.
 */
const DEPS_DE_MENTIRA: unknown = new Proxy(function () {}, {
  get(_objetivo, prop) {
    if (prop === 'then') return undefined; // que nadie lo confunda con una promesa
    if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
    if (typeof prop === 'symbol') return undefined;
    return DEPS_DE_MENTIRA;
  },
  apply: () => DEPS_DE_MENTIRA,
  construct: () => DEPS_DE_MENTIRA as object,
});

/**
 * Las familias de primer nivel que plantan los DEMÁS archivos de src/cli,
 * medidas plantándolas: cada registrador exportado recibe una raíz nueva y se
 * mira qué le cuelga. Nombres y alias, porque la raíz real acepta los dos.
 */
async function familiasAjenas(): Promise<Set<string>> {
  const ajenas = new Set<string>();
  for (const archivo of fs.readdirSync(DIR_CLI).sort()) {
    if (!archivo.endsWith('.ts') || archivo === 'mnemosine.ts') continue;
    const modulo = (await import(path.join(DIR_CLI, archivo))) as Record<string, unknown>;
    for (const [exportado, valor] of Object.entries(modulo)) {
      if (!/^register[A-Z]/.test(exportado) || typeof valor !== 'function') continue;
      const raiz = new Command('mnemosine');
      (valor as (programa: Command, deps: unknown) => void)(raiz, DEPS_DE_MENTIRA);
      for (const cmd of raiz.commands as Command[]) {
        ajenas.add(cmd.name());
        for (const alias of cmd.aliases()) ajenas.add(alias);
      }
    }
  }
  return ajenas;
}

/** El texto que `addHelpText('after', …)` imprimiría; commander no lo guarda. */
function textoPosterior(cmd: Command): string {
  const trozos: string[] = [];
  const emisor = cmd as unknown as {
    emit(
      evento: string,
      contexto: { error: boolean; command: Command; write: (s: string) => void }
    ): boolean;
  };
  emisor.emit('afterHelp', {
    error: false,
    command: cmd,
    write: (s: string) => {
      trozos.push(s);
    },
  });
  return trozos.join('');
}

function hojas(cmd: Command, prefijo: string[] = []): { ruta: string; cmd: Command }[] {
  const hijos = cmd.commands as Command[];
  if (hijos.length === 0) return prefijo.length > 0 ? [{ ruta: prefijo.join(' '), cmd }] : [];
  return hijos.flatMap((h) => hojas(h, [...prefijo, h.name()]));
}

/**
 * Las hojas que mnemosine.ts declara: el número de HOY, exacto y sin holgura.
 *
 * No es una lista a mano disfrazada de número: el conjunto se deriva del árbol
 * cada vez. El número está para que la derivación no pueda encoger en silencio
 * —que es justo lo que hacía el grep sobre el texto—. Si añades una hoja a
 * mnemosine.ts, súbelo y dilo en el commit; si esto se pone rojo sin que hayas
 * tocado el árbol, es que una hoja se escapó de la vigilancia.
 */
const HOJAS_PROPIAS = 17;

describe('las hojas declaradas en mnemosine.ts enseñan ejemplos', () => {
  let AJENAS = new Set<string>();
  let MIAS: { ruta: string; cmd: Command }[] = [];

  beforeAll(async () => {
    AJENAS = await familiasAjenas();
    // Una hoja es «de este archivo» cuando la familia que la aloja no la plantó
    // ningún registrador ajeno. `entity list` no cuenta: 'entity' lo planta
    // entity-command.ts. `outbox run` sí: 'outbox' no lo reclama nadie.
    MIAS = hojas(program).filter((h) => !AJENAS.has(h.ruta.split(' ')[0]));
  });

  it('los registradores ajenos se plantaron de verdad: si no, lo de abajo no prueba nada', () => {
    // Si el escaneo dejara de encontrar registradores (src/cli se reorganiza,
    // el nombre `registerX` cambia de forma), AJENAS quedaría vacío y TODA hoja
    // del binario pasaría por propia. Esto lo dice antes que la cuenta.
    for (const familia of ['entity', 'report', 'completion', 'period', 'year']) {
      expect(AJENAS, `${familia} lo planta otro archivo de src/cli`).toContain(familia);
    }
    // Y el que entraba por un comentario ahora entra por donde se registra:
    // completion-command.ts. Es ajena, no mía.
    expect(MIAS.map((h) => h.ruta)).not.toContain('completion');
  });

  it('el filtro encuentra las hojas de este archivo: si no, lo de abajo no prueba nada', () => {
    expect(
      MIAS.map((h) => h.ruta).sort(),
      'El conjunto vigilado cambió de tamaño. Si añadiste o quitaste una hoja en ' +
        'src/cli/mnemosine.ts, ajusta HOJAS_PROPIAS y dilo en el commit. Si no tocaste el ' +
        'árbol, una hoja se salió de la vigilancia y hay que averiguar por dónde.'
    ).toHaveLength(HOJAS_PROPIAS);
    for (const esperada of ['ingest', 'review', 'drafts', 'outbox run', 'question answer']) {
      expect(MIAS.map((h) => h.ruta)).toContain(esperada);
    }
    // Y no se cuela ninguna de otro archivo.
    expect(MIAS.map((h) => h.ruta)).not.toContain('entity list');
  });

  it('todas llevan su bloque de ejemplos', () => {
    const sinEjemplos = MIAS.filter(
      (h) =>
        !textoPosterior(h.cmd)
          .split('\n')
          .some((l) => l.trim().startsWith('mnemosine '))
    ).map((h) => h.ruta);
    expect(
      sinEjemplos,
      'Una hoja sin ejemplos deja al usuario adivinando qué forma tiene el argumento. ' +
        "Añádele su addHelpText('after', EJEMPLOS.…) en src/cli/mnemosine.ts."
    ).toEqual([]);
  });

  it('cada ejemplo empieza por la ruta de la hoja que lo aloja', () => {
    const desviados: string[] = [];
    for (const h of MIAS) {
      for (const linea of textoPosterior(h.cmd).split('\n').map((l) => l.trim())) {
        if (!linea.startsWith('mnemosine ')) continue;
        if (!linea.startsWith(`mnemosine ${h.ruta}`)) desviados.push(`${h.ruta} ← ${linea}`);
      }
    }
    expect(desviados).toEqual([]);
  });
});
