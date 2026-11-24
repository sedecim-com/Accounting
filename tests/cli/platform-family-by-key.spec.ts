import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// ============================================================
// I8.6 · the platform family speaks by key (MNE-001-223, #268)
//
// The five leaves of `backup`, end to end where they can be: `create`,
// `verify --restore` and `restore` against doubles of the backup service;
// `list` and the plain `verify` against a directory of fixture files, because
// listing only reads the file system; and `export` through `exportReport`,
// the pure function that builds what it prints (its service reads the
// database). Every line written to a person comes from the catalogue: English
// under the suite's en-US, Spanish when the language is pinned. `backup list`
// keeps its cells English in --json under any locale. Texts by hand, before
// the code. MNE-001-224 appends the other four leaves of the family here.
// ============================================================

vi.mock('../../src/services/backup/backup-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/backup/backup-service.js')>()),
  crearRespaldo: vi.fn(),
  verificarRespaldo: vi.fn(),
  restaurarRespaldo: vi.fn(),
}));
vi.mock('../../src/database/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/database/connection.js')>()),
  currentTenant: vi.fn(() => undefined),
  enterTenant: vi.fn(),
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Agente SA', tenantId: 'ten-1', currency: 'MXN',
    country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));
vi.mock('../../src/ai/stats-service.js', () => ({ estadisticasDelAgente: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'quizá'), close: vi.fn() })),
}));

import { exportReport, registerBackupCommand } from '../../src/cli/backup-command.js';
import { actorLabel, registerAuditCommand } from '../../src/cli/audit-command.js';
import { registerAiCommand } from '../../src/cli/ai-command.js';
import { registerJobsCommand } from '../../src/cli/jobs-command.js';
import { registerWebhookSweepCommand } from '../../src/cli/webhook-sweep-command.js';
import { query } from '../../src/database/connection.js';
import * as stats from '../../src/ai/stats-service.js';
import { type CliError } from '../../src/cli/kernel/index.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import * as service from '../../src/services/backup/backup-service.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import type { ResultadoExportacion } from '../../src/services/backup/exportacion-inquilino.js';

const PALETTE = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

async function cli(args: string[], confirm?: (q: string) => Promise<boolean>) {
  resetDeclarations();
  const codes: number[] = [];
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerBackupCommand(program, {
    palette: PALETTE,
    shutdown: (c: number) => { codes.push(c); },
    reportError: (e: unknown) => { errs.push(e); },
    ...(confirm ? { confirm } : {}),
  });
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', 'backup', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { codes, out, err, errs, program };
}

const MB = 1024 * 1024;
const DUMP = '/var/backups/mnemosine-20261120.dump';

function dumpManifest(tenants: number) {
  return {
    formato: 1, creado: '2026-11-20T10:00:00Z', alcance: { tipo: 'instalacion-completa', inquilinos: tenants },
    esquema: { ultimaMigracion: '335_x', migracionesAplicadas: 335 }, base: 'mnemosine_dev',
    archivo: 'mnemosine-20261120.dump', bytes: 12 * MB, sha256: 'abc', noIncluye: [],
  };
}

afterEach(() => resetLanguage());

