import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// La sección siembra catálogo y account_roles al crear la entidad: se mockea
// el servicio para que estas pruebas sigan siendo sobre la identidad, y se
// asevera aparte que la llamada ocurre.
const { sembrarContabilidad, altaDeEntidad } = vi.hoisted(() => ({
  sembrarContabilidad: vi.fn(),
  altaDeEntidad: vi.fn(),
}));
// El asistente ya no hace el alta a mano: delega en el servicio de entidad,
// que es quien se niega a adivinar el inquilino cuando hay varios.
vi.mock('../../../src/services/entity/entity-service.js', () => ({
  createEntity: (...a: unknown[]) => altaDeEntidad(...a),
}));
vi.mock('../../../src/services/accounting/entity-accounting.js', () => ({
  ensureEntityAccounting: (...a: unknown[]) => sembrarContabilidad(...a),
}));

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { InfraSection, upsertEnvVar, readEnvVar } from '../../../src/cli/init/s0-infra.js';
import { IdentidadSection } from '../../../src/cli/init/s1-identity.js';
import { UsuariosSection, ROLES } from '../../../src/cli/init/s2-users.js';
import { IaSection, categorizeProbeError } from '../../../src/cli/init/s3-ai.js';
import { buildSections } from '../../../src/cli/init/index.js';
import { BUILTIN_PROFILES, resolveProfile, ventanaDe } from '../../../src/ai/providers/config.js';
import type { MnemosineConfig } from '../../../src/ai/providers/config.js';
import type { SectionContext } from '../../../src/cli/init/section.js';
import { query, withTransaction, enterTenant, currentTenant } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const mockEnterTenant = enterTenant as unknown as Mock;

let tmp: string;
let homedir: { mockRestore: () => void };
const ENV = { ...process.env };

/** Section context that captures output and answers a fixed script. */
function makeCtx(answers: {
  text?: (string | null)[]; secrets?: (string | null)[]; confirms?: boolean[];
  flags?: Record<string, unknown>;
} = {}): SectionContext & { lines: string[] } {
  const lines: string[] = [];
  const text = [...(answers.text ?? [])];
  const secrets = [...(answers.secrets ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  return {
    rl: null,
    flags: answers.flags ?? {},
    lines,
    print: (l?: string) => lines.push(l ?? ''),
    askText: async (_p: string, fallback?: string) =>
      text.length ? text.shift()! : (fallback ?? null),
    askSecret: async () => (secrets.length ? secrets.shift()! : null),
    confirm: async (_p: string, d = true) => (confirms.length ? confirms.shift()! : d),
  };
}

beforeEach(() => {
    altaDeEntidad.mockReset();
    altaDeEntidad.mockResolvedValue({ tenantId: 'tenant-nuevo', entityId: 'ent-nueva' });
    sembrarContabilidad.mockReset();
    sembrarContabilidad.mockResolvedValue({
      cuentasBaseCreadas: [], accountsCreated: [], rolesMapped: 31,
      unmapped: [], estrategiaAplicada: 'auto', teniaCatalogo: false,
    });
  mockQuery.mockReset();
  mockTx.mockReset();
  mockEnterTenant.mockReset();
  (currentTenant as unknown as Mock).mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.MNEMOSINE_TENANT;
  // Hermetic: a section that falls back to ~/.mnemosine/.env must never touch the real home.
  process.env.HOME = tmp;
  // os.homedir() (the config files' reader and writer) stops following
  // process.env.HOME once afterEach swaps the object, so it is pinned too.
  homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  homedir.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ENV };
});

describe('upsertEnvVar', () => {
  it('creates the .env with 600 permissions (it carries secrets)', () => {
    const p = path.join(tmp, '.env');
    upsertEnvVar(p, 'FOO', 'bar');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(readEnvVar(p, 'FOO')).toBe('bar');
  });

  it('replaces the value without duplicating the variable', () => {
    const p = path.join(tmp, '.env');
    upsertEnvVar(p, 'FOO', 'uno');
    upsertEnvVar(p, 'FOO', 'dos');
    const content = fs.readFileSync(p, 'utf-8');
    expect(content.match(/^FOO=/gm)).toHaveLength(1);
    expect(readEnvVar(p, 'FOO')).toBe('dos');
  });

  it('preserves the other variables', () => {
    const p = path.join(tmp, '.env');
    fs.writeFileSync(p, 'OTRA=intacta\nFOO=viejo\n');
    upsertEnvVar(p, 'FOO', 'nuevo');
    expect(readEnvVar(p, 'OTRA')).toBe('intacta');
  });
});

describe('S0 · Infrastructure', () => {
  it('generates a dedicated ENCRYPTION_KEY when the example one is in use', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    fs.writeFileSync(path.join(tmp, '.env'), '');
    const s = new InfraSection({ cwd: tmp, home: tmp, randomKey: () => 'b'.repeat(64) });
    await s.configure(makeCtx());
    expect(readEnvVar(path.join(tmp, '.env'), 'ENCRYPTION_KEY')).toBe('b'.repeat(64));
    expect(process.env.ENCRYPTION_KEY).toBe('b'.repeat(64));
  });

  it('does NOT regenerate the key if it is already a dedicated one', async () => {
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    fs.writeFileSync(path.join(tmp, '.env'), '');
    const s = new InfraSection({ cwd: tmp, home: tmp, randomKey: () => 'NUEVA' });
    await s.configure(makeCtx());
    expect(readEnvVar(path.join(tmp, '.env'), 'ENCRYPTION_KEY')).not.toBe('NUEVA');
  });

  it('without a database it does not try to migrate (it stops before)', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const runMigrations = vi.fn();
    fs.writeFileSync(path.join(tmp, '.env'), '');
    const s = new InfraSection({ cwd: tmp, home: tmp, runMigrations });
    const ctx = makeCtx({ text: [null] });
    await s.configure(ctx);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(ctx.lines.join('\n')).toMatch(/docker compose up -d postgres/);
  });

  it('offers to apply missing migrations and runs them if you accept', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), '');
    const migDir = path.join(tmp, 'src/database/migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, '001_x.sql'), '');
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('version()')) return Promise.resolve({ rows: [{ v: 'PostgreSQL 15' }] });
      return Promise.resolve({ rows: [] }); // no migration applied
    });
    const runMigrations = vi.fn();
    const s = new InfraSection({ cwd: tmp, runMigrations });
    await s.configure(makeCtx({ confirms: [true] }));
    expect(runMigrations).toHaveBeenCalledOnce();
  });

  describe('where a new .env goes', () => {
    const envOf = (dir: string) => path.join(dir, '.mnemosine', '.env');
    const cwdOnly = () => fs.readdirSync(tmp).filter((f) => f === '.env');
    const interactive = (confirms: boolean[]) => ({ ...makeCtx({ confirms }), rl: {} as never });

    beforeEach(() => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    });

    it('without a terminal and outside a checkout it uses ~/.mnemosine/ and says so', async () => {
      const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      const ctx = makeCtx();
      await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
      expect(readEnvVar(envOf(tmp), 'ENCRYPTION_KEY')).toBe('c'.repeat(64));
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
      expect(ctx.lines.join('\n')).toContain(envOf(tmp));
      expect(fs.statSync(envOf(tmp)).mode & 0o777).toBe(0o600);
    });

    it('without a terminal inside a checkout (.env.example) keeps ./.env, announced', async () => {
      const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      fs.writeFileSync(path.join(cwd, '.env.example'), 'ENCRYPTION_KEY=' + '0'.repeat(64) + '\n');
      const ctx = makeCtx();
      await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
      expect(readEnvVar(path.join(cwd, '.env'), 'ENCRYPTION_KEY')).toBe('c'.repeat(64));
      expect(ctx.lines.join('\n')).toContain(path.join(cwd, '.env'));
    });

    it('with a terminal it asks, and answering no sends the file to ~/.mnemosine/', async () => {
      const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(interactive([false]));
      expect(fs.existsSync(envOf(tmp))).toBe(true);
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    });

    it('with a terminal answering yes writes ./.env', async () => {
      const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(interactive([true]));
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(true);
      expect(fs.existsSync(envOf(tmp))).toBe(false);
    });

    it('an existing ~/.mnemosine/.env is reused without asking or creating another', async () => {
      const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
      fs.mkdirSync(path.dirname(envOf(tmp)), { recursive: true });
      fs.writeFileSync(envOf(tmp), '');
      const ctx = makeCtx();
      await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
      expect(readEnvVar(envOf(tmp), 'ENCRYPTION_KEY')).toBe('c'.repeat(64));
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
      expect(cwdOnly()).toEqual([]);
    });
  });

  it('status reflects the worst check', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64); // fail
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    expect(await new InfraSection({ cwd: tmp }).status()).toBe('missing');
  });
});

