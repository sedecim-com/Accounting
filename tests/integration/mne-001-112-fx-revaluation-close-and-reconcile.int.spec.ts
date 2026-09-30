import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';

/**
 * MNE-001-112 (#305) · the closing revaluation inside the close conductor and
 * the AR/AP reconciliations, and the transition rule of its panel keys.
 *
 * A USD 1 000 receivable and a USD 500 payable born at 17.50; August closes at
 * 18.20: receivable +700, payable +350.
 */

let f: Fixture;
const DAY = '2026-08-20';
const RATE = (day: string, rate: string) =>
  fijarTipo({ par: exigirPar('USD/MXN'), fecha: day, tasa: rate, fuente: 'dof', creadoPor: f.userId });

const contextOf = (x: Fixture): AgentContext => ({
  entityId: x.entityId,
  entityName: 'MNE-001-112',
  tenantId: x.tenantId,
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'XAXX010101000',
});

async function periodOf(x: Fixture, month: number): Promise<ClosablePeriod> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number, fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1`,
    [x.periodos[month]]
  );
  return r.rows[0];
}

const revaluationEntries = async (): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1 AND source_type = 'fx_revaluation'`,
        [f.entityId]
      )
    ).rows[0].n
  );

apartarCatalogos('exchange_rates');

beforeAll(async () => {
  f = await crearInquilino('MNE-001-112 close and reconcile');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await RATE(DAY, '17.5000');
  await RATE('2026-08-31', '18.2000');

  const tag = uuidv4().slice(0, 8);
  const custId = uuidv4();
  const invId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente USD','XEXX010101000','rfc','USD',$4)`,
    [custId, f.entityId, `CR-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,1000,0,1000,1000,'USD',1,$5,$5,'draft',$6)`,
    [invId, f.entityId, `INV-112-${tag}`, custId, DAY, f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
       revenue_account_id, tax_amount, line_amount, total_amount)
     VALUES ($1,$2,1,'Servicio exportado',1,1000,$3,0,1000,1000)`,
    [uuidv4(), invId, f.cuentas['4100']]
  );
  await issueInvoice(invId, f.userId, { entityId: f.entityId });

  const vendorId = uuidv4();
  const billId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor USD','CCC030303CC3','rfc','USD',$4)`,
    [vendorId, f.entityId, `VR-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,500,0,500,500,0,'USD',17.5,$6,$6,'draft',$7)`,
    [billId, f.entityId, `BILL-112-${tag}`, vendorId, `V-${tag}`, DAY, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio en USD',1,500,500,0,500)`,
    [uuidv4(), billId, f.cuentas['6100']]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
});

afterAll(async () => {
  await drainAttestations();
  await closeDatabase();
});

describe('MNE-001-112 · ar/ap reconcile read a foreign-currency subledger at book value', () => {
  it('ar reconcile counts a USD invoice at the rate it was posted at, and balances', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.open_invoices).toBe('17500.00');
    expect(r.foreign_open).toEqual([{ currency: 'USD', foreign: '1000.00', book: '17500.00' }]);
    expect(r.fx_revaluation).toBe('0.00');
    expect(r.balanced).toBe(true);
  });

  it('ap reconcile counts a USD bill at its rate, and balances', async () => {
    const r = await apReconcile(f.entityId, { asOf: '2026-08-31' });
    expect(r.subdiario).toBe('8750.00');
    expect(r.foreignOpen).toEqual([{ currency: 'USD', foreign: '500.00', book: '8750.00' }]);
    expect(r.cuadra).toBe(true);
    expect(r.partidas).toEqual([]);
  });
});

describe('MNE-001-112 · closing run revalues, and a resumed run does not post it again', () => {
  it('the revalue-fx step posts the revaluation and records its entry from the marker', async () => {
    const august = await periodOf(f, 8);
    const out = await conductClose(contextOf(f), august, { userId: f.userId, stopAt: 'verify-checklist' });
    expect(out.status).toBe('stopped');
    const step = out.steps.find((s) => s.step === 'revalue-fx');
    expect(step).toMatchObject({ status: 'done', processed: 1, amount: null });
    expect(step?.detail).toMatch(/gain 700\.0000, loss 350\.0000; reversed on 2026-09-01/);
    expect(step?.journalEntryIds).toHaveLength(1);
    expect(await revaluationEntries()).toBe(1);
  });

  it('--resume runs the step again and posts nothing: the marker says it is done', async () => {
    const august = await periodOf(f, 8);
    const out = await conductClose(contextOf(f), august, { userId: f.userId, stopAt: 'verify-checklist', resume: true });
    const step = out.steps.find((s) => s.step === 'revalue-fx');
    expect(step).toMatchObject({ status: 'done', priorAttempt: true, processed: 1 });
    expect(step?.journalEntryIds).toHaveLength(1);
    expect(await revaluationEntries()).toBe(1);
  });

  it('an entity with nothing in a foreign currency skips the step, even in a December with no next year', async () => {
    const g = await crearInquilino('MNE-001-112 pesos only');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    const december = await periodOf(g, 12);
    const out = await conductClose(contextOf(g), december, { userId: g.userId, stopAt: 'verify-checklist' });
    expect(out.steps.find((s) => s.step === 'revalue-fx')).toMatchObject({
      status: 'skipped',
      detail: 'no foreign-currency balance to revalue',
      journalEntryIds: [],
    });
  });
});

describe('MNE-001-112 · the reconciliations name the revaluation line', () => {
  it('ap reconcile at the close holds the live revaluation in the subledger, not as a manual entry', async () => {
    const r = await apReconcile(f.entityId, { asOf: '2026-08-31' });
    expect(r.fxRevaluation).toBe('350.00');
    expect(r.subdiario).toBe('9100.00');
    expect(r.mayor).toBe('9100.00');
    expect(r.cuadra).toBe(true);
    expect(r.partidas).toEqual([]);
  });

  it('after the day-1 mirror the revaluation is gone from both sides', async () => {
    const r = await apReconcile(f.entityId, { asOf: '2026-09-01' });
    expect(r.fxRevaluation).toBe('0.00');
    expect(r.subdiario).toBe('8750.00');
    expect(r.cuadra).toBe(true);
    expect(r.partidas).toEqual([]);
  });

  it('ar reconcile lists neither the revaluation nor its mirror as manual entries', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.fx_revaluation).toBe('0.00');
    expect(r.manual_entries).toEqual([]);
    expect(r.balanced).toBe(true);
  });
});

