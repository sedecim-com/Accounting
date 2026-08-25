import { describe, it, expect } from 'vitest';
import {
  REQUIRED_ACCOUNTS,
  ROLE_MAP,
} from '../../src/services/xml-ingestion/account-roles-seed.js';
import { CASES, type AccountRole } from '../../src/services/xml-ingestion/cfdi-taxonomy.js';

describe('ROLE_MAP', () => {
  it('covers every role the taxonomy can emit', () => {
    // If a case posts to a role with no account, the classifier returns
    // needs_input instead of an entry — so the map must be exhaustive.
    const used = new Set<AccountRole>();
    for (const c of CASES) {
      for (const line of c.posting ?? []) used.add(line.role);
    }
    const missing = [...used].filter((r) => !(r in ROLE_MAP));
    expect(missing, `roles without account: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps every role to a non-empty account code', () => {
    for (const [role, code] of Object.entries(ROLE_MAP)) {
      expect(code, `role ${role}`).toMatch(/^\d{4}$/);
    }
  });

  it('points each created account at a role that uses it', () => {
    // An account created by the seed but referenced by no role would be
    // dead weight in the chart.
    const mapped = new Set(Object.values(ROLE_MAP));
    const orphans = REQUIRED_ACCOUNTS.filter((a) => !mapped.has(a.code));
    expect(orphans.map((o) => o.code), 'accounts created but never used').toEqual([]);
  });
});

describe('REQUIRED_ACCOUNTS', () => {
  it('includes the accounts Mexican VAT timing needs', () => {
    const codes = REQUIRED_ACCOUNTS.map((a) => a.code);
    // Without these two, PPD cannot be recorded correctly: VAT is credited
    // when paid and charged when collected, not at invoice time.
    expect(codes).toContain('1135'); // IVA pendiente de acreditar
    expect(codes).toContain('2125'); // IVA trasladado no cobrado
  });

  it('declares a coherent normal balance for each account type', () => {
    for (const a of REQUIRED_ACCOUNTS) {
      if (a.account_type === 'asset') {
        expect(a.normal_balance, a.code).toBe('debit');
      }
      if (a.account_type === 'liability') {
        expect(a.normal_balance, a.code).toBe('credit');
      }
    }
  });

  it('gives contra accounts the balance opposite to their family', () => {
    const devVentas = REQUIRED_ACCOUNTS.find((a) => a.code === '4400')!;
    const devCompras = REQUIRED_ACCOUNTS.find((a) => a.code === '5200')!;
    // A sales return is a revenue account with a debit balance, and a
    // purchase return an expense account with a credit balance.
    expect(devVentas.account_type).toBe('revenue');
    expect(devVentas.normal_balance).toBe('debit');
    expect(devCompras.account_type).toBe('expense');
    expect(devCompras.normal_balance).toBe('credit');
  });

  it('uses unique codes that do not collide with each other', () => {
    const codes = REQUIRED_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('documents why each account exists', () => {
    for (const a of REQUIRED_ACCOUNTS) {
      expect(a.description.length, a.code).toBeGreaterThan(20);
    }
  });
});
