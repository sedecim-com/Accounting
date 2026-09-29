import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { legalParameterAt } from '../../src/services/jurisdiction/legal-parameters.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { WITHHOLDING_KEYS } from '../../src/services/xml-ingestion/withholding-law.js';

// ============================================================
// MNE-001-056 · #309 — WITHHOLDINGS ON FEES AND LEASES, AGAINST POSTGRES.
//
// A legal entity receives an individual's professional-fees CFDI and a lease
// CFDI. Both go through `bill inbox run` (upload, then processToAccounting) on
// a migrated database: the rates come from migration 129, with no seeder. The
// withheld ISR and VAT land on the new role accounts, and each balance is the
// sum of what was withheld, which is what #308 reads for the 17th.
// All data is synthetic.
// ============================================================

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf8');
const FEES = fixture('honorarios-pf-612.xml');
const LEASE = fixture('arrendamiento-pf-606.xml');
const ENTITY_RFC = 'EMP010101AB1';

let f: Fixture;
const svc = new PreRegistrationService();

async function post(xml: string): Promise<string> {
  const fresh = xml.replace(/UUID="[^"]+"/, `UUID="${uuidv4().toUpperCase()}"`);
  const up = await svc.processXMLUpload(f.entityId, fresh, 'manual_upload', f.userId);
  const r = await svc.processToAccounting(up.preRegistration, f.userId);
  return (r.bill as { journal_entry_id: string }).journal_entry_id;
}

/** The posted balance of the account a role points to, as #308 would read it. */
async function roleBalance(role: string): Promise<{ code: string; balance: string }> {
  const r = await query<{ code: string; balance: string }>(
    `SELECT a.code, COALESCE(SUM(COALESCE(jl.credit_amount, 0) - COALESCE(jl.debit_amount, 0))
                     FILTER (WHERE je.status = 'posted'), 0)::numeric(18,2)::text AS balance
       FROM account_roles ar
       JOIN accounts a ON a.id = ar.account_id
       LEFT JOIN journal_entry_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.entity_id = ar.entity_id
      WHERE ar.entity_id = $1 AND ar.role = $2 AND ar.qualifier IS NULL
      GROUP BY a.code`,
    [f.entityId, role]
  );
  return r.rows[0];
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-056 withholdings');
  // A legal entity: only a 12-character RFC withholds.
  await query(`UPDATE legal_entities SET tax_id = $2 WHERE id = $1`, [f.entityId, ENTITY_RFC]);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  for (const [n, name, rfc] of [
    ['V-HON', 'Julian Gomez Martinez', 'GOMJ800101HA5'],
    ['V-ARR', 'Laura Ruiz Avila', 'RUAL750505KX2'],
  ]) {
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
         created_by, default_expense_account_id)
       VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6,
         (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
      [uuidv4(), f.entityId, n, name, rfc, f.userId]
    );
  }
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('withholdings on an individual\'s fees and lease', () => {
  it('the rates are in legal_parameters, dated and sourced, without running any seeder', async () => {
    const on = '2026-08-01';
    expect((await legalParameterAt('MX', WITHHOLDING_KEYS.professionalFeesIsr, on)).value).toBe('0.1000');
    expect((await legalParameterAt('MX', WITHHOLDING_KEYS.leaseIsr, on)).value).toBe('0.1000');
    const thirds = await legalParameterAt('MX', WITHHOLDING_KEYS.vatThirds, on);
    expect([thirds.value, thirds.unit]).toEqual(['2.0000', 'thirds']);
    expect(thirds.sourceUrl).toMatch(/Reg_LIVA/);
  });

  it('ACCEPTANCE: ISR and VAT withheld by law land on new role accounts whose balance is the sum withheld', async () => {
    const entries = [await post(FEES), await post(LEASE)];
    const { rows } = await query<{ code: string; credit: string }>(
      `SELECT a.code, jl.credit_amount::text AS credit
         FROM journal_entry_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = ANY($1::uuid[]) AND a.code IN ('2140', '2141', '2142')
        ORDER BY jl.credit_amount`,
      [entries]
    );
    expect(rows).toEqual([
      { code: '2141', credit: '800.0000' },
      { code: '2142', credit: '853.3300' },
      { code: '2141', credit: '1000.0000' },
      { code: '2142', credit: '1066.6700' },
    ]);

    expect(await roleBalance('isr_retenido_por_pagar')).toEqual({ code: '2141', balance: '1800.00' });
    expect(await roleBalance('iva_retenido_por_pagar')).toEqual({ code: '2142', balance: '1920.00' });
    // Payroll ISR keeps 2140: the new accounts hold only what was withheld from vendors.
    expect((await roleBalance('isr_nomina_por_pagar')).code).toBe('2140');
  }, 120_000);

  it('a lease that declares no withholding is held, not booked without the one the law requires', async () => {
    const silent = LEASE.replace(/<cfdi:Retenciones>[\s\S]*?<\/cfdi:Retenciones>/g, '')
      .replace(' TotalImpuestosRetenidos="1653.33"', '')
      .replace('Total="7626.67"', 'Total="9280.00"');
    await expect(post(silent)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    expect(await roleBalance('isr_retenido_por_pagar')).toEqual({ code: '2141', balance: '1800.00' });
  }, 120_000);
});
