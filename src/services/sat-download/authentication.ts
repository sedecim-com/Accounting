import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { query } from '../../database/connection.js';
import { config } from '../../config/index.js';
import { withCredential } from '../fiscal-credentials/service.js';
import { AUTENTICA_SOAP_ACTION, TIMESTAMP_LIFETIME_MS, buildSignedAutentica } from './ws-security.js';

// ============================================================
// EFIRMA-1 (#439) · AUTHENTICATION WITH THE SAT DESCARGA MASIVA SERVICE
//
// SECURITY: the e.firma is read ONLY through withCredential with purpose
// 'sat_auth'. That is what writes the fiscal_credential_access_log row
// (success, or error when the SAT refuses), and what applies the daily cap,
// the panel ceiling (Math.min) and efirma_accion_anomalia BEFORE fn runs, so
// a denied access never reaches the network.
//
// SECURITY: the token lives only in this process's memory, for no longer than
// the SAT says it is valid (and never past the 5 minutes of the signed
// Timestamp). It is never written to the database, a log line, an error
// message or disk. A cached token is dropped as soon as the credential that
// minted it stops being the entity's active one (revoked or replaced).
// ============================================================

export interface SatAuthContext {
  tenantId: string;
  entityId: string;
  actor: string;
  /** true = no human present (scheduler). Subject to the credential's policy. */
  unattended: boolean;
  requestId?: string;
}

export interface SatToken {
  /** Goes in `Authorization: WRAP access_token="<value>"` of later calls. */
  value: string;
  expiresAt: Date;
}

export interface SatAuthDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  url?: string;
}

export class SatAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatAuthenticationError';
  }
}

/** A token closer than this to its expiry is not handed out. */
const EXPIRY_MARGIN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface CachedToken extends SatToken {
  credentialId: string;
}

const tokenCache = new Map<string, CachedToken>();

export function clearSatTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(ctx: SatAuthContext): string {
  return `${ctx.tenantId}:${ctx.entityId}`;
}

async function activeCredentialId(ctx: SatAuthContext): Promise<string | undefined> {
  const r = await query<{ id: string }>(
    `SELECT id FROM fiscal_credentials
     WHERE entity_id = $1 AND tenant_id = $2 AND credential_type = 'efirma' AND status = 'active'`,
    [ctx.entityId, ctx.tenantId]
  );
  return r.rows[0]?.id;
}

const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

function child(node: unknown, name: string): unknown {
  return node && typeof node === 'object' ? (node as Record<string, unknown>)[name] : undefined;
}

function text(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  const inner = child(node, '#text');
  return typeof inner === 'string' ? inner : undefined;
}

/** Reads the token and its expiry; never echoes the token into an error. */
function parseAutenticaResponse(status: number, xml: string, now: Date): SatToken {
  let envelope: unknown;
  try {
    envelope = child(parser.parse(xml), 'Envelope');
  } catch {
    envelope = undefined;
  }
  const body = child(envelope, 'Body');
  const fault = text(child(child(body, 'Fault'), 'faultstring'));
  const value = text(child(child(body, 'AutenticaResponse'), 'AutenticaResult'))?.trim();
  if (status !== 200 || fault || !value) {
    // The fault text is the SAT's, not ours: data, cut short, never a token.
    const detail = fault ? `: ${fault.slice(0, 200)}` : '';
    throw new SatAuthenticationError(`The SAT refused the authentication (HTTP ${status})${detail}`);
  }
  const ceiling = now.getTime() + TIMESTAMP_LIFETIME_MS;
  const expires = text(child(child(child(child(envelope, 'Header'), 'Security'), 'Timestamp'), 'Expires'));
  const stated = expires ? Date.parse(expires) : NaN;
  return { value, expiresAt: new Date(Number.isFinite(stated) ? Math.min(stated, ceiling) : ceiling) };
}

/**
 * Returns a valid SAT token for the entity, signing a fresh `Autentica` with
 * its e.firma only when no cached one is still good.
 */
export async function authenticateWithSat(ctx: SatAuthContext, deps: SatAuthDeps = {}): Promise<SatToken> {
  const now = deps.now ?? (() => new Date());
  const key = cacheKey(ctx);
  const cached = tokenCache.get(key);
  if (cached) {
    const stillValid = cached.expiresAt.getTime() - EXPIRY_MARGIN_MS > now().getTime();
    if (stillValid && (await activeCredentialId(ctx)) === cached.credentialId) {
      return { value: cached.value, expiresAt: cached.expiresAt };
    }
    tokenCache.delete(key);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = deps.url ?? config.sat.descargaMasivaAuthUrl;
  let credentialId = '';
  const token = await withCredential(
    ctx.entityId,
    ctx.tenantId,
    { purpose: 'sat_auth', actor: ctx.actor, unattended: ctx.unattended, requestId: ctx.requestId },
    async (material, row) => {
      credentialId = row.id;
      const created = now();
      const envelope = buildSignedAutentica(material, { created, tokenId: `uuid-${randomUUID()}-1` });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: AUTENTICA_SOAP_ACTION },
        body: envelope,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return parseAutenticaResponse(res.status, await res.text(), created);
    }
  );
  tokenCache.set(key, { ...token, credentialId });
  return token;
}
