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
 * · La cola correctiva se publica como BANDA con dos convenciones (estricta y
 *   amplia), no como un número. La versión anterior imprimía 0.7% con una regex
 *   sobre el asunto y la auditoría II lo midió a mano entre 11.8% y 51.7%: el
 *   instrumento subestimaba entre 17× y 74%. Un instrumento que publica un
 *   falso verde es peor que no tenerlo, porque cierra la pregunta.
 * · Entrega y garantía se publican como DOS renglones, medidos por ruta
 *   (src/ contra tests/+scripts/+src/plan), no derivados de un porcentaje.
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

function insercionesEn(a: string, b: string, ...rutas: string[]): number {
  const stat = git('diff', '--shortstat', a, b, '--', ...rutas);
  const m = stat.match(/(\d+) insertions?/);
  return m ? Number(m[1]) : 0;
}

export function lineasEntre(a: string, b: string): number {
  return insercionesEn(a, b, 'src', 'tests', 'scripts');
}

/**
 * ENTREGA vs GARANTÍA, medidas y no derivadas.
 *
 * `src/` es lo que el despacho puede usar; `tests/` y `scripts/` es lo que
 * demuestra que sirve y lo mantiene medible. Publicarlas juntas como «420
 * líneas/fila» esconde el dato que cambia un presupuesto: cuánto de esa cifra
 * se reutiliza en la fila siguiente. `src/plan` cuenta como garantía aunque
 * viva bajo src: es el instrumento, no el producto.
 */
export function entregaYGarantia(a: string, b: string): { entrega: number; garantia: number } {
  const instrumento = insercionesEn(a, b, 'src/plan');
  const enSrc = insercionesEn(a, b, 'src');
  return {
    entrega: Math.max(0, enSrc - instrumento),
    garantia: insercionesEn(a, b, 'tests', 'scripts') + instrumento,
  };
}

// ============================================================
// LA COLA CORRECTIVA, COMO BANDA Y NO COMO NÚMERO (S2)
//
// La versión anterior imprimía UN porcentaje —0,7 % y bajando— clasificando
// por una regex sobre el asunto del commit. La auditoría integral II lo midió
// a mano: bajo cualquier convención razonable la cola está entre 11,8 % y
// 51,7 %, así que el instrumento la subestimaba por un factor de 17× a 74×.
// La causa no era «la cola dispersa en commits mixtos» como el propio script
// declaraba: eran COMMITS CORRECTIVOS ENTEROS cuyo asunto es narrativo. De
// dieciocho commits de su ventana, la regex casaba uno.
//
// Un instrumento que publica un falso verde es peor que no tenerlo, porque
// cierra la pregunta. Ahora publica una BANDA con sus dos convenciones:
//
//   ESTRICTA — sólo lo que se declara correctivo sin ambigüedad: el trailer
//     `Corrige:` del commit (la convención nueva) o la etiqueta AUD-* en el
//     asunto (la vieja).
//   AMPLIA — todo commit cuyo asunto delata trabajo sobre lo ya entregado:
//     tramos de garantía (S*, R*), reparaciones, auditorías, falsos verdes.
//
// La verdad está entre las dos, y decirlo así es lo honesto mientras el
// trailer no tenga historia suficiente para ser la única vara.
// ============================================================

const CORRECTIVO_ESTRICTO = /^AUD-/i;
const TRAILER_CORRIGE = /^Corrige:/im;
const CORRECTIVO_AMPLIO =
  /^(AUD-|S\d|R\d)|falso verde|corrig|repara|auditor|endurec|hueco|deuda/i;

export interface Cola {
  estricta: number;
  amplia: number;
  total: number;
  commits: number;
  conTrailer: number;
}

