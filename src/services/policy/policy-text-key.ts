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
