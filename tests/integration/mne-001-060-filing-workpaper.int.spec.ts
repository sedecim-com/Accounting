import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, getClient, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordCustomerPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordIncomeTaxInput } from '../../src/services/fiscal/provisional-income-tax-inputs.js';
import {
  entriesByIds,
  entriesMoving,
  generateFilingWorkpaper,
  type FilingWorkpaper,
} from '../../src/services/fiscal/filing-workpaper.js';
import { registerFilingWorkpaperCommand, workpaperRows } from '../../src/cli/filing-workpaper-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';

// ============================================================
// MNE-001-060 · THE MONTH'S WORKPAPER, TRACEABLE, BY HAND
//
// May 2026, one PUE sale posted by the real invoice service:
//   1 000 at 16 % (160) + 500 at 0 %  → income 1 500, IVA charged 160
//   IVA: 160 charged, nothing creditable        → 160 payable
//   ISR: coefficient 0.0875 (2025 return)
//     profit 1 500 × 0.0875 = 131.25 → 131 in pesos; base 131;
//     tax 30 %: 131.25 × 0.30 = 39.375 → 39.38 cents; 131 × 0.30 = 39.3 → 39
// Both columns on every line, and each line points to the entries behind it.
//
// June is the acceptance's hard case: several documents of different rates in
// one month, so a line that listed the whole role account would be wrong.
// ============================================================

let f: Fixture;
let wp: FilingWorkpaper;
let invoiceEntryId: string;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-060 papel de trabajo');
  await seedPolicies({ tenantId: f.tenantId });
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-060', 'Cliente Sintético SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: '2026-05-05', due_date: '2026-05-05',
    currency_code: 'MXN', terms: 'PUE',
    lines: [['1000', '16'], ['500', '0']].map(([price, rate]) => ({
      revenue_account_id: f.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: price, tax_rate: rate,
    })),
    created_by: f.userId,
  });
  const issued = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const { rows } = await query<{ journal_entry_id: string }>('SELECT journal_entry_id FROM invoices WHERE id = $1', [issued.invoice.id]);
  invoiceEntryId = rows[0].journal_entry_id;
  await recordIncomeTaxInput(entityScope(f.tenantId, f.entityId), {
    kind: 'profit_coefficient', value: '0.0875', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-20',
    sourceDocument: 'Declaración anual 2025, operación 000123',
  });
  wp = await generateFilingWorkpaper({
    tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 5, forms: ['iva', 'isr'],
  });
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const section = (form: 'iva' | 'isr') => wp.sections.find((s) => s.form === form)!;
const line = (form: 'iva' | 'isr', key: string) => section(form).lines.find((l) => l.key === key)!;

describe('every line carries two columns, cents of the ledger and pesos to capture', () => {
  it('IVA: 160 charged, 160 payable', () => {
    expect(section('iva').blockedBy).toEqual([]);
    expect(line('iva', 'charged.tasa16.iva')).toMatchObject({ cents: '160.00', whole: '160' });
    expect(section('iva')).toMatchObject({ resultCents: '160.00', resultWhole: '160' });
  });

  it('ISR: cents and pesos differ where CFF art. 20 says they do', () => {
    expect(line('isr', 'estimated_profit')).toMatchObject({ cents: '131.25', whole: '131' });
    expect(line('isr', 'tax_caused')).toMatchObject({ cents: '39.38', whole: '39' });
    expect(section('isr')).toMatchObject({ resultCents: '39.38', resultWhole: '39' });
  });
});

