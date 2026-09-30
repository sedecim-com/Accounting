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
// MNE-001-057 · #309 — FREIGHT, RESICO AND THE FLAGGED DISCREPANCY, AGAINST
// POSTGRES.
//
// A legal entity receives a land-freight CFDI and a RESICO individual's
// consulting CFDI through `bill inbox run` (upload, then processToAccounting)
// on a migrated database: the rates come from migration 175, with no seeder.
// A freight CFDI declaring 6 % instead of 4 % is held with the discrepancy as
// its reason and a question in the classification trail, and the ledger is not
// touched. All data is synthetic.
// ============================================================

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf8');
const FREIGHT = fixture('fletes-pm.xml');
const RESICO = fixture('resico-pf-626.xml');
const ENTITY_RFC = 'EMP010101AB1';

let f: Fixture;
const svc = new PreRegistrationService();

async function upload(xml: string) {
  const uuid = uuidv4().toUpperCase();
  const fresh = xml.replace(/UUID="[^"]+"/, `UUID="${uuid}"`);
  const up = await svc.processXMLUpload(f.entityId, fresh, 'manual_upload', f.userId);
  return { uuid, preRegistration: up.preRegistration };
}

async function post(xml: string): Promise<string> {
  const { preRegistration } = await upload(xml);
  const r = await svc.processToAccounting(preRegistration, f.userId);
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
  f = await crearInquilino('MNE-001-057 withholdings');
  // A legal entity: only a 12-character RFC withholds.
  await query(`UPDATE legal_entities SET tax_id = $2 WHERE id = $1`, [f.entityId, ENTITY_RFC]);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  for (const [n, name, rfc] of [
    ['V-FLE', 'Transportes de Carga Sinteticos SA de CV', 'TCA010101AB2'],
    ['V-RES', 'Lucia Morales Pena', 'MOPL800101HB3'],
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

describe('withholdings on freight and RESICO', () => {
  it('the two rates are in legal_parameters, dated and sourced, without running any seeder', async () => {
    const freight = await legalParameterAt('MX', WITHHOLDING_KEYS.freightVat, '2026-08-01');
    expect([freight.value, freight.effectiveFrom]).toEqual(['0.0400', '2006-12-05']);
    expect(freight.sourceUrl).toMatch(/Reg_LIVA/);
    const resico = await legalParameterAt('MX', WITHHOLDING_KEYS.resicoIsr, '2026-08-01');
    expect([resico.value, resico.effectiveFrom]).toEqual(['0.0125', '2022-01-01']);
    // RESICO did not exist before 2022: the law is not read back into 2021.
    await expect(legalParameterAt('MX', WITHHOLDING_KEYS.resicoIsr, '2021-12-31')).rejects.toThrow();
  });

  it('freight withholds 4 % VAT and RESICO 1.25 % ISR, on the role accounts, whose balance is the sum', async () => {
    const entries = [await post(FREIGHT), await post(RESICO)];
    const { rows } = await query<{ code: string; credit: string }>(
      `SELECT a.code, jl.credit_amount::text AS credit
         FROM journal_entry_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = ANY($1::uuid[]) AND a.code IN ('2140', '2141', '2142')
        ORDER BY jl.credit_amount`,
      [entries]
    );
    expect(rows).toEqual([
      { code: '2141', credit: '125.0000' },
      { code: '2142', credit: '400.0000' },
      { code: '2142', credit: '1066.6700' },
    ]);
    expect(await roleBalance('isr_retenido_por_pagar')).toEqual({ code: '2141', balance: '125.00' });
    expect(await roleBalance('iva_retenido_por_pagar')).toEqual({ code: '2142', balance: '1466.67' });
  }, 120_000);

  it('ACCEPTANCE: a CFDI withholding different from the computed one is flagged and asked, and the ledger is untouched', async () => {
    const sixPercent = FREIGHT.replace(/Importe="400\.00"/g, 'Importe="600.00"')
      .replace('TotalImpuestosRetenidos="400.00"', 'TotalImpuestosRetenidos="600.00"')
      .replace('Total="11200.00"', 'Total="11000.00"');
    const { uuid, preRegistration } = await upload(sixPercent);
    const held = await svc.processToAccounting(preRegistration, f.userId).then(
      () => null,
      (e: unknown) => e as { code?: string; message: string }
    );
    expect(held?.code).toBe('CFDI_REQUIERE_DECISION');
    expect(held?.message).toMatch(/VAT 400\.00, but the CFDI declares ISR 0\.00 and VAT 600\.00/);

    const pre = await query<{ status: string; validation_status: string; error_message: string }>(
      `SELECT status, validation_status, error_message FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
      [preRegistration.id, f.entityId]
    );
    expect(pre.rows[0]).toMatchObject({ status: 'draft', validation_status: 'needs_review' });
    expect(pre.rows[0].error_message).toMatch(/Withholding by law on a freight CFDI/);

    const trail = await query<{ status: string; decisions: Array<{ id: string; question: string }> }>(
      `SELECT status, decisions FROM cfdi_classifications WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, uuid]
    );
    expect(trail.rows[0].status).toBe('pending');
    expect(trail.rows[0].decisions.map((d) => d.id)).toEqual(['withholding_mismatch']);

    // The CFDI is not corrected and nothing reached the ledger.
    expect(await roleBalance('iva_retenido_por_pagar')).toEqual({ code: '2142', balance: '1466.67' });
    const xml = await query<{ xml_content: string }>(
      `SELECT xml_content FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, uuid]
    );
    expect(xml.rows[0].xml_content).toContain('TotalImpuestosRetenidos="600.00"');
  }, 120_000);
});
