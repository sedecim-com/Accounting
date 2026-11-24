import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  buildCommandManifest,
  CommandManifestError,
  renderCommandManifest,
  type ManifestCommand,
} from '../../src/cli/command-manifest.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';
import { hojasDe } from '../../src/cli/kernel/riesgos-retrofit.js';
import { allDeclarations, declareRisk, type RiskDeclaration } from '../../src/cli/kernel/risk.js';
import { program as shippedProgram } from '../../src/cli/mnemosine.js';

// ============================================================
// THE COMMAND MANIFEST (MNE-001-693, #952 stage 1)
//
// Two batteries. The synthetic tree pins how one leaf is read, field by
// field, on a tree small enough to check by hand. The shipped tree pins the
// two promises a hand-made tree cannot make: every declared leaf is there,
// and the committed file is the one this tree generates.
// ============================================================

const PUBLISHED = path.resolve(__dirname, '..', '..', 'docs', 'command-manifest.json');

/** A root named like the binary, so paths read as they do in the shipped tree. */
function tree(): Command {
  return new Command('mnemosine');
}

function leaf(parent: Command, name: string, decl: RiskDeclaration | null): Command {
  const cmd = parent.command(name).action(() => undefined);
  return decl ? declareRisk(cmd, decl) : cmd;
}

function entry(root: Command, at: string): ManifestCommand {
  const found = buildCommandManifest(root).commands.find((c) => c.path === at);
  if (!found) throw new Error(`no entry for ${at}`);
  return found;
}

function failure(fn: () => unknown): CommandManifestError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandManifestError) return error;
    throw error;
  }
  throw new Error('the generator did not fail');
}

