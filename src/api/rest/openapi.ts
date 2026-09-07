import type { Express, Router } from 'express';
import { censarRutas, VERBOS_QUE_MUTAN, alcanceDeIdempotencia, type RutaCensada } from './risk.js';
import { esquemaDeCuerpo } from './middleware/async-handler.js';
import { permisosDeManejador } from './middleware/auth.js';
import { jsonSchemaDeZod, type EsquemaJson } from './zod-a-json-schema.js';
import { CABECERA_LLAVE, LARGO_MAX_CLAVE } from './middleware/idempotencia.js';

// ============================================================
// EL CONTRATO DE LA API, DERIVADO DE LA API.
//
// Había 50 esquemas de Zod validando cada cuerpo y CERO especificación:
// quien integra contra esto leía los 5 146 renglones de src/api/rest/routes
// o adivinaba. La respuesta obvia —escribir un openapi.yaml— es la que este
// proyecto lleva un mes demostrando que no funciona: una lista al lado del
// código se desincroniza el primer martes, y nadie se entera hasta que un
// cliente manda el campo que el documento prometía.
//
// Así que no se escribe: se PREGUNTA. `censarRutas` (G4a) ya recorre la
// pila real de Express y devuelve, por ruta, el método, el camino, la clase
// de riesgo declarada y —desde este tramo— la cadena de manejadores tal
// como Express la corre. De esa cadena salen las otras dos verdades:
//
//   · el esquema de Zod, colgado del manejador de `validateBody`;
//   · los permisos, colgados del manejador de `requirePermission`.
//
// Ninguna de las tres se copia a mano en ninguna parte. Una ruta que se
// renombre, que cambie de esquema o que cambie de clase aparece cambiada
// aquí en la siguiente ejecución, y una ruta NUEVA aparece sola — que es lo
// que la prueba de tests/api/routes/openapi-contrato.spec.ts exige: la
// especificación cubre TODAS las rutas del censo, o falla.
//
// LO QUE ESTA ESPECIFICACIÓN NO DICE, dicho aquí y no escondido:
//
//   · Las respuestas de ÉXITO. La forma de un 200 no está en el censo —vive
//     dentro del cuerpo del manejador, en `res.json({...})`— y no se
//     inventa. Publicarlas exige declararlas en la ruta, con el mismo
//     mecanismo que la clase de riesgo, y eso es otro tramo. Lo que sí se
//     publica son los errores que SÍ se derivan: los que produce la cadena
//     que el censo ve.
//
//   · La autenticación de las rutas que no llevan `requirePermission`.
//     `authenticate` se monta sobre el PREFIJO (`app.use('/v1', ...)`), no
//     dentro de la cadena de la ruta, así que el censo no lo ve. Sí se
//     deriva lo contrario, y es una implicación sólida: una ruta con
//     `requirePermission` NO PUEDE servirse sin autenticar, porque
//     `assertPermissions` lanza 401 cuando no hay `req.user` y sólo
//     `authenticate` lo puebla. Esas llevan `security`; las demás no llevan
//     nada, y la ausencia significa «no derivable», nunca «pública».
// ============================================================

/** La versión de OpenAPI que se emite. Ver zod-a-json-schema.ts para el porqué de 3.1. */
export const VERSION_OPENAPI = '3.1.0';

export interface OpcionesContrato {
  /** `info.version` del documento. Por omisión, la del paquete. */
  version?: string;
  /** `servers` del documento. Vacío por omisión: la URL no está en el código. */
  servidores?: ReadonlyArray<{ url: string; description?: string }>;
}

type Operacion = Record<string, unknown>;

/**
 * Construye el documento OpenAPI de una app —o de un router— recorriendo su
 * pila real.
 *
 * Se le pasa la app en vez de construirla aquí porque el instrumento tiene
 * que poder apuntarse a lo que uno quiera censar: la superficie completa
 * (scripts/openapi.ts), un router suelto en una prueba, o la app real el
 * día que arrancar sin base sea posible.
 */
