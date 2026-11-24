import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { TranslationKey } from '../../src/i18n/index.js';
import {
  describedIn,
  expectEveryKeyInFormat,
  expectSpanishHelp,
  flat,
  keyFormat,
  node,
  unkeyedInFamilies,
} from './helpers/help-by-key.js';

// ============================================================
// #314: THE AGENT FAMILIES, HELP BY KEY IN es-MX, FAMILY BY FAMILY
//
// The agent is keyed in two tasks. MNE-001-242 takes approvals, memory,
// pending, skills, ingest and question whole (the roots of ingest and question,
// `ingest <files...>`, `--kind` and `question list` were keyed before it);
// MNE-001-243 adds the setup and session families to FAMILIES (the roots of
// ask, chat, sessions, drafts, review, lang, onboard and login, and
// `--minimum-wage-zone` of entity, were keyed before it).
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  approvals: 'approvals',
  memory: 'memory',
  pending: 'pending',
  skills: 'skills',
  ingest: 'ingest',
  question: 'question',
  entity: 'entity',
  init: 'init',
  onboard: 'onboard',
  lang: 'lang',
  login: 'login',
  ask: 'ask',
  chat: 'chat',
  compact: 'compact',
  drafts: 'drafts',
  review: 'review',
  sessions: 'sessions',
  'prompt-size': 'prompt_size',
  ai: 'ai',
  doctor: 'doctor',
  usage: 'usage',
};

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const option = node(path).options.find((o) => o.long === long);
  return option ? helpKeyOf(option) : null;
}

