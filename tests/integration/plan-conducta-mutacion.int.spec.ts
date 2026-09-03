import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRUEBAS_DE_CONDUCTA } from '../../src/plan/conducta.js';

// ============================================================
// S4a · LOS ESPEJOS DEL CRITERIO QUE EJECUTA
//
// El arnés en memoria (tests/plan/mutacion.spec.ts) no sirve aquí, y la razón
// es la tesis entera del tramo: `conFuenteMutada` sustituye el texto que un
// REGEX inspecciona, y un criterio de conducta no inspecciona texto — corre
// código. Para saber si muerde hay que cambiar el código que Postgres acaba
// ejecutando, o sea el ARCHIVO.
//
// Tres decisiones, con su precio dicho:
//
//   · SE ESCRIBE EN DISCO. Es la única forma de que la mutación llegue al
//     camino real. Se paga con un `finally` que restaura y un `afterAll` que
//     vuelve a restaurar por si el `finally` no llegó a correr. Si esta suite
//     muere de un SIGKILL en el medio, el árbol queda mutado: es el riesgo
//     que se acepta, y por eso la restauración se AFIRMA al final en vez de
//     confiarse.
//   · SE RE-CORRE EN UN PROCESO NUEVO. El padre ya tiene report-service y
//     scope cargados; reescribir el archivo no recarga un módulo. El hijo
//     nace con el árbol mutado y con su propia base efímera.
//   · CORRE EN LA SUITE DE INTEGRACIÓN, que es `singleFork` y
//     `fileParallelism: false`. En una suite paralela, mutar un archivo
//     compartido corrompería a los vecinos.
//
// Lo que se exige de cada mutante es lo mismo que en el arnés viejo: que el
// criterio pase a `falla`. NO se exige que falle por la cifra y no por una
// excepción — un asiento que deja de cuadrar también es rojo, y clasificarlo
// como «no se pudo medir» es justo el agujero que criterioDeConducta cierra.
// ============================================================

const RAIZ = path.resolve(__dirname, '..', '..');

/** El contenido original de cada archivo que algún espejo toca, leído UNA vez. */
const originales = new Map<string, string>();
for (const p of PRUEBAS_DE_CONDUCTA) {
  for (const m of p.mutantes) {
    const abs = path.join(RAIZ, m.archivo);
    if (!originales.has(abs)) originales.set(abs, fs.readFileSync(abs, 'utf-8'));
  }
}

function restaurarTodo(): void {
  for (const [abs, texto] of originales) {
    if (fs.readFileSync(abs, 'utf-8') !== texto) fs.writeFileSync(abs, texto, 'utf-8');
  }
}

afterEach(restaurarTodo);
afterAll(restaurarTodo);

interface Veredicto {
  resultados?: Record<string, { estado: string; detalle: string }>;
  motivo?: string;
}

/** Corre el escenario completo en un hijo y devuelve sus veredictos. */
function correrEscenario(): Veredicto {
  const salida = path.join(os.tmpdir(), `conducta-espejo-${crypto.randomBytes(6).toString('hex')}.json`);
  const r = spawnSync('npx', ['tsx', path.join(RAIZ, 'src', 'plan', 'conducta.ts'), `--salida=${salida}`], {
    cwd: RAIZ,
    encoding: 'utf-8',
    timeout: 240_000,
  });
  if (!fs.existsSync(salida)) {
    const cola = (r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' · ');
    return { motivo: `el hijo no dejó veredicto (código ${r.status ?? '?'}): ${cola}` };
  }
  const v = JSON.parse(fs.readFileSync(salida, 'utf-8')) as Veredicto;
  fs.unlinkSync(salida);
  return v;
}

const casos = PRUEBAS_DE_CONDUCTA.flatMap((p) =>
  p.mutantes.map((m) => ({ etiqueta: `${p.id} · ${m.archivo}: ${m.porque}`, id: p.id, mutante: m }))
);

describe('los espejos del criterio que EJECUTA', () => {
  it('el escenario sin mutar deja los tres en verde', () => {
    // La línea base. Sin ella, un mutante «mata» un criterio que ya estaba
    // rojo por otra cosa —una base que no monta, un catálogo que cambió— y el
    // arnés certificaría una mordida que no existe.
    const v = correrEscenario();
    expect(v.motivo, `el escenario no pudo montarse: ${v.motivo ?? ''}`).toBeUndefined();
    for (const p of PRUEBAS_DE_CONDUCTA) {
      expect(v.resultados?.[p.id]?.estado, `${p.id}: ${v.resultados?.[p.id]?.detalle ?? 'sin veredicto'}`).toBe('ok');
    }
  }, 240_000);

  it.each(casos)(
    'el mutante lo pone en rojo — $etiqueta',
    ({ id, mutante }: (typeof casos)[number]) => {
      const abs = path.join(RAIZ, mutante.archivo);
      const original = originales.get(abs)!;
      try {
        if (mutante.a === null) {
          fs.unlinkSync(abs);
        } else {
          const mutado = original.replace(mutante.de, mutante.a);
          expect(mutado, `la mutación no cambió ${mutante.archivo}`).not.toBe(original);
          fs.writeFileSync(abs, mutado, 'utf-8');
        }

        const v = correrEscenario();
        expect(v.motivo, `el escenario no pudo montarse: ${v.motivo ?? ''}`).toBeUndefined();
        const r = v.resultados?.[id];
        expect(
          r?.estado,
          `MUTANTE VIVO en «${id}»\n` +
            `  ${mutante.archivo}: «${mutante.de}» → «${mutante.a}»\n` +
            `  porque: ${mutante.porque}\n` +
            `  el criterio dijo: ${r?.detalle ?? 'nada'}\n` +
            '  El escenario no llega al sitio que el mutante toca: siémbralo más cerca.'
        ).toBe('falla');
      } finally {
        fs.writeFileSync(abs, original, 'utf-8');
      }
    },
    240_000
  );

  it('el árbol real queda intacto tras mutar', () => {
    for (const [abs, texto] of originales) {
      expect(fs.readFileSync(abs, 'utf-8'), `${path.relative(RAIZ, abs)} quedó mutado en disco`).toBe(texto);
    }
  });
});
