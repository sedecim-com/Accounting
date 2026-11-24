import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.8 · the ap family speaks by key (MNE-001-228 part 1, #270): ap reconcile,
// vendor and payment
//
// One assertion per key this part adds to the I8.8 block, through the real
// leaves over doubles (the services are mocked; `query` answers only the
// vendor-payment lookup), in English (the test locale is en-US) and an es-MX
// run of each area, with a singular and a plural where «(s)» used to be.
// Prepaid's are in ap-family-by-key.spec.ts; bill's arrive with part 2.
// ============================================================

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM vendor_payments')) {
      return { rows: [{ id: 'vp-1', payment_number: 'VPMT-2026-00019', payment_amount: '1160.0000', currency_code: 'MXN' }] };
    }
    throw new Error(`query must not be called: ${sql}`);
  }),
  currentTenant: () => 't1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })),
  requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/ap/ap-controls.js', () => ({ apReconcile: vi.fn() }));
vi.mock('../../src/services/ap/vendor-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveVendor: vi.fn(async () => ({ id: 'v1' })),
  getVendorById: vi.fn(async () => null),
  createVendor: vi.fn(async () => ({ vendor_number: 'VND-0007', company_name: 'Papeleria Sintetica', payment_terms: 'Net 30', currency_code: 'MXN' })),
  updateVendor: vi.fn(async () => ({ vendor_number: 'VND-0007' })),
  setVendorTerms: vi.fn(),
}));
vi.mock('../../src/services/ap/bill-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveBill: vi.fn(),
}));
vi.mock('../../src/services/payments/payment-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  recordVendorPayment: vi.fn(),
  applyVendorPayment: vi.fn(),
  unapplyVendorPayment: vi.fn(),
  reverseVendorPayment: vi.fn(),
}));
vi.mock('../../src/services/idempotency/idempotency-store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  mirarLlave: vi.fn(async () => null),
  conLlave: vi.fn(async (_c: unknown, _k: unknown, fn: () => Promise<unknown>) => ({ repetido: false, resultado: await fn() })),
}));
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-07-31') }));
vi.mock('../../src/services/accounting/posting.js', () => ({ attestEntryAsync: vi.fn() }));
vi.mock('../../src/services/banking/bank-statement-service.js', () => ({
  resolverCuentaBancaria: vi.fn(async () => ({ id: 'ba-1', account_name: 'Operativa BBVA' })),
}));
vi.mock('../../src/cli/trace-completion-output.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  warnUntracedPayment: vi.fn(async () => undefined),
}));

import { registerApCommand } from '../../src/cli/ap-command.js';
import { registerVendorCommand } from '../../src/cli/vendor-command.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { getVendorById, setVendorTerms } from '../../src/services/ap/vendor-service.js';
import { requireExplicitEntity } from '../../src/cli/kernel/entity-context.js';
import { resolveBill } from '../../src/services/ap/bill-service.js';
import {
  applyVendorPayment,
  recordVendorPayment,
  reverseVendorPayment,
  unapplyVendorPayment,
} from '../../src/services/payments/payment-service.js';
import { conLlave, mirarLlave } from '../../src/services/idempotency/idempotency-store.js';
import { todayFor } from '../../src/services/policy/today.js';

type Localized = Error & { localized: (l: 'es' | 'en') => string };
const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };

let out = '';
let err = '';
beforeEach(() => {
  vi.clearAllMocks();
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
});

function program(confirm?: (q: string) => Promise<boolean>) {
  resetDeclarations();
  const state: { code?: number; error?: Localized; cli: Command } = { cli: new Command('mnemosine').exitOverride() };
  const deps = {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (c: number) => { state.code = c; },
    reportError: (e: unknown) => { state.error = e as Localized; },
    ...(confirm ? { confirm } : {}),
  };
  registerApCommand(state.cli, deps);
  registerVendorCommand(state.cli, deps);
  registerPaymentCommands(state.cli, deps);
  return state;
}
async function run(argv: string[], confirm?: (q: string) => Promise<boolean>) {
  const state = program(confirm);
  await state.cli.parseAsync(['node', 'mnemosine', ...argv, '-e', 'e1']);
  return state;
}

// ---- ap reconcile ---------------------------------------------------

