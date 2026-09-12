import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import ts from 'typescript';
import type { Lane } from '../../scripts/language/lane.js';
import { codeLanes } from '../../scripts/language/lanes/code.js';
import { messageParameters } from '../../src/i18n/index.js';
import {
  CLI_SURFACE,
  englishBlock,
  entryLines,
  judgeLanguage,
  keyFor,
  planFor,
  planFrom,
  prefixFor,
  slugFor,
  spanishBlock,
  tsFilesUnder,
  userStrings,
  userStringsUnder,
} from '../../scripts/language/extract.js';

// ============================================================
// LA PRUEBA DEL EXTRACTOR Y DE SU CARRIL (I7 · issue #149)
//
// El extractor tiene dos clientes y esta prueba está partida por ellos:
//
//   1. UNA PERSONA que le pide el plan de un archivo y pega lo que salga en los
//      catálogos. Para ésa importa que el texto llegue INTACTO —una coma que se
//      pierde al partir un renglón largo es un mensaje distinto— y que la
//      llamada sugerida sea la que de verdad hace falta.
//   2. EL METRO, que usa el MISMO reconocedor para publicar
//      `spanish-user-strings-cli`. Para ése importa que el número se pueda
//      reproducir sin el metro, y el último bloque EJECUTA el `command` del
//      carril y lo compara con el valor publicado — igual que hace
//      `tests/language/lanes-code.spec.ts` con los seis suyos, y por lo mismo:
//      un `command` que ya no reproduce la cifra es peor que ninguno.
//
// LOS NÚMEROS DEL ÁRBOL NO SE CLAVAN AQUÍ. Este tramo corre a la vez que la
// traducción del piloto `bank-command.ts`, así que la cifra de `src/cli/` baja
// mientras se escribe esto —era 668 al abrir el tramo y sigue cayendo—: un
// aserto contra cualquier número concreto sería rojo mañana sin que nada esté
// mal. Lo que sí se comprueba contra el árbol de verdad son las
// PROPIEDADES —que el desglose sume el total, que el comando reproduzca la
// cifra, que el orden sea el mismo dos veces—, que son las que tienen que valer
// para cualquier número.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');

/** Los textos que el reconocedor saca de un fragmento, que es lo que casi todo caso mira. */
function textsOf(code: string): string[] {
  return userStrings(code, 'fragmento.ts').map((hit) => hit.text);
}

