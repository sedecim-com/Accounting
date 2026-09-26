import type { Request, Response, NextFunction, RequestHandler } from 'express';
import client from 'prom-client';
import { asyncHandler } from './async-handler.js';

// Default Node/process metrics (event loop lag, GC, heap, fd, …)
client.collectDefaultMetrics({ prefix: 'accounting_' });

// HTTP request duration in seconds — sliced by method/route/status.
// Buckets reflect a typical OLTP API: most p99 should land under 1s.
export const httpRequestDuration = new client.Histogram({
  name: 'accounting_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Request counter for per-route QPS and error-rate alerting.
export const httpRequestsTotal = new client.Counter({
  name: 'accounting_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
});

// Domain-level counter for payroll. Pay-run-service emits these at status
// transitions (calculated/approved/paid). Avoids adding a global hook on every
// DB write — only the meaningful state changes are observable.
export const payRunStateTransitions = new client.Counter({
  name: 'accounting_pay_run_transitions_total',
  help: 'Pay run state transitions',
  labelNames: ['from', 'to', 'country'] as const,
});

// CFDI stamping outcomes per PAC provider (drives the "switch primary PAC"
// runbook when one provider's failure rate spikes).
export const cfdiStampOutcomes = new client.Counter({
  name: 'accounting_cfdi_stamp_total',
  help: 'CFDI stamping outcomes',
  labelNames: ['provider', 'outcome'] as const, // outcome: success|fallback|failure
});

/**
 * The route label of a request no route matched.
 *
 * It used to be the literal `req.path`. prom-client keeps every label set it
 * has ever seen for the life of the process, and `/metrics` is served without
 * credentials, so anyone could mint one permanent series per random path
 * (`/v1/<uuid>`, `/wp-admin/…`) until the scrape and the heap grew without
 * bound. Unknown endpoints still show up — as one series per method and status.
 */
export const UNMATCHED_ROUTE_LABEL = 'unmatched';

/**
 * Express middleware that times every request and records both the histogram
 * (for percentiles) and the counter (for QPS and error budgets).
 *
 * The route label is the matched route pattern (`/v1/employees/:id` instead of
 * one label per UUID), and `UNMATCHED_ROUTE_LABEL` when no route matched.
 *
 * Cardinality stays bounded only while every label value comes from the code,
 * never from what the client sent. That is why the middleware reads nothing
 * of the request but its method and route, and the mount prefix lowercased:
 * `req.baseUrl` is the prefix as the client spelled it, Express matches mounts
 * case-insensitively, and `/V1/Ai/WebHooks` would otherwise mint its own series
 * next to `/v1/ai/webhooks`. Lowercasing is exact because every mount of this
 * API is a lowercase literal with no parameters (`src/api/rest/montajes.ts`;
 * `src/api/rest/risk.ts` relies on the same fact). Nothing enforces that yet:
 * a mount with a parameter would put the client's value back in the label.
 */
export const metricsMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const stop = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${(req.baseUrl || '').toLowerCase()}${req.route.path}`
      : UNMATCHED_ROUTE_LABEL;
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    stop(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
};

/**
 * Handler for GET /metrics. Exposes Prometheus text format. Should be mounted
 * BEFORE auth middleware so a scraper without a JWT can still poll it (or
 * gated by IP allowlist at the LB).
 */
export const metricsHandler: RequestHandler = asyncHandler(async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
