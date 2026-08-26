import { describe, it, expect, beforeAll } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from './kernel/consistency.spec.js';
import { registerVendorCommand } from '../../src/cli/vendor-command.js';
import { registerBillCommand, parseLineSpec } from '../../src/cli/bill-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';

// ============================================================
// The AP families against the rulebook, before the integrator
// wires them into mnemosine.ts. Building the program is enough:
// declareRisk throws at REGISTRATION time, and auditProgram walks
// the tree the same way the shipped CLI is walked.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

let program: Command;
let violations: ReturnType<typeof auditProgram>;
/**
 * Risk is snapshotted at registration time on purpose. The registry is a
 * module-level map that any suite may reset — and importing `auditProgram`
 * from the consistency spec pulls that suite in with it — so the honest thing
 * to assert on is what THIS program declared when it was built.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = [
  'vendor list', 'vendor show', 'vendor create', 'vendor edit', 'vendor terms set',
  'bill list', 'bill show', 'bill create', 'bill line set', 'bill approve',
];

beforeAll(() => {
  program = new Command('mnemosine');
  registerVendorCommand(program, deps);
  registerBillCommand(program, deps);
  violations = auditProgram(program);
  for (const path of LEAVES) risks.set(path, riskOf(find(path)));
});

function find(path: string): Command {
  let node: Command = program;
  for (const token of path.split(' ')) {
    const next = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`No command "${path}" (stuck at "${token}")`);
    node = next;
  }
  return node;
}

describe('the rulebook', () => {
  it('registers without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['bill', 'vendor']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ends every leaf command in a verb from the closed list', () => {
    const leaves: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) leaves.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    for (const leaf of leaves) {
      const last = leaf.split(' ').pop()!;
      expect(Object.keys(VERBS), leaf).toContain(last);
    }
    expect(leaves.sort()).toEqual([...LEAVES].sort());
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    vendor: 'proveedor',
    'vendor list': 'listar',
    'vendor show': 'ver',
    'vendor create': 'crear',
    'vendor edit': 'editar',
    'vendor terms': 'terminos',
    'vendor terms set': 'fijar',
    bill: 'factura-proveedor',
    'bill list': 'listar',
    'bill show': 'ver',
    'bill create': 'crear',
    'bill line': 'linea',
    'bill line set': 'fijar',
    'bill approve': 'aprobar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every verb command', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      const verb = path.split(' ').pop()!;
      if (VERBS[verb]) expect(alias, path).toBe(VERBS[verb]);
    }
  });

  it('never claims the plural `proveedores`, which the AI-model command already owns', () => {
    // The collision is real and deliberate: `mnemosine providers`·`proveedores`
    // lists MODEL providers. This family takes the singular only.
    const vendor = find('vendor');
    expect(vendor.aliases()).not.toContain('proveedores');
  });
});

describe('safety declarations', () => {
  it('lets the agent read and nothing else', () => {
    const agentAllowed = ['vendor list', 'vendor show', 'bill list', 'bill show'];
    for (const path of agentAllowed) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
    }
    for (const path of ['vendor create', 'vendor edit', 'vendor terms set', 'bill create', 'bill line set', 'bill approve']) {
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('declares approval irreversible: it posts to the ledger', () => {
    expect(risks.get('bill approve')?.risk).toBe('irreversible');
  });

  it('carries the safety flags that class requires', () => {
    const longs = find('bill approve').options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
  });

  it('would REFUSE to ship if someone let the agent approve a bill', () => {
    expect(() =>
      declareRisk(new Command('bill approve'), { risk: 'irreversible', agent: true })
    ).toThrow(/permission must never depend on the value of a flag/);
  });

  it('offers no way to set bank details anywhere in the vendor family', () => {
    // The bank-change gate needs a pending state, out-of-band verification and
    // a second approver. Until those exist, a flag that looks like the gate is
    // worse than no flag at all.
    const banky = /clabe|routing|bank/i;
    for (const cmd of [find('vendor create'), find('vendor edit'), find('vendor terms set')]) {
      expect(cmd.options.filter((o) => banky.test(o.long ?? '')), cmd.name()).toEqual([]);
    }
  });
});

describe('list commands can be paged and formatted', () => {
  it('carries --limit and --format, so nothing truncates silently', () => {
    for (const path of ['vendor list', 'bill list']) {
      const longs = find(path).options.map((o) => o.long);
      expect(longs, path).toEqual(expect.arrayContaining(['--limit', '--format', '--json', '--offset']));
    }
  });

  it('reads bill dates as the DOCUMENT date by default', () => {
    const basis = find('bill list').options.find((o) => o.long === '--date-basis');
    expect(basis?.defaultValue).toBe('document');
  });

  it('applies that default to the PARSED value, not only to the help text', () => {
    // Commander copies an option's default into the parsed values when the
    // option is registered, so rewriting `defaultValue` afterwards changes
    // what `--help` prints and nothing else. Asserting on defaultValue alone
    // let `bill list --since` run on the posting date, which hides every
    // unapproved bill — the ones somebody still has to act on.
    expect(find('bill list').opts().dateBasis).toBe('document');
  });
});

describe('parseLineSpec', () => {
  it('reads the key=value line a person types', () => {
    expect(parseLineSpec('account=5100,qty=2,price=350.00,tax=112')).toEqual({
      account: '5100', qty: '2', price: '350.00', tax: '112',
    });
  });

  it('keeps an "=" inside a value', () => {
    expect(parseLineSpec('account=5100,description=a=b').description).toBe('a=b');
  });

  it('refuses a fragment that is not key=value rather than guessing', () => {
    expect(() => parseLineSpec('5100,2,350')).toThrow(/key=value/);
  });
});
