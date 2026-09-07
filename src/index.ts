import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { ApolloServer } from '@apollo/server';
// Apollo Server 5 retiró el subpath `@apollo/server/express4`: la integración con
// Express vive ahora en un paquete propio. Seguimos en Express 4, así que el
// paquete es el de la versión 4, no el de la 5.
import { expressMiddleware } from '@as-integrations/express4';
import { config } from './config/index.js';
import { query, closeDatabase, initDatabase } from './database/connection.js';
import { verificarRolSujetoARls } from './database/rls-guard.js';
import { drainAttestations } from './services/accounting/posting.js';
import { authenticate } from './api/rest/middleware/auth.js';
import { asyncHandler } from './api/rest/middleware/async-handler.js';
import { auditLogMiddleware } from './api/rest/middleware/audit.js';
import { tenantContext } from './api/rest/middleware/tenant-context.js';
import { errorHandler } from './api/rest/middleware/error-handler.js';
import { rateLimiter, preAuthRateLimiter } from './api/rest/middleware/rate-limiter.js';
import { resolverTrustProxy } from './api/rest/trust-proxy.js';
import { metricsMiddleware, metricsHandler } from './api/rest/middleware/metrics.js';
import { correlationIdMiddleware, enrichLogContextMiddleware } from './api/rest/middleware/correlation.js';
import { logger } from './utils/logger.js';
import { formatearError } from './api/graphql/errores.js';
import { typeDefs } from './api/graphql/schemas/schema.js';
import { resolvers } from './api/graphql/resolvers/index.js';

