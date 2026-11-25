import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the ar family speaks by key, part 2 (MNE-001-803, #150). Under es-MX every refusal, question,
// receipt and label of `receipt`, `credit-note` and `customer` is Spanish from the catalogue, written here
// by hand before the code; amounts and dates arrive formatted. The English was compared by a dump.

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN', accountingStandard: 'mx_nif' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })), requireExplicitEntity: vi.fn(async () => CTX) }));
vi.mock('../../src/services/accounting/posting.js', () => ({ attestEntryAsync: vi.fn() }));
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-07-31'), zoneFor: vi.fn(async () => 'UTC') }));
vi.mock('../../src/services/ar/invoice-service.js', () => ({ resolveInvoice: vi.fn() }));
vi.mock('../../src/services/banking/bank-statement-service.js', () => ({ resolverCuentaBancaria: vi.fn(async () => ({ id: 'b1', account_name: 'Banco Sintetico' })) }));
vi.mock('../../src/cli/trace-completion-output.js', async (o) => ({ ...(await o<Record<string, unknown>>()), warnUntracedPayment: vi.fn(async () => undefined) }));
vi.mock('../../src/services/payments/payment-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), ...Object.fromEntries(
  ['recordCustomerPayment', 'applyCustomerPayment', 'unapplyCustomerPayment', 'reverseCustomerPayment', 'getCustomerPayment'].map((n) => [n, vi.fn()])) }));
vi.mock('../../src/services/ar/credit-note-service.js', () => Object.fromEntries(['createCreditNote', 'getCreditNote', 'listCreditNotes',
  'issueCreditNote', 'applyCreditNote', 'resolveCreditNote'].map((n) => [n, vi.fn()])));
vi.mock('../../src/services/ar/customer-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), ...Object.fromEntries(
  ['getCustomerById', 'resolveCustomer', 'archiveCustomer', 'restoreCustomer', 'getCustomerTaxProfile', 'setCustomerTaxProfile'].map((n) => [n, vi.fn()])) }));

import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { registerCreditNoteCommand } from '../../src/cli/credit-note-command.js';
import { registerCustomerCommand } from '../../src/cli/customer-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import * as pay from '../../src/services/payments/payment-service.js';
import * as cn from '../../src/services/ar/credit-note-service.js';
import * as cu from '../../src/services/ar/customer-service.js';
import { resolveInvoice } from '../../src/services/ar/invoice-service.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
const mock = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
const INV = { id: 'i1', invoice_number: 'INV-2026-00007', status: 'sent', amount_due: '1160.00', currency_code: 'MXN', customer_id: 'c1' };
const DOC = { numero: 'INV-2026-00007', saldoAnterior: '1160.00', saldoNuevo: '0.00', estado: 'paid' };
const PAYMENT = { paymentNumber: 'PMT-2026-00042', journalEntry: { entry_number: 'JE-12' }, documentos: [DOC], remanenteAnterior: '1360.00', remanenteNuevo: '200.00', date: '2026-07-31' };
const NOTE = { id: 'n1', credit_note_number: 'CN-2026-00003', status: 'draft', type: 'discount', credit_date: '2026-07-10', invoice_number: 'INV-2026-00007', tax_amount: '16.00',
  total_amount: '116.00', currency_code: 'MXN', amount_available: '116.00', reason: 'descuento', journal_entry_number: null, journal_entry_id: null, aplicaciones: [] };
const PROFILE = { customer_number: 'C-0001', tax_id: 'XAXX010101000', tax_regime: '601', tax_postal_code: '06000', uso_cfdi: null, complete: false, missing: ['uso_cfdi'] };
let out = ''; // everything a leaf said under es-MX: stdout, stderr, the question and the error
afterEach(() => { vi.restoreAllMocks(); resetLanguage(); });

