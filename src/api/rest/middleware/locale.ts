import type { NextFunction, Request, Response } from 'express';
import type { Language } from '../../../i18n/index.js';
import { DEFAULT_LOCALE, LOCALES, languageOfLocale, normalizeLocale, type Locale } from '../../../i18n/locale.js';

// ============================================================
// THE LANGUAGE A REQUEST ASKS FOR (I9 · issue #151)
//
// Decided in the issue before the code (decision d): in this first slice the
// language is negotiated ONLY from `Accept-Language`, and a request without it
// gets `DEFAULT_LOCALE`, the product's default. The language of the entity in
// context reaches REST later, on its own path (#656): nothing here reads it
// today, and like the tenant context it is known only after `authenticate`, so
// a 401 could not know it anyway.
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
  /**
   * Whether the request NAMED that language itself, rather than getting it as
   * the default: false with no header, with `*`, and with only unsupported
   * languages. Recorded as `res.locals.languageRequested` (MNE-001-152).
   */
  readonly requested: boolean;
}

/**
 * The tags offered to `req.acceptsLanguages`: the default first, then the other
 * locales, then their languages, so the specific tags come before the short
 * ones. Express matches `es-AR` to `es` and `en-GB` to `en`, and
 * `normalizeLocale` maps every tag back to a supported locale.
 *
 * `Accept-Language: *` resolves to the FIRST tag. That is why the list is built
 * from the default and never written by hand: a literal list keeps answering
 * the old default the day `DEFAULT_LOCALE` moves. E0.0
 * `user-language-has-one-door` refuses a tag literal anywhere in this file.
 */
export function offeredTagsFor(defaultLocale: Locale, locales: readonly Locale[] = LOCALES): readonly string[] {
  const ordered = [defaultLocale, ...locales.filter((l) => l !== defaultLocale)];
  return [...ordered, ...ordered.map(languageOfLocale)];
}

const OFFERED_TAGS = offeredTagsFor(DEFAULT_LOCALE);

/**
 * Whether `header` names `language` in a range of its own: not the wildcard,
 * and not refused with `q=0`. `es-AR` names `es`, as Express matches it.
 */
function headerNames(header: string, language: Language): boolean {
  return header.split(',').some((range) => {
    const [tag = '', ...params] = range.split(';');
    if (tag.trim().toLowerCase().split('-')[0] !== language) return false;
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

export function negotiatedLocaleOf(req: Pick<Request, 'acceptsLanguages' | 'headers'>): NegotiatedLocale {
  const header = req.headers['accept-language'];
  // An absent header gets the default by rule, not through the list above:
  // Express would answer its first tag, which is the default only because
  // `offeredTagsFor` puts it there.
  const match = header === undefined || header === '' ? false : req.acceptsLanguages(...OFFERED_TAGS);
  const locale = (typeof match === 'string' ? normalizeLocale(match) : null) ?? DEFAULT_LOCALE;
  const language = languageOfLocale(locale);
  // `*` matches too, and answers the first tag: a match alone does not say the
  // request asked for this language.
  const requested = typeof match === 'string' && header !== undefined && headerNames(header, language);
  return { locale, language, requested };
}

export function negotiateLocale(req: Request, res: Response, next: NextFunction): void {
  const negotiated = negotiatedLocaleOf(req);
  res.locals.locale = negotiated.locale;
  res.locals.language = negotiated.language;
  res.locals.languageRequested = negotiated.requested;
  next();
}

/**
 * THE ONE EXCEPTION TO `DEFAULT_LOCALE` (MNE-001-152, #151): a response whose
 * request named no supported language answers in `language` instead of the
 * default. Only the 422 of `validateBody` and `validateQuery` calls it, with
 * English, right before it hands its error on: the owner's words on #367,
 * «preserva el contrato de los 422», keep the English of that response for
 * every caller that did not ask for another language. A request that named
 * one keeps it. The error handler then renders and declares the language
 * recorded here, so `Content-Language`, `meta.language` and the text agree,
 * and it needs no rule of its own for this response.
 *
 * Without `negotiateLocale` in front (a harness, or a request rejected before
 * it) nothing was named either, so the same holds. A response object with no
 * `res.locals` at all is left alone.
 */
export function answerUnrequestedIn(res: Response, language: Language): void {
  const locals = res.locals as Record<string, unknown> | undefined;
  if (locals === undefined || locals.languageRequested === true) return;
  const locale = LOCALES.find((l) => languageOfLocale(l) === language);
  if (locale === undefined) return;
  locals.locale = locale;
  locals.language = language;
}

/** The negotiated locale of a response, or the default when the middleware did not run. */
export function responseLocale(res: Response): Locale {
  return normalizeLocale(res.locals.locale as string | undefined) ?? DEFAULT_LOCALE;
}

/** The negotiated language of a response, or the default when the middleware did not run. */
export function responseLanguage(res: Response): Language {
  return languageOfLocale(responseLocale(res));
}
