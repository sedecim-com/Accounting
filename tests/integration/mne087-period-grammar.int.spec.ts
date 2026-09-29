import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { registerCloseCommand } from '../../src/cli/close-command.js';
import { registerClosingCommand } from '../../src/cli/closing-command.js';
import { writeState } from '../../src/cli/kernel/entity-context.js';
import { ExitCode } from '../../src/cli/kernel/index.js';
import { getAuxiliaryView } from '../../src/services/reporting/report-service.js';

// ============================================================
// MNE-001-087 (#327) · ONE `--period` GRAMMAR, AND `close` HONOURS `entity use`
//
// `close --period` matched a SUBSTRING of the stored period name against the
// closable list, so `2026-08` — what every other family accepts — found
// nothing, and a bookkeeper had to know the name the calendar coined. Its
// twin `closing preview|check|explain` did the same, and `ledger auxiliary
// show` too. All of them now go through `resolvePeriod`: uuid, YYYY-MM, or an
// unambiguous part of the name.
//
// And `close` resolved its entity with `resolveEntity(opts.entity)`, which
// never reads the pin `entity use` writes: in a firm with more than one entity
// the pinned one was ignored. The test runs on two entities of ONE tenant so
// that the pin is the only thing that can tell them apart.
// ============================================================

let a: Fixture;
let b: Fixture;
/** A third entity whose year carries period 13, the way `year create` mints it. */
let c: Fixture;
let c13: string;
let email: string;
let home: string;
const envEntity = process.env.MNEMOSINE_ENTITY;

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Thrown by the test's shutdown so the action stops where a real exit would. */
class Exit extends Error {}

async function runLeaf(
  family: 'close' | 'closing',
  argv: string[]
): Promise<{ exitCode: number | undefined; errs: unknown[]; out: string }> {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origError = console.error;
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { out.push(`${args.join(' ')}\n`); };
  console.error = () => undefined;
  const reportError = (e: unknown) => { if (!(e instanceof Exit)) errs.push(e); };
  try {
    const p = new Command('mnemosine');
    if (family === 'close') {
      registerCloseCommand(p, {
        palette: plain,
        shutdown: (c: number) => {
          exitCode ??= c;
          throw new Exit();
        },
        reportError,
        home,
      });
    } else {
      registerClosingCommand(p, {
        palette: plain,
        shutdown: (c: number) => { exitCode ??= c; },
        reportError,
        home,
      });
    }
    await p.parseAsync(['node', 'mnemosine', ...argv, '-t', a.tenantId, '-u', email]).catch((e) => {
      if (!(e instanceof Exit)) throw e;
    });
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { exitCode, errs, out: out.join('') };
}

/** The period `close --check --json` answered about. */
function periodOf(out: string): { id: string; period_name: string } {
  return (JSON.parse(out) as { period: { id: string; period_name: string } }).period;
}

beforeAll(async () => {
  a = await crearInquilino('MNE-087 entidad A');
  b = await crearEntidadHermana(a, 'MNE-087 entidad B');
  c = await crearEntidadHermana(a, 'MNE-087 entidad C');
  enterTenant(a.tenantId);
  const p13 = await query<{ id: string }>(
    `INSERT INTO fiscal_periods (fiscal_year_id, entity_id, period_number, period_name,
       start_date, end_date, period_type, status)
     VALUES ($1, $2, 13, 'Year-end adjustments 2026', '2026-12-31', '2026-12-31', 'adjustment', 'open')
     RETURNING id`,
    [c.fiscalYearId, c.entityId]
  );
  c13 = p13.rows[0].id;
  const u = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [a.userId]);
  email = u.rows[0].email;
}, 300_000);

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (envEntity === undefined) delete process.env.MNEMOSINE_ENTITY;
  else process.env.MNEMOSINE_ENTITY = envEntity;
});

afterAll(async () => {
  await closeDatabase();
});

function freshHome(): void {
  home = mkdtempSync(path.join(os.tmpdir(), 'mne087-'));
  delete process.env.MNEMOSINE_ENTITY;
}

