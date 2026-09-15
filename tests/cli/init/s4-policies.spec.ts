import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/ai/context.js', () => ({
  resolveEntity: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/policy/policy-service.js')>();
  return {
    seedPolicies: vi.fn(),
    listPending: vi.fn(),
    listPolicies: vi.fn(),
    resolvePolicy: vi.fn(),
    // The real wording seam: the wizard must paint what it decides, not a stub.
    policyWording: actual.policyWording,
  };
});
vi.mock('../../../src/services/policy/policy-preview.js', () => ({
  previewFor: vi.fn(),
}));

import { PoliciesSection } from '../../../src/cli/init/s4-policies.js';
import { resolveEntity } from '../../../src/ai/context.js';
import {
  seedPolicies, listPending, listPolicies, resolvePolicy,
} from '../../../src/services/policy/policy-service.js';
import { previewFor } from '../../../src/services/policy/policy-preview.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';

const mockResolveEntity = resolveEntity as unknown as Mock;
const mockListPending = listPending as unknown as Mock;
const mockListPolicies = listPolicies as unknown as Mock;
const mockResolve = resolvePolicy as unknown as Mock;
const mockPreview = previewFor as unknown as Mock;

const ENTITY = {
  entityId: 'e1', entityName: 'Acme MX', tenantId: 't1',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AAA010101AAA',
};

/** A row as it comes from the DB: with the wording it had at seed time. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1', key: 'umbral_capitalizacion_mxn', category: 'contable',
    question: 'TEXTO VIEJO DE LA BASE',
    impact: 'IMPACTO VIEJO DE LA BASE',
    options: [{ value: 'viejo', label: 'opción vieja' }],
    default_value: '20000', default_rationale: 'r',
    status: 'pending', resolved_value: null, resolved_by: null,
    resolved_at: null, resolution_notes: null, priority: 10, entity_id: null,
    ...overrides,
  };
}

/** Captures the wizard's output and feeds it scripted answers. */
function harness(answers: string[]) {
  const lines: string[] = [];
  let i = 0;
  return {
    lines,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEntity.mockResolvedValue(ENTITY);
  (seedPolicies as unknown as Mock).mockResolvedValue({ inserted: 0 });
  mockPreview.mockResolvedValue([]);
  mockListPending.mockResolvedValue([]);
  mockListPolicies.mockResolvedValue([]);
});

describe('explains before asking', () => {
  it('shows why it asks and what it will do with the answer', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toMatch(/Why I ask:/);
    expect(h.out()).toMatch(/What I do:/);
    // `policyWording` carries no `whyAsking`/`whatIDo`: those still come from
    // the spec. The impact only replaces a missing `whyAsking`; without
    // `whatIDo` the line is simply not printed.
    const spec = POLICY_CATALOG.find((p) => p.key === 'umbral_capitalizacion_mxn')!;
    const flat = h.out().replace(/\s+/g, ' ');
    expect(flat).toContain(`Why I ask: ${spec.whyAsking!.replace(/\s+/g, ' ')}`);
    expect(flat).toContain(`What I do: ${spec.whatIDo!.replace(/\s+/g, ' ')}`);
  });

  it('takes the wording from the CATALOG, not from the stale DB copy', async () => {
    // The DB stores a text copied at seed time; if the catalog is reworded
    // (or translated) the row goes stale. The wizard must show the current one.
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    const spec = POLICY_CATALOG.find((p) => p.key === 'umbral_capitalizacion_mxn')!;
    expect(h.out()).toContain(spec.question);
    expect(h.out()).not.toContain('TEXTO VIEJO DE LA BASE');
    expect(h.out()).toContain(spec.options[0].label);
    expect(h.out()).not.toContain('opción vieja');
  });

  it('falls back to the row snapshot only for a key the catalog no longer has', async () => {
    const orphanKey = 'retired_policy_not_in_catalog';
    expect(POLICY_CATALOG.find((p) => p.key === orphanKey)).toBeUndefined();
    mockListPending.mockResolvedValue([
      row({
        key: orphanKey,
        question: 'SNAPSHOT QUESTION OF A RETIRED POLICY',
        impact: 'SNAPSHOT IMPACT OF A RETIRED POLICY',
        options: [
          { value: 'snapshot_a', label: 'SNAPSHOT OPTION A' },
          { value: 'snapshot_b', label: 'SNAPSHOT OPTION B' },
        ],
        default_value: 'snapshot_a',
      }),
    ]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toContain('SNAPSHOT QUESTION OF A RETIRED POLICY');
    // No spec means no `whyAsking`: the snapshot impact is what explains it.
    expect(h.out()).toContain('Why I ask: SNAPSHOT IMPACT OF A RETIRED POLICY');
    expect(h.out()).toContain('2) SNAPSHOT OPTION B');
  });

  it('a live key without `whyAsking` is explained by the catalog impact, not the row copy', async () => {
    // While the spec carries a `whyAsking` the impact fallback is never
    // reached, so this test takes it away for one run and puts it back.
    const spec = POLICY_CATALOG.find((p) => p.key === 'umbral_capitalizacion_mxn')!;
    const saved = spec.whyAsking;
    delete spec.whyAsking;
    try {
      mockListPending.mockResolvedValue([row()]);
      const h = harness(['']);
      await new PoliciesSection().configure(h.ctx);
      const flat = h.out().replace(/\s+/g, ' ');
      expect(flat).toContain(`Why I ask: ${spec.impact.replace(/\s+/g, ' ')}`);
      expect(flat).not.toContain('IMPACTO VIEJO DE LA BASE');
    } finally {
      spec.whyAsking = saved;
    }
  });

  it('tells the user what happens if they skip it', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['']); // Enter = skip
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toMatch(/Left open:/);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('marks which option is the current default', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toMatch(/← current default/);
  });
});

