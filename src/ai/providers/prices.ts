// ============================================================
// LOCAL MODEL PRICE TABLE
// USD per 1M tokens for the models the builtin profiles ship
// with (src/ai/providers/config.ts) plus their close families.
//
// AS-OF DATE: PRECIOS_VIGENTES_A below. These are ESTIMATES for budgeting
// and attribution — never billing. Providers reprice without notice;
// an unknown or repriced model still gets its tokens recorded in
// ai_usage, only estimated_cost_usd is NULL (see usage-ledger).
//
// Matching is by case-insensitive prefix, longest prefix wins:
// "claude-opus-5" covers "claude-opus-5" and any dated variant;
// "gpt-4o-mini" wins over "gpt-4o" for "gpt-4o-mini-2024...".
//
// SOURCES (MNE-001-449, #644): every row names the official page it was
// read from and the date. The 2026-11-20 reading went through search
// extracts of those pages, because the vendors' documentation hosts did not
// resolve from the session that read them; nothing was checked against a
// live bill. Where a page no longer lists a model, or lists it lower, the
// row keeps a rate at or above the published one and its source says so.
// ============================================================

export interface ModelPrice {
  /** Case-insensitive prefix matched against the model id. */
  prefix: string;
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cache-read tokens. Absent = billed at the input rate. */
  cacheReadPerMTok?: number;
  /** USD per 1M cache-write tokens. Absent = billed at the input rate. */
  cacheWritePerMTok?: number;
  /** The official page this row was read from, and `read YYYY-MM-DD`. */
  source: string;
}

const READ = 'read 2026-11-20';
const ANTHROPIC_PRICING = `https://platform.claude.com/docs/en/about-claude/pricing, ${READ}`;
const OPENAI_PRICING = `https://developers.openai.com/api/docs/pricing, ${READ}`;
const XAI_PRICING = `https://docs.x.ai/developers/pricing, ${READ}`;
const XAI_RETIRED =
  `https://docs.x.ai/developers/migration/may-15-retirement, ${READ}: retired on 2026-05-15 and now ` +
  'billed at grok-4.3 rates; kept at its last rate, which is higher';
const GEMINI_PRICING = `https://ai.google.dev/gemini-api/docs/pricing, ${READ}`;
const DEEPSEEK_LEGACY =
  `https://api-docs.deepseek.com/quick_start/pricing/, ${READ}: the page now lists V4 rates and ` +
  'does not map this id; kept at its launch rate';

/**
 * Anthropic cache rates follow the published multipliers:
 * read = 0.1 × input, write (5m ephemeral) = 1.25 × input.
 */
const anthropic = (
  prefix: string,
  input: number,
  output: number,
  source = ANTHROPIC_PRICING
): ModelPrice => ({
  prefix,
  source,
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: input * 0.1,
  cacheWritePerMTok: input * 1.25,
});

// INVARIANT: estimates must surprise DOWNWARD in the report, never in the
// bill — when a prefix is ambiguous between a cheap and an expensive model
// family, it must be priced at the EXPENSIVE one (overestimate, never
// underestimate). Longer prefixes below pin the expensive legacy ids that
// a shorter family prefix would otherwise underprice.
/**
 * Fecha de corte de esta tabla, COMO DATO y no como comentario (S1): la
 * salida de `mnemosine usage` la muestra, para que un costo estimado con
 * precios de hace un año no se lea como costo de hoy. Actualizar la tabla
 * implica actualizar esta fecha — están juntas a propósito.
 */
export const PRECIOS_VIGENTES_A = '2026-11-20';

