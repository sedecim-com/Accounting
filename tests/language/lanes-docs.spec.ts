import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ROOT,
  lanesFor,
  isSpanishComment,
  commentsByLine,
  asRepoPath,
  docsLanes,
  cleanCitation,
  spanishRatio,
  linesFor,
  blobSha,
  declaredSha,
  withoutFencedBlocks,
} from '../../scripts/language/lanes/docs.js';

// ============================================================
// LA PRUEBA DE LOS CARRILES DE DOCUMENTACIÓN (I2 · issue #144)
//
// Un metro se juzga por dos cosas y no por una: que cuente lo que dice contar,
// y que NO cuente lo que se le parece. La segunda mitad es la que decide si
// alguien lo sigue mirando, porque un número inflado se descubre a la semana y
// entonces se apaga el instrumento entero — así que casi todos los casos de
// abajo son cosas del árbol real que ESTUVIERON contadas de más mientras se
// escribía esto, y que están aquí para que no vuelvan.
//
// Y hay una tercera cosa que probar, más difícil: dos de los cuatro carriles
// valen hoy 2 y 0 sobre el árbol real, porque el esquema de gemelas viene de un
// PR sin fusionar. Un carril que nadie ha visto pasar de cero no está probado.
// Por eso la mitad de abajo le construye un árbol de juguete y le enseña la
// gemela desactualizada que este repositorio todavía no tiene.
// ============================================================

const ROOTS = new Set(['src', 'tests', 'scripts', 'docs', 'docker', 'skills', 'files', '.github']);
const pathOf = (raw: string): string | null => asRepoPath(cleanCitation(raw), ROOTS);

describe('qué es una ruta del árbol y qué sólo se le parece', () => {
  it('la ruta con referencia de línea suelta la línea y sigue siendo la ruta', () => {
    expect(pathOf('src/ai/floor.ts')).toBe('src/ai/floor.ts');
    expect(pathOf('src/ai/approval-policy.ts:161')).toBe('src/ai/approval-policy.ts');
    expect(pathOf('src/ai/context.ts:75,89,97')).toBe('src/ai/context.ts');
    // El orden de la limpieza importa: si el `:110` se quitara antes que la
    // coma, esta cita se quedaría con el `:110,` pegado y contaría como una
    // ruta distinta de la misma.
    expect(pathOf('src/cli/ar-command.ts:110,')).toBe('src/cli/ar-command.ts');
    expect(pathOf('src/config/index.ts:214+')).toBe('src/config/index.ts');
    expect(pathOf('docs/SCOPE.md#vision')).toBe('docs/SCOPE.md');
  });

  it('la carpeta sólo cuenta si viene escrita como carpeta', () => {
    expect(pathOf('src/cli/')).toBe('src/cli');
    expect(pathOf('src/services/integrations/canales/')).toBe('src/services/integrations/canales');
    // Sin barra final y sin extensión no hay forma de saber que es una ruta:
    // `docs/auditoria-integral-ii` es un NOMBRE DE RAMA que aparece en dos
    // síntesis de auditoría, y contarlo como carpeta muerta era mentira.
    expect(pathOf('docs/auditoria-integral-ii')).toBeNull();
  });

  it('la prosa que enumera carpetas con barras no es una ruta', () => {
    // «33 files changed, todas en `src/tests/scripts`» — tres carpetas, no una
    // ruta. La regla es que TODOS los segmentos sean raíces del repo.
    expect(pathOf('src/tests/scripts')).toBeNull();
    expect(pathOf('src/docs/tests')).toBeNull();
  });

  it('el prefijo cortado para filtrar vitest no es una ruta', () => {
    // Sale de docs/wiki/Pruebas-y-CI.md: `tests/integration/s3-` es lo que se
    // teclea para que vitest case varios archivos, no un archivo.
    expect(pathOf('tests/integration/s3-')).toBeNull();
    expect(pathOf('src/services/payroll/mx_')).toBeNull();
  });

  it('las banderas, los comodines, las URL y las formas no son rutas', () => {
    expect(pathOf('-B/--cost')).toBeNull();
    expect(pathOf('-s/--status')).toBeNull();
    expect(pathOf('!tests/fixtures/certs/*.key')).toBeNull();
    expect(pathOf('.../servicios/soap/cancel.wsdl')).toBeNull();
    expect(pathOf('https://github.com/sedecim-com/Accounting/blob/main/README.md')).toBeNull();
    expect(pathOf('mailto:seguridad@sedecim.com')).toBeNull();
    expect(pathOf('${apiPrefix}/audit')).toBeNull();
    expect(pathOf('"contract:sql": "tsx src/database/contract/cli.ts"')).toBeNull();
    expect(pathOf('src/database/migrations:/docker-entrypoint-initdb.d')).toBeNull();
    // Sin barra no hay ruta: `posting.ts` a secas puede estar en cinco sitios.
    expect(pathOf('posting.ts')).toBeNull();
  });
});

