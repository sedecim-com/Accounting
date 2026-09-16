// ============================================================
// THE TWO COOKIES, AND WHY EACH ATTRIBUTE IS THERE
//
// The session cookie is the first ambient authority this repository ships:
// the browser attaches it by itself. Every attribute narrows who can make the
// browser do that.
//
//   · `__Host-` makes the browser refuse the cookie unless it is Secure, has
//     Path=/ and no Domain, so a sibling subdomain cannot plant (toss) its own
//     session cookie over ours.
//   · HttpOnly keeps it out of reach of script, so an injected string cannot
//     read it.
//   · SameSite=Strict keeps it off every cross-site request, navigations
//     included. The SPA shell is public and needs no cookie on the first
//     navigation after the IdP redirect; its fetches are same-origin.
//
// The login cookie carries the sealed PKCE transaction across the IdP round
// trip, which IS a cross-site navigation back to us: it has to be Lax, and it
// lives ten minutes at most.
// ============================================================

export const SESSION_COOKIE = '__Host-mnemosine_session';
export const LOGIN_COOKIE = '__Host-mnemosine_login';

const SESSION_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';
const LOGIN_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600';

/** Seconds the login transaction may take, the same as the login cookie's Max-Age. */
export const LOGIN_TRANSACTION_SECONDS = 600;

/**
 * Reads the Cookie header by hand. When a name repeats, the first value wins
 * and later ones are ignored: with the `__Host-` prefix a second value can
 * only come from this origin.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** Only base64url survives into a cookie value: nothing a client wrote can inject an attribute. */
function assertCookieValue(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('cookie value is not base64url');
  return value;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${assertCookieValue(value)}; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`;
}

export function loginCookie(value: string): string {
  return `${LOGIN_COOKIE}=${assertCookieValue(value)}; ${LOGIN_COOKIE_ATTRIBUTES}`;
}

export function clearLoginCookie(): string {
  return `${LOGIN_COOKIE}=; ${LOGIN_COOKIE_ATTRIBUTES.replace('Max-Age=600', 'Max-Age=0')}`;
}