describe('qué es una cadena de usuario y qué no', () => {
  it('una frase en español cuenta; una palabra suelta no', () => {
    // La exigencia de DOS palabras separadas por espacio es lo que separa un
    // mensaje de un valor: `'estado-cuenta'` es un identificador escrito con
    // comillas, y renombrarlo es trabajo del censo de identificadores, no de
    // este carril. Sin esa exigencia el carril contaría cada valor de
    // enumeración del CLI y no llegaría a cero nunca.
    const code = `
      export const a = 'No hay ningún calendario vivo en esta entidad.';
      export const b = 'estado-cuenta';
      export const c = 'poliza';
    `;
    expect(textsOf(code)).toEqual(['No hay ningún calendario vivo en esta entidad.']);
  });

  it('el inglés no cuenta, ni cuando lleva datos de ejemplo en español', () => {
    // El caso REAL: los bloques de `Examples:` de `bank-command.ts` están en
    // inglés y llevan dentro nombres de cuenta españoles. Contarlos metía
    // cadenas falsas en el carril del archivo piloto —14 al abrir el tramo; la
    // cifra se mide vaciando `ENGLISH_FUNCTION_WORDS` y restando las dos listas
    // de `--list src/cli`, y baja con cada bloque que se traduce—.
    const code = `
      export const help = \`
Examples:
  # The peso operating account, mapped 1:1 to the cash account of the chart.
  mnemosine bank account create "BBVA Operativa MXN" --bank "BBVA Mexico"
\`;
    `;
    expect(textsOf(code)).toEqual([]);
  });

  it('un texto en inglés con un párrafo español dentro sí cuenta', () => {
    // La contraparte del caso anterior, y también real, aunque ya sólo en el
    // pasado: el bloque de ayuda de `bank account create` LLEVABA un comentario
    // entero en castellano que el usuario veía al pedir `--help`. Ahí había
    // español saliendo por pantalla y la regla de mayoría lo cazaba; este mismo
    // tramo lo tradujo, así que el fragmento de abajo conserva el caso aunque el
    // árbol ya no lo tenga — que es justo para lo que sirve un fragmento.
    const code = `
      export const help = \`
Examples:
  # OJO, medido: el catalogo siembra 1112 «Banco Nacional - USD» SIN
  # currency_code, y la consulta la resuelve como MXN. Un ejemplo con
  # --currency USD sobre esa cuenta parsea y el servicio lo RECHAZA.
\`;
    `;
    expect(textsOf(code)).toHaveLength(1);
  });

  it('lo que el programa compara o almacena no es un mensaje', () => {
    // Las posiciones de DATO. Traducir cualquiera de éstas rompe el cable por el
    // que viaja el valor: el módulo que se importa, la clave de la propiedad, el
    // tipo literal, la etiqueta del `case` y el lado de una comparación.
    const code = `
      import { algo } from './la-cuenta-del-banco.js';
      export type Estado = 'sin cotejar' | 'ya cotejado';
      export const mapa = { 'no se pudo leer': 1 };
      export function f(x: string) {
        switch (x) { case 'la cuenta no existe': return 1; }
        return x === 'sin saldo que devengar' ? 2 : 3;
      }
      export const ya = t('bank_run_hit_cap');
    `;
    expect(textsOf(code)).toEqual([]);
  });

  it('un SQL con columnas en español es deuda de otro tramo', () => {
    const code = `
      export const q = 'SELECT folio, cuenta FROM polizas WHERE la cuenta es esta';
    `;
    expect(textsOf(code)).toEqual([]);
  });
});

describe('el texto llega entero', () => {
  it('une lo que el código partió con `+`', () => {
    // Ésta es la razón por la que el carril cuenta MENSAJES y no literales.
    // Sobre `src/cli/` la diferencia era de 964 literales a 668 mensajes al
    // abrir el tramo, y sin unir, partir un renglón para que quepa haría subir
    // el carril sin que nadie escribiera una palabra nueva de español.
    const code = `
      export const m =
        'La consulta no acota nada: nombra al menos un término, ' +
        'o quítala para listar todo.';
    `;
    expect(textsOf(code)).toEqual([
      'La consulta no acota nada: nombra al menos un término, o quítala para listar todo.',
    ]);
  });

  it('convierte `${x}` en `{x}` y nombra el parámetro por su expresión', () => {
    const code = `
      export const m = \`La cuenta \${cuenta.nombre} no existe: revisa \${TIPOS.join(', ')}.\`;
    `;
    const [hit] = userStrings(code, 'fragmento.ts');
    expect(hit.text).toBe('La cuenta {nombre} no existe: revisa {TIPOS}.');
    expect(hit.params).toEqual(['nombre', 'TIPOS']);
  });

  it('dos huecos que se llamarían igual no se pisan', () => {
    // Un nombre repetido dejaría el segundo hueco sin manera de rellenarse: en
    // ICU los parámetros son un diccionario, no una lista de posiciones.
    const code = 'export const m = `de la cuenta ${a.folio} a la cuenta ${b.folio}`;';
    const [hit] = userStrings(code, 'fragmento.ts');
    expect(hit.params).toEqual(['folio', 'folio2']);
    expect(hit.text).toBe('de la cuenta {folio} a la cuenta {folio2}');
  });

  it('una cadena dentro de un hueco es una cadena más', () => {
    const code = `
      export const m = \`El periodo \${formatear('el mes que ya se cerró')} no admite pólizas\`;
    `;
    expect(textsOf(code).sort()).toEqual([
      'El periodo {formatear} no admite pólizas',
      'el mes que ya se cerró',
    ]);
  });
});

