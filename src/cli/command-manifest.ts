import type { Argument, Command, Option } from 'commander';
import { ExitCode } from './kernel/exit.js';
import { hojasDe } from './kernel/riesgos-retrofit.js';
import { allDeclarations, type ResolvedRisk, type Risk } from './kernel/risk.js';

// ============================================================
// THE COMMAND MANIFEST (MNE-001-693, #952 stage 1, PRD-003 RF-41)
//
// What a program that is not this binary needs to know about each leaf, read
// from the two places that already decide it: the Commander tree (path,
// aliases, arguments, options) and the risk registry (`allDeclarations`: the
// class, whether the agent may call it, what it does with the idempotency
// key). Nothing here is written by hand per command, and nothing is prose:
// descriptions stay in the help, which is translated; this is the contract.
//
// It is pure: it takes a tree and returns data. `scripts/command-manifest.ts`
// writes `docs/command-manifest.json` and checks it.
//
// WHAT IT CANNOT KNOW. `required` is what Commander knows (`requiredOption`):
// a handler that refuses a missing flag by hand is invisible here. Exit codes
// are the binary's table, published once, because no leaf declares a subset.
// ============================================================

/** Bumped when a field changes meaning or disappears, not when one is added. */
export const MANIFEST_SCHEMA = 1;

type Json = string | number | boolean | null | Json[];

export interface ManifestOption {
  /** The key of the value in the parsed options: `dryRun` for `--dry-run`. */
  name: string;
  /** The spelling as declared: short, long and placeholder. */
  flags: string;
  /** `boolean|string` is an optional value: the bare flag means `true`. */
  type: 'boolean' | 'string' | 'string[]' | 'boolean|string' | 'boolean|string[]';
  required: boolean;
  choices?: string[];
  default?: Json;
}

export interface ManifestArgument {
  name: string;
  type: 'string' | 'string[]';
  required: boolean;
  choices?: string[];
  default?: Json;
}

/**
 * What the leaf does with `--idempotency-key`. `not-offered`: the flag does
 * not exist on it. `undeclared`: the flag exists and the declaration does not
 * say what happens to it.
 */
export type KeyBehaviour =
  | { behaviour: 'honoured'; scope: string }
  | { behaviour: 'unneeded' | 'refused' | 'not-offered' | 'undeclared' };

export interface ManifestCommand {
  path: string;
  aliases: string[];
  risk: Risk;
  agent: boolean;
  draft_only: boolean;
  idempotency_key: KeyBehaviour;
  arguments: ManifestArgument[];
  options: ManifestOption[];
  /** `formats` is empty when the leaf has no machine-readable output. */
  output: { formats: string[]; file: boolean };
}

export interface CommandManifest {
  schema: number;
  binary: string;
  exit_codes: Array<{ code: number; name: string }>;
  global_options: ManifestOption[];
  commands: ManifestCommand[];
}

/** Why the manifest cannot be built. The caller words it; `subjects` says where. */
export class CommandManifestError extends Error {
  constructor(
    readonly code: 'undeclared-leaf' | 'declared-group' | 'unserialisable-default',
    readonly subjects: string[]
  ) {
    super(`${code}: ${subjects.join(', ')}`);
  }
}

/** Code-point order: the same on every machine, whatever its collation. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A closed list written in the placeholder, as in `--basis <book|tax>`. */
function listedChoices(placeholder: string): string[] | undefined {
  const inner = /[<[]([^>\]]+)[>\]]/.exec(placeholder)?.[1].replace(/\.\.\.$/, '');
  return inner?.includes('|') ? inner.split('|') : undefined;
}

const isPlain = (v: unknown): v is Json =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every(isPlain));

/** A default that is a function or a date would publish a different file on each machine. */
function plainDefault(value: unknown, subject: string): Json | undefined {
  if (value === undefined) return undefined;
  if (!isPlain(value)) throw new CommandManifestError('unserialisable-default', [subject]);
  return value;
}

