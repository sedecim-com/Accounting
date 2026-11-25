import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// I8b · the ar family speaks by key, part 1 (MNE-001-802, #150)
//
// Under es-MX every refusal, question, receipt and label of `invoice` and `ar` is
// Spanish from the catalogue, written here by hand before the code; amounts and
// dates arrive formatted. The English, byte for byte, was compared by a dump.
// ============================================================

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({
  ...(await o<Record<string, unknown>>()), resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })), requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/ar/invoice-service.js', () => Object.fromEntries(['listInvoices', 'getInvoiceById', 'resolveInvoice', 'createInvoice',
  'issueInvoice', 'voidInvoice', 'listEntitySequences', 'updateDraftInvoice', 'deleteDraftInvoice', 'checkInvoiceSeries'].map((n) => [n, vi.fn()])));
vi.mock('../../src/services/ar/customer-service.js', () => ({ resolveCustomer: vi.fn(), customerLabel: (c: { company_name: string }) => c.company_name }));
vi.mock('../../src/services/accounting/account-service.js', () => ({ resolveAccount: vi.fn() }));
vi.mock('../../src/services/accounting/posting.js', () => ({ attestEntryAsync: vi.fn() }));
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-07-31'), zoneFor: vi.fn(async () => 'UTC') }));
vi.mock('../../src/services/ar/ar-controls.js', () => ({ arReconcile: vi.fn(), runArChecks: vi.fn(), AR_CHECK_NAMES: [] }));

import { legacyInvoiceTaxKeyWarning, registerInvoiceCommand } from '../../src/cli/invoice-command.js';
import { registerArCommand } from '../../src/cli/ar-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import * as svc from '../../src/services/ar/invoice-service.js';
import { resolveCustomer } from '../../src/services/ar/customer-service.js';
import { resolveAccount } from '../../src/services/accounting/account-service.js';
import { arReconcile, runArChecks } from '../../src/services/ar/ar-controls.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';
const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
const INV = { id: 'i1', invoice_number: 'INV-2026-00007', status: 'draft', total_amount: '1160.00', currency_code: 'MXN', journal_entry_id: null, due_date: '2026-08-30' };
const CUST = { id: 'c1', customer_number: 'C-0001', company_name: 'Cliente Sintetico SA', is_active: true, payment_terms: 'Net 30', currency_code: 'MXN' };
const mock = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
let out = '';
beforeEach(() => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  mock(svc.resolveInvoice).mockResolvedValue(INV);
  mock(resolveCustomer).mockResolvedValue(CUST);
  mock(resolveAccount).mockResolvedValue({ id: 'a1', code: '4100', name: 'Ventas', account_type: 'revenue' });
});
afterEach(() => { vi.restoreAllMocks(); resetLanguage(); });

/** Runs one leaf under es-MX and returns everything it said: stdout, stderr, the question and the error. */
async function es(argv: string[], confirm = false): Promise<string> {
  out = '';
  setLanguage('es');
  resetDeclarations();
  const cli = new Command('mnemosine').exitOverride();
  const deps = { palette, home: '/tmp/mnemosine-tests-no-home', shutdown: () => undefined,
    reportError: (e: unknown) => { out += (e as { localized: () => string }).localized(); },
    ...(confirm ? { confirm: async (q: string) => { out += q; return true; } } : {}) };
  registerInvoiceCommand(cli, deps);
  registerArCommand(cli, deps);
  // --format defaults to 'table', which sends `ar` and `series check` down their machine branch; the prose needs it unset.
  const clear = (c: Command): void => { if (c.getOptionValue('format') === 'table') c.setOptionValue('format', undefined); c.commands.forEach(clear); };
  clear(cli);
  await cli.parseAsync(['node', 'mnemosine', ...argv, '-e', 'e1']);
  return out.replace(/\s+/g, ' ');
}

