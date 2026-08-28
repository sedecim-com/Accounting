import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  abiertosDe,
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
  });

  it('rompe cuando se exige cerrado un paquete que está abierto', async () => {
    callar();
    // E1.3 es hoy el más rojo del tablero: ninguna de sus políticas se lee.
    expect(await main(['--exigir=E1.3'])).toBe(1);
  });

  it('el filtro no puede blanquear lo exigido', async () => {
    // `plan:status E0 --exigir=E1.3` miraba sólo E0, no encontraba E1.3 entre
    // lo abierto, y pasaba. Un trinquete que se apaga con un argumento no es
    // un trinquete.
    callar();
    expect(await main(['E0', '--exigir=E1.3'])).toBe(1);
  });

  it('avisa cuando el filtro no coincide con nada, en vez de imprimir vacío', async () => {
    callar();
    expect(await main(['E9'])).toBe(1);
  });
});

describe('abiertosDe', () => {
  it('cuenta como abierto todo lo que no está demostrado cerrado', () => {
    const p = (id: string, estado: EstadoPaquete): Paquete => ({ id, estado, evaluaciones: [] });
    expect(
      abiertosDe([p('A', 'resuelto'), p('B', 'parcial'), p('C', 'no-demostrado'), p('D', 'sin-evaluar')])
    ).toEqual(['B', 'C', 'D']);
  });
});
