import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import {
  BUILTIN_PROFILES,
  MUESTREO_CABLEADO,
  reproducibilidadDe,
} from '../../../src/ai/providers/config.js';
import { buildTools } from '../../../src/ai/tools/index.js';
import { SUPERFICIE_INGESTA } from '../../../src/ai/tools/superficie.js';
import { cargarCasosGolden, politicasRequeridas } from '../../../src/ai/eval/golden.js';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { ExitCode } from '../../../src/cli/kernel/exit.js';
import type { AgentContext } from '../../../src/ai/context.js';
import {
  codigoDeSalida,
  laCorridaMidio,
  planDePanel,
  vigilarProveedor,
  type Balance,
} from '../../../scripts/eval-clasificador.js';
import type { LlmSession } from '../../../src/ai/providers/types.js';

// ============================================================
// EL ARNÉS EXISTE Y NUNCA HA JUZGADO NADA (A7).
//
// scripts/eval-clasificador.ts eran 16 KB de arnés COMPLETO —golden set,
// clasificador por el camino real, puntuación por clase, bitácora, comparación
// contra la corrida anterior, ocultación de secretos— que no aparecía ni en
// package.json ni en .github/. Nadie lo había ejecutado nunca.
//
// Y cuando por fin se ejecutó (ollama · gemma4:26b, 2026-09-02, el caso
// pue-recibido dos veces seguidas) devolvió confianza 0.70 y luego 0.80 para la
// MISMA entrada. Las clases coincidieron por suerte. Ese es el defecto de fondo:
// el arnés compara corridas, y sin muestreo fijado dos corridas no son
// comparables ni en principio — la flecha ▲ mide ruido.
//
// Lo que este archivo vigila son las formas de que eso vuelva:
//
//  1. que el arnés se descuelgue del sitio donde se ejecuta (package.json, CI);
//  2. que un perfil se calle sobre su muestreo, o finja fijar uno que la API
//     devolvería como 400;
//  3. que la nota «esto todavía no viaja por el cable» envejezca hasta mentir;
//  4. que el arnés mida una SUPERFICIE distinta de la que se embarca;
//  5. que salga en VERDE sin haber medido;
//  6. que puntúe bajo un PANEL distinto del que el caso declara.
//
// Las tres últimas son de esta ronda, y las tres tenían la misma forma: la
// prueba comprobaba que algo EXISTÍA y nunca que hiciera lo que promete.
// ============================================================

const RAIZ_REPO = path.join(__dirname, '..', '..', '..');
const leer = (...p: string[]): string => fs.readFileSync(path.join(RAIZ_REPO, ...p), 'utf-8');

/**
 * El fuente sin comentarios. `temperature` mencionada en una explicación no es
 * `temperature` enviada en una petición, y confundirlas haría que documentar el
 * problema pusiera roja la prueba que lo vigila.
 */
function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ============================================================
// EL FUENTE SE LEE COMO ÁRBOL, NO COMO TEXTO.
//
// Una prueba que grepea `herramientas: SUPERFICIE_INGESTA` bendice al mutante
// que la deja dentro de un comentario, y una que grepea `run: npm run eval`
// bendice al que pone `if: false` encima. Las dos son la misma forma: se
// comprueba que un texto ESTÁ, nunca que la construcción HAGA algo. Aquí se
// parsea con el compilador de TypeScript, que es el que decide de verdad.
// ============================================================

function fuenteDe(...rel: string[]): ts.SourceFile {
  return ts.createSourceFile(
    path.join(...rel),
    leer(...rel),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true
  );
}

function recorrer(nodo: ts.Node, visitar: (n: ts.Node) => void): void {
  visitar(nodo);
  nodo.forEachChild((h) => recorrer(h, visitar));
}

/** Toda llamada a `nombre(...)` o `algo.nombre(...)` del archivo. */
function llamadasA(sf: ts.SourceFile, nombre: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  recorrer(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression;
    const id = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    if (id === nombre) out.push(n);
  });
  return out;
}

/** Nombres que el archivo LIGA desde un módulo, por import estático o dinámico. */
function nombresLigadosDe(sf: ts.SourceFile, sufijoModulo: string): string[] {
  const nombres: string[] = [];
  const casa = (especificador: string): boolean => especificador.includes(sufijoModulo);
  recorrer(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && casa(n.moduleSpecifier.text)) {
      const b = n.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) for (const e of b.elements) nombres.push(e.name.text);
    }
    // `const { X } = await import('…')`
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      ts.isAwaitExpression(n.initializer) &&
      ts.isCallExpression(n.initializer.expression) &&
      n.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = n.initializer.expression.arguments[0];
      if (arg && ts.isStringLiteral(arg) && casa(arg.text) && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) nombres.push(el.name.text);
      }
    }
  });
  return nombres;
}

/** El identificador que una llamada a createLlmSession pasa como `herramientas`. */
function superficieDeLaSesion(llamada: ts.CallExpression, sf: ts.SourceFile): string | null {
  const opciones = llamada.arguments[3];
  if (!opciones || !ts.isObjectLiteralExpression(opciones)) return null;
  for (const p of opciones.properties) {
    const nombre =
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (nombre !== 'herramientas') continue;
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
    if (!ts.isPropertyAssignment(p)) return `«forma no reconocida: ${ts.SyntaxKind[p.kind]}»`;
    return p.initializer.getText(sf);
  }
  return null;
}

/** La función que contiene al nodo (la hoja de un comando, el cuerpo de main…). */
function funcionQueContiene(n: ts.Node): ts.Node | undefined {
  let p: ts.Node | undefined = n.parent;
  while (p && !ts.isFunctionLike(p)) p = p.parent;
  return p;
}

function contieneLlamadaA(nodo: ts.Node, nombre: string): boolean {
  let encontrada = false;
  recorrer(nodo, (n) => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression;
    const id = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    if (id === nombre) encontrada = true;
  });
  return encontrada;
}

