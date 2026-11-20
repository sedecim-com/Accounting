import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  ciJob,
  codigoDe,
  type Criterio,
  type Resultado,
  crudoDe,
  existe,
  falla,
  forEachGatewayNode,
  fuentes,
  leer,
  literalText,
  noEvaluable,
  ok,
  RAIZ,
  rutaDe,
  sectionOf,
  stepRuns,
} from './shared.js';
// NOTE: import cycle with the index. It is safe because CRITERIOS is only read
// inside `evaluar`, never at module load.
import { CRITERIOS } from '../criterios.js';
import {
  CENSUS_FILE,
  censusDrift,
  describeEntry,
  instrumentFiles,
  measureCensus,
  parseCensus,
} from '../mutation-census.js';
import { LOCALES, languageOfLocale } from '../../i18n/locale.js';

// ============================================================
// THE E0.0 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
/**
 * THE GROUND OF ONE I8 FAMILY (MNE-001-219, generalized in MNE-001-220): its
 * leaves have no entry in the lane's breakdown, every key of its catalogue
 * block is named by one of them, and none of the block's Spanish is written in
 * them as a literal. Each family's criterion names its block and its leaves.
 */
function familySpeaksByKey(block: string, family: string, LEAVES: readonly string[]): Resultado {
  const LANE = 'spanish-user-strings-cli';
  const BASELINE = 'docs/language-baseline.json';
  for (const rel of [BASELINE, ...LEAVES]) {
    if (!existe(rel)) return noEvaluable(`${rel} is not in this tree`);
  }

  // 1 · The breakdown, by absence.
  let baseline: { lanes?: Record<string, number>; perFile?: Record<string, Record<string, number>> };
  try {
    baseline = JSON.parse(crudoDe(BASELINE)) as typeof baseline;
  } catch {
    return falla(`${BASELINE} is not valid JSON`);
  }
  if (baseline.lanes?.[LANE] === undefined) {
    return falla(`the baseline no longer has the lane «${LANE}»: the family's ground stops being measurable`);
  }
  const owed = LEAVES.filter((f) => (baseline.perFile?.[LANE] ?? {})[f] !== undefined);
  if (owed.length) {
    return falla(
      `${owed.join(', ')} carry Spanish strings again in «${LANE}»: the ground ${block} won was given back`
    );
  }

  // The family's block of a catalogue, as key → value of its string literals.
  const blockOf = (rel: string): Map<string, string> | null => {
    const src = crudoDe(rel);
    const open = src.indexOf(`// ==== ${block} `);
    const close = src.indexOf(`// ==== end of ${block} ====`);
    if (open === -1 || close === -1 || close < open) return null;
    const sf = ts.createSourceFile(rel, `({\n${src.slice(open, close)}\n})`, ts.ScriptTarget.Latest, true);
    const out = new Map<string, string>();
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name))) {
        let text = '';
        const collect = (m: ts.Node): void => {
          if (ts.isStringLiteral(m) || ts.isNoSubstitutionTemplateLiteral(m)) text += m.text;
          m.forEachChild(collect);
        };
        collect(n.initializer);
        out.set(n.name.text, text);
      }
      n.forEachChild(visit);
    };
    visit(sf);
    return out;
  };
  const en = blockOf('src/i18n/en.ts');
  const es = blockOf('src/i18n/es.ts');
  if (en === null || es === null) {
    return falla(`a catalogue lost the markers of the ${block} block, where the ${family} family keeps its texts`);
  }
  if (en.size === 0) {
    return falla(`the ${block} block of src/i18n/en.ts declares no key: the ${family} family has nowhere to speak from`);
  }

  // 2 and 3 · What the leaves write as literals.
  const literals = new Set<string>();
  for (const rel of LEAVES) {
    const sf = ts.createSourceFile(rel, crudoDe(rel), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateLiteralToken(n)) {
        literals.add(n.text);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  const orphans = [...en.keys()].filter((k) => !literals.has(k));
  if (orphans.length) {
    return falla(
      `${orphans.length} key(s) of the ${block} block are named by no leaf of the family ` +
        `(${orphans.slice(0, 3).join(', ')}): their text went back into the code`
    );
  }
  const literalText = [...literals].join('\n');
  // Only values of two words or more (MNE-001-221): the lane's own judge counts
  // no single word as prose (scripts/language/extract.ts, `words.length >= 2`),
  // and a one-word label such as «estado» matches inside identifiers like
  // 'isn_estado_que_causa'. A one-word key is still held by check 2.
  const backInCode = [...es.entries()]
    .filter(([, value]) => value.length > 0 && !value.includes('{') && value.trim().split(/\s+/).length >= 2)
    .filter(([, value]) => literalText.includes(value))
    .map(([key]) => key);
  if (backInCode.length) {
    return falla(
      `the Spanish of ${backInCode.slice(0, 3).join(', ')} is written as a literal in the ${family} family again: ` +
        'it prints the same words to every user, whatever their language'
    );
  }

  return ok(
    `the ${en.size} keys of the ${block} block are named by the ${family} family, none of their Spanish is written ` +
      `in them, and none of its leaves has an entry in «${LANE}» (which is ${baseline.lanes[LANE]})`
  );
}

export const E0_0: Criterio[] = [
  // ---- E0.0 · Control de versiones y CI ----

  // ---------------------------------------------------------------
  // O1 lo encontró: UN BYTE INVISIBLE QUE APAGA `grep` SOBRE UN ARCHIVO ENTERO
  //
  // La verificación adversaria de O1 halló un NUL crudo escrito como separador
  // de una clave compuesta, con el byte de verdad dentro del literal. Es la
  // decisión CORRECTA —un NUL no cabe en un código de cuenta ni en un folio—
  // escrita del modo equivocado: convierte el fuente en BINARIO para `grep` y
  // para `file`, y mil ciento sesenta y seis líneas —el archivo que escribe el
  // asiento de apertura— dejaron de aparecer en ninguna búsqueda del
  // repositorio. Se descubrió por accidente, buscando otra cosa.
  //
  // NINGUNA PUERTA LO VIO: pasa tsc, pasa eslint, pasa vitest, pasa la
  // cobertura. Y `git diff` tampoco avisa, porque la heurística de binario de
  // git sólo mira los primeros 8 000 bytes y el NUL caía en el 22 381: la
  // revisión humana habría visto un diff perfectamente normal.
  //
  // Se busca SÓLO el NUL, no la familia entera de bytes de control: es el que
  // apaga las herramientas, y un criterio que caza de más se desactiva a la
  // primera falsa alarma. La lectura va por `crudoDe` —el seam— para que el
  // espejo pueda inyectar uno y comprobar que este criterio muerde.
  // ---------------------------------------------------------------
  {
    paquete: 'E0.0',
    id: 'sources-carry-no-nul-bytes',
    enunciado:
      'Ningún fuente lleva un byte NUL, que lo saca entero del alcance de grep sin que ninguna puerta se mueva',
    evaluar: () => {
      const rutas: string[] = [];
      const caminar = (rel: string): void => {
        const abs = rutaDe(rel);
        if (!fs.existsSync(abs)) return;
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
          const hijo = path.join(rel, e.name);
          if (e.isDirectory()) caminar(hijo);
          else if (/[.](ts|sql|json|ya?ml)$/.test(e.name)) rutas.push(hijo);
        }
      };
      for (const raiz of ['src', 'tests', 'scripts']) caminar(raiz);

      const binarios = rutas.filter((r) => crudoDe(r).includes('\u0000'));
      if (binarios.length > 0) {
        return falla(
          `${binarios.length} fuente(s) llevan un byte NUL y están fuera del alcance de grep: ` +
            `${binarios.slice(0, 4).join(', ')}. Escríbelo como el escape \\u0000 dentro del ` +
            `literal: el separador sigue siendo el mismo y el archivo vuelve a ser texto.`
        );
      }
      return ok(
        `${rutas.length} fuentes de src/, tests/ y scripts/ barridos y ninguno lleva un byte NUL: ` +
          `todos siguen siendo alcanzables por grep`
      );
    },
    mutantes: [
      {
        archivo: 'src/plan/conducta.ts',
        de: "'conducta.ts necesita --salida=<archivo.json>\\n'",
        a: "'conducta.ts necesita\u0000--salida=<archivo.json>\\n'",
        porque:
          'un NUL inyectado en un fuente real: si el barrido dejara de mirar, o mirara el disco en ' +
          'vez del seam, este criterio seguiría verde sobre un archivo que grep ya no encuentra',
      },
    ],
  },


  {
    paquete: 'E0.0',
    id: 'language-rule-written-and-lexicon-shared',
    enunciado: 'La regla del idioma está escrita donde se lee, y el léxico que la mide existe',
    evaluar: () => {
      // POR QUÉ NACE (I1, issue #143). El repositorio tenía la regla contraria
      // ESCRITA y en tres sitios: «Los comentarios y la documentación van en
      // español» (CONTRIBUTING, README) y «el español es una capa de alias»
      // (la wiki). Con esa frase en pie, cada PR nuevo nacía en español con
      // razón, y el epic #141 habría sido un tramo peleando contra la propia
      // documentación del proyecto. Cambiar la regla escrita no es papeleo: es
      // lo único que hace que lo NUEVO deje de crecer en español.
      //
      // Y la regla sola no basta, porque «español» no es medible a ojo: hace
      // falta la lista contra la que se mide. El metro (I2) y el lint (I3) van
      // a consumir ESTE léxico y no cada uno el suyo — dos listas distintas
      // publican dos números distintos y entonces nadie sabe cuál miente.
      const contrib = crudoDe('CONTRIBUTING.md');
      if (/Los comentarios y la documentación van en español/.test(contrib)) {
        return falla(
          'CONTRIBUTING vuelve a pedir que los comentarios vayan en español: la regla escrita ' +
            'contradice al epic, y gana la escrita porque es la que se lee al contribuir'
        );
      }
      if (!/nacen en inglés/.test(contrib)) {
        return falla('CONTRIBUTING no dice en qué idioma nace lo nuevo: la regla se quedó sin sustituto');
      }
      // AGENTS.md heredaba la regla por referencia y no tenía la suya. La
      // frontera que tiene que nombrar no es «inglés en el código»: es QUIÉN
      // LEE cada cosa, que es lo que decide de qué capa es.
      const agents = crudoDe('AGENTS.md');
      if (!/Lo que identifica no se traduce nunca/.test(agents)) {
        return falla(
          'AGENTS.md no nombra la frontera entre lo que identifica y lo que se lee: sin ella, el ' +
            'primer tramo que traduzca una clave rompe todo lo que casaba contra ella'
        );
      }
      const p = 'scripts/language/lexicon.ts';
      if (!existe(p)) return falla('no hay léxico: la regla del idioma no se puede medir');
      const lex = codigoDe(p);
      if (!/export const SPANISH_ROOTS/.test(lex) || !/export function classify/.test(lex)) {
        return falla('el léxico no publica ni sus raíces ni su clasificador: no hay una sola población que medir');
      }
      return ok('la regla escrita dice inglés de origen, nombra la frontera, y el léxico que la mide existe');
    },
    mutantes: [
      {
        archivo: 'CONTRIBUTING.md',
        de: 'Los comentarios y la documentación **nacen en inglés**',
        a: 'Los comentarios y la documentación van en español',
        porque:
          'la regla vieja vuelve al sitio donde se lee antes de contribuir, y con ella cada PR nuevo ' +
          'nace en español con razón: el epic entero pasaría a pelear contra la documentación del proyecto',
      },
      {
        archivo: 'AGENTS.md',
        de: 'Lo que identifica no se traduce nunca',
        a: 'Lo que identifica también se traduce',
        porque:
          'traducir una clave no cambia lo que dice, cambia a qué se parece: todo lo que casaba contra ' +
          'ella deja de casar en silencio, y ésa es la advertencia que este archivo existe para dar',
      },
      {
        archivo: 'scripts/language/lexicon.ts',
        de: 'export const SPANISH_ROOTS',
        a: 'const SPANISH_ROOTS',
        porque:
          'el léxico deja de publicar su lista y cada consumidor se hace la suya: el metro y el lint ' +
          'pasan a contar poblaciones distintas y sus dos números dejan de ser comparables',
      },
    ],
  },

  {
    paquete: 'E0.0',
    id: 'nothing-new-is-born-in-spanish',
    enunciado: 'Nada nuevo nace en español: la puerta del idioma es un error, no un aviso',
    evaluar: () => {
      // POR QUÉ NACE (I3, issue #145). El metro de I2 cuenta cuánto español
      // queda; sin puerta, sólo documenta una marea. Y una puerta en AVISO no
      // es una puerta: con 1 117 advertencias ya toleradas, una más no la nota
      // nadie. En error, y con línea base por archivo para que el árbol de hoy
      // no la vuelva impasable.
      //
      // Lo que este criterio vigila es la CONEXIÓN, que es donde se rompe sin
      // que nada se ponga rojo: la regla existe, corre en error, y consume el
      // MISMO léxico que el metro. Si cada uno trae su lista, publican dos
      // números y el día que difieran nadie sabrá cuál miente.
      const conf = crudoDe('eslint.config.mjs');
      if (!/house\/english-identifiers/.test(conf)) {
        return falla('no hay puerta del idioma: lo nuevo puede nacer en español y sólo se sabrá al medirlo');
      }
      if (!/'house\/english-identifiers':\s*'error'/.test(conf)) {
        return falla(
          'la puerta del idioma no está en error: con más de mil advertencias ya toleradas, un aviso ' +
            'más no lo ve nadie y la puerta no cierra'
        );
      }
      if (!existe('scripts/language/lexicon.json')) {
        return falla('el léxico no está publicado como dato: la regla y el metro no pueden compartir población');
      }
      if (!/lexicon\.json/.test(conf)) {
        return falla(
          'la regla no lee el léxico compartido: en cuanto traiga su propia lista, el metro y la ' +
            'puerta cuentan cosas distintas y sus dos cifras dejan de ser comparables'
        );
      }
      return ok('la puerta del idioma corre en error sobre los tres árboles y comparte el léxico del metro');
    },
    mutantes: [
      {
        archivo: 'eslint.config.mjs',
        de: "'house/english-identifiers': 'error'",
        a: "'house/english-identifiers': 'warn'",
        porque:
          'la puerta pasa a avisar, y un aviso más entre mil ciento diecisiete no lo ve nadie: el ' +
          'español vuelve a poder entrar con la CI en verde, que es justo lo que este tramo cierra',
      },
    ],
  },


  {
    paquete: 'E0.0',
    id: 'commit-subjects-born-english',
    enunciado: 'Los asuntos de commit nacen en inglés, y un lint en la CI rechaza los que no',
    evaluar: () => {
      // POR QUÉ NACE (I22, issue #165). El repositorio ordenaba lo CONTRARIO,
      // por escrito y en dos sitios: «En español» abría la sección de mensajes
      // de commit de CONTRIBUTING, y PROCESS decía «hasta que ese tramo entre,
      // los commits siguen en español». Con esas dos frases en pie, 193 de los
      // 295 asuntos sin fusión de `main` llevan acento y todos tenían razón.
      //
      // Es la misma lección que I1 una línea más arriba: cambiar la regla
      // escrita no es papeleo, es lo único que hace que lo nuevo deje de nacer
      // en español. Y por eso este criterio vigila TRES cosas que se pudren
      // por separado —la orden, el tiempo verbal del proceso, y el cableado de
      // la puerta—: una puerta cuyo documento dice lo contrario es una puerta
      // que la gente rodea, y un documento cuya puerta no corre es una
      // promesa.
      const contrib = crudoDe('CONTRIBUTING.md');
      const commits = sectionOf(contrib, '## Mensajes de commit');
      if (commits === null) {
        return falla('CONTRIBUTING perdió su sección de mensajes de commit: la regla se quedó sin sitio donde leerse');
      }
      // ACOTADO A SU SECCIÓN, no al archivo: «en español» aparece también en
      // la frase legítima sobre la línea base por archivo, y un ancla que no
      // acota acaba midiendo la oración equivocada.
      if (commits.includes('En español')) {
        return falla(
          'la sección de commits de CONTRIBUTING vuelve a pedir español: gana lo escrito, porque es ' +
            'lo que se lee antes de contribuir'
        );
      }
      if (!commits.includes('**En inglés.** El asunto lleva el código del tramo')) {
        return falla('CONTRIBUTING no dice en qué idioma nace el asunto de un commit');
      }

      const processDoc = sectionOf(crudoDe('docs/PROCESS.md'), '## Mensajes de commit');
      if (processDoc === null) return falla('PROCESS perdió su sección de mensajes de commit');
      if (processDoc.includes('siguen en español')) {
        return falla(
          'PROCESS vuelve a decir que los commits siguen en español: el documento del proceso ' +
            'contradice a la puerta, y quien lo lea escribirá en español con permiso'
        );
      }
      if (!processDoc.includes('es inglés desde I22')) {
        return falla('PROCESS no dice que el idioma del commit YA es inglés: sigue prometiendo un tramo que entró');
      }
      if (!processDoc.includes('no se reescribe')) {
        return falla('PROCESS dejó de decir que el historial no se reescribe, que es la mitad de la regla que protege el registro');
      }

      // El lint existe, y NO se escribió su propia lista (regla 3.1 del rector:
      // una sola población, un solo léxico).
      const scriptPath = 'scripts/language/commit-subjects.ts';
      if (!existe(scriptPath)) return falla('no hay lint de asunto: la regla escrita no tiene quien la haga cumplir');
      const lint = codigoDe(scriptPath);
      // IMPORTARLO NO ES USARLO. La primera versión se conformaba con ver el
      // `import`, y un import que nadie llama es exactamente lo que queda
      // cuando alguien sustituye el detector compartido por una regex propia y
      // no limpia la cabecera: el criterio seguía verde sobre un archivo que ya
      // no compartía población con el metro.
      if (!/import \{ judgeLanguage \} from '\.\/extract\.js';/.test(lint) || !/judgeLanguage\(/.test(lint)) {
        return falla(
          'el lint de asunto dejó de consumir el detector compartido: se hizo su propia lista, y dos ' +
            'listas publican dos números'
        );
      }

      // La fecha de corte vive en UN sitio y el documento la cita. Dos copias
      // de la misma cifra es como una de las dos empieza a mentir.
      const cutoff = /SUBJECT_RULE_EFFECTIVE_FROM\s*=\s*'([0-9TZ:.-]+)'/.exec(lint)?.[1];
      if (cutoff === undefined) {
        return falla('el lint no declara desde cuándo rige: sin corte, o juzga la historia entera o no juzga nada');
      }
      if (!commits.includes(cutoff)) {
        return falla(`CONTRIBUTING no cita la fecha de corte ${cutoff} que declara el lint: dos cifras de lo mismo, y una miente`);
      }

      // `crudoDe` y no `codigoDe` sobre el YAML, por la razón que el criterio
      // de al lado documenta: `codigoDe` se lleva 1 576 caracteres del archivo.
      const ci = crudoDe('.github/workflows/ci.yml');
      const job = sectionOf(ci, '  commit-subjects:', /^ {2}[a-z][a-z-]*:$/m);
      if (job === null) return falla('la CI no tiene job de asuntos de commit: el lint existe y nadie lo corre');

      // EL JOB SE MIDE SIN SUS COMENTARIOS, y ésta es la lección del tramo.
      //
      // El primer intento comprobaba `fetch-depth: 0` a secas, y el propio job
      // lleva un comentario que EXPLICA por qué esa línea va marcada — citando
      // `fetch-depth: 0`. El mutante ponía la profundidad en 1 y el criterio
      // seguía verde, casando contra la prosa que habla de la línea en vez de
      // contra la línea. Arreglar ESA aparición no arregla la clase: cualquier
      // comentario nuevo que nombre el guion dejaría vivo al mutante que borra
      // la invocación. Así que se quita el comentario, no se esquiva.
      //
      // `crudoDe` sigue siendo el lector —`codigoDe` sobre YAML se lleva 1 576
      // caracteres del archivo— y el recorte es sólo de líneas que empiezan por
      // `#`, que es lo que un comentario de YAML es.
      const withoutComments = job.replace(/^[ \t]*#.*$/gm, '');
      const invocation = `npx tsx ${scriptPath} --range "origin/$BASE_REF..$HEAD_SHA"`;
      if (!withoutComments.includes(invocation)) {
        return falla('el job de asuntos de commit ya no invoca al lint sobre el rango del PR: queda un job verde que no juzga nada');
      }
      if (!withoutComments.includes('fetch-depth: 0')) {
        return falla('el job de asuntos de commit clona a profundidad 1: vería un commit y el rango ni se resuelve');
      }
      // LAS TRES FORMAS BARATAS DE APAGAR UN JOB SIN BORRARLO.
      //
      // El mutante que este criterio declara contra la invocación describe «el
      // gesto de desactivar un momento», pero ese gesto casi nunca se escribe
      // borrando el comando: se escribe con `|| true`, con `continue-on-error`
      // o cambiando la condición. Las tres dejan el job en su sitio, con su
      // nombre y su verde. Si el criterio no las nombra, el espejo vigila la
      // única variante que nadie usa.
      if (/\|\|\s*true/.test(withoutComments) || /continue-on-error/.test(withoutComments)) {
        return falla('el job de asuntos de commit se traga su propio fallo (`|| true` o `continue-on-error`): corre, informa y no detiene nada');
      }
      if (!withoutComments.includes("if: github.event_name == 'pull_request'")) {
        return falla('el job de asuntos de commit perdió su condición: o no corre nunca, o corre sobre `main`, donde el rojo no se puede arreglar sin reescribir el registro');
      }
      // EL TÍTULO ES LA ÚNICA CADENA QUE EL SQUASH ESCRIBE EN `main`.
      // Sin estas dos variables el lint no lo juzga —y desde la revisión, se
      // niega a pasar—, así que borrar una línea de `env:` desarmaría la mitad
      // del tramo con el job y el criterio los dos en verde.
      for (const variable of ['PR_TITLE:', 'PR_CREATED_AT:']) {
        if (!withoutComments.includes(variable)) {
          return falla(`el job de asuntos de commit dejó de pasar ${variable} al lint: el título del PR —lo que el squash escribe en main— deja de juzgarse`);
        }
      }
      return ok(
        'la orden escrita dice inglés, el proceso la da por entregada, y el lint que la mide corre en la ' +
          'CI con el historial a la vista, sin tragarse su propio fallo'
      );
    },
    mutantes: [
      {
        archivo: 'CONTRIBUTING.md',
        de: '**En inglés.** El asunto lleva el código del tramo',
        a: '**En español.** El asunto lleva el código del tramo',
        porque:
          'la orden vuelve a pedir español donde se lee antes de contribuir, y con ella cada asunto nuevo ' +
          'nace en español con razón: el lint pasa a pelear contra la documentación del propio proyecto, ' +
          'y gana la documentación porque es la que se lee',
      },
      {
        archivo: 'docs/PROCESS.md',
        de: 'El idioma **es inglés desde I22**',
        a: 'El idioma pasa al inglés con I22 — decidido, pero todavía pendiente',
        porque:
          'el proceso vuelve a describir el cambio como futuro: quien lea PROCESS escribe en español con ' +
          'permiso y se encuentra un rojo que ningún documento le explica',
      },
      {
        archivo: 'scripts/language/commit-subjects.ts',
        de: "import { judgeLanguage } from './extract.js';",
        a: 'const judgeLanguage = (t: string) => ({ spanish: /[áéíóúñ]/i.test(t) });',
        porque:
          'el lint se escribe su propio detector y deja de compartir población con el metro: los 73 ' +
          'asuntos españoles SIN acento que este mismo árbol mide pasarían en verde, y la casa tendría ' +
          'dos listas publicando dos números',
      },
      {
        archivo: 'scripts/language/commit-subjects.ts',
        de: "SUBJECT_RULE_EFFECTIVE_FROM = '2026-09-17T00:00:00Z'",
        a: "SUBJECT_RULE_EFFECTIVE_FROM = '2099-01-01T00:00:00Z'",
        porque:
          'mover la fecha de corte hacia adelante perdona en silencio todo lo que el tramo vino a ' +
          'rechazar: el job sigue ahí, sigue verde, y no juzga un solo asunto',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: 'fetch-depth: 0 # commit-subjects',
        a: 'fetch-depth: 1 # commit-subjects',
        porque:
          'con profundidad 1 el runner tiene un commit y el rango no se resuelve: el job falla siempre o ' +
          'no mira nada, y de las dos formas deja de ser una puerta',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: 'npx tsx scripts/language/commit-subjects.ts --range',
        a: 'echo skipped for now --range',
        porque:
          'el gesto de «desactivar un momento» un job rojo deja el job en su sitio, con su nombre y su ' +
          'verde, y sin nadie juzgando un solo asunto',
      },
      // LOS TRES ESPEJOS QUE FALTABAN, y que una revisión adversaria encontró
      // vivos: el mutante de arriba describe «desactivar un momento», pero
      // nadie desactiva un job borrando el comando. Se escribe así.
      {
        archivo: '.github/workflows/ci.yml',
        de: '--range "origin/$BASE_REF..$HEAD_SHA"',
        a: '--range "origin/$BASE_REF..$HEAD_SHA" || true',
        porque:
          'el lint corre, imprime cada asunto que rechaza y sale 0: el job queda verde con sus fallos a ' +
          'la vista en la bitácora, que es la forma más silenciosa de apagar una puerta',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: "    if: github.event_name == 'pull_request'",
        a: '    if: false',
        porque:
          'el job no corre nunca más y reporta «skipped», que GitHub da por satisfecho: queda con su ' +
          'nombre en la lista de comprobaciones y sin juzgar un solo asunto',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: 'PR_TITLE: ${{ github.event.pull_request.title }}',
        a: 'PR_TITLE_UNUSED: ${{ github.event.pull_request.title }}',
        porque:
          'el título deja de juzgarse, y el título es la ÚNICA cadena que el squash escribe en `main` ' +
          'cuando el PR trae más de un commit: los commits pasarían en inglés y el asunto que queda en ' +
          'la historia podría estar en español',
      },
    ],
  },




  {
    paquete: 'E0.0',
    id: 'language-has-a-meter-with-a-baseline',
    enunciado: 'El idioma tiene metro con línea base, y la CI lo corre',
    evaluar: () => {
      // POR QUÉ NACE (I2, issue #144). El epic #141 traduce el código en
      // veintisiete tramos, y sin una cifra por deuda ninguno es evaluable:
      // «queda español» no se puede cerrar. Un plan cuyo avance no se mide se
      // abandona a la mitad — y quedarse a medias aquí es peor que no
      // empezar, porque deja dos convenciones vivas y ninguna vigente.
      //
      // El criterio vigila las DOS piezas, porque cada una sin la otra es
      // decorativa: el metro sin su línea base publica un número que nadie
      // compara, y la línea base sin `--check` en la CI es un archivo que
      // nadie lee.
      // `crudoDe` y no `codigoDe`: el segundo recorta comentarios y sobre un YAML
      // se lleva por delante parte del archivo — medido, 1 576 caracteres —, así
      // que la línea que este criterio busca desaparecía y daba un rojo falso.
      // Los criterios de ci.yml que ya existían leen en crudo por esta razón.
      const ci = crudoDe('.github/workflows/ci.yml');
      // Por el PASO y no por la cadena (T2): el ancla de subcadena casaba
      // también dentro del comentario que explica el paso, así que comentarlo
      // lo dejaba verde. Misma plantilla que las otras tres puertas.
      if (!stepRuns(ci, 'npx tsx scripts/language-status.ts --check')) {
        return falla(
          'la CI no corre el metro del idioma: la línea base deja de comprobarse y el español ' +
            'puede crecer sin que nada lo diga'
        );
      }
      if (!existe('docs/language-baseline.json')) {
        return falla('no hay línea base del idioma: `--check` no tiene contra qué comparar');
      }
      const base = JSON.parse(crudoDe('docs/language-baseline.json')) as {
        lanes?: Record<string, number>;
      };
      const carriles = Object.keys(base.lanes ?? {});
      if (carriles.length === 0) {
        return falla('la línea base del idioma está vacía: un trinquete sin carriles siempre pasa');
      }
      return ok(`${carriles.length} carriles con línea base, y la CI corre --check`);
    },
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: 'npx tsx scripts/language-status.ts --check',
        a: 'npx tsx scripts/language-status.ts',
        porque:
          'el metro se sigue imprimiendo y deja de juzgar: sale 0 pase lo que pase, y el español ' +
          'crece con la CI en verde — que es exactamente la clase de instrumento que este ' +
          'repositorio persigue',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/language-status.ts --check',
        a: '      # - run: npx tsx scripts/language-status.ts --check',
        porque:
          'la puerta se apaga comentándola, y el ancla de subcadena de antes de T2 casaba dentro del propio comentario',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'user-language-has-one-door',
    // I6 (issue #148). El catálogo tipado y el resolutor de locale, vigilados
    // por lo que de verdad se puede romper sin que nadie lo note.
    //
    // NO VIGILA QUE LAS CADENAS ESTÉN TRADUCIDAS —de eso se encarga `tsc`, y
    // mejor: `ES` es `Record<keyof typeof EN, string>`, así que una clave sin
    // traducir no compila—. Vigila las CINCO cosas que sí se pueden perder en
    // silencio, y cada una se perdió de verdad durante la construcción de este
    // tramo:
    //
    //   1. Que el idioma se DERIVE y no se congele al importar. La primera
    //      versión fijaba `activeLanguage = LANGUAGES[0]` en la línea 97 y
    //      `setLanguage` no tenía un solo llamador: el catálogo existía, sus
    //      cuarenta pruebas estaban en verde, y no traducía nada.
    //   2. Que el nombre de la variable de entorno viva en UN sitio. Con dos,
    //      la precedencia se implementa dos veces y se desincroniza; era el
    //      estado ANTES de este tramo (config.ts y mnemosine.ts).
    //   3. Que el español siga siendo el primero. Es el pedido del dueño, y es
    //      una línea que cualquiera reordena sin querer al añadir un idioma.
    //   4. That the REST edge builds the tags it offers from `DEFAULT_LOCALE`.
    //      `Accept-Language: *` takes the first one, and the list was written by
    //      hand: moving the constant left REST on the old default (MNE-001-465).
    //   5. That the `## Language` section of the OpenAPI description names no
    //      locale by hand. It wrote `es-MX` while four other places of the same
    //      contract followed the constant, so moving it would have made the
    //      generated contract contradict itself.
    enunciado:
      'El idioma del usuario se deriva del locale, y el nombre de su variable de entorno vive en un solo archivo',
    evaluar: () => {
      const missing = ['src/i18n/en.ts', 'src/i18n/es.ts', 'src/i18n/index.ts', 'src/i18n/locale.ts'].filter(
        (f) => !existe(f)
      );
      if (missing.length) return falla(`el catálogo no está: falta ${missing.join(', ')}`);

      // 1 · EL IDIOMA SE DERIVA. Si `t()` toma su idioma de una variable de
      // módulo, el valor queda clavado al importar y ningún cambio de locale
      // lo mueve. La forma que se exige es que la omisión sea una LLAMADA.
      const index = codigoDe('src/i18n/index.ts');
      if (!/=\s*getLanguage\(\)/.test(index)) {
        return falla(
          'el idioma por omisión de `t()` no sale de una llamada: si es una variable de módulo, ' +
            'queda decidido al importar y el catálogo no traduce nada aunque sus pruebas estén verdes'
        );
      }
      if (!/resolveLocale\s*\(/.test(index)) {
        return falla('el catálogo no consulta `resolveLocale`: el idioma no se deriva del locale');
      }

      // 2 · UNA SOLA PUERTA AL ENTORNO. Se cuenta el nombre EN POSICIÓN DE
      // VALOR —`X = 'MNEMOSINE_LOCALE'` o `{ k: 'MNEMOSINE_LANG' }`—, no cada
      // vez que aparece.
      //
      // Y NO SE CONFÍA EN `codigoDe` PARA ESTO, aunque quite comentarios: lo
      // probé y NO los quitó aquí. Los dos comentarios de mnemosine.ts que
      // nombran la variable la escriben entre acentos graves —`MNEMOSINE_LANG`,
      // al estilo markdown— y el escáner de `withoutComments` toma ese acento
      // por el inicio de una plantilla y deja de ver el comentario. Es un
      // defecto del instrumento del plan, no de este tramo; aquí sólo se evita
      // depender de él. La posición de valor la prosa no la imita.
      const doors = fuentes('src').filter((f) =>
        /(?:=|:)\s*['"]MNEMOSINE_(?:LOCALE|LANG)['"]/.test(crudoDe(path.relative(RAIZ, f)))
      );
      if (doors.length !== 1) {
        return falla(
          `${doors.length} archivo(s) de src/ nombran la variable de entorno del idioma ` +
            `(${doors.map((f) => path.relative(RAIZ, f)).join(', ')}): con más de uno la precedencia ` +
            'se implementa dos veces y se desincroniza, que es como estaba antes de I6'
        );
      }

      // 3 · ESPAÑOL PRIMERO. El pedido del dueño, en una línea que se reordena
      // sin querer.
      if (!/LANGUAGES\s*=\s*\[\s*'es'/.test(index)) {
        return falla('`LANGUAGES` ya no empieza por `es`: el español dejó de ser el primero');
      }

      // 4 and 5 read string and template literals through the AST, so a comment
      // that names `es-MX` is prose and never counts. The tag patterns come from
      // `LOCALES` and their languages: a third locale is covered with no edit.
      const MIDDLEWARE = 'src/api/rest/middleware/locale.ts';
      const OPENAPI = 'src/api/rest/openapi.ts';
      const gone = [MIDDLEWARE, OPENAPI].filter((f) => !existe(f));
      if (gone.length) return falla(`the REST edge this criterion reads is gone: ${gone.join(', ')} is missing`);
      const literalsOf = (rel: string): string[] => {
        const texts: string[] = [];
        const sf = ts.createSourceFile(path.basename(rel), crudoDe(rel), ts.ScriptTarget.Latest, true);
        forEachGatewayNode(sf, (n) => {
          const text = literalText(n);
          if (text !== undefined) texts.push(text);
        });
        return texts;
      };
      const escaped = (tags: readonly string[]): string =>
        tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const asToken = (tags: readonly string[], flags = ''): RegExp =>
        new RegExp(`(?<![A-Za-z-])(?:${escaped(tags)})(?![A-Za-z-])`, flags);
      const shortForms = LOCALES.map(languageOfLocale);

      // 4 · THE REST EDGE OFFERS ITS TAGS FROM THE DEFAULT. The whole file is
      // read, not only `OFFERED_TAGS`: a literal list handed straight to
      // `acceptsLanguages` is the same defect.
      const anyTag = asToken([...LOCALES, ...shortForms], 'i');
      const handListed = literalsOf(MIDDLEWARE).filter((t) => anyTag.test(t));
      if (handListed.length) {
        return falla(
          `${MIDDLEWARE} writes a locale or language tag by hand (${handListed.map((t) => JSON.stringify(t)).join(', ')}): ` +
            '`Accept-Language: *` takes the first tag offered, so a hand-written list keeps answering the old ' +
            'default the day `DEFAULT_LOCALE` moves. Build the tags with `offeredTagsFor(DEFAULT_LOCALE)`'
        );
      }

      // 5 · THE CONTRACT'S LANGUAGE SECTION FOLLOWS THE CONSTANT. The section is
      // found by its heading in the static text, not by the name of the array
      // that holds it, and a missing heading fails closed.
      const description = literalsOf(OPENAPI).join('\u0000');
      const heading = description.indexOf('\n## Language\n');
      if (heading === -1) {
        return falla(
          `${OPENAPI} has no \`## Language\` heading in its static text, so this criterion cannot see what ` +
            'the contract says about the default language: it fails closed'
        );
      }
      const fromHeading = description.slice(heading + 1);
      const nextHeading = fromHeading.indexOf('\n## ');
      const section = nextHeading === -1 ? fromHeading : fromHeading.slice(0, nextHeading);
      const regionTag = asToken(LOCALES);
      const bareLanguage = new RegExp(`\`(?:${escaped(shortForms)})\``);
      const handWritten = section.split('\u0000').find((t) => regionTag.test(t) || bareLanguage.test(t));
      if (handWritten !== undefined) {
        return falla(
          `the \`## Language\` section of ${OPENAPI} names a locale by hand (${JSON.stringify(handWritten.slice(0, 80))}): ` +
            'the rest of the contract follows `DEFAULT_LOCALE`, so moving it would leave this sentence stating ' +
            'the old default. Interpolate `LOCALES` and `DEFAULT_LOCALE`'
        );
      }

      return ok(
        'el idioma se deriva del locale en cada llamada, su variable de entorno se nombra en un ' +
          `solo archivo (${path.relative(RAIZ, doors[0])}) y el español sigue primero`
      );
    },
    mutantes: [
      {
        archivo: 'src/i18n/index.ts',
        de: 'export const LANGUAGES = [\'es\', \'en\'] as const;',
        a: 'export const LANGUAGES = [\'en\', \'es\'] as const;',
        porque: 'el español deja de ser el primero, que es el pedido del dueño y una línea que se reordena sin querer',
      },
      {
        // LA SEGUNDA PUERTA, encarnada donde de verdad estuvo hasta este tramo:
        // `config.ts` leía la variable por su cuenta, en paralelo a
        // `mnemosine.ts`, y por eso la precedencia estaba implementada dos
        // veces. El mutante la devuelve.
        archivo: 'src/ai/providers/config.ts',
        de: 'export function resolveLanguage(cwd = process.cwd()): AgentLanguage {',
        a:
          "const SEGUNDA_PUERTA = 'MNEMOSINE_LANG';\n" +
          'export function resolveLanguage(cwd = process.cwd()): AgentLanguage {\n' +
          '  void SEGUNDA_PUERTA;',
        porque:
          'segunda-puerta: un segundo archivo nombra la variable del idioma y la precedencia vuelve a implementarse dos veces',
      },
      {
        archivo: 'src/api/rest/middleware/locale.ts',
        de: 'const OFFERED_TAGS = offeredTagsFor(DEFAULT_LOCALE);',
        a: "const OFFERED_TAGS = ['es-MX', 'en-US', 'es', 'en'] as const;",
        porque:
          'hand-listed-tags: the REST edge lists its tags by hand again, so `Accept-Language: *` keeps ' +
          'answering the old default the day `DEFAULT_LOCALE` moves',
      },
      {
        archivo: 'src/api/rest/openapi.ts',
        de: "`Every request negotiates a language from \\`Accept-Language\\` (${LOCALES.map((l) => `\\`${l}\\``).join(' or ')}; \\`${DEFAULT_LOCALE}\\` when `,",
        a: "'Every request negotiates a language from `Accept-Language` (`es-MX` or `en-US`; `es-MX` when ',",
        porque:
          'hand-written-default: the Language section of the contract names `es-MX` by hand again, so ' +
          'moving `DEFAULT_LOCALE` would leave the generated contract stating two defaults',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'the-user-language-is-written-where-it-is-read',
    // I11 · 4 (issue #153). Las dos decisiones que cerraban el tramo: el
    // comando que CAMBIA el idioma, y la identidad de máquina de los chequeos
    // de doctor. Vive junto a `user-language-has-one-door` porque es su otra
    // mitad: aquél vigila que el idioma se LEA por una sola puerta; éste, que
    // se ESCRIBA en la puerta que se lee.
    //
    // EL DEFECTO QUE EXISTE PARA QUE NO VUELVA, reproducido antes de arreglarlo:
    // con un proyecto que fija `locale: en-US`, `mnemosine lang es` escribía la
    // clave vieja `language` en el archivo del PROYECTO e imprimía «✔ Agent will
    // now answer in Spanish». El idioma seguía en inglés. Escribir por debajo de
    // lo que ya gana es imprimir éxito sin cambiar nada, y ninguna prueba de
    // contenido lo nota: la línea de éxito es cierta COMO TEXTO, y el archivo
    // que se escribió existe y tiene dentro lo que se le pidió.
    //
    // SE LEE POR EL AST Y NO POR SUBCADENA, y no es preferencia de estilo: los
    // comentarios de `mnemosine.ts` que explican este mismo cambio NOMBRAN
    // `setLanguage`, `setUserLocale` y `normalizeLocale` a pocos renglones de la
    // llamada. Un criterio anclado en presencia saldría verde con la llamada
    // borrada y la prosa intacta — y `withoutComments` ya se midió CIEGO en este
    // archivo de tres mil renglones (está escrito en el criterio de I7, aquí al
    // lado). Un comentario no es un nodo del AST: ése es todo el truco.
    enunciado:
      'El comando del idioma valida con la única tabla de grafías y escribe la clave que el resolutor lee, en el archivo que le gana al del proyecto; y todo chequeo de doctor nace con identidad de máquina',
    evaluar: () => {
      const CLI = 'src/cli/mnemosine.ts';
      const CONFIG = 'src/ai/providers/config.ts';
      const DOCTOR = 'src/ai/doctor-service.ts';
      const RESOLVER = 'src/i18n/locale.ts';
      const absent = [CLI, CONFIG, DOCTOR, RESOLVER].filter((f) => !existe(f));
      if (absent.length) {
        return falla(`no están los archivos que este criterio juzga: falta ${absent.join(', ')}`);
      }

      function* walkAll(node: ts.Node): Generator<ts.Node> {
        yield node;
        for (const child of node.getChildren()) yield* walkAll(child);
      }
      const parse = (rel: string): ts.SourceFile =>
        ts.createSourceFile(path.basename(rel), crudoDe(rel), ts.ScriptTarget.Latest, true);
      /** Los nombres que se LLAMAN dentro de un subárbol, por identificador o por método. */
      const calledIn = (node: ts.Node): Set<string> => {
        const names = new Set<string>();
        for (const inner of walkAll(node)) {
          if (!ts.isCallExpression(inner)) continue;
          const callee = inner.expression;
          if (ts.isIdentifier(callee)) names.add(callee.text);
          else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
        }
        return names;
      };

      // 1 · EL COMANDO ESCRIBE DONDE SE LEE. Se acota al ÁRBOL DEL COMANDO
      // `lang` y no al archivo: `mnemosine.ts` registra cuarenta familias y
      // cualquiera de ellas puede llamar legítimamente a un escritor de config.
      const cli = parse(CLI);
      const isLangCommand = (node: ts.Node): boolean =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'command' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'lang';
      const langStatement = cli.statements.find((st) => {
        for (const inner of walkAll(st)) if (isLangCommand(inner)) return true;
        return false;
      });
      if (langStatement === undefined) {
        return falla(
          `no hay un comando \`lang\` en ${CLI}: el único sitio donde una persona cambia su idioma sin ` +
            'editar JSON a mano desapareció'
        );
      }
      const langCalls = calledIn(langStatement);
      if (!langCalls.has('setUserLocale')) {
        return falla(
          '`mnemosine lang` no llama a `setUserLocale`: escribe el idioma en un sitio distinto del que ' +
            'el resolutor lee primero, e imprime éxito sin cambiar nada — el defecto que I11 reprodujo ' +
            'con un proyecto que fijaba `locale: en-US`'
        );
      }
      if (langCalls.has('setLanguage')) {
        return falla(
          '`mnemosine lang` vuelve a llamar a `setLanguage`, el escritor de la clave vieja: pone ' +
            '`language` en el archivo de config ACTIVO —el del proyecto antes que el del usuario— y ' +
            'cualquier `locale` ya escrito le gana en `describeLocale` sin que el comando lo diga'
        );
      }

      // 2 · UNA SOLA TABLA DE GRAFÍAS. Dos respuestas a «¿es aceptable es-MX?»
      // es exactamente cómo nacieron los dos lectores de la variable de entorno
      // que I6 vino a cerrar: antes de este tramo la rama era
      // `language === 'en' || language === 'es'`, y el comando cuyo oficio es
      // fijar el locale rechazaba `es-MX`, que `--locale` sí aceptaba.
      if (!langCalls.has('normalizeLocale')) {
        return falla(
          '`mnemosine lang` no valida con `normalizeLocale`: la tabla de grafías aceptadas se escribió ' +
            'por segunda vez, y la segunda siempre acaba aceptando otras cosas que la primera'
        );
      }
      const actionCall = [...walkAll(langStatement)].find(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'action'
      );
      const handler = actionCall?.arguments[0];
      if (handler === undefined || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        return noEvaluable(
          'el comando `lang` ya no registra su acción como una función en línea: este criterio no sabe ' +
            'leer esa forma, y aproximar aquí sería inventarse un verde'
        );
      }
      const rawParameter = handler.parameters[0]?.name;
      if (rawParameter === undefined || !ts.isIdentifier(rawParameter)) {
        return noEvaluable(
          'la acción de `lang` no recibe el idioma pedido como un parámetro con nombre: este criterio ' +
            'no sabe leer esa forma'
        );
      }
      // Se juzga lo que se hace con el ARGUMENTO CRUDO, no cualquier `=== 'es'`:
      // el propio comando compara `languageOfLocale(locale) === 'es'` para elegir
      // entre «Spanish» e «English», y eso es RENDIR, no validar. Un criterio que
      // no distinguiera las dos se pondría rojo sobre el árbol correcto, y una
      // puerta que da rojo por la razón equivocada se acaba borrando.
      const rawName = rawParameter.text;
      const isRaw = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === rawName;
      for (const inner of walkAll(handler)) {
        const comparesRaw =
          ts.isBinaryExpression(inner) &&
          (inner.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            inner.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
          ((isRaw(inner.left) && ts.isStringLiteral(inner.right)) ||
            (isRaw(inner.right) && ts.isStringLiteral(inner.left)));
        const listsRaw =
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          (inner.expression.name.text === 'includes' || inner.expression.name.text === 'indexOf') &&
          ts.isArrayLiteralExpression(inner.expression.expression) &&
          inner.arguments.some(isRaw);
        if (comparesRaw || listsRaw) {
          return falla(
            `la acción de \`lang\` juzga \`${rawName}\` con una lista en línea (${inner.getText().replace(/\s+/g, ' ').slice(0, 70)}): ` +
              'es una segunda tabla de grafías junto a `normalizeLocale`, y las dos se separan el día ' +
              'que se añada un idioma'
          );
        }
      }

      // 3 · EL ESCRITOR APUNTA AL ARCHIVO DEL USUARIO Y ESCRIBE LA CLAVE NUEVA.
      const config = parse(CONFIG);
      const writer = [...walkAll(config)].find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === 'setUserLocale'
      );
      if (writer === undefined || writer.body === undefined) {
        return falla(
          `\`setUserLocale\` ya no existe en ${CONFIG}: el único escritor que apunta al archivo del ` +
            'usuario desapareció'
        );
      }
      const writerCalls = calledIn(writer.body);
      if (!writerCalls.has('userConfigPath')) {
        return falla(
          '`setUserLocale` ya no resuelve su destino con `userConfigPath`: si escribe en el ' +
            '`mnemosine.config.json` del repositorio, archiva el idioma POR DEBAJO del archivo del ' +
            'usuario, que es el escalón que `describeLocale` lee primero a propósito (regla 5 del épico)'
        );
      }
      const keysOf = (call: ts.CallExpression): string[] => {
        const first = call.arguments[0];
        if (first === undefined || !ts.isObjectLiteralExpression(first)) return [];
        return first.properties.flatMap((prop) =>
          prop.name !== undefined && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
            ? [prop.name.text]
            : []
        );
      };
      const patches = [...walkAll(writer.body)].filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'writeConfigPatch'
      );
      const wrongKey = patches.find((call) => keysOf(call).join(',') !== 'locale');
      if (patches.length === 0 || wrongKey !== undefined) {
        return falla(
          `\`setUserLocale\` escribe {${wrongKey === undefined ? '' : keysOf(wrongKey).join(', ')}} en vez de ` +
            'la clave `locale`: `describeLocale` lee `language` DEBAJO de `locale`, así que a quien ya ' +
            'tenga un locale puesto el comando le seguiría mintiendo en verde'
        );
      }
      // LA CUARENTENA LA DECIDE EL CONTENIDO, NO UN CATCH (Witness WIT-01, #286).
      // La primera versión envolvía la escritura en un catch y trataba CUALQUIER
      // error como archivo roto: un EIO al escribir un config válido lo borraba.
      // Así que el rescate tiene que colgar de un `if` cuya condición diagnostica
      // el contenido (`existingConfigIsUnusable`), y ningún catch del escritor
      // puede poner nada en cuarentena.
      const catchAll = [...walkAll(writer.body)].find(
        (node): node is ts.CatchClause => ts.isCatchClause(node) && calledIn(node.block).has('quarantineInvalidConfig')
      );
      if (catchAll !== undefined) {
        return falla(
          '`setUserLocale` pone en cuarentena desde un catch: un error de E/S al escribir un config ' +
            'VÁLIDO lo retiraría y lo reescribiría con `{ locale }` a secas, perdiendo el inquilino y el proveedor'
        );
      }
      const rescue = [...walkAll(writer.body)].find(
        (node): node is ts.IfStatement =>
          ts.isIfStatement(node) && calledIn(node.expression).has('existingConfigIsUnusable')
      );
      const rescueCalls = rescue === undefined ? new Set<string>() : calledIn(rescue.thenStatement);
      if (!rescueCalls.has('quarantineInvalidConfig') || !rescueCalls.has('writeConfigPatch')) {
        return falla(
          '`setUserLocale` no pone en cuarentena el config ilegible y REINTENTA: una coma de más en ' +
            '`~/.mnemosine/config.json` deja a su dueño sin poder cambiar de idioma, y arreglarlo es ' +
            'justo lo que venía a hacer. Es la misma clase de fallo que `src/i18n/locale.ts` ya rechazó ' +
            'por escrito para la LECTURA'
        );
      }

      // 4 · LA IDENTIDAD DE DOCTOR NO ES PROSA (#253, una capa más abajo).
      //
      // Se recorren los CONSTRUCTORES DE VERDAD y no una lista escrita a mano:
      // una lista se queda corta el día que alguien añade un chequeo, y un censo
      // que no llega a mirarlo lo aprueba por omisión. Un constructor se
      // reconoce por su forma —`level` con uno de los tres niveles y `detail`—,
      // que es lo que el tipo obliga, y no por el nombre del archivo.
      const resultInterface = [...walkAll(parse(DOCTOR))].find(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === 'CheckResult'
      );
      if (resultInterface === undefined) {
        return falla(`no hay interfaz \`CheckResult\` en ${DOCTOR}: el contrato de un chequeo desapareció`);
      }
      const idMember = resultInterface.members.find(
        (member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === 'id'
      );
      if (idMember === undefined || idMember.questionToken !== undefined) {
        return falla(
          '`CheckResult.id` no es obligatorio: con el campo opcional la identidad vuelve a ser una ' +
            'costumbre, el chequeo que se olvide de ponerla compila igual, y quien consuma ' +
            '`doctor --json` acaba agrupando por el rótulo — que es prosa traducible'
        );
      }

      const LEVELS = new Set(['ok', 'warn', 'fail']);
      const PROSE_FIELDS = /^(name|label|title)$/;
      let checkCount = 0;
      const anonymous: string[] = [];
      const derived: string[] = [];
      for (const abs of fuentes('src')) {
        const rel = path.relative(RAIZ, abs);
        const text = leer(abs);
        if (!/CheckResult|CheckIdentity/.test(text)) continue;
        const source = ts.createSourceFile(path.basename(rel), text, ts.ScriptTarget.Latest, true);
        for (const node of walkAll(source)) {
          if (!ts.isObjectLiteralExpression(node)) continue;
          const own = new Map<string, ts.ObjectLiteralElementLike>();
          let spreads = false;
          for (const prop of node.properties) {
            if (ts.isSpreadAssignment(prop)) {
              spreads = true;
              continue;
            }
            if (prop.name !== undefined && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
              own.set(prop.name.text, prop);
            }
          }
          const level = own.get('level');
          const isCheck =
            level !== undefined &&
            ts.isPropertyAssignment(level) &&
            ts.isStringLiteral(level.initializer) &&
            LEVELS.has(level.initializer.text) &&
            own.has('detail');
          // Las TABLAS de identidad entran también: `CHECK_IDENTITIES` y las
          // filas de `LOOKUP_TABLES` son donde vive el id de verdad, y es ahí
          // donde se puede derivar del rótulo sin tocar un solo constructor.
          const isIdentityRow = own.has('id') && (own.has('name') || own.has('label'));
          if (!isCheck && !isIdentityRow) continue;
          const at = `${rel}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (isCheck) {
            checkCount += 1;
            if (!own.has('id') && !spreads) anonymous.push(at);
          }
          const idProp = own.get('id');
          if (idProp !== undefined && ts.isPropertyAssignment(idProp)) {
            const value = idProp.initializer;
            // Un id DECLARADO es un literal, o la lectura de una identidad que
            // vive en otro sitio (`spec.id`). Todo lo demás —una llamada, una
            // plantilla, una concatenación— es un id CALCULADO, y lo único de
            // lo que se puede calcular aquí es el rótulo.
            const stated =
              ts.isStringLiteral(value) || ts.isIdentifier(value) || ts.isPropertyAccessExpression(value);
            const readsField = ts.isPropertyAccessExpression(value)
              ? value.name.text
              : ts.isIdentifier(value)
                ? value.text
                : '';
            if (!stated || PROSE_FIELDS.test(readsField)) {
              derived.push(`${at} → ${value.getText().replace(/\s+/g, ' ').slice(0, 60)}`);
            }
          }
        }
      }
      // EL CENSO, ANTES QUE EL VEREDICTO. Sin él, el día que los chequeos se
      // construyan de otra forma este recorrido encontraría CERO y los aprobaría
      // a todos: es el modo de fallo que la prueba de vacuidad de T2 encontró
      // tres veces. No es un trinquete —los chequeos van y vienen con las
      // funciones— sino el suelo por debajo del cual el instrumento dejó de ver.
      const CHECK_CENSUS_FLOOR = 60;
      if (checkCount < CHECK_CENSUS_FLOOR) {
        return falla(
          `sólo se reconocieron ${checkCount} constructores de \`CheckResult\` y el árbol tiene más de ` +
            `${CHECK_CENSUS_FLOOR}: este recorrido dejó de ver la forma en que se construyen, y un censo ` +
            'que no encuentra nada aprueba a todos por omisión'
        );
      }
      if (anonymous.length) {
        return falla(
          `${anonymous.length} chequeo(s) de doctor se construyen sin identidad ` +
            `(${anonymous.slice(0, 3).join(', ')}): quien consuma \`doctor --json\` tendría que agruparlos ` +
            'y silenciarlos por su rótulo, que es prosa traducible y está camino del catálogo'
        );
      }
      if (derived.length) {
        return falla(
          `${derived.length} identidad(es) de doctor se CALCULAN a partir de su prosa ` +
            `(${derived.slice(0, 3).join(' · ')}): traducir el rótulo cambiaría la llave, que es ` +
            'exactamente el defecto que #253 cerró una capa más arriba, en los informes'
        );
      }

      // 5 · LA CLAVE VIEJA SE SIGUE LEYENDO. Su RETIRO es de I24; aquí sólo se
      // dejó de ESCRIBIR. Un «limpiar lo viejo» que borre este escalón le quita
      // el idioma a quien lo configuró ayer, y lo hace en silencio: caería a
      // es-MX por omisión, que para la mitad de la gente es el idioma correcto.
      const resolver = [...walkAll(parse(RESOLVER))].find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === 'describeLocale'
      );
      if (resolver === undefined || resolver.body === undefined) {
        return falla(`no hay \`describeLocale\` en ${RESOLVER}: la precedencia del idioma desapareció entera`);
      }
      const readsLegacyKey = [...walkAll(resolver.body)].some(
        (node) =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'readConfigString' &&
          node.arguments.some((arg) => ts.isStringLiteral(arg) && arg.text === 'language')
      );
      if (!readsLegacyKey) {
        return falla(
          '`describeLocale` dejó de leer la clave vieja `language`: quien la tuviera escrita de ayer ' +
            'pierde hoy su idioma sin aviso. Este tramo dejó de ESCRIBIRLA; retirar a sus lectores es I24'
        );
      }

      return ok(
        '`mnemosine lang` valida con `normalizeLocale` y escribe `locale` con `setUserLocale` en el ' +
          `archivo del usuario, con cuarentena y reintento; los ${checkCount} constructores de chequeo del ` +
          'árbol traen identidad declarada y ninguna se calcula del rótulo; `describeLocale` sigue leyendo `language`'
      );
    },
    mutantes: [
      {
        // EL CORAZÓN, en la forma exacta que tenía antes de este tramo: el
        // comando escribe la clave vieja, en el archivo activo, y sigue
        // imprimiendo «✔ Agent will now answer in Spanish».
        archivo: 'src/cli/mnemosine.ts',
        de: 'const { file, quarantined } = setUserLocale(locale);',
        a: 'const { file, quarantined } = { file: setLanguage(languageOfLocale(locale)), quarantined: null };',
        porque:
          'escribir-por-debajo: el comando escribe en un escalón que ya pierde, así que imprime éxito sin cambiar nada y ninguna prueba de contenido lo nota',
      },
      {
        archivo: 'src/ai/providers/config.ts',
        de: 'return { file: writeConfigPatch({ locale }, undefined, file), quarantined: null };',
        a: 'return { file: writeConfigPatch({ language: locale }, undefined, file), quarantined: null };',
        porque:
          'clave-equivocada: el archivo correcto con la clave que se lee DEBAJO, así que un `locale` ya puesto sigue ganando',
      },
      {
        archivo: 'src/ai/providers/config.ts',
        de: 'const file = userConfigPath(home);',
        a: "const file = path.join(process.cwd(), 'mnemosine.config.json');",
        porque:
          'archivo-equivocado: la clave correcta en el archivo del proyecto, que es el escalón que `describeLocale` lee DESPUÉS del del usuario',
      },
      {
        // La lista en línea que de verdad estuvo aquí hasta I11: aceptaba dos
        // de las cuatro grafías que el resolutor entiende.
        archivo: 'src/cli/mnemosine.ts',
        de: 'const locale = normalizeLocale(language);',
        a: "const locale = language === 'en' || language === 'es' ? (language as Locale) : null;",
        porque:
          'segunda-tabla: el comando vuelve a tener su propia lista de grafías y rechaza el `es-MX` que `--locale` acepta',
      },
      {
        archivo: 'src/ai/providers/config.ts',
        de:
          '    const quarantined = quarantineInvalidConfig(file);\n' +
          '    if (quarantined === null) {',
        a:
          '    const quarantined: string | null = null;\n' +
          '    if (quarantined === null) {',
        porque:
          'archivo-roto-atrapa: una coma de más en el config del usuario impide cambiar de idioma, que es lo que la persona venía a hacer',
      },
      {
        archivo: 'src/ai/providers/config.ts',
        de: '  if (existingConfigIsUnusable(file)) {',
        a: '  if (fs.existsSync(file)) {',
        porque:
          'cuarentena-sin-diagnostico: todo config existente se retira, sano o no, y se reescribe con `{ locale }` a secas (Witness WIT-01)',
      },
      {
        // El conteo no vale aquí y por eso el recorrido es por AST: se retira la
        // identidad de UN constructor de los ochenta y tantos, dejando el
        // rótulo puesto. Es el estado exacto de este archivo antes de I11.
        archivo: 'src/cli/init/s0-infra.ts',
        de: "        ...RLS_CONTEXT,\n        level: 'ok',\n        detail: 'no tenant pinned yet",
        a: "        name: 'RLS context',\n        level: 'ok',\n        detail: 'no tenant pinned yet",
        porque:
          'chequeo-anónimo: un solo constructor pierde su identidad y conserva el rótulo, que es invisible en pantalla',
      },
      {
        archivo: 'src/ai/doctor-service.ts',
        de: '  /** Stable machine identity. See `CheckIdentity`. */\n  id: string;',
        a: '  /** Stable machine identity. See `CheckIdentity`. */\n  id?: string;',
        porque:
          'campo-opcional: la identidad pasa de obligación a costumbre, y el chequeo que se la olvide compila igual',
      },
      {
        archivo: 'src/ai/doctor-service.ts',
        de: "  database: { id: 'database-connection', name: 'Database' },",
        a: "  database: { id: 'Database'.toLowerCase().replace(/ /g, '-'), name: 'Database' },",
        porque:
          'id-calculado-del-rótulo: la llave vuelve a ser la prosa con otro disfraz, que es el defecto que #253 cerró en los informes',
      },
      {
        archivo: 'src/i18n/locale.ts',
        de: "const raw = readConfigString(activeConfig, 'language', warn);",
        a: "const raw = readConfigString(activeConfig, 'locale', warn);",
        porque:
          'limpiar-lo-viejo: se retira el escalón de la clave vieja y quien la tenga escrita pierde su idioma hoy, cuando su retiro es de I24',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-chrome-and-pilot-speak-by-key',
    // I7 (issue #149). El cromo del CLI y el piloto se rinden POR CLAVE, y el
    // terreno ganado no se puede devolver en silencio.
    //
    // TRES AFIRMACIONES, y cada una vigila una forma distinta de perderlo:
    //
    //   1. El instrumento existe. Si alguien borra el carril, las otras dos
    //      afirmaciones se vuelven incontestables y el tramo entero deja de
    //      medirse sin ponerse rojo.
    //   2. El terreno está ganado: ni `kernel/**` ni el piloto tienen entrada
    //      en el desglose. «Cero» aquí no es un número que alguien escribió:
    //      es la AUSENCIA de la entrada, que es lo que el trinquete de I2
    //      exige y lo que la issue pide con «entradas de la línea base
    //      borradas».
    //   3. El cromo se instala ANTES de la primera familia. El orden es el
    //      defecto: si las familias se registran primero, sus descripciones
    //      ya se rindieron con el idioma equivocado y ninguna prueba de
    //      contenido lo nota, porque el texto que sale es válido — sólo que
    //      en el otro idioma.
    enunciado:
      'El cromo del CLI se instala antes de la primera familia, y el kernel y el piloto no cargan una sola cadena sin clave',
    evaluar: () => {
      const rel = 'docs/language-baseline.json';
      if (!existe(rel)) return noEvaluable(`no existe ${rel}: el metro de I2 no está en este árbol`);
      let baseline: { lanes?: Record<string, number>; perFile?: Record<string, Record<string, number>> };
      try {
        baseline = JSON.parse(crudoDe(rel)) as typeof baseline;
      } catch {
        return falla(`${rel} no es JSON válido`);
      }

      const LANE = 'spanish-user-strings-cli';
      if (baseline.lanes?.[LANE] === undefined) {
        return falla(
          `la línea base ya no tiene el carril «${LANE}»: sin él, que el kernel y el piloto estén ` +
            'limpios deja de ser comprobable y el tramo se apaga sin ponerse rojo'
        );
      }

      // 2 · EL TERRENO, medido por AUSENCIA. El desglose sólo lista archivos
      // con deuda, así que no estar es la prueba de que está en cero — y es
      // más fuerte que un cero escrito, que alguien puede teclear.
      const breakdown = baseline.perFile?.[LANE] ?? {};
      const owed = Object.keys(breakdown).filter(
        (f) => /^src\/cli\/kernel\//.test(f) || f === 'src/cli/bank-command.ts'
      );
      if (owed.length) {
        return falla(
          `${owed.length} archivo(s) del kernel o del piloto vuelven a cargar cadenas sin clave ` +
            `(${owed.slice(0, 3).join(', ')}): el terreno que I7 ganó se devolvió`
        );
      }

      // 3 · EL ORDEN. Se compara la posición del cromo con la de la PRIMERA
      // familia registrada, no con una línea fija: el archivo crece con cada
      // familia nueva y un número aquí caducaría en el siguiente tramo.
      // SE LEE EL CRUDO Y SE ANCLA AL PRINCIPIO DEL RENGLÓN, no se confía en
      // que `codigoDe` quite los comentarios. Medido en este mismo tramo: con
      // la llamada comentada —`// installHelpChrome(program);`— el fuente ya
      // sin comentarios TODAVÍA la contiene, así que el criterio pasaba con el
      // cromo apagado. `withoutComments` es un escáner con estado y en un
      // archivo de tres mil renglones deja de quitar; en I6 lo vi cegado por
      // unos acentos graves, y aquí sin ellos. Es un defecto del instrumento
      // del plan y sigue abierto; lo que hace este criterio es no depender de
      // él: un renglón comentado no empieza por la llamada.
      const main = crudoDe('src/cli/mnemosine.ts');
      const chromeMatch = /^[ \t]*installHelpChrome\(program\)/m.exec(main);
      const chrome = chromeMatch?.index ?? -1;
      if (chrome === -1) {
        return falla(
          'nadie instala el cromo del CLI: `Usage:`/`Uso:` y las descripciones vuelven a salir en ' +
            'la prosa inglesa que Commander trae de fábrica, con el locale puesto o sin él'
        );
      }
      const firstFamily = /^register[A-Za-z]*\(program/m.exec(main);
      if (firstFamily === null || firstFamily.index === undefined) {
        return noEvaluable('no se encontró ninguna llamada `register…(program)`: cambió la forma de registrar familias');
      }
      if (chrome > firstFamily.index) {
        return falla(
          'el cromo se instala DESPUÉS de la primera familia: sus descripciones ya se rindieron con ' +
            'el idioma equivocado, y ninguna prueba de contenido lo nota porque el texto que sale es válido'
        );
      }

      return ok(
        `el cromo se instala antes de la primera familia, y ni el kernel ni el piloto tienen entrada ` +
          `en el desglose de «${LANE}» (que vale ${baseline.lanes[LANE]})`
      );
    },
    mutantes: [
      {
        archivo: 'src/cli/mnemosine.ts',
        de: 'installHelpChrome(program);',
        a: '// installHelpChrome(program);',
        porque:
          'sin cromo instalado, el CLI vuelve a la prosa de fábrica de Commander y el locale deja de cambiar una sola pantalla',
      },
      {
        // EL TERRENO DEVUELTO. Se encarna metiendo al piloto de vuelta en el
        // desglose, que es exactamente lo que pasaría si alguien reintrodujera
        // una cadena sin clave y resembrara la línea base sin mirar.
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/bank-command.ts": 1,',
        porque: 'terreno-devuelto: el piloto vuelve a cargar una cadena sin clave y el desglose lo registra',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-yes-no-prompt-built-by-kernel',
    // MNE-001-217 (issue #262, I8.0). Twenty leaves wrote `[y/N]` by hand, so a
    // question already translated to Spanish still ended in English. The kernel
    // now builds the suffix from one catalogue key (`yesNoPrompt`, next to the
    // answer grammar in `confirmacion.ts`), and the nine families of I8 call it.
    //
    // IT READS STRING LITERALS, NOT TEXT. `mnemosine.ts` and `confirmacion.ts`
    // name `[y/N]` in comments, and the comment stripper stops stripping in
    // `mnemosine.ts` (see `cli-chrome-and-pilot-speak-by-key` above). The
    // compiler's tree tells a literal from a comment without guessing.
    //
    // FOUR CHECKS, one per way of losing the ground:
    //   1. no literal in `src/cli/**` (kernel included) carries the suffix;
    //   2. the kernel reads it from the catalogue;
    //   3. in each catalogue the suffix lives in its own key and nowhere else,
    //      or a key that carries it prints it twice once wrapped;
    //   4. every `confirmarConReintento` outside the kernel asks through
    //      `yesNoPrompt`: a leaf that drops the suffix also drops the kernel.
    enunciado:
      'No CLI leaf writes the [y/N] suffix: the kernel builds it from the catalogue, in the user language (#262, MNE-001-217)',
    evaluar: () => {
      // MNE-001-219 widened it to the default-yes form, [Y/n] / [S/n], which the
      // first-run prompt of the root family asks with.
      const SUFFIX = /\[(?:[ys]\/N|[YS]\/n)\]/;
      const KEY = 'confirm_yes_no_suffix';
      const KEY_DEFAULT_YES = 'confirm_yes_no_suffix_default_yes';
      const KERNEL_KEYS = [KEY, KEY_DEFAULT_YES];
      const parse = (rel: string): ts.SourceFile =>
        ts.createSourceFile(rel, crudoDe(rel), ts.ScriptTarget.Latest, true);
      const literalPieces = (n: ts.Node): string | undefined =>
        ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateLiteralToken(n)
          ? n.text
          : undefined;
      const walk = (n: ts.Node, visit: (node: ts.Node) => void): void => {
        visit(n);
        n.forEachChild((child) => walk(child, visit));
      };
      const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
        sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

      const files = fuentes('src/cli').map((abs) => path.relative(RAIZ, abs).split(path.sep).join('/'));
      const trees = new Map(files.map((rel) => [rel, parse(rel)] as const));

      // The kernel is the file that declares yesNoPrompt, found and not named:
      // a path written here would pin the criterion to today's file name.
      const declares = (sf: ts.SourceFile): boolean =>
        sf.statements.some(
          (st) =>
            (ts.isFunctionDeclaration(st) && st.name?.text === 'yesNoPrompt') ||
            (ts.isVariableStatement(st) &&
              st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'yesNoPrompt'))
        );
      const kernels = files.filter((rel) => declares(trees.get(rel)!));
      if (kernels.length !== 1) {
        return falla(
          `${kernels.length} file(s) in src/cli declare yesNoPrompt (${kernels.join(', ') || 'none'}): ` +
            'the yes/no prompt must have exactly one builder, in the kernel'
        );
      }
      const KERNEL = kernels[0];
      if (!KERNEL.startsWith('src/cli/kernel/')) {
        return falla(`yesNoPrompt is declared in ${KERNEL}, outside src/cli/kernel/: a leaf cannot own the prompt`);
      }

      // 1 · No hand-written suffix anywhere in the CLI.
      const handWritten: string[] = [];
      // 4 · Every confirmation outside the kernel asks through yesNoPrompt.
      const unbuilt: string[] = [];
      let confirmations = 0;
      for (const rel of files) {
        const sf = trees.get(rel)!;
        walk(sf, (n) => {
          const text = literalPieces(n);
          if (text !== undefined && SUFFIX.test(text)) handWritten.push(`${rel}:${lineOf(sf, n)}`);
          if (
            rel !== KERNEL &&
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'confirmarConReintento'
          ) {
            confirmations++;
            let built = false;
            const prompt = n.arguments[1];
            if (prompt) {
              walk(prompt, (m) => {
                if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === 'yesNoPrompt') {
                  built = true;
                }
              });
            }
            if (!built) unbuilt.push(`${rel}:${lineOf(sf, n)}`);
          }
        });
      }
      if (handWritten.length) {
        return falla(
          `${handWritten.length} literal(s) in src/cli write the [y/N] suffix by hand ` +
            `(${handWritten.slice(0, 3).join(', ')}): ask with yesNoPrompt(question) from ${KERNEL}, ` +
            'which takes the suffix from the catalogue in the user language'
        );
      }
      if (confirmations === 0) {
        return noEvaluable('no confirmarConReintento call outside the kernel: the confirmation changed shape');
      }
      if (unbuilt.length) {
        return falla(
          `${unbuilt.length} confirmation(s) do not ask through yesNoPrompt ` +
            `(${unbuilt.slice(0, 3).join(', ')}): the prompt must come from the kernel`
        );
      }

      // 2 · The kernel reads both suffixes from the catalogue.
      const readKeys = new Set<string>();
      walk(trees.get(KERNEL)!, (n) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 't' &&
          n.arguments[0] !== undefined
        ) {
          const key = literalPieces(n.arguments[0]);
          if (key !== undefined) readKeys.add(key);
        }
      });
      for (const key of KERNEL_KEYS) {
        if (!readKeys.has(key)) {
          return falla(`${KERNEL} no longer calls t('${key}'): the suffix stops following the user language`);
        }
      }

      // 3 · In each catalogue, the suffix lives in its own key only.
      for (const rel of ['src/i18n/en.ts', 'src/i18n/es.ts']) {
        const sf = parse(rel);
        const owners: string[] = [];
        walk(sf, (n) => {
          if (!ts.isPropertyAssignment(n)) return;
          let carries = false;
          walk(n.initializer, (m) => {
            const text = literalPieces(m);
            if (text !== undefined && SUFFIX.test(text)) carries = true;
          });
          if (carries) owners.push(ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : '?');
        });
        if (owners.slice().sort().join(',') !== KERNEL_KEYS.slice().sort().join(',')) {
          return falla(
            `${rel}: the suffix is carried by ${owners.length ? owners.join(', ') : 'no key'}, and only ` +
              `${KERNEL_KEYS.join(' and ')} may carry it: a key with its own suffix prints it twice once the kernel wraps it`
          );
        }
      }

      return ok(
        `${confirmations} confirmation(s) in ${files.length} CLI file(s) ask through yesNoPrompt, none writes ` +
          `the suffix, and ${KERNEL_KEYS.join(' and ')} are its only homes in en.ts and es.ts`
      );
    },
    mutantes: [
      {
        archivo: 'src/cli/pay-run-command.ts',
        de: 'p.cyan(yesNoPrompt(question))',
        a: 'p.cyan(`${question} [y/N] `)',
        porque: 'literal-back-in-a-leaf: a leaf writes [y/N] by hand again and a Spanish user reads an English suffix',
      },
      {
        archivo: 'src/cli/pay-run-command.ts',
        de: 'p.cyan(yesNoPrompt(question))',
        a: 'p.cyan(`${question} `)',
        porque: 'kernel-bypassed: the leaf asks with no suffix at all, so no literal is left for check 1 to see',
      },
      {
        archivo: 'src/cli/kernel/confirmacion.ts',
        de: "t('confirm_yes_no_suffix')",
        a: "'[y/N]'",
        porque: 'kernel-off-the-catalogue: the kernel hard-codes the suffix and Spanish goes back to [y/N]',
      },
      {
        archivo: 'src/i18n/es.ts',
        de: "'¿Dar de alta al proveedor {name} (RFC {rfc})?'",
        a: "'¿Dar de alta al proveedor {name} (RFC {rfc})? [s/N]'",
        porque: 'suffix-twice: a catalogue key carries its own suffix again and prints it twice once wrapped',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: "yesNoPrompt(t('root.setup.run_now'), 'yes')",
        a: "'Run setup now? [Y/n] '",
        porque: 'default-yes-back-in-a-leaf: the first-run prompt writes [Y/n] by hand again and a Spanish user reads an English suffix',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-family-report-speaks-by-key',
    // MNE-001-218 (issue #263, I8.1). The report family —`cashflow` and
    // `cashflow reconcile`— printed ten Spanish strings from the code. They
    // live in the I8.1 block of the catalogue now, and three checks hold the
    // ground:
    //   1. the lane's breakdown has no entry for either leaf, measured by
    //      ABSENCE, as `cli-chrome-and-pilot-speak-by-key` measures the pilot;
    //   2. every key of the I8.1 block is named by one of the two leaves: a key
    //      no leaf names is a text that went back into the code;
    //   3. neither leaf hands prose straight to `console.log`.
    //
    // NOT THE LEXICON. `flagsAsSpanish` flags `indirecto`/`directo` inside the
    // correct English usage error of `--method`, so it would be red on a right
    // tree. Checks 1 and 2 measure the same ground without guessing a language.
    enunciado:
      'The report family (cashflow, cashflow reconcile) prints no Spanish string from the code: its texts come from the I8.1 block of the catalogue (#263, MNE-001-218)',
    evaluar: () => {
      const LANE = 'spanish-user-strings-cli';
      const LEAVES = ['src/cli/cashflow-command.ts', 'src/cli/cashflow-reconcile-command.ts'];
      const BASELINE = 'docs/language-baseline.json';
      for (const rel of [BASELINE, ...LEAVES]) {
        if (!existe(rel)) return noEvaluable(`${rel} is not in this tree`);
      }

      // 1 · The breakdown, by absence.
      let baseline: { lanes?: Record<string, number>; perFile?: Record<string, Record<string, number>> };
      try {
        baseline = JSON.parse(crudoDe(BASELINE)) as typeof baseline;
      } catch {
        return falla(`${BASELINE} is not valid JSON`);
      }
      if (baseline.lanes?.[LANE] === undefined) {
        return falla(`the baseline no longer has the lane «${LANE}»: the family's ground stops being measurable`);
      }
      const owed = LEAVES.filter((f) => (baseline.perFile?.[LANE] ?? {})[f] !== undefined);
      if (owed.length) {
        return falla(
          `${owed.join(', ')} carry Spanish strings again in «${LANE}»: the ground I8.1 won was given back`
        );
      }

      // 2 · Every key of the I8.1 block is named by a leaf.
      const en = crudoDe('src/i18n/en.ts');
      const open = en.indexOf('// ==== I8.1 ');
      const close = en.indexOf('// ==== end of I8.1 ====');
      if (open === -1 || close === -1 || close < open) {
        return falla('src/i18n/en.ts lost the markers of the I8.1 block, where the report family keeps its texts');
      }
      const keys = [...en.slice(open, close).matchAll(/^ {2}'([a-z0-9_.]+)':/gm)].map((m) => m[1]);
      if (keys.length === 0) {
        return falla('the I8.1 block of src/i18n/en.ts declares no key: the report family has nowhere to speak from');
      }
      const named = new Set<string>();
      const consoleProse: string[] = [];
      for (const rel of LEAVES) {
        const sf = ts.createSourceFile(rel, crudoDe(rel), ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node): void => {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) named.add(n.text);
          // 3 · No prose straight to console.log.
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            n.expression.expression.text === 'console' &&
            n.expression.name.text === 'log' &&
            n.arguments[0] !== undefined &&
            (ts.isStringLiteral(n.arguments[0]) ||
              ts.isNoSubstitutionTemplateLiteral(n.arguments[0]) ||
              ts.isTemplateExpression(n.arguments[0]))
          ) {
            consoleProse.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
          }
          n.forEachChild(visit);
        };
        visit(sf);
      }
      const orphans = keys.filter((k) => !named.has(k));
      if (orphans.length) {
        return falla(
          `${orphans.length} key(s) of the I8.1 block are named by no leaf of the family ` +
            `(${orphans.slice(0, 3).join(', ')}): their text went back into the code`
        );
      }
      if (consoleProse.length) {
        return falla(
          `the report family hands prose straight to console.log (${consoleProse.slice(0, 3).join(', ')}): ` +
            'a text printed from the code does not follow the user language'
        );
      }

      return ok(
        `the ${keys.length} keys of the I8.1 block are named by the family's two leaves, neither has an entry ` +
          `in «${LANE}» (which is ${baseline.lanes[LANE]}), and neither prints prose through console.log`
      );
    },
    mutantes: [
      {
        archivo: 'src/cli/cashflow-reconcile-command.ts',
        de: "t('report.cashflow_reconcile.ties')",
        a: "'Amarra: el estado de flujos equivale al movimiento real de efectivo.'",
        porque: 'string-back-in-the-code: the tie note is written in Spanish in the leaf again, and its key is left unread',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/cashflow-reconcile-command.ts": 1,',
        porque: 'ground-given-back: the breakdown records a Spanish string in the family again',
      },
      {
        archivo: 'src/cli/cashflow-command.ts',
        de: "throw usageError({ key: 'report.cashflow.gross_unavailable' });",
        a: "console.log('Estado en términos brutos');\n  throw usageError({ key: 'report.cashflow.gross_unavailable' });",
        porque: 'console-prose: the leaf prints a sentence from the code, outside the catalogue',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-family-root-speaks-by-key',
    // MNE-001-219 (issue #264, I8.2). The root family —`mnemosine.ts`, the
    // registrar every family passes through, and `close`— printed its Spanish
    // from the code. The texts a person reads live in the I8.2 block now; the
    // risk notes no screen prints are English in place. Three checks:
    //   1. the lane's breakdown has no entry for either leaf (by absence);
    //   2. every key of the I8.2 block is named by one of the two leaves;
    //   3. no Spanish value of the I8.2 block is written as a literal in them.
    //
    // CHECK 3 IS NOT #264's «no console.log('<prosa>')». `mnemosine.ts` holds
    // 53 English prose calls this task does not key, so that check would be
    // red on a correct tree. What it is for —a text of this family going back
    // into the code— is what check 3 catches, without guessing a language.
    enunciado:
      'The root family (mnemosine.ts, close) prints no Spanish string from the code: its texts come from the I8.2 block of the catalogue (#264, MNE-001-219)',
    evaluar: () =>
      familySpeaksByKey('I8.2', 'root', ['src/cli/mnemosine.ts', 'src/cli/close-command.ts']),
    mutantes: [
      {
        archivo: 'src/cli/mnemosine.ts',
        de: "t('root.ingest.auto_post_ignored')",
        a: "'Aviso: el auto-posteo pedido por bandera o por mnemosine.config.json se IGNORA: el panel del despacho no lo autoriza.'",
        porque: 'string-back-in-the-code: the auto-post warning is written in Spanish in the leaf again, and its key is left unread',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/close-command.ts": 1,',
        porque: 'ground-given-back: the breakdown records a Spanish string in the root family again',
      },
      {
        archivo: 'src/cli/mnemosine.ts',
        de: "usageError({ key: 'root.lang.unsupported', params: { language, options: LOCALES.join(', ') } })",
        a: 'usageError(`Unsupported language "${language}". Options: ${LOCALES.join(\', \')}, or es, en`)',
        porque: 'key-unread: the language refusal goes back to a template in the leaf and stops following the user language',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-family-ar-speaks-by-key',
    // MNE-001-220 (issue #265, I8.3). The ar family —receipt, invoice, customer,
    // credit-note— printed fourteen Spanish strings from the code. The ones a
    // person reads live in the I8.3 block now, the seven reasons a leaf gives
    // for not honoring --idempotency-key included: they reach the user inside
    // `cli.risk.key_not_honored`, so they travel as keys (`{ sinLlave: { key } }`)
    // and render in the language of their sentence. The help examples of
    // `customer` are English. Same three checks as the root family's.
    enunciado:
      'The ar family (receipt, invoice, customer, credit-note) prints no Spanish string from the code: its texts come from the I8.3 block of the catalogue (#265, MNE-001-220)',
    evaluar: () =>
      familySpeaksByKey('I8.3', 'ar', [
        'src/cli/receipt-command.ts',
        'src/cli/invoice-command.ts',
        'src/cli/customer-command.ts',
        'src/cli/credit-note-command.ts',
      ]),
    mutantes: [
      {
        archivo: 'src/cli/invoice-command.ts',
        de: "llave: { sinLlave: { key: 'ar.invoice.retry_reissues' } },",
        a: "llave: { sinLlave: 'un reintento vuelve a emitir y postea el ingreso otra vez' },",
        porque: 'reason-back-in-the-code: invoice issue declares its no-key reason in Spanish again, inside an English sentence',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/receipt-command.ts": 1,',
        porque: 'ground-given-back: the breakdown records a Spanish string in the ar family again',
      },
      {
        archivo: 'src/cli/receipt-command.ts',
        de: "t('ar.receipt.no_rep')",
        a: "'sin REP — obligación fiscal propia con plazo del SAT'",
        porque: 'string-back-in-the-code: receipt show writes «sin REP» in Spanish to every reader again',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cli-family-payroll-speaks-by-key',
    // MNE-001-221 (issue #266, I8.4). The payroll family —`payroll accrue` and
    // the ISN leaves of `payroll-isn`— printed 27 Spanish strings from the
    // code. The ones a person reads live in the I8.4 block now: the summary,
    // the confirmation and the done line with ICU plurals instead of «(es)»,
    // and the nine labels of the ISN capture preview. The «taken as no» line
    // reuses `bank.confirm.taken_as_no`, and the two `writes` are English in
    // place. The cédula's reason is English in the row and labelled in the
    // table, so --json and csv do not change with the locale.
    enunciado:
      'The payroll family (payroll, payroll-isn) prints no Spanish string from the code: its texts come from the I8.4 block of the catalogue (#266, MNE-001-221)',
    evaluar: () =>
      familySpeaksByKey('I8.4', 'payroll', ['src/cli/payroll-command.ts', 'src/cli/payroll-isn-command.ts']),
    mutantes: [
      {
        archivo: 'src/cli/payroll-command.ts',
        de: "deps.palette.dim(t('payroll.accrue.dry_run'))",
        a: "deps.palette.dim(t('payroll.accrue.dry_run') + 'Ensayo: el mayor no se tocó y no se escribió ningún renglón de cédula.')",
        porque: 'spanish-beside-the-key: the key is still read, and its Spanish is written next to it, which only check 3 sees',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/payroll-isn-command.ts": 1,',
        porque: 'ground-given-back: the breakdown records a Spanish string in the payroll family again',
      },
      {
        archivo: 'src/cli/payroll-isn-command.ts',
        de: "t('payroll.isn_rate_set.open_ended')",
        a: "'(sin cierre: sigue vigente)'",
        porque: 'string-back-in-the-code: the ISN preview writes «sin cierre» in Spanish to every reader again',
      },
    ],
  },

  {
    paquete: 'E0.0',
    id: 'cli-family-assets-speaks-by-key',
    // MNE-001-222 (issue #267, I8.5). The assets-inventory family —`depreciation
    // run`/`post` and `asset create`— printed 35 Spanish strings from the code.
    // The ones a person reads live in the I8.5 block now: the plan's header and
    // criteria, its warnings, the blocked run, the conflict with the approved
    // plan, the confirmation and the done line, with ICU plurals instead of
    // «(s)», and the usage errors of `asset create`. Six texts reuse a key that
    // already said the same (the «taken as no» line, the two ledger-untouched
    // notes, the no-terminal abort, the asset dry run, the date error); the two
    // `writes` and the dry-run sentinel are English in place. The no-class
    // group is English in the row and labelled in the table, so --json and csv
    // do not change with the locale.
    enunciado:
      'The assets-inventory family (depreciation, asset) prints no Spanish string from the code: its texts come from the I8.5 block of the catalogue (#267, MNE-001-222)',
    evaluar: () =>
      familySpeaksByKey('I8.5', 'assets', ['src/cli/depreciation-command.ts', 'src/cli/asset-command.ts']),
    mutantes: [
      {
        archivo: 'src/cli/depreciation-command.ts',
        de: "deps.palette.dim(`${t('assets.depreciation.nothing_this_book')}\\n`)",
        a: "deps.palette.dim('Nada que contabilizar en este periodo con este libro.\\n')",
        porque: 'string-back-in-the-code: depreciation run writes «nada que contabilizar» in Spanish to every reader again',
      },
      {
        archivo: 'docs/language-baseline.json',
        de: '"spanish-user-strings-cli": {',
        a: '"spanish-user-strings-cli": {\n   "src/cli/asset-command.ts": 1,',
        porque: 'ground-given-back: the breakdown records a Spanish string in the assets family again',
      },
      {
        archivo: 'src/cli/asset-command.ts',
        de: "usageError({ key: 'assets.asset.source_entry_contradiction' })",
        a: "usageError('--source-entry nombra el asiento donde YA está el costo, así que no se puede pasar junto a `--capitalized no`.')",
        porque: 'string-back-in-the-code: the usage error of asset create is a Spanish template again',
      },
    ],
  },



  {
    paquete: 'E0.0',
    id: 'instrument-identity-is-not-prose',
    enunciado: 'La identidad de un criterio es un id estable, no la frase con que se enuncia',
    evaluar: () => {
      // POR QUÉ NACE (I0, issue #142). El piso de criterios es un trinquete que
      // sólo sube, y su llave era `paquete · enunciado`: PROSA ESPAÑOLA. Con
      // eso, reescribir una frase daba de baja un criterio y daba de alta otro
      // sin que nadie hubiera tocado un instrumento — y el epic #141, que va a
      // traducir el código entero al inglés, lo habría hecho 136 veces de
      // golpe, dejando el piso vacío y la CI en verde.
      //
      // Este criterio vigila las dos mitades del arreglo: que el resolutor de
      // identidad PREFIERA el id, y que el piso esté escrito en ids y no en
      // frases. La unicidad y la forma las cubren las pruebas de
      // tests/plan/criterios.spec.ts, que es donde se pueden nombrar los
      // choques uno por uno.
      const st = codigoDe('src/plan/status.ts');
      if (!/c\.id \?\?/.test(st)) {
        return falla(
          'identidadDe no prefiere el id: la identidad vuelve a ser la frase, y traducirla da de ' +
            'baja el criterio sin tocar el instrumento'
        );
      }
      const piso = JSON.parse(crudoDe('docs/criterios-minimos.json')) as { verdes: string[] };
      const ids = new Set(CRITERIOS.map((c) => c.id).filter((x): x is string => x !== undefined));
      const frases = piso.verdes.filter((v) => !ids.has(v));
      if (frases.length > 0) {
        return falla(
          `${frases.length} entrada(s) del piso siguen siendo prosa y no ids: ${frases.slice(0, 2).join(' | ')}`
        );
      }
      const sinId = CRITERIOS.filter((c) => c.id === undefined).length;
      return ok(
        `${ids.size} criterios con id estable y ${piso.verdes.length} entradas del piso escritas en ids` +
          (sinId > 0 ? `; ${sinId} sin id todavía` : '')
      );
    },
    mutantes: [
      {
        archivo: 'src/plan/status.ts',
        de: 'c.id ?? `${c.paquete} · ${c.enunciado}`',
        a: '`${c.paquete} · ${c.enunciado}`',
        porque:
          'la identidad vuelve a ser la frase española: el piso entero, escrito en ids, dejaría de ' +
          'casar con un solo criterio y el trinquete se quedaría protegiendo nada',
      },
    ],
  },

  {
    paquete: 'E0.0',
    id: 'repository-declares-git-remote',
    enunciado: 'El repositorio tiene remoto, así que la CI puede dispararse',
    evaluar: () => {
      // EN UN ÁRBOL VINCULADO, `.git` ES UN ARCHIVO.
      //
      // `git worktree add` deja un `.git` que no es directorio sino una línea
      // «gitdir: …» apuntando al repositorio común. Este criterio buscaba
      // `.git/config` a secas y daba «no hay .git» en cualquier worktree —el
      // único rojo que salía al verificar un commit en un árbol limpio, que es
      // la práctica que este proyecto adoptó justo para no medir la mezcla de
      // varias sesiones—. Un falso rojo en el instrumento de verificación es
      // peor que en el código: entrena a saltarse la verificación.
      const enlace = rutaDe('.git');
      if (!fs.existsSync(enlace)) return falla('no hay .git');
      let cfg = path.join(enlace, 'config');
      if (fs.statSync(enlace).isFile()) {
        const apunta = /gitdir:\s*(.+)/.exec(leer(enlace));
        if (apunta === null) return falla('el .git de este árbol vinculado no dice a qué repositorio apunta');
        const comun = path.resolve(path.dirname(enlace), apunta[1].trim());
        // …/.git/worktrees/<nombre> → el config vive dos niveles más arriba.
        cfg = path.join(comun, '..', '..', 'config');
      }
      if (!fs.existsSync(cfg)) return falla('no hay .git');
      const tiene = /\[remote /.test(leer(cfg));
      return tiene
        ? ok('remoto configurado')
        : falla('sin remoto: ci.yml existe pero nunca puede ejecutarse');
    },
  },
  {
    paquete: 'E0.0',
    id: 'dotenv-ignored-except-example',
    // Esto exigía la línea literal `^\.env$` y la cadena `.env.backup`. Se
    // puso en rojo el día que alguien SUSTITUYÓ esa lista por `.env*` con
    // `!.env.example` — un patrón estrictamente más fuerte, que además cubre
    // el `.env.old` que la lista no cubría. El criterio afirmaba la forma del
    // arreglo en vez de la propiedad, y castigó una mejora.
    //
    // Ahora se le pregunta a git, que es la autoridad: no importa cómo esté
    // escrito el .gitignore mientras la respuesta sea la correcta.
    enunciado: 'Ninguna variante de .env se puede versionar, salvo el ejemplo',
    evaluar: () => {
      const ignorado = (archivo: string): boolean => {
        const r = spawnSync('git', ['check-ignore', '-q', '--no-index', archivo], { cwd: rutaDe() });
        if (r.error || r.status === null || r.status > 1) return false;
        return r.status === 0;
      };
      const deben = ['.env', '.env.local', '.env.backup-2026-08-27', '.env.old', '.env.copia', '.env.produccion'];
      const sueltos = deben.filter((f) => !ignorado(f));
      if (sueltos.length > 0) {
        return falla(
          `git versionaría ${sueltos.join(', ')}: un secreto real entra al historial en el primer \`git add -A\``
        );
      }
      // La excepción tiene que seguir siendo excepción: sin .env.example nadie
      // sabe qué variables hacen falta, y el arreglo obvio es aflojar el patrón.
      return ignorado('.env.example')
        ? falla('.env.example también está ignorado: sin plantilla, el siguiente arreglo será aflojar el patrón')
        : ok(`${deben.length} variantes de .env ignoradas y .env.example versionable`);
    },
  },
  {
    paquete: 'E0.0',
    id: 'ci-gates-single-workflow',
    enunciado: 'Los checks viven en un solo ci.yml, que declara sus cinco jobs',
    evaluar: () => {
      // Lo que E0.0-b compró no fue «un archivo en .github/workflows»: fue que
      // la CI de *checks* no se reparta entre archivos —«los demás paquetes
      // AÑADEN jobs a ci.yml; ninguno lo crea de nuevo»—, porque dos pipelines
      // en paralelo es como se pierde de vista cuál puerta está roja.
      //
      // Contar archivos medía eso por accidente y castigaba lo que no es un
      // pipeline: un listener de eventos de PR (witness-triage.yml) no corre
      // ninguna puerta, no puede diluirlas y no puede quedarse desfasado
      // respecto a ellas. Así que se mide la propiedad, no el número: ci.yml
      // lleva los jobs de puerta y NINGÚN otro workflow corre una puerta.
      const dir = rutaDe('.github', 'workflows');
      if (!fs.existsSync(dir)) return falla('no existe .github/workflows');
      const archivos = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
      if (!archivos.includes('ci.yml')) {
        return falla(`no hay ci.yml: ${archivos.join(', ') || 'ningún workflow'}`);
      }
      // POR QUÉ ENTRÓ `restauracion` (S3). Los cuatro primeros son los que
      // E0.0-b nombró. El quinto se añade porque su ausencia era la misma
      // fuga un piso más abajo: el criterio «un respaldo se prueba
      // restaurándolo» afirma que `verificarRespaldo` restaura y corre los
      // chequeos del mayor, pero lo afirma LEYENDO EL FUENTE. Borrar el job
      // del YAML dejaba esa afirmación intacta y en verde con nadie que la
      // ejecutara nunca — código que dice la verdad sobre sí mismo y no corre.
      // Y no es una puerta cualquiera: el propio plan exige «respaldo
      // verificado» como condición de sus tres remediaciones destructivas
      // (E1.2-h, E1.4-a, E3.2-i, las que «corrompen el mayor de una entidad
      // viva» si salen mal), así que este job ES ese control ejecutándose.
      //
      // `lint` sigue FUERA, y eso es deuda dicha en voz alta y no olvido: ver
      // «Lo que la CI no cubre» en docs/wiki/Pruebas-y-CI.md. `plan` salió de
      // esa deuda en T2, pero NO entrando en esta lista: lo que hacía falta no
      // era exigir que el job exista —un job con todos sus pasos comentados
      // existe— sino que sus puertas CORRAN, y eso lo afirma
      // `plan-job-gates-run-and-cannot-be-skipped`.
      const NOMBRES = ['typecheck', 'unit', 'integration', 'aislamiento', 'restauracion'];
      // Por el seam, no por fs: S2 exige que la única lectura directa de disco
      // en este archivo sea la de leer(), o el mutante de este criterio no lo
      // alcanzaría y su espejo mentiría en verde.
      const y = leer(path.join(dir, 'ci.yml'));
      const faltan = NOMBRES.filter((j) => !new RegExp(`^  ${j}:`, 'm').test(y));
      if (faltan.length > 0) return falla(`faltan jobs en ci.yml: ${faltan.join(', ')}`);

      // Una puerta corrida fuera de ci.yml es el pipeline partiéndose, se
      // llame como se llame el job que la corre.
      const PUERTAS = /tsc --noEmit|typecheck:tests|vitest run|test:integration|verify-isolation|plan\/status|catalogo-estado/;
      const intrusos = archivos
        .filter((f) => f !== 'ci.yml')
        .filter((f) => {
          const otro = leer(path.join(dir, f));
          return PUERTAS.test(otro) || NOMBRES.some((j) => new RegExp(`^  ${j}:`, 'm').test(otro));
        });
      // El número sale de la lista, no de la prosa: un conteo escrito a mano
      // en la salida es el que se queda diciendo «cuatro» cuando ya son cinco.
      return intrusos.length === 0
        ? ok(
            `ci.yml con sus ${NOMBRES.length} jobs de puerta` +
              (archivos.length > 1 ? `; ${archivos.length - 1} workflow(s) sin puertas` : '')
          )
        : falla(`la CI de checks se reparte fuera de ci.yml: ${intrusos.join(', ')}`);
    },
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: '  restauracion:',
        a: '  restauracion_retirada:',
        porque:
          'la puerta desaparece por RENOMBRE —la forma en que un job se va sin que ningún diff diga ' +
          'que lo borra— y el criterio que la nombraba tiene que acusarlo',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'plan-job-gates-run-and-cannot-be-skipped',
    enunciado: 'Las compuertas del job del plan corren de verdad, y ninguna se apaga sin ponerse roja',
    evaluar: () => {
      // T2 · EL HABILITADOR, y la razón de que este tramo vaya segundo.
      //
      // El job `plan` es donde el tablero se juzga a sí mismo: su primer paso
      // es el trinquete por criterio y los siete siguientes son las compuertas
      // que publican catálogo, corpus, historial, contrato de la API, censo de
      // superficie, idioma y mapa del repositorio. A nadie lo vigilaba. Se probaron las tres
      // mutaciones —comentar el `--piso --exigir`, comentar el `--check` del
      // catálogo, y colgar `continue-on-error: true` del job— y las tres
      // dejaban los criterios EXACTAMENTE igual: los mismos rojos
      // preexistentes, ninguno nuevo. Un tablero que no puede ponerse rojo
      // cuando apagas al juez no es un tablero, es una tabla.
      //
      // `ci-gates-single-workflow` no lo tapaba: comprueba que los jobs
      // EXISTAN, y un job con todos sus pasos comentados existe.
      const ci = crudoDe('.github', 'workflows', 'ci.yml');
      const block = ciJob(ci, 'plan');
      if (block === null) {
        return falla('el job `plan` desapareció de ci.yml: el tablero dejaría de juzgarse en el único sitio que decide una fusión');
      }

      // POR QUÉ `continue-on-error` ES SU PROPIA PREGUNTA. Es la forma de
      // apagar una puerta sin borrar una sola línea de lo que corre: el paso
      // sigue ahí, sigue fallando, sigue imprimiendo su rojo, y la fusión
      // pasa igual. Un criterio que sólo mirase los pasos lo daría por bueno.
      if (/^\s*continue-on-error:\s*true/m.test(block)) {
        return falla('el job `plan` lleva `continue-on-error: true`: sus puertas seguirían corriendo, fallando y dejando fusionar');
      }

      // LA LISTA SE ESCRIBE, Y ADEMÁS SE CUENTA. Nombrar las puertas es lo
      // que permite decir CUÁL se apagó; el conteo es lo que impide que una
      // puerta futura —que esta lista no conoce— se vaya en silencio. Sin la
      // cifra, el ancla quedaría abierta por la derecha: la lección de siempre.
      const GATES: Array<[string, string, string]> = [
        ['el trinquete del plan', 'npm run plan:status -- --piso --exigir=', '[A-Za-z0-9.,]+'],
        ['el catálogo de comandos', 'npx tsx scripts/catalogo-estado.ts --check', ''],
        ['la caducidad del corpus', 'npx tsx scripts/corpus-manifiesto.ts --check', ''],
        ['el historial de entrega', 'npx tsx scripts/historial-estado.ts --check', ''],
        ['el contrato de la API', 'npx tsx scripts/openapi.ts --check', ''],
        ['el censo de superficie', 'npx tsx scripts/ux-status.ts --check', ''],
        ['el metro del idioma', 'npx tsx scripts/language-status.ts --check', ''],
        ['el mapa del repositorio', 'npx tsx scripts/repo-map.ts --check', ''],
      ];
      const dark = GATES.filter(([, cmd, tail]) => !stepRuns(block, cmd, tail)).map(([q]) => q);
      if (dark.length > 0) {
        return falla(
          `${dark.length} de las ${GATES.length} puertas del job del plan no corren: ${dark.join(', ')}. ` +
            'Comentar un paso lo deja escrito y muerto, que es como se apaga una puerta sin que el diff lo diga.'
        );
      }

      // `npm ci` y `npm run migrate` son los dos pasos que no son puerta:
      // preparan la corrida. El total sólo SUBE, y un paso nuevo se añade a
      // esta cifra en el mismo commit que lo escribe.
      const MIN_LIVE_STEPS = 10;
      const live = (block.match(/^[ \t]*- run: /gm) ?? []).length;
      return live >= MIN_LIVE_STEPS
        ? ok(`las ${GATES.length} puertas del job del plan corren, sin continue-on-error y con ${live} pasos vivos`)
        : falla(
            `el job del plan corre ${live} pasos y la línea base son ${MIN_LIVE_STEPS}: ` +
              'se apagó un paso que esta lista no nombra, que es justo el caso que el conteo existe para ver'
          );
    },
    mutantes: [
      {
        // EL ESPEJO QUE EL TRAMO VINO A ENCENDER, literal: «comentar ci.yml
        // tiene que poner rojo un criterio». Antes de T2 esta mutación no
        // movía un solo veredicto.
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npm run plan:status -- --piso',
        a: '      # - run: npm run plan:status -- --piso',
        porque:
          'el trinquete por criterio se apaga comentándolo —el modo de fallo natural de un paso de CI— y hasta T2 los 180 criterios salían exactamente igual',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/catalogo-estado.ts --check',
        a: '      # - run: npx tsx scripts/catalogo-estado.ts --check',
        porque: 'la segunda puerta se apaga igual que la primera, y un criterio que sólo nombrara a la primera lo dejaría pasar',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '  plan:\n    name: Estado del plan',
        a: '  plan:\n    continue-on-error: true\n    name: Estado del plan',
        porque:
          'la puerta se apaga SIN borrar nada: los siete pasos siguen escritos, siguen corriendo y siguen fallando, y la fusión pasa igual',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/historial-estado.ts --check',
        a: '      - run: npx tsx scripts/historial-estado.ts --check || true',
        porque:
          'el `|| true` es el continue-on-error de un solo paso y no toca el encabezado del job: el ancla tiene que cerrar la línea por la derecha para verlo',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/repo-map.ts --check',
        a: '      # - run: npx tsx scripts/repo-map.ts --check',
        porque:
          'the newest gate goes dark the way the first one did, commented out, and the map would go back to omitting new modules without a word (#334)',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'isolation-job-unprivileged-role',
    enunciado: 'La aplicación conecta como rol NO privilegiado en el job que prueba el aislamiento',
    evaluar: () => {
      const y = crudoDe('.github', 'workflows', 'ci.yml');
      const bloque = y.slice(y.indexOf('aislamiento:'));
      return /DATABASE_URL:\s*postgresql:\/\/mnemosine_app/.test(bloque)
        ? ok('DATABASE_URL usa mnemosine_app')
        : falla('el job de aislamiento conecta como superusuario: la RLS no filtra y una política ausente no se detecta');
    },
  },
  {
    paquete: 'E0.0',
    id: 'audit-record-per-closed-flow',
    enunciado: 'Un flujo no se declara cerrado sin su auditoría adversarial registrada',
    evaluar: () => {
      // S1 lo escribió como INVITACIÓN y por eso no acusó a nadie: la lista de
      // flujos cerrados era un objeto que había que poblar a mano, su único
      // renglón estaba comentado, y `[].filter(...).length === 0` es verdad
      // constante. Con la compuerta en verde por vacía, F01, F02 y A3-A4 se
      // declararon hechos sin un solo registro — la auditoría integral II lo
      // nombró como la meta-brecha: el instrumento que juzga a todos era el
      // único que nadie juzgaba.
      //
      // S2 la vuelve DERIVADA: lo cerrado no lo dice una lista que hay que
      // acordarse de poblar, lo dice EL CATÁLOGO. Cada celda «hecha en F0x»
      // es la declaración de que ese flujo cerró, y entonces su registro de
      // auditoría DEBE existir. Ya no se puede cerrar un flujo sin auditarlo:
      // habría que no reclamar ni una fila.
      //
      // Se derivó del catálogo y no del historial de git a propósito: el
      // primer intento leía los asuntos de los commits y el clon de esta
      // misma máquina resultó ser SUPERFICIAL —igual que el de
      // `actions/checkout` por omisión—, así que la compuerta habría visto un
      // solo commit y dado verde por no mirar. El catálogo está en el árbol,
      // lo versiona el mismo commit que cierra el flujo, y el arnés de
      // mutación puede tocarlo.
      const REGISTROS: Record<string, string> = {
        // Los tramos que la integral II verificó tarjeta por tarjeta.
        F01: 'docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md',
        F02: 'docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md',
        'A3-A4': 'docs/auditorias/2026-09-01-integral-ii/a3a4-entregado.md',
        // F03 se auditó por EJECUCIÓN contra la base (el abanico de escépticos
        // murió dos veces contra el límite de la cuenta): su registro dice eso
        // en su primera sección, porque el método es parte del veredicto.
        F03: 'docs/auditorias/F03.md',
        // F04 se auditó igual que F03 —por EJECUCIÓN contra la base— y además
        // sometiendo sus propios criterios al arnés de mutación, que devolvió
        // cinco anclas blandas antes de dar el verde. Las dos cosas están en
        // su registro, porque el método es parte del veredicto.
        F04: 'docs/auditorias/F04.md',
        // F05 va por TRAMOS, y la compuerta los admite: su expresión acepta
        // `F\d+[a-z]?`. Cada tramo cierra con su propio registro, y mientras
        // ninguno escriba «hecha en F05» a secas el mutante de esta compuerta
        // sigue matando sin reapuntarse.
        F05a: 'docs/auditorias/F05a.md',
        F05b: 'docs/auditorias/F05b.md',
        F05c: 'docs/auditorias/F05c.md',
        F05d: 'docs/auditorias/F05d.md',
        F06a: 'docs/auditorias/F06a.md',
        F06b: 'docs/auditorias/F06b.md',
        F06c: 'docs/auditorias/F06c.md',
        R4: 'docs/auditorias/R4.md',
        D1a: 'docs/auditorias/D1a.md',
        F07a: 'docs/auditorias/F07a.md',
        F07b: 'docs/auditorias/F07b.md',
        F07c: 'docs/auditorias/F07c.md',
        F08a: 'docs/auditorias/F08a.md',
        G1a: 'docs/auditorias/G1a.md',
        G1b: 'docs/auditorias/G1b.md',
        G0: 'docs/auditorias/G0.md',
        G4a: 'docs/auditorias/G4a.md',
        G4b: 'docs/auditorias/G4b.md',
        A6: 'docs/auditorias/A6.md',
        // W0–W1, el tablero como gateway: su registro nace con el tramo.
        W0: 'docs/auditorias/W0.md',
      };

      if (!existe('docs/auditorias/2026-08-31-integral/README.md')) {
        return falla('el registro de auditorías desapareció: docs/auditorias/2026-08-31-integral');
      }

      const catalogo = crudoDe('docs/cli-command-catalog.md');
      const cerrados = [
        ...new Set(
          [...catalogo.matchAll(/hecha en (F\d+[a-z]?|A\d+(?:-A\d+)?|R\d+|W\d+)\b/g)].map((m) => m[1])
        ),
      ].sort();

      if (cerrados.length === 0) {
        return falla(
          'ninguna fila del catálogo se declara hecha en un flujo: o la convención se abandonó ' +
            'y esta compuerta dejó de ver nada, o el catálogo perdió sus celdas.'
        );
      }

      const sinRegistro = cerrados.filter((f) => !REGISTROS[f] || !existe(REGISTROS[f]));
      return sinRegistro.length === 0
        ? ok(
            `${cerrados.length} flujo(s) reclamados por el catálogo (${cerrados.join(', ')}), ` +
              'cada uno con su registro de auditoría en el árbol'
          )
        : falla(
            `flujo(s) que el catálogo declara hechos SIN registro de auditoría: ${sinRegistro.join(', ')}. ` +
              'Cerrar un flujo es auditarlo y archivar el registro bajo docs/auditorias/ en el mismo commit.'
          );
    },
    mutantes: [
      {
        archivo: 'docs/auditorias/F03.md',
        de: '# Auditoría adversarial de F03',
        a: null,
        porque: 'el registro de un flujo cerrado desaparece: la compuerta debe acusarlo, que es lo único que vino a hacer',
      },
      {
        archivo: 'docs/cli-command-catalog.md',
        de: 'hecha en W0**',
        a: 'hecha en W9**',
        porque:
          'una celda reclama un tramo de la serie W que no tiene registro: la compuerta tiene que acusarlo, ' +
          'igual que con los flujos F, A y R',
      },
      {
        archivo: 'docs/cli-command-catalog.md',
        de: 'hecha en F03',
        // El destino tiene que ser un flujo que NO exista todavía. Este mutante
        // apuntaba a F04 y dejó de matar el día que F04 se cerró con su
        // registro: la mutación pasó a describir algo verdadero. Un mutante
        // caduca cuando su «mentira» se vuelve cierta, y hay que reapuntarlo al
        // siguiente flujo sin auditar — no borrarlo.
        a: 'hecha en F05',
        porque: 'el catálogo reclama un flujo NUEVO sin auditoría: cerrar sin registro es exactamente lo prohibido',
      },
    ],
  },

  // ---- S2 · El instrumento se somete al instrumento ----

  {
    paquete: 'E0.0',
    id: 'criteria-mutation-harness',
    enunciado: 'Los criterios tienen espejo ejecutable: un mutante declarado los pone en rojo',
    evaluar: () => {
      // S2: §7 prometía desde el principio que «cada criterio llega con su
      // espejo que neutraliza la conducta medida y afirma el rojo». Era verdad
      // a medias — los espejos existían como PASE MANUAL, corrido a mano cada
      // fase, cuyo resultado vivía en el mensaje del commit. Nada impedía que
      // un criterio naciera sin ninguno ni que uno viejo dejara de morder.
      //
      // Ahora el espejo es una prueba: cada `mutante` se aplica sobre el seam
      // de lectura (overlay en memoria, el árbol jamás se toca) y se exige
      // `falla`. Este criterio vigila que el arnés siga existiendo, que el
      // seam siga siendo la única puerta de lectura, y que la deuda encoja.
      if (!existe('tests/plan/mutacion.spec.ts')) {
        return falla('el arnés de mutación desapareció: los espejos volverían a ser un pase manual');
      }
      const arnes = codigoDe('tests/plan/mutacion.spec.ts');
      if (!/conFuenteMutada\(overlay, \(\) => criterio\.evaluar\(\)\)/.test(arnes)) {
        return falla('el arnés dejó de evaluar el criterio BAJO la mutación: mediría el árbol limpio');
      }
      if (!/\.toBe\('falla'\)/.test(arnes)) {
        return falla('el arnés dejó de EXIGIR el rojo: un mutante que sobrevive pasaría inadvertido');
      }
      // El seam es la única puerta: si un criterio vuelve a leer el disco
      // directo, su mutante no lo toca y el espejo miente en verde. Se cuenta
      // sobre el fuente CRUDO porque el comentario que lo explica también
      // nombra fs.readFileSync — y aquí importa el conteo, no la presencia.
      //
      // El instrumento ya no es un solo archivo (#294): el índice, los
      // ayudantes de `criteria/shared.ts` y los paquetes de `criteria/`. Se
      // cuenta sobre su UNIÓN, y la lista sale del directorio: un archivo de
      // criterios nuevo no puede quedar fuera de la cuenta por no estar
      // nombrado aquí.
      const instrumento = instrumentFiles();
      const cru = instrumento.map((f) => crudoDe(f)).join('\n');
      const lecturasDirectas = (cru.match(/fs\.readFileSync\(/g) ?? []).length;
      if (lecturasDirectas > 1) {
        return falla(
          `${lecturasDirectas} lectura(s) directa(s) de disco en los criterios: sólo puede quedar la ` +
            'de leer() (el seam). Una lectura que rodea el seam es un criterio que ningún espejo puede mutar.'
        );
      }
      // THE MIRRORS ARE COUNTED ONE BY ONE, AGAINST A GENERATED CENSUS (#356).
      //
      // T2 (#89) made this a count of MIRRORS, not criteria, with zero slack:
      // retiring a mirror had to lower a constant in the same diff. That was
      // right, and it was two literals —MIRRORS_FLOOR and ANCHORS_HERE— that
      // every PR adding a mirror edited by hand, so two such PRs always
      // collided and the merge was resolved by summing by hand (#249, #272,
      // #286, #346). The census keeps the protection and drops the literal:
      // `src/plan/mutation-census.txt` holds one line per mirror and per `de:`
      // anchor, generated by `npm run mutation:census`. Retiring one still has
      // to show in the same diff —its census line goes— and now the failure
      // NAMES what vanished instead of printing two numbers.
      //
      // Only a VANISHED entry fails here, as the old floors did. A new mirror
      // not yet in the census is the unit suite's business
      // (tests/plan/mutation-census.spec.ts runs the exact `--check`).
      if (!existe(CENSUS_FILE)) {
        return falla(`the mirror census ${CENSUS_FILE} is gone: a mirror could be retired without anything noticing`);
      }
      const committed = parseCensus(crudoDe(CENSUS_FILE));
      if (committed.length === 0) {
        return falla(`the mirror census ${CENSUS_FILE} is empty: it protects no mirror`);
      }
      // `CRITERIOS` is an in-memory array and the seam only intercepts DISK
      // reads, so no mutant can lower the mirror half. The anchor half is the
      // same fact read through the seam, and that one a mirror can reach:
      // commenting out an anchor retires a mirror while leaving it written.
      const live = measureCensus(CRITERIOS, instrumento, (f) => crudoDe(f));
      const { vanished } = censusDrift(committed, live);
      const mirrors = live.filter((e) => e.startsWith('mirror\t')).length;
      const anchors = live.length - mirrors;
      return vanished.length === 0
        ? ok(
            `${mirrors} espejos ejecutables (${anchors} anclados en este archivo); ` +
              'toda lectura de fuente pasa por el seam'
          )
        : falla(
            `${vanished.length} census mirror(s) or anchor(s) are no longer in the tree:\n` +
              vanished.map((e) => `  ${describeEntry(e)}`).join('\n') +
              '\na mirror is retired only by dropping it from the census in plain sight (npm run mutation:census), in the same commit'
          );
    },
    mutantes: [
      {
        archivo: 'tests/plan/mutacion.spec.ts',
        de: ".toBe('falla')",
        a: ".toBe('ok')",
        porque: 'el arnés deja de exigir el rojo: los espejos pasarían a bendecir a los mutantes vivos',
      },
      {
        // El espejo del TRINQUETE DE ESPEJOS, que es la parte que no se puede
        // mirar desde el array: comentar un ancla retira un espejo dejándolo
        // escrito, y el conteo en memoria no se entera porque el objeto sigue
        // ahí. El seam sí lo ve.
        archivo: 'src/plan/criteria/e0-0.ts',
        de: "        de: \".toBe('falla')\",",
        a: "        // de: \".toBe('falla')\",",
        porque:
          'un espejo se retira comentándolo —queda escrito y muerto, como un paso de CI— y hasta T2 la línea base contaba criterios, así que 118 contra 14 exigidos se tragaban la pérdida sin moverse',
      },
      {
        // A mirror that left the code but not the census: the census names it
        // and the criterion has to go red. This is what the two literals
        // guarded, now per entry.
        archivo: 'src/plan/mutation-census.txt',
        de: '# Mutation census (#356).',
        a: 'mirror\tmemory\tE0.0 ghost-criterion\tnowhere.ts\ta mirror retired from the code\n# Mutation census (#356).',
        porque:
          'a mirror disappears from the code while the census still records it: if only totals were compared, or the census were not read, the loss would go green',
      },
      {
        archivo: 'src/plan/mutation-census.txt',
        de: '# Mutation census (#356).',
        a: null,
        porque:
          'the census file is deleted: with nothing to compare against, every mirror could be retired in silence',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'criteria-vacuity-harness',
    enunciado: 'Un criterio que no encuentra nada que mirar no puede salir verde sin declararlo',
    evaluar: () => {
      // T2 · LA MÁQUINA QUE PONE ROJOS A LOS DEMÁS DE GOLPE (issue #89).
      //
      // El arnés de mutación pregunta criterio por criterio «¿te pone rojo
      // ESTA mutación?», y sólo por las que alguien se acordó de escribir. La
      // prueba de vacuidad hace la pregunta contraria y de una vez: vacía los
      // 1 231 archivos versionados por el seam y exige que los criterios se
      // den cuenta. Encontró tres que medían la nada y la llamaban
      // conformidad, entre ellos el censo del perímetro —«0 rutas revisadas;
      // todas montan la guarda»—, que es la vara con la que se va a medir T9.
      if (!existe('tests/plan/vacuity.spec.ts')) {
        return falla('la prueba de vacuidad desapareció: un criterio podría volver a medir la nada y llamarlo conformidad');
      }
      const spec = codigoDe('tests/plan/vacuity.spec.ts');
      if (!/conFuenteMutada\(emptied/.test(spec)) {
        return falla('la prueba de vacuidad dejó de evaluar BAJO el árbol vaciado: mediría el árbol limpio, donde todo criterio sano sale verde');
      }
      if (!/toBeGreaterThan\(500\)/.test(spec)) {
        return falla(
          'la prueba de vacuidad perdió su propia guarda de vacuidad: sin exigir que el censo de ' +
            'archivos devuelva algo, no vaciaría nada y todos saldrían verdes «correctamente»'
        );
      }

      // LA LISTA DE EXCEPCIONES TIENE TOPE, o el arreglo obvio de un rojo sería
      // apuntarse en ella. Sólo encoge: un verde nuevo sobre el vacío se paga
      // endureciendo el criterio, no declarándolo correcto.
      const DECLARED_GREENS_MAX = 15;
      const declared = (spec.match(/^ {2}\[$/gm) ?? []).length;
      return declared <= DECLARED_GREENS_MAX
        ? ok(`la prueba de vacuidad corre sobre el árbol vaciado, con ${declared} verdes declarados de ${DECLARED_GREENS_MAX} admitidos`)
        : falla(
            `${declared} verdes declarados sobre el vacío y el tope son ${DECLARED_GREENS_MAX}: ` +
              'un criterio que mide la nada se arregla endureciéndolo, no apuntándolo en la lista de los correctos'
          );
    },
    mutantes: [
      {
        archivo: 'tests/plan/vacuity.spec.ts',
        de: 'conFuenteMutada(emptied',
        a: 'conFuenteMutada({}',
        porque:
          'la prueba deja de vaciar el árbol y pasa a evaluar el real, donde 172 criterios salen verdes por buenas razones: seguiría corriendo, seguiría en verde, y no comprobaría nada',
      },
      {
        archivo: 'tests/plan/vacuity.spec.ts',
        de: 'toBeGreaterThan(500)',
        a: 'toBeGreaterThan(0)',
        porque:
          'la guarda que impide que la prueba de vacuidad sea ella misma vacua se afloja: con un censo de archivos roto vaciaría casi nada y bendeciría a todos',
      },
      {
        archivo: 'tests/plan/vacuity.spec.ts',
        de: "  [\n    'orphan-export-baseline-only-shrinks',",
        a: "  [\n    'uno-de-mas',\n    'una razón que nadie escribió',\n  ],\n  [\n    'orphan-export-baseline-only-shrinks',",
        porque:
          'la lista de excepciones crece, que es el arreglo obvio y equivocado de un rojo de vacuidad: el tope existe para que apuntarse cueste más que endurecer el criterio',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'agent-corpus-staleness-gate',
    enunciado: 'El corpus que instruye al agente tiene compuerta de caducidad',
    evaluar: () => {
      // S2: el agente lee src/ai/docs como VERDAD —grounding.ts incluso lo
      // manda a leerlos para *verificar*— y la auditoría II encontró dos
      // páginas que le enseñaban lo que el sistema tiene módulos para
      // corregir: el IVA acreditado de inmediato (el defecto que
      // iva-ppd-reclass repara) y una anulación con auto-posteo que R1 hizo
      // imposible. No estaban desactualizadas: MAL-INSTRUÍAN, y su lector no
      // puede dudar como dudaría una persona.
      if (!existe('src/ai/docs/manifiesto.json') || !existe('scripts/corpus-manifiesto.ts')) {
        return falla('el manifiesto del corpus desapareció: los manuales del agente volverían a caducar en silencio');
      }
      const script = codigoDe('scripts/corpus-manifiesto.ts');
      if (!/sellado !== hoy/.test(script)) {
        return falla('el manifiesto dejó de comparar hashes: no detectaría que una fuente cambió');
      }
      if (!/m\.sin_revisar\.length > SIN_REVISAR_MAXIMO/.test(script)) {
        return falla('la deuda de manuales sin revisar dejó de tener trinquete: podría crecer en silencio');
      }
      // T2 · LA COBERTURA (issue #89). El detector de caducidad es exacto sobre
      // lo que el manifiesto DECLARA y ciego sobre el resto: 13 manuales
      // declarados contra 27 en el directorio, y los 14 restantes exentos por
      // un PÁRRAFO de MANIFIESTO.md que ningún programa leía. Un `.md` nuevo no
      // entraba en ninguna lista, no lo nombraba ningún fallo, y el agente lo
      // leía como verdad para siempre. Ahora `--check` compara los tres censos
      // que tienen que decir lo mismo: el directorio, `DOC_TOPICS` —lo que el
      // agente puede pedir— y `manuales` ∪ `exentos`.
      if (!/checkCoverage\(m\)/.test(script) || !/DOC_TOPICS/.test(script)) {
        return falla(
          'la compuerta del corpus dejó de comparar el directorio con el manifiesto y con DOC_TOPICS: ' +
            'un manual nuevo sin declarar volvería a ser invisible, y el agente lo leería como verdad'
        );
      }
      const manifiesto = crudoDe('src/ai/docs/manifiesto.json');
      if (!/"exentos"\s*:/.test(manifiesto)) {
        return falla('el manifiesto perdió su lista de exentos: la exención volvería a vivir en prosa, donde ningún programa la lee');
      }
      // La compuerta corre en CI o es un comando que nadie teclea. Por el
      // PASO y no por la cadena (T2): `/corpus-manifiesto\.ts --check/` casaba
      // dentro de `# - run: …`, así que comentar la línea —el modo de fallo
      // natural de un paso de CI— dejaba este criterio en verde con la
      // compuerta apagada. El gemelo del censo de superficie ya anclaba bien;
      // aquí se usa la misma plantilla, ahora escrita una sola vez en stepRuns.
      if (!stepRuns(crudoDe('.github', 'workflows', 'ci.yml'), 'npx tsx scripts/corpus-manifiesto.ts --check')) {
        return falla('la compuerta del corpus no corre en CI: sería una comprobación optativa, o una línea comentada que se lee como si corriera');
      }
      // Y los dos pasajes que mal-instruían quedaron corregidos: el manual
      // debe NOMBRAR la cuenta donde el IVA de un PPD aparca, y decir que un
      // asiento posteado no cambia de estado.
      const cfdi = crudoDe('src/ai/docs/mexico-cfdi.md');
      // La FRASE, no el número. Bastaba con que «1135» apareciera en alguna
      // parte, y F05d añadió una segunda mención (la regla del cheque
      // cobrado): mutar la del PPD dejaba la otra en pie y el criterio seguía
      // en verde mientras el manual enseñaba justo lo contrario de lo que
      // vigila. Un número suelto no es una lección; la lección es a qué cuenta
      // va el IVA de un PPD.
      if (!/PPD received → DR 1135/.test(cfdi) || !/2125/.test(cfdi)) {
        return falla('mexico-cfdi.md volvió a enseñar el IVA sin las cuentas de aparcado (1135/2125)');
      }
      return /IMMUTABLE|inmutable/i.test(crudoDe('src/ai/docs/accounting.md'))
        ? ok('manifiesto con hashes y deuda que sólo encoge, en CI, y los dos manuales que mal-instruían corregidos')
        : falla('accounting.md volvió a prometer que un asiento posteado cambia de estado');
    },
    mutantes: [
      {
        // Anclado en la FRASE del PPD y no en el número suelto. Con `de: '1135'`
        // el mutante cambiaba la primera aparición del documento, y F05d añadió
        // otra antes (la regla del cheque cobrado): el criterio encontraba la
        // que quedaba y el mutante sobrevivía. El gemelo de siempre.
        archivo: 'scripts/corpus-manifiesto.ts',
        de: '  const gaps = checkCoverage(m);',
        a: '  const gaps: Gap[] = [];',
        porque:
          'la compuerta vuelve a mirar sólo los 13 manuales declarados y a callar sobre los 14 que no lo están: un .md nuevo sin declarar queda invisible para siempre y el agente lo lee como verdad',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/corpus-manifiesto.ts --check',
        a: '      # - run: npx tsx scripts/corpus-manifiesto.ts --check',
        porque:
          'la compuerta se apaga comentándola, y con el ancla por subcadena este criterio casaba su propio comentario y bendecía al mutante que lo apagaba',
      },
      {
        archivo: 'src/ai/docs/mexico-cfdi.md',
        de: 'PPD received → DR 1135',
        a: 'PPD received → DR 1130',
        porque: 'el manual vuelve a enseñar que el IVA de un PPD se acredita de inmediato: el defecto que iva-ppd-reclass existe para reparar',
      },
      {
        archivo: 'scripts/corpus-manifiesto.ts',
        de: 'sellado !== hoy',
        a: 'sellado === hoy',
        porque: 'la comparación de hashes se invierte: la compuerta pasaría a acusar lo que NO cambió',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'delivery-history-completeness-gate',
    enunciado: 'El historial de entrega no puede quedarse atrás de lo entregado',
    evaluar: () => {
      // docs/HISTORY.md se reconstruyó una vez contra el árbol, porque el
      // artefacto anterior narraba sprints cuyos hashes no existen en `main`.
      // Quedó bien, y volvió a caducar por la única vía que quedaba: nadie lo
      // miró. Medido el 2026-09-08 decía que el PR #53 estaba ABIERTO —llevaba
      // un día fusionado— y no nombraba los dieciséis siguientes. Un historial
      // de entrega equivocado sobre lo entregado es exactamente el artefacto
      // contra el que advierte su propia cabecera.
      if (!existe('scripts/historial-estado.ts') || !existe('docs/HISTORY.md')) {
        return falla('el guardián del historial desapareció: el documento volvería a caducar en silencio');
      }
      const script = codigoDe('scripts/historial-estado.ts');
      // LO QUE EXIGE, que es lo único que impide que falte una fila.
      if (!/censo\.atrasados\.length > 0/.test(script)) {
        return falla('el guardián dejó de exigir los PRs atrasados: sólo verificaría que su censo cuadra consigo mismo');
      }
      // Y la deuda tiene TECHO. Sin él, la gracia sería una amnistía: bastaría
      // subirla para que el documento no volviera a caducar «todavía».
      if (!/const DIAS_DE_GRACIA = \d+;/.test(script)) {
        return falla('la gracia del historial dejó de tener techo declarado: el atraso podría crecer sin límite');
      }
      // Y LA GRACIA SE MIDE CONTRA EL RELOJ, no contra el árbol. La primera
      // versión usaba la fecha del commit más reciente, y así el PR sin fila
      // que ERA la punta tenía antigüedad 0 para siempre: la compuerta prometía
      // fallar a los siete días y no fallaba nunca para justo el último, que es
      // el que más importa.
      if (!/const hoy = new Date\(\)\.toISOString\(\)/.test(script)) {
        return falla('la gracia volvió a medirse contra la fecha del árbol: un PR sin fila que sea la punta no envejecería nunca');
      }
      // Y QUE NO SE SALTE CUANDO NO PUEDE MIRAR. `actions/checkout` clona a
      // profundidad 1 por omisión: sin esto el recorrido vería UN commit y el
      // documento saldría verde sin comprobarse. Es el falso verde que tenía
      // `doctor` antes del T1b, contando sin contexto de inquilino.
      if (!/cortesSuperficiales\(\)\.has/.test(script)) {
        return falla('el guardián dejó de detectar la historia truncada: en un clon superficial saldría en verde sin haber contado nada');
      }
      // La compuerta corre en CI o es un comando que nadie teclea. Se mide
      // sobre el YAML SIN sus comentarios: si no, la propia prosa que explica
      // el paso lo pondría verde aunque el paso se hubiera borrado — el modo
      // exacto en que nacieron verdes por accidente otros dos criterios.
      const ci = crudoDe('.github', 'workflows', 'ci.yml').replace(/^[ \t]*#.*$/gm, '');
      // T2 unificó esto con las otras tres puertas. Quitar los comentarios
      // antes de buscar ya frenaba al mutante que comenta la línea, pero no al
      // `|| true` que la deja correr y descartar su salida; `stepRuns` cierra
      // la línea por los dos lados y es la única plantilla de la casa.
      if (!stepRuns(ci, 'npx tsx scripts/historial-estado.ts --check')) {
        return falla('la compuerta del historial no corre en CI: sería una comprobación optativa');
      }
      // ACOTADO AL JOB DEL PLAN, que es donde corre esta compuerta.
      //
      // Hasta I22 este archivo tenía UN solo `fetch-depth: 0` y la pregunta
      // «¿alguien pide profundidad completa?» respondía por el job correcto
      // por accidente. I22 añade un segundo job que también la pide, y desde
      // entonces borrar la del job del plan dejaba este criterio VERDE
      // apoyándose en la del vecino. Un ancla que acierta porque sólo hay una
      // aparición deja de acertar en cuanto hay dos.
      const planJob = sectionOf(ci, '  plan:', /^ {2}[a-z][a-z-]*:$/m);
      if (planJob === null || !/fetch-depth: 0/.test(planJob)) {
        return falla('el checkout del job del plan dejó de pedir profundidad completa: el guardián no podría recorrer la historia');
      }
      if (!/HISTORIAL-GENERADO:INICIO/.test(crudoDe('docs/HISTORY.md'))) {
        return falla('el documento perdió los marcadores del censo: nadie podría regenerarlo ni compararlo');
      }
      return ok(
        'el historial se verifica contra `git log --first-parent` en CI, con profundidad completa y fallando cuando no puede mirar'
      );
    },
    mutantes: [
      {
        archivo: 'scripts/historial-estado.ts',
        de: 'censo.atrasados.length > 0',
        a: 'censo.atrasados.length > 99999',
        porque: 'la compuerta deja de acusar los PRs que faltan: el historial podría volver a quedarse dieciséis PRs atrás, en verde',
      },
      {
        archivo: 'scripts/historial-estado.ts',
        de: 'const hoy = new Date().toISOString()',
        a: 'const hoy = (vertebral[0]?.fecha ?? new Date().toISOString())',
        porque: 'la gracia vuelve a medirse contra el árbol: el PR sin fila que sea la punta tendría antigüedad cero para siempre y la compuerta no fallaría jamás por él',
      },
      {
        archivo: 'scripts/historial-estado.ts',
        de: 'const DIAS_DE_GRACIA = 7;',
        a: 'const GRACIA_SIN_TECHO = 7;',
        porque: 'la gracia deja de tener techo declarado: pasaría de ser una deuda acotada a una amnistía',
      },
      {
        archivo: 'scripts/historial-estado.ts',
        de: 'cortesSuperficiales().has',
        a: 'new Set<string>().has',
        porque: 'el guardián deja de ver que la historia está truncada: en el checkout por omisión de CI contaría un commit y firmaría el verde',
      },
      {
        archivo: '.github/workflows/ci.yml',
        de: 'historial-estado.ts --check',
        a: 'historial-estado.ts # --check',
        porque: 'el paso deja de verificar y pasa a REGENERAR: saldría siempre en verde reescribiendo el censo en vez de exigirlo',
      },
    ],
  },
  // ---- S3 · Respaldo, restauración y el corredor que no rellenaba ----

  {
    paquete: 'E0.0',
    id: 'rls-silent-backfill-repaired',
    enunciado: 'El migrador no puede rellenar cero filas en silencio: Postgres se lo impide',
    evaluar: () => {
      // EL DEFECTO. Las migraciones corren como un rol NOBYPASSRLS que además
      // es DUEÑO de tablas con FORCE ROW LEVEL SECURITY — lo que le quita su
      // exención implícita. Sin contexto de inquilino, todo DML de migración
      // sobre una tabla acotada afecta CERO FILAS, sin error, y la migración
      // se registra como aplicada. Reproducido: el rol ve 0 de 4 entidades.
      // Tres migraciones lo sufrieron (037, 040, 043) y una ya provocó una
      // colisión de folios en un despliegue real.
      //
      // POR QUÉ NO BASTA DOCUMENTARLO: la 026 ya había escrito el patrón
      // correcto —el bucle por inquilino— y la 043 lo repitió sin él
      // dieciocho migraciones después. Es reincidencia, no descuido.
      //
      // LA GUARDA ES DE POSTGRES, NO NUESTRA, y esa es su virtud. Con
      // `row_security = off` el motor no desactiva RLS: LANZA 42501 cuando
      // una consulta habría sido filtrada. El cuarto olvido no podrá callar,
      // porque quien se niega es el motor y no un regex sobre el .sql. Una
      // migración que SÍ maneja inquilinos hace opt-in explícito con
      // `SET LOCAL row_security = on` y su bucle.
      const m = codigoDe('src/database/migrate.ts');
      if (!/SET row_security = off/.test(m)) {
        return falla(
          'el migrador dejó de correr con row_security=off: el filtrado silencioso volvería a ser ' +
            'silencioso, y la clase que ya costó una colisión de folios podría repetirse'
        );
      }
      // Y la reparación de lo que se perdió, con el patrón que la 026
      // consagró: iterar inquilinos fijando el contexto.
      const reparacion = 'src/database/migrations/048_reparar_lo_que_rls_filtro_en_silencio.sql';
      if (!existe(reparacion)) {
        return falla('la migración de reparación desapareció: las tres siembras mudas seguirían mudas');
      }
      const r = crudoDe(reparacion);
      const cubre =
        /range_proof = NULL/.test(r) &&
        /zkverify_proof = NULL/.test(r) &&
        (r.match(/INSERT INTO entity_sequences/g) ?? []).length >= 5 &&
        /UPDATE bills/.test(r);
      if (!cubre) {
        return falla('la reparación dejó de cubrir las tres migraciones (037 etiquetado, 040 purga, 043 siembra)');
      }
      return /SET LOCAL row_security = on/.test(r) && /set_config\('app\.current_tenant'/.test(r)
        ? ok('el motor lanza 42501 ante el filtrado silencioso, y la reparación re-corre las tres con el bucle por inquilino')
        : falla('la reparación no declara su opt-in ni fija contexto: correría bajo el piso y fallaría, o volvería a rellenar cero');
    },
    mutantes: [
      {
        archivo: 'src/database/migrate.ts',
        de: "await client.query('SET row_security = off');",
        a: "await client.query('SELECT 1');",
        porque: 'el piso desaparece y el filtrado silencioso vuelve a ser silencioso: la clase que ya costó una colisión de folios',
      },
      {
        archivo: 'src/database/migrations/048_reparar_lo_que_rls_filtro_en_silencio.sql',
        de: 'SET LOCAL row_security = on',
        a: 'SET LOCAL row_security = off',
        porque: 'la reparación pierde su opt-in: correría bajo el piso y ni siquiera podría leer lo que viene a reparar',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'backup-verified-by-restore',
    enunciado: 'Un respaldo se prueba restaurándolo, y dice lo que no lleva',
    evaluar: () => {
      // S3: el mayor es inmutable a propósito (041 no admite UPDATE ni
      // DELETE sobre lo posteado; 033 deja la bitácora en sólo-agregar), y
      // esa misma inmutabilidad impide repararlo a mano — la 041 llega a
      // prescribir «bórrala entera y vuelve a migrar». La vía de recuperación
      // que el esquema NOMBRA es la restauración, y no existía ni una línea
      // sobre ella en todo el árbol.
      if (!existe('src/services/backup/backup-service.ts')) {
        return falla('no hay camino de respaldo: la inmutabilidad del mayor deja de ser una garantía y pasa a ser una trampa');
      }
      const b = codigoDe('src/services/backup/backup-service.ts');
      // La verificación que importa RESTAURA. Un verificador que sólo mira el
      // archivo comprueba que existe, no que sirva.
      // Forma de LLAMADA, no el símbolo: el nombre también aparece en el
      // import, y un regex laxo bendice al mutante que deja el import y
      // desconecta la llamada — la lección de AUD-6, cometida aquí mismo al
      // escribir este criterio y cazada por su propio espejo.
      if (!/pg_restore/.test(b) || !/await runLedgerChecksEn\(/.test(b)) {
        return falla('la verificación dejó de restaurar y de correr los chequeos: un respaldo no probado no es un respaldo');
      }
      // Y falla cerrado si el rol no puede volcar: se descubrió construyéndolo
      // que pg_dump como dueño REVIENTA por FORCE RLS — la misma clase que
      // silenciaba el DML, ahora sobre la recuperación.
      // El ANCLA ES LA NEGATIVA, no la existencia del comprobador: dejar la
      // función y borrar el `throw` es exactamente el mutante que sobrevivió
      // a la primera versión de este criterio.
      if (!/if \(!capacidad\.puede\) throw new ValidationError/.test(b) || !/rolbypassrls/.test(b)) {
        return falla('el respaldo dejó de NEGARSE cuando el rol no puede volcar: produciría un volcado parcial con nombre de respaldo');
      }
      // Lo que el volcado NO lleva se declara SIEMPRE: el material
      // criptográfico vive fuera de la base y sin él lo restaurado queda
      // ilegible.
      if (!/noIncluye/.test(b) || !/ENCRYPTION_KEY/.test(b)) {
        return falla('el manifiesto dejó de declarar lo que el volcado no lleva: prometería un respaldo completo que no lo es');
      }
      return /restaurar encima de una viva|ya existe/.test(b)
        ? ok('respaldo con manifiesto, verificación que restaura y corre los chequeos, y lo que no lleva declarado')
        : falla('la restauración dejó de exigir base NUEVA: sobrescribir una viva destruye lo que se intenta salvar');
    },
    mutantes: [
      {
        archivo: 'src/services/backup/backup-service.ts',
        de: 'if (!capacidad.puede) throw new ValidationError(capacidad.motivo);',
        a: 'void capacidad;',
        porque: 'el respaldo deja de fallar cerrado y produce un volcado parcial con nombre de respaldo',
      },
      {
        // Sobre la LLAMADA, no sobre el import: mutar el import deja la
        // llamada viva y el criterio la sigue viendo — lo comprobó este mismo
        // espejo, que en su primera versión declaró el mutante flojo.
        archivo: 'src/services/backup/backup-service.ts',
        de: 'await runLedgerChecksEn(',
        a: 'await noVerificarNada(',
        porque: 'la verificación deja de correr los chequeos del mayor: comprobaría que el archivo existe, no que sirva',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'cost-per-row-band-split',
    enunciado: 'El costo por fila publica su banda y separa entrega de garantía',
    evaluar: () => {
      // S2: el instrumento publicaba 0,7 % de cola correctiva —y bajando,
      // porque su regex sobre el asunto sólo casaba uno de cada dieciocho
      // commits correctivos— donde la medición a mano de la auditoría II da
      // entre 11,8 % y 51,7 %. Subestimaba por un factor de 17× a 74× y lo
      // hacía dos líneas encima de la referencia fundacional del 12,3 %, como
      // invitando a concluir que la cola se había resuelto sola.
      const s = codigoDe('scripts/costo-por-fila.ts');
      // La banda son DOS convenciones publicadas juntas: una sola volvería a
      // cerrar la pregunta con un número.
      if (!/estricta/.test(s) || !/amplia/.test(s)) {
        return falla('la cola volvió a publicarse como un número solo: cerraría la pregunta con la cifra equivocada');
      }
      if (!/TRAILER_CORRIGE/.test(s)) {
        return falla('el clasificador perdió el trailer declarado y volvería a depender sólo de adivinar el asunto');
      }
      // Entrega y garantía MEDIDAS por ruta, no derivadas de un porcentaje.
      if (!/export function entregaYGarantia/.test(s) || !/insercionesEn\(a, b, 'tests', 'scripts'\)/.test(s)) {
        return falla('entrega y garantía dejaron de medirse por ruta: volverían a ser una estimación de una estimación');
      }
      return /ENTREGA/.test(s) && /GARANTÍA/.test(s)
        ? ok('la cola se publica como banda con su trailer, y entrega/garantía salen medidas por ruta')
        : falla('la salida dejó de separar entrega de garantía: presupuestar una fase con el número junto la presupuesta mal');
    },
    mutantes: [
      {
        archivo: 'scripts/costo-por-fila.ts',
        de: "insercionesEn(a, b, 'tests', 'scripts')",
        a: 'insercionesEn(a, b)',
        porque: 'la garantía deja de medirse por ruta y se cuenta el árbol entero: la separación se vuelve ruido',
      },
    ],
  },
  {
    paquete: 'E0.0',
    id: 'ux-surface-census-ci-ratchet',
    enunciado:
      'El censo de superficie corre en CI, y su trinquete está apretado contra lo medido',
    mutantes: [
      {
        archivo: '.github/workflows/ci.yml',
        de: '      - run: npx tsx scripts/ux-status.ts --check',
        a: '      # - run: npx tsx scripts/ux-status.ts --check',
        porque:
          'puerta-declarada-y-no-cableada: el instrumento existía, la prueba lo importaba, y la degradación de superficie entraba igual porque nada lo corría en el único sitio que decide una fusión',
      },
    ],
    evaluar: () => {
      const ci = crudoDe('.github/workflows/ci.yml');
      // Ancla al PASO, no al texto: el modo de fallo natural de un paso de
      // CI es que alguien lo comente, y `# - run: … --check` contiene la
      // cadena entera. El primer intento de este criterio casaba su propio
      // comentario y bendecía al mutante que lo apagaba. T2 sacó esta
      // plantilla a `stepRuns`, que es de donde la copian ahora las otras.
      if (!stepRuns(ci, 'npx tsx scripts/ux-status.ts --check')) {
        return falla('el censo de superficie salió de CI: la degradación de usabilidad volvería a entrar sin que nada la detenga en la fusión');
      }
      // Y las seis líneas base existen. Un censo sin línea base mide y
      // no acusa; el trinquete es la mitad que sirve.
      const censo = codigoDe('scripts/ux-status.ts');
      const base = censo.match(/LINEAS_BASE[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
      if (!base) {
        return falla('el censo perdió sus líneas base: mediría sin acusar, que es la mitad que no sirve');
      }
      const cuantas = (base[1].match(/:\s*\d+/g) ?? []).length;
      return cuantas === 6
        ? ok('el censo de superficie corre en CI con sus seis líneas base sembradas en lo medido')
        : falla(`el censo declara ${cuantas} líneas base de las 6 medidas: una medida sin trinquete no frena nada`);
    },
  },
];