describe('impact preview', () => {
  it('shows the impact computed on the company own data', async () => {
    mockListPending.mockResolvedValue([row()]);
    mockPreview.mockResolvedValue([
      'Of your 47 received invoices:',
      '  · with $20,000 MXN → I would ask you 8 times (17%)',
    ]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toMatch(/In your data:/);
    expect(h.out()).toMatch(/47 received invoices/);
  });

  it('omits the section entirely when there is no data to show', async () => {
    mockListPending.mockResolvedValue([row()]);
    mockPreview.mockResolvedValue([]);
    const h = harness(['']);
    await new PoliciesSection().configure(h.ctx);
    // Inventing an example would be worse than staying silent.
    expect(h.out()).not.toMatch(/In your data:/);
  });
});

describe('answers', () => {
  it('records the value chosen by number', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['3']);
    await new PoliciesSection().configure(h.ctx);
    const spec = POLICY_CATALOG.find((p) => p.key === 'umbral_capitalizacion_mxn')!;
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'umbral_capitalizacion_mxn', spec.options[2].value,
      'admin@demo.com', expect.any(String)
    );
  });

  it('the number typed is the option printed next to it, for every printed number', async () => {
    // The row's list has ONE stale option; the catalog's has three. Indexing
    // a different list than the one printed saves the stale value or, past
    // its end, the bare digit.
    const spec = POLICY_CATALOG.find((p) => p.key === 'umbral_capitalizacion_mxn')!;
    for (let n = 1; n <= spec.options.length; n++) {
      mockResolve.mockClear();
      mockListPending.mockResolvedValue([row()]);
      const h = harness([String(n)]);
      await new PoliciesSection().configure(h.ctx);

      const printedLabel = h.lines
        .map((l) => new RegExp(`^ {5}${n}\\) (.+?)(?: {3}← current default)?$`).exec(l)?.[1])
        .find((l) => l !== undefined);
      const printed = spec.options.find((o) => o.label === printedLabel);
      expect(printed, `option ${n} printed a label the catalog does not have`).toBeDefined();
      expect(mockResolve).toHaveBeenCalledWith(
        { tenantId: 't1' }, 'umbral_capitalizacion_mxn', printed!.value,
        'admin@demo.com', expect.any(String)
      );
    }
  });

  it('an orphan key maps the typed number onto its snapshot list', async () => {
    mockListPending.mockResolvedValue([
      row({
        key: 'retired_policy_not_in_catalog',
        options: [
          { value: 'snapshot_a', label: 'SNAPSHOT OPTION A' },
          { value: 'snapshot_b', label: 'SNAPSHOT OPTION B' },
        ],
      }),
    ]);
    const h = harness(['2']);
    await new PoliciesSection().configure(h.ctx);
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'retired_policy_not_in_catalog', 'snapshot_b',
      'admin@demo.com', expect.any(String)
    );
  });

  it('accepts a free-form value outside the options', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['35000']);
    await new PoliciesSection().configure(h.ctx);
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'umbral_capitalizacion_mxn', '35000', 'admin@demo.com', expect.any(String)
    );
  });

  // A TYPED VALUE IS SAVED AS TYPED (src/cli/policy-answer.ts). Before, the
  // wizard read «1.00» as position 1 and saved 0.25 for the vacation premium.
  it('typing an option value that parses to a position saves the value, not the position', async () => {
    mockListPending.mockResolvedValue([row({ key: 'prima_vacacional_pct', default_value: '0.25' })]);
    const h = harness(['1.00']);
    await new PoliciesSection().configure(h.ctx);
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'prima_vacacional_pct', '1.00', 'admin@demo.com', expect.any(String)
    );
  });

  it('an integer that is both a position and another option value is asked, and v keeps the value', async () => {
    const spec = POLICY_CATALOG.find((p) => p.key === 'rep_ventana_dias')!;
    expect(spec.options.map((o) => o.value)).toContain('3');
    expect(spec.options[2].value).not.toBe('3');
    mockListPending.mockResolvedValue([row({ key: 'rep_ventana_dias', default_value: spec.defaultValue })]);
    const h = harness(['3', 'v']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toContain('is both option 3');
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'rep_ventana_dias', '3', 'admin@demo.com', expect.any(String)
    );
  });

  it('p takes the position, an unrecognised reply asks again, and empty saves nothing', async () => {
    const spec = POLICY_CATALOG.find((p) => p.key === 'rep_ventana_dias')!;
    mockListPending.mockResolvedValue([row({ key: 'rep_ventana_dias', default_value: spec.defaultValue })]);
    const byPosition = harness(['3', 'maybe', 'p']);
    await new PoliciesSection().configure(byPosition.ctx);
    expect(byPosition.out().split('is both option 3').length - 1).toBe(2);
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'rep_ventana_dias', spec.options[2].value, 'admin@demo.com', expect.any(String)
    );

    mockResolve.mockClear();
    mockListPending.mockResolvedValue([row({ key: 'rep_ventana_dias', default_value: spec.defaultValue })]);
    const cancelled = harness(['3', '']);
    await new PoliciesSection().configure(cancelled.ctx);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('stops asking on q and leaves the rest on defaults', async () => {
    mockListPending.mockResolvedValue([row(), row({ id: 'p2', key: 'ingest_auto_post' })]);
    const h = harness(['q']);
    await new PoliciesSection().configure(h.ctx);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(h.out()).toMatch(/Stopping here/);
  });

  it('keeps going when one answer fails to save', async () => {
    mockListPending.mockResolvedValue([row(), row({ id: 'p2', key: 'ingest_auto_post' })]);
    mockResolve.mockRejectedValueOnce(new Error('db down'));
    const h = harness(['1', '1']);
    await new PoliciesSection().configure(h.ctx);
    expect(h.out()).toMatch(/Could not save/);
    expect(mockResolve).toHaveBeenCalledTimes(2); // did not abort the section
  });
});