async function es(argv: string[], confirm = false): Promise<string> {
  out = '';
  setLanguage('es');
  resetDeclarations();
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const cli = new Command('mnemosine').exitOverride();
  const deps = { palette, home: '/tmp/mnemosine-tests-no-home', shutdown: () => undefined,
    reportError: (e: unknown) => { out += (e as { localized: () => string }).localized(); },
    ...(confirm ? { confirm: async (q: string) => { out += q; return true; } } : {}) };
  for (const register of [registerReceiptCommand, registerCreditNoteCommand, registerCustomerCommand]) register(cli, deps);
  // --format defaults to 'table', which sends `credit-note show` and `customer tax show` down their machine branch (MNE-001-676).
  const clear = (c: Command): void => { if (c.getOptionValue('format') === 'table') c.setOptionValue('format', undefined); c.commands.forEach(clear); };
  clear(cli);
  await cli.parseAsync(['node', 'mnemosine', ...argv, '-e', 'e1']);
  return out.replace(/\s+/g, ' ');
}

describe('under es-MX, receipt prints Spanish', () => {
  it('record: the refusal, the question with its parts, the dry run and the no-terminal refusal', async () => {
    mock(resolveInvoice).mockResolvedValueOnce({ ...INV, status: 'draft' });
    expect(await es(['receipt', 'record', 'X', '--amount', '1'])).toContain('INV-2026-00007 está en "draft". Emítela primero: una factura tiene que estar en el mayor');
    mock(resolveInvoice).mockResolvedValue(INV);
    mock(pay.recordCustomerPayment).mockResolvedValue(PAYMENT);
    expect(await es(['receipt', 'record', 'X', '--amount', '1360', '--on-account', '--bank', 'B'], true)).toContain('Cuenta bancaria: Banco Sintetico ¿Registrar 1360 MXN cobrados en INV-2026-00007 (1160.00 → 0.00), con 200.00 a cuenta, en Banco Sintetico, en Entidad Sintetica SA? Esto contabiliza en el mayor.');
    expect(await es(['receipt', 'record', 'X', '--amount', '1360', '--on-account', '--dry-run'])).toContain('Registraría 1160.00 → 0.00 en INV-2026-00007 · 200.00 a cuenta · asiento JE-12 Ensayo: no se escribió nada.');
    expect(await es(['receipt', 'record', 'X', '--amount', '1160'])).toContain('— no hay terminal donde preguntar.');
  });
  it('show and list', async () => {
    mock(pay.getCustomerPayment).mockResolvedValueOnce({ payment_number: 'PMT-2026-00042', status: 'reversed', payment_date: '2026-07-02', payment_amount: '1160.00',
      currency_code: 'MXN', payment_method: 'spei', unapplied_amount: '0.00', reversed_at: '2026-07-05T10:00:00Z', reversal_cause: null, advance_base: null, advance_tax_rate: null, advance_iva: null, aplicaciones: [] });
    const text = await es(['receipt', 'show', 'P']);
    for (const s of ['Fecha 2026-07-02', 'Importe 1160.00 MXN', 'Forma de pago spei', 'Reversado 2026-07-05', 'Causa de la reversa sin declarar', 'Aplicaciones (0)']) expect(text).toContain(s);
    expect(await es(['receipt', 'list', '--status', 'open'])).toContain('Filtra los cobros con --unapplied o --needs-rep');
  });
  it('apply, unapply and reverse, with the Spanish plural', async () => {
    mock(pay.getCustomerPayment).mockResolvedValue({ id: 'p1', payment_number: 'PMT-2026-00042', payment_amount: '1160.00', currency_code: 'MXN' });
    mock(resolveInvoice).mockResolvedValue(INV);
    mock(pay.applyCustomerPayment).mockResolvedValue({ ...PAYMENT, documentos: [{ ...DOC, withholdingIsr: '100.00', withholdingIva: '106.67' }] });
    expect(await es(['receipt', 'apply', 'P', '--invoice', 'X:1160'], true)).toContain('¿Aplicar INV-2026-00007 (1160.00 → 0.00; retenido ISR 100.00 + IVA 106.67) de PMT-2026-00042 (a cuenta 1360.00 → 200.00) el 2026-07-31 en Entidad Sintetica SA?');
    expect(out).toContain('PMT-2026-00042 aplicado');
    mock(pay.unapplyCustomerPayment).mockResolvedValue({ paymentNumber: 'PMT-2026-00042', desaplicado: '960.00', documento: DOC, ivaReAparcado: '132.41',
      ivaEstimado: true, ivaKeptCaused: '0.00', ivaAtCashing: '0.00', date: '2026-07-31', journalEntry: { entry_number: 'JE-14' }, attestation: { entityId: 'e1', entryId: 'x' } });
    expect(await es(['receipt', 'unapply', 'P', '--invoice', 'X', '--reason', 'r', '--dry-run'])).toContain('Desaplicaría 960.00 de INV-2026-00007 (1160.00 → 0.00, de vuelta a cuenta) el 2026-07-31 · IVA reaparcado 132.41 (estimación prorrateada)');
    expect(await es(['receipt', 'unapply', 'P', '--invoice', 'X', '--reason', 'r'], true)).toContain('El dinero queda a cuenta; la factura se reabre.✔ PMT-2026-00042 desaplicado de INV-2026-00007');
    mock(pay.reverseCustomerPayment).mockResolvedValue({ paymentNumber: 'PMT-2026-00042', reversals: [{ entryNumber: 'JE-20', of: 'JE-12' }], attestations: [],
      documentosReabiertos: [DOC, DOC], cause: 'taken_back', causeDefaulted: false, warnings: [] });
    expect(await es(['receipt', 'reverse', 'P', '--reason', 'r', '--dry-run'])).toContain('Reversaría PMT-2026-00042 · 1 asiento reflejado, 2 facturas reabiertas');
    expect(await es(['receipt', 'reverse', 'P', '--reason', 'r'], true)).toContain('¿Reversar PMT-2026-00042 (1160.00 MXN; causa taken_back)? 1 asiento del mayor recibe su espejo y 2 facturas se reabren.✔ PMT-2026-00042 reversado · JE-12→JE-20 · 2 facturas reabiertas');
  });
});

