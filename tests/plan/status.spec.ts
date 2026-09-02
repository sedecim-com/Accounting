import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  abiertosDe,
  bloqueadoPorEntorno,
  exigiblesAbiertos,
  estadoDe,
  evaluar,
  formatear,
  main,
  type EstadoPaquete,
  type Evaluacion,
  type Paquete,
} from '../../src/plan/status.js';
import { ok, falla, noEvaluable, type Criterio } from '../../src/plan/criterios.js';

// ============================================================
// El runner del estado del plan.
//
// Estas pruebas fijan lo que se aprendió en la PRIMERA corrida, cuando el
// comando todavía se creía a sí mismo:
//
//   · marcó E0.2 en verde con un criterio que nadie pudo evaluar;
//   · se acusó a sí mismo, porque su archivo de criterios contiene los
//     patrones que persigue.
//
// Un comando que se equivoca en su estreno no se vuelve a abrir, así que lo
// que aquí se prueba no es el formato: es que no pueda volver a mentir.
// ============================================================

const ev = (paquete: string, resultado: ReturnType<typeof ok>): Evaluacion => ({
  criterio: { paquete, enunciado: `criterio de ${paquete}`, evaluar: () => resultado },
  resultado,
});

describe('estadoDe — un hueco no es un acierto', () => {
  it('no declara resuelto un paquete con un criterio no evaluable', () => {
    const estado = estadoDe([ev('X', ok('cumple')), ev('X', noEvaluable('falta el escáner'))]);
    expect(estado).toBe('no-demostrado');
    expect(estado).not.toBe('resuelto');
  });

  it('declara resuelto sólo cuando TODOS los criterios pasaron', () => {
    expect(estadoDe([ev('X', ok('a')), ev('X', ok('b'))])).toBe('resuelto');
  });

  it('un solo rojo abre el paquete por mucho verde que lo acompañe', () => {
    const nueve = Array.from({ length: 9 }, () => ev('X', ok('cumple')));
    expect(estadoDe([...nueve, ev('X', falla('no cumple'))])).toBe('parcial');
  });

  it('sin ningún verde el paquete está pendiente, no parcial', () => {
    expect(estadoDe([ev('X', falla('a')), ev('X', falla('b'))])).toBe('pendiente');
  });

  it('sin nada evaluable lo dice, en vez de inventar un color', () => {
    expect(estadoDe([ev('X', noEvaluable('sin base de datos'))])).toBe('sin-evaluar');
  });
});

describe('evaluar — un criterio roto no se cuenta como cumplido', () => {
  it('convierte la excepción en no-evaluable, con la causa', async () => {
    const explota: Criterio = {
      paquete: 'X',
      enunciado: 'lee un archivo que no existe',
      evaluar: () => {
        throw new Error('ENOENT: no such file');
      },
    };
    const [paq] = await evaluar([explota]);
    expect(paq.estado).toBe('sin-evaluar');
    expect(paq.evaluaciones[0].resultado.estado).toBe('no-evaluable');
    expect(paq.evaluaciones[0].resultado.detalle).toContain('ENOENT');
  });

  it('agrupa por paquete y ordena, para que la salida no baile entre corridas', async () => {
    const c = (paquete: string): Criterio => ({ paquete, enunciado: paquete, evaluar: () => ok('ok') });
    const paqs = await evaluar([c('E2.1'), c('E0.1'), c('E2.1'), c('E1.1')]);
    expect(paqs.map((p) => p.id)).toEqual(['E0.1', 'E1.1', 'E2.1']);
    expect(paqs[2].evaluaciones).toHaveLength(2);
  });
});

describe('formatear — la salida sirve para actuar', () => {
  const plano = { isTTY: false } as NodeJS.WriteStream;

  it('detalla lo que falla y calla lo que pasa', async () => {
    const paqs = await evaluar([
      { paquete: 'X', enunciado: 'esto pasa', evaluar: () => ok('sin novedad') },
      { paquete: 'X', enunciado: 'esto no', evaluar: () => falla('falta el escritor') },
    ]);
    const texto = formatear(paqs, plano).lineas.join('\n');
    expect(texto).toContain('esto no');
    expect(texto).toContain('falta el escritor');
    expect(texto).not.toContain('sin novedad');
  });

  it('nombra la comprobación que falla, no un porcentaje', async () => {
    const paqs = await evaluar([
      { paquete: 'X', enunciado: 'la depreciación tiene puerta', evaluar: () => falla('sin llamador') },
    ]);
    expect(formatear(paqs, plano).lineas.join('\n')).toContain('la depreciación tiene puerta');
  });

  it('cuenta como abierto lo no demostrado, no sólo lo que está en rojo', async () => {
    const paqs = await evaluar([
      { paquete: 'X', enunciado: 'a', evaluar: () => ok('bien') },
      { paquete: 'X', enunciado: 'b', evaluar: () => noEvaluable('no hay con qué medirlo') },
    ]);
    expect(formatear(paqs, plano).abiertos).toEqual(['X']);
  });
});

