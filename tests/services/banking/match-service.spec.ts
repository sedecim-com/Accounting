import { describe, it, expect } from 'vitest';
import {
  asignarGrupo,
  cuadrarGrupo,
  exigirCuadre,
  exigirSinRepetidos,
  medirSenales,
  signoDe,
  MOTIVOS_DESAPLICACION,
  type AjusteDeGrupo,
  type ImporteDeGrupo,
} from '../../../src/services/banking/match-service.js';

/**
 * LA ARITMÉTICA DEL GRUPO, SIN POSTGRES DETRÁS.
 *
 * Es la razón entera de que el cuadre y el reparto sean funciones puras. Cada
 * caso de aquí —el pago corto por comisión, el depósito que agrupa tres
 * cobros, la parcialidad que deja un residual de un centavo, el descuadre que
 * sólo aparece en el cuarto decimal— habría necesitado sembrar una entidad,
 * una cuenta bancaria, tres movimientos y sus asientos para preguntar algo que
 * es una resta. Escritos así cuestan cuatro líneas.
 *
 * El caso del cuarto decimal está aquí por historia: en F05a se cazaron tres
 * defectos por presentar a dos decimales lo que la columna guarda con cuatro.
 */

const banco = (id: string, importe: string): ImporteDeGrupo => ({ id, importe });
const libro = (id: string, importe: string): ImporteDeGrupo => ({ id, importe });
const ajuste = (concepto: string, importe: string): AjusteDeGrupo => ({ concepto, importe });

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('cuadrarGrupo', () => {
  it('cuadra el 1:1 exacto y deja la diferencia en cero', () => {
    const c = cuadrarGrupo([banco('b1', '1160.0000')], [libro('l1', '1160.0000')]);
    expect(c).toEqual({
      totalBanco: '1160.0000',
      totalLibros: '1160.0000',
      totalAjustes: '0.0000',
      diferencia: '0.0000',
      cuadra: true,
    });
  });

  it('cuadra el depósito que agrupa tres cobros (1:N)', () => {
    const c = cuadrarGrupo(
      [banco('b1', '3000.0000')],
      [libro('l1', '1000.0000'), libro('l2', '1200.0000'), libro('l3', '800.0000')]
    );
    expect(c.cuadra).toBe(true);
    expect(c.totalLibros).toBe('3000.0000');
  });

  it('cuadra el pago corto por comisión cuando la comisión se declara como ajuste', () => {
    // El banco cargó 5000; el proveedor cobró 4950 y 50 fueron comisión.
    const c = cuadrarGrupo(
      [banco('b1', '-5000.0000')],
      [libro('l1', '-4950.0000')],
      [ajuste('comision-spei', '-50.0000')]
    );
    expect(c.cuadra).toBe(true);
    expect(c.totalAjustes).toBe('-50.0000');
  });

  it('no esconde un descuadre que sólo vive en el cuarto decimal', () => {
    const c = cuadrarGrupo([banco('b1', '100.0001')], [libro('l1', '100.0000')]);
    expect(c.cuadra).toBe(false);
    expect(c.diferencia).toBe('0.0001');
  });

  it('suma sin el ruido de la coma flotante', () => {
    const c = cuadrarGrupo(
      [banco('b1', '0.3000')],
      [libro('l1', '0.1000'), libro('l2', '0.2000')]
    );
    expect(c.cuadra).toBe(true);
    expect(c.totalLibros).toBe('0.3000');
  });

  it('conserva el signo de la diferencia: dice de qué lado falta', () => {
    const faltaEnLibros = cuadrarGrupo([banco('b1', '1000.0000')], [libro('l1', '900.0000')]);
    expect(faltaEnLibros.diferencia).toBe('100.0000');

    const sobraEnLibros = cuadrarGrupo([banco('b1', '900.0000')], [libro('l1', '1000.0000')]);
    expect(sobraEnLibros.diferencia).toBe('-100.0000');
  });

  it('un grupo vacío de los dos lados cuadra en cero', () => {
    expect(cuadrarGrupo([], []).cuadra).toBe(true);
  });
});

