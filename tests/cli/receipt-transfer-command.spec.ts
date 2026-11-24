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
vi.mock('../../src/services/ar/customer-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/ar/customer-service.js')>()),
  resolveCustomer: vi.fn(async () => ({ id: 'cus-b', customer_number: 'C-B', company_name: 'Cliente Cesionario SA' })),
}));
vi.mock('../../src/services/policy/today.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/policy/today.js')>()),
  todayFor: vi.fn(async () => '2026-06-20'),
}));
vi.mock('../../src/services/accounting/posting.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/accounting/posting.js')>()),
  attestEntryAsync: vi.fn(),
}));
vi.mock('../../src/services/payments/payment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payments/payment-service.js')>()),
  getCustomerPayment: vi.fn(async () => ({ id: 'cp-a', payment_number: 'PMT-2026-00001' })),
  transferCustomerCredit: vi.fn(),
}));

import { transferCustomerCredit, type CustomerCreditTransfer } from '../../src/services/payments/payment-service.js';
import { registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../src/cli/kernel/audit.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { t } from '../../src/i18n/index.js';

// ============================================================
// MNE-001-498 (#695, part 1/2) · `receipt transfer record`: the leaf that
// moves a customer's cash on account to another customer. The service is
// mocked; this pins the declaration, what the terminal refuses before
// reading anything, what it hands the service, and that --json keeps its
// keys in English.
// ============================================================

const palette = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};
const deps = { palette, shutdown: () => undefined, reportError: () => undefined };

const service = vi.mocked(transferCustomerCredit);

