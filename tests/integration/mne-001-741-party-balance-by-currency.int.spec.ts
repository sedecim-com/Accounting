import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { registerCustomerCommand } from '../../src/cli/customer-command.js';
import { registerVendorCommand } from '../../src/cli/vendor-command.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

/**
 * MNE-001-741 (#596, part 2 of MNE-001-647) · THE BALANCE PER CUSTOMER AND PER
 * VENDOR NEVER ADDS CURRENCIES.
 *
 * An entity in pesos, USD at 17.50 on the day of the documents (due that day,
 * so everything is past due today):
 *
 *   customer Alfa   MXN 2 400 + USD 1 000      book 2 400 + 17 500 = 19 900
 *   customer Beta   USD 300                    book 5 250
 *                                              receivables at book: 25 150
 *   vendor Gama     MXN 800 + USD 500          book 800 + 8 750 = 9 550
 *                   + a draft bill of MXN 100  (not a payable: never posted)
 *
 * Before this task the balance added the raw amounts: Alfa 2 400 + 1 000 =
 * 3 400, Beta 300 (dollars read as pesos), Gama 800 + 500 + 100 = 1 400.
 * The leaves run in-process against Postgres, as the binary would.
 */

let f: Fixture;
let email: string;
const DAY = '2026-08-20';
const ALFA = 'C-741-ALFA';
const BETA = 'C-741-BETA';
const GAMA = 'V-741-GAMA';
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

apartarCatalogos('exchange_rates');

async function customer(number: string, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,$4,'XEXX010101000','rfc','USD',$5)`,
    [id, f.entityId, number, name, f.userId]
  );
  return id;
}

async function invoice(customerId: string, currency: string, amount: number): Promise<void> {
  const id = uuidv4();
  const tag = id.slice(0, 8);
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,0,$5,$5,$6,1,$7,$7,'draft',$8)`,
    [id, f.entityId, `INV-741-${tag}`, customerId, amount, currency, DAY, f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
       revenue_account_id, tax_amount, line_amount, total_amount)
     VALUES ($1,$2,1,'Servicio',1,$3,$4,0,$3,$3)`,
    [uuidv4(), id, amount, f.cuentas['4100']]
  );
  await issueInvoice(id, f.userId, { entityId: f.entityId });
}

async function bill(vendorId: string, currency: string, amount: number, rate: number, approve = true): Promise<void> {
  const id = uuidv4();
  const tag = id.slice(0, 8);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,$6,0,$7,$8,$9,$9,'draft',$10)`,
    [id, f.entityId, `BILL-741-${tag}`, vendorId, `F-${tag}`, amount, currency, rate, DAY, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,0,$4)`,
    [uuidv4(), id, f.cuentas['6100'], amount]
  );
  if (approve) await approveBill(id, f.userId, { entityId: f.entityId });
}

interface Ran { out: string; err: string; errors: unknown[]; exitCode?: number }

/** Runs `<family> <argv>` in-process as the binary would; returns what it printed. */
async function cli(family: 'customer' | 'vendor', argv: string[]): Promise<Ran> {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const errors: unknown[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    const deps = {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errors.push(e); err.push(`${(e as Error).message}\n`); },
    };
    if (family === 'customer') registerCustomerCommand(program, deps);
    else registerVendorCommand(program, deps);
    try {
      await program.parseAsync(['node', 'mnemosine', family, ...argv, '--entity', f.entityId, '--tenant', f.tenantId]);
    } catch (e) {
      errors.push(e);
      exitCode = exitCodeFor(e);
    }
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { exitCode, out: out.join(''), err: err.join(''), errors };
}

interface CurrencyBalance {
  currency_code: string;
  open_documents: number;
  open_balance: string;
  overdue_balance: string;
  book_open_balance: string;
  book_overdue_balance: string;
}
interface ListRow {
  customer_number: string;
  open_by_currency: string;
  open_balance: string;
  overdue_balance: string;
  book_currency: string;
  open_documents: number;
  balances_by_currency: CurrencyBalance[];
}
interface Card extends ListRow {
  open_invoices: Array<{ currency_code: string; amount_due: string; book_amount_due: string }>;
}
interface VendorActivity {
  bill_count: string;
  open_count: string;
  billed: string;
  open_balance: string;
  paid: string;
  book_currency: string;
  by_currency: Array<{ currency_code: string; open_count: string; open_balance: string; book_open_balance: string }>;
}

const rowsOf = <T>(r: Ran): T[] => (JSON.parse(r.out) as { rows: T[] }).rows;
const numbersOf = (rows: ListRow[]): string[] => rows.map((r) => r.customer_number).sort();

beforeAll(async () => {
  f = await crearInquilino('MNE-001-741 party balance by currency');
  email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  await seedPolicies({ tenantId: f.tenantId });
  await fijarTipo({ par: exigirPar('USD/MXN'), fecha: DAY, tasa: '17.5000', fuente: 'dof', creadoPor: f.userId });
  const alfa = await customer(ALFA, 'Alfa con dos monedas');
  await invoice(alfa, 'MXN', 2400);
  await invoice(alfa, 'USD', 1000);
  const beta = await customer(BETA, 'Beta solo dolares');
  await invoice(beta, 'USD', 300);

  const gama = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Gama con dos monedas','CCC030303CC3','rfc','MXN',$4)`,
    [gama, f.entityId, GAMA, f.userId]
  );
  await bill(gama, 'MXN', 800, 1);
  await bill(gama, 'USD', 500, 17.5);
  await bill(gama, 'MXN', 100, 1, false);
});

