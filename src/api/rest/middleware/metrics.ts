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
 * Express middleware that times every request and records both the histogram
 * (for percentiles) and the counter (for QPS and error budgets).
 *
 * Routing label uses `req.route?.path || req.path`. The route path keeps
 * cardinality bounded (`/v1/employees/:id` instead of one label per UUID); on
 * 404s where no route matched we fall back to the literal path so unknown
 * endpoints still show up.
 */
export const metricsMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const stop = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path;
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
