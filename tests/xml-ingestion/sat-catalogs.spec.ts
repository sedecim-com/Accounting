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

// #102 (MNE-001-033): `customer tax set` validates against these two tables,
// so a current SAT code missing here is a legitimate customer refused.
describe('the catalogs the tax profile validates against', () => {
  const USES = SAT_CATALOGS.USO_CFDI as Record<string, string>;

  it.each(['I05', 'I06', 'I07', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'CN01'])('c_UsoCFDI carries %s', (code) => {
    expect(USES[code]).toBeTruthy();
  });

  it.each(['609', '611', '615', '628', '629', '630'])('c_RegimenFiscal carries %s', (code) => {
    expect(REGIMES[code]).toBeTruthy();
  });

  it('names D10, CN01 and 611 as the SAT does', () => {
    expect(USES.D10).toBe('Pagos por servicios educativos (colegiaturas)');
    expect(USES.CN01).toBe('Nómina');
    expect(REGIMES['611']).toBe('Ingresos por Dividendos (socios y accionistas)');
  });
});
