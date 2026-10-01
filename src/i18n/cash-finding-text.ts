import { t, type TranslationKey } from './index.js';

/** The shape `cashLimitFinding` returns: a catalog key and its parameters, never prose. */
interface CashFindingText {
  messageKey: string;
  messageParams: Record<string, string>;
  noteKey?: string;
  noteParams?: Record<string, string>;
}

/** The LISR 27-III signal as a sentence, in the language of whoever reads it (the edge). */
export function cashFindingMessage(f: CashFindingText): string {
  return t(f.messageKey as TranslationKey, f.messageParams) +
    (f.noteKey ? ' ' + t(f.noteKey as TranslationKey, f.noteParams) : '');
}

/** The finding as the CLI and the API publish it: the structured fields plus the rendered `message`. */
export function withCashFindingMessage<F extends CashFindingText>(f: F): F & { message: string } {
  return { ...f, message: cashFindingMessage(f) };
}