describe('los bloques cercados se borran, y los números de línea no se mueven', () => {
  it('lo de dentro del bloque desaparece y lo de fuera se queda en su renglón', () => {
    const lines = withoutFencedBlocks(
      ['antes `src/vive.ts`', '```bash', 'npx tsx src/dentro.ts', '```', 'después `src/otro.ts`'].join('\n')
    );
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('');
    // El renglón 5 sigue siendo el renglón 5: un ejemplo que manda a la línea
    // equivocada es peor que no dar ejemplo.
    expect(lines[4]).toContain('src/otro.ts');
  });

  it('un cercado de tildes no lo cierra uno de acentos graves', () => {
    const lines = withoutFencedBlocks(['~~~', '`src/dentro.ts`', '```', '`src/tambien-dentro.ts`', '~~~'].join('\n'));
    expect(lines.every((l) => !l.includes('src/'))).toBe(true);
  });
});

describe('el lector de comentarios distingue comentario de cadena', () => {
  it('la línea, el bloque y lo que no es ninguno de los dos', () => {
    const c = commentsByLine(['// uno', 'const x = 1;', '/* dos', '   tres */'].join('\n'));
    expect(c[0].trim()).toBe('uno');
    expect(c[1]).toBe('');
    expect(c[2].trim()).toBe('dos');
    expect(c[3].trim()).toBe('tres');
  });

  it('el `//` de dentro de una cadena no abre un comentario', () => {
    const c = commentsByLine("const u = 'https://ejemplo.mx/ruta'; // el de verdad");
    expect(c[0].trim()).toBe('el de verdad');
    expect(c[0]).not.toContain('ejemplo.mx');
  });

  it('la comilla huérfana de una expresión regular no se come el archivo', () => {
    // ÉSTE ES EL DEFECTO MEDIDO. `/['"]/` abre una comilla simple que nunca
    // cierra; sin el remedio del salto de línea el lector se quedaba en modo
    // cadena hasta el final del archivo. Costaba 666 líneas en src/, 307 de
    // ellas en src/cli/mnemosine.ts sola.
    const c = commentsByLine(["const re = /['\"]/;", '// este comentario sobrevive', '// y este también'].join('\n'));
    expect(c[1].trim()).toBe('este comentario sobrevive');
    expect(c[2].trim()).toBe('y este también');
  });

  it('la plantilla sí cruza el salto de línea, y lo de dentro no es comentario', () => {
    const c = commentsByLine(['const t = `linea uno', '// esto va dentro de la plantilla', 'fin`;', '// este sí es comentario'].join('\n'));
    expect(c[1]).toBe('');
    expect(c[3].trim()).toBe('este sí es comentario');
  });
});