const RECONCILED = {
  asOf: '2026-07-31',
  cuentaControl: { id: 'c-2110', code: '2110', name: 'Proveedores' },
  subdiario: '1000.00',
  foreignOpen: [] as Array<{ currency: string; foreign: string; book: string }>,
  fxRevaluation: '0.00',
  mayor: '1000.00',
  diferencia: '0.00',
  explicado: '0.00',
  sinExplicar: '0.00',
  cuadra: true,
  partidas: [] as Array<Record<string, string | null>>,
  advertenciaAsOf: null,
  omitidas: 0,
};
const ITEM = { tipo: 'asiento_manual', referencia: 'JE-2026-00042', fecha: '2026-07-15', importe: '100.00', detalle: 'synthetic' };
const RESIDUE = { tipo: 'residuo', referencia: '—', fecha: null, importe: '50.00', detalle: 'synthetic' };

describe('I8.8 · ap reconcile speaks by key', () => {
  it('ap.reconcile.date_invalid', async () => {
    const s = await run(['ap', 'reconcile', '--as-of', '2026-02-31']);
    expect(s.error?.message).toBe('--as-of must be a real date in YYYY-MM-DD form; got "2026-02-31".');
    expect(s.error?.localized('es')).toBe('--as-of debe ser una fecha real en formato YYYY-MM-DD; llegó "2026-02-31".');
  });

  it('the balanced table: title, header, row labels, verdict, no manual entries', async () => {
    vi.mocked(apReconcile).mockResolvedValue(RECONCILED as never);
    await run(['ap', 'reconcile']);
    expect(out).toContain('AP reconciliation · control 2110 Proveedores · as of 2026-07-31\n');
    for (const label of ['Subledger (open bills)', 'Control account (ledger)', 'Difference', 'Explained by items', 'Unexplained']) {
      expect(out).toMatch(new RegExp(`\\n  ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\d`));
    }
    expect(out).toContain('\n✔ Balanced.\n');
    expect(out).toContain('  No manual entries on the control account either.\n');
    setLanguage('es');
    out = '';
    await run(['ap', 'reconcile']);
    expect(out).toContain('Conciliación de CxP · control 2110 Proveedores · al 2026-07-31\n');
    expect(out).toMatch(/\n {2}Subdiario \(facturas abiertas\) +1000\.00\n/);
    expect(out).toMatch(/\n {2}Explicado por partidas +0\.00\n/);
    // The labels pad to the longest one, so the Spanish column still lines up.
    const rows = out.split('\n').filter((l) => /^ {2}\S.* \d+\.\d{2}$/.test(l));
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((l) => l.length)).size).toBe(1);
    expect(out).toContain('\n✔ Cuadra.\n');
    expect(out).toContain('  Tampoco hay asientos manuales en la cuenta de control.\n');
  });

  it('an unexplained difference, its items, --explain and the capped listing', async () => {
    vi.mocked(apReconcile).mockResolvedValue({
      ...RECONCILED,
      foreignOpen: [{ currency: 'USD', foreign: '50.00', book: '900.00' }],
      fxRevaluation: '12.00',
      mayor: '850.00', diferencia: '150.00', explicado: '100.00', sinExplicar: '50.00', cuadra: false,
      partidas: [ITEM, RESIDUE], omitidas: 1,
    } as never);
    await run(['ap', 'reconcile', '--explain']);
    expect(out).toContain('    of which USD 50.00');
    expect(out).toContain('    of which FX revaluation');
    expect(out).toContain('\n✘ Difference 150.00 — 100.00 named, 50.00 with no owner.\n');
    expect(out).toContain('\nReconciling items (2)\n');
    expect(out).toContain('  importe = what this item adds to (subledger − ledger); the named ones sum to Explained, and with the residual row to Difference.\n');
    expect(out).toContain('  Amounts are rounded per item; the column may differ from Explained by cents.\n');
    expect(out).toContain('\nWhy each item is there\n');
    expect(err).toContain(
      '1 more item exists and was not listed: the listing is capped per probe. The totals (explained, unexplained) do include them.\n'
    );
    setLanguage('es');
    out = '';
    err = '';
    vi.mocked(apReconcile).mockResolvedValue({
      ...RECONCILED, mayor: '900.00', diferencia: '100.00', explicado: '100.00', cuadra: false, partidas: [ITEM], omitidas: 2,
    } as never);
    await run(['ap', 'reconcile', '--explain']);
    expect(out).toContain('\n✘ Diferencia 100.00 — cada peso de ella está nombrado abajo.\n');
    expect(out).toContain('\nPartidas conciliatorias (1)\n');
    expect(out).toContain('  Los importes se redondean por partida; la columna puede diferir de Explicado por centavos.\n');
    expect(out).toContain('\nPor qué está cada partida\n');
    expect(err).toContain('2 partidas más existen y no se enumeraron: el listado tiene tope por sonda.');
    out = '';
    vi.mocked(apReconcile).mockResolvedValueOnce({
      ...RECONCILED, foreignOpen: [{ currency: 'USD', foreign: '50.00', book: '900.00' }], fxRevaluation: '12.00',
    } as never);
    await run(['ap', 'reconcile']);
    expect(out).toMatch(/\n {4}de lo cual USD 50\.00 +900\.00\n/);
    expect(out).toMatch(/\n {4}de lo cual revaluación cambiaria +12\.00\n/);
    expect(out).not.toContain('of which');
  });

  it('the English verdict when every peso is named', async () => {
    vi.mocked(apReconcile).mockResolvedValue({
      ...RECONCILED, mayor: '900.00', diferencia: '100.00', explicado: '100.00', cuadra: false, partidas: [ITEM],
    } as never);
    await run(['ap', 'reconcile']);
    expect(out).toContain('\n✘ Difference 100.00 — every peso of it is named below.\n');
    expect(out).toContain('  importe = what this item adds to');
  });
});

