import { describe, it, expect } from 'vitest';
import { CRITERIOS, conFuenteMutada, crudoDe } from '../../src/plan/criterios.js';

// T14 · #101 review. The single-query-layer criterion counts copies of the
// balance SQL outside report-service. A credit-normal copy — Σ(credit − debit),
// the form a liability control writes — is the same second layer with the
// operands swapped, so the detector has to see both sign orders.
const criterion = CRITERIOS.find((c) => c.id === 'single-report-query-layer');
const FILE = 'src/services/ar/ar-controls.ts';

describe('E4.2 single-report-query-layer sees balance copies in both sign orders', () => {
  it('flags a credit-first copy of the balance SQL', async () => {
    expect(criterion).toBeDefined();
    const mutated =
      crudoDe(FILE) +
      '\nexport const copy = `SELECT SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)) FROM x`;\n';
    const r = await conFuenteMutada({ [FILE]: mutated }, () => criterion!.evaluar());
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(FILE);
  });
});
