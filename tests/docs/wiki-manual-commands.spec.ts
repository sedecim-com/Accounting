import fs from 'node:fs';
import path from 'node:path';
import type { Command, Option } from 'commander';
import { describe, expect, it } from 'vitest';
import { program } from '../../src/cli/mnemosine.js';
import { RETIRED_OPTION_PREFIX } from '../../src/cli/kernel/index.js';
import { CLOSE_CHECK_ITEMS } from '../../src/services/accounting/period-close.js';

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
//      the tree has, nor denies, in its own words, one of the families #325
//      names (batch, period reopen, cashflow, e-accounting, diot) or bank;
//   3. no manual repeats a claim the code has since made false, and the
//      close-checklist prose stays tied to the checklist the code builds.
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
      if (option.description.startsWith(RETIRED_OPTION_PREFIX)) return `retired option ${flag} on "${node.name()}"`;
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
    if (PLACEHOLDER.test(token)) {
      // A placeholder stands for a positional; the flags after it still count.
      positional = true;
      continue;
    }
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

/**
 * The families #325 found written up as missing after they shipped, with the
 * words an accountant uses for them. The guard on backticked command paths
 * cannot see how the old manuals mostly denied these: in prose or in a table
 * row ("DIOT | ❌ No existe", "La familia que valida y aplica ese lote todavía
 * no existe").
 */
