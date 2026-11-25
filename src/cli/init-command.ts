import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import {
  buildSections, badge,
  type InitFlags, type SectionContext, type SetupSection,
} from './init/index.js';
import { runDoctor } from '../ai/doctor-service.js';
import { bootstrapTenant } from '../ai/context.js';
import { describeCommand, exitCodeFor, optionByKey } from './kernel/index.js';
import { t } from '../i18n/index.js';

// ============================================================
// mnemosine init
// Wizard idempotente por secciones: detecta lo configurado, solo
// pregunta lo que falta, prueba en vivo y cierra con doctor.
// ============================================================

const CTRL_C = '\u0003'; // Ctrl+C
const DELETE = '\u007F'; // backspace/delete

export interface InitCliDeps {
  palette: {
    dim: (s: string) => string; bold: (s: string) => string;
    cyan: (s: string) => string; red: (s: string) => string;
  };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  /** Lectura con eco oculto (secretos). Inyectable para tests. */
  readSecret?: (prompt: string) => Promise<string | null>;
}

/**
 * Reads a line WITHOUT echo: for passwords and API keys. In raw mode we must
 * manejar a mano el retorno, el borrado y Ctrl+C.
 */
export function readSecretFromTty(prompt: string, out: NodeJS.WritableStream = stdout): Promise<string | null> {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      // Sin terminal no hay forma de ocultar el eco: no se pide el secreto.
      out.write(`${prompt}${t('init.secret.skipped')}\n`);
      resolve(null);
      return;
    }
    out.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf-8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          out.write('\n');
          resolve(buf);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          out.write('\n');
          resolve(null);
          return;
        }
        if (ch === DELETE || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Construye el contexto que reciben las secciones. */
export function makeSectionContext(
  rl: readline.Interface | null,
  flags: InitFlags,
  deps: Pick<InitCliDeps, 'readSecret'> = {},
  print: (line?: string) => void = (l) => console.log(l ?? '')
): SectionContext {
  const nonInteractive = flags.yes === true || rl === null;

  const askText = async (prompt: string, fallback?: string): Promise<string | null> => {
    if (nonInteractive) return fallback ?? null;
    const raw = await rl.question(prompt).catch(() => null);
    if (raw === null) return fallback ?? null;
    const answer = raw.trim();
    return answer === '' ? (fallback ?? null) : answer;
  };

  const askSecret = async (prompt: string): Promise<string | null> => {
    // A secret is never invented nor taken from a default.
    if (nonInteractive) return null;
    return (deps.readSecret ?? readSecretFromTty)(prompt);
  };

  const confirm = async (prompt: string, defaultYes = true): Promise<boolean> => {
    if (nonInteractive) return defaultYes;
    const raw = await askText(`${prompt} [${defaultYes ? 'Y/n' : 'y/N'}] `, '');
    if (!raw) return defaultYes;
    return /^s|^y/i.test(raw);
  };

  return { rl, flags, print, askText, askSecret, confirm };
}

/**
 * `--section` accepts the English name (advertised in --help) and the
 * Spanish id (the section's internal id), mirroring the command aliases.
 */
const SECTION_ALIASES: Record<string, string> = {
  language: 'idioma', idioma: 'idioma',
  infra: 'infra', infrastructure: 'infra',
  identity: 'identidad', identidad: 'identidad',
  users: 'usuarios', usuarios: 'usuarios',
  ai: 'ia', ia: 'ia',
  policies: 'politicas', politicas: 'politicas', policy: 'politicas',
  import: 'importar', importar: 'importar',
};

export function resolveSectionId(input: string): string {
  return SECTION_ALIASES[input.trim().toLowerCase()] ?? input;
}

async function renderStatus(sections: SetupSection[], c: InitCliDeps['palette']): Promise<void> {
  console.log('');
  console.log(c.bold(t('init.status.title')));
  console.log('');
  for (const s of sections) {
    const st = await s.status();
    const shown = st === 'ok' ? badge('ok') : c.dim(badge(st));
    const req = s.required ? '' : c.dim(` ${t('init.status.optional')}`);
    console.log(`  ${shown}  ${s.title}${req}`);
  }
  console.log('');
}

// ─── Wizard core (shared by the init command and the bare-run rescue flow) ───

export interface InitWizardResult {
  completed: boolean;
  /** true only in rescue mode: the ENTRY FLOW owns launching the chat. */
  offerChat: boolean;
  /** Scripted first message ("hatch"), chosen by data presence. */
  seedMessage?: string;
}

export type InitWizardOptions = InitFlags & { section?: string; rescue?: boolean };

/** Same TTY + NO_COLOR gating as the CLI's palette; used by rescue callers. */
function defaultPalette(): InitCliDeps['palette'] {
  const on = stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { dim: wrap('2'), bold: wrap('1'), cyan: wrap('36'), red: wrap('31') };
}

/**
 * Runs the full setup journey and reports how it ended. It NEVER starts the
 * chat itself: `rescue: true` means the bare-run entry flow invoked it and
 * will honor `offerChat`/`seedMessage`; via the `init` command the chat is a
 * sibling command, so a "yes" prints the receipt (`Open the chat with:
 * mnemosine`) instead of offering a launch.
 */
export async function runInitWizard(
  opts: InitWizardOptions,
  deps: Partial<Pick<InitCliDeps, 'palette' | 'readSecret'>> = {}
): Promise<InitWizardResult> {
  const c = deps.palette ?? defaultPalette();
  const sections = buildSections();

  const wanted = opts.section ? resolveSectionId(opts.section) : undefined;
  const selected = wanted ? sections.filter((s) => s.id === wanted) : sections;
  if (selected.length === 0) {
    console.error(
      t('init.wizard.unknown_section', {
        section: opts.section ?? '',
        options: 'language, infra, identity, users, ai, policies, import',
      })
    );
    return { completed: false, offerChat: false };
  }

  const interactive = !opts.yes && stdin.isTTY;
  let rl: readline.Interface | undefined;
  if (interactive) rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log('');
    if (opts.rescue) {
      // The entry flow already showed the welcome; go straight to the point,
      // and promise what the design guarantees: interruption costs nothing.
      console.log(c.dim(`  ${t('init.wizard.rescue_intro')}`));
    } else {
      console.log(c.bold(t('init.wizard.title')));
      console.log(c.dim(`  ${t(interactive ? 'init.wizard.interactive' : 'init.wizard.non_interactive')}`));
    }

    const ctx = makeSectionContext(rl ?? null, opts, deps);

    for (const section of selected) {
      const before = await section.status();
      console.log('');
      console.log(c.bold(section.title) + c.dim(`  [${badge(before)}]`));

      // Idempotencia: lo ya configurado no se vuelve a preguntar, salvo
      // unless that section is requested explicitly with --section.
      if (before === 'ok' && !wanted) {
        console.log(c.dim(`  ${t('init.wizard.already_configured')}`));
        continue;
      }
      if (!section.required && before !== 'ok' && !wanted) {
        if (!(await ctx.confirm(`  ${t('init.wizard.configure_now')}`, false))) {
          console.log(c.dim(`  ${t('init.wizard.skipped')}`));
          continue;
        }
      }
      await section.configure(ctx);
    }

    // Close: full doctor — the same verification each section uses.
    console.log('');
    console.log(c.bold(t('init.wizard.final_verification')));
    const report = await runDoctor();
    for (const ch of report.checks) {
      const mark = ch.level === 'ok' ? '✔' : ch.level === 'warn' ? '⚠' : c.red('✘');
      console.log(`  ${mark} ${ch.name}: ${ch.detail}`);
      if (ch.fix && ch.level !== 'ok') console.log(c.dim(`      → ${ch.fix}`));
    }

    console.log('');
    if (report.worst === 'fail') {
      console.log(t('init.wizard.unresolved', { command: 'mnemosine init' }));
      console.log('');
      return { completed: false, offerChat: false };
    }

    // Hatch moment: healthy system, interactive terminal — offer the first
    // conversation, with a scripted first message chosen by data presence.
    if (interactive && rl) {
      const importSection = sections.find((s) => s.id === 'importar');
      const hasData = importSection ? (await importSection.status()) === 'ok' : false;
      const seed = t(hasData ? 'init.wizard.seed_with_data' : 'init.wizard.seed_fresh');

      if (await ctx.confirm(t('init.wizard.start_chat'), true)) {
        if (opts.rescue) {
          // Announce exactly what happens next; the ENTRY FLOW does it.
          console.log(t('init.wizard.opening_chat', { seed }));
          console.log('');
          return { completed: true, offerChat: true, seedMessage: seed };
        }
        // init command mode: chat is a sibling command, not launchable from
        // inside this action — hand over the receipt instead.
        console.log(t('init.wizard.open_chat_with', { command: 'mnemosine' }));
        console.log('');
        return { completed: true, offerChat: false };
      }
    }

    console.log(t('init.wizard.ready'));
    console.log(c.dim(`  mnemosine chat      ${t('init.wizard.try.chat')}`));
    console.log(c.dim(`  mnemosine review    ${t('init.wizard.try.review')}`));
    console.log(c.dim(`  mnemosine status    ${t('init.wizard.try.status')}`));
    console.log(c.dim(`  mnemosine pending   ${t('init.wizard.try.pending')}`));
    console.log(c.dim(`  mnemosine doctor    ${t('init.wizard.try.doctor')}`));
    console.log('');
    return { completed: true, offerChat: false };
  } finally {
    rl?.close();
  }
}