// ---- vendor ---------------------------------------------------------

describe('I8.8 · vendor speaks by key', () => {
  it('ap.vendor.show.include_unknown and disappeared', async () => {
    const bad = await run(['vendor', 'show', 'Papeleria', '--include', 'bank']);
    expect(bad.error?.message).toBe(
      'Cannot include "bank". This command can include: activity. "compliance" needs the vendor_tax_profiles and vendor_compliance_checks tables, and "bank" needs the audited decrypt path — neither exists yet.'
    );
    expect(bad.error?.localized('es')).toMatch(/^No se puede incluir "bank"\. Este comando puede incluir: activity\./);
    vi.mocked(getVendorById).mockResolvedValueOnce(null as never);
    const gone = await run(['vendor', 'show', 'Papeleria']);
    expect(gone.error?.message).toBe('Vendor Papeleria disappeared while reading it.');
    expect(gone.error?.localized('es')).toBe('El proveedor Papeleria desapareció mientras se leía.');
  });

  it('ap.vendor.create: the tax id type and the terms, refused by key', async () => {
    vi.mocked(requireExplicitEntity).mockResolvedValueOnce({ ...CTX, country: 'BR' } as never);
    const noType = await run(['vendor', 'create', 'Papeleria Sintetica', '--tax-id', 'X1']);
    expect(noType.error?.message).toBe(
      'This entity is incorporated in "BR", which has no default tax id type. Say which one with --tax-id-type rfc|ein|vat.'
    );
    expect(noType.error?.localized('es')).toMatch(/^Esta entidad está constituida en "BR", que no tiene un tipo de identificador fiscal/);
    const unknown = await run(['vendor', 'create', 'Papeleria Sintetica', '--tax-id', 'X1', '--tax-id-type', 'cuit']);
    expect(unknown.error?.message).toBe('Unknown --tax-id-type "cuit". Use one of: rfc, ein, vat.');
    expect(unknown.error?.localized('es')).toBe('--tax-id-type "cuit" no existe. Usa uno de: rfc, ein, vat.');
    const alone = await run(['vendor', 'create', 'Papeleria Sintetica', '--tax-id-type', 'rfc']);
    expect(alone.error?.message).toBe('--tax-id-type was given without --tax-id.');
    expect(alone.error?.localized('es')).toBe('Llegó --tax-id-type sin --tax-id.');
    const terms = await run(['vendor', 'create', 'Papeleria Sintetica', '--terms', 'cuando se pueda']);
    expect(terms.error?.message).toMatch(/^Payment terms "cuando se pueda" were not understood, so no due date could ever be computed/);
    expect(terms.error?.localized('es')).toMatch(/^Las condiciones de pago "cuando se pueda" no se entendieron/);
  });

  it('ap.vendor.create.tax_id_accepted and no_tax_id', async () => {
    await run(['vendor', 'create', 'Papeleria Sintetica', '--tax-id', 'PSI180412TF4']);
    expect(err).toMatch(/ {2}Tax id PSI180412TF4 accepted under: Mexico \(SAT\) RFC: .*\.\n/);
    err = '';
    await run(['vendor', 'create', 'Papeleria Sintetica']);
    expect(err).toContain('  No tax id on file. A received CFDI cannot be matched to this vendor and it cannot appear in a DIOT or a 1099.\n');
    setLanguage('es');
    err = '';
    await run(['vendor', 'create', 'Papeleria Sintetica']);
    expect(err).toContain('  No hay identificador fiscal registrado. Un CFDI recibido no podrá casarse con este proveedor');
  });

  it('ap.vendor.edit and ap.vendor.terms', async () => {
    const none = await run(['vendor', 'edit', 'Papeleria']);
    expect(none.error?.message).toMatch(/^Nothing to change\. Pass --name, --contact, --email, --phone or --notes\./);
    expect(none.error?.localized('es')).toMatch(/^Nada que cambiar\. Pasa --name/);
    await run(['vendor', 'edit', 'Papeleria', '--email', 'cxp@sintetica.example']);
    expect(out).toContain('✔ VND-0007 updated (email)\n');
    const nothing = await run(['vendor', 'terms', 'set', 'Papeleria']);
    expect(nothing.error?.message).toBe('Nothing to set. Pass --terms, --currency, or both.');
    expect(nothing.error?.localized('es')).toBe('Nada que fijar. Pasa --terms, --currency, o los dos.');

    const vendor = { vendor_number: 'VND-0007', payment_terms: '2/10 Net 30', currency_code: 'MXN' };
    vi.mocked(setVendorTerms).mockResolvedValueOnce({ vendor, terms: { netDays: 30, discountPct: 2, discountDays: 10 } } as never);
    await run(['vendor', 'terms', 'set', 'Papeleria', '--terms', '2/10 Net 30']);
    expect(err).toContain('  Read as: due 30 days after the bill date, 2% off if paid within 10 days.\n');
    vi.mocked(setVendorTerms).mockResolvedValueOnce({ vendor, terms: { netDays: null, discountPct: null, discountDays: null } } as never);
    await run(['vendor', 'terms', 'set', 'Papeleria', '--terms', 'Due on receipt']);
    expect(err).toContain('  Read as: no net term.\n');
    setLanguage('es');
    out = '';
    err = '';
    await run(['vendor', 'edit', 'Papeleria', '--phone', '5555000000']);
    expect(out).toContain('✔ VND-0007 actualizado (phone)\n');
    vi.mocked(setVendorTerms).mockResolvedValueOnce({ vendor, terms: { netDays: 1, discountPct: 1, discountDays: 1 } } as never);
    await run(['vendor', 'terms', 'set', 'Papeleria', '--terms', '1/1 Net 1']);
    expect(err).toContain('  Leído como: vence 1 día después de la fecha de la factura, 1% de descuento si se paga dentro de 1 día.\n');
  });
});

