import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

import { ExitCode } from '../../src/cli/kernel/exit.js';

// ============================================================
// EL CONTRATO DE CÓDIGOS DE SALIDA, UN PISO MÁS ABAJO
//
// La batería hermana (codigos-de-salida.spec.ts) cubre la capa de
// COMMANDER: bandera inexistente, subcomando inexistente, --help. Esa
// capa quedó entera. Lo que esta batería vigila es lo que pasa DESPUÉS
// de que commander aceptó la invocación y la acción de la hoja corre.
//
// Ahí había una clase entera rota. El catch canónico de una hoja era:
//
//     } catch (err) {
//       reportError(err);
//       await shutdown(1);        // ← aquí muere el contrato
//     }
//
// Con ese `1` fijo, TODO el trabajo de exit.ts se tiraba en la última
// línea: un CliError construido con notFound() (3) o usageError() (2)
// llegaba al catch con su código puesto y salía por la puerta como un
// 1 genérico. El reparto delataba la clase — 51 sitios aplastando
// contra 31 preservando, y familias enteras (webhooks, memory, skills,
// jobs, approvals, compact) sin un solo `exitCodeFor`.
//
// El caso que más dolía era `lang`: el `throw new Error(...)` de un
// idioma no soportado vivía TRES LÍNEAS debajo del addHelpText con los
// ejemplos, y salía 1 donde el contrato promete 2.
//
// La forma de esta batería no es negociable, y es la misma que la de su
// hermana: LANZA EL BINARIO DE VERDAD como proceso hijo y lee `status`.
// Un doble de `shutdown` probaría que la hoja LLAMA a exitCodeFor, no
// que el proceso SALE con el número — que es lo único que ve el guion
// que encadena `mnemosine` con `&&` o que un runner de CI mira.
// ============================================================

const RAIZ_REPO = path.join(__dirname, '..', '..');
const TSX = path.join(RAIZ_REPO, 'node_modules', '.bin', 'tsx');
const CLI = path.join(RAIZ_REPO, 'src', 'cli', 'mnemosine.ts');

/**
 * El CLI real, con HOME vacío y base inalcanzable: la máquina de un
 * primer día. stdin cerrado para que nada interactivo cuelgue.
 *
 * La base INALCANZABLE está puesta a propósito y es media prueba: todos
 * los casos de la batería resuelven su veredicto ANTES de tocar la base,
 * así que si alguien reordenase una hoja para consultar la base primero,
 * el código pasaría a 1 (ECONNREFUSED no es un CliError) y esto se
 * pondría rojo en vez de pasar apoyado en la base de quien lo corra.
 */
