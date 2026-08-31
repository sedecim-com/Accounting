import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';
import { buildSearchTools } from './search-tools.js';
import { buildLedgerTools } from './ledger-tools.js';
import { buildReportTools } from './report-tools.js';
import { buildDraftTools } from './draft-tools.js';
import { buildQuestionTools } from './question-tools.js';
import { buildDocsTools } from './docs-tools.js';
import { buildExternalTools } from './external-tools.js';
import { buildStatusTools } from './status-tools.js';
import { buildSkillsTools } from './skills-tools.js';
import { buildSessionSearchTools } from './session-search-tools.js';

export type { ToolObserver, ToolDeps, AskUserFn, AskUserPrompt, DraftCreatedInfo } from './observer.js';

// ============================================================
// TOOL-RESULT SIZE CAP (Hermes tool_output.max_bytes pattern)
// A single runaway result (an unfiltered ledger dump) can blow
// the context window and evict the cached prefix. Deterministic
// truncation with an actionable marker: the model is told HOW
// to get the rest (filters, date ranges, pagination), so it
// refines instead of retrying the same oversized call.
// ============================================================

export const MAX_TOOL_RESULT_CHARS = 32000;

const TRUNCATION_MARKER =
  `\n[... result truncated at ${MAX_TOOL_RESULT_CHARS} chars — ` +
  `refine your query (filters, date ranges, pagination) to see the rest]`;

/**
 * Wraps a tool so any string result over the cap is truncated with a clear
 * marker. Non-string results pass through untouched (the runner stringifies
 * them later); everything else about the tool is preserved.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withResultCap<T extends { run: (...args: any[]) => any }>(tool: T): T {
  const originalRun = tool.run.bind(tool);
  return {
    ...tool,
    run: async (...args: Parameters<T['run']>) => {
      const result = await originalRun(...args);
      if (typeof result === 'string' && result.length > MAX_TOOL_RESULT_CHARS) {
        return result.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_MARKER;
      }
      return result;
    },
  };
}

/**
 * All tools available to the agent for this session. Reads go straight to
 * the ledger; the write surfaces are ai_drafts (draft_journal_entry) y
 * ai_questions (ask_user) — posting real entries requires human approval
 * via `mnemosine review`.
 */
export function buildTools(
  ctx: AgentContext,
  deps: ToolDeps,
  /**
   * Lista blanca de nombres. Cuando viene, la sesión recibe EXACTAMENTE esas
   * herramientas — una corrida desatendida pasa aquí su superficie nombrada
   * (tools/superficie.ts) y una herramienta nueva queda fuera de lo
   * desatendido hasta que alguien la añada a esa lista. Un nombre que no
   * exista LANZA en vez de ignorarse: una lista con un nombre renombrado que
   * filtrara en silencio sería una superficie distinta de la que su autor
   * cree haber declarado.
   */
  permitidas?: readonly string[]
) {
  const todas = [
    ...buildSearchTools(ctx, deps.observe),
    ...buildLedgerTools(ctx, deps.observe),
    ...buildReportTools(ctx, deps.observe),
    ...buildDraftTools(ctx, deps),
    ...buildQuestionTools(ctx, deps),
    ...buildDocsTools(deps),
    ...buildExternalTools(ctx, deps),
    ...buildStatusTools(ctx, deps),
    ...buildSkillsTools(ctx, deps),
    ...buildSessionSearchTools(ctx, deps),
  ].map(withResultCap);
  if (!permitidas) return todas;

  const existentes = new Set(todas.map((t) => t.name));
  const fantasmas = permitidas.filter((n) => !existentes.has(n));
  if (fantasmas.length > 0) {
    throw new Error(
      `La lista de herramientas permitidas nombra ${fantasmas.length} que no existen ` +
        `(${fantasmas.join(', ')}). Si una herramienta se renombró, actualiza la lista: ` +
        'una superficie con nombres muertos no es la que su autor declaró.'
    );
  }
  const admitidas = new Set(permitidas);
  return todas.filter((t) => admitidas.has(t.name));
}