describe('every line points to its pólizas', () => {
  it('the charged IVA lines point to the invoice entry that moved iva_trasladado', () => {
    const src = line('iva', 'charged.tasa16.iva').source;
    expect(src.kind).toBe('documents');
    expect(src.accounts).toEqual(['iva_trasladado']);
    expect(src.entries.map((e) => e.entryId)).toEqual([invoiceEntryId]);
    expect(src.entries[0].net).toBe('-160.0000');
  });

  it('the nominal income points to the entry that credited the revenue account', () => {
    const src = line('isr', 'nominal_income').source;
    expect(src.accounts).toEqual(['4100']);
    expect(src.entries.find((e) => e.entryId === invoiceEntryId)?.net).toBe('-1500.0000');
  });

  it('a captured or derived line says so and lists no entry', () => {
    expect(line('iva', 'prior_balance_in_favor').source).toEqual({
      kind: 'captured', accounts: [], entries: [], ref: 'prior_balance_in_favor',
    });
    expect(line('isr', 'tax_caused').source.kind).toBe('derived');
  });

  it('no line is left without a source kind, and the flat rows carry both columns', () => {
    const rows = workpaperRows(wp);
    expect(rows.every((r) => r.cents !== undefined && r.whole !== undefined)).toBe(true);
    expect(wp.sections.flatMap((s) => s.lines).every((l) => l.source.kind)).toBe(true);
    const number = line('iva', 'charged.tasa16.iva').source.entries.find((e) => e.entryId === invoiceEntryId)?.entryNumber;
    expect(number).toBeTruthy();
    expect(rows.find((r) => r.line === 'iva.charged.tasa16.iva')?.entries).toContain(number);
  });

  it('the table caps the entries of a cell and says how many more; the paper keeps them all', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      entryId: `e${i}`, entryNumber: `JE-${i}`, entryDate: '2026-05-01', sourceType: null, description: null, net: '-1.0000',
    }));
    const paper: FilingWorkpaper = {
      ...wp,
      sections: [{
        ...section('iva'), resultCents: '1.00', resultWhole: '1',
        lines: [{ key: 'charged.tasa16.iva', cents: '1.00', whole: '1', source: { kind: 'accounts', accounts: ['x'], entries: many } }],
      }],
    };
    const capped = String(workpaperRows(paper, 8)[0].entries);
    expect(capped.startsWith('JE-0 JE-1 JE-2 JE-3 JE-4 JE-5 JE-6 JE-7 ')).toBe(true);
    expect(capped).toMatch(/\+3 (more|más)$/);
    expect(String(workpaperRows(paper)[0].entries).split(' ')).toHaveLength(11);
  });
});

describe('what cannot be vouched for is not settled, and nothing is filed', () => {
  it('January has no coefficient: the ISR section carries no result', async () => {
    const jan = await generateFilingWorkpaper({
      tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 1, forms: ['isr'],
    });
    expect(jan.sections[0]).toMatchObject({ resultCents: null, resultWhole: null, lines: [], blockedBy: ['ISR-WP-NO-COEFFICIENT'] });
    expect(jan.filed).toBe(false);
  });
});

// ============================================================
// THE ACCEPTANCE'S HARD CASE: documents of different rates in one month
//
// A line must list ITS OWN documents. June holds, in one entity:
//   PUE 1 000 at 16 % (160)   PUE 500 at 0 %   PUE 200 at 8 % (16)
//   PPD 400 at 16 % (64), collected in full on the 20th
//   PUE bill 800 at 16 % (128); PPD bill 1 500 at 16 % (240), 870 paid (120)
// plus ISR movements: a withholding of 30, an entry that applies 10 of it
// against a tax, and a sale in a second revenue account reversed in full.
// A sibling entity of the same tenant has its own 16 % invoice in June.
// ============================================================

const JUNE = { year: 2026, month: 6 };
const juneDay = (d: number): string => `2026-06-${String(d).padStart(2, '0')}`;

let sibling: Fixture;
let june: FilingWorkpaper;
const ids: Record<string, string> = {};
let tmpRoot: string;

async function saleIn(
  fx: Fixture, customer: string, terms: 'PUE' | 'PPD', lines: Array<[string, string]>, date: string
): Promise<string> {
  const draft = await createInvoice({
    entity_id: fx.entityId, customer_id: customer, invoice_date: date, due_date: date, currency_code: 'MXN', terms,
    lines: lines.map(([price, rate]) => ({
      revenue_account_id: fx.cuentas['4100'], description: 'Servicio', quantity: '1', unit_price: price, tax_rate: rate,
    })),
    created_by: fx.userId,
  });
  return (await issueInvoice(draft.id, fx.userId, { entityId: fx.entityId })).invoice.id;
}

