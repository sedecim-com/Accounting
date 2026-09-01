import { describe, it, expect } from 'vitest';
import { insecureProductionSecrets } from '../../src/config/index.js';

// ============================================================
// The two development defaults are in the repository. In
// production they are not weak secrets, they are PUBLISHED ones:
// anyone with a copy of the source can sign a token for any
// tenant, and an AES key of 32 zero bytes means the vendor bank
// accounts and fiscal credentials are stored in something that
// merely looks like ciphertext.
//
// The rule is a pure function so it can be checked for every
// combination without reloading the config module — which reads
// the real process.env exactly once, at import.
// ============================================================

const DEV_JWT = 'dev-secret-change-me';
const DEV_KEY = '0'.repeat(64);
const REAL_JWT = 'k4Xv9pQ2mZ7tR1sB6yL0nH3wC8dJ5fA';
const REAL_KEY = 'a'.repeat(64);

describe('insecureProductionSecrets', () => {
  it('says nothing in development, where the defaults are the point', () => {
    expect(insecureProductionSecrets('development', DEV_JWT, DEV_KEY)).toEqual([]);
  });

  it('says nothing under the test suite, which runs on the same defaults', () => {
    expect(insecureProductionSecrets('test', DEV_JWT, DEV_KEY)).toEqual([]);
  });

  it('refuses the default JWT secret in production', () => {
    const problems = insecureProductionSecrets('production', DEV_JWT, REAL_KEY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/JWT_SECRET/);
    // The message has to say what an attacker gets, not just "set this".
    expect(problems[0]).toMatch(/forge a token/i);
  });

  it('refuses the all-zero encryption key in production', () => {
    const problems = insecureProductionSecrets('production', REAL_JWT, DEV_KEY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ENCRYPTION_KEY/);
    expect(problems[0]).toMatch(/clear/i);
    // Rotating it later strands existing ciphertext; the operator is told now.
    expect(problems[0]).toMatch(/before the first write/i);
  });

  it('reports BOTH when both are left at the default — no fixing one and shipping', () => {
    expect(insecureProductionSecrets('production', DEV_JWT, DEV_KEY)).toHaveLength(2);
  });

  // The code default is not the only published secret. docker-compose hands
  // the container a DIFFERENT string, and a gate that only knew the fallback
  // would wave through a compose file flipped to production while reporting
  // itself checked. Both of these are in the repository; both forge tokens.
  it.each([
    ['the code default (src/config/index.ts)', DEV_JWT],
    ['the docker-compose value (docker/docker-compose.yml:15)', 'dev-secret-change-in-production'],
  ])('refuses %s in production', (_where, secret) => {
    const problems = insecureProductionSecrets('production', secret, REAL_KEY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/JWT_SECRET/);
  });

  it('does not refuse a secret merely because it looks development-ish', () => {
    // The rule is membership of a known-published set, not a substring hunt:
    // a real secret that happens to contain "dev" must still start.
    expect(insecureProductionSecrets('production', 'dev-secret-change-me-x9Qv', REAL_KEY)).toEqual([]);
  });

  it('is satisfied by real values in production', () => {
    expect(insecureProductionSecrets('production', REAL_JWT, REAL_KEY)).toEqual([]);
  });

  // Exact, lowercase 'production' — the same comparison services/vault/
  // index.ts and zkverify-client.ts make. Worth pinning: a deployment that
  // sets NODE_ENV=staging over production data is NOT covered by this gate,
  // and that is a property of the whole codebase, not of this function.
  it("gates on the literal 'production', like the rest of the codebase", () => {
    for (const env of ['prod', 'Production', 'staging', '']) {
      expect(insecureProductionSecrets(env, DEV_JWT, DEV_KEY), env).toEqual([]);
    }
  });
});
