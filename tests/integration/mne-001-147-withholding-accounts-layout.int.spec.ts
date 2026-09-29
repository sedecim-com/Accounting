import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, getClient } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { checkWithholdingAccounts } from '../../src/ai/doctor-service.js';
import {
  applyWithholdingLayout,
  censusWithholdingLayout,
} from '../../src/services/accounting/withholding-accounts.js';
import {
  PreRegistrationService,
  registrarFacturaDeBorradorAprobado,
  type ApprovedLine,
} from '../../src/services/xml-ingestion/pre-registration-service.js';

// ============================================================
// MNE-001-147 · #309 — THE WITHHOLDING ACCOUNTS ARE THE FIRM'S CHOICE.
//
// `withholding_accounts_layout` puts the ISR and VAT the entity withholds on
// one account, one per tax or three by concept; an individual's fees CFDI and
// lease CFDI go through `bill inbox run` and each account holds only what is
// its own. `withholding_accounts_existing` decides what happens to an entity
// whose roles still sit on 2140, as before MNE-001-056: warn, repoint, keep.
// All data is synthetic.
// ============================================================

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf8');
const FEES = fixture('honorarios-pf-612.xml');
const LEASE = fixture('arrendamiento-pf-606.xml');
const WITHHOLDING = ['2140', '2141', '2142', '2143', '2144', '2145'];

let base: Fixture;
const svc = new PreRegistrationService();
const byLayout = new Map<string, Fixture>();

/** A legal entity of the same tenant (only a 12-character RFC withholds) with both vendors. */
async function entity(name: string): Promise<Fixture> {
  const e = await crearEntidadHermana(base, name);
  await query(`UPDATE legal_entities SET tax_id = 'EMP010101AB1' WHERE id = $1`, [e.entityId]);
  for (const [n, vendor, rfc] of [
    ['V-HON', 'Julian Gomez Martinez', 'GOMJ800101HA5'],
    ['V-ARR', 'Laura Ruiz Avila', 'RUAL750505KX2'],
  ]) {
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
         created_by, default_expense_account_id)
       VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6,
         (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
      [uuidv4(), e.entityId, n, vendor, rfc, e.userId]
    );
  }
  return e;
}