async function customerOf(fx: Fixture, number: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente Sintético SA', 'MXN', $4)`,
    [id, fx.entityId, number, fx.userId]
  );
  return id;
}

const entryOf = async (table: 'invoices' | 'bills', id: string): Promise<string> =>
  (await query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM ${table} WHERE id = $1`, [id])).rows[0].journal_entry_id;

async function billIn(vendor: string, terms: 'PUE' | 'PPD', amount: string, iva: string, date: string): Promise<{ id: string; total: string }> {
  const id = uuidv4();
  const total = (Number(amount) + Number(iva)).toFixed(4);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms)
     VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$7,0,'MXN',$8,$8,'draft',$9,$10)`,
    [id, f.entityId, `BILL-${id.slice(0, 8)}`, vendor, amount, iva, total, date, f.userId, terms]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
       line_amount, tax_amount, total_amount, tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Insumo',1,$4,$4,$5,$6,'16.00','tasa')`,
    [uuidv4(), id, f.cuentas['6100'], amount, iva, total]
  );
  await approveBill(id, f.userId, { entityId: f.entityId });
  return { id, total };
}

const manual = (date: string, memo: string, lines: Array<[string, string | null, string | null]>) =>
  createJournalEntry(
    f.entityId, new Date(`${date}T00:00:00Z`), JournalEntryType.STANDARD, memo,
    lines.map(([account_id, debit_amount, credit_amount]) => ({ account_id, debit_amount, credit_amount, description: memo })),
    f.userId, { autoPost: true }
  );

const paymentEntry = async (table: 'customer_payments' | 'vendor_payments', date: string): Promise<string> =>
  (await query<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM ${table} WHERE entity_id = $1 AND payment_date = $2::date`, [f.entityId, date]
  )).rows[0].journal_entry_id;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mne060-'));
  const customer = await customerOf(f, 'C-060B');
  const vendor = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-060', 'Proveedor Sintético SA', 'PSI010101AA1', 'rfc', 'MXN', $3)`,
    [vendor, f.entityId, f.userId]
  );
  ids.inv16 = await saleIn(f, customer, 'PUE', [['1000', '16']], juneDay(3));
  ids.inv0 = await saleIn(f, customer, 'PUE', [['500', '0']], juneDay(4));
  ids.inv8 = await saleIn(f, customer, 'PUE', [['200', '8']], juneDay(5));
  ids.ppd = await saleIn(f, customer, 'PPD', [['400', '16']], juneDay(2));
  await recordCustomerPayment(
    { entityId: f.entityId, counterpartyId: customer, paymentAmount: '464', paymentDate: juneDay(20),
      paymentMethod: 'spei', applications: [{ documentId: ids.ppd, amountApplied: '464' }] },
    f.userId
  );
  ids.ppdPayment = await paymentEntry('customer_payments', juneDay(20));

  ids.billPue = (await billIn(vendor, 'PUE', '800.0000', '128.0000', juneDay(8))).id;
  const ppdBill = await billIn(vendor, 'PPD', '1500.0000', '240.0000', juneDay(9));
  await recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendor, paymentAmount: '870', paymentDate: juneDay(22),
      paymentMethod: 'spei', applications: [{ documentId: ppdBill.id, amountApplied: '870' }] },
    f.userId
  );
  ids.billPpd = ppdBill.id;
  ids.billPpdPayment = await paymentEntry('vendor_payments', juneDay(22));

  const isrRole = f.roles['isr_retenido_a_favor'];
  ids.withholding = (await manual(juneDay(10), 'ISR retenido', [[isrRole, '30.00', null], [f.roles['cxc'], null, '30.00']])).id;
  ids.applied = (await manual(juneDay(12), 'ISR aplicado', [[f.cuentas['6100'], '10.00', null], [isrRole, null, '10.00']])).id;
  ids.zeroSale = (await manual(juneDay(14), 'Venta en 4200', [[f.roles['cxc'], '100.00', null], [f.cuentas['4200'], null, '100.00']])).id;
  ids.zeroReversal = (await reverseJournalEntry(ids.zeroSale, f.userId, { reversalDate: juneDay(15) })).id;

  sibling = await crearEntidadHermana(f, 'Hermana 060');
  const siblingCustomer = await customerOf(sibling, 'C-060S');
  ids.siblingEntry = await entryOf('invoices', await saleIn(sibling, siblingCustomer, 'PUE', [['1000', '16']], juneDay(6)));

  ids.inv16Entry = await entryOf('invoices', ids.inv16);
  ids.inv0Entry = await entryOf('invoices', ids.inv0);
  ids.inv8Entry = await entryOf('invoices', ids.inv8);
  ids.billPueEntry = await entryOf('bills', ids.billPue);

  june = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, ...JUNE, forms: ['iva', 'isr'] });
}, 300_000);

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const sorted = (...xs: string[]): string[] => [...xs].sort();
const juneLine = (form: 'iva' | 'isr', key: string) => june.sections.find((s) => s.form === form)!.lines.find((l) => l.key === key)!;
const entryIdsOf = (form: 'iva' | 'isr', key: string): string[] => juneLine(form, key).source.entries.map((e) => e.entryId).sort();
const docsOf = (key: string): string[] => (juneLine('iva', key).source.documents ?? []).map((d) => d.documentId).sort();

