import { t, type Language, type TranslationKey } from './index.js';

// The caller names the language, and there is no default on purpose (#654).
// `t()` falls back to `getLanguage()`, the PROCESS language: on the REST edge
// that is the server's, which ignores what the request negotiated. The CLI
// passes `getLanguage()`, which it pinned at start-up; the API passes
// `responseLanguage(res)`. A required argument also makes `tsc` refuse
// `.map(withCashFindingMessage)`, which would hand the index in its place.

/** The shape `cashLimitFinding` returns: a catalog key and its parameters, never prose. */
interface CashFindingText {
  messageKey: string;
  messageParams: Record<string, string>;
  noteKey?: string;
  noteParams?: Record<string, string>;
}

/** The LISR 27-III signal as a sentence in `language`, the note included. */
export function cashFindingMessage(f: CashFindingText, language: Language): string {
  return t(f.messageKey as TranslationKey, f.messageParams, language) +
    (f.noteKey ? ' ' + t(f.noteKey as TranslationKey, f.noteParams, language) : '');
}

/** The finding as the CLI and the API publish it: the structured fields plus `message` in `language`. */
export function withCashFindingMessage<F extends CashFindingText>(f: F, language: Language): F & { message: string } {
  return { ...f, message: cashFindingMessage(f, language) };
}