// Route imports. La tabla del prefijo autenticado vive en montajes.ts para
// que la prueba del censo de riesgo monte EXACTAMENTE lo que monta esto.
import { MONTAJES_V1 } from './api/rest/montajes.js';
import { auditarRiesgoDeRutas } from './api/rest/risk.js';
import publicVerificationRouter from './api/rest/routes/public-verification.js';
import aiWebhooksRouter from './api/rest/routes/ai-webhooks.js';
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

  // `trust proxy` EXPLÍCITO. Sin él Express deja `req.ip` en la dirección del
  // socket, que detrás de un balanceador es la del balanceador para todos: el
  // limitador previo a autenticar —único freno de /public/v1 y de los webhooks
  // de IA, que sirven sin JWT— reparte un solo cubo entre todos los que llaman.
  // El valor correcto depende del despliegue y no se adivina desde aquí; el por
  // qué de cada forma está en api/rest/trust-proxy.ts.
  const trustProxy = resolverTrustProxy(process.env.TRUST_PROXY, config.env);
  try {
    app.set('trust proxy', trustProxy.valor);
  } catch (err) {
    // Express compila la lista de confianza aquí mismo, así que un CIDR mal
    // escrito aborta el arranque. Se reescribe el error para que diga QUÉ
    // variable revisar: el de proxy-addr no la nombra.
    throw new Error(
      `TRUST_PROXY no es un valor válido (${JSON.stringify(process.env.TRUST_PROXY)}): ` +
        `${err instanceof Error ? err.message : String(err)}. Usa un número de saltos, ` +
        'una lista de IPs o redes CIDR separadas por comas, o false.'
    );
  }
  if (trustProxy.aviso) logger.warn('trust_proxy', { detail: trustProxy.aviso });

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
  //
  // Y la excepción NO apaga CSP: lo declara. Poner
  // `contentSecurityPolicy: false` seguía siendo la misma alerta
  // (`js/insecure-helmet-configuration`) escrita más pequeña — dejaba una
  // ruta de ejecución sin ninguna política. En vez de eso, el playground
  // recibe las directivas por omisión de helmet con el CDN que su landing
  // necesita añadido a script/style/img, y nada más. La política sigue
  // aplicándose en los dos caminos; lo único que cambia es cuánto permite.
  const playgroundGraphql = process.env.GRAPHQL_ENABLED === 'true' && config.env !== 'production';
  const CDN_PLAYGROUND = 'https://cdn.jsdelivr.net';
  const cspPlayground = {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'", CDN_PLAYGROUND],
      'style-src': ["'self'", "'unsafe-inline'", CDN_PLAYGROUND],
      'img-src': ["'self'", 'data:', CDN_PLAYGROUND],
    },
  };
  app.use(helmet({ contentSecurityPolicy: playgroundGraphql ? cspPlayground : undefined }));
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
  app.get('/ready', asyncHandler(async (_req, res) => {
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
  }));
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

  // Mount routes — el orden es el de la tabla, y es significativo: dos
  // routers se montan dos veces cada uno y Express resuelve por orden.
  for (const [sufijo, router] of MONTAJES_V1) {
    app.use(`${apiPrefix}${sufijo}`, router);
  }

  // ============================================================
  // GraphQL API — DISABLED BY DEFAULT
  //
  // This is a second door into the same engine, and it is measurably the
  // less safe one:
  //   · it is mounted at /graphql, OUTSIDE the /v1 prefix, so it bypasses the
  //     AUDIT middleware every REST route carries: lo que pasa por aquí no deja
  //     la fila de PETICIÓN —la que lleva IP, agente y request_id—. La fila del
  //     HECHO contable sí queda: la escriben los servicios dentro de su propia
  //     transacción. Los dos frenos —por IP y por inquilino— sí los
  //     lleva ya, uno a cada lado de `authenticate`, igual que /v1;
  //     y hasta TEN-2 también se saltaba `tenantContext`, que es el que abre
  //     el contexto que leen las políticas de RLS. Sin él la consulta viaja
  //     directa al pool SIN inquilino: con el rol mnemosine_app habría
  //     devuelto cero filas y con un rol dueño o superusuario —que ignora
  //     RLS— las de TODOS los inquilinos. Ya va montado;
  //   · sus mutaciones llegaban al motor de posteo con `authenticate` y nada
  //     más: ni un `requirePermission` en los 393 renglones de resolutores, de
  //     modo que un `viewer` posteaba al mayor y cerraba el ejercicio. YA NO:
  //     todos los campos de Query y Mutation entran por `blindar`
  //     (api/graphql/permisos.ts), que exige el MISMO permiso que la ruta REST
  //     equivalente con el MISMO código (`assertPermissions`), y que al cargar
  //     contrasta el esquema contra el catálogo: una mutación declarada que no
  //     esté implementada-con-permiso o listada como ausente impide que los
  //     resolutores se carguen. Lo que sigue faltando aquí es la fila de
  //     `audit_log` que escribe `auditLogMiddleware` con IP y agente; el rastro
  //     CONTABLE no falta, porque posting.ts y period-close.ts escriben su
  //     renglón dentro de la misma transacción del hecho;
  //   · nothing in this repository consumes it. There is no web, ui, client
  //     or frontend directory; the only importer is this file.
  //
  // It is gated rather than deleted because this repository has no version
  // control, and 891 lines are not recoverable once removed. Set
  // GRAPHQL_ENABLED=true to bring it back — ya no «exactly as it was»: las
  // mutaciones ya piden permiso. Lo que falta antes de exponerlo de verdad es
  // mover el montaje dentro del prefijo auditado y tapar los campos del
  // esquema que no existen (están inventariados, uno por uno, en
  // api/graphql/permisos.ts).
  // ============================================================
  const graphqlEnabled = process.env.GRAPHQL_ENABLED === 'true';
  type GraphqlContext = {
    user: import('./types/index.js').JwtPayload | undefined;
    tenantId: string | undefined;
    entityId: string | undefined;
    entidadDeCabecera: string | undefined;
  };
  const apolloServer = new ApolloServer<GraphqlContext>({
    typeDefs,
    resolvers,
    // La traducción vive en su propio módulo para poder probarla: aquí
    // dentro de bootstrap() no la alcanza ninguna prueba.
    formatError: formatearError,
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
      // EL SEGUNDO FRENO, el que acota POR INQUILINO. `preAuthRateLimiter` va
      // arriba y cuenta por IP, que es lo que impide que verificar un JWT sea
      // trabajo gratis para el no autenticado; éste cuenta por inquilino y por
      // eso va DESPUÉS de authenticate, que es quien dice de quién es la
      // petición. /v1 lleva los dos desde siempre y esta puerta sólo llevaba el
      // primero: medido, un principal autenticado que rota de IP pasaba las
      // ocho peticiones por aquí y ninguna por /v1.
      //
      // No se pone para callar a `js/missing-rate-limiting`: esa regla no
      // reconoce estos middlewares —modela cinco paquetes que este repo no usa—
      // y sigue abierta sobre /v1, que ya los tiene ambos. Se pone porque el
      // hueco es real.
      rateLimiter,
      expressMiddleware(apolloServer, {
        context: async ({ req }) => ({
          user: req.user,
          tenantId: req.tenantId,
          entityId: req.entityId,
          // La cabecera CRUDA, aparte de `entityId`. `authenticate` deja
          // `req.entityId = cabecera || entities[0]`, así que ese campo no dice
          // si el cliente pidió algo o se le puso de relleno — y la regla de
          // «una petición nombra una sola entidad» distingue justo eso.
          entidadDeCabecera:
            typeof req.headers['x-entity-id'] === 'string' ? req.headers['x-entity-id'] : undefined,
        }),
      })
    );
    logger.warn(
      'GraphQL is mounted at /graphql. Its mutations now demand the same permissions as their REST ' +
        'equivalents, but it still sits outside the audited /v1 prefix: no audit_log row with IP and ' +
        'user agent (the ledger trail written by the services is unaffected).'
    );
  }

  // ============================================================
  // CENSO DE RIESGO DE RUTAS — la compuerta que hace que la API declare.
  //
  // El gemelo de esto en el CLI no hace falta llamarlo: `declareRisk` lanza
  // al REGISTRAR el comando, y registrar los comandos es construir el
  // programa. Montar un router de Express, en cambio, no comprueba nada, así
  // que aquí el equivalente se llama a mano — después de montar TODO
  // (incluidos /public/v1 y los webhooks de IA, que no van en la tabla) y
  // antes de escuchar.
  //
  // Si una ruta POST, PUT, PATCH o DELETE no declaró su clase, esto lanza y
  // bootstrap() sale con código 1. No avisa: rompe. Un censo que sólo avisa
  // es un censo que nadie mira, y la API llegó a postear al mayor saltándose
  // el control de cuatro ojos precisamente porque nadie miraba.
  // ============================================================
  const censo = auditarRiesgoDeRutas(app);
  logger.info('censo_riesgo_rutas', {
    total: censo.rutas.length,
    ...censo.porClase,
  });

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
