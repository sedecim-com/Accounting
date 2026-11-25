import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// I8b · the init family speaks by key, part 2 (MNE-001-798, #150): the identity,
// users and AI-provider steps print from the catalogue. Under es-MX they are
// Spanish, with their plurals; under the suite's en-US the English is the one
// they printed before, plural defects included. The Spanish is written by hand.

const m = vi.hoisted(() => ({ seedAccounting: vi.fn(), createEntity: vi.fn(), fiscalYear: vi.fn() }));
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), withTransaction: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));
vi.mock('../../../src/services/entity/entity-service.js', () => ({ createEntity: m.createEntity }));
vi.mock('../../../src/services/accounting/entity-accounting.js', () => ({ ensureEntityAccounting: m.seedAccounting }));
vi.mock('../../../src/services/accounting/fiscal-calendar-service.js', () => ({ ensureFiscalYear: m.fiscalYear }));

import { resetLanguage, setLanguage } from '../../../src/i18n/index.js';
import { query } from '../../../src/database/connection.js';
import { IdentidadSection } from '../../../src/cli/init/s1-identity.js';
import { UsuariosSection } from '../../../src/cli/init/s2-users.js';
import { IaSection } from '../../../src/cli/init/s3-ai.js';
import { englishUserStrings } from '../../../scripts/language/lanes/cli-strings.js';

const mockQuery = query as unknown as Mock;

function ctx(o: { text?: (string | null)[]; secrets?: (string | null)[]; confirms?: boolean[]; flags?: object } = {}) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const text = [...(o.text ?? [])];
  const secrets = [...(o.secrets ?? [])];
  const confirms = [...(o.confirms ?? [])];
  return {
    lines, prompts, rl: null, flags: o.flags ?? {},
    print: (l = '') => void lines.push(l),
    askText: async (p: string, d?: string) => (prompts.push(p), text.length ? text.shift()! : (d ?? null)),
    askSecret: async (p: string) => (prompts.push(p), secrets.length ? secrets.shift()! : null),
    confirm: async (p: string, d = true) => (prompts.push(p), confirms.length ? confirms.shift()! : d),
  };
}

const ALFA = { id: 'e1', name: 'Alfa', tax_id: 'AAA010101AAA', tenant_id: 't1' };
/** The existing-entities path: the tenant of the first one is pinned. */
const entities = (rows: object[]) =>
  mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT id, name, tax_id') ? rows : [] }));

