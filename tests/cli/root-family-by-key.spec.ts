import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { autoPostIgnoredWarning, program, setupPrompt } from '../../src/cli/mnemosine.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { palette } from '../../src/cli/palette.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';

// ============================================================
// I8.2 · THE ROOT FAMILY SPEAKS BY KEY (MNE-001-219, #264)
//
// The root family's texts a person reads come from the I8.2 block of the
// catalogue; the risk notes no screen prints are English in place, as the I7
// pilot left `bank-command.ts`. One assertion per key in English and the same
// texts in Spanish. Written by hand, before the code.
// ============================================================

const plain = palette({ isTTY: false } as NodeJS.WriteStream);

afterEach(() => resetLanguage());

/** A leaf of the shipped program, by its path of names. */
function leaf(...names: string[]): Command {
  let at: Command = program;
  for (const name of names) {
    const next = at.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no leaf ${names.join(' ')}`);
    at = next;
  }
  return at;
}

describe('the first-run prompt asks through the kernel, default yes', () => {
  it('in English: Run setup now? [Y/n]', () => {
    setLanguage('en');
    expect(setupPrompt()).toBe('Run setup now? [Y/n] ');
  });

  it('in Spanish: ¿Configurar ahora? [S/n]', () => {
    setLanguage('es');
    expect(setupPrompt()).toBe('¿Configurar ahora? [S/n] ');
  });
});

describe('the auto-post warning is said in the user language', () => {
  it('in English, both lines', () => {
    setLanguage('en');
    const said = autoPostIgnoredWarning(plain);
    expect(said).toContain(
      'Warning: the auto-post asked for by flag or by mnemosine.config.json is IGNORED: ' +
        "the firm's panel does not authorize it."
    );
    expect(said).toContain(
      '\n  Turning it on belongs to the panel (`mnemosine pending`), and it requires the shadow evidence. ' +
        'Turning it off can be local.'
    );
  });

  it('in Spanish, both lines', () => {
    setLanguage('es');
    const said = autoPostIgnoredWarning(plain);
    expect(said).toContain(
      'Aviso: el auto-posteo pedido por bandera o por mnemosine.config.json se IGNORA: el panel del despacho no lo autoriza.'
    );
    expect(said).toContain('\n  Encender es del panel (`mnemosine pending`), y exige la evidencia de sombra.');
  });
});

describe('the risk notes of the root family are English in place', () => {
  it('each declared write says what it writes, in English', () => {
    expect(riskOf(leaf('review'))?.writes).toMatch(/POSTED when a draft is approved/);
    expect(riskOf(leaf('ingest'))?.writes).toMatch(/with auto-post, POSTED entries/);
    expect(riskOf(leaf('onboard'))?.writes).toMatch(/opening balances; with --post, the POSTED opening entry/);
    expect(riskOf(leaf('outbox', 'run'))?.writes).toMatch(/EXECUTES each operation against the client's accounting system/);
    expect(riskOf(leaf('question', 'answer'))?.writes).toMatch(/the precedents its answer seeds/);
    expect(riskOf(leaf('close'))?.writes).toMatch(/with --hard, POSTED closing entries and the carry-forward of balances/);
  });

  it('each key it does not need says why, in English', () => {
    const reason = (cmd: Command): string => {
      const declared = riskOf(cmd)?.llave;
      return declared && 'innecesaria' in declared ? declared.innecesaria : '';
    };
    expect(reason(leaf('review'))).toMatch(/each approval is bound to the reviewed content/);
    expect(reason(leaf('ingest'))).toMatch(/each CFDI deduplicates by its own UUID and hash/);
    expect(reason(leaf('outbox', 'run'))).toMatch(/each operation is claimed atomically/);
  });

  it('the help of ask asks its examples in English', () => {
    const ask = leaf('ask');
    let help = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      help += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      ask.outputHelp();
    } finally {
      process.stdout.write = write;
    }
    expect(help).toContain('mnemosine ask "How much creditable VAT did I accrue in July"');
    expect(help).not.toMatch(/Cuanto IVA|Saldo de la cuenta/);
  });
});
