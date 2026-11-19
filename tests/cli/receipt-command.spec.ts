import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Corp MX', tenantId: 'ten-1',
    currency: 'MXN', country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'usr-1' })),
}));
vi.mock('../../src/services/ar/invoice-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/ar/invoice-service.js')>()),
  resolveInvoice: vi.fn(async (_e: string, ref: string) => ({ id: `id-${ref}`, invoice_number: ref })),
}));
vi.mock('../../src/services/ar/customer-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/ar/customer-service.js')>()),
  resolveCustomer: vi.fn(async () => ({ id: 'cus-1', company_name: 'Grupo Alameda SA de CV', currency_code: 'MXN' })),
}));
vi.mock('../../src/services/policy/today.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/policy/today.js')>()),
  todayFor: vi.fn(async () => '2026-12-31'),
}));
vi.mock('../../src/services/payments/payment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payments/payment-service.js')>()),
  recordCustomerPayment: vi.fn(async () => ({
    paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', journalEntry: null, attestation: null,
    documentos: [{
      id: 'id-INV-1', numero: 'INV-1', saldoAnterior: '100.00', saldoNuevo: '0.00', estado: 'paid', moneda: 'MXN',
    }],
    remanenteAnterior: '0.00', remanenteNuevo: '0.00',
  })),
  getCustomerPayment: vi.fn(async () => ({ id: 'pay-1', payment_number: 'PMT-2026-00042' })),
  reverseCustomerPayment: vi.fn(async () => ({
    paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', reversals: [{ entryNumber: 'JE-2', of: 'JE-1' }],
    attestations: [], documentosReabiertos: [], cause: 'taken_back', causeDefaulted: false, warnings: [],
  })),
  stateReversalCause: vi.fn(async () => ({
    paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', cause: 'taken_back',
    statedAt: new Date('2026-06-09T15:00:00Z'), reversedAt: new Date('2026-06-02T10:00:00Z'), warnings: [],
  })),
  applyCustomerPayment: vi.fn(async () => ({
    paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', journalEntry: null, attestation: null,
    documentos: [{
      id: 'id-INV-2026-00042', numero: 'INV-2026-00042', saldoAnterior: '11600.00', saldoNuevo: '0.00',
      estado: 'paid', moneda: 'MXN', withholdingIsr: '1000.00', withholdingIva: '1066.67',
    }],
    remanenteAnterior: '9533.33', remanenteNuevo: '0.00',
  })),
}));

import * as payments from '../../src/services/payments/payment-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import * as invoices from '../../src/services/ar/invoice-service.js';
import { todayFor } from '../../src/services/policy/today.js';
import { parseWithholding, registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { exitCodeFor } from '../../src/cli/kernel/index.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../src/cli/kernel/audit.js';
import { t } from '../../src/i18n/index.js';

// ============================================================
// MNE-001-113 (#309) · `receipt apply --withholding`: the spec a person
// types becomes the ISR and VAT the customer withheld, per invoice.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

describe('parseWithholding', () => {
  it('gives a bare spec to the only invoice, and adds up the two taxes', () => {
    const w = parseWithholding(['isr:1000', 'IVA:1066.67'], ['INV-2026-00042']);
    expect(w.get('INV-2026-00042')?.isr.toFixed(2)).toBe('1000.00');
    expect(w.get('INV-2026-00042')?.iva.toFixed(2)).toBe('1066.67');
  });

  it('names the invoice when there are several, and repeated specs add up', () => {
    const w = parseWithholding(
      ['INV-2:isr:600', 'INV-1:iva:100', 'INV-1:iva:0.50'],
      ['INV-1', 'INV-2']
    );
    expect(w.get('INV-1')?.iva.toFixed(2)).toBe('100.50');
    expect(w.get('INV-1')?.isr.toFixed(2)).toBe('0.00');
    expect(w.get('INV-2')?.isr.toFixed(2)).toBe('600.00');
  });

  it('is empty without the flag', () => {
    expect(parseWithholding(undefined, ['INV-1']).size).toBe(0);
  });

  it('refuses what it cannot read or place', () => {
    expect(() => parseWithholding(['ieps:10'], ['INV-1'])).toThrow(/isr:1000/);
    expect(() => parseWithholding(['isr:-5'], ['INV-1'])).toThrow(/isr:1000/);
    expect(() => parseWithholding(['isr:10'], ['INV-1', 'INV-2'])).toThrow(/INV-2026-00042:isr:10/);
    expect(() => parseWithholding(['INV-9:isr:10'], ['INV-1'])).toThrow(/INV-9/);
  });
});

describe('receipt apply', () => {
  it('declares --withholding and still passes the kernel audit', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, deps);
    const apply = program.commands[0].commands.find((c) => c.name() === 'apply')!;
    expect(apply.options.map((o) => o.long)).toContain('--withholding');
    const v = auditProgram(program);
    expect(v.filter((x) => !esDeudaDeLlave(x))).toEqual([]);
    for (const x of v.filter(esDeudaDeLlave)) expect(DEUDA_DE_LLAVES).toContain(x.command);
  });
});

