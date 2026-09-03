import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../../config/index.js';
import { UnauthorizedError, ForbiddenError, ValidationError } from '../../../utils/errors.js';
import { isAsymmetric, verifyIdpToken } from '../../../auth/oidc.js';
import { resolveIdentity, NoAccessError } from '../../../auth/provisioning.js';
import type { JwtPayload } from '../../../types/index.js';
import { ROLES as CATALOGO_DE_ROLES, hasPermission, type Permission } from '../../../auth/roles.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      tenantId?: string;
      entityId?: string;
    }
  }
}

/**
 * DUAL verification: keeps accepting our own token (HS256, signed with
 * our secret) and also validates tokens from an OIDC provider (RS256/ES256
 * against its JWKS). The decision comes from the header's algorithm, not
 * from configuration: that lets the local development path and the IdP coexist.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  void authenticateAsync(req, res).then(
    () => next(),
    (err) => next(err)
  );
};

async function authenticateAsync(req: Request, _res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or invalid authorization header');
  }
  const token = authHeader.substring(7);

  const payload = isAsymmetric(token)
    ? await verifyExternal(token)
    : verifyLocal(token);

  req.user = payload;
  req.tenantId = payload.tenant_id;
  req.entityId = resolverEntidadActiva(payload, req.headers['x-entity-id']);
}

/**
 * LA CABECERA ELIGE ENTRE LAS ENTIDADES DEL TOKEN; NO LAS AMPLÍA.
 *
 * Esto era `(req.headers['x-entity-id'] as string) || payload.entities[0]`, sin
 * contrastar la cabecera contra nada. Y `req.entityId` es el alcance con el que
 * trabaja media API: `entityId: req.entityId!` en invoices, `entity_id ||
 * req.entityId` en bills, customers, vendors, journal-entries y fiscal-periods.
 *
 * Lo que eso significaba: el alcance de la petición lo escribía el cliente. El
 * primer tramo de TEN-1 acotó `issueInvoice`/`voidInvoice` con `entityId`
 * obligatorio, y las dos rutas que los llaman —POST /v1/invoices/:id/send y
 * /:id/void— no llevan `requireEntityAccess`. Así que el filtro `AND entity_id
 * = $2` que se añadió al SQL recibía el valor de la cabecera: bastaba mandar
 * `x-entity-id: <entidad ajena>` para que el SELECT ... FOR UPDATE acotado
 * encontrara la factura ajena y la anulara, contraasentando su ingreso en el
 * mayor de la víctima. El arreglo era correcto y sorteable a la vez.
 *
 * `requireEntityAccess` no lo tapaba ni donde está montado: mira el PRIMERO de
 * (req.entityId, params.entity_id, body.entity_id), y req.entityId siempre
 * tiene valor — de modo que en una ruta cuyo id de entidad viaja en el cuerpo
 * valida la cabecera y nunca el cuerpo.
 *
 * Se arregla AQUÍ, en authenticate, y no en un middleware que cada ruta deba
 * recordar montar: es el mismo criterio que puso la frontera en la capa de
 * datos. Un valor que sale de authenticate ya es de fiar, o no sale.
 *
 * 403 y no 404: no hay lectura de base ni oráculo de existencia. La cabecera se
 * contrasta contra una lista que el propio llamador ya tiene en su token, así
 * que la respuesta no le dice nada que no supiera.
 */
function resolverEntidadActiva(
  payload: JwtPayload,
  cabecera: string | string[] | undefined
): string | undefined {
  // Sin cabecera: la entidad por omisión del token. Es la que ya se usaba.
  if (cabecera === undefined) return payload.entities[0];

  // Repetida (`x-entity-id: a, x-entity-id: b`) Express la entrega como array.
  // No se elige una: una petición actúa sobre UNA entidad, y adivinar cuál
  // quiso decir el cliente es exactamente la clase de decisión que no debe
  // tomar la capa de autenticación.
  if (Array.isArray(cabecera)) {
    throw new ForbiddenError('x-entity-id viene repetida: la petición actúa sobre una sola entidad');
  }

  const pedida = cabecera.trim();
  if (pedida === '') return payload.entities[0];

  if (!payload.entities.includes(pedida)) {
    // El mensaje no distingue entre «esa entidad no existe» y «existe y no es
    // tuya»: no hace falta, porque no se ha leído nada para saberlo.
    throw new ForbiddenError('Access denied to this entity');
  }
  return pedida;
}

