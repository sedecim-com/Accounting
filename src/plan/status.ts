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
      lineas.push(`       ${p.dim(resultado.detalle)}`);
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
  const abiertos = abiertosDe(todos);
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
