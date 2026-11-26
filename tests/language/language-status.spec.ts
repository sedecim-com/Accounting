import { describe, it, expect } from 'vitest';
import { block, compare, seed, staleBlocks, tighten, writeBlock } from '../../scripts/language-status.js';
import { declaredSha, sourceSha } from '../../scripts/language/lanes/docs.js';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';

// ============================================================
// LA MAQUINARIA DEL TRINQUETE (I2 · issue #144)
//
// Los carriles tienen sus propias pruebas: cuentan bien o no. Esto prueba lo
// OTRO, que es donde un trinquete se rompe sin que se note — cómo compara
// contra la línea base y cómo la aprieta.
//
// Se prueba sobre carriles SINTÉTICOS y no sobre el árbol real a propósito:
// una prueba que dependa de las cifras de hoy se pone roja cada vez que
// alguien traduce un archivo, y a la tercera vez se borra.
// ============================================================

const lane = (id: string, value: number, perFile?: Record<string, number>): Lane => ({
  id,
  title: id,
  value,
  target: 0,
  command: `echo ${id}`,
  ...(perFile ? { perFile } : {}),
});

const baselineOf = (lanes: Record<string, number>, perFile: Record<string, Record<string, number>> = {}) => ({
  _: '',
  _por_que: '',
  seeded: '2026-01-01',
  lanes,
  perFile,
});