// ---- payment --------------------------------------------------------

const BILL = { id: 'b7', bill_number: 'BILL-2026-00007', status: 'approved', currency_code: 'MXN' };
const RECORDED = {
  paymentId: 'vp-1',
  paymentNumber: 'VPMT-2026-00019',
  documentos: [{ numero: 'BILL-2026-00007', saldoAnterior: '1160.00', saldoNuevo: '0.00', estado: 'paid' }],
  journalEntry: { entry_number: 'JE-2026-00101', description: 'Pago a proveedor' },
  attestation: null,
  deductibilityFindings: [],
};
const APPLIED = {
  paymentNumber: 'VPMT-2026-00019',
  documentos: [
    { numero: 'BILL-2026-00007', saldoAnterior: '1160.00', saldoNuevo: '0.00', estado: 'paid' },
    { numero: 'BILL-2026-00011', saldoAnterior: '580.00', saldoNuevo: '0.00', estado: 'paid' },
  ],
  remanenteAnterior: '2000.00',
  remanenteNuevo: '320.00',
  date: '2026-07-31',
  condonado: '60.00',
  descuentosFueraDeTerminos: ['BILL-2026-00011'],
  cuentaCondonacion: '7010 Otros ingresos',
  politicaDefinida: false,
  ivaNoAcreditable: '8.28',
  journalEntry: null,
  attestation: null,
};

