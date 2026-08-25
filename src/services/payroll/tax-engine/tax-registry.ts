import type { ITaxCalculator } from './tax-engine.interface.js';

class TaxRegistry {
  private calculators = new Map<string, ITaxCalculator>();

  register(calc: ITaxCalculator): void {
    const key = `${calc.jurisdiction}:${calc.taxType}`;
    if (this.calculators.has(key)) return;
    this.calculators.set(key, calc);
  }

  get(jurisdiction: string, taxType: string): ITaxCalculator | null {
    return this.calculators.get(`${jurisdiction}:${taxType}`) || null;
  }

  getRequired(jurisdiction: string, taxType: string): ITaxCalculator {
    const calc = this.get(jurisdiction, taxType);
    if (!calc) {
      throw new Error(`No tax calculator registered for ${jurisdiction}:${taxType}`);
    }
    return calc;
  }

  list(): ITaxCalculator[] {
    return Array.from(this.calculators.values());
  }
}

export const taxRegistry = new TaxRegistry();
