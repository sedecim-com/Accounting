import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { checkOpeningBalance, importOpeningBalance } from '../../src/services/accounting/opening-balance.js';
import { renderBalanceComparison } from '../../src/services/accounting/opening-balance-check.js';
import { registerAnexo24MigrationCommands } from '../../src/cli/anexo24-migration-command.js';
import { palette } from '../../src/cli/palette.js';

// ============================================================
// MNE-001-483 · A LEAVES-ONLY TRIAL BALANCE TIES, AGAINST POSTGRES
//
// A previous system may export only the accounts that carry a balance of
// their own, without the headers above them. The load has always accepted
// that file; the check that follows used to call our roots surplus, though
// every peso under them was declared. Surplus is the money no declared
// account carries, named at the account that holds it. The whole-tree file,
// the one the month's opening step uses, must tie exactly as before.
// ============================================================

const RFC = 'XAXX010101000';
const NS_BAL = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';

const trialBalance = (rows: readonly (readonly [code: string, balance: string])[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<BCE:Balanza xmlns:BCE="${NS_BAL}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
  rows
    .map(([c, s]) => `<BCE:Ctas NumCta="${c}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`)
    .join('') +
  `</BCE:Balanza>`;

/** Only the two accounts with a balance of their own: no 1000, 1100, 1110 nor 3000. */
const LEAVES_ONLY = trialBalance([['1111', '1000.00'], ['3100', '1000.00']]);
/** The same books with every level declared, as the Anexo 24 asks. */
const WHOLE_TREE = trialBalance(
  ['1000', '1100', '1110', '1111', '3000', '3100'].map((c) => [c, '1000.00'] as const)
);

const DIR = mkdtempSync(path.join(tmpdir(), 'mne483-'));
const LEAVES_FILE = path.join(DIR, 'leaves-only.xml');
writeFileSync(LEAVES_FILE, LEAVES_ONLY);

let fx: Fixture;
const ctx = () => ({ tenantId: fx.tenantId, entityId: fx.entityId });
const compare = async (xml: string) =>
  (await checkOpeningBalance(ctx(), { entityId: fx.entityId, xml })).comparison;

/** `opening-balance check <file>` through the registered command, against the real service. */
async function checkFromTheTerminal(file: string): Promise<number | undefined> {
  const exits: number[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const program = new Command('mnemosine').exitOverride();
    registerAnexo24MigrationCommands(program, {
      palette: palette(process.stdout),
      shutdown: (code) => void exits.push(code),
      reportError: (e) => {
        throw e;
      },
      confirm: async () => false,
    });
    await program.parseAsync(['opening-balance', 'check', file, '-e', fx.entityId, '-t', fx.tenantId], {
      from: 'user',
    });
  } finally {
    process.stdout.write = stdout;
  }
  return exits.at(-1);
}

beforeAll(async () => {
  fx = await crearInquilino('MNE-001-483 leaves-only check');
  enterTenant(fx.tenantId);
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a trial balance that declares only the accounts with a balance of their own', () => {
  it('T1 · loads, and its own check ties: our undeclared roots are not surplus', async () => {
    const load = await importOpeningBalance(ctx(), {
      entityId: fx.entityId,
      xml: LEAVES_ONLY,
      userId: fx.userId,
    });
    expect(load.escrito).toBe(true);

    const c = await compare(LEAVES_ONLY);
    expect(renderBalanceComparison(c)).toContain('IGUALES AL PESO');
    expect(c.sobrantes).toEqual([]);
    expect(c.comparadas).toBe(2);
    expect(c.iguales).toBe(true);
  });

  it('…and `opening-balance check` exits 0', async () => {
    expect(await checkFromTheTerminal(LEAVES_FILE)).toBe(0);
  });

  it('T2 · the same books tie against the whole tree, the shape the month uses', async () => {
    const c = await compare(WHOLE_TREE);
    expect(renderBalanceComparison(c)).toContain('IGUALES AL PESO');
    expect(c.iguales).toBe(true);
    expect(c.comparadas).toBe(6);
  });
});

describe('money of ours that no declared account carries', () => {
  beforeAll(async () => {
    // On the opening day, on two accounts neither file declares.
    await createJournalEntry(
      fx.entityId,
      '2026-01-01',
      JournalEntryType.STANDARD,
      'Money the previous system did not have',
      [
        { account_id: fx.cuentas['1140'], debit_amount: '50.0000', credit_amount: null, description: 'surplus' },
        { account_id: fx.cuentas['3200'], debit_amount: null, credit_amount: '50.0000', description: 'surplus' },
      ],
      fx.userId,
      { autoPost: true }
    );
  });

  it('T3 · is surplus at the account that holds it, and at no header above it', async () => {
    const c = await compare(LEAVES_ONLY);
    expect(c.iguales).toBe(false);
    // Exactly these two, in whatever order the chart query returns them.
    expect(c.sobrantes).toHaveLength(2);
    expect(c.sobrantes).toEqual(
      expect.arrayContaining([
        { numCta: '1140', importe: '50.0000' },
        { numCta: '3200', importe: '50.0000' },
      ])
    );
    const report = renderBalanceComparison(c);
    expect(report).toContain('1140: aquí lleva 50.0000');
    expect(report).toContain('3200: aquí lleva 50.0000');
  });

  it('…and `opening-balance check` exits 4', async () => {
    expect(await checkFromTheTerminal(LEAVES_FILE)).toBe(4);
  });

  it('T4 · against the whole tree a declared ancestor covers it: a difference there, no surplus', async () => {
    const c = await compare(WHOLE_TREE);
    expect(c.sobrantes).toEqual([]);
    expect(c.diferencias).toHaveLength(3);
    expect(c.diferencias).toEqual(
      expect.arrayContaining([
        { numCta: '1000', esperado: '1000.0000', obtenido: '1050.0000', diferencia: '50.0000' },
        { numCta: '1100', esperado: '1000.0000', obtenido: '1050.0000', diferencia: '50.0000' },
        { numCta: '3000', esperado: '1000.0000', obtenido: '1050.0000', diferencia: '50.0000' },
      ])
    );
  });
});