describe('I8.8 · payment create speaks by key', () => {
  it('ap.payment.create.not_payable, by its three reasons', async () => {
    const cases: Array<[string, string, string]> = [
      ['paid', 'It is already settled.', 'Ya está liquidada.'],
      ['draft', 'Approve it first: the liability has to be in the ledger before it can be paid.', 'Apruébala primero: el pasivo tiene que estar en el mayor antes de poder pagarse.'],
      ['cancelled', 'Only approved, posted, partially_paid bills can be paid.', 'Sólo se pagan facturas approved, posted, partially_paid.'],
    ];
    for (const [status, en, es] of cases) {
      vi.mocked(resolveBill).mockResolvedValueOnce({ ...BILL, status } as never);
      const s = await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160']);
      expect(s.error?.message).toBe(`Bill BILL-2026-00007 is "${status}". ${en}`);
      expect(s.error?.localized('es')).toBe(`La factura BILL-2026-00007 está en "${status}". ${es}`);
    }
  });

  it('the dry run: would_record and dry_run, and the bank account echoed', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(recordVendorPayment).mockResolvedValue(RECORDED as never);
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--bank', 'BBVA', '--dry-run']);
    expect(err).toContain('Bank account: Operativa BBVA\n');
    expect(out).toContain('Would record 1160.00 → 0.00 on BILL-2026-00007 · entry JE-2026-00101\n');
    expect(err).toContain('Dry run: nothing was written.\n');
    setLanguage('es');
    out = '';
    err = '';
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--bank', 'BBVA', '--dry-run']);
    expect(err).toContain('Cuenta bancaria: Operativa BBVA\n');
    expect(out).toContain('Registraría 1160.00 → 0.00 en BILL-2026-00007 · asiento JE-2026-00101\n');
    expect(err).toContain('Ensayo: no se escribió nada.\n');
  });

  it('ap.payment.create.confirm, with and without --bank, and the no-terminal abort', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(recordVendorPayment).mockResolvedValue(RECORDED as never);
    const asked: string[] = [];
    const no = async (q: string) => { asked.push(q); return false; };
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160'], no);
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--bank', 'BBVA'], no);
    expect(asked).toEqual([
      'Record 1160 MXN paid on BILL-2026-00007 (1160.00 → 0.00) in Entidad Sintetica SA? This posts to the ledger.',
      'Record 1160 MXN paid on BILL-2026-00007 (1160.00 → 0.00) from Operativa BBVA in Entidad Sintetica SA? This posts to the ledger.',
    ]);
    setLanguage('es');
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--bank', 'BBVA'], no);
    expect(asked[2]).toBe(
      '¿Registrar el pago de 1160 MXN a BILL-2026-00007 (1160.00 → 0.00) desde Operativa BBVA en Entidad Sintetica SA? Esto contabiliza en el mayor.'
    );
    setLanguage('en');
    const tty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const s = await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160']);
      expect(s.error?.localized('en')).toBe(
        'Record 1160 MXN paid on BILL-2026-00007 (1160.00 → 0.00) in Entidad Sintetica SA? This posts to the ledger. — there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.'
      );
      expect(s.error?.localized('es')).toMatch(/ — no hay terminal donde preguntar\. Vuelve a correrlo con --yes/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('the two idempotency hits and the done line, by key', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(mirarLlave).mockResolvedValueOnce({ pago: RECORDED } as never);
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--idempotency-key', 'k1', '-y']);
    expect(err).toContain(
      '↩ Idempotency hit: the key "k1" already completed this act (VPMT-2026-00019). Nothing was written again; this is the recorded result.\n'
    );
    expect(out).toContain('✔ VPMT-2026-00019 · BILL-2026-00007 1160.00 → 0.00 (paid) · entry JE-2026-00101\n');
    err = '';
    vi.mocked(recordVendorPayment).mockResolvedValue(RECORDED as never);
    vi.mocked(conLlave).mockResolvedValueOnce({ repetido: true, resultado: { pago: RECORDED } } as never);
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--idempotency-key', 'k1', '-y']);
    expect(err).toContain(
      '↩ Idempotency hit: the key "k1" already spent this payment (VPMT-2026-00019). Nothing was written again; this is the recorded result.\n'
    );
    setLanguage('es');
    err = '';
    vi.mocked(mirarLlave).mockResolvedValueOnce({ pago: RECORDED } as never);
    await run(['payment', 'create', 'BILL-2026-00007', '--amount', '1160', '--idempotency-key', 'k1', '-y']);
    expect(err).toContain('↩ Idempotency hit: la llave "k1" ya consumó este acto (VPMT-2026-00019). Nada se escribió otra vez');
  });

  it('states what it writes in English', () => {
    const cli = program().cli;
    const payment = cli.commands.find((c) => c.name() === 'payment')!;
    const leaf = (n: string) => payment.commands.find((c) => c.name() === n)!;
    expect(riskOf(leaf('create'))?.writes).toBe(
      'vendor_payments (with check_number and the destination account), payment_applications, bills.amount_due, journal_entries'
    );
    expect(riskOf(leaf('apply'))?.llave).toEqual({ sinLlave: { key: 'ap.payment.apply.retry_reapplies' } });
  });
});

