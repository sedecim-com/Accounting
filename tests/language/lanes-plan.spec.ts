import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import {
  planLanes,
  isRenameable,
  manualsIn,
  renameableSegment,
  required,
  spanishIdentifiers,
} from '../../scripts/language/lanes/plan.js';
import type { Lane } from '../../scripts/language/lane.js';

// ============================================================
// LAS PRUEBAS DE LOS CARRILES DEL PLAN (I2 · issue #144)
//
// Un carril se juzga por tres cosas, y estas pruebas están ordenadas por ellas:
//
//   1. QUE EL NÚMERO SEA CIERTO. No se puede probar «cierto» contra nada, así
//      que se prueba contra las dos cosas que sí se pueden fijar: los casos
//      frontera de la definición (una por una, con su nombre) y el ÁRBOL REAL,
//      donde se clavan los hallazgos que hoy existen. Lo segundo no es una
//      línea base disfrazada: la línea base la lleva el orquestador y sólo
//      encoge; esto fija la FORMA del hallazgo —que la migración quede fuera,
//      que la ruta inglesa no entre— para que un cambio de definición no pase
//      por «bajó el número».
//
//   2. QUE SE PUEDA REPRODUCIR SIN EL METRO. El último bloque CORRE los seis
//      `command` y exige que den el mismo número. Cuesta unos tres segundos y
//      los vale: un `command` que no se ejecuta nunca se pudre en el primer
//      renombrado, y entonces el campo que existe para poder discutir la cifra
//      es el que impide discutirla.
//
//   3. QUE NO CUENTE DOS VECES. `perFile` tiene que sumar exactamente el total
//      en los seis; si un hallazgo entrara dos veces, ahí se ve.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const LANES = planLanes();
const byId = (id: string): Lane => {
  const l = LANES.find((c) => c.id === id);
  if (l === undefined) throw new Error(`no hay carril ${id}`);
  return l;
};

/** Los cinco que miden RUTAS. El primero mide identificadores y no aplica. */
const PATH_LANES = [
  'plan-criteria-pinned-to-spanish-paths',
  'plan-mutants-anchored-to-spanish-files',
  'coverage-thresholds-keyed-by-spanish-paths',
  'agent-corpus-sources-with-spanish-names',
  'test-mocks-of-spanish-modules',
];

describe('el contrato de un carril', () => {
  it('publica los seis carriles del rector §3.2, con id inglés y estable', () => {
    expect(LANES.map((l) => l.id)).toEqual([
      'plan-criteria-grepping-spanish-identifiers',
      'plan-criteria-pinned-to-spanish-paths',
      'plan-mutants-anchored-to-spanish-files',
      'coverage-thresholds-keyed-by-spanish-paths',
      'agent-corpus-sources-with-spanish-names',
      'test-mocks-of-spanish-modules',
    ]);
  });

  it('cada id es kebab-case inglés: es la LLAVE de la línea base, no una etiqueta', () => {
    // Si un id cambia, el orquestador pierde el histórico de ese carril y el
    // trinquete arranca de cero — que es como se pierde una deuda medida.
    for (const l of LANES) expect(l.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/);
  });

  it('todos apuntan a cero, y ninguno se declara informativo', () => {
    // No hay aquí ningún carril que nadie pueda bajar hoy: los 141 hallazgos
    // son ediciones de una línea. El único matiz honesto está escrito en
    // `spanishIdentifiers` — seis anclas del primer carril nombran cosas
    // del SAT que no se traducen— y se cierra con la frontera de AGENTS.md, no
    // apagando el carril.
    for (const l of LANES) {
      expect(l.target).toBe(0);
      expect(l.informational ?? false).toBe(false);
    }
  });

  it('cada carril trae comando y desglose, y el desglose SUMA el total', () => {
    for (const l of LANES) {
      expect(l.command.length).toBeGreaterThan(0);
      expect(l.title.length).toBeGreaterThan(0);
      const sum = Object.values(l.perFile ?? {}).reduce((a, b) => a + b, 0);
      expect(sum, `${l.id}: perFile no suma el total`).toBe(l.value);
      // Los ejemplos son «los primeros de la lista», nunca más que la lista.
      expect((l.examples ?? []).length).toBeLessThanOrEqual(l.value);
      if (l.value > 0) expect((l.examples ?? []).length).toBeGreaterThan(0);
    }
  });

  it('el recorrido es determinista: mismo árbol, mismo número y mismo orden', () => {
    // `fs.readdirSync` no promete orden y el carril de mocks recorre 341
    // archivos. Un metro que da dos cifras para el mismo árbol no es un metro,
    // y uno que da el mismo total con las llaves barajadas rompe el diff de la
    // línea base sin que nada haya cambiado.
    expect(JSON.stringify(planLanes())).toBe(JSON.stringify(LANES));
  });
});

