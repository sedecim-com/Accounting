import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../../src/database/connection.js';
import { program } from '../../src/cli/mnemosine.js';

// ============================================================
// W0 · `mnemosine web start` through the SHIPPED program.
//
// tests/cli/web-command.spec.ts registers the leaf on a bare Command, which is
// the right place for the action's own contract and the wrong place for two
// things that only exist in mnemosine.ts:
//   · the preAction hook, which opens the database unless skipsDatabase says
//     otherwise. A test that calls skipsDatabase() directly stays green when
//     the hook stops calling it;
//   · the global SIGINT handler, registered when mnemosine.ts loads. It writes
//     "Interrupted." to stdout and exits 130 at once. Ctrl+C is how a person
//     stops this leaf, so if that handler fires, a --json record is followed
//     by a line that is not data, and the process exits before the server has
//     closed.
// The gateway modules and initDatabase are replaced; everything between
// program.parseAsync and process.exit is the real code.
// ============================================================

const world = vi.hoisted(() => ({
  config: {
    issuer: 'https://idp.example.test',
    audience: 'mnemosine-api',
    webClientId: 'mnemosine-web',
    webClientSecret: 'never-printed-secret',
    publicOrigin: 'http://127.0.0.1:8080',
    apiUrl: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 8080,
    trustProxy: undefined,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
    sessionMax: 1000,
    production: false,
  },
  events: [] as string[],
  startGateway: vi.fn(),
}));

vi.mock('../../src/database/connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initDatabase: vi.fn(async () => {
    throw new Error('initDatabase ran');
  }),
}));

vi.mock('../../src/gateway/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGatewayConfig: () => ({ ...world.config }),
  gatewayConfigProblems: () => [],
}));

vi.mock('../../src/gateway/static-assets.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadStaticAssets: () => new Map(),
}));

vi.mock('../../src/gateway/server.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startGateway: world.startGateway,
}));

let stdout = '';

beforeEach(() => {
  stdout = '';
  world.events = [];
  vi.mocked(initDatabase).mockClear();
  world.startGateway.mockReset().mockImplementation(async () => ({
    server: {},
    url: 'http://127.0.0.1:8080',
    close: async () => {
      // A real close waits for the listening socket; give it a turn of the
      // event loop so an exit that does not wait for it lands first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      world.events.push('closed');
    },
  }));
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    world.events.push(`exit ${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web start in the shipped program', () => {
  it('does not open the database: the preAction hook skips it by path', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const run = program.parseAsync(['node', 'mnemosine', 'web', 'start', '--json']);
    await vi.waitFor(() => expect(stdout).toContain('"listening"'));
    process.emit('SIGTERM', 'SIGTERM');
    await run;

    expect(world.startGateway).toHaveBeenCalledTimes(1);
    expect(initDatabase).not.toHaveBeenCalled();
    expect(world.events).toEqual(['closed', 'exit 0']);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });

  it('still opens it for a leaf that queries, through the same hook', async () => {
    await expect(program.parseAsync(['node', 'mnemosine', 'entity', 'list'])).rejects.toThrow('initDatabase ran');
    expect(initDatabase).toHaveBeenCalledTimes(1);
  });

  it('owns Ctrl+C while it serves: stdout keeps only the record, and the server closes before the exit 130', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    expect(sigintListeners, 'mnemosine.ts registers its global SIGINT handler when it loads').toBeGreaterThan(0);

    const run = program.parseAsync(['node', 'mnemosine', 'web', 'start', '--json']);
    await vi.waitFor(() => expect(stdout).toContain('"listening"'));
    process.emit('SIGINT', 'SIGINT');
    await run;

    expect(world.events).toEqual(['closed', 'exit 130']);
    const record = JSON.parse(stdout) as { count: number; rows: Array<Record<string, unknown>> };
    expect(record.rows).toEqual([
      { listening: 'http://127.0.0.1:8080', api_url: 'http://127.0.0.1:3000', public_origin: 'http://127.0.0.1:8080' },
    ]);
    expect(stdout).not.toContain('Interrupted');
    // The CLI's handler is back once the signal has been taken, so a second
    // Ctrl+C during a slow close still ends the process the CLI's way.
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });
});
