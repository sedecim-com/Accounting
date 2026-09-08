import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  clasificarAtraso,
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
  it('publica lo que el DOCUMENTO registra, no el tamaño de `main`', () => {
    // Deliberado: si el bloque publicara «cuántos PRs hay en main», cada fusión
    // lo dejaría desfasado y volvería a poner en rojo todos los PRs abiertos —
    // justo lo que la gracia viene a evitar.
    const bloque = render({
      nombrados: 58,
      directos: 13,
      ultimoPr: 208,
      ultimaFecha: '2026-09-08',
      atrasados: [],
      recientes: [],
    });
    expect(bloque).toContain('**58** PRs registrados aquí');
    expect(bloque).toContain('**13** commits directos');
    expect(bloque).toContain('#208');
    expect(bloque).toContain('7 días');
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