/** El `if` más cercano que envuelve al nodo, y en cuál de sus dos ramas cae. */
function condicionQueGobierna(
  n: ts.Node,
  sf: ts.SourceFile
): { expresion: string; rama: 'then' | 'else' } | null {
  let hijo: ts.Node = n;
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (ts.isIfStatement(p)) {
      // El nodo puede colgar de la condición misma; eso no es una rama.
      if (hijo === p.thenStatement) return { expresion: p.expression.getText(sf), rama: 'then' };
      if (hijo === p.elseStatement) return { expresion: p.expression.getText(sf), rama: 'else' };
    }
    hijo = p;
    p = p.parent;
  }
  return null;
}

/** ¿El nodo vive dentro del bloque `finally` de algún `try`? */
function dentroDeUnFinally(n: ts.Node): boolean {
  let hijo: ts.Node = n;
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (ts.isTryStatement(p) && p.finallyBlock === hijo) return true;
    hijo = p;
    p = p.parent;
  }
  return false;
}

const ARNES = ['scripts', 'eval-clasificador.ts'];
const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Eval clasificador',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'XAXX010101000',
};

// ============================================================
// UN PARSER DE YAML DEL SUBCONJUNTO QUE ESTE ARCHIVO DE CI USA.
//
// No es un capricho: la prueba anterior comprobaba el paso del eval con
// `expect(ci).toMatch(/^\s*run: npm run eval …$/m)`, y un adversario cambió el
// `if:` de ese paso a `if: false` sin producir UN SOLO ROJO — la línea del
// `run` seguía en el archivo y la subcadena `id: credencial` seguía en los
// otros pasos. El arnés quedaba descolgado de CI, que es EL defecto que la
// pieza decía cerrar. Un `[ -n … ]` invertido a `[ -z … ]` pasaba igual.
//
// Comprender el YAML es lo que convierte «el paso EXISTE» en «el paso es
// ALCANZABLE». Y para no cambiar un ciego por otro, este parser LANZA ante
// cualquier construcción que no entienda: prefiere romperse a adivinar.
// ============================================================

type NodoYaml = string | NodoYaml[] | { [clave: string]: NodoYaml };

function parsearYaml(texto: string): NodoYaml {
  const lineas = texto.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const vacia = (l: string): boolean => l.trim() === '' || /^\s*#/.test(l);
  const sangria = (l: string): number => l.length - l.trimStart().length;
  const saltarVacias = (): void => {
    while (i < lineas.length && vacia(lineas[i])) i++;
  };
  const desentrecomillar = (v: string): string =>
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2) ||
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
      ? v.slice(1, -1)
      : v;

  const CLAVE = /^([^:\s][^:]*):(?:\s+(.*))?$/;

  function escalarDeBloque(estilo: string, sangriaPadre: number): string {
    const cuerpo: string[] = [];
    let sangriaBloque = -1;
    while (i < lineas.length) {
      const l = lineas[i];
      if (l.trim() === '') {
        cuerpo.push('');
        i++;
        continue;
      }
      const s = sangria(l);
      if (s <= sangriaPadre) break;
      if (sangriaBloque < 0) sangriaBloque = s;
      cuerpo.push(l.slice(sangriaBloque));
      i++;
    }
    while (cuerpo.length > 0 && cuerpo[cuerpo.length - 1] === '') cuerpo.pop();
    if (estilo.startsWith('|')) return cuerpo.join('\n') + (estilo.includes('-') ? '' : '\n');
    return cuerpo.map((s) => s.trim()).filter(Boolean).join(' ');
  }

  function valorDe(resto: string, sangriaPadre: number): NodoYaml {
    if (/^[|>][-+]?$/.test(resto)) return escalarDeBloque(resto, sangriaPadre);
    if (resto === '') {
      saltarVacias();
      if (i >= lineas.length || sangria(lineas[i]) <= sangriaPadre) return '';
      return bloque(sangria(lineas[i]));
    }
    if (resto.startsWith('[') && resto.endsWith(']')) {
      return resto
        .slice(1, -1)
        .split(',')
        .map((x) => desentrecomillar(x.trim()))
        .filter((x) => x !== '');
    }
    return desentrecomillar(resto);
  }

  function mapa(sangriaNivel: number): Record<string, NodoYaml> {
    const out: Record<string, NodoYaml> = {};
    for (;;) {
      saltarVacias();
      if (i >= lineas.length) break;
      const l = lineas[i];
      const s = sangria(l);
      if (s < sangriaNivel) break;
      if (s > sangriaNivel) throw new Error(`sangría inesperada en la línea ${i + 1}: «${l}»`);
      const cuerpo = l.trim();
      if (cuerpo.startsWith('- ') || cuerpo === '-') break;
      const m = CLAVE.exec(cuerpo);
      if (!m) throw new Error(`no sé leer la línea ${i + 1}: «${l}»`);
      i++;
      out[m[1].trim()] = valorDe((m[2] ?? '').trim(), sangriaNivel);
    }
    return out;
  }

  function secuencia(sangriaNivel: number): NodoYaml[] {
    const out: NodoYaml[] = [];
    for (;;) {
      saltarVacias();
      if (i >= lineas.length) break;
      const l = lineas[i];
      const s = sangria(l);
      if (s < sangriaNivel) break;
      if (s > sangriaNivel) throw new Error(`sangría inesperada en la línea ${i + 1}: «${l}»`);
      const cuerpo = l.trim();
      if (!cuerpo.startsWith('-')) break;
      const tras = cuerpo.slice(1);
      const desplaza = tras.length - tras.trimStart().length;
      const contenido = tras.trim();
      if (contenido === '') throw new Error(`elemento de lista vacío en la línea ${i + 1}`);
      if (CLAVE.test(contenido)) {
        // Un mapa que empieza en la misma línea del guion: se reescribe la
        // línea como si el guion no estuviera y se lee el mapa desde ahí.
        const sangriaItem = s + 1 + desplaza;
        lineas[i] = ' '.repeat(sangriaItem) + contenido;
        out.push(mapa(sangriaItem));
      } else {
        i++;
        out.push(desentrecomillar(contenido));
      }
    }
    return out;
  }

  function bloque(sangriaNivel: number): NodoYaml {
    saltarVacias();
    if (i >= lineas.length) return '';
    const l = lineas[i];
    return l.trim().startsWith('-') ? secuencia(sangriaNivel) : mapa(sangriaNivel);
  }

  saltarVacias();
  return bloque(sangria(lineas[i] ?? ''));
}