describe('S1 · Identity', () => {
  it('status = missing without entities', async () => {
    mockQuery.mockResolvedValue({ rows: [{ entities: '0', periods: '0' }] });
    expect(await new IdentidadSection({ cwd: tmp }).status()).toBe('missing');
  });

  it('status = partial with an entity but no fiscal periods', async () => {
    mockQuery.mockResolvedValue({ rows: [{ entities: '1', periods: '0' }] });
    expect(await new IdentidadSection({ cwd: tmp }).status()).toBe('partial');
  });

  it('verify FAILS if there are no open periods (nothing can be posted)', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('legal_entities')) return Promise.resolve({ rows: [{ n: '1' }] });
      return Promise.resolve({ rows: [{ n: '0' }] });
    });
    const checks = await new IdentidadSection({ cwd: tmp }).verify();
    const period = checks.find((c) => c.name === 'Fiscal year');
    expect(period?.level).toBe('fail');
    expect(period?.detail).toMatch(/no journal entry can be posted/);
  });

  it('seeds chart of accounts and account roles when creating an entity', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT id, name, tax_id, tenant_id')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ n: '12' }] });
    });
    const s = new IdentidadSection({ cwd: tmp });
    await s.configure(makeCtx({ flags: { entity: 'Nueva SA', country: 'MX', rfc: 'XAXX010101000' } }));
    // Sin esta llamada la entidad no puede postear ni una factura:
    // postInvoiceEntry resuelve sus cuentas por account_roles.
    // El alta va por el servicio, no por SQL propio del asistente.
    expect(altaDeEntidad).toHaveBeenCalled();
    expect(altaDeEntidad.mock.calls[0][0]).toMatchObject({
      name: 'Nueva SA', country: 'MX', taxId: 'XAXX010101000',
    });
    // Sin esta llamada la entidad no puede postear ni una factura:
    // postInvoiceEntry resuelve sus cuentas por account_roles.
    expect(sembrarContabilidad).toHaveBeenCalled();
    expect(sembrarContabilidad.mock.calls[0][3]).toMatchObject({ estrategia: 'auto' });
  });

  it('no elige inquilino por su cuenta: le pasa al servicio el fijado', async () => {
    // El camino viejo hacía `SELECT id FROM tenants ORDER BY created_at ASC
    // LIMIT 1`: en una instalación con varios despachos metía la empresa
    // nueva en los libros del MÁS VIEJO, sin decir nada.
    process.env.MNEMOSINE_TENANT = 'tenant-del-usuario';
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT id, name, tax_id, tenant_id')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ n: '12' }] });
    });
    const s = new IdentidadSection({ cwd: tmp });
    await s.configure(makeCtx({ flags: { entity: 'Otra SA', country: 'MX', rfc: 'XAXX010101000' } }));
    expect(altaDeEntidad.mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-del-usuario' });
  });

  it('with existing entities it pins the tenant in .env (RLS from startup)', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT id, name, tax_id, tenant_id')) {
        return Promise.resolve({
          rows: [{ id: 'e1', name: 'Acme', tax_id: 'AME010101AAA', tenant_id: 'tenant-xyz' }],
        });
      }
      return Promise.resolve({ rows: [{ n: '12' }] }); // already has periods
    });
    const s = new IdentidadSection({ cwd: tmp, home: tmp });
    await s.configure(makeCtx({ confirms: [false] })); // do not add another
    expect(readEnvVar(path.join(tmp, '.mnemosine', '.env'), 'MNEMOSINE_TENANT')).toBe('tenant-xyz');
    expect(process.env.MNEMOSINE_TENANT).toBe('tenant-xyz');
  });

  it('does not create an entity if the name is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const s = new IdentidadSection({ cwd: tmp });
    const ctx = makeCtx({ text: [null] }); // no name
    await s.configure(ctx);
    expect(mockTx).not.toHaveBeenCalled();
    expect(ctx.lines.join('\n')).toMatch(/section incomplete/);
  });
});

