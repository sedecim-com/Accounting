import * as os from 'node:os';

import type { CheckResult } from '../../ai/doctor-service.js';
import { setUserLocale } from '../../ai/providers/config.js';
import { getLanguage, LANGUAGES, setLanguage, t, type TranslationKey } from '../../i18n/index.js';
import { describeLocale, languageOfLocale, LOCALES, normalizeLocale, type LocaleDecision } from '../../i18n/locale.js';
import { languageInEffectLine, languageName, shownPath } from '../lang-line.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// INIT'S FIRST STEP: «Language / Idioma» (MNE-001-470 · issue #653)
//
// Before anything else is asked, init offers the language the CLI and the
// agent speak. The answer goes where `mnemosine lang` writes it, through
// `setUserLocale` into the person's own ~/.mnemosine/config.json, and never
// into a `.env`: an environment variable outranks that file, and `lang` would
// then warn that it takes precedence. Enter (and `--yes`, and a run without a
// terminal) keeps the language in effect and writes nothing.
// ============================================================

/** A key rendered in every catalog, the run's language first: «Language / Idioma». */
function inEveryLanguage(key: TranslationKey): string {
  const first = getLanguage();
  return [first, ...LANGUAGES.filter((language) => language !== first)]
    .map((language) => t(key, {}, language))
    .join(' / ');
}

export class LanguageSection implements SetupSection {
  readonly id = 'idioma' as const;
  /**
   * Required in the runner's sense only: an optional section is put behind a
   * default-no «Configure now?», which would hide the offer from the person who
   * presses Enter. Nothing is forced: Enter still writes nothing.
   */
  readonly required = true;

  constructor(private readonly opts: { cwd?: string; home?: string } = {}) {}

  get title(): string {
    return inEveryLanguage('cli.lang.step.title');
  }

  private decide(): LocaleDecision {
    return describeLocale({ cwd: this.opts.cwd, home: this.opts.home });
  }

  /** Asked only while nothing above the system default chose a language. */
  async status(): Promise<SectionStatus> {
    return this.decide().kind === 'default' ? 'missing' : 'ok';
  }

  async configure(ctx: SectionContext): Promise<void> {
    const home = this.opts.home ?? os.homedir();
    const current = this.decide();
    ctx.print(`  ${languageInEffectLine(current, undefined, home)}`);
    const prompt = `  ${inEveryLanguage('cli.lang.step.prompt')} [${LANGUAGES.join('|')}] (${languageOfLocale(current.locale)}): `;
    // Ends on Enter, EOF, --yes or no terminal: askText answers those with null.
    for (;;) {
      const answer = await ctx.askText(prompt);
      if (answer === null) return;
      const locale = normalizeLocale(answer);
      if (locale === null) {
        ctx.print(`  ${t('root.lang.unsupported', { language: answer, options: LOCALES.join(', '), languages: LANGUAGES.join(', ') })}`);
        continue;
      }
      const { file, quarantined } = setUserLocale(locale, home);
      // The run's language was pinned at startup; pinned again from the
      // resolver, the rest of this run speaks the answer wherever it is keyed,
      // unless a flag or a variable of this run still outranks the file.
      const now = this.decide();
      setLanguage(languageOfLocale(now.locale));
      ctx.print(`  ✔ ${t('cli.lang.set', { language: languageName({ locale }), locale, file: shownPath(file, home) })}`);
      if (quarantined !== null) {
        ctx.print(`  ${t('cli.lang.quarantined', { file: shownPath(file, home), copy: shownPath(quarantined, home) })}`);
      }
      if (now.locale !== locale && now.kind === 'env') {
        ctx.print(`  ⚠ ${t('cli.lang.shadowed_env', { variable: now.label ?? '', value: now.raw ?? '' })}`);
      }
      return;
    }
  }

  /** A language has nothing live to probe. */
  async verify(): Promise<CheckResult[]> {
    return [];
  }
}
