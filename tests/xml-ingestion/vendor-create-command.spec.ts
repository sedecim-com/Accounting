import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { vendorCreateCommand } from '../../src/services/xml-ingestion/pre-registration-service.js';

/**
 * Runs the printed command in a real bash where `mnemosine` is a harmless
 * stub that prints each argument it received, one per line and NUL-free. A
 * second stub catches any word the shell would run as a separate command.
 */
function interpret(command: string): { argv: string[]; strays: string[] } {
  const script = [
    'mnemosine() { for a in "$@"; do printf "ARG:%s\\n" "$a"; done; }',
    'command_not_found_handle() { printf "STRAY:%s\\n" "$1"; }',
    command,
    'wait',
  ].join('\n');
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const lines = out.stdout.split('\n').filter(Boolean);
  return {
    argv: lines.filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4)),
    strays: lines.filter((l) => l.startsWith('STRAY:')).map((l) => l.slice(6)),
  };
}

describe('the refusal command for an unknown CFDI issuer (#318, Witness WIT-01 on #414)', () => {
  it('keeps an RFC with an ampersand whole: one invocation, --tax-id gets the full RFC', () => {
    const { argv, strays } = interpret(vendorCreateCommand('Proveedor Sintetico', 'A&B010101AAA'));
    expect(strays).toEqual([]);
    expect(argv).toEqual(['vendor', 'create', 'Proveedor Sintetico', '--tax-id', 'A&B010101AAA']);
  });

  it("keeps a name with an apostrophe and shell syntax literal", () => {
    const name = "Proveedor O'Nuevo $(echo INJECTED) `id` & SC";
    const { argv, strays } = interpret(vendorCreateCommand(name, 'NUE020202BBB'));
    expect(strays).toEqual([]);
    expect(argv).toEqual(['vendor', 'create', name, '--tax-id', 'NUE020202BBB']);
  });

  it('prints the quoted form the refusal message shows', () => {
    expect(vendorCreateCommand("O'Nuevo", 'A&B010101AAA'))
      .toBe("mnemosine vendor create 'O'\\''Nuevo' --tax-id 'A&B010101AAA'");
  });
});
