import { describe, it, expect } from 'vitest';
import {
  PAYROLL_DRAFT_PRODUCER,
  payRunOfDraft,
  payRunReference,
} from '../../../src/services/payroll/common/pay-run-entry-link.js';

const RUN = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

describe('payRunOfDraft: which drafts are a pay run entry', () => {
  it('the payroll engine draft with the run reference books that run', () => {
    expect(payRunOfDraft({ ai_model: PAYROLL_DRAFT_PRODUCER, payload: { reference: payRunReference(RUN) } })).toBe(RUN);
  });

  it('the same reference from another producer is not the run entry', () => {
    expect(payRunOfDraft({ ai_model: 'some-model', payload: { reference: payRunReference(RUN) } })).toBeNull();
  });

  it('a payroll draft without a well-formed run reference is not linked', () => {
    expect(payRunOfDraft({ ai_model: PAYROLL_DRAFT_PRODUCER, payload: {} })).toBeNull();
    expect(payRunOfDraft({ ai_model: PAYROLL_DRAFT_PRODUCER, payload: { reference: `pay-run:${RUN} x` } })).toBeNull();
  });
});
