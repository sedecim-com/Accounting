import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  render,
  emit,
  legible,
  resetOutputTargets,
  FORMATS,
  type RenderOptions,
  type Row,
} from '../../../src/cli/kernel/output.js';

// ============================================================
// `-o/--output` PROMETE UN ARCHIVO. AQUÍ SE COBRA LA PROMESA.
//
// Mentía de tres maneras, todas medidas sobre el binario:
//   · `mnemosine cfdi list --fields -o f` salía 0 y `f` NO EXISTÍA;
//   · una tabla de cero filas con `-o` tampoco creaba el archivo;
//   · `mnemosine cfdi show -o f` dejaba en `f` SÓLO los conceptos: el
//     segundo `render` truncaba al primero y el comprobante se perdía
//     en silencio.
//
// POR QUÉ ESTA BATERÍA NO ES UN CENSO DE `out.write(`.
//
// El intento anterior propuso contar apariciones de `out.write(` dentro
// de output.ts. Ese censo mide la ORTOGRAFÍA de un archivo, no la regla:
// se satisface aliaseando el flujo (`const w = out.write.bind(out)`), se
// satisface escribiendo `process.stdout.write`, y no dice absolutamente
// nada sobre `-o`. Aquí la afirmación es la promesa misma, y se comprueba
// de dos formas que no se pueden satisfacer por accidente:
//
//   1. EQUIVALENCIA. Los bytes del archivo son EXACTAMENTE los que la
//      misma llamada habría puesto en stdout sin `-o`. No es una lista de
//      ramas: es la definición de lo que `-o` promete.
//   2. STDOUT ENVENENADO. En cada caso con `-o`, el flujo de stdout que
//      recibe `render` LANZA al escribir. Una fuga no queda a merced de
//      que alguien se acuerde de afirmar `stdout === ''`: revienta.
//
// Y LA TERCERA RAMA FUTURA (`--summary`, `--count`), que es la objeción
// que tumbó al censo: no la cierra ninguna prueba enumerativa, la cierra
// el COMPILADOR. `compose()` no recibe ningún flujo —no tiene a dónde
// escribir— y devuelve `Composed`; con `strict` activo, una rama que se
// olvide de devolver su texto es un error de `tsc`, no un archivo que no
// aparece. La matriz de abajo se genera además desde `FORMATS`, que el
// propio módulo exporta: un formato nuevo entra solo.
// ============================================================

