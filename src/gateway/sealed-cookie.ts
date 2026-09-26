import { createCipheriv, createDecipheriv } from 'node:crypto';

// ============================================================
// THE SEALED LOGIN TRANSACTION
//
// Between /auth/login and /auth/callback the gateway must remember the PKCE
// verifier and the state. Keeping them in server memory would let anyone
// allocate gateway state without credentials (an anonymous request per slot,
// until real users cannot sign in). So the transaction travels in a cookie,
// sealed with AES-256-GCM: the browser carries it and can neither read nor
// alter it.
//
// The key is 32 random bytes per process and is never configured. A restart
// invalidates logins in flight, which is the same thing a restart does to
// sessions, and there is no secret an operator could publish.
// ============================================================

const IV_BYTES = 12;
const TAG_BYTES = 16;

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Seals `payload` under `key`, bound to `aad` (the cookie name), as base64url. */
export function seal(key: Buffer, aad: string, payload: unknown, iv: Buffer): string {
  if (key.length !== 32) throw new Error('the sealing key must be 32 bytes');
  if (iv.length !== IV_BYTES) throw new Error('the IV must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return base64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** Opens a sealed value, or returns undefined for anything tampered, truncated or sealed elsewhere. */
export function open(key: Buffer, aad: string, sealed: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(sealed)) return undefined;
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const text = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
