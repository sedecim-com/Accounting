import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Command } from 'commander';

// ============================================================
// THE FOUR PAINTING SITES OF THE POLICY PANEL ASK THE ACTIVE LANGUAGE
// (I10 · #152, MNE-001-091, review fixes)
//
// `pending-locale.spec.ts` walks the pure renderers. This file drives the
// READERS that build their own translator or text object at the edge:
//
//   · `leerPanel`                     (the agent's panel, policy-tools.ts)
//   · `PoliciesSection.askOne`        (the init wizard, which stays English)
//   · `pending define/dismiss/reopen` (prompt, preview, messages)
//   · `getPendingBoard`               (the work board's summaries)
//
// Each test pins the language to `es` (the suite runs under en-US) and fails
// if a site goes back to a hand-written English string, to a translator bound
// to another language, or to a preview text that is not the active one.
// ============================================================

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({ resolveEntity: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn() }));
vi.mock('../../src/services/policy/policy-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/policy/policy-service.js')>();
  return {
    seedPolicies: vi.fn(),
    listPolicies: vi.fn(),
    listPending: vi.fn(),
    resolvePolicy: vi.fn(),
    dismissPolicy: vi.fn(),
    reopenPolicy: vi.fn(),
    policyWording: actual.policyWording,
  };
});
vi.mock('../../src/services/policy/policy-preview.js', () => ({ previewFor: vi.fn() }));

import { query } from '../../src/database/connection.js';
import { resolveEntity } from '../../src/ai/context.js';
import { resolveReviewer } from '../../src/ai/draft-service.js';
import {
  listPending, listPolicies, resolvePolicy, dismissPolicy, reopenPolicy,
} from '../../src/services/policy/policy-service.js';
import { previewFor } from '../../src/services/policy/policy-preview.js';
import { getPendingBoard } from '../../src/ai/pending-service.js';
import { leerPanel } from '../../src/ai/tools/policy-tools.js';
import { registerPendingCommands } from '../../src/cli/pending-command.js';
import { PoliciesSection } from '../../src/cli/init/s4-policies.js';
import { getPolicySpec } from '../../src/services/policy/pending-catalog.js';
import { policyOptionKey, policyTextKey } from '../../src/services/policy/policy-text-key.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';

const mockQuery = query as unknown as Mock;
const mockListPending = listPending as unknown as Mock;
const mockListPolicies = listPolicies as unknown as Mock;
const mockResolvePolicy = resolvePolicy as unknown as Mock;
const mockDismiss = dismissPolicy as unknown as Mock;
const mockReopen = reopenPolicy as unknown as Mock;
const mockPreview = previewFor as unknown as Mock;
const mockEntity = resolveEntity as unknown as Mock;
const mockReviewer = resolveReviewer as unknown as Mock;

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };
const flat = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').trim();

const KEY = 'umbral_capitalizacion_mxn';
const SPEC = getPolicySpec(KEY)!;
const CTX = {
  entityId: 'ent-1', entityName: 'Acme MX', tenantId: 'ten-1',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AAA010101AAA',
};