const FAMILY_NAMES: readonly (readonly [string, RegExp])[] = [
  ['batch', /`(?:mnemosine )?batch\b|familia que (?:valida|aplica)|aplicar? (?:ese |el |un )?lote/i],
  ['period reopen', /period reopen|reabr(?:ir|e)\b/i],
  ['cashflow', /`(?:mnemosine )?cashflow\b|flujos? de efectivo|NIF B-2\b/i],
  ['e-accounting', /`(?:mnemosine )?e-accounting\b|contabilidad electr[oó]nica/i],
  ['diot', /`(?:mnemosine )?diot\b|\bDIOT\b/],
  ['bank', /`(?:mnemosine )?bank\b|conciliar el banco|conciliaci[oó]n bancaria|familia de bancos/i],
];

/** How the old manuals said "this is not here". */
const DENIAL =
  /no existe|todavía no|no hay (?:comando|familia)|fuera de mnemosine|no se generan?\b|no genere\b|\|\s*(?:—\s*\|\s*)?\*\*No\*\*\s*\||❌/i;

/**
 * What a family still lacks, and a manual must stay free to say: e-accounting
 * builds the catalog and the trial balance, not the pólizas and auxiliares.
 */
const STILL_MISSING: Record<string, RegExp> = {
  'e-accounting': /p[oó]lizas y (?:los )?auxiliares/i,
};

/** The families a manual line denies: a family name and a denial on the same line. */
function familiesDenied(text: string): string[] {
  if (!DENIAL.test(text)) return [];
  return FAMILY_NAMES.filter(([family, names]) => names.test(text) && !STILL_MISSING[family]?.test(text)).map(
    ([family]) => family
  );
}

/**
 * Claims a manual once made that the code has since made false, with what
 * made them false. A manual that repeats one teaches a behaviour the binary
 * no longer has.
 */
const STALE_CLAIMS: readonly (readonly [RegExp, string])[] = [
  [
    /sin generar (?:el traspaso|los asientos de cierre)|se saltan en silencio|terminar bien sin haber traspasado/i,
    'the year-end hard close without 3900/3200 runs verificarQueElEjercicioBarrio (period-close.ts) and, by default, rolls back',
  ],
  [
    /El resultado va a la 3200, no a la 3300/,
    'the destination follows destino_del_resultado_del_ejercicio, whose default is 3300',
  ],
];

const SPANISH_COUNTS: Record<string, number> = {
  cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciséis: 16, diecisiete: 17, dieciocho: 18,
};

function manualLines(): { where: string; text: string }[] {
  return MANUALS.flatMap((file) =>
    fs
      .readFileSync(path.join(WIKI, file), 'utf8')
      .split('\n')
      .map((text, n) => ({ where: `${file}:${n + 1}`, text }))
  );
}

function section(file: string, heading: string): string {
  const text = fs.readFileSync(path.join(WIKI, file), 'utf8');
  const from = text.indexOf(heading);
  expect(from, `${file} has no heading "${heading}"`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', from + heading.length);
  return text.slice(from, next < 0 ? undefined : next);
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

  it('no manual denies, in prose or in a table, a family #325 names', () => {
    const found = manualLines().flatMap(({ where, text }) =>
      familiesDenied(text).map((family) => `${where} denies ${family}: ${text.trim().slice(0, 140)}`)
    );
    expect(found).toEqual([]);
  });

  it('the prose-denial matcher catches what the old manuals said, and spares what is still true', () => {
    // Verbatim from the manuals as they stood before #325.
    const old: [string, string][] = [
      ['batch', 'La familia que valida y aplica ese lote todavía no existe, así que un `batch_id` hoy no se puede consumir con ningún comando.'],
      ['batch', '| Aplicar un lote de `entry import` | El lote se queda escenificado; la familia que lo aplica no existe todavía | Capturar los saldos iniciales como una póliza manual (ver [[Manual-Primer-cliente]]) |'],
      ['period reopen', '`period open` sólo abre periodos **futuros**. No reabre uno cerrado, y **no existe un comando para reabrir un periodo cerrado**: el motor lo tiene, pero no está expuesto.'],
      ['period reopen', '| Reabrir un periodo cerrado | No hay comando | La corrección se registra en un periodo abierto. Piénsalo antes de cerrar |'],
      ['cashflow', '| Estado de flujos de efectivo (NIF B-2) | ❌ No existe | Fuera del sistema |'],
      ['cashflow', '| Estado de flujos de efectivo (NIF B-2) | — | **No** |'],
      ['e-accounting', '| XML de contabilidad electrónica (Anexo 24) | ❌ No existe el generador | Exportar la balanza a CSV y armarlo fuera |'],
      ['e-accounting', 'hay que hacerlo aunque hoy mnemosine todavía no genere el XML de contabilidad electrónica'],
      ['diot', '| DIOT | ❌ No existe | `vendor list --no-tax-id` para desbloquear los RFC faltantes; el armado, fuera |'],
      ['diot', '| DIOT | — | **No** |'],
      ['bank', 'No existe `bank`, ni `banco`, ni `conciliacion` en el árbol de comandos.'],
      ['bank', 'Y lo que sigue haciéndose fuera de mnemosine, sin excepción: bajar los CFDI del portal del SAT, timbrar, cancelar, emitir los REP, conciliar el banco y generar la contabilidad electrónica y la DIOT.'],
    ];
    for (const [family, sentence] of old) expect(familiesDenied(sentence), sentence).toContain(family);
    // Still true, and must stay sayable: the Anexo 24 pólizas and auxiliares
    // have no generator, and sealing and filing are the accountant's acts.
    expect(familiesDenied('| Pólizas y auxiliares del Anexo 24 en XML | ❌ No existe el generador | Exportar pólizas y auxiliar a CSV |')).toEqual([]);
    expect(familiesDenied('- **Anexo 24.** `e-accounting` arma el catálogo y la balanza. Las pólizas y los auxiliares en XML no se generan.')).toEqual([]);
    expect(familiesDenied('- sellar con la e.firma y presentar ante el SAT los XML del Anexo 24 y la DIOT.')).toEqual([]);
  });

  it('no manual repeats a claim the code has since made false', () => {
    const found = manualLines().flatMap(({ where, text }) =>
      STALE_CLAIMS.filter(([claim]) => claim.test(text)).map(([, why]) => `${where}: ${why}`)
    );
    expect(found).toEqual([]);
  });

  it('a stated size of the close checklist matches the checklist the code builds', () => {
    const items = Object.keys(CLOSE_CHECK_ITEMS).length;
    const stated = manualLines().flatMap(({ where, text }) =>
      [...text.matchAll(/(\p{L}+) (?:partidas|compuertas)\b/gu)]
        .map((m) => SPANISH_COUNTS[m[1].toLowerCase()])
        .filter((count) => count !== undefined && count !== items)
        .map((count) => `${where}: states ${count}, the code builds ${items}`)
    );
    expect(stated).toEqual([]);
  });

  it('the bank manual names the close items that read its sessions, and the review queue its drafts meet', () => {
    const close = section('Manual-Bancos-y-conciliacion.md', '## Qué ve el cierre de mes');
    expect(close).toContain(CLOSE_CHECK_ITEMS['bank-reconciled']);
    expect(close).toContain(CLOSE_CHECK_ITEMS['bank-variance-frozen']);
    expect(section('Manual-Bancos-y-conciliacion.md', '## 5. Explicar la diferencia')).toContain('mnemosine review');
  });

  it('the reopen of a hard-closed period teaches the second close the CLI prints', () => {
    const reopen = section('Manual-El-cierre-de-mes.md', '## Qué se puede reabrir y qué no');
    expect(reopen).toMatch(/close --period \S+(?: \S+)? --hard/);
  });

  it('catches the two defects #325 found, so the guard is not vacuous', () => {
    expect(problemWith('mnemosine account map check --scheme sat-agrupador --level 3 --strict')).toMatch(/retired option --level/);
    expect(problemWith('mnemosine banca')).toMatch(/not a subcommand/);
    expect(problemWith('npm run mnemosine -- period reopen 2026-07 --dry-run')).toBeNull();
    // A placeholder is a positional, not the end of the line: the flags after it are checked.
    expect(problemWith('mnemosine batch show <batch_id> --errors-only')).toBeNull();
    expect(problemWith('mnemosine batch show <batch_id> --error-only')).toMatch(/unknown option --error-only/);
  });
});
