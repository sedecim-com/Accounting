#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { Command, InvalidArgumentError, type CommanderError } from 'commander';
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
import {
  SUPERFICIE_DESATENDIDA,
  SUPERFICIE_DESATENDIDA_SANDBOX,
  SUPERFICIE_INGESTA,
} from '../ai/tools/superficie.js';
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
  CliError,
  ExitCode,
  type ExitCodeValue,
} from './kernel/index.js';
import { esAfirmativa, esNegativa, confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { registerSatCommands } from './sat-commands.js';
import { registerPendingCommands, renderAll } from './pending-command.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerAiCommand } from './ai-command.js';
import { registerLedgerCommand } from './ledger-command.js';
import { registerCfdiCommand } from './cfdi-command.js';
import { registerRepCommand } from './rep-command.js';
import { registerMemoryCommand } from './memory-command.js';
import { registerPromptSizeCommand } from './prompt-size-command.js';
import { registerInitCommand, runInitWizard, type InitWizardResult } from './init-command.js';
import { palette } from './palette.js';
import { detectSetupState, type SetupState } from './first-run.js';
import { renderBanner, type BannerInfo } from './banner.js';
import { registerCloseCommand } from './close-command.js';
import { registerCompletionCommand } from './completion-command.js';
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
import { registerReceiptCommand } from './receipt-command.js';
import { registerCreditNoteCommand } from './credit-note-command.js';
import { registerArCommand } from './ar-command.js';
import { registerApCommand } from './ap-command.js';
import { registerBankCommand } from './bank-command.js';
import { registerAssetCommand } from './asset-command.js';
import { registerDepreciationCommand } from './depreciation-command.js';
import { registerBatchCommand } from './batch-command.js';
import { registerClosingCommand } from './closing-command.js';
import { registerFxCommand } from './fx-command.js';
import { registerPrepaidCommand } from './prepaid-command.js';
import { registerEAccountingCommand } from './e-accounting-command.js';
import { registerDiotCommand } from './diot-command.js';
import { registerCashFlowCommand } from './cashflow-command.js';
import { registerAuditCommand } from './audit-command.js';
import { registerWebhookSweepCommand } from './webhook-sweep-command.js';
import { registerBackupCommand } from './backup-command.js';
import { registerReportCommand } from './report-command.js';
import { recordUsage, estimateCostUsd, clampTokenCount } from '../ai/usage-ledger.js';
import { registrarEventoEnSegundoPlano } from '../ai/agent-events.js';
import { conCorridaRegistrada } from '../ai/ingest-runs.js';
import type { TurnUsage } from '../ai/providers/types.js';
import type { RunAgentTurn } from '../ai/jobs/runner.js';
import {
  listDrafts,
  approveDraft,
  rejectDraft,
  resolveReviewer,
  DraftValidationError,
  canonicalDraftHash,
  diffDraftPayloads,
  rejectionPrecedent,
  type DraftRow,
  type DraftPayload,
  type DraftCorrection,
} from '../ai/draft-service.js';
import { teachMemory } from '../ai/memory-service.js';
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

/**
 * Única fuente de versión: package.json. Antes convivían dos números
 * (package.json decía 1.0.0 y aquí había un 0.1.0 a mano) y cada release
 * iba a tener que acordarse de tocar los dos. __dirname resuelve igual
 * desde src/cli (tsx) que desde dist/cli (compilado): ../../package.json.
 */
function versionDelPaquete(): string {
  try {
    const crudo = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8');
    const version = (JSON.parse(crudo) as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch {
    // Sin package.json legible (instalación rota) el número de respaldo
    // delata el problema en vez de inventar una versión plausible.
  }
  return '0.0.0';
}
export const CLI_VERSION = versionDelPaquete();

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

export function reportError(err: unknown): void {
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
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(ce.red(`\n${mensaje}`));
    // El redactor de remedios existía y solo lo veía el arranque desnudo
    // (renderBrokenFlow): cualquier otra hoja escupía «role postgres does
    // not exist» pelado. Aquí se cierra ese hueco: si el mensaje cae en una
    // categoría con remedio inequívoco, el comando que lo arregla sale en la
    // línea siguiente. Un CliError del kernel ya viene redactado con su
    // propio remedio — añadirle otro sería aconsejar dos veces.
    if (!(err instanceof CliError)) {
      const remedio = remedioParaMensaje(mensaje);
      if (remedio) console.error(`  → ${remedio}`);
    }
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
export function makeAskUser(rl: () => readline.Interface | undefined): AskUserFn {
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
      // EL MISMO CRITERIO QUE LA COLA, porque es la misma escritura: lo que
      // se teclee aquí lo graba recordAnsweredQuestion ya como precedente
      // firme. Un sí/no desnudo se repregunta en vez de convertirse en el
      // criterio; agotada la repregunta la duda queda PENDIENTE, que es lo
      // que ya significaba una respuesta en blanco en este prompt.
      for (let intento = 0; intento < 2; intento++) {
        const raw = await ask(iface, c.cyan('answer> '));
        if (raw === null) return null;
        const answer = raw.trim();
        if (!answer) return null;
        const idx = Number(answer);
        if (prompt.options && Number.isInteger(idx) && idx >= 1 && idx <= prompt.options.length) {
          return prompt.options[idx - 1];
        }
        if (!consentimientoDesnudo(answer)) return answer;
        console.log(ce.dim(criterioDesnudo(answer, prompt.options, false)));
      }
      console.log(ce.dim('Left pending: nothing was recorded as a precedent.'));
      return null;
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
  if (raw.trim() === '') return defaultYes;
  // La gramática del sí vive en el kernel: aquí sólo se decide el default.
  return esAfirmativa(raw);
}

/**
 * Categorized failure → action: every broken-state reason maps to the exact
 * command that repairs it. Database problems win — with the DB down, the
 * other diagnoses are unreliable.
 *
 * `enReporteDeError` marca qué categorías puede citar reportError ante un
 * error ARBITRARIO en cualquier hoja: la de base de datos sí (con la base
 * caída el remedio es siempre el mismo), pero «entidad» y «proveedor» no —
 * un «No active entity matches "Demmo"» es un dedazo, y mandarlo a
 * `init --section identity` sería aconsejar reconfigurar por un typo.
 */
const REMEDIOS: ReadonlyArray<{ patron: RegExp; comando: string; enReporteDeError: boolean }> = [
  {
    // Además de las palabras del arranque (databas/tunnel/migrat…), las
    // firmas crudas de pg y de la red: es lo que un error de conexión trae
    // en el mensaje cuando ninguna capa lo ha redactado todavía.
    patron:
      /databas|\bdb\b|connect|conexi|econn|tunnel|postgres|migrat|ssl|etimedout|enotfound|timed out|terminat|role "?[^"\s]+"? does not exist|password authentication/,
    comando: 'mnemosine doctor   (and check DATABASE_URL in .env)',
    enReporteDeError: true,
  },
  { patron: /entit|identity|rfc|tenant/, comando: 'mnemosine init --section identity', enReporteDeError: false },
  {
    patron: /provider|api.?key|model|credential|anthropic|ollama|hermes/,
    comando: 'mnemosine init --section ai',
    enReporteDeError: false,
  },
];

export function repairCommandFor(reason: string): string {
  const r = reason.toLowerCase();
  return REMEDIOS.find(({ patron }) => patron.test(r))?.comando ?? 'mnemosine doctor';
}

/**
 * El remedio que reportError puede añadir bajo un mensaje cualquiera, o null
 * cuando no hay categoría segura. A diferencia de repairCommandFor no tiene
 * respaldo genérico: rematar cada error desconocido con «mnemosine doctor»
 * sería ruido, no ayuda.
 */
export function remedioParaMensaje(mensaje: string): string | null {
  const r = mensaje.toLowerCase();
  const categoria = REMEDIOS.find(({ patron }) => patron.test(r));
  return categoria && categoria.enReporteDeError ? categoria.comando : null;
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

// ============================================================
// EL CONTRATO DE SALIDA TAMBIÉN CUBRE LOS ERRORES DE COMMANDER
//
// Sin `exitOverride`, todo error de USO —subcomando inexistente, bandera
// mal escrita, argumento faltante— muere en el `process.exit(1)` que
// commander lleva dentro (`_exit`, command.js:534). Dos daños, y el
// segundo es el caro:
//   · el código es 1 donde exit.ts promete 2 (USAGE), así que un guion
//     no puede distinguir un dedazo del usuario de un fallo del sistema; y
//   · el proceso muere SIN pasar por shutdown(), o sea sin drenar las
//     atestaciones en vuelo ni cerrar el pool. Las trece filas de la tabla
//     de exit.ts existían y la puerta de salida se saltaba doce.
//
// `exitOverride` convierte cada `_exit` de commander en una excepción que
// el catch de la entrada recoge y pasa por shutdown().
//
// EL DETALLE QUE MUERDE: exitOverride TAMBIÉN dispara en `--help` y en
// `--version`, que son salidas de ÉXITO. Mandarlas a 2 rompería todo
// guion que pida ayuda antes de decidir, así que el traductor las mira
// por `err.code` —el identificador estable que commander adjunta— y
// nunca por el texto del mensaje.
//
// LA INSTALACIÓN VA AQUÍ, pegada al constructor y antes del primer
// `.command()`: commander copia `_exitCallback` en el momento de CREAR
// cada subcomando (copyInheritedSettings, command.js:105) y nunca
// después. Instalarlo al final del archivo dejaría el árbol entero sin
// cubrir y sólo la raíz traduciría — que es justo el caso que menos
// duele, porque la raíz ya tiene su propia compuerta más abajo.
// ============================================================

/** Los `err.code` de commander que NO son un error: la ayuda y la versión. */
const SALIDAS_DE_COMMANDER_QUE_SON_EXITO = new Set([
  'commander.help', // `mnemosine help`, `mnemosine help report`
  'commander.helpDisplayed', // -h / --help en cualquier nivel
  'commander.version', // -V / --version
]);

/**
 * El código del contrato (exit.ts) para una salida de commander.
 *
 * Todo lo que no es ayuda ni versión es un error de USO: bandera
 * desconocida, subcomando inexistente, argumento faltante, argumento
 * inválido, opción obligatoria sin valor, opciones en conflicto,
 * demasiados argumentos. Los ocho tienen el mismo remedio —el usuario
 * vuelve a teclear— y por eso comparten código.
 *
 * Queda un noveno `err.code`, `commander.executeSubCommandAsync`, que no
 * es una salida sino el cierre de un subcomando EJECUTABLE lanzado con
 * spawn. En este árbol no puede dispararse: no hay una sola hoja de esa
 * forma, y hay prueba que lo fija (si alguien añade la primera, la prueba
 * se pone roja y este comentario deja de ser una promesa).
 */
export function codigoDeSalidaDeCommander(err: {
  code?: string;
  exitCode?: number;
}): ExitCodeValue {
  if (SALIDAS_DE_COMMANDER_QUE_SON_EXITO.has(err.code ?? '')) {
    // `help({ error: true })` imprime la ayuda A RAÍZ de un fallo y sale
    // con código distinto de cero: eso sigue siendo un uso mal escrito.
    return err.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
  }
  return ExitCode.USAGE;
}

/**
 * Lo que commander iba a hacer con process.exit, convertido en algo que
 * el cierre ordenado pueda atender. Lleva el código YA traducido porque
 * quien la recoge (el catch de la entrada) no debe volver a decidir.
 *
 * No es un CliError a propósito: un CliError significa «un comando falló
 * y hay que reportarlo», y aquí no hay nada que reportar — commander ya
 * escribió su línea en stderr antes de salir (`error()`, command.js:1953)
 * y --help/--version ya volcaron lo suyo en stdout.
 */
export class SalidaDeCommander extends Error {
  constructor(
    readonly codigo: ExitCodeValue,
    readonly origen: string
  ) {
    super(`commander exit (${origen})`);
    this.name = 'SalidaDeCommander';
  }
}

program.exitOverride((err: CommanderError) => {
  throw new SalidaDeCommander(codigoDeSalidaDeCommander(err), err.code);
});

// ============================================================
// LOS EJEMPLOS DE LAS HOJAS QUE VIVEN EN ESTE ARCHIVO
//
// Mismo trato que en report-command.ts y compañía: prosa en el idioma
// del nodo —estas hojas están en inglés— y datos mexicanos de verdad,
// el mismo reparto que ya usan los ejemplos de las otras familias
// (Molinos del Bajio como entidad, Papeleria del Centro como proveedor,
// cuentas del catálogo que chart-seed.ts siembra).
//
// Ninguna bandera de aquí está inventada: tests/cli/ejemplos-de-ayuda
// resuelve cada línea contra el árbol embarcado y falla si una hoja
// enseña una bandera que no declara.
// ============================================================
const EJEMPLOS = {
  entities: `
Examples:
  # The active legal entities of this tenant (\`entity list\` supersedes this).
  mnemosine entities
`,
  providers: `
Examples:
  # Which model providers are configured, and whether their API key is present.
  mnemosine providers
`,
  ask: `
Examples:
  # One question, one answer, no interactive session.
  mnemosine ask "Cuanto IVA acreditable acumule en julio"
  # Ask about one client, on a named provider.
  mnemosine ask "Saldo de la cuenta 1111 al cierre de julio" --entity "Molinos del Bajio" --provider anthropic
`,
  chat: `
Examples:
  # Open a session against the entity you last worked on.
  mnemosine chat
  # Pick up the transcript of this terminal's last session.
  mnemosine chat --continue
  # Resume one session by id (list them with \`mnemosine sessions\`).
  mnemosine chat --resume 6f1b0c2e-6d3a-4a8e-9a4c-2a3b4c5d6e7f
`,
  sessions: `
Examples:
  # The most recent chat sessions of the active entity.
  mnemosine sessions
  # The last five, for one client.
  mnemosine sessions --entity "Molinos del Bajio" --limit 5
`,
  drafts: `
Examples:
  # Every draft the AI created that nobody has looked at yet.
  mnemosine drafts --status pending_review
  # The rejected ones, for a named entity.
  mnemosine drafts --status rejected --entity "Molinos del Bajio SA de CV"
`,
  review: `
Examples:
  # Walk the pending drafts one by one; approving POSTS to the ledger.
  mnemosine review
  # See what would be posted without moving a balance.
  mnemosine review --dry-run
  # Attribute the review to a named reviewer and skip the prompt.
  mnemosine review --user contador@despacho.mx --yes
`,
  ingest: `
Examples:
  # Read a month of received CFDIs; everything lands as a draft to review.
  mnemosine ingest ./cfdi/julio/*.xml
  # See what it would classify, writing nothing and posting nothing.
  mnemosine ingest ./cfdi/julio/PCE180412TF4_A4471.xml --dry-run
  # Turn auto-posting OFF for this run, even if the firm's panel allows it.
  mnemosine ingest ./cfdi/julio/*.xml --no-auto-post --user contador@despacho.mx
  # Confirm the auto-posting the panel already authorized, with your own ceiling.
  mnemosine ingest ./cfdi/julio/*.xml --auto-post --min-confidence 0.95 --max-amount 20000
`,
  lang: `
Examples:
  # Which language the agent answers in right now.
  mnemosine lang
  # Make it answer in Spanish. The CLI interface stays English either way.
  mnemosine lang es
`,
  onboard: `
Examples:
  # Plan the import from the client's current system, writing nothing.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --dry-run
  # Bring in the chart and the opening balances; they wait as a draft.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --entity "Molinos del Bajio"
  # Post the opening entry now, balancing the remainder to prior-year results.
  mnemosine onboard --provider contalink --cutoff 2026-06-30 --balance-account 3200 --post --yes
`,
  outboxList: `
Examples:
  # The operations queued for the client's external system.
  mnemosine outbox list
  # Everything that failed, as JSON to attach to a ticket.
  mnemosine outbox list --status failed --json
`,
  outboxRun: `
Examples:
  # Work the queue interactively; nothing reaches the client's system yet.
  mnemosine outbox run --dry-run
  # Execute two operations FOR REAL against the client's system.
  mnemosine outbox run 3f2a9c14-8b0e-4d55-9c31-77a0d2f4b8e6 8a1c5d90-2b47-4e6f-b0d3-91e2a7c4f5b6 --live --yes
`,
  questionList: `
Examples:
  # The questions the agent is waiting on.
  mnemosine question list
  # The ones already answered, as CSV for the file.
  mnemosine question list --status answered --format csv
`,
  questionAnswer: `
Examples:
  # Work the pending queue one question at a time.
  mnemosine question answer
  # Answer one by id; the answer is stored as a precedent.
  mnemosine question answer 5d2e7a10-93cf-4b62-8a71-0c4e6f8b2d19 "Va a gastos: mantenimiento menor, no capitaliza"
  # Pick option 2 of the ones the question offers.
  mnemosine question answer 5d2e7a10-93cf-4b62-8a71-0c4e6f8b2d19 2
`,
  login: `
Examples:
  # Sign in with a browser.
  mnemosine login
  # On a server reached over SSH, with no browser to open.
  mnemosine login --device
`,
  logout: `
Examples:
  # Delete the credential stored on this machine.
  mnemosine logout
`,
  whoami: `
Examples:
  # Which credential is active, and how long it is good for.
  mnemosine whoami
`,
};

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
let chatDbInitError: Error | null = null;

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
    chatDbInitError = err instanceof Error ? err : new Error(String(err));
  }
});

program
  .command('entities')
  .alias('entidades')
  .description('Lists the active legal entities (deprecated: use `mnemosine entity list`)')
  .addHelpText('after', EJEMPLOS.entities)
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
      await shutdown(exitCodeFor(err));
    }
  });

