import { describe, it, expect } from 'vitest';

import { languageInEffectLine, otherLanguageOffer, shownPath } from '../../src/cli/lang-line.js';
import { DEFAULT_LOCALE, LOCALE_ENV_VAR, LOCALE_FLAG, languageOfLocale, type LocaleDecision, type LocaleSourceKind } from '../../src/i18n/locale.js';
import { LANGUAGES } from '../../src/i18n/index.js';

// ============================================================
// `mnemosine lang` SAYS WHICH LANGUAGE, FOR WHAT, AND WHO DECIDED (MNE-001-469 · #653)
//
// The first line of `lang` is rendered from `describeLocale`'s decision: the
// language in effect, the fact that it is the CLI's AND the agent's (the CLI
// reads the same `locale` the agent does), and one keyed phrase per rung. The
// expected strings below are written by hand, not copied from the output.
// ============================================================

const HOME = '/home/synthetic';

/** One decision per kind, with the shapes `describeLocale` really returns. */
const DECISIONS: Readonly<Record<LocaleSourceKind, LocaleDecision>> = {
  flag: { locale: 'en-US', kind: 'flag', label: LOCALE_FLAG, raw: 'en-US' },
  env: { locale: 'en-US', kind: 'env', label: LOCALE_ENV_VAR, raw: 'en' },
  'user-config': {
    locale: 'es-MX',
    kind: 'user-config',
    label: `locale in ${HOME}/.mnemosine/config.json`,
    raw: 'es-MX',
    file: `${HOME}/.mnemosine/config.json`,
  },
  'project-config': {
    locale: 'en-US',
    kind: 'project-config',
    label: 'locale in /srv/books/mnemosine.config.json',
    raw: 'en-US',
    file: '/srv/books/mnemosine.config.json',
  },
  'legacy-config': {
    locale: 'es-MX',
    kind: 'legacy-config',
    label: 'language in /srv/books/mnemosine.config.json',
    raw: 'es',
    file: '/srv/books/mnemosine.config.json',
  },
  entity: { locale: 'en-US', kind: 'entity', label: 'Acme US', raw: 'en-US' },
  default: { locale: 'es-MX', kind: 'default', label: null, raw: null },
};

const ENGLISH: Readonly<Record<LocaleSourceKind, string>> = {
  flag: 'Language: English (en-US), for the CLI and the agent. Decided by the --locale flag of this run.',
  env: 'Language: English (en-US), for the CLI and the agent. Decided by MNEMOSINE_LOCALE=en in the environment.',
  'user-config':
    'Language: Spanish (es-MX), for the CLI and the agent. Decided by your own choice, saved in ~/.mnemosine/config.json.',
  'project-config':
    "Language: English (en-US), for the CLI and the agent. Decided by this folder's /srv/books/mnemosine.config.json.",
  'legacy-config':
    'Language: Spanish (es-MX), for the CLI and the agent. Decided by the legacy "language" key in /srv/books/mnemosine.config.json.',
  entity: 'Language: English (en-US), for the CLI and the agent. Decided by the language of the entity Acme US.',
  default:
    'Language: Spanish (es-MX), for the CLI and the agent. Decided by the system default: nothing else chose one.',
};

const SPANISH: Readonly<Record<LocaleSourceKind, string>> = {
  flag: 'Idioma: inglés (en-US), el del CLI y el del agente. Lo decide la bandera --locale de esta ejecución.',
  env: 'Idioma: inglés (en-US), el del CLI y el del agente. Lo decide MNEMOSINE_LOCALE=en en el entorno.',
  'user-config':
    'Idioma: español (es-MX), el del CLI y el del agente. Lo decide tu propia elección, guardada en ~/.mnemosine/config.json.',
  'project-config':
    'Idioma: inglés (en-US), el del CLI y el del agente. Lo decide el /srv/books/mnemosine.config.json de esta carpeta.',
  'legacy-config':
    'Idioma: español (es-MX), el del CLI y el del agente. Lo decide la clave antigua «language» en /srv/books/mnemosine.config.json.',
  entity: 'Idioma: inglés (en-US), el del CLI y el del agente. Lo decide el idioma de la entidad Acme US.',
  default:
    'Idioma: español (es-MX), el del CLI y el del agente. Lo decide el valor por omisión del sistema: nada más eligió uno.',
};

describe('the first line of `lang` names the language, says it is the CLI and the agent, and names the rung', () => {
  const kinds = Object.keys(DECISIONS) as LocaleSourceKind[];

  it.each(kinds)('in English, for the %s rung', (kind) => {
    expect(languageInEffectLine(DECISIONS[kind], 'en', HOME)).toBe(ENGLISH[kind]);
  });

  it.each(kinds)('in Spanish, for the %s rung', (kind) => {
    expect(languageInEffectLine(DECISIONS[kind], 'es', HOME)).toBe(SPANISH[kind]);
  });

  it('gives each of the seven kinds its own phrase', () => {
    expect(kinds).toHaveLength(7);
    const rungs = kinds.map((kind) => ENGLISH[kind].split('Decided by ')[1]);
    expect(new Set(rungs).size).toBe(7);
  });
});

describe('a path under HOME is shown from ~', () => {
  it('collapses the home directory, and only a whole directory of it', () => {
    expect(shownPath(`${HOME}/.mnemosine/config.json`, HOME)).toBe('~/.mnemosine/config.json');
    expect(shownPath('/srv/books/mnemosine.config.json', HOME)).toBe('/srv/books/mnemosine.config.json');
    // A sibling whose name starts with the home's is not under it.
    expect(shownPath(`${HOME}2/.mnemosine/config.json`, HOME)).toBe(`${HOME}2/.mnemosine/config.json`);
  });
});

// MNE-001-470 · #653, part 3: the first run offers the language it is NOT in,
// written in that language, from that language's catalog.
describe('the first run offers the other language, in that language', () => {
  it('under English it offers Spanish, in Spanish', () => {
    expect(otherLanguageOffer('en')).toBe('Para usar Mnemosine en español: mnemosine idioma es');
  });

  it('under Spanish it offers English, in English', () => {
    expect(otherLanguageOffer('es')).toBe('To use Mnemosine in English: mnemosine lang en');
  });

  it('under the default it offers the language the default is not, so #657 edits nothing here', () => {
    const OFFER: Readonly<Record<(typeof LANGUAGES)[number], string>> = {
      es: 'Para usar Mnemosine en español: mnemosine idioma es',
      en: 'To use Mnemosine in English: mnemosine lang en',
    };
    const current = languageOfLocale(DEFAULT_LOCALE);
    const other = LANGUAGES.find((l) => l !== current)!;
    expect(otherLanguageOffer(current)).toBe(OFFER[other]);
  });
});
