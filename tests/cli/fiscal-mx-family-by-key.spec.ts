import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerSatCommands } from '../../src/cli/sat-commands.js';
import { riskOf } from '../../src/cli/kernel/risk.js';

// ============================================================
// I8.7 · the fiscal-mx family speaks by key (MNE-001-225, #269)
//
// `sat cred add` and `sat cred revoke` had four Spanish risk texts: why they
// need no idempotency key, and what they write. They are English in place now,
// like every other `writes` and `innecesaria` of the binary; the two reasons
// are the very English each leaf already prints when it gets the flag. The
// e-accounting leaves are asserted in e-accounting-command.spec.ts, beside
// their doubles. MNE-001-226 appends diot, cfdi and rep here.
// ============================================================

describe('I8.7 · sat cred states its risk in English', () => {
  const program = new Command();
  const pass = (s: string) => s;
  registerSatCommands(program, {
    color: { dim: pass, bold: pass, cyan: pass },
    colorErr: { dim: pass, red: pass },
    shutdown: async () => { throw new Error('shutdown'); },
    reportError: () => undefined,
    ask: async () => null,
  });
  const leaf = (...names: string[]): Command =>
    names.reduce(
      (cmd: Command, n) => cmd.commands.find((c) => c.name() === n)!,
      program.commands.find((c) => c.name() === 'sat')!
    );

  it('sat cred add: custody is guarded by the typed consent, and it writes the vault material', () => {
    const risk = riskOf(leaf('cred', 'add'))!;
    expect(risk.writes).toBe('fiscal_credentials + the material in the vault; validates the certificate locally first');
    expect(risk.llave).toEqual({
      innecesaria: 'custody is guarded by the typed consent and the credential status',
    });
  });

  it('sat cred revoke: a second revoke is refused, and it destroys the vault material', () => {
    const risk = riskOf(leaf('cred', 'revoke'))!;
    expect(risk.writes).toBe('fiscal_credentials + cryptographic destruction of the material in the vault');
    expect(risk.llave).toEqual({
      innecesaria: 'a second revoke is refused because no active credential remains',
    });
  });
});
