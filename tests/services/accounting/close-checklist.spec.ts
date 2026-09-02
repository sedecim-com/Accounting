import { describe, it, expect } from 'vitest';
import {
  CLOSE_CHECK_CODES,
  CLOSE_CHECK_ITEMS,
  severidadDeLineaSinPartida,
} from '../../../src/services/accounting/period-close.js';
import {
  REMEDIO_DE,
  esCodigoDeCierre,
  explainCloseCheck,
} from '../../../src/services/accounting/close-explain.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// F06b · EL REGISTRO DE CASILLAS — lo separable, sin base de datos.
//
// El contrato que estas pruebas congelan: cada casilla tiene un código
// kebab-case ESTABLE, una prosa y un remedio; `closing explain` valida el
// código ANTES de tocar la base; y la política de la línea de banco sin
// explicar sólo bloquea con su literal exacto.
// ============================================================

describe('el registro de códigos del cierre', () => {
  it('todo código es kebab-case: minúsculas, dígitos y guiones', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(codigo, `"${codigo}" no es kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('no hay códigos repetidos', () => {
    expect(new Set(CLOSE_CHECK_CODES).size).toBe(CLOSE_CHECK_CODES.length);
  });

  it('cada código tiene su prosa en CLOSE_CHECK_ITEMS', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(CLOSE_CHECK_ITEMS[codigo], `${codigo} sin prosa`).toBeTruthy();
    }
  });

  it('las prosas históricas no cambian: hay pruebas y renders que las buscan', () => {
    // Los cinco textos que existían antes de F06b, literales.
    expect(CLOSE_CHECK_ITEMS['entries-posted']).toBe('All journal entries posted');
    expect(CLOSE_CHECK_ITEMS['bank-reconciled']).toBe('Bank reconciliations complete');
    expect(CLOSE_CHECK_ITEMS['invoices-reviewed']).toBe('All invoices reviewed');
    expect(CLOSE_CHECK_ITEMS['depreciation-posted']).toBe('Depreciation calculated and posted');
    expect(CLOSE_CHECK_ITEMS['trial-balance']).toBe('Trial balance balanced');
    expect(CLOSE_CHECK_ITEMS['rep-parked']).toBe('Parked payment receipts (REP) resolved');
    expect(CLOSE_CHECK_ITEMS['rep-missing']).toBe('Payments in period have their REP');
  });

  it('cada código tiene remedio, y el remedio es un comando de mnemosine', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(REMEDIO_DE[codigo], `${codigo} sin remedio`).toMatch(/^mnemosine /);
    }
  });

  it('esCodigoDeCierre distingue el registro de lo inventado', () => {
    expect(esCodigoDeCierre('bank-lines-unexplained')).toBe(true);
    expect(esCodigoDeCierre('bank_lines_unexplained')).toBe(false);
    expect(esCodigoDeCierre('')).toBe(false);
  });
});

describe('severidadDeLineaSinPartida', () => {
  it("sólo el literal 'bloquear_cierre' bloquea", () => {
    expect(severidadDeLineaSinPartida('bloquear_cierre')).toBe('blocking');
  });

  it('las otras dos opciones del panel avisan', () => {
    expect(severidadDeLineaSinPartida('partida_conciliatoria')).toBe('warning');
    expect(severidadDeLineaSinPartida('suspenso')).toBe('warning');
  });

  it('un valor raro del panel no puede congelar el cierre: avisa', () => {
    expect(severidadDeLineaSinPartida('lo-que-sea')).toBe('warning');
    expect(severidadDeLineaSinPartida('')).toBe('warning');
    expect(severidadDeLineaSinPartida('BLOQUEAR_CIERRE')).toBe('warning');
  });
});

describe('explainCloseCheck valida ANTES de tocar la base', () => {
  it('un código desconocido es error de uso que lista los disponibles', async () => {
    await expect(explainCloseCheck('e-1', 'p-1', 'no-existe')).rejects.toThrow(ValidationError);
    await expect(explainCloseCheck('e-1', 'p-1', 'no-existe')).rejects.toThrow(
      /previous-period-closed/
    );
  });

  it('un límite ilegible también, con el valor que llegó', async () => {
    await expect(
      explainCloseCheck('e-1', 'p-1', 'entries-posted', { limit: 0 })
    ).rejects.toThrow(ValidationError);
    await expect(
      explainCloseCheck('e-1', 'p-1', 'entries-posted', { limit: 2.5 })
    ).rejects.toThrow(/2\.5/);
  });
});
