import { describe, it, expect, vi } from 'vitest';
import {
  repVerdict,
  listPaymentsAwaitingRep,
  watchedAtClose,
  type RunQuery,
  type RepExpectation,
} from '../../../src/services/accounting/rep-expected.js';

const PPD = { metodo: 'PPD', origin: 'cfdi', assumed: false } as const;
const PUE = { metodo: 'PUE', origin: 'cfdi', assumed: false } as const;
const ASSUMED_PUE = { metodo: 'PUE', origin: 'default', assumed: true } as const;
const ASSUMED_PPD = { metodo: 'PPD', origin: 'default', assumed: true } as const;

const MEXICAN = { rows: [{ incorporation_country: 'MX', accounting_standard: 'mx_nif' }] };

describe('repVerdict (MNE-001-125)', () => {
  it('a PUE document never awaits a REP, on either side', () => {
    expect(repVerdict('received', PUE, true)).toBe('none');
    expect(repVerdict('issued', PUE, true)).toBe('none');
  });

  it('a PPD bill awaits its supplier REP, stated or by the ledger default', () => {
    expect(repVerdict('received', PPD, false)).toBe('awaits');
    expect(repVerdict('received', ASSUMED_PPD, false)).toBe('awaits');
  });

  it('an issued invoice awaits our REP only when it is stamped', () => {
    expect(repVerdict('issued', PPD, true)).toBe('awaits');
    expect(repVerdict('issued', PPD, false)).toBe('none');
  });

  it('a stamped invoice with no stated method follows the ledger (assumed PUE): unknown, not awaiting', () => {
    expect(repVerdict('issued', ASSUMED_PUE, true)).toBe('unknown_method');
    expect(repVerdict('issued', ASSUMED_PUE, false)).toBe('none');
  });
});

describe('listPaymentsAwaitingRep', () => {
  const row = (payment_id: string, over: Record<string, unknown> = {}) => ({
    payment_id, payment_number: payment_id.toUpperCase(), payment_date: '2026-08-10', counterparty: 'X',
    amount: '100.0000', currency_code: 'MXN', age_days: 3,
    cfdi_metodo: null, terms: null, memo: null, stamped: true, ...over,
  });

  it('lists each payment once, if ANY document it settles awaits a REP, and keeps the unknown issued apart', async () => {
    const runQuery = vi.fn()
      .mockResolvedValueOnce(MEXICAN)
      .mockResolvedValueOnce({
        rows: [
          row('vp-1', { cfdi_metodo: 'PUE' }),
          row('vp-1', { terms: 'PPD' }),       // same payment, a PPD bill: listed once
          row('vp-2', { terms: 'Net 30 PUE' }), // PUE by the terms token, as the ledger read it
          row('vp-3'),                           // nothing stated: the received default is PPD
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          row('cp-1', { cfdi_metodo: 'PUE' }),
          row('cp-2', { stamped: false, cfdi_metodo: 'PPD' }),
          row('cp-3', { cfdi_metodo: 'PPD' }),
          row('cp-4'),                           // stamped, no method anywhere: the ledger assumed PUE
        ],
      });
    const result = await listPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1', { periodId: 'per-8' });
    expect(result.awaiting.map((p) => [p.payment_id, p.direction, p.method])).toEqual([
      ['vp-1', 'received', 'PPD'],
      ['vp-3', 'received', 'desconocido'],
      ['cp-3', 'issued', 'PPD'],
    ]);
    expect(result.unknownIssuedMethod.map((p) => p.payment_id)).toEqual(['cp-4']);
  });

  it('a payment that settles a PPD and an unknown invoice awaits, and is not also listed as unknown', async () => {
    const runQuery = vi.fn()
      .mockResolvedValueOnce(MEXICAN)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row('cp-1'), row('cp-1', { cfdi_metodo: 'PPD' })] });
    const result = await listPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1');
    expect(result.awaiting.map((p) => p.payment_id)).toEqual(['cp-1']);
    expect(result.unknownIssuedMethod).toEqual([]);
  });

  it('asks for completed payments, live applications, stamped CFDIs, scoped to entity and period', async () => {
    const runQuery = vi.fn().mockResolvedValueOnce(MEXICAN).mockResolvedValue({ rows: [] });
    await listPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1', { periodId: 'per-8' });
    const [, [receivedSql, receivedParams], [issuedSql, issuedParams]] = runQuery.mock.calls;
    expect(receivedSql).toMatch(/FROM vendor_payments/);
    expect(issuedSql).toMatch(/FROM customer_payments/);
    expect(issuedSql).toMatch(/i\.cfdi_status = 'stamped'/);
    for (const sql of [receivedSql, issuedSql]) {
      expect(sql).toMatch(/status = 'completed'/);
      expect(sql).toMatch(/unapplied_at IS NULL/);
      expect(sql).toMatch(/cfdi_uuid IS NULL/);
      expect(sql).toMatch(/entity_id = \$1/);
      expect(sql).toMatch(/fiscal_periods WHERE id = \$2/);
    }
    expect(receivedParams).toEqual(['ent-1', 'per-8']);
    expect(issuedParams).toEqual(['ent-1', 'per-8']);
  });

  it('without a period it reads every pending payment of the entity', async () => {
    const runQuery = vi.fn().mockResolvedValueOnce(MEXICAN).mockResolvedValue({ rows: [] });
    await listPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1');
    const [, [receivedSql, receivedParams]] = runQuery.mock.calls;
    expect(receivedSql).not.toMatch(/fiscal_periods/);
    expect(receivedParams).toEqual(['ent-1']);
  });

  it('an entity that does not keep Mexican books expects no REP at all', async () => {
    for (const entity of [{ rows: [{ incorporation_country: 'US', accounting_standard: 'us_gaap' }] }, { rows: [] }]) {
      const runQuery = vi.fn().mockResolvedValueOnce(entity);
      const result = await listPaymentsAwaitingRep(runQuery as unknown as RunQuery, 'ent-1', { periodId: 'per-8' });
      expect(result).toEqual({ awaiting: [], unknownIssuedMethod: [] });
      expect(runQuery).toHaveBeenCalledTimes(1);
    }
  });
});

describe('watchedAtClose', () => {
  const p = (direction: 'received' | 'issued') => ({ direction }) as RepExpectation['awaiting'][number];
  const expectation: RepExpectation = { awaiting: [p('received'), p('issued')], unknownIssuedMethod: [] };

  it("'no_vigilar' drops the supplier side; any other answer keeps both", () => {
    expect(watchedAtClose(expectation, 'no_vigilar').map((x) => x.direction)).toEqual(['issued']);
    expect(watchedAtClose(expectation, 'avisar')).toHaveLength(2);
    expect(watchedAtClose(expectation, 'bloquear')).toHaveLength(2);
    expect(watchedAtClose(expectation, undefined)).toHaveLength(2);
  });
});
