import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { getPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerPendingCommands, type PendingCommandDeps } from '../../src/cli/pending-command.js';
import { changePolicyHint } from '../../src/services/policy/policy-hint.js';

// ============================================================
// MNE-001-072 (#300) · THE HINT RUNS
//
// Fourteen messages told the accountant to run a verb the binary never had.
// They now go through `changePolicyHint`, and this spec runs, against a real
// database, exactly the commands that hint prints, on a decision someone
// already answered: there `define` alone answers NOT_FOUND, which is why the
// hint names `reopen` first.
// ============================================================

let f: Fixture;
let reviewer: string;
const KEY = 'base_depreciacion';

async function run(argv: string[]) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const log = console.log;
  console.log = () => undefined;
  try {
    const p = new Command('mnemosine');
    p.exitOverride();
    const deps: PendingCommandDeps = {
      color: { bold: (s) => s, dim: (s) => s, cyan: (s) => s },
      colorErr: { dim: (s) => s, red: (s) => s },
      shutdown: (async (c: number) => {
        exitCode = c;
      }) as unknown as (code: number) => Promise<never>,
      reportError: (e: unknown) => {
        errs.push(e);
      },
      ask: () => Promise.resolve(null),
    };
    registerPendingCommands(p, deps);
    await p.parseAsync(['node', ...argv, '--entity', f.entityId]);
  } finally {
    console.log = log;
  }
  return { exitCode, err: errs.map(String).join('\n') };
}

/** The invocations the hint prints, in order, with the value appended to `define`. */
function hintedCommands(value: string): string[][] {
  const cmds = [...changePolicyHint(KEY).matchAll(/`([^`]+)`/g)].map((m) => m[1].split(' '));
  expect(cmds.map((c) => c.slice(0, 3).join(' '))).toEqual(['mnemosine pending reopen', 'mnemosine pending define']);
  return cmds.map((c) => (c[2] === 'define' ? [...c, value, '--user', reviewer] : c));
}

beforeAll(async () => {
  f = await crearInquilino('MNE-072 hint');
  reviewer = `it-${f.userId.slice(0, 8)}@example.test`;
  await seedPolicies({ tenantId: f.tenantId });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('changePolicyHint names commands that change the decision', () => {
  it('on an answered decision: define alone is refused, the hinted pair changes it', async () => {
    const scope = { tenantId: f.tenantId, entityId: f.entityId };
    await resolvePolicy(scope, KEY, 'vida_util_nif', reviewer);

    const [reopen, define] = hintedCommands('tasa_lisr');
    const alone = await run(define);
    expect(alone.exitCode, 'define on an answered key').not.toBe(0);

    for (const cmd of [reopen, define]) {
      const r = await run(cmd);
      expect(r.exitCode, `${cmd.join(' ')}: ${r.err}`).toBe(0);
    }
    expect((await getPolicy(scope, KEY)).value).toBe('tasa_lisr');
  });
});