describe('close --period speaks the same grammar as every other family', () => {
  it('accepts 2026-01 and answers about THAT month', async () => {
    freshHome();
    const r = await runLeaf('close', ['close', '--period', '2026-01', '--check', '--json', '-e', a.entityId]);
    expect(r.errs, r.out).toEqual([]);
    expect(periodOf(r.out).id).toBe(a.periodos[1]);
  });

  it('still accepts the name the calendar gave the period', async () => {
    freshHome();
    const r = await runLeaf('close', ['close', '--period', 'Periodo 1/2026', '--check', '--json', '-e', a.entityId]);
    expect(periodOf(r.out).id).toBe(a.periodos[1]);
  });

  it('a month that exists but can no longer be closed is refused by its state, not "not found"', async () => {
    freshHome();
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = $1`, [a.periodos[12]]);
    try {
      const r = await runLeaf('close', ['close', '--period', '2026-12', '--check', '-e', a.entityId]);
      expect(r.exitCode).toBe(ExitCode.BLOCKED);
      expect(String(r.errs[0])).toMatch(/Periodo 12\/2026 is locked/);
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [a.periodos[12]]);
    }
  });

  it('an ambiguous name is refused, listing every match, instead of taking the first', async () => {
    freshHome();
    // "Periodo 1" is part of periods 1, 10, 11 and 12.
    const r = await runLeaf('close', ['close', '--period', 'Periodo 1', '--check', '-e', a.entityId]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    const msg = String(r.errs[0]);
    expect(msg).toMatch(/matches 4 periods/);
    expect(msg).toMatch(/Periodo 1\/2026, Periodo 10\/2026/);
    expect(msg).toMatch(/YYYY-MM/);
  });

  it('a month with no period is NOT_FOUND and lists what can be closed', async () => {
    freshHome();
    const r = await runLeaf('close', ['close', '--period', '2031-05', '--check', '-e', a.entityId]);
    expect(r.exitCode).toBe(ExitCode.NOT_FOUND);
    expect(String(r.errs[0])).toMatch(/2031-05/);
    expect(String(r.errs[0])).toMatch(/Periodo 1\/2026/);
  });
});

describe('close honours `entity use` when the tenant has more than one entity', () => {
  it('with B pinned and no -e, it answers about B', async () => {
    freshHome();
    writeState({ entityId: b.entityId, entityName: 'MNE-087 entidad B' }, home);
    const r = await runLeaf('close', ['close', '--period', '2026-01', '--check', '--json']);
    expect(r.errs, r.out).toEqual([]);
    expect(periodOf(r.out).id).toBe(b.periodos[1]);
  });

  it('-e still wins over the pin', async () => {
    freshHome();
    writeState({ entityId: b.entityId, entityName: 'MNE-087 entidad B' }, home);
    // A name B has too, so only the entity can decide which period answers.
    const r = await runLeaf('close', ['close', '--period', 'Periodo 1/2026', '--check', '--json', '-e', a.entityId]);
    expect(r.errs, r.out).toEqual([]);
    expect(periodOf(r.out).id).toBe(a.periodos[1]);
  });
});

describe('the closing family and the auxiliary ledger read the same grammar', () => {
  it('closing preview 2026-01, with B pinned, answers about B', async () => {
    freshHome();
    writeState({ entityId: b.entityId, entityName: 'MNE-087 entidad B' }, home);
    const r = await runLeaf('closing', ['closing', 'preview', '2026-01', '--json']);
    expect(r.errs, r.out).toEqual([]);
    const envelope = JSON.parse(r.out) as { rows: Array<{ period: { id: string } }> };
    expect(envelope.rows[0].period.id).toBe(b.periodos[1]);
  });

  it('ledger auxiliary show resolves 2026-02 to the February period', async () => {
    const aux = await getAuxiliaryView(a.entityId, '1111', '2026-02');
    expect(aux.period_name).toBe('Periodo 2/2026');
  });
});

describe('December and the year-end adjustments period (13) share 2026-12', () => {
  it('close --period 2026-12 --hard --dry-run is refused instead of sealing December as if it were the annual close', async () => {
    freshHome();
    const r = await runLeaf('close', [
      'close', '--period', '2026-12', '--hard', '--reason', 'Cierre anual 2026', '--dry-run', '-e', c.entityId,
    ]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    const msg = String(r.errs[0]);
    expect(msg).toMatch(/matches 2 periods/);
    expect(msg).toContain(c.periodos[12]);
    expect(msg).toContain(c13);
  });

  it('closing preview 2026-12 refuses the same way: one resolver for every close surface', async () => {
    freshHome();
    const r = await runLeaf('closing', ['closing', 'preview', '2026-12', '--json', '-e', c.entityId]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(String(r.errs[0])).toMatch(/matches 2 periods/);
  });

  it('period 13 is reachable by its full name, as the help shows', async () => {
    freshHome();
    const r = await runLeaf('close', [
      'close', '--period', 'Year-end adjustments 2026', '--check', '--json', '-e', c.entityId,
    ]);
    expect(r.errs, r.out).toEqual([]);
    expect(periodOf(r.out).id).toBe(c13);
  });

  it('period 13 is reachable by its id', async () => {
    freshHome();
    const r = await runLeaf('close', ['close', '--period', c13, '--check', '--json', '-e', c.entityId]);
    expect(r.errs, r.out).toEqual([]);
    expect(periodOf(r.out).id).toBe(c13);
  });
});
