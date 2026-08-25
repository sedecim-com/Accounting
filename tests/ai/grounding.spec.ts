import { describe, it, expect } from 'vitest';
import { GroundingGuard, GROUNDING_NUDGE, DEFAULT_MIN_ANSWER_CHARS } from '../../src/ai/grounding.js';

const LONG_ANSWER = 'Para timbrar un CFDI debes usar el comando... '.repeat(10); // ~460 chars
const SHORT_ANSWER = '¡Hola! ¿En qué te ayudo hoy?';

describe('GroundingGuard', () => {
  it('nudges a substantive answer produced with zero tools and zero docs', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(true);
    expect(guard.buildNudge()).toBe(GROUNDING_NUDGE);
  });

  it('fires at most once per session (latch)', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(true);
    guard.buildNudge();
    // The corrective turn ALSO answers without tools — no second nudge.
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
  });

  it('ignores short answers (greetings, acks)', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    expect(SHORT_ANSWER.length).toBeLessThan(DEFAULT_MIN_ANSWER_CHARS);
    expect(guard.needsNudge(SHORT_ANSWER)).toBe(false);
    // Whitespace padding does not smuggle a greeting past the threshold.
    expect(guard.needsNudge(SHORT_ANSWER + ' '.repeat(500))).toBe(false);
  });

  it('any tool call this turn counts as grounding', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    guard.onToolUse('search_accounts');
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
  });

  it('a read_docs earlier in the session exempts later tool-less turns (follow-ups)', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    guard.onToolUse('read_docs');
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
    // Next turn: no tools at all, but docs are already in context.
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
  });

  it('a non-docs tool in a PREVIOUS turn does not exempt the next one', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    guard.onToolUse('search_accounts');
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
    // New turn, zero tools, still no docs in the session → nudge.
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(true);
  });

  it('reset() re-arms everything: docs counter AND the spent latch', () => {
    const guard = new GroundingGuard();
    guard.beginTurn();
    guard.onToolUse('read_docs');
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false); // docs in context
    guard.buildNudge(); // latch spent (hypothetically)
    // /new wipes the model context: the docs are GONE and the latch must re-arm.
    guard.reset();
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(true);
  });

  it('can be disabled (tools:false channels, tests)', () => {
    const guard = new GroundingGuard({ enabled: false });
    guard.beginTurn();
    expect(guard.needsNudge(LONG_ANSWER)).toBe(false);
  });

  it('honors a custom answer-length threshold', () => {
    const guard = new GroundingGuard({ minAnswerChars: 5 });
    guard.beginTurn();
    expect(guard.needsNudge('Usa mnemosine review')).toBe(true);
  });

  it('the nudge text is labeled as harness-injected, not the user', () => {
    expect(GROUNDING_NUDGE).toMatch(/MNEMOSINE HARNESS/);
    expect(GROUNDING_NUDGE).toMatch(/NOT the user/);
  });
});
