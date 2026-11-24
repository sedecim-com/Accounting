import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Entidad de Prueba SA', tenantId: 'ten-1',
    currency: 'MXN', country: 'MX', accountingStandard: 'NIF', taxId: 'EPR010101AB1',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'usr-1' })),
}));
vi.mock('../../src/services/payments/payment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payments/payment-service.js')>()),
  getCustomerPayment: vi.fn(async () => ({ id: 'cp-1', payment_number: 'PMT-2026-00001' })),
}));
vi.mock('../../src/services/payments/payment-trace-service.js', () => ({
  completePaymentTrace: vi.fn(),
}));
// MNE-001-571 · what is still missing after writing is the generator's to say; here it is a spy.
vi.mock('../../src/cli/trace-completion-output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/trace-completion-output.js')>()),
  warnUntracedPayment: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/banking/bank-statement-service.js', () => ({
  resolverCuentaBancaria: vi.fn(async () => ({ id: 'ba-1', account_name: 'Operativa BBVA' })),
}));

import { completePaymentTrace, type TraceCompletion } from '../../src/services/payments/payment-trace-service.js';
import { warnUntracedPayment } from '../../src/cli/trace-completion-output.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../src/cli/kernel/audit.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { t } from '../../src/i18n/index.js';

// ============================================================
// MNE-001-570 (#612, part 3/4) · `receipt trace record`: the leaf that
// completes a registered receipt's trace, the payer's side and our bank
// account. The service is mocked; this pins the declaration, the refusals
// the terminal makes before reading anything, and what it hands the service.
// ============================================================

const palette = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};
const deps = { palette, shutdown: () => undefined, reportError: () => undefined };

const service = vi.mocked(completePaymentTrace);

const completion = (over: Partial<TraceCompletion> = {}): TraceCompletion => ({
  paymentId: 'cp-1',
  paymentNumber: 'PMT-2026-00001',
  status: 'completed',
  filled: [
    { column: 'bank_account_id', flag: '--bank', shown: 'Operativa BBVA' },
    { column: 'banco_origen_sat', flag: '--payer-bank', shown: '002' },
    { column: 'cuenta_origen', flag: '--payer-account', shown: '…3210' },
  ],
  unchanged: [],
  journalEntry: 'JE-2026-0042',
  period: '2026-11',
  periodStatus: 'open',
  archivedVoucherFiles: 0,
  ...over,
});

function program(): Command {
  resetDeclarations();
  const p = new Command('mnemosine').exitOverride();
  registerReceiptCommand(p, deps);
  return p;
}

const leaf = (p: Command): Command =>
  p.commands.find((c) => c.name() === 'receipt')!
    .commands.find((c) => c.name() === 'trace')!
    .commands.find((c) => c.name() === 'record')!;

