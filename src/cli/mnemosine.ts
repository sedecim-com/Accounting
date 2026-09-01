#!/usr/bin/env node
import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { Command, InvalidArgumentError } from 'commander';
import { declararPendientes } from './kernel/riesgos-retrofit.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { closeDatabase, currentTenant, initDatabase, query } from '../database/connection.js';
import { config } from '../config/index.js';
import { loginWithPkce, loginWithDeviceCode } from '../auth/login-flows.js';
import { saveToken, loadToken, clearToken, isFresh, credentialsPath } from '../auth/token-store.js';
import { drainAttestations } from '../services/accounting/posting.js';
import { resolveEntity, listEntities, bootstrapTenant, type AgentContext } from '../ai/context.js';
import {
  createLlmSession,
  createLlmSessionWithFailover,
  resolveProfile,
  listProfiles,
  type LlmSession,
} from '../ai/providers/index.js';
import { resolveLanguage, setLanguage } from '../ai/providers/config.js';
import {
  createSession,
  latestSession,
  getSession,
  getSessionMessages,
  listSessions,
  recordTurn,
  updateSessionProvider,
  type SessionRow,
} from '../ai/session-store.js';
import { ingestCfdiFiles, previewCfdiFiles, type DraftCapture } from '../ai/ingest-service.js';
import { SUPERFICIE_DESATENDIDA, SUPERFICIE_DESATENDIDA_SANDBOX } from '../ai/tools/superficie.js';
import { resolverUmbralesConPanel } from '../ai/ingest-thresholds.js';
import {
  declareRisk,
  gateMutation,
  withContext,
  withOutput,
  withSelection,
  globalsOf,
  render,
  abortedByUser,
  usageError,
  notFound,
  exitCodeFor,
} from './kernel/index.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { registerSatCommands } from './sat-commands.js';
import { registerPendingCommands, renderAll } from './pending-command.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerAiCommand } from './ai-command.js';
import { registerMemoryCommand } from './memory-command.js';
import { registerPromptSizeCommand } from './prompt-size-command.js';
import { registerInitCommand, runInitWizard, type InitWizardResult } from './init-command.js';
import { palette } from './palette.js';
import { detectSetupState, type SetupState } from './first-run.js';
import { renderBanner, type BannerInfo } from './banner.js';
import { registerCloseCommand } from './close-command.js';
import { registerCompactCommand } from './compact-command.js';
import { registerApprovalsCommand } from './approvals-command.js';
import { registerUsageCommand } from './usage-command.js';
import { registerStatusCommand } from './status-command.js';
import { registerJobsCommand } from './jobs-command.js';
import { registerSkillsCommand } from './skills-command.js';
import { registerWebhooksCommand } from './webhooks-command.js';
import { registerEntityCommand } from './entity-command.js';
import { registerAccountCommand } from './account-command.js';
import { registerEntryCommand } from './entry-command.js';
import { registerPeriodCommand, registerYearCommand } from './period-command.js';
import { registerVendorCommand } from './vendor-command.js';
import { registerBillCommand } from './bill-command.js';
import { registerCustomerCommand } from './customer-command.js';
import { registerInvoiceCommand } from './invoice-command.js';
import { registerPaymentCommands } from './payment-command.js';
import { registerReportCommand } from './report-command.js';
import { recordUsage, estimateCostUsd, clampTokenCount } from '../ai/usage-ledger.js';
import { registrarEventoEnSegundoPlano } from '../ai/agent-events.js';
import { registrarCorridaIngesta } from '../ai/ingest-runs.js';
import type { TurnUsage } from '../ai/providers/types.js';
import type { RunAgentTurn } from '../ai/jobs/runner.js';
import {
  listDrafts,
  approveDraft,
  rejectDraft,
  resolveReviewer,
  DraftValidationError,
  canonicalDraftHash,
  type DraftRow,
} from '../ai/draft-service.js';
import {
  listQuestions,
  answerQuestion,
  dismissQuestion,
  type QuestionRow,
} from '../ai/question-service.js';
import {
  listExternalOps,
  executeExternalOp,
  canonicalOpHash,
  rejectExternalOp,
  recoverExecutingOp,
  type ExternalOpRow,
} from '../ai/external-service.js';
import { diffTrialBalance } from '../ai/external-service.js';
import { planOnboarding, executeOnboarding } from '../ai/onboarding-service.js';
import type { AskUserFn } from '../ai/tools/index.js';
import type { SessionCallbacks } from '../ai/providers/types.js';

// ============================================================
// MNEMOSINE CLI
//   mnemosine entities             — lists legal entities
//   mnemosine ask "question"       — single question (one-shot)
//   mnemosine chat                 — conversational REPL (default)
// Flags: -e/--entity <id|name>, -m/--model <model>
// ============================================================

// Color only on a real terminal; honor NO_COLOR. Piped output stays clean.
// (Shared implementation lives in palette.ts — same TTY/NO_COLOR gating.)
const c = palette(stdout);
const ce = palette(stderr);

/** Single source of truth for the version shown by --version and the banner. */
const CLI_VERSION = '0.1.0';

// Usage rows are written fire-and-forget so a turn never blocks on
// accounting; the chain lets shutdown drain in-flight inserts (bounded)
// before the pool closes, so the last turn's row is not silently lost.
let usageChain: Promise<void> = Promise.resolve();
function recordUsageInBackground(ctx: AgentContext, sessionId: string | null, usage: TurnUsage): void {
  usageChain = usageChain.then(() => recordUsage(ctx, sessionId, usage)).then(
    () => undefined,
    () => undefined
  );
}

// Bounded shutdown: drain in-flight blockchain attestations (they'd be lost
// silently otherwise), then close the pool. pool.end() waits for checked-out
// clients, so a stuck query would make Ctrl+C appear dead — cap at 2s.
async function shutdown(code: number): Promise<never> {
  await Promise.race([
    usageChain,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1500).unref();
    }),
  ]);
  await drainAttestations(5000).catch(() => undefined);
  await Promise.race([
    closeDatabase().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2000).unref();
    }),
  ]);
  process.exit(code);
}

/**
 * rl.question that settles on stdin EOF: with piped input, a question asked
 * after the input runs out would otherwise never resolve and hang the
 * process. Returns null when the interface closes.
 */
function ask(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (!settled) {
        settled = true;
        rl.removeListener('close', onClose);
        resolve(value);
      }
    };
    const onClose = () => settle(null);
    rl.once('close', onClose);
    rl.question(prompt).then(
      (answer) => settle(answer),
      () => settle(null)
    );
  });
}

/**
 * Interprets the answer to a rejection-reason prompt. A null (stdin EOF /
 * closed interface) is an ABORT — never a silent confirmation: pressing 'r'
 * then hitting Ctrl+D (or a truncated pipe) must leave the draft/op pending,
 * not record a rejection with a fabricated 'No reason'. An explicitly entered
 * empty line still defaults to 'No reason'.
 */
export function rejectionReasonFrom(
  raw: string | null
): { abort: true } | { abort: false; reason: string } {
  if (raw === null) return { abort: true };
  return { abort: false, reason: raw.trim() || 'No reason' };
}

export interface ProviderProvenance {
  name: string;
  model: string;
}

/**
 * Tracks which provider should be recorded as the session's provenance under
 * failover. A failover event only means a provider was ASKED to try — it has
 * produced nothing yet. So onFailover merely stages the candidate; the audit
 * write happens on the first turn that actually completes under it
 * (onTurnComplete → commit). A turn that fails outright drops the staged
 * candidate (onTurnFailed) so a later, non-failing turn never inherits a
 * provider that produced nothing.
 */
export function createProvenanceTracker(commit: (p: ProviderProvenance) => void) {
  let pending: ProviderProvenance | null = null;
  return {
    onFailover(p: ProviderProvenance): void {
      pending = p;
    },
    onTurnComplete(): void {
      if (pending) {
        const p = pending;
        pending = null;
        commit(p);
      }
    },
    onTurnFailed(): void {
      pending = null;
    },
    get pending(): ProviderProvenance | null {
      return pending;
    },
  };
}

function isInterrupt(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err instanceof OpenAI.APIUserAbortError) return true;
  const code = (err as { code?: string } | null)?.code;
  return code === 'ABORT_ERR' || code === 'ERR_USE_AFTER_CLOSE';
}

function reportError(err: unknown): void {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error(ce.red('\nAuthentication error with the Anthropic API.'));
    console.error('Set ANTHROPIC_API_KEY in your environment or .env, or run `ant auth login`.');
  } else if (err instanceof OpenAI.AuthenticationError) {
    console.error(ce.red('\nThe provider rejected the credential (401).'));
    console.error('Check the environment variable named by api_key_env in the profile (mnemosine providers).');
  } else if (err instanceof OpenAI.APIConnectionError) {
    console.error(ce.red('\nCould not connect to the provider endpoint.'));
    console.error('If it is a local model (ollama, hermes-agent), check that the server is running.');
  } else if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    console.error(ce.red(`\nProvider API error (${err.status}): ${err.message}`));
  } else {
    console.error(ce.red(`\n${err instanceof Error ? err.message : String(err)}`));
  }
}

function makeCallbacks(askUser?: AskUserFn, onDraftCreated?: SessionCallbacks['onDraftCreated']): SessionCallbacks {
  return {
    onText: (delta: string) => stdout.write(delta),
    // Tool progress goes to stderr so piped stdout carries only the answer.
    onToolUse: (name: string, input: unknown) => {
      stderr.write(ce.dim(`\n  ⚙ ${name} ${JSON.stringify(input)}\n`));
    },
    askUser,
    onDraftCreated,
  };
}

/**
 * One-shot agent turn for scheduled jobs: fresh session on the default
 * profile, drafts captured for the run log, usage recorded sessionless.
 */
const makeRunAgentTurn = (ctx: AgentContext, opciones?: { externo?: boolean }): RunAgentTurn =>
  async ({ prompt, capture }) => {
    const callbacks = makeCallbacks(undefined, (info) => capture.drafts.push(info));
    callbacks.onUsage = (usage) => recordUsageInBackground(ctx, null, usage);
    const session = await createLlmSessionWithFailover(undefined, ctx, callbacks, {
      // Unattended run: no human watches a grounding corrective turn, and
      // its extra model call would feed the draft-capture hooks.
      grounding: { enabled: false },
      // Y con su superficie NOMBRADA: sin esto la sesión desatendida recibía
      // todas las herramientas por omisión — hoy inofensivo (ninguna puede
      // postear), pero una herramienta futura habría entrado a lo desatendido
      // sin que nadie lo decidiera. Ahora nace excluida hasta que alguien la
      // añada a tools/superficie.ts, que es una línea en un diff.
      //
      // Y la compuerta --live del kernel decide el brazo externo: sin ella la
      // corrida usa herramientas: SUPERFICIE_DESATENDIDA_SANDBOX (la misma
      // superficie sin las dos lecturas contra el sistema del cliente con su
      // credencial); con --live viaja SUPERFICIE_DESATENDIDA completa.
      herramientas: opciones?.externo ? SUPERFICIE_DESATENDIDA : SUPERFICIE_DESATENDIDA_SANDBOX,
      onFailover: (from, errorType, to) => {
        stderr.write(ce.dim(`  ⚠ provider ${from} failed (${errorType}); trying ${to}\n`));
        registrarEventoEnSegundoPlano(ctx, {
          kind: 'failover', provider: from, detail: { categoria: errorType, siguiente: to },
        });
      },
    });
    await session.runTurn(prompt);
  };

