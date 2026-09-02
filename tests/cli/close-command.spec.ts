import { describe, it, expect } from 'vitest';
import { renderReadiness } from '../../src/cli/close-command.js';
import type { CloseReadiness } from '../../src/ai/close-service.js';

// Identity palette: assert on the text, not on ANSI codes
const plain = {
  dim: (s: string) => s, bold: (s: string) => s,
  cyan: (s: string) => s, red: (s: string) => s,
};

const BASE: CloseReadiness = {
  period: {
    id: 'fp-1', period_name: 'July 2026', period_number: 7,
    start_date: '2026-07-01', end_date: '2026-07-31',
    status: 'open', year_number: 2026, overdue: true,
  },
  canClose: true,
  blockingIssues: [],
  warnings: [],
  // Desde F06b cada casilla lleva su código estable y su severidad; el
  // render de `close` sigue mostrando la prosa — los campos nuevos son para
  // `closing check|explain` y los scripts.
  checklist: [
    { codigo: 'entries-posted', item: 'All journal entries posted', is_complete: true, severity: 'blocking' },
    {
      codigo: 'bank-reconciled', item: 'Bank reconciliations complete',
      is_complete: false, severity: 'warning', details: '1 account pending',
    },
  ],
  ai: { pendingDrafts: 0, pendingQuestions: 0, pendingExternalOps: 0 },
};

describe('renderReadiness', () => {
  it('shows the period with its range and the overdue flag', () => {
    const out = renderReadiness(BASE, plain).join('\n');
    expect(out).toMatch(/July 2026/);
    expect(out).toMatch(/2026-07-01 → 2026-07-31/);
    expect(out).toMatch(/overdue/);
  });

  it('marks each checklist item and shows its detail', () => {
    const out = renderReadiness(BASE, plain).join('\n');
    expect(out).toMatch(/✔ All journal entries posted/);
    expect(out).toMatch(/✘ Bank reconciliations complete/);
    expect(out).toMatch(/1 account pending/);
  });

  it('says it is ready when there is nothing blocking', () => {
    expect(renderReadiness(BASE, plain).join('\n')).toMatch(/Ready to close\./);
  });

  it('lists the blockers and refuses when it cannot close', () => {
    const out = renderReadiness(
      { ...BASE, canClose: false, blockingIssues: ['3 AI draft(s) pending review'] },
      plain
    ).join('\n');
    expect(out).toMatch(/Blocking:/);
    expect(out).toMatch(/3 AI draft\(s\) pending review/);
    expect(out).toMatch(/Cannot close yet/);
    expect(out).not.toMatch(/Ready to close/);
  });

  it('shows warnings without preventing the close', () => {
    const out = renderReadiness(
      { ...BASE, warnings: ['2 unanswered question(s)'] },
      plain
    ).join('\n');
    expect(out).toMatch(/Warnings:/);
    expect(out).toMatch(/2 unanswered question\(s\)/);
    expect(out).toMatch(/Ready to close\./);
  });

  it('omits the sections that have no content', () => {
    const out = renderReadiness(BASE, plain).join('\n');
    expect(out).not.toMatch(/Blocking:/);
    expect(out).not.toMatch(/Warnings:/);
  });
});