describe('S2 · Users and roles', () => {
  it('the roles declare permissions consistent with their scope', () => {
    expect(ROLES.owner.permissions).toEqual(['*']);
    expect(ROLES.auditor.permissions).not.toContain('journal_entries:post');
    expect(ROLES.revisor.permissions).toContain('journal_entries:post');
    // The auditor can read the trail; the reviewer does not need it
    expect(ROLES.auditor.permissions).toContain('audit:read');
  });

  it('status = missing without active users', async () => {
    mockQuery.mockResolvedValue({ rows: [{ n: '0', owners: '0' }] });
    expect(await new UsuariosSection().status()).toBe('missing');
  });

  it('status = partial if there are users but no owner', async () => {
    mockQuery.mockResolvedValue({ rows: [{ n: '2', owners: '0' }] });
    expect(await new UsuariosSection().status()).toBe('partial');
  });

  it('verify warns that multiple users force --user', async () => {
    mockQuery.mockResolvedValue({ rows: [{ n: '3', owners: '1' }] });
    const [c] = await new UsuariosSection().verify();
    expect(c.level).toBe('ok');
    expect(c.fix).toMatch(/--user/);
  });

  it('REJECTS a short password and does not write the user', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT email, roles')) return Promise.resolve({ rows: [] });
      if (q.includes('public.tenants')) return Promise.resolve({ rows: [{ id: 't1' }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const ctx = makeCtx({ text: ['nuevo@demo.com', '1'], secrets: ['corto'] });
    await new UsuariosSection().configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/too short/);
    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO users'));
    expect(inserts).toHaveLength(0);
  });

  it('refuses what `user create` refuses: a password bcrypt would truncate, and length in code points', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT email, roles')) return Promise.resolve({ rows: [] });
      if (q.includes('public.tenants')) return Promise.resolve({ rows: [{ id: 't1' }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    // 73 bytes: bcrypt would keep only the first 72.
    const long = makeCtx({ text: ['nuevo@demo.com', '1'], secrets: ['a'.repeat(73)] });
    await new UsuariosSection().configure(long);
    expect(long.lines.join('\n')).toMatch(/too long/);
    // 6 emoji are 12 UTF-16 units but 6 characters: too short for both doors.
    const astral = makeCtx({ text: ['nuevo@demo.com', '1'], secrets: ['\u{1F511}'.repeat(6)] });
    await new UsuariosSection().configure(astral);
    expect(astral.lines.join('\n')).toMatch(/too short/);
    const inserts = mockQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO users'));
    expect(inserts).toHaveLength(0);
  });

  it('hashes the password (never stores it in the clear)', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT email, roles')) return Promise.resolve({ rows: [] });
      if (q.includes('public.tenants')) return Promise.resolve({ rows: [{ id: 't1' }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const secret = 'unPasswordLargoSeguro';
    await new UsuariosSection().configure(
      makeCtx({ text: ['jefe@demo.com', '1'], secrets: [secret] })
    );
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO users'));
    expect(insert).toBeDefined();
    const hash = insert![1][2] as string;
    expect(hash).not.toBe(secret);
    expect(hash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(JSON.stringify(insert![1])).not.toContain(secret);
  });
});

describe('S2 · the tenant a new user joins', () => {
  // `init --section users` used to take `SELECT id FROM tenants ORDER BY
  // created_at LIMIT 1`: once `tenant create` made a second firm reachable, the
  // first login of the new firm landed in the OLDEST one, with its role.
  const TWO = [
    { id: 't-old', name: 'Despacho Viejo' },
    { id: 't-new', name: 'Despacho Norte' },
  ];

  function tenantsAre(rows: Array<{ id: string; name: string }>) {
    mockQuery.mockImplementation((sql?: unknown, params?: unknown[]) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT email, roles')) return Promise.resolve({ rows: [] });
      if (q.includes('public.tenants') && q.includes('WHERE id')) {
        return Promise.resolve({ rows: rows.filter((t) => t.id === params?.[0]) });
      }
      if (q.includes('public.tenants')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }
  const inserts = () =>
    (mockQuery.mock.calls as Array<[string, unknown[]]>).filter((c) => c[0].includes('INSERT INTO users'));
  const answers = { text: ['nueva@norte.mx', '1'], secrets: ['unPasswordLargoSeguro'] };

  it('with two firms and none named it refuses, lists them and writes no user', async () => {
    tenantsAre(TWO);
    const ctx = makeCtx(answers);
    await new UsuariosSection().configure(ctx);
    expect(inserts()).toHaveLength(0);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/--tenant/);
    expect(out).toContain('Despacho Norte → t-new');
  });

  it('with --tenant naming the second firm the user is written under it', async () => {
    tenantsAre(TWO);
    (currentTenant as unknown as Mock).mockReturnValue('t-new');
    await new UsuariosSection().configure(makeCtx(answers));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1][0]).toBe('t-new');
  });

  it('lists only the users of the chosen firm', async () => {
    tenantsAre(TWO);
    (currentTenant as unknown as Mock).mockReturnValue('t-new');
    await new UsuariosSection().configure(makeCtx(answers));
    const listing = mockQuery.mock.calls.find((c) => String(c[0]).includes('SELECT email, roles'));
    expect(String(listing![0])).toMatch(/tenant_id = \$1/);
    expect(listing![1]).toEqual(['t-new']);
  });

  it('MNEMOSINE_TENANT counts as naming the firm', async () => {
    tenantsAre(TWO);
    process.env.MNEMOSINE_TENANT = 't-new';
    await new UsuariosSection().configure(makeCtx(answers));
    expect(inserts()[0][1][0]).toBe('t-new');
  });

  it('a named firm that does not exist is refused, not created', async () => {
    tenantsAre(TWO);
    (currentTenant as unknown as Mock).mockReturnValue('t-ghost');
    const ctx = makeCtx(answers);
    await new UsuariosSection().configure(ctx);
    expect(inserts()).toHaveLength(0);
    expect(ctx.lines.join('\n')).toMatch(/t-ghost.*does not exist/);
  });

  it('with a single firm and none named it uses that one', async () => {
    tenantsAre([TWO[0]]);
    await new UsuariosSection().configure(makeCtx(answers));
    expect(inserts()[0][1][0]).toBe('t-old');
  });
});

describe('S3 · AI provider', () => {
  function writeConfig(cfg: unknown) {
    fs.writeFileSync(path.join(tmp, 'mnemosine.config.json'), JSON.stringify(cfg));
  }

  it('suggests and saves a local provider without asking for a credential', async () => {
    writeConfig({
      default_provider: 'anthropic',
      providers: {
        ollamita: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:11434/v1' },
      },
    });
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    const s = new IaSection({
      cwd: tmp, probe, listOllamaModels: async () => ['gemma4:26b', 'llama3'],
    });
    // --provider forces the profile; without it the suggestion would pick a ready built-in.
    // The profile lives in the project file, so init asks before writing there: Yes.
    const ctx = makeCtx({ flags: { provider: 'ollamita' }, text: ['2'], confirms: [true] });
    await s.configure(ctx);

    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'mnemosine.config.json'), 'utf-8'));
    expect(written.default_provider).toBe('ollamita');
    expect(written.providers.ollamita.model).toBe('llama3');
    expect(ctx.lines.join('\n')).toMatch(/Supports tool-calling/);
  });

  it('WARNS when the provider does not support tool-calling', async () => {
    writeConfig({
      default_provider: 'chatonly',
      providers: {
        chatonly: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:9/v1' },
      },
    });
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: false, detail: 'no tools' });
    const ctx = makeCtx({ flags: { provider: 'chatonly' } });
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/Does NOT support tool-calling/);
    expect(out).toMatch(/fine for conversation, not for operating/);
  });

  it('reports the failure if the provider does not respond', async () => {
    writeConfig({
      default_provider: 'muerto',
      providers: {
        muerto: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:1/v1' },
      },
    });
    const probe = vi.fn().mockResolvedValue({ chat: false, tools: false, detail: 'ECONNREFUSED' });
    const ctx = makeCtx({ flags: { provider: 'muerto' } });
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/No response: ECONNREFUSED/);
  });

  it('saves the credential in .env, NEVER in the config', async () => {
    writeConfig({
      default_provider: 'conkey',
      providers: {
        conkey: {
          type: 'openai-compatible', model: 'm',
          base_url: 'https://x/v1', api_key_env: 'MI_KEY',
        },
      },
    });
    delete process.env.MI_KEY;
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    await new IaSection({ cwd: tmp, home: tmp, probe, listOllamaModels: async () => [] }).configure(
      makeCtx({ flags: { provider: 'conkey' }, secrets: ['sk-secreta-123'] })
    );

    expect(readEnvVar(path.join(tmp, '.mnemosine', '.env'), 'MI_KEY')).toBe('sk-secreta-123');
    expect(fs.existsSync(path.join(tmp, '.env'))).toBe(false);
    const config = fs.readFileSync(path.join(tmp, 'mnemosine.config.json'), 'utf-8');
    expect(config).not.toContain('sk-secreta-123');
  });
});