const upload = (e: Fixture, xml: string) =>
  svc.processXMLUpload(e.entityId, xml.replace(/UUID="[^"]+"/, `UUID="${uuidv4().toUpperCase()}"`), 'manual_upload', e.userId);

async function post(e: Fixture, xml: string): Promise<void> {
  await svc.processToAccounting((await upload(e, xml)).preRegistration, e.userId);
}

/** The approval of an AI draft of this CFDI with these lines, always rolled back. */
async function approve(e: Fixture, xml: string, approvedLines: ApprovedLine[]): Promise<void> {
  const up = await upload(e, xml);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await registrarFacturaDeBorradorAprobado(client, {
      tenantId: e.tenantId, entityId: e.entityId, preRegistrationId: String(up.preRegistration.id),
      approvedLines, approvedDescription: 'Approved draft', userId: e.userId,
      accountIdByCode: new Map((await client.query<{ code: string; id: string }>(
        'SELECT code, id FROM accounts WHERE entity_id = $1', [e.entityId])).rows.map((a) => [a.code, a.id])),
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Posted credit balance of each withholding account that holds anything. */
async function balances(e: Fixture): Promise<Record<string, string>> {
  const r = await query<{ code: string; balance: string }>(
    `SELECT a.code, SUM(COALESCE(jl.credit_amount, 0) - COALESCE(jl.debit_amount, 0))::numeric(18,2)::text AS balance
       FROM journal_entry_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
       JOIN accounts a ON a.id = jl.account_id AND a.entity_id = je.entity_id
      WHERE je.entity_id = $1 AND a.code = ANY($2::text[])
      GROUP BY a.code ORDER BY a.code`,
    [e.entityId, WITHHOLDING]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, x.balance]));
}

/** Where each withholding mapping points: `role` or `role[qualifier]` → code. */
async function mappings(e: Fixture): Promise<Record<string, string>> {
  const r = await query<{ k: string; code: string }>(
    `SELECT ar.role || COALESCE('[' || ar.qualifier || ']', '') AS k, a.code
       FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role IN ('isr_retenido_por_pagar', 'iva_retenido_por_pagar', 'isr_nomina_por_pagar')`,
    [e.entityId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.k, x.code]));
}

/** An entity as MNE-001-056 found them: both roles on 2140, no 2141 or 2142. */
async function legacy(name: string): Promise<Fixture> {
  const e = await entity(name);
  const u = await query(
    `UPDATE account_roles SET account_id = (SELECT id FROM accounts WHERE entity_id = $1 AND code = '2140')
      WHERE entity_id = $1 AND qualifier IS NULL AND role IN ('isr_retenido_por_pagar', 'iva_retenido_por_pagar')`,
    [e.entityId]
  );
  expect(u.rowCount).toBe(2);
  await query(`DELETE FROM accounts WHERE entity_id = $1 AND code IN ('2141', '2142')`, [e.entityId]);
  return e;
}

const answer = (e: Fixture, key: string, value: string) =>
  resolvePolicy({ tenantId: e.tenantId, entityId: e.entityId }, key, value, e.userId);

const checklistItem = async (e: Fixture) =>
  (await getPeriodCloseStatus(e.periodos[8], e.entityId)).checklist.find((c) => c.codigo === 'withholding-accounts-layout');

beforeAll(async () => {
  base = await crearInquilino('MNE-001-147 withholding accounts');
  await seedPolicies({ tenantId: base.tenantId });
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('withholding_accounts_existing on an entity whose roles sit on 2140', () => {
  it('warn (default): doctor and the close checklist name it and `account role sync`; nothing moves until it runs', async () => {
    const e = await legacy('Legacy warn');
    await post(e, FEES);
    const before = await balances(e);
    expect(before).toEqual({ '2140': '2066.67' });

    const doctor = await checkWithholdingAccounts({ tenantId: e.tenantId });
    expect(doctor.level).toBe('warn');
    expect(doctor.detail).toContain('Legacy warn (create 2141 ISR Retenido por Enterar; create 2142');
    expect(doctor.fix).toContain('mnemosine account role sync');
    const item = await checklistItem(e);
    expect(item).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(item?.details).toContain('isr_retenido_por_pagar: 2140 → 2141');
    expect((await explainCloseCheck(e.entityId, e.periodos[8], 'withholding-accounts-layout')).total).toBe(4);
    expect(await mappings(e)).toMatchObject({ isr_retenido_por_pagar: '2140', iva_retenido_por_pagar: '2140' });

    // The command: census, then the act, audited, with no entry posted.
    const [plan] = await censusWithholdingLayout({ entityId: e.entityId });
    await applyWithholdingLayout(plan, e.userId);
    expect(await mappings(e)).toEqual({
      isr_retenido_por_pagar: '2141', iva_retenido_por_pagar: '2142', isr_nomina_por_pagar: '2140',
    });
    const audit = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE tenant_id = $1 AND user_id = $2 AND new_values ? 'withholding_layout'`,
      [e.tenantId, e.userId]
    );
    expect(audit.rows[0].n).toBe('4');
    await post(e, LEASE);
    expect(await balances(e)).toEqual({ '2140': '2066.67', '2141': '800.00', '2142': '853.33' });
    expect(await checklistItem(e)).toMatchObject({ is_complete: true });
  }, 240_000);

  it('repoint: setting the key repoints it, audited and signed by whoever answered', async () => {
    const e = await legacy('Legacy repoint');
    const notes = await answer(e, 'withholding_accounts_existing', 'repoint');
    expect(notes).toEqual([expect.stringContaining('Legacy repoint: withholding roles repointed')]);
    expect(await mappings(e)).toMatchObject({ isr_retenido_por_pagar: '2141', iva_retenido_por_pagar: '2142' });
    const audit = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND reason LIKE 'MNE-001-147%'`,
      [e.tenantId, e.userId]
    );
    expect(audit.rows[0].n).toBe('4');
  }, 240_000);

  it('keep: no warning and no change', async () => {
    const e = await legacy('Legacy keep');
    expect(await answer(e, 'withholding_accounts_existing', 'keep')).toEqual([]);
    expect((await checkWithholdingAccounts({ tenantId: e.tenantId })).detail).not.toContain('Legacy keep');
    expect(await checklistItem(e)).toMatchObject({ is_complete: true });
    expect(await mappings(e)).toMatchObject({ isr_retenido_por_pagar: '2140', iva_retenido_por_pagar: '2140' });
  }, 240_000);

  it('a mapping someone set by hand is kept by the command and named, even on 2140', async () => {
    const e = await legacy('Legacy manual');
    await setAccountRole(e.entityId, e.tenantId, 'iva_retenido_por_pagar', e.cuentas['2140'], {
      userId: e.userId, reason: 'The firm keeps VAT withheld with payroll ISR',
    });
    const [plan] = await censusWithholdingLayout({ entityId: e.entityId });
    expect(plan.kept).toEqual([{ role: 'iva_retenido_por_pagar', qualifier: null, code: '2140' }]);
    await applyWithholdingLayout(plan, e.userId);
    expect(await mappings(e)).toMatchObject({ isr_retenido_por_pagar: '2141', iva_retenido_por_pagar: '2140' });
    expect(await checklistItem(e)).toMatchObject({ is_complete: true });
  }, 240_000);
});

describe('withholding_accounts_layout: fees and lease withholdings land on the accounts of each layout', () => {
  it.each([
    ['per_tax', { '2141': '1800.00', '2142': '1920.00' }],
    ['single', { '2143': '3720.00' }],
    ['by_concept', { '2142': '1920.00', '2144': '800.00', '2145': '1000.00' }],
  ])('%s', async (layout, expected) => {
    // Set for the tenant before the entity exists: it is born with the layout.
    const tenant = { tenantId: base.tenantId };
    await reopenPolicy(tenant, 'withholding_accounts_layout').catch(() => undefined);
    await resolvePolicy(tenant, 'withholding_accounts_layout', layout, base.userId);
    const e = await entity(`Layout ${layout}`);
    byLayout.set(layout, e);
    expect((await censusWithholdingLayout({ entityId: e.entityId }))[0].moves).toEqual([]);

    await post(e, FEES);
    await post(e, LEASE);
    expect(await balances(e)).toEqual(expected);
    expect((await mappings(e)).isr_nomina_por_pagar).toBe('2140');
    if (layout === 'by_concept') {
      const grouping = await query<{ code: string; codigo_agrupador_sat: string }>(
        `SELECT code, codigo_agrupador_sat FROM accounts WHERE entity_id = $1 AND code IN ('2142', '2144', '2145') ORDER BY code`,
        [e.entityId]
      );
      expect(grouping.rows.map((r) => `${r.code} ${r.codigo_agrupador_sat}`)).toEqual(['2142 216.10', '2144 216.03', '2145 216.04']);
    }
  }, 240_000);

  it('by_concept: approving a lease draft checks the ISR on 2144 and 2145 apart from the VAT on 2142', async () => {
    const e = byLayout.get('by_concept') as Fixture;
    const lines = (isr: string, vat: string): ApprovedLine[] => [
      { account_code: '6100', debit: 8000 }, { account_code: '1130', debit: 1280 },
      { account_code: isr, credit: 800 }, { account_code: vat, credit: 853.33 },
      { account_code: '2110', credit: 7626.67 },
    ];
    await expect(approve(e, LEASE, lines('2144', '2142'))).resolves.toBeUndefined();
    await expect(approve(e, LEASE, lines('2142', '2144'))).rejects.toMatchObject({ code: 'CFDI_RECONCILIATION_FAILED' });
  }, 240_000);
});
