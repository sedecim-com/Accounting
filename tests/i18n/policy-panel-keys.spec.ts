import { describe, expect, it } from 'vitest';
import { EN } from '../../src/i18n/en.js';
import { ES } from '../../src/i18n/es.js';
import { CATALOGS, LANGUAGES, t, type TranslationKey } from '../../src/i18n/index.js';
import { POLICY_CATALOG, type PolicySpec } from '../../src/services/policy/pending-catalog.js';
import {
  POLICY_TEXT_FIELDS,
  policyOptionKey,
  policyTextKey,
} from '../../src/services/policy/policy-text-key.js';

// ============================================================
// THE POLICY PANEL, BY KEY, IN EVERY LANGUAGE (I10 · #152, MNE-001-090)
//
// `tsc` cannot see these keys: they are built at run time from
// `PolicySpec.textKey` and the persisted option values, so `es.ts` being a
// `Record<keyof typeof EN, string>` only proves the two catalogs agree with
// EACH OTHER, not that they agree with the panel. This file walks
// `POLICY_CATALOG` and asks the catalogs for every key the panel will ask for
// (owner's note on #152: "what really protects is sync.spec, or a criterion
// that walks POLICY_CATALOG").
//
// The English half is the spec's prose, extracted as is. Until the readers
// render by key (part 2/2) the spec keeps its prose too, so the last block
// holds the two equal: a rewording made in one place and not the other would
// otherwise print one text in `en` and another in the row seeded from the spec.
// ============================================================

type Prose = Partial<Record<(typeof POLICY_TEXT_FIELDS)[number][0], string>>;

/** Every key the panel needs for one policy, with the English it must carry. */
function expectedOf(spec: PolicySpec): [string, string][] {
  const prose = spec as unknown as Prose;
  const out: [string, string][] = [];
  for (const [field, segment] of POLICY_TEXT_FIELDS) {
    const text = prose[field];
    if (typeof text === 'string') out.push([policyTextKey(spec.textKey, segment), text]);
  }
  for (const option of spec.options) out.push([policyOptionKey(spec.textKey, option.value), option.label]);
  return out;
}

const EXPECTED = new Map(POLICY_CATALOG.flatMap(expectedOf));

describe('every key the policy panel asks for exists in every language', () => {
  it('each prose field and each option label has its key in es and in en', () => {
    // The walk itself must not be empty, or every check below passes on nothing.
    for (const spec of POLICY_CATALOG) {
      for (const segment of ['question', 'impact', 'rationale'] as const) {
        expect(EXPECTED.has(policyTextKey(spec.textKey, segment)), `${spec.key} lacks ${segment}`).toBe(true);
      }
    }
    for (const language of LANGUAGES) {
      const catalog = CATALOGS[language] as Readonly<Record<string, string>>;
      const missing = [...EXPECTED.keys()].filter((key) => typeof catalog[key] !== 'string');
      expect(missing, `${language} lacks panel keys`).toEqual([]);
    }
  });

  it('the policy.* keys are exactly the texts the panel asks for, none missing and none left over', () => {
    const block = Object.keys(EN).filter((key) => key.startsWith('policy.')).sort();
    expect(block).toEqual([...EXPECTED.keys()].sort());
  });

  it('each key renders in es and in en with nothing left to fill', () => {
    for (const language of LANGUAGES) {
      for (const key of EXPECTED.keys()) {
        const rendered = t(key as TranslationKey, {}, language);
        expect(rendered.trim(), `${language}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('es.ts carries Spanish, not the extracted English, for every question', () => {
    for (const spec of POLICY_CATALOG) {
      const key = policyTextKey(spec.textKey, 'question') as TranslationKey;
      expect(ES[key], `es.${key}`).not.toBe(EN[key]);
      expect(ES[key], `es.${key} does not open as a Spanish question`).toMatch(/¿/);
    }
  });
});

describe('the English of the panel is the spec prose, until the readers render by key', () => {
  it('each en entry equals the spec field or option label it was extracted from', () => {
    const drift = [...EXPECTED.entries()]
      .filter(([key, text]) => (EN as Readonly<Record<string, string>>)[key] !== text)
      .map(([key]) => key);
    expect(drift).toEqual([]);
  });
});
