import fs from 'node:fs';
import path from 'node:path';
import type { Command, Option } from 'commander';
import { describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';

// ============================================================
// MNE-001-084 (#325) · the wiki manuals only teach commands the binary has.
//
// An accountant learns the product from docs/wiki/Manual-*.md. A manual that
// says "there is no `period reopen`" takes a tool away from them; one that
// documents a flag the command rejects sends them to an exit 2. Both happened:
// five families were written up as missing after they shipped, and
// `account map check --level 3` stayed in three manuals after the flag was
// retired. This spec holds the part a machine can hold, against the shipped
// commander tree:
//   1. every `mnemosine ...` line inside a fenced block lands on a real node,
//      and every flag it passes is declared on that node or an ancestor and
//      is not marked retired;
//   2. no manual says "no hay / no existe `<command>`" about a command path
//      the tree has.
// ============================================================

const WIKI = path.resolve(__dirname, '../../docs/wiki');
const MANUALS = fs
  .readdirSync(WIKI)
  .filter((f) => /^Manual-.*\.md$/.test(f) || f === 'Puesta-en-marcha.md')
  .sort();

function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function subcommand(node: Command, name: string): Command | undefined {
  return (node.commands as Command[]).find((c) => c.name() === name || c.aliases().includes(name));
}

function declared(chain: Command[], flag: string): Option | undefined {
  for (const node of [...chain].reverse()) {
    const hit = (node.options as Option[]).find((o) => o.long === flag || o.short === flag);
    if (hit) return hit;
  }
  return undefined;
}

const SHELL_STOP = new Set(['|', '>', '>>', '<', '&&', '||', ';', '2>&1']);
const PLACEHOLDER = /^<.*>?$|^algo$/;

/** Why the invocation does not parse against the tree, or null when it does. */
function problemWith(line: string): string | null {
  const tokens = tokenize(line);
  const start = tokens.findIndex((t) => t === 'mnemosine');
  let rest = tokens.slice(start + 1);
  if (rest[0] === '--') rest = rest.slice(1);
  const stop = rest.findIndex((t) => SHELL_STOP.has(t) || t.startsWith('#'));
  if (stop >= 0) rest = rest.slice(0, stop);

  const chain: Command[] = [program];
  let positional = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const node = chain[chain.length - 1];
    if (token.startsWith('-') && token !== '-') {
      const flag = token.split('=')[0];
      const option = declared(chain, flag);
      if (!option) return `unknown option ${flag} on "${node.name()}"`;
      if (/retired/i.test(option.description)) return `retired option ${flag} on "${node.name()}"`;
      const takesValue = option.required || (option.optional && rest[i + 1] && !rest[i + 1].startsWith('-'));
      if (takesValue && !token.includes('=')) i++;
      continue;
    }
    if (positional) continue;
    const next = subcommand(node, token);
    if (next) {
      chain.push(next);
      continue;
    }
    if (PLACEHOLDER.test(token)) return null;
    if (node.commands.length > 0) return `"${token}" is not a subcommand of "${node.name()}"`;
    positional = true;
  }
  return null;
}

/** Every `mnemosine` invocation inside a fenced block, continuation lines joined. */
function fencedInvocations(file: string): { where: string; line: string }[] {
  const out: { where: string; line: string }[] = [];
  const lines = fs.readFileSync(path.join(WIKI, file), 'utf8').split('\n');
  let fenced = false;
  let pending = '';
  let from = 0;
  lines.forEach((raw, n) => {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) return;
    if (!pending) from = n + 1;
    if (raw.trimEnd().endsWith('\\')) {
      pending += raw.trimEnd().slice(0, -1) + ' ';
      return;
    }
    const joined = pending + raw;
    pending = '';
    if (/(^|\s)mnemosine(\s|$)/.test(joined)) out.push({ where: `${file}:${from}`, line: joined.trim() });
  });
  return out;
}

function commandPaths(node: Command, prefix: string[] = []): string[] {
  return (node.commands as Command[]).flatMap((c) => {
    const here = [...prefix, c.name()];
    return [here.join(' '), ...commandPaths(c, here)];
  });
}

describe('the wiki manuals and the shipped command tree', () => {
  it('reads the manuals it is meant to guard', () => {
    expect(MANUALS).toContain('Manual-El-cierre-de-mes.md');
    expect(MANUALS).toContain('Puesta-en-marcha.md');
  });

  it('every fenced mnemosine invocation parses against the tree', () => {
    const invocations = MANUALS.flatMap(fencedInvocations);
    expect(invocations.length).toBeGreaterThan(100);
    const broken = invocations
      .map(({ where, line }) => ({ where, line, problem: problemWith(line) }))
      .filter((r) => r.problem !== null)
      .map((r) => `${r.where}: ${r.problem} — ${r.line}`);
    expect(broken).toEqual([]);
  });

  it('no manual says a command the tree has does not exist', () => {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const denials = commandPaths(program).map(
      (p) => [p, new RegExp(`no (?:hay|existen?)(?: ni)?\\s+\`(?:mnemosine )?${escape(p)}\``, 'i')] as const
    );
    const found = MANUALS.flatMap((file) =>
      fs
        .readFileSync(path.join(WIKI, file), 'utf8')
        .split('\n')
        .flatMap((text, n) => denials.filter(([, re]) => re.test(text)).map(([p]) => `${file}:${n + 1} denies \`${p}\``))
    );
    expect(found).toEqual([]);
  });

  it('catches the two defects #325 found, so the guard is not vacuous', () => {
    expect(problemWith('mnemosine account map check --scheme sat-agrupador --level 3 --strict')).toMatch(/retired option --level/);
    expect(problemWith('mnemosine banca')).toMatch(/not a subcommand/);
    expect(problemWith('npm run mnemosine -- period reopen 2026-07 --dry-run')).toBeNull();
  });
});