afterAll(async () => {
  await drainAttestations();
  await closeDatabase();
});

describe('MNE-001-741 · customer list --with-balance never adds currencies', () => {
  it('json: each customer says what it owes per currency, and the single figure is the book value in MXN', async () => {
    const r = await cli('customer', ['list', '--json']);
    expect(r.errors).toEqual([]);
    const rows = rowsOf<ListRow>(r);
    const alfa = rows.find((x) => x.customer_number === ALFA)!;
    expect(alfa.balances_by_currency).toEqual([
      {
        currency_code: 'MXN', open_documents: 1, open_balance: '2400.0000', overdue_balance: '2400.0000',
        book_open_balance: '2400.0000', book_overdue_balance: '2400.0000',
      },
      {
        currency_code: 'USD', open_documents: 1, open_balance: '1000.0000', overdue_balance: '1000.0000',
        book_open_balance: '17500.0000', book_overdue_balance: '17500.0000',
      },
    ]);
    expect([alfa.open_balance, alfa.overdue_balance, alfa.book_currency, alfa.open_documents])
      .toEqual(['19900.0000', '19900.0000', 'MXN', 2]);
    expect(alfa.open_by_currency).toBe('MXN 2400.0000; USD 1000.0000');

    const beta = rows.find((x) => x.customer_number === BETA)!;
    expect([beta.open_by_currency, beta.open_balance, beta.book_currency]).toEqual(['USD 300.0000', '5250.0000', 'MXN']);
    // The defect: 2 400 + 1 000 printed as one figure.
    expect(r.out).not.toContain('3400');
  });

  it('csv: the per-currency column and the book currency are there', async () => {
    const r = await cli('customer', ['list', '--format', 'csv']);
    const [header, ...lines] = r.out.trim().split('\n');
    expect(header.split(',')).toEqual(expect.arrayContaining(['open_by_currency', 'open_balance', 'book_currency']));
    const alfa = lines.find((l) => l.startsWith(ALFA))!;
    expect(alfa).toContain('MXN 2400.0000; USD 1000.0000');
    expect(alfa).toContain('19900.0000');
  });

  it('--balance-gt compares the book value in the functional currency: USD 300 is 5 250 pesos', async () => {
    // Read as pesos, USD 300 is not over 1 000; at book value it is 5 250.
    expect(numbersOf(rowsOf<ListRow>(await cli('customer', ['list', '--balance-gt', '1000', '--json']))))
      .toEqual([ALFA, BETA]);
    // Alfa owes 19 900 at book value, not 3 400; Beta's 5 250 is under 6 000.
    expect(numbersOf(rowsOf<ListRow>(await cli('customer', ['list', '--balance-gt', '6000', '--json']))))
      .toEqual([ALFA]);
    expect(numbersOf(rowsOf<ListRow>(await cli('customer', ['list', '--balance-gt', '19900', '--json']))))
      .toEqual([]);
  });

  it('--overdue lists both, and the help says which figure --balance-gt compares', async () => {
    expect(numbersOf(rowsOf<ListRow>(await cli('customer', ['list', '--overdue', '--json'])))).toEqual([ALFA, BETA]);
    const help = await cli('customer', ['list', '--help']);
    expect(help.out).toMatch(/--balance-gt <amount>\s+only customers whose balance at book value, in the\s+functional currency/);
  });
});

