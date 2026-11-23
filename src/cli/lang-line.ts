import * as os from 'node:os';
import * as path from 'node:path';

import { t, type Language, type TranslationKey } from '../i18n/index.js';
import { languageOfLocale, type LocaleDecision, type LocaleSourceKind } from '../i18n/locale.js';

// ============================================================
// THE FIRST LINE OF `mnemosine lang` (MNE-001-469 · issue #653)
//
// `lang` writes `locale` into ~/.mnemosine/config.json, and the CLI reads that
// same key: the language it sets is the CLI's AND the agent's. Its first line
// says so, and says which rung of `describeLocale` decided, one keyed phrase
// per kind. Both tables are a `Record` over the type, so a kind or a language
// added without its phrase does not compile.
// ============================================================

const RUNG_KEY: Readonly<Record<LocaleSourceKind, TranslationKey>> = {
  flag: 'cli.lang.rung.flag',
  env: 'cli.lang.rung.env',
  'user-config': 'cli.lang.rung.user_config',
  'project-config': 'cli.lang.rung.project_config',
  'legacy-config': 'cli.lang.rung.legacy_config',
  entity: 'cli.lang.rung.entity',
  default: 'cli.lang.rung.default',
};

const LANGUAGE_NAME_KEY: Readonly<Record<Language, TranslationKey>> = {
  es: 'cli.lang.name.es',
  en: 'cli.lang.name.en',
};

/** A path under HOME, shown from `~`: home paths say no more than they need. */
export function shownPath(file: string, home = os.homedir()): string {
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** The name of a locale's language, in `language`. */
export function languageName(decision: Pick<LocaleDecision, 'locale'>, language?: Language): string {
  return t(LANGUAGE_NAME_KEY[languageOfLocale(decision.locale)], {}, language);
}

/** The phrase that names the rung which decided, in `language` (by default the run's). */
export function rungPhrase(decision: LocaleDecision, language?: Language, home = os.homedir()): string {
  const source = decision.label ?? '';
  return t(
    RUNG_KEY[decision.kind],
    {
      flag: source,
      variable: source,
      value: decision.raw ?? '',
      file: decision.file === undefined ? source : shownPath(decision.file, home),
      entity: source,
    },
    language
  );
}

/**
 * «Language: Spanish (es-MX), for the CLI and the agent. Decided by …», in
 * `language` (by default the run's). `emphasis` wraps the language's name, so
 * the terminal can bold it while the tests read plain text.
 */
export function languageInEffectLine(
  decision: LocaleDecision,
  language?: Language,
  home = os.homedir(),
  emphasis: (text: string) => string = (text) => text
): string {
  const rung = rungPhrase(decision, language, home);
  return t(
    'cli.lang.in_effect',
    { language: emphasis(languageName(decision, language)), locale: decision.locale, rung },
    language
  );
}
