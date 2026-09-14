import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint, RuleTester, type Rule } from 'eslint';
import { parser } from 'typescript-eslint';

// ============================================================
// LA PUERTA DEL IDIOMA, PROBADA (I3 · issue #145)
//
// La regla `house/english-identifiers` vive escrita en `eslint.config.mjs`. Lo
// que aquí se comprueba son las cuatro cosas que la hacen una puerta y no un
// adorno, y ninguna de las cuatro se ve leyendo el número que publica el metro:
//
//   1. QUE ESTÉ ENCENDIDA, en error y sobre los tres árboles. Una regla escrita
//      y no cableada pasa todas las pruebas de comportamiento y no detiene nada.
//   2. QUE UN ARCHIVO NUEVO NO TENGA DERECHO A ESPAÑOL. Sin entrada en la línea
//      base el cupo es cero, que es el tramo entero en una frase.
//   3. QUE LA DEUDA VIEJA NO SALGA EN ROJO. Un archivo dentro de su cupo no
//      informa nada: si informara, CI estaría en rojo por 15 151 identificadores
//      que nadie puede renombrar hoy, y la regla duraría una tarde.
//   4. QUE LA EXENCIÓN EXIJA UNA RAZÓN. `// language-allow:` pelado no exime;
//      una excepción sin dueño es la grieta por la que se vacía una puerta.
//
// LA REGLA SE PIDE POR LA PUERTA DE ESLINT, NO IMPORTANDO EL ARCHIVO
//
// `eslint.config.mjs` es ESM y esta prueba compila a CommonJS, así que un
// `import` directo no pasaría el `tsc` del proyecto. Pero sobre todo: pedírsela
// a ESLint —`calculateConfigForFile`— comprueba de paso lo que un `import` no
// vería, que es que la regla esté REALMENTE aplicada a este archivo y con qué
// severidad. Se prueba la puerta montada, no la pieza suelta.
//
// LOS IDENTIFICADORES DE ESTA PRUEBA VAN EN INGLÉS, y aquí no es una costumbre:
// este archivo nace sin línea base, así que la regla que verifica es la primera
// que lo mira. Todo el español de aquí abajo vive dentro de cadenas —los
// fragmentos que se le dan al `RuleTester`, los nombres de los casos—, y las
// cadenas no son población.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');

/** El nombre con el que la regla se registra en la configuración plana. */
const RULE_ID = 'house/english-identifiers';

/** Los tres árboles que el rector cubre, y sobre los que la puerta tiene que estar. */
const TREES = ['src', 'tests', 'scripts'] as const;

/**
 * La forma que esta prueba necesita de una configuración ya resuelta. ESLint
 * devuelve `any`; se estrecha aquí para que un cambio de forma se vea como un
 * fallo de esta prueba y no como un `undefined` corriendo por dentro.
 */
interface ResolvedConfig {
  rules?: Record<string, unknown>;
  plugins?: Record<string, { rules?: Record<string, Rule.RuleModule> }>;
}

async function configFor(file: string): Promise<ResolvedConfig> {
  const eslint = new ESLint({ cwd: ROOT });
  return (await eslint.calculateConfigForFile(file)) as unknown as ResolvedConfig;
}

/** La regla tal y como la carga ESLint desde `eslint.config.mjs`. */
async function houseRule(): Promise<Rule.RuleModule> {
  const resolved = await configFor('src/probe.ts');
  const rule = resolved.plugins?.house?.rules?.['english-identifiers'];
  if (!rule) {
    throw new Error(
      `${RULE_ID} no está en la configuración de src/: la regla existe pero no está cableada.`,
    );
  }
  return rule;
}

interface BaselineFile {
  perFile: Record<string, Record<string, number>>;
}

const BASELINE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'language-baseline.json'), 'utf8'),
) as BaselineFile;