describe('I8.6 · backup create speaks by key', () => {
  beforeEach(() => {
    vi.mocked(service.crearRespaldo).mockResolvedValue({
      archivo: DUMP, manifiestoEn: `${DUMP}.manifiesto.json`, manifiesto: dumpManifest(2),
    } as never);
  });

  it('a scoped create is a usage error that names export, in both languages', async () => {
    const r = await cli(['create', '--tenant', 't1']);
    const e = r.errs[0] as CliError;
    expect(e.message).toContain('`backup create` dumps the WHOLE installation with pg_dump, which does not filter rows');
    expect(e.message).toContain('For the archive of ONE firm: `mnemosine backup export --tenant <id>`');
    expect(e.localized('es')).toContain('`backup create` vuelca la instalación ENTERA con pg_dump');
  });

  it('says what the dump is, whose it is and what it leaves out', async () => {
    const r = await cli(['create']);
    expect(r.out).toContain('✔ mnemosine-20261120.dump (12.0 MB · schema 335_x)\n');
    expect(r.out).toContain('  manifest: mnemosine-20261120.dump.manifiesto.json\n');
    expect(r.err).toContain('  It holds the UNREDACTED data of 2 tenants: it is the whole installation, not one firm.\n');
    expect(r.err).toContain('  For the archive of one only: `mnemosine backup export --tenant <id>`.\n');
    expect(r.err).toContain('  And it does NOT include the cryptographic material:\n');
    expect(r.err).toContain(
      '  the vault key and ENCRYPTION_KEY live outside the database. Without them, after a restore the fiscal ' +
        'credentials and the bank data are unreadable. Back them up separately.\n'
    );
    expect(r.err).toContain('  And an untested backup is not a backup: `mnemosine backup verify <file> --restore`.\n');
  });

  it('the same, in Spanish and with one tenant', async () => {
    vi.mocked(service.crearRespaldo).mockResolvedValue({
      archivo: DUMP, manifiestoEn: `${DUMP}.manifiesto.json`, manifiesto: dumpManifest(1),
    } as never);
    setLanguage('es');
    const r = await cli(['create']);
    expect(r.out).toContain('(12.0 MB · esquema 335_x)');
    expect(r.out).toContain('  manifiesto: mnemosine-20261120.dump.manifiesto.json');
    expect(r.err).toContain('Contiene los datos SIN REDACTAR de 1 inquilino: es la instalación entera, no un despacho.');
  });

  it('--json writes the row and no prose', async () => {
    const r = await cli(['create', '--json']);
    expect(r.out).toContain('"inquilinos"');
    expect(r.out).not.toContain('UNREDACTED');
    expect(r.err).toBe('');
  });
});

describe('I8.6 · backup export speaks by key', () => {
  const exported = (outOfScope: number): ResultadoExportacion =>
    ({
      archivo: '/var/backups/demo-20261120.exportacion.ndjson',
      manifiestoEn: '/var/backups/demo-20261120.exportacion.ndjson.manifiesto.json',
      manifiesto: {
        formato: 1, tipo: 'exportacion-logica', restaurable: false, creado: '2026-11-20T10:00:00Z',
        alcance: { tipo: 'entidad', tenantId: 't1', tenantNombre: 'Demo Respaldo SA', entityId: 'e1', entityNombre: 'Demo Hermana SA' },
        esquema: { ultimaMigracion: '335_x', migracionesAplicadas: 335 }, base: 'mnemosine_dev',
        archivo: 'demo-20261120.exportacion.ndjson', bytes: MB / 2, sha256: 'abc',
        leidoComo: { rol: 'mnemosine_app', sujetoARls: true, aislamiento: 'REPEATABLE READ' },
        tablas: [{ tabla: 'a', filas: 1, acotadaPor: 'entity_id' }, { tabla: 'b', filas: 0, acotadaPor: 'entity_id' }],
        totalFilas: 1, noIncluye: [],
        fueraDeAlcance: Array.from({ length: outOfScope }, (_, i) => ({ tabla: `t${i}`, motivo: 'm' })),
      },
    }) as unknown as ResultadoExportacion;

  it('an export with no tenant is a usage error, in both languages', async () => {
    const r = await cli(['export']);
    const e = r.errs[0] as CliError;
    expect(e.message).toContain('There is no tenant to export. Name it with `--tenant <uuid>` or set MNEMOSINE_TENANT.');
    expect(e.localized('es')).toContain('No hay inquilino que exportar.');
  });

  it('says what was exported, how it was read and why it is not a backup', () => {
    const r = exportReport(exported(3), PALETTE);
    expect(r.out).toContain('✔ demo-20261120.exportacion.ndjson (0.5 MB · 1 row · 2 tables)\n');
    expect(r.out).toContain('  scope: entidad — Demo Hermana SA (entity of Demo Respaldo SA)\n');
    expect(r.out).toContain('  read as mnemosine_app, subject to RLS, in a single REPEATABLE READ snapshot\n');
    expect(r.out).toContain('  manifest: demo-20261120.exportacion.ndjson.manifiesto.json\n');
    expect(r.err).toContain('  This is an EXPORT, not a backup: there is no tested way back.\n');
    expect(r.err).toContain('  For disaster recovery: `mnemosine backup create` + `backup restore`.\n');
    expect(r.err).toContain('  3 scoped tables are left outside this scope; the manifest names them one by one.\n');
    expect(r.err).toContain("  It carries the firm's unredacted data, third-party RFCs included: treat it as such.\n");
  });

  it('the same in Spanish, with its plurals', () => {
    setLanguage('es');
    const r = exportReport(exported(1), PALETTE);
    expect(r.out).toContain('(0.5 MB · 1 fila · 2 tablas)');
    expect(r.out).toContain('  alcance: entidad — Demo Hermana SA (entidad de Demo Respaldo SA)');
    expect(r.err).toContain('1 tabla acotada queda fuera de este alcance;');
  });

  it('with no table out of scope there is no such line', () => {
    expect(exportReport(exported(0), PALETTE).err).not.toContain('outside this scope');
  });
});

