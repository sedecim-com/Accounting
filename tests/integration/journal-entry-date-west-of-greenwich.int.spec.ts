import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import billsRouter from '../../src/api/rest/routes/bills.js';
import invoicesRouter from '../../src/api/rest/routes/invoices.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';

// ============================================================
// #211 · UN ASIENTO FECHADO EL 1 DE MARZO SE GUARDA EL 28 DE FEBRERO
//
// `entry_date` es DATE. La ruta REST hacía `new Date(entry_date)` sobre la
// cadena `YYYY-MM-DD` del cuerpo, que es medianoche UTC; node-postgres
// serializa un `Date` con los componentes LOCALES del proceso, así que al
// oeste de Greenwich la columna recibía el día anterior. En CI el reloj es UTC
// y el defecto no aparece: aparece en el mercado al que va el sistema.
//
// Por eso esta prueba FIJA LA ZONA dentro de cada caso y la restaura en
// `finally`: la suite de integración corre en un solo proceso y un `TZ` suelto
// se pegaría a todos los archivos que vengan detrás. Y comprueba antes que el
// cambio de zona surtió efecto, o pasaría en falso en una máquina sin datos de
// zonas horarias.
//
// Dos zonas y no una: México, donde se mide el defecto, y Tokio, donde se mide
// que el arreglo no rompa el otro lado del meridiano.
// ============================================================

let fx: Fixture;
let server: Servidor;

beforeAll(async () => {
  fx = await crearInquilino('#211 fecha del asiento');
  server = await levantar(
    [
      ['/v1/journal-entries', journalEntriesRouter],
      ['/v1/bills', billsRouter],
      ['/v1/invoices', invoicesRouter],
    ],
    sesionDe(fx)
  );
}, 120_000);

afterAll(async () => {
  await drainAttestations(3000).catch(() => undefined);
  await server?.cerrar();
  await closeDatabase();
});