async function buildSession(
  entityArg: string | undefined,
  providerFlag: string | undefined,
  modelFlag: string | undefined,
  callbacks: SessionCallbacks = makeCallbacks(),
  onFailover?: (from: string, errorType: string, to: string) => void
): Promise<{ session: LlmSession; ctx: AgentContext }> {
  const ctx = await resolveEntity(entityArg);
  // Failover walks the profile's configured chain only on eligible errors
  // (auth/429/5xx/timeout/billing); the winning provider is pinned for the
  // session and surfaced here so the operator always knows who answered.
  const session = await createLlmSessionWithFailover(providerFlag, ctx, callbacks, {
    model: modelFlag,
    // A2: nudge y failover dejan evento (ai_agent_events) — la salud del
    // agente se mide, no se recuerda de leer stderr.
    grounding: {
      onNudge: () => registrarEventoEnSegundoPlano(ctx, { kind: 'nudge' }),
    },
    onFailover: (from, errorType, to) => {
      stderr.write(ce.red(`  ⚠ provider ${from} failed (${errorType}); trying ${to}\n`));
      registrarEventoEnSegundoPlano(ctx, {
        kind: 'failover', provider: from, detail: { categoria: errorType, siguiente: to },
      });
      onFailover?.(from, errorType, to);
    },
  });
  return { session, ctx };
}

/** Interactive ask_user channel for chat mode: renders the agent's question
 *  and returns the human answer (numeric choice maps to its option).
 *
 *  SERIALIZED: the tool runner executes parallel tool calls concurrently, and
 *  node readline silently drops a second question() while one is pending (the
 *  promise never resolves → deadlock). The promise chain queues concurrent
 *  ask_user calls so each question waits its turn at the terminal. */
function makeAskUser(rl: () => readline.Interface | undefined): AskUserFn {
  let chain: Promise<unknown> = Promise.resolve();
  return (prompt) => {
    const run = async (): Promise<string | null> => {
      const iface = rl();
      if (!iface) return null;
      stdout.write('\n' + c.bold('❓ The agent asks:') + `\n${prompt.question}\n`);
      if (prompt.context) console.log(c.dim(prompt.context));
      if (prompt.options?.length) {
        prompt.options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
      }
      console.log(c.dim('  (option number or free text; empty = leave pending for `mnemosine questions`)'));
      const raw = await ask(iface, c.cyan('answer> '));
      if (raw === null) return null;
      const answer = raw.trim();
      if (!answer) return null;
      const idx = Number(answer);
      if (prompt.options && Number.isInteger(idx) && idx >= 1 && idx <= prompt.options.length) {
        return prompt.options[idx - 1];
      }
      return answer;
    };
    const p = chain.then(run, run);
    chain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  };
}

// ============================================================
// ENTRY EXPERIENCE — state-aware bare invocation
// Bare `mnemosine` lands on chat (isDefault). Instead of dying on a
// virgin or misconfigured machine, chat diagnoses via detectSetupState:
//   fresh  → inline rescue: offer to run the init wizard right here
//   broken → repair mode: name the problem + the exact command, change nothing
//   ready  → informative banner instead of the bare two header lines
// The happy path pays zero extra latency: diagnosis only runs when the
// normal startup fails.
// ============================================================

/**
 * Yes/no with an announced default. Accepts English and Spanish
 * affirmatives (y/yes/s/si/sí). Empty input takes the default; EOF (null)
 * is always "no" — never launch a wizard on a closed stdin.
 */
export function isAffirmative(raw: string | null, defaultYes = true): boolean {
  if (raw === null) return false;
  const t = raw.trim().toLowerCase();
  if (t === '') return defaultYes;
  return t === 'y' || t === 'yes' || t === 's' || t === 'si' || t === 'sí';
}

/**
 * Categorized failure → action: every broken-state reason maps to the exact
 * command that repairs it. Database problems win — with the DB down, the
 * other diagnoses are unreliable.
 */
export function repairCommandFor(reason: string): string {
  const r = reason.toLowerCase();
  if (/databas|\bdb\b|connect|tunnel|postgres|migrat|ssl/.test(r)) {
    return 'mnemosine doctor   (and check DATABASE_URL in .env)';
  }
  if (/entit|identity|rfc|tenant/.test(r)) return 'mnemosine init --section identity';
  if (/provider|api.?key|model|credential|anthropic|ollama|hermes/.test(r)) {
    return 'mnemosine init --section ai';
  }
  return 'mnemosine doctor';
}

/** Banner gating: rich chrome only on a real terminal, and it can always
 *  be turned off (--no-banner, MNEMOSINE_NO_BANNER=1). */
export function shouldShowBanner(
  opts: { banner?: boolean },
  env: Record<string, string | undefined>,
  isTTY: boolean
): boolean {
  if (!isTTY) return false;
  if (opts.banner === false) return false;
  if (env.MNEMOSINE_NO_BANNER === '1') return false;
  return true;
}

/**
 * One cheap aggregated query for the banner's pending counts. Never blocks
 * the prompt: capped at 1s and any failure just omits the counts.
 */
