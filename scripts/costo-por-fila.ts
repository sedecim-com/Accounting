/**
 * El instrumento del costo por fila (S1).
 *
 *   npx tsx scripts/costo-por-fila.ts        imprime la serie y los agregados
 *
 * POR QUÉ EXISTE
 *
 * La tesis entera de «Doce sprints o sesenta» descansa en un número —~390
 * líneas por fila cerrada, con 12.3% de cola correctiva— que se midió UNA vez,
 * sobre las primeras 50 filas, y se arrastró congelado desde entonces. La
 * auditoría integral (doce-cobertura) lo señaló: si el costo real de las filas
 * nuevas divergió, nadie lo sabría. Éste es el mismo patrón de
 * catalogo-estado: dejar de recordar el número y empezar a preguntarlo.
 *
 * MÉTODO (y sus límites, dichos)
 *
 * · La unidad de avance es el SUELO del catálogo (docs/catalogo-minimos.json,
 *   S0.1): cada commit que lo sube declara filas invocables ganadas. Entre dos
 *   commits de suelo, las líneas insertadas (git diff --shortstat sobre
 *   src/tests/scripts) son el costo del segmento. Invocable ≠ fila cerrada con
 *   motor ✅ — es un PROXY, más duro que el original (exige que el comando se
 *   teclee), y lo decimos en vez de fingir equivalencia.
 * · La cola correctiva se aproxima por los commits cuyo asunto se declara
 *   correctivo (AUD-*, «falso verde», «corrig», «repara»). Subestima la cola
 *   dispersa en commits mixtos; también se dice.
 * · El suelo existe desde S0.1: lo anterior (las 50 filas del documento) queda
 *   como la medición fundacional, no re-medible por esta vía.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const RAIZ = path.resolve(__dirname, '..');
const SUELO = 'docs/catalogo-minimos.json';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf-8' }).trim();
}

interface Punto {
  commit: string;
  asunto: string;
  invocables: number;
}

export function puntosDeSuelo(): Punto[] {
  const commits = git('log', '--reverse', '--format=%H', '--', SUELO).split('\n').filter(Boolean);
  const puntos: Punto[] = [];
  for (const c of commits) {
    let inv: number | null = null;
    try {
      const j = JSON.parse(git('show', `${c}:${SUELO}`)) as Record<string, unknown>;
      inv = typeof j.invocables === 'number' ? j.invocables : null;
    } catch {
      inv = null;
    }
    if (inv === null) continue;
    puntos.push({ commit: c.slice(0, 7), asunto: git('log', '-1', '--format=%s', c), invocables: inv });
  }
  return puntos;
}

export function lineasEntre(a: string, b: string): number {
  const stat = git('diff', '--shortstat', a, b, '--', 'src', 'tests', 'scripts');
  const m = stat.match(/(\d+) insertions?/);
  return m ? Number(m[1]) : 0;
}

const CORRECTIVO_RE = /^AUD-|falso verde|corrig|repara/i;

export function colaCorrectiva(desde: string, hasta: string): { lineas: number; total: number } {
  const commits = git('log', '--format=%H%x09%s', `${desde}..${hasta}`).split('\n').filter(Boolean);
  let lineas = 0;
  let total = 0;
  for (const linea of commits) {
    const [hash, asunto] = linea.split('\t');
    const stat = git('show', '--shortstat', '--format=', hash);
    const m = stat.match(/(\d+) insertions?/);
    const ins = m ? Number(m[1]) : 0;
    total += ins;
    if (CORRECTIVO_RE.test(asunto ?? '')) lineas += ins;
  }
  return { lineas, total };
}

function main(): number {
  const puntos = puntosDeSuelo();
  if (puntos.length < 2) {
    process.stdout.write(
      'El suelo del catálogo tiene menos de dos puntos: aún no hay serie que medir.\n'
    );
    return 0;
  }

  process.stdout.write('Costo por fila, medido sobre los movimientos del suelo del catálogo\n\n');
  process.stdout.write('  commit   Δinv  líneas  líneas/fila  asunto\n');
  let totLineas = 0;
  let totFilas = 0;
  for (let i = 1; i < puntos.length; i++) {
    const a = puntos[i - 1];
    const b = puntos[i];
    const dInv = b.invocables - a.invocables;
    const lineas = lineasEntre(a.commit, b.commit);
    totLineas += lineas;
    if (dInv > 0) totFilas += dInv;
    const porFila = dInv > 0 ? Math.round(lineas / dInv).toString() : '—';
    process.stdout.write(
      `  ${b.commit}  ${String(dInv).padStart(4)}  ${String(lineas).padStart(6)}  ` +
        `${porFila.padStart(11)}  ${b.asunto.slice(0, 60)}\n`
    );
  }

  const primera = puntos[0];
  const ultima = puntos[puntos.length - 1];
  const cola = colaCorrectiva(primera.commit, ultima.commit);
  const pctCola = cola.total > 0 ? ((100 * cola.lineas) / cola.total).toFixed(1) : '—';

  process.stdout.write(
    `\nAgregado desde S0.1: ${totFilas} fila(s) invocable(s) ganadas · ${totLineas} líneas · ` +
      `${totFilas > 0 ? Math.round(totLineas / totFilas) : '—'} líneas/fila\n` +
      `Cola correctiva declarada (asuntos AUD-*/correctivos): ${cola.lineas} de ${cola.total} ` +
      `líneas = ${pctCola}%\n\n` +
      'Referencia fundacional («Doce sprints», medida una vez sobre 50 filas): ~390 líneas/fila, 12.3% de cola.\n' +
      'Límites del método: invocable ≈ fila (proxy duro), la cola dispersa en commits mixtos se subestima,\n' +
      'y los segmentos con Δinv=0 (garantías puras) cargan sus líneas al agregado sin filas — a propósito:\n' +
      'las garantías también son costo del catálogo.\n'
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
