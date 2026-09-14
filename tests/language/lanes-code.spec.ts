import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';
import { isFlagged } from '../../scripts/language/lexicon.js';
import {
  codeLanes,
  flaggedDeclarations,
  hasSpanishFileName,
  tsFiles,
  list,
  TREES,
} from '../../scripts/language/lanes/code.js';

// ============================================================
// LA PRUEBA DE LOS CARRILES DEL CÓDIGO (I2 · issue #144)
//
// Un metro se juzga por tres cosas, y esta prueba está partida en tres por eso:
//
//   1. QUE EL NÚMERO SEA CIERTO. Aquí se acota lo que el recorredor cuenta y lo
//      que NO —comentarios, cadenas, importaciones, claves de objeto—, porque
//      un metro que cuenta de más se apaga a la semana y uno que cuenta de
//      menos deja pasar la deuda que vino a registrar.
//   2. QUE SE PUEDA REPRODUCIR SIN EL METRO. El campo `command` no es
//      decorativo: el último bloque lo EJECUTA y compara su `wc -l` con el
//      valor publicado. Si alguien cambia el recorrido y se olvida del CLI, o
//      al revés, esto se cae.
//   3. QUE NO CUENTE DOS VECES. Seis carriles se publican juntos; si dos miden
//      lo mismo con otro nombre, la suma miente.
//
// LA PROSA VA EN CASTELLANO Y LOS IDENTIFICADORES EN INGLÉS, y aquí eso no es
// una preferencia sino la misma regla que el módulo defiende: lo que va dentro
// de una cadena —el nombre de cada caso, los fragmentos que se le dan al
// recorredor— NO se cuenta, y lo que se declara SÍ. Escrita con nombres
// españoles, esta prueba aportaba 24 al carril `spanish-identifiers-tests` que
// ella misma verifica; el último caso del contrato es el que impide la recaída.
//
// Los carriles se calculan UNA VEZ en `beforeAll`: recorrer los tres árboles
// cuesta unos segundos y hacerlo en cada caso convertiría esta prueba en la más
// lenta de la suite, que es como se acaba borrando una prueba buena.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');

let LANES: Lane[];
beforeAll(() => {
  LANES = codeLanes();
}, 120_000);

/** Los nombres señalados de un fragmento, que es lo que casi todo caso mira. */
function names(code: string): string[] {
  return flaggedDeclarations(code, 'fragmento.ts').map((hit) => hit.name);
}

