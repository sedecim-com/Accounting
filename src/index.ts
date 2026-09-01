import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { config } from './config/index.js';
import { query, closeDatabase, initDatabase } from './database/connection.js';
import { verificarRolSujetoARls } from './database/rls-guard.js';
import { drainAttestations } from './services/accounting/posting.js';
import { authenticate, requireEntityAccess } from './api/rest/middleware/auth.js';
import { auditLogMiddleware } from './api/rest/middleware/audit.js';
import { tenantContext } from './api/rest/middleware/tenant-context.js';
import { errorHandler } from './api/rest/middleware/error-handler.js';
import { rateLimiter, preAuthRateLimiter } from './api/rest/middleware/rate-limiter.js';
import { metricsMiddleware, metricsHandler } from './api/rest/middleware/metrics.js';
import { correlationIdMiddleware, enrichLogContextMiddleware } from './api/rest/middleware/correlation.js';
import { logger } from './utils/logger.js';
import { typeDefs } from './api/graphql/schemas/schema.js';
import { resolvers } from './api/graphql/resolvers/index.js';

// Route imports
import accountsRouter from './api/rest/routes/accounts.js';
import journalEntriesRouter from './api/rest/routes/journal-entries.js';
import invoicesRouter from './api/rest/routes/invoices.js';
import billsRouter from './api/rest/routes/bills.js';
import reportsRouter from './api/rest/routes/reports.js';
import bankReconciliationRouter from './api/rest/routes/bank-reconciliation.js';
import webhooksRouter from './api/rest/routes/webhooks.js';
import vendorsRouter from './api/rest/routes/vendors.js';
import customersRouter from './api/rest/routes/customers.js';
import fiscalPeriodsRouter from './api/rest/routes/fiscal-periods.js';
import xmlIngestionRouter from './api/rest/routes/xml-ingestion.js';
import blockchainRouter from './api/rest/routes/blockchain.js';
import publicVerificationRouter from './api/rest/routes/public-verification.js';
import aiWebhooksRouter from './api/rest/routes/ai-webhooks.js';
import integrationsRouter from './api/rest/routes/integrations.js';
import payrollRouter from './api/rest/routes/payroll.js';
import aiRouter from './api/rest/routes/ai.js';
import './services/integrations/index.js'; // Register all adapters
import './services/payroll/tax-engine/register-all.js'; // Register all tax calculators

