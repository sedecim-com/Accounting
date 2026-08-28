import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../../config/index.js';
import { UnauthorizedError, ForbiddenError } from '../../../utils/errors.js';
import { isAsymmetric, verifyIdpToken } from '../../../auth/oidc.js';
import { resolveIdentity, NoAccessError } from '../../../auth/provisioning.js';
import type { JwtPayload } from '../../../types/index.js';
import { ROLES as CATALOGO_DE_ROLES } from '../../../auth/roles.js';

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
  req.entityId = (req.headers['x-entity-id'] as string) || payload.entities[0];
}

function verifyLocal(token: string): JwtPayload {
  try {
    return jwt.verify(token, config.jwt.secret) as JwtPayload;
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

export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    // Wildcard admin
    if (req.user.permissions.includes('*')) {
      return next();
    }

    const missing = permissions.filter((p) => !req.user!.permissions.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenError('Insufficient permissions', {
        required: permissions,
        missing,
        current: req.user.permissions,
      });
    }

    next();
  };
}

export function requireEntityAccess(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  const entityId = req.entityId || req.params.entity_id || req.body?.entity_id;
  if (!entityId) {
    return next();
  }

  assertEntityAccess(req.user, entityId);
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

// Segregation of Duties rules
interface SoDRule {
  name: string;
  conflicting_permissions: [string[], string[]];
  severity: 'high' | 'medium' | 'low';
}

const SOD_RULES: SoDRule[] = [
  {
    name: 'Vendor Setup vs Payment Approval',
    conflicting_permissions: [
      ['vendors:create', 'vendors:update'],
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
    const hasGroup1 = rule.conflicting_permissions[0].some((p) => permissions.includes(p));
    const hasGroup2 = rule.conflicting_permissions[1].some((p) => permissions.includes(p));

    if (hasGroup1 && hasGroup2) {
      violations.push({ rule: rule.name, severity: rule.severity });
    }
  }

  return violations;
}
