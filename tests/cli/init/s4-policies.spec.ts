import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/ai/context.js', () => ({
  resolveEntity: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  seedPolicies: vi.fn(),
  listPending: vi.fn(),
  listPolicies: vi.fn(),
  resolvePolicy: vi.fn(),
}));
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

  it('accepts a free-form value outside the options', async () => {
    mockListPending.mockResolvedValue([row()]);
    const h = harness(['35000']);
    await new PoliciesSection().configure(h.ctx);
    expect(mockResolve).toHaveBeenCalledWith(
      { tenantId: 't1' }, 'umbral_capitalizacion_mxn', '35000', 'admin@demo.com', expect.any(String)
    );
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
