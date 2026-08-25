import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../database/connection.js';
import type { JwtPayload } from '../types/index.js';
import type { VerifiedIdentity } from './oidc.js';

// ============================================================
// JIT PROVISIONING
//
// The IdP says WHO you are; this layer translates that into WHAT YOU
// CAN TOUCH by reading it from `users`. The separation is not purism:
//   · journal_entries.created_by points at users: the audit trail
//     has to resolve to a local record, not to a third party's
//     'sub' that may no longer exist.
//   · Granting access to a client's accounting is domain
//     authorization. An IdP administrator should not be able to
//     grant it by editing a group, with no trace in the accounting
//     system.
//
// That is why the first login creates the user WITHOUT access to any
// entity. An administrator grants it afterwards, and that is audited.
// ============================================================

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  roles: string[];
  permissions: string[];
  accessible_entities: string[];
  is_active: boolean;
}

export class NoAccessError extends Error {
  constructor(email: string) {
    super(
      `User ${email} is authenticated but has no access to any entity. ` +
        'An administrator must grant them access (users.accessible_entities).'
    );
    this.name = 'NoAccessError';
  }
}

/**
 * Resolves the verified identity to a local user, creating it on first
 * login. `defaultTenantId` is which tenant whoever comes in through this
 * issuer belongs to — configured per deployment, not decided by the token.
 */
export async function resolveIdentity(
  identity: VerifiedIdentity,
  opts: { provider: string; defaultTenantId: string }
): Promise<JwtPayload> {
  const found = await query<UserRow & { identity_id: string }>(
    `SELECT u.id, u.tenant_id, u.email, u.roles, u.permissions,
            u.accessible_entities, u.is_active, i.id AS identity_id
     FROM identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.provider = $1 AND i.subject = $2`,
    [opts.provider, identity.subject]
  );

  let user: UserRow;
  if (found.rows.length > 0) {
    user = found.rows[0];
    if (!user.is_active) {
      throw new Error(`The account ${user.email} is deactivated`);
    }
    await query(
      `UPDATE identities SET last_login_at = NOW(), email = COALESCE($1, email),
              email_verified = $2 WHERE id = $3`,
      [identity.email ?? null, identity.emailVerified, found.rows[0].identity_id]
    );
  } else {
    user = await provision(identity, opts);
  }

  // With no accessible entities there is nothing to do: fail with a message
  // that says what is missing, instead of leaving a session that cannot read anything.
  const entities = normalizeJsonArray(user.accessible_entities);
  if (entities.length === 0) {
    throw new NoAccessError(user.email);
  }

  const sessionId = await openSession(user.id, user.tenant_id, identity.expiresAt);

  return {
    user_id: user.id,
    tenant_id: user.tenant_id,
    email: user.email,
    roles: normalizeJsonArray(user.roles),
    permissions: normalizeJsonArray(user.permissions),
    entities,
    session_id: sessionId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(identity.expiresAt / 1000),
  };
}

/** First login: creates the user without access and links the identity. */
async function provision(
  identity: VerifiedIdentity,
  opts: { provider: string; defaultTenantId: string }
): Promise<UserRow> {
  if (!identity.email) {
    throw new Error('The provider did not send an email: the user cannot be created');
  }
  return withTransaction(async (client) => {
    // A user with that email may already exist (created by hand or via another
    // provider): the identity is linked instead of duplicating the person.
    const existing = await client.query<UserRow>(
      `SELECT id, tenant_id, email, roles, permissions, accessible_entities, is_active
       FROM users WHERE tenant_id = $1 AND email = $2`,
      [opts.defaultTenantId, identity.email]
    );

    let user: UserRow;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
    } else {
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (id, tenant_id, email, password_hash, roles, permissions, accessible_entities)
         VALUES ($1, $2, $3, '', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
         RETURNING id, tenant_id, email, roles, permissions, accessible_entities, is_active`,
        [uuidv4(), opts.defaultTenantId, identity.email]
      );
      user = inserted.rows[0];
    }

    await client.query(
      `INSERT INTO identities (id, user_id, provider, subject, issuer, email, email_verified, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (provider, subject) DO UPDATE SET last_login_at = NOW()`,
      [uuidv4(), user.id, opts.provider, identity.subject, identity.issuer,
       identity.email, identity.emailVerified]
    );

    return user;
  });
}

async function openSession(userId: string, tenantId: string, expiresAt: number): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO sessions (id, user_id, tenant_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, '', to_timestamp($4))`,
    [id, userId, tenantId, Math.floor(expiresAt / 1000)]
  );
  return id;
}

/** pg returns jsonb already parsed, but a text column would arrive as a string. */
function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}