async function trace(args: string[]): Promise<{ out: string; err: string; errs: Error[] }> {
  const errs: Error[] = [];
  const p = new Command('mnemosine').exitOverride();
  resetDeclarations();
  registerReceiptCommand(p, {
    ...deps, home: '/tmp/mnemosine-tests-no-home', reportError: (e: unknown) => { errs.push(e as Error); },
  });
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out += String(chunk); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err += String(chunk); return true; });
  try {
    await p.parseAsync(['node', 'mnemosine', 'receipt', 'trace', 'record', 'PMT-2026-00001', '--entity', 'ent-1', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err, errs };
}

const FLAGS = [
  ['--check-number', 'check_number'],
  ['--payer-bank', 'payer_bank'],
  ['--payer-account', 'payer_account'],
  ['--payer-foreign-bank', 'payer_foreign_bank'],
  ['--bank', 'bank'],
] as const;

beforeEach(() => {
  service.mockReset();
});

describe('receipt trace record is declared (MNE-001-570)', () => {
  it('takes the payer flags, --bank and --reason, with keyed help in English and in Spanish', () => {
    const cmd = leaf(program());
    for (const [flag, key] of FLAGS) {
      const option = cmd.options.find((o) => o.long === flag);
      expect(option, flag).toBeDefined();
      expect(helpKeyOf(option!)).toBe(`help.receipt.trace.record.option.${key}`);
      expect(t(`help.receipt.trace.record.option.${key}`, {}, 'es')).not.toBe(t(`help.receipt.trace.record.option.${key}`, {}, 'en'));
    }
    // The destination flags are the vendor side's: a receipt's destination is our bank account.
    expect(cmd.options.find((o) => o.long === '--to-account')).toBeUndefined();
    expect(helpKeyOf(cmd.options.find((o) => o.long === '--reason')!)).toBe('cli.flag.reason');
    expect(helpKeyOf(cmd)).toBe('help.receipt.trace.record.description');
  });

  it('its Spanish path is `cobro rastro registrar`, it is irreversible, closed to the agent, and passes the audit', () => {
    const p = program();
    const receipt = p.commands.find((c) => c.name() === 'receipt')!;
    const trace = receipt.commands.find((c) => c.name() === 'trace')!;
    expect([receipt.alias(), trace.alias(), leaf(p).alias()]).toEqual(['cobro', 'rastro', 'registrar']);
    expect(riskOf(leaf(p))).toMatchObject({ risk: 'irreversible', agentAllowed: false });
    const v = auditProgram(p);
    expect(v.filter((x) => !esDeudaDeLlave(x))).toEqual([]);
    for (const x of v.filter(esDeudaDeLlave)) expect(DEUDA_DE_LLAVES).toContain(x.command);
  });
});

describe('receipt trace record refuses before reading, and hands the receipt side to the service', () => {
  it('with no trace flag it is a usage error (exit 2) naming the receipt flags, and nothing is called', async () => {
    const { errs } = await trace(['--reason', 'CEP del cobro', '--yes']);
    expect(errs).toHaveLength(1);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--payer-bank');
    expect(errs[0].message).not.toContain('--to-account');
    expect(service).not.toHaveBeenCalled();
  });

  it('with no --reason outside a dry run it is a usage error (exit 2), and nothing is called', async () => {
    const { errs } = await trace(['--payer-bank', '002', '--yes']);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--reason');
    expect(service).not.toHaveBeenCalled();
  });

  it('confirmed, it previews, writes once on the customer side, and never echoes the account in clear', async () => {
    service.mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion());
    const { out, errs } = await trace([
      '--bank', 'Operativa BBVA', '--payer-bank', '002', '--payer-account', '002180009876543210',
      '--reason', 'CEP del cobro', '--yes',
    ]);
    expect(errs).toEqual([]);
    const fields = {
      checkNumber: undefined, payerBank: '002', payerAccount: '002180009876543210', payerForeignBank: undefined,
      bankAccountId: 'ba-1',
    };
    expect(service.mock.calls.map((c) => [c[1], c[2], c[3], c[4], c[6]])).toEqual([
      ['customer', 'cp-1', fields, 'CEP del cobro', { dryRun: true }],
      ['customer', 'cp-1', fields, 'CEP del cobro', undefined],
    ]);
    expect(out).toContain(t('payment.trace.completed', {
      number: 'PMT-2026-00001', fields: '--bank Operativa BBVA, --payer-bank 002, --payer-account …3210',
    }, 'en'));
    expect(out).not.toContain('002180009876543210');
  });
});

describe('receipt trace record says what is still missing once it wrote (MNE-001-571)', () => {
  it('asks the generator about the receipt after writing, on the customer side', async () => {
    const warn = vi.mocked(warnUntracedPayment);
    warn.mockClear();
    service.mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion());
    const { errs } = await trace(['--payer-bank', '002', '--reason', 'CEP del cobro', '--yes']);
    expect(errs).toEqual([]);
    expect(warn.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['customer', 'ent-1', 'cp-1']]);
  });
});