describe('comparar — qué cuenta como retroceso', () => {
  it('un carril que crece se acusa, y uno que baja no', () => {
    const h = compare([lane('a', 11), lane('b', 4)], baselineOf({ a: 10, b: 9 }));
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('a');
    expect(h[0].detail).toContain('10 → 11');
  });

  it('un carril igual a su línea base NO es retroceso', () => {
    // Si el empate contara, el trinquete exigiría bajar en cada PR y sería
    // imposible tocar nada sin pagar deuda ajena.
    expect(compare([lane('a', 10)], baselineOf({ a: 10 }))).toEqual([]);
  });

  it('UN CARRIL INFORMATIVO QUE CRECE NO FALLA; UNO EXIGIDO SÍ', () => {
    // WIT-01 de la revisión de I2. El contrato de `Lane` dice que un carril
    // `informational` se MIDE y no se EXIGE —los comentarios españoles no se
    // tocan hasta I20— pero la comparación los trataba igual que a los demás.
    // Como también están sembrados en la línea base, el primer commit que
    // añadiera un comentario en español ponía `--check` en rojo y bloqueaba
    // CI años antes de que ese tramo existiera.
    //
    // Lo que hace caro el defecto no es el rojo: es que el carril NO SE PUEDE
    // BAJAR HOY. Una puerta que nadie puede abrir se acaba quitando, y con
    // ella se van los quince carriles que sí exigen algo.
    const informationalLane: Lane = { ...lane('comentarios', 500), informational: true };
    const requiredLane = lane('identificadores', 500);
    const floor = baselineOf({ comentarios: 400, identificadores: 400 });

    // Los dos crecen EXACTAMENTE lo mismo, 400 → 500, y se comparan en la
    // misma llamada: así lo único que puede explicar la diferencia es la
    // bandera. Un solo hallazgo, y es el del carril exigido.
    const h = compare([informationalLane, requiredLane], floor);
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('identificadores');
    expect(h[0].detail).toContain('400 → 500');
  });

  it('un carril informativo tampoco arrastra su desglose por archivo', () => {
    // La otra puerta del mismo carril: si el total no juzga pero el desglose
    // sí, la exención sería sólo aparente y el primer archivo con un comentario
    // nuevo volvería a poner CI en rojo.
    const informationalLane: Lane = {
      ...lane('comentarios', 500, { 'x.ts': 300, 'nuevo.ts': 200 }),
      informational: true,
    };
    expect(compare([informationalLane], baselineOf({ comentarios: 400 }, { comentarios: { 'x.ts': 100 } }))).toEqual([]);
  });

  it('UN ARCHIVO QUE EMPEORA SE ACUSA AUNQUE EL TOTAL NO CREZCA', () => {
    // Es la razón de ser del desglose. Con sólo el total, traducir un archivo
    // y ensuciar otro sale gratis, y el carril se queda quieto mientras la
    // deuda se mueve de sitio.
    const h = compare(
      [lane('a', 10, { 'x.ts': 8, 'y.ts': 2 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 4, 'y.ts': 6 } })
    );
    expect(h).toHaveLength(1);
    expect(h[0].detail).toContain('x.ts: creció 4 → 8');
  });

  it('LA DEUDA NO SE ESCAPA A UN ARCHIVO NUEVO: sin entrada, el floor es cero', () => {
    // El agujero que encontró la revisión de I2 (WIT-01). El desglose sólo
    // auditaba archivos que YA tenían entrada, así que la deuda tenía una
    // salida: sacar una unidad de un archivo vigilado y meterla en uno que
    // nadie vigila. El total del carril no se mueve —10 sigue siendo 10— y
    // el desglose no dice nada, que es exactamente el desplazamiento que el
    // desglose existe para impedir.
    //
    // Con el floor cero implícito, el archivo nuevo tiene que justificarse.
    const h = compare(
      [lane('a', 10, { 'x.ts': 9, 'nuevo.ts': 1 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 10 } })
    );
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('a');
    expect(h[0].detail).toContain('nuevo.ts');
    expect(h[0].detail).toContain('0 → 1');
    // Y que haya hallazgo es que `--check` sale con 1: ese es su único
    // criterio (`findings.length === 0`), no hay otra puerta.
    expect(h.length).toBeGreaterThan(0);
  });

  it('a lane whose unit is not a file names its own rule on a new or grown entry (#314)', () => {
    const rule = 'register it by key';
    const withRule: Lane = { ...lane('a', 12, { bank: 5, employee: 7 }), perEntryRule: rule };
    // `gone` reached zero: the summed ceiling stays 12, so only the entries speak.
    const h = compare([withRule], baselineOf({}, { a: { bank: 4, gone: 8 } }));
    expect(h.map((f) => f.detail)).toEqual([
      'bank: creció 4 → 5; register it by key',
      'employee: 0 → 7 — sin entrada en la línea base; register it by key',
    ]);
    // Without a rule the file wording stays, so the other lanes read as before.
    const plain = compare([lane('a', 1, { 'x.ts': 1 })], baselineOf({ a: 1 }));
    expect(plain[0].detail).toContain('un archivo nuevo no nace con deuda');
  });

  it('un archivo que DESAPARECE del desglose no es hallazgo: desaparecer es llegar a cero', () => {
    // La otra cara de la misma regla. El desglose sólo lista archivos con
    // deuda; si `y.ts` se traduce entero, deja la lista. Acusarlo convertiría
    // cada traducción terminada en un rojo, y el trinquete se borraría.
    const h = compare(
      [lane('a', 4, { 'x.ts': 4 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 4, 'y.ts': 6 } })
    );
    expect(h).toEqual([]);
  });

  it('UNA ENTRADA MUERTA SE ACUSA: el trinquete no puede cuidar lo que ya no se mide', () => {
    // El fallo silencioso: se borra un carril, su entrada se queda, y la línea
    // base protege algo que no existe. Se ve verde para siempre.
    const h = compare([lane('a', 1)], baselineOf({ a: 1, fantasma: 7 }));
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('fantasma');
    expect(h[0].detail).toContain('ya no se mide');
  });

  it('un carril nuevo sin línea base se nombra, no se ignora', () => {
    const h = compare([lane('nuevo', 3)], baselineOf({}));
    expect(h[0].detail).toContain('siémbralo');
  });
});

describe('apretar — sólo baja', () => {
  it('baja lo que tiene holgura', () => {
    const b = tighten([lane('a', 4)], baselineOf({ a: 10 }));
    expect(b.lanes.a).toBe(4);
  });

  it('NO SUBE, y ésta es la prueba que hace del archivo un trinquete', () => {
    // Si `--apretar` subiera, bastaría con correrlo tras una regresión para
    // que el retroceso quedara bendecido y sin rastro en el diff. Subir tiene
    // que costar una edición a mano que alguien pueda ver en la revisión.
    const b = tighten([lane('a', 99)], baselineOf({ a: 10 }));
    expect(b.lanes.a).toBe(10);
  });

  it('el desglose también baja y también se niega a subir', () => {
    const b = tighten(
      [lane('a', 10, { 'x.ts': 1, 'y.ts': 50 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 9, 'y.ts': 9 } })
    );
    expect(b.perFile.a['x.ts']).toBe(1);
    expect(b.perFile.a['y.ts']).toBe(9);
  });

  it('un carril que desapareció sale de la línea base en vez de quedarse de adorno', () => {
    const b = tighten([lane('a', 1)], baselineOf({ a: 1, fantasma: 7 }));
    expect(Object.keys(b.lanes)).toEqual(['a']);
  });
});