program
  .command('providers')
  .alias('proveedores')
  .description('Lists the configured model providers (built-in + mnemosine.config.json)')
  .addHelpText('after', EJEMPLOS.providers)
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
      await shutdown(exitCodeFor(err));
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
  .addHelpText('after', EJEMPLOS.ask)
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
      await shutdown(exitCodeFor(err));
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
  .addHelpText('after', EJEMPLOS.chat)
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
          // FAILURE y no un código fino a propósito: `state.broken` agrupa
          // causas de máquina (no hay base, no hay credencial de modelo, las
          // migraciones no han corrido) que no comparten remedio ni familia.
          // Inventarles un 2 o un 5 sería mentir con más precisión.
          renderBrokenFlow(state);
          return shutdown(ExitCode.FAILURE);
        }
        // Fresh machine → inline rescue. A pipe cannot answer a wizard:
        // point at init and exit instead of hanging.
        if (!stdin.isTTY || !stdout.isTTY) {
          stderr.write('Not configured. Run: mnemosine init\n');
          // Misma razón: la máquina está sin configurar, que es un fallo
          // genérico del entorno y no un error de uso del que invoca.
          return shutdown(ExitCode.FAILURE);
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
          if (!resumed) throw notFound(`Session ${opts.resume} does not exist in this entity.`);
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
      await shutdown(exitCodeFor(err));
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
  .addHelpText('after', EJEMPLOS.sessions)
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
      await shutdown(exitCodeFor(err));
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
  .addHelpText('after', EJEMPLOS.drafts)
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
      await shutdown(exitCodeFor(err));
    }
  });