describe('I8.6 · backup list and the plain verify, over a directory', () => {
  let dir: string;
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mne-223-'));
    writeFileSync(join(dir, 'a-20261119.dump'), 'dump a');
    writeFileSync(
      join(dir, 'a-20261119.dump.manifiesto.json'),
      JSON.stringify({
        ...dumpManifest(3), creado: '2026-11-19T10:00:00Z', sha256: sha('dump a'),
        verificacion: { fecha: '2026-11-19T11:00:00Z', restauro: true, hallazgos: 0, detalle: '' },
      })
    );
    writeFileSync(join(dir, 'b-20261118.dump'), 'dump b');
    writeFileSync(join(dir, 'd-20261116.dump'), 'dump d');
    writeFileSync(
      join(dir, 'd-20261116.dump.manifiesto.json'),
      JSON.stringify({ ...dumpManifest(1), creado: '2026-11-16T10:00:00Z', sha256: 'not-the-hash' })
    );
    writeFileSync(join(dir, 'c-20261117.exportacion.ndjson'), 'export c');
    writeFileSync(
      join(dir, 'c-20261117.exportacion.ndjson.manifiesto.json'),
      JSON.stringify({
        formato: 1, tipo: 'exportacion-logica', restaurable: false, creado: '2026-11-17T10:00:00Z',
        alcance: { tipo: 'inquilino', tenantId: 't1', tenantNombre: 'Demo Respaldo SA' },
        esquema: { ultimaMigracion: '335_x', migracionesAplicadas: 335 }, bytes: 8, sha256: sha('export c'),
      })
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a status filter and a scope filter are usage errors, in both languages', async () => {
    const status = (await cli(['list', '--target', dir, '--status', 'ok'])).errs[0] as CliError;
    expect(status.message).toBe('`backup list` has no status to filter: a backup is a file, not a document with a lifecycle.');
    const scope = (await cli(['list', '--target', dir, '--entity', 'e1'])).errs[0] as CliError;
    expect(scope.message).toContain('`backup list` inventories a DIRECTORY, and it does not filter by scope yet');
    expect(scope.localized('es')).toContain('`backup list` inventaría un DIRECTORIO');
  });

  it('the table speaks English under en-US', async () => {
    const r = await cli(['list', '--target', dir]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain('installation (3 tenants)');
    expect(r.out).toContain('(no manifest)');
    expect(r.out).toContain('2026-11-19 (0 findings)');
    expect(r.out).toContain('never');
    expect(r.out).toContain('n/a (export, not restorable)');
    expect(r.out).toContain('yes');
  });

  it('the table speaks Spanish under es-MX', async () => {
    setLanguage('es');
    const r = await cli(['list', '--target', dir]);
    expect(r.out).toContain('instalación (3 inquilinos)');
    expect(r.out).toContain('(sin manifiesto)');
    expect(r.out).toContain('2026-11-19 (0 hallazgos)');
    expect(r.out).toContain('nunca');
    expect(r.out).toContain('n/a (exportación, no restaurable)');
    expect(r.out).toContain('sí');
    expect(r.out).not.toContain('(no manifest)');
  });

  it('--json keeps the English cells under es-MX', async () => {
    setLanguage('es');
    const r = await cli(['list', '--target', dir, '--json']);
    expect(r.out).toContain('installation (3 tenants)');
    expect(r.out).toContain('(no manifest)');
    expect(r.out).toContain('"yes"');
    expect(r.out).toContain('n/a (export, not restorable)');
    expect(r.out).not.toContain('sin manifiesto');
    expect(r.out).not.toContain('inquilinos)');
  });

  it('a file that is not there is a usage error', async () => {
    const r = await cli(['verify', join(dir, 'missing.dump')]);
    expect((r.errs[0] as CliError).message).toBe(`The backup ${join(dir, 'missing.dump')} was not found`);
  });

  it('the plain verify says the hash matches, and that it proves nothing about restoring', async () => {
    const r = await cli(['verify', join(dir, 'a-20261119.dump')]);
    expect(r.out).toBe('✔ hash and manifest match · schema 335_x\n');
    expect(r.err).toBe(
      '  This does NOT prove the backup restores. An untested backup is not a backup: run it again with --restore.\n'
    );
  });

  it('a tampered file does not match, and says it in Spanish too', async () => {
    const r = await cli(['verify', join(dir, 'd-20261116.dump')]);
    expect(r.out).toContain('✘ the hash does NOT match the manifest · schema 335_x');
    expect(r.codes[0]).toBe(4);
    setLanguage('es');
    const spanish = await cli(['verify', join(dir, 'd-20261116.dump')]);
    expect(spanish.out).toContain('✘ el hash NO cuadra con el manifiesto · esquema 335_x');
  });
});

