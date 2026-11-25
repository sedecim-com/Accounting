import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// I8b · the init family speaks by key, part 3 (MNE-001-799, #150): the import
// step, the first-run diagnosis that leads to init and the provider readiness
// lines print from the catalogue. Under es-MX they are Spanish, with their
// plurals; under the suite's en-US the English is the one they printed before,
// plural defects included. The Spanish is written by hand.

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), withTransaction: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(), withTenant: vi.fn(),
}));

import { resetLanguage, setLanguage } from '../../../src/i18n/index.js';
import { query } from '../../../src/database/connection.js';
import { ImportSection } from '../../../src/cli/init/s5-import.js';
import { detectSetupState, type DetectDeps } from '../../../src/cli/first-run.js';
import { providerLines, tickCredentialLine } from '../../../src/cli/provider-readiness.js';
import { repairCommandFor } from '../../../src/cli/mnemosine.js';
import { englishUserStrings } from '../../../scripts/language/lanes/cli-strings.js';

const mockQuery = query as unknown as Mock;
const ENTITY = { entityId: 'e1', entityName: 'Demo SA', tenantId: 't1', taxId: 'AAA010101AAA' } as never;

type Answers = { text?: readonly (string | null)[]; secrets?: readonly string[]; confirms?: readonly boolean[]; rl?: null };
function ctx(o: Answers = {}) {
  const [lines, prompts]: string[][] = [[], []];
  const [text, secrets, confirms] = [[...(o.text ?? [])], [...(o.secrets ?? [])], [...(o.confirms ?? [])]];
  return {
    lines, prompts, rl: o.rl === null ? null : ({} as never), flags: {},
    print: (l = '') => void lines.push(l),
    askText: async (p: string, d?: string) => (prompts.push(p), text.length ? text.shift()! : (d ?? null)),
    askSecret: async (p: string) => (prompts.push(p), secrets.length ? secrets.shift()! : null),
    confirm: async (p: string, d = true) => (prompts.push(p), confirms.length ? confirms.shift()! : d),
  };
}

const PLAN = {
  reference: 'onboarding:contalink:2026-06-30', remoteAccounts: 3, existingAccounts: 1,
  accountsToCreate: [{ code: '1' }, { code: '2' }], openingLines: [{}], needsBalancingAccount: true,
  totals: { debits: 100, credits: 90, imbalance: 10 },
};
function section(o: Record<string, unknown> = {}) {
  return new ImportSection({
    resolveEntity: async () => ENTITY,
    resolveReviewer: async () => ({ userId: 'u1', email: 'jefa@demo.test' }) as never,
    planOnboarding: async () => PLAN as never,
    executeOnboarding: async () => ({ accountsCreated: 1, draftId: 'D1' }) as never,
    hasCredential: async () => true,
    storeCredential: (async () => undefined) as never,
    listXmlFiles: () => [],
    ...o,
  } as never);
}

afterEach(() => (resetLanguage(), vi.restoreAllMocks()));
const api = (o: { confirms?: boolean[]; secrets?: string[] } = {}) =>
  ctx({ text: ['1', 'contalink', '2026-06-30', '3200'], ...o });