describe('una línea de comentario en español se reconoce sin mirar los acentos', () => {
  it('el español sin acentos cuenta igual que con ellos', () => {
    expect(isSpanishComment('El saldo inicial de la cuenta')).toBe(true);
    expect(isSpanishComment('La comision del periodo ya esta devengada')).toBe(true);
    expect(isSpanishComment('La comisión del período ya está devengada')).toBe(true);
  });

  it('el inglés no cuenta, y la decoración tampoco', () => {
    expect(isSpanishComment('Standard cron: dom and dow OR together when BOTH are restricted.')).toBe(false);
    expect(isSpanishComment('============================================================')).toBe(false);
    expect(isSpanishComment('*')).toBe(false);
  });

  it('la línea a medio traducir cuenta, que es justo la que hay que reescribir', () => {
    expect(isSpanishComment('Medical expenses for pensioners (gastos medicos pensionados)')).toBe(true);
  });
});

describe('la proporción española de una página', () => {
  const ENGLISH =
    'This document describes how the command tree binds its dictionaries and which section wins ' +
    'when two of them disagree about a flag, a verb or an output contract for the shipping repository.';
  const SPANISH =
    'Este documento describe cómo el árbol de comandos fija sus diccionarios y qué sección gana ' +
    'cuando dos de ellas discrepan sobre una bandera, un verbo o un contrato de salida del repositorio.';

  it('separa la prosa inglesa de la española con holgura', () => {
    const english = spanishRatio(ENGLISH);
    const spanish = spanishRatio(SPANISH);
    expect(english).not.toBeNull();
    expect(spanish).not.toBeNull();
    expect(english as number).toBeLessThan(0.2);
    expect(spanish as number).toBeGreaterThan(0.2);
  });

  it('una página demasiado corta no se juzga', () => {
    // Menos de veinte palabras clasificables no son prosa: son un título. Y
    // acusar a un título de estar en el idioma equivocado es ruido.
    expect(spanishRatio('# Title')).toBeNull();
    expect(spanishRatio('')).toBeNull();
  });
});

describe('el sha de la gemela es el mismo que calcula git', () => {
  it('coincide con `git hash-object` en los vectores conocidos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-'));
    try {
      const empty = path.join(dir, 'vacio.txt');
      const hello = path.join(dir, 'hola.txt');
      fs.writeFileSync(empty, '');
      fs.writeFileSync(hello, 'hello\n');
      expect(blobSha(empty)).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
      expect(blobSha(hello)).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el `source_sha` se lee escrito de cualquiera de las formas en que puede venir', () => {
    // El PR que trae el rector no está fusionado, así que el lector es
    // tolerante en la forma y estricto en el contenido.
    expect(declaredSha('---\nsource_sha: 4c0f8db1a9622688cca6c12ff7c5bcfae8478e5e\n---\n')).toBe(
      '4c0f8db1a9622688cca6c12ff7c5bcfae8478e5e'
    );
    expect(declaredSha('<!-- source_sha: 4c0f8db -->')).toBe('4c0f8db');
    expect(declaredSha('**source_sha** = "4C0F8DB1A96"')).toBe('4c0f8db1a96');
    expect(declaredSha('# Rector\n\nsin declaración ninguna')).toBeNull();
    // Seis caracteres no son un sha: un prefijo así casa con demasiadas cosas.
    expect(declaredSha('source_sha: 4c0f8d')).toBeNull();
  });
});

// ============================================================
// EL ÁRBOL DE JUGUETE
//
// Los cuatro carriles, contando sobre un repositorio de diez archivos donde SÍ
// existe el esquema de gemelas. Es la única forma de ver a los carriles 3 y 4
// pasar de cero, porque el árbol real no tiene ni una `.es.md`.
// ============================================================

const LONG_ENGLISH =
  'This page explains how the ledger closes a period and which checks must pass before the books ' +
  'are locked for good, including the trial balance, the pending documents and the approval trail.';