describe('I8.6 · backup verify --restore speaks by key', () => {
  const finding = { entidad: 'Demo', check: 'balance', severity: 'warning', referencia: '', detalle: 'd' };

  it('says it restored, what it checked and that the hash does not match', async () => {
    vi.mocked(service.verificarRespaldo).mockResolvedValue({
      archivo: DUMP, restauro: true, integro: false, hallazgos: [finding, finding], entidadesRevisadas: 1, detalle: 'x',
    });
    const r = await cli(['verify', DUMP, '--restore']);
    expect(r.out).toContain('✔ restored into a throwaway database · 1 entity checked · 2 findings\n');
    expect(r.out).toContain('  ✘ the hash does NOT match the manifest\n');
  });

  it('a dump that did not restore, in Spanish', async () => {
    vi.mocked(service.verificarRespaldo).mockResolvedValue({
      archivo: DUMP, restauro: false, integro: true, hallazgos: [finding], entidadesRevisadas: 2, detalle: 'x',
    });
    setLanguage('es');
    const r = await cli(['verify', DUMP, '--restore']);
    expect(r.out).toContain('✘ NO restauró · 2 entidades revisadas · 1 hallazgo\n');
  });
});

describe('I8.6 · backup restore speaks by key', () => {
  const RESTORE = ['restore', 'x.dump', '--target', 'restored_db'];

  beforeEach(() => {
    vi.mocked(service.restaurarRespaldo).mockClear().mockResolvedValue({ archivo: 'x.dump', destino: 'restored_db', creada: true });
  });

  it('the dry run says what it would do, in both languages', async () => {
    const r = await cli([...RESTORE, '--dry-run']);
    expect(r.out).toBe(
      'Would restore x.dump into a NEW database "restored_db"\n' +
        '  Nothing is written, and no existing database is ever touched.\n'
    );
    setLanguage('es');
    const spanish = await cli([...RESTORE, '--dry-run']);
    expect(spanish.out).toContain('Restauraría x.dump en una base NUEVA «restored_db»');
  });

  it('asks before creating the database, in both languages', async () => {
    const asked: string[] = [];
    await cli(RESTORE, async (q) => { asked.push(q); return true; });
    setLanguage('es');
    await cli(RESTORE, async (q) => { asked.push(q); return true; });
    expect(asked).toEqual([
      'Create database "restored_db" and restore x.dump into it?',
      '¿Crear la base «restored_db» y restaurar x.dump en ella?',
    ]);
  });

  it('without a terminal it repeats the question and names --yes, in both languages', async () => {
    const r = await cli(RESTORE);
    const e = r.errs[0] as CliError;
    expect(e.message).toBe(
      'Create database "restored_db" and restore x.dump into it? — there is no terminal to ask on. ' +
        'Re-run with --yes once you are sure.'
    );
    expect(e.localized('es')).toBe(
      '¿Crear la base «restored_db» y restaurar x.dump en ella? — no hay terminal donde preguntar. ' +
        'Vuelve a correrlo con --yes cuando estés seguro.'
    );
    expect(service.restaurarRespaldo).not.toHaveBeenCalled();
  });

  it('on a terminal, an answer it cannot read is taken as a no', async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await cli(RESTORE);
      expect((r.errs[0] as CliError).message).toMatch(/“quizá”.*; I take it as a no\.$/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('a done restore says where, and what is still the operator’s to do', async () => {
    const r = await cli([...RESTORE, '--yes']);
    expect(r.out).toBe(
      '✔ restored into the database restored_db\n' +
        '  The previous database is still intact: pointing the application at the new one is a separate act.\n' +
        '  Check it first: mnemosine backup verify x.dump --restore\n'
    );
  });

  it('a key it does not honour is refused with its reason', async () => {
    const r = await cli([...RESTORE, '--yes', '--idempotency-key', 'k1']);
    expect((r.errs[0] as CliError).message).toContain('a retry restores again over what was already restored');
  });

  it('says in English what it writes, for the audit trail', async () => {
    const r = await cli([...RESTORE, '--dry-run']);
    const leaf = r.program.commands.find((c) => c.name() === 'backup')!.commands.find((c) => c.name() === 'restore')!;
    expect(riskOf(leaf)!.writes).toBe('creates a new database and fills it with the dump');
  });
});

// ============================================================
// I8.6 · part 2 (MNE-001-224): audit, ai, jobs and webhook-sweep
// ============================================================

type Register = (program: Command, deps: {
  palette: typeof PALETTE;
  shutdown: (code: number) => never;
  reportError: (err: unknown) => void;
  home: string;
}) => void;

async function leaf(register: Register, args: string[]) {
  resetDeclarations();
  const codes: number[] = [];
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  register(program, {
    palette: PALETTE,
    shutdown: ((c: number) => { codes.push(c); }) as unknown as (code: number) => never,
    reportError: (e: unknown) => { errs.push(e); },
    home: '/tmp/mnemosine-tests-no-home',
  });
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', ...args]);
  } catch (e) {
    // An option's own parser throws out of parseAsync, before the action.
    errs.push(e);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { codes, out, err, errs, program };
}

const audit = (args: string[]) => leaf(registerAuditCommand as unknown as Register, ['audit', ...args, '--entity', 'ent-1']);
const auditError = async (args: string[]) => (await audit(args)).errs[0] as CliError;

const AUDIT_ROW = {
  id: 'a1', timestamp: new Date('2026-11-20T10:00:00Z'), actor: null, action: 'post', entity_type: 'journal_entries',
  entity_id: 'je-1', old_values: null, new_values: { status: 'posted' }, reason: null,
};

describe('I8.6 · audit list speaks by key', () => {
  beforeEach(() => vi.mocked(query).mockReset().mockResolvedValue({ rows: [] } as never));

  it('an unreal date is the shared date error, in both languages', async () => {
    const e = await auditError(['list', '--since', '2026-02-31']);
    expect(e.message).toBe('--since must be a real date in YYYY-MM-DD form; got "2026-02-31".');
    expect(e.localized('es')).toBe('--since debe ser una fecha real en formato YYYY-MM-DD; llegó "2026-02-31".');
  });

  it('a limit of zero and a negative offset are usage errors', async () => {
    expect((await auditError(['list', '--limit', '0'])).message).toBe('--limit must be a positive whole number; got "0".');
    expect((await auditError(['list', '--offset=-1'])).message).toBe('--offset must be a non-negative whole number; got "-1".');
  });

  it('an unknown action names the vocabulary, in both languages', async () => {
    const e = await auditError(['list', '--action', 'erase']);
    expect(e.message).toBe(
      'Unknown action "erase". The vocabulary is fixed by the CHECK of audit_log (migration 001): ' +
        'create, update, delete, post, void, approve, close, reopen.'
    );
    expect(e.localized('es')).toContain('Acción desconocida «erase». El vocabulario lo fija el CHECK de audit_log');
  });

  it('the agent cannot be filtered yet, and a made-up actor is a usage error', async () => {
    const blocked = await auditError(['list', '--actor', 'agent']);
    expect(blocked.message).toContain('The trail does not tell the agent apart yet: `audit_log` has no actor column');
    expect(blocked.message).toContain('Filtering by "agent" would return zero rows');
    expect((await auditError(['list', '--actor', 'robot'])).message).toBe(
      '--actor only accepts "human", "agent" or "agent:<session>"; got "robot".'
    );
  });

  it('an unknown family and a family that does not hold the type are usage errors', async () => {
    expect((await auditError(['list', '--object', 'payroll'])).message).toBe(
      'Unknown object family "payroll". Known: ledger, period, bank, ar, ap, asset, fiscal. ' +
        'For an exact value of the column use --entity-type.'
    );
    expect((await auditError(['list', '--object', 'bank', '--entity-type', 'invoices'])).message).toBe(
      '--object "bank" and --entity-type "invoices" do not intersect: the family does not contain that type. Give one of the two.'
    );
  });

  it('an email that does not exist is not found, and the trail is not filtered', async () => {
    const e = await auditError(['list', '--user', 'nobody@demo.test']);
    expect(e.message).toBe(
      'User "nobody@demo.test" in this tenant. The trail was not filtered: an email that does not exist ' +
        'would return zero rows and read as if that person did nothing.'
    );
  });

  it('no rows says whose the trail is', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ n: '0' }] } as never).mockResolvedValueOnce({ rows: [] } as never);
    const r = await audit(['list']);
    expect(r.err).toContain('No rows. The trail belongs to the TENANT: `audit_log` has no legal-entity column');
  });

  it('a removed user is labelled in the table, in both languages, and stays English in --json', async () => {
    const twice = () =>
      vi.mocked(query).mockResolvedValueOnce({ rows: [{ n: '1' }] } as never).mockResolvedValueOnce({ rows: [AUDIT_ROW] } as never);
    twice();
    expect((await audit(['list'])).out).toContain('(user removed)');
    setLanguage('es');
    twice();
    const spanish = await audit(['list']);
    expect(spanish.out).toContain('(usuario dado de baja)');
    twice();
    const json = await audit(['list', '--json']);
    expect(json.out).toContain('(user removed)');
    expect(json.out).not.toContain('dado de baja');
  });

  it('the label passes an email through', () => {
    expect(actorLabel('ana@demo.test')).toBe('ana@demo.test');
  });
});