/**
 * UN ARCHIVO REAL CON CUPO, ELEGIDO DE LA PROPIA LÍNEA BASE.
 *
 * Escribir aquí un nombre y un número a mano —«scripts/openapi.ts, 4»— ataría
 * la prueba a un archivo que el epic existe para renombrar: el día que se
 * traduzca, la prueba se caería sin que nada estuviera roto. Se toma del JSON
 * el primero con cupo suficiente, y lo que queda comprobado es el CONTRATO
 * —«se perdona lo que dice la línea base de ESE archivo»— y no una cifra.
 */
function fileWithAllowance(): { file: string; allowance: number } {
  const lane = BASELINE.perFile['spanish-identifiers-scripts'] ?? {};
  const entries = Object.entries(lane)
    .filter(([, count]) => count >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chosen = entries[0];
  if (!chosen) {
    throw new Error(
      'ningún archivo de scripts/ tiene cupo ≥ 2 en la línea base: si el carril llegó a cero, ' +
        'esta prueba sobra y hay que borrarla; mientras no, algo le pasa al JSON.',
    );
  }
  return { file: chosen[0], allowance: chosen[1] };
}

/** `count` declaraciones españolas, una por línea. Cada una cuenta uno. */
function spanishDeclarations(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `export const saldoInicial${index} = ${index};`,
  ).join('\n');
}

describe('house/english-identifiers · el cableado', () => {
  it('está en error sobre src/, tests/ y scripts/', async () => {
    for (const tree of TREES) {
      const resolved = await configFor(`${tree}/probe.ts`);
      // ESLint normaliza la severidad a un array: `['error']` o `[2]`.
      expect(resolved.rules?.[RULE_ID], `${tree}/ no tiene la puerta puesta`).toEqual([2]);
    }
  });

  it('la regla que ESLint carga es la que se prueba abajo', async () => {
    const rule = await houseRule();
    expect(typeof rule.create).toBe('function');
    expect(rule.meta?.messages).toHaveProperty('bornInSpanish');
    expect(rule.meta?.messages).toHaveProperty('overBaseline');
  });
});