describe('under es-MX the import step prints Spanish', () => {
  it('the intro, the three doors and the non-interactive exit, and the title', async () => {
    setLanguage('es');
    const c = ctx({ rl: null });
    await section().configure(c);
    expect(c.lines).toEqual([
      '',
      '  Por qué pregunto: mnemosine sirve más cuando ve tu contabilidad real.',
      '  Qué hago: todo llega como borradores por revisar — nada se contabiliza sin ti.',
      '',
      '  ¿Cómo quieres empezar?',
      '    1) Importar de otro sistema contable por API (hoy, Contalink)',
      '    2) Ingerir archivos XML de CFDI desde una carpeta',
      '    3) Empezar desde cero — puedes importar cuando quieras',
      '',
      '  Modo no interactivo: se empieza desde cero. Puedes importar cuando quieras: mnemosine onboard --help',
    ]);
    expect(section().title).toBe('Trae tu contabilidad');
  });

  it('the API door: the key for the RFC, the plan with its plurals, the draft', async () => {
    setLanguage('es');
    const c = api({ secrets: ['clave-falsa'], confirms: [true, true] });
    await section({ hasCredential: async () => false }).configure(c);
    expect(c.prompts).toEqual([
      '  Opción [1/2/3] (3): ',
      '  Sistema externo (contalink): ',
      '  Clave de API de contalink para el RFC AAA010101AAA (Enter para omitir): ',
      '  ¿Esta clave abre la empresa de contalink con RFC AAA010101AAA, y ninguna otra?',
      '  Fecha de corte, saldos al AAAA-MM-DD: ',
      '  Código de la cuenta de cuadre (3200): ',
      '  ¿Creo 2 cuentas y el saldo inicial como borrador?',
    ]);
    expect(c.lines).toEqual(expect.arrayContaining([
      '  Demo SA todavía no tiene una clave de contalink que sirva.',
      '  Cada entidad lee y escribe sólo con la clave de su propia empresa (el mismo RFC).',
      '  En contalink: abre la empresa con RFC AAA010101AAA → API Configuration.',
      '  ✔ Clave de contalink registrada para el RFC AAA010101AAA (guardada en la bóveda).',
      '  Leyendo la balanza de comprobación remota…',
      '  Cuentas remotas: 3 · ya existen: 1 · por crear: 2',
      '  Saldo inicial: 1 línea · cargos 100 · abonos 90',
      '  La balanza de comprobación remota no cuadra (diferencia 10).',
      '  ✔ Se creó 1 cuenta.',
      '  ✔ Saldo inicial en el borrador D1 (ref onboarding:contalink:2026-06-30).',
      '  Revisa los borradores: mnemosine review',
    ]));
  });

  const fail = (message: string) => async () => { throw new Error(message); };
  const many = Array.from({ length: 51 }, (_, i) => `/x/${i}.xml`);
  it.each([
    ['no attestation', { hasCredential: async () => false }, { text: ['1', 'contalink'], secrets: ['k'], confirms: [false] }, [
      '  No se registró: una clave de otra empresa escribiría en sus libros.',
      '  La sección queda incompleta. Vuelve a correr para registrarla: mnemosine init --section import',
    ]],
    ['a bad cutoff', {}, { text: ['1', 'contalink', '30/06/2026'] }, [
      '  El corte debe ser AAAA-MM-DD. No se importó nada — vuelve a correr cuando estés listo:',
      '    mnemosine init --section import',
    ]],
    ['a failed plan', { planOnboarding: fail('ETIMEDOUT') }, { text: ['1', 'contalink', '2026-06-30'] }, [
      '  No pude planear la importación: ETIMEDOUT',
      '  No se creó nada. Control completo de la importación: mnemosine onboard --help',
    ]],
    ['a failed import', { executeOnboarding: fail('rechazo') }, { text: ['1', 'contalink', '2026-06-30', '3200'] }, [
      '  Falló la importación: rechazo',
      '  Reintenta con control completo: mnemosine onboard --help',
    ]],
    ['no folder', {}, { text: ['2', null] }, [
      '  No diste una carpeta. Puedes ingerir cuando quieras: mnemosine ingest <files…>',
    ]],
    ['the first-run cap and a failed run', { listXmlFiles: () => many, resolveReviewer: fail('sin revisor') }, { text: ['2', '/x'] }, [
      '  Encontré 51 archivos; tomo los primeros 50 en esta primera corrida para que la revisión siga ' +
        'siendo manejable. Ingiere el resto con: mnemosine ingest <files…>',
      '  Falló la ingesta: sin revisor',
      '  Reintenta cuando quieras: mnemosine ingest <files…>',
    ]],
  ] as const)('the way out after %s', async (_name, deps, answers, tail) => {
    setLanguage('es');
    const c = ctx({ confirms: [true], ...answers });
    await section(deps).configure(c);
    expect(c.lines.slice(-tail.length)).toEqual(tail);
  });

  it('the checks, with their plurals', async () => {
    setLanguage('es');
    const verify = async (entries: number, xmls: number, drafts: number) => {
      mockQuery.mockResolvedValue({ rows: [{ entries: `${entries}`, xmls: `${xmls}`, onboarding_drafts: `${drafts}` }] });
      return section().verify();
    };
    const [empty] = await verify(0, 0, 0);
    expect(empty.detail).toBe('Todavía no hay datos contables');
    expect(empty.fix).toBe('Importa con `mnemosine onboard` o ingiere CFDI con `mnemosine ingest`');
    const [one, draft] = await verify(1, 1, 1);
    expect(one.detail).toBe('1 póliza, 1 CFDI ingerido');
    expect(draft.detail).toBe('1 borrador de saldo inicial en espera de aprobación');
    expect(draft.fix).toBe('Apruébalo o recházalo con `mnemosine review`');
    const [many, drafts] = await verify(5, 2, 3);
    expect(many.detail).toBe('5 pólizas, 2 CFDI ingeridos');
    expect(drafts.detail).toBe('3 borradores de saldo inicial en espera de aprobación');
  });

  it('under en-US the English keeps its words and its plural defects', async () => {
    const c = api({ confirms: [true] });
    await section().configure(c);
    expect(c.prompts).toContain('  Create 2 account(s) and the opening balance as a draft?');
    expect(c.lines).toContain('  Opening balance: 1 line(s) · debits 100 · credits 90');
    expect(c.lines).toContain('  ✔ 1 account(s) created.');
    mockQuery.mockResolvedValue({ rows: [{ entries: '1', xmls: '1', onboarding_drafts: '0' }] });
    expect((await section().verify())[0].detail).toBe('1 journal entry, 1 CFDI(s) ingested');
    expect(section().title).toBe('Bring your accounting in');
  });
});