export const PRICE_TABLE: ModelPrice[] = [
  // --- Anthropic (first-party API rates) ---
  // Legacy Opus 4/4.1 ($15/$75) sort ahead of the 'claude-opus-4' family
  // entry ($5/$25, correct for Opus 4.5+) by prefix length: the dated ids
  // claude-opus-4-20250514 / claude-opus-4-0 / claude-opus-4-1[-20250805]
  // must never be underpriced 3x by the cheaper family rate.
  anthropic('claude-opus-4-2025', 15, 75),
  anthropic('claude-opus-4-0', 15, 75),
  anthropic('claude-opus-4-1', 15, 75),
  anthropic('claude-opus-4', 5, 25),
  anthropic('claude-opus-5', 5, 25),
  anthropic('claude-sonnet-4', 3, 15),
  anthropic(
    'claude-sonnet-5',
    3,
    15,
    `${ANTHROPIC_PRICING}: the models overview lists $2/$10 and the pricing table leaves it ` +
      'blank; kept at $3/$15 until the table confirms it'
  ),
  anthropic('claude-haiku-4', 1, 5),
  // Claude 3-generation ids put the generation number BEFORE the family
  // name ('claude-3-haiku-20240307', 'claude-3-5-haiku-20241022') — a
  // 'claude-haiku-3' prefix would be dead and leave those models unpriced.
  anthropic('claude-3-5-haiku', 0.8, 4),
  anthropic(
    'claude-3-haiku',
    0.25,
    1.25,
    `${ANTHROPIC_PRICING}: no longer listed there; kept at its last listed rate`
  ),

  // --- OpenAI (cached input ≈ 0.5 × input; no write surcharge) ---
  { prefix: 'gpt-4o-mini', inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075, source: OPENAI_PRICING },
  { prefix: 'gpt-4o', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25, source: OPENAI_PRICING },
  { prefix: 'gpt-4.1-mini', inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1, source: OPENAI_PRICING },
  {
    prefix: 'gpt-4.1-nano',
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.025,
    source: `https://developers.openai.com/api/docs/models/gpt-4.1-nano, ${READ}: shut down`,
  },
  { prefix: 'gpt-4.1', inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, source: OPENAI_PRICING },
  {
    prefix: 'gpt-5.1',
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    source: `https://developers.openai.com/api/docs/models/gpt-5.1, ${READ}`,
  },
  // gpt-5-pro bills far above the gpt-5 family rate; the longer prefix
  // pins it so the 'gpt-5' entry cannot underestimate it up to 12x.
  { prefix: 'gpt-5-pro', inputPerMTok: 15, outputPerMTok: 120, source: OPENAI_PRICING },
  { prefix: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, source: OPENAI_PRICING },

  // --- xAI ---
  // grok-4.3 bills a prompt of 200K or more at $2.50/$5 for all its tokens;
  // the grok profile's declared window stops at 200 000, so the row is the
  // rate below that step.
  { prefix: 'grok-4.3', inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2, source: XAI_PRICING },
  // 'grok-4' also catches grok-4.7: $2/$6 under 200K on the same page, so
  // this row overestimates it except on input above 200K ($4).
  { prefix: 'grok-4', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.75, source: XAI_RETIRED },
  {
    prefix: 'grok-3-mini',
    inputPerMTok: 0.3,
    outputPerMTok: 0.5,
    source: `${XAI_PRICING}: no longer listed there; kept at its last rate`,
  },
  { prefix: 'grok-3', inputPerMTok: 3, outputPerMTok: 15, source: XAI_RETIRED },

  // --- Google (Gemini, OpenAI-compat endpoint) ---
  // The rate Google publishes from 2027-01-01, the higher one: the
  // introductory $0.75/$3.75 ends on 2026-12-31. The prefix also matches
  // variants such as -cyber, whose price was not read.
  { prefix: 'gemini-3.8-flash', inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15, source: GEMINI_PRICING },
  // Above 200K prompt tokens, the rate of every request at that size. The
  // gemini profile declares a 1M window, so a model override can reach it;
  // the page lists no standard cache rate, so cache reads bill at input.
  { prefix: 'gemini-2.5-pro', inputPerMTok: 2.5, outputPerMTok: 15, source: GEMINI_PRICING },
  { prefix: 'gemini-2.5-flash', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075, source: GEMINI_PRICING },
  {
    prefix: 'gemini-2.0-flash',
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.025,
    source: `${GEMINI_PRICING}: no longer listed there; kept at its last rate`,
  },

  // --- DeepSeek-style OpenRouter defaults ---
  { prefix: 'deepseek/deepseek-chat', inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07, source: DEEPSEEK_LEGACY },
  { prefix: 'deepseek/deepseek-r1', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, source: DEEPSEEK_LEGACY },
  { prefix: 'deepseek-chat', inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07, source: DEEPSEEK_LEGACY },
  { prefix: 'deepseek-reasoner', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, source: DEEPSEEK_LEGACY },
];

/**
 * Longest-matching-prefix lookup, case-insensitive. Returns null for
 * anything the table does not know (local Ollama models, hermes-agent,
 * openrouter/auto, onboarding-wizard): the caller records the tokens
 * anyway with a NULL cost — no estimate beats a wrong estimate.
 */
export function lookupPrice(model: string): ModelPrice | null {
  const normalized = model.trim().toLowerCase();
  let best: ModelPrice | null = null;
  for (const entry of PRICE_TABLE) {
    if (normalized.startsWith(entry.prefix.toLowerCase())) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best;
}
