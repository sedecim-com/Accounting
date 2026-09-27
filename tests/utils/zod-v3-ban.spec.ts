import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint, Linter } from 'eslint';
import { parser } from 'typescript-eslint';

// CONTRACT: no file in src/, tests/ or scripts/ loads zod's v3 API (#367),
// whatever way it is loaded. A v3 schema is invisible to the converter, to
// src/utils/zod-compat.ts and to the 422 adapter. `no-restricted-imports`
// alone only sees static imports and export-from, so `import('zod/v3')` and
// `require('zod/v3')` passed lint.
//
// The rules are asked of ESLint for each tree (calculateConfigForFile), so a
// later block that replaces `no-restricted-syntax` for its files, as the
// browser block does, shows up here. They then run untyped on each probe.

const ROOT = path.resolve(__dirname, '..', '..');
const BANS = ['no-restricted-imports', 'no-restricted-syntax'] as const;
const FILES = ['src/probe.ts', 'tests/probe.ts', 'scripts/probe.ts', 'src/gateway/app/probe.ts'];

async function bansFor(file: string): Promise<Linter.RulesRecord> {
  const resolved = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(file)) as {
    rules?: Linter.RulesRecord;
  };
  const rules: Linter.RulesRecord = {};
  for (const rule of BANS) {
    const entry = resolved.rules?.[rule];
    if (entry !== undefined) rules[rule] = entry;
  }
  return rules;
}

function zodErrors(rules: Linter.RulesRecord, code: string): number {
  const messages = new Linter({ configType: 'flat' }).verify(
    code,
    [{ files: ['**/*.ts'], languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' }, rules }],
    'probe.ts'
  );
  const fatal = messages.filter((m) => m.fatal === true);
  if (fatal.length > 0) throw new Error(fatal.map((m) => m.message).join('\n'));
  return messages.filter((m) => m.severity === 2 && m.message.includes('#367')).length;
}

const BANNED = [
  "import { z } from 'zod/v3';",
  "import type { ZodTypeAny } from 'zod/v3';",
  "export * from 'zod/v3';",
  "import { z } from 'zod/v3/external';",
  "export const load = async (): Promise<unknown> => import('zod/v3');",
  "export const load = async (): Promise<unknown> => import('zod/v3/external');",
  'export const load = async (): Promise<unknown> => import(`zod/v3`);',
  "export const z: unknown = require('zod/v3');",
  "export const z: unknown = require('zod/v3/external');",
  "import z = require('zod/v3');",
];

const ALLOWED = [
  "import { z } from 'zod';",
  "import { z } from 'zod/v4';",
  "export const load = async (): Promise<unknown> => import('zod');",
  "export const load = async (): Promise<unknown> => import('zod/v30');",
  "export const z: unknown = require('zod/v4');",
  "export const name = 'zod/v3';",
];

describe('zod/v3 is banned however it is loaded', () => {
  it.each(FILES)('in %s', async (file) => {
    const rules = await bansFor(file);
    for (const code of BANNED) expect(zodErrors(rules, code), code).toBe(1);
    for (const code of ALLOWED) expect(zodErrors(rules, code), code).toBe(0);
  });
});
