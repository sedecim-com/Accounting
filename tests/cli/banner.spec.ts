import { describe, it, expect, afterEach } from 'vitest';
import { renderBanner, type BannerInfo } from '../../src/cli/banner.js';
import { palette, type Palette } from '../../src/cli/palette.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// Palette with the gate closed: every function is the identity.
const plain: Palette = palette({ isTTY: false } as unknown as NodeJS.WriteStream);

const FULL: BannerInfo = {
  version: '0.1.0',
  entityName: 'Acme Corporación SA de CV',
  taxId: 'ACO010101AB1',
  providerLabel: 'anthropic · claude-opus-5',
  language: 'es',
  pending: { drafts: 3, questions: 1, ops: 2 },
};

const MINIMAL: BannerInfo = { version: '0.1.0' };

function assertFits(lines: string[], columns: number): void {
  for (const line of lines) {
    expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
  }
}

describe('palette', () => {
  const saved = process.env.NO_COLOR;
  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });

  it('emits ANSI on a TTY without NO_COLOR', () => {
    delete process.env.NO_COLOR;
    const c = palette({ isTTY: true } as unknown as NodeJS.WriteStream);
    expect(c.green('ok')).toBe('\x1b[32mok\x1b[0m');
    expect(c.yellow('warn')).toBe('\x1b[33mwarn\x1b[0m');
  });

  it('is the identity when piped or NO_COLOR is set', () => {
    const piped = palette({ isTTY: false } as unknown as NodeJS.WriteStream);
    expect(piped.cyan('x')).toBe('x');
    process.env.NO_COLOR = '1';
    const noColor = palette({ isTTY: true } as unknown as NodeJS.WriteStream);
    expect(noColor.bold('x')).toBe('x');
  });
});

describe('renderBanner — wide panel (>= 80 cols)', () => {
  it('renders the full panel at 120 cols within width', () => {
    const lines = renderBanner(FULL, 120, plain);
    expect(lines.length).toBeGreaterThan(3);
    assertFits(lines, 120);
    const text = lines.join('\n');
    expect(text).toContain('Acme Corporación SA de CV');
    expect(text).toContain('(ACO010101AB1)');
    expect(text).toContain('anthropic · claude-opus-5');
    expect(text).toContain('es');
    expect(text).toContain('3 drafts · 1 question · 2 queued writes');
    expect(text).toContain('v0.1.0');
    expect(text).toContain('Your books, remembered.');
    expect(text).toContain('/help for commands');
    expect(text).not.toContain('undefined');
  });

  it('fits exactly at 80 cols (values clipped, never overflowing)', () => {
    const wide: BannerInfo = {
      ...FULL,
      entityName: 'A Very Long Corporate Name That Would Definitely Overflow The Column SA de CV',
    };
    const lines = renderBanner(wide, 80, plain);
    assertFits(lines, 80);
    expect(lines.join('\n')).toContain('…');
  });

  it('wordmark rows have consistent width', () => {
    const lines = renderBanner(MINIMAL, 120, plain).map(stripAnsi);
    // Rows containing block glyphs are the wordmark.
    const mark = lines.filter((l) => l.includes('█'));
    expect(mark).toHaveLength(2);
    expect(mark[0].trimEnd().length).toBe(mark[1].trimEnd().length);
  });

  it('includes the meander motif line', () => {
    const lines = renderBanner(MINIMAL, 100, plain).map(stripAnsi);
    expect(lines.some((l) => l.includes('┌┘'))).toBe(true);
  });

  it('omits absent fields and never prints "undefined"', () => {
    const lines = renderBanner(MINIMAL, 100, plain);
    const text = lines.join('\n');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('entity');
    expect(text).not.toContain('provider ');
    expect(text).not.toContain('draft');
  });

  it('omits the pending line when all counters are zero, and zero parts otherwise', () => {
    const allZero = renderBanner(
      { ...MINIMAL, pending: { drafts: 0, questions: 0, ops: 0 } },
      100,
      plain
    ).join('\n');
    expect(allZero).not.toContain('pending');

    const some = renderBanner(
      { ...MINIMAL, pending: { drafts: 1, questions: 0, ops: 0 } },
      100,
      plain
    ).join('\n');
    expect(some).toContain('1 draft');
    expect(some).not.toContain('question');
    expect(some).not.toContain('queued');
  });

  it('keeps width discipline when the palette emits real ANSI', () => {
    const saved = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const ansi = palette({ isTTY: true } as unknown as NodeJS.WriteStream);
      const lines = renderBanner(FULL, 90, ansi);
      assertFits(lines, 90);
      expect(lines.join('')).toContain('\x1b[');
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  });
});

describe('renderBanner — compact (40-79 cols)', () => {
  it('renders one headline plus a dim detail line at 60 cols', () => {
    const lines = renderBanner(FULL, 60, plain);
    expect(lines.length).toBe(2);
    assertFits(lines, 60);
    expect(stripAnsi(lines[0])).toContain('mnemosine v0.1.0');
    expect(stripAnsi(lines[1])).toContain('Acme Corporación');
    expect(stripAnsi(lines[1])).toContain('anthropic');
  });

  it('drops the tagline when it would not fit', () => {
    const lines = renderBanner(MINIMAL, 40, plain);
    assertFits(lines, 40);
    expect(stripAnsi(lines[0])).toContain('mnemosine v0.1.0');
    expect(lines[0]).not.toContain('remembered');
  });

  it('omits the detail line without entity or provider', () => {
    const lines = renderBanner(MINIMAL, 70, plain);
    expect(lines.length).toBe(1);
    expect(lines.join('\n')).not.toContain('undefined');
  });
});

describe('renderBanner — narrow (< 40 cols)', () => {
  it('returns [] below 40 columns', () => {
    expect(renderBanner(FULL, 39, plain)).toEqual([]);
    expect(renderBanner(FULL, 0, plain)).toEqual([]);
    expect(renderBanner(FULL, NaN, plain)).toEqual([]);
  });
});
