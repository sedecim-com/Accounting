import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { runDoctor,
  checkAccountRoles,
  checkLookupTables,
  checkOrphanedCapability,
  claseDe,
  LOOKUP_TABLES,
} from '../../src/ai/doctor-service.js';
import { query } from '../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

/** Answers by mentioned table; defensive with missing args. */
function mockDb(over: Partial<Record<string, unknown[]>> = {}) {
  mockQuery.mockImplementation((sql?: unknown) => {
    const q = typeof sql === 'string' ? sql : '';
    if (q.includes('version()')) return Promise.resolve({ rows: over.version ?? [{ v: 'PostgreSQL 15.17 on x86_64' }] });
    if (q.includes('public.migrations')) return Promise.resolve({ rows: over.migrations ?? [] });
    if (q.includes('legal_entities')) return Promise.resolve({ rows: over.entities ?? [{ n: '1' }] });
    if (q.includes('pg_roles')) return Promise.resolve({ rows: over.roles ?? [{ current_user: 'app', is_super: false, bypass: false, rls_tables: '57' }] });
    if (q.includes('ai_drafts')) return Promise.resolve({ rows: over.pending ?? [{ drafts: '0', questions: '0', ops: '0' }] });
    if (q.includes('fiscal_credentials')) return Promise.resolve({ rows: over.creds ?? [{ n: '0', soonest: null }] });
    return Promise.resolve({ rows: [] });
  });
}

let tmpDir: string;
const ENV = { ...process.env };

beforeEach(() => {
  mockQuery.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  delete process.env.MNEMOSINE_PROVIDER;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...ENV };
});

function find(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`missing check "${name}"`);
  return c;
}

describe('runDoctor — database', () => {
  it('reports the version when it connects', async () => {
    mockDb();
    const r = await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir });
    expect(find(r, 'Database').level).toBe('ok');
    expect(find(r, 'Database').detail).toBe('PostgreSQL 15.17');
  });

  it('when the DB fails, SKIPS the checks that depend on it', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir });
    expect(find(r, 'Database').level).toBe('fail');
    expect(r.checks.find((c) => c.name === 'Migrations')).toBeUndefined();
    expect(r.worst).toBe('fail');
    // Those that do not depend on the DB still run
    expect(r.checks.find((c) => c.name === 'Encryption key')).toBeDefined();
  });
});

describe('runDoctor — migrations', () => {
  it('detects unapplied migrations and gives the command', async () => {
    fs.writeFileSync(path.join(tmpDir, '001_a.sql'), '');
    fs.writeFileSync(path.join(tmpDir, '002_b.sql'), '');
    mockDb({ migrations: [{ filename: '001_a.sql' }] });
    const r = await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir });
    const c = find(r, 'Migrations');
    expect(c.level).toBe('fail');
    expect(c.detail).toMatch(/1 unapplied: 002_b\.sql/);
    expect(c.fix).toBe('npm run migrate');
  });

  it('ok when all are applied', async () => {
    fs.writeFileSync(path.join(tmpDir, '001_a.sql'), '');
    mockDb({ migrations: [{ filename: '001_a.sql' }] });
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Migrations').level).toBe('ok');
  });
});

describe('runDoctor — tenant isolation', () => {
  it('WARNS that RLS is inert with a SUPERUSER role', async () => {
    mockDb({ roles: [{ current_user: 'victor', is_super: true, bypass: false, rls_tables: '57' }] });
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Tenant isolation');
    expect(c.level).toBe('warn');
    expect(c.detail).toMatch(/SUPERUSER/);
    expect(c.fix).toMatch(/mnemosine_app/);
  });

  it('also warns with BYPASSRLS', async () => {
    mockDb({ roles: [{ current_user: 'app', is_super: false, bypass: true, rls_tables: '57' }] });
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Tenant isolation').detail)
      .toMatch(/BYPASSRLS/);
  });

  it('warns when RLS is not enabled on any table', async () => {
    mockDb({ roles: [{ current_user: 'app', is_super: false, bypass: false, rls_tables: '0' }] });
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Tenant isolation');
    expect(c.level).toBe('warn');
    expect(c.detail).toMatch(/not enabled/);
  });

  it('ok when the role is subject to policies', async () => {
    mockDb();
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Tenant isolation').level).toBe('ok');
  });
});