describe('--section with no .env writes to the announced location', () => {
  const userEnv = () => path.join(tmp, '.mnemosine', '.env');
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  });

  it('--section ia: the API key goes to ~/.mnemosine/.env and the location is announced', async () => {
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), JSON.stringify({
      default_provider: 'conkey',
      providers: { conkey: { type: 'openai-compatible', model: 'm', base_url: 'https://x/v1', api_key_env: 'MI_KEY' } },
    }));
    delete process.env.MI_KEY;
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    const ctx = makeCtx({ flags: { provider: 'conkey' }, secrets: ['sk-x'] });
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(readEnvVar(userEnv(), 'MI_KEY')).toBe('sk-x');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    const out = ctx.lines.join('\n');
    expect(out).toContain(`.env location: ${userEnv()}`);
    expect(out.indexOf('.env location')).toBeLessThan(out.indexOf('Saved MI_KEY'));
  });

  it('--section identity --yes: the tenant pin goes to ~/.mnemosine/.env, not ./.env', async () => {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('SELECT id, name, tax_id, tenant_id')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ n: '12' }] });
    });
    const ctx = makeCtx({ flags: { entity: 'Nueva SA', country: 'MX', rfc: 'XAXX010101000' } });
    await new IdentidadSection({ cwd, home: tmp }).configure(ctx);
    expect(readEnvVar(userEnv(), 'MNEMOSINE_TENANT')).toBe('tenant-nuevo');
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
    expect(ctx.lines.join('\n')).toContain(`.env location: ${userEnv()}`);
  });

  it('pressing Enter (the default) outside a checkout chooses the user directory', async () => {
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const ctx = { ...makeCtx(), rl: {} as never }; // no queued answer: confirm returns its default
    await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
    expect(fs.existsSync(userEnv())).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(false);
  });

  it('pressing Enter inside a checkout keeps ./.env', async () => {
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    fs.writeFileSync(path.join(cwd, '.env.example'), '');
    const ctx = { ...makeCtx(), rl: {} as never };
    await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
    expect(fs.existsSync(path.join(cwd, '.env'))).toBe(true);
    expect(fs.existsSync(userEnv())).toBe(false);
  });

  it('tightens a pre-existing 0644 .env and ~/.mnemosine to 0600/0700, and warns', async () => {
    fs.mkdirSync(path.dirname(userEnv()), { mode: 0o755 });
    fs.writeFileSync(userEnv(), '', { mode: 0o644 });
    fs.chmodSync(userEnv(), 0o644);
    fs.chmodSync(path.dirname(userEnv()), 0o755);
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const ctx = makeCtx();
    await new InfraSection({ cwd, home: tmp, randomKey: () => 'c'.repeat(64) }).configure(ctx);
    expect(fs.statSync(userEnv()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(userEnv())).mode & 0o777).toBe(0o700);
    expect(ctx.lines.join('\n')).toMatch(/was mode 644; tightened to 600/);
  });
});