// ============================================================
// LA GRAMÁTICA DEL MENÚ DE REVISIÓN
//
// El prompt ofrecía «[a]pprove / [r]eject / [s]kip / [q]uit» y CUALQUIER otra
// tecla saltaba el borrador sin imprimir nada. Dos defectos en el mismo sitio:
//
//  · «s» es lo que un contador que trabaja en español teclea creyendo que
//    dice «sí». Creía haber aprobado y había saltado — y la tecla más
//    ambigua del menú era justo la que se tragaba la respuesta en silencio.
//  · Una respuesta no reconocida DECIDÍA (saltaba) en vez de repreguntar,
//    que es lo contrario de lo que aprendió el kernel de confirmación: lo
//    que no se entiende se vuelve a preguntar, nunca se interpreta.
//
// Este menú no es una pregunta de sí/no, así que ninguna respuesta del
// vocabulario de confirmación se interpreta como tecla: se nombra la
// ambigüedad —en los dos idiomas, porque en uno «s» es sí y en el otro es
// saltar, y son resultados opuestos— y se enseñan las teclas. Pasar al
// siguiente es ENTER, que no colisiona con ningún idioma.
//
// El «¿es un sí?» sale del kernel (esAfirmativa), no de un predicado nuevo:
// aquí se usa para RECHAZAR la respuesta, no para consentir nada.
// ============================================================

/** Lo que el revisor pidió, o la razón por la que no se entendió. */
type ReviewChoice =
  | { kind: 'approve' | 'edit' | 'reject' | 'next' | 'quit' }
  | { kind: 'unclear'; message: string };

const REVIEW_KEYS: Array<{ kind: 'approve' | 'edit' | 'reject' | 'next' | 'quit'; words: string[] }> = [
  { kind: 'approve', words: ['a', 'approve', 'aprobar'] },
  { kind: 'edit', words: ['e', 'edit', 'editar', 'corregir'] },
  { kind: 'reject', words: ['r', 'reject', 'rechazar'] },
  { kind: 'next', words: ['skip', 'saltar', 'siguiente', 'next'] },
  { kind: 'quit', words: ['q', 'quit', 'exit', 'salir'] },
];

const REVIEW_MENU =
  '\n[a]pprove and post  [e]dit then approve  [r]eject  ENTER next  [q]uit > ';

function reviewMenuChoice(raw: string): ReviewChoice {
  const dicho = raw.trim();
  const t = dicho
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (t === '') return { kind: 'next' }; // ENTER: pasa al siguiente, sin tocar nada
  for (const { kind, words } of REVIEW_KEYS) {
    if (words.includes(t)) return { kind };
  }
  if (esAfirmativa(t)) {
    return {
      kind: 'unclear',
      message:
        `«${dicho}» is a yes, and this is not a yes/no question: in Spanish it reads as «sí» and ` +
        'in English as «skip» — opposite outcomes. Type `a` to approve AND POST, or press ENTER ' +
        'to move on without touching this draft.',
    };
  }
  return { kind: 'unclear', message: `I did not understand «${dicho}»; the keys are above.` };
}

/**
 * Pregunta el menú y concede UNA repregunta a lo que no se entendió. El tope
 * es deliberado, igual que en confirmarConReintento: un prompt que insiste sin
 * límite contra una stdin que repite basura es un ciclo infinito en un cron.
 * Agotada la repregunta NO decide nada — devuelve el «no entendí» para que
 * quien llama lo DIGA y deje el borrador intacto. Null es EOF.
 */
async function askReviewMenu(
  preguntar: (prompt: string) => Promise<string | null>
): Promise<ReviewChoice | null> {
  let ultimo: ReviewChoice = { kind: 'unclear', message: '' };
  for (let intento = 0; intento < 2; intento++) {
    const raw = await preguntar(c.cyan(REVIEW_MENU));
    if (raw === null) return null;
    const choice = reviewMenuChoice(raw);
    if (choice.kind !== 'unclear') return choice;
    console.log(ce.dim(choice.message));
    ultimo = choice;
  }
  return ultimo;
}

/** Palabras que abren la edición de la descripción del asiento. */
const DESC_WORDS = ['d', 'desc', 'description', 'descripcion'];

/** Cómo se lee una línea mientras se corrige. */
function editorLine(l: { account_code?: string; debit?: number; credit?: number }): string {
  const side =
    typeof l.debit === 'number'
      ? `debit  ${l.debit.toFixed(2)}`
      : typeof l.credit === 'number'
        ? `credit ${l.credit.toFixed(2)}`
        : 'no amount';
  return `${String(l.account_code ?? '??').padEnd(10)} ${side}`;
}

/**
 * CORREGIR ANTES DE APROBAR.
 *
 * Guiado, sin gramática que memorizar: se elige una línea (o «d» para la
 * descripción) y se contesta lo nuevo; en blanco se conserva lo que había.
 * Trabaja sobre una COPIA — el borrador de la cola no se toca, porque el
 * original es lo que el modelo propuso y de ahí sale el diff.
 *
 * EOF aborta la corrección entera: una stdin que se cierra a media edición no
 * puede acabar en una aprobación a medias.
 */
