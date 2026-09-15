import { createHash } from 'node:crypto';

// ============================================================
// BROWSER SESSIONS, IN MEMORY
//
// A session exists only after the IdP's access token has been verified. The
// cookie carries 32 random bytes; the map is keyed by their SHA-256, so a
// heap dump or a log line correlating sessions never holds a usable cookie.
//
// A record keeps what the proxy needs and nothing else: the access token, the
// refresh token, when each clock runs out. No ID token, no email, no subject,
// no claims. Logs correlate by the first eight hex characters of the key.
//
// Limits are enforced here, not trusted to the cookie's Max-Age: idle and
// absolute lifetimes, and a cap. At the cap the store sweeps expired entries
// and, if still full, refuses the NEW session. It never evicts a live one: an
// eviction policy lets anyone with a login sign everyone else out.
//
// In memory means a restart signs everyone out and only one instance is
// supported. That is declared (.env.example), not detected.
// ============================================================

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms: the `exp` of the verified access token. */
  accessExpiresAt: number;
  /** Epoch ms. The absolute lifetime counts from here; a refresh never moves it. */
  createdAt: number;
  /** Epoch ms of the last request the session authorised. */
  lastSeenAt: number;
  /** The refresh in flight, shared by concurrent requests of this session. */
  refreshing?: Promise<boolean>;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: number;
}

export interface SessionLimits {
  idleMs: number;
  absoluteMs: number;
  max: number;
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

  /**
   * A new session for verified tokens: the cookie value to set, or undefined
   * when the store is full of live sessions.
   */
  create(tokens: SessionTokens): { cookieValue: string; key: string } | undefined {
    if (this.entries.size >= this.limits.max) this.sweep();
    if (this.entries.size >= this.limits.max) return undefined;
    const now = this.clock();
    const cookieValue = this.newId();
    const key = sessionKey(cookieValue);
    this.entries.set(key, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
      createdAt: now,
      lastSeenAt: now,
    });
    return { cookieValue, key };
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

  /** Replaces the tokens after a verified refresh. createdAt stays, so the absolute lifetime does too. */
  replaceTokens(key: string, tokens: SessionTokens): boolean {
    const record = this.entries.get(key);
    if (!record) return false;
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
