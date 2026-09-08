import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  entriesOf,
  headOf,
  isRegistered,
  kept,
  problemsIn,
  registry,
  renamed,
  type VocabularyEntry,
} from '../../src/language/vocabulary-registry.js';
import {
  flagsAsSpanish,
  readAccountRoleValues,
  readLexicon,
  readSchemaVocabularies,
  tokenizeLikeLexicon,
} from '../../src/plan/criterios.js';
import { isFlagged, tokenize } from '../../scripts/language/lexicon.js';

// ============================================================
// EL REGISTRO DEL VOCABULARIO PERSISTIDO (I4 · issue #146)
//
// El registro es EL MAPA de los renombrados de I23-I25, y un mapa que miente
// es peor que no tener mapa: el renombrado le cree y toca datos de despachos
// actual. Estas pruebas no comprueban que el registro exista —eso lo hace el
// criterio— sino que las DOS COSAS de las que depende su valor se sostengan:
// que su forma sea valida entrada por entrada, y que el detector de espanol
// que decide que DEBE estar en el sea el mismo que el resto del sistema usa.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');

describe('el registro que existe hoy', () => {
  it('carga, y no trae una sola entrada invalida', () => {
    const r = registry();
    expect(r.length).toBeGreaterThan(500);
    const problems = r.flatMap((e, i) => problemsIn(e, i));
    expect(problems).toEqual([]);
  });

  it('cada entrada que NO se renombra dice por que, y ninguna dice las dos cosas', () => {
    // Es la regla que sostiene todo lo demas. Una excepcion sin razon se lee
    // dentro de seis meses como un descuido, y alguien la «arregla»
    // traduciendo un campo del SAT.
    for (const e of kept()) expect(e.keptBecause, `${e.where} · ${e.es}`).toBeTruthy();
    for (const e of renamed()) expect(e.keptBecause, `${e.where} · ${e.es}`).toBeUndefined();
    expect(kept().length + renamed().length).toBe(registry().length);
  });

  it('ninguna llave (clase, sitio, termino) aparece dos veces', () => {
    // Dos entradas para el mismo termino son dos decisiones para el mismo
    // renombrado, y el tramo que lo ejecute elegira una sin saber que habia otra.
    const seen = new Set<string>();
    const repeats: string[] = [];
    for (const e of registry()) {
      const k = `${e.class} ${headOf(e.where)} ${e.es}`;
      if (seen.has(k)) repeats.push(`${e.class} · ${headOf(e.where)} · ${e.es}`);
      seen.add(k);
    }
    expect(repeats).toEqual([]);
  });

  it('las doce clases estan pobladas: ninguna quedo declarada y vacia', () => {
    // Una clase vacia es una poblacion que nadie inventario, y el criterio no
    // la puede echar de menos reason no sabe que existe.
    for (const c of [
      'table',
      'column',
      'check-value',
      'account-role',
      'as-const',
      'policy-key',
      'policy-value',
      'migration-name',
      'error-code',
      'openapi-extension',
      'golden-key',
      'sealed-artifact',
    ] as const) {
      expect(entriesOf(c).length, `la clase ${c} esta vacia`).toBeGreaterThan(0);
    }
  });

  it('el sitio se compara por su cabeza, para que precisar no sea castigado', () => {
    expect(headOf('sat_anexo24_artefactos.tipo · TipoArtefacto (artefactos.ts:24-29)')).toBe(
      'sat_anexo24_artefactos.tipo'
    );
    expect(headOf('  tabla.columna  ')).toBe('tabla.columna');
    // Y la consulta del criterio encuentra una entrada aunque su sitio venga
    // con precisiones que el esquema no tiene.
    expect(isRegistered('check-value', 'sat_anexo24_artefactos.tipo', 'balanza')).toBe(true);
    expect(isRegistered('check-value', 'sat_anexo24_artefactos.tipo', 'no_existe')).toBe(false);
  });
});

