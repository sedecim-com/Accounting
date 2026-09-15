import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================
// W0 · the noun registry's published counts are counted, not remembered.
//
// docs/cli-command-registry.md §2 says how many canonical nouns there are, once
// in total and once per owner file in each heading. Both were written by hand,
// and they drifted: §2.12 platform said (38) while it listed 39 nouns, and the
// total said 230 while the sections added up to 231. Adding `web` in W0 made it
// 40 against (38), which is how the gap was noticed.
//
// A section lists its nouns in one of two shapes, and only its first paragraph
// does: a table with one `| \`noun\` |` row per noun (ledger, bank), or a
// ` · `-separated run whose items start with the backticked noun. Bold remarks
// are removed first, because they quote nouns that are not entries (`was
// \`provider\`·\`proveedor\``). §2.1's first paragraph after the heading is the
// closed list of root commands, which the total includes.
// ============================================================

const REGISTRY = path.join(__dirname, '..', '..', 'docs', 'cli-command-registry.md');

interface Section {
  heading: string;
  published: number;
  listed: number;
}

function countListed(body: string): number {
  const first = body.trim().split(/\n\s*\n/)[0] ?? '';
  if (first.startsWith('|')) return first.split('\n').filter((line) => line.startsWith('| `')).length;
  const withoutRemarks = first.replace(/\*\*[\s\S]*?\*\*/g, '');
  return withoutRemarks.split(/\s·\s/).filter((item) => item.trim().startsWith('`')).length;
}

function sectionsOf(text: string): Section[] {
  const parts = text.split(/^### (2\.\d+ .*)$/m);
  const sections: Section[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i] ?? '';
    const number = Number(/^2\.(\d+)/.exec(heading)?.[1]);
    if (number > 12) break;
    const published = Number((/\((\d+)\)\s*$/.exec(heading) ?? /closed list of (\d+)/.exec(heading))?.[1]);
    sections.push({ heading, published, listed: countListed(parts[i + 1] ?? '') });
  }
  return sections;
}

describe('docs/cli-command-registry.md §2', () => {
  const text = readFileSync(REGISTRY, 'utf-8');
  const sections = sectionsOf(text);

  it('reads the twelve sections, from the root list to platform', () => {
    expect(sections.map((s) => s.heading.split(' ')[0])).toEqual(
      Array.from({ length: 12 }, (_, i) => `2.${i + 1}`)
    );
    expect(sections.find((s) => s.heading.startsWith('2.12'))?.heading).toContain('platform.md');
  });

  it('publishes in each heading the number of nouns the section lists', () => {
    for (const section of sections) {
      expect(section.listed, `§${section.heading}`).toBe(section.published);
    }
  });

  it('publishes as the total the sum of the sections', () => {
    const total = Number(/^(\d+) canonical nouns\./m.exec(text)?.[1]);
    expect(total).toBe(sections.reduce((sum, s) => sum + s.listed, 0));
  });
});