// ============================================================
// A CLOSED LANE HAS NO BASELINE (MNE-001-405, #314)
//
// A lane that reached its target is held there by its own declaration, not by
// a number in docs/language-baseline.json: raising that number is the manual
// act the ratchet allows, and it would let the debt back in with --check green.
// ============================================================
describe('a closed lane: --check demands its target, with no baseline', () => {
  const closed = (value: number, perFile?: Record<string, number>): Lane => ({
    ...lane('help', value, perFile),
    closed: true,
    perEntryRule: 'register it by key',
  });

  it('above its target it is refused, whatever the baseline says', () => {
    // The reproduction: a hand-raised baseline used to excuse it.
    const h = compare([closed(1, { bank: 1 })], baselineOf({}));
    expect(h.map((f) => f.detail)).toEqual([
      'closed at 0, measures 1',
      'bank: 0 → 1 — closed lane; register it by key',
    ]);
    expect(compare([lane('help', 1, { bank: 1 })], baselineOf({ help: 5 }, { help: { bank: 3 } }))).toEqual([]);
    expect(compare([closed(1, { bank: 1 })], baselineOf({ help: 5 }, { help: { bank: 3 } })).length).toBeGreaterThan(0);
  });

  it('at its target with no baseline entry it passes, and is not «a new lane to seed»', () => {
    expect(compare([closed(0)], baselineOf({}))).toEqual([]);
  });

  it('a baseline entry for it is a finding: it would be a ceiling a hand edit can raise', () => {
    expect(compare([closed(0)], baselineOf({ help: 0 })).map((f) => f.detail)).toEqual([
      'a closed lane has no baseline: remove its entry from docs/language-baseline.json',
    ]);
    expect(compare([closed(0)], baselineOf({}, { help: { bank: 0 } }))).toHaveLength(1);
  });

  it('--tighten and --seed never write it, and --tighten drops a leftover entry', () => {
    const b = tighten([closed(0), lane('a', 1)], baselineOf({ help: 0, a: 2 }, { help: { bank: 1 } }));
    expect(b.lanes).toEqual({ a: 1 });
    expect(b.perFile).toEqual({});
    const s = seed([closed(0, { bank: 0 }), lane('a', 1)], '2026-01-01');
    expect(Object.keys(s.lanes)).toEqual(['a']);
    expect(s.perFile).toEqual({});
  });

  it('the block shows its target as the ceiling, marked closed', () => {
    const text = block([closed(0), lane('a', 1)], baselineOf({ a: 1 }));
    expect(text).toContain('| `help` | help *(closed)* | 0 | 0 |');
    expect(text).toContain('A *(closed)* lane has no baseline');
    expect(block([lane('a', 1)], baselineOf({ a: 1 }))).not.toContain('closed');
  });
});

