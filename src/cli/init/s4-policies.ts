import { resolveEntity } from '../../ai/context.js';
import {
  seedPolicies,
  listPending,
  listPolicies,
  resolvePolicy,
  policyWording,
  type PolicyRow,
} from '../../services/policy/policy-service.js';
import { previewFor } from '../../services/policy/policy-preview.js';
import { getPolicySpec } from '../../services/policy/pending-catalog.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';
import { ambiguityQuestion, interpretPolicyAnswer, resolveAmbiguity } from '../policy-answer.js';

// ============================================================
// S4 · ACCOUNTING POLICIES
// The decisions the system cannot make on its own because they
// depend on the firm's judgment. Each one is presented with:
//   · why I need it (what I cannot decide alone)
//   · what I will do with the answer
//   · what it looks like in THIS company's own data
//   · what happens if it is skipped
//
// Nothing is mandatory: every policy has a declared default, so
// skipping leaves the system working and the decision visible in
// `mnemosine pending`.
// ============================================================

/** A policy the wizard chooses to raise now, with its context ready. */
interface PreparedQuestion {
  row: PolicyRow;
  preview: string[];
}

export class PoliciesSection implements SetupSection {
  readonly id = 'politicas' as const;
  readonly title = 'Accounting policies';
  /** Never blocks setup: every policy has a working default. */
  readonly required = false;

  async status(): Promise<SectionStatus> {
    try {
      const ctx = await resolveEntity(undefined);
      const all = await listPolicies({ tenantId: ctx.tenantId });
      if (all.length === 0) return 'missing';
      const pending = all.filter((p) => p.status === 'pending').length;
      if (pending === 0) return 'ok';
      return pending === all.length ? 'missing' : 'partial';
    } catch {
      return 'missing';
    }
  }

  async configure(ctx: SectionContext): Promise<void> {
    let entity;
    try {
      entity = await resolveEntity(ctx.flags.entity);
    } catch {
      ctx.print('  No entity resolved yet; policies are configured after the entity exists.');
      return;
    }

    await seedPolicies({ tenantId: entity.tenantId });
    const pending = await listPending({ tenantId: entity.tenantId });

    if (pending.length === 0) {
      ctx.print('  All policies are already defined.');
      return;
    }

    ctx.print('');
    ctx.print(`  There are ${pending.length} decisions I cannot make on my own.`);
    ctx.print('  They depend on your firm\'s criteria, not on a rule I can look up.');
    ctx.print('');
    ctx.print('  You can skip any of them: each has a working default, and whatever');
    ctx.print('  you leave open stays visible in `mnemosine pending`.');

    // --yes mode: it must not ask. Report what is left on defaults and move on.
    if (!ctx.rl || ctx.flags.yes) {
      ctx.print('');
      ctx.print(`  Non-interactive mode: leaving ${pending.length} policies on their defaults.`);
      for (const p of pending) {
        ctx.print(`    · ${p.key} = ${p.default_value ?? '(none)'}`);
      }
      return;
    }

    // Prepare previews in parallel: each is a query and the wizard should
    // not stall between questions.
    const prepared: PreparedQuestion[] = await Promise.all(
      pending.map(async (row) => ({
        row,
        preview: await previewFor(row.key, {
          entityId: entity.entityId,
          tenantId: entity.tenantId,
          currency: entity.currency,
        }),
      }))
    );

    let answered = 0;
    for (let i = 0; i < prepared.length; i++) {
      const result = await this.askOne(ctx, prepared[i], i + 1, prepared.length, entity.tenantId);
      if (result === 'quit') {
        ctx.print('');
        ctx.print(`  Stopping here. The rest stay on their defaults.`);
        break;
      }
      if (result === 'answered') answered++;
    }

    const left = (await listPending({ tenantId: entity.tenantId })).length;
    ctx.print('');
    ctx.print(
      `  Defined ${answered} of ${prepared.length}.` +
        (left > 0 ? ` ${left} still open — see \`mnemosine pending\`.` : ' Nothing left open.')
    );
  }