async function fetchPendingCounts(entityId: string): Promise<BannerInfo['pending']> {
  try {
    const counts = query<{ drafts: string; questions: string; ops: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ai_drafts       WHERE entity_id = $1 AND status = 'pending_review') AS drafts,
         (SELECT COUNT(*) FROM ai_questions    WHERE entity_id = $1 AND status = 'pending')        AS questions,
         (SELECT COUNT(*) FROM ai_external_ops WHERE entity_id = $1 AND status = 'pending')        AS ops`,
      [entityId]
    );
    const res = await Promise.race([
      counts,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1000).unref();
      }),
    ]);
    if (!res) return undefined;
    const row = res.rows[0];
    return { drafts: Number(row.drafts), questions: Number(row.questions), ops: Number(row.ops) };
  } catch {
    return undefined;
  }
}

/**
 * Repair mode (broken state): nothing is changed, no wizard is launched.
 * Every reason prints with the exact command that fixes it. Chrome goes to
 * stderr — a broken startup must leave stdout clean.
 */
function renderBrokenFlow(state: SetupState): void {
  if (stderr.isTTY) {
    for (const line of renderBanner({ version: CLI_VERSION }, Math.min(stderr.columns || 80, 80), ce)) {
      stderr.write(line + '\n');
    }
  }
  stderr.write('Something needs attention before we can chat:\n');
  if (state.reasons.length === 0) {
    stderr.write(`      → ${repairCommandFor('')}\n`);
  }
  for (const reason of state.reasons) {
    stderr.write(ce.dim(`  · ${reason}\n`));
    stderr.write(`      → ${repairCommandFor(reason)}\n`);
  }
}

/**
 * First-run rescue (fresh state, TTY only): a one-line intro, the detected
 * gaps, and an inline offer to run the wizard without leaving the command
 * the user already typed.
 */
async function runFreshRescue(state: SetupState): Promise<InitWizardResult | 'declined'> {
  for (const line of renderBanner({ version: CLI_VERSION }, stdout.columns || 80, c)) {
    console.log(line);
  }
  console.log('Welcome. Mnemosine is an AI accountant that keeps your books auditable: it drafts, you approve.');
  for (const reason of state.reasons) console.log(c.dim(`  · ${reason}`));
  console.log('');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await ask(rl, c.cyan('Run setup now? [Y/n] '));
  rl.close();
  if (!isAffirmative(answer)) return 'declined';
  return runInitWizard({ rescue: true }, { palette: c });
}

const program = new Command();

program
  .name('mnemosine')
  .description('AI accounting assistant — converse with your accounting from the terminal')
  .version(CLI_VERSION)
  .option(
    '-T, --tenant <uuid>',
    'Tenant to operate on (or MNEMOSINE_TENANT). Scopes EVERY query via RLS'
  );

// The tenant is set before any command runs, so that even entity resolution
// is scoped. Without this, `entities` would see every client's entities.
// Commands that only touch local files must not demand a database (or an
// SSH tunnel): `lang` reads/writes config JSON and nothing else.
const NO_DB_COMMANDS = new Set(['lang', 'idioma']);

// A failed initDatabase for CHAT is stashed instead of thrown: on a virgin
// machine the chat action routes to the first-run rescue, which needs the
// process alive to diagnose and offer the wizard. Every other command keeps
// today's fail-fast behavior.
let chatDbInitError: unknown = null;

program.hook('preAction', async (thisCommand, actionCommand) => {
  bootstrapTenant(thisCommand.opts().tenant as string | undefined);
  if (NO_DB_COMMANDS.has(actionCommand.name())) return;
  // The tunnel must be up BEFORE the first query; since the pool is lazy,
  // bringing it up here is enough.
  try {
    const { tunneled, warning } = await initDatabase();
    if (tunneled) stderr.write(ce.dim('  SSH tunnel established\n'));
    if (warning) stderr.write(ce.dim(`  ⚠ ${warning}\n`));
  } catch (err) {
    if (actionCommand.name() !== 'chat') throw err;
    chatDbInitError = err;
  }
});

program
  .command('entities')
  .alias('entidades')
  .description('Lists the active legal entities (deprecated: use `mnemosine entity list`)')
  .action(async () => {
    try {
      // R9 deprecation protocol: the old name keeps working and says so on
      // stderr, so stdout stays byte-clean for anything already piping this.
      stderr.write(
        c.dim('`mnemosine entities` is now `mnemosine entity list`; the old name still works.\n')
      );
      const entities = await listEntities();
      if (entities.length === 0) {
        console.log(
          currentTenant()
            ? 'No active entities in this tenant.'
            : 'No entities visible. If the database enforces tenant isolation, specify one with --tenant <uuid> or MNEMOSINE_TENANT.'
        );
      } else {
        for (const e of entities) {
          console.log(`${c.bold(e.name)}  ${c.dim(`(${e.tax_id}, ${e.incorporation_country}, ${e.functional_currency})`)}`);
          console.log(c.dim(`  id: ${e.id}`));
        }
      }
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('providers')
  .alias('proveedores')
  .description('Lists the configured model providers (built-in + mnemosine.config.json)')
  .action(async () => {
    try {
      const { profiles, defaultName, source } = listProfiles();
      for (const [name, p] of Object.entries(profiles)) {
        const isDefault = name === defaultName ? c.cyan(' ← default') : '';
        const keyStatus = p.api_key_env
          ? process.env[p.api_key_env]
            ? c.dim(`${p.api_key_env} ✔`)
            : c.dim(`${p.api_key_env} `) + '✘ missing'
          : c.dim('no key');
        console.log(`${c.bold(name)}${isDefault}`);
        console.log(c.dim(`  ${p.type} · ${p.model}${p.base_url ? ` · ${p.base_url}` : ''} · ${p.tools === false ? 'no tools' : 'tools'} · `) + keyStatus);
        if (p.note) console.log(c.dim(`  ${p.note}`));
      }
      console.log(
        c.dim(
          source
            ? `\nConfig: ${source}`
            : '\nUsing built-in profiles. Customize with mnemosine.config.json (or ~/.mnemosine/config.json) ' +
                'and pick the default with "default_provider", MNEMOSINE_PROVIDER or --provider.'
        )
      );
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('ask')
  .alias('pregunta')
  .description('Asks a single question and exits')
  .argument('<question...>', 'The question for the assistant')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-p, --provider <name>', 'Model provider (see: mnemosine providers)')
  .option('-m, --model <model>', 'Override the profile model')
  .action(async (questionParts: string[], opts: { entity?: string; provider?: string; model?: string }) => {
    try {
      const callbacks = makeCallbacks();
      const { session, ctx } = await buildSession(opts.entity, opts.provider, opts.model, callbacks);
      callbacks.onUsage = (usage) => recordUsageInBackground(ctx, null, usage);
      stderr.write(ce.dim(`[${ctx.entityName} · ${session.label}]\n\n`));
      await session.runTurn(questionParts.join(' '));
      stdout.write('\n');
      await shutdown(0);
    } catch (err) {
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('chat', { isDefault: true })
  .description('Opens an interactive chat session (default)')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-p, --provider <name>', 'Model provider (see: mnemosine providers)')
  .option('-m, --model <model>', 'Override the profile model')
  .option('--continue', 'Resume the latest session of this terminal/entity (transcript continuity; the model context starts fresh)')
  .option('--resume <id>', 'Resume a specific session by id (see: mnemosine sessions)')
  .option('--no-banner', 'Suppress the startup banner (also: MNEMOSINE_NO_BANNER=1)')
  .action(async (opts: {
    entity?: string; provider?: string; model?: string;
    continue?: boolean; resume?: string; banner?: boolean;
  }) => {
    let rl: readline.Interface | undefined;
    try {
      // Lazy rl getter: the session is built before readline is created, but
      // ask_user only runs mid-conversation, when rl already exists.
      const callbacks = makeCallbacks(makeAskUser(() => rl));

      // ─── Durable transcript wiring ───
      // Every completed turn is persisted via onTurnComplete. The transcript
      // is an audit convenience, not a gate: if the store is unavailable
      // (e.g. migration 018 not applied yet), chat keeps working without it.
      let sessionId: string | null = null;
      let recordChain: Promise<void> = Promise.resolve();
      const transcriptOff = (err: unknown) => {
        sessionId = null;
        stderr.write(ce.dim(`(transcript disabled: ${err instanceof Error ? err.message : String(err)})\n`));
      };
      // A failover mid-session must show on the audit row: attribute the
      // provider actually producing turns, not the one that was merely asked
      // to try. The tracker stages the candidate on failover and the DB write
      // lands only once a turn completes under it.
      const provenance = createProvenanceTracker((p) => {
        if (!sessionId) return;
        const sid = sessionId;
        recordChain = recordChain
          .then(() => updateSessionProvider(sid, p.name, p.model))
          .catch(transcriptOff);
      });
      callbacks.onTurnComplete = (record) => {
        if (!sessionId) return;
        const sid = sessionId;
        // The turn produced output: safe to persist the staged provenance
        // (ahead of the turn's rows in the serialized chain).
        provenance.onTurnComplete();
        // Serialized: seq is MAX+1 per insert, so turns must not interleave.
        recordChain = recordChain.then(() => recordTurn(sid, record)).catch(transcriptOff);
      };
      const onChatFailover = (_from: string, _errorType: string, to: string) => {
        try {
          const fallback = resolveProfile(to);
          provenance.onFailover({ name: fallback.name, model: fallback.model });
        } catch {
          // Unresolvable fallback name: the warning line already told the
          // human; provenance stays on the requested profile.
        }
      };

      // ─── State-aware startup ───
      // Try the normal startup first: when it works, no diagnosis runs and
      // the happy path pays nothing. Only on failure (or a stashed
      // preAction DB error) does detectSetupState classify the machine.
      let seedMessage: string | undefined;
      let built: Awaited<ReturnType<typeof buildSession>>;
      try {
        if (chatDbInitError) throw chatDbInitError;
        built = await buildSession(opts.entity, opts.provider, opts.model, callbacks, onChatFailover);
      } catch (startupErr) {
        const state = await detectSetupState();
        // Ready but startup still failed → a genuine runtime/user error
        // (e.g. a bad --entity): keep today's error reporting.
        if (state.state === 'ready') throw startupErr;
        if (state.state === 'broken') {
          // Repair mode: name the problem, print the fix, change nothing.
          renderBrokenFlow(state);
          return shutdown(1);
        }
        // Fresh machine → inline rescue. A pipe cannot answer a wizard:
        // point at init and exit instead of hanging.
        if (!stdin.isTTY || !stdout.isTTY) {
          stderr.write('Not configured. Run: mnemosine init\n');
          return shutdown(1);
        }
        const rescue = await runFreshRescue(state);
        if (rescue === 'declined' || !rescue.completed) {
          console.log(c.dim('You can set up anytime: mnemosine init'));
          return shutdown(0);
        }
        if (!rescue.offerChat) return shutdown(0);
        seedMessage = rescue.seedMessage;
        // The wizard just proved the system live: retry the normal startup
        // (preAction's initDatabase may have failed before the wizard ran).
        chatDbInitError = null;
        await initDatabase();
        built = await buildSession(opts.entity, opts.provider, opts.model, callbacks, onChatFailover);
      }
      const ctx = built.ctx;
      let session = built.session;

      // Usage accounting is fire-and-forget: it must never block or fail a
      // turn. sessionId is read at call time so rows attach to the session
      // once the transcript is up (null rows are still valid ledger rows).
      callbacks.onUsage = (usage) => recordUsageInBackground(ctx, sessionId, usage);

      // Informative banner on a healthy interactive start; the compact
      // two-line header everywhere else (non-TTY, --no-banner, env opt-out).
      if (shouldShowBanner(opts, process.env, stdout.isTTY === true)) {
        const info: BannerInfo = {
          version: CLI_VERSION,
          entityName: ctx.entityName,
          taxId: ctx.taxId,
          providerLabel: session.label,
          language: resolveLanguage(),
          pending: await fetchPendingCounts(ctx.entityId),
        };
        for (const line of renderBanner(info, stdout.columns || 80, c)) console.log(line);
      } else {
        console.log(c.bold('\nmnemosine') + c.dim(` · ${ctx.entityName} (${ctx.taxId}) · ${ctx.currency} · ${session.label}`));
      }
      console.log(c.dim('Commands: /exit  /new (restart)  /provider [name] (switch model)  /help\n'));

      // Identifies THIS terminal so `--continue` prefers its conversation
      // when several terminals are open on the same entity.
      const terminalKey = process.env.TMUX_PANE || process.env.TERM_SESSION_ID || null;
      try {
        let resumed: SessionRow | null = null;
        if (opts.resume) {
          resumed = await getSession(ctx, opts.resume);
          if (!resumed) throw new Error(`Session ${opts.resume} does not exist in this entity.`);
        } else if (opts.continue) {
          resumed = await latestSession(ctx, terminalKey ?? undefined);
          if (!resumed) console.log(c.dim('No previous session for this entity; starting a new one.\n'));
        }
        if (resumed) {
          sessionId = resumed.id;
          // The session may resume under a different provider than the one
          // that created it: keep the audit row's provenance columns
          // matching the profile actually producing the turns.
          const running = resolveProfile(opts.provider, opts.model);
          if (running.name !== resumed.provider || running.model !== resumed.model) {
            const sid = resumed.id;
            recordChain = recordChain
              .then(() => updateSessionProvider(sid, running.name, running.model))
              .catch(transcriptOff);
          }
          const when = resumed.last_active_at instanceof Date
            ? resumed.last_active_at.toISOString().replace('T', ' ').slice(0, 16)
            : String(resumed.last_active_at);
          console.log(c.dim(`Resuming session ${resumed.id}`));
          console.log(c.dim(`  ${resumed.title ?? `${resumed.provider} · ${resumed.model}`} · last active ${when}`));
          // Reminder for the HUMAN only — the transcript continues, but the
          // model context starts fresh (nothing is replayed into the model).
          const transcript = await getSessionMessages(resumed.id);
          const tail = transcript
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-6); // last 3 exchanges
          for (const m of tail) {
            const label = m.role === 'user' ? c.cyan('you>') : c.bold('ai> ');
            const text = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
            console.log(`${label} ${text}`);
          }
          if (tail.length > 0) {
            console.log(c.dim('(reminder only — the model starts with a fresh context)\n'));
          }
        }
        if (!sessionId) {
          const profile = resolveProfile(opts.provider, opts.model);
          sessionId = await createSession(ctx, {
            provider: profile.name,
            model: profile.model,
            terminalKey,
          });
        }
      } catch (err) {
        // --resume with a bad id is a user error: fail loudly instead of
        // silently opening an unrecorded chat.
        if (opts.resume) throw err;
        transcriptOff(err);
      }

      rl = readline.createInterface({ input: stdin, output: stdout });

      // readline owns the TTY in raw mode, so process-level SIGINT never
      // fires here: handle Ctrl+C via the interface itself and abort any
      // in-flight agent turn (up to 25 API iterations) before exiting.
      const ac = new AbortController();
      rl.on('SIGINT', () => {
        ac.abort();
        stdout.write(c.dim('\nInterrupted.\n'));
        rl?.close();
        // Flush the transcript chain (read at flush time, so the latest
        // chained promise is awaited) before closing the pool — otherwise
        // the just-completed turn's rows are lost or half-written. Bounded
        // at 2s, mirroring the closeDatabase cap, so a hung DB cannot make
        // Ctrl+C appear dead.
        void Promise.race([
          recordChain.catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2000).unref();
          }),
        ]).then(() => shutdown(130));
      });

      // Scripted first message from the init wizard ("hatch"): announced,
      // rendered like a typed line, and recorded in the transcript like any
      // other turn — the conversation starts moving without a blank prompt.
      if (seedMessage) {
        console.log(c.dim(`Sending your first message: "${seedMessage}"`));
        stdout.write(c.cyan('you> ') + seedMessage + '\n\n');
        try {
          await session.runTurn(seedMessage, ac.signal);
        } catch (err) {
          provenance.onTurnFailed();
          if (isInterrupt(err)) return;
          reportError(err);
        }
        stdout.write('\n\n');
      }

      for (;;) {
        const answer = await ask(rl, c.cyan('you> '));
        if (answer === null) break; // stdin EOF or interface closed
        const line = answer.trim();
        if (!line) continue;

        if (line === '/exit' || line === '/quit' || line === '/salir') break;
        if (line === '/new' || line === '/nueva') {
          session.reset();
          console.log(c.dim('Conversation restarted.\n'));
          continue;
        }
        if (
          line === '/provider' || line.startsWith('/provider ') ||
          line === '/proveedor' || line.startsWith('/proveedor ')
        ) {
          const target = line
            .slice(line.startsWith('/provider') ? '/provider'.length : '/proveedor'.length)
            .trim();
          if (!target) {
            const { profiles, defaultName } = listProfiles();
            console.log(c.dim(`Current: ${session.label}. Available: ${Object.keys(profiles).join(', ')} (default: ${defaultName})`));
            continue;
          }
          try {
            // Hot-swap: new session — history is not portable across
            // different provider formats. The startup --model is NOT
            // propagated: it was an override for the initial profile.
            const profile = resolveProfile(target);
            session = await createLlmSession(profile, ctx, callbacks);
            // Keep the audit row's provenance in sync with the provider now
            // producing turns. Chained on recordChain so it cannot
            // interleave with an in-flight recordTurn.
            if (sessionId) {
              const sid = sessionId;
              recordChain = recordChain
                .then(() => updateSessionProvider(sid, profile.name, profile.model))
                .catch(transcriptOff);
            }
            console.log(c.dim(`Provider switched to ${session.label}. New conversation.\n`));
          } catch (err) {
            reportError(err);
          }
          continue;
        }
        if (
          line === '/pending' || line.startsWith('/pending ') ||
          line === '/pendientes' || line.startsWith('/pendientes ')
        ) {
          // Same view as `mnemosine pending`, without leaving the chat.
          try {
            const verbose = line.includes('-v') || line.includes('--verbose');
            console.log('');
            for (const l of await renderAll(ctx, c, { verbose })) console.log(l);
          } catch (err) {
            reportError(err);
          }
          stdout.write('\n');
          continue;
        }
        if (line === '/compact') {
          // Live compaction of the model's in-flight view; the Postgres
          // transcript keeps every message either way.
          try {
            const result = await session.compact?.();
            console.log(c.dim(result
              ? `Compacted: summarized ${result.droppedMessages} older messages (~${result.dropTokens} tokens); kept ~${result.keepTokens} tokens intact.\n`
              : 'Nothing to compact.\n'));
          } catch (err) {
            reportError(err);
          }
          continue;
        }
        if (line === '/help' || line === '/ayuda') {
          console.log(c.dim('Ask about your accounting in natural language. Examples:'));
          console.log(c.dim('  How is the trial balance doing?'));
          console.log(c.dim('  Which customers owe me and since when?'));
          console.log(c.dim('  record the August rent: 10,000 from banks'));
          console.log(c.dim('  /provider hermes   ← switch models mid-session'));
          console.log(c.dim('  /pending [-v]      ← policy decisions awaiting definition'));
          console.log(c.dim('  /compact           ← summarize older turns to free context'));
          console.log(c.dim('  mnemosine usage · status · jobs   ← more tools outside the chat\n'));
          continue;
        }

        stdout.write('\n');
        try {
          await session.runTurn(line, ac.signal);
        } catch (err) {
          // The turn produced no completed output: discard any provider that
          // failover staged so a later, non-failing turn never inherits it.
          provenance.onTurnFailed();
          if (isInterrupt(err)) return;
          reportError(err);
        }
        stdout.write('\n\n');
      }

      rl.close();
      // Flush the transcript writes of the last turn before closing the pool.
      await recordChain.catch(() => undefined);
      console.log(c.dim('Goodbye.'));
      // Exit receipt: the conversation is resumable, say so on the way out.
      if (sessionId && stdout.isTTY) {
        console.log(c.dim('Resume this conversation:  mnemosine --continue'));
      }
      await shutdown(0);
    } catch (err) {
      rl?.close();
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('sessions')
  .alias('sesiones')
  .description('Lists recent chat sessions (resume one with: mnemosine chat --resume <id>)')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-n, --limit <n>', 'Maximum number of sessions to show', (v: string) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) throw new InvalidArgumentError('Expected a number.');
    return n;
  }, 20)
  .action(async (opts: { entity?: string; limit?: number }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const sessions = await listSessions(ctx, opts.limit);
      if (sessions.length === 0) {
        console.log('No recorded sessions for this entity.');
      } else {
        for (const s of sessions) {
          const when = s.last_active_at instanceof Date
            ? s.last_active_at.toISOString().replace('T', ' ').slice(0, 16)
            : String(s.last_active_at);
          console.log(
            `${c.bold(s.title ?? '(untitled)')}  ` +
              c.dim(`(${when} · ${s.provider} · ${s.model} · ${s.message_count} message${s.message_count === 1 ? '' : 's'})`)
          );
          console.log(c.dim(`  id: ${s.id}`));
        }
      }
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

function renderDraft(draft: DraftRow, index: number, total: number): void {
  const p = draft.payload;
  console.log(c.bold(`\n─── Draft ${index + 1}/${total} ───`));
  console.log(`${c.dim('id:')} ${draft.id}`);
  console.log(`${c.dim('date:')} ${p.entry_date}   ${c.dim('AI confidence:')} ${draft.ai_confidence}`);
  console.log(`${c.dim('description:')} ${p.description}`);
  if (p.reference) console.log(`${c.dim('reference:')} ${p.reference}`);
  console.log(`${c.dim('reasoning:')} ${c.dim(draft.ai_reasoning)}`);
  console.log('');
  console.log(c.dim('  account     description                                     debit       credit'));
  let debits = 0;
  let credits = 0;
  // Defensive render: payload is JSONB — a malformed draft (missing code,
  // string amounts) must not crash the whole review session.
  const money = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '');
  for (const l of p.lines ?? []) {
    if (typeof l.debit === 'number') debits += l.debit;
    if (typeof l.credit === 'number') credits += l.credit;
    const desc = (l.description ?? '').slice(0, 40);
    console.log(
      `  ${String(l.account_code ?? '??').padEnd(10)}  ${desc.padEnd(40)}  ${money(l.debit).padStart(11)}  ${money(l.credit).padStart(11)}`
    );
  }
  console.log(c.dim(`  ${''.padEnd(54)}  ${debits.toFixed(2).padStart(11)}  ${credits.toFixed(2).padStart(11)}`));
}

program
  .command('drafts')
  .alias('borradores')
  .description('Lists the journal entry drafts created by the AI')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-s, --status <status>', 'pending_review | approved | rejected')
  .action(async (opts: { entity?: string; status?: 'pending_review' | 'approved' | 'rejected' }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      const drafts = await listDrafts(ctx, opts.status);
      if (drafts.length === 0) {
        console.log('No drafts' + (opts.status ? ` with status ${opts.status}` : '') + '.');
      } else {
        for (const d of drafts) {
          const tag = d.status === 'pending_review' ? '⏳' : d.status === 'approved' ? '✔' : '✘';
          console.log(
            `${tag} ${c.bold(d.payload.entry_date)}  ${d.payload.description}  ` +
              c.dim(`(${d.payload.lines.length} lines · conf ${d.ai_confidence} · ${d.status} · ${d.id})`)
          );
        }
      }
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

const review = program
  .command('review')
  .alias('revisar')
  .description('Reviews pending drafts: approve (creates and posts the journal entry) or reject')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Reviewer email (default: first active user of the tenant)');
// Aprobar POSTEA al mayor: irreversible, declarado junto a su registro (S0.6;
// antes vivía en la tabla de retrofit). El kernel añade --dry-run, --yes e
// --idempotency-key y le niega el comando al agente.
declareRisk(review, {
  risk: 'irreversible',
  agent: false,
  writes: 'journal_entries + journal_entry_lines POSTEADOS al aprobar un borrador',
});
review.action(async (opts: { entity?: string; user?: string; yes?: boolean; idempotencyKey?: string }) => {
    let rl: readline.Interface | undefined;
    try {
      const ctx = await resolveEntity(opts.entity);
      const { dryRun } = gateMutation(review, opts as Record<string, unknown>);
      const pending = await listDrafts(ctx, 'pending_review');

      if (pending.length === 0) {
        console.log('No drafts pending review.');
        await shutdown(0);
      }

      if (dryRun) {
        // La marcha seca muestra la cola completa sin abrir el prompt: lo que
        // se vería, sin poder aprobar nada.
        pending.forEach((d, i) => renderDraft(d, i, pending.length));
        console.log(c.dim(`\n(dry-run: ${pending.length} draft(s) pending; nothing was approved or rejected)`));
        await shutdown(0);
      }
      if (opts.idempotencyKey) {
        stderr.write(
          '  --idempotency-key does not apply to the interactive queue: each approval is bound to the ' +
            'exact reviewed content (hash) and a repeat is refused by the draft status.\n'
        );
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      console.log(
        c.bold('\nmnemosine review') +
          c.dim(` · ${ctx.entityName} · ${pending.length} pending · reviewer: ${reviewer.email}`)
      );

      rl = readline.createInterface({ input: stdin, output: stdout });
      rl.on('SIGINT', () => {
        stdout.write(c.dim('\nInterrupted.\n'));
        rl?.close();
        void shutdown(130);
      });

      let approved = 0;
      let rejected = 0;
      for (let i = 0; i < pending.length; i++) {
        renderDraft(pending[i], i, pending.length);
        const raw = await ask(rl, c.cyan('\n[a]pprove and post  [r]eject  [s]kip  [q]uit > '));
        if (raw === null) break; // stdin EOF: stop cleanly instead of hanging
        const answer = raw.trim().toLowerCase();

        if (answer === 'q') break;
        if (answer === 'a') {
          try {
            // Approval is bound to the exact content the reviewer SAW at
            // render time: if the payload changes in between, approval aborts.
            const posted = await approveDraft(
              ctx, pending[i].id, reviewer, undefined, canonicalDraftHash(pending[i].payload)
            );
            approved++;
            console.log(`✔ Journal entry ${c.bold(posted.entryNumber)} created and posted.`);
          } catch (err) {
            if (err instanceof DraftValidationError) {
              console.log(ce.red('The draft no longer passes validation (the chart of accounts may have changed):'));
              for (const e of err.errors) console.log(ce.red(`  - ${e}`));
              console.log(c.dim('It stays pending; reject it if it no longer applies.'));
            } else {
              reportError(err);
            }
          }
        } else if (answer === 'r') {
          const decision = rejectionReasonFrom(await ask(rl, c.cyan('Rejection reason: ')));
          // EOF at the reason prompt aborts the rejection: leave the draft
          // pending and stop the queue cleanly, never confirm silently.
          if (decision.abort) break;
          try {
            await rejectDraft(ctx, pending[i].id, reviewer, decision.reason);
            rejected++;
            console.log('✘ Draft rejected.');
          } catch (err) {
            // e.g. another session already reviewed it — keep the queue going
            reportError(err);
            console.log(c.dim('The draft is left as-is; continuing with the next one.'));
          }
        }
        // 's' or anything else: skip
      }

      rl.close();
      console.log(c.dim(`\nDone: ${approved} approved, ${rejected} rejected.`));
      await shutdown(0);
    } catch (err) {
      rl?.close();
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(1);
    }
  });

const ingest = program
  .command('ingest')
  .alias('ingesta')
  .description('Batch ingestion of CFDIs (XML): rules → AI classification → drafts (or auto-post by thresholds)')
  .argument('<files...>', 'Paths to CFDI XML files')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-p, --provider <name>', 'Model provider (see: mnemosine providers)')
  .option('-m, --model <model>', 'Override the profile model')
  .option('-u, --user <email>', 'User the ingestion is attributed to (default: sole active user)')
  .option('--auto-post', 'Enables threshold-based auto-posting (default: everything stays as draft)')
  .option('--no-auto-post', 'Disables auto-posting even if the config has it turned on')
  .option('--min-confidence <n>', 'Minimum confidence for auto-post (0-1)', parseFloat)
  .option('--max-amount <n>', 'Maximum auto-postable amount', parseFloat);
// Irreversible por su camino más grave (el auto-posteo), declarado junto a su
// registro (S0.6). El plan de cierre proponía partirlo por bandera, pero S0.3
// lo dejó atrás: el auto-posteo ya no lo decide una bandera sino la
// precedencia bandera > archivo del operador > política del panel > omisión —
// partirlo rompería el gobierno del panel, y el apagado garantizado del
// operador ya existe (`--no-auto-post`, la bandera gana). Lo que sí exige la
// clase es --dry-run honesta, y aquí se honra en la capa determinista.
declareRisk(ingest, {
  risk: 'irreversible',
  agent: false,
  writes: 'xml_documents, pre_registrations, bills; y con auto-posteo, asientos POSTEADOS',
});
ingest.action(async (files: string[], opts: {
    entity?: string; provider?: string; model?: string; user?: string;
    autoPost?: boolean; minConfidence?: number; maxAmount?: number;
    yes?: boolean; idempotencyKey?: string;
  }) => {
    try {
      const ctx = await resolveEntity(opts.entity);
      // El panel entra en la precedencia (bandera > archivo > política >
      // omisión): antes las dos claves de auto-posteo del panel no las leía
      // nadie y el json local gobernaba solo, sin bitácora — el despacho las
      // contestaba y no cambiaba nada.
      const thresholds = await resolverUmbralesConPanel(
        {
          autoPost: opts.autoPost,
          minConfidence: opts.minConfidence,
          maxAmount: opts.maxAmount,
        },
        ctx
      );
      const { dryRun } = gateMutation(ingest, opts as Record<string, unknown>);

      if (dryRun) {
        // La capa determinista, sin escribir NADA y sin llamar a nadie: ni
        // xml_documents, ni el validador del SAT, ni el modelo. Se dice lo
        // que no se calculó: las reglas del despacho, la clasificación IA y
        // el plan de asiento se deciden en la corrida real.
        const preview = await previewCfdiFiles({ files, thresholds });
        const icon: Record<string, string> = {
          would_process: '·', duplicate: '↩', invalid: '✘', error: '✘',
        };
        console.log(c.bold('\nmnemosine ingest --dry-run') + c.dim(` · ${ctx.entityName} · ${files.length} file(s)`));
        for (const r of preview) {
          console.log(
            `${icon[r.verdict] ?? '·'} ${r.file}  ${c.dim(
              `${r.verdict}${r.tipo ? ` · tipo ${r.tipo}` : ''}${r.total ? ` · ${r.total}` : ''}` +
                `${r.route ? ` · ${r.route}` : ''}${r.detail ? ` · ${r.detail}` : ''}`
            )}`
          );
        }
        console.log(c.dim(
          '\n(dry-run: nothing was written and nothing external was called. Firm rules, AI ' +
            'classification and the journal-entry plan are decided on the real run.)'
        ));
        const broken = preview.filter((r) => r.verdict === 'invalid' || r.verdict === 'error').length;
        await shutdown(broken > 0 ? 1 : 0);
      }
      if (opts.idempotencyKey) {
        stderr.write(
          '  --idempotency-key does not apply to the batch: each CFDI deduplicates on its own UUID/hash.\n'
        );
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      // No interactive channel: the AI's questions land in `mnemosine questions`.
      const capture: DraftCapture = { drafts: [] };
      const callbacks = makeCallbacks(undefined, (info) => {
        capture.drafts.push(info);
      });
      // A2: la ingesta acumula su consumo para la fila de ai_ingest_runs —
      // y de paso cierra un hueco: este camino no registraba NADA en
      // ai_usage (el onUsage nunca se cableó aquí; ask/chat/jobs sí).
      const consumo = { input: 0, output: 0, costo: 0, costoConocido: false };
      callbacks.onUsage = (usage) => {
        recordUsageInBackground(ctx, null, usage);
        // Mismas pinzas que recordUsage: contadores hostiles o no-numéricos
        // se fijan ANTES de estimar el costo, o un NaN envenena el total.
        const fijado = {
          ...usage,
          inputTokens: clampTokenCount(usage.inputTokens),
          outputTokens: clampTokenCount(usage.outputTokens),
          cacheReadInputTokens: clampTokenCount(usage.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens: clampTokenCount(usage.cacheCreationInputTokens ?? 0),
        };
        consumo.input += fijado.inputTokens;
        consumo.output += fijado.outputTokens;
        const costo = estimateCostUsd(fijado);
        if (costo !== null) {
          consumo.costo += costo;
          consumo.costoConocido = true;
        }
      };
      const profile = resolveProfile(opts.provider, opts.model);
      // Batch pipeline with auto-post thresholds: the grounding corrective
      // turn is harness-initiated and must never be able to add drafts to
      // an unattended run — disabled here.
      const session = await createLlmSession(profile, ctx, callbacks, {
        grounding: { enabled: false },
      });

      console.log(
        c.bold('\nmnemosine ingest') +
          c.dim(
            ` · ${ctx.entityName} · ${files.length} file(s) · ${session.label} · ` +
              (thresholds.autoPost
                ? `auto-post ≥${thresholds.minConfidence} up to ${thresholds.maxAmount}`
                : 'no auto-post (everything to draft)')
          )
      );

      const corridaInicio = Date.now();
      const report = await ingestCfdiFiles({
        ctx, reviewer, files, thresholds, session, capture,
        onProgress: (msg) => stderr.write(ce.dim(`\n── ${msg}\n`)),
      });

      // A2: la corrida deja fila (counts, borradores, consumo) y cada CFDI
      // sospechoso deja evento con sus campos marcados. El registro nunca
      // tira la corrida: los resultados de ARRIBA ya son verdad aunque la
      // anotación falle — se avisa y se sigue.
      try {
        const corridaId = await registrarCorridaIngesta(ctx, {
          provider: profile.name,
          model: profile.model,
          filesTotal: files.length,
          counts: report.counts,
          sospechaCount: report.results.filter((r) => (r.sospechas?.length ?? 0) > 0).length,
          draftsCreated: report.results.filter((r) => r.draftId).length,
          inputTokens: consumo.input,
          outputTokens: consumo.output,
          estimatedCostUsd: consumo.costoConocido ? consumo.costo : null,
          durationMs: Date.now() - corridaInicio,
          autoPostEnabled: thresholds.autoPost,
          createdBy: reviewer.email,
        });
        for (const r of report.results) {
          if ((r.sospechas?.length ?? 0) > 0) {
            registrarEventoEnSegundoPlano(ctx, {
              kind: 'sospecha',
              provider: profile.name,
              detail: { archivo: r.file, campos: r.sospechas, corrida: corridaId },
            });
          }
        }
      } catch (err) {
        stderr.write(ce.yellow(`  (aviso: la corrida no quedó registrada en ai_ingest_runs: ${(err as Error).message})\n`));
      }

      const icon: Record<string, string> = {
        rules: '⚙', auto_post: '✔', draft: '📝', blocked: '❓',
        duplicate: '↩', invalid: '✘', error: '✘',
      };
      console.log('');
      for (const r of report.results) {
        console.log(
          `${icon[r.status] ?? '·'} ${r.file}  ${c.dim(`${r.status}${r.entryNumber ? ` → ${r.entryNumber}` : ''}${r.detail ? ` · ${r.detail}` : ''}`)}`
        );
      }
      const cnt = report.counts;
      console.log(
        c.bold('\nSummary: ') +
          `${cnt.auto_post} auto-posted, ${cnt.rules} by rules, ${cnt.draft} draft(s), ` +
          `${cnt.blocked} blocked, ${cnt.duplicate} duplicate(s), ${cnt.invalid + cnt.error} with errors`
      );
      if (cnt.draft > 0) console.log(c.dim('Review the drafts with: mnemosine review'));
      if (cnt.blocked > 0) console.log(c.dim('Answer the questions with: mnemosine questions'));

      await shutdown(cnt.error + cnt.invalid > 0 ? 1 : 0);
    } catch (err) {
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('lang')
  .alias('idioma')
  .description("Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)")
  .argument('[language]', "'en' or 'es'; omit to show the current setting")
  .action(async (language?: string) => {
    try {
      if (!language) {
        console.log(`Agent response language: ${c.bold(resolveLanguage())}`);
        console.log(c.dim("Change it with: mnemosine lang en|es (or MNEMOSINE_LANG env var)"));
      } else if (language === 'en' || language === 'es') {
        const file = setLanguage(language);
        console.log(`✔ Agent will now answer in ${c.bold(language === 'es' ? 'Spanish' : 'English')} ${c.dim(`(${file})`)}`);
        console.log(c.dim('Takes effect on the next session.'));
        const env = process.env.MNEMOSINE_LANG;
        if (env && env.trim().toLowerCase() !== language) {
          console.log(c.dim(`  ⚠ MNEMOSINE_LANG=${env} is set and takes precedence — unset it for this change to apply.`));
        }
      } else {
        throw new Error(`Unsupported language "${language}". Options: en, es`);
      }
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

const onboard = program
  .command('onboard')
  .alias('alta')
  .description('Imports a client\'s accounting from an external system (chart of accounts + opening balances)')
  .requiredOption('-p, --provider <name>', 'External system, e.g. contalink')
  .requiredOption('--cutoff <YYYY-MM-DD>', 'Cutoff date: opening balances are taken as of this date')
  .option('--from <YYYY-MM-DD>', 'Start of the remote trial balance period (default: January 1st of the cutoff year)')
  .option('-e, --entity <idOrName>', 'Target legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Who runs it (default: sole active user of the tenant)')
  .option('--balance-account <code>', 'Balancing account if the remote trial balance does not sum to zero (e.g. 3200)')
  .option('--post', 'Post the opening balance immediately (default: stays as a draft for mnemosine review)')
  .option('--dry-run', 'Only show the plan, without executing anything');
// Irreversible por su camino más grave (--post postea el asiento de apertura),
// declarado junto a su registro (S0.6). Su --dry-run existía desde antes del
// kernel y ya era honesta (sólo el plan); el kernel añade --yes e
// --idempotency-key y le niega el comando al agente.
declareRisk(onboard, {
  risk: 'irreversible',
  agent: false,
  writes: 'accounts, saldos iniciales; y con --post, el asiento de apertura POSTEADO',
});
onboard.action(async (opts: {
    provider: string; cutoff: string; from?: string; entity?: string; user?: string;
    balanceAccount?: string; post?: boolean; dryRun?: boolean; yes?: boolean; idempotencyKey?: string;
  }) => {
    let rl: readline.Interface | undefined;
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.cutoff)) throw new Error('--cutoff must be YYYY-MM-DD');
      const startDate = opts.from ?? `${opts.cutoff.slice(0, 4)}-01-01`;
      const ctx = await resolveEntity(opts.entity);
      const { dryRun } = gateMutation(onboard, opts as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      console.log(c.bold('\nmnemosine onboard') + c.dim(` · ${ctx.entityName} ← ${opts.provider} · cutoff ${opts.cutoff}`));
      stderr.write(ce.dim('Reading remote trial balance…\n'));
      const plan = await planOnboarding(ctx, opts.provider, startDate, opts.cutoff);

      // ─── Plan ───
      console.log(`\nRemote accounts: ${c.bold(String(plan.remoteAccounts))} · already exist: ${plan.existingAccounts} · to create: ${c.bold(String(plan.accountsToCreate.length))}`);
      for (const a of plan.accountsToCreate.slice(0, 40)) {
        console.log(`  + ${a.code.padEnd(12)} ${a.name.slice(0, 45).padEnd(45)} ${c.dim(`${a.account_type}/${a.normal_balance}${a.confident ? '' : '  ⚠ type inferred with low confidence'}`)}`);
      }
      if (plan.accountsToCreate.length > 40) console.log(c.dim(`  … and ${plan.accountsToCreate.length - 40} more`));
      console.log(`\nOpening balance: ${plan.openingLines.length} line(s) · debits ${c.bold(plan.totals.debits)} · credits ${c.bold(plan.totals.credits)}`);
      if (plan.needsBalancingAccount) {
        console.log(ce.dim(`⚠ The remote trial balance does not balance (difference ${plan.totals.imbalance}): --balance-account is required (suggested: 3200)`));
      }

      if (dryRun) {
        console.log(c.dim('\n(dry-run: nothing was created)'));
        await shutdown(0);
      }
      if (plan.openingLines.length === 0) {
        console.log('\nNothing to import: the remote trial balance has no balances.');
        await shutdown(0);
      }

      // ─── Confirmation (--yes skips it; without a terminal, refuse) ───
      const pregunta = `Create ${plan.accountsToCreate.length} account(s) and the opening balance${opts.post ? ' AND POST IT' : ' as a draft'}?`;
      if (!opts.yes) {
        if (!stdin.isTTY) {
          throw abortedByUser(
            `${pregunta} — there is no terminal to ask on. Re-run with --yes once you are sure, ` +
              'or with --dry-run to see the plan first.'
          );
        }
        rl = readline.createInterface({ input: stdin, output: stdout });
        rl.on('SIGINT', () => { stdout.write(c.dim('\nInterrupted.\n')); rl?.close(); void shutdown(130); });
        const confirm = await ask(rl, c.cyan(`\n${pregunta} [y/N] > `));
        if (!confirm || !/^(y|yes|s|si|sí)$/i.test(confirm.trim())) {
          console.log(c.dim('Cancelled.'));
          rl.close();
          await shutdown(0);
        }
      }

      // ─── Execution (idempotency key stored on success since 039) ───
      const acto = await conLlave(
        { tenantId: ctx.tenantId, entityId: ctx.entityId },
        {
          scope: 'onboard',
          clave: opts.idempotencyKey,
          payloadHash: hashDeCarga(ctx.entityId, opts.provider, opts.cutoff, startDate, opts.post ? 'post' : 'draft'),
        },
        async () => {
          const r = await executeOnboarding(ctx, plan, reviewer, {
            balanceAccountCode: opts.balanceAccount,
            postNow: opts.post,
          });
          return { accountsCreated: r.accountsCreated, entryNumber: r.entryNumber ?? null, draftId: r.draftId ?? null };
        }
      );
      const result = acto.resultado;
      if (acto.repetido) {
        stderr.write(
          `↩ Idempotency hit: key "${opts.idempotencyKey}" already ran this onboarding — ` +
            `${result.accountsCreated} account(s), ${result.entryNumber ?? result.draftId}. Nothing was executed again.\n`
        );
        rl?.close();
        await shutdown(0);
      }
      console.log(`\n✔ ${result.accountsCreated} account(s) created.`);
      if (result.entryNumber) {
        console.log(`✔ Opening balance posted: ${c.bold(result.entryNumber)} (ref ${plan.reference})`);
        // ─── Verification: the loop closes with the diff ───
        stderr.write(ce.dim('Verifying against the external system…\n'));
        const diff = await diffTrialBalance(ctx, opts.provider, startDate, opts.cutoff);
        if (diff.differences.length === 0 && diff.only_remote.length === 0) {
          console.log(`✔ Verification: ${diff.matched_equal} account(s) match ${opts.provider}; no differences.`);
        } else {
          console.log(ce.dim(`⚠ Verification: ${diff.differences.length} difference(s), ${diff.only_remote.length} remote-only — inspect with external_diff_trial_balance in the chat.`));
        }
      } else {
        console.log(`✔ Opening balance in draft ${c.dim(result.draftId ?? '')} — approve it with: mnemosine review`);
      }
      rl?.close();
      await shutdown(0);
    } catch (err) {
      rl?.close();
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(exitCodeFor(err));
    }
  });

function renderExternalOp(op: ExternalOpRow, index: number, total: number): void {
  console.log(c.bold(`\n─── Operation ${index + 1}/${total} ───`));
  console.log(`${c.dim('target:')} ${op.provider}   ${c.dim('operation:')} ${op.operation}`);
  console.log(`${c.dim('AI reasoning:')} ${c.dim(op.ai_reasoning)}`);
  console.log(`${c.dim('payload:')}`);
  console.log(JSON.stringify(op.payload, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  console.log(c.dim(`id: ${op.id}`));
}

// ============================================================
// outbox — partido en `outbox list` (lectura) y `outbox run` (externo), S0.6.
// El comando de una sola hoja hacía cosas distintas según -l: listaba o
// EJECUTABA contra el sistema del cliente con su credencial. Cada camino es
// ahora su propia hoja con su propia declaración; el padre queda como shim de
// deprecación que avisa y reenvía. La ejecución real exige --live (no existe
// un sandbox de Contalink: el efecto externo es opt-in, como manda el kernel).
// ============================================================

const ESTADOS_OUTBOX = ['pending', 'executing', 'executed', 'failed', 'rejected'] as const;

async function listarOutboxImpl(opts: {
  entity?: string; status?: string[]; limit?: number; offset?: number; all?: boolean;
  format?: string; json?: boolean; output?: string; fields?: string | boolean; quiet?: boolean;
}): Promise<void> {
  const ctx = await resolveEntity(opts.entity);
  const pedidos = (opts.status?.length ? opts.status : ['pending']) as Array<ExternalOpRow['status']>;
  for (const s of pedidos) {
    if (!(ESTADOS_OUTBOX as readonly string[]).includes(s)) {
      throw usageError(`Unknown --status "${s}". Use one of: ${ESTADOS_OUTBOX.join(', ')}.`);
    }
  }
  const todas: ExternalOpRow[] = [];
  for (const s of pedidos) todas.push(...(await listExternalOps(ctx, s)));
  const inicio = opts.offset ?? 0;
  const tope = opts.all ? undefined : opts.limit ?? 50;
  const visibles = todas.slice(inicio, tope === undefined ? undefined : inicio + tope);
  render(
    visibles.map((op) => ({
      id: op.id,
      status: op.status,
      provider: op.provider,
      operation: op.operation,
      created: op.created_at instanceof Date ? op.created_at.toISOString() : String(op.created_at),
      reasoning: (op.ai_reasoning ?? '').slice(0, 60),
    })),
    { ...opts, total: todas.length, idField: 'id' }
  );
}

async function correrOutboxImpl(
  cmd: Command,
  ids: string[],
  opts: {
    entity?: string; user?: string; yes?: boolean;
    dryRun?: boolean; live?: boolean; idempotencyKey?: string;
  }
): Promise<void> {
  let rl: readline.Interface | undefined;
  try {
    const ctx = await resolveEntity(opts.entity);
    const { dryRun, live } = gateMutation(cmd, opts as Record<string, unknown>);
    if (opts.idempotencyKey) {
      stderr.write(
        '  --idempotency-key does not apply here: each operation is claimed atomically and bound ' +
          'to the exact reviewed content (hash); a repeat is refused by its status.\n'
      );
    }
    const pending = await listExternalOps(ctx, 'pending');

    // 'executing' rows older than 10 minutes are stranded: a previous run
    // died between the atomic claim and the terminal status update, and
    // the external write may or may not have landed. Surface them for
    // manual resolution — they are otherwise invisible and unexecutable.
    // reviewed_at is set by the claim UPDATE, so it is the staleness clock
    // (ExternalOpRow does not carry it, hence the id-only staleness query).
    const executing = await listExternalOps(ctx, 'executing');
    let stale: ExternalOpRow[] = [];
    if (executing.length > 0) {
      const staleIds = await query<{ id: string }>(
        `SELECT id FROM ai_external_ops
         WHERE entity_id = $1 AND status = 'executing'
           AND reviewed_at < NOW() - INTERVAL '10 minutes'`,
        [ctx.entityId]
      );
      const idSet = new Set(staleIds.rows.map((r) => r.id));
      stale = executing.filter((op) => idSet.has(op.id));
    }
    const warnStale = (op: ExternalOpRow): void => {
      console.log(ce.red(
        `WARNING: stuck in 'executing' — a previous run died mid-execution; ` +
        `the external write may or may not have landed. Verify in ${op.provider} before resolving.`
      ));
    };

    // Con ids explícitos NO se sale por cola vacía: un guion que pidió
    // ejecutar estas operaciones debe oír «no están», no un 0 silencioso.
    if (ids.length === 0 && pending.length === 0 && stale.length === 0) {
      console.log('No pending external operations.');
      await shutdown(0);
    }

    // ─── Scripted mode: explicit ids ───
    if (ids.length > 0) {
      const porId = new Map(pending.map((op) => [op.id, op]));
      const faltan = ids.filter((id) => !porId.has(id));
      if (faltan.length > 0) {
        throw notFound(
          `Not pending (or not found) in this entity's outbox: ${faltan.join(', ')}. ` +
            'See the queue with: mnemosine outbox list'
        );
      }
      const targets = ids.map((id) => porId.get(id)!);
      if (dryRun) {
        targets.forEach((op, i) => renderExternalOp(op, i, targets.length));
        console.log(c.dim(`\n(dry-run: ${targets.length} operation(s) would execute; nothing was called)`));
        await shutdown(0);
      }
      if (!live) {
        throw usageError(
          'outbox run executes against the client\'s REAL external system and no sandbox endpoint ' +
            'exists: the real effect is opt-in. Re-run with --live (and --yes for scripts), or use ' +
            '--dry-run to see what would execute.'
        );
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      let executed = 0;
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        renderExternalOp(targets[i], i, targets.length);
        if (!opts.yes) {
          if (!stdin.isTTY) {
            throw abortedByUser(
              'Execute in the external system? — there is no terminal to ask on. Re-run with --yes once you are sure.'
            );
          }
          rl = readline.createInterface({ input: stdin, output: stdout });
          const raw = await ask(rl, c.cyan('\nExecute in the external system? [y/N] > '));
          rl.close();
          rl = undefined;
          if (!raw || !/^(y|yes|s|si|sí)$/i.test(raw.trim())) {
            console.log(c.dim('Skipped.'));
            continue;
          }
        }
        try {
          const { result } = await executeExternalOp(
            ctx, targets[i].id, reviewer.email,
            canonicalOpHash(targets[i].provider, targets[i].operation, targets[i].payload)
          );
          executed++;
          console.log(`✔ Executed. Response: ${c.dim(JSON.stringify(result).slice(0, 200))}`);
        } catch (err) {
          failed++;
          reportError(err);
          console.log(c.dim('The operation is left as-is (check outbox list --status failed); continuing.'));
        }
      }
      console.log(c.dim(`\nDone: ${executed} executed, ${failed} failed.`));
      await shutdown(failed > 0 ? 1 : 0);
    }

    // ─── Interactive queue ───
    if (dryRun) {
      pending.forEach((op, i) => renderExternalOp(op, i, pending.length));
      stale.forEach((op, i) => {
        renderExternalOp(op, i, stale.length);
        warnStale(op);
      });
      console.log(c.dim('\n(dry-run: nothing was executed or changed)'));
      await shutdown(0);
    }

    const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
    console.log(
      c.bold('\nmnemosine outbox run') +
        c.dim(` · ${ctx.entityName} · ${pending.length} pending · executes: ${reviewer.email}`)
    );
    console.log(ce.dim('WARNING: executing WRITES to the external system (Contalink, etc.).'));
    if (!live) {
      console.log(ce.dim(
        'Without --live, [e]xecute is disabled (no sandbox endpoint exists; the real effect is ' +
          'opt-in). You can still reject and skip; re-run with --live to execute.'
      ));
    }

    rl = readline.createInterface({ input: stdin, output: stdout });
    rl.on('SIGINT', () => {
      stdout.write(c.dim('\nInterrupted.\n'));
      rl?.close();
      void shutdown(130);
    });

    // Resolve stranded operations first: the human checks the external
    // system and tells us whether the interrupted write actually landed.
    for (let i = 0; i < stale.length; i++) {
      renderExternalOp(stale[i], i, stale.length);
      warnStale(stale[i]);
      const raw = await ask(rl, c.cyan(
        '\n[f] mark failed (write may have landed)  [p] reset to pending (write did NOT land)  [s]kip > '
      ));
      if (raw === null) break;
      const answer = raw.trim().toLowerCase();
      try {
        if (answer === 'f') {
          await recoverExecutingOp(ctx, stale[i].id, reviewer.email, 'failed');
          console.log('✘ Marked failed. Verify in the external system whether the write landed.');
        } else if (answer === 'p') {
          await recoverExecutingOp(ctx, stale[i].id, reviewer.email, 'pending');
          console.log('↩ Returned to the pending queue (re-run outbox run to review it again).');
        }
        // 's' or anything else: skip
      } catch (err) {
        reportError(err);
        console.log(c.dim('The operation is left as-is; the queue continues.'));
      }
    }

    let executed = 0;
    let rejected = 0;
    for (let i = 0; i < pending.length; i++) {
      renderExternalOp(pending[i], i, pending.length);
      const raw = await ask(rl, c.cyan('\n[e]xecute in the external system  [r]eject  [s]kip  [q]uit > '));
      if (raw === null) break;
      const answer = raw.trim().toLowerCase();
      if (answer === 'q') break;

      try {
        if (answer === 'e') {
          if (!live) {
            console.log(ce.dim('Not executed: re-run with --live to reach the real external system.'));
            continue;
          }
          const { result } = await executeExternalOp(
            ctx, pending[i].id, reviewer.email,
            canonicalOpHash(pending[i].provider, pending[i].operation, pending[i].payload)
          );
          executed++;
          console.log(`✔ Executed. Response: ${c.dim(JSON.stringify(result).slice(0, 200))}`);
        } else if (answer === 'r') {
          const decision = rejectionReasonFrom(await ask(rl, c.cyan('Rejection reason: ')));
          // EOF at the reason prompt aborts: leave the op pending, stop cleanly.
          if (decision.abort) break;
          await rejectExternalOp(ctx, pending[i].id, reviewer.email, decision.reason);
          rejected++;
          console.log('✘ Rejected.');
        }
        // 's' or anything else: skip
      } catch (err) {
        reportError(err);
        console.log(c.dim('The operation is left as-is (check list_external_ops/failed); the queue continues.'));
      }
    }

    rl.close();
    console.log(c.dim(`\nDone: ${executed} executed, ${rejected} rejected.`));
    await shutdown(0);
  } catch (err) {
    rl?.close();
    if (isInterrupt(err)) await shutdown(130);
    reportError(err);
    await shutdown(exitCodeFor(err));
  }
}