describe('MNE-001-112 · a revaluation key changes only without a live revaluation', () => {
  const tenant = () => ({ tenantId: f.tenantId });
  beforeAll(async () => {
    await seedPolicies(tenant());
  });

  it('changing the closing rate source is refused while August is revalued and not sealed', async () => {
    await expect(
      resolvePolicy(tenant(), 'closing_exchange_rate_source', 'fix_banxico', f.userId)
    ).rejects.toMatchObject({ code: 'FX_REVALUATION_KEY_LOCKED' });
  });

  it('answering with the value already in force is not a change, and reopening it is', async () => {
    await resolvePolicy(tenant(), 'closing_exchange_rate_source', 'operations_source', f.userId);
    await expect(reopenPolicy(tenant(), 'closing_exchange_rate_source')).rejects.toMatchObject({
      code: 'FX_REVALUATION_KEY_LOCKED',
    });
  });

  it('once the revalued month is sealed the key changes', async () => {
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2`, [
      f.periodos[8],
      f.entityId,
    ]);
    await reopenPolicy(tenant(), 'closing_exchange_rate_source');
    await resolvePolicy(tenant(), 'closing_exchange_rate_source', 'fix_banxico', f.userId);
    const row = await query<{ resolved_value: string }>(
      `SELECT resolved_value FROM policy_decisions
        WHERE tenant_id = $1 AND key = 'closing_exchange_rate_source' AND entity_id IS NULL`,
      [f.tenantId]
    );
    expect(row.rows[0].resolved_value).toBe('fix_banxico');
  });
});
