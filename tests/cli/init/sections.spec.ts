import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { SectionContext } from '../../../src/cli/init/section.js';
import { query, withTransaction, enterTenant } from '../../../src/database/connection.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockTx = withTransaction as unknown as ReturnType<typeof vi.fn>;
const mockEnterTenant = enterTenant as unknown as ReturnType<typeof vi.fn>;

let tmp: string;
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
  } as never;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.MNEMOSINE_TENANT;
});
afterEach(() => {
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
    const s = new InfraSection({ cwd: tmp, randomKey: () => 'b'.repeat(64) });
    await s.configure(makeCtx());
    expect(readEnvVar(path.join(tmp, '.env'), 'ENCRYPTION_KEY')).toBe('b'.repeat(64));
    expect(process.env.ENCRYPTION_KEY).toBe('b'.repeat(64));
  });

  it('does NOT regenerate the key if it is already a dedicated one', async () => {
    mockQuery.mockResolvedValue({ rows: [{ v: 'PostgreSQL 15' }] });
    const s = new InfraSection({ cwd: tmp, randomKey: () => 'NUEVA' });
    await s.configure(makeCtx());
    expect(readEnvVar(path.join(tmp, '.env'), 'ENCRYPTION_KEY')).not.toBe('NUEVA');
  });

  it('without a database it does not try to migrate (it stops before)', async () => {
    mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
    const runMigrations = vi.fn();
    const s = new InfraSection({ cwd: tmp, runMigrations });
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
    const s = new IdentidadSection({ cwd: tmp });
    await s.configure(makeCtx({ confirms: [false] })); // do not add another
    expect(readEnvVar(path.join(tmp, '.env'), 'MNEMOSINE_TENANT')).toBe('tenant-xyz');
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
    // --provider forces the profile; without it the suggestion would pick a ready built-in
    const ctx = makeCtx({ flags: { provider: 'ollamita' }, text: ['2'] });
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
    await new IaSection({ cwd: tmp, probe, listOllamaModels: async () => [] }).configure(
      makeCtx({ flags: { provider: 'conkey' }, secrets: ['sk-secreta-123'] })
    );

    expect(readEnvVar(path.join(tmp, '.env'), 'MI_KEY')).toBe('sk-secreta-123');
    const config = fs.readFileSync(path.join(tmp, 'mnemosine.config.json'), 'utf-8');
    expect(config).not.toContain('sk-secreta-123');
  });
});

describe('buildSections', () => {
  it('orders the sections by dependency and marks the required ones', () => {
    const s = buildSections(tmp);
    expect(s.map((x) => x.id)).toEqual([
      'infra', 'identidad', 'usuarios', 'ia', 'politicas', 'importar',
    ]);
    expect(s.filter((x) => x.required).map((x) => x.id)).toEqual(['infra', 'identidad', 'ia']);
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
    const checks = await new InfraSection({ cwd: tmp }).verify();
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
    const ctx = makeCtx({ flags: { provider: 'p1' }, confirms: [true], text: ['p2'] });
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