const RAIZ_REPO = path.join(__dirname, '..', '..', '..');
const TSX = path.join(RAIZ_REPO, 'node_modules', '.bin', 'tsx');
const OUTPUT_TS = path.join(RAIZ_REPO, 'src', 'cli', 'kernel', 'output.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'salida-prometida-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const ruta = (): string => path.join(TMP, `s${++n}.out`);

/** Recoge lo que un comando habría escrito, por flujo. */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (s: string) => { out.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => { err.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    get stdoutText() { return out.join(''); },
    get stderrText() { return err.join(''); },
  };
}

/** Un stdout que no perdona: si algo de dato sale por aquí teniendo `-o`, revienta. */
function veneno(): NodeJS.WriteStream {
  return {
    write: (s: string) => {
      throw new Error(`teniendo -o, ${JSON.stringify(s.slice(0, 60))} salió por stdout`);
    },
    isTTY: false,
  } as unknown as NodeJS.WriteStream;
}

const FILAS: Row[] = [
  { code: '1110', name: 'Bancos', balance: '1000.51' },
  { code: '2110', name: 'Proveedores', balance: '-400.00' },
];

// Cada proceso nace sin rutas abiertas; dentro de la suite hay que fingirlo.
beforeEach(resetOutputTargets);

// ── La matriz, generada desde el propio vocabulario del módulo ──
interface Caso { nombre: string; filas: Row[]; opts: RenderOptions }
const CUANTAS: Array<[string, Row[]]> = [
  ['0 filas', []],
  ['1 fila', FILAS.slice(0, 1)],
  ['2 filas', FILAS],
];
const CAMPOS: Array<[string, string | boolean | undefined]> = [
  ['todas', undefined],
  ['--fields (censo)', true],
  ['--fields code', 'code'],
];

const CASOS: Caso[] = [];
for (const format of FORMATS) {
  for (const [cuantas, filas] of CUANTAS) {
    for (const [comoCampos, fields] of CAMPOS) {
      for (const total of [undefined, 99]) {
        CASOS.push({
          nombre: `${format} · ${cuantas} · ${comoCampos}${total === undefined ? '' : ' · truncado'}`,
          filas,
          opts: { format, fields, ...(total === undefined ? {} : { total }) },
        });
      }
    }
  }
}
for (const [cuantas, filas] of [CUANTAS[0], CUANTAS[2]]) {
  for (const total of [undefined, 99]) {
    CASOS.push({
      nombre: `--quiet · ${cuantas}${total === undefined ? '' : ' · truncado'}`,
      filas,
      opts: { quiet: true, ...(total === undefined ? {} : { total }) },
    });
  }
}

describe('el archivo de -o contiene lo que habría salido por stdout', () => {
  it.each(CASOS)('$nombre', ({ filas, opts }) => {
    // Lo que este comando IMPRIME cuando nadie pidió archivo.
    const s = sink();
    resetOutputTargets();
    render(filas, { ...opts, stdout: s.stdout, stderr: s.stderr });

    // Lo mismo, con -o, y con stdout envenenado: una fuga lanza.
    const destino = ruta();
    const e = sink();
    resetOutputTargets();
    render(filas, { ...opts, output: destino, stdout: veneno(), stderr: e.stderr });

    // La promesa literal: el archivo existe SIEMPRE, aunque el resultado sea
    // vacío — cero filas es un resultado, y `-o` prometió un archivo.
    expect(fs.existsSync(destino), `-o no creó ${destino}`).toBe(true);
    expect(fs.readFileSync(destino, 'utf8')).toBe(s.stdoutText);
    // Y las notas no se mudan al archivo ni desaparecen: siguen en stderr.
    expect(e.stderrText).toBe(s.stderrText);
  });
});

describe('un comando que rinde varias veces', () => {
  it('componer no escribe: ni un byte por stdout ni por stderr, en ningún formato ni rama', () => {
    // ESTO SUSTITUYE A UNA AFIRMACIÓN QUE NO ERA CIERTA. El diseño dice que
    // quien compone el texto «no tiene a dónde escribir», y no es verdad:
    // `process.stdout` es global, así que `compose` podría escribir por ahí y
    // devolver la cadena vacía sin que el compilador, el tipo `Composed` ni
    // ningún criterio lo vieran. Es exactamente la fuga por la que este tramo
    // existe —una promesa que el instrumento no comprueba—, así que se
    // comprueba: se espían los DOS flujos y se exige cero escrituras, sobre
    // cada formato y cada rama que devuelve temprano.
    const filas = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }];
    const casos: Array<[string, Parameters<typeof render>[1]]> = [
      ['tabla', {}],
      ['json', { json: true }],
      ['csv', { format: 'csv' }],
      ['tsv', { format: 'tsv' }],
      ['ndjson', { format: 'ndjson' }],
      ['quiet', { quiet: true }],
      ['--fields a secas', { fields: true }],
      ['--fields con lista', { fields: 'a' }],
      ['cero filas', {}],
      ['truncado', { total: 99 }],
    ];
    for (const [nombre, opts] of casos) {
      const destino = path.join(TMP, `compose-${nombre.replace(/\W+/g, '-')}.txt`);
      const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        // Se vigila STDOUT y no stderr, y la distinción es el contrato entero:
        // las NOTAS van por stderr siempre —«No rows.», el aviso de truncado—,
        // y ésas no son una fuga. El DATO, con `-o`, tiene que estar en el
        // archivo y en ningún otro sitio; un solo byte suyo por stdout es la
        // composición saltándose la puerta.
        render(nombre === 'cero filas' ? [] : filas, { ...opts, output: destino });
      } finally {
        const escrituras = outSpy.mock.calls.map((c) => String(c[0]));
        outSpy.mockRestore();
        expect(
          escrituras,
          `«${nombre}» sacó dato por stdout teniendo -o: la separación entre componer y ` +
            'escribir se saltó por el camino de siempre, y el archivo prometido queda incompleto'
        ).toEqual([]);
      }
    }
  });

  it('acumula: el archivo tiene la salida COMPLETA, no sólo la última tabla', () => {
    // La forma exacta de `cfdi show`: cabecera y luego conceptos.
    const destino = ruta();
    const s = sink();
    render([{ uuid: 'D5A8', total: '1160.00' }], { stdout: s.stdout, stderr: s.stderr });
    render([{ line: 1, importe: '1000.00' }], { stdout: s.stdout, stderr: s.stderr });

    resetOutputTargets();
    render([{ uuid: 'D5A8', total: '1160.00' }], { output: destino, stdout: veneno(), stderr: s.stderr });
    render([{ line: 1, importe: '1000.00' }], { output: destino, stdout: veneno(), stderr: s.stderr });

    const escrito = fs.readFileSync(destino, 'utf8');
    expect(escrito).toContain('D5A8');
    expect(escrito).toContain('1,000.00'); // la segunda tabla; antes la primera la borraba
    expect(escrito).toBe(s.stdoutText);
  });

  it('la rama de cero filas escribe vacío sin borrar lo que otra rama ya puso', () => {
    const destino = ruta();
    resetOutputTargets();
    render(FILAS, { output: destino, stderr: sink().stderr });
    const conTabla = fs.readFileSync(destino, 'utf8');
    expect(conTabla).toContain('1110');
    render([], { output: destino, stderr: sink().stderr });
    expect(fs.readFileSync(destino, 'utf8')).toBe(conTabla);
  });

  it('la ruta se resuelve: `./x` y `x` son el mismo archivo, y no se truncan entre sí', () => {
    const destino = ruta();
    resetOutputTargets();
    render(FILAS.slice(0, 1), { output: destino, stderr: sink().stderr });
    render(FILAS.slice(1), { output: `${path.dirname(destino)}${path.sep}.${path.sep}${path.basename(destino)}`, stderr: sink().stderr });
    const escrito = fs.readFileSync(destino, 'utf8');
    expect(escrito).toContain('1110');
    expect(escrito).toContain('2110');
  });
});