describe('a line lists the documents of its own box, not every entry of its role account', () => {
  it('the paper settles: nothing blocks June', () => {
    expect(june.sections.map((s) => s.blockedBy)).toEqual([[], []]);
  });

  it('charged 16 % IVA is the 16 % invoice and the PPD collection, never the 8 % invoice', () => {
    const l = juneLine('iva', 'charged.tasa16.iva');
    expect(l).toMatchObject({ cents: '224.00', whole: '224' });
    expect(l.source.kind).toBe('documents');
    expect(docsOf('charged.tasa16.iva')).toEqual(sorted(ids.inv16, ids.ppd));
    expect(entryIdsOf('iva', 'charged.tasa16.iva')).toEqual(sorted(ids.inv16Entry, ids.ppdPayment));
    const nets = Object.fromEntries(l.source.entries.map((e) => [e.entryId, e.net]));
    expect(nets[ids.inv16Entry]).toBe('-160.0000');
    expect(nets[ids.ppdPayment]).toBe('-64.0000');
    // the listed nets add up to the line, which the role-account listing did not
    expect(l.source.entries.reduce((acc, e) => acc + Number(e.net), 0)).toBe(-224);
  });

  it('charged 8 % is only the 8 % invoice', () => {
    expect(entryIdsOf('iva', 'charged.tasa8.iva')).toEqual([ids.inv8Entry]);
    expect(entryIdsOf('iva', 'charged.tasa8.base')).toEqual([ids.inv8Entry]);
  });

  it('the 0 % base lists the 0 % invoice, which posts no IVA line, and no other', () => {
    expect(juneLine('iva', 'charged.tasa0.base')).toMatchObject({ cents: '500.00' });
    expect(docsOf('charged.tasa0.base')).toEqual([ids.inv0]);
    expect(entryIdsOf('iva', 'charged.tasa0.base')).toEqual([ids.inv0Entry]);
  });

  it('the 16 % base lists its two documents', () => {
    expect(entryIdsOf('iva', 'charged.tasa16.base')).toEqual(sorted(ids.inv16Entry, ids.ppdPayment));
  });

  it('creditable IVA lists the PUE bill entry and the PPD bill payment entry', () => {
    expect(juneLine('iva', 'creditable.tasa16.iva')).toMatchObject({ cents: '248.00' });
    expect(docsOf('creditable.tasa16.iva')).toEqual(sorted(ids.billPue, ids.billPpd));
    expect(entryIdsOf('iva', 'creditable.tasa16.iva')).toEqual(sorted(ids.billPueEntry, ids.billPpdPayment));
  });

  it('the role-account movement is kept apart, as the section tie-out', () => {
    const tie = june.sections[0].ledgerTieOut.find((t) => t.role === 'iva_trasladado')!;
    const have = tie.entries.map((e) => e.entryId);
    expect(have).toEqual(expect.arrayContaining([ids.inv16Entry, ids.inv8Entry, ids.ppdPayment]));
    expect(have).not.toContain(ids.siblingEntry);
  });
});

