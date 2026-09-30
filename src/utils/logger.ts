import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';
import { config } from '../config/index.js';
import { colorEnabled } from './color.js';

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

// NOTE: null means "log every occurrence", which is what the long-lived API
// server needs: a warning that recurs across requests is a signal. The CLI
// opens one scope per unit of work (a one-shot command, or one chat turn),
// and inside a scope the same warning repeated (the MetodoPago of one
// document is resolved by posting and again by the checks) is noise.
let seenWarnings: Set<string> | null = null;

/**
 * Starts a unit of work: from now on an identical warning (message and
 * metadata) is printed once, until the next call opens a fresh scope. A
 * warning that recurs in a later scope, such as the next chat turn, is
 * printed again, and the set of seen warnings never outlives its scope.
 */
export function beginWarningScope(): void {
  seenWarnings = new Set();
}

/** The dedupe key; null when the metadata cannot be serialised (a BigInt, a cycle). */
function warningKey(info: object): string | null {
  try {
    // String keys only: winston's own Symbol-keyed fields stay out, and so
    // does the timestamp, which is added after this format runs.
    return JSON.stringify(info);
  } catch {
    return null;
  }
}

const onceFormat = winston.format((info) => {
  if (!seenWarnings || info.level !== 'warn') return info;
  const key = warningKey(info);
  // Metadata with no key: print it every time rather than throw into the caller.
  if (key === null) return info;
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
