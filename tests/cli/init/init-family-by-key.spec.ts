import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================
// I8b · the init family speaks by key, part 1 (MNE-001-479, #150)
//
// The wizard's frame (`init-command.ts`, the badges of `section.ts`), the
// infrastructure step (`s0-infra.ts`) and the policies step (`s4-policies.ts`)
// print from the catalogue. Under es-MX the frame, the chrome and the panel's
// own text are Spanish together, so `WIZARD_LANGUAGE` is gone; under the
// suite's en-US the English is the one these files printed before. The
// Spanish below is written by hand, before the code.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), withTransaction: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));
vi.mock('../../../src/ai/context.js', () => ({ resolveEntity: vi.fn(), bootstrapTenant: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/policy/policy-service.js')>();
  return {
    seedPolicies: vi.fn(), listPending: vi.fn(), listPolicies: vi.fn(), resolvePolicy: vi.fn(),
    policyWording: actual.policyWording,
  };
});
vi.mock('../../../src/services/policy/policy-preview.js', () => ({ previewFor: vi.fn(async () => []) }));
const { sections } = vi.hoisted(() => ({ sections: { list: [] as unknown[] } }));
vi.mock('../../../src/cli/init/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cli/init/index.js')>()),
  buildSections: () => sections.list,
}));
vi.mock('../../../src/ai/doctor-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/doctor-service.js')>()),
  runDoctor: async () => ({ worst: 'ok', checks: [] }),
}));

import { resetLanguage, setLanguage, t, type TranslationKey } from '../../../src/i18n/index.js';
import { query } from '../../../src/database/connection.js';
import { resolveEntity } from '../../../src/ai/context.js';
import { listPending } from '../../../src/services/policy/policy-service.js';
import { getPolicySpec } from '../../../src/services/policy/pending-catalog.js';
import { policyTextKey } from '../../../src/services/policy/policy-text-key.js';
import { InfraSection } from '../../../src/cli/init/s0-infra.js';
import { PoliciesSection } from '../../../src/cli/init/s4-policies.js';
import { runInitWizard } from '../../../src/cli/init-command.js';
import { englishUserStrings } from '../../../scripts/language/lanes/cli-strings.js';

const KEY = 'umbral_capitalizacion_mxn';
const SPEC = getPolicySpec(KEY)!;
const PLAIN = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s, red: (s: string) => s };
const es = (key: string): string => t(key as TranslationKey, {}, 'es');
const row = { key: KEY, question: 'Q', impact: 'I', options: [], default_value: '20000', status: 'pending' };

function ctx(o: { text?: string[]; yes?: boolean } = {}) {
  const lines: string[] = [];
  const text = [...(o.text ?? [])];
  return {
    lines,
    rl: o.yes ? null : ({} as never),
    flags: { yes: o.yes },
    print: (l = '') => void lines.push(l),
    askText: async () => (text.length ? text.shift()! : null),
    askSecret: async () => null,
    confirm: async (_p: string, d = true) => d,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-479-'));
  (resolveEntity as unknown as Mock).mockResolvedValue({ entityId: 'e1', tenantId: 't1', currency: 'MXN' });
  (listPending as unknown as Mock).mockResolvedValue([row]);
  (query as unknown as Mock).mockRejectedValue(new Error('ECONNREFUSED'));
});
afterEach(() => {
  resetLanguage();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('under es-MX the init family prints Spanish', () => {
  it('the frame: title, mode, badge, skip notice, final verification and the ready list', async () => {
    setLanguage('es');
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l?: unknown) => void out.push(String(l ?? '')));
    sections.list = [{
      id: 'usuarios', title: 'X', required: false,
      status: async () => 'partial', verify: async () => [], configure: async () => {},
    }];
    await runInitWizard({ yes: true }, { palette: PLAIN });
    const text = out.join('\n');
    expect(text).toContain('Configuración de Mnemosine');
    expect(text).toContain('  Modo no interactivo: uso los valores por omisión y las banderas.');
    expect(text).toContain('X  [◐ incompleta]');
    expect(text).toContain('  Omitida. Aparecerá como pendiente en init --status.');
    expect(text).toContain('Verificación final');
    expect(text).toContain('  mnemosine chat      conversa con tu contabilidad');
    expect(text).not.toMatch(/Mnemosine setup|Final verification|Ready\. Try:/);
  });

  it('the infrastructure step without a database', async () => {
    setLanguage('es');
    const c = ctx({ yes: true });
    await new InfraSection({ cwd: tmp, home: tmp }).configure(c);
    expect(c.lines).toContain(`  Se creó un ${path.join(tmp, '.mnemosine', '.env')} vacío`);
    expect(c.lines).toContain('  Arranca PostgreSQL y vuelve a correr: docker compose up -d postgres');
    expect(new InfraSection().title).toBe('Infraestructura (base de datos, migraciones, cifrado)');
  });

  it('the policies step: chrome and panel text in one language, the Spanish one', async () => {
    setLanguage('es');
    const c = ctx({ text: [''] });
    await new PoliciesSection().configure(c);
    const flat = c.lines.join('\n').replace(/\s+/g, ' ');
    expect(flat).toContain('Hay 1 decisión que no puedo tomar por mi cuenta.');
    expect(flat).toContain(`Por qué lo pregunto: ${es(policyTextKey(SPEC.textKey, 'why')).replace(/\s+/g, ' ')}`);
    expect(flat).toContain(es(policyTextKey(SPEC.textKey, 'question')));
    expect(flat).toContain('Enter = conservar el valor por omisión (20000) · q = dejar de preguntar');
    expect(flat).not.toMatch(/Why I ask|What I do|current default/);
    expect(new PoliciesSection().title).toBe('Políticas contables');
  });

  it('non-interactive: the plural is Spanish, the English keeps its words', async () => {
    setLanguage('es');
    const spanish = ctx({ yes: true });
    await new PoliciesSection().configure(spanish);
    expect(spanish.lines).toContain('  Modo no interactivo: dejo 1 política en su valor por omisión.');
    setLanguage('en');
    const en = ctx({ yes: true });
    await new PoliciesSection().configure(en);
    expect(en.lines).toContain('  There are 1 decisions I cannot make on my own.');
    expect(en.lines).toContain('  Non-interactive mode: leaving 1 policies on their defaults.');
  });
});

describe('the lane: these four files print no English literal', () => {
  const lane = (file: string) =>
    englishUserStrings(fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8'), file).map((h) => h.text);

  it('the frame, the badges and the infrastructure step have none', () => {
    for (const file of ['src/cli/init-command.ts', 'src/cli/init/section.ts', 'src/cli/init/s0-infra.ts']) {
      expect(lane(file), file).toEqual([]);
    }
  });

  it('the policies step keeps only the note it persists with the answer, which is data', () => {
    expect(lane('src/cli/init/s4-policies.ts')).toEqual(['Defined during setup']);
  });
});