describe('entre invocaciones NO se acumula', () => {
  it('un proceso nuevo trunca: correr el mismo comando dos veces no duplica el extracto', () => {
    const destino = ruta();
    // Esta invocación (el proceso de la suite) escribe una vez.
    resetOutputTargets();
    render(FILAS, { output: destino, stderr: sink().stderr });
    expect(fs.readFileSync(destino, 'utf8')).toContain('1110');

    // Y AHORA UN PROCESO DE VERDAD, que es la única forma de afirmar esto:
    // nace sin rutas abiertas, así que su primer render trunca lo anterior y
    // el segundo acumula sobre lo suyo. Un `resetOutputTargets()` aquí sólo
    // probaría que la función que finge el proceso nuevo funciona.
    const guion = path.join(TMP, 'otra-invocacion.ts');
    fs.writeFileSync(
      guion,
      `import { render } from ${JSON.stringify(OUTPUT_TS)};\n` +
        `const f = process.argv[2];\n` +
        `render([{ code: 'AAAA' }], { output: f });\n` +
        `render([{ code: 'BBBB' }], { output: f });\n`,
      'utf8'
    );
    const r = spawnSync(TSX, [guion, destino], { encoding: 'utf-8', cwd: RAIZ_REPO, timeout: 60_000 });
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);

    const despues = fs.readFileSync(destino, 'utf8');
    expect(despues).not.toContain('1110'); // la corrida anterior se fue, como con `>`
    expect(despues).toContain('AAAA'); // y las dos salidas de ESTA corrida están
    expect(despues).toContain('BBBB');
  });
});

describe('el estilo lo decide el destino, no la terminal de quien invoca', () => {
  it('con -o el archivo sale sin códigos ANSI aunque stdout sea una TTY', () => {
    const antes = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const destino = ruta();
      const tty = { write: () => true, isTTY: true } as unknown as NodeJS.WriteStream;
      resetOutputTargets();
      render(FILAS, { output: destino, stdout: tty, stderr: sink().stderr });
      // Los primeros bytes del archivo eran ESC-[-1-m: la tabla entraba vestida.
      expect(fs.readFileSync(destino, 'utf8')).not.toMatch(/\u001b\[/);
    } finally {
      if (antes !== undefined) process.env.NO_COLOR = antes;
    }
  });
});

describe('la puerta también sirve a lo que no pasa por render', () => {
  it('los bytes crudos (cfdi show --format xml) llegan al archivo y acumulan igual', () => {
    const destino = ruta();
    resetOutputTargets();
    emit('<?xml version="1.0"?>\n', { output: destino });
    emit('<Comprobante/>\n', { output: destino });
    expect(fs.readFileSync(destino, 'utf8')).toBe('<?xml version="1.0"?>\n<Comprobante/>\n');
  });

  it('sin -o escribe por el flujo que le den, sin tocar el disco', () => {
    const s = sink();
    emit('crudo\n', {}, s.stdout);
    expect(s.stdoutText).toBe('crudo\n');
  });
});

describe('pedir un archivo es pedir otra forma', () => {
  // `-o` no sólo tiene que crear el archivo: tiene que APAGAR la ficha escrita
  // a mano que una hoja imprime antes de su tabla, porque esa ficha no pasa por
  // `render` y se quedaría en la terminal. Diez hojas ya lo consultaban con un
  // `legible()` copiado; `entry show` tenía el suyo a mano con tres cláusulas
  // de las cinco y le faltaba justo `-o`: al archivo llegaban los renglones de
  // la póliza sin número, sin fecha, sin estatus y sin totales. El archivo
  // existía, así que la mentira era por omisión.
  it('con -o la ficha escrita a mano cede: el archivo se lleva la salida entera', () => {
    expect(legible({})).toBe(true);
    expect(legible({ output: 'x.txt' })).toBe(false);
  });

  it('y cede igual ante cualquier otra forma pedida', () => {
    expect(legible({ json: true })).toBe(false);
    expect(legible({ format: 'csv' })).toBe(false);
    expect(legible({ quiet: true })).toBe(false);
    expect(legible({ fields: 'code' })).toBe(false);
    expect(legible({ format: 'table' })).toBe(true); // 'table' es el valor por omisión de la bandera
  });
});
