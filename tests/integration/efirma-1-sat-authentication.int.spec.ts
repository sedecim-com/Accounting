import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { storeCredential, CredentialAccessDenied } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';
import {
  authenticateWithSat,
  clearSatTokenCache,
  SatAuthenticationError,
} from '../../src/services/sat-download/authentication.js';
import { startSatSimulator, SIMULATED_TOKEN, type SatSimulator } from '../sat-download/sat-simulator.js';

// ============================================================
// EFIRMA-1 (#439), against a real database and a local SAT simulator
// (invariant 7: never the real SAT). The e.firma is the synthetic fixture of
// tests/fixtures/certs, stored through storeCredential into an in-memory
// vault, and read back only by withCredential.
// ============================================================

const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'certs');
const FIEL_RFC = 'AAA010101AAA';
const ACTOR = 'scheduler@efirma-1.test';

let f: Fixture;
let sim: SatSimulator;
let credentialId: string;
const vaultBlobs = new Map<string, Buffer>();

interface LogRow { purpose: string; actor: string; unattended: boolean; outcome: string; denied_reason: string | null }

async function logRows(): Promise<LogRow[]> {
  const r = await query<LogRow>(
    `SELECT purpose, actor, unattended, outcome, denied_reason FROM fiscal_credential_access_log
      WHERE credential_id = $1 AND tenant_id = $2 AND entity_id = $3 ORDER BY accessed_at, id`,
    [credentialId, f.tenantId, f.entityId]
  );
  return r.rows;
}

const authenticate = () =>
  authenticateWithSat({ tenantId: f.tenantId, entityId: f.entityId, actor: ACTOR, unattended: true }, { url: sim.url });

beforeAll(async () => {
  f = await crearInquilino('EFIRMA-1 SAT authentication');
  await seedPolicies({ tenantId: f.tenantId });
  await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [FIEL_RFC, f.entityId, f.tenantId]);
  setVaultForTesting({
    backend: 'test',
    put: async (_ctx: unknown, blob: Buffer) => {
      vaultBlobs.set('test://efirma-1', Buffer.from(blob));
      return { backend: 'test', ref: 'test://efirma-1' };
    },
    get: async (_ctx: unknown, ref: { ref: string }) => Buffer.from(vaultBlobs.get(ref.ref)!),
    destroy: async () => undefined,
    healthCheck: async () => ({ ok: true }),
  } as unknown as SecretVault);
  const stored = await storeCredential({
    tenantId: f.tenantId,
    entityId: f.entityId,
    material: {
      cer: fs.readFileSync(path.join(CERT_DIR, 'fiel.cer')),
      key: fs.readFileSync(path.join(CERT_DIR, 'fiel.key')),
      password: 'test1234',
    },
    consentBy: 'owner@efirma-1.test',
  });
  credentialId = stored.id;
  sim = await startSatSimulator();
});

beforeEach(() => {
  clearSatTokenCache();
  sim.requests.length = 0;
  sim.failing = false;
});

afterAll(async () => {
  await sim.close();
  setVaultForTesting(null);
  await drainAttestations(2000);
  await closeDatabase();
});

describe('EFIRMA-1 · authentication signed with the vault e.firma', () => {
  it('gets a token the simulator accepted and leaves one sat_auth success row, with no token stored', async () => {
    const token = await authenticate();

    expect(token.value).toBe(SIMULATED_TOKEN);
    expect(sim.requests).toHaveLength(1);
    expect(await logRows()).toEqual([
      { purpose: 'sat_auth', actor: ACTOR, unattended: true, outcome: 'success', denied_reason: null },
    ]);
    const stored = await query(
      `SELECT 1 FROM fiscal_credential_access_log WHERE credential_id = $1
         AND (coalesce(error, '') LIKE $2 OR coalesce(denied_reason, '') LIKE $2)
       UNION ALL
       SELECT 1 FROM fiscal_credentials WHERE id = $1 AND row_to_json(fiscal_credentials.*)::text LIKE $2`,
      [credentialId, `%${SIMULATED_TOKEN}%`]
    );
    expect(stored.rows).toHaveLength(0);
  });

  it('records error when the SAT refuses the signed request', async () => {
    sim.failing = true;
    await expect(authenticate()).rejects.toBeInstanceOf(SatAuthenticationError);
    expect((await logRows()).at(-1)).toMatchObject({ purpose: 'sat_auth', outcome: 'error' });
  });

  it('at the daily cap, efirma_accion_anomalia = alertar lets it through with an alert row', async () => {
    await query(`UPDATE fiscal_credentials SET max_daily_access = 1 WHERE id = $1 AND tenant_id = $2`, [credentialId, f.tenantId]);
    await authenticate();
    expect(sim.requests).toHaveLength(1);
    expect((await logRows()).slice(-2).map((r) => r.outcome)).toEqual(['denied', 'success']);
  });

  it('at the daily cap, efirma_accion_anomalia = bloquear denies before any request to the SAT', async () => {
    await resolvePolicy({ tenantId: f.tenantId }, 'efirma_accion_anomalia', 'bloquear', f.userId);
    await expect(authenticate()).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(0);
    expect((await logRows()).at(-1)).toMatchObject({ purpose: 'sat_auth', outcome: 'denied', denied_reason: 'rate_limit' });
  });

  it('SAT refusals count toward the cap: two refusals at two uses left, and the third call never leaves', async () => {
    // Each refusal decrypted the key and sent a signature, so it spends the cap.
    const counted = (await logRows()).filter((r) => r.outcome === 'success' || r.outcome === 'error').length;
    await query(`UPDATE fiscal_credentials SET max_daily_access = $1 WHERE id = $2 AND tenant_id = $3`, [
      counted + 2, credentialId, f.tenantId,
    ]);
    sim.failing = true;
    await expect(authenticate()).rejects.toBeInstanceOf(SatAuthenticationError);
    await expect(authenticate()).rejects.toBeInstanceOf(SatAuthenticationError);
    expect(sim.requests).toHaveLength(2);

    await expect(authenticate()).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(2);
    expect((await logRows()).at(-1)).toMatchObject({ purpose: 'sat_auth', outcome: 'denied', denied_reason: 'rate_limit' });
  });
});