export function colaCorrectiva(desde: string, hasta: string): Cola {
  // %B (cuerpo entero) para poder leer el trailer, con separador propio.
  const crudo = git('log', '--format=%H%x09%s%x1f%B%x1e', `${desde}..${hasta}`);
  const registros = crudo.split('\x1e').map((r) => r.trim()).filter(Boolean);
  let estricta = 0;
  let amplia = 0;
  let total = 0;
  let conTrailer = 0;
  for (const registro of registros) {
    const [cabecera, cuerpo = ''] = registro.split('\x1f');
    const [hash, asunto = ''] = cabecera.split('\t');
    const stat = git('show', '--shortstat', '--format=', hash.trim());
    const m = stat.match(/(\d+) insertions?/);
    const ins = m ? Number(m[1]) : 0;
    total += ins;
    const declarado = TRAILER_CORRIGE.test(cuerpo);
    if (declarado) conTrailer += 1;
    if (declarado || CORRECTIVO_ESTRICTO.test(asunto)) estricta += ins;
    if (declarado || CORRECTIVO_AMPLIO.test(asunto)) amplia += ins;
  }
  return { estricta, amplia, total, commits: registros.length, conTrailer };
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
  const pct = (n: number) => (cola.total > 0 ? ((100 * n) / cola.total).toFixed(1) : '—');
  const porFila = totFilas > 0 ? Math.round(totLineas / totFilas) : 0;

  // ENTREGA Y GARANTÍA, DOS RENGLONES. Publicar «420 líneas/fila» como un solo
  // número esconde el dato accionable: buena parte de esa cifra es garantía, y
  // la garantía se reutiliza en la fila siguiente. Presupuestar una fase con el
  // número junto es presupuestarla mal en las dos direcciones.
  const partes = entregaYGarantia(primera.commit, ultima.commit);
  const entregaPorFila = totFilas > 0 ? Math.round(partes.entrega / totFilas) : 0;
  const garantiaPorFila = totFilas > 0 ? Math.round(partes.garantia / totFilas) : 0;

  process.stdout.write(
    `\nAgregado desde S0.1: ${totFilas} fila(s) invocable(s) ganadas · ${totLineas} líneas · ` +
      `${porFila || '—'} líneas/fila\n` +
      `  ENTREGA  ${String(entregaPorFila).padStart(4)} líneas/fila  (src/, sin src/plan)\n` +
      `  GARANTÍA ${String(garantiaPorFila).padStart(4)} líneas/fila  (tests/, scripts/ y el instrumento src/plan)\n` +
      `  razón ${entregaPorFila > 0 ? (garantiaPorFila / entregaPorFila).toFixed(2) : '—'} ` +
      'líneas de garantía por línea entregada — y la garantía se reutiliza en la fila siguiente\n\n' +
      `Cola correctiva, como BANDA sobre ${cola.commits} commits (${cola.total} líneas):\n` +
      `  estricta  ${String(cola.estricta).padStart(6)} líneas = ${pct(cola.estricta).padStart(5)}%  ` +
      '(trailer `Corrige:` o etiqueta AUD-*)\n' +
      `  amplia    ${String(cola.amplia).padStart(6)} líneas = ${pct(cola.amplia).padStart(5)}%  ` +
      '(además: tramos de garantía S*/R*, reparaciones, auditorías)\n' +
      `  ${cola.conTrailer} de ${cola.commits} commits declaran el trailer \`Corrige:\`\n\n` +
      'Referencia fundacional («Doce sprints», medida una vez sobre 50 filas): ~390 líneas/fila, 12.3% de cola.\n' +
      'Por qué una banda y no un número: la versión anterior clasificaba por regex sobre el asunto y\n' +
      'publicaba 0.7%, subestimando entre 17× y 74× — de dieciocho commits correctivos casaba uno. La\n' +
      'verdad vive entre las dos convenciones hasta que el trailer tenga historia; publicar una sola\n' +
      'cifra cerraría la pregunta con el número equivocado.\n' +
      'Límites del método: invocable ≈ fila (proxy duro), y los segmentos con Δinv=0 (garantías puras)\n' +
      'cargan sus líneas al agregado sin filas — a propósito: las garantías también son costo.\n'
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