/** Leaves `choices` and `default` out when there are none: absent is not `null`. */
function withValueFacts<T extends object>(
  base: T,
  choices: readonly string[] | undefined,
  fallback: Json | undefined
): T & { choices?: string[]; default?: Json } {
  return {
    ...base,
    ...(choices ? { choices: [...choices] } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

function optionOf(option: Option, owner: string): ManifestOption {
  const list = option.variadic ? 'string[]' : 'string';
  const type = option.required ? list : option.optional ? (`boolean|${list}` as const) : 'boolean';
  return withValueFacts(
    { name: option.attributeName(), flags: option.flags, type, required: option.mandatory },
    option.argChoices ?? listedChoices(option.flags),
    plainDefault(option.defaultValue, `${owner} ${option.flags}`.trim())
  );
}

function optionsOf(cmd: Command, owner: string): ManifestOption[] {
  return cmd.options
    .map((o) => optionOf(o, owner))
    .sort((a, b) => byText(a.name, b.name) || byText(a.flags, b.flags));
}

function argumentOf(argument: Argument, owner: string): ManifestArgument {
  return withValueFacts(
    {
      name: argument.name(),
      type: argument.variadic ? ('string[]' as const) : ('string' as const),
      required: argument.required,
    },
    argument.argChoices ?? listedChoices(`<${argument.name()}>`),
    plainDefault(argument.defaultValue, `${owner} <${argument.name()}>`)
  );
}

function keyBehaviourOf(risk: ResolvedRisk): KeyBehaviour {
  const key = risk.llave;
  if (key && 'scope' in key) return { behaviour: 'honoured', scope: key.scope };
  if (key && 'innecesaria' in key) return { behaviour: 'unneeded' };
  if (key && 'sinLlave' in key) return { behaviour: 'refused' };
  return { behaviour: risk.requiresIdempotencyKey ? 'undeclared' : 'not-offered' };
}

/**
 * The formats the leaf can PRINT. A `--format` whose list has no `json` is
 * the format of a file the leaf reads (`bank statement import`), not output.
 */
function outputOf(options: readonly ManifestOption[]): ManifestCommand['output'] {
  const has = (name: string): boolean => options.some((o) => o.name === name);
  const listed = options.find((o) => o.name === 'format')?.choices ?? [];
  const formats = listed.includes('json') ? listed : has('json') ? ['json'] : [];
  return { formats, file: has('output') };
}

function rootOf(cmd: Command): Command {
  let top = cmd;
  while (top.parent) top = top.parent;
  return top;
}

/**
 * The manifest of every leaf under `program`.
 *
 * Fails instead of publishing less than the tree: a leaf without a
 * declaration, a declaration on a node that is not a leaf (the manifest would
 * drop it and the two counts would stop matching), or a default that is not
 * plain JSON.
 */
export function buildCommandManifest(program: Command): CommandManifest {
  const declared = new Map(
    allDeclarations()
      .filter(({ command }) => rootOf(command) === program)
      .map(({ command, risk }) => [command, risk] as const)
  );
  const leaves = hojasDe(program);

  const undeclared = leaves.filter((leaf) => !declared.has(leaf.cmd)).map((leaf) => leaf.ruta);
  if (undeclared.length > 0) throw new CommandManifestError('undeclared-leaf', undeclared.sort(byText));

  if (declared.size !== leaves.length) {
    const onLeaf = new Set(leaves.map((leaf) => leaf.cmd));
    const groups = [...declared.keys()].filter((cmd) => !onLeaf.has(cmd)).map((cmd) => cmd.name());
    throw new CommandManifestError('declared-group', groups.sort(byText));
  }

  const commands = leaves
    .map((leaf): ManifestCommand => {
      const { cmd } = leaf;
      const risk = declared.get(cmd)!;
      const options = optionsOf(cmd, leaf.ruta);
      return {
        path: leaf.ruta,
        aliases: [...cmd.aliases()],
        risk: risk.risk,
        agent: risk.agentAllowed,
        draft_only: risk.draftOnly === true,
        idempotency_key: keyBehaviourOf(risk),
        arguments: cmd.registeredArguments.map((a) => argumentOf(a, leaf.ruta)),
        options,
        output: outputOf(options),
      };
    })
    .sort((a, b) => byText(a.path, b.path));

  return {
    schema: MANIFEST_SCHEMA,
    binary: program.name(),
    exit_codes: Object.entries(ExitCode)
      .map(([name, code]) => ({ code, name }))
      .sort((a, b) => a.code - b.code),
    global_options: optionsOf(program, ''),
    commands,
  };
}

/** The lists printed one item per line, so one changed flag is one changed line. */
const ROWS: ReadonlySet<string> = new Set(['exit_codes', 'global_options', 'arguments', 'options']);

function print(value: unknown, indent: string, key?: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(value) && value.length > 0 && key !== undefined && (key === 'commands' || ROWS.has(key))) {
    const item = (v: unknown): string => (key === 'commands' ? print(v, inner) : JSON.stringify(v));
    return `[\n${value.map((v) => inner + item(v)).join(',\n')}\n${indent}]`;
  }
  if (key === undefined) {
    const fields = Object.entries(value as object).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${print(v, inner, k)}`);
    return `{\n${fields.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The bytes of `docs/command-manifest.json`: the same for the same tree, on any machine. */
export function renderCommandManifest(manifest: CommandManifest): string {
  return `${print(manifest, '')}\n`;
}
