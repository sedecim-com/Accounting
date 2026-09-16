import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  getPolicy,
  policyWording,
  POLICY_CATALOG,
  getPolicySpec,
  type PolicyRow,
  type PolicySpec,
} from '../../../src/services/policy/policy-service.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// THE ROW KEEPS STATE; THE WORDING COMES FROM THE CATALOG (I10 · #152)
//
// `seedPolicies` copies the catalog text into every row with ON CONFLICT DO
// NOTHING, so a tenant seeded before a rewording keeps the old text forever.
// These tests feed rows whose text is deliberately NOT the catalog's, and
// check that what comes out is the catalog's.
//
// Every text expectation is anchored to a literal or to `getPolicySpec` —
// never to `policyWording(...)` itself: comparing the piece under test
// against its own output stays green when it breaks.
// ============================================================

const LIVE_KEY = 'destino_del_resultado_del_ejercicio';
const ORPHAN_KEY = 'retired_policy_that_the_catalog_no_longer_has';

/** Text as an old catalog seeded it: different from today's on every column. */
const STALE_QUESTION = 'Stale seeded question that the catalog has since reworded';
const STALE_IMPACT = 'Stale seeded impact';
const STALE_RATIONALE = 'Stale seeded rationale';
const STALE_OPTIONS = [{ value: 'stale_option', label: 'Stale option label' }];

function liveSpec(): PolicySpec {
  const spec = getPolicySpec(LIVE_KEY);
  if (spec === undefined) throw new Error(`test precondition: "${LIVE_KEY}" must be in POLICY_CATALOG`);
  return spec;
}

/** A policy row as the database returns it, carrying stale seeded text. */
function row(over: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: 'p1', key: LIVE_KEY, category: 'contable',
    question: STALE_QUESTION, impact: STALE_IMPACT,
    options: STALE_OPTIONS.map((o) => ({ ...o })),
    default_value: 'dos_pasos_hasta_asamblea', default_rationale: STALE_RATIONALE,
    status: 'pending', resolved_value: null, resolved_by: null,
    resolved_at: null, resolution_notes: null, priority: 1, entity_id: null,
    jurisdiction: null,
    ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('policyWording — a live key speaks with the catalog', () => {
  it('returns the catalog text even when the row carries different text, and says so', () => {
    const spec = liveSpec();
    // Precondition: without a real difference the test would pass vacuously.
    expect(spec.question).not.toBe(STALE_QUESTION);
    expect(spec.impact).not.toBe(STALE_IMPACT);
    expect(spec.defaultRationale).not.toBe(STALE_RATIONALE);

    const w = policyWording(row());

    expect(w.source).toBe('catalog');
    expect(w.question).toBe(spec.question);
    expect(w.impact).toBe(spec.impact);
    expect(w.defaultRationale).toBe(spec.defaultRationale);
    expect(w.options).toEqual(spec.options);
    // Anchored to literals too, so a change to getPolicySpec cannot move both sides.
    expect(w.options.map((o) => o.value)).toEqual(['dos_pasos_hasta_asamblea', 'directo_a_acumulados']);
    expect(w.question).not.toBe(STALE_QUESTION);
  });
});

describe('policyWording — a key the catalog no longer has keeps its snapshot', () => {
  it('returns the row copy with source "snapshot"', () => {
    expect(getPolicySpec(ORPHAN_KEY)).toBeUndefined();

    const w = policyWording(row({ key: ORPHAN_KEY }));

    expect(w).toEqual({
      question: STALE_QUESTION,
      impact: STALE_IMPACT,
      options: [{ value: 'stale_option', label: 'Stale option label' }],
      defaultRationale: STALE_RATIONALE,
      source: 'snapshot',
    });
  });

  it('turns a null options column into an empty list', () => {
    const w = policyWording(
      row({ key: ORPHAN_KEY, options: null as unknown as PolicyRow['options'], default_rationale: null })
    );

    expect(w.source).toBe('snapshot');
    expect(w.options).toEqual([]);
    expect(w.defaultRationale).toBeNull();
  });
});

describe('policyWording — the options it hands out are a copy', () => {
  it('mutating the returned list or its entries does not reach POLICY_CATALOG', () => {
    const catalogEntry = POLICY_CATALOG.find((p) => p.key === LIVE_KEY);
    if (catalogEntry === undefined) throw new Error(`test precondition: "${LIVE_KEY}" must be in POLICY_CATALOG`);
    const before = structuredClone(catalogEntry.options);

    try {
      const w = policyWording(row());
      w.options[0].label = 'Mutated by a caller';
      w.options.reverse();
      w.options.push({ value: 'injected', label: 'Injected by a caller' });

      expect(catalogEntry.options).toEqual(before);
      expect(catalogEntry.options.map((o) => o.value)).toEqual([
        'dos_pasos_hasta_asamblea',
        'directo_a_acumulados',
      ]);
      // A second caller is not handed the first caller's edits.
      expect(policyWording(row()).options).toEqual(before);
    } finally {
      // If the copy is broken, do not leave a mutated catalog for the next test.
      catalogEntry.options = before;
    }
  });
});

describe('getPolicy — screens get catalog wording, the row keeps its state', () => {
  it('a resolved row with stale text: question from the catalog, rationale = resolution_notes', async () => {
    const notes = 'Resolved by the shareholders meeting, April 2026';
    mockQuery.mockResolvedValue({
      rows: [row({
        status: 'resolved', resolved_value: 'directo_a_acumulados', resolved_by: 'victor',
        resolution_notes: notes,
      })],
      rowCount: 1,
    });

    const p = await getPolicy({ tenantId: 't1' }, LIVE_KEY);

    expect(p.defined).toBe(true);
    expect(p.value).toBe('directo_a_acumulados');
    expect(p.question).toBe(liveSpec().question);
    expect(p.question).not.toBe(STALE_QUESTION);
    // The reviewer's note is state; it must not be replaced by catalog text.
    expect(p.rationale).toBe(notes);
  });

  it('an unresolved row with stale text: question and rationale from the catalog, value = the ROW default', async () => {
    const spec = liveSpec();
    // The row's default differs from today's catalog default on purpose: the
    // wording moves to the catalog, the behaviour does not.
    expect(spec.defaultValue).toBe('dos_pasos_hasta_asamblea');
    mockQuery.mockResolvedValue({
      rows: [row({ default_value: 'directo_a_acumulados' })],
      rowCount: 1,
    });

    const p = await getPolicy({ tenantId: 't1' }, LIVE_KEY);

    expect(p.defined).toBe(false);
    expect(p.value).toBe('directo_a_acumulados');
    expect(p.question).toBe(spec.question);
    expect(p.rationale).toBe(spec.defaultRationale);
    expect(p.rationale).not.toBe(STALE_RATIONALE);
  });

  it('an unresolved orphan row still answers with its own snapshot text', async () => {
    mockQuery.mockResolvedValue({
      rows: [row({ key: ORPHAN_KEY, default_value: 'kept_value' })],
      rowCount: 1,
    });

    const p = await getPolicy({ tenantId: 't1' }, ORPHAN_KEY);

    expect(p.value).toBe('kept_value');
    expect(p.question).toBe(STALE_QUESTION);
    expect(p.rationale).toBe(STALE_RATIONALE);
  });
});