let tmp: string;
const ENV = { ...process.env };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-798-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  delete process.env.MNEMOSINE_TENANT;
  delete process.env.MNEMOSINE_PROVIDER;
  mockQuery.mockReset();
  m.fiscalYear.mockResolvedValue({ created: false, periods: 1 });
  const unmapped = [{ role: 'bank', code: '102' }];
  m.seedAccounting.mockResolvedValue({ cuentasBaseCreadas: ['1'], accountsCreated: [], rolesMapped: 0, unmapped });
});
afterEach(() => {
  resetLanguage();
  vi.restoreAllMocks();
  process.env = { ...ENV };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('under es-MX the identity step prints Spanish', () => {
  it('the existing entities, the pinned tenant, the fiscal year and the chart, with their plurals', async () => {
    setLanguage('es');
    entities([ALFA, { ...ALFA, id: 'e2', name: 'Beta' }]);
    const c = ctx({ confirms: [false] });
    await new IdentidadSection({ cwd: tmp, home: tmp }).configure(c);
    expect(c.lines).toContain('  Ya hay 2 entidades:');
    expect(c.prompts).toContain('  ¿Agrego otra entidad?');
    expect(c.lines).toContain(`  ✔ Inquilino fijado en ${path.join(tmp, '.mnemosine', '.env')} (aislamiento RLS activo)`);
    expect(c.lines).toContain(`  ✔ El ejercicio fiscal ${new Date().getFullYear()} ya tiene 1 periodo`);
    expect(c.lines).toContain('  ✔ Se sembró el catálogo de cuentas (1 cuenta)');
    expect(c.lines).toContain('  ⚠ 1 rol sin cuenta en este catálogo:');
    expect(c.lines).toContain('      bank → código esperado 102');
    expect(c.lines).toContain('      Asígnalos con: mnemosine doctor');
  });

  it('the refusals, the prompts, the checks and the title', async () => {
    setLanguage('es');
    mockQuery.mockResolvedValue({ rows: [] });
    const noName = ctx({ text: [null] });
    await new IdentidadSection({ cwd: tmp, home: tmp }).configure(noName);
    expect(noName.prompts).toEqual(['  Nombre de la entidad legal: ']);
    expect(noName.lines).toEqual(['  Sin un nombre no puedo crear la entidad; la sección queda incompleta.']);
    const noRfc = ctx({ text: ['Nueva SA', null, null] });
    await new IdentidadSection({ cwd: tmp, home: tmp }).configure(noRfc);
    expect(noRfc.prompts).toContain('  País [MX/USA] (MX): ');
    expect(noRfc.lines).toEqual(['  Sin RFC no puedo crear la entidad; la sección queda incompleta.']);

    mockQuery.mockImplementation(async (sql: string) => ({ rows: [{ n: sql.includes('fiscal_periods') ? '0' : '1' }] }));
    const [, closed] = await new IdentidadSection().verify();
    expect(closed.detail).toBe('no hay periodos abiertos: no se puede contabilizar ninguna póliza');
    expect(new IdentidadSection().title).toBe('Identidad fiscal (inquilino, entidad legal, ejercicio fiscal)');
  });

  it('under en-US the English keeps its words and its plural defects', async () => {
    entities([ALFA]);
    const c = ctx({ confirms: [false] });
    await new IdentidadSection({ cwd: tmp, home: tmp }).configure(c);
    expect(c.lines).toContain('  There are already 1 entity(ies):');
    expect(c.lines).toContain(`  ✔ Fiscal year ${new Date().getFullYear()} already has 1 periods`);
    expect(c.lines).toContain('  ⚠ 1 role(s) without an account in this chart:');
  });
});

describe('under es-MX the users step prints Spanish', () => {
  it('the three verdicts of its check, with their plurals', async () => {
    setLanguage('es');
    const verdict = async (n: string, owners: string) => {
      mockQuery.mockResolvedValue({ rows: [{ n, owners }] });
      return (await new UsuariosSection().verify())[0];
    };
    expect((await verdict('0', '0')).detail).toBe('no hay ningún usuario activo: review/outbox/questions no pueden atribuir');
    expect((await verdict('1', '0')).detail).toBe('1 usuario, pero ninguno con el rol owner');
    const many = await verdict('3', '1');
    expect(many.detail).toBe('3 activos, 1 con el rol owner');
    expect(many.fix).toBe('con varios usuarios, review/questions exigen --user <email>');
    expect(new UsuariosSection().title).toBe('Usuarios y roles');
  });

  it('the listing, the prompts, the created user and the two-firm refusal', async () => {
    setLanguage('es');
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT email, roles')) return { rows: [{ email: 'a@demo.mx', roles: [] }] };
      if (sql.includes('public.tenants')) return { rows: [{ id: 't1', name: 'Uno' }] };
      return { rows: [], rowCount: 1 };
    });
    const c = ctx({ confirms: [true], text: ['nueva@demo.mx', '1'], secrets: ['unPasswordLargoSeguro'] });
    await new UsuariosSection().configure(c);
    expect(c.lines).toContain('  Usuarios actuales:');
    expect(c.lines).toContain('    · a@demo.mx [sin rol]');
    expect(c.lines).toContain('  Roles disponibles:');
    expect(c.prompts).toEqual([
      '  ¿Agrego otro usuario?', '  Correo del usuario: ', '  Rol [1-7] (1): ', '  Contraseña (mínimo 12 caracteres): ',
    ]);
    expect(c.lines).toContain('  ✔ Se creó el usuario nueva@demo.mx con el rol owner');

    mockQuery.mockResolvedValue({ rows: [{ id: 't1', name: 'Uno' }, { id: 't2', name: 'Dos' }] });
    const two = ctx();
    await new UsuariosSection().configure(two);
    expect(two.lines).toEqual([
      '  Esta instalación tiene más de un inquilino: nombra el despacho con --tenant.',
      '  Elegir por ti podría darle a este acceso los libros de otro despacho:',
      '    - Uno → t1', '    - Dos → t2', '  La sección queda incompleta.',
    ]);
  });
});

