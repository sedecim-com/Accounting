import { describe, it, expect, vi } from 'vitest';
import {
  awaitsRep,
  countPaymentsAwaitingRep,
  type RunQuery,
} from '../../../src/services/accounting/rep-expected.js';

const PPD = { metodo: 'PPD', origin: 'cfdi', assumed: false } as const;
const PUE = { metodo: 'PUE', origin: 'cfdi', assumed: false } as const;
const ASSUMED_PUE = { metodo: 'PUE', origin: 'default', assumed: true } as const;

describe('awaitsRep (MNE-001-125)', () => {
  it('a PUE document never awaits a REP, on either side', () => {
    expect(awaitsRep('received', PUE, true)).toBe(false);
    expect(awaitsRep('issued', PUE, true)).toBe(false);
  });

  it('a PPD bill awaits its supplier REP', () => {
    expect(awaitsRep('received', PPD, false)).toBe(true);
  });

  it('an issued invoice awaits our REP only when it is stamped', () => {
    expect(awaitsRep('issued', PPD, true)).toBe(true);
    expect(awaitsRep('issued', PPD, false)).toBe(false);
  });

  it('a stamped invoice whose method nothing states is listed with the doubt; an unstamped one is not', () => {
    expect(awaitsRep('issued', ASSUMED_PUE, true)).toBe(true);
    expect(awaitsRep('issued', ASSUMED_PUE, false)).toBe(false);
  });
});

describe('countPaymentsAwaitingRep', () => {
  const row = (payment_id: string, over: Record<string, unknown> = {}) => ({
    payment_id, cfdi_metodo: null, terms: null, memo: null, stamped: true, ...over,
  });

  it('counts each payment once, if ANY document it settles awaits a REP', async () => {
    const runQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          row('vp-1', { cfdi_metodo: 'PUE' }),
          row('vp-1', { terms: 'PPD' }),       // same payment, a PPD bill: counts once
          row('vp-2', { terms: 'Net 30 PUE' }), // PUE by the terms token, as the ledger read it
          row('vp-3'),                           // nothing stated: the received default is PPD
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          row('cp-1', { cfdi_metodo: 'PUE' }),
          row('cp-2', { stamped: false }),
          row('cp-3', { cfdi_metodo: 'PPD' }),
        ],
      });
    const result = await countPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1', 'per-8');
    expect(result).toEqual({ received: 2, issued: 1 });
  });

  it('asks for completed payments only, live applications only, scoped to entity and period', async () => {
    const runQuery = vi.fn().mockResolvedValue({ rows: [] });
    await countPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1', 'per-8');
    const [[receivedSql, receivedParams], [issuedSql, issuedParams]] = runQuery.mock.calls;
    expect(receivedSql).toMatch(/FROM vendor_payments/);
    expect(issuedSql).toMatch(/FROM customer_payments/);
    for (const sql of [receivedSql, issuedSql]) {
      expect(sql).toMatch(/status = 'completed'/);
      expect(sql).toMatch(/unapplied_at IS NULL/);
      expect(sql).toMatch(/cfdi_uuid IS NULL/);
      expect(sql).toMatch(/entity_id = \$1/);
    }
    expect(receivedParams).toEqual(['ent-1', 'per-8']);
    expect(issuedParams).toEqual(['ent-1', 'per-8']);
  });
});