describe('runDoctor — fiscal credentials', () => {
  const now = new Date('2026-08-24T00:00:00Z');

  it('no credentials is OK (they are not required)', async () => {
    mockDb();
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir, now }), 'Fiscal credentials').level).toBe('ok');
  });

  it('warns when it expires in less than 30 days', async () => {
    mockDb({ creds: [{ n: '1', soonest: '2026-09-10T00:00:00Z' }] });
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir, now }), 'Fiscal credentials');
    expect(c.level).toBe('warn');
    expect(c.detail).toMatch(/expires in 17 days/);
  });

  it('FAILS when it has already expired', async () => {
    mockDb({ creds: [{ n: '1', soonest: '2026-08-01T00:00:00Z' }] });
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir, now }), 'Fiscal credentials');
    expect(c.level).toBe('fail');
    expect(c.detail).toMatch(/ALREADY EXPIRED/);
  });
});

describe('runDoctor — model provider', () => {
  it('ok with a local provider without a credential', async () => {
    mockDb();
    fs.writeFileSync(path.join(tmpDir, 'mnemosine.config.json'), JSON.stringify({
      default_provider: 'local', providers: { local: { type: 'openai-compatible', model: 'm', base_url: 'http://x/v1' } },
    }));
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Model provider');
    expect(c.level).toBe('ok');
    expect(c.detail).toMatch(/local, no credential/);
  });

  it('FAILS when the default requires a missing key, and suggests a viable alternative', async () => {
    mockDb();
    delete process.env.SOME_KEY;
    fs.writeFileSync(path.join(tmpDir, 'mnemosine.config.json'), JSON.stringify({
      default_provider: 'remoto',
      providers: {
        remoto: { type: 'openai-compatible', model: 'm', base_url: 'http://x/v1', api_key_env: 'SOME_KEY' },
        localito: { type: 'openai-compatible', model: 'm2', base_url: 'http://y/v1' },
      },
    }));
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Model provider');
    expect(c.level).toBe('fail');
    expect(c.detail).toMatch(/SOME_KEY/);
    expect(c.fix).toMatch(/--provider/);
  });
});

describe('runDoctor — encryption key', () => {
  it('FAILS with the example key (zeros)', async () => {
    mockDb();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const c = find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Encryption key');
    expect(c.level).toBe('fail');
    expect(c.detail).toMatch(/EXAMPLE/);
    expect(c.fix).toMatch(/openssl rand -hex 32/);
  });

  it('FAILS with an invalid length', async () => {
    mockDb();
    process.env.ENCRYPTION_KEY = 'abc';
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Encryption key').level).toBe('fail');
  });

  it('ok with an own 64-hex key', async () => {
    mockDb();
    expect(find(await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir }), 'Encryption key').level).toBe('ok');
  });
});

describe('runDoctor — aggregated severity', () => {
  it('worst = fail if there is any failure', async () => {
    mockDb();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    expect((await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir })).worst).toBe('fail');
  });

  it('worst = warn when there are only warnings', async () => {
    mockDb({ roles: [{ current_user: 'victor', is_super: true, bypass: false, rls_tables: '57' }] });
    fs.writeFileSync(path.join(tmpDir, 'mnemosine.config.json'), JSON.stringify({
      default_provider: 'local', providers: { local: { type: 'openai-compatible', model: 'm', base_url: 'http://x/v1' } },
    }));
    expect((await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir })).worst).toBe('warn');
  });

  it('every check with a problem carries an actionable fix', async () => {
    mockDb({ roles: [{ current_user: 'victor', is_super: true, bypass: false, rls_tables: '57' }] });
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const r = await runDoctor({ migrationsDir: tmpDir, cwd: tmpDir });
    for (const c of r.checks.filter((x) => x.level !== 'ok')) {
      expect(c.fix, `"${c.name}" does not say how to fix it`).toBeTruthy();
    }
  });
});

