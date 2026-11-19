import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { registerAnnualFigureCommand } from '../../src/cli/annual-figure-command.js';
import { registerFilingWorkpaperCommand } from '../../src/cli/filing-workpaper-command.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-457 (#622, part 1/2) · THE PROFIT COEFFICIENT FROM THE TERMINAL
//
// `annual figure record --kind profit_coefficient` through the leaf, against a
// migrated Postgres, with `filing workpaper generate` beside it: the ISR paper
// stops blocking once the coefficient of a filed return is captured, an
// amendment takes over while the earlier row stays, and no refusal reaches a
// table CHECK or writes a row. The return is invented. A case that captures
// uses its own sibling entity.
// ============================================================

let f: Fixture;
let other: Fixture;
let email: string;
let otherEmail: string;

const same = (x: string): string => x;
const plain = { dim: same, bold: same, cyan: same, red: same, green: same, yellow: same };

interface Who { entity: string; tenant: string; user: string }
interface CliResult { exitCode?: number; out: string; err: string }

/** Runs the binary's two leaves; stdout, stderr and the reported error are kept. */
async function cli(argv: string[], who: Who): Promise<CliResult> {
  const r: CliResult = { out: '', err: '' };
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { r.out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { r.err += String(c); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    const deps = {
      palette: plain,
      shutdown: (c: number) => { r.exitCode = c; },
      reportError: (e: unknown) => { r.err += `${(e as Error).message}\n`; },
    };
    registerAnnualFigureCommand(p, deps);
    registerFilingWorkpaperCommand(p, deps);
    await p.parseAsync(['node', 'mnemosine', ...argv, '-e', who.entity, '-t', who.tenant, '-u', who.user]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return r;
}
const me = (fx: Fixture = f): Who => ({ entity: fx.entityId, tenant: fx.tenantId, user: email });

const SOURCE = '2025 return, operation 000111';
const RETURN_2025 = { kind: 'profit_coefficient', value: '0.0875', year: '2025', 'filed-on': '2026-03-20', source: SOURCE };
/** What a capture of that return prints, real or dry. */
const printed = (): Record<string, unknown> => ({
  kind: 'profit_coefficient', value: '0.0875', source_fiscal_year: 2025, source_filed_on: '2026-03-20',
  source_document: SOURCE, updated_through: null, recorded_by: email,
});

/** `annual figure record` with the invented return; a flag set to undefined is left out. */
const record = (change: Record<string, string | undefined> = {}, extra: string[] = []): string[] => [
  'annual', 'figure', 'record',
  ...Object.entries({ ...RETURN_2025, ...change }).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}=${v}`])),
  ...extra,
];
const paper = (period: string): string[] => ['filing', 'workpaper', 'generate', '--period', period, '--form', 'isr', '--json'];

interface Stored { value: string; year: number; filed: string; source: string; recorded_by: string | null }
const stored = async (entityId: string): Promise<Stored[]> =>
  (await query<Stored>(
    `SELECT value::text AS value, source_fiscal_year AS year, to_char(source_filed_on, 'YYYY-MM-DD') AS filed,
            source_document AS source, recorded_by
       FROM income_tax_annual_inputs WHERE entity_id = $1 ORDER BY seq`,
    [entityId]
  )).rows;

const rowOf = (r: CliResult): Record<string, unknown> =>
  (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
interface IsrSection {
  blockedBy: string[];
  lines: Array<{ key: string; source: { ref?: string } }>;
  inputs: { coefficient?: Record<string, unknown> };
}
const isrOf = (r: CliResult): IsrSection => (JSON.parse(r.out) as { sections: IsrSection[] }).sections[0];

beforeAll(async () => {
  other = await crearInquilino('MNE-001-457 · the other tenant');
  f = await crearInquilino('MNE-001-457 · annual figure record');
  await seedPolicies({ tenantId: f.tenantId });
  const mail = async (id: string): Promise<string> =>
    (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [id])).rows[0].email;
  email = await mail(f.userId);
  otherEmail = await mail(other.userId);
}, 180_000);

afterAll(() => closeDatabase());

describe('annual figure record --kind profit_coefficient', () => {
  it('the paper blocks naming the command, settles once the coefficient is captured, and an amendment takes over', async () => {
    const a = await crearEntidadHermana(f, 'MNE-001-457 · capture and amendment');
    const blocked = await cli(paper('2026-05'), me(a));
    expect(blocked.exitCode).toBe(4);
    expect(isrOf(blocked).blockedBy).toEqual(['ISR-WP-NO-COEFFICIENT']);
    expect(blocked.err).toContain('`mnemosine annual figure record --kind profit_coefficient`');

    const captured = await cli(record({}, ['--json']), me(a));
    expect(captured.exitCode, captured.err).toBe(0);
    const first = { value: '0.0875', year: 2025, filed: '2026-03-20', source: SOURCE, recorded_by: f.userId };
    expect(await stored(a.entityId)).toEqual([first]);
    expect(rowOf(captured)).toMatchObject({ ...printed(), dry_run: false });
    expect(rowOf(captured).id).toMatch(/^[0-9a-f-]{36}$/);

    const may = await cli(paper('2026-05'), me(a));
    expect(may.exitCode, may.err).toBe(0);
    expect(isrOf(may).blockedBy).toEqual([]);
    expect(isrOf(may).lines.find((l) => l.key === 'estimated_profit')?.source.ref).toBe('coefficient');
    expect(isrOf(may).inputs.coefficient).toEqual(
      { value: '0.0875', sourceFiscalYear: 2025, sourceFiledOn: '2026-03-20', sourceDocument: SOURCE });

    const amendment = '2025 amended return, operation 000222';
    const amended = await cli(record({ value: '0.0900', 'filed-on': '2026-05-02', source: amendment }), me(a));
    expect(amended.exitCode, amended.err).toBe(0);
    expect(amended.err).toMatch(/mnemosine filing workpaper generate/);
    const june = await cli(paper('2026-06'), me(a));
    expect(isrOf(june).inputs.coefficient).toMatchObject({ value: '0.0900', sourceFiledOn: '2026-05-02', sourceDocument: amendment });
    const rows = await stored(a.entityId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(first);
  }, 120_000);

  it('the same capture twice is two rows, and the paper does not move', async () => {
    const b = await crearEntidadHermana(f, 'MNE-001-457 · repeated capture');
    expect((await cli(record(), me(b))).exitCode).toBe(0);
    const once = isrOf(await cli(paper('2026-05'), me(b))).inputs.coefficient;
    expect((await cli(record(), me(b))).exitCode).toBe(0);
    expect(await stored(b.entityId)).toHaveLength(2);
    expect(isrOf(await cli(paper('2026-05'), me(b))).inputs.coefficient).toEqual(once);
  }, 120_000);

  it('zero and a coefficient above one are accepted', async () => {
    const c = await crearEntidadHermana(f, 'MNE-001-457 · zero and above one');
    for (const value of ['0', '1.2000']) {
      const r = await cli(record({ value }, ['--json']), me(c));
      expect(r.exitCode, r.err).toBe(0);
      expect(rowOf(r).value).toBe(Number(value).toFixed(4));
    }
    expect((await stored(c.entityId)).map((r) => r.value)).toEqual(['0.0000', '1.2000']);
  }, 120_000);

  it.each<[string, Record<string, string | undefined>, number, RegExp]>([
    ['no --kind', { kind: undefined }, 2, /--kind/],
    ['a kind the table does not have', { kind: 'ptu_paid' }, 2, /--kind.*ptu_paid/],
    ['the pending losses, which this leaf does not record yet', { kind: 'pending_tax_losses' }, 2, /--kind.*pending_tax_losses/],
    ['no --value', { value: undefined }, 2, /--value/],
    ['a value that is not a number', { value: 'abc' }, 2, /--value.*abc/],
    ['a negative value', { value: '-0.1' }, 2, /--value.*-0\.1/],
    ['five decimals', { value: '0.12345' }, 2, /--value.*0\.12345/],
    ['sixteen integer digits', { value: '1000000000000000' }, 2, /--value.*1000000000000000/],
    ['no --year', { year: undefined }, 2, /--year/],
    ['a fractional year', { year: '2025.5' }, 2, /--year.*2025\.5/],
    ['a year before 2000', { year: '1999', 'filed-on': '2000-03-31' }, 2, /--year.*1999/],
    ['no --filed-on', { 'filed-on': undefined }, 2, /--filed-on/],
    ['a filing date that is not a real day', { 'filed-on': '2026-02-30' }, 2, /--filed-on.*2026-02-30/],
    ['no --source', { source: undefined }, 2, /--source/],
    ['a source of spaces', { source: '   ' }, 2, /--source/],
    ['a return filed inside its own year', { 'filed-on': '2025-12-31' }, 4, /--filed-on.*2025-12-31/],
    ['a return filed after today', { year: '2199', 'filed-on': '2200-03-31' }, 4, /--filed-on.*2200-03-31/],
  ])('refuses %s in words and writes nothing', async (_, change, exit, says) => {
    const r = await cli(record(change), me());
    expect(r.exitCode, r.err).toBe(exit);
    expect(r.err).toMatch(says);
    expect(r.err).not.toMatch(/constraint|violates|_check|income_tax_annual_inputs/);
    expect(await stored(f.entityId)).toEqual([]);
  });

  it('an entity of another tenant is refused by the context guard, and no tenant gets a row', async () => {
    const r = await cli(record(), { ...me(), entity: other.entityId });
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toMatch(/pertenece al inquilino/);
    expect([...(await stored(f.entityId)), ...(await stored(other.entityId))]).toEqual([]);
  });

  it('a user of another tenant gets the answer an unknown address gets, and no row', async () => {
    const foreign = await cli(record(), { ...me(), user: otherEmail });
    const unknown = await cli(record(), { ...me(), user: 'nobody@example.test' });
    expect(foreign.exitCode).not.toBe(0);
    expect(foreign.exitCode).toBe(unknown.exitCode);
    expect(foreign.err.replaceAll(otherEmail, '<address>')).toBe(unknown.err.replaceAll('nobody@example.test', '<address>'));
    expect(await stored(f.entityId)).toEqual([]);
  });

  it('--dry-run --json prints the row of a real capture and writes nothing', async () => {
    const r = await cli(record({}, ['--dry-run', '--json']), me());
    expect(r.exitCode, r.err).toBe(0);
    expect(rowOf(r)).toEqual({ id: '', ...printed(), recorded_at: '', dry_run: true });
    expect(await stored(f.entityId)).toEqual([]);
  });
});