describe('buildSections', () => {
  it('orders the sections by dependency and marks the required ones', () => {
    const s = buildSections(tmp);
    // The language comes first (MNE-001-470): everything after it can speak it.
    expect(s.map((x) => x.id)).toEqual([
      'idioma', 'infra', 'identidad', 'usuarios', 'ia', 'politicas', 'importar',
    ]);
    expect(s.filter((x) => x.required).map((x) => x.id)).toEqual(['idioma', 'infra', 'identidad', 'ia']);
  });

  it('every section implements the full contract', () => {
    for (const s of buildSections(tmp)) {
      expect(typeof s.status).toBe('function');
      expect(typeof s.configure).toBe('function');
      expect(typeof s.verify).toBe('function');
      expect(s.title.length).toBeGreaterThan(0);
    }
  });
});

describe('categorizeProbeError', () => {
  it('recognizes credential problems', () => {
    expect(categorizeProbeError('401 Unauthorized')).toBe('auth');
    expect(categorizeProbeError('invalid x-api-key')).toBe('auth');
    expect(categorizeProbeError('permission denied for this credential')).toBe('auth');
  });

  it('recognizes connectivity problems', () => {
    expect(categorizeProbeError('connect ECONNREFUSED 127.0.0.1:11434')).toBe('connection');
    expect(categorizeProbeError('fetch failed')).toBe('connection');
    expect(categorizeProbeError('Request timed out')).toBe('connection');
  });

  it('everything else is "other" (shown verbatim)', () => {
    expect(categorizeProbeError('model not found')).toBe('other');
  });
});

describe('S0 · RLS context', () => {
  /** DB ok; the RLS probe answers whatever `rls` says. */
  function mockDb(rls: () => Promise<unknown>) {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = typeof sql === 'string' ? sql : '';
      if (q.includes('version()')) return Promise.resolve({ rows: [{ v: 'PostgreSQL 15' }] });
      if (q.includes('current_setting')) return rls();
      return Promise.resolve({ rows: [] });
    });
  }

  it('with a pinned tenant it enters it and runs a REAL scoped SELECT', async () => {
    process.env.MNEMOSINE_TENANT = 't-1';
    mockDb(async () => ({ rows: [{ tenant: 't-1', entities: '2' }] }));
    const checks = await new InfraSection({ cwd: tmp }).verify();
    const rls = checks.find((c) => c.name === 'RLS context');
    expect(rls?.level).toBe('ok');
    expect(mockEnterTenant).toHaveBeenCalledWith('t-1');
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('current_setting'));
    expect(String(call![0])).toContain('legal_entities'); // scoped table, not a bare SELECT 1
  });

  it('FAILS when the connection does not apply the tenant (queries would run unscoped)', async () => {
    process.env.MNEMOSINE_TENANT = 't-1';
    mockDb(async () => ({ rows: [{ tenant: null, entities: '0' }] }));
    const checks = await new InfraSection({ cwd: tmp }).verify();
    const rls = checks.find((c) => c.name === 'RLS context');
    expect(rls?.level).toBe('fail');
    expect(rls?.detail).toMatch(/unscoped/);
  });

  it('FAILS with a fix when the scoped SELECT itself blows up', async () => {
    process.env.MNEMOSINE_TENANT = 't-1';
    mockDb(async () => Promise.reject(new Error('relation "legal_entities" does not exist')));
    const checks = await new InfraSection({ cwd: tmp }).verify();
    const rls = checks.find((c) => c.name === 'RLS context');
    expect(rls?.level).toBe('fail');
    expect(rls?.fix).toMatch(/npm run migrate/);
  });

  it('without a tenant there is nothing to verify yet: passes with a note, never enters', async () => {
    mockDb(async () => ({ rows: [] }));
    const checks = await new InfraSection({ cwd: tmp, home: tmp }).verify();
    const rls = checks.find((c) => c.name === 'RLS context');
    expect(rls?.level).toBe('ok');
    expect(rls?.detail).toMatch(/no tenant pinned/);
    expect(mockEnterTenant).not.toHaveBeenCalled();
  });

  it('configure reports the RLS verification (verify, not reconfigure)', async () => {
    process.env.MNEMOSINE_TENANT = 't-1';
    mockDb(async () => ({ rows: [{ tenant: 't-1', entities: '1' }] }));
    const ctx = makeCtx();
    await new InfraSection({ cwd: tmp }).configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/RLS: tenant t-1 scoped/);
  });
});

