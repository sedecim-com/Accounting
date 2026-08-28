import { describe, it, expect } from 'vitest';
import {
  citasDe,
  comandosVivos,
  filasDelCatalogo,
  medir,
  render,
  rutaDe,
} from '../../scripts/catalogo-estado.js';

// ============================================================
// El catálogo de comandos publicaba a mano cuánto de su superficie existía ya.
// Duró 42 commits: decía «~30 comandos, casi todos de plomería del agente»
// cuando el binario ya respondía 136 en 41 familias.
//
// Es la misma lección que la tabla de estado del plan de cierre, borrada por lo
// mismo. Lo que se prueba aquí no es el formato del bloque: es que el número
// salga del árbol de comandos VIVO y no de que alguien se acuerde de contar.
// ============================================================

describe('rutaDe — el comando son los verbos, no sus argumentos', () => {
  it('descarta el argumento obligatorio', () => {
    expect(rutaDe('entry post <id>')).toBe('entry post');
  });

  it('descarta el opcional y las banderas', () => {
    expect(rutaDe('account list [query] --json --limit')).toBe('account list');
  });

  it('sin esto, cada fila con distinto argumento contaría como otro comando', () => {
    expect(rutaDe('invoice show <id>')).toBe(rutaDe('invoice show <folio>'));
  });

  it('deja intacto un comando sin argumentos', () => {
    expect(rutaDe('doctor')).toBe('doctor');
  });
});

describe('filasDelCatalogo', () => {
  const md = [
    '| `mnemosine account list [query]` · `cuenta listar` | Lista | `--json` | ✅ src/x.ts:1 | lectura | ✓ | 1 |',
    '| `mnemosine entry post <id>` · `poliza aplicar` | Aplica | `--force` | ❌ no existe | escritura | ✗ | 1 |',
    '| no es una fila de comando | x | y | z |',
  ].join('\n');

  it('extrae sólo las filas que declaran una invocación', () => {
    expect(filasDelCatalogo(md)).toHaveLength(2);
  });

  it('agrupa por familia, que es el primer verbo', () => {
    expect(filasDelCatalogo(md).map((f) => f.familia)).toEqual(['account', 'entry']);
  });

  it('conserva la invocación literal junto a la ruta normalizada', () => {
    const [primera] = filasDelCatalogo(md);
    expect(primera.invocacion).toBe('account list [query]');
    expect(primera.ruta).toBe('account list');
  });
});

describe('citasDe', () => {
  it('reconoce archivo:línea de src, tests y scripts', () => {
    const c = citasDe('ver src/a.ts:10 y tests/b.spec.ts:2 y scripts/c.ts:3');
    expect(c.map((x) => x.archivo)).toEqual(['src/a.ts', 'tests/b.spec.ts', 'scripts/c.ts']);
  });

  it('no cuenta dos veces la misma cita', () => {
    expect(citasDe('src/a.ts:10 … src/a.ts:10')).toHaveLength(1);
  });

  it('distingue dos líneas del mismo archivo', () => {
    expect(citasDe('src/a.ts:10 y src/a.ts:11')).toHaveLength(2);
  });

  it('reconoce también las migraciones .sql', () => {
    expect(citasDe('src/database/migrations/001_core.sql:141')[0].linea).toBe(141);
  });
});

describe('medir — el número sale del árbol vivo', () => {
  it('cuenta como implementada una fila cuyo comando responde el binario', () => {
    // `doctor` existe desde antes de que hubiera catálogo; si algún día deja de
    // existir, esta prueba es la que avisa de que el número cambió por eso.
    expect(comandosVivos().has('doctor')).toBe(true);
    const e = medir('| `mnemosine doctor` · `revisar` | x | y | ✅ z | lectura | ✓ | 1 |');
    expect(e.filas).toBe(1);
    expect(e.implementadas).toBe(1);
  });

  it('no cuenta una que el binario no responde', () => {
    const e = medir('| `mnemosine bank reconcile auto <id>` · `x` | a | b | ❌ c | escritura | ✗ | 2 |');
    expect(e.implementadas).toBe(0);
  });

  it('delata una cita a un archivo que ya no existe', () => {
    const e = medir('| `mnemosine x` | a | b | ✅ src/services/mexico/cfdi.ts:12 | lectura | ✓ | 1 |');
    expect(e.citas.sinArchivo.map((c) => c.archivo)).toContain('src/services/mexico/cfdi.ts');
  });

  it('delata una línea más allá del final del archivo', () => {
    const e = medir('| `mnemosine x` | a | b | ✅ package.json:1 · src/index.ts:999999 | lectura | ✓ | 1 |');
    expect(e.citas.fueraDeRango.map((c) => c.archivo)).toContain('src/index.ts');
  });

  it('no acusa una cita que sí resuelve', () => {
    const e = medir('| `mnemosine x` | a | b | ✅ src/index.ts:1 | lectura | ✓ | 1 |');
    expect(e.citas.sinArchivo).toHaveLength(0);
    expect(e.citas.fueraDeRango).toHaveLength(0);
  });
});

describe('render', () => {
  const bloque = render(medir('| `mnemosine doctor` · `revisar` | x | y | ✅ src/index.ts:1 | lectura | ✓ | 1 |'));

  it('lleva los marcadores que permiten sustituirlo sin tocar el resto', () => {
    expect(bloque.startsWith('<!-- ESTADO-GENERADO:INICIO -->')).toBe(true);
    expect(bloque.endsWith('<!-- ESTADO-GENERADO:FIN -->')).toBe(true);
  });

  it('dice que no se edite a mano y cómo regenerarlo', () => {
    expect(bloque).toContain('NO EDITAR A MANO');
    expect(bloque).toContain('scripts/catalogo-estado.ts');
  });

  it('confiesa lo que el número NO prueba', () => {
    // Una cita que resuelve sólo dice que el archivo existe y tiene esa línea.
    // Publicarlo como si fuera verificación sería el error que este bloque
    // viene a quitar, no a repetir.
    expect(bloque).toContain('no prueba que siga apuntando a lo mismo');
  });
});