interface PasoCi {
  name?: string;
  id?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  'continue-on-error'?: string;
}

const WORKFLOW = parsearYaml(leer('.github', 'workflows', 'ci.yml')) as unknown as {
  jobs: Record<string, { name?: string; if?: string; steps: PasoCi[] }>;
};

/**
 * Ejecuta DE VERDAD el guion de un paso de CI y devuelve lo que escribió en
 * `$GITHUB_OUTPUT`. Es la diferencia entre leer la puerta y abrirla: invertir
 * el `[ -n … ]` a `[ -z … ]` cambia lo que este bash devuelve, y ninguna
 * subcadena del archivo cambia.
 */
function abrirLaPuerta(run: string, entorno: Record<string, string>): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-puerta-'));
  try {
    const salida = path.join(dir, 'github_output');
    fs.writeFileSync(salida, '');
    execFileSync('bash', ['-c', run], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: salida, ...entorno },
      stdio: 'pipe',
    });
    return Object.fromEntries(
      fs
        .readFileSync(salida, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Evalúa el `if:` de un paso contra las salidas REALES de la puerta.
 *
 * Sólo entiende la forma que este workflow usa. Cualquier otra —`false`, una
 * función de estado, una conjunción— LANZA: una condición que esta prueba no
 * sabe evaluar es una condición que no puede afirmar alcanzable, y callarse
 * ahí sería volver al ciego que esto viene a cerrar.
 */
function alcanzable(expr: string | undefined, salidas: Record<string, Record<string, string>>): boolean {
  if (expr === undefined) return true;
  const m = /^steps\.([\w-]+)\.outputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'$/.exec(expr.trim());
  if (!m) {
    throw new Error(
      `el paso está gobernado por una condición que esta prueba no sabe evaluar: «${expr}». ` +
        'Si es legítima, enseña aquí a evaluarla; mientras tanto no se puede afirmar que el paso ' +
        'sea alcanzable, y un paso inalcanzable descuelga el arnés de CI sin un solo rojo.'
    );
  }
  const valor = salidas[m[1]]?.[m[2]] ?? '';
  return m[3] === '==' ? valor === m[4] : valor !== m[4];
}

describe('el arnés está cableado donde se ejecuta', () => {
  it('package.json lo publica como `npm run eval`', () => {
    const pkg = JSON.parse(leer('package.json')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.eval).toBe('tsx scripts/eval-clasificador.ts');
  });

  it('y el guion RESPONDE cuando se le lanza como programa', () => {
    // La guarda `invocadoComoPrograma()` existe para que esta prueba pueda
    // importar las funciones puras sin montar una base de datos. Su modo de
    // fallo es catastrófico y silencioso: si dejara de casar, `npm run eval`
    // no ejecutaría NADA y saldría 0 — el arnés más verde de todos. Así que
    // aquí se lanza de verdad y se comprueba que contesta.
    let codigo = 0;
    let stderr = '';
    try {
      execFileSync(
        path.join(RAIZ_REPO, 'node_modules', '.bin', 'tsx'),
        [path.join(RAIZ_REPO, 'scripts', 'eval-clasificador.ts'), '--bandera-que-no-existe'],
        { cwd: RAIZ_REPO, stdio: 'pipe', encoding: 'utf-8' }
      );
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      codigo = e.status ?? 0;
      stderr = e.stderr ?? '';
    }
    expect(
      codigo,
      'el guion no reaccionó a un argumento inválido: o la guarda de «invocado como programa» ' +
        'dejó de casar y `npm run eval` es un no-op, o parseArgs dejó de rechazar lo desconocido'
    ).toBe(ExitCode.USAGE);
    expect(stderr).toContain('--bandera-que-no-existe');
  }, 60_000);

  it('CI corre el paso del eval, y ese paso es ALCANZABLE con credencial', () => {
    const job = WORKFLOW.jobs.eval;
    expect(job, 'el job `eval` desapareció de CI').toBeDefined();
    expect(
      job.if,
      'el job entero quedó gobernado por una condición: alcanzar sus pasos ya no depende de la puerta'
    ).toBeUndefined();

    const puerta = job.steps.find((p) => p.id === 'credencial');
    expect(puerta?.run, 'no hay paso `id: credencial` que escriba la puerta').toBeTruthy();
    // La puerta lee una variable que CI tiene que ponerle: si el `env:` deja de
    // mapear el secreto, el guion lee vacío SIEMPRE y el eval no corre nunca.
    expect(
      puerta!.env?.ANTHROPIC_API_KEY ?? '',
      'la puerta lee $ANTHROPIC_API_KEY y su `env:` dejó de mapearla del secreto: leería vacío ' +
        'SIEMPRE y el eval no correría nunca'
    ).toContain('secrets.ANTHROPIC_API_KEY');

    const paso = job.steps.find((p) => p.run === 'npm run eval -- --provider anthropic');
    expect(paso, 'ningún paso de CI ejecuta el arnés').toBeDefined();
    // Y con la credencial puesta: si no la recibe, el paso corre y revienta.
    expect(
      paso!.env?.ANTHROPIC_API_KEY ?? '',
      'el paso del eval corre sin recibir la credencial: reventaría en cada corrida'
    ).toContain('secrets.ANTHROPIC_API_KEY');
    expect(paso!.env?.TEST_ADMIN_DATABASE_URL).toBeTruthy();

    // ── LA PUERTA SE ABRE DE VERDAD, EN LOS DOS MUNDOS ──
    const conLlave = { credencial: abrirLaPuerta(puerta!.run!, { ANTHROPIC_API_KEY: 'sk-de-mentira-para-la-prueba' }) };
    const sinLlave = { credencial: abrirLaPuerta(puerta!.run!, { ANTHROPIC_API_KEY: '' }) };
    expect(conLlave.credencial, 'la puerta no escribió nada con la credencial puesta').not.toEqual(sinLlave.credencial);

    expect(
      alcanzable(paso!.if, conLlave),
      'con ANTHROPIC_API_KEY presente el paso del eval NO se ejecuta: el arnés está descolgado de CI'
    ).toBe(true);
    expect(
      alcanzable(paso!.if, sinLlave),
      'sin credencial el paso del eval se ejecutaría igual y reventaría en cada fork'
    ).toBe(false);
  });

  it('el salto por falta de credencial es EXPLÍCITO, y ocurre justo cuando no hay llave', () => {
    const job = WORKFLOW.jobs.eval;
    const puerta = job.steps.find((p) => p.id === 'credencial')!;
    const conLlave = { credencial: abrirLaPuerta(puerta.run!, { ANTHROPIC_API_KEY: 'sk-de-mentira-para-la-prueba' }) };
    const sinLlave = { credencial: abrirLaPuerta(puerta.run!, { ANTHROPIC_API_KEY: '' }) };

    // El anuncio: un job que se salta sin decirlo es indistinguible de un job
    // que corrió y pasó, que es justo la mentira que esto viene a cerrar.
    const aviso = job.steps.find((p) => (p.run ?? '').includes('::warning title=Eval del clasificador SALTADO'));
    expect(aviso, 'el aviso de SALTADO desapareció: la casilla verde diría «el clasificador se midió»').toBeDefined();
    expect(alcanzable(aviso!.if, sinLlave), 'sin credencial el aviso NO se imprime').toBe(true);
    expect(alcanzable(aviso!.if, conLlave), 'con credencial el aviso se imprimiría igual y mentiría').toBe(false);

    // LA CLASE, NO LA INSTANCIA: ningún paso que gaste (npm, migrate, el eval)
    // puede correr sin llave, y ningún paso puede comprarse el verde.
    for (const p of job.steps) {
      expect(p['continue-on-error'], `el paso «${p.name ?? p.run ?? p.uses}» pinta de verde lo que falle`).toBeUndefined();
      if ((p.run ?? '').startsWith('npm ')) {
        expect(alcanzable(p.if, sinLlave), `«${p.run}» correría sin credencial`).toBe(false);
        expect(alcanzable(p.if, conLlave), `«${p.run}» no correría ni con credencial`).toBe(true);
      }
    }
    // Y en el mundo sin llave algo TIENE que correr: el anuncio. Un job que no
    // ejecuta ni un paso y sale verde es el silencio que esto prohíbe.
    expect(job.steps.filter((p) => alcanzable(p.if, sinLlave)).length).toBeGreaterThan(0);
  });

  it('y sus precedentes siguen ahí: si alguien rehace el archivo, que se vea', () => {
    const ci = leer('.github', 'workflows', 'ci.yml');
    expect(ci).toContain('npx tsx scripts/catalogo-estado.ts --check');
    expect(ci).toContain('npx tsx scripts/corpus-manifiesto.ts --check');
  });
});

describe('el arnés mide la superficie que se EMBARCA, no una más ancha', () => {
  it('la sesión del arnés pasa una lista, y es la MISMA constante que la ingesta', () => {
    const arnes = fuenteDe(...ARNES);
    const llamadas = llamadasA(arnes, 'createLlmSession');
    expect(llamadas.length, 'el arnés dejó de abrir sesión propia').toBeGreaterThan(0);

    // LA CLASE: TODAS las sesiones que el arnés abra, no la primera.
    const superficies = llamadas.map((l) => superficieDeLaSesion(l, arnes));
    for (const s of superficies) {
      expect(
        s,
        'una llamada a createLlmSession del arnés no pasa `herramientas`: buildTools sin lista ' +
          'devuelve las 25 herramientas y el arnés vuelve a medir un clasificador que nadie embarca'
      ).toBe('SUPERFICIE_INGESTA');
    }
    // Importada, no copiada: un array literal aquí divergiría en el primer diff.
    expect(nombresLigadosDe(arnes, 'ai/tools/superficie')).toContain('SUPERFICIE_INGESTA');

    // Y la hoja que SE EMBARCA usa esa misma constante. Se localiza por lo que
    // HACE —la función que abre la sesión y además llama a ingestCfdiFiles—,
    // no por el número de línea ni por un comentario.
    const cli = fuenteDe('src', 'cli', 'mnemosine.ts');
    const hojasDeIngesta = llamadasA(cli, 'createLlmSession').filter((l) => {
      const fn = funcionQueContiene(l);
      return fn !== undefined && contieneLlamadaA(fn, 'ingestCfdiFiles');
    });
    expect(hojasDeIngesta.length, 'no encuentro la hoja de `mnemosine ingest` en el CLI').toBe(1);
    expect(superficieDeLaSesion(hojasDeIngesta[0], cli)).toBe('SUPERFICIE_INGESTA');
  });

  it('y esa superficie son ONCE herramientas, no veinticinco', () => {
    const todas = buildTools(CTX, { model: 'claude-opus-5' }).map((t) => t.name);
    const ingesta = buildTools(CTX, { model: 'claude-opus-5' }, SUPERFICIE_INGESTA).map((t) => t.name);
    expect(todas).toHaveLength(25);
    expect(ingesta).toHaveLength(11);
    expect([...ingesta].sort()).toEqual([...SUPERFICIE_INGESTA].sort());

    // Las catorce que el arnés medía de más, nombradas. Están en la superficie
    // completa (por eso el defecto era invisible) y fuera de la ingesta.
    const deMas = [
      'external_pull', 'external_push', 'external_diff_trial_balance', 'list_external_ops',
      'get_trial_balance', 'get_balance_sheet', 'get_income_statement', 'get_general_ledger',
      'get_aged_payables', 'get_aged_receivables',
      'search_customers', 'list_drafts', 'get_entity_status', 'session_search',
    ];
    expect(todas.filter((n) => !ingesta.includes(n)).sort()).toEqual([...deMas].sort());
  });

  it('los dos `src` que el arnés importa arriba son módulos HOJA', () => {
    // El arnés importa dinámicamente todo src PORQUE los módulos que tocan la
    // base arman el pool al cargarse. Estos dos entran estáticamente, y la
    // excepción sólo vale mientras no importen nada.
    for (const rel of [['src', 'cli', 'kernel', 'exit.ts'], ['src', 'ai', 'tools', 'superficie.ts']]) {
      const sf = fuenteDe(...rel);
      const dependencias: string[] = [];
      recorrer(sf, (n) => {
        if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) {
          dependencias.push(n.getText(sf).split('\n')[0]);
        }
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          dependencias.push('import(…) dinámico');
        }
      });
      expect(
        dependencias,
        `${rel.join('/')} dejó de ser un módulo hoja; el arnés lo importa ANTES del global-setup y ` +
          'una dependencia nueva puede armar el pool con la DATABASE_URL equivocada'
      ).toEqual([]);
    }
  });
});