/** Runs `receipt apply` with the services mocked, capturing what it prints. */
async function applyDryRun(extra: string[]): Promise<{ out: string; errs: unknown[] }> {
  resetDeclarations();
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerReceiptCommand(program, {
    ...deps,
    home: '/tmp/mnemosine-tests-no-home',
    reportError: (e: unknown) => { errs.push(e); },
  } as never);
  let out = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync([
      'node', 'mnemosine', 'receipt', 'apply', 'PMT-2026-00042', '--entity', 'ent-1',
      '--invoice', 'INV-2026-00042:9533.33', '--withholding', 'isr:1000', '--withholding', 'iva:1066.67',
      '--dry-run', ...extra,
    ]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, errs };
}

describe('receipt apply shows the withholding before it posts (MNE-001-113)', () => {
  it('passes the withholding to the service and prints it in the dry run', async () => {
    const { out, errs } = await applyDryRun([]);
    expect(errs).toEqual([]);
    expect(vi.mocked(payments.applyCustomerPayment).mock.calls[0][2]).toEqual([
      { documentId: 'id-INV-2026-00042', amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' },
    ]);
    expect(out).toContain('withheld ISR 1000.00 + VAT 1066.67');
  });

  it('carries it in the --json payload the agent reads', async () => {
    const { out, errs } = await applyDryRun(['--json']);
    expect(errs).toEqual([]);
    const { rows } = JSON.parse(out) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toMatchObject({ withholding_isr: '1000.00', withholding_iva: '1066.67', dry_run: true });
  });
});

describe('receipt apply and unapply take --date (MNE-001-460)', () => {
  it('declares --date on both leaves with keyed help, in English and in Spanish', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerReceiptCommand(program, deps);
    for (const leaf of ['apply', 'unapply'] as const) {
      const cmd = program.commands[0].commands.find((c) => c.name() === leaf)!;
      const option = cmd.options.find((o) => o.long === '--date')!;
      expect(option.description).toBe(t(`help.receipt.${leaf}.option.date`));
      expect(t(`help.receipt.${leaf}.option.date`, {}, 'es')).toMatch(/AAAA-MM-DD/);
    }
  });

  it('passes the stated day to the preview and prints it', async () => {
    vi.mocked(payments.applyCustomerPayment).mockClear();
    vi.mocked(payments.applyCustomerPayment).mockImplementationOnce(async () => ({
      paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', journalEntry: null, attestation: null,
      documentos: [], remanenteAnterior: '9533.33', remanenteNuevo: '0.00', date: '2026-05-20',
    }));
    const { out, errs } = await applyDryRun(['--date', '2026-05-20']);
    expect(errs).toEqual([]);
    expect(vi.mocked(payments.applyCustomerPayment).mock.calls[0][4]).toEqual({ dryRun: true, date: '2026-05-20' });
    expect(out).toContain('2026-05-20');
  });

  it("with no --date the preview gets the entity's day, not the process clock", async () => {
    vi.mocked(payments.applyCustomerPayment).mockClear();
    await applyDryRun([]);
    expect(vi.mocked(payments.applyCustomerPayment).mock.calls[0][4]).toEqual({ dryRun: true, date: '2026-12-31' });
  });
});

