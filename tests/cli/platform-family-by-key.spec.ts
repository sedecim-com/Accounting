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
}));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'quizá'), close: vi.fn() })),
}));

import { exportReport, registerBackupCommand } from '../../src/cli/backup-command.js';
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