/** The catalog text of a key in Spanish, read straight from the catalog. */
const es = (key: string) => t(key as never, {}, 'es');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1', key: KEY, category: SPEC.category, question: SPEC.question, impact: SPEC.impact,
    options: SPEC.options, default_value: SPEC.defaultValue, default_rationale: SPEC.defaultRationale,
    status: 'pending', resolved_value: null, resolved_by: null, resolved_at: null,
    resolution_notes: null, priority: 10, entity_id: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockEntity.mockResolvedValue(CTX);
  mockReviewer.mockResolvedValue({ email: 'admin@demo.com' });
  mockListPending.mockResolvedValue([row()]);
  mockListPolicies.mockResolvedValue([]);
  mockResolvePolicy.mockResolvedValue([]);
  mockPreview.mockResolvedValue([]);
});
afterEach(() => {
  resetLanguage();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------
describe('leerPanel (the agent panel) follows the active language', () => {
  const seededRow = {
    key: KEY, category: SPEC.category, question: 'STALE', impact: 'STALE', options: [{ value: 'x', label: 'STALE' }],
    default_value: SPEC.defaultValue, default_rationale: 'STALE', status: 'pending',
    resolved_value: null, resolution_notes: null, entity_id: null,
  };
  const serve = () =>
    mockQuery.mockImplementation((sql?: unknown) =>
      Promise.resolve({ rows: String(sql).includes('policy_decisions') ? [seededRow] : [] })
    );

  it('es: question and option labels come out in Spanish, option values untouched', async () => {
    serve();
    setLanguage('es');
    const p = (await leerPanel(CTX, [KEY])).policies[0];
    expect(p.question).toBe(es(policyTextKey(SPEC.textKey, 'question')));
    expect(p.question).not.toBe(SPEC.question);
    expect(p.options!.map((o) => o.label)).toEqual(
      SPEC.options.map((o) => es(policyOptionKey(SPEC.textKey, o.value)))
    );
    expect(p.options!.map((o) => o.value)).toEqual(SPEC.options.map((o) => o.value));
  });

  it('en: the same call is the catalog English, unchanged', async () => {
    serve();
    setLanguage('en');
    const p = (await leerPanel(CTX, [KEY])).policies[0];
    expect(p.question).toBe(SPEC.question);
  });
});

// ------------------------------------------------------------
describe('the init wizard keeps ONE language: English, chrome and catalog text together', () => {
  function harness(answers: string[]) {
    const lines: string[] = [];
    let i = 0;
    return {
      ctx: {
        rl: {} as never,
        flags: { entity: 'Acme', user: 'admin@demo.com' },
        print: (l = '') => lines.push(l),
        askText: async () => (i < answers.length ? answers[i++] : 'q'),
        askSecret: async () => null,
        confirm: async () => true,
      },
      out: () => lines.join('\n'),
    };
  }

  it('under es the question, why/what, options and preview are English like the labels around them', async () => {
    setLanguage('es');
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    const text = h.out().replace(/\s+/g, ' ');
    expect(text).toContain('Why I ask:');
    expect(text).toContain(SPEC.question);
    expect(text).toContain(SPEC.whyAsking!.replace(/\s+/g, ' '));
    expect(text).toContain(SPEC.options[0].label);
    expect(text).not.toContain(es(policyTextKey(SPEC.textKey, 'question')));
    // The preview text handed to the query is bound to English too.
    const { text: previewText } = mockPreview.mock.calls[0][1] as { text: { t(k: string): string } };
    expect(previewText.t('policy_preview.inventory.none')).toBe(t('policy_preview.inventory.none', {}, 'en'));
  });

  it('under es an ambiguous answer is asked in English', async () => {
    setLanguage('es');
    // Typing 2 is option 2 (whose value is 1) AND the value of option 1.
    mockListPending.mockResolvedValue([
      row({
        key: 'retired_policy_not_in_catalog',
        options: [{ value: '2', label: 'first' }, { value: '1', label: 'second' }],
        default_value: '1',
      }),
    ]);
    const h = harness(['2', '']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toContain('Type p for option 2');
  });
});

// ------------------------------------------------------------
describe('`pending define`, `dismiss` and `reopen` speak the active language', () => {
  async function run(argv: string[], answer = ''): Promise<{ out: string[]; errors: unknown[] }> {
    const out: string[] = [];
    const errors: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
    class Stop extends Error {}
    const program = new Command();
    program.exitOverride();
    registerPendingCommands(program, {
      color: plain,
      colorErr: { dim: (s: string) => s, red: (s: string) => s },
      shutdown: async () => { throw new Stop(); },
      reportError: (err: unknown) => {
        if (err instanceof Stop) throw err;
        errors.push(err);
      },
      ask: async () => answer,
    });
    try {
      await program.parseAsync(argv, { from: 'user' });
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
    }
    return { out: out.flatMap((l) => l.split('\n')), errors };
  }

  it('the prompt: labels, question, options, hint and the preview text are Spanish', async () => {
    setLanguage('es');
    mockPreview.mockImplementation(async (_k: string, c: { text: { t(k: string): string } }) => [
      c.text.t('policy_preview.inventory.none'),
    ]);
    const { out } = await run(['pending', 'define', KEY]);
    const text = flat(out);
    expect(text).toContain('impacto:');
    expect(text).toContain('por qué lo pregunto:');
    expect(text).toContain('en tus datos:');
    expect(text).toContain(es('policy_preview.inventory.none'));
    expect(text).toContain(es(policyTextKey(SPEC.textKey, 'question')));
    expect(text).toContain(es('pending.define.input_hint'));
    expect(text).not.toContain(SPEC.question);
    expect(text).not.toContain('in your data');
  });

  it('a cancelled prompt says so in Spanish and writes nothing', async () => {
    setLanguage('es');
    const { out } = await run(['pending', 'define', KEY], '');
    expect(flat(out)).toContain('Cancelado; sigue pendiente.');
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

  it('a saved answer: confirmation and remaining count in Spanish', async () => {
    setLanguage('es');
    const { out } = await run(['pending', 'define', KEY, '20000']);
    const text = flat(out);
    expect(text).toContain(`✔ ${KEY} = 20000`);
    expect(text).toContain('1 definición sigue pendiente.');
  });

  it('an unknown key: the error text is Spanish', async () => {
    setLanguage('es');
    const { errors } = await run(['pending', 'define', 'no-such-key']);
    expect(String((errors[0] as Error).message)).toContain('No hay una decisión pendiente con la clave "no-such-key"');
  });

  it('dismiss and reopen confirm in Spanish; en keeps the English lines', async () => {
    setLanguage('es');
    expect(flat((await run(['pending', 'dismiss', KEY])).out)).toContain(`✘ ${KEY} descartada.`);
    expect(mockDismiss).toHaveBeenCalled();
    expect(flat((await run(['pending', 'reopen', KEY])).out)).toContain(`↻ ${KEY} vuelve a estar pendiente.`);
    expect(mockReopen).toHaveBeenCalled();
    setLanguage('en');
    expect(flat((await run(['pending', 'dismiss', KEY])).out)).toContain(`✘ ${KEY} dismissed.`);
  });
});

// ------------------------------------------------------------
describe('getPendingBoard summaries come out in the active language', () => {
  function serve(sources: { drafts?: unknown[]; creds?: unknown[]; periods?: unknown[] }) {
    mockQuery.mockImplementation((sql?: unknown) => {
      const q = String(sql);
      if (q.includes('ai_drafts')) return Promise.resolve({ rows: sources.drafts ?? [] });
      if (q.includes('fiscal_credentials')) return Promise.resolve({ rows: sources.creds ?? [] });
      if (q.includes('fiscal_periods')) return Promise.resolve({ rows: sources.periods ?? [] });
      return Promise.resolve({ rows: [] });
    });
  }
  const summaryOf = async (kind: string) =>
    (await getPendingBoard(CTX as never)).items.find((i) => i.kind === kind)!;

  it('es: plural, period example and the credential message agree in gender', async () => {
    setLanguage('es');
    serve({
      drafts: [{ description: 'a', total: '1' }, { description: 'b', total: '2' }],
      periods: [{ period_name: 'Julio 2026', end_date: '2026-07-31' }],
      creds: [{ credential_type: 'efirma', days: '-1' }],
    });
    expect((await summaryOf('draft')).summary).toBe('2 borradores esperan tu aprobación');
    const period = await summaryOf('period_close');
    expect(period.summary).toBe('1 periodo terminado sigue sin cerrar');
    expect(period.examples![0]).toBe('Julio 2026 (terminó el 2026-07-31)');
    expect((await summaryOf('credential_expiry')).summary).toBe('tu e.firma YA VENCIÓ: renuévala en el SAT');

    serve({ creds: [{ credential_type: 'csd', days: '0' }] });
    expect((await summaryOf('credential_expiry')).summary).toBe('tu CSD YA VENCIÓ: renuévalo en el SAT');
    serve({ creds: [{ credential_type: 'csd', days: '1' }] });
    expect((await summaryOf('credential_expiry')).summary).toBe('tu CSD vence en 1 día');
  });

  it('en: the same sources read as before', async () => {
    setLanguage('en');
    serve({ drafts: [{ description: 'a', total: '1' }], creds: [{ credential_type: 'csd', days: '-2' }] });
    expect((await summaryOf('draft')).summary).toBe('1 draft awaits your approval');
    expect((await summaryOf('credential_expiry')).summary).toBe('your CSD has ALREADY EXPIRED — renew it at the SAT');
  });
});