  /** Presents one decision and records the answer. */
  private async askOne(
    ctx: SectionContext,
    q: PreparedQuestion,
    index: number,
    total: number,
    tenantId: string
  ): Promise<'answered' | 'skipped' | 'quit'> {
    const { row, preview } = q;

    // The wording lives in the CATALOG, not in the row: the database keeps
    // the STATE (pending/resolved/value), and a text copied at seed time
    // goes stale the moment the catalog is reworded. `policyWording` decides
    // where question, impact and options come from — the row's snapshot only
    // for a key the catalog no longer has — so this screen and `pending`
    // cannot disagree about it. `whyAsking`/`whatIDo`/`ifSkipped` are not
    // part of that wording and still come from the spec.
    const spec = getPolicySpec(row.key);
    const wording = policyWording(row);
    const question = wording.question;
    const why = spec?.whyAsking ?? wording.impact;
    const what = spec?.whatIDo;
    // The same list is printed below and indexed by the typed number.
    const options = wording.options;

    ctx.print('');
    ctx.print(`  ── ${index}/${total} · ${question}`);

    // Explain BEFORE asking: the user should not have to guess why the
    // system wants this, nor what it will do with it.
    ctx.print('');
    ctx.print(`     Why I ask: ${wrap(why, 68, '                ')}`);
    if (what) {
      ctx.print(`     What I do: ${wrap(what, 68, '                ')}`);
    }

    if (preview.length > 0) {
      ctx.print('');
      ctx.print('     In your data:');
      for (const line of preview) ctx.print(`       ${line}`);
    }

    ctx.print('');
    options.forEach((o, i) => {
      const isDefault = o.value === row.default_value;
      ctx.print(`     ${i + 1}) ${o.label}${isDefault ? '   ← current default' : ''}`);
    });
    ctx.print(`     Enter = keep the default (${row.default_value})   ·   q = stop asking`);

    const raw = await ctx.askText('     > ');
    if (raw === null) return 'quit';
    const answer = raw.trim();

    if (answer === '') {
      if (spec?.ifSkipped) ctx.print(`     Left open: ${spec.ifSkipped}`);
      return 'skipped';
    }
    if (answer.toLowerCase() === 'q') return 'quit';

    // Same interpretation as `pending define` (src/cli/policy-answer.ts): a
    // canonical integer is a position, anything else is what was typed, and
    // an integer that is also another option's value is asked, not guessed.
    let interpreted = interpretPolicyAnswer(answer, options);
    while (interpreted.kind === 'ambiguous') {
      ctx.print(`     ${ambiguityQuestion(interpreted)}`);
      const replyRaw = await ctx.askText('     p/v > ');
      if (replyRaw === null) return 'quit';
      const reply = resolveAmbiguity(replyRaw, interpreted);
      if (reply === null) return 'skipped';
      if (reply !== undefined) interpreted = { kind: 'chosen', value: reply };
    }
    const chosen = interpreted.value;

    try {
      await resolvePolicy(
        { tenantId },
        row.key,
        chosen,
        ctx.flags.user ?? 'init',
        'Defined during setup'
      );
      ctx.print(`     ✔ ${row.key} = ${chosen}`);
      return 'answered';
    } catch (err) {
      ctx.print(`     Could not save: ${err instanceof Error ? err.message : String(err)}`);
      return 'skipped';
    }
  }

  async verify(): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    try {
      const entity = await resolveEntity(undefined);
      const all = await listPolicies({ tenantId: entity.tenantId });
      const pending = all.filter((p) => p.status === 'pending');

      checks.push({
        name: 'Policy catalog',
        level: all.length === 0 ? 'warn' : 'ok',
        detail:
          all.length === 0
            ? 'Not seeded yet; run `mnemosine init` or `mnemosine pending`'
            : `${all.length} policies, ${pending.length} still on defaults`,
      });

      // Policies that change what reaches the books deserve a nudge.
      const highImpact = pending.filter((p) =>
        ['ingest_auto_post', 'lleva_inventarios', 'umbral_capitalizacion_mxn'].includes(p.key)
      );
      if (highImpact.length > 0) {
        checks.push({
          name: 'High-impact policies',
          level: 'warn',
          detail:
            `${highImpact.map((p) => p.key).join(', ')} still on defaults — ` +
            'they change how invoices are booked',
        });
      }
    } catch (err) {
      checks.push({
        name: 'Policy catalog',
        level: 'warn',
        detail: `Could not read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return checks;
  }
}

/** Wraps long text keeping the wizard's indentation. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > width) {
      lines.push(current.trim());
      current = w;
    } else {
      current += ' ' + w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join('\n' + indent);
}
