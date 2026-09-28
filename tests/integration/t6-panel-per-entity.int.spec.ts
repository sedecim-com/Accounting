import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createDraft, rejectDraft } from '../../src/ai/draft-service.js';
import { registrarVeredictoSombra, concordanciaSombra } from '../../src/ai/shadow-verdicts.js';
import { seedPolicies, getPolicy, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { resolverUmbralesConPanel } from '../../src/ai/ingest-thresholds.js';
import { registerPendingCommands } from '../../src/cli/pending-command.js';
import { FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_VEREDICTOS } from '../../src/ai/floor.js';
import type { AgentContext } from '../../src/ai/context.js';

// ============================================================
// T6 (#93, remainder c) · THE POLICY PANEL IS PER ENTITY
//
// The service already knew how to scope a decision to one entity (017,
// A7), but no surface ever wrote an entity row: `pending define` previewed
// with `--entity` and resolved with `{ tenantId }` alone, `dismiss` and
// `reopen` had no entity in their WHERE, and `concordanciaSombra` turned its
// own entity filter off when handed a NULL — so the evidence of the busy
// company switched auto-posting on for a freshly created sibling.
//
// Driven through the real `pending` command against Postgres, with two
// entities A and B in one tenant.
// ============================================================

let f: Fixture;
let entityB: string;
let ctxA: AgentContext;
let ctxB: AgentContext;
let reviewer: string;

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

/** Runs `mnemosine pending ...` for real and returns what it printed and its exit code. */
async function pending(argv: string[], answers: string[] = []) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const logOriginal = console.log;
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  };
  try {
    const p = new Command('mnemosine');
    p.exitOverride();
    registerPendingCommands(p, {
      color: plain,
      colorErr: { dim: (s) => s, red: (s) => s },
      shutdown: (async (c: number) => {
        exitCode = c;
      }) as unknown as (code: number) => Promise<never>,
      reportError: (e: unknown) => {
        errs.push(e);
      },
      ask: async () => answers.shift() ?? null,
    });
    // Only the writers that record an author take --user.
    const who = argv[0] === 'define' || argv[0] === 'dismiss' ? ['--user', reviewer] : [];
    await p.parseAsync(['node', 'mnemosine', 'pending', ...argv, ...who]);
  } finally {
    console.log = logOriginal;
  }
  return { exitCode, errs, out: out.join('\n'), err: errs.map(String).join('\n') };
}

async function rowOf(entityId: string | null, key: string) {
  const r = await query<{ status: string; resolved_value: string | null }>(
    `SELECT status, resolved_value FROM policy_decisions
      WHERE tenant_id = $1 AND key = $2 AND entity_id IS NOT DISTINCT FROM $3::uuid`,
    [f.tenantId, key, entityId]
  );
  return r.rows[0];
}

const day = () => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function draftIn(ctx: AgentContext) {
  return createDraft(ctx, {
    payload: {
      entry_date: day(),
      description: 'T6 per-entity evidence',
      lines: [
        { account_code: '6100', debit: 100 },
        { account_code: '1110', credit: 100 },
      ],
    },
    confidence: 0.7,
    reasoning: 'test',
    model: 'claude-test',
  });
}

/** Shadow evidence that clears the floor, recorded in ONE entity only. */
async function evidenceIn(ctx: AgentContext): Promise<void> {
  for (let i = 0; i < FLOOR_SOMBRA_VEREDICTOS; i++) {
    const draft = await draftIn(ctx);
    await registrarVeredictoSombra(ctx, {
      draftId: draft.id, wouldAutoPost: false, motivo: 'new vendor (no match)', thresholds: {},
    });
    await rejectDraft(ctx, draft.id, { userId: f.userId, email: reviewer }, 'does not apply');
    await query(
      `UPDATE ai_shadow_verdicts SET created_at = NOW() - ($2 || ' days')::interval WHERE draft_id = $1`,
      [draft.id, String(i % FLOOR_SOMBRA_DIAS)]
    );
  }
}

