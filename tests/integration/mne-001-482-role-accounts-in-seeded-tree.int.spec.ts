import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { checkOpeningBalance, importOpeningBalance } from '../../src/services/accounting/opening-balance.js';
import { rolesPara, seedAccountRoles } from '../../src/services/xml-ingestion/account-roles-seed.js';

// ============================================================
// MNE-001-482 · THE ROLE ACCOUNTS ARE BORN INSIDE THE SEEDED TREE
//
// A new entity's role accounts used to be created with no parent. A previous
// system's trial balance that reuses the seeded codes nests 1135 under
// Activo Circulante and 2125 under Pasivo Circulante, as an Anexo 24 file
// does. The opening subtracts from each account what its descendants carry
// by OUR tree, so with 1135 a root the file's 1100 kept 320.00 of its own
// and the load refused the header (APE-CUENTA-NO-POSTEABLE); the check then
// differed at 1100, 1000, 2100 and 2000.
//
// The file, at 2025-12-31 (1,000 + 320 = 480 + 840):
//   1000 Activo 1,320 ─ 1100 Activo Circulante 1,320 ─ 1110 Caja y Bancos 1,000 ─ 1111 1,000
//                                                    └ 1135 IVA Pendiente de Acreditar 320
//   2000 Pasivo 480 ─ 2100 Pasivo Circulante 480 ─ 2125 IVA Trasladado No Cobrado 480
//   3000 Capital Contable 840 ─ 3100 Capital Social 840
//
// Runs as the superuser, like the other specs on `crearInquilino`.
// ============================================================

let f: Fixture;

const RFC = 'XAXX010101000';
const SOURCE: ReadonlyArray<readonly [string, string]> = [
  ['1000', '1320.00'], ['1100', '1320.00'], ['1110', '1000.00'], ['1111', '1000.00'], ['1135', '320.00'],
  ['2000', '480.00'], ['2100', '480.00'], ['2125', '480.00'],
  ['3000', '840.00'], ['3100', '840.00'],
];
const TRIAL_BALANCE_XML =
  `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza ` +
  `xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
  `Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
  SOURCE.map(([code, balance]) =>
    `<BCE:Ctas NumCta="${code}" SaldoIni="${balance}" Debe="0.00" Haber="0.00" SaldoFin="${balance}"/>`).join('') +
  '</BCE:Balanza>';

/** Decision 2 of the plan: each role account under the header of its class. */
const SEEDED_UNDER: Record<string, string[]> = {
  '1100': ['1135', '1145', '1146', '1150', '1160', '1165'],
  '2100': ['2125', '2141', '2142', '2150', '2160', '2170', '2180', '2190'],
  '4000': ['4310', '4320', '4400'],
  '5000': ['5200'],
  '6000': ['6310', '6320', '6900'],
};

const ctx = (): { tenantId: string; entityId: string } => ({ tenantId: f.tenantId, entityId: f.entityId });

async function parentCodeOf(codes: string[]): Promise<Record<string, string | null>> {
  const r = await query<{ code: string; parent_code: string | null }>(
    `SELECT a.code, p.code AS parent_code
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id AND p.entity_id = a.entity_id
      WHERE a.entity_id = $1 AND a.code = ANY($2::text[])`,
    [f.entityId, codes]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, x.parent_code]));
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-482 role accounts in the seeded tree');
  enterTenant(f.tenantId);
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a new entity (MNE-001-482)', () => {
  it('T1 · has each role account under the header of its class, and no posting role on a parent it did not have', async () => {
    const expected = Object.fromEntries(
      Object.entries(SEEDED_UNDER).flatMap(([parent, codes]) => codes.map((code) => [code, parent]))
    );
    expect(Object.keys(expected)).toHaveLength(21);
    expect(await parentCodeOf(Object.keys(expected))).toEqual(expected);
    // The base chart's twins are where they were.
    expect(await parentCodeOf(['1130', '2120'])).toEqual({ '1130': '1100', '2120': '2100' });

    // No role lands on an account that has children (BAN-1, #324), but for
    // the two cases older than this task: 1110, which `efectivo` only reads,
    // and 6100, which `gasto` and `impuestos_locales_gasto` post to and the
    // criterion `posting-roles-point-to-leaf-accounts` keeps named.
    const withChildren = await query<{ code: string }>(
      `SELECT DISTINCT a.code
         FROM accounts a
        WHERE a.entity_id = $1 AND a.code = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id AND c.entity_id = a.entity_id)
        ORDER BY a.code`,
      [f.entityId, [...new Set(Object.values(rolesPara(true)))]]
    );
    expect(withChildren.rows.map((x) => x.code)).toEqual(['1110', '6100']);
  });

  it('T2 · loads a trial balance that nests 1135 under 1100 and 2125 under 2100, with nothing on the headers', async () => {
    const r = await importOpeningBalance(ctx(), {
      entityId: f.entityId, xml: TRIAL_BALANCE_XML, userId: f.userId, reason: 'MNE-001-482',
    });
    expect(r.findings.filter((x) => x.severidad === 'bloquea').map((x) => [x.regla, x.numCta, x.mensaje])).toEqual([]);
    expect(r.findings.map((x) => x.regla)).not.toContain('APE-CUENTA-NO-POSTEABLE');
    expect(r.escrito).toBe(true);

    const lines = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
        WHERE jel.journal_entry_id = $1
        ORDER BY a.code`,
      [r.asiento?.id]
    );
    expect(lines.rows.map((l) => [l.code, Number(l.debit ?? 0).toFixed(2), Number(l.credit ?? 0).toFixed(2)])).toEqual([
      ['1111', '1000.00', '0.00'],
      ['1135', '320.00', '0.00'],
      ['2125', '0.00', '480.00'],
      ['3100', '0.00', '840.00'],
    ]);
  });

  it('T3 · the check finds the ledger equal to the file at every header', async () => {
    const { comparison } = await checkOpeningBalance(ctx(), { entityId: f.entityId, xml: TRIAL_BALANCE_XML });
    expect(comparison.diferencias).toEqual([]);
    expect(comparison).toMatchObject({ iguales: true, comparadas: 10 });
    const differing = comparison.diferencias.map((d) => d.numCta);
    for (const header of ['1100', '1000', '2100', '2000']) expect(differing).not.toContain(header);
  });

  it('T4 · a second seed creates nothing, and never re-hangs an account someone left at the root', async () => {
    const second = await seedAccountRoles(f.entityId, f.tenantId, f.userId);
    expect(second).toMatchObject({ accountsCreated: [], rolesMapped: 0 });

    const detached = await query(
      `UPDATE accounts SET parent_id = NULL
        WHERE entity_id = $1 AND code = '1135' AND parent_id IS NOT NULL`,
      [f.entityId]
    );
    expect(detached.rowCount).toBe(1);
    const third = await seedAccountRoles(f.entityId, f.tenantId, f.userId);
    expect(third.accountsCreated).toEqual([]);
    expect(await parentCodeOf(['1135'])).toEqual({ '1135': null });
  });
});
