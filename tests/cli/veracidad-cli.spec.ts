import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  registerBillCommand,
  parseLineSpec,
  resolveLineTaxAmount,
  LEGACY_TAX_KEY_WARNING,
} from '../../src/cli/bill-command.js';
import { registerInvoiceCommand } from '../../src/cli/invoice-command.js';
import { registerSatCommands } from '../../src/cli/sat-commands.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';

// ============================================================
// Tres sitios donde la CLI afirmaba lo que no hacía, ahora
// clavados con pruebas:
//   · `tax=` en bill significa MONTO (y siempre lo significó);
//     el nombre canónico pasa a `tax-amount=` y el sinónimo viejo
//     avisa, porque el `tax=` de invoice es TASA y quien cruza de
//     un comando al otro registraba 16 pesos donde iban 160.
//   · La ayuda de `sat` prometía la descarga masiva de CFDI que
//     no está construida, y sobre esa promesa se entregaban
//     e.firmas.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

function find(program: Command, path: string): Command {
  let node = program;
  for (const token of path.split(' ')) {
    const next: Command | undefined = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`no such command: ${path}`);
    node = next;
  }
  return node;
}

/** La ayuda completa del comando, con los bloques de addHelpText incluidos. */
function fullHelp(cmd: Command): string {
  let out = '';
  cmd.configureOutput({ writeOut: (s) => { out += s; } });
  cmd.outputHelp();
  return out;
}

describe('bill --line: tax es MONTO y tax-amount lo dice sin ambigüedad', () => {
  it('tax-amount= viaja como MONTO, tal cual, sin aritmética de tasa', () => {
    const parsed = parseLineSpec('account=5100,qty=1,price=1000,tax-amount=160');
    const r = resolveLineTaxAmount(parsed);
    // El dinero se compara como cadena: si alguien convirtiera tax-amount en
    // tasa (1000 × 160 / 100 = 1600), esta igualdad literal lo acusa.
    expect(r.tax_amount).toBe('160');
    expect(r.usedLegacyTaxKey).toBe(false);
  });

  it('tax= sigue siendo sinónimo con la MISMA semántica de monto, pero queda marcado para el aviso', () => {
    const r = resolveLineTaxAmount(parseLineSpec('account=5100,qty=1,price=1000,tax=160'));
    expect(r.tax_amount).toBe('160');
    expect(r.usedLegacyTaxKey).toBe(true);
  });

  it('cuando vienen ambos gana el nombre explícito, y no hay aviso', () => {
    const r = resolveLineTaxAmount(parseLineSpec('account=5100,price=1000,tax-amount=160,tax=999'));
    expect(r.tax_amount).toBe('160');
    expect(r.usedLegacyTaxKey).toBe(false);
  });

  it('sin clave de IVA el monto es 0 y nadie avisa nada', () => {
    const r = resolveLineTaxAmount(parseLineSpec('account=5100,price=1000'));
    expect(r.tax_amount).toBe('0');
    expect(r.usedLegacyTaxKey).toBe(false);
  });

  it('el aviso dice que tax= es el MONTO y hacia dónde migrar', () => {
    expect(LEGACY_TAX_KEY_WARNING).toMatch(/MONTO del IVA/);
    expect(LEGACY_TAX_KEY_WARNING).toMatch(/no la tasa/);
    expect(LEGACY_TAX_KEY_WARNING).toMatch(/tax-amount=/);
  });

  it('la ayuda de bill create documenta cada clave de --line, tax-amount incluida', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerBillCommand(program, deps);
    const help = fullHelp(find(program, 'bill create'));
    // Las claves que el comando acepta y que el help enumeraba a medias:
    // ahora cada una tiene su renglón.
    for (const key of [
      'account', 'qty', 'quantity', 'price', 'unit-price', 'tax-amount', 'tax',
      'description', 'cost-center', 'project',
    ]) {
      expect(help).toContain(`\n  ${key}`);
    }
    // Y la línea de tax-amount aclara que es MONTO, no tasa.
    expect(help).toMatch(/tax-amount\s+.*AMOUNT/);
    expect(help).toMatch(/NOT a rate/);
  });

  it('la ayuda de invoice aclara que SU tax= es TASA, no monto', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerInvoiceCommand(program, deps);
    const create = find(program, 'invoice create');
    const lineOpt = create.options.find((o) => o.long === '--line');
    expect(lineOpt?.description).toMatch(/RATE/);
    expect(lineOpt?.description).toMatch(/not an amount/);
  });
});

describe('sat --help ya no promete la descarga de CFDI que no existe', () => {
  it('la descripción habla de credenciales y confiesa que la descarga no está', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerSatCommands(program, {
      color: deps.palette,
      colorErr: deps.palette,
      shutdown: async (_code: number): Promise<never> => { throw new Error('shutdown'); },
      reportError: () => undefined,
      ask: async () => null,
    });
    const sat = find(program, 'sat');
    // La frase vieja era «SAT services (credentials and CFDI download)» y
    // sobre ella se entregaban e.firmas para una descarga que es E3.2 del
    // tablero, no software.
    expect(sat.description()).not.toMatch(/credentials and CFDI download/i);
    expect(sat.description()).toMatch(/e\.firma/);
    expect(sat.description()).toMatch(/not built yet/i);
  });
});