async function editDraftPayload(
  preguntar: (prompt: string) => Promise<string | null>,
  original: DraftPayload
): Promise<{ abort: true } | { abort: false; payload: DraftPayload }> {
  const edited: DraftPayload = {
    ...original,
    lines: (Array.isArray(original.lines) ? original.lines : []).map((l) => ({ ...l })),
  };
  let sinEntender = 0;
  for (;;) {
    console.log(c.dim(`  description: ${edited.description}`));
    edited.lines.forEach((l, i) => console.log(c.dim(`  ${i + 1}) ${editorLine(l)}`)));

    const raw = await preguntar(
      c.cyan(`Correct which line? (1-${edited.lines.length}, «d» description, ENTER done) > `)
    );
    if (raw === null) return { abort: true };
    const t = raw.trim().toLowerCase();
    if (t === '') return { abort: false, payload: edited };

    if (DESC_WORDS.includes(t)) {
      const nueva = await preguntar(c.cyan(`New description (ENTER keeps «${edited.description}») > `));
      if (nueva === null) return { abort: true };
      if (nueva.trim() !== '') edited.description = nueva.trim();
      sinEntender = 0;
      continue;
    }

    const n = /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > edited.lines.length) {
      if (++sinEntender >= 2) {
        console.log(ce.dim('Still not understood; leaving the editor with what was corrected so far.'));
        return { abort: false, payload: edited };
      }
      console.log(
        ce.dim(`I did not understand «${raw.trim()}»: a line number 1-${edited.lines.length}, «d», or ENTER.`)
      );
      continue;
    }
    sinEntender = 0;

    const line = edited.lines[n - 1];
    const code = await preguntar(
      c.cyan(`Line ${n} account code (ENTER keeps «${line.account_code ?? ''}») > `)
    );
    if (code === null) return { abort: true };
    if (code.trim() !== '') line.account_code = code.trim();

    const esDebito = typeof line.debit === 'number';
    const actual = esDebito ? line.debit : line.credit;
    const monto = await preguntar(
      c.cyan(
        `Line ${n} ${esDebito ? 'debit' : 'credit'} amount ` +
          `(ENTER keeps ${typeof actual === 'number' ? actual.toFixed(2) : '—'}) > `
      )
    );
    if (monto === null) return { abort: true };
    if (monto.trim() !== '') {
      const v = Number(monto.trim());
      if (!Number.isFinite(v) || v <= 0) {
        // No se inventa un importe: se dice y se conserva el que había. El
        // cuadre lo vuelve a juzgar el motor al aprobar, no este prompt.
        console.log(ce.dim(`«${monto.trim()}» is not a positive amount; line ${n} keeps what it had.`));
      } else if (esDebito) {
        line.debit = v;
      } else {
        line.credit = v;
      }
    }
  }
}

/**
 * TRAS UN RECHAZO, OFRECER SEMBRAR EL PRECEDENTE.
 *
 * El motivo del rechazo ya se escribía en ai_drafts.review_notes, y esa
 * columna no la lee nadie que enseñe: el digest que entra al prompt de cada
 * sesión sale SÓLO de ai_questions. Catorce rechazos con motivo escrito no
 * llegaban a ningún sitio, y el contador rechazaba el mismo error catorce
 * veces y concluía, con razón, que el agente no aprende.
 *
 * Lo que esto NO hace es sembrar solo. Enseña el precedente que se sembraría,
 * pregunta, y sólo un sí explícito llama a teachMemory —la MISMA vía humana
 * que usa `mnemosine memory teach`, reutilizada, no duplicada— atribuido al
 * revisor que lo dijo. El default del [y/N] es no, y un EOF también lo es.
 */
async function offerToSeedPrecedent(
  preguntar: (prompt: string) => Promise<string | null>,
  ctx: AgentContext,
  reviewer: { email: string },
  draft: DraftRow,
  reason: string
): Promise<boolean> {
  const propuesta = rejectionPrecedent(draft, reason);
  console.log(c.dim('  Precedent this could seed, so the AI stops repeating it:'));
  console.log(c.dim(`    when: ${propuesta.rule}`));
  console.log(c.dim(`    then: ${propuesta.criterion}`));
  const veredicto = await confirmarConReintento(
    preguntar,
    c.cyan('  Seed it as a firm criterion, attributed to you? [y/N] ')
  );
  if (!veredicto.si) {
    console.log(c.dim('  Not seeded: the rejection stands and nothing was taught.'));
    return false;
  }
  try {
    const id = await teachMemory(ctx, {
      rule: propuesta.rule,
      criterion: propuesta.criterion,
      taughtBy: reviewer.email,
    });
    console.log(`  ✔ Criterion seeded by ${reviewer.email}; review it with: mnemosine memory`);
    console.log(c.dim(`    id: ${id}`));
    return true;
  } catch (err) {
    reportError(err);
    console.log(c.dim('  The rejection stands; the criterion was not seeded.'));
    return false;
  }
}

const review = program
  .command('review')
  .alias('revisar')
  .description(
    'Reviews pending drafts: approve (creates and posts the journal entry), ' +
      'correct then approve, or reject — a rejection can seed the criterion for next time'
  )
  .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
  .option('-u, --user <email>', 'Reviewer email (default: first active user of the tenant)')
  .addHelpText('after', EJEMPLOS.review);