describe('under es-MX the AI-provider step prints Spanish', () => {
  const writeConfig = (cfg: unknown) => fs.writeFileSync(path.join(tmp, 'mnemosine.config.json'), JSON.stringify(cfg));
  const local = { type: 'openai-compatible', model: 'm', base_url: 'http://localhost:9/v1' };

  it('a persisted provider that fails goes to repair, with the cause and the retry', async () => {
    setLanguage('es');
    writeConfig({ default_provider: 'p1', providers: { p1: local } });
    const probe = vi.fn().mockResolvedValue({ chat: false, tools: false, detail: 'ECONNREFUSED' });
    const c = ctx({ confirms: [false] });
    await new IaSection({ cwd: tmp, home: tmp, probe, listOllamaModels: async () => [] }).configure(c);
    expect(c.lines).toContain('  El proveedor "p1" ya está configurado; lo verifico en vivo…');
    expect(c.lines).toContain('  ✘ Sin respuesta: ECONNREFUSED');
    expect(c.lines).toContain('     Causa: no se pudo llegar al servicio. Revisa base_url, tu red,');
    expect(c.lines).toContain('     y que el servicio esté corriendo (en los locales: ollama serve, hermes gateway…).');
    expect(c.lines).toContain('  Proveedores disponibles:');
    expect(c.prompts.filter((p) => /^ {2}¿Cuál uso por omisión\? \(\S+\): $/.test(p))).toHaveLength(1);
    expect(c.prompts).toContain('  ¿Pruebo otro proveedor?');
    expect(c.lines).toContain('  No se guardó nada: se conserva la configuración anterior (si la había).');
    expect(new IaSection().title).toBe('Proveedor de IA');
  });

  it('a provider without tools is saved, and the project file that wins is named', async () => {
    setLanguage('es');
    writeConfig({ providers: { p1: local } });
    const probe = vi.fn().mockResolvedValue({ chat: true, tools: false, detail: 'ok' });
    const c = ctx({ flags: { provider: 'p1' }, confirms: [true] });
    await new IaSection({ cwd: tmp, home: tmp, probe, listOllamaModels: async () => [] }).configure(c);
    const file = path.join(tmp, 'mnemosine.config.json');
    expect(c.lines).toContain('  ✔ Responde a un chat mínimo');
    expect(c.lines).toContain('  ⚠ NO admite llamadas a herramientas: sirve para conversar, no para operar');
    expect(c.lines).toContain('     Marca tools:false en su perfil, o elige otro proveedor.');
    expect(c.lines).toContain(`  ! todos los que corren mnemosine en ${tmp} leen ${file}.`);
    expect(c.prompts).toContain(`  ¿Guardo tu elección ahí (No: en ${path.join(tmp, '.mnemosine', 'config.json')})?`);
    expect(c.lines).toContain(`  ✔ Se guardó en ${file}`);
    expect(c.lines).toContain('  ✔ Proveedor por omisión: p1');
  });
});

describe('the lane: these three files print no English literal but the probe text', () => {
  const lane = (file: string) =>
    englishUserStrings(fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8'), file).map((h) => h.text);

  it('the identity and users steps have none', () => {
    for (const file of ['src/cli/init/s1-identity.ts', 'src/cli/init/s2-users.ts']) expect(lane(file), file).toEqual([]);
  });

  it('the provider step keeps only the machine text it sends to the model in the probe', () => {
    expect(lane('src/cli/init/s3-ai.ts')).toEqual([
      'Returns pong. Use it to confirm you can call tools.', 'Call the ping tool.', 'Call the ping tool.',
    ]);
  });
});
