import { InvalidArgumentError, type Command } from 'commander';
import { t } from '../i18n/index.js';
import type { GatewayConfig } from '../gateway/config.js';
import type { RunningGateway } from '../gateway/server.js';
import {
  CliError,
  declareRisk,
  describeCommand,
  exitCodeFor,
  ExitCode,
  legible,
  optionByKey,
  render,
  usageError,
  withOutput,
  type RenderOptions,
} from './kernel/index.js';

// ============================================================
// mnemosine web start · web iniciar
//
// The operator's and developer's entry to the web gateway (W0, issue #117).
// Production runs `node dist/gateway/main.js`, which loads no dotenv, no
// src/config and no src/database. This leaf cannot promise that: it lives in
// the CLI, whose entry already loaded all three before any action runs. So it
// is the convenient door, not the deployment one, and it says so in help.
//
// Two rules keep it from pulling the gateway into every CLI invocation:
//   · registering reads no environment and imports nothing from src/gateway
//     at run time (the imports above are type-only and erased); the gateway is
//     loaded inside the action, and only when this leaf runs;
//   · mnemosine.ts skips the database for exactly the path `web start`
//     (NO_DB_COMMAND_PATHS), so a missing DATABASE_URL or a dead SSH tunnel
//     does not stop a process that never queries.
//
// The leaf reads: it holds browser sessions and relays GET/HEAD to /v1, and
// the gateway itself refuses every other method. It is not for the agent: a
// long-running server is not a tool call.
// ============================================================

/** What the action needs from src/gateway, behind one seam so tests can stub it. */
export interface GatewayLauncher {
  /** The gateway's own configuration, read from the environment. */
  readConfig(): GatewayConfig;
  /** Every configuration violation at once; empty when it can start. */
  configProblems(config: GatewayConfig): string[];
  /** Why the built browser files cannot be served, or undefined when they are all there. */
  missingAssets(): string | undefined;
  start(config: GatewayConfig): Promise<RunningGateway>;
}

/** The real launcher. Loading src/gateway happens here, when the leaf runs, and nowhere else. */
export async function loadGatewayLauncher(): Promise<GatewayLauncher> {
  const [configModule, serverModule, assetsModule] = await Promise.all([
    import('../gateway/config.js'),
    import('../gateway/server.js'),
    import('../gateway/static-assets.js'),
  ]);
  return {
    readConfig: () => configModule.readGatewayConfig(),
    configProblems: (config) => configModule.gatewayConfigProblems(config),
    missingAssets: () => {
      try {
        assetsModule.loadStaticAssets(assetsModule.DEFAULT_STATIC_ROOT);
        return undefined;
      } catch (err) {
        if (err instanceof assetsModule.MissingStaticAssets) return err.message;
        throw err;
      }
    },
    start: (config) => serverModule.startGateway(config),
  };
}

/**
 * Resolves with the first SIGINT or SIGTERM the process receives.
 *
 * While it waits, this leaf owns SIGINT. mnemosine.ts registers a global
 * handler when it loads that writes "Interrupted." to stdout and exits 130 at
 * once. Ctrl+C is how a person stops a server, so that handler would put a
 * line that is not data after a --json record, and exit before the server had
 * closed. The handlers already registered are detached while the gateway
 * serves and put back once the signal has been taken: a second Ctrl+C during a
 * slow close still ends the process the CLI's way.
 *
 * process.listeners() is what tsx patches to hide its own relay handler, so
 * that one is never detached.
 */
function nextStopSignal(): Promise<NodeJS.Signals> {
  const inherited = process.listeners('SIGINT');
  for (const listener of inherited) process.off('SIGINT', listener);
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      for (const listener of inherited) process.on('SIGINT', listener);
      resolve(signal);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export interface WebPalette {
  dim: (s: string) => string;
}

export interface WebCommandDeps {
  palette?: WebPalette;
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  /** Tests replace the gateway; the default loads src/gateway lazily. */
  loadGateway?: () => Promise<GatewayLauncher>;
  /** Tests resolve this at once; the default waits for SIGINT or SIGTERM. */
  waitForStop?: () => Promise<NodeJS.Signals>;
}

export interface WebStartOptions extends RenderOptions {
  port?: number;
  host?: string;
  apiUrl?: string;
  publicOrigin?: string;
}

/** The last TCP port. The gateway's own check says the same, but names GATEWAY_PORT. */
const MAX_PORT = 65_535;

function parsePort(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(t('cli.flag.error_not_whole_number', { name: '--port', value }));
  }
  const port = Number(value.trim());
  if (port > MAX_PORT) throw new InvalidArgumentError(t('cli.flag.error_not_port', { name: '--port', value }));
  return port;
}

/**
 * A flag's own error names the FLAG. The gateway validates the same values
 * afterwards, but it names the environment key it expects them under, and
 * telling an operator to fix GATEWAY_API_URL when they typed --api-url sends
 * them to the wrong place.
 */
function parseOrigin(name: string): (value: string) => string {
  return (value: string) => {
    const text = value.trim();
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new InvalidArgumentError(t('cli.flag.error_not_origin', { name, value }));
    }
    const bare = (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' && !text.endsWith('/');
    if (!bare) throw new InvalidArgumentError(t('cli.flag.error_not_origin', { name, value }));
    return text;
  };
}

function parseListenHost(value: string): string {
  const host = value.trim();
  if (host === '') throw new InvalidArgumentError(t('cli.flag.error_empty', { name: '--host' }));
  return host;
}