function corre(args: string[]): { status: number; stdout: string; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-hoja-'));
  try {
    const env = { ...process.env };
    delete env.MNEMOSINE_TENANT;
    delete env.MNEMOSINE_ENTITY;
    delete env.MNEMOSINE_LANG;
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

interface Caso {
  args: string[];
  codigo: number;
  /** Fragmento que debe seguir apareciendo: fija QUÉ error es, no sólo su número. */
  dice: string;
  porque: string;
}

// Los códigos de la batería son deliberadamente DIVERSOS (0, 1, 2 y 3).
// Un mutante perezoso que devolviese siempre el mismo número —el 1 de
// antes, o un 2 para todo— moriría por las filas de los otros tres.
const BATERIA: Caso[] = [
  // ── USAGE (2): la hoja rechaza lo que el usuario escribió ──
  {
    args: ['lang', 'klingon'],
    codigo: ExitCode.USAGE,
    dice: 'Unsupported language',
    porque: 'un idioma que no existe es error de USO, no un fallo genérico',
  },
  {
    args: ['idioma', 'klingon'],
    codigo: ExitCode.USAGE,
    dice: 'Unsupported language',
    porque: 'el alias castellano sale por el mismo número que su hoja inglesa',
  },
  {
    args: ['usage', '--since', '7w'],
    codigo: ExitCode.USAGE,
    dice: 'Invalid --since',
    porque: 'una ventana mal escrita la rechaza el parser de la hoja, no commander',
  },
  {
    args: ['usage', '--by', 'nonsense'],
    codigo: ExitCode.USAGE,
    dice: 'Invalid --by',
    porque: 'una dimensión de agrupación fuera del vocabulario',
  },
  {
    args: ['webhooks', 'create', 'x', '--source', 'carrier-pigeon'],
    codigo: ExitCode.USAGE,
    dice: 'Invalid --source',
    porque: 'la familia webhooks entera no tenía un solo exitCodeFor',
  },
  {
    args: ['webhooks', 'deliveries', '--limit', '0'],
    codigo: ExitCode.USAGE,
    dice: 'Invalid --limit',
    porque: 'un límite no positivo se rechaza antes de abrir la base',
  },
  {
    args: ['completion', 'bogusshell'],
    codigo: ExitCode.USAGE,
    dice: 'unknown shell',
    porque: 'otra familia entera de *-command.ts que resuelve su veredicto sin abrir la base',
  },
  {
    args: ['onboard', '-p', 'contalink', '--cutoff', 'notadate'],
    codigo: ExitCode.USAGE,
    dice: '--cutoff must be YYYY-MM-DD',
    porque: 'onboard ya preservaba el código; lo que faltaba era que el throw lo llevase',
  },

  // ── NOT_FOUND (3): lo que se nombró no está ──
  {
    args: ['skills', 'view', 'no-such-skill'],
    codigo: ExitCode.NOT_FOUND,
    dice: 'No skill named',
    porque: 'la negativa uniforme del almacén es, en la frontera del CLI, un 3',
  },
  {
    args: ['skills', 'view', '../../etc/passwd'],
    codigo: ExitCode.NOT_FOUND,
    dice: 'No skill named',
    porque: 'un nombre con travesía de rutas sale por la MISMA puerta: ni 1 genérico ni 2 de uso',
  },

  // ── OK (0): el mismo camino, sin error ──
  {
    args: ['lang'],
    codigo: ExitCode.OK,
    dice: 'Agent response language',
    porque: 'la hoja que acabamos de tocar sigue saliendo 0 cuando no falla nada',
  },

  // ── FAILURE (1): sigue siendo 1 lo que de verdad es genérico ──
  //
  // Esta fila es la que impide "arreglar" el contrato subiendo números a
  // ciegas. `sessions` sí toca la base; con la base caída el error no es
  // un CliError con código propio sino una conexión rechazada, y
  // exitCodeFor le da FAILURE. Que siga siendo 1 es parte del contrato.
  {
    args: ['sessions'],
    codigo: ExitCode.FAILURE,
    dice: 'ECONNREFUSED',
    porque: 'exitCodeFor da 1 a lo que no es CliError — la conversión es segura por construcción',
  },
];

describe('el binario sale con el código del contrato TAMBIÉN cuando la acción de la hoja falla', () => {
  it.each(BATERIA)(
    'mnemosine $args → $codigo ($porque)',
    ({ args, codigo, dice }) => {
      const r = corre(args);
      const donde = `stderr:\n${r.stderr.slice(0, 600)}\nstdout:\n${r.stdout.slice(0, 600)}`;
      expect(r.status, donde).toBe(codigo);
      expect(r.stdout + r.stderr, donde).toContain(dice);
    },
    90_000
  );
});


// ============================================================
// EL CENSO ESTÁTICO: la CLASE entera, no la muestra
//
// La batería de arriba prueba doce invocaciones. La clase tiene 85
// sitios. Un trinquete que sólo buscase `shutdown(1)` literal dejaría
// vivo el mutante que de verdad importa: cambiar `exitCodeFor(err)` por
// `ExitCode.FAILURE` en CUALQUIERA de las 33 hojas que la batería no
// visita. Se lee como una decisión, hace exactamente el daño de antes, y
// un grep de `shutdown(1)` no lo ve.
//
// Así que el censo no busca un texto: PARSEA. Con el compilador de
// TypeScript recorre `src/cli`, entra en cada CatchClause y anota el
// argumento de cada `shutdown(...)` que hay dentro. Sin heurísticas de
// llaves ni de sangría: lo que cuenta es el árbol, así que una llave
// dentro de una plantilla o un comentario no lo descuadra.
//
// La regla es entonces exacta: dentro de un catch, `shutdown` se llama
// con `exitCodeFor(...)` — salvo las doce excepciones de abajo, que se
// nombran una por una con su razón. Añadir una decimotercera pone esto
// rojo, que es justo lo que se quiere: una salida de error con número
// fijo se discute, no se cuela.
// ============================================================

describe('el censo: dentro de un catch, el código sale de exitCodeFor', () => {
  const DIR = path.join(RAIZ_REPO, 'src', 'cli');

  function fuentes(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...fuentes(p));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out.sort();
  }

  interface Sitio {
    archivo: string;
    linea: number;
    arg: string;
  }

  /** Cada `shutdown(...)` que vive dentro de un `catch`, con su argumento textual. */
  function censar(): Sitio[] {
    const sitios: Sitio[] = [];
    for (const archivo of fuentes(DIR)) {
      const src = ts.createSourceFile(
        archivo,
        fs.readFileSync(archivo, 'utf-8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visita = (n: ts.Node, dentroDeCatch: boolean): void => {
        if (ts.isCatchClause(n)) {
          ts.forEachChild(n.block, (h) => visita(h, true));
          return;
        }
        if (dentroDeCatch && ts.isCallExpression(n)) {
          const llamado = n.expression.getText(src);
          if (llamado === 'shutdown' || llamado.endsWith('.shutdown')) {
            sitios.push({
              archivo: path.relative(DIR, archivo),
              linea: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1,
              arg: n.arguments.map((a) => a.getText(src)).join(', '),
            });
          }
        }
        ts.forEachChild(n, (h) => visita(h, dentroDeCatch));
      };
      ts.forEachChild(src, (h) => visita(h, false));
    }
    return sitios;
  }

  /**
   * Las ÚNICAS salidas de un catch que no pasan por exitCodeFor. Las doce
   * están en el mismo archivo y cada una tiene su porqué escrito al lado
   * en el fuente. Si mañana hay una más, esta lista lo dice antes que el
   * usuario.
   */
  const EXCEPCIONES: Record<string, { arg: string; veces: number; porque: string }[]> = {
    'mnemosine.ts': [
      {
        arg: '130',
        veces: 7,
        porque:
          'Ctrl+C. Van todas guardadas por `if (isInterrupt(err))` y la línea siguiente ' +
          'sigue siendo exitCodeFor: no es un código fijo para el error, es la convención ' +
          'de señal (128+SIGINT) que exit.ts publica como INTERRUPTED.',
      },
      {
        arg: 'ExitCode.FAILURE',
        veces: 2,
        porque:
          'arranque de chat sobre máquina rota y sobre máquina sin configurar por tubería. ' +
          'Agrupan causas de entorno que no comparten remedio; inventarles un 2 o un 5 sería ' +
          'mentir con más precisión. Escrito FAILURE y no 1 para que se lea como decisión.',
      },
      {
        arg: '0',
        veces: 2,
        porque:
          'el rescate del primer día: el usuario declinó el asistente o no quiso seguir a chat. ' +
          'No falló nada, así que no hay código de fallo que preservar.',
      },
      {
        arg: 'err.codigo',
        veces: 1,
        porque:
          'SalidaDeCommander ya trae el código que commander decidió (2 de uso, 0 de --help). ' +
          'Pasarlo por exitCodeFor lo aplastaría a 1: es el único sitio donde NO usarlo es lo correcto.',
      },
    ],
  };

  const censo = censar();

  it('el censo encuentra la clase entera (y no pasa en verde sobre cero)', () => {
    // Si un refactor rompiese el recorrido y `censar()` devolviese poco o
    // nada, las dos comprobaciones de abajo pasarían sobre el vacío. Este
    // piso lo impide: hoy son 85 sitios en 34 archivos.
    const archivos = new Set(censo.map((s) => s.archivo));
    expect(censo.length).toBeGreaterThanOrEqual(85);
    expect(archivos.size).toBeGreaterThanOrEqual(30);
  });

  it('ningún catch de src/cli sale con un código fijo sin declararlo', () => {
    const esperado: string[] = [];
    for (const [archivo, filas] of Object.entries(EXCEPCIONES)) {
      for (const f of filas) for (let i = 0; i < f.veces; i++) esperado.push(`${archivo}: shutdown(${f.arg})`);
    }
    const encontrado = censo
      .filter((s) => !/^exitCodeFor\(/.test(s.arg))
      .map((s) => `${s.archivo}: shutdown(${s.arg})`);

    const detalle = censo
      .filter((s) => !/^exitCodeFor\(/.test(s.arg))
      .map((s) => `${s.archivo}:${s.linea}: shutdown(${s.arg})`)
      .join('\n');
    expect(encontrado.slice().sort(), detalle).toEqual(esperado.slice().sort());
  });

  it('todo lo demás —73 sitios— pasa por exitCodeFor', () => {
    const conservan = censo.filter((s) => /^exitCodeFor\(/.test(s.arg));
    expect(conservan.length).toBeGreaterThanOrEqual(73);
    // Y ninguna familia se queda entera fuera: las que el reparto delataba
    // (webhooks, memory, skills, jobs, approvals, compact) tienen que
    // aparecer, porque antes tenían CERO.
    const familias = ['webhooks-command.ts', 'memory-command.ts', 'skills-command.ts',
      'jobs-command.ts', 'approvals-command.ts', 'compact-command.ts'];
    for (const f of familias) {
      expect(conservan.some((s) => s.archivo === f), `${f} no conserva ningún código`).toBe(true);
    }
  });
});

// ── El trinquete literal: no vuelve el `1` a mano ────────────────────
//
// El censo de arriba cubre los catch. Este cubre el resto del archivo:
// en `src/cli` no queda un solo `shutdown(1)` literal, ni dentro ni
// fuera de un catch. Un fallo de verdad genérico se escribe
// `shutdown(ExitCode.FAILURE)`, que se lee como una decisión y no como
// un descuido — y hay tres así (arranque de máquina rota, máquina sin
// configurar por tubería, y OIDC sin configurar), cada uno con su razón
// escrita al lado.
describe('el trinquete: ninguna hoja aplasta el código a 1 a mano', () => {
  const DIR = path.join(RAIZ_REPO, 'src', 'cli');

  function fuentes(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...fuentes(p));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out.sort();
  }

  it('no queda ningún shutdown(1) literal en src/cli', () => {
    const culpables: string[] = [];
    for (const archivo of fuentes(DIR)) {
      const texto = fs.readFileSync(archivo, 'utf-8').split('\n');
      texto.forEach((linea, i) => {
        if (/shutdown\(\s*1\s*\)/.test(linea)) {
          culpables.push(`${path.relative(RAIZ_REPO, archivo)}:${i + 1}: ${linea.trim()}`);
        }
      });
    }
    expect(culpables, culpables.join('\n')).toEqual([]);
  });

  it('el archivo que más aplastaba (mnemosine.ts) declara sus tres FAILURE a propósito', () => {
    const texto = fs.readFileSync(path.join(DIR, 'mnemosine.ts'), 'utf-8');
    const deliberados = texto.match(/shutdown\(ExitCode\.FAILURE\)/g) ?? [];
    expect(deliberados).toHaveLength(3);
  });
});
