import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, ExitCode, riskOf } from '../../src/cli/kernel/index.js';
import { program, reportError, skipsDatabase } from '../../src/cli/mnemosine.js';
import { registerWebCommand, withStartFlags, type GatewayLauncher } from '../../src/cli/web-command.js';
import type { GatewayConfig } from '../../src/gateway/config.js';
import { GatewayDiscoveryFailed, GatewayListenFailed, GatewayStartupRefused } from '../../src/gateway/server.js';

// ============================================================
// W0 · `mnemosine web start`, the operator's door to the web gateway.
//
// What this spec holds, and why each part matters:
//   · the CLI does not load src/gateway unless this leaf runs, so the leaf's
//     file has no run-time import of it and registering touches nothing;
//   · the leaf is where the registry and the catalog say it is, reads, and is
//     not the agent's;
//   · its action refuses a broken configuration or a missing build with the
//     usage code, before anything listens, and prints only addresses;
//   · the database is skipped for the path `web start` and not for every leaf
//     that happens to be called `start`.
// The gateway itself is stubbed here: tests/gateway covers what it does.
// ============================================================

const SOURCE = path.join(__dirname, '..', '..', 'src', 'cli', 'web-command.ts');

const CONFIG: GatewayConfig = {
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
};

interface Harness {
  program: Command;
  shutdown: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  loadGateway: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<GatewayLauncher> = {}, signal: NodeJS.Signals = 'SIGTERM'): Harness {
  const close = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ server: {} as never, url: 'http://127.0.0.1:8080', close }));
  const launcher: GatewayLauncher = {
    readConfig: () => ({ ...CONFIG }),
    configProblems: () => [],
    missingAssets: () => undefined,
    start,
    ...overrides,
  };
  const loadGateway = vi.fn(async () => launcher);
  // The real shutdown never returns; resolving is enough for the action to end.
  const shutdown = vi.fn(async () => undefined as never);
  const reportError = vi.fn();
  const root = new Command('mnemosine');
  root.exitOverride();
  root.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerWebCommand(root, {
    shutdown,
    reportError,
    loadGateway,
    waitForStop: async () => signal,
  });
  return { program: root, shutdown, reportError, start, close, loadGateway };
}

function leaf(root: Command, ...names: string[]): Command {
  let node = root;
  for (const name of names) {
    const next = (node.commands as Command[]).find((c) => c.name() === name);
    if (!next) throw new Error(`no ${names.join(' ')} under ${root.name()}`);
    node = next;
  }
  return node;
}

function captureStdout(): { text: () => string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { text: () => out };
}

