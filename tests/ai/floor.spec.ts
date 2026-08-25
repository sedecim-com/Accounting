import { describe, it, expect } from 'vitest';
import {
  FLOOR_MAX_AUTO_POST,
  FLOOR_MAX_OP_AGE_DAYS,
  floorMaxAutoAmount,
  isOpStale,
} from '../../src/ai/floor.js';

describe('the unbreakable floor', () => {
  it('pins the constants: changing them is a deliberate act, not a refactor', () => {
    expect(FLOOR_MAX_AUTO_POST).toBe(50000);
    expect(FLOOR_MAX_OP_AGE_DAYS).toBe(30);
  });
});

describe('floorMaxAutoAmount', () => {
  it('keeps a configured cap below the floor', () => {
    expect(floorMaxAutoAmount(10000)).toBe(10000);
    expect(floorMaxAutoAmount(0)).toBe(0);
  });

  it('clamps a configured cap above the floor — config can never raise it', () => {
    expect(floorMaxAutoAmount(1_000_000)).toBe(FLOOR_MAX_AUTO_POST);
    expect(floorMaxAutoAmount(FLOOR_MAX_AUTO_POST + 0.01)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('allows exactly the floor', () => {
    expect(floorMaxAutoAmount(FLOOR_MAX_AUTO_POST)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('fails CLOSED on garbage config (NaN, Infinity, negative → 0, nothing auto-posts)', () => {
    expect(floorMaxAutoAmount(NaN)).toBe(0);
    expect(floorMaxAutoAmount(Infinity)).toBe(0);
    expect(floorMaxAutoAmount(-5)).toBe(0);
  });
});

describe('isOpStale', () => {
  const NOW = new Date('2026-08-24T12:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

  it('a fresh op is not stale', () => {
    expect(isOpStale(daysAgo(0), NOW)).toBe(false);
    expect(isOpStale(daysAgo(29), NOW)).toBe(false);
  });

  it('exactly the limit is still executable; strictly older is stale', () => {
    expect(isOpStale(daysAgo(FLOOR_MAX_OP_AGE_DAYS), NOW)).toBe(false);
    expect(isOpStale(daysAgo(FLOOR_MAX_OP_AGE_DAYS + 0.001), NOW)).toBe(true);
    expect(isOpStale(daysAgo(31), NOW)).toBe(true);
  });

  it('accepts an ISO string timestamp', () => {
    expect(isOpStale('2026-08-20T00:00:00Z', NOW)).toBe(false);
    expect(isOpStale('2026-07-01T00:00:00Z', NOW)).toBe(true);
  });

  it('an unparseable timestamp fails CLOSED (stale)', () => {
    expect(isOpStale('not a date', NOW)).toBe(true);
  });
});
