import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SessionStore, sessionKey } from '../../src/gateway/session-store.js';

// ============================================================
// W0 · the in-memory session store.
//
// Keys are hashes of the cookie, never the cookie; a full store refuses the
// newcomer instead of evicting someone who is signed in; expiry is enforced
// by the store and not left to the cookie's Max-Age.
// ============================================================

const tokens = { accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: 0 };

function storeWith(max: number, now: { value: number }, idleMinutes = 30, absoluteHours = 8) {
  let n = 0;
  return new SessionStore(
    { idleMs: idleMinutes * 60_000, absoluteMs: absoluteHours * 3_600_000, max },
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
    const a = store.create(tokens)!;
    now.value += 31 * 60_000;
    const b = store.create(tokens)!;
    // `a` is idle-expired: the sweep makes room for `c`.
    const c = store.create(tokens);
    expect(c).toBeDefined();
    expect(store.find(a.cookieValue)).toBeUndefined();
    // Now both live: the next one is refused and nobody is signed out.
    expect(store.create(tokens)).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.find(b.cookieValue)).toBeDefined();
    expect(store.find(c!.cookieValue)).toBeDefined();
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
        store.replaceTokens(found!.key, { accessToken: 'new', accessExpiresAt: now.value + 600_000 });
      } else {
        // 75 minutes after creation: past the one-hour absolute lifetime.
        expect(found).toBeUndefined();
      }
    }
    expect(store.size).toBe(0);
  });

  it('a replaced token keeps the stored refresh token when the IdP does not rotate it', () => {
    const store = storeWith(10, { value: 0 });
    const s = store.create(tokens)!;
    store.replaceTokens(s.key, { accessToken: 'new', accessExpiresAt: 1 });
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
    expect(members).toEqual(['accessToken', 'refreshToken', 'accessExpiresAt', 'createdAt', 'lastSeenAt', 'refreshing']);
    const s = storeWith(10, { value: 0 }).create(tokens);
    expect(s).toBeDefined();
  });
});
