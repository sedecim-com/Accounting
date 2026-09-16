import { t, type Language, type TranslationKey } from './index.js';

// ============================================================
// THE LABEL OF A REPORT SECTION (I11 · issue #153, second commit)
//
// WHY THIS LIVES AT THE EDGE AND NOT IN THE SERVICE. The issue asks for the
// six literals of `report-service.ts` to be translated there. Measured before
// writing this: no file under `src/services/` imports `src/i18n/`, and the two
// surfaces that would read it resolve the language in incompatible ways — the
// CLI pins it in a module global at start-up (`cli/mnemosine.ts`), while the
// API only ever puts it on `res.locals` (`api/rest/middleware/locale.ts`). A
// service that asked `getLanguage()` would answer every HTTP request in the
// PROCESS language and ignore `Accept-Language`, which is the exact defect I9
// has just closed for errors.
//
// So the service keeps coining its English `name`, the key it already carries
// since #253 is the identity, and every human surface renders the label from
// that key with the language it actually has. The agent renders nothing: it
// consumes `key` and its manual promises it.
//
// THERE ARE NINETEEN LABELS, NOT SIX. Six sections, and thirteen subsections
// that are not literals at all: `report-service.ts` builds them by prettifying
// the stored `fs_category` (`cat.replace(/_/g, ' ')…`), whose domain is the
// twelve values of migration 078's CHECK plus `other`. That prettifier was
// never a label — two of its outputs are not words («Ori», «Cogs») and a
// third collides with the label of its own parent section («Equity» inside
// «Equity»).
// ============================================================

/** The sections a statement publishes, plus the result that lives inside equity. */
export const REPORT_SECTION_KEYS = [
  'assets',
  'liabilities',
  'equity',
  'revenue',
  'expenses',
  'result_of_the_period',
] as const;

export type ReportSectionKey = (typeof REPORT_SECTION_KEYS)[number];

/**
 * The label of a section, or of the subsection that does not come from
 * `fs_category` (`result_of_the_period`).
 *
 * An unknown key falls back to the key itself rather than throwing. `t()`
 * throws on a missing key, and a report that cannot be printed because a
 * section was renamed upstream is worse than one that prints its identifier:
 * the figures are right either way, and the caller can see what is missing.
 */
export function reportSectionLabel(key: string, language?: Language): string {
  return labelOr(`report.section.${key}`, key, language);
}

/**
 * The label of a balance-sheet subsection, keyed by the stored `fs_category`
 * (or `other` when the account has none).
 */
export function reportCategoryLabel(key: string, language?: Language): string {
  return labelOr(`report.category.${key}`, key, language);
}

function labelOr(candidate: string, fallback: string, language?: Language): string {
  const key = candidate as TranslationKey;
  return isKnown(key) ? t(key, {}, language) : fallback;
}

function isKnown(key: TranslationKey): boolean {
  try {
    t(key, {}, 'en');
    return true;
  } catch {
    return false;
  }
}