describe('qué ruta cuenta: española Y renombrable', () => {
  it('el léxico decide, no el parecido — el aviso de `vault`', () => {
    // Es el caso que el rector puso por delante de todos: dos rutas que se
    // leen igual de extranjeras y sólo una lo es.
    expect(renameableSegment('src/services/vault/secrets.ts')).toBeUndefined();
    expect(renameableSegment('src/services/poliza/index.ts')).toBe('poliza');
  });

  it('el segmento nombrado es el que hay que renombrar', () => {
    expect(renameableSegment('src/services/reporting/criterio-cierre.ts')).toBe(
      'criterio-cierre'
    );
    expect(renameableSegment('src/services/payroll/mx/cfdi-nomina-generator.ts')).toBe(
      'cfdi-nomina-generator'
    );
  });

  it('una carpeta española basta, aunque el archivo esté en inglés', () => {
    expect(renameableSegment('src/services/nomina/service.ts')).toBe('nomina');
  });

  it('lo que este carril NO ve: una carpeta con dígito pegado', () => {
    // `anexo24` sale NEUTRO, y no por un token que falte: el tokenizador del
    // léxico parte en camelCase y en los separadores, no en la frontera
    // letra→dígito, así que `anexo24` nunca llega a preguntarse por `anexo`.
    // Hoy no cuesta nada —los archivos de esa carpeta se señalan igual por su
    // nombre (`balanza-service.ts`, `polizas-service.ts`)— pero un
    // `src/services/anexo24/service.ts` en inglés se le escaparía entero.
    // Queda escrito aquí y no se persigue con una lista propia: el arreglo, si
    // llega a hacer falta, es del tokenizador compartido y vale para el metro y
    // para el lint a la vez.
    expect(renameableSegment('src/services/anexo24/service.ts')).toBeUndefined();
  });

  it('una migración NO es renombrable: su nombre es su fila en el registro', () => {
    const migration = 'src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql';
    // Española sí; deuda de este epic, no. Contarla habría publicado 15
    // mutantes y 17 criterios que nadie puede arreglar nunca.
    expect(isRenameable(migration)).toBe(false);
    expect(renameableSegment(migration)).toBeUndefined();
  });

  it('un .md tampoco: la regla de la casa mantiene la documentación en español', () => {
    expect(isRenameable('docs/auditorias/2026-09-01-integral-ii/maestro-vs-codigo.md')).toBe(
      false
    );
  });

  it('un .sql que no es migración y un .json sí son renombrables', () => {
    // Nadie los tiene registrados por nombre, así que sí se traducen — y un
    // criterio anclado a ellos sí se queda apuntando a nada.
    expect(isRenameable('src/database/consulta-publica.sql')).toBe(true);
    expect(renameableSegment('src/ai/docs/manifiesto.json')).toBe('manifiesto');
  });
});

describe('qué grep cuenta: un identificador, no una palabra', () => {
  it('el ejemplo del rector: una declaración española', () => {
    expect(spanishIdentifiers('/export function calcularSaldo/')).toEqual(['calcularSaldo']);
  });

  it('el mismo grep en inglés no cuenta', () => {
    expect(spanishIdentifiers('/export function calculateBalance/')).toEqual([]);
  });

  it('la prosa española de un documento español NO es un identificador', () => {
    // Media criterios.ts busca frases dentro de CONTRIBUTING o de un manual.
    // Esa prosa no se rompe cuando el código se traduce: sus palabras van
    // sueltas, una por token. Sin esta regla el carril publicaba 1 802.
    expect(
      spanishIdentifiers('/Los comentarios y la documentación van en español/')
    ).toEqual([]);
    expect(spanishIdentifiers('/Lo que identifica no se traduce nunca/')).toEqual([]);
  });

  it('lower_snake es de SQL o de un JSON, y no lo renombra una traducción', () => {
    expect(spanishIdentifiers('/CREATE POLICY verificacion_publica/g')).toEqual([]);
    expect(spanishIdentifiers('/CONSTRAINT sesion_balanceada_con_aritmetica/')).toEqual([]);
    expect(spanishIdentifiers("/key: 'segregacion_de_funciones'/")).toEqual([]);
  });

  it('camelCase, PascalCase y SCREAMING_SNAKE sí son nombres de TypeScript', () => {
    expect(spanishIdentifiers('/exigirSegregacion\\(\\{/')).toEqual(['exigirSegregacion']);
    expect(spanishIdentifiers('/throw new CompuertaAbiertaError\\(huecos\\);/')).toEqual([
      'CompuertaAbiertaError',
    ]);
    expect(spanishIdentifiers("/ORIGEN_LOTE_IMPORTADO = 'import_batch'/")).toEqual([
      'ORIGEN_LOTE_IMPORTADO',
    ]);
  });

  it('la secuencia de escape NO se pega al nombre', () => {
    // El defecto que este filtro cazó: sin quitar los escapes, esta regex
    // entregaba `bcensarRutas` —la `\b` pegada— y el ejemplo mandaba a buscar
    // un identificador que no existe en ningún archivo. Un metro que publica
    // un nombre inventado se deja de leer a la primera.
    expect(
      spanishIdentifiers("/import \\{[^}]*\\bcensarRutas\\b[^}]*\\} from '\\.\\/risk\\.js'/")
    ).toEqual(['censarRutas']);
  });

  it('devuelve los nombres ordenados y sin repetir', () => {
    expect(spanishIdentifiers('/baseAntiguo !== baseReciente && baseAntiguo/')).toEqual([
      'baseAntiguo',
      'baseReciente',
    ]);
  });
});