// Aprobar POSTEA al mayor: irreversible, declarado junto a su registro (S0.6;
// antes vivía en la tabla de retrofit). El kernel añade --dry-run, --yes e
// --idempotency-key y le niega el comando al agente.
declareRisk(review, {
  risk: 'irreversible',
  agent: false,
  writes:
    'journal_entries + journal_entry_lines POSTEADOS al aprobar un borrador; ' +
    'ai_questions al sembrar un precedente que el revisor confirmó tras un rechazo',
});
review.action(async (opts: { entity?: string; user?: string; yes?: boolean; idempotencyKey?: string }) => {
    let rl: readline.Interface | undefined;
    try {
      const ctx = await resolveEntity(opts.entity);
      const { dryRun } = gateMutation(review, opts);
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

      const preguntar = (prompt: string): Promise<string | null> => ask(rl!, prompt);

      let approved = 0;
      let corrected = 0;
      let rejected = 0;
      let seeded = 0;
      for (let i = 0; i < pending.length; i++) {
        renderDraft(pending[i], i, pending.length);
        const choice = await askReviewMenu(preguntar);
        if (choice === null) break; // stdin EOF: stop cleanly instead of hanging
        if (choice.kind === 'quit') break;
        if (choice.kind === 'unclear') {
          // Antes esto no imprimía NADA: el borrador se saltaba en silencio.
          console.log(c.dim('Nothing was done to this draft; moving on to the next one.'));
          continue;
        }
        if (choice.kind === 'next') {
          console.log(c.dim('Skipped: the draft stays pending.'));
          continue;
        }

        // El hash de lo que el revisor VIO. Ata la aprobación —corregida o
        // no— a ese contenido exacto: si el payload cambia en medio, aborta.
        const baseHash = canonicalDraftHash(pending[i].payload);

        if (choice.kind === 'approve' || choice.kind === 'edit') {
          let correction: DraftCorrection | undefined;
          if (choice.kind === 'edit') {
            const edit = await editDraftPayload(preguntar, pending[i].payload);
            if (edit.abort) break; // EOF a media corrección: no se aprueba nada
            const diff = diffDraftPayloads(pending[i].payload, edit.payload);
            if (diff.length === 0) {
              console.log(c.dim('Nothing changed: it would post exactly as the model proposed.'));
            } else {
              console.log(c.bold('\nModel → you:'));
              for (const d of diff) console.log(`  ${d}`);
              // El servicio recalcula approved_content_hash sobre ESTA
              // versión: la columna tiene que decir lo que el humano aprobó.
              correction = { payload: edit.payload, basedOnHash: baseHash };
            }
            // EL HUMANO DISPONE: corregir no aprueba. La aprobación se pide
            // aparte, con la gramática única de confirmación del kernel.
            const veredicto = await confirmarConReintento(
              preguntar,
              c.cyan('Approve and post THIS version? [y/N] ')
            );
            if (!veredicto.si) {
              console.log(c.dim('Not approved: the correction is discarded and the draft stays pending.'));
              continue;
            }
          }
          try {
            const posted = await approveDraft(
              ctx, pending[i].id, reviewer, undefined, baseHash, correction
            );
            approved++;
            if (correction) corrected++;
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
          continue;
        }

        const decision = rejectionReasonFrom(await preguntar(c.cyan('Rejection reason: ')));
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
          continue;
        }
        // Un rechazo con motivo escrito y nadie que lo lea era el agente que
        // no aprende. Se OFRECE; siembra sólo si el humano lo confirma.
        if (await offerToSeedPrecedent(preguntar, ctx, reviewer, pending[i], decision.reason)) {
          seeded++;
        }
      }

      rl.close();
      console.log(
        c.dim(
          `\nDone: ${approved} approved (${corrected} corrected first), ` +
            `${rejected} rejected, ${seeded} criteria seeded.`
        )
      );
      await shutdown(0);
    } catch (err) {
      rl?.close();
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(exitCodeFor(err));
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
  .option('--max-amount <n>', 'Maximum auto-postable amount', parseFloat)
  .addHelpText('after', EJEMPLOS.ingest);
// Irreversible por su camino más grave (el auto-posteo), declarado junto a su
// registro (S0.6). El plan de cierre proponía partirlo por bandera, pero S0.3
// lo dejó atrás: el auto-posteo no lo decide una bandera sino el panel del
// despacho. Desde A7 la relación entre capas es una ASIMETRÍA y no un orden:
// `--no-auto-post` apaga siempre (apagar es local), y `--auto-post` sólo
// confirma lo que el panel ya autorizó — encender rodearía la compuerta de
// evidencia, que es lo único que separa «medimos» de «posteamos».
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
      // A7: lo que la capa local pidió y el panel no autoriza no desaparece en
      // silencio. Sin esto, un operador con `"auto_post": true` en su json
      // creería que su corrida auto-postea y no entendería por qué no pasa
      // nada — o peor, creería que el sistema le falla.
      if (thresholds.encendidoIgnorado) {
        console.error(
          c.yellow(
            'Aviso: el auto-posteo pedido por bandera o por mnemosine.config.json se IGNORA: ' +
              'el panel del despacho no lo autoriza.'
          ) +
            c.dim(
              '\n  Encender es del panel (`mnemosine pending`), y exige la evidencia de sombra. ' +
                'Apagar sí puede ser local.'
            )
        );
      }
      const { dryRun } = gateMutation(ingest, opts);

      if (dryRun) {
        // La capa determinista, sin escribir NADA y sin llamar a nadie: ni
        // xml_documents, ni el validador del SAT, ni el modelo. Se dice lo
        // que no se calculó: las reglas del despacho, la clasificación IA y
        // el plan de asiento se deciden en la corrida real.
        const preview = await previewCfdiFiles({ files, thresholds, entityId: ctx.entityId });
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
      // `capture.drafts` se VACÍA en cada archivo (ingest-service lo reinicia
      // antes de cada turno), así que no sirve para saber cuántos borradores
      // lleva la corrida. Este contador sí: cuenta cada aviso de borrador
      // creado desde que empezó. Sólo se usa en el camino de la MUERTE — el
      // camino feliz sigue contando sobre report.results, que es la misma
      // verdad medida donde siempre se midió.
      const borradoresCapturados = { n: 0 };
      const callbacks = makeCallbacks(undefined, (info) => {
        capture.drafts.push(info);
        borradoresCapturados.n++;
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
        // A7·3 · y con su superficie NOMBRADA. Esta hoja construía su sesión
        // por su cuenta y no pasaba lista: recibía TODAS las herramientas
        // porque nadie se lo impidió. Hoy no es una fuga —ninguna postea—,
        // pero es propiedad por accidente en el ÚNICO camino que puede
        // postear al mayor sin humano cuando el panel autoriza el auto-posteo.
        // No es la desatendida: la ingesta clasifica comprobantes, no
        // concilia ni reporta, y su lista propia (tools/superficie.ts) deja
        // fuera el brazo externo entero y los estados financieros. Una
        // herramienta nueva nace excluida de la ingesta hasta que alguien la
        // añada a esa lista, y eso es una línea en un diff que se revisa.
        herramientas: SUPERFICIE_INGESTA,
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
      // A7·3: LA FILA SE ABRE ANTES DEL BUCLE Y SE CIERRA DESPUÉS — también
      // por el camino de la excepción. Antes se insertaba al final, con los
      // contadores ya finales: una corrida de 2 000 CFDI que moría en el
      // archivo 1 500 dejaba mil quinientos borradores en la base y CERO
      // filas de corrida, y a la mañana siguiente no había nada que dijera
      // qué corrida los produjo. Ahora la fila nace en 'running' y muere
      // diciendo cómo murió.
      //
      // El registro sigue siendo BEST-EFFORT: si la apertura falla, la
      // ingesta corre igual. Lo que ya no pasa es que el fallo se pierda —
      // sale en amarillo por la salida donde esta hoja avisa (no un stderr en
      // gris que nadie lee) y se repite junto al Summary, que es lo último
      // que el operador mira tras una corrida larga.
      const fila = { id: null as string | null };
      const avisosDeRegistro: string[] = [];
      const report = await conCorridaRegistrada({
        ctx,
        apertura: {
          provider: profile.name,
          model: profile.model,
          filesTotal: files.length,
          autoPostEnabled: thresholds.autoPost,
          createdBy: reviewer.email,
        },
        cuerpo: (corridaId) => {
          fila.id = corridaId;
          return ingestCfdiFiles({
            ctx, reviewer, files, thresholds, session, capture,
            onProgress: (msg) => stderr.write(ce.dim(`\n── ${msg}\n`)),
          });
        },
        // Si la corrida reventó (`resultado` null) NO se inventan counts: se
        // omiten, las columnas conservan su DEFAULT 0 y el status 'failed' es
        // lo que dice que esos ceros son «no se llegó a contar». Lo que sí se
        // escribe es lo que este proceso midió de verdad: el consumo del
        // modelo y los borradores que alcanzó a crear.
        cierre: (resultado) => ({
          counts: resultado?.counts,
          sospechaCount: resultado
            ? resultado.results.filter((r) => (r.sospechas?.length ?? 0) > 0).length
            : 0,
          draftsCreated: resultado
            ? resultado.results.filter((r) => r.draftId).length
            : borradoresCapturados.n,
          inputTokens: consumo.input,
          outputTokens: consumo.output,
          estimatedCostUsd: consumo.costoConocido ? consumo.costo : null,
          durationMs: Date.now() - corridaInicio,
        }),
        onAviso: (mensaje) => {
          avisosDeRegistro.push(mensaje);
          console.error(c.yellow(`Aviso: ${mensaje}`));
        },
      });

      // A2: cada CFDI sospechoso deja evento con sus campos marcados, ligado
      // a la fila de su corrida (null si la apertura no llegó a escribirse).
      for (const r of report.results) {
        if ((r.sospechas?.length ?? 0) > 0) {
          registrarEventoEnSegundoPlano(ctx, {
            kind: 'sospecha',
            provider: profile.name,
            detail: { archivo: r.file, campos: r.sospechas, corrida: fila.id },
          });
        }
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
      // El registro es best-effort y NO cambia el código de salida — los CFDI
      // clasificados son verdad aunque la anotación falle. Pero el operador se
      // entera aquí, donde mira, y no sólo cuando pasó hace veinte minutos.
      for (const aviso of avisosDeRegistro) {
        console.error(c.yellow(`⚠ ${aviso}`));
      }

      await shutdown(cnt.error + cnt.invalid > 0 ? 1 : 0);
    } catch (err) {
      if (isInterrupt(err)) await shutdown(130);
      reportError(err);
      await shutdown(exitCodeFor(err));
    }
  });

program
  .command('lang')
  .alias('idioma')
  .description("Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)")
  .argument('[language]', "'en' or 'es'; omit to show the current setting")
  .addHelpText('after', EJEMPLOS.lang)
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
        throw usageError(`Unsupported language "${language}". Options: en, es`);
      }
      await shutdown(0);
    } catch (err) {
      reportError(err);
      await shutdown(exitCodeFor(err));
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
  .option('--dry-run', 'Only show the plan, without executing anything')
  .addHelpText('after', EJEMPLOS.onboard);
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.cutoff)) throw usageError('--cutoff must be YYYY-MM-DD');
      const startDate = opts.from ?? `${opts.cutoff.slice(0, 4)}-01-01`;
      const ctx = await resolveEntity(opts.entity);
      const { dryRun } = gateMutation(onboard, opts);
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
        const rlOnboard = rl;
        const veredicto = await confirmarConReintento(
          (q) => ask(rlOnboard, q),
          c.cyan(`\n${pregunta} [y/N] > `)
        );
        if (!veredicto.si) {
          console.log(
            c.dim(
              veredicto.incomprendida !== undefined
                ? `${noEntendi(veredicto.incomprendida)} — Cancelled.`
                : 'Cancelled.'
            )
          );
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
    const { dryRun, live } = gateMutation(cmd, opts);
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
          const rlOutbox = rl;
          const veredicto = await confirmarConReintento(
            (q) => ask(rlOutbox, q),
            c.cyan('\nExecute in the external system? [y/N] > ')
          );
          rl.close();
          rl = undefined;
          if (!veredicto.si) {
            console.log(
              c.dim(
                veredicto.incomprendida !== undefined
                  ? `${noEntendi(veredicto.incomprendida)} — Skipped.`
                  : 'Skipped.'
              )
            );
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
  .description('List queued external operations (default: pending)')
  .addHelpText('after', EJEMPLOS.outboxList);
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
  .option('-u, --user <email>', 'Who executes (default: sole active user of the tenant)')
  .addHelpText('after', EJEMPLOS.outboxRun);
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

// ============================================================
// LA GRAMÁTICA DE LA COLA DE PREGUNTAS
//
// El prompt ofrecía «[answer / option number / s=skip / d=dismiss / q=quit]»
// y todo lo que no fuera una de esas teclas se tomaba como LA RESPUESTA. Dos
// consecuencias en el mismo sitio:
//
//  · «s» era saltar, que es justo lo que teclea en español quien cree decir
//    «sí» — el mismo defecto que `review` corrigió un comando más allá.
//  · Cualquier OTRA palabra de consentimiento —«si», «sí», «y», «yes»— no era
//    tecla, así que se INSERTABA como respuesta. Y una respuesta aquí no es
//    una respuesta cualquiera: answerQuestion la graba con is_precedent=true
//    y buildMemoryDigest la imprime en el prompt de TODAS las sesiones
//    siguientes. El contador que tecleaba «si» creyendo que consentía
//    plantaba un precedente FIRME cuyo criterio era la palabra «si».
//
// POR QUÉ ESTE BUCLE NO PUEDE COPIAR AL DE `review`. Allí toda respuesta es
// una TECLA de menú y lo no reconocido se repregunta entero. Aquí el TEXTO
// LIBRE ES la respuesta legítima —es el canal por el que el despacho enseña
// su criterio—, así que repreguntarlo todo rompería el comando. La frontera
// no es «tecla vs. resto», sino «está contestando la PREGUNTA» vs. «cree
// estar contestando al MENÚ», y una respuesta que coincide con una palabra
// de consentimiento cae justo encima de esa frontera.
//
// SE RESUELVE ASÍ, y la asimetría entre las dos reglas es deliberada:
//
//  1. Un sí/no DESNUDO nunca se acepta como respuesta, ni siquiera repetido.
//     No es sólo que sea ambiguo con el menú: es que como criterio está
//     VACÍO. El digest imprime `topic ?? question: answer`, y con topic —que
//     el modelo casi siempre pone— la línea que le queda al agente es
//     «clasificacion:Telmex: si». Un precedente firme no puede nacer de una
//     ambigüedad, y menos de una que no dice nada. La salida se enseña en la
//     misma repregunta: el número de una opción (elegirla SÍ es inequívoco,
//     aunque la opción se llame «Sí, se deduce»), o el criterio en palabras.
//     Si la pregunta era de sí/no, el sí con su porqué —«sí, se deduce al
//     100%»— es exactamente lo que el agente necesita leer en seis semanas.
//  2. Un número fuera del rango de opciones —«5» donde hay tres— sí tiene
//     contenido: puede ser un dedazo del índice o una cuenta («5201», que
//     hasta hoy entraba tal cual). Se repregunta UNA vez nombrando el rango
//     y se acepta literal si se repite. Repetirlo después de leer el aviso
//     es una confirmación informada, no un silencio que se toma por permiso;
//     y no abre puerta al sí desnudo, porque la regla 1 se evalúa antes y no
//     tiene excepción por insistencia.
//  3. Pasar de largo es ENTER, que no colisiona con ningún idioma. «s» deja
//     de ser tecla: cae en la regla 1 y se repregunta.
//
// Agotada la repregunta NO se decide nada: la pregunta queda pendiente. El
// «¿es un sí?» sale del kernel (esAfirmativa/esNegativa) y no de un predicado
// nuevo; aquí se usa para RECHAZAR una respuesta, jamás para consentir.
// ============================================================

/** Minúsculas y sin marcas diacríticas: «SÍ» y «si» son la misma palabra. */
const normalizaTecla = (s: string): string =>
  s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * ¿Es un sí/no a secas? Ni sirve de criterio ni se distingue de un intento de
 * contestar al menú. Sale del kernel para que la gramática del «sí» siga
 * siendo UNA sola en todo el CLI.
 */
function consentimientoDesnudo(texto: string): boolean {
  return esAfirmativa(texto) || esNegativa(texto);
}

/** Lo que se le dice a quien contesta «si» donde la respuesta se vuelve memoria firme. */
function criterioDesnudo(
  dicho: string,
  options: string[] | null | undefined,
  enMenu: boolean
): string {
  const salidas = options?.length
    ? `an option number (1-${options.length}), or the criterion in words`
    : 'the criterion in words';
  return (
    `«${dicho}» is a bare yes/no` +
    (enMenu ? ', and this prompt is also a menu — I cannot tell it from a keystroke' : '') +
    '. What you type here is SAVED AS A FIRM PRECEDENT and enters the prompt of every later ' +
    `session, so «${dicho}» would be the whole criterion the agent gets to read. ` +
    `Answer with ${salidas} (e.g. «sí, se deduce al 100%»); ENTER leaves the question pending.`
  );
}

/** Lo que el contador quiso decir en el prompt de la cola de preguntas. */
type QuestionReply =
  | { kind: 'answer'; answer: string }
  | { kind: 'skip' | 'dismiss' | 'quit' }
  | { kind: 'unclear'; message: string };

const QUESTION_KEYS: Array<{ kind: 'skip' | 'dismiss' | 'quit'; words: string[] }> = [
  { kind: 'skip', words: ['skip', 'saltar', 'siguiente', 'next'] },
  { kind: 'dismiss', words: ['d', 'dismiss', 'descartar'] },
  { kind: 'quit', words: ['q', 'quit', 'exit', 'salir'] },
];

const QUESTION_MENU = '\n[answer / option number / ENTER=skip / d=dismiss / q=quit] > ';

/**
 * Interpreta UNA línea del prompt. `insistido` es true sólo cuando se repite
 * al pie de la letra lo que ya se avisó; abre la regla 2 y nunca la 1.
 */
function questionReply(
  raw: string,
  options: string[] | null | undefined,
  opts: { insistido?: boolean } = {}
): QuestionReply {
  const dicho = raw.trim();
  const t = normalizaTecla(dicho);
  if (t === '') return { kind: 'skip' };
  for (const { kind, words } of QUESTION_KEYS) {
    if (words.includes(t)) return { kind };
  }
  if (consentimientoDesnudo(t)) {
    return { kind: 'unclear', message: criterioDesnudo(dicho, options, true) };
  }
  const idx = Number(t);
  if (options?.length && Number.isInteger(idx)) {
    if (idx >= 1 && idx <= options.length) return { kind: 'answer', answer: options[idx - 1] };
    if (!opts.insistido) {
      return {
        kind: 'unclear',
        message:
          `There is no option «${dicho}»: this question offers 1-${options.length}. ` +
          `Type one of those, or repeat «${dicho}» to record it verbatim as the answer.`,
      };
    }
  }
  return { kind: 'answer', answer: dicho };
}

/**
 * Pregunta y concede UNA repregunta a lo que no se pudo leer. El tope es
 * deliberado, igual que en confirmarConReintento: un prompt que insiste sin
 * límite contra una stdin que repite basura es un ciclo infinito en un cron.
 * Agotada la repregunta NO decide: devuelve el «no entendí» para que quien
 * llama lo diga y deje la pregunta pendiente. Null es EOF.
 */
async function askQuestionReply(
  preguntar: (prompt: string) => Promise<string | null>,
  options: string[] | null | undefined
): Promise<QuestionReply | null> {
  let anterior: string | null = null;
  let ultimo: QuestionReply = { kind: 'unclear', message: '' };
  for (let intento = 0; intento < 2; intento++) {
    const raw = await preguntar(c.cyan(QUESTION_MENU));
    if (raw === null) return null;
    const dicho = raw.trim();
    const reply = questionReply(dicho, options, {
      insistido: anterior !== null && normalizaTecla(anterior) === normalizaTecla(dicho),
    });
    if (reply.kind !== 'unclear') return reply;
    console.log(ce.dim(reply.message));
    anterior = dicho;
    ultimo = reply;
  }
  return ultimo;
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

    const preguntar = (prompt: string): Promise<string | null> => ask(rl!, prompt);

    let answered = 0;
    let dismissed = 0;
    for (let i = 0; i < pending.length; i++) {
      const q = pending[i];
      renderQuestion(q, i, pending.length);
      const reply = await askQuestionReply(preguntar, q.options);
      if (reply === null) break; // stdin EOF: stop cleanly instead of hanging
      if (reply.kind === 'quit') break;
      if (reply.kind === 'skip') {
        console.log(c.dim('Skipped: the question stays pending.'));
        continue;
      }
      if (reply.kind === 'unclear') {
        // Aquí estaba el defecto: esto ENTRABA como respuesta y sembraba un
        // precedente firme con la palabra que nadie supo leer.
        console.log(c.dim('Nothing recorded: the question stays pending, and no precedent was seeded.'));
        continue;
      }

      try {
        // En positivo, no por descarte: es lo único que estrecha el tipo
        // hasta la rama que trae texto, y así el compilador vigila que sólo
        // se grabe como respuesta lo que el intérprete llamó respuesta.
        if (reply.kind === 'answer') {
          await answerQuestion(ctx, q.id, reply.answer, reviewer.email);
          answered++;
          console.log(`✔ Answered and saved as a precedent: ${c.bold(reply.answer)}`);
        } else {
          await dismissQuestion(ctx, q.id, reviewer.email);
          dismissed++;
          console.log(c.dim('Question dismissed.'));
        }
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
  .description("List the agent's questions (default: pending)")
  .addHelpText('after', EJEMPLOS.questionList);
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
  .option('-u, --user <email>', 'Who answers (default: sole active user of the tenant)')
  .addHelpText('after', EJEMPLOS.questionAnswer);
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
    // Por argumento no hay menú que confundir, pero la OTRA mitad de la regla
    // sigue en pie: lo que entre aquí se graba con is_precedent=true. Un sí/no
    // desnudo —y un blanco, que hasta hoy pasaba como respuesta vacía— no es
    // un criterio, y no hay repregunta posible en un comando no interactivo:
    // se rechaza enseñando cómo se dice. Elegir una opción por su número es
    // inequívoco aunque la opción se llame «Sí»: eso no pasa por el filtro.
    const opciones = q.options ?? [];
    const idx = Number(line);
    const esOpcion = Number.isInteger(idx) && idx >= 1 && idx <= opciones.length;
    if (line === '') {
      throw usageError('question answer <id> needs the answer: mnemosine question answer <id> "<text or option number>"');
    }
    if (!esOpcion && consentimientoDesnudo(line)) {
      throw usageError(criterioDesnudo(line, q.options, false));
    }
    const answer = esOpcion ? opciones[idx - 1] : line;
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
  .addHelpText('after', EJEMPLOS.login)
  .action(async (opts: { device?: boolean }) => {
    try {
      if (!config.auth.enabled) {
        console.error(ce.red('OIDC is not configured.'));
        console.error('Set AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID and AUTH_OIDC_AUDIENCE in your .env.');
        // Entorno sin configurar, igual que los dos de arriba: FAILURE.
        await shutdown(ExitCode.FAILURE);
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
      await shutdown(exitCodeFor(err));
    }
  });

program
  .command('logout')
  .alias('salir')
  .description('Deletes the stored credential')
  .addHelpText('after', EJEMPLOS.logout)
  .action(async () => {
    await clearToken();
    console.log('Signed out.');
    await shutdown(0);
  });

program
  .command('whoami')
  .alias('quien')
  .description('Shows the active credential and its validity')
  .addHelpText('after', EJEMPLOS.whoami)
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
registerReceiptCommand(program, { palette: c, shutdown, reportError });
registerCreditNoteCommand(program, { palette: c, shutdown, reportError });
registerArCommand(program, { palette: c, shutdown, reportError });
registerApCommand(program, { palette: c, shutdown, reportError });
registerBankCommand(program, { palette: c, shutdown, reportError });
registerAssetCommand(program, { palette: c, shutdown, reportError });
registerDepreciationCommand(program, { palette: c, shutdown, reportError });
registerBatchCommand(program, { palette: c, shutdown, reportError });
registerClosingCommand(program, { palette: c, shutdown, reportError });
registerFxCommand(program, { palette: c, shutdown, reportError });
registerPrepaidCommand(program, { palette: c, shutdown, reportError });
registerEAccountingCommand(program, { palette: c, shutdown, reportError });
registerDiotCommand(program, { palette: c, shutdown, reportError });
registerCashFlowCommand(program, { palette: c, shutdown, reportError });
registerAuditCommand(program, { palette: c, shutdown, reportError });
// G4b · el barrido de entregas SALIENTES. Cuelga de `subscription`·`suscripcion`,
// que es la familia de SALIDA del catálogo — `webhooks`·`ganchos` es la de
// ENTRADA (tokens que despiertan al agente lector) y son tablas distintas: el
// mismo sustantivo para las dos cosas habría sido el defecto de nombre que
// esta casa lleva un mes cazando en otras formas.
const subscription = program
  .command('subscription')
  .alias('suscripcion')
  .description('Outbound event subscriptions: who we notify, and what we could not deliver');
registerWebhookSweepCommand(subscription, { palette: c, shutdown, reportError });
registerBackupCommand(program, { palette: c, shutdown, reportError });
registerReportCommand(program, { palette: c, shutdown, reportError });
registerLedgerCommand(program, { palette: c, shutdown, reportError });
registerCfdiCommand(program, { palette: c, shutdown, reportError });
registerRepCommand(program, { palette: c, shutdown, reportError });
registerAiCommand(program, { palette: c, shutdown, reportError });
registerUsageCommand(program, { palette: c, shutdown, reportError });
registerStatusCommand(program, { palette: c, shutdown, reportError });
registerJobsCommand(program, { palette: c, shutdown, reportError, makeRunAgentTurn });
registerSkillsCommand(program, { palette: c, shutdown, reportError });
registerWebhooksCommand(program, { palette: c, shutdown, reportError });
registerInitCommand(program, { palette: c, shutdown, reportError });
registerCloseCommand(program, { palette: c, shutdown, reportError });
// Va el ÚLTIMO a propósito: su guion se genera del árbol vivo en tiempo de
// acción, así que el orden de registro no lo condiciona, pero registrarlo al
// final deja escrito que completa todo lo de arriba y no un árbol a medias.
registerCompletionCommand(program, { palette: c, shutdown, reportError });
// Lectura pura: recorre el árbol EN MEMORIA y escribe un guion en stdout, sin
// abrir la base ni tocar nada de fuera. Toda hoja declara —a lo que no declara
// no se le aplica ninguna compuerta y el auditor no puede decir nada de ello—
// y una hoja NUEVA declara junto a su registro, no en la tabla de retrofit.
//
// DEUDA ANOTADA: el sitio de la casa es junto al `.command('completion')`,
// dentro de completion-command.ts. Está aquí porque registerCompletionCommand
// no devuelve el comando y ese archivo lo escribe otra mano; migrarla es mover
// la declaración y borrar la búsqueda.
const completionCmd = (program.commands as Command[]).find((cmd) => cmd.name() === 'completion');
if (completionCmd) declareRisk(completionCmd, { risk: 'lectura', agent: true });

// Las declaraciones de riesgo que faltaban, sobre el árbol ya completo.
//
// Va aquí y no antes porque necesita el programa entero montado: 49 de las 106
// hojas no declaraban nada, y a lo que no declara no se le aplica ninguna
// compuerta. Respeta lo que ya declaró junto a su comando.
declararPendientes(program);

// ============================================================
// LA RAÍZ NO SE TRAGA EL TECLEO
// chat es isDefault, así que commander le entrega CUALQUIER token
// desconocido de la raíz: `mnemosine balanza` moría con «too many
// arguments for chat» aunque balanza sea un alias real un nivel
// abajo, y el sugeridor de commander (que sí corre en los
// subniveles: `entity lst` → Did you mean list?) nunca veía la
// raíz. Esta compuerta decide ANTES de parsear:
//   · token registrado en la raíz          → pasa intacto
//   · registrado salvo por los acentos     → se reescribe al
//     canónico («póliza» ejecuta poliza: un contador teclea la
//     palabra como se escribe, no como la registró el programador)
//   · desconocido                          → comando desconocido +
//     la sugerencia más cercana (raíz y un nivel abajo, para que
//     balanza apunte a `report balanza`) y USAGE (2), nunca chat
// ============================================================

/**
 * NFD separa la letra de su marca y sin marcas «póliza» y «poliza» son la
 * misma palabra. Cubre también el otro sentido: una terminal que emite NFD
 * (macOS) produce bytes distintos para el mismo tecleo compuesto.
 */
export function normalizarToken(token: string): string {
  return token.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Levenshtein corta (sin transposición): basta para dedazos de comando. */
export function distanciaDeEdicion(a: string, b: string): number {
  const previa: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previa[0];
    previa[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const sustituir = diagonal + costo;
      diagonal = previa[j];
      previa[j] = Math.min(previa[j] + 1, previa[j - 1] + 1, sustituir);
    }
  }
  return previa[b.length];
}

export interface ComandoRegistrado {
  /** El nombre o alias tal como se teclea. */
  clave: string;
  /** Cómo invocarlo desde la raíz (para un subcomando: `padre hijo`). */
  invocacion: string;
}

/**
 * La raíz y un nivel abajo. El segundo nivel entra solo como material de
 * SUGERENCIA: los alias en español viven ahí (`report balanza`) y son
 * exactamente lo que un contador teclea suelto en la raíz.
 */
export function comandosRegistrados(programa: Command): ComandoRegistrado[] {
  const lista: ComandoRegistrado[] = [];
  for (const cmd of programa.commands) {
    for (const clave of [cmd.name(), ...cmd.aliases()]) {
      lista.push({ clave, invocacion: clave });
    }
    for (const sub of cmd.commands) {
      for (const clave of [sub.name(), ...sub.aliases()]) {
        lista.push({ clave, invocacion: `${cmd.name()} ${clave}` });
      }
    }
  }
  return lista;
}

export type VeredictoDeRaiz =
  | { tipo: 'pasa' }
  | { tipo: 'canonico'; nombre: string }
  | { tipo: 'desconocido'; sugerencia: string | null };

export function veredictoDeRaiz(
  token: string | undefined,
  comandos: ComandoRegistrado[]
): VeredictoDeRaiz {
  // Sin token o con flag, los flujos legales de chat no cambian: el desnudo
  // sigue cayendo en chat y las opciones globales las juzga commander.
  // `help` es el comando implícito de commander y no figura en .commands.
  if (!token || token.startsWith('-') || token === 'help') return { tipo: 'pasa' };
  const raices = comandos.filter((c) => c.clave === c.invocacion);
  if (raices.some((c) => c.clave === token)) return { tipo: 'pasa' };
  const normal = normalizarToken(token);
  const porAcentos = raices.find((c) => normalizarToken(c.clave) === normal);
  if (porAcentos) return { tipo: 'canonico', nombre: porAcentos.clave };

  // Umbral de commander (suggestSimilar): a lo más 3 ediciones y similitud
  // mayor a 0.4; empates al orden alfabético para que la salida sea estable.
  //
  // CUANDO HAY EMPATE, SE OFRECEN LAS DOS. El desempate alfabético hacía la
  // salida estable pero elegía por el usuario, y desde F07b hay palabras que
  // viven en dos familias: «balanza» es la de comprobación (`report`) y
  // también la del Anexo 24 (`e-accounting`). Quien la teclea suele querer la
  // primera, pero «suele» no es saber, y adivinar mal a alguien que ya está
  // perdido lo manda más lejos. Se listan las candidatas empatadas, en orden
  // alfabético para que la salida siga siendo estable.
  let mejorDistancia = Infinity;
  let empatadas: string[] = [];
  for (const candidato of comandos) {
    if (candidato.clave.length <= 1) continue;
    const claveNormal = normalizarToken(candidato.clave);
    const distancia = distanciaDeEdicion(normal, claveNormal);
    const largo = Math.max(normal.length, claveNormal.length);
    if (distancia > 3 || (largo - distancia) / largo <= 0.4) continue;
    if (distancia < mejorDistancia) {
      mejorDistancia = distancia;
      empatadas = [candidato.invocacion];
    } else if (distancia === mejorDistancia && !empatadas.includes(candidato.invocacion)) {
      empatadas.push(candidato.invocacion);
    }
  }
  empatadas.sort();
  const sugerencia =
    empatadas.length === 0 ? null : empatadas.length === 1 ? empatadas[0] : empatadas.join(' o ');
  return { tipo: 'desconocido', sugerencia };
}

// Exported for scripts/generate-cli-reference.ts, which walks the command
// tree to emit the agent-facing CLI reference without spawning the binary.
export { program };

// Parse only when executed as the entrypoint (tsx / node dist are CJS, where
// require.main identifies it). Importing this module — the entry-flow spec
// pulls the exported pure helpers — must not launch the CLI.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void (async () => {
    const argv = [...process.argv];
    const veredicto = veredictoDeRaiz(argv[2], comandosRegistrados(program));
    if (veredicto.tipo === 'desconocido') {
      // Antes de abrir base o túnel alguno: un tecleo desconocido termina aquí
      // con el contrato de USAGE, en vez de viajar hasta chat y morir con un
      // «too many arguments for chat» que no nombra el problema.
      stderr.write(ce.red(`error: unknown command '${argv[2]}'\n`));
      if (veredicto.sugerencia) {
        stderr.write(`(Did you mean ${veredicto.sugerencia}?)\n`);
      }
      // Por shutdown como todo el resto. Aquí todavía no hay base abierta y
      // el cierre no tiene nada que drenar, pero la salida del proceso tiene
      // UNA puerta: dejar una excepción a la vista es cómo vuelve el bicho.
      await shutdown(ExitCode.USAGE);
      return;
    }
    if (veredicto.tipo === 'canonico') argv[2] = veredicto.nombre;
    try {
      await program.parseAsync(argv);
    } catch (err) {
      if (err instanceof SalidaDeCommander) {
        // Ya está todo escrito: `error()` vuelca su línea en stderr ANTES de
        // salir, y --help/--version imprimieron lo suyo. reportError aquí
        // duplicaría el mensaje y encima le colgaría un remedio inventado.
        await shutdown(err.codigo);
        return;
      }
      reportError(err);
      // exitCodeFor y no un 1 fijo: un CliError que se escapa de su acción
      // trae su código puesto, y perderlo justo en la puerta es el mismo
      // daño que arriba, sólo que un piso más abajo.
      await shutdown(exitCodeFor(err));
    }
  })();
}
