import { describe, it, expect, vi, type Mock } from 'vitest';
import { ContalinkAdapter } from '../../../src/services/integrations/accounting/contalink-adapter.js';

function fakeFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

describe('ContalinkAdapter', () => {
  it('sends the RAW API key in Authorization (not Bearer) and respects the baseUrl', async () => {
    const f = fakeFetch({ status: 1, trial_balance: { items: [] } });
    const a = new ContalinkAdapter('mi-key', 'https://api.ejemplo/prod', f);
    await a.getTrialBalance('2026-08-01', '2026-08-31');
    const [url, init] = (f as unknown as Mock).mock.calls[0];
    expect(url).toBe('https://api.ejemplo/prod/accounting/trial-balance/?start_date=2026-08-01&end_date=2026-08-31&period=O');
    expect(init.headers.Authorization).toBe('mi-key');
  });

  it('treats status:0 as an ERROR even when the HTTP is 200 (Contalink inverted convention)', async () => {
    const f = fakeFetch({ status: 0, message: 'Invalid API key' });
    const a = new ContalinkAdapter('k', 'https://x', f);
    await expect(a.getTrialBalance('2026-01-01', '2026-01-31')).rejects.toThrow(/Invalid API key/);
  });

  it('normalizes the trial balance: Spanish fields and string amounts → numbers', async () => {
    const f = fakeFetch({
      status: 1,
      trial_balance: {
        items: [
          { cuenta: 'Bancos', cuenta_numero: '102-01', debe: '1,500.50', haber: '500.00', final_saldo: '1000.50' },
        ],
      },
    });
    const a = new ContalinkAdapter('k', 'https://x', f);
    const rows = await a.getTrialBalance('2026-08-01', '2026-08-31');
    expect(rows).toEqual([
      { account_code: '102-01', account_name: 'Bancos', period_debits: 1500.5, period_credits: 500, ending_balance: 1000.5 },
    ]);
  });

  it('creates a manual journal entry with the exact contract (accounting_records, record_date)', async () => {
    const f = fakeFetch({ status: 1, policy_data: {} });
    const a = new ContalinkAdapter('k', 'https://x', f);
    await a.createManualPolicy({
      record_date: '2026-08-24', description: 'Ajuste',
      records: [{ account_code: '601-01', debit: 100, credit: 0 }],
    });
    const [url, init] = (f as unknown as Mock).mock.calls[0];
    expect(url).toBe('https://x/accounting/manual-accounting-policy/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      record_date: '2026-08-24', description: 'Ajuste',
      accounting_records: [{ account_code: '601-01', debit: 100, credit: 0 }],
    });
  });

  it('reports HTTP errors with the status', async () => {
    const f = fakeFetch({}, false, 503);
    const a = new ContalinkAdapter('k', 'https://x', f);
    await expect(a.getAccountBalance('102-01', '2026-08-24')).rejects.toThrow(/HTTP 503/);
  });
});