describe('S3 · verify before persisting / verify-repair on re-run', () => {
  function writeConfig(cfg: unknown) {
    fs.writeFileSync(path.join(tmp, 'mnemosine.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  }
  const configFile = () => path.join(tmp, 'mnemosine.config.json');

  it('a failing probe leaves the previous default UNTOUCHED (persist only on success)', async () => {
    writeConfig({
      default_provider: 'bueno',
      providers: {
        bueno: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:9/v1' },
        malo: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:1/v1' },
      },
    });
    const probe = vi.fn().mockResolvedValue({ chat: false, tools: false, detail: 'ECONNREFUSED' });
    const ctx = makeCtx({ flags: { provider: 'malo' } }); // confirm defaults to "no"
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.default_provider).toBe('bueno');
    expect(ctx.lines.join('\n')).toMatch(/Nothing was persisted/);
  });

  it('categorizes an auth failure and deep-links the credential page', async () => {
    process.env.OPENAI_API_KEY = 'sk-rota';
    writeConfig({ default_provider: 'x' }); // flags skip the verify/repair path anyway
    const probe = vi.fn().mockResolvedValue({
      chat: false, tools: false, detail: '401 invalid api key', category: 'auth',
    });
    const ctx = makeCtx({ flags: { provider: 'openai' } });
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/credential was rejected/);
    expect(out).toMatch(/platform\.openai\.com/);
  });

  it('categorizes a connection failure from the detail when the probe gives no category', async () => {
    writeConfig({
      default_provider: 'muerto',
      providers: {
        muerto: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:1/v1' },
      },
    });
    const probe = vi.fn().mockResolvedValue({ chat: false, tools: false, detail: 'ECONNREFUSED' });
    const ctx = makeCtx({ flags: { provider: 'muerto' } });
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/could not reach the endpoint/i);
  });

  it('on failure it offers another provider and persists only the one that verifies', async () => {
    writeConfig({
      providers: {
        p1: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:2/v1' },
        p2: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:3/v1' },
      },
    });
    const probe = vi.fn().mockImplementation(async (name: string) =>
      name === 'p2'
        ? { chat: true, tools: true, detail: 'ok' }
        : { chat: false, tools: false, detail: 'ECONNREFUSED' }
    );
    // Yes to «try another», then Yes to writing the project file that defines p2.
    const ctx = makeCtx({ flags: { provider: 'p1' }, confirms: [true, true], text: ['p2'] });
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);

    expect(probe).toHaveBeenCalledTimes(2);
    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.default_provider).toBe('p2');
  });

  it('re-run with a HEALTHY persisted provider: probes it and leaves the config byte-identical', async () => {
    writeConfig({
      default_provider: 'ollamita',
      providers: {
        ollamita: { type: 'openai-compatible', model: 'llama3', base_url: 'http://localhost:11434/v1' },
      },
    });
    const before = fs.readFileSync(configFile(), 'utf-8');
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    const ctx = makeCtx(); // no flags: this is a plain re-run
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('ollamita');
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before);
    expect(ctx.lines.join('\n')).toMatch(/config left untouched/);
  });

  it('re-run with an UNHEALTHY persisted provider goes into repair; aborting keeps the config', async () => {
    writeConfig({
      default_provider: 'ollamita',
      providers: {
        ollamita: { type: 'openai-compatible', model: 'llama3', base_url: 'http://localhost:11434/v1' },
      },
    });
    const before = fs.readFileSync(configFile(), 'utf-8');
    const probe = vi.fn().mockResolvedValue({ chat: false, tools: false, detail: 'ECONNREFUSED' });
    const ctx = makeCtx(); // declines "try another" by default
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);

    const out = ctx.lines.join('\n');
    expect(out).toMatch(/Repair/);
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before);
  });

  it('fails closed on a config with a typo key: descriptive error, file left untouched', async () => {
    const original = JSON.stringify({ defalt_provider: 'ollama' }, null, 2) + '\n';
    fs.writeFileSync(configFile(), original);
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    const ctx = makeCtx({ flags: { provider: 'ollama' } });
    await expect(
      new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx)
    ).rejects.toThrow(/Invalid configuration/);
    // fail closed: the broken file is never overwritten with a "repaired" one
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(original);
  });

  it('refuses to persist a model value that looks like a raw credential (writeConfigPatch gate)', async () => {
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    const ctx = makeCtx({ flags: { provider: 'ollama', model: 'sk-oops-a-raw-key' } });
    await expect(
      new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(ctx)
    ).rejects.toThrow(/credential/);
    expect(fs.existsSync(configFile())).toBe(false);
  });
});