describe('under es-MX, credit-note and customer print Spanish', () => {
  it('credit-note create, show, list, issue and apply', async () => {
    expect(await es(['credit-note', 'create', '--type', 'discount', '--amount', '1'])).toContain('Una nota de crédito necesita su destino: --invoice <ref>');
    mock(resolveInvoice).mockResolvedValue(INV);
    mock(cn.createCreditNote).mockResolvedValueOnce(NOTE);
    expect(await es(['credit-note', 'create', '--type', 'discount', '--amount', '100', '--invoice', 'X'])).toContain('✔ CN-2026-00003 quedó en borrador (discount, 116.00 MXN, acredita INV-2026-00007) No se contabilizó nada. Contabilízala con `credit-note issue` y luego `credit-note apply`.');
    mock(cn.getCreditNote).mockResolvedValueOnce(NOTE);
    const text = await es(['credit-note', 'show', 'N']);
    for (const s of ['Tipo discount', 'Fecha 2026-07-10', 'Acredita la factura INV-2026-00007', 'Impuestos 16.00', 'Disponible 116.00', 'Motivo descuento',
      'Póliza sin contabilizar — corre `credit-note issue`', 'Aplicaciones (0)']) expect(text).toContain(s);
    expect(await es(['credit-note', 'list', '--status', 'nope'])).toContain('--status "nope" desconocido. Usa uno de: draft,');
    mock(cn.resolveCreditNote).mockResolvedValueOnce({ ...NOTE, status: 'issued', journal_entry_id: 'je' });
    expect(await es(['credit-note', 'issue', 'N'])).toContain('CN-2026-00003 está en "issued" y ya está en el mayor.');
    mock(cn.resolveCreditNote).mockResolvedValue(NOTE);
    mock(cn.issueCreditNote).mockResolvedValueOnce({ creditNoteNumber: 'CN-2026-00003', journalEntry: { entry_number: 'JE-41' } });
    expect(await es(['credit-note', 'issue', 'N'], true)).toContain('¿Contabilizar CN-2026-00003 (116.00 MXN contra la cuenta por cobrar) en el mayor? Esto no se deshace.✔ CN-2026-00003 emitida como JE-41 · la nota ya es saldo a favor del cliente');
    expect(await es(['credit-note', 'apply', 'N'])).toContain('Di a qué factura o facturas:');
    expect(await es(['credit-note', 'apply', 'N', '--invoice', 'A', '--invoice', 'B:1'])).toContain('La factura "A" no trae importe.');
    mock(cn.applyCreditNote).mockResolvedValue({ creditNoteNumber: 'CN-2026-00003', documentos: [DOC], disponibleAnterior: '116.00', disponibleNuevo: '0.00', notaStatus: 'applied' });
    expect(await es(['credit-note', 'apply', 'N', '--invoice', 'X:116'], true)).toContain('¿Aplicar CN-2026-00003 a INV-2026-00007 (1160.00 → 0.00) en Entidad Sintetica SA?✔ CN-2026-00003 aplicada: INV-2026-00007 1160.00 → 0.00 (paid) · disponible 0.00 · nota applied');
  });
  it('customer refusals, show, archive, restore and tax', async () => {
    expect(await es(['customer', 'list', '--balance-gt', 'abc'])).toContain('--balance-gt tiene que ser un número; llegó "abc".');
    expect(await es(['customer', 'show', 'C', '--since', '2026-01-01'])).toContain('`customer show` es una ficha a una fecha');
    expect(await es(['customer', 'create', '--name', 'X', '--currency', 'PESO'])).toContain('--currency tiene que ser un código de 3 letras; llegó "PESO".');
    expect(await es(['customer', 'tax', 'list', '--status', 'x'])).toContain('`customer tax list` no tiene filtro de ciclo de vida: usa --missing.');
    mock(cu.resolveCustomer).mockResolvedValue({ id: 'c1', customer_number: 'C-0001' });
    mock(cu.getCustomerById).mockResolvedValueOnce({ customer_number: 'C-0001', company_name: 'Cliente Sintetico SA', is_active: false, payment_terms: 'Net 30',
      credit_status: 'approved', open_balance: '0.00', book_currency: 'MXN', balances_by_currency: [], open_invoices: [], recent_payments: [] });
    const text = await es(['customer', 'show', 'C']);
    for (const s of ['C-0001 [archivado]', 'Condiciones Net 30', 'Estado de crédito approved', 'Documentos abiertos (0)', 'Cobros recientes (0)']) expect(text).toContain(s);
    mock(cu.archiveCustomer).mockResolvedValueOnce({ balance: { open_documents: 1, balances_by_currency: [{ currency_code: 'MXN', open_balance: '10.00' }], open_balance: '10.00', book_currency: 'MXN' } });
    expect(await es(['customer', 'archive', 'C', '--reason', 'r', '--force'])).toContain('✔ C-0001 archivado. Queda 1 documento abierto por MXN 10.00 en los libros.');
    mock(cu.restoreCustomer).mockResolvedValueOnce({ customer_number: 'C-0001' });
    expect(await es(['customer', 'restore', 'C'])).toContain('C-0001 vuelve a estar activo.');
    mock(cu.getCustomerTaxProfile).mockResolvedValueOnce(PROFILE);
    expect(await es(['customer', 'tax', 'show', 'C'])).toContain('Régimen 601 Código postal 06000 UsoCFDI — ▲ Falta uso_cfdi: un CFDI para este cliente sería rechazado.');
    mock(cu.setCustomerTaxProfile).mockResolvedValueOnce(PROFILE);
    expect(await es(['customer', 'tax', 'set', 'C', '--postal-code', '06000'])).toContain('✔ perfil fiscal de C-0001 actualizado · todavía falta uso_cfdi');
  });
});

describe('the English keeps its words, and the lane finds no English literal', () => {
  it('an English plural defect stays', () => {
    setLanguage('en');
    expect(t('ar.receipt.reverse.would_detail', { entries: 1, invoices: 1 })).toBe('1 entry(ies) mirrored, 1 invoice(s) reopened');
    expect(t('ar.customer.archive.open_documents', { count: 1, balance: 'MXN 10.00' })).toBe('1 open document(s) worth MXN 10.00 remain on the books.');
  });
  it.each(['src/cli/receipt-command.ts', 'src/cli/credit-note-command.ts', 'src/cli/customer-command.ts'])('%s', (file) => {
    const code = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(englishUserStrings(code, file).map((h) => h.text)).toEqual([]);
  });
});
