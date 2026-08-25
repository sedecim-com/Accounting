import type { Palette } from './palette.js';

// ============================================================
// BANNER
// Mnemosine's visual identity: a half-block wordmark with a
// Greek-meander motif (Mnemosyne, titaness of memory) on the
// left, and a Hermes-style informative column on the right —
// entity, provider, response language, pending work.
//
// Pure function: returns lines, the caller prints (to stderr).
// Degradation is the palette's job (identity fns when piped or
// NO_COLOR); ours is width:
//   >= 80 cols  two-column panel
//   40-79 cols  one/two compact lines
//   <  40 cols  nothing ([])
// ============================================================

export interface BannerInfo {
  version: string;
  entityName?: string;
  taxId?: string;
  providerLabel?: string;
  language?: string;
  pending?: { drafts: number; questions: number; ops: number };
}

// Small-block font, 2 rows. Glyph widths: M5 N4 E3 M5 O3 S2 I1 N4 E3
// + 8 separators = 38 columns. Renders crisply in default macOS Terminal
// (all glyphs are single-width BMP block elements).
const WORDMARK: readonly string[] = [
  '█▀▄▀█ █▄ █ █▀▀ █▀▄▀█ █▀█ █▀ █ █▄ █ █▀▀',
  '█ ▀ █ █ ▀█ ██▄ █ ▀ █ █▄█ ▄█ █ █ ▀█ ██▄',
];
const WORDMARK_WIDTH = 38;
const LEFT_COLUMN_WIDTH = WORDMARK_WIDTH + 3; // wordmark + gap to the right column

const TAGLINE = 'Your books, remembered.';
const HINT = 'chat: just type · /help for commands · mnemosine status for a checkup';

/** Clip plain text to `max` visible columns, ellipsized. */
function clip(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function displayVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/** '3 drafts · 1 question · 2 queued writes' — zeros omitted; '' when all zero. */
function pendingSummary(p: NonNullable<BannerInfo['pending']>): string {
  const parts: string[] = [];
  if (p.drafts > 0) parts.push(`${p.drafts} ${p.drafts === 1 ? 'draft' : 'drafts'}`);
  if (p.questions > 0) parts.push(`${p.questions} ${p.questions === 1 ? 'question' : 'questions'}`);
  if (p.ops > 0) parts.push(`${p.ops} queued ${p.ops === 1 ? 'write' : 'writes'}`);
  return parts.join(' · ');
}

/** Right-column rows as label/value pairs, only for fields actually present. */
function rightRows(info: BannerInfo): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const entity = [info.entityName, info.taxId ? `(${info.taxId})` : '']
    .filter(Boolean)
    .join(' ');
  if (entity) rows.push({ label: 'entity', value: entity });
  if (info.providerLabel) rows.push({ label: 'provider', value: info.providerLabel });
  if (info.language) rows.push({ label: 'language', value: info.language });
  const pending = info.pending ? pendingSummary(info.pending) : '';
  if (pending) rows.push({ label: 'pending', value: pending });
  return rows;
}

function renderWide(info: BannerInfo, columns: number, c: Palette): string[] {
  const meander = '┌┘'.repeat(WORDMARK_WIDTH / 2);
  const byline = clip(`${displayVersion(info.version)} · ${TAGLINE}`, WORDMARK_WIDTH);

  // Left column: {colored text, plain width} so padding stays correct
  // whether or not the palette is emitting escapes.
  const left: Array<{ text: string; width: number }> = [
    { text: c.bold(c.cyan(WORDMARK[0])), width: WORDMARK_WIDTH },
    { text: c.bold(c.cyan(WORDMARK[1])), width: WORDMARK_WIDTH },
    { text: c.yellow(meander), width: meander.length },
    { text: c.dim(byline), width: byline.length },
  ];

  const labelWidth = 9; // longest label ('provider'/'language') + 1
  const valueMax = columns - LEFT_COLUMN_WIDTH - labelWidth;
  const right = rightRows(info).map(({ label, value }) => {
    const paddedLabel = label.padEnd(labelWidth);
    return c.dim(paddedLabel) + clip(value, valueMax);
  });

  const lines: string[] = [];
  const rowCount = Math.max(left.length, right.length);
  for (let i = 0; i < rowCount; i++) {
    const l = left[i] ?? { text: '', width: 0 };
    const r = right[i] ?? '';
    const line = r ? l.text + ' '.repeat(LEFT_COLUMN_WIDTH - l.width) + r : l.text;
    lines.push(line);
  }
  lines.push('');
  lines.push(c.dim(clip(HINT, columns)));
  return lines;
}

function renderCompact(info: BannerInfo, columns: number, c: Palette): string[] {
  const head = `mnemosine ${displayVersion(info.version)}`;
  const withTagline = `${head} — ${TAGLINE}`;
  const first =
    withTagline.length <= columns
      ? `${c.bold('mnemosine')} ${displayVersion(info.version)} — ${c.dim(TAGLINE)}`
      : `${c.bold('mnemosine')} ${clip(displayVersion(info.version), columns - 10)}`;

  const lines = [first];
  const detail = [rightRows(info).find((r) => r.label === 'entity')?.value, info.providerLabel]
    .filter(Boolean)
    .join(' · ');
  if (detail) lines.push(c.dim(clip(detail, columns)));
  return lines;
}

/**
 * Renders the entry banner. Pure: no I/O, no environment reads — the caller
 * decides the stream and columns, the palette decides whether color happens.
 * Returns [] when the terminal is too narrow to say anything gracefully.
 */
export function renderBanner(info: BannerInfo, columns: number, c: Palette): string[] {
  if (!Number.isFinite(columns) || columns < 40) return [];
  if (columns < 80) return renderCompact(info, columns, c);
  return renderWide(info, columns, c);
}