async function inTimezone<T>(tz: string, expectedOffsetMinutes: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const offset = new Date('2026-03-01T12:00:00Z').getTimezoneOffset();
    expect(offset, `the process did not switch to ${tz}: the test would pass vacuously`).toBe(expectedOffsetMinutes);
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const MEXICO = ['America/Mexico_City', 360] as const;
const TOKYO = ['Asia/Tokyo', -540] as const;

interface StoredEntry {
  id: string;
  entry_date: string;
  fiscal_period_id: string;
  entry_number: string;
}

async function postEntry(entryDate: string): Promise<{ status: number; stored: StoredEntry | undefined; body: unknown }> {
  const reference = `D211-${randomUUID().slice(0, 8)}`;
  const r = await pedir(server, 'POST', '/v1/journal-entries', {
    entity_id: fx.entityId,
    entry_date: entryDate,
    description: `#211 ${entryDate}`,
    reference,
    auto_post: true,
    lines: [
      { account_id: fx.cuentas['1120'], debit_amount: '100.00' },
      { account_id: fx.cuentas['4100'], credit_amount: '100.00' },
    ],
  });
  const { rows } = await query<StoredEntry>(
    `SELECT id, entry_date::text AS entry_date, fiscal_period_id, entry_number
       FROM journal_entries WHERE reference = $1`,
    [reference]
  );
  return { status: r.status, stored: rows[0], body: r.body };
}

describe('the date a user writes is the date the ledger keeps — west of Greenwich', () => {
  it('an entry dated March 1st is stored on March 1st, in the March period', async () => {
    await inTimezone(...MEXICO, async () => {
      const { status, stored, body } = await postEntry('2026-03-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date, 'the entry landed on another day').toBe('2026-03-01');
      expect(stored?.fiscal_period_id, 'the entry landed in another fiscal period').toBe(fx.periodos[3]);
    });
  });

  it('an entry dated January 1st is accepted, and takes the folio series of ITS year', async () => {
    // Shifted back one day it would be December 31st of the previous year:
    // a period that does not exist here, and the previous year's folio series.
    await inTimezone(...MEXICO, async () => {
      const { status, stored, body } = await postEntry('2026-01-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date).toBe('2026-01-01');
      expect(stored?.entry_number, 'the folio came from the previous year series').toMatch(/-2026-/);
    });
  });

  it('a reversal dated April 1st is stored on April 1st', async () => {
    await inTimezone(...MEXICO, async () => {
      const { stored } = await postEntry('2026-03-15');
      const r = await pedir(server, 'POST', `/v1/journal-entries/${stored!.id}/reverse`, { reversal_date: '2026-04-01' });
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
      const { rows } = await query<{ entry_date: string }>(
        `SELECT entry_date::text AS entry_date FROM journal_entries WHERE reverses_entry_id = $1`,
        [stored!.id]
      );
      expect(rows[0]?.entry_date, 'the reversal landed on another day').toBe('2026-04-01');
    });
  });
});

/** An approved vendor bill (its own entry comes from the DB row, which is fine). */
async function approvedBill(billDate: string): Promise<string> {
  const billId = randomUUID();
  const vendorId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Vendor 211','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, fx.entityId, `V-${tag}`, fx.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid, currency_code, bill_date, due_date,
       status, created_by, terms)
     VALUES ($1,$2,$3,$4,$5,'1000.00','160.00','1160.00','1160.00',0,'MXN',$6,$6,'draft',$7,'PUE')`,
    [billId, fx.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, billDate, fx.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Service',1,'1000.00','1000.00','160.00','1160.00')`,
    [randomUUID(), billId, fx.cuentas['6100']]
  );
  await approveBill(billId, fx.userId, { entityId: fx.entityId });
  return billId;
}

/** The payment row and ITS OWN entry, joined by the payment's journal_entry_id. */
async function paymentAndItsEntry(
  table: 'vendor_payments' | 'customer_payments',
  paymentNumber: string
): Promise<{ payment_date: string; entry_date: string; entry_number: string } | undefined> {
  const { rows } = await query<{ payment_date: string; entry_date: string; entry_number: string }>(
    `SELECT p.payment_date::text AS payment_date, je.entry_date::text AS entry_date, je.entry_number
       FROM ${table} p JOIN journal_entries je ON je.id = p.journal_entry_id
      WHERE p.payment_number = $1 AND p.entity_id = $2`,
    [paymentNumber, fx.entityId]
  );
  return rows[0];
}

describe('the payment and its entry keep the same day — west of Greenwich', () => {
  it('a vendor payment dated April 1st posts its entry on April 1st', async () => {
    const billId = await approvedBill('2026-04-01');
    await inTimezone(...MEXICO, async () => {
      const r = await pedir(server, 'POST', '/v1/bills/payments', {
        entity_id: fx.entityId,
        vendor_id: (await query<{ vendor_id: string }>('SELECT vendor_id FROM bills WHERE id = $1', [billId])).rows[0].vendor_id,
        payment_amount: '1160.00',
        payment_method: 'spei',
        payment_date: '2026-04-01',
        applications: [{ bill_id: billId, amount_applied: '1160.00' }],
      });
      expect(r.status, JSON.stringify(r.body).slice(0, 240)).toBe(201);
      const paymentNumber = (r.body as { data: { payment_number: string } }).data.payment_number;
      const pair = await paymentAndItsEntry('vendor_payments', paymentNumber);
      expect(pair?.payment_date).toBe('2026-04-01');
      expect(pair?.entry_date, 'the payment and its own entry disagree on the day').toBe('2026-04-01');
    });
  });

  it('a customer receipt dated January 1st is accepted, and its entry takes the 2026 folio', async () => {
    const customerId = randomUUID();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
       VALUES ($1,$2,$3,'Customer 211','MXN',$4)`,
      [customerId, fx.entityId, `C-${customerId.slice(0, 8)}`, fx.userId]
    );
    const draft = await createInvoice({
      entity_id: fx.entityId,
      customer_id: customerId,
      invoice_date: '2026-01-01',
      due_date: '2026-01-01',
      currency_code: 'MXN',
      lines: [{ revenue_account_id: fx.cuentas['4100'], description: 'Service', quantity: '1', unit_price: '1000.00', tax_rate: '16.0000' }],
      created_by: fx.userId,
    });
    const issued = await issueInvoice(draft.id, fx.userId, { entityId: fx.entityId });
    await inTimezone(...MEXICO, async () => {
      const r = await pedir(server, 'POST', `/v1/invoices/${issued.invoice.id}/payments`, {
        payment_date: '2026-01-01',
        payment_amount: issued.invoice.total_amount,
        payment_method: 'spei',
      });
      expect(r.status, JSON.stringify(r.body).slice(0, 240)).toBe(201);
      const paymentNumber = (r.body as { data: { payment_number: string } }).data.payment_number;
      const pair = await paymentAndItsEntry('customer_payments', paymentNumber);
      expect(pair?.entry_date, 'the receipt and its own entry disagree on the day').toBe('2026-01-01');
      expect(pair?.entry_number, 'the receipt entry took the previous year folio').toMatch(/-2026-/);
    });
  });
});

describe('and the fix does not break the other side of the meridian', () => {
  it('east of Greenwich, March 1st is still March 1st, in the March period', async () => {
    await inTimezone(...TOKYO, async () => {
      const { status, stored, body } = await postEntry('2026-03-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date).toBe('2026-03-01');
      expect(stored?.fiscal_period_id).toBe(fx.periodos[3]);
    });
  });
});