const outbox = program
  .command('outbox')
  .aliases(['envio', 'envios'])
  .description('Operations queued for external accounting systems: list, review and execute')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Who executes (default: sole active user of the tenant)')
  .option('-l, --list', 'Only list, without executing (deprecated: use `outbox list`)');

const outboxList = outbox
  .command('list')
  .alias('listar')
  .description('List queued external operations (default: pending)');
withOutput(withSelection(withContext(outboxList)));
declareRisk(outboxList, { risk: 'lectura', agent: true });
outboxList.action(async (_opts: unknown, cmdArg: Command) => {
  // globalsOf: el padre también declara -e/-u, y Commander entrega la opción
  // repetida al PADRE — leerla sólo del subcomando la perdería (flags.ts).
  const opts = globalsOf<Parameters<typeof listarOutboxImpl>[0]>(cmdArg);
  try {
    await listarOutboxImpl(opts);
    await shutdown(0);
  } catch (err) {
    reportError(err);
    await shutdown(exitCodeFor(err));
  }
});

const outboxRun = outbox
  .command('run')
  .alias('ejecutar')
  .argument('[id...]', 'operation ids to execute; omit to review the whole queue interactively')
  .description("Execute queued operations against the client's external system (the real effect requires --live)")
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Who executes (default: sole active user of the tenant)');
declareRisk(outboxRun, {
  risk: 'externo',
  agent: false,
  writes: 'ai_external_ops; y EJECUTA cada operación contra el sistema contable del cliente con su credencial',
});
outboxRun.action((ids: string[], _opts: unknown, cmdArg: Command) =>
  // globalsOf: -e/-u repetidas viven en el padre (ver outbox list).
  correrOutboxImpl(outboxRun, ids, globalsOf<Parameters<typeof correrOutboxImpl>[2]>(cmdArg))
);

