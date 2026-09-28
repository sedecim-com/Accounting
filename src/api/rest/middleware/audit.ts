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
//
// SECURITY: A NAME IS MATCHED BY WHAT IT SAYS, NOT BY HOW IT IS SPELLED.
//
// A field used to be redacted only when its lowercased name was exactly one
// on the list. The integration adapters read camelCase names, so a successful
// `PUT /v1/admin/integrations/:provider` wrote Stripe's `secretKey`,
// Conekta's `privateKey`, Edicom's `clientSecret` and the `webhookSecret` of
// both payment adapters to audit_log in clear. Now a name is compared without
// case, accents or separators, and it is redacted when
//   - it CONTAINS a stem that means a secret by itself: `clientSecret` falls
//     under `secret`, `accessKeyId` under `access_key`;
//   - it ENDS in `key` or `bank_account`: `signingkey` is redacted, and
//     `bank_account_id`, the account a bill points at, is not;
//   - one of its WORDS is a stem too short to trust inside another word:
//     `ssn_encrypted` and `keyFile` are redacted, and `business_name` is not,
//     although it holds "ssn"; nor is the SAT certificate number an invoice
//     sends, whose field name holds "cer".
//
// Redacted on purpose although not secret: `publishableKey`, `publicKey` and
// `apiKeyEnv`, the name of a variable. Carving them out of `key` and
// `api_key` is the kind of exception a real secret slips through, and the
// trail loses nothing it needs. Kept on purpose: `environment`, `region`,
// `bucket`, `username` and `clientId`. None is a credential by itself, and
// they tell an auditor which account and which environment were attached.
// tests/api/middleware/audit-redaction-credentials.spec.ts pins both lists
// for every adapter the registry exposes.
//
// The rule reads names, not values: a secret sent under a name with no stem
// still reaches the table. Rows written before this change stay as they
// are; 033 leaves any purge to a migration that records itself.
// ============================================================

/**
 * A field name in the two forms the stems are compared with: `joined` has no
 * case, accents or separators, so `secret_access_key`, `secretAccessKey` and
 * `SECRET-ACCESS-KEY` are one name; `words` splits it at separators and at
 * camelCase humps, so `keyFile` is `key` and `file`.
 */
function nameForms(name: string): { joined: string; words: string[] } {
  const words = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return { joined: words.join(''), words };
}

// Stems are written the way a field would be and pass through nameForms(),
// so an underscore in one can never make it unmatchable.
const INSIDE = [
  'secret', 'password', 'passwd', 'passphrase', 'contrasena', 'token',
  'api_key', 'private_key', 'access_key',
  'clabe', 'curp', 'account_number', 'routing_number', 'card_number',
].map((stem) => nameForms(stem).joined);

const AT_END = ['key', 'bank_account'].map((stem) => nameForms(stem).joined);

const WHOLE_WORD = ['key', 'cer', 'ssn', 'nss', 'cvv'];

function isSensitive(name: string): boolean {
  const { joined, words } = nameForms(name);
  return (
    INSIDE.some((stem) => joined.includes(stem)) ||
    AT_END.some((stem) => joined.endsWith(stem)) ||
    words.some((word) => WHOLE_WORD.includes(word))
  );
}

/** Copia el cuerpo con los campos sensibles sustituidos, a cualquier profundidad. */
export function redactarSensibles(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redactarSensibles);
  if (valor === null || typeof valor !== 'object') return valor;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    out[k] = isSensitive(k) ? '[REDACTADO]' : redactarSensibles(v);
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
    const data = (body).data as Record<string, unknown>;
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
