import { describe, it, expect } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import { registerSatCommands } from '../../src/cli/sat-commands.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import {
  waitForDownload, positiveInt, pollDelay, POLL_FIRST_MS, POLL_MAX_MS, MAX_POLLS_PER_WAIT,
} from '../../src/cli/sat-download-commands.js';
import { CredentialAccessDenied } from '../../src/services/fiscal-credentials/service.js';
import type { MirrorRequest } from '../../src/services/sat-download/packages.js';

// ============================================================
// MNE-001-143 (#440), review fixes. The wait of `sat download check --wait`
// decrypts the e.firma on every ask, and the daily cap is shared with the
// package download: it backs off, stops at a budget, and stops on the cap.
// A fake clock and a counter of asks; nothing here touches a database.
// ============================================================

const request = (status: string): MirrorRequest => ({
  id: 'r1', direction: 'received', requestType: 'CFDI', periodStart: '2026-02-01T00:00:00', periodEnd: '2026-02-01T23:59:59',
  status, satRequestId: 's1', satCode: null, satMessage: null, errorKey: null, cfdiCount: null, packageIds: [],
  requestedAt: new Date(0), verifiedAt: null, actor: 'a', archivedPackageIds: [],
});

/** A SAT that stays open for `openFor` asks, then finishes; a clock that only moves when the loop sleeps. */
function harness(openFor: number, failAt?: { ask: number; error: Error }) {
  let clock = 0;
  let asks = 0;
  const sleeps: number[] = [];
  return {
    asks: () => asks,
    sleeps,
    io: {
      now: () => clock,
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      verify: async () => {
        asks += 1;
        if (failAt && asks === failAt.ask) throw failAt.error;
      },
      reload: async () => request(asks > openFor ? 'finished' : 'in_process'),
    },
  };
}

describe('MNE-001-143 review · check --wait backs off instead of polling every 30 s', () => {
  it('doubles the gap from a minute up to fifteen', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(pollDelay)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    expect(POLL_FIRST_MS).toBe(60_000);
    expect(POLL_MAX_MS).toBe(900_000);
  });

  it('the default 900 s wait asks the SAT about 5 times, not 30', async () => {
    const h = harness(1_000);
    const out = await waitForDownload(request('accepted'), { wait: true, timeoutMs: 900_000 }, h.io);
    expect(out.stopped).toBe('timeout');
    expect(h.asks()).toBe(out.polls);
    expect(h.asks()).toBeLessThanOrEqual(6);
    expect(Math.min(...h.sleeps)).toBeGreaterThanOrEqual(1);
    expect(h.sleeps.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
  });

  it('never asks more than the budget however long the timeout is', async () => {
    const h = harness(1_000);
    const out = await waitForDownload(request('accepted'), { wait: true, timeoutMs: 30 * 24 * 3_600_000 }, h.io);
    expect(out.stopped).toBe('budget');
    expect(h.asks()).toBe(MAX_POLLS_PER_WAIT);
  });

  it('stops as soon as the request is ready, and asks once without --wait', async () => {
    const ready = harness(2);
    const out = await waitForDownload(request('accepted'), { wait: true, timeoutMs: 900_000 }, ready.io);
    expect(out.row.status).toBe('finished');
    expect(out.stopped).toBeUndefined();
    expect(ready.asks()).toBe(3);

    const once = harness(1_000);
    const single = await waitForDownload(request('accepted'), { wait: false, timeoutMs: 900_000 }, once.io);
    expect(single.polls).toBe(1);
    expect(once.sleeps).toEqual([]);
  });

  it('does not ask about a request that is no longer open', async () => {
    const h = harness(0);
    const out = await waitForDownload(request('finished'), { wait: true, timeoutMs: 900_000 }, h.io);
    expect(out.polls).toBe(0);
    expect(h.asks()).toBe(0);
  });

  it('stops on the daily cap and reports how many asks it made, instead of aborting with an error', async () => {
    const h = harness(1_000, { ask: 3, error: new CredentialAccessDenied('The limit of 24 accesses in 24 h was reached', 'rate_limit') });
    const out = await waitForDownload(request('accepted'), { wait: true, timeoutMs: 900_000 }, h.io);
    expect(out.stopped).toBe('rate_limit');
    expect(out.polls).toBe(2);
    expect(out.row.status).toBe('in_process');
  });

  it('lets any other denial through', async () => {
    const h = harness(1_000, { ask: 1, error: new CredentialAccessDenied('expired', 'expired') });
    await expect(waitForDownload(request('accepted'), { wait: true, timeoutMs: 900_000 }, h.io)).rejects.toThrow('expired');
  });
});

describe('MNE-001-143 review · --timeout and --limit take a whole number above zero', () => {
  const parse = positiveInt('--timeout');
  it('accepts whole numbers', () => {
    expect(parse('600')).toBe(600);
    expect(parse(' 5 ')).toBe(5);
  });
  it.each(['abc', '', '0', '-3', '1.5', '1e3', 'NaN', '99999999999999999999'])('rejects "%s" as an invalid argument', (v) => {
    expect(() => parse(v)).toThrow(InvalidArgumentError);
  });
});

describe('MNE-001-143 review · the agent may read the mirror and may not use the e.firma', () => {
  const program = new Command();
  const pass = (s: string) => s;
  registerSatCommands(program, {
    color: { dim: pass, bold: pass, cyan: pass }, colorErr: { dim: pass, red: pass },
    shutdown: async () => { throw new Error('shutdown'); }, reportError: () => undefined, ask: async () => null,
  });
  const leaf = (...names: string[]): Command =>
    names.reduce((cmd: Command, n) => cmd.commands.find((c) => c.name() === n)!, program.commands.find((c) => c.name() === 'sat')!);

  it.each([['download', 'create'], ['download', 'check'], ['package', 'download']])('sat %s %s is agent:false', (...path) => {
    expect(riskOf(leaf(...path))).toMatchObject({ agent: false });
  });
  it.each([['download', 'status'], ['download', 'list'], ['quota', 'show']])('sat %s %s is a read the agent may run', (...path) => {
    expect(riskOf(leaf(...path))).toMatchObject({ risk: 'lectura', agent: true });
  });
  it('rejects a --timeout or --limit that is not a whole number above zero at parse time', () => {
    const check = leaf('download', 'check');
    const list = leaf('download', 'list');
    for (const cmd of [check, list]) cmd.exitOverride().configureOutput({ writeErr: () => undefined });
    expect(() => check.parse(['x', '--timeout', 'abc'], { from: 'user' })).toThrow(/--timeout/);
    expect(() => list.parse(['--limit', '0'], { from: 'user' })).toThrow(/--limit/);
  });
});
