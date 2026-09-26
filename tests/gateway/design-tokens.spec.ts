import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATIC_ASSETS } from '../../src/gateway/static-assets.js';
import { isFlagged } from '../../scripts/language/lexicon.js';

// ============================================================
// W1 · the house tokens: one map in two files, measured for contrast.
//
// tokens.css is what the page loads; tokens.json is the same map for anything
// that is not a stylesheet (no production reader yet: the CLI palette and the
// document templates are follow-ups). They are compared in both directions,
// the contrast the palette promises is computed here rather than asserted in
// a comment, and app.css may only use tokens that exist.
//
// The CSS is read with a dedicated pattern, not the plan's comment stripper,
// which takes CSS's `--` for SQL comments.
// ============================================================

const PUBLIC = path.join(__dirname, '..', '..', 'src', 'gateway', 'public');
const read = (rel: string) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

const tokensCss = read('design/tokens.css');
const appCss = read('app.css');
const shell = read('index.html');
const tokensJson = JSON.parse(read('design/tokens.json')) as { tokens: Record<string, string>; status_meanings: Record<string, string> };

/** The custom properties declared in the :root block, comments removed. */
function declaredTokens(css: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^}]*)\}/.exec(withoutComments);
  const found: Record<string, string> = {};
  for (const match of (root?.[1] ?? '').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found[match[1]] = match[2].trim();
  }
  return found;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tokens = declaredTokens(tokensCss);
const STATUSES = ['info', 'balanced', 'pending', 'blocked'];

describe('tokens.css and tokens.json are one map', () => {
  it('same names and values, in both directions', () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(15);
    expect(tokens).toEqual(tokensJson.tokens);
  });

  it('every status has a colour, a soft background and a fixed meaning', () => {
    expect(Object.keys(tokensJson.status_meanings).sort()).toEqual([...STATUSES].sort());
    for (const status of STATUSES) {
      expect(tokens[`status-${status}`], status).toMatch(/^#[0-9A-F]{6}$/);
      expect(tokens[`status-${status}-soft`], status).toMatch(/^#[0-9A-F]{6}$/);
      expect(tokensJson.status_meanings[status].trim()).not.toBe('');
    }
  });

  it('every name is English to the house lexicon', () => {
    for (const name of Object.keys(tokens)) {
      const camel = name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
      expect(isFlagged(camel), name).toBe(false);
      for (const segment of name.split('-')) expect(isFlagged(segment), `${name}: ${segment}`).toBe(false);
    }
  });

  it('the palette is light only, and says so', () => {
    expect(tokensCss).toMatch(/color-scheme:\s*light;/);
  });
});

describe('contrast is measured, not claimed', () => {
  const backgrounds = ['color-paper', 'color-surface', 'color-band'];

  it('ink and ink-muted reach 4.5:1 on every background and every soft status background', () => {
    const grounds = [...backgrounds, ...STATUSES.map((s) => `status-${s}-soft`)];
    for (const foreground of ['color-ink', 'color-ink-muted']) {
      for (const ground of grounds) {
        expect(contrast(tokens[foreground], tokens[ground]), `${foreground} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('each status colour reaches 4.5:1 on paper, surface, band and its own soft background', () => {
    for (const status of STATUSES) {
      for (const ground of [...backgrounds, `status-${status}-soft`]) {
        expect(contrast(tokens[`status-${status}`], tokens[ground]), `status-${status} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the focus ring reaches 3:1 against every background it can sit on', () => {
    for (const ground of [...backgrounds, ...STATUSES.map((s) => `status-${s}-soft`)]) {
      expect(contrast(tokens['color-focus'], tokens[ground]), `focus on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the contrast function is the WCAG one', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});

describe('app.css', () => {
  it('uses only tokens that exist', () => {
    const used = [...appCss.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const name of used) expect(tokens[name], name).toBeDefined();
  });

  it('draws a visible focus with the focus token', () => {
    expect(appCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-focus\);[^}]*outline-offset:\s*2px;/);
  });

  it('has no animation, no !important, and gives every tone class its status pair', () => {
    // Read without comments: the file's header says, in prose, what it does not do.
    expect(appCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/animation|transition|!important/);
    for (const status of ['info', 'balanced', 'pending']) {
      const rule = new RegExp(`\\.tone-${status}\\s*\\{[^}]*background:\\s*var\\(--status-${status}-soft\\);[^}]*color:\\s*var\\(--status-${status}\\);`);
      expect(appCss, status).toMatch(rule);
    }
  });
});

describe('nothing loads from elsewhere, and no font file ships', () => {
  it('no stylesheet or shell names an http(s) or protocol-relative URL', () => {
    for (const [name, content] of [['tokens.css', tokensCss], ['app.css', appCss], ['index.html', shell]]) {
      expect(content, name).not.toMatch(/(?:https?:)?\/\/[a-z0-9]/i);
    }
  });

  it('fonts are named with system fallbacks, never fetched: no @font-face, no url(), no font in the table', () => {
    for (const css of [tokensCss, appCss]) {
      expect(css).not.toMatch(/@font-face|url\(/);
    }
    expect(tokens['font-sans']).toMatch(/^'IBM Plex Sans', system-ui, .*sans-serif$/);
    expect(tokens['font-mono']).toMatch(/^'IBM Plex Mono', ui-monospace, .*monospace$/);
    expect(STATIC_ASSETS.filter(([published]) => published.endsWith('.woff2'))).toEqual([]);
  });

  it('the shell loads the tokens before the layout', () => {
    const tokensAt = shell.indexOf('href="/design/tokens.css"');
    const layoutAt = shell.indexOf('href="/app.css"');
    expect(tokensAt).toBeGreaterThan(0);
    expect(layoutAt).toBeGreaterThan(tokensAt);
  });
});