describe('the agent families, help by key, family by family (#314, MNE-001-242)', () => {
  it('the lane finds nothing in these families, and each root has a key of its own', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
    for (const [family, prefix] of Object.entries(FAMILIES)) {
      expect(helpKeyOf(node(family)) ?? 'no key', family).toMatch(keyFormat(prefix));
    }
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  // Every group screen and every leaf 242 and 243 key, once; the roots' own rows are the test after this one.
  it.each<[string, TranslationKey]>([
    ['approvals', 'help.approvals.grant.description'],
    ['approvals list', 'help.approvals.list.option.all'],
    ['approvals grant', 'help.approvals.grant.option.kind'],
    ['approvals revoke', 'help.approvals.revoke.option.entity'],
    ['memory', 'help.memory.option.conflicts'],
    ['memory teach', 'help.memory.teach.argument.criterion'],
    ['memory correct', 'help.memory.correct.argument.answer'],
    ['memory retire', 'help.memory.retire.option.reason'],
    ['memory restore', 'help.memory.restore.description'],
    ['pending', 'help.pending.option.verbose'],
    ['pending define', 'help.pending.define.argument.value'],
    ['pending dismiss', 'help.pending.dismiss.option.note'],
    ['pending reopen', 'help.pending.reopen.description'],
    ['skills', 'help.skills.view.description'],
    ['skills list', 'help.skills.list.description'],
    ['skills drafts', 'help.skills.drafts.option.override_drift'],
    ['skills view', 'help.skills.view.argument.name'],
    ['ingest', 'help.ingest.option.no_auto_post'],
    ['question', 'help.question.option.list'],
    ['question answer', 'help.question.answer.argument.id'],
    ['entity', 'help.entity.unset.description'],
    ['entity list', 'help.entity.list.description'],
    ['entity show', 'help.entity.show.argument.id_or_name'],
    ['entity use', 'help.entity.use.description'],
    ['entity create', 'help.entity.create.option.chart'],
    ['entity edit', 'help.entity.edit.option.reason'],
    ['entity archive', 'help.entity.archive.argument.id_or_name'],
    ['entity unset', 'help.entity.unset.description'],
    ['init', 'help.init.option.yes'],
    ['onboard', 'help.onboard.option.cutoff'],
    // lang is MNE-001-469's (#889): its argument carries {choices} mid-sentence, so the sample is --unset.
    ['lang', 'help.lang.option.unset'],
    ['login', 'help.login.option.device'],
    ['ask', 'help.ask.argument.question'],
    ['chat', 'help.chat.option.continue'],
    ['compact', 'help.compact.option.keep'],
    ['drafts', 'help.drafts.option.entity'],
    ['review', 'help.review.option.user'],
    ['sessions', 'help.sessions.option.limit'],
    ['prompt-size', 'help.prompt_size.description'],
    ['ai', 'help.ai.stats.description'],
    ['ai stats', 'help.ai.stats.description'],
    ['doctor', 'help.doctor.option.json'],
    ['usage', 'help.usage.option.since'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key) => {
    expectSpanishHelp(path, key);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    for (const prefix of Object.values(FAMILIES)) {
      expect(help).toContain(t(`help.${prefix}.description` as TranslationKey, {}, 'es'));
    }
  });

  it('every generic flag a 242 leaf declares is worded for it and keeps a key of its own', () => {
    // None of these texts is the kernel's: «Legal entity», «Tenant», «JSON output» on leaves with no
    // --format, an --all that is not «no default limit», a --note and a --reason worded for the leaf.
    const own: Record<string, string[]> = {
      'approvals list': ['--entity', '--tenant', '--all', '--json'],
      'approvals grant': ['--entity', '--tenant', '--user'],
      'approvals revoke': ['--entity', '--tenant'],
      memory: ['--entity', '--tenant', '--all', '--json'],
      'memory teach': ['--user'],
      'memory retire': ['--user', '--reason'],
      pending: ['--entity', '--all'],
      'pending define': ['--entity', '--user', '--note'],
      'pending dismiss': ['--entity', '--user', '--note'],
      'skills list': ['--entity', '--tenant', '--json'],
      'skills drafts': ['--entity', '--tenant', '--user', '--json'],
      ingest: ['--entity', '--user'],
      // The root holds -e/-u for globalsOf; `question answer` repeats them.
      question: ['--entity', '--user'],
      'question answer': ['--entity', '--user'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*.
    const injected = [
      keyOf('approvals grant', '--yes'),
      keyOf('approvals revoke', '--reason'),
      keyOf('memory teach', '--yes'),
      keyOf('pending reopen', '--reason'),
      keyOf('ingest', '--dry-run'),
      keyOf('ingest', '--idempotency-key'),
      keyOf('question list', '--entity'),
      keyOf('question list', '--json'),
    ];
    expect(injected).toEqual([
      'cli.flag.yes',
      'cli.flag.reason',
      'cli.flag.yes',
      'cli.flag.reason',
      'cli.flag.dry_run',
      'cli.flag.idempotency_key_unneeded',
      'cli.flag.entity',
      'cli.flag.json',
    ]);
  });

  it('the approval scopes and modes travel as parameters', () => {
    expectSpanishHelp('approvals list', 'help.approvals.list.option.scope', { scopes: 'draft | external_op' });
    expectSpanishHelp('approvals grant', 'help.approvals.grant.option.scope', { scopes: 'draft | external_op' });
    expectSpanishHelp('approvals grant', 'help.approvals.grant.option.mode', { modes: 'once | session | always' });
  });

  it('the mandatory options, the parsers of their own and the arguments are where they were', () => {
    const option = (path: string, long: string) => node(path).options.find((o) => o.long === long)!;
    expect(['--scope', '--mode'].map((long) => option('approvals grant', long).mandatory)).toEqual([true, true]);
    expect(option('ingest', '--min-confidence').parseArg?.('0.8', undefined)).toBe(0.8);
    expect(option('ingest', '--max-amount').parseArg?.('1500.5', undefined)).toBe(1500.5);
    // The positive flag first, so Commander gives autoPost no default and the panel decides.
    const autoPost = node('ingest').options.filter((o) => o.long === '--auto-post' || o.long === '--no-auto-post');
    expect(autoPost.map((o): unknown[] => [o.long, o.negate, o.defaultValue as unknown])).toEqual([
      ['--auto-post', false, undefined],
      ['--no-auto-post', true, undefined],
    ]);
    const args = (path: string) => node(path).registeredArguments.map((a) => [a.name(), a.required, a.variadic]);
    expect(args('pending define')).toEqual([['key', true, false], ['value', false, false]]);
    expect(args('question answer')).toEqual([['id', false, false], ['answer', false, true]]);
    expect(args('memory teach')).toEqual([['rule', true, false], ['criterion', true, false]]);
  });
});

describe('the setup and session families, help by key (#314, MNE-001-243)', () => {
  it('every generic flag a 243 leaf declares is worded for it and keeps a key of its own', () => {
    // None is the kernel's: «Legal entity (id, RFC or name fragment)», «Tenant», a --json on a leaf
    // with no --format, init's -y that is «non-interactive», onboard's own --dry-run, an optional
    // --reason, and a --limit and --status worded for the leaf.
    const own: Record<string, string[]> = {
      'entity create': ['--json'],
      'entity edit': ['--reason', '--json'],
      init: ['--yes', '--tenant', '--entity', '--user'],
      onboard: ['--entity', '--user', '--dry-run'],
      ask: ['--entity'],
      chat: ['--entity'],
      compact: ['--entity', '--tenant', '--session', '--json'],
      drafts: ['--entity', '--status'],
      review: ['--entity', '--user'],
      sessions: ['--entity', '--limit'],
      'prompt-size': ['--entity', '--tenant', '--json'],
      doctor: ['--json'],
      usage: ['--entity', '--tenant', '--json'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/ /g, '.').replace(/-/g, '_')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), path).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    // What the kernel adds stays on cli.flag.*.
    const injected = [
      keyOf('entity list', '--entity'),
      keyOf('entity list', '--json'),
      keyOf('entity archive', '--reason'),
      keyOf('review', '--dry-run'),
      keyOf('onboard', '--yes'),
      keyOf('ai stats', '--entity'),
    ];
    expect(injected).toEqual([
      'cli.flag.entity',
      'cli.flag.json',
      'cli.flag.reason',
      'cli.flag.dry_run',
      'cli.flag.yes',
      'cli.flag.entity',
    ]);
  });

  it('the usage groupings travel as a parameter', () => {
    expectSpanishHelp('usage', 'help.usage.option.by', { choices: 'model, provider, day, session' });
  });

  it('the mandatory options, the parsers and defaults of their own and the arguments are where they were', () => {
    const option = (path: string, long: string) => node(path).options.find((o) => o.long === long)!;
    expect(option('entity create', '--tax-id').mandatory).toBe(true);
    expect(['--provider', '--cutoff'].map((long) => option('onboard', long).mandatory)).toEqual([true, true]);
    expect(option('sessions', '--limit').parseArg?.('7', undefined)).toBe(7);
    expect(() => option('sessions', '--limit').parseArg?.('seven', undefined)).toThrow('Expected a number.');
    const defaults = (path: string, longs: string[]) => longs.map((long) => option(path, long).defaultValue as unknown);
    expect(defaults('sessions', ['--limit'])).toEqual([20]);
    expect(defaults('entity create', ['--country', '--chart'])).toEqual(['MX', 'auto']);
    expect(defaults('usage', ['--by'])).toEqual(['model']);
    expect(typeof option('compact', '--keep').defaultValue).toBe('string');
    expect(Number(option('compact', '--keep').defaultValue)).toBeGreaterThan(0);
    const noBanner = option('chat', '--no-banner');
    expect([noBanner.negate, noBanner.attributeName(), noBanner.defaultValue as unknown]).toEqual([true, 'banner', undefined]);
    const args = (path: string) => node(path).registeredArguments.map((a) => [a.name(), a.required, a.variadic]);
    expect(args('ask')).toEqual([['question', true, true]]);
    expect(args('entity show')).toEqual([['idOrName', false, false]]);
    expect(args('entity create')).toEqual([['name', true, false]]);
    expect(args('lang')).toEqual([['language', false, false]]);
  });
});
