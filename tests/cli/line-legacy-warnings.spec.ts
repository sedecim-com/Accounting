import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerInvoiceCommand, LEGACY_INVOICE_TAX_KEY_WARNING } from '../../src/cli/invoice-command.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { LEGACY_COMMA_WARNING } from '../../src/cli/kernel/line-spec.js';

// #327 (MNE-001-100): what people already type keeps working, with ONE stderr
// warning per invocation. These drive the real commander with the services
// stubbed, so deleting the `process.stderr.write` of either warning, or
// moving it inside the per-line loop, turns a test red.

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));
vi.mock('../../src/services/accounting/account-service.js', () => ({
  resolveAccount: (_entity: string, code: string) =>
    Promise.resolve({ id: `A${code}`, code, name: `Cuenta ${code}`, account_type: 'revenue', is_active: true }),
}));
const createInvoice = vi.fn();
vi.mock('../../src/services/ar/invoice-service.js', async () => {
  const real = await vi.importActual<typeof import('../../src/services/ar/invoice-service.js')>(
    '../../src/services/ar/invoice-service.js'
  );
  return { ...real, createInvoice: (...a: unknown[]) => createInvoice(...a) as unknown };
});
vi.mock('../../src/services/ar/customer-service.js', async () => {
  const real = await vi.importActual<typeof import('../../src/services/ar/customer-service.js')>(
    '../../src/services/ar/customer-service.js'
  );
  return {
    ...real,
    resolveCustomer: () =>
      Promise.resolve({
        id: 'C1', customer_number: 'C-001', company_name: 'Grupo Alameda', is_active: true,
        payment_terms: 'Net 30', currency_code: 'MXN',
      }),
  };
});
const createBill = vi.fn();
vi.mock('../../src/services/ap/bill-service.js', async () => {
  const real = await vi.importActual<typeof import('../../src/services/ap/bill-service.js')>(
    '../../src/services/ap/bill-service.js'
  );
  return { ...real, createBill: (...a: unknown[]) => createBill(...a) as unknown };
});
vi.mock('../../src/services/ap/vendor-service.js', async () => {
  const real = await vi.importActual<typeof import('../../src/services/ap/vendor-service.js')>(
    '../../src/services/ap/vendor-service.js'
  );
  return {
    ...real,
    resolveVendor: () =>
      Promise.resolve({ id: 'V1', company_name: 'Papeleria del Centro', payment_terms: 'Net 30', currency_code: 'MXN' }),
  };
});

const id = (s: string) => s;
let exitCode: number | undefined;
let errs: unknown[] = [];
let stderr = '';

async function run(argv: string[]): Promise<void> {
  errs = [];
  exitCode = undefined;
  stderr = '';
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { stderr += c; return true; }) as typeof process.stderr.write;
  try {
    const program = new Command('mnemosine').exitOverride();
    const deps = {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id },
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
    } as never;
    registerInvoiceCommand(program, deps);
    registerBillCommand(program, deps);
    await program.parseAsync(['node', 'mnemosine', ...argv, '--entity', 'E1', '--json']);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
  createInvoice.mockReset().mockResolvedValue({
    invoice_number: 'INV-1', total_amount: '2320.00', currency_code: 'MXN', due_date: '2026-08-14',
  });
  createBill.mockReset().mockResolvedValue({ bill_number: 'B-1', total_amount: '2.00', currency_code: 'MXN' });
});

describe('invoice create: the legacy tax= key', () => {
  const INVOICE = ['invoice', 'create', '--customer', 'C-001', '--date', '2026-07-15', '--due-date', '2026-08-14'];

  it('is read as the rate, and warns exactly once for two legacy lines', async () => {
    await run([...INVOICE, '--line', 'account=4100;price=1000;tax=16', '--line', 'account=4200;price=1000;tax=16']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(occurrences(stderr, LEGACY_INVOICE_TAX_KEY_WARNING)).toBe(1);
    const lines = (createInvoice.mock.calls[0][0] as { lines: Array<{ tax_rate: string }> }).lines;
    expect(lines.map((l) => l.tax_rate)).toEqual(['16', '16']);
  });

  it('says nothing for the canonical tax-rate=', async () => {
    await run([...INVOICE, '--line', 'account=4100;price=1000;tax-rate=16', '--line', 'account=4200;price=1000;tax-rate=16']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(stderr).not.toContain('tax=');
  });
});

describe('bill create: the legacy comma separator', () => {
  const BILL = ['bill', 'create', 'V-001', '--bill-date', '2026-07-08', '--due-date', '2026-08-07'];

  it('is read, and warns exactly once for two comma lines', async () => {
    await run([...BILL, '--line', 'account=5100,price=1,tax-amount=0', '--line', 'account=5100,price=1,tax-amount=0']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(occurrences(stderr, LEGACY_COMMA_WARNING)).toBe(1);
    expect((createBill.mock.calls[0][0] as { lines: unknown[] }).lines).toHaveLength(2);
  });

  it('says nothing for the canonical ";"', async () => {
    await run([...BILL, '--line', 'account=5100;price=1;tax-amount=0', '--line', 'account=5100;price=1;tax-amount=0']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(stderr).not.toContain(LEGACY_COMMA_WARNING);
  });
});