describe('exigirCuadre', () => {
  it('acepta el grupo que cuadra y deja el residual en cero', () => {
    const c = cuadrarGrupo([banco('b1', '500.0000')], [libro('l1', '500.0000')]);
    expect(exigirCuadre(c)).toEqual({ residual: '0.0000', modo: 'keep', cuentaWriteOff: null });
  });

  it('rechaza el descuadre no declarado NOMBRANDO los tres números y la diferencia', () => {
    const c = cuadrarGrupo(
      [banco('b1', '1000.0000')],
      [libro('l1', '900.0000')],
      [ajuste('comision', '25.0000')]
    );
    expect(() => exigirCuadre(c)).toThrowError(/1000\.0000/);
    expect(() => exigirCuadre(c)).toThrowError(/900\.0000/);
    expect(() => exigirCuadre(c)).toThrowError(/25\.0000/);
    expect(() => exigirCuadre(c)).toThrowError(/75\.0000/);
  });

  it('deja vivo el residual declarado como keep', () => {
    const c = cuadrarGrupo([banco('b1', '1000.0000')], [libro('l1', '999.9900')]);
    expect(exigirCuadre(c, { modo: 'keep' })).toEqual({
      residual: '0.0100',
      modo: 'keep',
      cuentaWriteOff: null,
    });
  });

  it('rechaza write-off sin cuenta ANTES de que lo haga el CHECK de la 052', () => {
    const c = cuadrarGrupo([banco('b1', '1000.0000')], [libro('l1', '999.0000')]);
    expect(() => exigirCuadre(c, { modo: 'write-off' })).toThrowError(/--write-off-account/);
  });

  it('acepta write-off con cuenta y guarda la cuenta', () => {
    const c = cuadrarGrupo([banco('b1', '1000.0000')], [libro('l1', '999.0000')]);
    expect(exigirCuadre(c, { modo: 'write-off', cuentaWriteOff: 'cta-7' })).toEqual({
      residual: '1.0000',
      modo: 'write-off',
      cuentaWriteOff: 'cta-7',
    });
  });

  it('rechaza una cuenta de cancelación sobre un residual que se conserva', () => {
    const c = cuadrarGrupo([banco('b1', '1000.0000')], [libro('l1', '999.0000')]);
    expect(() => exigirCuadre(c, { modo: 'keep', cuentaWriteOff: 'cta-7' }))
      .toThrowError(/sólo tiene sentido con --residual write-off/);
  });

  it('rechaza el write-off que no cancela nada', () => {
    const c = cuadrarGrupo([banco('b1', '500.0000')], [libro('l1', '500.0000')]);
    expect(() => exigirCuadre(c, { modo: 'write-off', cuentaWriteOff: 'cta-7' }))
      .toThrowError(/no hay nada que cancelar/);
  });

  it('un descuadre negativo también se declara, y conserva su signo', () => {
    const c = cuadrarGrupo([banco('b1', '900.0000')], [libro('l1', '1000.0000')]);
    expect(exigirCuadre(c, { modo: 'keep' }).residual).toBe('-100.0000');
  });
});

describe('asignarGrupo', () => {
  it('reparte el 1:1 sin marcarlo parcial', () => {
    const a = asignarGrupo([banco('b1', '1160.0000')], [libro('l1', '1160.0000')]);
    expect(a).toEqual([
      { bancoId: 'b1', librosId: 'l1', importe: '1160.0000', parcial: false },
    ]);
  });

  it('reparte un depósito contra tres facturas y marca las tres parciales', () => {
    const a = asignarGrupo(
      [banco('b1', '3000.0000')],
      [libro('l1', '1000.0000'), libro('l2', '1200.0000'), libro('l3', '800.0000')]
    );
    expect(a.map((x) => x.importe)).toEqual(['1000.0000', '1200.0000', '800.0000']);
    // Ninguna asignación agota el movimiento de banco, así que las tres son
    // parciales: `is_partial` lleva desde la 003 esperando este caso.
    expect(a.every((x) => x.parcial)).toBe(true);
    expect(a.every((x) => x.bancoId === 'b1')).toBe(true);
  });

  it('reparte tres cargos contra una sola partida (N:1)', () => {
    const a = asignarGrupo(
      [banco('b1', '-100.0000'), banco('b2', '-200.0000'), banco('b3', '-300.0000')],
      [libro('l1', '-600.0000')]
    );
    expect(a.map((x) => [x.bancoId, x.importe])).toEqual([
      ['b1', '100.0000'],
      ['b2', '200.0000'],
      ['b3', '300.0000'],
    ]);
    expect(a.every((x) => x.parcial)).toBe(true);
  });

  it('parte una asignación cuando el corte no coincide (N:M)', () => {
    const a = asignarGrupo(
      [banco('b1', '500.0000'), banco('b2', '500.0000')],
      [libro('l1', '300.0000'), libro('l2', '700.0000')]
    );
    expect(a).toEqual([
      { bancoId: 'b1', librosId: 'l1', importe: '300.0000', parcial: true },
      { bancoId: 'b1', librosId: 'l2', importe: '200.0000', parcial: true },
      { bancoId: 'b2', librosId: 'l2', importe: '500.0000', parcial: true },
    ]);
  });

  it('el pago corto por comisión deja la asignación en el importe de libros', () => {
    const a = asignarGrupo([banco('b1', '-5000.0000')], [libro('l1', '-4950.0000')]);
    expect(a).toEqual([
      { bancoId: 'b1', librosId: 'l1', importe: '4950.0000', parcial: true },
    ]);
  });

  it('deja sin asignación al movimiento que ninguna partida alcanza', () => {
    // El servicio rechaza este grupo antes de escribir: un movimiento marcado
    // como cotejado sin fila que lo explique es invisible a la vez para
    // «no cotejados» y para «cotejados».
    const a = asignarGrupo(
      [banco('b1', '-1000.0000'), banco('b2', '-50.0000')],
      [libro('l1', '-1000.0000')]
    );
    expect(a.map((x) => x.bancoId)).toEqual(['b1']);
  });

  it('no fabrica filas de importe cero', () => {
    const a = asignarGrupo([banco('b1', '0.0000'), banco('b2', '100.0000')], [libro('l1', '100.0000')]);
    expect(a).toEqual([
      { bancoId: 'b2', librosId: 'l1', importe: '100.0000', parcial: false },
    ]);
  });
});

