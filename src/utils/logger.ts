import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';
import { config } from '../config/index.js';

// ─── AsyncLocalStorage context for correlation IDs ───
// Every request opens a context with { request_id, tenant_id, user_id, entity_id }
// so any log emitted during the request lifecycle automatically carries them,
// without threading the request object through every service.
interface LogContext {
  request_id?: string;
  tenant_id?: string;
  user_id?: string;
  entity_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/**
 * Merges the ambient AsyncLocalStorage context into every log line.
 * Keeps request_id alongside the primary tenant/user/entity identifiers
 * so logs are greppable in aggregation systems (Loki / Datadog / CloudWatch).
 */
const contextFormat = winston.format((info) => {
  const ctx = logContext.getStore();
  if (ctx) {
    return { ...ctx, ...info };
  }
  return info;
});

/**
 * Colour only on a real terminal, and never when NO_COLOR is present and
 * non-empty (https://no-color.org). The same gate as src/cli/palette.ts:
 * the CLI prints these warnings on the accountant's terminal, and a warning
 * that ignores NO_COLOR leaves raw escape codes in a pipe or a log file.
 */
export function colorEnabled(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return stream.isTTY === true && !env.NO_COLOR;
}

// NOTE: null means "log every occurrence", which is what the long-lived API
// server needs: a warning that recurs across requests is a signal. The CLI
// runs one command per process, and there the same warning repeated (the
// MetodoPago of one document is resolved by posting and again by the
// checks) is noise, so the CLI entry point opts in with logEachWarningOnce.
let seenWarnings: Set<string> | null = null;

/** From now on in this process, an identical warning (message and metadata) is printed once. */
export function logEachWarningOnce(): void {
  seenWarnings ??= new Set();
}

const onceFormat = winston.format((info) => {
  if (!seenWarnings || info.level !== 'warn') return info;
  // String keys only: winston's own Symbol-keyed fields stay out, and so does
  // the timestamp, which is added after this format runs.
  const key = JSON.stringify(info);
  if (seenWarnings.has(key)) return false;
  seenWarnings.add(key);
  return info;
});

export const logger = winston.createLogger({
  level: config.env === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    contextFormat(),
    onceFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    config.env === 'production'
      ? winston.format.json()
      : winston.format.combine(
          // The Console transport writes every level to stdout.
          ...(colorEnabled(process.stdout) ? [winston.format.colorize()] : []),
          winston.format.printf((info) => {
            const { timestamp, level, message, request_id, tenant_id, stack, ...rest } = info;
            const reqTag = request_id ? ` [req=${String(request_id).slice(0, 8)}]` : '';
            const tenantTag = tenant_id ? ` [tenant=${String(tenant_id).slice(0, 8)}]` : '';
            const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
            return `${timestamp} ${level}${reqTag}${tenantTag} ${message}${typeof stack === 'string' ? '\n' + stack : ''}${extra}`;
          })
        )
  ),
  transports: [new winston.transports.Console()],
});