// Shim de deprecación: el atajo de una sola hoja sigue funcionando, avisa, y
// reenvía a las hojas nuevas. Sin --live en el padre, la cola interactiva no
// puede ejecutar nada — el acto grave vive sólo detrás de `outbox run --live`.
outbox.action(async (opts: { entity?: string; user?: string; list?: boolean }) => {
  stderr.write(ce.dim(
    '  ⚠ deprecated: `mnemosine outbox` is split into `outbox list` and `outbox run` — this shortcut will go away.\n'
  ));
  if (opts.list) {
    try {
      await listarOutboxImpl(opts);
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(exitCodeFor(err));
    }
  }
  await correrOutboxImpl(outboxRun, [], opts);
});

function renderQuestion(q: QuestionRow, index: number, total: number): void {
  console.log(c.bold(`\n─── Question ${index + 1}/${total} ───`) + c.dim(`  (${q.created_at.toISOString?.().split('T')[0] ?? q.created_at})`));
  console.log(q.question);
  if (q.context) console.log(c.dim(q.context));
  if (q.options?.length) q.options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  console.log(c.dim(`id: ${q.id}`));
}

// ============================================================
// question — partido en `question list` (lectura) y `question answer`
// (escritura), S0.6. El comando de una sola hoja hacía cosas distintas según
// -l; y el sustantivo pasa a singular como comete el catálogo (R2), con
// `questions`/`dudas` vivos como aliases de compatibilidad.
// ============================================================