// ============================================================
// PUBLICAR EL BLOQUE, Y ACUSAR CUANDO NO SE PUDO (WIT-02 de #179)
//
// El medidor promete publicar su cifra en el rector inglés y en su gemela
// española (#144). La versión revisada escribía en UNA página y, si faltaba el
// archivo o sus marcadores, imprimía un aviso y SALÍA CON CERO — un comando que
// promete publicar y termina bien sin publicar deja el bloque con las cifras
// del mes pasado y nadie se entera.
// ============================================================
describe('publicar el bloque en el rector y su gemela', () => {
  const withTempDocs = (contents: (string | null)[], run: (paths: string[]) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-block-'));
    const paths = contents.map((c, i) => {
      const p = path.join(dir, `doc${i}.md`);
      if (c !== null) fs.writeFileSync(p, c);
      return p;
    });
    try {
      run(paths);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const OPEN = '<!-- LANGUAGE-STATUS:START -->';
  const CLOSE = '<!-- LANGUAGE-STATUS:END -->';
  const withMarkers = `# Rector\n\nantes\n${OPEN}\nviejo\n${CLOSE}\ndespués\n`;

  it('reemplaza el bloque entre marcadores y NO toca el resto de la página', () => {
    withTempDocs([withMarkers], ([p]) => {
      const failures = writeBlock(`${OPEN}\nnuevo\n${CLOSE}`, [p]);
      expect(failures).toEqual([]);
      const out = fs.readFileSync(p, 'utf8');
      expect(out).toContain('nuevo');
      expect(out).not.toContain('viejo');
      // Lo de fuera del bloque sobrevive: el documento decide qué dice, el
      // comando sólo mantiene su recuadro al día.
      expect(out).toContain('# Rector');
      expect(out).toContain('antes');
      expect(out).toContain('después');
    });
  });

  it('publica en LAS DOS páginas, no en una', () => {
    // Publicar sólo en el rector deja la gemela con cifras viejas y sin ninguna
    // señal de que lo son, que es peor que no publicar.
    withTempDocs([withMarkers, withMarkers], (ps) => {
      expect(writeBlock(`${OPEN}\nnuevo\n${CLOSE}`, ps)).toEqual([]);
      for (const p of ps) expect(fs.readFileSync(p, 'utf8')).toContain('nuevo');
    });
  });

  it('UN ARCHIVO QUE NO EXISTE ES UN FALLO, no un aviso', () => {
    withTempDocs([null], ([p]) => {
      const failures = writeBlock(`${OPEN}\nx\n${CLOSE}`, [p]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('no existe');
    });
  });

  it('UN ARCHIVO SIN MARCADORES ES UN FALLO: no se inventa dónde va el bloque', () => {
    withTempDocs(['# Rector\n\nsin recuadro\n'], ([p]) => {
      const failures = writeBlock(`${OPEN}\nx\n${CLOSE}`, [p]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('marcadores');
      // Y no se escribe nada: una página sin sitio declarado se queda como está.
      expect(fs.readFileSync(p, 'utf8')).not.toContain('LANGUAGE-STATUS');
    });
  });

  // THE CHECK SIDE OF THE SAME PROMISE. `staleBlocks` is what `--check` uses
  // to refuse a page that does not publish what the tree measures.
  it('a page that publishes exactly the expected block is not stale', () => {
    withTempDocs([withMarkers, withMarkers], (ps) => {
      const expected = `${OPEN}\nnuevo\n${CLOSE}`;
      writeBlock(expected, ps);
      expect(staleBlocks(expected, ps)).toEqual([]);
    });
  });

  it('A BLOCK THAT WAS NEVER REGENERATED IS STALE — the case --check used to miss', () => {
    // Measured before this existed: the rector's block lacked a whole lane and
    // `--check` was green, because nothing compared the page with the tree.
    withTempDocs([withMarkers], ([p]) => {
      const stale = staleBlocks(`${OPEN}\nnuevo\n${CLOSE}`, [p]);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain('is not the one generated from');
    });
  });

  it('a one-character hand edit inside the block is stale, and only that page is named', () => {
    withTempDocs([withMarkers, withMarkers], ([a, b]) => {
      const expected = `${OPEN}\n| lane | 468 |\n${CLOSE}`;
      writeBlock(expected, [a, b]);
      fs.writeFileSync(b, fs.readFileSync(b, 'utf8').replace('468', '467'));
      const stale = staleBlocks(expected, [a, b]);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain(path.relative(process.cwd(), b).split(path.sep).pop());
    });
  });

  it('text outside the markers does not make a page stale', () => {
    withTempDocs([withMarkers], ([p]) => {
      const expected = `${OPEN}\nnuevo\n${CLOSE}`;
      writeBlock(expected, [p]);
      fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8')}\nun párrafo nuevo del rector\n`);
      expect(staleBlocks(expected, [p])).toEqual([]);
    });
  });

  it('a missing page or missing markers is reported as stale, not skipped', () => {
    withTempDocs([null, '# sin recuadro\n'], ([missing, bare]) => {
      const stale = staleBlocks(`${OPEN}\nx\n${CLOSE}`, [missing, bare]);
      expect(stale).toHaveLength(2);
      expect(stale[0]).toContain('no existe');
      expect(stale[1]).toContain('marcadores');
    });
  });

  it('si una de las dos falla, la otra sí se publica y el fallo se nombra', () => {
    // El caso mixto importa: publicar la mitad y callar la otra es cómo se
    // desincronizan las gemelas sin que nadie lo note.
    withTempDocs([withMarkers, null], (ps) => {
      const failures = writeBlock(`${OPEN}\nnuevo\n${CLOSE}`, ps);
      expect(failures).toHaveLength(1);
      expect(fs.readFileSync(ps[0], 'utf8')).toContain('nuevo');
    });
  });
});

// ============================================================
// THE BLOCK PUBLISHES THE RATCHET'S CEILINGS, NOT THE LIVE COUNTS (#734)
//
// The block used to print each lane's value measured on the tree, so almost
// every code PR rewrote the same line of `docs/language.md` and its twin, and
// each merge put every other open PR in conflict on those two files. It now
// publishes each ratcheted lane's baseline; the live figures stay in the
// command's output. These tests pin that the block is a function of the
// baseline and the lane list, and that the ratchet did not move.
// ============================================================
describe('the published block — ceilings from the baseline, not counts from the tree', () => {
  const observed = (id: string, value: number): Lane => ({ ...lane(id, value), informational: true });
  const base = baselineOf({ identifiers: 10512, filenames: 51, comments: 27780 });
  const tree = (identifiers: number, filenames: number, comments: number): Lane[] => [
    lane('identifiers', identifiers),
    lane('filenames', filenames),
    observed('comments', comments),
  ];

  it('a count that goes down without the baseline changing leaves the block byte for byte the same', () => {
    expect(block(tree(10507, 51, 28754), base)).toBe(block(tree(10512, 51, 27780), base));
    expect(block(tree(3, 0, 0), base)).toBe(block(tree(10512, 51, 27780), base));
    // And the ratchet has nothing to say about a count that went down.
    expect(compare(tree(10507, 51, 28754), base)).toEqual([]);
  });

  it('each ratcheted lane shows its baseline, and no live value appears anywhere', () => {
    const text = block(tree(7001, 49, 31337), base);
    expect(text).toContain('| `identifiers` | identifiers | 10512 | 0 |');
    expect(text).toContain('| `filenames` | filenames | 51 | 0 |');
    for (const live of ['7001', '49', '31337']) expect(text).not.toContain(live);
  });

  it('an informational lane is listed with no figure, not even its seeded one', () => {
    const text = block(tree(10512, 51, 31337), base);
    expect(text).toContain('| `comments` | comments *(informational)* | — | 0 |');
    expect(text).not.toContain('27780');
    expect(text).not.toContain('31337');
  });

  it('the block says it publishes ceilings and where the live figures are read', () => {
    const text = block(tree(1, 1, 1), base);
    expect(text).toContain("publishes the ratchet's ceilings");
    expect(text).toContain('`npm run language:status`');
    expect(text).toContain('| Lane | What it counts | Ceiling | Towards |');
  });

  it('a changed baseline changes the block, so the page is stale until it is regenerated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-ceil-'));
    try {
      const page = path.join(dir, 'page.md');
      fs.writeFileSync(page, `# Page\n\n${block(tree(10507, 51, 1), base)}\n`);
      expect(staleBlocks(block(tree(10507, 51, 1), base), [page])).toEqual([]);

      const lowered = baselineOf({ ...base.lanes, identifiers: 10507 });
      const stale = staleBlocks(block(tree(10507, 51, 1), lowered), [page]);
      expect(stale).toHaveLength(1);

      expect(writeBlock(block(tree(10507, 51, 1), lowered), [page])).toEqual([]);
      expect(staleBlocks(block(tree(10507, 51, 1), lowered), [page])).toEqual([]);
      expect(fs.readFileSync(page, 'utf8')).toContain('| `identifiers` | identifiers | 10507 | 0 |');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lane above its baseline is still named with its value and its baseline, whatever the page says', () => {
    const grown = tree(10513, 51, 1);
    const h = compare(grown, base);
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('identifiers');
    expect(h[0].detail).toContain('10512 → 10513');
    // The page is not what excuses or accuses a regression: it reads the same.
    expect(block(grown, base)).toBe(block(tree(10512, 51, 1), base));
  });

  it('a lane with no baseline entry shows no figure, and the ratchet names it', () => {
    const lanes = [...tree(1, 1, 1), lane('brand-new', 3)];
    expect(block(lanes, base)).toContain('| `brand-new` | brand-new | — | 0 |');
    expect(compare(lanes, base).map((f) => f.lane)).toEqual(['brand-new']);
  });

  // THE MERGE THE ISSUE IS ABOUT, WITH A REAL `git merge`.
  //
  // Two branches leave the same commit. Each lowers a count and does what a
  // builder does before pushing: regenerates the block on both pages with what
  // its own tree measures. One is merged, then the other merges the result.
  // Before #734 both rewrote the same row of both pages with different numbers.
  it('two branches that each lower a count merge with no conflict, and the merged pages need no regeneration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-merge-'));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
    const pages = [path.join(dir, 'language.md'), path.join(dir, 'language.es.md')];
    const publish = (lanes: Lane[]): void => {
      expect(writeBlock(block(lanes, base), pages)).toEqual([]);
    };
    try {
      git('init', '-q', '-b', 'develop');
      const sealed = '0'.repeat(40);
      fs.writeFileSync(pages[0], `# Language\n\n${block(tree(10512, 51, 100), base)}\n\nafter\n`);
      fs.writeFileSync(
        pages[1],
        `# Idioma\n\n> source_sha: ${sealed}\n\n${block(tree(10512, 51, 100), base)}\n\ndespués\n`
      );
      publish(tree(10512, 51, 100));
      fs.writeFileSync(path.join(dir, 'a.ts'), 'const importe = 1;\n');
      fs.writeFileSync(path.join(dir, 'b.ts'), '// un comentario\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const committed = pages.map((p) => fs.readFileSync(p, 'utf8'));

      // Branch one deletes a Spanish identifier: 10512 → 10511.
      git('checkout', '-q', '-b', 'one');
      fs.writeFileSync(path.join(dir, 'a.ts'), 'const amount = 1;\n');
      publish(tree(10511, 51, 100));
      git('add', '-A');
      git('commit', '-q', '-m', 'one');

      // Branch two, from the same commit, lowers the same lane by two and a comment.
      git('checkout', '-q', 'develop');
      git('checkout', '-q', '-b', 'two');
      fs.writeFileSync(path.join(dir, 'b.ts'), '// a comment\n');
      publish(tree(10510, 51, 99));
      git('add', '-A');
      git('commit', '-q', '-m', 'two');

      // `one` lands on develop; `two` merges develop.
      git('checkout', '-q', 'develop');
      git('merge', '-q', '--no-ff', '-m', 'merge one', 'one');
      git('checkout', '-q', 'two');
      const merge = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', 'merge develop', 'develop'],
        { cwd: dir, encoding: 'utf8' }
      );
      expect(merge.status, merge.stdout + merge.stderr).toBe(0);
      expect(git('status', '--porcelain')).toBe('');

      // The merged tree measures both gains; the pages pass the block check as merged.
      expect(staleBlocks(block(tree(10509, 51, 99), base), pages)).toEqual([]);
      expect(compare(tree(10509, 51, 99), base)).toEqual([]);
      // And neither page moved at all, so the twin's seal did not move either.
      expect(pages.map((p) => fs.readFileSync(p, 'utf8'))).toEqual(committed);
      expect(git('log', '--oneline', 'develop~1..two', '--', 'language.md', 'language.es.md')).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// A LANE COUNTED PER FILE STORES NO TOTAL (MNE-001-818, #311)
//
// Measured on the develop merges of 25 and 26 Nov: most merges of develop
// into an open PR conflicted in docs/language*, on three lines every PR
// rewrites: the lane's total in the baseline, its ceiling row in the block,
// and the twin's `source_sha`. GitHub's squash and «Update branch» are a plain
// 3-way merge with no custom driver, so the cure is in what is committed: the
// ceiling of a per-file lane is the sum of its files' floors, the block prints
// no figure that a tighten moves, and the stamp ignores the generated block.
// ============================================================
describe('a lane counted per file: its ceiling is the sum of its floors', () => {
  it('the sum is the ceiling, and a stored total can only lower it', () => {
    const tree = [lane('svc', 6, { 'x.ts': 3, 'y.ts': 3 })];
    expect(compare(tree, baselineOf({}, { svc: { 'x.ts': 3, 'y.ts': 3 } }))).toEqual([]);
    // y.ts grew 2 → 3: the file is named, and so is the total over the summed ceiling, 5.
    expect(compare(tree, baselineOf({}, { svc: { 'x.ts': 3, 'y.ts': 2 } })).map((f) => f.detail)).toEqual([
      'creció: 5 → 6',
      'y.ts: creció 2 → 3',
    ]);
    // A total raised by hand excuses nothing; one lowered by hand still binds.
    expect(compare(tree, baselineOf({ svc: 99 }, { svc: { 'x.ts': 3, 'y.ts': 2 } }))).toHaveLength(2);
    expect(compare(tree, baselineOf({ svc: 5 }, { svc: { 'x.ts': 3, 'y.ts': 3 } })).map((f) => f.detail)).toEqual([
      'creció: 5 → 6',
    ]);
  });

  it('--tighten and --seed keep no total for a lane with a breakdown, and keep it for one without', () => {
    const next = tighten(
      [lane('svc', 4, { 'x.ts': 1, 'y.ts': 3 }), lane('cli', 0)],
      baselineOf({ svc: 6, cli: 0 }, { svc: { 'x.ts': 3, 'y.ts': 3 } })
    );
    expect(next.lanes).toEqual({ cli: 0 });
    expect(next.perFile).toEqual({ svc: { 'x.ts': 1, 'y.ts': 3 } });
    // The last file reaches zero: the breakdown leaves and the lane keeps a 0, which never moves.
    expect(tighten([lane('svc', 0, {})], next).lanes).toEqual({ svc: 0 });
    const s = seed([lane('svc', 4, { 'x.ts': 4 }), lane('cli', 0)], '2026-01-01');
    expect(s.lanes).toEqual({ cli: 0 });
    expect(s.perFile).toEqual({ svc: { 'x.ts': 4 } });
  });

  it('--tighten never raises the summed ceiling: a new file takes only the slack another one freed', () => {
    const base = baselineOf({}, { svc: { 'old.ts': 3, 'y.ts': 2 } });
    // A rename moves the floor with the file.
    expect(tighten([lane('svc', 5, { 'new.ts': 3, 'y.ts': 2 })], base).perFile.svc).toEqual({ 'new.ts': 3, 'y.ts': 2 });
    // New debt with nothing freed gets no floor, so --check stays red after --tighten.
    const grown = [lane('svc', 6, { 'old.ts': 3, 'y.ts': 2, 'z.ts': 1 })];
    const next = tighten(grown, base);
    expect(next.perFile.svc).toEqual({ 'old.ts': 3, 'y.ts': 2 });
    expect(compare(grown, next).map((f) => f.detail)).toContain(
      'z.ts: 0 → 1 — sin entrada en la línea base; un archivo nuevo no nace con deuda'
    );
  });

  it('the block prints «per file» for such a lane, so lowering a file leaves it byte for byte the same', () => {
    const base = baselineOf({ cli: 0 }, { svc: { 'x.ts': 3, 'y.ts': 3 } });
    const published = [lane('svc', 6), lane('cli', 0)];
    const text = block(published, base);
    expect(text).toContain('| `svc` | svc | per file | 0 |');
    expect(text).toContain('| `cli` | cli | 0 | 0 |');
    expect(text).toContain("files' floors");
    const lowered = tighten([lane('svc', 4, { 'x.ts': 1, 'y.ts': 3 }), lane('cli', 0)], base);
    expect(block(published, lowered)).toBe(text);
  });
});

describe('two PRs that lower different files merge with a plain 3-way merge, in either order', () => {
  const FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
  // The tree: each PR translates one Spanish string in its own file.
  const treeOf = (counts: Record<string, number>): Lane[] => [
    { ...lane('svc', Object.values(counts).reduce((s, n) => s + n, 0), counts), title: 'services, per file' },
    lane('cli', 0),
  ];
  const start: Record<string, number> = Object.fromEntries(FILES.map((f) => [f, 4]));
  const stamped = (sha: string): string => `# Idioma\n\n> Gemela · source_sha: ${sha}\n\nPrólogo.\n\n`;

  const repo = (): { dir: string; git: (...a: string[]) => string; merge: (ref: string) => number } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-818-'));
    // No user config and no attributes file: what GitHub runs, with no custom merge driver.
    const flags = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.attributesFile=/dev/null'];
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...a: string[]): string => execFileSync('git', [...flags, ...a], { cwd: dir, encoding: 'utf8', env });
    const merge = (ref: string): number =>
      spawnSync('git', [...flags, 'merge', '--no-ff', '-m', `merge ${ref}`, ref], { cwd: dir, encoding: 'utf8', env }).status ?? -1;
    return { dir, git, merge };
  };

  // What a builder does before pushing: --tighten, then --write.
  const routine = (dir: string, counts: Record<string, number>): void => {
    const file = path.join(dir, 'language-baseline.json');
    const next = tighten(treeOf(counts), JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof baselineOf>);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    expect(writeBlock(block(treeOf(counts), next), [path.join(dir, 'language.md'), path.join(dir, 'language.es.md')])).toEqual([]);
  };

  const setUp = (): ReturnType<typeof repo> => {
    const r = repo();
    r.git('init', '-q', '-b', 'develop');
    const base = seed(treeOf(start), '2026-11-26');
    fs.writeFileSync(path.join(r.dir, 'language-baseline.json'), `${JSON.stringify(base, null, 2)}\n`);
    const md = path.join(r.dir, 'language.md');
    fs.writeFileSync(md, `# Language\n\nProse.\n\n${block(treeOf(start), base)}\n\nAfter.\n`);
    fs.writeFileSync(path.join(r.dir, 'language.es.md'), `${stamped(sourceSha(md))}${block(treeOf(start), base)}\n\nDespués.\n`);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'base');
    // PR one translates a string in src/a.ts, PR two two strings in src/e.ts: the
    // totals differ, as they did in every measured merge, so a stored total conflicts.
    for (const [branch, file, left] of [['one', 'src/a.ts', 3], ['two', 'src/e.ts', 2]] as const) {
      r.git('checkout', '-q', '-b', branch, 'develop');
      routine(r.dir, { ...start, [file]: left });
      r.git('commit', '-q', '-am', branch);
    }
    r.git('checkout', '-q', 'develop');
    return r;
  };

  const merged = { ...start, 'src/a.ts': 3, 'src/e.ts': 2 };
  const checkPasses = (dir: string): void => {
    const base = JSON.parse(fs.readFileSync(path.join(dir, 'language-baseline.json'), 'utf8')) as ReturnType<typeof baselineOf>;
    const pages = [path.join(dir, 'language.md'), path.join(dir, 'language.es.md')];
    expect(compare(treeOf(merged), base)).toEqual([]);
    expect(staleBlocks(block(treeOf(merged), base), pages)).toEqual([]);
    expect(declaredSha(fs.readFileSync(pages[1], 'utf8'))).toBe(sourceSha(pages[0]));
  };

  for (const [first, second] of [['one', 'two'], ['two', 'one']]) {
    it(`${first} lands, ${second} takes develop, then lands: no conflict, and --check holds on the result`, () => {
      const r = setUp();
      try {
        expect(r.merge(first)).toBe(0);
        r.git('checkout', '-q', second);
        expect(r.merge('develop'), r.git('diff', '--name-only', '--diff-filter=U')).toBe(0);
        checkPasses(r.dir);
        r.git('checkout', '-q', 'develop');
        expect(r.merge(second)).toBe(0);
        checkPasses(r.dir);
      } finally {
        fs.rmSync(r.dir, { recursive: true, force: true });
      }
    });
  }

  it('on the merged result a stale block, a stale stamp or a raised file still turn --check red', () => {
    const r = setUp();
    try {
      expect(r.merge('one')).toBe(0);
      expect(r.merge('two')).toBe(0);
      const md = path.join(r.dir, 'language.md');
      const es = path.join(r.dir, 'language.es.md');
      const base = JSON.parse(fs.readFileSync(path.join(r.dir, 'language-baseline.json'), 'utf8')) as ReturnType<typeof baselineOf>;
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('| per file |', '| 21 |'));
      expect(staleBlocks(block(treeOf(merged), base), [md, es])).toHaveLength(1);
      // A hand edit of the block does not move the stamp; a prose edit does.
      expect(declaredSha(fs.readFileSync(es, 'utf8'))).toBe(sourceSha(md));
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('Prose.', 'New prose.'));
      expect(declaredSha(fs.readFileSync(es, 'utf8'))).not.toBe(sourceSha(md));
      expect(compare(treeOf({ ...merged, 'src/c.ts': 5 }), base).map((f) => f.detail)).toContain('src/c.ts: creció 4 → 5');
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('two PRs that lower the SAME file still conflict on that one line: a real conflict stays one', () => {
    const r = setUp();
    try {
      r.git('checkout', '-q', '-b', 'three', 'develop');
      routine(r.dir, { ...start, 'src/a.ts': 2 });
      r.git('commit', '-q', '-am', 'three');
      r.git('checkout', '-q', 'develop');
      expect(r.merge('one')).toBe(0);
      r.git('checkout', '-q', 'three');
      expect(r.merge('develop')).not.toBe(0);
      expect(r.git('diff', '--name-only', '--diff-filter=U').trim()).toBe('language-baseline.json');
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
