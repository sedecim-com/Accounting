import { describe, it, expect } from 'vitest';

// ============================================================
// ENTRY FLOW — pure helpers of the state-aware bare invocation.
// mnemosine.ts guards program.parseAsync behind require.main, so
// importing it here loads the command tree without launching the
// CLI (and without touching the database: the pool is lazy).
// The REPL itself is not unit-testable; these helpers carry the
// decisions the flows depend on:
//   - isAffirmative: the Hermes-style 'Run setup now? [Y/n]' gate
//   - repairCommandFor: categorized failure → exact next command
//   - shouldShowBanner: rich chrome only where it belongs
// ============================================================

import {
  isAffirmative,
  repairCommandFor,
  shouldShowBanner,
  rejectionReasonFrom,
  createProvenanceTracker,
} from '../../src/cli/mnemosine.js';

describe('isAffirmative', () => {
  it('empty input takes the announced default (Y)', () => {
    expect(isAffirmative('')).toBe(true);
    expect(isAffirmative('   ')).toBe(true);
  });

  it('empty input takes the default when the default is No', () => {
    expect(isAffirmative('', false)).toBe(false);
  });

  it('accepts English and Spanish affirmatives, case-insensitive', () => {
    for (const yes of ['y', 'Y', 'yes', 'YES', 's', 'si', 'sí', ' Sí ']) {
      expect(isAffirmative(yes), `expected "${yes}" to be affirmative`).toBe(true);
    }
  });

  it('anything else is a No', () => {
    for (const no of ['n', 'no', 'q', 'nope', 'x', 'yess']) {
      expect(isAffirmative(no), `expected "${no}" to be negative`).toBe(false);
    }
  });

  it('EOF (null) is always No — never launch a wizard on a closed stdin', () => {
    expect(isAffirmative(null)).toBe(false);
    expect(isAffirmative(null, true)).toBe(false);
  });
});

describe('repairCommandFor', () => {
  it('database problems point at doctor and DATABASE_URL', () => {
    expect(repairCommandFor('database unreachable: connection refused')).toContain('mnemosine doctor');
    expect(repairCommandFor('database unreachable: connection refused')).toContain('DATABASE_URL');
    expect(repairCommandFor('database unreachable: timed out after 3000ms')).toContain('mnemosine doctor');
  });

  it('missing entities point at the identity section', () => {
    expect(repairCommandFor('no legal entities registered')).toBe('mnemosine init --section identity');
  });

  it('provider problems point at the ai section', () => {
    expect(repairCommandFor('AI provider not configured')).toBe('mnemosine init --section ai');
  });

  it('unknown reasons never dead-end: generic doctor', () => {
    expect(repairCommandFor('setup check failed: boom')).toBe('mnemosine doctor');
    expect(repairCommandFor('')).toBe('mnemosine doctor');
  });

  it('with the database down, the database repair wins over other hints', () => {
    // Other diagnoses are unreliable while the DB is unreachable.
    expect(repairCommandFor('database unreachable: cannot list entities')).toContain('doctor');
  });
});

describe('shouldShowBanner', () => {
  const on = {};
  it('shows on a plain interactive terminal', () => {
    expect(shouldShowBanner(on, {}, true)).toBe(true);
  });

  it('never on a non-TTY (piped stdout stays clean)', () => {
    expect(shouldShowBanner(on, {}, false)).toBe(false);
  });

  it('--no-banner wins', () => {
    expect(shouldShowBanner({ banner: false }, {}, true)).toBe(false);
  });

  it('MNEMOSINE_NO_BANNER=1 wins; other values do not', () => {
    expect(shouldShowBanner(on, { MNEMOSINE_NO_BANNER: '1' }, true)).toBe(false);
    expect(shouldShowBanner(on, { MNEMOSINE_NO_BANNER: '0' }, true)).toBe(true);
    expect(shouldShowBanner(on, { MNEMOSINE_NO_BANNER: undefined }, true)).toBe(true);
  });
});

describe('rejectionReasonFrom', () => {
  it('EOF (null) aborts — never a silent rejection with a fabricated reason', () => {
    expect(rejectionReasonFrom(null)).toEqual({ abort: true });
  });

  it('an explicitly entered empty line defaults to "No reason"', () => {
    expect(rejectionReasonFrom('')).toEqual({ abort: false, reason: 'No reason' });
    expect(rejectionReasonFrom('   ')).toEqual({ abort: false, reason: 'No reason' });
  });

  it('carries a typed reason through, trimmed', () => {
    expect(rejectionReasonFrom('  duplicate invoice  ')).toEqual({
      abort: false,
      reason: 'duplicate invoice',
    });
  });
});

describe('createProvenanceTracker', () => {
  const B = { name: 'hermes', model: 'm-b' };
  const C = { name: 'zeus', model: 'm-c' };

  it('does not record a provider until a turn completes under it', () => {
    const committed: Array<{ name: string; model: string }> = [];
    const t = createProvenanceTracker((p) => committed.push(p));
    t.onFailover(B);
    // Failover alone (provider only asked to try) writes nothing.
    expect(committed).toEqual([]);
    expect(t.pending).toEqual(B);
    // A completed turn under B flushes exactly once.
    t.onTurnComplete();
    expect(committed).toEqual([B]);
    expect(t.pending).toBeNull();
    // No further writes without a new failover.
    t.onTurnComplete();
    expect(committed).toEqual([B]);
  });

  it('records only the last-attempted provider in a multi-hop chain that finally succeeds', () => {
    const committed: Array<{ name: string; model: string }> = [];
    const t = createProvenanceTracker((p) => committed.push(p));
    t.onFailover(B);
    t.onFailover(C); // B also failed; C is now being tried
    t.onTurnComplete(); // C produced the turn
    expect(committed).toEqual([C]);
  });

  it('drops the staged provider when the turn fails entirely — no misattribution', () => {
    const committed: Array<{ name: string; model: string }> = [];
    const t = createProvenanceTracker((p) => committed.push(p));
    t.onFailover(B);
    t.onTurnFailed(); // whole turn failed: B produced nothing
    expect(committed).toEqual([]);
    expect(t.pending).toBeNull();
    // A later, non-failing turn (no failover) does not inherit B.
    t.onTurnComplete();
    expect(committed).toEqual([]);
  });
});