export function registerInitCommand(program: Command, deps: InitCliDeps): void {
  const init = describeCommand(program.command('init').alias('configurar'), 'help.init.description')
    .addHelpText('after', '\n.env: ./.env wins over ~/.mnemosine/.env. With neither, init asks (default ./.env in a checkout,\n~/.mnemosine/.env elsewhere); without a terminal it applies the same rule.');
  optionByKey(init, '--status', 'help.init.option.status');
  optionByKey(init, '--section <id>', 'help.init.option.section');
  optionByKey(init, '-y, --yes', 'help.init.option.yes');
  optionByKey(init, '-t, --tenant <id>', 'help.init.option.tenant');
  optionByKey(init, '--entity <name>', 'help.init.option.entity');
  optionByKey(init, '--rfc <rfc>', 'help.init.option.rfc');
  optionByKey(init, '--country <country>', 'help.init.option.country');
  optionByKey(init, '--currency <currency>', 'help.init.option.currency');
  optionByKey(init, '--provider <name>', 'help.init.option.provider');
  optionByKey(init, '--model <model>', 'help.init.option.model');
  optionByKey(init, '-u, --user <email>', 'help.init.option.user');
  init
    .action(async (opts: InitWizardOptions & { status?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);

        if (opts.status) {
          await renderStatus(buildSections(), deps.palette);
          await deps.shutdown(0);
        }

        const result = await runInitWizard(opts, deps);
        await deps.shutdown(result.completed ? 0 : 1);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