async function listarQuestionsImpl(opts: {
  entity?: string; status?: string[]; limit?: number; offset?: number; all?: boolean;
  format?: string; json?: boolean; output?: string; fields?: string | boolean; quiet?: boolean;
}): Promise<void> {
  const ctx = await resolveEntity(opts.entity);
  const ESTADOS = ['pending', 'answered', 'dismissed'] as const;
  const pedidos = (opts.status?.length ? opts.status : ['pending']) as Array<QuestionRow['status']>;
  for (const s of pedidos) {
    if (!(ESTADOS as readonly string[]).includes(s)) {
      throw usageError(`Unknown --status "${s}". Use one of: ${ESTADOS.join(', ')}.`);
    }
  }
  const todas: QuestionRow[] = [];
  for (const s of pedidos) todas.push(...(await listQuestions(ctx, s)));
  const inicio = opts.offset ?? 0;
  const tope = opts.all ? undefined : opts.limit ?? 50;
  const visibles = todas.slice(inicio, tope === undefined ? undefined : inicio + tope);
  render(
    visibles.map((q) => ({
      id: q.id,
      status: q.status,
      created: q.created_at instanceof Date ? q.created_at.toISOString().split('T')[0] : String(q.created_at),
      question: q.question.slice(0, 70),
      options: q.options?.length ? String(q.options.length) : '',
      topic: q.topic ?? '',
    })),
    { ...opts, total: todas.length, idField: 'id' }
  );
}

