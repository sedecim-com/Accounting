import type { Palette } from './palette.js';
import { t } from '../i18n/index.js';

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
  if (p.drafts > 0) parts.push(t('banner.pending.drafts', { count: p.drafts }));
  if (p.questions > 0) parts.push(t('banner.pending.questions', { count: p.questions }));
  if (p.ops > 0) parts.push(t('banner.pending.writes', { count: p.ops }));
  return parts.join(' · ');
}

/** 'Name (RFC)', or '' when neither is known. */
function entityText(info: BannerInfo): string {
  return [info.entityName, info.taxId ? `(${info.taxId})` : ''].filter(Boolean).join(' ');
}

const LABELS = ['entity', 'provider', 'language', 'pending'] as const;

/** Right-column rows as label/value pairs, only for fields actually present. */
function rightRows(info: BannerInfo): Array<{ label: string; value: string }> {
  const values = [entityText(info), info.providerLabel, info.language, info.pending ? pendingSummary(info.pending) : ''];
  return LABELS.map((k, i) => ({ label: t(`banner.label.${k}`), value: values[i] ?? '' })).filter((r) => r.value);
}

function renderWide(info: BannerInfo, columns: number, c: Palette): string[] {
  const meander = '┌┘'.repeat(WORDMARK_WIDTH / 2);
  const byline = clip(`${displayVersion(info.version)} · ${t('banner.tagline')}`, WORDMARK_WIDTH);

  // Left column: {colored text, plain width} so padding stays correct
  // whether or not the palette is emitting escapes.
  const left: Array<{ text: string; width: number }> = [
    { text: c.bold(c.cyan(WORDMARK[0])), width: WORDMARK_WIDTH },
    { text: c.bold(c.cyan(WORDMARK[1])), width: WORDMARK_WIDTH },
    { text: c.yellow(meander), width: meander.length },
    { text: c.dim(byline), width: byline.length },
  ];

  // The longest label of the language plus one: 9 in English ('provider'/'language').
  const labelWidth = Math.max(...LABELS.map((k) => t(`banner.label.${k}`).length)) + 1;
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
  lines.push(c.dim(clip(t('banner.hint'), columns)));
  return lines;
}

function renderCompact(info: BannerInfo, columns: number, c: Palette): string[] {
  const head = `mnemosine ${displayVersion(info.version)}`;
  const tagline = t('banner.tagline');
  const withTagline = `${head} — ${tagline}`;
  const first =
    withTagline.length <= columns
      ? `${c.bold('mnemosine')} ${displayVersion(info.version)} — ${c.dim(tagline)}`
      : `${c.bold('mnemosine')} ${clip(displayVersion(info.version), columns - 10)}`;

  const lines = [first];
  const detail = [entityText(info), info.providerLabel]
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
