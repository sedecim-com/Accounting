import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { DECISIONS, getDecision } from '../../../src/services/xml-ingestion/cfdi-decisions.js';
import {
  answerablePending, answeredPerDocument, answerWithoutEntry, documentAnswers, optionsText,
} from '../../../src/services/xml-ingestion/decision-answers.js';

// MNE-001-906 (#1075), part 1: which decisions a person answers for one CFDI,
// and what the door reads from the trail. The door itself is in
// tests/integration/mne-001-906-inbox-decision-answer.int.spec.ts.

describe('which decisions are answered per document', () => {
  it('the blocking ones whose every option names the role it posts to, and no other', () => {
    expect(DECISIONS.filter(answeredPerDocument).map((d) => d.id)).toEqual([
      'gasto_vs_activo', 'efectivo_no_deducible', 'combustible_efectivo', 'anticipo_o_gasto', 'por_cuenta_terceros',
    ]);
  });

  it('never one whose answer the classifier could not turn into an entry', () => {
    // No role on their options: «do not record» would only release the CFDI.
    for (const id of ['proveedor_nuevo', 'periodo_cerrado', 'cfdi_cancelado']) {
      expect(getDecision(id)?.severity).toBe('blocking');
      expect(answeredPerDocument(getDecision(id))).toBe(false);
    }
    // Advisory: the firm's panel answers them, or the default stands.
    for (const id of ['gasto_vs_anticipado', 'consumo_restaurante', 'cuenta_ambigua', 'ieps_acreditable']) {
      expect(answeredPerDocument(getDecision(id))).toBe(false);
    }
    expect(answeredPerDocument(undefined)).toBe(false);
  });
});

describe('what the door reads from a trail', () => {
  const trail = [
    { id: 'efectivo_no_deducible', severity: 'blocking', options: [{ value: 'no_deducible' }, { value: 'gasto' }], answer: 'gasto', answered_by: 'u1' },
    { id: 'gasto_vs_activo', severity: 'blocking', options: [{ value: 'activo_fijo' }, { value: 'gasto' }] },
    { id: 'cfdi_cancelado', severity: 'blocking', options: [{ value: 'rechazar' }], answer: 'registrar' },
    { id: 'cuenta_ambigua', severity: 'advisory', options: [] },
  ];

  it('only the answers of decisions answered per document reach the classifier', () => {
    expect(documentAnswers(trail)).toEqual({ efectivo_no_deducible: 'gasto' });
    expect(documentAnswers(null)).toEqual({});
    expect(documentAnswers('not a list')).toEqual({});
  });

  it('the pending ones a person can answer, with the options the trail offered', () => {
    expect(answerablePending(trail).map((d) => d.id)).toEqual(['gasto_vs_activo']);
    expect(optionsText(answerablePending(trail))).toBe('gasto_vs_activo = activo_fijo | gasto');
  });
});

describe('an answer the entry cannot honour yet keeps the CFDI held', () => {
  const judged = (roles: string[], openedOffRoleAccount: Record<string, string> = {}) => ({ lineRoles: new Set(roles), openedOffRoleAccount });
  const expenseEntry = judged(['gasto', 'iva_pendiente_acreditar', 'cxp']);

  it('«no_deducible», whichever decision carries it and whatever the entry', () => {
    expect(answerWithoutEntry({ efectivo_no_deducible: 'no_deducible' })).toEqual({
      decision: 'efectivo_no_deducible', answer: 'no_deducible', role: 'gasto_no_deducible', why: 'non_deductible',
    });
    expect(answerWithoutEntry({ efectivo_no_deducible: 'gasto', combustible_efectivo: 'no_deducible' }, expenseEntry))
      .toMatchObject({ decision: 'combustible_efectivo', why: 'non_deductible' });
    expect(answerWithoutEntry({ efectivo_no_deducible: 'no_deducible' }, judged(['gasto_no_deducible'])))
      .toMatchObject({ why: 'non_deductible' });
  });

  it('an answer whose role has no line in the entry the classifier proposes', () => {
    // The classifier follows the first answered decision only: the second one's role is not in the entry.
    expect(answerWithoutEntry({ gasto_vs_activo: 'gasto', anticipo_o_gasto: 'anticipo' }, expenseEntry)).toEqual({
      decision: 'anticipo_o_gasto', answer: 'anticipo', role: 'anticipo_proveedores', why: 'not_followed',
    });
    expect(answerWithoutEntry({ anticipo_o_gasto: 'gasto' }, judged(['anticipo_proveedores', 'iva_acreditable', 'cxp'])))
      .toMatchObject({ role: 'gasto', why: 'not_followed' });
  });

  it('an answer the classifier follows, whose amount the plan put on accounts that are not the role\'s', () => {
    const openedElsewhere = judged(['activo_fijo', 'iva_pendiente_acreditar', 'cxp'], { activo_fijo: '1210' });
    expect(answerWithoutEntry({ gasto_vs_activo: 'activo_fijo' }, openedElsewhere)).toEqual({
      decision: 'gasto_vs_activo', answer: 'activo_fijo', role: 'activo_fijo', why: 'off_role_account', account: '1210',
    });
    expect(answerWithoutEntry({ gasto_vs_activo: 'activo_fijo', efectivo_no_deducible: 'gasto' }, openedElsewhere))
      .toMatchObject({ decision: 'gasto_vs_activo', why: 'off_role_account' });
    // The plain expense is the person's own coding: its lines never sit on the role's generic account.
    expect(answerWithoutEntry({ gasto_vs_activo: 'gasto' }, judged(['gasto', 'cxp'], { gasto: '6100' }))).toBeNull();
  });

  it('nothing is held when every answer has its line, or there is no answer', () => {
    expect(answerWithoutEntry({ efectivo_no_deducible: 'gasto', combustible_efectivo: 'gasto' }, expenseEntry)).toBeNull();
    expect(answerWithoutEntry({ gasto_vs_activo: 'activo_fijo' }, judged(['activo_fijo', 'cxp']))).toBeNull();
    // «gasto» asks for no change: an asset paid by a CFDI whose cash payment form is wrong is still the asset's entry.
    expect(answerWithoutEntry({ gasto_vs_activo: 'activo_fijo', efectivo_no_deducible: 'gasto' }, judged(['activo_fijo', 'cxp']))).toBeNull();
    expect(answerWithoutEntry({ efectivo_no_deducible: 'gasto', gasto_vs_activo: 'activo_fijo' }, expenseEntry))
      .toMatchObject({ decision: 'gasto_vs_activo', role: 'activo_fijo', why: 'not_followed' });
    expect(answerWithoutEntry({}, expenseEntry)).toBeNull();
    expect(answerWithoutEntry({ efectivo_no_deducible: 'gasto' })).toBeNull();
    // A value the decision does not offer names no role: the verb refuses it before it is stored.
    expect(answerWithoutEntry({ efectivo_no_deducible: 'deducible' }, expenseEntry)).toBeNull();
  });
});
