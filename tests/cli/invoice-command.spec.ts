import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { parseInvoiceLine, dueDateFromTerms, registerInvoiceCommand } from '../../src/cli/invoice-command.js';
import { inferTaxIdType, registerCustomerCommand } from '../../src/cli/customer-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { auditProgram } from './kernel/consistency.spec.js';

// ============================================================
// The AR families against the kernel's own rules: the audit that
// keeps 1,700 commands coherent has to pass for these too, and the
// safety property — nothing that reaches the ledger is agent
// invocable — is asserted here rather than trusted.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

function build(): Command {
  resetDeclarations();
  const program = new Command('mnemosine');
  registerCustomerCommand(program, deps);
  registerInvoiceCommand(program, deps);
  return program;
}

function find(program: Command, path: string): Command {
  let node = program;
  for (const token of path.split(' ')) {
    const next: Command | undefined = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`no such command: ${path}`);
    node = next;
  }
  return node;
}

describe('the kernel audit', () => {
  it('accepts every command in both families', () => {
    expect(auditProgram(build())).toEqual([]);
  });
});

describe('the safety property', () => {
  it('never lets the agent reach the ledger', () => {
    const program = build();
    for (const path of ['invoice issue', 'invoice void']) {
      const risk = riskOf(find(program, path));
      expect(risk?.risk, path).toBe('irreversible');
      expect(risk?.agentAllowed, path).toBe(false);
    }
  });

  it('keeps every write away from the agent, drafts included', () => {
    const program = build();
    for (const path of ['customer create', 'customer edit', 'customer archive', 'customer restore', 'invoice create']) {
      expect(riskOf(find(program, path))?.agentAllowed, path).toBe(false);
    }
  });

  it('lets the agent read', () => {
    const program = build();
    for (const path of ['customer list', 'customer show', 'invoice list', 'invoice show', 'invoice series list']) {
      const risk = riskOf(find(program, path));
      expect(risk?.risk, path).toBe('lectura');
      expect(risk?.agentAllowed, path).toBe(true);
    }
  });

  it('gives the ledger commands their safety flags', () => {
    const program = build();
    const longs = (path: string) => find(program, path).options.map((o) => o.long);
    expect(longs('invoice issue')).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
    expect(longs('invoice void')).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--reason']));
  });
});

describe('every command is bilingual', () => {
  it('carries the Spanish alias the catalog names', () => {
    const program = build();
    const aliasOf = (path: string) => find(program, path).aliases()[0];
    expect(aliasOf('customer')).toBe('cliente');
    expect(aliasOf('customer list')).toBe('listar');
    expect(aliasOf('customer show')).toBe('ver');
    expect(aliasOf('customer create')).toBe('crear');
    expect(aliasOf('customer edit')).toBe('editar');
    expect(aliasOf('customer archive')).toBe('archivar');
    expect(aliasOf('customer restore')).toBe('restaurar');
    expect(aliasOf('invoice')).toBe('factura');
    expect(aliasOf('invoice list')).toBe('listar');
    expect(aliasOf('invoice show')).toBe('ver');
    expect(aliasOf('invoice create')).toBe('crear');
    expect(aliasOf('invoice issue')).toBe('emitir');
    expect(aliasOf('invoice void')).toBe('anular');
    expect(aliasOf('invoice series')).toBe('serie');
    expect(aliasOf('invoice series list')).toBe('listar');
  });
});

describe('parseInvoiceLine', () => {
  it('reads key=value pairs separated by semicolons', () => {
    expect(parseInvoiceLine('account=4100;qty=2;price=1500;tax=16')).toEqual({
      account: '4100', qty: '2', price: '1500', tax: '16',
    });
  });

  it('lets a description keep its commas', () => {
    const line = parseInvoiceLine('account=4100;price=10;description=Consultoria, agosto');
    expect(line.description).toBe('Consultoria, agosto');
  });

  it('insists on an account and a price', () => {
    expect(() => parseInvoiceLine('price=10')).toThrow(/account/);
    expect(() => parseInvoiceLine('account=4100')).toThrow(/price/);
  });

  it('refuses a spec it cannot read instead of guessing', () => {
    expect(() => parseInvoiceLine('4100 1500')).toThrow(/key=value/);
  });
});

describe('dueDateFromTerms', () => {
  it('reads the Net-N form, in both languages', () => {
    expect(dueDateFromTerms('Net 30', '2026-08-01')).toBe('2026-08-31');
    expect(dueDateFromTerms('neto 15', '2026-06-01')).toBe('2026-06-16');
    expect(dueDateFromTerms('NET-45', '2026-01-01')).toBe('2026-02-15');
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(dueDateFromTerms('Net 30', '2026-12-15')).toBe('2027-01-14');
  });

  it('returns nothing rather than inventing a date it cannot derive', () => {
    expect(dueDateFromTerms('2/10 Net 30', '2026-08-01')).toBeNull();
    expect(dueDateFromTerms('Contra entrega', '2026-08-01')).toBeNull();
    expect(dueDateFromTerms(null, '2026-08-01')).toBeNull();
  });
});

describe('inferTaxIdType', () => {
  it('knows what each country issues, and admits when it does not', () => {
    expect(inferTaxIdType('MX')).toBe('rfc');
    expect(inferTaxIdType('us')).toBe('ein');
    expect(inferTaxIdType('DE')).toBeUndefined();
    expect(inferTaxIdType(undefined)).toBeUndefined();
  });
});