function verifyLocal(token: string): JwtPayload {
  try {
    // Algoritmo FIJADO (S1): sin la lista, jwt.verify acepta el algoritmo
    // que el token declare — la puerta clásica de alg-confusion. La retirada
    // completa de esta rama sigue en la mesa (plan de cierre); mientras viva,
    // no negocia.
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

async function verifyExternal(token: string): Promise<JwtPayload> {
  if (!config.auth.enabled) {
    throw new UnauthorizedError('The token comes from an external provider and OIDC is not configured');
  }
  try {
    const identity = await verifyIdpToken(token, {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
    return await resolveIdentity(identity, {
      provider: config.auth.provider,
      defaultTenantId: config.auth.tenantId,
    });
  } catch (err) {
    // A valid user without granted access is not an authentication failure:
    // the message has to say what is missing, not "invalid token".
    if (err instanceof NoAccessError) throw new ForbiddenError(err.message);
    throw new UnauthorizedError(
      err instanceof Error ? `External token rejected: ${err.message}` : 'External token rejected'
    );
  }
}

/**
 * LA COMPROBACIÓN DE PERMISOS, SIN EXPRESS.
 *
 * `requirePermission` era la única forma de hacer esta pregunta y sólo se
 * podía hacer desde un middleware. GraphQL no tiene middlewares por campo: por
 * eso sus cinco mutaciones —crear, postear y anular asientos, cerrar periodos
 * en blando y en duro— llegaban al motor comprobando únicamente PERTENENCIA de
 * entidad, y un `viewer` (accounts:read, journal_entries:read, invoices:read,
 * bills:read, reports:read) podía postear al mayor y cerrar el ejercicio.
 *
 * Se extrae el núcleo en vez de copiarlo en la otra puerta: dos
 * implementaciones de «¿tiene permiso?» divergen —una aprende el comodín, la
 * otra no— y la que diverge es siempre la que no se mira. El middleware de
 * abajo es ahora una envoltura de tres renglones sobre esto, así que REST y
 * GraphQL contestan por el mismo código y con el mismo error.
 *
 * La semántica no cambia: el comodín pasa; sin él, TODOS los permisos pedidos
 * tienen que estar; si falta alguno, ForbiddenError con required/missing/current.
 */
export function assertPermissions(
  user: { permissions: string[] } | undefined,
  permissions: readonly string[]
): void {
  if (!user) {
    throw new UnauthorizedError();
  }

  // Wildcard admin
  if (user.permissions.includes('*')) {
    return;
  }

  const missing = permissions.filter((p) => !user.permissions.includes(p));
  if (missing.length > 0) {
    throw new ForbiddenError('Insufficient permissions', {
      required: permissions,
      missing,
      current: user.permissions,
    });
  }
}

export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    assertPermissions(req.user, permissions);
    next();
  };
}

export function requireEntityAccess(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  // SE VALIDAN TODOS LOS QUE LA PETICIÓN TRAE, NO EL PRIMERO.
  //
  // Esto era una cadena de `||`, y por eso no servía: `authenticate` puebla
  // SIEMPRE `req.entityId`, y un usuario sin entidades accesibles ni
  // siquiera puede iniciar sesión. El primer término nunca es falsy, así que
  // la cadena jamás llegaba a los otros tres: la guarda comprobaba una
  // fuente mientras el manejador leía su `?entity_id=`. Tres de las cuatro
  // eran inalcanzables.
  //
  // La cabecera ya la valida `resolverEntidadActiva` en el origen; esto es
  // la otra mitad, para las fuentes que no pasan por ahí.
  //
  // Con varias fuentes no hay forma de saber aquí cuál va a usar el
  // manejador —cada ruta lee la suya— así que la única regla correcta es
  // que TODAS tienen que ser suyas. Una petición que menciona una entidad
  // ajena se rechaza aunque el manejador fuera a ignorarla.
  //
  // Se distingue lo que la petición NOMBRA de lo que se puso por omisión.
  // `authenticate` deja `req.entityId = cabecera || payload.entities[0]`, así
  // que ese campo no dice si el cliente pidió algo: mezclarlo con lo nombrado
  // haría que un `?entity_id=B` legítimo, sin cabecera, chocara contra la
  // entidad que el token trae de relleno.
  const nombradas: Array<{ fuente: string; valor: string }> = [];
  const anota = (fuente: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) nombradas.push({ fuente, valor: v });
  };
  anota('la cabecera x-entity-id', req.headers?.['x-entity-id']);
  anota('la ruta (:entity_id)', req.params.entity_id);
  anota('el cuerpo', (req.body as { entity_id?: string } | undefined)?.entity_id);
  const enQuery = req.query.entity_id;
  for (const v of Array.isArray(enQuery) ? enQuery : [enQuery]) anota('la cadena de consulta (?entity_id=)', v);

  const distintas = [...new Set(nombradas.map((n) => n.valor))];

  // DOS ENTIDADES DISTINTAS EN UNA PETICIÓN SE RECHAZAN, AUNQUE LAS DOS SEAN
  // SUYAS.
  //
  // Comprobar que ambas pertenecen al usuario cierra el hueco de acceso y deja
  // otro abierto, que en un sistema contable es el que importa: cada ruta lee
  // la fuente que le da la gana —unas la cabecera, otras `?entity_id=`— y el
  // contexto de la bitácora se arma SIEMPRE con `req.entityId`
  // (middleware/correlation.ts). Con cabecera A y query B, el trabajo ocurre
  // sobre B y todo lo registrado dice A. No es una fuga: es una atribución
  // falsa, y no se puede reparar después porque el rastro ya se escribió así.
  //
  // Aquí no hay forma de saber cuál de las dos iba a usar el manejador. La
  // única respuesta correcta es no adivinar.
  if (distintas.length > 1) {
    throw new ValidationError(
      'La petición nombra ' +
        `${distintas.length} entidades distintas (` +
        nombradas.map((n) => `${n.fuente}: ${n.valor}`).join('; ') +
        '). Cada ruta usa la fuente que le corresponde y la bitácora registra la de la cabecera, ' +
        'así que con dos no se puede saber sobre cuál se trabajó. Manda una sola.',
      'entity_id'
    );
  }

  // Una sola entidad nombrada MANDA sobre la de relleno, y con ella se
  // registra la petición. Sin esto, `?entity_id=B` sin cabecera se trabaja
  // sobre B y se registra sobre la primera entidad del token — la misma
  // atribución falsa que el rechazo de arriba evita en el otro caso.
  if (distintas.length === 1) {
    req.entityId = distintas[0];
  }

  for (const entityId of new Set([...distintas, req.entityId].filter((v): v is string => !!v))) {
    assertEntityAccess(req.user, entityId);
  }
  next();
}

/**
 * Entity-membership check for handlers that address a resource by id: the
 * middleware above only sees entity_id when the REQUEST carries it, so
 * routes like /:id/post must fetch the resource's entity and call this.
 * RLS isolates the TENANT; entity membership is enforced here.
 */
export function assertEntityAccess(
  user: { entities: string[]; permissions: string[] },
  entityId: string
): void {
  // UN COMODÍN DE PERMISOS AUTORIZA VERBOS, NO FILAS.
  //
  // Antes esto era `... && !user.permissions.includes('*')`, y el rol owner
  // es exactamente ['*'] (ROLES.owner, abajo). O sea: para cualquier owner
  // esta función era un no-op y aceptaba el id de CUALQUIER entidad, de
  // cualquier inquilino. Lo único que quedaba en medio era RLS, que es
  // inerte con un rol de conexión que la ignora.
  //
  // Permiso y pertenencia son dos ejes distintos: `journal_entries:post`
  // dice QUÉ puedes hacer, accessible_entities dice SOBRE QUÉ. Quitar el
  // comodín no deja a nadie fuera: un usuario sin entidades accesibles ni
  // siquiera puede iniciar sesión (auth/provisioning.ts).
  if (!user.entities.includes(entityId)) {
    throw new ForbiddenError('Access denied to this entity');
  }
}

// El catálogo vive en src/auth/roles.ts, que es el único. Aquí había una de
// las dos copias que existían, con nombres de rol distintos de los del
// asistente de alta.
export const ROLES: Record<string, readonly string[]> = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOGO_DE_ROLES).map(([nombre, spec]) => [nombre, spec.permissions])
  )
);

