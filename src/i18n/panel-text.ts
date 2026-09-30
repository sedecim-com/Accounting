import { formatMoney, formatNumber } from './format.js';
import { getLanguage, t, type Language, type TranslationKey } from './index.js';
import { resolveLocale } from './locale.js';
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

/**
 * The wording and figures a policy preview speaks with. The amounts arrive as
 * `number` from the aggregation and go to the formatter as a fixed-point
 * string, which is what `formatMoney` accepts.
 */
export function previewText(language: Language = getLanguage()): PreviewText {
  return {
    t: (key, params = {}) => t(key as TranslationKey, params, language),
    money: (amount, currency) =>
      formatMoney(amount.toFixed(4), { currency, fractionDigits: 0, locale: resolveLocale() }),
    number: (value, options = {}) => formatNumber(value, { ...options, locale: resolveLocale() }),
  };
}