async function bootstrap() {
  // Túnel y TLS resueltos antes de la primera consulta.
  const { tunneled, warning } = await initDatabase();
  if (tunneled) logger.info('db_tunnel_open');
  if (warning) logger.warn('db_tls_warning', { warning });

  // Falla cerrado en producción ante un rol que ignora RLS (S1); advierte en
  // desarrollo. `mnemosine doctor` lo reporta también (checkTenantIsolation).
  await verificarRolSujetoARls();

  const app = express();

  // ============================================================
  // Middleware
  // ============================================================
  // CSP ENCENDIDO EN TODOS LOS ENTORNOS, con una sola excepción declarada.
  //
  // Estaba apagado fuera de producción —`js/insecure-helmet-configuration`— y
  // la razón original era el playground de GraphQL, cuya landing page carga
  // scripts de un CDN que CSP bloquea. Pero GraphQL ya viene APAGADO por
  // omisión, así que la excepción sólo hace falta cuando alguien lo enciende
  // a propósito en desarrollo. La API sirve JSON: encender CSP no le cuesta
  // nada y quita una diferencia entre lo que se prueba y lo que se despliega.
  const playgroundGraphql = process.env.GRAPHQL_ENABLED === 'true' && config.env !== 'production';
  app.use(helmet({ contentSecurityPolicy: playgroundGraphql ? false : undefined }));
  // CORS explícito por entorno (S1): `cors()` a secas publica
  // Access-Control-Allow-Origin: * también en producción. La API la consumen
  // el CLI y agentes (sin navegador), así que producción sin ALLOWED_ORIGINS
  // no permite ningún origen cruzado; declarar orígenes es opt-in por env
  // (lista separada por comas). En desarrollo sólo se reflejan orígenes
  // locales — `true` reflejaba CUALQUIERA, y un navegador en la LAN contra
  // un dev server es exactamente el caso que CORS existe para parar. Cada
  // entrada de la lista debe ser un origen concreto con esquema: un '*'
  // colado en el env volvería público lo que el opt-in quiso enumerar, así
  // que se descarta en vez de honrarse.
  app.use(cors({
    origin: config.env === 'production'
      ? (process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim())
          .filter((o) => /^https?:\/\/[^*\s/]+$/.test(o)) ?? false)
      : [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
  }));
  // Global JSON body parser — but the inbound AI webhook path parses its OWN
  // body with express.raw (exact-bytes idempotency fallback + a hard 1MB cap).
  // If the global json parser consumed those requests first, body-parser would
  // set req._body, the route's express.raw would skip, req.body would be a
  // parsed object instead of a Buffer, and every delivery would 415. So the
  // webhook path is excluded here and left for its own router to parse.
  const jsonParser = express.json({ limit: '10mb' });
  app.use((req, res, next) =>
    req.path.startsWith('/v1/ai/webhooks') ? next() : jsonParser(req, res, next)
  );

  // Correlation ID — must come BEFORE anything that might log, so even
  // pre-auth errors surface with a request_id.
  app.use(correlationIdMiddleware);

  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

  // Metrics — instrument every request, expose /metrics before auth so that
  // Prometheus scrapers don't need a JWT (gate by IP allowlist at the LB).
  app.use(metricsMiddleware);
  app.get('/metrics', metricsHandler);

  // ─── Health probes (no auth) ───
  // /live  — process is up (does not touch dependencies). For k8s livenessProbe.
  // /ready — DB connectivity OK. For k8s readinessProbe (and load-balancer gate).
  // /health — legacy alias kept for back-compat.
  app.get('/live', (_req, res) => {
    res.json({ status: 'alive', timestamp: new Date().toISOString() });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({
        status: 'not_ready',
        db: 'error',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', version: '1.0.0', timestamp: new Date().toISOString() });
  });

  // PUBLIC verification endpoints (no auth) — APAGADOS POR OMISIÓN.
  //
  // Este router sirve, sin credenciales, atestaciones cuyo anclaje los
  // adaptadores de cadena FABRICAN: no hay transacción en ninguna red. Su
  // propósito es que un tercero se las crea, así que publicarlo por defecto
  // es la peor variante del acto que CLI-5 retiró. Se enciende cuando el
  // anclaje sea real, con PUBLIC_VERIFICATION_ENABLED=true.
  //
  // Encendido, cada endpoint se niega igualmente a servir una fila
  // simulada: la bandera decide si el router existe, no si miente.
  if (process.env.PUBLIC_VERIFICATION_ENABLED === 'true') {
    // El limitador por IP no va aquí: vive DENTRO del router, para que viaje
    // con él y se vea desde el archivo que sirve sin credenciales.
    app.use('/public/v1', publicVerificationRouter);
    logger.warn('public_verification_enabled', {
      detail:
        'La verificación pública está encendida. Sólo servirá atestaciones no simuladas; ' +
        'hoy todas lo son, porque ningún adaptador de cadena ancla de verdad.',
    });
  }

  // Inbound AI webhooks: authenticated by their own dedicated tokens
  // (Bearer, hashed at rest), NOT by JWT — mounted before `authenticate` so
  // it must not require a JWT. It IS still rate limited: the limiter runs
  // first (preAuthRateLimiter: keyed per-IP, since there is no JWT tenant) so the
  // unauthenticated token-guessing / flood surface is throttled instead of
  // being both unauthenticated AND unthrottled.
  app.use('/v1/ai/webhooks', preAuthRateLimiter, aiWebhooksRouter);

  // ============================================================
  // REST API Routes
  // ============================================================
  const apiPrefix = `/v1`;

  // Auth + rate limiting middleware for all API routes
  // El escudo va ANTES de authenticate: verificar una firma JWT es trabajo de
  // CPU, y sin esto salía gratis para quien no tiene credenciales — el
  // limitador de abajo, que reparte por inquilino, no llegaba a correr.
  app.use(apiPrefix, preAuthRateLimiter);
  app.use(apiPrefix, authenticate);
  // Right after authenticate, and before anything that touches the
  // database: it opens the tenant context that the RLS policies read.
  // Mounted here, once, so no router can forget it.
  app.use(apiPrefix, tenantContext);
  app.use(apiPrefix, enrichLogContextMiddleware);
  app.use(apiPrefix, rateLimiter);
  app.use(apiPrefix, auditLogMiddleware);

  // Mount routes
  app.use(`${apiPrefix}/accounts`, accountsRouter);
  app.use(`${apiPrefix}/journal-entries`, journalEntriesRouter);
  app.use(`${apiPrefix}/invoices`, invoicesRouter);
  app.use(`${apiPrefix}/bills`, billsRouter);
  app.use(`${apiPrefix}/reports`, reportsRouter);
  app.use(`${apiPrefix}/bank-accounts`, bankReconciliationRouter);
  app.use(`${apiPrefix}/webhooks`, webhooksRouter);
  app.use(`${apiPrefix}/vendors`, vendorsRouter);
  app.use(`${apiPrefix}/customers`, customersRouter);
  app.use(`${apiPrefix}/fiscal-periods`, fiscalPeriodsRouter);
  app.use(`${apiPrefix}/xml`, xmlIngestionRouter);
  app.use(apiPrefix, xmlIngestionRouter);
  app.use(`${apiPrefix}/admin/blockchain`, blockchainRouter);
  app.use(`${apiPrefix}/admin`, blockchainRouter);
  app.use(`${apiPrefix}/admin/integrations`, integrationsRouter);
  app.use(`${apiPrefix}/payroll`, payrollRouter);
  app.use(`${apiPrefix}/ai`, aiRouter);

  // ============================================================
  // GraphQL API — DISABLED BY DEFAULT
  //
  // This is a second door into the same engine, and it is measurably the
  // less safe one:
  //   · it is mounted at /graphql, OUTSIDE the /v1 prefix, so it bypasses
  //     the audit and rate-limiting middleware every REST route carries —
  //     y hasta TEN-2 también se saltaba `tenantContext`, que es el que abre
  //     el contexto que leen las políticas de RLS. Sin él la consulta viaja
  //     directa al pool SIN inquilino: con el rol mnemosine_app habría
  //     devuelto cero filas y con un rol dueño o superusuario —que ignora
  //     RLS— las de TODOS los inquilinos. Ya va montado;
  //   · `createJournalEntry` and `postJournalEntry` reach the posting engine
  //     with `authenticate` only — there is no permission check anywhere in
  //     the resolvers, so any authenticated principal can post to any ledger
  //     the tenant context lets it see, leaving no audit row;
  //   · nothing in this repository consumes it. There is no web, ui, client
  //     or frontend directory; the only importer is this file.
  //
  // It is gated rather than deleted because this repository has no version
  // control, and 891 lines are not recoverable once removed. Set
  // GRAPHQL_ENABLED=true to bring it back exactly as it was — and if it is
  // ever brought back for real, the mutations need permission checks and the
  // mount needs to move inside the audited prefix first.
  // ============================================================
  const graphqlEnabled = process.env.GRAPHQL_ENABLED === 'true';
  type GraphqlContext = {
    user: import('./types/index.js').JwtPayload | undefined;
    tenantId: string | undefined;
    entityId: string | undefined;
  };
  const apolloServer = new ApolloServer<GraphqlContext>({
    typeDefs,
    resolvers,
  });

  await apolloServer.start();

  if (graphqlEnabled) {
    app.use(
      '/graphql',
      preAuthRateLimiter,
      authenticate,
      // Igual que en /v1: justo después de authenticate y antes de nada que
      // toque la base. Que esta puerta esté fuera del prefijo auditado no es
      // razón para que además corra sin inquilino.
      tenantContext,
      expressMiddleware(apolloServer, {
        context: async ({ req }) => ({
          user: req.user,
          tenantId: req.tenantId,
          entityId: req.entityId,
        }),
      })
    );
    logger.warn(
      'GraphQL is mounted at /graphql. It sits outside the audited /v1 prefix and its ' +
        'ledger mutations carry no permission check — do not expose it publicly.'
    );
  }

  // ============================================================
  // Error Handler (must be last)
  // ============================================================
  app.use(errorHandler);

  // ============================================================
  // Start Server
  // ============================================================
  const server = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, env: config.env });
    console.log(`
╔══════════════════════════════════════════════════╗
║         Accounting Core API Server               ║
║══════════════════════════════════════════════════║
║  REST API:    http://localhost:${config.port}/v1          ║
${graphqlEnabled ? `║  GraphQL:     http://localhost:${config.port}/graphql     ║` : '║  GraphQL:     disabled (GRAPHQL_ENABLED=true to mount)   ║'}
║  Health:      http://localhost:${config.port}/health      ║
║  Live:        http://localhost:${config.port}/live        ║
║  Ready:       http://localhost:${config.port}/ready       ║
║  Environment: ${config.env.padEnd(34)}║
╚══════════════════════════════════════════════════╝
    `);
  });

  // ─── Graceful shutdown ───
  // Stop accepting new connections, finish in-flight requests, then drain the
  // PG pool. Hard exit after 30s if the loop never empties (zombie keep-alive).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });
    const forceExit = setTimeout(() => {
      logger.error('shutdown_timeout', { message: 'Shutdown took >30s — forcing exit' });
      process.exit(1);
    }, 30_000);
    forceExit.unref();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      await apolloServer.stop();
      // Las atestaciones en vuelo, antes de cerrar el pool.
      //
      // `attestEntryAsync` es dispara-y-olvida: la promesa vive fuera de la
      // petición. El CLI ya drenaba al apagarse (mnemosine.ts); aquí no, así
      // que `closeDatabase()` mataba por debajo la atestación de un asiento
      // recién posteado y el `.catch` la degradaba a un warn. El asiento
      // quedaba posteado y sin hash — y, desde ATE-1, un periodo con un solo
      // asiento así ya no se puede sellar, que es como debe ser: mejor que se
      // note.
      await drainAttestations(5000).catch(() => undefined);
      await closeDatabase();
      logger.info('shutdown_complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown_error', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('bootstrap_failed', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
