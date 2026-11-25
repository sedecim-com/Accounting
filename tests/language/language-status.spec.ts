import { describe, it, expect } from 'vitest';
import { block, compare, seed, staleBlocks, tighten, writeBlock } from '../../scripts/language-status.js';
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
    const h = compare([withRule], baselineOf({ a: 12 }, { a: { bank: 4 } }));
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