// ============================================================
// «NO PUDE MEDIR» NO ES «MEDÍ Y SALIÓ MAL».
//
// El arnés salía con código 0 aunque el proveedor fallara el 100% de los
// casos: el único camino a un código distinto era --umbral, y el paso de CI
// corre a propósito sin --umbral. Un adversario lo ejecutó con un id de modelo
// inexistente: «Model failure: 404», ocho clases en 0.000, SALIDA 0.
// ============================================================

/**
 * Una sesión de proveedor FALSA: el efecto que no se puede tener en una prueba
 * unitaria (la red, el modelo), no una copia de la lógica que se está midiendo.
 * Lo que se ejercita es el envoltorio real que se embarca.
 */
const turnosPorSesion = new WeakMap<LlmSession, number>();
function sesionFalsa(alCorrer: () => string): LlmSession {
  const s: LlmSession = {
    label: 'proveedor-de-mentira',
    runTurn: async () => {
      turnosPorSesion.set(s, (turnosPorSesion.get(s) ?? 0) + 1);
      return alCorrer();
    },
    reset: () => undefined,
  };
  turnosPorSesion.set(s, 0);
  return s;
}
const llamadasDe = (s: LlmSession): number => turnosPorSesion.get(s) ?? 0;

const balanceLimpio = (cambios: Partial<Balance> = {}): Balance => ({
  declarados: 10,
  medidos: 10,
  noMedidos: [],
  global: { aciertos: 40, total: 40 },
  ...cambios,
});

