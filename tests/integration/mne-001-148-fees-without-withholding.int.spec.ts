import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';

// ============================================================
// MNE-001-148 · #309 — PROFESSIONAL FEES WITH NO ISR WITHHELD, AGAINST POSTGRES.
//
// A legal entity receives an individual's (regime 612) legal-services CFDI
// that declares no withholding, through `bill inbox run` (upload, then
// processToAccounting). `fees_without_withholding` is answered on the panel
// with each of its three values; the rates come from migration 129. A
// purchase of goods from the same issuer, and fees that do declare the
// withholding, are not touched. All data is synthetic.
// ============================================================

const FEES = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'honorarios-pf-612.xml'), 'utf8');
const SILENT = FEES.replace(/<cfdi:Retenciones>[\s\S]*?<\/cfdi:Retenciones>/g, '')
  .replace(' TotalImpuestosRetenidos="2066.67"', '')
  .replace('Total="9533.33"', 'Total="11600.00"');
const GOODS = SILENT.replace('ClaveProdServ="80121600"', 'ClaveProdServ="44121600"');
const KEY = 'fees_without_withholding';

let f: Fixture;
const svc = new PreRegistrationService();
const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId });

async function answer(value: string) {
  const row = await query<{ status: string }>(
    `SELECT status FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = $3`,
    [f.tenantId, f.entityId, KEY]
  );
  if (row.rows[0]?.status !== 'pending') await reopenPolicy(ctx(), KEY);
  await resolvePolicy(ctx(), KEY, value, f.userId);
}

/** Runs one CFDI through the inbox; returns its pre-registration and, if it posted, its entry. */
async function run(xml: string): Promise<{ preRegId: string; uuid: string; entryId?: string; error?: string }> {
  const uuid = uuidv4().toUpperCase();
  const up = await svc.processXMLUpload(f.entityId, xml.replace(/UUID="[^"]+"/, `UUID="${uuid}"`), 'manual_upload', f.userId);
  const preRegId = up.preRegistration.id as string;
  try {
    const r = await svc.processToAccounting(up.preRegistration, f.userId);
    return { preRegId, uuid, entryId: (r.bill as { journal_entry_id: string }).journal_entry_id };
  } catch (e) {
    return { preRegId, uuid, error: (e as { code?: string }).code };
  }
}

const withheldLines = async (entryId: string) =>
  (await query<{ code: string; credit: string }>(
    `SELECT a.code, jl.credit_amount::text AS credit FROM journal_entry_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = $1 AND a.code IN ('2140', '2141', '2142') ORDER BY a.code`,
    [entryId]
  )).rows;
const entryCount = async () =>
  Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId])).rows[0].n);
const facts = async (uuid: string) =>
  (await query<{ facts: Record<string, unknown> }>(
    `SELECT facts FROM cfdi_classifications WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid]
  )).rows[0]?.facts;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-148 fees without withholding');
  await query(`UPDATE legal_entities SET tax_id = 'EMP010101AB1' WHERE id = $1`, [f.entityId]);
  await seedPolicies(ctx());
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code,
       created_by, default_expense_account_id)
     VALUES ($1, $2, 'V-HON', 'Julian Gomez Martinez', 'GOMJ800101HA5', 'rfc', 'MXN', $3,
       (SELECT id FROM accounts WHERE entity_id = $2 AND code = '6100'))`,
    [uuidv4(), f.entityId, f.userId]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('fees_without_withholding, one value at a time', () => {
  it('DEFAULT: held asking for a substitute CFDI, and the ledger untouched', async () => {
    const before = await entryCount();
    const r = await run(SILENT);
    expect(r.error).toBe('CFDI_REQUIERE_DECISION');
    const pre = await query<{ validation_status: string; error_message: string }>(
      `SELECT validation_status, error_message FROM pre_registrations WHERE id = $1`, [r.preRegId]
    );
    expect(pre.rows[0].validation_status).toBe('needs_review');
    expect(pre.rows[0].error_message).toMatch(/Ask the vendor for a substitute CFDI/);
    expect(await entryCount()).toBe(before);
    expect((await facts(r.uuid))?.feesWithoutWithholding).toBe('request_substitute_cfdi');
  }, 120_000);

  it("withhold_by_law: the law's withholding is computed from migration 129 and the entry is held", async () => {
    await answer('withhold_by_law');
    const before = await entryCount();
    const r = await run(SILENT);
    expect(r.error).toBe('CFDI_REQUIERE_DECISION');
    const pre = await query<{ error_message: string }>(`SELECT error_message FROM pre_registrations WHERE id = $1`, [r.preRegId]);
    expect(pre.rows[0].error_message).toMatch(/held for review.*ISR 1000\.00 and VAT 1066\.67/);
    expect((await facts(r.uuid))?.withholdingDue).toEqual({ isr: 1000, iva: 1066.67 });
    expect(await entryCount()).toBe(before);
  }, 120_000);

  it('record_as_issued: posts with no withholding, warns, and the close checklist lists it', async () => {
    await answer('record_as_issued');
    const r = await run(SILENT);
    expect(r.error).toBeUndefined();
    expect(await withheldLines(r.entryId!)).toEqual([]);
    const pre = await query<{ validation_warnings: string[] }>(
      `SELECT validation_warnings FROM pre_registrations WHERE id = $1`, [r.preRegId]
    );
    expect(pre.rows[0].validation_warnings.join('\n')).toMatch(/LISR 27-V/);

    const st = await getPeriodCloseStatus(f.periodos[8], f.entityId);
    const box = st.checklist.find((i) => i.codigo === 'fees-without-withholding')!;
    expect(box).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(box.details).toMatch(/^1 fees CFDI\(s\) recorded as issued/);
    const explained = await explainCloseCheck(f.entityId, f.periodos[8], 'fees-without-withholding');
    expect(explained.renglones.map((x) => x.cfdi_uuid)).toEqual([r.uuid]);
    // Another month has nothing to say.
    const july = await getPeriodCloseStatus(f.periodos[7], f.entityId);
    expect(july.checklist.find((i) => i.codigo === 'fees-without-withholding')!.is_complete).toBe(true);
  }, 120_000);
});

describe('what the policy does not touch, under the default', () => {
  it('a purchase of goods from the same 612 issuer posts, not flagged', async () => {
    await answer('request_substitute_cfdi');
    const r = await run(GOODS);
    expect(r.error).toBeUndefined();
    expect((await facts(r.uuid))?.feesWithoutWithholding).toBeUndefined();
  }, 120_000);

  it('fees that declare the withholding keep MNE-001-056: posted on 2141 and 2142', async () => {
    const r = await run(FEES);
    expect(r.error).toBeUndefined();
    expect(await withheldLines(r.entryId!)).toEqual([
      { code: '2141', credit: '1000.0000' },
      { code: '2142', credit: '1066.6700' },
    ]);
  }, 120_000);
});
