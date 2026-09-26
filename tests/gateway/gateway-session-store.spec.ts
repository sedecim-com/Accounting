import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SESSIONS_PER_PRINCIPAL, SessionStore, sessionKey, sessionPrincipal } from '../../src/gateway/session-store.js';

// ============================================================
// W0 · the in-memory session store.
//
// Keys are hashes of the cookie, never the cookie; a full store refuses the
// newcomer instead of evicting someone who is signed in; expiry is enforced
// by the store and not left to the cookie's Max-Age.
// ============================================================

const principal = sessionPrincipal('https://idp.test', 'user-1');
const tokens = { accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: 0, principal };

function tokensOf(subject: string, accessToken = `access-${subject}`) {
  return { accessToken, refreshToken: `refresh-${subject}`, accessExpiresAt: 0, principal: sessionPrincipal('https://idp.test', subject) };
}

function storeWith(max: number, now: { value: number }, idleMinutes = 30, absoluteHours = 8, perPrincipal = SESSIONS_PER_PRINCIPAL) {
  let n = 0;
  return new SessionStore(
    { idleMs: idleMinutes * 60_000, absoluteMs: absoluteHours * 3_600_000, max, perPrincipal },
    () => now.value,
    () => `cookie-value-${(n += 1)}`
  );
}

