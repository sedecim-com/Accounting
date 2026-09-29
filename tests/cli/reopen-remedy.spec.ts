import { describe, it, expect } from 'vitest';
import { reopenRemedy } from '../../src/cli/period-command.js';

// #99 · MNE-001-048. `period reopen` printed `close --period X` for every
// period, and that is the SOFT close: a month reopened from 'hard_close' and
// closed again that way never redid its carry-forward.
describe('reopenRemedy', () => {
  it('tells a period reopened from hard_close to seal it again with --hard', () => {
    const out = reopenRemedy('June 2026', 'hard_close').join('\n');
    expect(out).toMatch(/Close it again with: mnemosine close --period "June 2026"$/m);
    expect(out).toMatch(/mnemosine close --period "June 2026" --hard$/m);
  });

  it('does not push a period that was only soft closed into a hard close', () => {
    const out = reopenRemedy('June 2026', 'soft_close').join('\n');
    expect(out).toBe('Close it again with: mnemosine close --period "June 2026"');
  });
});
