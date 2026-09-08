/**
 * Verifica —y genera el censo de— la completitud de docs/HISTORY.md.
 *
 *   npx tsx scripts/historial-estado.ts            escribe el bloque en el documento
 *   npx tsx scripts/historial-estado.ts --check    sale con 1 si el historial se quedó atrás de `main`
 *
 * POR QUÉ EXISTE
 *
 * `docs/HISTORY.md` nace de una lección concreta, escrita en su propia cabecera:
 * el artefacto «Plan de cierre» narraba un Sprint 1 y un Sprint 2 cuyos hashes
 * NO EXISTEN en `main`. El documento se reconstruyó verificando contra el árbol,
 * y quedó bien. Y después le pasó exactamente lo mismo, por la misma vía: nadie
 * lo volvió a mirar. Medido el 2026-09-08, decía que el **PR #53 estaba
 * abierto** —llevaba fusionado desde el 2026-09-07— y no nombraba los **16 PRs**
 * fusionados después. Un historial de entrega que se equivoca sobre lo que se
 * entregó no es un historial: es el artefacto que él mismo advierte que no hay
 * que creerse.
 *
 * La reparación no puede ser volver a reconstruirlo a mano, porque eso es lo
 * que ya se hizo una vez y caducó en dos días. Es la misma disciplina que
 * `catalogo-estado.ts`: la mitad DERIVABLE la cuenta la máquina y la mitad
 * JUZGABLE se sigue escribiendo a mano.
 *
 *   · Derivable — qué PRs entraron a `main`. Lo dice `git log --first-parent`,
 *     sin red y sin la API. Esto es lo que aquí se exige.
 *   · Juzgable — a qué sprint pertenece cada uno, qué tramos incluye, qué nota
 *     merece. Eso no es mecánico y aquí no se toca.
 *
 * O sea: esto NO comprueba que el historial sea bueno. Comprueba que no le
 * FALTE nada, que es el modo exacto en que se estropeó — y con una semana de
 * gracia, para que exigirlo no rompa el trabajo ajeno (ver DIAS_DE_GRACIA).
 *
 * POR QUÉ FALLA CUANDO NO PUEDE MIRAR
 *
 * `actions/checkout` clona a profundidad 1 por omisión: `git log` devolvería un
 * solo commit y este guardián saldría en VERDE sin haber comprobado nada. Es el
 * mismo falso verde que tenía `doctor` antes del T1b —contaba sin contexto de
 * inquilino y firmaba el cero— y se trata igual: si el clon es superficial, esto
 * es un ERROR, no un salto. El trabajo de CI que lo invoca pide `fetch-depth: 0`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const RAIZ = path.resolve(__dirname, '..');
const DOC = path.join(RAIZ, 'docs', 'HISTORY.md');
const INICIO = '<!-- HISTORIAL-GENERADO:INICIO -->';
const FIN = '<!-- HISTORIAL-GENERADO:FIN -->';

/**
 * Cuánto puede ir el documento por detrás de `main` sin que esto falle.
 *
 * NO es indulgencia: es lo que impide que esta compuerta acople entre sí a los
 * PRs abiertos. CI corre sobre `refs/pull/N/merge`, o sea sobre la punta de
 * `main`: si se exigiera que TODO PR fusionado apareciera ya en el documento,
 * cada fusión pondría en rojo los demás PRs vivos —había DIECIOCHO el día que
 * esto se escribió— hasta que alguien añadiera la fila. Una compuerta que rompe
 * el trabajo ajeno se acaba desactivando, y entonces no hay compuerta.
 *
 * Con la gracia, el documento puede ir detrás de la ráfaga del día y sigue sin
 * poder PUDRIRSE: lo que lleva más de una semana fusionado sin fila es rojo. La
 * deuda tiene techo, igual que la de manuales sin revisar en
 * `corpus-manifiesto.ts`.
 */
const DIAS_DE_GRACIA = 7;

/**
 * Un PR que llegó a `main`, tal como lo cuenta el propio árbol.
 *
 * `commit` es el commit de PRIMER PADRE que lo introdujo — el squash, o el
 * commit de fusión. No es el commit de la rama: la rama puede tener veinte y
 * aquí sólo interesa el punto por el que entró.
 */
export interface Entrada {
  sha: string;
  commit: string;
  fecha: string;
  pr: number | null;
  asunto: string;
}

/**
 * `git`, siempre en UTC.
 *
 * El documento fecha en UTC —lo dice su propia prosa, «02:50Z del 2026-09-03»—
 * y es lo que devuelve `gh` en `mergedAt`. `git log --date=short` da la zona de
 * quien escribió el commit: aquí, UTC−6, que corre de día doce merges de los
 * diecisiete últimos. Sin fijar TZ el censo generado contradiría a la tabla
 * escrita a mano justo en la mitad de las filas.
 */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: RAIZ,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' },
  });
}

/**
 * El número de PR que un commit de primer padre declara, en las DOS formas que
 * este repositorio usa de verdad:
 *
 *   `… (#55)`                              — squash (el modo de la mayoría)
 *   `Merge pull request #53 from …`        — fusión con commit propio
 *
 * Un commit sin ninguna de las dos es un commit DIRECTO a `main`: los trece de
 * la línea base, antes de que existiera el flujo por PR. No es un error.
 */