describe('MNE-001-741 · customer show and the archive guard', () => {
  it('show --json: per currency, the book value, and each open document says its currency', async () => {
    const r = await cli('customer', ['show', ALFA, '--json']);
    expect(r.errors).toEqual([]);
    const card = rowsOf<Card>(r)[0];
    expect(card.balances_by_currency.map((b) => [b.currency_code, b.open_balance, b.book_open_balance])).toEqual([
      ['MXN', '2400.0000', '2400.0000'],
      ['USD', '1000.0000', '17500.0000'],
    ]);
    expect([card.open_balance, card.book_currency]).toEqual(['19900.0000', 'MXN']);
    expect(card.open_invoices.map((i) => [i.currency_code, i.amount_due, i.book_amount_due]).sort()).toEqual([
      ['MXN', '2400.0000', '2400.0000'],
      ['USD', '1000.0000', '17500.0000'],
    ]);
  });

  it('show (the card): the amount due per currency and the book value in MXN', async () => {
    const r = await cli('customer', ['show', ALFA]);
    expect(r.out).toMatch(/Amount due\s+MXN 2400\.0000; USD 1000\.0000/);
    expect(r.out).toMatch(/Book value\s+19900\.0000 MXN/);
    expect(r.out).not.toContain('3400');
  });

  it('archive refuses a customer who owes only dollars, and says it in dollars and at book value', async () => {
    const r = await cli('customer', ['archive', BETA, '--reason', 'synthetic test', '--user', email]);
    expect(r.errors).toHaveLength(1);
    expect(r.err).toContain('1 open document(s) totalling USD 300.0000 (book value 5250.0000 MXN)');
    const still = await query<{ is_active: boolean }>(
      `SELECT is_active FROM customers WHERE entity_id = $1 AND customer_number = $2`,
      [f.entityId, BETA]
    );
    expect(still.rows[0].is_active).toBe(true);
  });

  it('the sum of the book values per customer is what ar reconcile weighs against the control, and it ties', async () => {
    const rows = rowsOf<ListRow>(await cli('customer', ['list', '--json']));
    const sum = rows.reduce((s, x) => s + Number(x.open_balance || 0), 0);
    expect(sum.toFixed(2)).toBe('25150.00');
    const reconcile = await arReconcile(f.entityId);
    expect(reconcile.open_invoices).toBe('25150.00');
    expect(reconcile.balanced).toBe(true);
  });
});

describe('MNE-001-741 · vendor show --include activity never adds currencies', () => {
  it('json: per currency, and the open balance is the book value of the posted bills', async () => {
    const r = await cli('vendor', ['show', GAMA, '--include', 'activity', '--json']);
    expect(r.errors).toEqual([]);
    const activity = (JSON.parse(r.out) as { rows: Array<{ activity: VendorActivity }> }).rows[0].activity;
    expect(activity.by_currency.map((c) => [c.currency_code, c.open_count, c.open_balance, c.book_open_balance])).toEqual([
      ['MXN', '1', '800.0000', '800.0000'],
      ['USD', '1', '500.0000', '8750.0000'],
    ]);
    // The draft is billed (it exists) but is not owed: it never reached the ledger.
    expect([activity.bill_count, activity.open_count, activity.open_balance, activity.billed, activity.book_currency])
      .toEqual(['3', '2', '9550.0000', '9650.0000', 'MXN']);
    // The defect: 800 + 500 + 100 and 800 + 500 + 100 again.
    expect(r.out).not.toContain('1400');
  });

  it('the book value of the vendor is what ap reconcile weighs against the control, and it ties', async () => {
    const r = await cli('vendor', ['show', GAMA, '--include', 'activity', '--json']);
    const activity = (JSON.parse(r.out) as { rows: Array<{ activity: VendorActivity }> }).rows[0].activity;
    const reconcile = await apReconcile(f.entityId, {});
    expect(Number(activity.open_balance).toFixed(2)).toBe(reconcile.subdiario);
    expect(reconcile.subdiario).toBe('9550.00');
    expect(reconcile.cuadra).toBe(true);
  });
});