export function construirOpenAPI(
  destino: Express | Router,
  opciones: OpcionesContrato = {}
): Record<string, unknown> {
  const rutas = censarRutas(destino);
  const caminos: Record<string, Record<string, Operacion>> = {};
  const idsVistos = new Map<string, string>();

  // Orden estable: el documento se regenera a menudo y un diff que cambia de
  // orden entre dos ejecuciones idénticas es un diff que nadie lee.
  const ordenadas = [...rutas].sort(
    (a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo)
  );

  for (const r of ordenadas) {
    const camino = caminoOpenAPI(r.ruta);
    const operacion = operacionDe(r, camino);

    const id = String(operacion.operationId);
    const anterior = idsVistos.get(id);
    if (anterior !== undefined) {
      // Dos operaciones con el mismo `operationId` rompen a todo generador de
      // clientes, y calladamente: uno de los dos métodos desaparece. Se rompe
      // aquí, con las dos rutas a la vista.
      throw new Error(
        `Dos rutas producen el mismo operationId "${id}": ${anterior} y ` +
          `${r.metodo.toUpperCase()} ${r.ruta}. Un operationId repetido hace que un generador ` +
          'de clientes se quede con una sola de las dos, sin avisar. Renombra una de las rutas.'
      );
    }
    idsVistos.set(id, `${r.metodo.toUpperCase()} ${r.ruta}`);

    caminos[camino] ??= {};
    caminos[camino][r.metodo] = operacion;
  }

  return {
    openapi: VERSION_OPENAPI,
    info: {
      title: 'mnemosine — Accounting Core API',
      version: opciones.version ?? '1.0.0',
      description: DESCRIPCION,
    },
    ...(opciones.servidores && opciones.servidores.length > 0
      ? { servers: [...opciones.servidores] }
      : {}),
    paths: caminos,
    components: COMPONENTES,
  };
}

// ─── una operación ───

function operacionDe(r: RutaCensada, camino: string): Operacion {
  const op: Operacion = {
    operationId: operationId(r.metodo, camino),
    tags: [etiquetaDe(camino)],
  };

  const riesgo = r.riesgo;
  const permisos = primerPermiso(r.manejadores);
  const esquema = primerEsquema(r.manejadores);

  op.summary = resumen(r, riesgo?.riesgo);
  if (riesgo) {
    op['x-riesgo'] = riesgo.riesgo;
    op['x-agente-permitido'] = riesgo.agentePermitido;
    op['x-exige-marcha-seca'] = riesgo.exigeMarchaSeca;
    op['x-exige-compuerta-en-vivo'] = riesgo.exigeCompuertaEnVivo;
    op['x-exige-llave-de-idempotencia'] = riesgo.exigeLlaveDeIdempotencia;
    if (riesgo.escribe !== undefined) op['x-escribe'] = riesgo.escribe;
    if (riesgo.exigeLlaveDeIdempotencia) {
      // El alcance con el que el almacén guarda la llave. Se publica porque
      // determina el radio de la deduplicación: la misma llave en dos rutas
      // distintas son dos llaves, y quien reintenta necesita saberlo.
      op['x-alcance-idempotencia'] = alcanceDeIdempotencia(r);
    }
  }

  const parametros: EsquemaJson[] = parametrosDeCamino(camino);
  if (riesgo?.exigeLlaveDeIdempotencia) {
    parametros.push({ $ref: '#/components/parameters/LlaveDeIdempotencia' });
  }
  if (permisos) {
    parametros.push({ $ref: '#/components/parameters/EntidadActiva' });
    op['x-permisos-requeridos'] = [...permisos];
    op.security = [{ bearerAuth: [] }];
  }
  if (parametros.length > 0) op.parameters = parametros;

  if (esquema) {
    op.requestBody = {
      // Un cuerpo es obligatorio cuando el esquema rechaza el objeto vacío,
      // y eso no se opina: se le pregunta al propio esquema. Express entrega
      // `{}` cuando no viene cuerpo, así que ésa es exactamente la prueba.
      required: !esquema.safeParse({}).success,
      content: {
        'application/json': {
          schema: jsonSchemaDeZod(esquema, `${r.metodo.toUpperCase()} ${r.ruta}`),
        },
      },
    };
  }

  op.responses = respuestas(Boolean(esquema), Boolean(permisos), riesgo?.exigeLlaveDeIdempotencia);
  return op;
}

function resumen(r: RutaCensada, clase: string | undefined): string {
  const verbo = VERBOS_QUE_MUTAN.includes(r.metodo) ? 'Mutating' : 'Read';
  return clase === undefined
    ? `${verbo} route (no declared risk class; GET routes default to "lectura").`
    : `${verbo} route declared "${clase}".`;
}

/**
 * Las respuestas que SÍ se derivan de la cadena que el censo ve.
 *
 * Cada una está atada a un manejador concreto: el 422 lo produce
 * `validateBody`, el 401/403 los produce `assertPermissions`, el 409 lo
 * produce el guardián de idempotencia cuando la misma llave llega con otra
 * carga, y el 500 lo produce `errorHandler` para todo lo que no sea un
 * `AppError`. No hay ninguna que se haya supuesto.
 */