describe('los cuatro carriles sobre un árbol de juguete', () => {
  let root = '';

  const write = (relative: string, content: string): void => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const laneValue = (id: string): number => {
    const lane = lanesFor(root).find((c) => c.id === id);
    if (lane === undefined) throw new Error(`no hay carril ${id}`);
    return lane.value;
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'carriles-'));

    write(
      'src/a.ts',
      [
        '// El saldo inicial de la cuenta.',
        'const uno = 1;',
        '/* La comision del periodo. */',
        "const u = 'https://ejemplo.mx/x'; // Plain English trailing note.",
        'export { uno, u };',
      ].join('\n')
    );
    write('tests/existe.spec.ts', 'export const nada = 0;\n');

    write(
      'docs/vive.md',
      [
        '# Documento vivo en castellano',
        '',
        'Este documento cita `src/a.ts`, que existe, y `src/fantasma.ts`, que no.',
        'También enlaza a [la prueba](tests/existe.spec.ts) y a [lo que ya no está](fantasma/x.md).',
        'El enlace a [GitHub](https://github.com/x/y/blob/main/src/otro.ts) no cuenta,',
        'y `src/docs/tests` es prosa con barras, no una ruta del árbol.',
        '',
        '```bash',
        'npx tsx src/dentro-del-bloque.ts',
        '```',
      ].join('\n')
    );
    // Una página inglesa CON gemela: no le falta nada.
    write('docs/rector.md', `# Rector\n\n${LONG_ENGLISH}\n`);
    write(
      'docs/rector.es.md',
      `---\nsource_sha: ${blobSha(path.join(root, 'docs/rector.md'))}\n---\n\n# Rector\n\nLa página del rector en castellano.\n`
    );
    // Una página inglesa SIN gemela: ésa es la deuda del carril 3.
    write('docs/solo.md', `# Alone\n\n${LONG_ENGLISH}\n`);
  });

  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });

  it('cuenta las citas muertas y deja fuera las vivas, las URL y los bloques', () => {
    // Muertas: `src/fantasma.ts` en prosa y `](fantasma/x.md)` resuelto contra
    // docs/. Vivas: src/a.ts y tests/existe.spec.ts. Fuera: la URL de GitHub,
    // la enumeración `src/docs/tests` y lo de dentro del bloque cercado.
    const lane = lanesFor(root).find((c) => c.id === 'docs-dead-path-citations');
    expect(lane?.value).toBe(2);
    expect(linesFor('docs-dead-path-citations', root).map((r) => r.split('\t')[0])).toEqual([
      'docs/fantasma/x.md',
      'src/fantasma.ts',
    ]);
    expect(lane?.perFile).toEqual({ 'docs/vive.md': 2 });
  });

  it('cuenta las líneas de comentario en español y no las inglesas', () => {
    const lane = lanesFor(root).find((c) => c.id === 'src-spanish-comment-lines');
    expect(lane?.value).toBe(2);
    expect(lane?.informational).toBe(true);
    expect(lane?.perFile).toEqual({ 'src/a.ts': 2 });
  });

  it('la página inglesa sin gemela cuenta; la que la tiene, no', () => {
    const lane = lanesFor(root).find((c) => c.id === 'docs-english-pages-untwinned');
    expect(lane?.value).toBe(1);
    expect(lane?.examples).toEqual(['docs/solo.md']);
  });

  it('la gemela fresca no cuenta, y deja de estar fresca en cuanto el original cambia', () => {
    expect(laneValue('docs-spanish-twins-stale')).toBe(0);
    fs.appendFileSync(path.join(root, 'docs/rector.md'), '\nOne more paragraph nobody translated.\n');
    expect(laneValue('docs-spanish-twins-stale')).toBe(1);
    expect(linesFor('docs-spanish-twins-stale', root)[0]).toContain('ya no casa');
  });

  it('la gemela sin `source_sha` y la gemela huérfana cuentan igual', () => {
    // No poder comprobar la frescura no es un estado neutro: es el mismo
    // defecto con otra cara, y si no contara, bastaría borrar la línea del sha
    // para poner el carril en verde.
    write('docs/sinsha.md', '# Sin sha\n\nUna página cualquiera en castellano con su gemela.\n');
    write('docs/sinsha.es.md', '# Sin sha\n\nLa gemela que no declara de qué original viene.\n');
    write('docs/huerfana.es.md', '---\nsource_sha: 4c0f8db\n---\n\nLa gemela de un original borrado.\n');
    const reasons = linesFor('docs-spanish-twins-stale', root).join('\n');
    expect(laneValue('docs-spanish-twins-stale')).toBe(3);
    expect(reasons).toContain('no declara source_sha');
    expect(reasons).toContain('ya no existe');
  });

  it('el `command` de las gemelas, EJECUTADO, da el mismo número que el carril', () => {
    // ÉSTA ES LA PRUEBA QUE FALTABA, y la falta tiene nombre: sobre el árbol
    // real hay CERO gemelas, así que el carril vale 0 y cualquier comando
    // —incluso uno que no lista nada— «coincide». La prueba hermana de más
    // abajo compara el valor con `linesFor`, que es el propio módulo
    // hablando consigo mismo; el campo `command` promete otra cosa: que un
    // humano con una terminal llegue al mismo número SIN el metro. Eso sólo se
    // puede comprobar donde el número no es cero, y aquí lo es.
    //
    // Con la primera versión del comando este caso daba 0 contra 3: el
    // pathspec `docs/**/*.es.md` no veía las gemelas de primer nivel y una
    // gemela sin `source_sha` casaba con el patrón vacío. Las tres razones
    // están escritas en `docs.ts`, junto al comando.
    const lane = lanesFor(root).find((c) => c.id === 'docs-spanish-twins-stale');
    const output = execSync(lane!.command, { cwd: root, encoding: 'utf8', shell: '/bin/bash' });
    expect(Number(output.trim())).toBe(lane!.value);
  });

  it('la cita muerta que escriben dos documentos cuenta DOS, y cada uno paga la suya', () => {
    // El descuadre que este tramo cerró, reproducido en pequeño: con la ruta
    // como unidad esto valía 1 y el desglose decía 2, y arreglar uno de los dos
    // documentos no movía el total. Ahora la unidad es la cita: dos columnas,
    // dos de total, y cada documento puede cerrar la suya.
    write('docs/otro.md', 'Este documento también cita `src/fantasma.ts`, que sigue sin existir.\n');
    const lane = lanesFor(root).find((c) => c.id === 'docs-dead-path-citations');
    const forGhost = linesFor('docs-dead-path-citations', root).filter((r) =>
      r.startsWith('src/fantasma.ts\t')
    );
    expect(forGhost).toHaveLength(2);
    expect(lane?.perFile?.['docs/otro.md']).toBe(1);
    expect(Object.values(lane?.perFile ?? {}).reduce((a, b) => a + b, 0)).toBe(lane?.value);
    fs.rmSync(path.join(root, 'docs/otro.md'));
  });
});