// ============================================================
// UN TERMINO, UN SOLO INGLES
//
// El registro existe reason seis inventarios en paralelo, cada uno dueno de
// una clase, tradujeron el mismo literal de dos formas distintas: eso es
// exactamente el dano que I23-I25 no puede permitirse, reason dos nombres
// para un dato no se arreglan con otro renombrado.
//
// La regla no es absoluta: a veces dos sitios que comparten palabra espanola
// nombran cosas distintas, y forzarles un solo ingles fundiria dos conceptos,
// que es peor. Por eso la excepcion se PERMITE Y SE ESCRIBE. Una divergencia
// en esta lista es una decision; una fuera de ella es un descuido.
// ============================================================
const DELIBERATE_DIVERGENCES: Record<string, { english: string[]; reason: string }> = {
  fecha: {
    english: ['item_date', 'timestamp'],
    reason:
      'reconciling_items.fecha es una FECHA de negocio (la del movimiento) y la key `fecha` de la ' +
      'bitacora del evaluador es la marca de tiempo de una corrida. Un solo nombre prometeria el ' +
      'mismo tipo en los dos sitios.',
  },
  resultado: {
    english: ['outcome', 'result'],
    reason:
      'idempotency_keys.resultado GUARDA el resultado de la operacion repetida —es un dato, `result`—; ' +
      'el `resultado` del corpus y de la puntuacion dice COMO SALIO el caso (draft / ask / ' +
      'deterministic), que es `outcome`. Fundirlos haria creer que la columna guarda un veredicto.',
  },
  tipo: {
    english: ['adjustment_type', 'artifact_type', 'item_type'],
    reason:
      'Un nombre de columna solo tiene que ser unico dentro de su tabla, y las tres se ven en la ' +
      'MISMA consulta (reconciliation-service.ts hace FROM reconciliation_adjustments LEFT JOIN ' +
      'reconciling_items): llamarlas `type` a las tres obligaria a un alias en cada sitio. La forma ' +
      '<sustantivo>_type ya esta fijada por el arbol (entry_type, earning_type, deduction_type).',
  },
};

describe('un termino, un solo ingles', () => {
  it('ningun literal recibe dos traducciones sin permiso escrito', () => {
    const byTerm = new Map<string, Set<string>>();
    for (const e of registry()) {
      if (e.en === null) continue;
      const s = byTerm.get(e.es) ?? new Set<string>();
      s.add(e.en);
      byTerm.set(e.es, s);
    }
    const diverging = [...byTerm.entries()].filter(([, v]) => v.size > 1);
    const unlisted = diverging
      .filter(([es]) => !(es in DELIBERATE_DIVERGENCES))
      .map(([es, v]) => `${es} → ${[...v].sort().join(' / ')}`);
    expect(unlisted, 'un mismo termino con dos english y sin razon escrita').toEqual([]);
  });

  it('cada permiso escrito describe una divergencia que existe de verdad', () => {
    // El otro lado del trinquete: una excepcion que sobra es una que quedo
    // escrita cuando el problema ya se habia resuelto, y da permiso a un
    // descuido futuro sin que nadie lo note.
    for (const [es, { english }] of Object.entries(DELIBERATE_DIVERGENCES)) {
      const actual = new Set(registry().filter((e) => e.es === es && e.en !== null).map((e) => e.en));
      expect([...actual].sort(), `el permiso para «${es}» ya no corresponde`).toEqual([...english].sort());
    }
  });
});

describe('que hace invalida a una entrada', () => {
  const shape: VocabularyEntry = {
    class: 'check-value',
    where: 'tabla.columna',
    es: 'pendiente',
    en: 'pending',
    why: 'reason si',
  };

  it('acepta la entrada bien formada', () => {
    expect(problemsIn(shape, 0)).toEqual([]);
    expect(problemsIn({ ...shape, en: null, keptBecause: 'authority-field' }, 0)).toEqual([]);
  });

  it('no renombrar SIN razon es invalido', () => {
    const p = problemsIn({ ...shape, en: null }, 3);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('no se renombra y no dice por qué');
  });

  it('renombrar Y traer razon para no hacerlo es una contradiccion', () => {
    const p = problemsIn({ ...shape, keptBecause: 'identical-in-both' }, 0);
    expect(p[0]).toContain('trae nombre inglés Y razón');
  });

  it('un «en» vacio no es «no se renombra»: eso se dice con null', () => {
    // La forma silenciosa de perder una decision: la cadena vacia se lee como
    // renombrado y produce un nombre en blanco.
    expect(problemsIn({ ...shape, en: '' }, 0)[0]).toContain('«en» vacío');
  });

  it('una clase o una razon desconocidas se nombran', () => {
    expect(problemsIn({ ...shape, class: 'inventada' as never }, 0)[0]).toContain('clase desconocida');
    expect(problemsIn({ ...shape, en: null, keptBecause: 'reason-me-gusta' as never }, 0)[0]).toContain(
      'razón desconocida'
    );
  });

  it('una entrada sin razon escrita es una decision sin decision', () => {
    expect(problemsIn({ ...shape, why: '   ' }, 0)[0]).toContain('sin «why»');
  });
});