describe('under es-MX the first run names its gaps in Spanish, and each keeps its repair', () => {
  const healthy: DetectDeps = {
    cwd: '/fake', env: { DATABASE_URL: 'postgresql://localhost/x' }, fileExists: (p) => p === '/fake/.env',
    probeDb: async () => undefined, countActiveEntities: async () => 1, resolveProvider: () => ({ name: 'a' }),
  };
  const cases: Array<[string, DetectDeps, string]> = [
    ['fresh', { ...healthy, fileExists: () => false, env: {} }, 'no hay archivo .env (nunca se configuró)'],
    ['no url', { ...healthy, env: {} }, 'DATABASE_URL no está definida (agrégala a tu .env)'],
    ['db down', { ...healthy, probeDb: async () => { throw new Error('ECONNREFUSED'); } },
      'sin conexión con la base de datos: ECONNREFUSED'],
    ['db slow', { ...healthy, probeDb: () => new Promise<void>(() => undefined), timeoutMs: 5 },
      'sin conexión con la base de datos: se agotó el tiempo de espera tras 5 ms'],
    ['no entity', { ...healthy, countActiveEntities: async () => 0 }, 'no hay entidades legales registradas'],
    ['no provider', { ...healthy, resolveProvider: () => { throw new Error('x'); } }, 'el proveedor de IA no está configurado'],
  ];

  it.each(cases)('%s', async (_name, deps, spanish) => {
    const english = (await detectSetupState(deps)).reasons;
    setLanguage('es');
    const reasons = (await detectSetupState(deps)).reasons;
    expect(reasons).toEqual([spanish]);
    expect(reasons.map(repairCommandFor)).toEqual(english.map(repairCommandFor));
  });

  it('a check that fails outright says so in Spanish', async () => {
    setLanguage('es');
    const broken = { ...healthy, get cwd(): string { throw new Error('raro'); } };
    expect((await detectSetupState(broken)).reasons).toEqual(['falló la revisión de la configuración: raro']);
  });
});

describe('under es-MX the provider list and the tick line print Spanish', () => {
  let [cwd, home] = ['', ''];
  const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };
  beforeEach(() => {
    [cwd, home] = ['cwd', 'home'].map((n) => fs.mkdtempSync(path.join(os.tmpdir(), `init-799-${n}-`)));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('MNEMOSINE_PROVIDER', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [cwd, home]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the default mark, tools and the closing line', () => {
    setLanguage('es');
    const out = providerLines(plain, { cwd, home, env: {} });
    expect(out).toContain('anthropic ← por omisión');
    expect(out.join('\n')).toMatch(/ · herramientas · /);
    expect(out.join('\n')).toMatch(/ · sin herramientas · /);
    expect(out.at(-1)).toBe(
      '\nSe usan los perfiles integrados. Personalízalos con mnemosine.config.json (o ~/.mnemosine/config.json) ' +
        'y elige el predeterminado con "default_provider", MNEMOSINE_PROVIDER o --provider.'
    );
  });

  it('the three tick lines', () => {
    setLanguage('es');
    const line = tickCredentialLine({ cwd, home, env: {} });
    expect(line).toMatch(/^proveedor anthropic · .+ · la credencial del usuario que corre esta pasada$/);
    fs.mkdirSync(path.join(home, '.mnemosine'));
    fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify({ default_provider: 'fantasma' }));
    expect(tickCredentialLine({ cwd, home, env: {} })).toBe('el proveedor fantasma no existe (mnemosine doctor dice más)');
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), '{ no');
    expect(tickCredentialLine({ cwd, home, env: {} })).toBe('proveedor: la configuración no carga (mnemosine doctor dice por qué)');
  });
});

describe('the lane: these three files print no English literal', () => {
  it.each(['src/cli/init/s5-import.ts', 'src/cli/first-run.ts', 'src/cli/provider-readiness.ts'])('%s', (file) => {
    const code = fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
    expect(englishUserStrings(code, file).map((h) => h.text)).toEqual([]);
  });
});