describe('the ISR lines trace what the builder counted', () => {
  it('withheld ISR lists the withholding and not the entry that applies it against a tax', () => {
    expect(juneLine('isr', 'withheld_income_tax').cents).toBe('30.00');
    expect(entryIdsOf('isr', 'withheld_income_tax')).toEqual([ids.withholding]);
  });

  it('nominal income lists a revenue account whose year-to-date net is zero', () => {
    expect(entryIdsOf('isr', 'nominal_income')).toEqual(expect.arrayContaining([ids.zeroSale, ids.zeroReversal, ids.inv16Entry]));
    expect(juneLine('isr', 'nominal_income').source.accounts).toContain('4200');
  });

  it('derived lines point to the datum that explains them, captured ones say so', () => {
    const isr = june.sections[1];
    const src = (key: string) => juneLine('isr', key).source;
    expect(src('estimated_profit')).toMatchObject({ kind: 'derived', ref: 'coefficient' });
    expect(src('pending_losses_applied')).toMatchObject({ kind: 'derived', ref: 'losses' });
    expect(src('ptu_deducted')).toMatchObject({ kind: 'derived', ref: 'ptu_paid' });
    expect(src('tax_caused')).toMatchObject({ kind: 'derived', ref: 'rate' });
    expect(src('prior_provisional_payments')).toMatchObject({ kind: 'captured', ref: 'prior_provisional' });
    expect(isr.inputs.coefficient).toMatchObject({
      value: '0.0875', sourceFiscalYear: 2025, sourceDocument: 'Declaración anual 2025, operación 000123',
    });
    expect(isr.inputs.rate).toMatchObject({
      value: expect.any(String), effectiveFrom: expect.any(String), sourceUrl: expect.any(String),
    });
    expect(isr.rounding).toEqual({ key: 'declaracion_redondeo_a_pesos', value: 'cada_renglon', defined: expect.any(Boolean) });
  });

  it('a PTU captured in the paper is the input of the derived ptu line', async () => {
    const aug = await generateFilingWorkpaper({
      tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8, forms: ['isr'], ptuPaidInYear: '8000',
    });
    expect(aug.sections[0].inputs.ptu_paid).toMatchObject({ value: '8000.0000', eighthsElapsed: 4, deductible: '4000.0000' });
  });

  it('the IVA proration and the prior balance are explained, even when nothing was prorated', () => {
    const iva = june.sections[0];
    expect(iva.inputs.proration).toMatchObject({ method: 'monthly', applied: false });
    expect(juneLine('iva', 'prior_balance_in_favor').source).toMatchObject({ kind: 'captured', ref: 'prior_balance_in_favor' });
  });
});