describe('el arnés no puede salir en verde sin haber medido', () => {
  it('midió el corpus entero y da la talla → 0', () => {
    expect(codigoDeSalida(balanceLimpio())).toBe(ExitCode.OK);
    expect(codigoDeSalida(balanceLimpio({ umbral: 0.8 }))).toBe(ExitCode.OK);
    expect(laCorridaMidio(balanceLimpio())).toBe(true);
  });

  it('midió y NO da la talla → 4 (VALIDATION), que es «encontré algo»', () => {
    const b = balanceLimpio({ umbral: 0.9, global: { aciertos: 30, total: 40 } });
    expect(codigoDeSalida(b)).toBe(ExitCode.VALIDATION);
    // Y sigue siendo una lectura: la línea entra en la bitácora.
    expect(laCorridaMidio(b)).toBe(true);
  });

  it('el proveedor falló EL CIEN POR CIENTO → 8, jamás 0', () => {
    // El caso exacto que el adversario ejecutó: nada se puntuó, todo salió en
    // 0.000, y el arnés devolvía 0. Un `return ExitCode.OK` aquí es la casilla
    // verde que dice «el clasificador se midió» sin que nadie mirara.
    const b = balanceLimpio({
      medidos: 0,
      global: { aciertos: 0, total: 0 },
      noMedidos: Array.from({ length: 10 }, (_, k) => ({
        caso: `caso-${k}`,
        clase: 'proveedor' as const,
        motivo: 'Model failure: 404 model not found',
      })),
    });
    expect(codigoDeSalida(b)).toBe(ExitCode.EXTERNAL_FAILED);
    expect(laCorridaMidio(b)).toBe(false);
  });

  it('UN solo caso sin medir basta, aunque los demás estén perfectos y sobre el umbral', () => {
    const b = balanceLimpio({
      medidos: 9,
      umbral: 0.8,
      global: { aciertos: 36, total: 36 },
      noMedidos: [{ caso: 'pue-recibido', clase: 'proveedor', motivo: 'ECONNRESET' }],
    });
    // 36/36 = 1.000 y el umbral es 0.8: por exactitud esto «pasa». No pasa,
    // porque el corpus no se midió entero y la lectura no existe.
    expect(codigoDeSalida(b)).toBe(ExitCode.EXTERNAL_FAILED);
    expect(laCorridaMidio(b)).toBe(false);
  });

  it('un panel que no se pudo montar sale por 1: no se arregla reintentando', () => {
    const b = balanceLimpio({
      medidos: 9,
      noMedidos: [{ caso: 'capitaliza-equipo-computo', clase: 'precondicion', motivo: 'evidencia de sombra' }],
    });
    expect(codigoDeSalida(b)).toBe(ExitCode.FAILURE);
    // Y manda sobre el fallo del proveedor: arreglar el corpus va primero.
    expect(
      codigoDeSalida(
        balanceLimpio({
          medidos: 8,
          noMedidos: [
            { caso: 'a', clase: 'proveedor', motivo: 'timeout' },
            { caso: 'b', clase: 'precondicion', motivo: 'no montable' },
          ],
        })
      )
    ).toBe(ExitCode.FAILURE);
  });

  it('cero casos es ÉXITO SOBRE CERO, y sale 1', () => {
    // Un filtro que no casa nada, un corpus vaciado: 0 de 0 es 100% de nada.
    const b = balanceLimpio({ declarados: 0, medidos: 0, global: { aciertos: 0, total: 0 } });
    expect(codigoDeSalida(b)).toBe(ExitCode.FAILURE);
    expect(codigoDeSalida(balanceLimpio({ global: { aciertos: 0, total: 0 } }))).toBe(ExitCode.FAILURE);
  });

  it('NINGUNA corrida sin medir puede devolver 0', () => {
    // La clase entera, por si mañana se añade otro modo de no medir.
    const sinMedir: Balance[] = [
      balanceLimpio({ declarados: 0, medidos: 0, global: { aciertos: 0, total: 0 } }),
      balanceLimpio({ medidos: 9, noMedidos: [{ caso: 'x', clase: 'proveedor', motivo: 'm' }] }),
      balanceLimpio({ medidos: 9, noMedidos: [{ caso: 'x', clase: 'precondicion', motivo: 'm' }] }),
      balanceLimpio({ medidos: 9 }),
      balanceLimpio({ global: { aciertos: 0, total: 0 } }),
    ];
    for (const b of sinMedir) {
      expect(laCorridaMidio(b)).toBe(false);
      expect(codigoDeSalida(b), JSON.stringify(b)).not.toBe(ExitCode.OK);
    }
  });

  it('el arnés VE al proveedor lanzar, y no lo deduce de una subcadena', async () => {
    // `ingestCfdiFiles` atrapa el fallo del modelo y lo devuelve como un
    // resultado más («Model failure: …»), indistinguible de una clasificación
    // mala salvo por el texto. Este envoltorio lo ve LANZAR. Si se lo tragara,
    // `noMedidos` quedaría vacío y la corrida saldría 0 con todo en 0.000 —
    // el defecto entero, con la tabla de códigos nueva puesta encima.
    const base = sesionFalsa(() => {
      throw new Error('404 model not found');
    });
    const v = vigilarProveedor(base);
    expect(v.fallo()).toBeNull();
    v.nuevoCaso();
    await expect(v.session.runTurn('clasifica esto')).rejects.toThrow('404 model not found');
    expect(v.fallo(), 'el envoltorio se tragó el fallo del proveedor').toBe('404 model not found');
    expect(v.llamoAlModelo()).toBe(true);
    // Y RE-LANZA: la ingesta tiene que enterarse igual, o el caso seguiría su
    // curso como si el modelo hubiera contestado.
    expect(llamadasDe(base)).toBe(1);
  });

  it('y olvida el fallo al empezar el caso siguiente', async () => {
    // Sin esto, el primer caso que falla deja marcados como no medidos a TODOS
    // los siguientes: una corrida entera perdida por un timeout.
    let revienta = true;
    const base = sesionFalsa(() => {
      if (revienta) throw new Error('ECONNRESET');
      return 'listo';
    });
    const v = vigilarProveedor(base);
    v.nuevoCaso();
    await expect(v.session.runTurn('uno')).rejects.toThrow('ECONNRESET');
    expect(v.fallo()).toBe('ECONNRESET');
    revienta = false;
    v.nuevoCaso();
    expect(v.fallo(), 'el fallo del caso anterior contamina al siguiente').toBeNull();
    expect(v.llamoAlModelo(), 'el contador de turnos no se reinició con el caso').toBe(false);
    await v.session.runTurn('dos');
    expect(v.fallo()).toBeNull();
    expect(v.llamoAlModelo()).toBe(true);
  });

  it('y el caso que el proveedor tumbó no llega a puntuarse', () => {
    // El eslabón entre lo de arriba y la tabla de códigos: el `push` a
    // `noMedidos` con clase 'proveedor' cuelga de que el envoltorio haya visto
    // el fallo, y con la polaridad correcta.
    const sf = fuenteDe(...ARNES);
    expect(llamadasA(sf, 'vigilarProveedor').length, 'main() ya no vigila al proveedor').toBe(1);
    const empujones: ts.CallExpression[] = llamadasA(sf, 'push').filter((c) =>
      (c.arguments[0]?.getText(sf) ?? '').includes("clase: 'proveedor'")
    );
    expect(empujones, 'nadie registra ya el caso que el proveedor tumbó').toHaveLength(1);
    const gobierno = condicionQueGobierna(empujones[0], sf);
    expect(gobierno, 'el registro del fallo del proveedor no cuelga de ninguna condición').not.toBeNull();
    expect(gobierno!.expresion).toMatch(/fallo !== null/);
    expect(gobierno!.rama).toBe('then');
    // Y del mismo sitio sale un `continue`: puntuar igual sería medir un cero
    // que no es del clasificador.
    let hayContinue = false;
    recorrer(gobierno === null ? sf : empujones[0].parent.parent, (n) => {
      if (ts.isContinueStatement(n)) hayContinue = true;
    });
    expect(hayContinue, 'el caso no medido sigue su curso hasta puntuarse').toBe(true);
  });

  it('y ese veredicto es lo ÚNICO que decide la salida del proceso', () => {
    // Sin esto, la tabla de arriba sería un examen a una función que nadie
    // llama — el arnés podría seguir saliendo 0 por otro camino.
    const sf = fuenteDe(...ARNES);
    const asignaciones: ts.BinaryExpression[] = [];
    recorrer(sf, (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === 'exitCode' &&
        n.left.expression.getText(sf) === 'process'
      ) {
        asignaciones.push(n);
      }
    });
    expect(asignaciones, 'el arnés fija process.exitCode en más de un sitio (o en ninguno)').toHaveLength(1);
    const derecha = asignaciones[0].right;
    expect(
      ts.isCallExpression(derecha) && ts.isIdentifier(derecha.expression) && derecha.expression.text === 'codigoDeSalida',
      `process.exitCode se fija con «${derecha.getText(sf)}» y no con codigoDeSalida(...)`
    ).toBe(true);

    // Y las salidas duras tampoco pueden ser un éxito.
    const salidas = llamadasA(sf, 'exit').filter(
      (c) => ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(sf) === 'process'
    );
    expect(salidas.length, 'process.exit() desapareció del arnés').toBeGreaterThan(0);
    for (const s of salidas) {
      const arg = s.arguments[0]?.getText(sf) ?? '';
      expect(arg, 'un process.exit() del arnés no usa la tabla de kernel/exit.ts').toContain('ExitCode.');
      expect(arg, 'un process.exit() del arnés puede terminar en éxito').not.toContain('ExitCode.OK');
    }
  });

  it('una corrida a medias NO deja línea en la bitácora', () => {
    // La bitácora es la memoria del «mejoró/empeoró»: una media lectura escrita
    // ahí es un número que la corrida de mañana compara como si fuera entero, y
    // la flecha diría del modelo lo que fue del proveedor.
    const sf = fuenteDe(...ARNES);
    const anexos = llamadasA(sf, 'appendFileSync');
    expect(anexos, 'el arnés dejó de escribir la bitácora').toHaveLength(1);
    const gobierno = condicionQueGobierna(anexos[0], sf);
    expect(gobierno, 'la escritura de la bitácora no está gobernada por ningún `if`').not.toBeNull();
    expect(gobierno!.expresion).toContain('laCorridaMidio');
    // La polaridad, no sólo la presencia: `if (!laCorridaMidio(…)) {…} else {escribe}`.
    const negada = gobierno!.expresion.trimStart().startsWith('!');
    expect(
      gobierno!.rama,
      `la bitácora se escribe en la rama «${gobierno!.rama}» de «${gobierno!.expresion}»: la polaridad está invertida`
    ).toBe(negada ? 'else' : 'then');
  });
});