describe('medirSenales', () => {
  it('el importe exacto es la señal dura', () => {
    const s = medirSenales(
      '-1160.0000', d('2026-03-10'), 'PAGO PROVEEDOR ACME',
      '-1160.0000', d('2026-03-10'), 'Gasto ACME'
    );
    expect(s.importeExacto).toBe(true);
    expect(s.senalDura).toBe(true);
    expect(s.diasDeDiferencia).toBe(0);
    expect(s.mismaDireccion).toBe(true);
  });

  it('el 5 % que la regla difusa absorbe en silencio NO es señal dura', () => {
    const s = medirSenales(
      '-1000.0000', d('2026-03-10'), 'PAGO ACME SA DE CV',
      '-960.0000', d('2026-03-10'), 'PAGO ACME SA DE CV'
    );
    expect(s.diferenciaImporte).toBe('-40.0000');
    expect(s.importeExacto).toBe(false);
    expect(s.senalDura).toBe(false);
  });

  it('una descripción idéntica sola no vuelve dura la señal', () => {
    const s = medirSenales(
      '-1000.0000', d('2026-03-10'), 'TRANSFERENCIA ACME',
      '-1500.0000', d('2026-03-25'), 'TRANSFERENCIA ACME'
    );
    expect(s.similitudDescripcion).toBeGreaterThan(0.9);
    expect(s.senalDura).toBe(false);
  });

  it('distingue la dirección: un depósito no coteja contra una salida', () => {
    const s = medirSenales(
      '1160.0000', d('2026-03-10'), 'DEPOSITO',
      '-1160.0000', d('2026-03-10'), 'PAGO'
    );
    expect(s.mismaDireccion).toBe(false);
  });

  it('cuenta los días y marca la ventana de tres', () => {
    expect(medirSenales('100.0000', d('2026-03-10'), null, '100.0000', d('2026-03-13'), null)
      .dentroDeVentana).toBe(true);
    expect(medirSenales('100.0000', d('2026-03-10'), null, '100.0000', d('2026-03-14'), null)
      .dentroDeVentana).toBe(false);
    expect(medirSenales('100.0000', d('2026-03-14'), null, '100.0000', d('2026-03-10'), null)
      .diasDeDiferencia).toBe(4);
  });

  it('una descripción ausente no inventa parecido', () => {
    const s = medirSenales('100.0000', d('2026-03-10'), null, '100.0000', d('2026-03-10'), null);
    expect(s.similitudDescripcion).toBe(0);
    expect(s.senalDura).toBe(true);
  });
});

describe('exigirSinRepetidos', () => {
  it('deja pasar los ids distintos', () => {
    expect(() => exigirSinRepetidos(['a', 'b', 'c'], 'movimiento de banco')).not.toThrow();
  });

  it('rechaza el id repetido, que haría cuadrar el grupo por el doble', () => {
    // Sin este guardia: banco [b1, b1] suma 2000 contra libros de 2000, y el
    // cuadre daría por buena una aseveración sobre un movimiento que no existe.
    const c = cuadrarGrupo(
      [banco('b1', '1000.0000'), banco('b1', '1000.0000')],
      [libro('l1', '2000.0000')]
    );
    expect(c.cuadra).toBe(true);
    expect(() => exigirSinRepetidos(['b1', 'b1'], 'movimiento de banco'))
      .toThrowError(/aparece dos veces/);
  });
});

describe('signoDe', () => {
  it('factura y cobro entran; gasto y pago salen', () => {
    expect(signoDe('invoice')).toBe(1);
    expect(signoDe('customer_payment')).toBe(1);
    expect(signoDe('bill')).toBe(-1);
    expect(signoDe('vendor_payment')).toBe(-1);
  });
});

describe('MOTIVOS_DESAPLICACION', () => {
  it('caben todos en la columna de 40 caracteres de la 052', () => {
    for (const motivo of MOTIVOS_DESAPLICACION) {
      expect(motivo.length).toBeLessThanOrEqual(40);
    }
  });

  it('son códigos y no prosa: sin espacios ni mayúsculas', () => {
    for (const motivo of MOTIVOS_DESAPLICACION) {
      expect(motivo).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
  });
});