describe('lo que no se transforma', () => {
  it('`// i18n:plural` deja la cadena sin clave, y aun así la cuenta', () => {
    // LA MARCA NO ES UNA EXENCIÓN DEL METRO. Si descontara, bastaría con
    // escribir comentarios para poner un archivo en verde. Cambia lo que hace el
    // EXTRACTOR —no propone una clave plana que congelaría el `(s)`— y no lo que
    // ve el CARRIL.
    const code = [
      'export const a = `Se cancelaron ${n} pólizas del periodo`;',
      '// i18n:plural',
      'export const b = `${n} CFDI cancelado por el emisor y sin efecto`;',
    ].join('\n');
    const hits = userStrings(code, 'fragmento.ts');
    expect(hits.map((hit) => hit.needsPlural)).toEqual([false, true]);

    const plan = planFrom(code, 'fragmento.ts', 'demo');
    expect(plan.entries.map((entry) => entry.spanish)).toEqual([
      'Se cancelaron {n} pólizas del periodo',
    ]);
    expect(plan.skipped).toHaveLength(1);
  });

  it('la forma `(s)` se reconoce sola: es como este CLI resuelve hoy el plural', () => {
    // `cfdi-command.ts:308` escribe `cancelado(s)` y `diot-command.ts:744`
    // `verificación(es)`. Meterlos al catálogo como texto plano congelaría el
    // paréntesis dentro de la traducción, que es justo lo que el plural de I6
    // vino a jubilar.
    const code = 'export const m = `${n} verificación(es) pedidas y ninguna falló`;';
    expect(userStrings(code, 'fragmento.ts')[0].needsPlural).toBe(true);
  });
});

describe('la clave', () => {
  it('es prefijo + slug, y el prefijo sale de la ruta', () => {
    expect(prefixFor('src/cli/bank-command.ts')).toBe('bank');
    expect(prefixFor('src/cli/kernel/exit.ts')).toBe('exit');
    // Seis palabras y se corta: una clave de treinta caracteres no se lee mejor
    // que una de veinte, y lo que identifica el mensaje es su principio.
    expect(slugFor('Sin cambios: el mayor no se tocó.')).toBe('sin_cambios_el_mayor_no_se');
    expect(keyFor('bank', 'Sin cambios: el mayor no se tocó.', new Set())).toBe(
      'bank_sin_cambios_el_mayor_no_se'
    );
  });

  it('el hueco no entra en el slug', () => {
    // `{cuenta}` es un parámetro, no una palabra del mensaje: meterlo en la
    // clave la ataría al nombre de una variable del sitio de llamada.
    expect(slugFor('La cuenta {cuenta} no existe')).toBe('la_cuenta_no_existe');
  });

  it('dos mensajes distintos con el mismo slug no comparten clave', () => {
    // Dos mensajes que empiezan igual y siguen distinto: el corte a seis palabras
    // los deja con el mismo slug. El desempate es un sufijo y no un slug más
    // largo, porque dos frases que empiezan igual suelen seguir igual.
    const taken = new Set(['bank_la_cuenta_no_existe_en_el']);
    expect(keyFor('bank', 'La cuenta no existe en el mayor', taken)).toBe(
      'bank_la_cuenta_no_existe_en_el_2'
    );
  });

  it('el mismo texto dos veces es UNA clave con dos sitios', () => {
    // Es la mitad del valor de mudar al catálogo, y `en.ts` lo dice de la
    // siembra de I6: la misma frase vivía en tres archivos. Dos claves para una
    // frase hacen que una corrección toque una y deje la otra vieja.
    const code = [
      "export const a = 'No hay ningún calendario vivo en esta entidad.';",
      "export const b = 'No hay ningún calendario vivo en esta entidad.';",
    ].join('\n');
    const plan = planFrom(code, 'fragmento.ts', 'demo');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].sites).toHaveLength(2);
    // Y el carril sigue viendo DOS: son dos literales que hay que sustituir.
    expect(userStrings(code, 'fragmento.ts')).toHaveLength(2);
  });

  it('avisa cuando el slug que propone es español', () => {
    // El extractor no traduce, así que la clave que compone sale del castellano
    // mientras el catálogo las tiene inglesas. No lo puede arreglar y no finge
    // que sí: lo marca con el MISMO léxico que usa el metro.
    const plan = planFrom(SEALED_PERIOD, 'fragmento.ts', 'demo');
    expect(plan.entries[0].keyIsSpanish).toBe(true);
  });
});