describe('receipt record without --date (MNE-001-290)', () => {
  it("dates the collection with the entity's day, not the process clock", async () => {
    resetDeclarations();
    vi.mocked(invoices.resolveInvoice).mockResolvedValueOnce({
      id: 'id-INV-1', invoice_number: 'INV-1', status: 'sent', amount_due: '100.00', customer_id: 'c1',
    } as never);
    const program = new Command('mnemosine').exitOverride();
    registerReceiptCommand(program, { ...deps, home: '/tmp/mnemosine-tests-no-home' } as never);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await program.parseAsync([
        'node', 'mnemosine', 'receipt', 'record', 'INV-1', '--entity', 'ent-1', '--amount', '100.00', '--dry-run',
      ]);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(todayFor).toHaveBeenCalledWith({ tenantId: 'ten-1', entityId: 'ent-1' });
    expect(vi.mocked(payments.recordCustomerPayment).mock.calls[0][0].paymentDate).toBe('2026-12-31');
  });
});

// ============================================================
// MNE-001-421 (#623, part 2/8) · `receipt record` with no invoice: what the
// accountant types becomes the advance the service records, and what cannot
// be an advance is refused before the service is called.
// ============================================================

/** Runs `receipt record` with the services mocked; returns what it reported and what reached the service. */
async function record(args: string[]) {
  resetDeclarations();
  const service = vi.mocked(payments.recordCustomerPayment);
  service.mockClear();
  const errs: Error[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerReceiptCommand(program, {
    ...deps, home: '/tmp/mnemosine-tests-no-home', reportError: (e: unknown) => { errs.push(e as Error); },
  } as never);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'mnemosine', 'receipt', 'record', '--entity', 'ent-1', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { errs, calls: service.mock.calls };
}

describe('receipt record with no invoice (MNE-001-421)', () => {
  const advance = ['--customer', 'Grupo Alameda', '--amount', '1160.00'];

  it('passes the resolved customer, no application and the treatment to the service', async () => {
    const { errs, calls } = await record([...advance, '--tax-rate', '16', '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      counterpartyId: 'cus-1', paymentAmount: '1160.00', applications: [], onAccount: true, advanceTreatment: '16',
    });
    expect(calls[0][2]).toEqual({ dryRun: true });
  });

  it.each([
    ['exempt', 'exempt'], ['exento', 'exempt'], ['not-subject', 'not-subject'], ['no-objeto', 'not-subject'], ['8', '8'], ['0', '0'],
  ])('reads --tax-rate %s as the treatment %s', async (typed, treatment) => {
    const { errs, calls } = await record([...advance, '--tax-rate', typed, '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls[0][0].advanceTreatment).toBe(treatment);
  });

  it.each([
    ['no rate on an entity that keeps Mexican books', advance, /--tax-rate/],
    ['a rate outside the list', [...advance, '--tax-rate', '17'], /"17".*16, 8, 0, exempt/],
    ['a rate written as a factor', [...advance, '--tax-rate', '1.6'], /"1\.6"/],
    ['a rate that is not one', [...advance, '--tax-rate', 'abc'], /"abc"/],
    ['neither an invoice nor --customer', ['--amount', '1160.00', '--tax-rate', '16'], /--customer/],
    ['--tax-rate with an invoice', ['INV-1', '--amount', '100.00', '--tax-rate', '16'], /only for an advance with no invoice/],
  ])('refuses %s before the service is called', async (_case, args, message) => {
    const { errs, calls } = await record([...args, '--yes']);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(message);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(calls).toEqual([]);
  });

  it('asks no rate of an entity that does not keep Mexican books: the cash goes on account as before', async () => {
    vi.mocked(resolveEntity).mockResolvedValueOnce({
      entityId: 'ent-1', entityName: 'Demo Corp US', tenantId: 'ten-1',
      currency: 'USD', country: 'US', accountingStandard: 'us_gaap', taxId: 'X',
    });
    const { errs, calls } = await record([...advance, '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls[0][0]).toMatchObject({ counterpartyId: 'cus-1', applications: [], onAccount: true });
    expect(calls[0][0].advanceTreatment).toBeUndefined();
  });

  it('with an invoice and --customer, the resolved customer is what reaches the service', async () => {
    vi.mocked(invoices.resolveInvoice).mockResolvedValueOnce({
      id: 'id-INV-1', invoice_number: 'INV-1', status: 'sent', amount_due: '100.00', customer_id: 'c-of-the-invoice',
    } as never);
    const { errs, calls } = await record(['INV-1', '--customer', 'Grupo Alameda', '--amount', '100.00', '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls[0][0]).toMatchObject({
      counterpartyId: 'cus-1', applications: [{ documentId: 'id-INV-1', amountApplied: '100.00' }], onAccount: false,
    });
    expect(calls[0][0].advanceTreatment).toBeUndefined();
  });

  it('with no --yes and no terminal it is refused after the rehearsal, and nothing is recorded', async () => {
    const tty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const { errs, calls } = await record([...advance, '--tax-rate', '16']);
      expect(errs[0].message).toMatch(/no terminal to ask on.*--yes/);
      expect(exitCodeFor(errs[0])).toBe(10);
      // The only call is the dry run that feeds the confirmation.
      expect(calls.map((c) => c[2])).toEqual([{ dryRun: true }]);
    } finally {
      process.stdin.isTTY = tty;
    }
  });
});

// ============================================================
// MNE-001-509 (#701) · `receipt reverse --cause`: the terminal passes the
// cause to the service and repeats what the service answered: the cause the
// receipt keeps, whether it was a cheque's default, and the warnings.
// ============================================================

/** Runs a `receipt` leaf with the services mocked; returns what it printed, what it reported and the reversal calls. */
async function receipt(args: string[]) {
  resetDeclarations();
  const service = vi.mocked(payments.reverseCustomerPayment);
  service.mockClear();
  vi.mocked(payments.getCustomerPayment).mockClear();
  const errs: Error[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerReceiptCommand(program, {
    ...deps, home: '/tmp/mnemosine-tests-no-home', reportError: (e: unknown) => { errs.push(e as Error); },
  } as never);
  let out = '';
  const write = (chunk: unknown) => { out += String(chunk); return true; };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(write);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(write);
  try {
    await program.parseAsync(['node', 'mnemosine', 'receipt', ...args, '--entity', 'ent-1']);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, errs, calls: service.mock.calls };
}

describe('receipt reverse --cause (MNE-001-509)', () => {
  const reversal = {
    paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', reversals: [{ entryNumber: 'JE-2', of: 'JE-1' }],
    attestations: [], documentosReabiertos: [],
  };
  const reverse = ['reverse', 'PMT-2026-00042', '--reason', 'chargeback 4853'];

  it('T11 · refuses a cause that is neither of the two before anything is read', async () => {
    const { errs, calls } = await receipt([...reverse, '--cause', 'bounced', '--yes']);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/"bounced".*not_collected.*taken_back/);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(calls).toEqual([]);
    expect(payments.getCustomerPayment).not.toHaveBeenCalled();
  });

  it('passes the cause to the service, and the dry run says it', async () => {
    const { out, errs, calls } = await receipt([...reverse, '--cause', 'taken_back', '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls.map((c) => [c[2], c[4]])).toEqual([[{ reason: 'chargeback 4853', cause: 'taken_back', feeAmount: undefined }, { dryRun: true }]]);
    expect(out).toContain(t('receipt.reverse.cause.stated', { cause: 'taken_back' }, 'en'));
    expect(out).not.toContain('NSF');
  });

  it('with no --cause it says what the service decided: a cheque by default, or none with its warning', async () => {
    vi.mocked(payments.reverseCustomerPayment).mockResolvedValueOnce(
      { ...reversal, cause: 'not_collected', causeDefaulted: true, warnings: [] });
    const byCheck = await receipt([...reverse, '--dry-run']);
    expect(byCheck.calls[0][2].cause).toBeUndefined();
    expect(byCheck.out).toContain(t('receipt.reverse.cause.defaulted', {}, 'en'));

    vi.mocked(payments.reverseCustomerPayment).mockResolvedValueOnce(
      { ...reversal, cause: null, causeDefaulted: false, warnings: ['receipt.reverse.warning.cause_not_stated'] });
    const byTransfer = await receipt([...reverse, '--dry-run']);
    expect(byTransfer.out).toContain(t('receipt.reverse.cause.none', {}, 'en'));
    expect(byTransfer.out).toContain(t('receipt.reverse.warning.cause_not_stated', {}, 'en'));
  });

  it('--json carries the cause, whether it was the default, and the warnings', async () => {
    vi.mocked(payments.reverseCustomerPayment).mockResolvedValue(
      { ...reversal, cause: 'not_collected', causeDefaulted: false, warnings: ['receipt.reverse.warning.card_not_collected'] });
    const { out, errs, calls } = await receipt([...reverse, '--cause', 'not_collected', '--yes', '--json']);
    vi.mocked(payments.reverseCustomerPayment).mockReset();
    expect(errs).toEqual([]);
    expect(calls.map((c) => c[4])).toEqual([{ dryRun: true }, undefined]);
    const { rows } = JSON.parse(out.slice(out.indexOf('{'))) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toMatchObject({
      status: 'reversed', cause: 'not_collected', cause_defaulted: false,
      warnings: t('receipt.reverse.warning.card_not_collected', {}, 'en'),
    });
  });

  it('receipt show carries the cause of a reversed receipt', async () => {
    vi.mocked(payments.getCustomerPayment).mockResolvedValueOnce({
      id: 'pay-1', payment_number: 'PMT-2026-00042', status: 'reversed', payment_amount: '1160.00', currency_code: 'MXN',
      payment_date: new Date('2026-05-20'), payment_method: 'credit_card', unapplied_amount: '0.00', aplicaciones: [],
      reversed_at: new Date('2026-06-02T10:00:00Z'), reversal_cause: 'taken_back',
    } as never);
    const { out, errs } = await receipt(['show', 'PMT-2026-00042', '--json']);
    expect(errs).toEqual([]);
    const { rows } = JSON.parse(out) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toMatchObject({ status: 'reversed', reversal_cause: 'taken_back' });
  });

  it('receipt show, with no format asked for, prints the detail: the cause of a reversal and the advance CFDI where the REP was', async () => {
    const row = {
      id: 'pay-1', payment_number: 'PMT-2026-00042', status: 'reversed', payment_amount: '1160.00', currency_code: 'MXN',
      payment_date: new Date('2026-05-20'), payment_method: 'bank_transfer', unapplied_amount: '1160.00', aplicaciones: [],
      customer_name: 'Grupo Alameda', cfdi_uuid: null, advance_base: '1000.00', advance_tax_rate: '16', advance_iva: '160.00',
      reversed_at: new Date('2026-06-02T10:00:00Z'), reversal_cause: null,
    };
    vi.mocked(payments.getCustomerPayment).mockResolvedValueOnce(row as never);
    const all = await receipt(['show', 'PMT-2026-00042']);
    expect(all.errs).toEqual([]);
    expect(all.out).toMatch(/Reversal cause\s+not stated/);
    expect(all.out).toContain(t('receipt.advance.cfdi_owed', {}, 'en'));
    expect(all.out).not.toContain('sin REP');

    // Part advance, part not: the REP is still owed.
    vi.mocked(payments.getCustomerPayment).mockResolvedValueOnce({ ...row, payment_amount: '2000.00', reversal_cause: 'taken_back' } as never);
    const part = await receipt(['show', 'PMT-2026-00042']);
    expect(part.out).toMatch(/Reversal cause\s+taken_back/);
    expect(part.out).toContain('sin REP');
    expect(part.out).not.toContain('Cause stated');

    // MNE-001-511: the instant the cause was stated, which is later than the reversal when it was stated afterwards.
    vi.mocked(payments.getCustomerPayment).mockResolvedValueOnce(
      { ...row, reversal_cause: 'taken_back', reversal_cause_stated_at: new Date('2026-06-09T15:00:00Z') } as never);
    const later = await receipt(['show', 'PMT-2026-00042']);
    expect(later.out).toMatch(/Cause stated\s+2026-06-09T15:00:00.000Z/);
  });
});

// ============================================================
// MNE-001-511 (#701) · `receipt cause record`: the cause of a receipt
// reversed with none, stated afterwards. The terminal refuses what it can
// before reading, and repeats what the service answered.
// ============================================================

describe('receipt cause record (MNE-001-511)', () => {
  const state = vi.mocked(payments.stateReversalCause);
  const record = ['cause', 'record', 'PMT-2026-00042'];
  const run = async (args: string[]) => {
    state.mockClear();
    return { ...(await receipt([...record, ...args])), calls: state.mock.calls };
  };

  it('C1 · refuses a cause that is neither of the two before anything is read', async () => {
    const { errs, calls } = await run(['--cause', 'bounced', '--reason', 'typo', '--yes']);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/"bounced".*not_collected.*taken_back/);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(calls).toEqual([]);
    expect(payments.getCustomerPayment).not.toHaveBeenCalled();
  });

  it('C2 · with no --reason it is a usage error outside a dry run, and nothing is called', async () => {
    const { errs, calls } = await run(['--cause', 'taken_back', '--yes']);
    expect(errs).toHaveLength(1);
    expect(exitCodeFor(errs[0])).toBe(2);
    expect(errs[0].message).toContain('--reason');
    expect(calls).toEqual([]);
  });

  it('C3 · the dry run asks the service with dryRun, prints the cause and its warnings, and stops there', async () => {
    state.mockResolvedValueOnce({
      paymentId: 'pay-1', paymentNumber: 'PMT-2026-00042', cause: 'not_collected',
      statedAt: new Date('2026-06-09T15:00:00Z'), reversedAt: null, warnings: ['receipt.reverse.warning.card_not_collected'],
    });
    const { out, errs, calls } = await run(['--cause', 'not_collected', '--dry-run']);
    expect(errs).toEqual([]);
    expect(calls.map((c) => [c[1], c[2], c[4]])).toEqual([['pay-1', { cause: 'not_collected', reason: '' }, { dryRun: true }]]);
    expect(out).toContain(t('receipt.cause.would_state', { number: 'PMT-2026-00042', cause: 'not_collected' }, 'en'));
    expect(out).toContain(t('receipt.reverse.warning.card_not_collected', {}, 'en'));
  });

  it('C4 · --json carries the cause, the instant it was stated and the warnings', async () => {
    const { out, errs, calls } = await run(['--cause', 'taken_back', '--reason', 'disputed on June 9', '--yes', '--json']);
    expect(errs).toEqual([]);
    expect(calls.map((c) => c[4])).toEqual([{ dryRun: true }, undefined]);
    expect(calls[1][2]).toEqual({ cause: 'taken_back', reason: 'disputed on June 9' });
    const { rows } = JSON.parse(out) as { rows: Record<string, unknown>[] };
    expect(rows[0]).toEqual({
      payment_number: 'PMT-2026-00042', cause: 'taken_back', stated_at: '2026-06-09T15:00:00.000Z', warnings: '',
    });
  });
});