/** localhost and the loopback addresses: an origin nothing else can reach. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * THE BROWSER MUST REACH WHAT THE GATEWAY OPENS. `--port` and `--host` move
 * the listening socket; the Host guard, the OIDC redirect_uri and the line
 * this leaf prints all come from GATEWAY_PUBLIC_ORIGIN. Moved apart on one
 * machine, the gateway answers 421 to every browser request and the operator
 * is sent to an address where nothing listens. A public origin that is NOT
 * loopback is a proxy's address, and then the two are meant to differ.
 */
export function listeningMismatch(config: GatewayConfig, opts: WebStartOptions): string | undefined {
  if (opts.port === undefined && opts.host === undefined) return undefined;
  let origin: URL;
  try {
    origin = new URL(config.publicOrigin);
  } catch {
    return undefined;
  }
  if (!isLoopbackHost(origin.hostname)) return undefined;
  const originPort = origin.port === '' ? (origin.protocol === 'https:' ? 443 : 80) : Number(origin.port);
  const problems: string[] = [];
  if (opts.port !== undefined && opts.port !== originPort) {
    problems.push(`--port ${opts.port} against ${config.publicOrigin}`);
  }
  if (opts.host !== undefined && !isLoopbackHost(opts.host.trim())) {
    problems.push(`--host ${opts.host.trim()} against ${config.publicOrigin}`);
  }
  if (problems.length === 0) return undefined;
  return (
    `the browser reaches the gateway at ${config.publicOrigin}, which this run does not listen on (${problems.join(', ')}). ` +
    'Pass --public-origin with the address the browser opens, set GATEWAY_PUBLIC_ORIGIN, or drop the flag.'
  );
}

/** The flags win over the environment; an absent flag leaves the environment's value alone. */
export function withStartFlags(config: GatewayConfig, opts: WebStartOptions): GatewayConfig {
  return {
    ...config,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host.trim() } : {}),
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl.trim() } : {}),
    ...(opts.publicOrigin !== undefined ? { publicOrigin: opts.publicOrigin.trim() } : {}),
  };
}

const EXAMPLES = `
Examples:
  # Serve the board with the GATEWAY_* and AUTH_OIDC_* settings of this environment.
  mnemosine web start
  # Another port, relaying to an API that runs on this machine. The browser
  # has to reach the gateway at its public origin, so that moves too.
  mnemosine web start --port 8081 --public-origin http://localhost:8081 --api-url http://127.0.0.1:3000
`;

/**
 * Every failure of this leaf, as a CliError with the same message and exit code.
 *
 * reportError (mnemosine.ts) adds a database remedy under any other error whose
 * message looks like a connection problem, and a gateway message can look like
 * one without being one: a listen on an unresolvable host (ENOTFOUND), a host
 * such as db.internal, an issuer URL with "connect" in it. This leaf never
 * opens the database (NO_DB_COMMAND_PATHS), so that remedy is never right here,
 * and the gateway's startup errors already say what to fix. A CliError is
 * printed as it is, so both doors print the same text for them.
 */
function asLeafFailure(err: unknown): CliError {
  if (err instanceof CliError) return err;
  return new CliError(err instanceof Error ? err.message : String(err), exitCodeFor(err));
}

export function registerWebCommand(program: Command, deps: WebCommandDeps): void {
  const web = describeCommand(program.command('web'), 'help.web.description');

  const start = describeCommand(web.command('start').alias('iniciar'), 'help.web.start.description');
  optionByKey(start, '--port <n>', 'help.web.start.port', { parser: parsePort });
  optionByKey(start, '--host <addr>', 'help.web.start.host', { parser: parseListenHost });
  optionByKey(start, '--api-url <url>', 'help.web.start.api_url', { parser: parseOrigin('--api-url') });
  optionByKey(start, '--public-origin <url>', 'help.web.start.public_origin', { parser: parseOrigin('--public-origin') });
  withOutput(start);
  start.addHelpText('after', EXAMPLES);
  declareRisk(start, { risk: 'lectura', agent: false });

  start.action(async (opts: WebStartOptions) => {
    try {
      const gateway = await (deps.loadGateway ?? loadGatewayLauncher)();
      const config = withStartFlags(gateway.readConfig(), opts);

      const mismatch = listeningMismatch(config, opts);
      if (mismatch !== undefined) throw usageError(mismatch);

      const problems = gateway.configProblems(config);
      if (problems.length > 0) {
        throw usageError(`the web gateway refuses to start:\n  - ${problems.join('\n  - ')}`);
      }
      const missing = gateway.missingAssets();
      if (missing !== undefined) throw usageError(missing);

      const running = await gateway.start(config);
      // Addresses only: the record never carries a secret, a token or a session.
      render([{ listening: running.url, api_url: config.apiUrl, public_origin: config.publicOrigin }], opts);
      if (legible(opts)) {
        const dim = deps.palette?.dim ?? ((s: string) => s);
        process.stderr.write(dim(`  ${t('web.start.listening', { origin: config.publicOrigin })}\n`));
      }

      const signal = await (deps.waitForStop ?? nextStopSignal)();
      await running.close();
      await deps.shutdown(signal === 'SIGINT' ? ExitCode.INTERRUPTED : ExitCode.OK);
    } catch (err) {
      const failure = asLeafFailure(err);
      deps.reportError(failure);
      await deps.shutdown(exitCodeFor(failure));
    }
  });
}