// ============================================================
// EL CERO QUE PARECE UNA VICTORIA
//
// Los cuatro carriles tienen meta cero, así que un recorrido que no encuentra
// lo que mide publica la victoria. Estos tres casos son las tres formas de que
// eso pase —medidas, no imaginadas: sin `docs/` el módulo daba 0-0-0 con la
// salida limpia— y lo que exigen no es un mensaje bonito, es que el metro se
// niegue a dar una cifra que no ha medido.
// ============================================================

describe('un carril que no encuentra lo que mide revienta en vez de dar cero', () => {
  let root = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-arbol-'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/x.md'), '# Nada que citar\n');
    fs.writeFileSync(path.join(root, 'src/x.ts'), 'export const nada = 0;\n');
  });

  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });

  it('con el árbol entero, los cuatro carriles miden y dan cero de verdad', () => {
    // La contraprueba: el cero legítimo —hay docs/ y hay src/, y no hay deuda—
    // tiene que seguir siendo un cero, o la guarda estaría prohibiendo ganar.
    expect(lanesFor(root).map((lane) => lane.value)).toEqual([0, 0, 0, 0]);
  });

  it('sin docs/, el carril de citas dice qué falta en vez de publicar cero', () => {
    const withoutDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-docs-'));
    fs.mkdirSync(path.join(withoutDocs, 'src'));
    try {
      expect(() => lanesFor(withoutDocs)).toThrow(/no existe .*docs/);
      expect(() => lanesFor(withoutDocs)).toThrow(/carril de citas muertas/);
    } finally {
      fs.rmSync(withoutDocs, { recursive: true, force: true });
    }
  });

  it('sin src/, el carril de comentarios dice qué falta en vez de publicar cero', () => {
    const withoutSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-src-'));
    fs.mkdirSync(path.join(withoutSrc, 'docs'));
    try {
      expect(() => lanesFor(withoutSrc)).toThrow(/no existe .*src/);
      expect(() => lanesFor(withoutSrc)).toThrow(/carril de comentarios/);
    } finally {
      fs.rmSync(withoutSrc, { recursive: true, force: true });
    }
  });

  it('sin raíz no hay ancla, y sin ancla el carril tampoco se calla', () => {
    // Una raíz mal resuelta —el módulo copiado a otra carpeta, un checkout
    // parcial— es el caso que más se parece a «ya no hay deuda».
    expect(() => lanesFor(path.join(os.tmpdir(), 'raiz-que-no-existe-jamas'))).toThrow(/no existe/);
  });
});