describe('I8.6 · audit show speaks by key', () => {
  beforeEach(() => vi.mocked(query).mockReset().mockResolvedValue({ rows: [{ ...AUDIT_ROW, new_values: null, request_id: null, ip_address: null }] } as never));

  it('the human block, in English', async () => {
    const r = await audit(['show', 'a1']);
    expect(r.out).toBe(
      'post journal_entries je-1\n' +
        '  when 2026-11-20T10:00:00.000Z\n' +
        "  who  (unknown user: the log is append-only and outlives the user's record)\n" +
        '  why  (no reason recorded)\n' +
        '  no values: the row records the act, not the before and the after\n'
    );
  });

  it('the human block, in Spanish, aligned as before', async () => {
    setLanguage('es');
    const r = await audit(['show', 'a1']);
    expect(r.out).toContain('  cuándo  2026-11-20T10:00:00.000Z\n');
    expect(r.out).toContain('  quién   (usuario desconocido: la bitácora es de sólo agregar y sobrevive al alta)\n');
    expect(r.out).toContain('  por qué (sin razón registrada)\n');
    expect(r.out).toContain('  sin valores: la fila registra el acto, no el antes y el después\n');
  });
});

describe('I8.6 · ai stats speaks by key', () => {
  const summary = (partial: Record<string, unknown> = {}) => ({
    borradores_total: 12, decididos: 8, aprobados_humano: 4, aprobados_politica: 1, auto_posteados: 1,
    rechazados: 2, pendientes: 4, tasa_intervencion_humana: '0.750', corridas_ingesta: 1,
    borradores_de_ingesta: 1, costo_ingesta_usd: '0.02', costo_por_borrador_usd: '0.02',
    llamadas_con_duracion: 3, duracion_promedio_ms: 900, duracion_p95_ms: 1500,
    eventos: { sospecha: 1, nudge: 0, failover: 2 }, ...partial,
  });
  const statsOf = (partial: Record<string, unknown> = {}) =>
    vi.mocked(stats.estadisticasDelAgente).mockResolvedValue({
      buckets: [],
      resumen: summary(partial),
      sombra: { veredictos: 5, dias_con_veredictos: 1, decididos: 3, tasa_acuerdo: '0.900' },
    } as never);
  const aiStats = () => leaf(registerAiCommand as unknown as Register, ['ai', 'stats', '--entity', 'ent-1']);

  it('every line of the summary, in English', async () => {
    statsOf();
    const r = await aiStats();
    expect(r.errs).toEqual([]);
    expect(r.err).toContain('ai stats · Demo Agente SA · 12 drafts, 8 decided\n');
    expect(r.err).toContain('human intervention 0.750 (4 approved + 2 rejected of 8 decided; 1 by policy, 1 auto-posted)\n');
    expect(r.err).toContain('ingest: 1 run, 1 draft, ~$0.02 USD per draft (total $0.02)\n');
    expect(r.err).toContain('model latency: 900 ms average, 1500 ms p95 (3 calls measured)\n');
    expect(r.err).toContain('events: 1 injection suspicion, 0 grounding nudges, 2 failovers\n');
    expect(r.err).toContain(
      'shadow: 5 verdicts over 1 day, 3 decided by a person, agreement 0.900 (turning "on" requires ≥7 days, ≥10 decided and ≥0.90)\n'
    );
  });

  it('an ingest with no price says the cost cannot be estimated', async () => {
    statsOf({ corridas_ingesta: 2, borradores_de_ingesta: 3, costo_por_borrador_usd: null, costo_ingesta_usd: null });
    expect((await aiStats()).err).toContain('ingest: 2 runs, 3 drafts, cost not estimable (model without a price)\n');
  });

  it('the summary in Spanish, with its plurals', async () => {
    statsOf({ llamadas_con_duracion: 1 });
    setLanguage('es');
    const r = await aiStats();
    expect(r.err).toContain('ai stats · Demo Agente SA · 12 borradores, 8 decididos');
    expect(r.err).toContain('intervención humana 0.750 (4 aprobados + 2 rechazados de 8 decididos;');
    expect(r.err).toContain('ingesta: 1 corrida, 1 borrador, ~$0.02 USD por borrador (total $0.02)');
    expect(r.err).toContain('(1 llamada medida)');
    expect(r.err).toContain('eventos: 1 sospecha de inyección, 0 nudges de grounding, 2 failovers');
    expect(r.err).toContain('sombra: 5 veredictos en 1 día, 3 decididos por humano, acuerdo 0.900 (encender «on» exige ≥7 días, ≥10 decididos y ≥0.90)');
  });

  it('the help of the family and of the leaf is English', async () => {
    statsOf();
    const r = await aiStats();
    const family = r.program.commands.find((c) => c.name() === 'ai')!;
    expect(family.description()).toBe('Metrics and calibration of the accounting agent');
    expect(family.commands.find((c) => c.name() === 'stats')!.description()).toBe(
      'Approval by confidence bucket, confidence-vs-reality delta, cost and events'
    );
  });
});

