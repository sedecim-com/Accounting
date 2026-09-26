import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { createInvoice, issueInvoice, voidInvoice } from '../../src/services/ar/invoice-service.js';
import { arReconcile, runArChecks } from '../../src/services/ar/ar-controls.js';

/**
 * MNE-001-036 (#98): two AR probes that lied, against a real database.
 *
 * 1. The manual-entries list on the receivable control counted the engine's own
 *    reversals: they are born with a NULL `source_type`, so every clean
 *    `invoice void` was reported as "a manual entry on the control".
 * 2. `duplicate-invoice` reported the length of its LIMIT 5 sample as the
 *    count, so forty double captures read as five on `ar check --json`.
 *
 * Each scenario has its own tenant: the probes read the whole entity, and a
 * shared fixture would let one scenario's rows leak into the other's count.
 */

let f: Fixture;

const today = (): string => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function accountId(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`,
    [entityId, code]
  );
  if (r.rows.length === 0) throw new Error(`missing account ${code}`);
  return r.rows[0].id;
}

async function customer(fx: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic customer', 'MXN', $4)`,
    [id, fx.entityId, `C-${id.slice(0, 8)}`, fx.userId]
  );
  return id;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-036 engine reversal');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the manual-entries probe on the receivable control', () => {
  it('does not list the engine reversal of a voided invoice, and still lists a real manual entry', async () => {
    const customerId = await customer(f);
    const draft = await createInvoice({
      entity_id: f.entityId,
      customer_id: customerId,
      invoice_date: today(),
      due_date: today(),
      currency_code: 'MXN',
      lines: [
        {
          revenue_account_id: await accountId(f.entityId, '4100'),
          description: 'Service',
          quantity: '1',
          unit_price: '1000.00',
          tax_rate: '16',
        },
      ],
      created_by: f.userId,
    });
    await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
    await voidInvoice(draft.id, f.userId, { entityId: f.entityId, reason: 'captured twice' });

    const reversal = await query<{ entry_number: string; source_type: string | null }>(
      `SELECT je.entry_number, je.source_type
         FROM journal_entries je
         JOIN journal_entries orig ON orig.id = je.reverses_entry_id
        WHERE orig.source_type = 'invoice' AND orig.source_id = $1 AND je.entity_id = $2`,
      [draft.id, f.entityId]
    );
    expect(reversal.rows, 'the void must leave a linked reversal to test against').toHaveLength(1);
    expect(reversal.rows[0].source_type, 'the premise: the reversal carries no source_type').toBeNull();

    const clean = await arReconcile(f.entityId);
    expect(
      clean.manual_entries.map((m) => m.entry_number),
      'without the NOT EXISTS on reverses_entry_id, every clean void is denounced as manual'
    ).toEqual([]);
    expect(clean.balanced).toBe(true);

    // The other direction: a hand-posted entry on the control still lists.
    const receivable = await accountId(f.entityId, '1120');
    const revenue = await accountId(f.entityId, '4100');
    await withTransaction(async (client) => {
      await createJournalEntry(
        f.entityId,
        fechaEnPeriodo(),
        JournalEntryType.STANDARD,
        'hand adjustment on the control',
        [
          { account_id: receivable, debit_amount: '250.00', credit_amount: null, description: 'manual' },
          { account_id: revenue, debit_amount: null, credit_amount: '250.00', description: 'manual' },
        ],
        f.userId,
        { autoPost: true, client }
      );
    });
    const dirty = await arReconcile(f.entityId);
    expect(dirty.manual_entries).toHaveLength(1);
    expect(dirty.manual_entries[0].amount).toBe('250.00');
    expect(dirty.balanced).toBe(false);
  }, 120_000);
});

describe('duplicate-invoice', () => {
  it('counts 40 duplicate groups as 40, not as the five rows of its sample', async () => {
    const fx = await crearInquilino('MNE-001-036 duplicates');
    const customerId = await customer(fx);
    const date = today();
    // Drafts inserted directly: the probe reads only `invoices`, and a draft
    // without a ledger entry is a state the application itself produces.
    for (let g = 0; g < 40; g++) {
      const total = (100 + g).toFixed(2);
      for (let copy = 0; copy < 2; copy++) {
        await query(
          `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, total_amount,
                                 amount_due, currency_code, invoice_date, due_date, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $5, $5, 'MXN', $6, $6, 'draft', $7)`,
          [uuidv4(), fx.entityId, `DUP-${g}-${copy}`, customerId, total, date, fx.userId]
        );
      }
    }

    const { results } = await runArChecks(fx.entityId, { checks: ['duplicate-invoice'] });
    expect(results[0].level).toBe('warning');
    expect(results[0].count, 'count is the window total, not the LIMIT 5 sample').toBe(40);
    expect(results[0].sample).toHaveLength(5);
  }, 120_000);
});