describe('main — la compuerta de CI', () => {
  /**
   * CADA CASO DE ESTE BLOQUE EVALÚA EL ÁRBOL ENTERO.
   *
   * `main` no simula nada: corre los quince paquetes de criterios de verdad
   * sobre el repositorio —subproceso y socket incluidos—, que es lo que les da
   * valor: un trinquete probado contra un doble no prueba el trinquete. El
   * precio es que su costo CRECE CON EL PROYECTO, y el timeout por omisión de
   * vitest (5 s) nunca se eligió pensando en ellos.
   *
   * El primero de los seis ya llevaba su propio `{ timeout: 30_000 }` con esta
   * misma razón escrita al lado. Le faltaban las cinco hermanas: el arreglo se
   * aplicó al caso que falló y no a su clase, así que el problema volvió por el
   * siguiente que cruzara los cinco segundos. Ahora el presupuesto es del
   * bloque y no de un caso.
   *
   * Ya alcanzó: en CI un caso tardó 5 042 ms y rompió el build por 42
   * milisegundos, sin que nada estuviera mal. Medido en local hoy: entre 2,5 y
   * 3,6 s por caso; CI es del orden del doble de lento.
   *
   * El presupuesto va explícito y holgado, no ajustado a la medición de hoy:
   * un margen corto vuelve a caducar con el siguiente tramo y el rojo que
   * produce no dice nada del código. Sigue siendo un tope, no una barra libre
   * — si uno de éstos llega a 30 s, algo se colgó de verdad y hay que mirarlo.
   */
  const PRESUPUESTO = 30_000;

  const callar = () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sin --exigir informa y no rompe el build: un paquete abierto es información', async () => {
    callar();
    expect(await main([])).toBe(0);
  }, PRESUPUESTO);

  it('rompe cuando se exige cerrado un paquete que está abierto', async () => {
    callar();
    // F02 puso E1.3 en verde (todas las políticas ganaron lector): el rojo
    // de guardia pasa a E3.2 — la descarga masiva del SAT, bloqueada por la
    // e.firma real, el rojo más longevo del tablero.
    expect(await main(['--exigir=E3.2'])).toBe(1);
  }, PRESUPUESTO);

  it('el filtro no puede blanquear lo exigido', async () => {
    // `plan:status E0 --exigir=E3.2` miraba sólo E0, no encontraba E3.2 entre
    // lo abierto, y pasaba. Un trinquete que se apaga con un argumento no es
    // un trinquete.
    callar();
    expect(await main(['E0', '--exigir=E3.2'])).toBe(1);
  }, PRESUPUESTO);

  it('un paquete exigido que NO EXISTE rompe, en vez de pasar en silencio', async () => {
    // El trinquete se podía vaciar sin ponerse rojo: bastaba borrar o
    // renombrar un paquete en criterios.ts para reabrir lo cerrado, porque
    // --exigir ignoraba los ids desconocidos. El instrumento vive en el mismo
    // commit que el cambio que juzga, y nada lo protegía de eso.
    callar();
    expect(await main(['--exigir=E9.9'])).toBe(1);
  }, PRESUPUESTO);

  it('lo detecta aunque venga mezclado con paquetes que sí existen y están verdes', async () => {
    callar();
    expect(await main(['--exigir=E0.0,E9.9'])).toBe(1);
  }, PRESUPUESTO);

  it('avisa cuando el filtro no coincide con nada, en vez de imprimir vacío', async () => {
    callar();
    expect(await main(['E9'])).toBe(1);
  }, PRESUPUESTO);
});

