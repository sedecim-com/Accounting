import { describe, expect, it } from 'vitest';
import { SAT_CATALOGS } from '../../src/services/xml-ingestion/sat-catalogs.js';

// ============================================================
// #359 · 625 IS NOT RESICO
//
// The catalog labelled 625 as RESICO. In the SAT's c_RegimenFiscal, 625 is
// the regime for business activities through technology platforms, and
// RESICO is 626. The label is not cosmetic: `tax_regime_name` in a
// customer's tax profile reads it (customer-service.ts), and whoever sees
// "RESICO" may apply the 1.25 % ISR withholding that belongs only to 626.
// ============================================================

const REGIMES = SAT_CATALOGS.REGIMEN_FISCAL as Record<string, string>;

describe('the tax regime catalog', () => {
  it('names 625 as the SAT does: business activities through technology platforms', () => {
    expect(REGIMES['625']).toBe(
      'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas',
    );
  });

  it('keeps 626 as the Régimen Simplificado de Confianza', () => {
    expect(REGIMES['626']).toBe('Régimen Simplificado de Confianza');
  });

  it('puts the RESICO acronym on no label', () => {
    const tagged = Object.entries(REGIMES).filter(([, name]) => /RESICO/i.test(name));
    expect(tagged).toEqual([]);
  });
});