const result = (over: Partial<CustomerCreditTransfer> = {}): CustomerCreditTransfer => ({
  transferId: 'cp-trf', transferNumber: 'TRF-2026-00001',
  sourceId: 'cp-a', sourceNumber: 'PMT-2026-00001',
  fromCustomer: 'C-A Cliente Cedente SA', toCustomer: 'C-B Cliente Cesionario SA',
  amount: '1160.00', date: '2026-06-15',
  journalEntry: { id: 'je-1', entry_number: 'JE-2026-00007' } as CustomerCreditTransfer['journalEntry'],
  attestation: { entityId: 'ent-1', entryId: 'je-1' },
  lines: [
    { account: '2150', debit: '1160.00', credit: '0.00', description: "C-A Cliente Cedente SA's credit on PMT-2026-00001 assigned" },
    { account: '2150', debit: '0.00', credit: '1160.00', description: 'C-B Cliente Cesionario SA credit from PMT-2026-00001' },
  ],
  sourceOnAccount: { before: '1160.00', after: '0.00' },
  customerOnAccount: { before: '0.00', after: '1160.00' },
  advance: null,
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
    .commands.find((c) => c.name() === 'transfer')!
    .commands.find((c) => c.name() === 'record')!;

async function transfer(args: string[]): Promise<{ out: string; err: string; errs: Error[] }> {
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
    await p.parseAsync(['node', 'mnemosine', 'receipt', 'transfer', 'record', 'PMT-2026-00001', '--entity', 'ent-1', ...args]);
  } catch (e) {
    errs.push(e as Error);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err, errs };
}

const FLAGS = [
  ['--customer', 'customer'],
  ['--amount', 'amount'],
  ['--date', 'date'],
  ['--json', 'json'],
] as const;

const ARGS = ['--customer', 'C-B', '--amount', '1160.00', '--date', '2026-06-15'];

beforeEach(() => {
  service.mockReset();
});

describe('receipt transfer record is declared (MNE-001-498)', () => {
  it('takes --customer, --amount, --date, --reason and --json, with keyed help in English and in Spanish', () => {
    const cmd = leaf(program());
    for (const [flag, key] of FLAGS) {
      const option = cmd.options.find((o) => o.long === flag);
      expect(option, flag).toBeDefined();
      expect(helpKeyOf(option!)).toBe(`help.receipt.transfer.record.option.${key}`);
      if (key !== 'json') {
        expect(t(`help.receipt.transfer.record.option.${key}`, {}, 'es')).not.toBe(t(`help.receipt.transfer.record.option.${key}`, {}, 'en'));
      }
    }
    expect(cmd.options.find((o) => o.long === '--as-of')).toBeUndefined();
    expect(helpKeyOf(cmd.options.find((o) => o.long === '--reason')!)).toBe('cli.flag.reason');
    for (const flag of ['--dry-run', '--yes', '--idempotency-key']) expect(cmd.options.find((o) => o.long === flag), flag).toBeDefined();
    expect(helpKeyOf(cmd)).toBe('help.receipt.transfer.record.description');
  });

  it('its Spanish path is `cobro traspaso registrar`, it is irreversible, closed to the agent, and passes the audit', () => {
    const p = program();
    const receipt = p.commands.find((c) => c.name() === 'receipt')!;
    const noun = receipt.commands.find((c) => c.name() === 'transfer')!;
    expect([receipt.alias(), noun.alias(), leaf(p).alias()]).toEqual(['cobro', 'traspaso', 'registrar']);
    expect(riskOf(leaf(p))).toMatchObject({ risk: 'irreversible', agentAllowed: false });
    const v = auditProgram(p);
    expect(v.filter((x) => !esDeudaDeLlave(x))).toEqual([]);
    for (const x of v.filter(esDeudaDeLlave)) expect(DEUDA_DE_LLAVES).toContain(x.command);
    expect(DEUDA_DE_LLAVES).not.toContain('receipt transfer record');
  });
});

describe('receipt transfer record refuses before reading, and hands the transfer to the service', () => {
  it('with no --reason outside a dry run it is a usage error (exit 2), and nothing is called', async () => {
    const { errs } = await transfer([...ARGS, '--yes']);
    expect(errs).toHaveLength(1);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--reason');
    expect(service).not.toHaveBeenCalled();
  });

  it('without --customer or --amount it is refused by the parser, and nothing is called', async () => {
    for (const args of [['--amount', '1160.00'], ['--customer', 'C-B']]) {
      const { errs } = await transfer([...args, '--reason', 'Convenio', '--yes']);
      expect(errs.length).toBeGreaterThan(0);
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('the dry run asks the service once with dryRun, prints the entry and both balances, and writes nothing', async () => {
    service.mockResolvedValueOnce(result());
    const { out, err, errs } = await transfer([...ARGS, '--reason', 'Convenio 15-jun', '--dry-run']);
    expect(errs).toEqual([]);
    expect(service.mock.calls.map((c) => [c[0], c[1], c[2], c[3], c[4]])).toEqual([
      ['ent-1', 'cp-a', { customerId: 'cus-b', amount: '1160.00', date: '2026-06-15', reason: 'Convenio 15-jun' }, 'usr-1', { dryRun: true }],
    ]);
    expect(out).toContain(t('receipt.transfer.would_transfer', {
      amount: '1160.00', source: 'PMT-2026-00001', from: 'C-A Cliente Cedente SA', to: 'C-B Cliente Cesionario SA', date: '2026-06-15',
    }, 'en'));
    expect(out).toMatch(/2150\s+1160\.00\s+0\.00/);
    expect(out).toMatch(/2150\s+0\.00\s+1160\.00/);
    expect(out).toContain(t('receipt.transfer.on_account', { party: 'PMT-2026-00001', before: '1160.00', after: '0.00' }, 'en'));
    expect(out).toContain(t('receipt.transfer.on_account', { party: 'C-B Cliente Cesionario SA', before: '0.00', after: '1160.00' }, 'en'));
    expect(err).toContain('Dry run: nothing was written.');
    expect(out).not.toContain(t('receipt.transfer.carries', { base: '1000.00', iva: '160.00' }, 'en'));
  });

  it('of a treated advance it says the base and IVA the credit carries, and --json gives both (MNE-001-499)', async () => {
    const treated = result({ amount: '580.00', advance: { base: '500.00', iva: '80.00' } });
    service.mockResolvedValueOnce(treated);
    const { out } = await transfer([...ARGS, '--reason', 'Convenio 15-jun', '--dry-run']);
    expect(out).toContain(t('receipt.transfer.carries', { base: '500.00', iva: '80.00' }, 'en'));
    service.mockResolvedValueOnce(treated).mockResolvedValueOnce(treated);
    const json = await transfer([...ARGS, '--reason', 'Convenio 15-jun', '--yes', '--json']);
    expect((JSON.parse(json.out) as { rows: Record<string, unknown>[] }).rows[0]).toMatchObject({ advance_base: '500.00', advance_iva: '80.00' });
  });

  it('without --yes and with no terminal it aborts after the preview, and nothing is written', async () => {
    service.mockResolvedValueOnce(result());
    const { errs } = await transfer([...ARGS, '--reason', 'Convenio 15-jun']);
    expect(errs).toHaveLength(1);
    expect(service.mock.calls.map((c) => c[4])).toEqual([{ dryRun: true }]);
  });

  it('confirmed with --json, it previews, writes once, and keeps its keys in English', async () => {
    service.mockResolvedValueOnce(result()).mockResolvedValueOnce(result());
    const { out, errs } = await transfer([...ARGS, '--reason', 'Convenio 15-jun', '--yes', '--json']);
    expect(errs).toEqual([]);
    expect(service.mock.calls.map((c) => c[4])).toEqual([{ dryRun: true }, undefined]);
    const { rows } = JSON.parse(out) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toEqual({
      transfer_number: 'TRF-2026-00001', source: 'PMT-2026-00001',
      from_customer: 'C-A Cliente Cedente SA', to_customer: 'C-B Cliente Cesionario SA',
      amount: '1160.00', date: '2026-06-15', entry_number: 'JE-2026-00007',
      source_on_account_before: '1160.00', source_on_account_after: '0.00',
      customer_on_account_before: '0.00', customer_on_account_after: '1160.00',
      advance_base: null, advance_iva: null,
    });
  });
});

describe('receipt show of a reversed transfer (MNE-001-499, #937 B2)', () => {
  it('says it has no cause to state instead of «not stated»', async () => {
    const { getCustomerPayment } = await import('../../src/services/payments/payment-service.js');
    vi.mocked(getCustomerPayment).mockResolvedValueOnce({
      id: 'cp-trf', payment_number: 'TRF-2026-00001', customer_id: 'cus-b', customer_name: 'Cliente Cesionario SA',
      payment_amount: '1160.00', currency_code: 'MXN', payment_date: new Date('2026-06-15T12:00:00Z'),
      payment_method: 'balance_transfer', reference_number: null, status: 'reversed', journal_entry_number: 'JE-2026-00007',
      cfdi_uuid: null, cfdi_pago_indice: null, reversed_at: new Date('2026-06-20T12:00:00Z'),
      reversal_cause: null, reversal_cause_stated_at: null, unapplied_amount: '0.00',
      advance_base: null, advance_tax_rate: null, advance_iva: null, check_cashed_date: null, check_cashed_tx_id: null,
      aplicaciones: [],
    } as unknown as Awaited<ReturnType<typeof getCustomerPayment>>);
    const p = new Command('mnemosine').exitOverride();
    resetDeclarations();
    registerReceiptCommand(p, deps);
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out += String(chunk); return true; });
    try {
      await p.parseAsync(['node', 'mnemosine', 'receipt', 'show', 'TRF-2026-00001', '--entity', 'ent-1']);
    } finally {
      spy.mockRestore();
    }
    expect(out).toContain(t('receipt.cause.none_for_transfer', {}, 'en'));
    expect(out).not.toContain('not stated');
  });
});