describe('abiertosDe', () => {
  it('cuenta como abierto todo lo que no está demostrado cerrado', () => {
    const p = (id: string, estado: EstadoPaquete): Paquete => ({ id, estado, evaluaciones: [] });
    expect(
      abiertosDe([p('A', 'resuelto'), p('B', 'parcial'), p('C', 'no-demostrado'), p('D', 'sin-evaluar')])
    ).toEqual(['B', 'C', 'D']);
  });
});

/**
 * `Criterio.necesita` vivió en el tipo sin que el runner lo mirara nunca, y la
 * factura llegó entera: alguien escribió un criterio correcto —el sello de un
 * periodo, que sólo se comprueba contra Postgres—, declaró
 * `necesita: 'base-de-datos'`, y el job de CI que evalúa el plan no tiene base.
 * El criterio salió no evaluable, el paquete cayó a 🟠, el trinquete lo leyó
 * como retroceso y la CI se puso roja. Para desatascarla hubo que BORRAR el
 * criterio bueno.
 *
 * Un campo declarado que nadie honra promete una semántica y entrega otra.
 */
describe('criterios que declaran necesitar algo del entorno', () => {
  const paquete = (evaluaciones: Evaluacion[]): Paquete => ({
    id: 'E0.1',
    estado: estadoDe(evaluaciones),
    evaluaciones,
  });
  const conNecesidad = (resultado: ReturnType<typeof ok>): Evaluacion => ({
    criterio: {
      paquete: 'E0.1',
      enunciado: 'el sello de un periodo abarca el periodo entero',
      necesita: 'base-de-datos',
      evaluar: () => resultado,
    },
    resultado,
  });
  const simple = (resultado: ReturnType<typeof ok>): Evaluacion => ({
    criterio: { paquete: 'E0.1', enunciado: 'algo que se mide leyendo el código', evaluar: () => resultado },
    resultado,
  });

  it('no cuenta para --exigir cuando su precondición falta', () => {
    // Es el caso literal que rompió la CI: tres verdes y uno sin base de datos.
    const p = paquete([simple(ok('a')), simple(ok('b')), simple(ok('c')), conNecesidad(noEvaluable('ECONNREFUSED'))]);
    expect(exigiblesAbiertos([p])).toEqual([]);
  });

  it('pero SIGUE abierto para informar: se ignora al exigir, nunca al contar', () => {
    const p = paquete([simple(ok('a')), conNecesidad(noEvaluable('ECONNREFUSED'))]);
    expect(p.estado).toBe('no-demostrado');
    expect(abiertosDe([p])).toEqual(['E0.1']);
  });

  it('un hueco SIN declarar sigue rompiendo el trinquete', () => {
    // La excepción es para lo que el entorno no puede medir, no para lo que
    // nadie supo escribir. Si valiera para los dos, bastaría no evaluar nada.
    const p = paquete([simple(ok('a')), simple(noEvaluable('no supe cómo medirlo'))]);
    expect(exigiblesAbiertos([p])).toEqual(['E0.1']);
  });

  it('un rojo de verdad rompe el trinquete aunque lo acompañe uno bloqueado', () => {
    const p = paquete([simple(falla('esto sí está roto')), conNecesidad(noEvaluable('ECONNREFUSED'))]);
    expect(exigiblesAbiertos([p])).toEqual(['E0.1']);
  });

  it('si la precondición SÍ está, el criterio se juzga como cualquier otro', () => {
    // Con Postgres delante devuelve falla, no no-evaluable, y entonces cuenta.
    const p = paquete([conNecesidad(falla('el sello cubre medio periodo'))]);
    expect(exigiblesAbiertos([p])).toEqual(['E0.1']);
  });

  it('bloqueadoPorEntorno exige LAS DOS cosas: la declaración y el no-evaluable', () => {
    expect(bloqueadoPorEntorno(conNecesidad(noEvaluable('x')))).toBe(true);
    expect(bloqueadoPorEntorno(conNecesidad(ok('x')))).toBe(false);
    expect(bloqueadoPorEntorno(simple(noEvaluable('x')))).toBe(false);
  });

  it('la salida dice por qué no cuenta, para que no parezca un verde regalado', () => {
    const plano = { isTTY: false } as NodeJS.WriteStream;
    const texto = formatear([paquete([conNecesidad(noEvaluable('ECONNREFUSED'))])], plano).lineas.join('\n');
    expect(texto).toContain('necesita base-de-datos');
    expect(texto).toContain('no cuenta para --exigir');
  });
});
