import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import {
  buildSections, BADGE,
  type InitFlags, type SectionContext, type SetupSection,
} from './init/index.js';
import { runDoctor } from '../ai/doctor-service.js';
import { bootstrapTenant } from '../ai/context.js';

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
export function readSecretFromTty(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      // Sin terminal no hay forma de ocultar el eco: no se pide el secreto.
      stdout.write(prompt + '(skipped: no interactive terminal)\n');
      resolve(null);
      return;
    }
    stdout.write(prompt);
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
          stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          stdout.write('\n');
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
    const raw = await rl!.question(prompt).catch(() => null);
    if (raw === null) return fallback ?? null;
    const t = raw.trim();
    return t === '' ? (fallback ?? null) : t;
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
  console.log(c.bold('Configuration status'));
  console.log('');
  for (const s of sections) {
    const st = await s.status();
    const badge = st === 'ok' ? BADGE.ok : c.dim(BADGE[st]);
    const req = s.required ? '' : c.dim(' (optional)');
    console.log(`  ${badge}  ${s.title}${req}`);
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

const SEED_WITH_DATA = 'Say hello and give me a quick health check of my books.';
const SEED_FRESH = 'Say hello and tell me what you can do once I load my accounting.';

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
      `Unknown section: "${opts.section}". Options: infra, identity, users, ai, policies, import`
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
      console.log(
        c.dim(
          "  Let's get you set up. Enter accepts the value in parentheses; Ctrl+C pauses — " +
            'your progress is saved because state lives in the system, not a file.'
        )
      );
    } else {
      console.log(c.bold('Mnemosine setup'));
      console.log(
        c.dim(
          interactive
            ? '  Only asking for what is missing. Enter accepts the value in parentheses.'
            : '  Non-interactive mode: using defaults and flags.'
        )
      );
    }

    const ctx = makeSectionContext(rl ?? null, opts, deps);

    for (const section of selected) {
      const before = await section.status();
      console.log('');
      console.log(c.bold(section.title) + c.dim(`  [${BADGE[before]}]`));

      // Idempotencia: lo ya configurado no se vuelve a preguntar, salvo
      // unless that section is requested explicitly with --section.
      if (before === 'ok' && !wanted) {
        console.log(c.dim('  Already configured; moving on.'));
        continue;
      }
      if (!section.required && before !== 'ok' && !wanted) {
        if (!(await ctx.confirm('  Configure now?', false))) {
          console.log(c.dim('  Skipped. It will show as pending in init --status.'));
          continue;
        }
      }
      await section.configure(ctx);
    }

    // Close: full doctor — the same verification each section uses.
    console.log('');
    console.log(c.bold('Final verification'));
    const report = await runDoctor();
    for (const ch of report.checks) {
      const mark = ch.level === 'ok' ? '✔' : ch.level === 'warn' ? '⚠' : c.red('✘');
      console.log(`  ${mark} ${ch.name}: ${ch.detail}`);
      if (ch.fix && ch.level !== 'ok') console.log(c.dim(`      → ${ch.fix}`));
    }

    console.log('');
    if (report.worst === 'fail') {
      console.log('Some items are still unresolved. Run again: mnemosine init');
      console.log('');
      return { completed: false, offerChat: false };
    }

    // Hatch moment: healthy system, interactive terminal — offer the first
    // conversation, with a scripted first message chosen by data presence.
    if (interactive && rl) {
      const importSection = sections.find((s) => s.id === 'importar');
      const hasData = importSection ? (await importSection.status()) === 'ok' : false;
      const seed = hasData ? SEED_WITH_DATA : SEED_FRESH;

      if (await ctx.confirm('Start chatting now?', true)) {
        if (opts.rescue) {
          // Announce exactly what happens next; the ENTRY FLOW does it.
          console.log(
            `I'll open the chat and send your first message: "${seed}". ` +
              '(The agent reads your real data — this may take a few seconds.)'
          );
          console.log('');
          return { completed: true, offerChat: true, seedMessage: seed };
        }
        // init command mode: chat is a sibling command, not launchable from
        // inside this action — hand over the receipt instead.
        console.log('Open the chat with: mnemosine');
        console.log('');
        return { completed: true, offerChat: false };
      }
    }

    console.log('Ready. Try:');
    console.log(c.dim('  mnemosine chat      converse with your accounting'));
    console.log(c.dim('  mnemosine review    approve or reject pending drafts'));
    console.log(c.dim('  mnemosine status    where things stand'));
    console.log(c.dim('  mnemosine pending   what needs your attention'));
    console.log(c.dim('  mnemosine doctor    system health'));
    console.log('');
    return { completed: true, offerChat: false };
  } finally {
    rl?.close();
  }
}

export function registerInitCommand(program: Command, deps: InitCliDeps): void {
  program
    .command('init')
    .alias('configurar')
    .description('Guided setup: infrastructure, entity, users, AI provider, and your books')
    .option('--status', 'Only show the status, configure nothing')
    .option('--section <id>', 'Configure a single section (infra|identity|users|ai|policies|import)')
    .option('-y, --yes', 'Non-interactive: use defaults and flags, ask nothing')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--entity <name>', 'Name of the legal entity to create')
    .option('--rfc <rfc>', 'RFC/EIN of the entity')
    .option('--country <country>', 'MX | USA')
    .option('--currency <currency>', 'Functional currency')
    .option('--provider <name>', 'Default AI provider')
    .option('--model <model>', 'Provider model')
    .option('-u, --user <email>', 'Email of the user to create')
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
        await deps.shutdown(1);
      }
    });
}