describe('checkAccountRoles', () => {
  it('falla y da el comando cuando una entidad no tiene roles sembrados', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { entidad: 'e1', nombre: 'Nueva SA', mapeados: '0', total: '0' },
        { entidad: 'e2', nombre: 'Otra SA', mapeados: '31', total: '31' },
      ],
    });
    const r = await checkAccountRoles();
    expect(r.level).toBe('fail');
    expect(r.detail).toContain('Nueva SA');
    expect(r.fix).toBe('mnemosine init --section identity');
  });

  it('reporta el total mapeado cuando todas están sembradas', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ entidad: 'e1', nombre: 'Demo', mapeados: '31', total: '31' }],
    });
    const r = await checkAccountRoles();
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('31');
  });

  it('no se queja si no hay entidades activas', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect((await checkAccountRoles()).level).toBe('ok');
  });
});

// ============================================================
// Lookup tables with a reader and no writer are the worst failure mode in
// the system: the capability looks present, and the first real use dies
// deep inside a posting routine. doctor should say so BEFORE that happens
// — but only for an entity that actually uses the capability, or people
// learn to ignore it.
// ============================================================

describe('checkLookupTables', () => {
  it('says nothing is wrong when no entity uses the capability', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const results = await checkLookupTables();
    expect(results).toHaveLength(LOOKUP_TABLES.length);
    for (const r of results) {
      expect(r.level).toBe('ok');
      expect(r.detail).toMatch(/no entity uses this capability yet/);
    }
  });

  it('fails when an entity that runs payroll has no GL mapping, and names the consequence', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/payroll_account_mapping/.test(sql)) {
        return { rows: [{ nombre: 'Cliente SA', n: '0' }] };
      }
      return { rows: [] };
    });
    const payroll = (await checkLookupTables()).find((r) => r.name === 'Payroll GL mapping')!;
    expect(payroll.level).toBe('fail');
    expect(payroll.detail).toMatch(/Cliente SA/);
    expect(payroll.detail).toMatch(/a pay run cannot post/);
    expect(payroll.fix).toMatch(/seedPayrollAccountMapping/);
  });

  it('only warns for the SAT code map, because inference degrades rather than breaks', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/sat_code_mappings/.test(sql)) return { rows: [{ nombre: 'Demo Corp MX', n: '0' }] };
      return { rows: [] };
    });
    const sat = (await checkLookupTables()).find((r) => r.name === 'SAT product-code mapping')!;
    expect(sat.level).toBe('warn');
    expect(sat.detail).toMatch(/still works/);
  });

  it('reports the row count when the tables are populated', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/payroll_account_mapping/.test(sql)) return { rows: [{ nombre: 'Cliente SA', n: '8' }] };
      return { rows: [] };
    });
    const payroll = (await checkLookupTables()).find((r) => r.name === 'Payroll GL mapping')!;
    expect(payroll.level).toBe('ok');
    expect(payroll.detail).toMatch(/8 row\(s\) across 1 entity/);
  });

  it('catches a PARTIALLY mapped table and names the missing bucket', async () => {
    // The harder failure: rows exist, so a row-count check says "ok", and the
    // pay run dies on the one bucket nobody mapped. This is what happens on an
    // onboarded chart, where the bank account is the firm's own choice.
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/unnest/.test(sql) && /payroll_account_mapping/.test(sql)) {
        void params;
        return { rows: [{ nombre: 'Nueva Empresa SA', faltantes: 'cash_payroll' }] };
      }
      if (/payroll_account_mapping/.test(sql)) return { rows: [{ nombre: 'Nueva Empresa SA', n: '6' }] };
      return { rows: [] };
    });
    const payroll = (await checkLookupTables()).find((r) => r.name === 'Payroll GL mapping')!;
    expect(payroll.level).toBe('fail');
    expect(payroll.detail).toMatch(/cash_payroll/);
    expect(payroll.detail).toMatch(/Nueva Empresa SA/);
  });

  it('passes when every required bucket is mapped', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/unnest/.test(sql)) return { rows: [{ nombre: 'Cliente SA', faltantes: null }] };
      if (/payroll_account_mapping/.test(sql)) return { rows: [{ nombre: 'Cliente SA', n: '8' }] };
      return { rows: [] };
    });
    const payroll = (await checkLookupTables()).find((r) => r.name === 'Payroll GL mapping')!;
    expect(payroll.level).toBe('ok');
  });

  it('gates each table on the capability actually being in use', () => {
    // Without appliesWhen, every entity without employees would be reported
    // as broken payroll — noise that teaches people to skip doctor.
    for (const spec of LOOKUP_TABLES) {
      expect(spec.appliesWhen, `${spec.table} must state when it applies`).toBeDefined();
      expect(spec.breaks.length).toBeGreaterThan(20);
      expect(spec.fix.length).toBeGreaterThan(5);
    }
  });
});