// ============================================================
// EL ÁRBOL REAL
//
// Lo de arriba prueba las reglas; esto prueba que las reglas se cumplen donde
// se van a usar. Ninguna aserción de aquí fija una CIFRA: las cifras las fija
// la línea base del orquestador, y clavarlas también aquí obligaría a tocar dos
// archivos por cada arreglo, que es como se consigue que nadie apriete nada.
// ============================================================

describe('el contrato de los carriles sobre el árbol real', () => {
  const lanes = docsLanes();

  it('son cuatro, con identidad estable y sin repetirse', () => {
    // El `id` es la llave de la línea base: cambiarlo pierde la serie entera y
    // el trinquete vuelve a empezar de cero sin que nadie se entere.
    expect(lanes.map((c) => c.id)).toEqual([
      'docs-dead-path-citations',
      'src-spanish-comment-lines',
      'docs-english-pages-untwinned',
      'docs-spanish-twins-stale',
    ]);
    expect(new Set(lanes.map((c) => c.id)).size).toBe(4);
  });

  it('cada carril trae lo que hace falta para discutirlo', () => {
    for (const c of lanes) {
      expect(c.target).toBe(0);
      expect(c.title).not.toBe('');
      // Tres carriles se reproducen corriendo el módulo y contando su lista; el
      // de las gemelas tiene comando de verdad, porque git calcula el mismo sha.
      expect(c.command).toMatch(/docs\.ts|git hash-object/);
      expect(c.value).toBeGreaterThanOrEqual(0);
      // Un número sin ejemplos manda a buscar a mano, y entonces nadie lo usa.
      expect(c.examples ?? []).toHaveLength(Math.min(c.value, 8));
    }
  });

  it('sólo el de los comentarios es informativo', () => {
    // Mezclar lo que se observa con lo que se exige apagaría el trinquete: el
    // de comentarios no se exige hasta I20 y los otros tres sí.
    expect(lanes.filter((c) => c.informational === true).map((c) => c.id)).toEqual(['src-spanish-comment-lines']);
  });

  it('el desglose por archivo apunta a archivos que existen', () => {
    for (const c of lanes) {
      for (const file of Object.keys(c.perFile ?? {})) {
        expect(fs.existsSync(path.join(ROOT, file)), `${c.id}: ${file}`).toBe(true);
      }
    }
  });

  it('el desglose de los cuatro suma EXACTAMENTE el total', () => {
    // Aquí vivía la excepción: el carril de citas sumaba «al menos», y esta
    // prueba la daba por buena. Sumaba 218 columnas bajo un total de 196
    // porque contaba rutas arriba y reparaciones abajo, y la línea base guarda
    // los dos números: el trinquete se habría sembrado con dos verdades sobre
    // el mismo hecho. Ahora la unidad es la cita en los dos sitios y la
    // igualdad es estricta, aquí y en tests/language/lanes-contract.spec.ts,
    // que la exige sobre los dieciséis carriles del metro.
    for (const lane of lanes) {
      const sum = Object.values(lane.perFile ?? {}).reduce((a, b) => a + b, 0);
      expect(sum, `${lane.id}: el desglose no suma el total`).toBe(lane.value);
    }
  });

  it('el mismo árbol da el mismo número dos veces seguidas', () => {
    // `fs.readdirSync` no promete orden. Sin el `sort` del recorrido, esta
    // prueba pasa en un sistema de archivos y falla en otro.
    expect(JSON.stringify(docsLanes())).toBe(JSON.stringify(lanes));
  });

  it('el comando publicado devuelve exactamente el número publicado', () => {
    // `command` no es decorativo: es lo que alguien va a teclear cuando la
    // cifra le parezca rara.
    for (const c of lanes) {
      expect(linesFor(c.id)).toHaveLength(c.value);
    }
  });
});

