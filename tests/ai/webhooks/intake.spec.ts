import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(async (_tenant: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import {
  hashToken,
  issueWebhookToken,
  verifyWebhookToken,
  touchWebhookToken,
  deriveDocumentKey,
  recordDelivery,
  markDeliveryOutcome,
  listWebhookTokens,
  disableWebhookToken,
  type WebhookTokenRow,
  type WebhookDeliveryRow,
} from '../../../src/ai/webhooks/intake.js';
import { query } from '../../../src/database/connection.js';
import { logger } from '../../../src/utils/logger.js';
import type { AgentContext } from '../../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function tokenRow(overrides: Partial<WebhookTokenRow> = {}): WebhookTokenRow {
  return {
    id: 'tok-1', tenant_id: 'tenant-a', entity_id: 'entity-1', name: 'bank-bbva',
    token_hash: sha256('raw-secret'), source_kind: 'bank_notification', enabled: true,
    created_by: 'ops@acme.mx', created_at: new Date('2026-08-01T00:00:00Z'), last_used_at: null,
    ...overrides,
  };
}

function deliveryRow(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: 'del-1', token_id: 'tok-1', tenant_id: 'tenant-a', entity_id: 'entity-1',
    document_key: 'tx-777', received_at: new Date('2026-08-24T10:00:00Z'),
    status: 'received', suspicion: null, drafts_created: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ─── Token hash roundtrip ───

describe('issueWebhookToken', () => {
  it('stores only the sha256 hash of the raw token and returns the raw token once', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tokenRow()], rowCount: 1 });
    const issued = await issueWebhookToken(CTX, {
      name: 'bank-bbva', sourceKind: 'bank_notification', createdBy: 'ops@acme.mx',
    });

    expect(issued.rawToken).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO ai_webhook_tokens');
    expect(params).toContain(hashToken(issued.rawToken));
    // The raw token itself never reaches SQL.
    expect(params).not.toContain(issued.rawToken);
    expect(hashToken(issued.rawToken)).toBe(sha256(issued.rawToken));
  });

  it('scopes the insert to the context tenant and entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tokenRow()], rowCount: 1 });
    await issueWebhookToken(CTX, { name: 'x1', sourceKind: 'generic', createdBy: 'me' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain('tenant-a');
    expect(params).toContain('entity-1');
  });

  it('rejects names that are not URL-safe slugs', async () => {
    await expect(
      issueWebhookToken(CTX, { name: 'Bad Name!', sourceKind: 'generic', createdBy: 'me' })
    ).rejects.toThrow(/Invalid webhook name/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects unknown source kinds', async () => {
    await expect(
      issueWebhookToken(CTX, {
        name: 'ok', sourceKind: 'evil' as never, createdBy: 'me',
      })
    ).rejects.toThrow(/Invalid source kind/);
  });
});

// ─── Constant-time verification ───

describe('verifyWebhookToken', () => {
  it('returns the row when the recomputed hash matches', async () => {
    const row = tokenRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const match = await verifyWebhookToken('raw-secret', 'bank-bbva');
    expect(match).toEqual(row);
    // Lookup is keyed on the token's OWN hash, scoped to the routing name —
    // NO name-only candidate window (no LIMIT), so same-name tokens cannot
    // shadow this one out of a bounded scan.
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE token_hash = $1 AND name = $2 AND enabled = true');
    expect(sql).not.toMatch(/LIMIT/i);
    expect(params).toEqual([sha256('raw-secret'), 'bank-bbva']);
  });

  it('resists same-name shadowing: the victim verifies even amid many same-name tokens', async () => {
    // The hash-scoped query returns exactly the row whose token_hash matches
    // the presented secret, regardless of how many same-name tokens exist in
    // other tenants (the old LIMIT 25 name window could evict this row).
    const victim = tokenRow({ id: 'victim', tenant_id: 'tenant-a' });
    mockQuery.mockResolvedValueOnce({ rows: [victim], rowCount: 1 });
    const match = await verifyWebhookToken('raw-secret', 'bank-bbva');
    expect(match?.id).toBe('victim');
    // The presented hash is the SQL filter, so a flood of same-name rows never
    // participates in the lookup.
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(sha256('raw-secret'));
  });

  it('returns null for a wrong secret even when the name exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tokenRow()], rowCount: 1 });
    expect(await verifyWebhookToken('wrong-secret', 'bank-bbva')).toBeNull();
  });

  it('returns null without querying for a malformed token name', async () => {
    expect(await verifyWebhookToken('raw-secret', '../etc/passwd')).toBeNull();
    expect(await verifyWebhookToken('', 'bank-bbva')).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('disambiguates same-name tokens across tenants by hash', async () => {
    const other = tokenRow({ id: 'tok-2', tenant_id: 'tenant-b', token_hash: sha256('other-secret') });
    mockQuery.mockResolvedValueOnce({ rows: [other, tokenRow()], rowCount: 2 });
    const match = await verifyWebhookToken('raw-secret', 'bank-bbva');
    expect(match?.tenant_id).toBe('tenant-a');
  });
});

describe('touchWebhookToken', () => {
  it('updates last_used_at guarded by id, tenant and enabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await touchWebhookToken(tokenRow());
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('enabled = true');
    expect(params).toEqual(['tok-1', 'tenant-a']);
  });
});

