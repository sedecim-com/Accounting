import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_PROFILES } from '../../src/ai/providers/config.js';

// ============================================================
// The three places that list the built-in profiles name exactly
// BUILTIN_PROFILES (MNE-001-448, #644 P8): the table of
// src/cli/README.md, the list of src/ai/docs/connectivity.md and its
// count, and the table of the wiki's Proveedores-de-modelo page. The
// root README's sentence is prose, kept by hand.
// ============================================================

const ROOT = path.join(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
const builtins = Object.keys(BUILTIN_PROFILES).sort();

/** The first cell of each body row of the first table after `heading`. */
function firstColumn(markdown: string, heading: string): string[] {
  const from = markdown.indexOf(heading);
  expect(from, `${heading} is missing`).toBeGreaterThan(-1);
  const lines = markdown.slice(from).split('\n');
  const start = lines.findIndex((l) => l.startsWith('|'));
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(/^\|\s*`([^`]+)`/.exec(line)?.[1] ?? line);
  }
  return rows.sort();
}

describe('the provider tables follow BUILTIN_PROFILES', () => {
  it('src/cli/README.md', () => {
    expect(firstColumn(read('src/cli/README.md'), '## Model providers')).toEqual(builtins);
  });

  it('src/ai/docs/connectivity.md, with its count', () => {
    const m = /^(\d+) built-in profiles: ([\s\S]*?)\. `mnemosine providers`/m.exec(read('src/ai/docs/connectivity.md'));
    expect(m, 'the built-in sentence of connectivity.md is missing').not.toBeNull();
    expect(Number(m![1])).toBe(builtins.length);
    expect([...m![2].matchAll(/`([^`]+)`/g)].map((x) => x[1]).sort()).toEqual(builtins);
  });

  it('docs/wiki/Proveedores-de-modelo.md', () => {
    expect(firstColumn(read('docs/wiki/Proveedores-de-modelo.md'), '| Perfil |')).toEqual(builtins);
  });
});