describe('house/english-identifiers · el comportamiento', () => {
  it('cumple sus casos', async () => {
    const rule = await houseRule();
    const { file: baselined, allowance } = fileWithAllowance();

    // El `RuleTester` de ESLint usa `describe`/`it` si los encuentra como
    // globales. Vitest no los publica (no hay `globals: true`), pero fijarlos
    // aquí quita la duda: los casos corren EN LÍNEA, dentro de este `it`, y un
    // fallo es una excepción de este caso. Sin esto, encender los globales de
    // vitest algún día anidaría un `describe` dentro de un `it` y la prueba
    // dejaría de comprobar nada sin dejar de pasar.
    type TestBody = () => unknown;
    RuleTester.describe = (_name: string, body: TestBody) => body();
    RuleTester.it = (_name: string, body: TestBody) => body();

    const tester = new RuleTester({
      languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    });

    tester.run(RULE_ID, rule, {
      valid: [
        {
          name: 'un archivo nuevo escrito en inglés',
          filename: 'src/language/gate-probe.ts',
          code: 'export function computeBalance(openingAmount: number): number {\n  return openingAmount;\n}\n',
        },
        {
          name: 'la exención escrita, con su razón',
          filename: 'src/language/gate-probe.ts',
          code: '// language-allow: la columna se llama así en la base y el mapeo casa por nombre\nexport const saldoInicial = 1;\n',
        },
        {
          name: 'las dos exenciones: dos letras o menos, y snake_case en miembro de interfaz',
          filename: 'src/language/gate-probe.ts',
          code: 'export const al = 1;\nexport interface Row {\n  emisor_rfc: string;\n  costo_total: number;\n}\n',
        },
        {
          name: 'lo que no es una declaración: cadenas, comentarios, claves de objeto e importaciones',
          filename: 'src/language/gate-probe.ts',
          code: [
            "import { crearPoliza } from './poliza.js';",
            '// El asiento de la póliza se cuadra contra el saldo inicial.',
            "export const label = 'saldo inicial de la póliza';",
            'export const row = { poliza: 1, saldo_inicial: 2 };',
            'void crearPoliza;',
          ].join('\n'),
        },
        {
          name: 'un archivo dentro de su cupo no informa nada',
          filename: baselined,
          code: spanishDeclarations(allowance),
        },
        {
          name: 'y por debajo del cupo, tampoco: la holgura la baja --tighten, no un error',
          filename: baselined,
          code: spanishDeclarations(allowance - 1),
        },
      ],

      invalid: [
        {
          name: 'un archivo nuevo con una función española',
          filename: 'src/language/gate-probe.ts',
          code: 'export function calcularSaldo(): number {\n  return 0;\n}\n',
          errors: [
            {
              messageId: 'bornInSpanish',
              data: { name: 'calcularSaldo', file: 'src/language/gate-probe.ts' },
            },
          ],
        },
        {
          name: 'sin nada perdonado, el aviso cae encima de cada palabra',
          filename: 'src/language/gate-probe.ts',
          code: 'export function calcularSaldo(montoInicial: number): number {\n  const saldoFinal = montoInicial;\n  return saldoFinal;\n}\n',
          errors: [
            { messageId: 'bornInSpanish', line: 1, column: 17 },
            { messageId: 'bornInSpanish', line: 1, column: 31 },
            { messageId: 'bornInSpanish', line: 2, column: 9 },
          ],
        },
        {
          name: 'la exención sin razón no exime: el identificador sigue contando',
          filename: 'src/language/gate-probe.ts',
          code: '// language-allow:\nexport const saldoInicial = 1;\n',
          errors: [
            {
              messageId: 'bornInSpanish',
              data: { name: 'saldoInicial', file: 'src/language/gate-probe.ts' },
            },
          ],
        },
        {
          name: 'snake_case fuera de un miembro de interfaz sí cuenta: ahí no hay columna que proteger',
          filename: 'src/language/gate-probe.ts',
          code: 'export const saldo_inicial = 1;\n',
          errors: [
            {
              messageId: 'bornInSpanish',
              data: { name: 'saldo_inicial', file: 'src/language/gate-probe.ts' },
            },
          ],
        },
        // LOS DOS SITIOS DONDE EL ÁRBOL DE ESLINT NO SE PARECE AL DE TYPESCRIPT.
        // No son casos exóticos por gusto: son los dos que el recorrido tiene
        // que tratar aparte, y los dos fallan EN SILENCIO —el lint cuenta de
        // menos y deja pasar español— si alguien simplifica el recorrido. El
        // del tipo mapeado no se dedujo leyendo: se cayó en un fixture.
        {
          name: 'el parámetro de un catch, que en TypeScript es una declaración de variable',
          filename: 'src/language/gate-probe.ts',
          code: 'export function run(): void {\n  try {\n    void 0;\n  } catch (errorContable) {\n    void errorContable;\n  }\n}\n',
          errors: [
            {
              messageId: 'bornInSpanish',
              data: { name: 'errorContable', file: 'src/language/gate-probe.ts' },
            },
          ],
        },
        {
          name: 'la llave de un tipo mapeado, que allí es un parámetro de tipo y aquí no',
          filename: 'src/language/gate-probe.ts',
          code: 'export type Mapped<T> = { [Llave in keyof T]: T[Llave] };\n',
          errors: [
            {
              messageId: 'bornInSpanish',
              data: { name: 'Llave', file: 'src/language/gate-probe.ts' },
            },
          ],
        },
        {
          name: 'uno por encima del cupo: un solo aviso, y del archivo entero',
          filename: baselined,
          code: spanishDeclarations(allowance + 1),
          errors: [
            {
              messageId: 'overBaseline',
              line: 1,
              column: 1,
              // La aritmética del mensaje, escrita: cuántos hay, cuántos se
              // perdonan, cuántos sobran. Es lo que quien lo lea va a creerse.
              data: {
                file: baselined,
                count: String(allowance + 1),
                baseline: String(allowance),
                excess: '1',
                command: `npx tsx scripts/language/lanes/code.ts identifiers scripts | grep ${baselined}`,
              },
            },
          ],
        },
      ],
    });
  });
});