// ─── Document key derivation ───

describe('deriveDocumentKey', () => {
  it('uses the bank transaction id for bank notifications', () => {
    expect(deriveDocumentKey('bank_notification', { transaction_id: 'tx-99' }, '{}')).toBe('tx-99');
  });

  it('uses the CFDI UUID for SAT mailbox payloads', () => {
    expect(deriveDocumentKey('sat_mailbox', { cfdi_uuid: 'AAA-BBB' }, '{}')).toBe('AAA-BBB');
  });

  it('falls back to sha256 of the raw body when no document id exists', () => {
    const raw = '{"whatever":true}';
    const key = deriveDocumentKey('generic', { whatever: true }, raw);
    expect(key).toBe(`sha256:${sha256(raw)}`);
    // Deterministic: an exact replay produces the same key.
    expect(deriveDocumentKey('generic', { whatever: true }, raw)).toBe(key);
  });

  it('strips control characters and caps the length of third-party ids', () => {
    const key = deriveDocumentKey(
      'generic',
      { document_id: 'ab\u0000c\n' + 'x'.repeat(500) },
      '{}'
    );
    expect(key.startsWith('abcx')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).not.toMatch(/[\u0000-\u001f]/);
  });

  it('supports caller-supplied extractors per source kind', () => {
    const key = deriveDocumentKey('generic', { ref: 'R-1' }, '{}', {
      bank_notification: () => undefined,
      sat_mailbox: () => undefined,
      generic: (body) => (body as { ref: string }).ref,
    });
    expect(key).toBe('R-1');
  });
});

// ─── Idempotent delivery recording ───

describe('recordDelivery', () => {
  it('inserts a first-seen document as received', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [deliveryRow()], rowCount: 1 });
    const result = await recordDelivery(tokenRow(), { documentKey: 'tx-777', suspicion: [] });
    expect(result.duplicate).toBe(false);
    expect(result.delivery.status).toBe('received');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (token_id, document_key) DO NOTHING');
  });

  it('returns the PRIOR delivery flagged duplicate on replay', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // conflict: insert returned nothing
      .mockResolvedValueOnce({ rows: [deliveryRow({ status: 'processed', drafts_created: 2 })], rowCount: 1 });
    const result = await recordDelivery(tokenRow(), { documentKey: 'tx-777' });
    expect(result.duplicate).toBe(true);
    expect(result.delivery.id).toBe('del-1');
    expect(result.delivery.status).toBe('duplicate');
    expect(result.delivery.drafts_created).toBe(2);
  });

  it('a duplicate that suppresses work is NOT silent: it logs a warning', async () => {
    // document_key is derived from third-party body fields, so a collision may
    // be a genuine document whose key was pre-claimed by an earlier (hostile)
    // delivery on the same token. The suppression must be surfaced, never a
    // silent drop.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [deliveryRow({ status: 'received', drafts_created: 0 })], rowCount: 1 });
      await recordDelivery(tokenRow(), { documentKey: 'tx-777' });
      expect(warn).toHaveBeenCalledTimes(1);
      const [event, meta] = warn.mock.calls[0];
      expect(event).toBe('webhook_delivery_duplicate_suppressed');
      expect(meta).toMatchObject({
        token_id: 'tok-1',
        tenant_id: 'tenant-a',
        document_key: 'tx-777',
        prior_delivery_id: 'del-1',
        prior_status: 'received',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('records suspicion reasons on the delivery row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [deliveryRow()], rowCount: 1 });
    await recordDelivery(tokenRow(), {
      documentKey: 'tx-777',
      suspicion: ['instruction-like injection phrase'],
    });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(JSON.stringify(['instruction-like injection phrase']));
  });

  it('fails closed when the conflict row is not visible', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(recordDelivery(tokenRow(), { documentKey: 'tx-777' })).rejects.toThrow(/not visible/);
  });
});

describe('markDeliveryOutcome', () => {
  it("moves only rows still in 'received' (guarded UPDATE with rowCount)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const moved = await markDeliveryOutcome(deliveryRow(), { status: 'processed', draftsCreated: 3 });
    expect(moved).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'received'");
    expect(params).toEqual(['processed', 3, 'del-1', 'tok-1', 'tenant-a']);
  });

  it('reports false when the row already left received', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(
      await markDeliveryOutcome(deliveryRow(), { status: 'processed', draftsCreated: 0 })
    ).toBe(false);
  });
});

// ─── CLI queries (tenant scoping, secret hygiene) ───

describe('listWebhookTokens', () => {
  it('never selects token_hash and scopes by entity and tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listWebhookTokens(CTX);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('token_hash');
    expect(params).toEqual(['entity-1', 'tenant-a']);
  });
});

describe('disableWebhookToken', () => {
  it('disables with a guarded, tenant-scoped UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await disableWebhookToken(CTX, 'Bank-BBVA ')).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('enabled = true');
    expect(params).toEqual(['entity-1', 'tenant-a', 'bank-bbva']);
  });

  it('reports false when nothing changed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await disableWebhookToken(CTX, 'ghost')).toBe(false);
  });
});