describe('command manifest: one leaf, field by field', () => {
  it('reads the path, the aliases in declared order and the risk declaration', () => {
    const root = tree();
    const bank = root.command('bank');
    leaf(bank, 'show', { risk: 'lectura', agent: true }).aliases(['ver', 'mostrar']);
    leaf(bank, 'draft', { risk: 'escritura', agent: true, draftOnly: true });
    leaf(bank, 'edit', { risk: 'escritura' });

    expect(entry(root, 'bank show')).toMatchObject({
      path: 'bank show',
      aliases: ['ver', 'mostrar'],
      risk: 'lectura',
      agent: true,
      draft_only: false,
      idempotency_key: { behaviour: 'not-offered' },
    });
    expect(entry(root, 'bank draft')).toMatchObject({ risk: 'escritura', agent: true, draft_only: true });
    expect(entry(root, 'bank edit')).toMatchObject({ risk: 'escritura', agent: false, draft_only: false });
  });

  it('says what each grave leaf does with --idempotency-key', () => {
    const root = tree();
    leaf(root, 'post', { risk: 'irreversible', llave: { scope: 'post' } });
    leaf(root, 'stamp', { risk: 'externo', llave: { innecesaria: 'the UUID deduplicates' } });
    leaf(root, 'purge', { risk: 'irreversible', llave: { sinLlave: 'not wired' } });
    leaf(root, 'legacy', { risk: 'irreversible' });

    expect(entry(root, 'post').idempotency_key).toEqual({ behaviour: 'honoured', scope: 'post' });
    expect(entry(root, 'stamp').idempotency_key).toEqual({ behaviour: 'unneeded' });
    expect(entry(root, 'purge').idempotency_key).toEqual({ behaviour: 'refused' });
    expect(entry(root, 'legacy').idempotency_key).toEqual({ behaviour: 'undeclared' });
    // The flags the declaration injects are options like any other.
    expect(entry(root, 'stamp').options.map((o) => o.name)).toEqual(['dryRun', 'idempotencyKey', 'live', 'yes']);
  });

  it('reads type, required, choices and default of options, sorted by name', () => {
    const root = tree();
    leaf(root, 'list', { risk: 'lectura' })
      .option('-n, --limit <n>', 'rows', '20')
      .option('--basis <book|tax>', 'basis')
      .requiredOption('--period <yyyy-mm>', 'period')
      .option('-s, --status <state...>', 'states')
      .option('--fields [names]', 'columns')
      .option('--no-color', 'plain')
      .option('-a, --all', 'everything');

    expect(entry(root, 'list').options).toEqual([
      { name: 'all', flags: '-a, --all', type: 'boolean', required: false },
      { name: 'basis', flags: '--basis <book|tax>', type: 'string', required: false, choices: ['book', 'tax'] },
      { name: 'color', flags: '--no-color', type: 'boolean', required: false },
      { name: 'fields', flags: '--fields [names]', type: 'boolean|string', required: false },
      { name: 'limit', flags: '-n, --limit <n>', type: 'string', required: false, default: '20' },
      { name: 'period', flags: '--period <yyyy-mm>', type: 'string', required: true },
      { name: 'status', flags: '-s, --status <state...>', type: 'string[]', required: false },
    ]);
  });

  it('keeps arguments in positional order', () => {
    const root = tree();
    leaf(root, 'import', { risk: 'escritura' })
      .argument('<kind>', 'kind')
      .argument('[target]', 'target', 'ledger')
      .argument('[files...]', 'files');

    expect(entry(root, 'import').arguments).toEqual([
      { name: 'kind', type: 'string', required: true },
      { name: 'target', type: 'string', required: false, default: 'ledger' },
      { name: 'files', type: 'string[]', required: false },
    ]);
  });

  it('derives the output formats from --format and --json, and never from an input format', () => {
    const root = tree();
    leaf(root, 'report', { risk: 'lectura' })
      .option('--format <table|json|csv>', 'shape', 'table')
      .option('--json', 'json')
      .option('-o, --output <path>', 'file');
    leaf(root, 'status', { risk: 'lectura' }).option('--json', 'json');
    leaf(root, 'load', { risk: 'escritura' }).option('--format <csv|ofx>', 'the format of the file read');
    leaf(root, 'doctor', { risk: 'lectura' });

    expect(entry(root, 'report').output).toEqual({ formats: ['table', 'json', 'csv'], file: true });
    expect(entry(root, 'status').output).toEqual({ formats: ['json'], file: false });
    expect(entry(root, 'load').output).toEqual({ formats: [], file: false });
    expect(entry(root, 'doctor').output).toEqual({ formats: [], file: false });
  });

  it('publishes the exit codes of the binary and the options of the root once', () => {
    const root = tree().option('-T, --tenant <uuid>', 'tenant');
    leaf(root, 'whoami', { risk: 'lectura' });
    const manifest = buildCommandManifest(root);

    expect(manifest.binary).toBe('mnemosine');
    expect(manifest.global_options).toEqual([
      { name: 'tenant', flags: '-T, --tenant <uuid>', type: 'string', required: false },
    ]);
    expect(manifest.exit_codes.map((e) => e.code)).toEqual(
      Object.values(ExitCode).sort((a, b) => a - b)
    );
    expect(manifest.exit_codes).toContainEqual({ code: 11, name: 'NEEDS_HUMAN' });
  });
});

