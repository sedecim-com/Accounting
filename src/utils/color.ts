// ============================================================
// THE COLOUR GATE
// One rule for every surface that writes to the accountant's terminal:
// the CLI palette (src/cli/palette.ts) and the logger's console format
// (src/utils/logger.ts). It lives in utils so the logger never imports
// from the CLI layer. Pure: it reads only what it is given.
// ============================================================

/**
 * Colour only on a real terminal, and never when NO_COLOR is present and
 * non-empty (https://no-color.org). Piped or redirected output stays
 * byte-clean.
 */
export function colorEnabled(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return stream.isTTY === true && !env.NO_COLOR;
}
