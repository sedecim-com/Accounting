import type { Command } from 'commander';
import { CliError, ExitCode } from './exit.js';

// ============================================================
// RISK DECLARATION — one central mechanism (rulebook R11)
//
// Every mutating command declares its risk class ONCE, here, and
// that declaration drives four things at once:
//   1. which safety flags the command is required to carry,
//   2. how strong the confirmation is,
//   3. what the audit record says,
//   4. whether the LLM agent may invoke it.
//
// The load-bearing rule is (4), and the reason it lives in code
// rather than in a review checklist:
//
//   THE AGENT'S PERMISSION MUST NEVER DEPEND ON THE VALUE OF A
//   FLAG.
//
// If `year close --generate` were allowed and `year close --seal`
// forbidden, then permission would be a property of how the
// command was invoked — unknowable at registration time and
// unenforceable anywhere. Such a command must be split into two
// commands with two declarations. `declareRisk` refuses the
// alternative: marking an irreversible or external command as
// agent-invocable throws at startup, so the mistake cannot ship.
// ============================================================

/**
 * The four risk classes, matching the catalog's vocabulary exactly
 * (docs/cli-command-catalog.md), so a row in the catalog and a
 * command in the code cannot drift apart.
 */
export type Risk =
  /** Reads only. No row anywhere changes. */
  | 'lectura'
  /** Writes something reversible: a draft, a master-data field, a config value. */
  | 'escritura'
  /** Posts to the ledger, deletes, or otherwise cannot be undone by re-running. */
  | 'irreversible'
  /** Has an effect outside this system: a PAC, the SAT, a bank, an email. */
  | 'externo';

export interface RiskDeclaration {
  risk: Risk;
  /**
   * True only when the LLM agent may invoke this command autonomously.
   * Permitted for `lectura` always, and for `escritura` only together
   * with `draftOnly`, because the single guarantee the agent's whole
   * design rests on is that it proposes and a human disposes.
   */
  agent?: boolean;
  /**
   * Required to pair with `agent` on an `escritura` command: asserts
   * that every write this command performs lands in a review queue
   * (ai_drafts / ai_questions / ai_external_ops), never in the ledger.
   */
  draftOnly?: boolean;
  /** Human-readable summary of what it writes, for the audit record. */
  writes?: string;
}

export interface ResolvedRisk extends RiskDeclaration {
  /** Final, enforced answer to "may the agent call this?". */
  agentAllowed: boolean;
  /** Irreversible and external commands must be able to show their effect first. */
  requiresDryRun: boolean;
  /** External effects are opt-in: the default endpoint is the sandbox. */
  requiresLiveGate: boolean;
  /** Mutations at this level must carry a client dedupe key. */
  requiresIdempotencyKey: boolean;
}

const REGISTRY = new Map<Command, ResolvedRisk>();

/** Verbs whose whole point is undoing or overriding something: they must be justified. */
const REASON_VERBS = new Set([
  'reverse', 'void', 'reopen', 'unlock', 'cancel', 'reject', 'archive', 'revoke', 'delete',
]);

function lastToken(cmd: Command): string {
  const parts = cmd.name().trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Declares a command's risk and applies every flag that class requires.
 * Throws at registration time — i.e. at process startup, before any
 * user input exists — when a declaration is unsafe.
 */
export function declareRisk(cmd: Command, decl: RiskDeclaration): Command {
  const { risk, agent = false, draftOnly = false } = decl;

  if (agent && (risk === 'irreversible' || risk === 'externo')) {
    throw new Error(
      `Command "${cmd.name()}" declares risk "${risk}" and agent access at the same time. ` +
        'The agent may never post to the ledger, move money, stamp, cancel, file with an ' +
        'authority, delete, or reach a third party with a client credential. If part of this ' +
        'command is genuinely safe, split it into two commands with two declarations — ' +
        'permission must never depend on the value of a flag.'
    );
  }
  if (agent && risk === 'escritura' && !draftOnly) {
    throw new Error(
      `Command "${cmd.name()}" grants the agent a write without asserting draftOnly. ` +
        'An agent-invocable write must land in a review queue, not in the ledger. ' +
        'Set draftOnly: true if that is true of every path through this command; otherwise agent: false.'
    );
  }

  const resolved: ResolvedRisk = {
    ...decl,
    agent,
    draftOnly,
    agentAllowed: agent,
    requiresDryRun: risk === 'irreversible' || risk === 'externo',
    requiresLiveGate: risk === 'externo',
    requiresIdempotencyKey: risk === 'irreversible' || risk === 'externo',
  };

  if (resolved.requiresDryRun) {
    cmd.option('--dry-run', 'compute and show the full effect; write nothing and call nothing external');
    cmd.option('-y, --yes', 'skip the confirmation prompt');
    cmd.option('--idempotency-key <key>', 'client dedupe key; defaults to a hash of the payload');
  }
  if (resolved.requiresLiveGate) {
    cmd.option('--live', 'perform the real external effect (default is the sandbox endpoint)');
  }
  if (REASON_VERBS.has(lastToken(cmd))) {
    cmd.option('--reason <text>', 'justification recorded in the audit trail (required)');
  }

  REGISTRY.set(cmd, resolved);
  return cmd;
}

export function riskOf(cmd: Command): ResolvedRisk | undefined {
  return REGISTRY.get(cmd);
}

/** Every declaration made in this process, for the consistency test and the agent bridge. */
export function allDeclarations(): Array<{ command: Command; risk: ResolvedRisk }> {
  return [...REGISTRY.entries()].map(([command, risk]) => ({ command, risk }));
}

/** Test seam: drop every declaration so a suite can register a fresh program. */
export function resetDeclarations(): void {
  REGISTRY.clear();
}

/**
 * Enforces at call time what the declaration promised: a `--force` or an
 * undo verb needs a reason, and an external effect without `--live` stays
 * in the sandbox. Returns the effective mode so the handler can branch once.
 */
export function gateMutation(
  cmd: Command,
  opts: Record<string, unknown>
): { dryRun: boolean; live: boolean; reason?: string } {
  const resolved = riskOf(cmd);
  const dryRun = opts.dryRun === true;
  const live = opts.live === true;
  const reason = typeof opts.reason === 'string' ? opts.reason : undefined;

  if (opts.force === true && !reason) {
    throw new CliError(
      '--force overrides a safety rule, so it requires --reason "<why>". The reason is written to the audit trail.',
      ExitCode.USAGE
    );
  }
  if (resolved && REASON_VERBS.has(lastToken(cmd)) && !reason && !dryRun) {
    throw new CliError(
      `"${cmd.name()}" undoes or overrides something, so it requires --reason "<why>".`,
      ExitCode.USAGE
    );
  }
  return { dryRun, live, reason };
}