describe('under es-MX, invoice prints Spanish', () => {
  it('list refuses its flags in Spanish', async () => {
    expect(await es(['invoice', 'list', '--status', 'nope'])).toContain('--status "nope" desconocido. Usa uno de: draft,');
    expect(await es(['invoice', 'list', '--date-basis', 'value'])).toContain('--date-basis value no está disponible en una factura');
    expect(await es(['invoice', 'list', '--period', '2026-07', '--since', '2026-07-01'])).toContain('Usa --period o --since/--until, no los dos.');
    expect(await es(['invoice', 'list', '--overdue-days', '-1'])).toContain('--overdue-days tiene que ser un entero no negativo; llegó "-1".');
  });
  it('show: the facts, the headings and the missing ones', async () => {
    mock(svc.getInvoiceById).mockResolvedValueOnce(null);
    expect(await es(['invoice', 'show', 'X'])).toContain('La factura X desapareció mientras se leía.');
    mock(svc.getInvoiceById).mockResolvedValueOnce({ ...INV, invoice_date: '2026-07-01', tax_amount: '160.00', po_number: 'OC-1', lines: [], payment_allocations: [] });
    const text = await es(['invoice', 'show', 'X']);
    for (const s of ['Fecha de factura 2026-07-01', 'Vencimiento 2026-08-30', 'Impuestos 160.00', 'Total 1160.00 MXN', 'Orden de compra OC-1',
      'Póliza sin contabilizar — corre `invoice issue`', 'CFDI sin timbrar — es un documento local', 'Líneas (0)', 'Cobros aplicados (0)']) {
      expect(text).toContain(s);
    }
  });
  it('create: its refusals, the note, the legacy key and the receipt', async () => {
    mock(resolveCustomer).mockResolvedValueOnce({ ...CUST, is_active: false });
    expect(await es(['invoice', 'create', '--customer', 'C'])).toContain('C-0001 está archivado. Restáuralo con `customer restore` antes de facturarle.');
    expect(await es(['invoice', 'create', '--customer', 'C'])).toContain('Una factura necesita al menos una línea: pasa --line');
    mock(resolveCustomer).mockResolvedValueOnce({ ...CUST, payment_terms: 'whenever' });
    expect(await es(['invoice', 'create', '--customer', 'C', '--line', 'account=4100;price=1'])).toContain('No se puede calcular un vencimiento con las condiciones de este cliente ("whenever"). Pasa --due-date <AAAA-MM-DD>.');
    expect(await es(['invoice', 'create', '--customer', 'C', '--line', 'account=4100;price=1', '--date', '2026-07-10', '--due-date', '2026-07-01'])).toContain('--due-date 2026-07-01 cae antes de la fecha de la factura 2026-07-10.');
    expect(await es(['invoice', 'create', '--customer', 'C', '--line', 'price=1'])).toContain('La línea "price=1" no tiene account=<código>.');
    expect(await es(['invoice', 'create', '--customer', 'C', '--line', 'account=4100'])).toContain('La línea "account=4100" no trae price=<importe>.');
    mock(resolveAccount).mockResolvedValueOnce({ id: 'a2', code: '1100', name: 'Caja', account_type: 'asset' });
    mock(svc.createInvoice).mockResolvedValueOnce({ ...INV, invoice_number: 'INV-2026-00008' });
    const text = await es(['invoice', 'create', '--customer', 'C', '--line', 'account=1100;price=1000;tax=16']);
    expect(text).toContain('Nota: 1100 Caja es de tipo "asset", no de ingresos.');
    expect(text).toContain('En una línea de factura, tax= es la TASA en porcentaje; escribe tax-rate= para que no se lea como un importe.');
    expect(text).toContain('✔ INV-2026-00008 quedó en borrador para Cliente Sintetico SA (1160.00 MXN, vence 2026-08-30)');
    expect(text).toContain('No se contabilizó ni se timbró nada. Contabilízala con `invoice issue`.');
  });
  it('issue: the refusals, the question and both results', async () => {
    mock(svc.resolveInvoice).mockResolvedValueOnce({ ...INV, journal_entry_id: 'je' });
    expect(await es(['invoice', 'issue', 'X'])).toContain('INV-2026-00007 ya se emitió y está en el mayor. Corrígela con `invoice void`');
    mock(svc.resolveInvoice).mockResolvedValueOnce({ ...INV, status: 'void' });
    expect(await es(['invoice', 'issue', 'X'])).toContain('INV-2026-00007 está en void y nunca podrá emitirse.');
    mock(svc.resolveInvoice).mockResolvedValueOnce({ ...INV, total_amount: '0.00' });
    expect(await es(['invoice', 'issue', 'X'])).toContain('INV-2026-00007 suma 0.00. Una factura sin importe no contabiliza nada');
    expect(await es(['invoice', 'issue', 'X'])).toContain('¿Contabilizar INV-2026-00007 (1160.00 MXN) en el mayor? Esto no se deshace. — no hay terminal donde preguntar.');
    const entry = { invoice: INV, entry: { entry_number: 'JE-9' }, entryLines: [], dryRun: true };
    mock(svc.issueInvoice).mockResolvedValueOnce(entry);
    expect(await es(['invoice', 'issue', 'X', '--dry-run'])).toContain('Se contabilizaría INV-2026-00007 como JE-9 No se escribió nada. Vuelve a correrlo sin --dry-run');
    mock(svc.issueInvoice).mockResolvedValueOnce({ ...entry, entry: null, dryRun: false });
    const text = await es(['invoice', 'issue', 'X'], true);
    expect(text).toContain('✔ INV-2026-00007 emitida como (sin póliza) El documento está contabilizado, sin timbrar y sin entregar.');
  });
  it('void, edit and delete', async () => {
    mock(svc.resolveInvoice).mockResolvedValueOnce({ ...INV, status: 'paid' });
    expect(await es(['invoice', 'void', 'X', '--reason', 'r'])).toContain('INV-2026-00007 está pagada. Desaplica primero el cobro, o emite una nota de crédito.');
    mock(svc.resolveInvoice).mockResolvedValueOnce({ ...INV, journal_entry_id: 'je' });
    mock(svc.voidInvoice).mockResolvedValueOnce({ invoice: INV, reversalEntryId: 'rev', dryRun: false });
    expect(await es(['invoice', 'void', 'X', '--reason', 'r'], true)).toContain('¿Anular INV-2026-00007 (1160.00 MXN) y revertir su póliza?✔ INV-2026-00007 anulada y su póliza quedó revertida.');
    mock(svc.voidInvoice).mockResolvedValueOnce({ invoice: INV, reversalEntryId: null, dryRun: true });
    expect(await es(['invoice', 'void', 'X', '--reason', 'r', '--dry-run'])).toContain('Se anularía INV-2026-00007 (nunca había llegado al mayor). No se escribió nada.');
    mock(svc.updateDraftInvoice).mockResolvedValueOnce(INV);
    expect(await es(['invoice', 'edit', 'X', '--memo', 'm'])).toContain('✔ INV-2026-00007 editada (1160.00 MXN, vence 2026-08-30) Sigue en borrador');
    expect(await es(['invoice', 'delete', 'X', '--reason', 'r', '--dry-run'])).toContain('Se eliminaría INV-2026-00007 (1160.00 MXN, borrador). El folio quedaría como un hueco documentado.');
    mock(svc.deleteDraftInvoice).mockResolvedValueOnce({ invoiceNumber: 'INV-2026-00007', folioGap: true });
    expect(await es(['invoice', 'delete', 'X', '--reason', 'r'], true)).toContain('¿Eliminar el borrador INV-2026-00007 (1160.00 MXN)? El documento se borra; sólo el rastro de auditoría conserva sus cifras.✔ INV-2026-00007 eliminada · el folio queda');
  });
  it('series: its refusals and the gaps, with a Spanish plural', async () => {
    expect(await es(['invoice', 'series', 'list', '--status', 'draft'])).toContain('`invoice series list` no tiene estado de ciclo de vida');
    expect(await es(['invoice', 'series', 'check', '--year', '26'])).toContain('--year debe ser un año de cuatro dígitos; llegó "26".');
    const s = { year: 2026, used: 1, counterAt: 3, missing: ['F-2'], explained: [] };
    mock(svc.checkInvoiceSeries).mockResolvedValueOnce([s]);
    const text = await es(['invoice', 'series', 'check']);
    expect(text).toContain('INV 2026 · 1 usado, contador en 3');
    expect(text).toContain('1 hueco SIN rastro: una transacción que se revirtió a media emisión, o algo peor.');
  });
});

