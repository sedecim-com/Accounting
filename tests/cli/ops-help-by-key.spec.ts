import { afterEach, describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { helpKeyOf } from '../../src/cli/kernel/help.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { MessageParams, TranslationKey } from '../../src/i18n/index.js';
import { JOB_KINDS } from '../../src/ai/jobs/job-store.js';
import { WEBHOOK_SOURCE_KINDS } from '../../src/ai/webhooks/intake.js';
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
// #314: THE JOBS, WEBHOOKS AND OUTBOX FAMILIES, HELP BY KEY IN es-MX
//
// MNE-001-244 is the first part of the operations task: `jobs`, `webhooks`
// and `outbox` whole. `jobs adopt`, `jobs unadopt`, `outbox list` and the
// `outbox` root description were born keyed; this keys the rest. No node of
// these families is author prose in Castilian, so the English moves to en.ts
// as shown. `audit`, `backup`, `status`, `subscription` and `completion` are
// the second part.
// ============================================================

afterEach(() => resetLanguage());

/** Top-level family → the prefix of its keys. */
const FAMILIES: Record<string, string> = {
  jobs: 'jobs',
  webhooks: 'webhooks',
  outbox: 'outbox',
};

const JOB_KIND_LIST: MessageParams = { kinds: JOB_KINDS.join(' | ') };
const SOURCE_KINDS: MessageParams = { kinds: WEBHOOK_SOURCE_KINDS.join(', ') };

const option = (path: string, long: string) => node(path).options.find((o) => o.long === long);

/** The key of this leaf's option, or null when the leaf has no such flag. */
function keyOf(path: string, long: string): TranslationKey | null {
  const found = option(path, long);
  return found ? helpKeyOf(found) : null;
}

describe('the jobs, webhooks and outbox families, help by key (#314, MNE-001-244)', () => {
  it('the lane finds nothing in these families, and each root has a key of its own', () => {
    expect(unkeyedInFamilies(Object.keys(FAMILIES))).toEqual([]);
    for (const [family, prefix] of Object.entries(FAMILIES)) {
      expect(helpKeyOf(node(family)) ?? 'no key', family).toMatch(keyFormat(prefix));
    }
  });

  it.each(Object.entries(FAMILIES))('every description of %s has a key in the decided format', (path, prefix) => {
    expectEveryKeyInFormat(describedIn(node(path)), prefix);
  });

  it('the family rows of `mnemosine --help` are in Spanish', () => {
    setLanguage('es');
    const help = flat(program.helpInformation());
    for (const prefix of Object.values(FAMILIES)) {
      expect(help).toContain(t(`help.${prefix}.description` as TranslationKey, {}, 'es'));
    }
  });

  it.each<[string, TranslationKey, MessageParams?]>([
    ['jobs', 'help.jobs.list.description'],
    ['jobs', 'help.jobs.create.description'],
    ['jobs', 'help.jobs.enable.description'],
    ['jobs', 'help.jobs.disable.description'],
    ['jobs', 'help.jobs.run_due.description'],
    ['jobs', 'help.jobs.history.description'],
    ['jobs list', 'help.jobs.list.option.entity'],
    ['jobs list', 'help.jobs.list.option.tenant'],
    ['jobs create', 'help.jobs.create.option.entity'],
    ['jobs create', 'help.jobs.create.option.tenant'],
    ['jobs create', 'help.jobs.create.option.name'],
    ['jobs create', 'help.jobs.create.option.kind', JOB_KIND_LIST],
    ['jobs create', 'help.jobs.create.option.schedule'],
    ['jobs create', 'help.jobs.create.option.max_failures'],
    ['jobs create', 'help.jobs.create.option.user'],
    ['jobs enable', 'help.jobs.enable.argument.job_id'],
    ['jobs enable', 'help.jobs.enable.option.entity'],
    ['jobs enable', 'help.jobs.enable.option.tenant'],
    ['jobs disable', 'help.jobs.disable.argument.job_id'],
    ['jobs disable', 'help.jobs.disable.option.entity'],
    ['jobs disable', 'help.jobs.disable.option.tenant'],
    ['jobs run-due', 'help.jobs.run_due.option.entity'],
    ['jobs run-due', 'help.jobs.run_due.option.tenant'],
    ['jobs history', 'help.jobs.history.option.entity'],
    ['jobs history', 'help.jobs.history.option.tenant'],
    ['jobs history', 'help.jobs.history.option.job'],
    ['jobs history', 'help.jobs.history.option.limit'],
    ['webhooks', 'help.webhooks.create.description'],
    ['webhooks', 'help.webhooks.list.description'],
    ['webhooks', 'help.webhooks.disable.description'],
    ['webhooks', 'help.webhooks.deliveries.description'],
    ['webhooks create', 'help.webhooks.create.option.entity'],
    ['webhooks create', 'help.webhooks.create.option.tenant'],
    ['webhooks create', 'help.webhooks.create.option.source', SOURCE_KINDS],
    ['webhooks list', 'help.webhooks.list.option.entity'],
    ['webhooks list', 'help.webhooks.list.option.tenant'],
    ['webhooks list', 'help.webhooks.list.option.json'],
    ['webhooks disable', 'help.webhooks.disable.option.entity'],
    ['webhooks disable', 'help.webhooks.disable.option.tenant'],
    ['webhooks deliveries', 'help.webhooks.deliveries.option.entity'],
    ['webhooks deliveries', 'help.webhooks.deliveries.option.tenant'],
    ['webhooks deliveries', 'help.webhooks.deliveries.option.limit'],
    ['webhooks deliveries', 'help.webhooks.deliveries.option.json'],
    ['outbox', 'help.outbox.option.entity'],
    ['outbox', 'help.outbox.option.user'],
    ['outbox', 'help.outbox.option.list'],
    ['outbox run', 'help.outbox.run.argument.id'],
    ['outbox run', 'help.outbox.run.option.entity'],
    ['outbox run', 'help.outbox.run.option.user'],
  ])('`%s --help` in es-MX shows %s in Spanish', (path, key, params) => {
    expectSpanishHelp(path, key, params);
  });

  it('every generic flag a 244 leaf declares keeps a key of its own; what the kernel adds stays on cli.flag.*', () => {
    // «Legal entity (id, RFC or name fragment)» and «Tenant» are not the texts
    // of cli.flag.entity and cli.flag.tenant_scope, and no leaf here has an
    // output --format for --json to be shorthand of.
    const own: Record<string, string[]> = {
      'jobs list': ['--entity', '--tenant'],
      'jobs create': ['--entity', '--tenant', '--user'],
      'jobs enable': ['--entity', '--tenant'],
      'jobs disable': ['--entity', '--tenant'],
      'jobs run-due': ['--entity', '--tenant'],
      'jobs history': ['--entity', '--tenant', '--limit'],
      'webhooks create': ['--entity', '--tenant'],
      'webhooks list': ['--entity', '--tenant', '--json'],
      'webhooks disable': ['--entity', '--tenant'],
      'webhooks deliveries': ['--entity', '--tenant', '--limit', '--json'],
      outbox: ['--entity', '--user', '--list'],
      'outbox run': ['--entity', '--user'],
    };
    for (const [path, flags] of Object.entries(own)) {
      const prefix = `help.${path.replace(/-/g, '_').replace(/ /g, '.')}.option`;
      for (const flag of flags) expect(keyOf(path, flag), `${path} ${flag}`).toBe(`${prefix}.${flag.slice(2).replace(/-/g, '_')}`);
    }
    const injected = [
      keyOf('jobs run-due', '--yes'),
      keyOf('jobs run-due', '--dry-run'),
      keyOf('jobs run-due', '--live'),
      keyOf('outbox run', '--live'),
      // Born keyed (MNE-001-453), on the kernel's texts: not touched here.
      keyOf('jobs adopt', '--entity'),
      keyOf('jobs adopt', '--tenant'),
    ];
    expect(injected).toEqual([
      'cli.flag.yes',
      'cli.flag.dry_run',
      'cli.flag.live',
      'cli.flag.live',
      'cli.flag.entity',
      'cli.flag.tenant_scope',
    ]);
  });

  it('the 244 leaves keep their machine contract: required options, defaults, argument arity, option order', () => {
    for (const long of ['--name', '--kind', '--schedule']) expect(option('jobs create', long)?.mandatory, long).toBe(true);
    expect(option('jobs create', '--max-failures')?.mandatory).toBe(false);
    expect(option('webhooks create', '--source')?.defaultValue).toBe('generic');
    expect(option('webhooks deliveries', '--limit')?.defaultValue).toBe('20');
    expect(option('webhooks deliveries', '--limit')?.short).toBe('-n');
    expect(node('outbox run').registeredArguments.map((a) => [a.name(), a.required, a.variadic])).toEqual([
      ['id', false, true],
    ]);
    for (const path of ['jobs enable', 'jobs disable']) {
      expect(node(path).registeredArguments.map((a) => [a.name(), a.required]), path).toEqual([['jobId', true]]);
    }
    for (const path of ['webhooks create', 'webhooks disable']) {
      expect(node(path).registeredArguments.map((a) => [a.name(), a.required, a.description]), path).toEqual([
        ['name', true, ''],
      ]);
    }
    const longs = (path: string) => node(path).options.map((o) => o.long);
    expect(longs('jobs create').slice(0, 7)).toEqual([
      '--entity', '--tenant', '--name', '--kind', '--schedule', '--max-failures', '--user',
    ]);
    expect(longs('jobs history')).toEqual(['--entity', '--tenant', '--job', '--limit']);
    expect(longs('webhooks deliveries')).toEqual(['--entity', '--tenant', '--limit', '--json']);
    expect(longs('outbox')).toEqual(['--entity', '--user', '--list']);
    expect(longs('outbox run').slice(0, 2)).toEqual(['--entity', '--user']);
  });
});