describe('S3 · init saves the chosen model and key in the person\'s own files (MNE-001-441)', () => {
  const userConfig = () => path.join(tmp, '.mnemosine', 'config.json');
  const userEnv = () => path.join(tmp, '.mnemosine', '.env');
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    delete process.env.MNEMOSINE_PROVIDER;
  });
  const projectConfig = () => path.join(cwd, 'mnemosine.config.json');
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as MnemosineConfig;
  const okProbe = () => vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });

  for (const name of ['anthropic', 'openai', 'grok', 'gemini', 'ollama']) {
    it(`${name} --model: probes that model, saves default_provider and models.${name} in the user file`, async () => {
      const env = BUILTIN_PROFILES[name].api_key_env;
      if (env) process.env[env] = `clave-falsa-de-prueba-${name}`;
      const model = `${name}-modelo-de-prueba`;
      const probe = okProbe();
      await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(
        makeCtx({ flags: { provider: name, model } })
      );

      expect(probe).toHaveBeenCalledWith(name, model);
      expect(fs.existsSync(projectConfig())).toBe(false);
      // Only the two keys: the built-in is not copied, so it keeps its window and posture.
      expect(readJson(userConfig())).toEqual({ default_provider: name, models: { [name]: model } });
      expect(resolveProfile(undefined, undefined, cwd)).toMatchObject({ name, model });
      expect(ventanaDe(name, cwd)).toEqual(BUILTIN_PROFILES[name].ventana);
      expect(resolveProfile(name, 'otro-modelo', cwd).model).toBe('otro-modelo');
    });
  }

  it('ollama without --model: probes and saves the installed model picked from the list', async () => {
    const probe = okProbe();
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => ['a:1b', 'b:2b'] }).configure(
      makeCtx({ flags: { provider: 'ollama' }, text: ['2'] })
    );
    expect(probe).toHaveBeenCalledWith('ollama', 'b:2b');
    expect(readJson(userConfig()).models).toEqual({ ollama: 'b:2b' });
  });

  it('a model other than the one the window was declared for is reported with the threshold that governs it', async () => {
    const ctx = makeCtx({ flags: { provider: 'ollama', model: 'otro:7b' } });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toContain('32768');
    expect(out).toContain('llama3.1');
    expect(out).toContain('compaction.threshold_tokens');
  });

  it('a profile kept in the user file keeps living there, with and without --model; no project file appears', async () => {
    fs.mkdirSync(path.dirname(userConfig()), { recursive: true });
    fs.writeFileSync(userConfig(), JSON.stringify({
      providers: {
        mio: { type: 'openai-compatible', model: 'viejo', base_url: 'http://localhost:9/v1', api_key_cmd: 'printf falsa' },
      },
    }));
    const probe = okProbe();
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(
      makeCtx({ flags: { provider: 'mio' } })
    );
    expect(readJson(userConfig())).toMatchObject({ default_provider: 'mio', providers: { mio: { model: 'viejo' } } });

    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(
      makeCtx({ flags: { provider: 'mio', model: 'nuevo' } })
    );
    const saved = readJson(userConfig());
    expect(saved.providers?.mio).toEqual({
      type: 'openai-compatible', model: 'nuevo', base_url: 'http://localhost:9/v1', api_key_cmd: 'printf falsa',
    });
    expect(saved.models).toBeUndefined();
    expect(fs.existsSync(projectConfig())).toBe(false);
  });

  describe('a project file wins in this folder', () => {
    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'clave-falsa-de-prueba';
      fs.writeFileSync(projectConfig(), JSON.stringify({ default_provider: 'anthropic' }));
    });

    it('says who reads it and asks; No (the default) writes the user file and says the project file still decides', async () => {
      const before = fs.readFileSync(projectConfig(), 'utf-8');
      const ctx = makeCtx({ flags: { provider: 'gemini', model: 'g-prueba' } });
      await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);

      const out = ctx.lines.join('\n');
      expect(out).toContain(`everyone who runs mnemosine in ${cwd} reads ${projectConfig()}`);
      expect(fs.readFileSync(projectConfig(), 'utf-8')).toBe(before);
      expect(readJson(userConfig())).toEqual({ default_provider: 'gemini', models: { gemini: 'g-prueba' } });
      expect(out).toContain(`${projectConfig()} still decides in ${cwd}`);
    });

    it('--yes keeps No', async () => {
      const before = fs.readFileSync(projectConfig(), 'utf-8');
      await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(
        makeCtx({ flags: { provider: 'gemini', model: 'g-prueba', yes: true } })
      );
      expect(fs.readFileSync(projectConfig(), 'utf-8')).toBe(before);
      expect(readJson(userConfig()).models).toEqual({ gemini: 'g-prueba' });
    });

    it('Yes writes the project file', async () => {
      await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(
        makeCtx({ flags: { provider: 'gemini', model: 'g-prueba' }, confirms: [true] })
      );
      expect(readJson(projectConfig())).toEqual({ default_provider: 'gemini', models: { gemini: 'g-prueba' } });
      expect(fs.existsSync(userConfig())).toBe(false);
    });
  });

  it('a profile defined only in the project file is not copied into the user file on No', async () => {
    fs.writeFileSync(projectConfig(), JSON.stringify({
      providers: { compartido: { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:9/v1', api_key_cmd: 'printf falsa' } },
    }));
    const ctx = makeCtx({ flags: { provider: 'compartido', model: 'n' } });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);
    expect(fs.existsSync(userConfig())).toBe(false);
    expect(readJson(projectConfig()).providers?.compartido?.model).toBe('m');
    expect(ctx.lines.join('\n')).toMatch(/only in .*mnemosine\.config\.json.*nothing was saved/i);
  });

  it('a typed key goes to ~/.mnemosine/.env (600), never ./.env, and an empty definition in ./.env is removed', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'OTRA=1\nGEMINI_API_KEY=\nMAS=2\n', { mode: 0o644 });
    delete process.env.GEMINI_API_KEY;
    const ctx = makeCtx({ flags: { provider: 'gemini' }, secrets: ['clave-falsa-tecleada'] });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);

    expect(readEnvVar(userEnv(), 'GEMINI_API_KEY')).toBe('clave-falsa-tecleada');
    expect(fs.statSync(userEnv()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(userEnv())).mode & 0o777).toBe(0o700);
    const local = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
    expect(local).toBe('OTRA=1\nMAS=2\n');
    expect(local).not.toContain('clave-falsa-tecleada');
  });

  it('a non-empty definition in ./.env is left alone, and init says it wins in that folder', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'GEMINI_API_KEY=clave-falsa-de-la-carpeta\n');
    delete process.env.GEMINI_API_KEY;
    const ctx = makeCtx({ flags: { provider: 'gemini' }, secrets: ['clave-falsa-tecleada'] });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);

    expect(fs.readFileSync(path.join(cwd, '.env'), 'utf-8')).toBe('GEMINI_API_KEY=clave-falsa-de-la-carpeta\n');
    expect(readEnvVar(userEnv(), 'GEMINI_API_KEY')).toBe('clave-falsa-tecleada');
    expect(ctx.lines.join('\n')).toContain(`GEMINI_API_KEY in ${path.join(cwd, '.env')} wins in ${cwd}`);
  });

  it('MNEMOSINE_PROVIDER naming another profile is reported as the one that wins', async () => {
    process.env.MNEMOSINE_PROVIDER = 'anthropic';
    process.env.GEMINI_API_KEY = 'clave-falsa-de-prueba';
    const ctx = makeCtx({ flags: { provider: 'gemini' } });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);
    expect(ctx.lines.join('\n')).toContain('MNEMOSINE_PROVIDER=anthropic wins over the default_provider just saved');
  });
});