async function colaDeQuestionsImpl(opts: { entity?: string; user?: string }): Promise<void> {
  let rl: readline.Interface | undefined;
  try {
    const ctx = await resolveEntity(opts.entity);
    const pending = await listQuestions(ctx, 'pending');

    if (pending.length === 0) {
      console.log('No pending questions.');
      await shutdown(0);
    }

    const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
    console.log(
      c.bold('\nmnemosine question answer') +
        c.dim(` · ${ctx.entityName} · ${pending.length} pending · answers: ${reviewer.email}`)
    );

    rl = readline.createInterface({ input: stdin, output: stdout });
    rl.on('SIGINT', () => {
      stdout.write(c.dim('\nInterrupted.\n'));
      rl?.close();
      void shutdown(130);
    });

    let answered = 0;
    let dismissed = 0;
    for (let i = 0; i < pending.length; i++) {
      const q = pending[i];
      renderQuestion(q, i, pending.length);
      const raw = await ask(rl, c.cyan('\n[answer / option number / s=skip / d=dismiss / q=quit] > '));
      if (raw === null) break;
      const line = raw.trim();
      if (!line || line.toLowerCase() === 's') continue;
      if (line.toLowerCase() === 'q') break;

      try {
        if (line.toLowerCase() === 'd') {
          await dismissQuestion(ctx, q.id, reviewer.email);
          dismissed++;
          console.log(c.dim('Question dismissed.'));
          continue;
        }
        const idx = Number(line);
        const answer =
          q.options && Number.isInteger(idx) && idx >= 1 && idx <= q.options.length
            ? q.options[idx - 1]
            : line;
        await answerQuestion(ctx, q.id, answer, reviewer.email);
        answered++;
        console.log(`✔ Answered and saved as a precedent: ${c.bold(answer)}`);
      } catch (err) {
        // e.g. another session already resolved it — continue with the queue
        reportError(err);
      }
    }

    rl.close();
    console.log(c.dim(`\nDone: ${answered} answered, ${dismissed} dismissed.`));
    await shutdown(0);
  } catch (err) {
    rl?.close();
    if (isInterrupt(err)) await shutdown(130);
    reportError(err);
    await shutdown(exitCodeFor(err));
  }
}