describe('los seis carriles sobre el árbol real', () => {
  it('ninguna llave de un carril de rutas es inglesa ni queda fuera de lo renombrable', () => {
    // El precio de un falso positivo aquí es una persona renombrando código
    // que está bien escrito; a la tercera vez deja de mirar el instrumento.
    for (const id of PATH_LANES) {
      for (const filePath of Object.keys(byId(id).perFile ?? {})) {
        expect(renameableSegment(filePath), `${id} señala ${filePath}`).toBeDefined();
        expect(filePath).not.toMatch(/(?:^|\/)migrations\//);
        expect(filePath).not.toMatch(/\.md$/);
      }
    }
  });

  it('el carril de umbrales encuentra las SEIS entradas y ni una más', () => {
    // Las dos tablas de suelo y los dos vitest.config. El primer intento —una
    // regex `'src/….ts':` sobre el fuente entero— publicaba de más: se tragaba
    // el `de:` y el `a:` de un mutante que cita literalmente una entrada de la
    // tabla. Por eso se lee el AST.
    //
    // Eran cuatro sobre un solo archivo hasta que main trajo
    // `criterio-archivadas.ts` con su umbral en vitest.config.ts:119 y su suelo
    // en criterios.ts:607. La cifra sube porque la POBLACIÓN creció, no porque
    // el carril cuente distinto: se comprueba el desglose y no el total
    // justamente para que esa diferencia se vea.
    expect(byId('coverage-thresholds-keyed-by-spanish-paths').perFile).toEqual({
      'src/services/reporting/criterio-archivadas.ts': 2,
      'src/services/reporting/criterio-cierre.ts': 4,
    });
  });

  it('el carril del corpus mira las fuentes DECLARADAS, no sólo las selladas', () => {
    // `cfdi-nomina-generator.ts` lo declara payroll.md, que hoy está en
    // `sin_revisar` y por eso no tiene hash. Contar sólo `hashes` habría dado
    // cero justo sobre el único caso que existe.
    expect(byId('agent-corpus-sources-with-spanish-names').perFile).toEqual({
      'src/services/payroll/mx/cfdi-nomina-generator.ts': 1,
    });
  });

  it('el carril de mocks normaliza el specifier al archivo que se renombra', () => {
    // Cuatro `vi.mock('../../../src/services/reporting/criterio-cierre.js')`
    // escritos desde tres carpetas distintas son UN archivo que renombrar. Sin
    // normalizar, `perFile` publicaría tres llaves para el mismo módulo y el
    // desglose dejaría de servir para repartir trabajo.
    const pf = byId('test-mocks-of-spanish-modules').perFile ?? {};
    expect(pf['src/services/reporting/criterio-cierre.ts']).toBe(4);
    for (const k of Object.keys(pf)) expect(k.startsWith('src/')).toBe(true);
  });

  it('renombrar un módulo baja varios carriles a la vez, y eso no es contar dos veces', () => {
    // `permisos.ts` sale en el carril de rutas (1 cita) y en el de mutantes
    // (2 anclas). Son tres ediciones en tres sitios: el desglose las suma por
    // el archivo que se va a renombrar justamente para que quien lo renombre
    // vea el precio completo antes de empezar.
    expect(byId('plan-criteria-pinned-to-spanish-paths').perFile?.['src/api/graphql/permisos.ts'])
      .toBe(1);
    expect(byId('plan-mutants-anchored-to-spanish-files').perFile?.['src/api/graphql/permisos.ts'])
      .toBe(2);
  });

  it('el desglose del carril de greps apunta al archivo LEÍDO, no a criterios.ts', () => {
    // Es lo que hace pagable ese carril: cuando alguien traduzca posting.ts,
    // estas anclas son suyas. Si la resolución se rompiera, todo caería al
    // cajón `src/plan/criterios.ts` y el desglose dejaría de decir nada.
    const pf = byId('plan-criteria-grepping-spanish-identifiers').perFile ?? {};
    expect(pf['src/services/accounting/posting.ts']).toBeGreaterThan(0);
    const total = Object.values(pf).reduce((a, b) => a + b, 0);
    expect(pf['src/plan/criterios.ts'] ?? 0).toBeLessThan(total * 0.1);
  });

  it('cada ejemplo nombra un archivo y una línea que se pueden abrir', () => {
    for (const l of LANES) {
      for (const e of l.examples ?? []) {
        expect(e.length).toBeGreaterThan(0);
        expect(e).toMatch(/[A-Za-z0-9_-]+\.(?:ts|json)/);
      }
    }
  });
});

// ============================================================
// EL CERO QUE PARECE UNA VICTORIA
//
// Los seis apuntan a cero, así que un carril que no encuentra su fuente
// publica la meta. Está medido: sin `vitest.config.ts` el carril de umbrales
// bajaba de 4 a 3 con la salida limpia, sin el manifiesto el del corpus daba 0
// y sin `tests/` el de mocks daba 0 — tres bajadas que nadie había ganado, y
// que el primer `--apretar` habría convertido en línea base para siempre.
//
// Las fuentes de este módulo se resuelven contra la raíz real del repositorio,
// así que la guarda se ejercita por su cuenta —no hay forma de darle otro árbol
// sin mudar el módulo— y lo que se fija aquí es lo que el trinquete necesita:
// que un archivo que falta pare la medición y diga QUÉ falta y a QUIÉN dejaba
// ciego, en vez de devolver una lista vacía.
// ============================================================

describe('una fuente que falta para la medición, no publica cero', () => {
  it('la fuente que sí está se lee sin ruido', () => {
    expect(() => required('vitest.config.ts', 'el carril de umbrales')).not.toThrow();
    expect(required('vitest.config.ts', 'el carril de umbrales')).toBe(
      path.join(ROOT, 'vitest.config.ts')
    );
  });

  it('la que no está nombra el archivo Y el carril que se habría quedado ciego', () => {
    // Sin el nombre del carril, el error dice «falta un archivo» y quien lo lea
    // no sabe qué número dejó de ser cierto.
    expect(() => required('vitest.config.ts.movido', 'el carril de umbrales')).toThrow(
      /vitest\.config\.ts\.movido/
    );
    expect(() => required('vitest.config.ts.movido', 'el carril de umbrales')).toThrow(
      /el carril de umbrales/
    );
    expect(() => required('tests/no-existe', 'el carril de mocks')).toThrow(/el carril de mocks/);
  });

  it('un manifiesto que cambió de forma ciega el carril del corpus igual que uno ausente', () => {
    // El mapa `manuales` es un dato del archivo, no un nombre de este módulo:
    // si desaparece, `Object.entries(undefined ?? {})` daba cero fuentes y el
    // carril publicaba su meta sin haber mirado ninguna.
    expect(manualsIn({ manuales: { 'payroll.md': ['src/a.ts'] } })).toEqual({
      'payroll.md': ['src/a.ts'],
    });
    expect(() => manualsIn({ hashes: {} })).toThrow(/manuales/);
    expect(() => manualsIn({})).toThrow(/manifiesto\.json/);
  });
});

describe('el comando de cada carril reproduce su cifra', () => {
  // POR QUÉ ESTA PRUEBA EXISTE. `command` es lo que convierte un número en algo
  // discutible: sin él, a quien la cifra le parezca rara sólo le queda creerla
  // o no. Un campo así se pudre en silencio —basta con que alguien mueva un
  // archivo— y entonces el metro publica una receta que no corre. Aquí se
  // corre, y cuatro de los seis llegan por un camino DISTINTO al del carril:
  // importan el módulo y leen los datos en tiempo de ejecución en vez de
  // parsear el fuente, así que cuando coinciden, coinciden de verdad.
  for (const l of LANES) {
    it(
      `${l.id} → ${l.value}`,
      () => {
        const output = execSync(l.command, {
          cwd: ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(Number(output.trim().split('\n').pop())).toBe(l.value);
      },
      30_000
    );
  }
});
