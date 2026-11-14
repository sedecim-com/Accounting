import { describe, it, expect } from 'vitest';
import type { ITaxCalculator } from '../../../src/services/payroll/tax-engine/tax-engine.interface.js';
// The CLI entry first, and only it: the registry is read after it has loaded.
import '../../../src/cli/mnemosine.js';
import { taxRegistry } from '../../../src/services/payroll/tax-engine/tax-registry.js';

// ============================================================
// #586 · THE BINARY BRINGS ITS OWN TAX CALCULATORS
//
// The calculators used to be registered only by the REST entry point, so
// `mnemosine pay-run calculate` died with `No tax calculator registered for
// MX:isr`. Each spec file runs in its own module graph: what this file loads
// is exactly what the CLI entry loads, and nothing here imports the
// registration by hand before the snapshot is taken.
// ============================================================

const MX_TAXES = [
  'isr', 'subsidio_empleo', 'imss_employee', 'imss_employer', 'infonavit_employer', 'infonavit_credit',
];

function keysOf(list: ITaxCalculator[]): string[] {
  return list.map((c) => `${c.jurisdiction}:${c.taxType}`).sort();
}

describe('tax calculators under the CLI entry (#586)', () => {
  it('loading src/cli/mnemosine.ts alone registers the Mexican calculators', () => {
    const underCli = keysOf(taxRegistry.list());

    for (const tax of MX_TAXES) expect(underCli).toContain(`MX:${tax}`);
    // The REST entry reaches the registry through the same module, the
    // paycheck service, so both entries hold one and the same set:
    // tax-calculators-rest-entry.spec.ts pins that side.
  });

  it('a second registration under an existing key keeps the first calculator', () => {
    const original = taxRegistry.getRequired('MX', 'isr');
    const before = taxRegistry.list().length;

    const impostor: ITaxCalculator = {
      jurisdiction: 'MX',
      taxType: 'isr',
      calculate: async () => { throw new Error('the impostor must never be called'); },
    };
    taxRegistry.register(impostor);

    expect(taxRegistry.getRequired('MX', 'isr')).toBe(original);
    expect(taxRegistry.list()).toHaveLength(before);
  });
});
