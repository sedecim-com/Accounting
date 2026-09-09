import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  clasificarAtraso,
  soloHistoria,
  diasEntre,
  prDe,
  prsNombrados,
  render,
} from '../../scripts/historial-estado.js';
import type { Entrada } from '../../scripts/historial-estado.js';

// ============================================================
// EL HISTORIAL DE ENTREGA YA CADUCÓ UNA VEZ, Y NO POR LO QUE PARECE.
//
// `docs/HISTORY.md` nace de una lección escrita en su propia cabecera: el
// artefacto anterior narraba sprints cuyos hashes NO EXISTEN en `main`. Se
// reconstruyó verificando contra el árbol, quedó bien — y volvió a caducar por
// la única vía que quedaba: nadie lo miró. Medido el 2026-09-08 afirmaba que el
// PR #53 estaba ABIERTO (llevaba un día fusionado) y no nombraba los dieciséis
// siguientes.
//
// Lo que se prueba aquí no es la prosa del documento: es que la lista de PRs
// salga del ÁRBOL y no de que alguien se acuerde de añadir una fila.
// ============================================================

describe('prDe — las dos formas en que un PR entra a `main`', () => {
  it('el squash, que es como entra la mayoría', () => {
    expect(prDe('T1b: la reparación no llegaba a quien la necesitaba (#186)')).toBe(186);
  });

  it('la fusión con commit propio, que es como entró el #53', () => {
    expect(prDe('Merge pull request #53 from sedecim-com/instrumentos-que-mienten')).toBe(53);
  });

  it('un commit directo a `main` no es un error: son los trece de la línea base', () => {
    expect(prDe('Línea base del sistema contable mnemosine')).toBeNull();
    expect(prDe('E0.3: el motor de posteo deja rastro, y el rastro es atómico')).toBeNull();
  });

  it('gana el PR del FINAL, no el que el título menciona de pasada', () => {
    // Caso real, y el que rompería un `#(\d+)` suelto: el #186 se titula por el
    // hallazgo que cierra, que es del #136. Quedarse con el primero registraría
    // el PR equivocado y daría por ausente el que sí entró.
    expect(
      prDe('T1b: la reparación no llegaba a quien la necesitaba, y la 071 no dejaba llegar nada (WIT-01 crítico de #136) (#186)')
    ).toBe(186);
    expect(prDe('T20-6b: la migración que corrige un parámetro fiscal (WIT-01 de #139) (#183)')).toBe(183);
  });

  it('una referencia suelta a mitad de frase NO cuenta como entrada', () => {
    // Si contara, cualquier commit que citara un PR se daría por fusionado y el
    // guardián exigiría filas de PRs que nunca entraron.
    expect(prDe('Revierte lo que el #170 dejó a medias')).toBeNull();
  });
});

describe('prsNombrados — qué considera el guardián que el documento «nombra»', () => {
  const doc = `
| [#53](https://github.com/sedecim-com/Accounting/pull/53) | G0 y G3 |
| [#186](https://github.com/sedecim-com/Accounting/pull/186) | T1b |
Ver también la issue [#127](https://github.com/sedecim-com/Accounting/issues/127).
El PR #999 se menciona aquí sin enlace.
`;

  it('cuenta los PRs enlazados', () => {
    expect(prsNombrados(doc).has(53)).toBe(true);
    expect(prsNombrados(doc).has(186)).toBe(true);
  });

  it('NO confunde una issue con un PR', () => {
    // `/issues/127` y `/pull/127` son cosas distintas y el documento enlaza las
    // dos. Contarlas juntas daría por documentado un PR que no lo está.
    expect(prsNombrados(doc).has(127)).toBe(false);
  });

  it('y exige el enlace: una mención suelta no basta', () => {
    // Es deliberado. La tabla enlaza cada PR; aceptar «#999» a secas dejaría
    // pasar una fila escrita a medias, que es la que nadie vuelve a completar.
    expect(prsNombrados(doc).has(999)).toBe(false);
  });
});

describe('soloHistoria — la punta todavía no es historia', () => {
  const c = (asunto: string, pr: number | null): Entrada => ({
    sha: `sha-${asunto}`,
    commit: asunto.slice(0, 7),
    fecha: '2026-09-08',
    pr,
    asunto,
  });

  it('descarta el commit de fusión que CI fabrica para refs/pull/N/merge', () => {
    // Reproducido en CI y luego en local: ese commit no declara PR, así que se
    // contaba como «commit directo a main» y el censo daba 14 donde el árbol
    // tiene 13. El documento era correcto y la compuerta salía en rojo.
    const walk = [c('Merge 1b47d1c into 5fbb272', null), c('algo (#208)', 208), c('Línea base', null)];
    expect(soloHistoria(walk).map((e) => e.pr)).toEqual([208, null]);
  });

  it('y los commits propios de la rama en la que se trabaja', () => {
    const walk = [c('mi trabajo en curso', null), c('otro mío', null), c('algo (#208)', 208)];
    expect(soloHistoria(walk).map((e) => e.pr)).toEqual([208]);
  });

  it('pero NO los trece directos de la raíz, que sí son historia', () => {
    // Sólo se corta el prefijo de la PUNTA. Los directos viven en la raíz.
    const walk = [c('algo (#208)', 208), c('E0.3: el motor deja rastro', null), c('Línea base', null)];
    expect(soloHistoria(walk)).toHaveLength(3);
  });

  it('un árbol sin ningún PR no tiene historia que contar', () => {
    expect(soloHistoria([c('sólo trabajo local', null)])).toEqual([]);
  });
});