beforeAll(async () => {
  f = await crearInquilino('T6 entity A');
  reviewer = `it-${f.userId.slice(0, 8)}@example.test`;
  const r = await query<{ id: string }>(
    `INSERT INTO legal_entities (
       id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
       incorporation_country, functional_currency, accounting_standard,
       fiscal_year_start_month, is_active
     )
     SELECT gen_random_uuid(), tenant_id, organization_id, 'T6 entity B',
            entity_type, 'XAXX010101002', tax_id_type, incorporation_country,
            functional_currency, accounting_standard, fiscal_year_start_month, true
       FROM legal_entities WHERE id = $1
     RETURNING id`,
    [f.entityId]
  );
  entityB = r.rows[0].id;
  const base = {
    tenantId: f.tenantId, currency: 'MXN', country: 'MX',
    accountingStandard: 'mx_nif' as const, taxId: 'XAXX010101000',
  };
  ctxA = { ...base, entityId: f.entityId, entityName: 'T6 entity A' };
  ctxB = { ...base, entityId: entityB, entityName: 'T6 entity B' };
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('pending define --entity A does not change B', () => {
  it('the answer lands on A only; B and the tenant row stay on the default', async () => {
    const r = await pending(['define', 'ingest_auto_post', 'shadow', '--entity', f.entityId]);
    expect(r.exitCode, r.err).toBe(0);

    expect((await getPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'ingest_auto_post')).value).toBe('shadow');
    const inB = await getPolicy({ tenantId: f.tenantId, entityId: entityB }, 'ingest_auto_post');
    expect(inB.defined, 'B answered nothing').toBe(false);
    expect((await rowOf(null, 'ingest_auto_post')).status, 'the tenant row governs every entity').toBe('pending');
  });

  it("the listing is the entity's: A no longer lists the key, B still does", async () => {
    const a = await pending(['--entity', f.entityId]);
    const b = await pending(['--entity', entityB]);
    expect(a.out).not.toMatch(/ingest_auto_post\b/);
    expect(b.out).toMatch(/ingest_auto_post\b/);
  });
});

describe("concordanciaSombra counts only the entity's evidence", () => {
  beforeAll(async () => {
    await evidenceIn(ctxA);
    // One draft in B with no shadow verdict, so B's preview has something
    // to say — and what it says must be B's own history, not A's.
    // B has no chart or periods of its own, so its draft goes in by SQL: the
    // preview only counts B's drafts.
    await query(
      `INSERT INTO ai_drafts (id, tenant_id, entity_id, draft_type, status, payload,
         ai_confidence, ai_reasoning, ai_model)
       VALUES (gen_random_uuid(), $1, $2, 'journal_entry', 'pending_review', '{"lines":[]}'::jsonb,
         0.70, 'T6 B draft', 'claude-test')`,
      [f.tenantId, entityB]
    );
  }, 120_000);

  it("A's evidence does not switch on B: preview and refusal both speak of B", async () => {
    expect((await concordanciaSombra(ctxA)).decididos).toBeGreaterThanOrEqual(FLOOR_SOMBRA_VEREDICTOS);
    // Interactive define: the preview printed before the prompt and the
    // resolution after it must be measured on the SAME entity.
    const r = await pending(['define', 'ingest_auto_post', '--entity', entityB], ['on']);
    expect(r.out, 'the preview is B\'s: no shadow history').toMatch(/no shadow history yet/);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toMatch(/evidencia de sombra/);
    expect((await rowOf(entityB, 'ingest_auto_post'))?.status ?? 'absent').not.toBe('resolved');

    const thresholds = await resolverUmbralesConPanel({}, ctxB, __dirname);
    expect(thresholds.autoPost, "B's auto-posting stays off").toBe(false);
  });

  it('a tenant-wide answer cannot switch it on either: that scope has no evidence of its own', async () => {
    await expect(
      resolvePolicy({ tenantId: f.tenantId }, 'ingest_auto_post', 'on', reviewer)
    ).rejects.toThrow(/per entity|por entidad/);
    expect((await rowOf(null, 'ingest_auto_post')).status).toBe('pending');
  });

  it("and A, with its own evidence, does switch on: the preview shows A's verdicts", async () => {
    const reopened = await pending(['reopen', 'ingest_auto_post', '--entity', f.entityId]);
    expect(reopened.exitCode, reopened.err).toBe(0);
    const r = await pending(['define', 'ingest_auto_post', '--entity', f.entityId], ['on']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.out).toMatch(/shadow: \d+ verdict/);
    expect((await rowOf(f.entityId, 'ingest_auto_post')).resolved_value).toBe('on');
    expect((await getPolicy({ tenantId: f.tenantId, entityId: entityB }, 'ingest_auto_post')).defined).toBe(false);
  });
});

describe('pending dismiss and reopen with --entity touch only that row', () => {
  const KEY = 'politica_restaurantes';

  it('dismiss in A leaves B and the tenant row pending', async () => {
    const r = await pending(['dismiss', KEY, '--entity', f.entityId]);
    expect(r.exitCode, r.err).toBe(0);
    expect((await rowOf(f.entityId, KEY)).status).toBe('dismissed');
    expect((await rowOf(null, KEY)).status).toBe('pending');
    expect(await rowOf(entityB, KEY)).toBeUndefined();
  });

  it('reopen in A brings back only A', async () => {
    const r = await pending(['reopen', KEY, '--entity', f.entityId]);
    expect(r.exitCode, r.err).toBe(0);
    expect((await rowOf(f.entityId, KEY)).status).toBe('pending');
    expect((await rowOf(null, KEY)).status).toBe('pending');
  });

  it('reopening in B an answer B inherited from the tenant does not reopen it for A', async () => {
    const KEY2 = 'tratamiento_ieps';
    await resolvePolicy({ tenantId: f.tenantId }, KEY2, 'costo', reviewer);

    const r = await pending(['reopen', KEY2, '--entity', entityB]);
    expect(r.exitCode, r.err).toBe(0);
    expect((await rowOf(entityB, KEY2)).status).toBe('pending');
    expect((await rowOf(null, KEY2)).status, 'the tenant answer still governs A').toBe('resolved');
    expect((await getPolicy({ tenantId: f.tenantId, entityId: f.entityId }, KEY2)).value).toBe('costo');
    expect((await getPolicy({ tenantId: f.tenantId, entityId: entityB }, KEY2)).defined).toBe(false);
  });
});