describe('checkOrphanedCapability', () => {
  it('says so when there is no source tree instead of passing on nothing', () => {
    // A packaged install runs from dist/. A green tick that checked nothing is
    // the failure mode this whole check exists to remove.
    const r = checkOrphanedCapability({ cwd: tmpDir });
    expect(r.level).toBe('ok');
    expect(r.detail).toMatch(/source/i);
  });

  it('reports the repository it is run from, with its denominators', () => {
    const r = checkOrphanedCapability({ cwd: process.cwd() });
    expect(r.name).toBe('Orphaned capability');
    expect(r.detail).toMatch(/of \d+ tables and \d+ exports/);
  });

  it('never fails the run, and that is structural rather than pending', () => {
    // La gravedad de un huérfano depende de si ESTA instalación usa la
    // capacidad, y esto lee src/, no la base. Lo que merece 'fail' se gradúa a
    // LOOKUP_TABLES, donde appliesWhen sí puede preguntarlo.
    expect(checkOrphanedCapability({ cwd: process.cwd() }).level).not.toBe('fail');
  });

  it('ordena por consecuencia: primero lo que puede falsear una cifra', () => {
    const detalle = checkOrphanedCapability({ cwd: process.cwd() }).detail;
    const cifra = detalle.indexOf('figure');
    const muerto = detalle.indexOf('unreferenced');
    expect(cifra).toBeGreaterThanOrEqual(0);
    expect(muerto).toBeGreaterThan(cifra);
  });

  it('cuenta el peso muerto en vez de enumerarlo', () => {
    // Dieciocho nombres detrás de los dos que importan es lo que hace que se
    // deje de leer el renglón.
    const detalle = checkOrphanedCapability({ cwd: process.cwd() }).detail;
    expect(detalle).not.toContain('getCachedAccounts');
    expect(detalle).toMatch(/\d+ unreferenced export\(s\)/);
  });

  it('no repite lo que checkLookupTables ya vigila con nivel propio', () => {
    // employer_tax_liabilities se graduó allí: decirlo dos veces con dos
    // niveles distintos enseña a leer el más suave.
    const detalle = checkOrphanedCapability({ cwd: process.cwd() }).detail;
    for (const spec of LOOKUP_TABLES) expect(detalle).not.toContain(spec.table);
  });

  it('clasifica por la FORMA del daño, no por el tipo de objeto', () => {
    expect(claseDe({ kind: 'tabla', name: 'paycheck_taxes', where: 'x', consequence: 'y' })).toBe('numero-falso');
    expect(claseDe({ kind: 'tabla', name: 'garnishments', where: 'x', consequence: 'y' })).toBe('sin-puerta');
    expect(claseDe({ kind: 'funcion', name: 'getCachedAccounts', where: 'x', consequence: 'y' })).toBe('peso-muerto');
  });

  it('offers a fix that names the two ways out', () => {
    const r = checkOrphanedCapability({ cwd: process.cwd() });
    expect(r.fix).toMatch(/delete/i);
  });
});

describe('employer_tax_liabilities, graduada a LOOKUP_TABLES', () => {
  it('está gated en que la entidad tenga empleados en EE.UU.', () => {
    // Sin appliesWhen pondría en rojo a todo despacho mexicano, que es
    // exactamente lo que enseña a ignorar doctor.
    const spec = LOOKUP_TABLES.find((t) => t.table === 'employer_tax_liabilities')!;
    expect(spec.appliesWhen?.table).toBe('employees');
    expect(spec.appliesWhen?.where).toContain("country_code = 'US'");
  });

  it('es la única que llega a fail junto al mapeo de nómina, y dice por qué', () => {
    const spec = LOOKUP_TABLES.find((t) => t.table === 'employer_tax_liabilities')!;
    expect(spec.level).toBe('fail');
    // Lo que la distingue de las demás huérfanas: la forma se PRESENTA.
    expect(spec.breaks).toMatch(/940|941/);
    expect(spec.breaks).toMatch(/ZERO|zero/);
  });
});