describe('S3 · the wizard gives the readiness answer and asks no key when a helper exists (MNE-001-443)', () => {
  const userConfig = () => path.join(tmp, '.mnemosine', 'config.json');
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    delete process.env.MNEMOSINE_PROVIDER;
    delete process.env.VAULT_FAKE_KEY;
  });
  const okProbe = () => vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
  const marker = () => path.join(cwd, 'helper-ran');
  function helperUserConfig(extra: Record<string, unknown> = {}) {
    fs.mkdirSync(path.dirname(userConfig()), { recursive: true });
    fs.writeFileSync(userConfig(), JSON.stringify({
      ...extra,
      providers: {
        vault: {
          type: 'openai-compatible', model: 'vm', base_url: 'https://vault.example.test/v1',
          api_key_env: 'VAULT_FAKE_KEY', api_key_cmd: `touch ${marker()} && echo fake-helper-secret >&2`,
        },
      },
    }, null, 2) + '\n');
  }

  it('lists each profile with its readiness answer, never running a helper or printing its command', async () => {
    helperUserConfig();
    const ctx = makeCtx({ flags: { provider: 'vault' } });
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/✔ vault\s+vm · api_key_cmd in ~\/\.mnemosine\/config\.json$/m);
    expect(out).toMatch(/✔ ollama\s+\S+ · local, no credential$/m);
    expect(out).not.toMatch(/touch|fake-helper-secret/);
    // The fake probe stands in for the live call; nothing else runs the helper.
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('a helper default is not asked for a key: the probe resolves it, as the session does', async () => {
    helperUserConfig();
    const askSecret = vi.fn();
    const ctx = { ...makeCtx({ flags: { provider: 'vault' } }), askSecret };
    const probe = okProbe();
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(askSecret).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith('vault', undefined);
    expect((JSON.parse(fs.readFileSync(userConfig(), 'utf-8')) as MnemosineConfig).default_provider).toBe('vault');
  });

  it('re-run with a helper default: verified live and left byte-identical, not sent to repair', async () => {
    helperUserConfig({ default_provider: 'vault' });
    const before = fs.readFileSync(userConfig(), 'utf-8');
    const probe = okProbe();
    const ctx = makeCtx();
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('vault');
    expect(fs.readFileSync(userConfig(), 'utf-8')).toBe(before);
    expect(ctx.lines.join('\n')).toMatch(/config left untouched/);
  });

  it('a missing key is still asked, with where to get it', async () => {
    delete process.env.XAI_API_KEY;
    const askSecret = vi.fn().mockResolvedValue(null);
    const ctx = { ...makeCtx({ flags: { provider: 'grok' } }), askSecret };
    await new IaSection({ cwd, home: tmp, probe: okProbe(), listOllamaModels: async () => [] }).configure(ctx);
    expect(askSecret).toHaveBeenCalledTimes(1);
    expect(ctx.lines.join('\n')).toMatch(/○ grok\s+\S+ · XAI_API_KEY missing \(get it at https:\/\/console\.x\.ai\)$/m);
  });
});

describe('S3 · the wizard asks no key of someone signed in with Anthropic (MNE-001-444)', () => {
  let cwd: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE', 'MNEMOSINE_PROVIDER'];
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('an ant auth login profile under ANTHROPIC_CONFIG_DIR: no key asked, the readiness answer names it', async () => {
    const root = path.join(tmp, 'anthropic-config');
    fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'configs', 'default.json'), '{"authentication":{"type":"user_oauth"}}');
    process.env.ANTHROPIC_CONFIG_DIR = root;
    const askSecret = vi.fn();
    const ctx = { ...makeCtx({ flags: { provider: 'anthropic' } }), askSecret };
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    expect(askSecret).not.toHaveBeenCalled();
    expect(ctx.lines.join('\n')).toMatch(/✔ anthropic\s+\S+ · signed in: Anthropic profile default in /m);
    expect(probe).toHaveBeenCalledWith('anthropic', undefined);
  });

  it('with nothing, the key is still asked, with the page Anthropic names', async () => {
    process.env.ANTHROPIC_CONFIG_DIR = path.join(tmp, 'no-anthropic-config');
    const askSecret = vi.fn().mockResolvedValue(null);
    const ctx = { ...makeCtx({ flags: { provider: 'anthropic' } }), askSecret };
    await new IaSection({ cwd, home: tmp, probe: vi.fn().mockResolvedValue({ chat: false, detail: 'no' }), listOllamaModels: async () => [] }).configure(ctx);
    expect(askSecret).toHaveBeenCalledTimes(1);
    expect(ctx.lines.join('\n')).toContain('Get the credential at: https://platform.claude.com/settings/keys');
  });
});

// MNE-001-448 (#644 P8): NVIDIA's hosted catalog is a trial that records what
// it receives. Init prints its terms and asks before it saves it as the
// default; the default is No, and --yes keeps No.
describe('S3 · the nvidia built-in asks for its trial terms before it is saved', () => {
  const userConfig = () => path.join(tmp, '.mnemosine', 'config.json');
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    delete process.env.MNEMOSINE_PROVIDER;
    process.env.NVIDIA_API_KEY = 'clave-falsa-de-prueba';
  });
  const okProbe = () => vi.fn().mockResolvedValue({ chat: true, tools: true, detail: 'ok' });
  const configure = async (answers: Parameters<typeof makeCtx>[0]) => {
    const probe = okProbe();
    const ctx = makeCtx(answers);
    await new IaSection({ cwd, home: tmp, probe, listOllamaModels: async () => [] }).configure(ctx);
    return { probe, out: ctx.lines.join('\n') };
  };

  it('prints the terms and asks; No (the default) saves nothing and calls nothing', async () => {
    const { probe, out } = await configure({ flags: { provider: 'nvidia' } });
    expect(out).toContain('integrate.api.nvidia.com');
    expect(out).toMatch(/record what you send/);
    expect(out).toMatch(/personal data/);
    expect(out).toMatch(/nvidia was not saved/);
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(userConfig())).toBe(false);
  });

  it('--yes does not accept them', async () => {
    const { probe } = await configure({ flags: { provider: 'nvidia', yes: true } });
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(userConfig())).toBe(false);
  });

  it('a yes probes it and saves it in the user file', async () => {
    const { probe } = await configure({ flags: { provider: 'nvidia' }, confirms: [true] });
    expect(probe).toHaveBeenCalledWith('nvidia', undefined);
    expect(JSON.parse(fs.readFileSync(userConfig(), 'utf-8'))).toEqual({ default_provider: 'nvidia' });
  });
});
