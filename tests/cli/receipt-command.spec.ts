import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
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
    expect(() => parseWithholding(['isr:10'], ['INV-1', 'INV-2'])).toThrow(/<folio>:isr:10/);
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
