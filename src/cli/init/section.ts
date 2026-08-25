import type * as readline from 'node:readline/promises';
import type { CheckResult } from '../../ai/doctor-service.js';

// ============================================================
// SETUP SECTION
// Shared contract between init and doctor: init CONFIGURES
// (writes), doctor VERIFIES (reads), and both use the same
// verify() — a single source of truth for "does this work?".
// ============================================================

export type SectionStatus = 'ok' | 'partial' | 'missing';

export type SectionId =
  | 'infra' | 'identidad' | 'usuarios' | 'ia'
  | 'fiscal' | 'contabilidad' | 'memoria' | 'politicas' | 'importar';

/** Flags for the non-interactive mode (`init --yes`). */
export interface InitFlags {
  yes?: boolean;
  tenant?: string;
  entity?: string;
  provider?: string;
  model?: string;
  user?: string;
  rfc?: string;
  country?: string;
  currency?: string;
}

export interface SectionContext {
  /** null in --yes mode: the section must not ask anything. */
  rl: readline.Interface | null;
  flags: InitFlags;
  /** Wizard output (allows capturing it in tests). */
  print: (line?: string) => void;
  /** Question with visible echo; null if there is no terminal or on EOF. */
  askText: (prompt: string, fallback?: string) => Promise<string | null>;
  /** Question with HIDDEN echo: for secrets. Never logged. */
  askSecret: (prompt: string) => Promise<string | null>;
  /** Yes/no confirmation; in --yes it returns the default without asking. */
  confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface SetupSection {
  readonly id: SectionId;
  readonly title: string;
  /** Without this the system does not operate; init does not allow skipping it. */
  readonly required: boolean;
  /** Current state, for the badges and `init --status`. */
  status(): Promise<SectionStatus>;
  /** Configures idempotently: only asks for what is missing. */
  configure(ctx: SectionContext): Promise<void>;
  /** Live checks. Shared with doctor. */
  verify(): Promise<CheckResult[]>;
}

export const BADGE: Record<SectionStatus, string> = {
  ok: '✔ configured',
  partial: '◐ incomplete',
  missing: '○ pending',
};