describe('lo que se pega en los catálogos', () => {
  it('el español va a es.ts y en en.ts queda la marca que la sincronía rechaza', () => {
    const plan = planFrom(SEALED_PERIOD, 'fragmento.ts', 'demo');
    const key = plan.entries[0].key;
    expect(spanishBlock(plan)).toContain('El periodo ya está cerrado y firmado.');
    expect(englishBlock(plan)).toContain(`${key}: '__TRANSLATE__'`);
    // La cita de origen viaja con la clave: sin ella, la siguiente persona no
    // sabe de qué pantalla salió el texto que está traduciendo.
    expect(englishBlock(plan)).toContain(plan.entries[0].sites[0].file);
  });

  it('un mensaje largo se parte en trozos que suman EXACTAMENTE el original', () => {
    // Partir por la izquierda del espacio en vez de por la derecha se come el
    // espacio y el catálogo deja de decir lo que decía el código. Es un error de
    // copia que ninguna prueba de tipos ve, así que se comprueba evaluando el
    // TypeScript que el extractor escribe.
    const long =
      'La corrida llegó a su tope y quedan movimientos sin evaluar: vuelve a ' +
      'correrla con --limit más alto, o acota con --account para que el trabajo ' +
      'quepa dentro de una sola pasada del motor de conciliación.';
    const lines = entryLines('demo_key', long);
    expect(lines.length).toBeGreaterThan(1);
    expect(evaluateEntry(lines)).toBe(long);
  });

  it('las comillas y los saltos de renglón sobreviven al viaje', () => {
    const tricky = 'no entendí «lo\'que sea»:\nresponde y/s para sí';
    expect(evaluateEntry(entryLines('demo_key', tricky))).toBe(tricky);
  });

  it('una llave suelta no llega al catálogo: se aparta con su razón', () => {
    // `{` y `}` son un carácter más en una plantilla de JavaScript y son
    // SINTAXIS en ICU. Sin validar, el extractor escribiría en el catálogo un
    // texto que `t()` rechaza en tiempo de ejecución — o sea, en la terminal de
    // un contador. Se valida con `messageParameters`, el MISMO recorrido que usa
    // `t()`, y lo que no pasa se aparta en vez de colarse.
    const plan = planFrom(
      "export const a = 'El asiento { no cuadra y la póliza no se puede firmar';",
      'fragmento.ts',
      'demo'
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/ICU/);
  });

  it('los parámetros que anuncia son los que el analizador de `t()` encuentra', () => {
    // Se comprueba sobre el CLI de verdad y sin exigir que haya nada: el día que
    // una familia quede traducida, su plan sale vacío y este caso sigue siendo
    // cierto. Un aserto de «hay al menos uno» se caería justo cuando todo salió
    // bien.
    for (const file of tsFilesUnder(`${CLI_SURFACE}/kernel`)) {
      for (const entry of planFor(file).entries) {
        const parameters = messageParameters(entry.spanish, entry.key).map((one) => one.name);
        expect(new Set(parameters)).toEqual(new Set(entry.params));
      }
    }
  });
});