describe('I8.8 · payment apply speaks by key', () => {
  const APPLY = ['payment', 'apply', 'VPMT-2026-00019'];

  it('the flag errors, with a plural where the count is', async () => {
    const missing = await run([...APPLY]);
    expect(missing.error?.message).toBe(
      'Name the bill it applies to: --bill <ref> --amount <amount>. Repeat them to split it among several.'
    );
    expect(missing.error?.localized('es')).toBe(
      'Indica a qué gasto se aplica: --bill <ref> --amount <importe>. Repítelos para repartir entre varios.'
    );
    const one = await run([...APPLY, '--bill', 'B1', '--amount', '1', '--amount', '2']);
    expect(one.error?.message).toBe(
      'There is 1 --bill and 2 --amount: they pair up by position, so there must be as many of each.'
    );
    const two = await run([...APPLY, '--bill', 'B1', '--bill', 'B2', '--amount', '1']);
    expect(two.error?.message).toMatch(/^There are 2 --bill and 1 --amount:/);
    expect(two.error?.localized('es')).toBe(
      'Hay 2 --bill y 1 --amount: van emparejados por posición, así que tienen que ser tantos como aquéllos.'
    );
    const disc = await run([...APPLY, '--bill', 'B1', '--amount', '1', '--discount', '1', '--discount', '2']);
    expect(disc.error?.message).toBe('There are 2 --discount for 1 --bill: at least one is left over.');
    expect(disc.error?.localized('es')).toBe('Hay 2 --discount para 1 --bill: sobra alguno.');
    const mode = await run([...APPLY, '--bill', 'B1', '--amount', '1', '--mode', 'total']);
    expect(mode.error?.message).toBe('--mode takes "partial" or "residual"; got "total".');
    expect(mode.error?.localized('es')).toBe('--mode admite "partial" o "residual"; llegó "total".');
  });

  it('ap.payment.apply.not_applicable', async () => {
    vi.mocked(resolveBill).mockResolvedValueOnce({ ...BILL, status: 'draft' } as never);
    const s = await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1160']);
    expect(s.error?.message).toBe('Bill BILL-2026-00007 is "draft"; only approved, posted, partially_paid bills can be applied to.');
    expect(s.error?.localized('es')).toBe(
      'La factura BILL-2026-00007 está en "draft"; sólo se aplican pagos a facturas approved, posted, partially_paid.'
    );
  });

  it('the dry run: would, on account, and the four notes', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(applyVendorPayment).mockResolvedValue(APPLIED as never);
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1100', '--mode', 'residual', '--dry-run']);
    expect(out).toContain('Would apply VPMT-2026-00019 · on account 2000.00 → 320.00 · 2026-07-31\n');
    expect(err).toContain('  Discount taken outside the terms on BILL-2026-00011: it is a negotiated deduction, not an agreed early-payment discount.\n');
    expect(err).toContain('  60.00 stopped being owed (short payment) → 7010 Otros ingresos\n');
    expect(err).toContain(
      '  That account is the declared DEFAULT; nobody has decided it yet: `mnemosine pending --verbose` shows it and `mnemosine pending define pago_corto_residual` decides it.\n'
    );
    expect(err).toContain(
      '  8.28 of IVA left 1135 WITHOUT being credited: it was the tax on the part that was not paid, and under cash basis what is not paid is not credited.\n'
    );
    expect(err).toContain('Dry run: nothing was written.\n');
    setLanguage('es');
    out = '';
    err = '';
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1100', '--mode', 'residual', '--dry-run']);
    expect(out).toContain('Aplicaría VPMT-2026-00019 · a cuenta 2000.00 → 320.00 · 2026-07-31\n');
    expect(err).toContain('  Descuento tomado fuera de las condiciones en BILL-2026-00011: es una deducción negociada, no un pronto pago pactado.\n');
    expect(err).toContain('  60.00 dejó de deberse (pago corto) → 7010 Otros ingresos\n');
    expect(err).toContain('  Esa cuenta es el DEFECTO declarado, nadie la ha decidido todavía:');
    expect(err).toContain('  8.28 de IVA salió de la 1135 SIN acreditarse:');
  });

  it('ap.payment.apply.confirm: one document and two, with and without a write-off', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    const asked: string[] = [];
    const no = async (q: string) => { asked.push(q); return false; };
    vi.mocked(applyVendorPayment).mockResolvedValueOnce({ ...APPLIED, documentos: APPLIED.documentos.slice(0, 1), condonado: '0.00' } as never);
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1160'], no);
    vi.mocked(applyVendorPayment).mockResolvedValueOnce(APPLIED as never);
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1100', '--mode', 'residual'], no);
    expect(asked).toEqual([
      'Apply 1 document of VPMT-2026-00019 on 2026-07-31 in Entidad Sintetica SA? This posts to the ledger.',
      'Apply 2 documents of VPMT-2026-00019 on 2026-07-31 in Entidad Sintetica SA, WRITING OFF 60.00 that will stop being owed? This posts to the ledger.',
    ]);
    setLanguage('es');
    vi.mocked(applyVendorPayment).mockResolvedValueOnce(APPLIED as never);
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1100', '--mode', 'residual'], no);
    expect(asked[2]).toBe(
      '¿Aplicar 2 documentos de VPMT-2026-00019 el 2026-07-31 en Entidad Sintetica SA, CONDONANDO 60.00, que dejará de deberse? Esto contabiliza en el mayor.'
    );
  });

  // MNE-001-678 (#787): the application is dated, and its day is resolved once.
  it('--date reaches the preview and the write; without it both take the entity\'s today, read once', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(applyVendorPayment).mockResolvedValue({ ...APPLIED, date: '2026-05-10' } as never);
    const yes = async () => true;
    const dated = await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1160', '--date', '2026-05-10', '--json'], yes);
    expect(dated.error).toBeUndefined();
    expect(vi.mocked(applyVendorPayment).mock.calls.map((c) => c[4])).toEqual([
      { modo: 'partial', shortPayReason: undefined, date: '2026-05-10', dryRun: true },
      { modo: 'partial', shortPayReason: undefined, date: '2026-05-10' },
    ]);
    expect(todayFor).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { rows: Array<{ date: string }> }).rows[0].date).toBe('2026-05-10');

    vi.mocked(applyVendorPayment).mockClear();
    await run([...APPLY, '--bill', 'BILL-2026-00007', '--amount', '1160'], yes);
    expect(vi.mocked(applyVendorPayment).mock.calls.map((c) => (c[4] as { date?: string }).date)).toEqual(['2026-07-31', '2026-07-31']);
    expect(todayFor).toHaveBeenCalledTimes(1);
  });

  it('help.payment.apply.option.date, in en and es', async () => {
    const option = (cli: Command) =>
      cli.commands.find((c) => c.name() === 'payment')!.commands.find((c) => c.name() === 'apply')!
        .options.find((o) => o.long === '--date')!.description;
    expect(option(program().cli)).toBe(
      'day of the application (YYYY-MM-DD), which dates its entry, the application and the bill\'s last payment; defaults to today in the entity\'s time zone'
    );
    // Commander keeps the English source on the option; the help renderer reads the key in the reader's language.
    expect(t('help.payment.apply.option.date', {}, 'es')).toBe(
      'día de la aplicación (AAAA-MM-DD), que fecha su asiento, la aplicación y el último pago del gasto; por omisión, hoy en la zona horaria de la entidad'
    );
  });
});

