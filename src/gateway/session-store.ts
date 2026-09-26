import { createHash } from 'node:crypto';

// ============================================================
// BROWSER SESSIONS, IN MEMORY
//
// A session exists only after the IdP's access token has been verified. The
// cookie carries 32 random bytes; the map is keyed by their SHA-256, so a
// heap dump or a log line correlating sessions never holds a usable cookie.
//
// A record keeps what the proxy needs and nothing else: the access token, the
// refresh token, when each clock runs out, and the principal: a SHA-256 of
// the verified issuer and subject, never the claim itself. No ID token, no
// email, no subject, no claims. Logs correlate by the first eight hex
// characters of the key.
//
// Limits are enforced here, not trusted to the cookie's Max-Age: idle and
// absolute lifetimes, a cap per principal and a cap for the store.
//   · One principal holds at most SESSIONS_PER_PRINCIPAL live sessions. Past
//     that, its OWN oldest session gives way: a person with six browsers loses
//     the first, and nobody else is ever signed out. Without this bound one IdP
//     account, scripted through the SSO it already holds, fills the store and
//     locks every other user out for the absolute lifetime.
//   · At the store's cap it sweeps expired entries and, if still full, refuses
//     the NEW session. It never evicts someone else's live one: an eviction
//     policy lets anyone with a login sign everyone else out.
// What remains is the store's cap divided by the per-principal bound: that
// many distinct IdP accounts can still fill it. Who may hold an account is
// the IdP's control; the gateway accepts that residue rather than solving it.
//
// In memory means a restart signs everyone out and only one instance is
// supported. That is declared (.env.example), not detected.
// ============================================================

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms: the `exp` of the verified access token. */
  accessExpiresAt: number;
  /** sessionPrincipal(issuer, subject) of the verified token: who holds the session, as a hash. */
  principal: string;
  /** Epoch ms. The absolute lifetime counts from here; a refresh never moves it. */
  createdAt: number;
  /** Epoch ms of the last request the session authorised. */
  lastSeenAt: number;
  /** The refresh in flight, shared by concurrent requests of this session. */
  refreshing?: Promise<RefreshOutcome>;
}

/**
 * How a refresh ended: new tokens stored, refused by the IdP (the session
 * ends), or not decided because the IdP could not answer (the session stays).
 * See request-guards.ts.
 */
export type RefreshOutcome = 'refreshed' | 'refused' | 'unavailable';

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: number;
  principal: string;
}

export interface SessionLimits {
  idleMs: number;
  absoluteMs: number;
  max: number;
  perPrincipal: number;
}

/** Live sessions one principal may hold at once. Not configured: a person needs a handful of browsers, not a store. */
export const SESSIONS_PER_PRINCIPAL = 5;

/** Who a verified token names, as a hash: issuer and subject, unambiguously joined. */
export function sessionPrincipal(issuer: string, subject: string): string {
  return createHash('sha256').update(JSON.stringify([issuer, subject]), 'utf8').digest('hex');
}

export function sessionKey(cookieValue: string): string {
  return createHash('sha256').update(cookieValue, 'utf8').digest('hex');
}

/** What a log may say about a session. */
export function sessionTag(key: string): string {
  return key.slice(0, 8);
}

export class SessionStore {
  private readonly entries = new Map<string, SessionRecord>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    private readonly limits: SessionLimits,
    private readonly clock: () => number,
    private readonly newId: () => string
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private expired(record: SessionRecord, now: number): boolean {
    return now - record.lastSeenAt >= this.limits.idleMs || now - record.createdAt >= this.limits.absoluteMs;
  }

  /** Removes every expired entry; returns how many went. */
  sweep(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, record] of this.entries) {
      if (this.expired(record, now)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** True when the principal still holds a live session. */
  hasLive(principal: string): boolean {
    const now = this.clock();
    for (const record of this.entries.values()) {
      if (record.principal === principal && !this.expired(record, now)) return true;
    }
    return false;
  }

  /**
   * A new session for verified tokens: the cookie value to set and the
   * principal's own sessions that gave way to it (oldest first), or undefined
   * when the store is full of other people's live sessions.
   */
  create(tokens: SessionTokens): { cookieValue: string; key: string; displaced: SessionRecord[] } | undefined {
    const now = this.clock();
    const own = [...this.entries]
      .filter(([, record]) => record.principal === tokens.principal && !this.expired(record, now))
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
    const displaced: SessionRecord[] = [];
    for (const [key, record] of own.slice(0, Math.max(0, own.length - this.limits.perPrincipal + 1))) {
      this.entries.delete(key);
      displaced.push(record);
    }
    if (this.entries.size >= this.limits.max) this.sweep();
    if (this.entries.size >= this.limits.max) return undefined;
    const cookieValue = this.newId();
    const key = sessionKey(cookieValue);
    this.entries.set(key, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
      principal: tokens.principal,
      createdAt: now,
      lastSeenAt: now,
    });
    return { cookieValue, key, displaced };
  }

  /** The live record for a cookie value. An expired one is destroyed on sight. */
  find(cookieValue: string | undefined): { key: string; record: SessionRecord } | undefined {
    if (!cookieValue) return undefined;
    const key = sessionKey(cookieValue);
    const record = this.entries.get(key);
    if (!record) return undefined;
    if (this.expired(record, this.clock())) {
      this.entries.delete(key);
      return undefined;
    }
    return { key, record };
  }

  touch(key: string): void {
    const record = this.entries.get(key);
    if (record) record.lastSeenAt = this.clock();
  }

  /**
   * Replaces the tokens after a verified refresh. createdAt stays, so the
   * absolute lifetime does too. A refresh that names another principal
   * replaces nothing: the session belongs to whoever signed in.
   *
   * Nor does a refresh that lands after the session ended (WIT-01, #249). The
   * refresh is an await: a session alive when it started can cross its idle
   * or absolute limit before the IdP answers, and storing the new tokens then
   * would hand an ended session a fresh credential. It is destroyed instead.
   */
  replaceTokens(key: string, tokens: SessionTokens): boolean {
    const record = this.entries.get(key);
    if (!record || record.principal !== tokens.principal) return false;
    if (this.expired(record, this.clock())) {
      this.entries.delete(key);
      return false;
    }
    record.accessToken = tokens.accessToken;
    record.refreshToken = tokens.refreshToken ?? record.refreshToken;
    record.accessExpiresAt = tokens.accessExpiresAt;
    return true;
  }

  destroy(key: string): SessionRecord | undefined {
    const record = this.entries.get(key);
    this.entries.delete(key);
    return record;
  }

  /** When the absolute lifetime of a session ends, epoch ms. */
  absoluteEndOf(record: SessionRecord): number {
    return record.createdAt + this.limits.absoluteMs;
  }

  /** Starts the periodic sweep. The timer is unref'd: it never keeps the process alive. */
  startSweeper(intervalMs = 60_000): NodeJS.Timeout {
    this.stopSweeper();
    const timer = setInterval(() => {
      this.sweep();
    }, intervalMs);
    timer.unref();
    this.sweeper = timer;
    return timer;
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}