describe('el panel que el corpus declara se monta antes de medir', () => {
  const casos = cargarCasosGolden(path.join(RAIZ_REPO, 'tests', 'golden', 'cfdi'));
  const gemelo = (nombre: string) => {
    const c = casos.find((x) => x.nombre === nombre);
    if (!c) throw new Error(`el corpus perdió el caso «${nombre}»`);
    return c;
  };

  it('el corpus embarca dos gemelos que SÓLO se distinguen por el panel', () => {
    const capitaliza = gemelo('capitaliza-equipo-computo');
    const pregunta = gemelo('ask-equipo-computo');
    expect(politicasRequeridas(capitaliza)).toEqual([['umbral_capitalizacion_mxn', '5000']]);
    expect(politicasRequeridas(pregunta)).toEqual([['umbral_capitalizacion_mxn', null]]);
    // Y esperan respuestas OPUESTAS: por eso el panel no es decoración.
    expect(capitaliza.esperado.resultado).toBe('draft');
    expect(pregunta.esperado.resultado).toBe('pregunta');
  });

  it('el valor declarado NO es el de por omisión: sin sembrarlo se mide otra cosa', () => {
    // Ésta es la razón de existir del sembrado, y el ancla contra el arreglo
    // cómodo: si alguien «arregla» el caso poniéndole el defecto del catálogo,
    // el arnés vuelve a puntuar bajo un panel que el caso no declara y el
    // hueco regresa sin un solo rojo.
    const porOmision = getPolicySpec('umbral_capitalizacion_mxn')?.defaultValue;
    expect(porOmision).toBe('20000');
    expect(politicasRequeridas(gemelo('capitaliza-equipo-computo'))[0][1]).not.toBe(porOmision);
  });

  it('planDePanel convierte el null en un paso ACTIVO, no en un no-op', () => {
    // «Sin contestar» hay que GARANTIZARLO: el caso anterior pudo contestar esa
    // misma clave, y entonces el gemelo mediría bajo un panel que nadie declaró.
    expect(planDePanel(politicasRequeridas(gemelo('ask-equipo-computo')))).toEqual([
      { op: 'dejar-sin-contestar', clave: 'umbral_capitalizacion_mxn' },
    ]);
    expect(planDePanel(politicasRequeridas(gemelo('capitaliza-equipo-computo')))).toEqual([
      { op: 'contestar', clave: 'umbral_capitalizacion_mxn', valor: '5000' },
    ]);
    // Un caso sin precondición no toca el panel.
    expect(planDePanel(politicasRequeridas(gemelo('pue-recibido')))).toEqual([]);
  });

  it('el arnés lo siembra con las funciones del producto y en el alcance de ENTIDAD', () => {
    const sf = fuenteDe(...ARNES);
    // Lo lee del corpus (no lo deduce) y lo escribe con el servicio real.
    expect(nombresLigadosDe(sf, 'ai/eval/golden')).toContain('politicasRequeridas');
    const delPanel = nombresLigadosDe(sf, 'services/policy/policy-service');
    for (const fn of ['seedPolicies', 'resolvePolicy', 'reopenPolicy']) {
      expect(delPanel, `el arnés no liga ${fn}: no puede montar ni desmontar el panel`).toContain(fn);
      expect(llamadasA(sf, fn).length, `${fn} se importa y no se llama`).toBeGreaterThan(0);
    }
    expect(llamadasA(sf, 'politicasRequeridas').length).toBeGreaterThan(0);
    expect(llamadasA(sf, 'planDePanel').length).toBeGreaterThan(0);
    // El alcance: pre-registration-service resuelve con {tenantId, entityId}.
    // Sembrar en otro dejaría al clasificador leyendo el panel por omisión.
    const sinCom = sinComentarios(leer(...ARNES));
    expect(sinCom).toMatch(/panelCtx\s*=\s*\{\s*tenantId:\s*f\.tenantId,\s*entityId:\s*f\.entityId\s*\}/);
  });

  it('el panel se DESMONTA pase lo que pase, también por el camino del error', () => {
    // Sin esto, el caso que contesta `umbral_capitalizacion_mxn = 5000` se la
    // deja contestada al siguiente, y su gemelo —que declara la misma clave sin
    // contestar— mediría bajo un panel que nadie declaró. El camino que más
    // importa es el del `continue`: un caso no medido también tiene que
    // devolver el panel.
    const sf = fuenteDe(...ARNES);
    const desmontajes = llamadasA(sf, 'desmontarPanel');
    expect(desmontajes, 'el arnés dejó de devolver el panel a su estado').toHaveLength(1);
    expect(
      dentroDeUnFinally(desmontajes[0]),
      'el desmontaje del panel no está en un `finally`: un caso que revienta o que se salta con ' +
        '`continue` deja el panel contestado para el siguiente'
    ).toBe(true);
    // Y el montaje vive dentro de ESE mismo try, o un montaje a medias se
    // escaparía del desmontaje.
    const montajes = llamadasA(sf, 'montarPanel');
    expect(montajes).toHaveLength(1);
    let mismoTry = false;
    let p: ts.Node | undefined = montajes[0].parent;
    while (p) {
      if (ts.isTryStatement(p) && p.finallyBlock && contieneLlamadaA(p.finallyBlock, 'desmontarPanel')) {
        mismoTry = true;
        break;
      }
      p = p.parent;
    }
    expect(mismoTry, 'montarPanel corre fuera del try cuyo finally desmonta').toBe(true);
  });

  it('un caso cuyo panel no se pudo montar no se puntúa y tiñe la corrida', () => {
    const b = balanceLimpio({
      medidos: 9,
      noMedidos: [{ caso: 'capitaliza-equipo-computo', clase: 'precondicion', motivo: 'no montable' }],
    });
    expect(laCorridaMidio(b)).toBe(false);
    expect(codigoDeSalida(b)).not.toBe(ExitCode.OK);
  });
});