describe('la gracia — por qué esta compuerta no rompe el trabajo ajeno', () => {
  // Fechas puestas a mano: la regla de gracia es lo único que podría dar un
  // veredicto distinto según cuándo se pregunte, y una prueba atada al árbol
  // envejecería hasta ponerse roja sola.
  const pr = (n: number, fecha: string): Entrada => ({
    sha: `sha${n}`,
    commit: `c${n}`,
    fecha,
    pr: n,
    asunto: `algo (#${n})`,
  });
  const HOY = '2026-09-15';

  it('lo fusionado ayer sin fila NO falla: sería poner en rojo los demás PRs abiertos', () => {
    const r = clasificarAtraso([pr(208, '2026-09-14')], HOY);
    expect(r.atrasados).toHaveLength(0);
    expect(r.recientes).toHaveLength(1);
  });

  it('pero lo de hace más de una semana SÍ: la deuda tiene techo', () => {
    const r = clasificarAtraso([pr(53, '2026-09-07')], HOY);
    expect(r.atrasados.map((e) => e.pr)).toEqual([53]);
    expect(r.recientes).toHaveLength(0);
  });

  it('el séptimo día todavía está dentro, el octavo ya no', () => {
    expect(clasificarAtraso([pr(1, '2026-09-08')], HOY).atrasados).toHaveLength(0);
    expect(clasificarAtraso([pr(1, '2026-09-07')], HOY).atrasados).toHaveLength(1);
  });

  it('sin fecha con la que medir, TODO es deuda', () => {
    // No se firma en verde lo que no se pudo mirar. Es la misma regla que hace
    // que el guardián falle ante una historia truncada.
    const r = clasificarAtraso([pr(208, '2026-09-14')], null);
    expect(r.atrasados).toHaveLength(1);
    expect(r.recientes).toHaveLength(0);
  });

  it('y separa la ráfaga del día de la rotura de verdad', () => {
    const r = clasificarAtraso([pr(53, '2026-09-01'), pr(208, '2026-09-14')], HOY);
    expect(r.atrasados.map((e) => e.pr)).toEqual([53]);
    expect(r.recientes.map((e) => e.pr)).toEqual([208]);
  });
});

describe('diasEntre', () => {
  it('cuenta los días entre dos fechas del documento', () => {
    expect(diasEntre('2026-09-01', '2026-09-08')).toBe(7);
    expect(diasEntre('2026-09-08', '2026-09-08')).toBe(0);
  });
});

describe('el censo que se publica en el documento', () => {
  it('publica lo que el DOCUMENTO registra, no lo que el recorrido alcanza', () => {
    // Deliberado, y por una causa medida: al fusionar `main` en una rama, los
    // PRs que entraron mientras tanto llegan por el SEGUNDO padre, así que el
    // recorrido de primer padre de la rama no los ve — pero el
    // `refs/pull/N/merge` de CI sí, porque allí el primer padre es la punta de
    // `main`. Un bloque que contara el recorrido daría un número en la rama y
    // otro en CI, y `--check` se pondría rojo por un bloque «desfasado» que
    // estaba bien. Aquí se comprueba que el render no recibe nada del árbol.
    const bloque = render({
      nombrados: 60,
      directos: 13,
      ultimoPr: 214,
      atrasados: [],
      recientes: [],
    });
    expect(bloque).toContain('**60** PRs registrados aquí');
    expect(bloque).toContain('**13** commits directos');
    expect(bloque).toContain('#214');
    expect(bloque).toContain('7 días');
    // Y NINGUNA fecha: era el último dato que ataba el bloque al árbol.
    expect(bloque).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('el documento vivo', () => {
  const HISTORY = readFileSync(path.resolve(__dirname, '../../docs/HISTORY.md'), 'utf-8');

  it('conserva los marcadores del bloque generado', () => {
    expect(HISTORY).toContain('<!-- HISTORIAL-GENERADO:INICIO -->');
    expect(HISTORY).toContain('<!-- HISTORIAL-GENERADO:FIN -->');
  });

  it('ya no afirma que el #53 esté abierto', () => {
    // La regresión exacta: la fila decía «Abierto, CI en verde» sobre un PR
    // fusionado el 2026-09-07, en el documento cuya primera línea advierte que
    // no hay que creerse la narrativa de un artefacto sin verificarla.
    expect(HISTORY).not.toMatch(/pull\/53\)[^|]*\|[^|]*\|\s*Abierto/);
  });
});