// ============================================================
// SEGREGACIÓN POR COMPOSICIÓN DE ROL — LA REGLA QUE NO PODÍA DISPARARSE.
//
// Dos defectos, y los dos hacían que la severidad ALTA no se encendiera
// JAMÁS. Una regla de segregación que no puede dispararse es peor que no
// tenerla: ocupa el sitio donde iría una que sí, y el informe sale limpio.
//
//   1. Nombraba permisos INEXISTENTES. La regla alta pedía `vendors:create`
//      y `vendors:update`, y en el catálogo (src/auth/roles.ts) no hay ni ha
//      habido un solo permiso `vendors:*`: el alta y la edición de proveedor
//      las guarda `bills:create` (routes/vendors.ts:93 y :109). Ningún
//      usuario podía tener el primer grupo, así que la conjunción era falsa
//      para todos. Ahora el tipo es `Permission` y no `string`: un permiso
//      que no exista en el catálogo ya no compila, que es la única forma de
//      que esto no vuelva a pudrirse en silencio.
//
//   2. El comodín no casaba. `owner` es `['*']` (ROLES.owner) y el detector
//      hacía `permissions.includes(p)` contra literales: `'*'` no es igual a
//      `'bills:approve'`, así que el ÚNICO rol que puede hacerlo todo salía
//      sin una sola violación. Se pregunta con `hasPermission`, que es la
//      misma función con la que el perímetro decide si te deja pasar: si un
//      permiso te abre la puerta, cuenta para el conflicto.
//
// El conflicto ALTO es el clásico de compras: quien da de alta al proveedor
// —y con él su CLABE— no debe ser quien aprueba las facturas que se le pagan,
// porque juntas las dos facultades bastan para desviar dinero sin cómplice.
// ============================================================
interface SoDRule {
  name: string;
  conflicting_permissions: [Permission[], Permission[]];
  severity: 'high' | 'medium' | 'low';
}

