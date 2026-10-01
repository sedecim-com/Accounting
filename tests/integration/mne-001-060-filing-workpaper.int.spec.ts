import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { recordIncomeTaxInput } from '../../src/services/fiscal/provisional-income-tax-inputs.js';
import { generateFilingWorkpaper, type FilingWorkpaper } from '../../src/services/fiscal/filing-workpaper.js';
import { workpaperRows } from '../../src/cli/filing-workpaper-command.js';

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
    expect(src.kind).toBe('accounts');
    expect(src.accounts).toEqual(['iva_trasladado']);
    expect(src.entries.map((e) => e.entryId)).toContain(invoiceEntryId);
    expect(src.entries.find((e) => e.entryId === invoiceEntryId)?.net).toBe('-160.0000');
  });

  it('the nominal income points to the entry that credited the revenue account', () => {
    const src = line('isr', 'nominal_income').source;
    expect(src.accounts).toEqual(['4100']);
    expect(src.entries.find((e) => e.entryId === invoiceEntryId)?.net).toBe('-1500.0000');
  });

  it('a captured or derived line says so and lists no entry', () => {
    expect(line('iva', 'prior_balance_in_favor').source).toEqual({ kind: 'captured', accounts: [], entries: [] });
    expect(line('isr', 'tax_caused').source.kind).toBe('derived');
  });

  it('no line is left without a source kind, and the flat rows carry both columns', () => {
    const rows = workpaperRows(wp);
    expect(rows.every((r) => r.cents !== undefined && r.whole !== undefined)).toBe(true);
    expect(wp.sections.flatMap((s) => s.lines).every((l) => l.source.kind)).toBe(true);
    const number = line('iva', 'charged.tasa16.iva').source.entries.find((e) => e.entryId === invoiceEntryId)?.entryNumber;
    expect(number).toBeTruthy();
    expect(rows.find((r) => r.form === 'iva' && r.line === 'charged.tasa16.iva')?.entries).toContain(number);
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