describe('el carril, y que su número se pueda reproducir', () => {
  let lanes: Lane[];
  beforeAll(() => {
    lanes = codeLanes();
  }, 180_000);

  it('existe, va hacia cero y no es informativo', () => {
    const lane = lanes.find((one) => one.id === 'spanish-user-strings-cli');
    expect(lane).toBeDefined();
    expect(lane?.target).toBe(0);
    // Se puede bajar HOY —el extractor y `t()` ya existen— y sobre todo se puede
    // no subir hoy, que es lo que el trinquete por archivo protege.
    expect(lane?.informational).toBeUndefined();
  });

  it('el desglose por archivo suma el total, sin entradas en cero', () => {
    // Sin esta igualdad el desglose sería decorativo: un archivo podría
    // empeorar mientras el total se queda quieto, que es exactamente lo que el
    // trinquete por archivo existe para ver.
    const lane = lanes.find((one) => one.id === 'spanish-user-strings-cli');
    const perFile = Object.values(lane?.perFile ?? {});
    expect(perFile.reduce((sum, n) => sum + n, 0)).toBe(lane?.value);
    expect(perFile.every((n) => n > 0)).toBe(true);
  });

  it('sólo mira `src/cli/`, que es la superficie que el contador lee', () => {
    // `src/plan/criterios.ts` y el catálogo de agrupadores del SAT están llenos
    // de prosa española que NO se traduce —uno lo lee quien desarrolla y el otro
    // va a una autoridad—. Un carril que los contara publicaría una deuda que no
    // se debe pagar.
    const lane = lanes.find((one) => one.id === 'spanish-user-strings-cli');
    expect(Object.keys(lane?.perFile ?? {}).every((file) => file.startsWith(`${CLI_SURFACE}/`))).toBe(
      true
    );
  });

  it('el `command` que publica reproduce la cifra que publica', () => {
    // El campo `command` no es decorativo: si alguien cambia el recorrido y se
    // olvida del CLI, o al revés, este caso se cae.
    const lane = lanes.find((one) => one.id === 'spanish-user-strings-cli');
    const rows = execSync(lane?.command ?? '', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(Number(rows.trim())).toBe(lane?.value);
  }, 180_000);

  it('dos recorridos del mismo árbol dan la misma lista, en el mismo orden', () => {
    // `fs.readdirSync` no promete orden y el recorrido usa una pila explícita,
    // que tampoco sale en orden de lectura. Los dos se ordenan a propósito: un
    // metro que da dos listas para el mismo árbol no es un metro.
    const first = userStringsUnder('src/cli/kernel').map((hit) => `${hit.file}:${hit.line}`);
    const second = userStringsUnder('src/cli/kernel').map((hit) => `${hit.file}:${hit.line}`);
    expect(first).toEqual(second);
  });

  it('una ruta que no existe se queja en vez de devolver cero', () => {
    // El cero que parece una victoria: una lista vacía ES la meta del carril, y
    // el primer `--tighten` la clavaría en cero para siempre.
    expect(() => tsFilesUnder('src/cli-que-no-existe')).toThrow(/no existe/);
  });
});

describe('el juicio de idioma, que es donde se equivocaría', () => {
  it('cuenta palabras funcionales y no confunde una bandera con español', () => {
    // `--no-post` y `-y, --yes` aportaban un `no` y una `y` que son banderas, no
    // castellano. Eran falsos positivos reales sobre `bank-command.ts`.
    expect(judgeLanguage('-y, --yes').spanish).toBe(false);
    expect(judgeLanguage('run every validation and then roll it back').spanish).toBe(false);
  });

  it('reconoce prosa española que el léxico de identificadores da por inglesa', () => {
    // Medido: con la clasificación de `lexicon.ts` a secas —donde lo desconocido
    // cae en inglés— esta frase salía inglesa, porque `aceptada` y `honrar` son
    // conjugaciones que una lista de raíces no trae. Sobre prosa el idioma lo
    // delatan las palabras gramaticales.
    expect(judgeLanguage('R11 llave aceptada sin honrar').spanish).toBe(true);
  });
});

// ---- Utilería de la prueba -------------------------------------------

/** Un mensaje español de muestra, para no repetirlo en cuatro casos. */
const SEALED_PERIOD = "export const a = 'El periodo ya está cerrado y firmado.';";

/**
 * Evalúa los renglones que escribe `entryLines` como TypeScript de verdad, para
 * comprobar que el valor que quedaría en el catálogo es EXACTAMENTE el texto
 * original. Se hace con el árbol del compilador y no con `eval`: lo que se
 * quiere probar es que la sintaxis emitida es correcta, y `eval` lo probaría
 * ejecutando código que el extractor generó.
 */
function evaluateEntry(lines: string[]): string {
  const expression = lines.join('\n').replace(/^\s*[A-Za-z_][A-Za-z0-9_]*:/, '').replace(/,\s*$/, '');
  const source = ts.createSourceFile(
    'entry.ts',
    `const value = ${expression};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parts.join('');
}