describe('non-interactive mode', () => {
  it('asks nothing and reports what stays on defaults', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness([]);
    await new PoliciesSection().configure({ ...h.ctx, rl: null, flags: { yes: true } });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(h.out()).toMatch(/Non-interactive mode/);
    expect(h.out()).toMatch(/umbral_capitalizacion_mxn = 20000/);
  });
});

describe('status and verify', () => {
  it('is ok only when nothing is pending', async () => {
    mockListPolicies.mockResolvedValue([row({ status: 'resolved', resolved_value: '50000' })]);
    expect(await new PoliciesSection().status()).toBe('ok');
  });

  it('is partial when some are defined and some are not', async () => {
    mockListPolicies.mockResolvedValue([
      row({ status: 'resolved', resolved_value: '50000' }),
      row({ id: 'p2', key: 'ingest_auto_post' }),
    ]);
    expect(await new PoliciesSection().status()).toBe('partial');
  });

  it('warns about the policies that change how invoices get booked', async () => {
    mockListPolicies.mockResolvedValue([row({ key: 'ingest_auto_post' })]);
    const checks = await new PoliciesSection().verify();
    const warn = checks.find((c) => c.name === 'High-impact policies');
    expect(warn?.level).toBe('warn');
    expect(warn?.detail).toMatch(/ingest_auto_post/);
  });

  it('never blocks setup: the section is optional', () => {
    expect(new PoliciesSection().required).toBe(false);
  });
});

describe('catalog quality', () => {
  it('every policy explains why it is asked and what will be done', () => {
    const incomplete = POLICY_CATALOG.filter((p) => !p.whyAsking || !p.whatIDo || !p.ifSkipped);
    expect(
      incomplete.map((p) => p.key),
      'policies without an onboarding explanation'
    ).toEqual([]);
  });

  it('the explanation says something more than the question itself', () => {
    for (const p of POLICY_CATALOG) {
      expect(p.whyAsking!.length, p.key).toBeGreaterThan(p.question.length);
    }
  });

  it('every default is one of the offered options', () => {
    for (const p of POLICY_CATALOG) {
      expect(p.options.map((o) => o.value), p.key).toContain(p.defaultValue);
    }
  });
});