// ============================================================
// LA PRUEBA QUE SOSTIENE AL CRITERIO
//
// El criterio decide QUE DEBE estar en el registro preguntando si un valor es
// espanol, y no puede importar el lexicon de I1: vive en scripts/, fuera del
// `rootDir` de src/. Asi que reimplementa su regla — y una reimplementacion
// que nadie compara es una que va a divergir.
//
// Esto la compara. Si alguien cambia el clasificador, esta prueba se pone roja
// antes de que el criterio empiece a dar veredictos con un idioma viejo.
// ============================================================
describe('el detector del criterio y el lexicon de verdad dicen lo mismo', () => {
  const lexicon = readLexicon();

  it('el lexicon se puede leer desde el criterio', () => {
    // Si esto falla, el criterio sale «no evaluable» y deja de vigilar sin
    // ponerse rojo. Paso de verdad: `domainTerms` es un mapa termino->razon y
    // leerlo como arreglo hacia explotar `new Set({})` dentro de un catch.
    expect(lexicon).not.toBeNull();
    expect(lexicon!.roots.size).toBeGreaterThan(1000);
  });

  it('parte los identificadores exactamente igual que `tokenize`', () => {
    for (const x of ['RFCValido', 'saldo_libro', 'cheque-en-circulacion', 'jsonOriginal', 'ISR2026', '']) {
      expect(tokenizeLikeLexicon(x), x).toEqual(tokenize(x));
    }
  });

  it('coincide con `isFlagged` en las 200 declaraciones etiquetadas a mano', () => {
    const tsv = fs.readFileSync(path.join(ROOT, 'tests/language/muestra200.tsv'), 'utf8');
    const samples = tsv
      .split('\n')
      .map((l) => l.split('\t')[0])
      .filter((x) => x.length > 0);
    expect(samples.length).toBeGreaterThan(150);
    const disagree = samples.filter((x) => flagsAsSpanish(x, lexicon!) !== isFlagged(x));
    expect(disagree).toEqual([]);
  });

  it('coincide con `isFlagged` en TODOS los values de CHECK del esquema', () => {
    // La poblacion que el criterio recorre de verdad. La muestra prueba la
    // regla; esto prueba el uso.
    const values = [...readSchemaVocabularies().values()].flat();
    expect(values.length).toBeGreaterThan(300);
    const disagree = values.filter((v) => flagsAsSpanish(v, lexicon!) !== isFlagged(v));
    expect(disagree).toEqual([]);
  });

  it('coincide con `isFlagged` en los values de AccountRole', () => {
    const roles = readAccountRoleValues();
    expect(roles.length).toBeGreaterThan(20);
    expect(roles.filter((r) => flagsAsSpanish(r, lexicon!) !== isFlagged(r))).toEqual([]);
  });
});

describe('lo que el criterio exige, medido aqui tambien', () => {
  it('todo literal espanol de un CHECK esta registrado', () => {
    // El mismo calculo que el criterio, para que el fallo se lea en la suite y
    // no solo en el tablero del plan.
    const lexicon = readLexicon()!;
    const missing: string[] = [];
    for (const [key, values] of readSchemaVocabularies()) {
      for (const v of values) {
        if (flagsAsSpanish(v, lexicon) && !isRegistered('check-value', key, v)) {
          missing.push(`${key} = '${v}'`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('todo valor de AccountRole esta registrado', () => {
    const missing = readAccountRoleValues().filter((r) => !isRegistered('account-role', 'account_roles.role', r));
    expect(missing).toEqual([]);
  });
});
