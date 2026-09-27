import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  softClosePeriod,
  hardClosePeriod,
} from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { getCloseReadiness, listClosablePeriods } from '../../src/ai/close-service.js';
import { renderReadiness } from '../../src/cli/close-command.js';
import { JournalEntryType } from '../../src/types/index.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * MNE-001-035 (#98): a subledger that disagrees with its control account
 * blocks the close.
 *
 * `runArChecks` was born as "the battery `close --check` will consume" and
 * its `subledger-delta` probe is blocking, yet the close checklist never
 * asked: a month could be hard-closed with 1 240 000 on the control account
 * and 1 190 000 in the subledger. The owner's acceptance, for AR and for AP:
 * `close --check` shows ✘ and the hard close refuses.
 *
 * The scenario seals the period while the two sides still agree (the soft
 * close already runs the checklist, so it would refuse too), then a hand
 * entry on the control in the NEXT, still open, month opens a 50 000 gap.
 * That is the case only the hard close can catch: its period is already
 * soft-closed, so nothing on its own dates changed.
 *
 * Each ledger gets its own tenant: the reconciliation reads the whole entity.
 */

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s, red: (s: string) => s };

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function accountId(fx: Fixture, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [fx.entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`missing account ${code}`);
  return r.rows[0].id;
}

/** A posted hand entry: `debit` gets the charge, `credit` the credit. */
async function handEntry(fx: Fixture, month: number, amount: string, debit: string, credit: string) {
  await createJournalEntry(
    fx.entityId, fechaEnPeriodo(month, 10), JournalEntryType.STANDARD, 'hand entry on the control',
    [
      { account_id: debit, debit_amount: amount, credit_amount: null, description: 'manual' },
      { account_id: credit, debit_amount: null, credit_amount: amount, description: 'manual' },
    ],
    fx.userId, { autoPost: true }
  );
}

/** One open invoice worth 1 190 000 in the receivable subledger. */
async function openInvoice(fx: Fixture): Promise<void> {
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic customer', 'MXN', $4)`,
    [customerId, fx.entityId, `C-${customerId.slice(0, 8)}`, fx.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, total_amount,
                           amount_due, currency_code, invoice_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, 1190000, 1190000, 1190000, 'MXN', $5, $5, 'pending', $6)`,
    [uuidv4(), fx.entityId, `INV-${customerId.slice(0, 8)}`, customerId, fechaEnPeriodo(1, 10), fx.userId]
  );
}

/** One approved bill worth 1 190 000 in the payable subledger. */
async function openBill(fx: Fixture): Promise<void> {
  const vendorId = uuidv4();
  const tag = vendorId.slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic vendor', 'CCC030303CC3', 'rfc', 'MXN', $4)`,
    [vendorId, fx.entityId, `V-${tag}`, fx.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number,
                        subtotal, tax_amount, total_amount, amount_due, amount_paid,
                        currency_code, bill_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 1190000, 0, 1190000, 1190000, 0, 'MXN', $6, $6, 'approved', $7)`,
    [uuidv4(), fx.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, fechaEnPeriodo(1, 10), fx.userId]
  );
}

async function closeCheck(fx: Fixture, periodId: string) {
  const ctx: AgentContext = {
    tenantId: fx.tenantId, entityId: fx.entityId, entityName: 'MNE-001-035',
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  const period = (await listClosablePeriods(ctx)).find((p) => p.id === periodId);
  if (!period) throw new Error('period is not closable');
  const readiness = await getCloseReadiness(ctx, period);
  return { readiness, screen: renderReadiness(readiness, plain).join('\n') };
}

const cases = [
  {
    ledger: 'AR (CxC)',
    code: 'ar-subledger-delta',
    subledger: openInvoice,
    // Receivable: the control carries a DEBIT balance.
    onControl: async (fx: Fixture, month: number, amount: string) =>
      handEntry(fx, month, amount, fx.roles.cxc, await accountId(fx, '4100')),
  },
  {
    ledger: 'AP (CxP)',
    code: 'ap-subledger-delta',
    subledger: openBill,
    // Payable: the control carries a CREDIT balance.
    onControl: async (fx: Fixture, month: number, amount: string) =>
      handEntry(fx, month, amount, await accountId(fx, '6100'), fx.roles.cxp),
  },
] as const;

describe.each(cases)('the $ledger subledger delta blocks the close', ({ ledger, code, subledger, onControl }) => {
  it(`control 1 240 000 against a subledger of 1 190 000: close --check shows ✘ and the hard close refuses`, async () => {
    const fx = await crearInquilino(`MNE-001-035 ${ledger}`);
    await subledger(fx);
    await onControl(fx, 1, '1190000.00');

    // While the two sides agree the check is green and the month soft-closes.
    const before = await closeCheck(fx, fx.periodos[1]);
    const green = before.readiness.checklist.find((c) => c.codigo === code);
    expect(green, `the checklist must carry ${code}`).toBeDefined();
    expect(green!.is_complete).toBe(true);
    expect(green!.severity).toBe('blocking');
    expect((await softClosePeriod(fx.periodos[1], fx.entityId, fx.userId)).status).toBe('soft_close');

    // A hand entry on the control in the next, open, month: 1 240 000 vs 1 190 000.
    await onControl(fx, 2, '50000.00');

    const after = await closeCheck(fx, fx.periodos[1]);
    const red = after.readiness.checklist.find((c) => c.codigo === code)!;
    expect(red.is_complete).toBe(false);
    expect(red.severity).toBe('blocking');
    expect(red.details).toMatch(/1240000\.00/);
    expect(red.details).toMatch(/1190000\.00/);
    expect(after.readiness.canClose).toBe(false);
    expect(after.screen).toContain(`✘ ${red.item}`);
    expect(after.screen).toContain('Cannot close yet');

    // `closing explain <code>` lists the same finding, with the delta.
    const explained = await explainCloseCheck(fx.entityId, fx.periodos[1], code);
    expect(explained.total).toBe(1);
    expect(explained.renglones[0]).toMatchObject({
      control_balance: '1240000.00',
      subledger_balance: '1190000.00',
      delta: '50000.00',
    });

    await expect(hardClosePeriod(fx.periodos[1], fx.entityId, fx.userId, 'seal the month')).rejects.toMatchObject({
      code: 'CANNOT_CLOSE_PERIOD',
    });
    const still = await query<{ status: string }>(
      `SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
      [fx.periodos[1], fx.entityId]
    );
    expect(still.rows[0].status, 'the refused hard close must leave the period soft-closed').toBe('soft_close');

    // And the soft close of the next month refuses on the same finding.
    await expect(softClosePeriod(fx.periodos[2], fx.entityId, fx.userId)).rejects.toMatchObject({
      code: 'CANNOT_CLOSE_PERIOD',
    });
  }, 180_000);
});
