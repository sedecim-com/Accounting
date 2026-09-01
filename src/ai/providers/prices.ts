// ============================================================
// LOCAL MODEL PRICE TABLE
// USD per 1M tokens for the models the builtin profiles ship
// with (src/ai/providers/config.ts) plus their close families.
//
// AS-OF DATE: 2026-08-24. These are ESTIMATES for budgeting and
// attribution — never billing. Providers reprice without notice;
// an unknown or repriced model still gets its tokens recorded in
// ai_usage, only estimated_cost_usd is NULL (see usage-ledger).
//
// Matching is by case-insensitive prefix, longest prefix wins:
// "claude-opus-5" covers "claude-opus-5" and any dated variant;
// "gpt-4o-mini" wins over "gpt-4o" for "gpt-4o-mini-2024...".
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
}

/**
 * Anthropic cache rates follow the published multipliers:
 * read = 0.1 × input, write (5m ephemeral) = 1.25 × input.
 */
const anthropic = (prefix: string, input: number, output: number): ModelPrice => ({
  prefix,
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
export const PRECIOS_VIGENTES_A = '2026-08-24';

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
  anthropic('claude-sonnet-5', 3, 15),
  anthropic('claude-haiku-4', 1, 5),
  // Claude 3-generation ids put the generation number BEFORE the family
  // name ('claude-3-haiku-20240307', 'claude-3-5-haiku-20241022') — a
  // 'claude-haiku-3' prefix would be dead and leave those models unpriced.
  anthropic('claude-3-5-haiku', 0.8, 4),
  anthropic('claude-3-haiku', 0.25, 1.25),

  // --- OpenAI (cached input ≈ 0.5 × input; no write surcharge) ---
  { prefix: 'gpt-4o-mini', inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  { prefix: 'gpt-4o', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  { prefix: 'gpt-4.1-mini', inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1 },
  { prefix: 'gpt-4.1-nano', inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025 },
  { prefix: 'gpt-4.1', inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
  { prefix: 'gpt-5.1', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 },
  // gpt-5-pro bills far above the gpt-5 family rate; the longer prefix
  // pins it so the 'gpt-5' entry cannot underestimate it up to 12x.
  { prefix: 'gpt-5-pro', inputPerMTok: 15, outputPerMTok: 120 },
  { prefix: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 },

  // --- xAI ---
  { prefix: 'grok-4', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.75 },
  { prefix: 'grok-3-mini', inputPerMTok: 0.3, outputPerMTok: 0.5 },
  { prefix: 'grok-3', inputPerMTok: 3, outputPerMTok: 15 },

  // --- Google (Gemini, OpenAI-compat endpoint) ---
  { prefix: 'gemini-2.5-pro', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 },
  { prefix: 'gemini-2.5-flash', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075 },
  { prefix: 'gemini-2.0-flash', inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025 },

  // --- DeepSeek-style OpenRouter defaults ---
  { prefix: 'deepseek/deepseek-chat', inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 },
  { prefix: 'deepseek/deepseek-r1', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14 },
  { prefix: 'deepseek-chat', inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 },
  { prefix: 'deepseek-reasoner', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14 },
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