/** What the shipped reportError prints to the console for `err`. */
function printedBy(err: unknown): string {
  let printed = '';
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    printed += `${args.map(String).join(' ')}\n`;
  });
  reportError(err);
  return printed;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registering web start', () => {
  it('has no run-time import of src/gateway: the gateway is loaded inside the action only', () => {
    const file = ts.createSourceFile(SOURCE, fs.readFileSync(SOURCE, 'utf-8'), ts.ScriptTarget.Latest, true);
    const staticGateway: string[] = [];
    const dynamicGateway: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.includes('gateway') && !node.importClause?.isTypeOnly) staticGateway.push(specifier);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (node.moduleSpecifier.text.includes('gateway')) staticGateway.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        const [first] = node.arguments;
        const literal = first && ts.isStringLiteral(first) ? first.text : '';
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && literal.includes('gateway')) {
          dynamicGateway.push(literal);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && literal.includes('gateway')) {
          staticGateway.push(literal);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(staticGateway, 'a value import of src/gateway would load it on every CLI run').toEqual([]);
    expect(dynamicGateway.sort()).toEqual([
      '../gateway/config.js',
      '../gateway/server.js',
      '../gateway/static-assets.js',
    ]);
    expect(file.text).not.toMatch(/process\.env/);
  });

  it('registers without loading the gateway, starting anything or exiting', () => {
    const h = harness();
    expect(h.loadGateway).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it('is `web start` with the alias iniciar in the shipped program, declared lectura and not for the agent', () => {
    const start = leaf(program, 'web', 'start');
    expect(start.aliases()).toEqual(['iniciar']);
    expect(leaf(program, 'web').aliases()).toEqual([]);
    const risk = riskOf(start);
    expect(risk?.risk).toBe('lectura');
    expect(risk?.agent).toBe(false);
    for (const flag of ['--port', '--host', '--api-url', '--format', '--json']) {
      expect(start.options.map((o) => o.long)).toContain(flag);
    }
  });

  it('teaches `mnemosine web start` first in its examples', () => {
    const start = leaf(program, 'web', 'start');
    // addHelpText('after') is an afterHelp listener that writes to the context
    // it is given; emitting it reads the block without rendering the screen
    // (the same reading tests/cli/ejemplos-de-ayuda.spec.ts uses).
    const chunks: string[] = [];
    const emitter = start as unknown as {
      emit(event: string, context: { error: boolean; command: Command; write: (s: string) => void }): boolean;
    };
    emitter.emit('afterHelp', { error: false, command: start, write: (s) => chunks.push(s) });
    const after = chunks.join('');
    expect(after).toContain('Examples:');
    const invocations = after.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('mnemosine '));
    expect(invocations[0]).toBe('mnemosine web start');
  });
});

describe('the database is skipped by path, not by leaf name', () => {
  it('skips it for web start, and still for lang', () => {
    expect(skipsDatabase(leaf(program, 'web', 'start'))).toBe(true);
    expect(skipsDatabase(leaf(program, 'lang'))).toBe(true);
  });

  it('does not skip it for another leaf called start, nor for the web group itself', () => {
    const root = new Command('mnemosine');
    const jobStart = root.command('job').command('start');
    expect(skipsDatabase(jobStart)).toBe(false);
    expect(skipsDatabase(leaf(program, 'web'))).toBe(false);
    expect(skipsDatabase(leaf(program, 'entity', 'list'))).toBe(false);
  });
});

