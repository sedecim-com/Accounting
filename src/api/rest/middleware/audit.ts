import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';

// ============================================================
// LA BITÁCORA NO GUARDA EN CLARO LO QUE LAS TABLAS CIFRAN (S1).
//
// Este middleware escribía `JSON.stringify(req.body)` entero en
// audit_log.new_values. Un alta de empleado dejaba `ssn` y `bank_account` en
// claro; un proveedor, su CLABE — mientras el servicio los cifraba en su
// tabla. Y es la peor tabla posible para esa fuga: la 033 la hizo
// append-only hasta para el dueño del esquema, así que no hay remediación.
//
// La lista es deliberadamente más ancha que lo que hoy se cifra: redactar de
// más cuesta un dato menos en el rastro; redactar de menos deja un secreto
// eterno. Un criterio del plan (E0.3) vigila que el stringify crudo no
// vuelva.
// ============================================================

const CAMPOS_SENSIBLES = [
  'ssn', 'curp', 'nss',
  'password', 'contrasena', 'secret', 'token', 'api_key', 'apikey',
  'key', 'cer', 'private_key',
  'clabe', 'bank_account', 'bank_account_number', 'account_number',
  'routing_number', 'card_number', 'cvv',
] as const;

const SENSIBLE = new Set<string>(CAMPOS_SENSIBLES);

/** Copia el cuerpo con los campos sensibles sustituidos, a cualquier profundidad. */
export function redactarSensibles(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redactarSensibles);
  if (valor === null || typeof valor !== 'object') return valor;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    out[k] = SENSIBLE.has(k.toLowerCase()) ? '[REDACTADO]' : redactarSensibles(v);
  }
  return out;
}

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
            JSON.stringify(redactarSensibles(req.body)),
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