describe('command manifest: the generator fails closed', () => {
  it('fails on a leaf without a declaration, and names it', () => {
    const root = tree();
    const bank = root.command('bank');
    leaf(bank, 'show', { risk: 'lectura' });
    leaf(bank, 'forgotten', null);
    leaf(root, 'orphan', null);

    const error = failure(() => buildCommandManifest(root));
    expect(error.code).toBe('undeclared-leaf');
    expect(error.subjects).toEqual(['bank forgotten', 'orphan']);
  });

  it('fails on a declaration that sits on a group, which the manifest would drop', () => {
    const root = tree();
    const group = declareRisk(root.command('bank'), { risk: 'lectura' });
    leaf(group, 'show', { risk: 'lectura' });

    const error = failure(() => buildCommandManifest(root));
    expect(error.code).toBe('declared-group');
    expect(error.subjects).toEqual(['bank']);
  });

  it('fails on a default that is not plain JSON, which would differ between machines', () => {
    const root = tree();
    leaf(root, 'export', { risk: 'lectura' }).option('--since <date>', 'from', new Date(0) as unknown as string);

    const error = failure(() => buildCommandManifest(root));
    expect(error.code).toBe('unserialisable-default');
    expect(error.subjects).toEqual(['export --since <date>']);
  });

  it('ignores the declarations of another tree in the same process', () => {
    const other = tree();
    leaf(other, 'elsewhere', { risk: 'lectura' });
    const root = tree();
    leaf(root, 'here', { risk: 'lectura' });

    expect(buildCommandManifest(root).commands.map((c) => c.path)).toEqual(['here']);
  });
});

describe('command manifest: deterministic rendering', () => {
  it('sorts leaves by path whatever the order of registration, and round-trips as JSON', () => {
    const forward = tree();
    for (const name of ['zeta', 'alpha', 'Mid']) leaf(forward, name, { risk: 'lectura' }).option('--json', 'json');
    const backward = tree();
    for (const name of ['Mid', 'alpha', 'zeta']) leaf(backward, name, { risk: 'lectura' }).option('--json', 'json');

    const text = renderCommandManifest(buildCommandManifest(forward));
    expect(renderCommandManifest(buildCommandManifest(backward))).toBe(text);
    expect(JSON.parse(text)).toEqual(buildCommandManifest(forward));
    // Code-point order, not the machine's collation: uppercase sorts first.
    expect(buildCommandManifest(forward).commands.map((c) => c.path)).toEqual(['Mid', 'alpha', 'zeta']);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('writes one line per option, so a changed flag is a one-line diff', () => {
    const root = tree();
    leaf(root, 'list', { risk: 'lectura' }).option('-a, --all', 'everything').option('--json', 'json');
    const lines = renderCommandManifest(buildCommandManifest(root)).split('\n');

    expect(lines).toContain('        {"name":"all","flags":"-a, --all","type":"boolean","required":false},');
    expect(lines).toContain('        {"name":"json","flags":"--json","type":"boolean","required":false}');
  });
});

describe('command manifest: the shipped tree', () => {
  const manifest = buildCommandManifest(shippedProgram);

  it('has one entry per leaf of the tree and per declaration of the registry', () => {
    const leaves = hojasDe(shippedProgram).map((h) => h.ruta);
    const declared = allDeclarations().filter(({ command }) => {
      let top: Command = command;
      while (top.parent) top = top.parent;
      return top === shippedProgram;
    });

    expect(leaves.length).toBeGreaterThan(250);
    expect(manifest.commands).toHaveLength(leaves.length);
    expect(manifest.commands).toHaveLength(declared.length);
    expect(new Set(manifest.commands.map((c) => c.path))).toEqual(new Set(leaves));
  });

  it('never offers the agent an irreversible or external leaf', () => {
    const grave = manifest.commands.filter((c) => c.agent && (c.risk === 'irreversible' || c.risk === 'externo'));
    expect(grave.map((c) => c.path)).toEqual([]);
  });

  it('leaves no grave leaf without an answer about its idempotency key', () => {
    const silent = manifest.commands.filter((c) => c.idempotency_key.behaviour === 'undeclared');
    expect(silent.map((c) => c.path)).toEqual([]);
  });

  it('matches the published docs/command-manifest.json byte for byte', () => {
    // CI runs this through `npm test`. Regenerate with `npm run command:manifest`.
    expect(fs.readFileSync(PUBLISHED, 'utf8')).toBe(renderCommandManifest(manifest));
  });

  it('carries no date and no version, which would make the file stale without a change', () => {
    const text = renderCommandManifest(manifest);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(Object.keys(manifest)).toEqual(['schema', 'binary', 'exit_codes', 'global_options', 'commands']);
  });
});