describe('running web start', () => {
  it('with --json prints one record of addresses, never the client secret, and exits 0 on SIGTERM', async () => {
    const out = captureStdout();
    const h = harness();
    await h.program.parseAsync(['web', 'start', '--json', '--port', '8123', '--public-origin', 'http://127.0.0.1:8123'], { from: 'user' });

    expect(h.start).toHaveBeenCalledTimes(1);
    expect((h.start.mock.calls[0] as unknown[])[0]).toMatchObject({ port: 8123, host: '127.0.0.1' });
    const printed = JSON.parse(out.text()) as { count: number; rows: Array<Record<string, unknown>> };
    expect(printed.count).toBe(1);
    expect(printed.rows[0]).toEqual({
      listening: 'http://127.0.0.1:8080',
      api_url: 'http://127.0.0.1:3000',
      public_origin: 'http://127.0.0.1:8123',
    });
    expect(out.text()).not.toContain(CONFIG.webClientSecret);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.OK);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('as a table tells the person on stderr which origin to open, and keeps stdout for the record', async () => {
    let err = '';
    const out = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    const h = harness();
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(out.text()).toContain('http://127.0.0.1:3000');
    expect(out.text()).not.toContain('Ctrl+C');
    expect(err).toContain(`Open ${CONFIG.publicOrigin} in a browser`);
    expect(err).not.toContain(CONFIG.webClientSecret);
  });

  it('exits 130 when SIGINT stops it, after closing the server', async () => {
    captureStdout();
    const h = harness({}, 'SIGINT');
    await h.program.parseAsync(['web', 'start', '--json'], { from: 'user' });
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.INTERRUPTED);
  });

  it('refuses a broken configuration with the usage code, naming every problem, before anything starts', async () => {
    captureStdout();
    const h = harness({ configProblems: () => ['GATEWAY_API_URL is required', 'AUTH_OIDC_ISSUER is required'] });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });

    expect(h.start).not.toHaveBeenCalled();
    expect(h.shutdown).toHaveBeenCalledTimes(1);
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.USAGE);
    const reported = h.reportError.mock.calls[0]?.[0] as CliError;
    expect(reported).toBeInstanceOf(CliError);
    expect(reported.message).toContain('GATEWAY_API_URL is required');
    expect(reported.message).toContain('AUTH_OIDC_ISSUER is required');
  });

  it('refuses a missing build with the usage code and the command that fixes it', async () => {
    captureStdout();
    const h = harness({ missingAssets: () => 'the gateway cannot start: 1 static file(s) missing. Run npm run build:web.' });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });

    expect(h.start).not.toHaveBeenCalled();
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.USAGE);
    expect((h.reportError.mock.calls[0]?.[0] as Error).message).toContain('npm run build:web');
  });

  it('keeps the contract code when the gateway fails to start for another reason', async () => {
    captureStdout();
    const h = harness({
      start: async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:8080');
      },
    });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.FAILURE);
  });

  it('exits 1 and prints the address and the system code when it cannot listen, as node dist/gateway/main.js does', async () => {
    captureStdout();
    const h = harness({
      start: async () => {
        throw new GatewayListenFailed('127.0.0.1', 8080, 'EADDRINUSE');
      },
    });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.FAILURE);
    expect(printedBy(h.reportError.mock.calls[0]?.[0])).toContain('cannot listen on 127.0.0.1:8080: EADDRINUSE');
  });

  // reportError adds a database remedy under any error whose message looks
  // like a connection problem. This leaf opens no database, and these gateway
  // messages only look like one: an unresolvable host (ENOTFOUND), a host or an
  // issuer whose name has db or connect in it.
  it.each([
    ['an unresolvable host', new GatewayListenFailed('nohost.invalid', 8080, 'ENOTFOUND'), ExitCode.FAILURE],
    ['a host named like a database', new GatewayListenFailed('db.internal', 8080, 'EADDRNOTAVAIL'), ExitCode.FAILURE],
    [
      'an issuer whose address says connect',
      new GatewayDiscoveryFailed('Could not read the OIDC configuration of https://login.connect.example (HTTP 503)'),
      ExitCode.EXTERNAL_FAILED,
    ],
  ])('prints what the gateway says for %s, and no database remedy', async (_label, failure, code) => {
    captureStdout();
    const h = harness({
      start: async () => {
        throw failure;
      },
    });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(h.shutdown).toHaveBeenCalledWith(code);
    const printed = printedBy(h.reportError.mock.calls[0]?.[0]);
    expect(printed).toContain(failure.message);
    expect(printed).not.toContain('DATABASE_URL');
    expect(printed).not.toContain('mnemosine doctor');
  });

  it('exits 8, the retryable code, when the IdP cannot be read, as node dist/gateway/main.js does', async () => {
    captureStdout();
    const h = harness({
      start: async () => {
        throw new GatewayDiscoveryFailed('fetch failed');
      },
    });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.EXTERNAL_FAILED);
    expect((h.reportError.mock.calls[0]?.[0] as Error).message).toContain('OIDC discovery for AUTH_OIDC_ISSUER failed');
  });

  it('exits 2 when the gateway itself refuses at start, as node dist/gateway/main.js does', async () => {
    captureStdout();
    const h = harness({
      start: async () => {
        throw new GatewayStartupRefused(['the discovered issuer is not the configured AUTH_OIDC_ISSUER']);
      },
    });
    await h.program.parseAsync(['web', 'start'], { from: 'user' });
    expect(h.shutdown).toHaveBeenCalledWith(ExitCode.USAGE);
  });

  it('rejects a --port that is not a whole number at parse time', async () => {
    const h = harness();
    await expect(h.program.parseAsync(['web', 'start', '--port', '80a'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
    expect(h.loadGateway).not.toHaveBeenCalled();
  });

  it('rejects a --port above 65535 at parse time, naming the flag and not GATEWAY_PORT', async () => {
    const h = harness();
    const attempt = h.program.parseAsync(['web', 'start', '--port', '70000'], { from: 'user' });
    await expect(attempt).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    await expect(attempt).rejects.toThrow(/--port/);
    await expect(attempt).rejects.not.toThrow(/GATEWAY_PORT/);
    expect(h.loadGateway).not.toHaveBeenCalled();
  });

  it('accepts the whole range, 0 (any free port) to 65535', async () => {
    captureStdout();
    for (const port of ['0', '65535']) {
      const h = harness();
      await h.program.parseAsync(
        ['web', 'start', '--json', '--port', port, '--public-origin', `http://127.0.0.1:${port}`],
        { from: 'user' }
      );
      expect((h.start.mock.calls[0] as unknown[])[0]).toMatchObject({ port: Number(port) });
    }
  });
});

describe('the address the browser opens', () => {
  it('refuses to listen somewhere the loopback public origin does not name', async () => {
    captureStdout();
    for (const argv of [
      ['web', 'start', '--port', '8081'],
      ['web', 'start', '--host', '0.0.0.0'],
    ]) {
      const h = harness();
      await h.program.parseAsync(argv, { from: 'user' });
      expect(h.start).not.toHaveBeenCalled();
      expect(h.shutdown).toHaveBeenCalledWith(ExitCode.USAGE);
      const reported = h.reportError.mock.calls[0]?.[0] as Error;
      expect(reported.message).toMatch(/the browser reaches the gateway at http:\/\/127\.0\.0\.1:8080/);
      expect(reported.message).toMatch(/--public-origin/);
    }
  });

  it('lets the flags move together, and leaves a proxy in front alone', async () => {
    captureStdout();
    const moved = harness();
    await moved.program.parseAsync(
      ['web', 'start', '--json', '--port', '8081', '--public-origin', 'http://localhost:8081'],
      { from: 'user' }
    );
    expect((moved.start.mock.calls[0] as unknown[])[0]).toMatchObject({ port: 8081, publicOrigin: 'http://localhost:8081' });

    // A public origin that is not loopback is a proxy's address: the port
    // behind it is nobody's business but the deployment's.
    const behindProxy = harness({ readConfig: () => ({ ...CONFIG, publicOrigin: 'https://tablero.despacho.mx' }) });
    await behindProxy.program.parseAsync(['web', 'start', '--json', '--port', '8081'], { from: 'user' });
    expect((behindProxy.start.mock.calls[0] as unknown[])[0]).toMatchObject({ port: 8081 });
  });

  it('names the flag, not the environment key, when a flag carries a bad value', async () => {
    for (const [argv, flag] of [
      [['web', 'start', '--api-url', 'http://127.0.0.1:3000/v1'], '--api-url'],
      [['web', 'start', '--public-origin', 'not-a-url'], '--public-origin'],
      [['web', 'start', '--host', '  '], '--host'],
    ] as Array<[string[], string]>) {
      const h = harness();
      await expect(h.program.parseAsync(argv, { from: 'user' })).rejects.toThrow(new RegExp(flag));
      expect(h.start).not.toHaveBeenCalled();
    }
  });
});

describe('withStartFlags', () => {
  it('lets each flag win over the environment and leaves the rest alone', () => {
    expect(withStartFlags(CONFIG, {})).toEqual(CONFIG);
    expect(withStartFlags(CONFIG, { port: 9000, host: ' 0.0.0.0 ', apiUrl: 'https://api.example.test' })).toEqual({
      ...CONFIG,
      port: 9000,
      host: '0.0.0.0',
      apiUrl: 'https://api.example.test',
    });
  });
});