describe('el muestreo está declarado, perfil por perfil', () => {
  const nombres = Object.keys(BUILTIN_PROFILES);

  it('ningún perfil de fábrica se calla', () => {
    // El tipo ya lo exige (un perfil sin `reproducibilidad` no compila), pero el
    // arnés lo LEE en tiempo de ejecución: si alguien relaja el tipo, esto
    // sigue en pie. La lista se afirma entera para que añadir un proveedor
    // obligue a pronunciarse sobre él.
    expect(nombres.length).toBeGreaterThanOrEqual(12);
    for (const nombre of nombres) {
      const r = reproducibilidadDe(nombre);
      expect(r, `el perfil «${nombre}» no declara su reproducibilidad`).not.toBeNull();
      expect(['fijado', 'no-admite']).toContain(r!.muestreo);
      // Una postura sin motivo es una opinión: el porqué viaja con ella.
      expect(r!.razon.length, `la razón de «${nombre}» es demasiado corta para decir nada`)
        .toBeGreaterThan(40);
    }
  });

  it('«fijado» significa temperatura CERO, y «no-admite» no lleva ninguna', () => {
    for (const nombre of nombres) {
      const r = reproducibilidadDe(nombre)!;
      if (r.muestreo === 'fijado') {
        // Es un CLASIFICADOR: la respuesta correcta no depende de la
        // creatividad del modelo. Cualquier otra temperatura reintroduce el
        // ruido que hizo que la misma entrada diera 0.70 y 0.80.
        expect(r.temperature, `«${nombre}» dice fijar el muestreo sin decir en cuánto`)
          .toBe(0);
      } else {
        // Declarar una temperatura junto a «no-admite» sería fingir que se fija
        // algo que la API devolvería como 400.
        expect(r.temperature, `«${nombre}» no admite fijar muestreo pero declara uno`)
          .toBeUndefined();
      }
    }
  });

  it('el perfil POR DEFECTO declara que NO puede fijarlo, que es la verdad incómoda', () => {
    // claude-opus-5 es posterior a Claude Opus 4.6, y el SDK instalado lo dice
    // en su propia deprecación: sólo se acepta temperatura 1.0, todo lo demás
    // vuelve 400. Este es el ancla contra el arreglo cómodo — poner
    // `temperature: 0` aquí para que la tabla se vea completa produciría un
    // eval que no arranca contra el proveedor que de verdad se embarca.
    const r = reproducibilidadDe('anthropic')!;
    expect(r.muestreo).toBe('no-admite');
    expect(r.temperature).toBeUndefined();
    expect(r.razon).toMatch(/400/);
    // Y no hay instantánea fechada que fijar: el id ya es exacto.
    expect(r.instantanea).toBeNull();
  });

  it('el enrutador se declara inevaluable por el modelo, no por el muestreo', () => {
    // `openrouter/auto` elige modelo POR PETICIÓN: dos corridas del «mismo
    // proveedor+modelo» pueden haber preguntado a dos modelos distintos, y la
    // bitácora las compararía como si fueran la misma. Fijar la temperatura no
    // arreglaría eso, y declararlo `fijado` escondería el defecto real.
    expect(BUILTIN_PROFILES.openrouter.model).toBe('openrouter/auto');
    expect(reproducibilidadDe('openrouter')!.muestreo).toBe('no-admite');
  });

  it('un perfil del usuario no hereda una garantía que nadie estableció', () => {
    // mnemosine.config.json no tiene dónde declarar reproducibilidad. Devolver
    // `null` es lo honesto: el arnés lo trata como «sin garantía» y lo dice, en
    // vez de suponerle la postura del perfil de fábrica que reemplaza.
    expect(reproducibilidadDe('un-perfil-que-el-usuario-definio')).toBeNull();
  });
});

