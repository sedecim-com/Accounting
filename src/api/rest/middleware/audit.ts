import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';

export function auditLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  const requestId = uuidv4();
  req.headers['x-request-id'] = requestId;

  res.json = function (body: unknown) {
    // Only log mutations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && res.statusCode < 300) {
      const entityType = extractEntityType(req.path);
      const entityId = extractEntityId(req.path, body as Record<string, unknown>);

      if (entityType && req.user) {
        query(
          `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id,
           new_values, ip_address, user_agent, request_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            uuidv4(),
            req.user.user_id,
            req.user.tenant_id,
            methodToAction(req.method),
            entityType,
            entityId || uuidv4(),
            JSON.stringify(req.body),
            req.ip,
            req.get('user-agent'),
            requestId,
          ]
        ).catch((err) => console.error('Audit log error:', err));
      }
    }

    return originalJson(body);
  };

  next();
}

function extractEntityType(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  // Skip version prefix (v1)
  const resourceSegments = segments.filter((s) => s !== 'v1');
  return resourceSegments[0] || null;
}

function extractEntityId(path: string, body?: Record<string, unknown>): string | null {
  const segments = path.split('/').filter(Boolean);
  // Look for UUID pattern in path
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idSegment = segments.find((s) => uuidPattern.test(s));
  if (idSegment) return idSegment;

  // Try response body
  if (body && typeof body === 'object') {
    const data = (body as Record<string, unknown>).data as Record<string, unknown>;
    return (data?.id as string) || null;
  }

  return null;
}

function methodToAction(method: string): string {
  switch (method) {
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return 'update';
  }
}
