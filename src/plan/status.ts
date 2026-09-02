import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRITERIOS, type Criterio, type Resultado } from './criterios.js';
import { palette } from '../cli/palette.js';

// ============================================================
// npm run plan:status
//
// Imprime el estado de cada paquete del plan EVALUANDO sus criterios, y
// nombrando el que falla. Reemplaza una tabla escrita a mano que se
// desincronizó de sus propios commits.
//
// El estado de un paquete es el PEOR de sus criterios: un paquete con nueve
// criterios en verde y uno en rojo no está «casi cerrado», está abierto. Ésa
// es la diferencia entre esta salida y un porcentaje.
//
// Sale con código 0 siempre que haya podido evaluar. No es una compuerta de
// CI —un paquete abierto es información, no un fallo del build— salvo con
// --exigir, que la convierte en una para el conjunto de paquetes que se le
// nombren.
// ============================================================

export type EstadoPaquete =
  | 'resuelto'
  | 'no-demostrado'
  | 'parcial'
  | 'pendiente'
  | 'sin-evaluar';

export interface Evaluacion {
  criterio: Criterio;
  resultado: Resultado;
}

export interface Paquete {
  id: string;
  estado: EstadoPaquete;
  evaluaciones: Evaluacion[];
}

export async function evaluar(criterios: Criterio[] = CRITERIOS): Promise<Paquete[]> {
  const porPaquete = new Map<string, Evaluacion[]>();

  for (const criterio of criterios) {
    let resultado: Resultado;
    try {
      resultado = await criterio.evaluar();
    } catch (err) {
      // Un criterio que revienta no es un criterio cumplido. Se reporta como
      // no evaluable con la causa, que es lo que hace falta para arreglarlo.
      resultado = {
        estado: 'no-evaluable',
        detalle: `el criterio falló al ejecutarse: ${(err as Error).message}`,
      };
    }
    const lista = porPaquete.get(criterio.paquete) ?? [];
    lista.push({ criterio, resultado });
    porPaquete.set(criterio.paquete, lista);
  }

  return [...porPaquete.entries()]
    .map(([id, evaluaciones]) => ({ id, estado: estadoDe(evaluaciones), evaluaciones }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function estadoDe(evaluaciones: Evaluacion[]): EstadoPaquete {
  const ok = evaluaciones.filter((e) => e.resultado.estado === 'ok').length;
  const fallan = evaluaciones.filter((e) => e.resultado.estado === 'falla').length;
  const evaluables = evaluaciones.filter((e) => e.resultado.estado !== 'no-evaluable').length;

  if (evaluables === 0) return 'sin-evaluar';
  // Un paquete es ✅ sólo si TODOS sus criterios se evaluaron y pasaron. La
  // primera corrida marcó E0.2 en verde con un criterio que nadie pudo
  // evaluar, que es exactamente el error que este comando existe para no
  // repetir: un hueco no es un acierto, es un hueco.
  if (ok === evaluaciones.length) return 'resuelto';
  if (fallan === 0) return 'no-demostrado';
  if (ok === 0) return 'pendiente';
  return 'parcial';
}

const MARCA: Record<EstadoPaquete, string> = {
  resuelto: '✅',
  'no-demostrado': '🟠',
  parcial: '🟡',
  pendiente: '⬜',
  'sin-evaluar': '· ',
};

export interface Salida {
  lineas: string[];
  /** Paquetes que NO tienen todos sus criterios evaluados y en verde. */
  abiertos: string[];
}

/**
 * Abierto es todo lo que no está demostrado cerrado: un paquete con un criterio
 * en rojo y uno con un criterio que nadie sabe evaluar están, para quien depende
 * de él, en la misma situación.
 */
export const abiertosDe = (paquetes: Paquete[]): string[] =>
  paquetes.filter((p) => p.estado !== 'resuelto').map((p) => p.id);

/**
 * Un criterio que DECLARÓ necesitar algo del entorno y no pudo evaluarse.
 *
 * `Criterio.necesita` existía en el tipo desde el principio y el runner no lo
 * miraba nunca. La consecuencia salió cara: alguien escribió un criterio
 * correcto —el sello de un periodo, que sólo se puede comprobar contra
 * Postgres—, declaró `necesita: 'base-de-datos'`, y el job de CI que evalúa el
 * plan no tiene base. El criterio se reportó no evaluable, el paquete cayó a
 * 🟠, el trinquete lo leyó como retroceso y la CI se puso roja. Para
 * desatascarla hubo que BORRAR el criterio bueno.
 *
 * Un campo declarado que nadie honra es peor que un campo ausente: promete una
 * semántica y entrega otra.
 */
export const bloqueadoPorEntorno = (e: Evaluacion): boolean =>
  e.criterio.necesita !== undefined && e.resultado.estado === 'no-evaluable';

/**
 * Lo que el trinquete puede EXIGIR: paquetes abiertos por algo que este entorno
 * sí podía medir.
 *
 * Un criterio bloqueado por una precondición ausente no es una regresión del
 * código — es un instrumento que aquí no existe. Contarlo hace que el mismo
 * commit pase en una portátil con Postgres y falle en CI sin él, y una compuerta
 * que depende de dónde corre no es una compuerta. Se sigue MOSTRANDO en la
 * salida, con su causa: se ignora para exigir, nunca para informar.
 */
export const exigiblesAbiertos = (paquetes: Paquete[]): string[] =>
  paquetes
    .filter((p) => {
      const noVerdes = p.evaluaciones.filter((e) => e.resultado.estado !== 'ok');
      return noVerdes.length > 0 && !noVerdes.every(bloqueadoPorEntorno);
    })
    .map((p) => p.id);

// ============================================================
// EL TRINQUETE POR CRITERIO (S2)
//
// `--exigir` protege PAQUETES, y el estado de un paquete es el peor de sus
// criterios. La consecuencia, demostrada por la auditoría II con un archivo
// de prueba: un paquete YA abierto absorbe cualquier regresión interna sin
// mover el veredicto de CI. Diecisiete criterios verdes vivían así — entre
// ellos «ninguna herramienta del agente alcanza el mayor», que es una regla
// de la casa: la auditoría añadió un archivo que nombraba postJournalEntry,
// el criterio se puso rojo, y la misma línea de CI siguió saliendo con 0.
//
// El piso los nombra uno a uno. Tres direcciones, porque un trinquete que
// sólo mira una se vacía por las otras dos:
//   1. un criterio del piso que se pone rojo → falla (la regresión);
//   2. un criterio del piso cuyo enunciado ya no existe → falla (el
//      renombre que vaciaría la lista en silencio, la misma fuga que
//      `--exigir` ya tapó para paquetes);
//   3. un criterio verde de un paquete ABIERTO que no está en el piso →
//      falla (el piso sube en el mismo commit que gana el terreno, como el
//      suelo del catálogo).
//
// Los criterios de paquetes resueltos NO se listan: `--exigir` ya los cubre
// entero, y duplicarlos sería dos listas que se desincronizan.
// ============================================================

/** La identidad de un criterio: no hay id, así que es paquete + enunciado. */
export const identidadDe = (c: Criterio): string => `${c.paquete} · ${c.enunciado}`;

export interface VeredictoPiso {
  regresados: string[];
  desaparecidos: string[];
  sinProteger: string[];
}

export function compararConPiso(paquetes: Paquete[], piso: string[]): VeredictoPiso {
  const evaluaciones = paquetes.flatMap((p) => p.evaluaciones.map((e) => ({ paquete: p, ...e })));
  const porIdentidad = new Map(evaluaciones.map((e) => [identidadDe(e.criterio), e]));

  const regresados: string[] = [];
  const desaparecidos: string[] = [];
  for (const id of piso) {
    const e = porIdentidad.get(id);
    if (!e) {
      desaparecidos.push(id);
      continue;
    }
    // Un criterio bloqueado por el entorno no es una regresión del código:
    // misma semántica que --exigir, o la compuerta dependería de dónde corre.
    if (e.resultado.estado !== 'ok' && !bloqueadoPorEntorno(e)) regresados.push(id);
  }

  const enPiso = new Set(piso);
  const sinProteger = evaluaciones
    .filter((e) => e.resultado.estado === 'ok' && e.paquete.estado !== 'resuelto')
    .map((e) => identidadDe(e.criterio))
    .filter((id) => !enPiso.has(id));

  return { regresados, desaparecidos, sinProteger };
}

export function formatear(paquetes: Paquete[], stream: NodeJS.WriteStream): Salida {
  const p = palette(stream);
  const lineas: string[] = [];

  lineas.push(p.bold('Estado del plan, evaluado contra el código'));
  lineas.push('');

  for (const paq of paquetes) {
    const total = paq.evaluaciones.length;
    const cumplidos = paq.evaluaciones.filter((e) => e.resultado.estado === 'ok').length;
    lineas.push(
      `${MARCA[paq.estado]} ${p.bold(paq.id.padEnd(6))} ${p.dim(`${cumplidos}/${total} criterios`)}`
    );

    // Sólo se detalla lo que NO está en verde: una lista de aciertos es ruido
    // que esconde el único renglón que hay que leer.
    for (const { criterio, resultado } of paq.evaluaciones) {
      if (resultado.estado === 'ok') continue;
      const icono = resultado.estado === 'falla' ? p.red('✘') : p.dim('?');
      lineas.push(`     ${icono} ${criterio.enunciado}`);
      const nota = bloqueadoPorEntorno({ criterio, resultado })
        ? `  (necesita ${criterio.necesita}: no cuenta para --exigir aquí)`
        : '';
      lineas.push(`       ${p.dim(resultado.detalle + nota)}`);
    }
  }

  const resueltos = paquetes.filter((x) => x.estado === 'resuelto').length;
  const noEvaluables = paquetes.flatMap((x) => x.evaluaciones).filter((e) => e.resultado.estado === 'no-evaluable').length;

  lineas.push('');
  lineas.push(
    p.dim(
      `${resueltos} de ${paquetes.length} paquetes con todos sus criterios en verde` +
        (noEvaluables ? ` · ${noEvaluables} criterio(s) no evaluable(s)` : '')
    )
  );
  lineas.push(
    p.dim(
      'El estado de un paquete es el PEOR de sus criterios. Los criterios viven en ' +
        'src/plan/criterios.ts; el documento los cita, este comando los decide.'
    )
  );

  return { lineas, abiertos: abiertosDe(paquetes) };
}

const RUTA_PISO = 'docs/criterios-minimos.json';

function comprobarPiso(todos: Paquete[]): number {
  const ruta = path.resolve(__dirname, '..', '..', RUTA_PISO);
  if (!fs.existsSync(ruta)) {
    process.stderr.write(
      `\nNo existe ${RUTA_PISO}: el piso de criterios es el trinquete de los verdes que viven ` +
        'en paquetes abiertos, y sin archivo no protege a nadie.\n'
    );
    return 1;
  }
  const piso = (JSON.parse(fs.readFileSync(ruta, 'utf-8')) as { verdes?: string[] }).verdes ?? [];
  const { regresados, desaparecidos, sinProteger } = compararConPiso(todos, piso);

  if (desaparecidos.length > 0) {
    process.stderr.write(
      `\nEl piso nombra criterios que ya no existen:\n${desaparecidos.map((d) => `  · ${d}`).join('\n')}\n` +
        `Si reescribiste un enunciado, actualiza ${RUTA_PISO} en el MISMO commit: ` +
        'un renombre silencioso vacía el trinquete, que es la fuga que este piso viene a tapar.\n'
    );
    return 1;
  }
  if (regresados.length > 0) {
    process.stderr.write(
      `\nCriterios del piso que dejaron de estar en verde:\n${regresados.map((d) => `  · ${d}`).join('\n')}\n` +
        'Viven en paquetes abiertos, así que --exigir no los cubre: por eso el piso los nombra uno a uno.\n'
    );
    return 1;
  }
  if (sinProteger.length > 0) {
    process.stderr.write(
      `\nCriterios verdes en paquetes abiertos que el piso no protege:\n${sinProteger.map((d) => `  · ${d}`).join('\n')}\n` +
        `Añádelos a ${RUTA_PISO} en el MISMO commit que los pone en verde: el piso sólo sube, ` +
        'igual que el suelo del catálogo.\n'
    );
    return 1;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Un argumento suelto filtra por prefijo de paquete: `plan:status E0` o
  // `plan:status E2.1`. Es lo que hace citable un paquete desde el documento
  // sin copiar su estado a mano, que es exactamente lo que se desincronizó.
  const filtros = argv.filter((a) => !a.startsWith('-'));
  const todos = await evaluar();
  const paquetes = filtros.length
    ? todos.filter((p) => filtros.some((f) => p.id.startsWith(f)))
    : todos;

  if (paquetes.length === 0) {
    process.stderr.write(
      `Ningún paquete coincide con ${filtros.join(', ')}. Hay: ${todos.map((p) => p.id).join(', ')}\n`
    );
    return 1;
  }

  const { lineas } = formatear(paquetes, process.stdout);
  process.stdout.write(lineas.join('\n') + '\n');

  if (argv.includes('--piso')) {
    const codigo = comprobarPiso(todos);
    if (codigo !== 0) return codigo;
  }

  const exigir = argv
    .filter((a) => a.startsWith('--exigir='))
    .flatMap((a) => a.slice('--exigir='.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  if (exigir.length === 0) return 0;

  // UN PAQUETE QUE NO EXISTE NO ESTÁ CERRADO: NO SE SABE.
  //
  // `--exigir=E9.9` salía con 0 y en silencio, así que el trinquete se podía
  // vaciar sin ponerse rojo: bastaba borrar o renombrar un paquete en
  // criterios.ts para reabrir lo cerrado sin que la CI se enterara. El
  // instrumento vive en el mismo commit que el cambio que juzga, y ésa es
  // justo la regresión de la que nada lo protegía.
  const inexistentes = exigir.filter((id) => !todos.some((p) => p.id === id));
  if (inexistentes.length > 0) {
    process.stderr.write(
      `\nSe exigen paquetes que no existen: ${inexistentes.join(', ')}. ` +
        `Hay: ${todos.map((p) => p.id).join(', ')}.\n` +
        'Si se renombró o se borró un paquete, actualiza la lista de --exigir en el mismo commit.\n'
    );
    return 1;
  }

  // Contra TODOS los paquetes, no contra los que el filtro dejó a la vista:
  // `plan:status E0 --exigir=E1.3` no debe pasar por no haber mirado E1.3.
  const abiertos = exigiblesAbiertos(todos);
  const incumplidos = exigir.filter((id) => abiertos.includes(id));
  if (incumplidos.length > 0) {
    process.stderr.write(
      `\nSe exigían cerrados y están abiertos: ${incumplidos.join(', ')}\n`
    );
    return 1;
  }
  return 0;
}

// Entrypoint sólo cuando se ejecuta directamente, para que las pruebas puedan
// importar `evaluar` y `formatear` sin disparar el proceso.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`plan:status falló: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
