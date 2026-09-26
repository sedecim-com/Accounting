// ============================================================
// GATEWAY LOG
//
// JSON lines to stderr, one per event, and only event names plus fields the
// caller chose from a closed vocabulary: a status, a code, the first eight hex
// characters of a session key. Never a token, a code, a verifier, the client
// secret or a raw cookie value; tests/gateway/secrets-never-leave.spec.ts runs
// the whole flow with a capturing logger and looks for each of them.
// ============================================================

export type LogField = string | number | boolean;

export interface GatewayLogger {
  event(name: string, fields?: Record<string, LogField>): void;
}

export function createStderrLogger(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
  clock: () => number = Date.now
): GatewayLogger {
  return {
    event(name, fields = {}) {
      write(`${JSON.stringify({ at: new Date(clock()).toISOString(), event: name, ...fields })}\n`);
    },
  };
}
