import { describe, it, expect } from 'vitest';
import { CRITERIOS, conFuenteMutada, crudoDe } from '../../src/plan/criterios.js';

// T14 · #101 review. The single-query-layer criterion counts copies of the
// balance SQL outside report-service. A credit-normal copy — Σ(credit − debit),
// the form a liability control writes — is the same second layer with the
// operands swapped, so the detector has to see both sign orders.
//
// MNE-001-439: the alias does not matter either. The same sum under `l.`, on
// the bare column or on the table name is the same second layer.
const criterion = CRITERIOS.find((c) => c.id === 'single-report-query-layer');
const FILE = 'src/services/ar/ar-controls.ts';

async function evaluateWith(copy: string) {
  expect(criterion).toBeDefined();
  const mutated = crudoDe(FILE) + `\n${copy}\n`;
  return conFuenteMutada({ [FILE]: mutated }, () => criterion!.evaluar());
}

describe('E4.2 single-report-query-layer sees balance copies in both sign orders', () => {
  it('flags a credit-first copy of the balance SQL', async () => {
    const r = await evaluateWith(
      'export const copy = `SELECT SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)) FROM x`;'
    );
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(FILE);
  });
});

describe('E4.2 single-report-query-layer sees balance copies under any alias', () => {
  it('flags a debit-first copy under the alias l.', async () => {
    const r = await evaluateWith(
      'export const copy = `SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) FROM x l`;'
    );
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(FILE);
  });

  it('flags a credit-first copy on the bare column, split across lines', async () => {
    const r = await evaluateWith(
      'export const copy = `SELECT SUM(\n  COALESCE( credit_amount, 0) - COALESCE(debit_amount, 0)) FROM journal_entry_lines`;'
    );
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(FILE);
  });

  it('flags a copy qualified by the table name', async () => {
    const r = await evaluateWith(
      'export const copy = `SELECT SUM(COALESCE(journal_entry_lines.debit_amount, 0)) FROM journal_entry_lines`;'
    );
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(FILE);
  });

  it('does not count a copy that only appears in a comment', async () => {
    const r = await evaluateWith('// SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))');
    expect(r.detalle).not.toContain(FILE);
  });
});