describe('I8.6 · jobs and webhook-sweep say what they write in English', () => {
  it('jobs run-due refuses a key it does not honour, with its reason', async () => {
    const register: Register = (p, deps) =>
      registerJobsCommand(p, { ...deps, makeRunAgentTurn: () => (async () => ({})) as never });
    const r = await leaf(register, ['jobs', 'run-due', '--entity', 'ent-1', '--yes', '--idempotency-key', 'k1']);
    expect((r.errs[0] as CliError).message).toContain('a retry runs the due jobs again');
    const runDue = r.program.commands.find((c) => c.name() === 'jobs')!.commands.find((c) => c.name() === 'run-due')!;
    expect(riskOf(runDue)!.writes).toBe(
      "job_runs; and runs the work of each due job — with --live, with reads against the client's external system"
    );
  });

  it('subscription delivery sweep declares its writes and why it needs no key', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerWebhookSweepCommand(program.command('subscription'), {
      palette: PALETTE, shutdown: (() => undefined) as never, reportError: () => undefined,
    });
    const sweep = program.commands[0].commands.find((c) => c.name() === 'delivery')!.commands.find((c) => c.name() === 'sweep')!;
    const risk = riskOf(sweep)!;
    expect(risk.writes).toBe(
      "webhook_deliveries (status, attempt_count, next_retry_at, error_message); and POSTs the original event to each subscription's URL"
    );
    expect(risk.llave).toEqual({
      innecesaria:
        'each delivery already carries its own stable key (X-Webhook-ID), and deduplicating whole sweeps WOULD SKIP due deliveries',
    });
  });
});