const SOD_RULES: SoDRule[] = [
  {
    // `bills:create` es el permiso que guarda POST/PATCH /v1/vendors: quien
    // lo tiene da de alta al proveedor y sus datos bancarios.
    name: 'Vendor Setup vs Payment Approval',
    conflicting_permissions: [
      ['bills:create'],
      ['bills:approve'],
    ],
    severity: 'high',
  },
  {
    name: 'Entry Creation vs Posting',
    conflicting_permissions: [
      ['journal_entries:create'],
      ['journal_entries:post'],
    ],
    severity: 'medium',
  },
  {
    name: 'Period Close vs Reopen',
    conflicting_permissions: [
      ['periods:close'],
      ['periods:reopen'],
    ],
    severity: 'low',
  },
];

export function checkSoDViolations(permissions: string[]): Array<{ rule: string; severity: string }> {
  const violations: Array<{ rule: string; severity: string }> = [];

  for (const rule of SOD_RULES) {
    // `hasPermission` y no `includes`: el comodín del owner autoriza verbos,
    // y lo que autoriza, acumula.
    const hasGroup1 = rule.conflicting_permissions[0].some((p) => hasPermission(permissions, p));
    const hasGroup2 = rule.conflicting_permissions[1].some((p) => hasPermission(permissions, p));

    if (hasGroup1 && hasGroup2) {
      violations.push({ rule: rule.name, severity: rule.severity });
    }
  }

  return violations;
}
