/**
 * MNE-001-881 (#1069). Units of production is refused at registration, on
 * either book, by a catalogue key; and the sentence the close uses for an
 * asset already registered that way names it and says what to do. Texts
 * written by hand, with synthetic assets.
 */
import { describe, expect, it } from 'vitest';
import { refuseUnitsOfProduction } from '../../../src/services/assets/asset-service.js';
import { unitsOfProductionNote } from '../../../src/services/assets/depreciation.js';
import { MOTIVOS_DE_OMISION } from '../../../src/services/assets/depreciation-plan.js';
import { DepreciationMethod } from '../../../src/types/index.js';
import { ValidationError } from '../../../src/utils/errors.js';

const UNITS = DepreciationMethod.UNITS_OF_PRODUCTION;
const LINE = DepreciationMethod.STRAIGHT_LINE;

function refusal(book: DepreciationMethod, tax: DepreciationMethod): ValidationError {
  try {
    refuseUnitsOfProduction(book, tax);
  } catch (err) {
    return err as ValidationError;
  }
  throw new Error('it did not refuse');
}

describe('registration refuses units of production', () => {
  it('on the book side, in both languages, naming the field', () => {
    const e = refusal(UNITS, LINE);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.messageKey).toEqual({
      key: 'error.VALIDATION_ERROR.asset.units_of_production_unsupported',
      params: { book: 'book' },
    });
    expect(e.field).toBe('book_depreciation_method');
    expect(e.message).toBe(
      'The book depreciation method cannot be units_of_production yet: nothing captures the production of the ' +
        'period, so the monthly run could not compute a single row for this asset. Choose another method ' +
        '(straight_line when none is given). Nothing was registered.'
    );
    expect(e.localized('es')).toBe(
      'El método de depreciación contable todavía no puede ser units_of_production: nada captura la producción ' +
        'del periodo, así que la corrida mensual no podría calcular un solo renglón de este activo. Elige otro ' +
        'método (straight_line cuando no se indica ninguno). No se registró nada.'
    );
  });

  it('on the tax side', () => {
    const e = refusal(LINE, UNITS);
    expect(e.field).toBe('tax_depreciation_method');
    expect(e.message).toMatch(/^The tax depreciation method cannot be units_of_production yet: /);
    expect(e.localized('es')).toMatch(/^El método de depreciación fiscal todavía no puede ser units_of_production: /);
  });

  it('every other method passes', () => {
    for (const m of Object.values(DepreciationMethod).filter((x) => x !== UNITS)) {
      expect(() => refuseUnitsOfProduction(m, m)).not.toThrow();
    }
  });
});

describe('what the close says about assets already registered by units of production', () => {
  const press = (n: number) => ({ asset_number: `AF-2026-0000${n}`, asset_name: `Synthetic press ${n}` });

  it('names the asset, the reason the plan uses, and what to do', () => {
    expect(MOTIVOS_DE_OMISION).toContain('unidades_de_produccion');
    expect(unitsOfProductionNote([press(1)])).toBe(
      '1 asset(s) skipped by units of production (unidades_de_produccion), nothing posted for them: ' +
        "AF-2026-00001 Synthetic press 1. The period's production cannot be captured yet: " +
        "book the month's charge by hand (entry create), or give the asset another method (asset edit --method)"
    );
  });

  it('names five and counts the rest', () => {
    const note = unitsOfProductionNote([1, 2, 3, 4, 5, 6, 7].map(press));
    expect(note).toContain('7 asset(s) skipped by units of production');
    expect(note).toContain('AF-2026-00005 Synthetic press 5 (+2 more). ');
    expect(note).not.toContain('AF-2026-00006');
  });
});
