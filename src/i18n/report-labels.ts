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

// ============================================================
// THE SAME LABELS, FOR A PUBLISHED CONTRACT (I11 · 3)
//
// `key` is the identity and `name` the LOCALIZED label — decided in #153, and
// the reason nothing is retired: an API that answered only the key would hand
// every dashboard the job of translating it. The CLI composes its labels at
// print time because its row is also a machine format; an HTTP body has no
// such split, so the section travels with its label already rendered.
//
// The language is the one the REQUEST negotiated, never the process's: the
// caller passes it in. That is the whole reason these labels are not resolved
// inside the service (see the header of this file).
// ============================================================

/** The shape both statements publish: a key, a label, and possibly subsections. */
export interface LabelledSection {
  readonly key: string;
  readonly name: string;
  readonly subsections?: readonly { readonly key: string; readonly name: string }[];
}

/**
 * The same section with `name` rendered in `language`, subsections included.
 *
 * Subsections are keyed by `fs_category`, sections by their own key, and
 * `result_of_the_period` lives among the subsections of equity while being
 * named like a section — so it is looked up in both tables, section first.
 */
export function localizedSection<T extends LabelledSection>(section: T, language: Language): T {
  const named = { ...section, name: reportSectionLabel(section.key, language) };
  if (section.subsections === undefined) return named;
  return {
    ...named,
    subsections: section.subsections.map((sub) => ({
      ...sub,
      name: subsectionLabel(sub.key, language),
    })),
  };
}

/**
 * A subsection is keyed by `fs_category`, so its CATEGORY label wins.
 *
 * The lookup order is not a detail. `equity` is BOTH a section key and a
 * legitimate `fs_category` of migration 078's CHECK, and asking the section
 * table first labels the subsection with the name of its own parent —
 * «Capital contable» inside «Capital contable», which is precisely the
 * collision the catalog was written to kill, surviving the translation. Worse,
 * it made the CLI and the API name the same account differently, and it erased
 * the distinction the 078 states in its own COMMENT: telling `ori` from
 * `equity` is what keeps a revaluation from reading as a shareholder
 * contribution.
 *
 * The section table is the FALLBACK, and it has exactly one customer:
 * `result_of_the_period`, which travels among equity's subsections while being
 * named like a section and has no `fs_category` of its own.
 */
function subsectionLabel(key: string, language: Language): string {
  const asCategory = reportCategoryLabel(key, language);
  return asCategory === key ? reportSectionLabel(key, language) : asCategory;
}
