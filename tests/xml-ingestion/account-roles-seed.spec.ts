import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import {
  NON_POSTING_ROLES,
  REQUIRED_ACCOUNTS,
  ROLE_MAP,
  rolesPara,
  seedAccountRoles,
} from '../../src/services/xml-ingestion/account-roles-seed.js';
import { BASE_CHART_MX, CATALOGO_UNIVERSAL, catalogoBasePara } from '../../src/services/accounting/chart-seed.js';
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

describe('the cash role (BAN-1, #324)', () => {
  // The cash-flow statement reads `efectivo` and its descendants as cash, so
  // wherever `banco` posts has to sit inside that tree, or a bank's money
  // would leave the statement the day `banco` moves.
  it.each([
    ['a Mexican entity', true],
    ['a non-Mexican entity', false],
  ])('anchors cash on 1110 and keeps the bank account inside its tree for %s', (_label, mexican) => {
    const chart = catalogoBasePara(mexican);
    const parentOf = new Map(chart.map((a) => [a.code, a.parent]));
    const roles = rolesPara(mexican);
    expect(roles.efectivo).toBe('1110');

    const ancestry: string[] = [];
    for (let code: string | undefined = roles.banco; code; code = parentOf.get(code)) {
      ancestry.push(code);
    }
    expect(ancestry, `banco → ${roles.banco}`).toContain(roles.efectivo);
  });

  it('is declared non-posting, and no CFDI case posts to a non-posting role', () => {
    expect(NON_POSTING_ROLES).toContain('efectivo');
    const posted = new Set(CASES.flatMap((c) => (c.posting ?? []).map((l) => l.role)));
    expect(NON_POSTING_ROLES.filter((r) => posted.has(r))).toEqual([]);
  });
});

describe('the bank role (BAN-1, #324)', () => {
  // Posting to an account that has children breaks every report that rolls
  // balances up the hierarchy: the parent carries a balance of its own on top
  // of the sum of its children. 1110 «Caja y Bancos» is the parent of the bank
  // accounts, so the role that every collection and payment posts to cannot
  // live there.
  it.each([
    ['a Mexican entity', true, '1111'],
    ['a non-Mexican entity', false, '1115'],
  ])('lands on a leaf of the chart seeded for %s', (_label, mexican, leaf) => {
    const chart = catalogoBasePara(mexican);
    const parents = new Set(chart.map((a) => a.parent).filter(Boolean));
    const bank = rolesPara(mexican).banco;
    expect(bank).toBe(leaf);
    expect(chart.map((a) => a.code), `${leaf} must be seeded`).toContain(leaf);
    expect(parents.has(bank!), `${bank} has children`).toBe(false);
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

describe('where a role account hangs (MNE-001-482)', () => {
  // Left at the root, a role account is outside Activo and Pasivo: a migrated
  // trial balance that nests 1135 under 1100 then leaves 1135's balance on
  // the header, and the opening refuses it.
  it('U1 · names a parent on every entry, and that parent is a header of the universal chart', () => {
    const headers = new Set(CATALOGO_UNIVERSAL.filter((a) => a.header === true).map((a) => a.code));
    const offHeader = REQUIRED_ACCOUNTS.filter((a) => a.parent === undefined || !headers.has(a.parent));
    // 6140 keeps the parent the base chart gives it, 6100, which takes entries.
    expect(offHeader.map((a) => [a.code, a.parent])).toEqual([['6140', '6100']]);
    expect(REQUIRED_ACCOUNTS.find((a) => a.code === '1290')?.parent).toBe('1200');
  });

  it('U2 · names the same parent as the base chart on the codes both lists seed', () => {
    const inBase = new Map(BASE_CHART_MX.map((a) => [a.code, a.parent]));
    const shared = REQUIRED_ACCOUNTS.filter((a) => inBase.has(a.code));
    expect(shared.map((a) => a.code).sort()).toEqual(['1130', '1290', '2120', '4300', '6140']);
    for (const a of shared) expect(a.parent, a.code).toBe(inBase.get(a.code));
  });

  /** A client that answers the seeder's three statements and keeps the account INSERTs. */
  const seedOver = async (existing: Array<{ code: string; id: string; is_header: boolean }>) => {
    const inserted = new Map<string, unknown>();
    const client = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT')) return { rows: existing };
        if (sql.includes('INSERT INTO accounts')) {
          inserted.set(String(params[0]), params[8]);
          return { rows: [{ id: `new-${String(params[0])}` }] };
        }
        return { rowCount: 1 };
      },
    } as unknown as pg.PoolClient;
    await seedAccountRoles('entity', 'tenant', 'user', { client });
    return inserted;
  };

  it('U3 · hangs 1135 from 1100 only when the entity has 1100 as a header', async () => {
    const seeded = await seedOver([{ code: '1100', id: 'id-1100', is_header: true }]);
    expect(seeded.get('1135')).toBe('id-1100');
    // No 2100 here: the liabilities stay at the root.
    expect(seeded.get('2125')).toBeNull();

    // An imported chart where 1100 is an account that takes entries.
    const posting = await seedOver([{ code: '1100', id: 'id-1100', is_header: false }]);
    expect(posting.get('1135')).toBeNull();

    const missing = await seedOver([]);
    expect(missing.size).toBe(REQUIRED_ACCOUNTS.length);
    expect([...missing.values()].every((parentId) => parentId === null)).toBe(true);
  });
});