describe('the trace stays inside its entity', () => {
  it('the sibling entity entries are in no list of the entity', () => {
    const everything = june.sections.flatMap((s) => [
      ...s.lines.flatMap((l) => l.source.entries),
      ...s.ledgerTieOut.flatMap((t) => t.entries),
    ]);
    expect(everything.map((e) => e.entryId)).not.toContain(ids.siblingEntry);
  });

  it('the sibling paper has its own invoice and none of this entity', async () => {
    const other = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: sibling.entityId, ...JUNE, forms: ['iva'] });
    const l = other.sections[0].lines.find((x) => x.key === 'charged.tasa16.iva')!;
    expect(l).toMatchObject({ cents: '160.00' });
    expect(l.source.entries.map((e) => e.entryId)).toEqual([ids.siblingEntry]);
  });

  it('both ledger readers refuse a foreign entity even when handed its accounts and entries', async () => {
    const foreignAccounts = Object.values(sibling.cuentas);
    const client = await getClient();
    try {
      expect(await entriesMoving(client, f.entityId, foreignAccounts, '2026-01-01', '2026-12-31')).toEqual([]);
      expect(await entriesByIds(client, f.entityId, [ids.siblingEntry], foreignAccounts)).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('the cents of the ledger and the pesos differ at 0.50 and 0.51 as CFF art. 20 says', () => {
  it('0.50 goes down and 0.51 goes up, where "nearest" would take both up', async () => {
    const customer = await customerOf(f, 'C-060R');
    // IVA 3.125 × 16 % = 0.50 and 6.375 × 8 % = 0.51
    await saleIn(f, customer, 'PUE', [['3.125', '16'], ['6.375', '8']], '2026-07-06');
    const jul = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 7, forms: ['iva'] });
    const lines = jul.sections[0].lines;
    expect(lines.find((l) => l.key === 'charged.tasa16.iva')).toMatchObject({ cents: '0.50', whole: '0' });
    expect(lines.find((l) => l.key === 'charged.tasa8.iva')).toMatchObject({ cents: '0.51', whole: '1' });
  });
});

// ------------------------------------------------------------
// THE COMMAND: exit code, -o, quiet ids, and nothing written
// ------------------------------------------------------------

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

async function run(argv: string[]) {
  let exitCode: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const program = new Command('mnemosine');
    registerFilingWorkpaperCommand(program, {
      palette: plain,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
    });
    await program.parseAsync(['node', 'mnemosine', 'filing', 'workpaper', 'generate', ...argv, '-e', f.entityId, '-t', f.tenantId]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, out: out.join(''), err: err.join('') };
}

const counts = async (): Promise<string> => {
  const r = await query<{ n: string }>(
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE entity_id = $1)::text || '/' ||
            (SELECT COUNT(*) FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.entity_id = $1)::text || '/' ||
            (SELECT COUNT(*) FROM invoices WHERE entity_id = $1)::text || '/' ||
            (SELECT COUNT(*) FROM payment_allocations)::text AS n`,
    [f.entityId]
  );
  return r.rows[0].n;
};

describe('the command', () => {
  it('a blocked ISR exits 4 (validation; 3 is not-found), prints the block and writes nothing', async () => {
    const before = await counts();
    const r = await run(['--period', '2026-01', '--form', 'isr']);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(ExitCode.VALIDATION).toBe(4);
    expect(r.out).toContain('isr.blocked');
    expect(r.out).toContain('ISR-WP-NO-COEFFICIENT');
    expect(r.err).toMatch(/BLOCKS|BLOQUEA/);
    expect(await counts()).toBe(before);
  });

  it('a blocked IVA carries no result and also exits 4', async () => {
    const customer = await customerOf(f, 'C-060X');
    const bare = await saleIn(f, customer, 'PUE', [['1000', '16']], '2026-09-05');
    await query(`UPDATE invoice_lines SET tax_amount = 0, tax_rate = NULL WHERE invoice_id = $1`, [bare]);
    const paper = await generateFilingWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 9, forms: ['iva'] });
    expect(paper.sections[0]).toMatchObject({ resultCents: null, resultWhole: null, lines: [], blockedBy: ['DIOT-IVA-CABECERA'] });
    const r = await run(['--period', '2026-09', '--form', 'iva']);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.out).toContain('iva.blocked');
  });

  it('a settled month exits 0 and --json -o writes the whole paper to the file, not to stdout', async () => {
    const target = path.join(tmpRoot, 'papel.json');
    const before = await counts();
    const r = await run(['--period', '2026-06', '--json', '-o', target]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toBe('');
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as FilingWorkpaper;
    expect(written.filed).toBe(false);
    const tasa16 = written.sections[0].lines.find((l) => l.key === 'charged.tasa16.iva')!;
    expect(tasa16.source.documents?.map((d) => d.documentId).sort()).toEqual(sorted(ids.inv16, ids.ppd));
    expect(await counts()).toBe(before);
  });

  it('--quiet prints one id per line, unique across the two forms', async () => {
    const r = await run(['--period', '2026-06', '--quiet']);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toEqual(expect.arrayContaining(['iva.result', 'isr.result', 'iva.charged.tasa16.iva']));
  });

  it('a period that is not a month is a usage error, before any query', async () => {
    const r = await run(['--period', '2026-13']);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.err).toContain('2026-13');
  });
});