describe('lo que el árbol real enseña, y lo que NO debe volver a contarse', () => {
  const dead = linesFor('docs-dead-path-citations').map((r) => r.split('\t')[0]);

  it('caza las citas muertas de verdad', () => {
    // docs/auditorias/2026-08-31-integral/disposicion-plan-cierre.md dice, con
    // todas las letras, «`scripts/e2e-arap.ts` ya no existe». La documentación
    // sabe que el archivo se fue y lo sigue citando: eso es el carril.
    expect(dead).toContain('scripts/e2e-arap.ts');
  });

  it('no cuenta las tres cosas que estuvieron contadas de más', () => {
    expect(dead).not.toContain('src/tests/scripts');
    expect(dead).not.toContain('docs/auditoria-integral-ii');
    expect(dead).not.toContain('tests/integration/s3-');
  });

  it('no cuenta ninguna ruta que sí exista', () => {
    for (const m of dead) expect(fs.existsSync(path.join(ROOT, m)), m).toBe(false);
  });

  it('la página inglesa del árbol se reconoce y las españolas no', () => {
    const english = linesFor('docs-english-pages-untwinned');
    // docs/harness-best-practices.md está escrita entera en inglés (proporción
    // española 0,008) y no tiene gemela.
    expect(english).toContain('docs/harness-best-practices.md');
    // Y ninguna de las 145 páginas en castellano se cuela: la que más se acerca
    // al umbral está en 0,385, casi el doble del 0,20 que lo fija.
    expect(english).not.toContain('docs/SCOPE.md');
    expect(english).not.toContain('docs/plan-cierre-brechas.md');
    expect(english).not.toContain('docs/investigacion/2026-09-06-normas-y-motores/practicas/conectores.md');
  });

  it('las líneas de comentario que cuenta son de comentario y son españolas', () => {
    const rows = linesFor('src-spanish-comment-lines');
    expect(rows.length).toBeGreaterThan(1000);
    for (const r of rows.slice(0, 200)) {
      const [where, text] = r.split('\t');
      expect(where).toMatch(/^src\/.+\.ts:\d+$/);
      expect(isSpanishComment(text)).toBe(true);
    }
  });
});