describe('la nota sobre el cableado no puede envejecer hasta mentir', () => {
  it('MUESTREO_CABLEADO dice lo que los constructores de petición hacen HOY', () => {
    // LA CLASE, NO LA INSTANCIA: los DOS caminos que arman un cuerpo de
    // petición. Anthropic por src/ai/agent.ts y todo lo demás por
    // openai-compat.ts; declarar el muestreo sin tocar ninguno de los dos deja
    // la declaración en el aire, y ésta es la prueba que lo impide.
    const constructores = [
      sinComentarios(leer('src', 'ai', 'agent.ts')),
      sinComentarios(leer('src', 'ai', 'providers', 'openai-compat.ts')),
    ];
    const envia = constructores.some((src) => /(^|[^\w.])temperature\s*:/.test(src));
    expect(
      envia,
      envia
        ? 'alguien cableó el muestreo en el constructor de peticiones y dejó MUESTREO_CABLEADO en false: ' +
          'el arnés sigue avisando de una irreproducibilidad que ya no existe'
        : 'MUESTREO_CABLEADO está en true pero ningún constructor de peticiones envía temperature: ' +
          'el arnés estaría prometiendo corridas comparables que no lo son'
    ).toBe(MUESTREO_CABLEADO);
  });

  it('el arnés LEE la declaración en vez de suponerla', () => {
    const arnes = leer(...ARNES);
    expect(arnes).toContain('reproducibilidadDe');
    expect(arnes).toContain('MUESTREO_CABLEADO');
    // La consecuencia con dientes: sin corrida comparable no se dibuja flecha.
    // Si alguien quita la puerta, el arnés vuelve a afirmar tendencias sobre
    // ruido — que es el defecto que A7 vino a cerrar, no un detalle de formato.
    expect(arnes).toMatch(/const comparable =\s*repro\?\.muestreo === 'fijado' && MUESTREO_CABLEADO/);
    expect(arnes).toMatch(/if \(comparable && fs\.existsSync\(BITACORA\)\)/);
  });
});