function respuestas(
  conCuerpo: boolean,
  conPermiso: boolean,
  conLlave: boolean | undefined
): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (conPermiso) {
    r['401'] = { $ref: '#/components/responses/NoAutenticado' };
    r['403'] = { $ref: '#/components/responses/SinPermiso' };
  }
  if (conLlave) r['409'] = { $ref: '#/components/responses/LlaveReusada' };
  if (conCuerpo) r['422'] = { $ref: '#/components/responses/CuerpoInvalido' };
  r['500'] = { $ref: '#/components/responses/ErrorInterno' };
  return r;
}

// ─── lectura de la cadena de manejadores ───

function primerEsquema(manejadores: readonly unknown[]) {
  for (const h of manejadores) {
    const e = esquemaDeCuerpo(h);
    if (e) return e;
  }
  return undefined;
}

function primerPermiso(manejadores: readonly unknown[]): readonly string[] | undefined {
  for (const h of manejadores) {
    const p = permisosDeManejador(h);
    if (p) return p;
  }
  return undefined;
}

// ─── caminos ───

/** `/v1/invoices/:id/payments` → `/v1/invoices/{id}/payments`. */
export function caminoOpenAPI(ruta: string): string {
  return ruta.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parametrosDeCamino(camino: string): EsquemaJson[] {
  return [...camino.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    // `type: string` y nada más, a propósito. La mayoría son UUID, pero eso
    // no está escrito en ninguna parte que este instrumento pueda leer: el
    // manejador lo descubre al consultar. Publicar `format: uuid` sería
    // adivinar, y una adivinanza en un contrato es peor que un silencio.
    schema: { type: 'string' },
  }));
}

function etiquetaDe(camino: string): string {
  // `/v1/admin/blockchain/config` → `admin`; `/public/v1/verify/x` → `public`.
  const partes = camino.split('/').filter((p) => p !== '' && p !== 'v1');
  return partes[0] ?? 'root';
}

function operationId(metodo: string, camino: string): string {
  const cuerpo = camino
    .replace(/[{}]/g, '')
    .split('/')
    .filter((p) => p !== '')
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_');
  return `${metodo}_${cuerpo}`;
}

// ─── piezas fijas del documento ───
//
// Éstas SÍ están escritas a mano, y la diferencia con una lista paralela es
// que no describen rutas: describen el sobre de error de `errorHandler` y el
// contrato de la cabecera de idempotencia, que son UNO para toda la API y
// viven en un solo archivo cada uno. Nada aquí se multiplica por ruta.

const ESQUEMA_ERROR: EsquemaJson = {
  type: 'object',
  description: 'The envelope every error goes out in (src/api/rest/middleware/error-handler.ts).',
  properties: {
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          field: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
        required: ['code', 'message'],
      },
    },
    meta: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        version: { type: 'string' },
      },
    },
  },
  required: ['errors'],
};

function respuesta(descripcion: string): EsquemaJson {
  return {
    description: descripcion,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

const COMPONENTES: Record<string, unknown> = {
  schemas: { Error: ESQUEMA_ERROR },
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Either a token this system issued (HS256) or one from the configured OIDC provider ' +
        '(RS256/ES256); the header algorithm picks the path.',
    },
  },
  parameters: {
    LlaveDeIdempotencia: {
      name: CABECERA_LLAVE,
      in: 'header',
      required: false,
      description:
        'OPTIONAL, and honoured when sent. Same key + same payload replays the recorded ' +
        'response without re-running the act; same key + a different payload is rejected with ' +
        '409. Sending no key touches nothing. Only success is recorded, and only after the ' +
        'act, so a retry after a 5xx is not locked out. Whether this should be mandatory on ' +
        'irreversible routes is an open question, named in middleware/idempotencia.ts.',
      schema: { type: 'string', maxLength: LARGO_MAX_CLAVE },
    },
    EntidadActiva: {
      name: 'x-entity-id',
      in: 'header',
      required: false,
      description:
        'Picks which of the entities in the token this request acts on. It does not widen the ' +
        'token: an id the token does not carry is refused with 403. Absent, the first entity ' +
        'in the token is used.',
      schema: { type: 'string' },
    },
  },
  responses: {
    NoAutenticado: respuesta('Missing, malformed or expired bearer token (UNAUTHORIZED).'),
    SinPermiso: respuesta(
      'Authenticated, but missing at least one of x-permisos-requeridos, or acting on an ' +
        'entity the token does not carry (FORBIDDEN).'
    ),
    LlaveReusada: respuesta(
      'The same Idempotency-Key was already used with a different payload ' +
        '(RESOURCE_ALREADY_EXISTS).'
    ),
    CuerpoInvalido: respuesta(
      'The request body failed the schema in requestBody (VALIDATION_ERROR). Note the status ' +
        'is 422, not 400.'
    ),
    ErrorInterno: respuesta('Unhandled failure (INTERNAL_SERVER_ERROR).'),
  },
};

