import type { z } from 'zod';

// ============================================================
// CONTRACT: the ONLY place where a Zod issue becomes prose for a client.
//
// Two surfaces show Zod issues to a person: the 422 body of the REST API
// (validateBody, middleware/async-handler.ts) and the error that rejects a
// mnemosine.config.json (ai/providers/config.ts). Both read their issues from
// here and nowhere else, so what they say is decided in one file.
//
// The owner's decision on #367 fixes that prose to the zod 3.25.76 wording,
// issue order included, pinned by tests/api/golden/rest-body.golden.json and
// tests/ai/providers/config-contract.spec.ts. A Zod upgrade that words or
// orders issues differently is absorbed HERE, not at each caller.
// ============================================================

/** One issue as a client reads it: the dotted field path ('' at the root) and the message. */
export interface ClientIssue {
  path: string;
  message: string;
}

export type ClientParse<T> = { success: true; data: T } | { success: false; issues: ClientIssue[] };

/** `schema.safeParse(input)`, with its issues in the wording and order clients are promised. */
export function parseForClient<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): ClientParse<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}
