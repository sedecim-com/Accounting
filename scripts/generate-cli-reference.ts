/**
 * Generates src/ai/docs/cli-reference.md from the commander program itself.
 *
 * Walks the exported `program` object (src/cli/mnemosine.ts) and emits each
 * command's own helpInformation() — byte-identical to what `mnemosine <cmd>
 * --help` prints — without spawning one process per command and without
 * parsing help text (both failure modes of the earlier shell generator).
 *
 * Run: npx tsx scripts/generate-cli-reference.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { program } from '../src/cli/mnemosine.js';

const HEADER = `# CLI reference (auto-generated — do not edit by hand)

Regenerate with: \`npx tsx scripts/generate-cli-reference.ts\`.

This is the EXACT surface of the \`mnemosine\` binary: quote commands and
flags verbatim when guiding a human — never invent a flag that is not
listed here. When a flow needs several commands, give them in order.

Notes for the agent:
- The global option \`-T, --tenant <uuid>\` (or the \`MNEMOSINE_TENANT\` env
  var) scopes EVERY command under row-level security. It appears only on
  the root help below, but it works before any subcommand.
- Spanish aliases (shown as \`name|alias\`) are equivalent to the English
  names; use whichever matches the user's language.
`;

function heading(depth: number): string {
  return '#'.repeat(Math.min(depth, 6));
}

function section(cmd: Command, chain: string[], depth: number, out: string[]): void {
  const fullName = [...chain, cmd.name()].join(' ');
  const aliases = cmd.aliases().filter(Boolean);
  const alias = aliases.length ? ` (alias: ${aliases.join(', ')})` : '';
  out.push(`${heading(depth)} \`${fullName}\`${alias}`, '');
  out.push('```', cmd.helpInformation().trimEnd(), '```', '');
  for (const sub of cmd.commands) {
    section(sub, [...chain, cmd.name()], depth + 1, out);
  }
}

const out: string[] = [HEADER];
out.push('## `mnemosine` (root)', '');
out.push('```', program.helpInformation().trimEnd(), '```', '');
for (const cmd of program.commands) {
  section(cmd, ['mnemosine'], 2, out);
}

// __dirname nativo en lugar de import.meta, igual que build-niif-indice.ts:
// el proyecto compila a CommonJS (tsconfig NodeNext sin "type": "module"),
// donde import.meta es un error de compilación (TS1470).
const target = path.join(__dirname, '..', 'src', 'ai', 'docs', 'cli-reference.md');
fs.writeFileSync(target, out.join('\n') + '\n');

const commandCount = (out.join('\n').match(/^#{2,6} `/gm) ?? []).length - 1;
console.log(`Wrote ${target} — ${commandCount} command sections.`);
process.exit(0);