describe('SessionStore', () => {
  it('keys the map by the SHA-256 hex of the cookie value, never by the value', () => {
    const store = storeWith(10, { value: 0 });
    const created = store.create(tokens)!;
    expect(created.key).toBe(createHash('sha256').update(created.cookieValue).digest('hex'));
    expect(created.key).toBe(sessionKey(created.cookieValue));
    const keys = [...(store as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toEqual([created.key]);
    expect(keys).not.toContain(created.cookieValue);
    expect(store.find(created.cookieValue)?.key).toBe(created.key);
    expect(store.find(created.key)).toBeUndefined();
  });

  it('at capacity it sweeps expired entries first, then refuses the new session without evicting a live one', () => {
    const now = { value: 0 };
    const store = storeWith(2, now);
    const a = store.create(tokensOf('a'))!;
    now.value += 31 * 60_000;
    const b = store.create(tokensOf('b'))!;
    // `a` is idle-expired: the sweep makes room for `c`.
    const c = store.create(tokensOf('c'));
    expect(c).toBeDefined();
    expect(store.find(a.cookieValue)).toBeUndefined();
    // Now both live: the next one is refused and nobody is signed out.
    expect(store.create(tokensOf('d'))).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.find(b.cookieValue)).toBeDefined();
    expect(store.find(c!.cookieValue)).toBeDefined();
  });

  it('one principal cannot fill the store: past its own bound its oldest session gives way, and nobody else is signed out', () => {
    const now = { value: 0 };
    const store = storeWith(4, now, 30, 8, 2);
    const other = store.create(tokensOf('other'))!;
    const held: Array<{ cookieValue: string; displaced: unknown[] }> = [];
    for (let i = 0; i < 5; i += 1) {
      now.value += 1_000;
      const created = store.create(tokensOf('greedy', `access-greedy-${i}`));
      expect(created, `sign-in ${i + 1} of the same principal`).toBeDefined();
      held.push(created!);
    }
    // Two live sessions for the greedy principal, the newest two; the one slot
    // left in the store is still free for a third principal.
    expect(store.size).toBe(3);
    expect(held.map((s) => store.find(s.cookieValue) !== undefined)).toEqual([false, false, false, true, true]);
    expect(held[2].displaced).toEqual([expect.objectContaining({ accessToken: 'access-greedy-0' })]);
    expect(store.find(other.cookieValue)).toBeDefined();
    expect(store.hasLive(sessionPrincipal('https://idp.test', 'greedy'))).toBe(true);
    expect(store.create(tokensOf('newcomer'))).toBeDefined();
  });

  it('the principal is a hash of issuer and subject, never the claim, and cannot be confused across issuers', () => {
    const p = sessionPrincipal('https://idp.test', 'user-1');
    expect(p).toMatch(/^[0-9a-f]{64}$/);
    expect(p).not.toContain('user-1');
    expect(sessionPrincipal('https://idp.test/', 'user-1')).not.toBe(p);
    expect(sessionPrincipal('https://idp.tes', 'tuser-1')).not.toBe(p);
  });

  it('a refresh that names another principal does not replace the tokens', () => {
    const store = storeWith(10, { value: 0 });
    const s = store.create(tokensOf('user-1'))!;
    expect(store.replaceTokens(s.key, tokensOf('user-2', 'swapped'))).toBe(false);
    expect(store.find(s.cookieValue)?.record.accessToken).toBe('access-user-1');
  });

  it('idle and absolute expiry are the store’s, and a replaced token does not move the absolute end', () => {
    const now = { value: 0 };
    const store = storeWith(10, now, 30, 1);
    const s = store.create(tokens)!;
    for (let i = 0; i < 3; i += 1) {
      now.value += 25 * 60_000 - 1;
      const found = store.find(s.cookieValue);
      if (i < 2) {
        expect(found).toBeDefined();
        store.touch(found!.key);
        store.replaceTokens(found!.key, { accessToken: 'new', accessExpiresAt: now.value + 600_000, principal });
      } else {
        // 75 minutes after creation: past the one-hour absolute lifetime.
        expect(found).toBeUndefined();
      }
    }
    expect(store.size).toBe(0);
  });

  // WIT-01 (#249): a refresh is an await, and a session alive when it started
  // can cross its idle or absolute limit before the tokens come back. Storing
  // them then would hand an ended session a fresh access token.
  it.each([
    ['absolute', 30, 1, 3_600_000],
    ['idle', 5, 8, 5 * 60_000],
  ])('tokens that arrive after the %s limit replace nothing, and the ended session is gone', (limit, idle, absolute, limitMs) => {
    const now = { value: 0 };
    const store = storeWith(10, now, idle, absolute);
    const s = store.create(tokens)!;
    if (limit === 'absolute') {
      // Keep it active so only the absolute lifetime can end it.
      for (let t = 20 * 60_000; t < limitMs; t += 20 * 60_000) {
        now.value = t;
        store.touch(store.find(s.cookieValue)!.key);
      }
    }
    now.value = limitMs - 1_000;
    expect(store.find(s.cookieValue)).toBeDefined();
    now.value = limitMs + 1_000;
    expect(store.replaceTokens(s.key, { accessToken: 'late', accessExpiresAt: now.value + 600_000, principal })).toBe(false);
    expect(store.size).toBe(0);
    store.touch(s.key);
    expect(store.find(s.cookieValue)).toBeUndefined();
  });

  it('tokens that arrive before either limit still replace the old ones (control)', () => {
    const now = { value: 0 };
    const store = storeWith(10, now, 5, 1);
    const s = store.create(tokens)!;
    now.value = 5 * 60_000 - 1_000;
    expect(store.replaceTokens(s.key, { accessToken: 'in-time', accessExpiresAt: now.value + 600_000, principal })).toBe(true);
    expect(store.find(s.cookieValue)?.record.accessToken).toBe('in-time');
  });

  it('a replaced token keeps the stored refresh token when the IdP does not rotate it', () => {
    const store = storeWith(10, { value: 0 });
    const s = store.create(tokens)!;
    store.replaceTokens(s.key, { accessToken: 'new', accessExpiresAt: 1, principal });
    expect(store.find(s.cookieValue)?.record).toMatchObject({ accessToken: 'new', refreshToken: 'refresh' });
  });

  it('the sweep timer never keeps the process alive', () => {
    const store = storeWith(10, { value: 0 });
    const timer = store.startSweeper(1000);
    expect(timer.hasRef()).toBe(false);
    store.stopSweeper();
  });

  it('the record type holds no ID token, email, subject or claims', () => {
    const file = path.join(__dirname, '..', '..', 'src', 'gateway', 'session-store.ts');
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const record = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'SessionRecord');
    const members = record!.members.map((m) => m.name?.getText(sf) ?? '');
    expect(members).toEqual(['accessToken', 'refreshToken', 'accessExpiresAt', 'principal', 'createdAt', 'lastSeenAt', 'refreshing']);
    const s = storeWith(10, { value: 0 }).create(tokens);
    expect(s).toBeDefined();
  });
});