export function prDe(asunto: string): number | null {
  const fusion = /^Merge pull request #(\d+)\b/.exec(asunto);
  if (fusion) return Number(fusion[1]);
  const squash = /\(#(\d+)\)\s*$/.exec(asunto);
  if (squash) return Number(squash[1]);
  return null;
}

/**
 * La columna vertebral de `main`, que es la misma que el documento declara usar.
 *
 * Se camina desde HEAD a propósito: en CI el checkout es `refs/pull/N/merge`,
 * cuyo primer padre es la punta de `main`. Así el guardián exige exactamente lo
 * ya fusionado y nunca el PR en curso, que todavía no es historia.
 */
/**
 * Los commits donde un clon superficial CORTA la historia.
 *
 * `--is-shallow-repository` a secas no sirve como predicado: un árbol de
 * trabajo normal puede ser superficial y aun así tener completa la línea de
 * primer padre de `main`, porque el corte cayó en una rama fusionada. Medido en
 * este repositorio: hay dos cortes, uno de ellos ancestro de HEAD, y el
 * recorrido de primer padre llega igualmente hasta el commit raíz. Fallar por
 * eso sería un guardián que grita donde no hay nada.
 */
function cortesSuperficiales(): Set<string> {
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'true') return new Set();
  const comun = git('rev-parse', '--git-common-dir').trim();
  const archivo = path.resolve(RAIZ, comun, 'shallow');
  if (!fs.existsSync(archivo)) return new Set();
  return new Set(
    fs
      .readFileSync(archivo, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
  );
}

function columnaVertebral(): Entrada[] {
  const crudo = git(
    'log',
    '--first-parent',
    '--format=%H%x09%h%x09%cd%x09%s',
    '--date=format-local:%Y-%m-%d',
    'HEAD'
  );
  const entradas = crudo
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [sha, commit, fecha, ...resto] = l.split('\t');
      const asunto = resto.join('\t');
      return { sha, commit, fecha, pr: prDe(asunto), asunto };
    });

  // LO QUE DE VERDAD IMPORTA: que el recorrido llegue al principio.
  //
  // Si el commit más viejo de la línea de primer padre ES un borde de corte, la
  // historia está truncada justo por donde este guardián cuenta, y entonces no
  // puede saber qué PRs faltan. `actions/checkout` clona a profundidad 1 por
  // omisión, así que ése es el caso normal en CI si nadie pide lo contrario: el
  // recorrido daría UN commit y el documento saldría en verde sin comprobarse.
  // No se salta: se falla. Es el mismo falso verde que tenía `doctor` antes del
  // T1b, que contaba sin contexto de inquilino y firmaba el cero.
  const masViejo = entradas[entradas.length - 1];
  if (masViejo !== undefined && cortesSuperficiales().has(masViejo.sha)) {
    throw new Error(
      `La historia está TRUNCADA: el recorrido de primer padre muere en ${masViejo.commit} ` +
        '(un borde de clon superficial),\n' +
        `así que sólo se ven ${entradas.length} commit(s) y no se puede saber qué PRs faltan.\n` +
        'Este guardián no se salta cuando no puede mirar — eso sería el falso verde que viene a\n' +
        'impedir. Pide `fetch-depth: 0` en el paso de actions/checkout.'
    );
  }
  return entradas;
}

/** Los PRs que el documento nombra, por su enlace — que es como los escribe. */
export function prsNombrados(md: string): Set<number> {
  const encontrados = new Set<number>();
  for (const m of md.matchAll(/\/pull\/(\d+)\b/g)) encontrados.add(Number(m[1]));
  return encontrados;
}

export interface Censo {
  /** PRs que el documento nombra y que están de verdad en `main`. */
  nombrados: number;
  /** Commits directos a `main`, de antes del flujo por PR. */
  directos: number;
  /** El más reciente de los NOMBRADOS — no el más reciente de `main`. */
  ultimoPr: number | null;
  ultimaFecha: string | null;
  /** Fusionados, sin fila, y ya fuera de la gracia. Esto es lo que falla. */
  atrasados: Entrada[];
  /** Fusionados, sin fila, todavía dentro de la gracia. Sólo se informa. */
  recientes: Entrada[];
}

/** Días entre dos fechas `YYYY-MM-DD`, que es el formato en que aquí viajan. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000);
}

/**
 * Reparte los PRs sin fila entre los que ya son deuda y los que aún no.
 *
 * Puro a propósito: la regla de gracia es lo único de este guardián que puede
 * dar un veredicto distinto según CUÁNDO se pregunte, así que se prueba con
 * fechas puestas a mano y no contra el árbol —que envejecería la prueba y la
 * volvería roja sola dentro de una semana.
 *
 * Sin `hoy` no hay con qué medir la gracia, y entonces TODOS son deuda: es la
 * misma regla de la casa, no se firma en verde lo que no se pudo mirar.
 */
