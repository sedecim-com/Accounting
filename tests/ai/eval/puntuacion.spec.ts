import { describe, it, expect } from 'vitest';
import {
  puntuarCaso,
  agregarPuntuaciones,
  inferirTratamiento,
  type ObservadoCaso,
} from '../../../src/ai/eval/puntuacion.js';
import type { EsperadoGolden } from '../../../src/ai/eval/golden.js';

const ESPERADO_PPD: EsperadoGolden = {
  caso: 'ppd',
  resultado: 'draft',
  tratamiento: 'PPD',
  sospecha: false,
  asiento: [
    { cuenta: ['6100'], lado: 'cargo', monto: '12000.00' },
    { cuenta: ['1135'], lado: 'cargo', monto: '1920.00' },
    { cuenta: ['2110'], lado: 'abono', monto: '13920.00' },
  ],
  nota: '',
};

const OBSERVADO_PERFECTO: ObservadoCaso = {
  resultado: 'draft',
  confianza: 0.93,
  lineas: [
    { cuenta: '6100', lado: 'cargo', monto: '12000.00' },
    { cuenta: '1135', lado: 'cargo', monto: '1920.00' },
    { cuenta: '2110', lado: 'abono', monto: '13920.00' },
  ],
};

describe('inferirTratamiento', () => {
  it('PPD por 1135 o por abono a proveedores; PUE por 1130 más abono a banco', () => {
    expect(inferirTratamiento(OBSERVADO_PERFECTO.lineas!)).toBe('PPD');
    expect(
      inferirTratamiento([
        { cuenta: '6100', lado: 'cargo', monto: '100' },
        { cuenta: '1130', lado: 'cargo', monto: '16' },
        { cuenta: '1111', lado: 'abono', monto: '116' },
      ])
    ).toBe('PUE');
  });

  it('un asiento con señales de los dos regímenes es indefinido, no una adivinanza', () => {
    expect(
      inferirTratamiento([
        { cuenta: '1130', lado: 'cargo', monto: '16' },
        { cuenta: '1135', lado: 'cargo', monto: '16' },
        { cuenta: '1110', lado: 'abono', monto: '16' },
        { cuenta: '2110', lado: 'abono', monto: '16' },
      ])
    ).toBeNull();
  });
});

describe('puntuarCaso', () => {
  it('el caso perfecto acierta todas sus clases y no deja fallas', () => {
    const p = puntuarCaso(ESPERADO_PPD, OBSERVADO_PERFECTO);
    expect(p.fallas).toEqual([]);
    expect(p.clases.resultado).toEqual({ aciertos: 1, total: 1 });
    expect(p.clases.cuentas).toEqual({ aciertos: 3, total: 3 });
    expect(p.clases.montos).toEqual({ aciertos: 3, total: 3 });
    expect(p.clases.tratamiento).toEqual({ aciertos: 1, total: 1 });
    // Clases que no aplican NO aparecen: sospecha/abstención sólo donde el esperado las pide.
    expect(p.clases.sospecha).toBeUndefined();
    expect(p.clases.abstencion).toBeUndefined();
  });

  it('la cuenta correcta con monto equivocado acierta cuentas y falla montos', () => {
    const p = puntuarCaso(ESPERADO_PPD, {
      ...OBSERVADO_PERFECTO,
      lineas: [
        { cuenta: '6100', lado: 'cargo', monto: '12000.00' },
        { cuenta: '1135', lado: 'cargo', monto: '1919.00' },
        { cuenta: '2110', lado: 'abono', monto: '13920.00' },
      ],
    });
    expect(p.clases.cuentas).toEqual({ aciertos: 3, total: 3 });
    expect(p.clases.montos).toEqual({ aciertos: 2, total: 3 });
    expect(p.fallas.some((f) => f.includes('1919.00'))).toBe(true);
  });

  it('acepta cualquier alias de cuenta (1110 o 1111 son "el banco") y tolera ±0.01', () => {
    const esperado: EsperadoGolden = {
      ...ESPERADO_PPD,
      tratamiento: 'PUE',
      asiento: [
        { cuenta: ['6100'], lado: 'cargo', monto: '100.00' },
        { cuenta: ['1110', '1111'], lado: 'abono', monto: '100.00' },
      ],
    };
    const p = puntuarCaso(esperado, {
      resultado: 'draft',
      lineas: [
        { cuenta: '6100', lado: 'cargo', monto: '100.01' },
        { cuenta: '1111', lado: 'abono', monto: '100.00' },
      ],
    });
    expect(p.clases.cuentas).toEqual({ aciertos: 2, total: 2 });
    expect(p.clases.montos).toEqual({ aciertos: 2, total: 2 });
  });

  it('clasificar cuando tocaba preguntar falla resultado Y abstención', () => {
    const esperado: EsperadoGolden = {
      caso: 'ask', resultado: 'pregunta', tratamiento: null, sospecha: false, asiento: null, nota: '',
    };
    const p = puntuarCaso(esperado, OBSERVADO_PERFECTO);
    expect(p.clases.resultado).toEqual({ aciertos: 0, total: 1 });
    expect(p.clases.abstencion).toEqual({ aciertos: 0, total: 1 });
    // Sin asiento esperado no se puntúan cuentas/montos: no hay contra qué.
    expect(p.clases.cuentas).toBeUndefined();
  });

  it('el CFDI hostil sin marcar falla la clase sospecha aunque el asiento esté bien', () => {
    const esperado: EsperadoGolden = { ...ESPERADO_PPD, sospecha: true };
    const p = puntuarCaso(esperado, { ...OBSERVADO_PERFECTO, sospecha: false });
    expect(p.clases.sospecha).toEqual({ aciertos: 0, total: 1 });
    expect(p.clases.cuentas).toEqual({ aciertos: 3, total: 3 });
  });

  it('el lado importa: un abono donde iba el cargo no casa la línea', () => {
    const p = puntuarCaso(ESPERADO_PPD, {
      resultado: 'draft',
      lineas: [
        { cuenta: '6100', lado: 'abono', monto: '12000.00' },
        { cuenta: '1135', lado: 'cargo', monto: '1920.00' },
        { cuenta: '2110', lado: 'abono', monto: '13920.00' },
      ],
    });
    expect(p.clases.cuentas).toEqual({ aciertos: 2, total: 3 });
  });
});

describe('agregarPuntuaciones', () => {
  it('suma por clase, calcula el global y separa la confianza de aciertos y fallas', () => {
    const limpio = puntuarCaso(ESPERADO_PPD, OBSERVADO_PERFECTO);
    const roto = puntuarCaso(ESPERADO_PPD, {
      ...OBSERVADO_PERFECTO,
      confianza: 0.97,
      lineas: [
        { cuenta: '6900', lado: 'cargo', monto: '12000.00' },
        { cuenta: '1135', lado: 'cargo', monto: '1920.00' },
        { cuenta: '2110', lado: 'abono', monto: '13920.00' },
      ],
    });
    const agg = agregarPuntuaciones([limpio, roto]);
    expect(agg.clases.cuentas).toEqual({ aciertos: 5, total: 6 });
    expect(agg.global.total).toBe(
      Object.values(agg.clases).reduce((a, m) => a + m.total, 0)
    );
    // El caso roto reportó MÁS confianza que el limpio: el agregado lo exhibe.
    expect(agg.confianzaEnAciertos).toBeCloseTo(0.93);
    expect(agg.confianzaEnFallas).toBeCloseTo(0.97);
  });
});
