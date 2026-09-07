import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  fechaLimiteBimestral,
  fechaLimiteDia17,
  finDeMes,
  inicioDeMes,
} from '../../../src/services/payroll/common/employer-liability-service.js';

// ============================================================
// LAS FECHAS DE UN PASIVO NO SON DECORACIÓN
//
// `employer_tax_liabilities.due_date` es lo que decide si un renglón está al
// corriente o vencido, y la aritmética que lo produce cruza fin de año, fin de
// bimestre y febrero. Los tres son los sitios donde una resta de días a mano
// falla, y ninguno de los tres se nota en la corrida del mes en que se escribe
// el código: se nota en diciembre.
//
// Se prueba aquí, sin base de datos, porque es aritmética de calendario y no
// necesita Postgres para estar mal.
// ============================================================

describe('el mes del periodo', () => {
  it('encuentra el primero y el último día sin tabla de meses', () => {
    expect(inicioDeMes('2026-03-15')).toBe('2026-03-01');
    expect(finDeMes('2026-03-15')).toBe('2026-03-31');
  });

  it('acierta en febrero, bisiesto o no', () => {
    expect(finDeMes('2026-02-10')).toBe('2026-02-28');
    expect(finDeMes('2028-02-10')).toBe('2028-02-29');
  });

  it('acierta en diciembre, que es donde se rompe el mes+1 ingenuo', () => {
    expect(inicioDeMes('2026-12-31')).toBe('2026-12-01');
    expect(finDeMes('2026-12-01')).toBe('2026-12-31');
  });

  it('se niega a adivinar con una fecha ilegible', () => {
    // Un Date inválido produciría 'Invalid Date' y, tras el slice, una cadena
    // que la columna DATE rechaza en el mejor caso y acepta torcida en el peor.
    expect(() => inicioDeMes('marzo de 2026')).toThrow(/YYYY-MM-DD/);
  });
});

describe('día 17 del mes siguiente — IMSS mensual e ISN', () => {
  it('vence el mes siguiente al que cierra el periodo', () => {
    expect(fechaLimiteDia17('2026-03-31')).toBe('2026-04-17');
    expect(fechaLimiteDia17('2026-03-15')).toBe('2026-04-17');
  });

  it('cruza el año: una nómina de diciembre vence en enero', () => {
    expect(fechaLimiteDia17('2026-12-31')).toBe('2027-01-17');
  });
});

describe('bimestral — INFONAVIT', () => {
  it('una nómina de enero NO vence en febrero: vence al cerrar el bimestre', () => {
    // ene-feb es un bimestre; se paga el 17 de marzo. Tratarlo como mensual
    // marcaría vencido el 18 de febrero un pasivo que está al corriente.
    expect(fechaLimiteBimestral('2026-01-31')).toBe('2026-03-17');
    expect(fechaLimiteBimestral('2026-02-28')).toBe('2026-03-17');
  });

  it('cada bimestre vence el 17 del mes siguiente a su cierre', () => {
    expect(fechaLimiteBimestral('2026-03-31')).toBe('2026-05-17');
    expect(fechaLimiteBimestral('2026-04-30')).toBe('2026-05-17');
    expect(fechaLimiteBimestral('2026-09-30')).toBe('2026-11-17');
    expect(fechaLimiteBimestral('2026-10-31')).toBe('2026-11-17');
  });

  it('el bimestre nov-dic vence en enero del año siguiente', () => {
    expect(fechaLimiteBimestral('2026-11-30')).toBe('2027-01-17');
    expect(fechaLimiteBimestral('2026-12-31')).toBe('2027-01-17');
  });
});
