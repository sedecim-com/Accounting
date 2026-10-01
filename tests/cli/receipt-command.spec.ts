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
import * as invoices from '../../src/services/ar/invoice-service.js';
import { todayFor } from '../../src/services/policy/today.js';
import { parseWithholding, registerReceiptCommand } from '../../src/cli/receipt-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { auditProgram, DEUDA_DE_LLAVES, esDeudaDeLlave } from '../../src/cli/kernel/audit.js';

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