describe('under es-MX, ar prints Spanish', () => {
  it('reconcile: labels, verdict and the manual entries', async () => {
    const r = { control_account: { code: '1120', name: 'Clientes' }, control_balance: '5000.00', open_invoices: '6000.00', foreign_open: [{ currency: 'USD', foreign: '100.00', book: '1800.00' }],
      unapplied_credit_notes: '1000.00', foreign_unapplied: [], fx_revaluation: '0.00', subledger_net: '5020.00', balanced: false, delta: '20.00',
      manual_entries: [{ entry_number: 'JE-3', entry_date: '2026-07-02', amount: '20.00', description: 'x' }] };
    mock(arReconcile).mockResolvedValueOnce(r);
    const text = await es(['ar', 'reconcile']);
    for (const s of ['Conciliación de CxC · cuenta de control 1120 Clientes', 'Saldo de la cuenta de control 5000.00', 'Facturas abiertas 6000.00',
      'de lo cual USD 100.00 1800.00', '− Notas de crédito sin aplicar 1000.00', 'Neto del auxiliar 5020.00',
      '✘ Diferencia 20.00 — el auxiliar y el mayor cuentan historias distintas.', 'Asientos manuales que tocan la cuenta de control (1)']) {
      expect(text).toContain(s);
    }
  });
  it('check: the title and the summary, singular and plural', async () => {
    mock(runArChecks).mockResolvedValueOnce({ results: [], blocking: 1, warnings: 3 });
    expect(await es(['ar', 'check'])).toContain('Controles de CxC · Entidad Sintetica SA 1 bloqueante · 3 advertencias');
    mock(runArChecks).mockResolvedValueOnce({ results: [], blocking: 0, warnings: 0 });
    expect(await es(['ar', 'check'])).toContain('0 bloqueantes · 0 advertencias');
  });
});

describe('the English keeps its words, and the lane finds no English literal', () => {
  it('the legacy warning is read when printed', () => {
    expect(legacyInvoiceTaxKeyWarning()).toBe('tax= in an invoice line is the RATE in percent; write tax-rate= so it cannot be read as an amount. tax= stops working in 2.0.0.');
  });
  it.each(['src/cli/invoice-command.ts', 'src/cli/ar-command.ts'])('%s', (file) => {
    const code = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(englishUserStrings(code, file).map((h) => h.text)).toEqual([]);
  });
});
