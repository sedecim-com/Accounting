import { describe, it, expect } from 'vitest';

import { ExitCode, batchExitCode } from '../../../src/cli/kernel/exit.js';
import { exitCodeFor } from '../../../src/cli/kernel/index.js';
import {
  AppError,
  ExternalRejectedError,
  ExternalServiceError,
  NotFoundError,
} from '../../../src/utils/errors.js';

// ============================================================
// EL ENTERO CON QUE MUERE EL PROCESO, EN LA MITAD EXTERNA
//
// El contrato vende dos códigos que un guion PUEDE actuar:
//   8  el servicio externo falló  → reintenta
//   9  el servicio externo rechazó → no reintentes NUNCA a ciegas
//
// Estaban publicados en exit.ts y en docs/cli-command-registry.md desde
// el primer día, y ninguno de los dos ocurría por el camino del CLI:
//   · el mapa 502/503/504 → 8 existía, pero NINGUNA clase de error del
//     árbol llevaba esos estados, así que la fila era decorado; y
//   · el 9 no tenía ni mapa ni productor: cero en todo el árbol.
// Todo fallo externo salía por el 1 genérico, y un cron no podía
// distinguir «la red se cayó» de «tu credencial no vale».
//
// Esta batería fija las dos mitades del arreglo: la TRADUCCIÓN (qué
// entero sale de cada clase) y la COMPOSICIÓN (qué entero saca un lote
// que siguió adelante tras cada fallo). La conducta de punta a punta
// —que el proceso SALGA con ese número— la fija la batería de hojas.
// ============================================================

describe('la traducción: cada clase externa llega a su entero del contrato', () => {
  it('un fallo transitorio sale 8 (reintentable)', () => {
    const err = new ExternalServiceError('contalink', 'HTTP 503 at /x');
    expect(err.statusCode).toBe(502);
    expect(exitCodeFor(err)).toBe(ExitCode.EXTERNAL_FAILED);
  });

  it('un rechazo definitivo sale 9 (jamás reintentable a ciegas)', () => {
    const err = new ExternalRejectedError('contalink', 'rejected the operation at /x: RFC no autorizado');
    expect(err.statusCode).toBe(424);
    expect(exitCodeFor(err)).toBe(ExitCode.EXTERNAL_REJECTED);
  });

  it('ambas nombran al proveedor en el mensaje y lo llevan en el detalle', () => {
    const fallo = new ExternalServiceError('contalink', 'unreachable at /x: fetch failed');
    const rechazo = new ExternalRejectedError('sat', 'HTTP 403 at /y');
    expect(fallo.message).toBe('contalink: unreachable at /x: fetch failed');
    expect(rechazo.message).toBe('sat: HTTP 403 at /y');
    expect(fallo.details).toMatchObject({ provider: 'contalink' });
    expect(rechazo.details).toMatchObject({ provider: 'sat' });
  });

  // El mapa se prueba por el ESTADO, no sólo por la clase: así el mutante
  // que borra la fila 424 (o las 502/503/504) se pone rojo aunque las
  // clases sigan existiendo intactas.
  it('el mapa de estados sigue abriendo las dos puertas, venga la clase que venga', () => {
    for (const status of [502, 503, 504]) {
      expect(exitCodeFor(new AppError(status, 'X', 'y')), `${status}`).toBe(ExitCode.EXTERNAL_FAILED);
    }
    expect(exitCodeFor(new AppError(424, 'X', 'y'))).toBe(ExitCode.EXTERNAL_REJECTED);
  });

  // La conversión sigue siendo segura por construcción: lo que no es
  // externo no se contagia de los códigos nuevos.
  it('nada más se mueve: 404 sigue en 3 y un Error pelado sigue en 1', () => {
    expect(exitCodeFor(new NotFoundError('CFDI', 'x'))).toBe(ExitCode.NOT_FOUND);
    expect(exitCodeFor(new Error('boom'))).toBe(ExitCode.FAILURE);
  });
});

// ── La composición ───────────────────────────────────────────────────
//
// `outbox run <ids>` es la hoja que llama un cron, y no puede lanzar:
// tiene que intentar TODOS los ids. Así que su código se compone. Antes
// se componía como `failed > 0 ? 1 : 0` — un literal que ningún censo de
// `shutdown(1)` veía, y que tiraba la única distinción que el contrato
// vende.
describe('la composición: el veredicto de un lote que siguió adelante', () => {
  it('sin fallos, 0', () => {
    expect(batchExitCode([])).toBe(ExitCode.OK);
  });

  it('todo transitorio → 8: el lote entero merece otra pasada', () => {
    expect(batchExitCode([ExitCode.EXTERNAL_FAILED, ExitCode.EXTERNAL_FAILED]))
      .toBe(ExitCode.EXTERNAL_FAILED);
  });

  it('todo rechazo → 9: repetirlo es quemar peticiones para siempre', () => {
    expect(batchExitCode([ExitCode.EXTERNAL_REJECTED, ExitCode.EXTERNAL_REJECTED]))
      .toBe(ExitCode.EXTERNAL_REJECTED);
  });

  // La regla que decide el caso mixto, y la razón por la que se decide
  // así: reintentar el lote vuelve a intentar el que PODRÍA salir, y no
  // vuelve a llamar al rechazado (ya no está `pending`, su estado lo
  // rechaza sin una segunda llamada). Lo caro es lo contrario: dar 9 a
  // un lote con una operación viva la dejaría sin reintento nunca.
  it('mezcla → 8: lo reintentable domina', () => {
    expect(batchExitCode([ExitCode.EXTERNAL_REJECTED, ExitCode.EXTERNAL_FAILED]))
      .toBe(ExitCode.EXTERNAL_FAILED);
    expect(batchExitCode([ExitCode.EXTERNAL_FAILED, ExitCode.EXTERNAL_REJECTED]))
      .toBe(ExitCode.EXTERNAL_FAILED);
  });

  it('un fallo que no es externo no se disfraza de externo: sale 1', () => {
    expect(batchExitCode([ExitCode.FAILURE])).toBe(ExitCode.FAILURE);
    expect(batchExitCode([ExitCode.EXTERNAL_REJECTED, ExitCode.NOT_FOUND])).toBe(ExitCode.FAILURE);
  });
});
