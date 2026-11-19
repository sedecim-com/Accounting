import { describe, expect, it } from 'vitest';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';

// MNE-001-553 · #684, part 3/3: where a received CFDI's line with no account goes.

describe('received_line_without_account', () => {
  const spec = getPolicySpec('received_line_without_account');

  it('offers the refusal and the generic account of the role, and refuses by default', () => {
    expect(spec?.options.map((o) => o.value)).toEqual(['refuse', 'role_generic_account']);
    expect(spec?.defaultValue).toBe('refuse');
  });

  it('C2 · its default rationale names its two sources', () => {
    expect(spec?.defaultRationale).toContain('LISR art. 27 fr. IV');
    expect(spec?.defaultRationale).toContain('ADR-0006');
  });
});
