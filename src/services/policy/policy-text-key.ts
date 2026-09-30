import { getLanguage, t, type Language, type TranslationKey } from '../../i18n/index.js';
import type { PolicyOption, PolicySpec } from './pending-catalog.js';

// ============================================================
// THE I18N KEYS OF THE POLICY PANEL (#152, owner decision 2026-09-26)
//
// The panel's texts are looked up by key, never by position: #238 fixed a
// prompt that mapped a typed number to the wrong option, and
// `prima_vacacional_pct = '1.00'` was stored as `'0.25'`. So an option's
// text key carries its VALUE, the persisted one, in Spanish until I23 (#166)
// renames it.
//
// A value is not always a valid key segment: `0.25` would read as two
// segments, and `America/Mexico_City` carries a slash and capitals. This is
// the ONE function that turns a value into its segment. It is not injective
// (`0.25` and `0_25` land on the same segment), so collisions are checked
// per policy by `optionSegmentCollisions`, both in the unit suite and in the
// plan criterion that walks the catalog.
// ============================================================

/** The i18n key segment of a persisted option value: lower snake case. */
export function optionKeySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * The six prose fields of a `PolicySpec`, each with the segment its text
 * lives under: `policy.<textKey>.<segment>`. The segments are the ones the
 * issue fixed (#152); the field names are the spec's, which keep their
 * longer names until the readers render by key.
 */
export const POLICY_TEXT_FIELDS = [
  ['question', 'question'],
  ['impact', 'impact'],
  ['defaultRationale', 'rationale'],
  ['whyAsking', 'why'],
  ['whatIDo', 'what'],
  ['ifSkipped', 'if_skipped'],
] as const;

export type PolicyTextField = (typeof POLICY_TEXT_FIELDS)[number][1];

/** `policy.<textKey>.<field>`: the key of one prose field of a policy. */
export function policyTextKey(textKey: string, field: PolicyTextField): string {
  return `policy.${textKey}.${field}`;
}

/** `policy.<textKey>.option.<segment>`: the key of one option's label. */
export function policyOptionKey(textKey: string, value: string): string {
  return `policy.${textKey}.option.${optionKeySegment(value)}`;
}

/**
 * The values of ONE policy that share a segment, as `a / b → segment`.
 * Empty when every value keeps its own key, which is what the panel needs:
 * two options under one key would print the same label for both.
 */
export function optionSegmentCollisions(values: readonly string[]): string[] {
  const bySegment = new Map<string, string[]>();
  for (const v of values) {
    const segment = optionKeySegment(v);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), v]);
  }
  return [...bySegment.entries()]
    .filter(([, vs]) => vs.length > 1)
    .map(([segment, vs]) => `${vs.join(' / ')} → ${segment}`);
}

/** The wording of one catalog policy in one language, read by key. */
export interface SpecWording {
  question: string;
  impact: string;
  defaultRationale: string;
  whyAsking?: string;
  whatIDo?: string;
  ifSkipped?: string;
  options: PolicyOption[];
}

/**
 * The text of a catalog policy in `language` (default: the active one).
 *
 * The spec's own prose stays as the English source the `en` catalog was
 * extracted from. Every reader that PAINTS a policy goes through here, so the
 * accountant reads the panel in their language while `policy_decisions`
 * (state, not wording) is never touched. An optional field the spec does not
 * carry stays absent instead of becoming a blank line.
 */
export function specWording(spec: PolicySpec, language: Language = getLanguage()): SpecWording {
  const text = (field: PolicyTextField): string =>
    t(policyTextKey(spec.textKey, field) as TranslationKey, {}, language);
  return {
    question: text('question'),
    impact: text('impact'),
    defaultRationale: text('rationale'),
    whyAsking: spec.whyAsking === undefined ? undefined : text('why'),
    whatIDo: spec.whatIDo === undefined ? undefined : text('what'),
    ifSkipped: spec.ifSkipped === undefined ? undefined : text('if_skipped'),
    options: spec.options.map((o) => ({
      value: o.value,
      label: t(policyOptionKey(spec.textKey, o.value) as TranslationKey, {}, language),
    })),
  };
}
