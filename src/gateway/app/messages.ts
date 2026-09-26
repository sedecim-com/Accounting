import { EN } from '../../i18n/en.js';
import { ES } from '../../i18n/es.js';

// ============================================================
// THE BROWSER'S MESSAGES, FROM THE HOUSE CATALOG (W1 · issue #117)
//
// The board has no catalog of its own: it imports the typed EN and ES of
// src/i18n, which the web program compiles to /modules/i18n/*.js. One
// population, so tests/i18n/sync.spec.ts and the language meter stay the
// authority on key parity, order and untranslated copies (docs/language.md).
//
// src/i18n/index.ts cannot come along: its locale resolver reads the process
// environment, and its message parser is the CLI's. Copying that parser here
// would be a second analyzer, so the board's runtime is deliberately smaller:
// it looks a key up and fills plain {name} holes, nothing else. That is enough
// because every web.* message is branch-free, which
// tests/gateway/web-model.spec.ts checks with the house messageParameters.
//
// DOM-free: the unit specs import it.
// ============================================================

export type WebLanguage = 'es' | 'en';

export type WebMessageKey = Extract<keyof typeof EN, `web.${string}`>;

export type WebMessageParams = Readonly<Record<string, string | number>>;

const CATALOGS: Readonly<Record<WebLanguage, Readonly<Record<keyof typeof EN, string>>>> = { es: ES, en: EN };

/**
 * The first browser language this board speaks, by its primary subtag;
 * Spanish when none matches, as the CLI falls back to it.
 */
export function pickLanguage(languages: readonly string[]): WebLanguage {
  for (const tag of languages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'es' || primary === 'en') return primary;
  }
  return 'es';
}

const HOLE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The message for `key` in `language`, with its {name} holes filled.
 *
 * A hole with no value throws, as the CLI's t() does: an empty gap in a
 * sentence is a defect to see in a test, not text to show someone.
 */
export function text(language: WebLanguage, key: WebMessageKey, params: WebMessageParams = {}): string {
  const message = CATALOGS[language][key];
  return message.replace(HOLE, (_hole, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${key} needs {${name}}`);
    return String(value);
  });
}