const DESCRIPCION = [
  'Generated from the running Express stack, never written by hand. Every path, method, ',
  'request body, required permission and risk class below is read out of the handlers the ',
  'server actually mounts (src/api/rest/openapi.ts), so a route that changes shows up changed ',
  'and a route that is added shows up on its own.',
  '\n\n## Extensions\n\n',
  '- `x-riesgo` — the class the route declares: `lectura` (reads only), `escritura` ',
  '(reversible write), `irreversible` (posts to the ledger, voids, deletes — repeating it is ',
  'not the same as doing it once), `externo` (reaches a PAC, the SAT, a bank, a mailbox). ',
  'Operations with no `x-riesgo` are GET routes with no declaration, which the server reads as ',
  '`lectura`. A POST, PUT, PATCH or DELETE can never be missing it: the server refuses to boot.\n',
  '- `x-exige-llave-de-idempotencia` — true where a retry is not free. Those operations accept ',
  'the `Idempotency-Key` header; see its description for the exact contract.\n',
  '- `x-alcance-idempotencia` — the scope a key is stored under. The same key on two different ',
  'operations is two different keys.\n',
  '- `x-exige-marcha-seca` / `x-exige-compuerta-en-vivo` — the route must be able to show its ',
  'effect before performing it, and (for `externo`) talks to a sandbox unless live is opted in.\n',
  '- `x-agente-permitido` — whether the LLM agent may call this on its own. False on every ',
  'mutating route today.\n',
  '- `x-escribe` — the declaration’s own words about what the route writes.\n',
  '- `x-permisos-requeridos` — ALL of them are required, not any one. The `*` wildcard passes.\n',
  '- `x-claves-desconocidas` (on object schemas) — `descartadas`: unknown keys validate and are ',
  'then silently dropped; `conservadas`: they validate and are kept. JSON Schema cannot say the ',
  'difference, and it is the difference between a field being stored and a field vanishing.\n',
  '- `x-validacion-adicional` — the body also passes a cross-field predicate that JSON Schema ',
  'cannot express (for example "company_name or first_name", "debit or credit, not both"). ',
  'Validating against this schema alone is not enough to know the request will be accepted.\n',
  '\n## What is not here\n\n',
  'Success responses. Their shape lives inside the handler bodies, which the census does not ',
  'read, and inventing them would be the exact defect this document exists to avoid. Only the ',
  'errors that are provably produced by the mounted chain are listed.\n\n',
  'Security on operations without `security`. Authentication is mounted on the `/v1` prefix, ',
  'outside the route chain, so it is not visible to the census; the absence of `security` means ',
  '"not derivable", not "public".\n\n',
  'The body of an operation with no `requestBody`. No `requestBody` means the route has no ',
  '`validateBody` in its chain, which is all the census can tell; it does NOT mean the route ',
  'takes no body. 17 mutating routes read fields straight out of `req.body` and reject the ',
  'request when they are missing — `POST /v1/invoices/{id}/cfdi/cancel` needs ',
  '`cancellation_reason`, and publishes nothing. Until those routes declare a schema, a client ',
  'generated from this document cannot call them.\n\n',
  'Whether a handler will accept a body this schema accepts. `requestBody` is the schema ',
  '`validateBody` applies, and that is the whole of what the census can see: a handler can ',
  'still reject the request from inside its own body, and 40 such checks live across 8 route ',
  'files today. Passing this schema proves the request is well formed, not that it will be ',
  'accepted. Where such a rule fits in the schema it belongs there instead — that is the only ',
  'way this document can carry it.\n\n',
  'Whether a path is switched on. `/public/v1/**` is only served with ',
  'PUBLIC_VERIFICATION_ENABLED=true; the flag decides whether those routes answer, not whether ',
  'they exist.\n\n',
  'Bodies are JSON and capped at 10 MB by the global parser. `/v1/ai/webhooks/**` is the ',
  'exception: it reads raw bytes with its own 1 MB cap.',
].join('');