describe('el recorredor cuenta declaraciones, no palabras', () => {
  it('cubre las formas de declarar que el rector nombra', () => {
    const code = `
      const saldoInicial = 1;
      function calcularSaldo(importeBruto: number) { return importeBruto; }
      class Poliza { private folioInterno = 0; metodoCuadre() { return 1; } }
      interface Asiento { descripcionLarga: string }
      type TipoDeCambio = string;
      enum EstadoPoliza { Cerrada = 'c' }
      const { cuentaOrigen } = obj;
      const [primerRenglon] = arr;
    `;
    expect(names(code)).toEqual([
      'saldoInicial',
      'calcularSaldo',
      'importeBruto',
      'Poliza',
      'folioInterno',
      'metodoCuadre',
      'Asiento',
      'descripcionLarga',
      'TipoDeCambio',
      'EstadoPoliza',
      'Cerrada',
      'cuentaOrigen',
      'primerRenglon',
    ]);
  });

  it('un comentario y una cadena no declaran nada', () => {
    // Éste es el defecto que el rector avisa y el que decidió que aquí hubiera
    // un árbol de sintaxis y no una expresión regular. La plantilla de abajo es
    // el caso REAL del repo: `src/api/graphql/schemas/schema.ts` lleva un SDL
    // de GraphQL dentro de un literal, y por eso un `grep` de `enum` cuenta 32
    // declaraciones en `src/` donde hay 24.
    const code = `
      // const saldoComentado = 1;
      /* function calcularOculto() {} */
      const sdl = \`
        enum EstadoPoliza { CANCELADA }
        type Poliza { folio: String }
      \`;
      const label = 'interface Asiento { cuenta: string }';
    `;
    expect(names(code)).toEqual([]);

    // La contraprueba, para que quede EJECUTADO y no sólo dicho: sobre la misma
    // fuente, el regex ingenuo señalaría cinco declaraciones españolas que no
    // existen —viven en un comentario o dentro de una cadena—.
    const naive = [...code.matchAll(/\b(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1])
      .filter(isFlagged);
    expect(naive).toEqual(['saldoComentado', 'calcularOculto', 'EstadoPoliza', 'Poliza', 'Asiento']);
  });

  it('una sobrecarga son dos avisos del lint y son dos aquí', () => {
    // El metro cuenta UNA VEZ POR NODO porque es como informa un lint. Si
    // contara nombres únicos, el número del metro y el del lint divergirían en
    // cada función sobrecargada, que es exactamente lo que I2 existe para
    // evitar.
    const code = `
      export function buscarPoliza(id: string): number;
      export function buscarPoliza(id: number): number;
      export function buscarPoliza(id: unknown): number { return 1; }
    `;
    expect(names(code)).toEqual(['buscarPoliza', 'buscarPoliza', 'buscarPoliza']);
  });

  it('el renglón que publica es el renglón donde está el nombre', () => {
    const code = ['const first = 1;', '', 'const saldoInicial = 2;'].join('\n');
    expect(flaggedDeclarations(code, 'x.ts')).toEqual([
      { file: 'x.ts', line: 3, name: 'saldoInicial' },
    ]);
  });
});

describe('lo que la población deja fuera, y por qué', () => {
  it('una importación no declara el nombre: lo declaró el archivo de origen', () => {
    // Contarlo aquí convertiría un solo renombrado en diez, y el carril bajaría
    // diez cuando el trabajo hecho fue uno.
    const code = `
      import { crearPoliza } from './poliza.js';
      import cuentaPorCobrar from './cxc.js';
      export { crearPoliza };
    `;
    expect(names(code)).toEqual([]);
  });

  it('las claves de un objeto literal no se cuentan: son la misma deuda repetida', () => {
    // Medido sobre el árbol real: contarlas lleva `src/` de 9 797 a 18 059 y
    // `tests/` de 4 929 a 10 270 sin que exista una sola declaración más. La
    // clave se cuenta una vez, donde se DECLARA el tipo que la nombra.
    const code = `const fila = { poliza: 1, saldoInicial: 2, importe };`;
    expect(names(code)).toEqual(['fila']);
  });

  it('una clave entrecomillada no es un identificador', () => {
    const code = `
      interface Fila { 'razon-social': string }
      const mapa = { 'poliza-madre': 1 };
    `;
    expect(names(code)).toEqual(['Fila', 'mapa']);
  });

  it('al desestructurar se cuenta el enlace que se crea, no la propiedad de origen', () => {
    const code = `const { poliza: entry, saldoFinal } = fila;`;
    expect(names(code)).toEqual(['saldoFinal']);
  });
});

describe('las exenciones son dos, y sólo dos', () => {
  it('dos letras o menos no dicen de qué idioma son', () => {
    const code = `const id = 1; const db = 2; const mx = 3; const dia = 4;`;
    expect(names(code)).toEqual(['dia']);
  });

  it('snake_case en un miembro de interfaz está exento: ahí hay una columna que proteger', () => {
    const code = `
      interface FilaPoliza { emisor_rfc: string; costo_total: number }
      type Renglon = { fecha_pago: string };
    `;
    // Sólo salen los dos NOMBRES de tipo; los tres miembros están exentos. El
    // tipo escrito en línea cuenta como interfaz a propósito: 110 de los 345
    // miembros exentos del árbol son formas de fila devueltas por una consulta,
    // y son el mismo fenómeno que los 235 de una `interface` con nombre.
    expect(names(code)).toEqual(['FilaPoliza', 'Renglon']);
  });

  it('el mismo snake_case fuera de una interfaz SÍ se cuenta', () => {
    // La exención protege el mapeo con las columnas. Una variable local o una
    // propiedad de clase no mapea nada, así que ahí no hay nada que proteger; y
    // dejarla exenta abriría una tercera exención por la puerta de atrás.
    const code = `
      const fecha_pago = '2026-01-01';
      class Recibo { emisor_rfc = 'X'; }
      function f(costo_total: number) { return costo_total; }
    `;
    expect(names(code)).toEqual(['fecha_pago', 'Recibo', 'emisor_rfc', 'costo_total']);
  });

  it('no hay una tercera: un nombre español entero se cuenta aunque duela', () => {
    expect(names(`const cuentaContable = 1;`)).toEqual(['cuentaContable']);
  });
});

describe('el nombre del archivo pasa por el mismo léxico', () => {
  it('poliza-service.ts cuenta; bank-service.ts no', () => {
    expect(hasSpanishFileName('src/services/poliza-service.ts')).toBe(true);
    expect(hasSpanishFileName('src/services/bank-service.ts')).toBe(false);
  });

  it('el sufijo .spec no salva un nombre español', () => {
    // Aporta un token inglés, y el léxico señala también lo MIXTO: quitarlo
    // sería una regla más que mantener a cambio de ninguna diferencia medible.
    expect(hasSpanishFileName('tests/accounting/poliza.spec.ts')).toBe(true);
    expect(hasSpanishFileName('tests/accounting/bank.spec.ts')).toBe(false);
  });

  it('el directorio no cuenta, sólo el archivo', () => {
    // Mover un directorio es otro trabajo y merecerá su propio carril. Si el
    // camino contara, un solo `git mv` movería un número que mide otra cosa.
    expect(hasSpanishFileName('src/contabilidad/ledger.ts')).toBe(false);
  });
});

describe('el recorrido es determinista', () => {
  it('los archivos salen ordenados y sin lo que no es código de la casa', () => {
    const files = tsFiles('scripts');
    expect(files.length).toBeGreaterThan(0);
    expect([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(files);
    expect(files.every((f) => f.startsWith('scripts/') && f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.includes('node_modules') || f.includes('/.'))).toBe(false);
  });

  it(
    'dos lecturas del mismo árbol dan el mismo carril, entero',
    () => {
      // `fs.readdirSync` no promete orden. Un metro que da dos cifras para el
      // mismo árbol no es un metro: es una discusión sobre si el número subió.
      expect(codeLanes()).toEqual(LANES);
    },
    120_000,
  );
});

// I7 (issue #149) añadió un SÉPTIMO carril a `codeLanes()`: las cadenas de
// usuario del CLI. Su contrato es otro —lo reproduce `scripts/language/extract.ts`
// y no este módulo, y sus ejemplos son frases y no nombres de declaración—, así
// que se prueba en `tests/language/extract.spec.ts` con sus propios casos. Este
// bloque sigue mirando el CENSO DE NOMBRES, que es lo que este archivo prueba;
// meter el séptimo aquí a la fuerza habría exigido aflojar cuatro asertos que
// valen para los seis.
const census = (): Lane[] =>
  LANES.filter(
    (lane) => lane.id.startsWith('spanish-identifiers-') || lane.id.startsWith('spanish-filenames-')
  );

describe('el contrato de los seis carriles del censo', () => {
  it('son seis, con identidad estable y en inglés', () => {
    expect(census().map((lane) => lane.id)).toEqual([
      'spanish-identifiers-src',
      'spanish-identifiers-tests',
      'spanish-identifiers-scripts',
      'spanish-filenames-src',
      'spanish-filenames-tests',
      'spanish-filenames-scripts',
    ]);
  });

  it('todos apuntan a cero y ninguno es informativo', () => {
    // Lo informativo se reserva para lo que se mide y todavía no se puede
    // exigir. Los seis se bajan hoy renombrando, que es el trabajo del epic.
    for (const lane of census()) {
      expect(lane.target).toBe(0);
      expect(lane.informational).toBeUndefined();
      expect(lane.value).toBeGreaterThan(0);
      expect(lane.command).toContain('scripts/language/lanes/code.ts');
    }
  });

  it('el desglose por archivo suma exactamente el total', () => {
    // Sin esto, `perFile` sería una decoración y no la forma de pagar la deuda
    // por tramos: un PR que cierra tres archivos tiene que poder demostrarlo.
    for (const lane of LANES) {
      const byFile = lane.perFile ?? {};
      const sum = Object.values(byFile).reduce((a, b) => a + b, 0);
      expect(sum).toBe(lane.value);
      expect(Object.values(byFile).every((n) => n > 0)).toBe(true);
    }
  });

  it('los ejemplos son de verdad, y el renglón apunta al nombre', () => {
    // Un ejemplo que no lleva a ninguna parte es peor que ninguno: manda a
    // buscar a mano justo cuando alguien decidió confiar en el número.
    for (const lane of census().slice(0, 3)) {
      expect(lane.examples?.length).toBe(8);
      for (const example of lane.examples ?? []) {
        const m = /^(.+):(\d+) (.+)$/.exec(example);
        expect(m).not.toBeNull();
        const [, file, lineNo, name] = m as RegExpExecArray;
        const lineText = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[Number(lineNo) - 1];
        expect(lineText).toContain(name);
      }
    }
    for (const lane of census().slice(3)) {
      for (const example of lane.examples ?? []) {
        expect(fs.existsSync(path.join(ROOT, example))).toBe(true);
      }
    }
  });

  it('ningún carril mide lo que mide otro', () => {
    // Se publican juntos: dos carriles con la misma población y otro nombre
    // hacen que la suma mienta.
    expect(new Set(census().map((lane) => lane.id)).size).toBe(6);
    expect(new Set(census().map((lane) => lane.command)).size).toBe(6);
    // Y ninguno de los siete publicados repite identidad ni comando: si el
    // séptimo llegara con el `id` de otro, el trinquete protegería uno solo.
    expect(new Set(LANES.map((lane) => lane.id)).size).toBe(LANES.length);
    expect(new Set(LANES.map((lane) => lane.command)).size).toBe(LANES.length);
    for (const tree of TREES) {
      const identifiers = LANES.find((lane) => lane.id === `spanish-identifiers-${tree}`);
      const files = LANES.find((lane) => lane.id === `spanish-filenames-${tree}`);
      // Poblaciones disjuntas: una cuenta declaraciones DENTRO de los archivos
      // y la otra cuenta archivos, así que la del archivo no puede pasar del
      // censo y la del identificador tiene que pasarlo.
      expect(files?.value).toBeLessThanOrEqual(tsFiles(tree).length);
      expect(identifiers?.value).toBeGreaterThan(tsFiles(tree).length);
    }
  });

  it('el metro no engorda los carriles que publica', () => {
    // La primera versión de `code.ts` se escribió con nombres españoles y subió
    // `spanish-identifiers-scripts` de 425 a 474; ésta, con nombres españoles,
    // aportaba 24 a `spanish-identifiers-tests`. Cuarenta y nueve más
    // veinticuatro de deuda nueva, aportados por el instrumento que viene a
    // medirla y por su prueba. `lexicon.ts` (I1) aporta 1 y `lane.ts`, 0.
    // Este caso es el que impide la recaída, y sólo mira los archivos de I2:
    // los módulos hermanos son de sus tramos y de sus autores.
    const scriptsLane = LANES.find((lane) => lane.id === 'spanish-identifiers-scripts');
    const testsLane = LANES.find((lane) => lane.id === 'spanish-identifiers-tests');
    expect(scriptsLane?.perFile?.['scripts/language/lanes/code.ts']).toBeUndefined();
    expect(scriptsLane?.perFile?.['scripts/language/lane.ts']).toBeUndefined();
    expect(testsLane?.perFile?.['tests/language/lanes-code.spec.ts']).toBeUndefined();
  });
});

describe('la cifra se reproduce fuera del metro', () => {
  // Se ejecutan los dos carriles de `scripts/` —el árbol más pequeño— y no los
  // seis: los otros cuatro recorren EL MISMO código con otro argumento, así que
  // seis subprocesos comprarían la misma garantía por cuatro veces el tiempo.
  // Lo que esto ata es que `command` y el valor publicado no puedan separarse.
  it.each(['spanish-identifiers-scripts', 'spanish-filenames-scripts'])(
    '%s: correr su `command` da su `value`',
    (id) => {
      const lane = LANES.find((one) => one.id === id);
      expect(lane).toBeDefined();
      const out = execSync(lane!.command, { cwd: ROOT, encoding: 'utf8' });
      expect(Number(out.trim())).toBe(lane!.value);
    },
    120_000,
  );

  it('el CLI imprime una línea por item contado, no un total', () => {
    // Un total no se puede auditar; una lista sí. Es la diferencia entre un
    // número que se cree y uno que se comprueba.
    const rows = list('filenames', 'scripts');
    expect(rows.length).toBe(LANES.find((lane) => lane.id === 'spanish-filenames-scripts')?.value);
    expect(rows.every((row) => row.startsWith('scripts/'))).toBe(true);
  });
});
