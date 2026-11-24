import { describe, it, expect, afterEach } from 'vitest';
import { failoverNotice } from '../../src/cli/mnemosine.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';

// ============================================================
// WHAT A FAILOVER SAYS AND RECORDS (MNE-001-447, #644 P7)
//
// Both CLI callbacks (chat and ask, and the jobs tick) ask this one
// function. A link with no credential here is a configuration gap,
// not a provider failure: one dim line, by key, and no
// ai_agent_events row, so `mnemosine ai stats` keeps counting
// provider failures. Any other category prints and records as before.
// ============================================================

const dim = (s: string) => `<dim>${s}</dim>`;
const red = (s: string) => `<red>${s}</red>`;

afterEach(() => resetLanguage());

describe('failoverNotice', () => {
  it('a link with no credential: one dim line, by key, and no event', () => {
    const notice = failoverNotice('anthropic', 'unconfigured', 'gemini', 'red', { dim, red });
    expect(notice.record).toBe(false);
    expect(notice.line).toBe(`${dim(`  · ${t('provider.failover.unconfigured', { from: 'anthropic', to: 'gemini' })}`)}\n`);
    expect(notice.line.split('\n').filter(Boolean)).toHaveLength(1);
    expect(notice.line).toContain('anthropic');
    expect(notice.line).toContain('gemini');
  });

  it('the line follows the active language', () => {
    setLanguage('en');
    const english = failoverNotice('openai', 'unconfigured', 'grok', 'red', { dim, red }).line;
    setLanguage('es');
    const spanish = failoverNotice('openai', 'unconfigured', 'grok', 'red', { dim, red }).line;
    expect(spanish).toBe(`${dim(`  · ${t('provider.failover.unconfigured', { from: 'openai', to: 'grok' })}`)}\n`);
    expect(spanish).not.toBe(english);
  });

  it.each(['auth', 'rate_limit', 'server', 'timeout', 'billing'])('%s: the caller\'s tone, as today, and the event', (category) => {
    const notice = failoverNotice('anthropic', category, 'gemini', 'red', { dim, red });
    expect(notice.record).toBe(true);
    expect(notice.line).toBe(red(`  ⚠ provider anthropic failed (${category}); trying gemini\n`));
  });
});
