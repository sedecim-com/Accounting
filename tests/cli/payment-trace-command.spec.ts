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
vi.mock('../../src/database/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/database/connection.js')>()),
  query: vi.fn(async () => ({
    rows: [{ id: 'vp-1', payment_number: 'VPMT-2026-00001', payment_amount: '1160.0000', currency_code: 'MXN' }],
  })),
}));
vi.mock('../../src/services/payments/payment-trace-service.js', () => ({
  completePaymentTrace: vi.fn(),
}));

import { completePaymentTrace, type TraceCompletion } from '../../src/services/payments/payment-trace-service.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../src/cli/kernel/audit.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { t } from '../../src/i18n/index.js';

// ============================================================
// MNE-001-568 (#612, part 1/4) · `payment trace record`: the leaf that
// completes the vendor side of a registered payment's trace. The service is
// mocked; this pins the declaration, the refusals the terminal makes before
// reading anything, and what it repeats of the service's answer.
// ============================================================

const palette = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};
const deps = { palette, shutdown: () => undefined, reportError: () => undefined };

const service = vi.mocked(completePaymentTrace);

const completion = (over: Partial<TraceCompletion> = {}): TraceCompletion => ({
  paymentId: 'vp-1',
  paymentNumber: 'VPMT-2026-00001',
  status: 'completed',
  filled: [
    { column: 'cuenta_destino', flag: '--to-account', shown: '…4455' },
    { column: 'banco_destino_sat', flag: '--to-bank', shown: '002' },
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
  registerPaymentCommands(p, deps);
  return p;
}

const leaf = (p: Command): Command =>
  p.commands.find((c) => c.name() === 'payment')!
    .commands.find((c) => c.name() === 'trace')!
    .commands.find((c) => c.name() === 'record')!;

async function trace(args: string[]): Promise<{ out: string; err: string; errs: Error[] }> {
  const errs: Error[] = [];
  const p = new Command('mnemosine').exitOverride();
  resetDeclarations();
  registerPaymentCommands(p, {
    ...deps, home: '/tmp/mnemosine-tests-no-home', reportError: (e: unknown) => { errs.push(e as Error); },
  } as never);
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out += String(chunk); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err += String(chunk); return true; });
  try {
    await p.parseAsync(['node', 'mnemosine', 'payment', 'trace', 'record', 'VPMT-2026-00001', '--entity', 'ent-1', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err, errs };
}

const FLAGS = [
  ['--check-number', 'check_number'],
  ['--to-account', 'to_account'],
  ['--to-bank', 'to_bank'],
  ['--to-foreign-bank', 'to_foreign_bank'],
] as const;

beforeEach(() => {
  service.mockReset();
});

describe('payment trace record is declared (MNE-001-568)', () => {
  it('takes the four trace flags and --reason, with keyed help in English and in Spanish', () => {
    const cmd = leaf(program());
    for (const [flag, key] of FLAGS) {
      const option = cmd.options.find((o) => o.long === flag);
      expect(option, flag).toBeDefined();
      expect(helpKeyOf(option!)).toBe(`help.payment.trace.record.option.${key}`);
      expect(t(`help.payment.trace.record.option.${key}`, {}, 'es')).not.toBe(t(`help.payment.trace.record.option.${key}`, {}, 'en'));
    }
    expect(helpKeyOf(cmd.options.find((o) => o.long === '--reason')!)).toBe('cli.flag.reason');
    expect(helpKeyOf(cmd)).toBe('help.payment.trace.record.description');
    expect(t('help.payment.trace.record.description', {}, 'es')).not.toBe(t('help.payment.trace.record.description', {}, 'en'));
  });

  it('its Spanish path is `pago rastro registrar`', () => {
    const p = program();
    const payment = p.commands.find((c) => c.name() === 'payment')!;
    const trace = payment.commands.find((c) => c.name() === 'trace')!;
    expect([payment.alias(), trace.alias(), leaf(p).alias()]).toEqual(['pago', 'rastro', 'registrar']);
  });

  it('is irreversible and closed to the agent, and passes the kernel audit', () => {
    const p = program();
    expect(riskOf(leaf(p))).toMatchObject({ risk: 'irreversible', agentAllowed: false });
    const v = auditProgram(p);
    expect(v.filter((x) => !esDeudaDeLlave(x))).toEqual([]);
    for (const x of v.filter(esDeudaDeLlave)) expect(DEUDA_DE_LLAVES).toContain(x.command);
  });
});

describe('payment trace record refuses before reading, and repeats what the service answered', () => {
  it('with no trace flag it is a usage error (exit 2), and nothing is called', async () => {
    const { errs } = await trace(['--reason', 'Comprobante SPEI OP-0511', '--yes']);
    expect(errs).toHaveLength(1);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--to-account');
    expect(service).not.toHaveBeenCalled();
  });

  it('with no --reason outside a dry run it is a usage error (exit 2), and nothing is called', async () => {
    const { errs } = await trace(['--to-account', '002180001122334455', '--yes']);
    expect(errs).toHaveLength(1);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--reason');
    expect(service).not.toHaveBeenCalled();
  });

  it('the dry run asks the service with dryRun, says what it would fill and the period state, and stops', async () => {
    service.mockResolvedValueOnce(completion({ period: '2026-09', periodStatus: 'hard_close', archivedVoucherFiles: 1 }));
    const { out, err, errs } = await trace(['--to-account', '002180001122334455', '--to-bank', '002', '--dry-run']);
    expect(errs).toEqual([]);
    expect(service.mock.calls.map((c) => [c[1], c[2], c[3], c[6]])).toEqual([[
      'vendor', 'vp-1',
      { checkNumber: undefined, toAccount: '002180001122334455', toBank: '002', toForeignBank: undefined },
      { dryRun: true },
    ]]);
    expect(out).toContain(t('payment.trace.would_complete', { number: 'VPMT-2026-00001', fields: '--to-account …4455, --to-bank 002' }, 'en'));
    expect(err).toContain(t('payment.trace.period_not_open', { period: '2026-09', status: 'hard_close' }, 'en'));
    expect(err).toContain(t('payment.trace.archived_files', { count: 1, period: '2026-09' }, 'en'));
    expect(out).not.toContain('002180001122334455');
  });

  it('confirmed, it writes once after the preview and --json carries what was filled', async () => {
    service.mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion());
    const { out, err, errs } = await trace([
      '--to-account', '002180001122334455', '--to-bank', '002', '--reason', 'Comprobante SPEI OP-0511', '--yes', '--json',
    ]);
    expect(errs).toEqual([]);
    expect(service.mock.calls.map((c) => [c[4], c[6]])).toEqual([
      ['Comprobante SPEI OP-0511', { dryRun: true }],
      ['Comprobante SPEI OP-0511', undefined],
    ]);
    const { rows } = JSON.parse(out) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toEqual({
      payment_number: 'VPMT-2026-00001', status: 'completed',
      filled: { cuenta_destino: '…4455', banco_destino_sat: '002' }, unchanged: {},
      journal_entry: 'JE-2026-0042', period: '2026-11', period_status: 'open', archived_voucher_files: 0, dry_run: false,
    });
    // An open month needs no line about it.
    expect(err).not.toContain('2026-11');
  });

  it('a field that already holds the value is reported unchanged, and nothing is written', async () => {
    service.mockResolvedValueOnce(completion({
      filled: [], unchanged: [{ column: 'check_number', flag: '--check-number', shown: '000123' }],
    }));
    const { out, errs } = await trace(['--check-number', '000123', '--reason', 'Talón del cheque']);
    expect(errs).toEqual([]);
    expect(service).toHaveBeenCalledTimes(1);
    expect(out).toContain(t('payment.trace.unchanged', { number: 'VPMT-2026-00001', fields: '--check-number 000123' }, 'en'));
  });
});
