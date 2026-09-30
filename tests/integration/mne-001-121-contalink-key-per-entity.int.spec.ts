import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { setVaultForTesting, type SecretContext, type SecretVault } from '../../src/services/vault/index.js';
import {
  storeExternalCredential,
  ExternalCredentialError,
} from '../../src/services/integrations/accounting/entity-credentials.js';
import { executeExternalOp, queueExternalOp } from '../../src/ai/external-service.js';
import type { AgentContext } from '../../src/ai/context.js';

// ============================================================
// MNE-001-121 (#357, ADR-0004): the Contalink key belongs to one entity and
// to its RFC. Real database, simulated Contalink (a stubbed fetch that maps
// each key to the company it opens): no network, no real key or RFC. The two
// entities are siblings in ONE tenant, the case where RLS bounds nothing and
// only the entity scope keeps one company's writes out of the other.
// ============================================================

// SAT test RFCs, never real taxpayers.
const RFC_A = 'EKU9003173C9';
const RFC_B = 'IIA040805DZ4';
const KEY_A = 'test-key-company-a';
const KEY_B = 'test-key-company-b';
const COMPANY_BY_KEY: Record<string, string> = { [KEY_A]: 'company-a', [KEY_B]: 'company-b' };

let a: Fixture;
let b: Fixture;
const vaultBlobs = new Map<string, Buffer>();
const calls: Array<{ key: string; path: string }> = [];

const vaultName = (ctx: SecretContext) => `test://${ctx.tenantId}/${ctx.entityId}/${ctx.kind}`;

const ctxOf = (f: Fixture, taxId: string): AgentContext => ({
  entityId: f.entityId, tenantId: f.tenantId, entityName: `entity ${taxId}`,
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId,
});

const POLICY = {
  record_date: '2026-08-24', description: 'MNE-001-121',
  records: [{ account_code: '1110', debit: 100, credit: 0 }, { account_code: '4100', debit: 0, credit: 100 }],
};

async function insertPendingOp(f: Fixture): Promise<string> {
  // Straight into the queue, as an op queued before the key existed would be.
  const id = uuidv4();
  await query(
    `INSERT INTO ai_external_ops (id, tenant_id, entity_id, provider, operation, payload, ai_reasoning, ai_model)
     VALUES ($1, $2, $3, 'contalink', 'create_policy', $4::jsonb, 'test', 'test')`,
    [id, f.tenantId, f.entityId, JSON.stringify(POLICY)]
  );
  return id;
}

async function opRow(id: string): Promise<{ status: string; error: string | null; result: unknown }> {
  const r = await query<{ status: string; error: string | null; result: unknown }>(
    'SELECT status, error, result FROM ai_external_ops WHERE id = $1', [id]
  );
  return r.rows[0];
}

beforeAll(async () => {
  a = await crearInquilino('MNE-001-121 entity A');
  b = await crearEntidadHermana(a, 'MNE-001-121 entity B');
  await query('UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3', [RFC_A, a.entityId, a.tenantId]);
  await query('UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3', [RFC_B, b.entityId, b.tenantId]);
  setVaultForTesting({
    backend: 'test',
    put: async (ctx: SecretContext, blob: Buffer) => {
      vaultBlobs.set(vaultName(ctx), Buffer.from(blob));
      return { backend: 'test', ref: vaultName(ctx) };
    },
    get: async (ctx: SecretContext, ref: { ref: string }) => {
      if (ref.ref !== vaultName(ctx)) throw new Error('vault context mismatch');
      return Buffer.from(vaultBlobs.get(ref.ref)!);
    },
    destroy: async () => undefined,
    healthCheck: async () => ({ healthy: true }),
  } as SecretVault);
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    const key = init.headers.Authorization;
    calls.push({ key, path: new URL(url).pathname });
    return new Response(JSON.stringify({ status: 1, company: COMPANY_BY_KEY[key] ?? 'unknown' }), { status: 200 });
  });
});

beforeEach(() => {
  calls.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  setVaultForTesting(null);
  await closeDatabase();
});

describe('MNE-001-121 · the Contalink key is bound to its entity and its RFC', () => {
  it('without a key, the approved op fails BEFORE any call to Contalink and says what is missing', async () => {
    const id = await insertPendingOp(a);
    await expect(executeExternalOp(ctxOf(a, RFC_A), id, 'reviewer@test')).rejects.toThrow(/no contalink key registered/);
    expect(calls).toEqual([]);
    const row = await opRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/no contalink key registered/);
  });

  it('refuses to register a key declared for another RFC, before it reaches the vault', async () => {
    await expect(storeExternalCredential({
      tenantId: a.tenantId, entityId: a.entityId, provider: 'contalink',
      rfc: RFC_B, apiKey: Buffer.from(KEY_B), registeredBy: 'owner@test',
    })).rejects.toThrow(ExternalCredentialError);
    expect(vaultBlobs.size).toBe(0);
  });

  it('two entities in one run: each approved op reaches its own company, and the key is never in the database', async () => {
    for (const [f, rfc, key] of [[a, RFC_A, KEY_A], [b, RFC_B, KEY_B]] as const) {
      await storeExternalCredential({
        tenantId: f.tenantId, entityId: f.entityId, provider: 'contalink',
        rfc: rfc.toLowerCase(), apiKey: Buffer.from(key), registeredBy: 'owner@test',
      });
    }
    const opA = await queueExternalOp(ctxOf(a, RFC_A), {
      provider: 'contalink', operation: 'create_policy', payload: POLICY, reasoning: 'a', model: 'm',
    });
    const opB = await queueExternalOp(ctxOf(b, RFC_B), {
      provider: 'contalink', operation: 'create_policy', payload: POLICY, reasoning: 'b', model: 'm',
    });

    const resultB = await executeExternalOp(ctxOf(b, RFC_B), opB, 'reviewer@test');
    const resultA = await executeExternalOp(ctxOf(a, RFC_A), opA, 'reviewer@test');

    expect(resultA.result.company).toBe('company-a');
    expect(resultB.result.company).toBe('company-b');
    expect(calls.map((c) => c.key)).toEqual([KEY_B, KEY_A]);

    // The table keeps the vault reference, the RFC and the status; no row
    // anywhere in the credential table or the queue carries the key itself.
    const creds = await query<{ rfc: string; row: string }>(
      `SELECT rfc, row_to_json(c)::text AS row FROM external_system_credentials c
       WHERE tenant_id = $1 ORDER BY rfc`, [a.tenantId]
    );
    expect(creds.rows.map((r) => r.rfc)).toEqual([RFC_A, RFC_B]);
    const ops = await query<{ row: string }>(
      'SELECT row_to_json(o)::text AS row FROM ai_external_ops o WHERE tenant_id = $1', [a.tenantId]
    );
    for (const { row } of [...creds.rows, ...ops.rows]) {
      expect(row).not.toContain(KEY_A);
      expect(row).not.toContain(KEY_B);
    }
  });

  it('when the entity\'s RFC no longer matches the key\'s, the op is refused without calling Contalink', async () => {
    const id = await insertPendingOp(a);
    await query('UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3', ['XAXX010101000', a.entityId, a.tenantId]);
    try {
      await expect(executeExternalOp(ctxOf(a, 'XAXX010101000'), id, 'reviewer@test'))
        .rejects.toThrow(new RegExp(`registered for RFC ${RFC_A}.*entity's RFC is XAXX010101000`));
      expect(calls).toEqual([]);
      expect((await opRow(id)).status).toBe('failed');
    } finally {
      await query('UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3', [RFC_A, a.entityId, a.tenantId]);
    }
  });
});
