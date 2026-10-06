import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { setAccountMapping, importAccountMappings } from '../../src/services/accounting/account-service.js';
import { ValidationError } from '../../src/utils/errors.js';

/**
 * #242 · MNE-001-379. THE DAY THE SAT GROUPING CODE IS VALIDATED ON.
 *
 * Without --year, the c_CodAgrup catalogue in force "today" validates the code.
 * "Today" was the UTC day: at 20:00 on December 31st in Mexico City it is
 * already January 1st in UTC, so the NEXT year's catalogue judged the code.
 *
 * Two catalogue generations are seeded so the day decides the verdict:
 * OLD is in force until 2026-12-31, NEW from 2027-01-01.
 * The clock is 2027-01-01T02:00:00Z = 20:00 on Dec 31st in Mexico City.
 * Only `Date` is faked: pg's timers keep running.
 */

const OLD = 'T01.01';
const NEW = 'T02.01';
const CLOCK = new Date('2027-01-01T02:00:00Z');

let f: Fixture;
let email: string;
const originalTz = process.env.TZ;

apartarCatalogos('sat_codigos_agrupadores');

beforeAll(async () => {
  f = await crearInquilino('SAT grouping today in zone');
  await query('DELETE FROM sat_codigos_agrupadores');
  await query(
    `INSERT INTO sat_codigos_agrupadores (codigo, nombre, nivel, codigo_padre, naturaleza, vigente_desde, vigente_hasta)
     VALUES ($1, 'Old generation', 2, NULL, NULL, '2015-01-01', '2026-12-31'),
            ($2, 'New generation', 2, NULL, NULL, '2027-01-01', NULL)`,
    [OLD, NEW]
  );
  const u = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId]);
  email = u.rows[0].email;
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

afterAll(async () => {
  await closeDatabase();
});

function atDecember31InMexicoCity(): void {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK);
}

async function storedCode(accountId: string): Promise<string | null> {
  const r = await query<{ v: string | null }>(
    'SELECT codigo_agrupador_sat AS v FROM accounts WHERE id = $1',
    [accountId]
  );
  return r.rows[0].v;
}

async function accountCommand(value: string): Promise<{ out: string; err: string }> {
  const { registerAccountCommand } = await import('../../src/cli/account-command.js');
  let out = '';
  let err = '';
  const plain = {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  };
  const program = new Command();
  program.exitOverride();
  registerAccountCommand(program, {
    palette: plain,
    shutdown: () => {},
    reportError: (e: unknown) => { err += `${(e as Error).message}\n`; },
  });
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += String(s); return true; });
  try {
    await program.parseAsync([
      'node', 'mnemosine', 'account', 'map', 'set', '1120', '--scheme', 'sat-agrupador',
      '--value', value, '--dry-run', '--entity', f.entityId, '--tenant', f.tenantId, '--user', email,
    ]);
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { out, err };
}

describe('the SAT grouping code without --year is validated on the entity day', () => {
  it('account map set: the catalogue of the 31st accepts OLD and rejects NEW', async () => {
    atDecember31InMexicoCity();
    await setAccountMapping(f.cuentas['1120'], 'sat-agrupador', OLD, f.userId);
    expect(await storedCode(f.cuentas['1120'])).toBe(OLD);
    await expect(
      setAccountMapping(f.cuentas['1120'], 'sat-agrupador', NEW, f.userId)
    ).rejects.toThrow(ValidationError);
  });

  it('bulk mapping: the same verdicts, row by row', async () => {
    atDecember31InMexicoCity();
    const r = await importAccountMappings(
      f.entityId,
      'sat-agrupador',
      [
        { code: '1100', value: OLD },
        { code: '1120', value: NEW },
      ],
      f.userId,
      { dryRun: true }
    );
    expect(r.map((x) => x.resultado)).toEqual(['aplicado', 'fuera_de_catalogo']);
  });

  it('the dry-run of `account map set` answers with the catalogue of the 31st', async () => {
    atDecember31InMexicoCity();
    const old = await accountCommand(OLD);
    expect(old.err).toBe('');
    expect(old.out).toContain('Old generation');
    const fresh = await accountCommand(NEW);
    expect(fresh.err).toContain(NEW);
  });
});
