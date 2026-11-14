import { formatMoney, formatNumber, formatPercent } from './format.js';
import { getLanguage, t, type Language, type TranslationKey } from './index.js';
import type { Locale } from './locale.js';
import type { PanelTranslate } from '../services/policy/policy-text-key.js';
import type { PreviewText } from '../services/policy/policy-preview.js';

// ============================================================
// THE POLICY PANEL'S TEXT, BOUND AT THE EDGE (#152)
//
// `src/services/policy/` renders nothing in a language of its own: no file
// under `src/services` imports the catalog, because a service can only resolve
// the language of the PROCESS, and the API would then answer every request in
// it and ignore `Accept-Language` (plan criterion
// `report-labels-come-from-the-catalog`). So the CLI, the agent and the setup
// wizard build these two objects and hand them in.
// ============================================================

/** Looks up a panel text by key in `language` (default: the active one). */
export function panelTranslator(language: Language = getLanguage()): PanelTranslate {
  return (key) => t(key as TranslationKey, {}, language);
}

/** The locale whose separators go with each language's words. */
const FORMAT_LOCALE: Readonly<Record<Language, Locale>> = { es: 'es-MX', en: 'en-US' };

/**
 * The wording and figures a policy preview speaks with. The amounts arrive as
 * `number` from the aggregation and go to the formatter as a fixed-point
 * string, which is what `formatMoney` accepts. Words AND separators follow the
 * same `language`, so a caller that asks for one other than the active one gets
 * a consistent screen (Spanish words with Spanish separators, or the reverse),
 * never a mix.
 */
export function previewText(language: Language = getLanguage()): PreviewText {
  const locale = FORMAT_LOCALE[language];
  return {
    t: (key, params = {}) => t(key as TranslationKey, params, language),
    money: (amount, currency) =>
      formatMoney(amount.toFixed(4), { currency, fractionDigits: 0, locale }),
    number: (value, options = {}) => formatNumber(value, { ...options, locale }),
    percent: (ratio, options = {}) => formatPercent(ratio, { ...options, locale }),
  };
}
