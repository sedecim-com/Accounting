import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitCodeFor, ExitCode } from '../../src/cli/kernel/index.js';
import { GatewayDiscoveryFailed, GatewayStartupRefused, startupExitCode } from '../../src/gateway/server.js';

// ============================================================
// W0 · the deployment entry exits with the CLI's contract codes.
//
// Two doors start the gateway: `node dist/gateway/main.js` in production and
// `mnemosine web start` for operators. The same failure must exit with the
// same code from both, or a job runner that retries on 8 retries one door and
// gives up on the other. The CLI maps errors through exitCodeFor; main.ts may
// not import src/cli, so it uses startupExitCode. This spec runs main.ts for
// real, with startGateway replaced, and holds the two mappings together.
// ============================================================

const refusal = new GatewayStartupRefused(['GATEWAY_API_URL is required']);
const idpDown = new GatewayDiscoveryFailed('fetch failed');
const other = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8080');

/** Loads main.ts in a fresh module registry, with startGateway rejecting with `err`. */
async function runMainFailingWith(err: Error): Promise<{ code: number | undefined; stderr: string }> {
  vi.resetModules();
  vi.doMock('../../src/gateway/config.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readGatewayConfig: () => ({}),
  }));
  vi.doMock('../../src/gateway/server.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The classes stay the ones this spec imported, so instanceof in main.ts sees them.
    GatewayStartupRefused,
    GatewayDiscoveryFailed,
    startupExitCode,
    startGateway: () => Promise.reject(err),
  }));
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as never);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('../../src/gateway/main.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return { code: exit.mock.calls[0]?.[0] as number | undefined, stderr };
}

afterEach(() => {
  vi.doUnmock('../../src/gateway/config.js');
  vi.doUnmock('../../src/gateway/server.js');
  vi.restoreAllMocks();
});

describe('node dist/gateway/main.js, when the start fails', () => {
  it('exits 2 for a refusal and names the problem', async () => {
    const { code, stderr } = await runMainFailingWith(refusal);
    expect(code).toBe(ExitCode.USAGE);
    expect(stderr).toContain('GATEWAY_API_URL is required');
  });

  it('exits 8 for an IdP whose discovery could not be read, the retryable code', async () => {
    const { code, stderr } = await runMainFailingWith(idpDown);
    expect(code).toBe(ExitCode.EXTERNAL_FAILED);
    expect(stderr).toContain('OIDC discovery for AUTH_OIDC_ISSUER failed: fetch failed');
  });

  it('exits 1 for anything else and echoes nothing of it', async () => {
    const { code, stderr } = await runMainFailingWith(other);
    expect(code).toBe(ExitCode.FAILURE);
    expect(stderr).toBe('the web gateway failed to start\n');
  });
});

describe('startupExitCode', () => {
  it('is exitCodeFor for every startup error, so both doors exit alike', () => {
    for (const err of [refusal, idpDown, other]) {
      expect(startupExitCode(err), err.name).toBe(exitCodeFor(err));
    }
  });
});
