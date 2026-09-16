import type { NextFunction, Request, Response } from 'express';
import type { Language } from '../../../i18n/index.js';
import { DEFAULT_LOCALE, languageOfLocale, normalizeLocale, type Locale } from '../../../i18n/locale.js';

// ============================================================
// THE LANGUAGE A REQUEST ASKS FOR (I9 · issue #151)
//
// Decided in the issue before the code (decision d): in this first slice the
// language is negotiated ONLY from `Accept-Language`, and a request without it
// gets `es-MX`, the product's default. The tenant's own setting
// (`tenants.settings.locale`) comes later: no query reads that column today,
// and the tenant context is mounted after `authenticate`, so a 401 could not
// know it anyway.
//
// THIS MIDDLEWARE DECLARES NOTHING TO THE CLIENT. It only records the
// negotiated language on `res.locals`. The `Content-Language` header and
// `meta.language` are set by the error handler, and only when the message it
// renders really was written by catalog key. An earlier version set the header
// on every response, and measured against this very commit that was a lie
// almost everywhere: a 401 answered `Content-Language: es-MX` over an English
// message, and a reused idempotency key answered `en-US` over a Spanish one,
// because only `error.*` keys follow the negotiation and nearly every message
// is still prose.
// ============================================================

/** What the rest of the request pipeline reads: set on `res.locals` by `negotiateLocale`. */
export interface NegotiatedLocale {
  readonly locale: Locale;
  readonly language: Language;
}

/**
 * The tags offered to `req.acceptsLanguages`, most specific first. Express
 * matches `es-AR` to `es` and `en-GB` to `en`, and `normalizeLocale` maps each
 * of these four to one of the supported locales. `Accept-Language: *` resolves
 * to the FIRST tag of this list, so es-MX must stay first.
 */
const OFFERED_TAGS = ['es-MX', 'en-US', 'es', 'en'] as const;

export function negotiatedLocaleOf(req: Pick<Request, 'acceptsLanguages' | 'headers'>): NegotiatedLocale {
  const header = req.headers['accept-language'];
  // An absent header is the product default by rule, not by the order of the
  // list above: Express would answer the first offered tag, which is es-MX today
  // only because of that order.
  const match = header === undefined || header === '' ? false : req.acceptsLanguages(...OFFERED_TAGS);
  const locale = (typeof match === 'string' ? normalizeLocale(match) : null) ?? DEFAULT_LOCALE;
  return { locale, language: languageOfLocale(locale) };
}

export function negotiateLocale(req: Request, res: Response, next: NextFunction): void {
  const negotiated = negotiatedLocaleOf(req);
  res.locals.locale = negotiated.locale;
  res.locals.language = negotiated.language;
  next();
}

/** The negotiated locale of a response, or the default when the middleware did not run. */
export function responseLocale(res: Response): Locale {
  return normalizeLocale(res.locals.locale as string | undefined) ?? DEFAULT_LOCALE;
}

/** The negotiated language of a response, or the default when the middleware did not run. */
export function responseLanguage(res: Response): Language {
  return languageOfLocale(responseLocale(res));
}
