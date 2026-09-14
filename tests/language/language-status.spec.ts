import { describe, it, expect } from 'vitest';
import { compare, tighten, writeBlock } from '../../scripts/language-status.js';
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