const question = program
  .command('question')
  .aliases(['duda', 'questions', 'dudas'])
  .description("The agent's pending questions: list, answer (saved as a precedent) or dismiss")
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Who answers (default: sole active user of the tenant)')
  .option('-l, --list', 'Only list, without answering (deprecated: use `question list`)');

const questionList = question
  .command('list')
  .alias('listar')
  .description("List the agent's questions (default: pending)");
withOutput(withSelection(withContext(questionList)));
declareRisk(questionList, { risk: 'lectura', agent: true });
questionList.action(async (_opts: unknown, cmdArg: Command) => {
  // globalsOf: -e/-u repetidas viven en el padre (ver outbox list).
  const opts = globalsOf<Parameters<typeof listarQuestionsImpl>[0]>(cmdArg);
  try {
    await listarQuestionsImpl(opts);
    await shutdown(0);
  } catch (err) {
    reportError(err);
    await shutdown(exitCodeFor(err));
  }
});

const questionAnswer = question
  .command('answer')
  .alias('responder')
  .argument('[id]', 'question id; omit to answer the pending queue interactively')
  .argument('[answer...]', 'the answer text, or the number of an option (requires <id>)')
  .description('Answer a question (the answer is saved as a precedent), or work the pending queue')
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Who answers (default: sole active user of the tenant)');
declareRisk(questionAnswer, {
  risk: 'escritura',
  agent: false,
  writes: 'ai_questions y los precedentes que su respuesta siembra',
});
questionAnswer.action(async (id: string | undefined, answerParts: string[], _opts: unknown, cmdArg: Command) => {
  // globalsOf: -e/-u repetidas viven en el padre (ver outbox list).
  const opts = globalsOf<{ entity?: string; user?: string }>(cmdArg);
  if (!id) return colaDeQuestionsImpl(opts);
  try {
    if (answerParts.length === 0) {
      throw usageError('question answer <id> needs the answer: mnemosine question answer <id> "<text or option number>"');
    }
    const ctx = await resolveEntity(opts.entity);
    const q = (await listQuestions(ctx, 'pending')).find((row) => row.id === id);
    if (!q) {
      throw notFound(`No pending question with id ${id}. See them with: mnemosine question list`);
    }
    const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
    const line = answerParts.join(' ').trim();
    const idx = Number(line);
    const answer =
      q.options && Number.isInteger(idx) && idx >= 1 && idx <= q.options.length
        ? q.options[idx - 1]
        : line;
    await answerQuestion(ctx, q.id, answer, reviewer.email);
    console.log(`✔ Answered and saved as a precedent: ${c.bold(answer)}`);
    await shutdown(0);
  } catch (err) {
    reportError(err);
    await shutdown(exitCodeFor(err));
  }
});

// Shim de deprecación: `mnemosine questions [-l]` sigue funcionando, avisa y
// reenvía a las hojas nuevas.
question.action(async (opts: { entity?: string; user?: string; list?: boolean }) => {
  stderr.write(ce.dim(
    '  ⚠ deprecated: `mnemosine questions` is split into `question list` and `question answer` — this shortcut will go away.\n'
  ));
  if (opts.list) {
    try {
      await listarQuestionsImpl(opts);
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(exitCodeFor(err));
    }
  }
  await colaDeQuestionsImpl(opts);
});

registerSatCommands(program, {
  color: c,
  colorErr: ce,
  shutdown,
  reportError,
  ask,
});

registerPendingCommands(program, {
  color: c,
  colorErr: ce,
  shutdown,
  reportError,
  ask,
});

program
  .command('login')
  .alias('entrar')
  .description('Signs in with your identity provider (OIDC)')
  .option('--device', 'Use the device-code flow (SSH, server without a browser)')
  .action(async (opts: { device?: boolean }) => {
    try {
      if (!config.auth.enabled) {
        console.error(ce.red('OIDC is not configured.'));
        console.error('Set AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID and AUTH_OIDC_AUDIENCE in your .env.');
        await shutdown(1);
      }
      const cfg = {
        issuer: config.auth.issuer,
        clientId: config.auth.clientId,
        audience: config.auth.audience,
      };
      const presenter = {
        showUrl: (url: string, note?: string) => {
          if (note) console.log(c.dim(note));
          console.log('\n' + url + '\n');
        },
        showCode: (code: string, url: string) => {
          console.log(c.dim('\nOpen this address:'));
          console.log('  ' + url);
          console.log(c.dim('and type in the code:') + '  ' + c.bold(code) + '\n');
        },
      };

      const token = opts.device
        ? await loginWithDeviceCode(cfg, presenter)
        : await loginWithPkce(cfg, presenter);

      const where = await saveToken(token);
      console.log(
        `✔ Signed in. Credential stored in ${where === 'keychain' ? 'the system keychain' : credentialsPath}.`
      );
      console.log(c.dim(`Expires in ${Math.round((token.expiresAt - Date.now()) / 60000)} min; renews itself.`));
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(1);
    }
  });

program
  .command('logout')
  .alias('salir')
  .description('Deletes the stored credential')
  .action(async () => {
    await clearToken();
    console.log('Signed out.');
    await shutdown(0);
  });

program
  .command('whoami')
  .alias('quien')
  .description('Shows the active credential and its validity')
  .action(async () => {
    const token = await loadToken();
    if (!token) {
      console.log('No session. Use `mnemosine login`.');
    } else {
      const mins = Math.round((token.expiresAt - Date.now()) / 60000);
      console.log(`Provider: ${token.issuer}`);
      console.log(
        isFresh(token)
          ? `Valid for ${mins} more min${token.refreshToken ? ' (renewable)' : ''}.`
          : c.dim('Expired.') + (token.refreshToken ? ' It will renew on next use.' : ' Sign in again.')
      );
    }
    await shutdown(0);
  });

// Covers non-readline modes (ask, entities); in chat the rl 'SIGINT'
// listener handles Ctrl+C because raw mode swallows the signal.
process.on('SIGINT', () => {
  stdout.write(c.dim('\nInterrupted.\n'));
  void shutdown(130);
});

registerDoctorCommand(program, { palette: c, shutdown, reportError });
registerMemoryCommand(program, { palette: c, shutdown, reportError });
registerPromptSizeCommand(program, { palette: c, shutdown, reportError });
registerCompactCommand(program, { palette: c, shutdown, reportError });
registerApprovalsCommand(program, { palette: c, shutdown, reportError });
registerEntityCommand(program, { palette: c, shutdown, reportError });
registerPaymentCommands(program, { palette: c, shutdown, reportError });
registerAccountCommand(program, { palette: c, shutdown, reportError });
registerEntryCommand(program, { palette: c, shutdown, reportError });
registerPeriodCommand(program, { palette: c, shutdown, reportError });
registerYearCommand(program, { palette: c, shutdown, reportError });
registerVendorCommand(program, { palette: c, shutdown, reportError });
registerBillCommand(program, { palette: c, shutdown, reportError });
registerCustomerCommand(program, { palette: c, shutdown, reportError });
registerInvoiceCommand(program, { palette: c, shutdown, reportError });
registerReportCommand(program, { palette: c, shutdown, reportError });
registerAiCommand(program, { palette: c, shutdown, reportError });
registerUsageCommand(program, { palette: c, shutdown, reportError });
registerStatusCommand(program, { palette: c, shutdown, reportError });
registerJobsCommand(program, { palette: c, shutdown, reportError, makeRunAgentTurn });
registerSkillsCommand(program, { palette: c, shutdown, reportError });
registerWebhooksCommand(program, { palette: c, shutdown, reportError });
registerInitCommand(program, { palette: c, shutdown, reportError });
registerCloseCommand(program, { palette: c, shutdown, reportError });

// Las declaraciones de riesgo que faltaban, sobre el árbol ya completo.
//
// Va aquí y no antes porque necesita el programa entero montado: 49 de las 106
// hojas no declaraban nada, y a lo que no declara no se le aplica ninguna
// compuerta. Respeta lo que ya declaró junto a su comando.
declararPendientes(program);

// Exported for scripts/generate-cli-reference.ts, which walks the command
// tree to emit the agent-facing CLI reference without spawning the binary.
export { program };

// Parse only when executed as the entrypoint (tsx / node dist are CJS, where
// require.main identifies it). Importing this module — the entry-flow spec
// pulls the exported pure helpers — must not launch the CLI.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  program.parseAsync(process.argv).catch(async (err) => {
    reportError(err);
    await shutdown(1);
  });
}