export function clasificarAtraso(
  sinFila: Entrada[],
  hoy: string | null
): { atrasados: Entrada[]; recientes: Entrada[] } {
  if (hoy === null) return { atrasados: sinFila, recientes: [] };
  const atrasados = sinFila.filter((e) => diasEntre(e.fecha, hoy) > DIAS_DE_GRACIA);
  const recientes = sinFila.filter((e) => diasEntre(e.fecha, hoy) <= DIAS_DE_GRACIA);
  return { atrasados, recientes };
}

export function medir(md: string): Censo {
  const vertebral = columnaVertebral();
  const conPr = vertebral.filter((e) => e.pr !== null);
  const nombrados = prsNombrados(md);

  // «Hoy» es la fecha del commit más reciente del ÁRBOL, no la del reloj. Así
  // el veredicto es reproducible —el mismo árbol da mañana el mismo resultado—
  // y la gracia se mide en actividad del proyecto, no en tiempo de pared, que
  // es lo que importa cuando se fusionan dieciséis PRs en dos días.
  const hoy = vertebral[0]?.fecha ?? null;

  const { atrasados, recientes } = clasificarAtraso(
    conPr.filter((e) => !nombrados.has(e.pr as number)),
    hoy
  );

  const conFila = conPr.filter((e) => nombrados.has(e.pr as number));
  const ultimo = conFila[0] ?? null;
  return {
    nombrados: conFila.length,
    directos: vertebral.length - conPr.length,
    ultimoPr: ultimo ? ultimo.pr : null,
    ultimaFecha: ultimo ? ultimo.fecha : null,
    atrasados,
    recientes,
  };
}

export function render(c: Censo): string {
  const l: string[] = [INICIO];
  l.push('');
  l.push('**Censo, medido sobre el árbol** (`npm run historial:estado`):');
  l.push('');
  l.push(`- **${c.nombrados}** PRs registrados aquí, y los ${c.nombrados} están en \`main\`.`);
  l.push(
    `- El más reciente registrado es el **#${c.ultimoPr ?? '—'}**, del **${c.ultimaFecha ?? '—'}** (UTC).`
  );
  l.push(
    `- **${c.directos}** commits directos a \`main\`, de antes del flujo por PR (la fila «—» del Sprint 1).`
  );
  l.push('');
  l.push(
    `CI lo verifica con \`--check\`, que falla cuando un PR lleva más de **${DIAS_DE_GRACIA} días** ` +
      'fusionado sin aparecer aquí. La gracia existe para que una fusión no ponga en rojo los demás ' +
      'PRs abiertos; el techo, para que el documento no pueda pudrirse.'
  );
  l.push('');
  l.push(FIN);
  return l.join('\n');
}

function main(argv: string[]): number {
  const md = fs.readFileSync(DOC, 'utf-8');
  let censo: Censo;
  try {
    censo = medir(md);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
  const bloque = render(censo);

  const i = md.indexOf(INICIO);
  const j = md.indexOf(FIN);
  if (i < 0 || j < 0) {
    process.stderr.write(
      `El documento no tiene los marcadores ${INICIO} … ${FIN}. ` +
        'Insértalos donde deba ir el bloque generado.\n'
    );
    return 1;
  }
  const actual = md.slice(i, j + FIN.length);

  if (argv.includes('--check')) {
    // LA COMPLETITUD, ANTES QUE EL FORMATO.
    //
    // Un bloque regenerado no prueba nada si la tabla no nombra el PR: el censo
    // diría «16 registrados» y seguiría estando al día consigo mismo. Por eso
    // los atrasados fallan primero, y con nombre y apellido.
    if (censo.atrasados.length > 0) {
      process.stderr.write(
        `El historial no nombra ${censo.atrasados.length} PR(s) fusionados hace más de ` +
          `${DIAS_DE_GRACIA} días:\n` +
          censo.atrasados.map((e) => `  #${e.pr}  ${e.fecha}  ${e.commit}  ${e.asunto}`).join('\n') +
          '\n\nAñade su fila a docs/HISTORY.md —con sus tramos y su nota— y regenera el censo:\n' +
          '  npm run historial:estado\n'
      );
      return 1;
    }
    if (censo.recientes.length > 0) {
      // Dentro de la gracia: se dice en voz alta y NO se falla. Un aviso que
      // nadie ve es una deuda que nadie paga.
      process.stdout.write(
        `Aviso: ${censo.recientes.length} PR(s) fusionados sin fila todavía, dentro de los ` +
          `${DIAS_DE_GRACIA} días de gracia: ${censo.recientes.map((e) => `#${e.pr}`).join(', ')}\n`
      );
    }

    if (actual === bloque) {
      process.stdout.write('El historial de entrega está al día.\n');
      return 0;
    }
    process.stderr.write(
      'El censo del historial está desfasado respecto al árbol.\n' +
        'Regenéralo con:  npx tsx scripts/historial-estado.ts\n'
    );
    return 1;
  }

  fs.writeFileSync(DOC, md.slice(0, i) + bloque + md.slice(j + FIN.length));
  process.stdout.write(`Censo del historial regenerado en ${path.relative(RAIZ, DOC)}.\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