const UNAPPLIED = {
  paymentNumber: 'VPMT-2026-00020',
  document: { numero: 'BILL-2026-00007', saldoAnterior: '0.00', saldoNuevo: '1160.00' },
  date: '2026-07-31',
  unapplied: '1160.00',
  discountReturned: '0.00',
  ivaReparked: '160.00',
  remainingOnAccount: '1160.00',
  journalEntry: { entry_number: 'JE-2026-00120' },
  attestation: { entityId: 'e1', entryId: 'je-120' },
};
const REVERSED = {
  paymentNumber: 'VPMT-2026-00020',
  date: '2026-07-31',
  reversals: [{ of: 'JE-2026-00101', entryNumber: 'JE-2026-00130' }],
  documents: [
    { numero: 'BILL-2026-00007', saldoAnterior: '0.00', saldoNuevo: '1160.00', estado: 'approved' },
    { numero: 'BILL-2026-00011', saldoAnterior: '0.00', saldoNuevo: '580.00', estado: 'approved' },
  ],
  attestations: [],
};

describe('I8.8 · payment unapply and reverse speak by key', () => {
  it('ap.payment.unapply: the dry run, the question, the idempotency hit', async () => {
    vi.mocked(resolveBill).mockResolvedValue(BILL as never);
    vi.mocked(unapplyVendorPayment).mockResolvedValue(UNAPPLIED as never);
    const UNAPPLY = ['payment', 'unapply', 'VPMT-2026-00020', '--bill', 'BILL-2026-00007', '--reason', 'Duplicate SPEI'];
    await run([...UNAPPLY, '--dry-run']);
    expect(out).toContain('Would unapply VPMT-2026-00020 from BILL-2026-00007 0.00 → 1160.00 · on account 1160.00\n');
    expect(err).toContain('Dry run: nothing was written.\n');
    const asked: string[] = [];
    await run(UNAPPLY, async (q) => { asked.push(q); return false; });
    expect(asked[0]).toBe(
      'Unapply 1160.00 of VPMT-2026-00019 from BILL-2026-00007 on 2026-07-31 (0.00 → 1160.00)? The cash goes back on account.'
    );
    // MNE-001-678: with no --date the leaf hands the service the entity's today, the same for the preview.
    expect(vi.mocked(unapplyVendorPayment).mock.calls.map((c) => c[2].date)).toEqual(['2026-07-31', '2026-07-31']);
    err = '';
    out = '';
    vi.mocked(mirarLlave).mockResolvedValueOnce({ result: UNAPPLIED } as never);
    await run([...UNAPPLY, '--idempotency-key', 'k2', '-y']);
    expect(err).toContain('↩ Idempotency hit: key "k2" already unapplied this; nothing was written again.\n');
    expect(out).toContain('✔ VPMT-2026-00020 unapplied from BILL-2026-00007 0.00 → 1160.00 · on account 1160.00 · entry JE-2026-00120\n');
    setLanguage('es');
    out = '';
    err = '';
    await run([...UNAPPLY, '--dry-run']);
    expect(out).toContain('Desaplicaría VPMT-2026-00020 de BILL-2026-00007 0.00 → 1160.00 · a cuenta 1160.00\n');
    vi.mocked(mirarLlave).mockResolvedValueOnce({ result: UNAPPLIED } as never);
    await run([...UNAPPLY, '--idempotency-key', 'k2', '-y']);
    expect(err).toContain('↩ Idempotency hit: la llave "k2" ya desaplicó esto; nada se escribió otra vez.\n');
    expect(out).toContain('✔ VPMT-2026-00020 desaplicado de BILL-2026-00007');
  });

  it('ap.payment.reverse: the question with two plurals, the dry run, the idempotency hit', async () => {
    vi.mocked(reverseVendorPayment).mockResolvedValue(REVERSED as never);
    const REVERSE = ['payment', 'reverse', 'VPMT-2026-00020', '--reason', 'Returned'];
    const asked: string[] = [];
    const no = async (q: string) => { asked.push(q); return false; };
    await run(REVERSE, no);
    expect(asked[0]).toBe('Reverse VPMT-2026-00019 on 2026-07-31? 1 ledger entry gets a mirror and 2 bills are owed again.');
    await run([...REVERSE, '--dry-run']);
    expect(out).toContain('Would reverse VPMT-2026-00020 on 2026-07-31 · JE-2026-00101\n');
    expect(err).toContain('Dry run: nothing was written.\n');
    err = '';
    out = '';
    vi.mocked(mirarLlave).mockResolvedValueOnce({ result: REVERSED } as never);
    await run([...REVERSE, '--idempotency-key', 'k3', '-y']);
    expect(err).toContain('↩ Idempotency hit: key "k3" already reversed this; nothing was written again.\n');
    expect(out).toContain('✔ VPMT-2026-00020 reversed on 2026-07-31 · JE-2026-00101→JE-2026-00130\n');
    setLanguage('es');
    vi.mocked(reverseVendorPayment).mockResolvedValueOnce({
      ...REVERSED, reversals: [...REVERSED.reversals, { of: 'JE-2026-00102', entryNumber: 'JE-2026-00131' }], documents: REVERSED.documents.slice(0, 1),
    } as never);
    await run(REVERSE, no);
    expect(asked[1]).toBe('¿Reversar VPMT-2026-00019 el 2026-07-31? 2 asientos del mayor reciben su espejo y 1 factura se vuelve a deber.');
    out = '';
    await run([...REVERSE, '--dry-run']);
    expect(out).toContain('Reversaría VPMT-2026-00020 el 2026-07-31 · JE-2026-00101\n');
  });
});
