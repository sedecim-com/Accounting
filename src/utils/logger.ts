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

export const logger = winston.createLogger({
  level: config.env === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    contextFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    config.env === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
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

/**
 * Wrap a function so everything it awaits runs inside a fresh log context.
 * Used by the HTTP correlation middleware to scope request_id per request.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContext.run(ctx, fn);
}
