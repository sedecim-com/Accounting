import { describe, it, expect, vi } from 'vitest';
import {
  classifyProviderError,
  isFailoverEligible,
  CooldownRegistry,
  COOLDOWN_INITIAL_MS,
  COOLDOWN_CAP_MS,
  runWithFailover,
  AllProvidersFailedError,
  type NamedProfile,
  type ProviderErrorCategory,
} from '../../../src/ai/providers/failover.js';
import OpenAI from 'openai';
import {
  MissingProviderCredentialError,
  NotAProviderCredentialError,
  ProjectFileRefusalError,
} from '../../../src/ai/providers/config.js';
import { CredentialHelperError } from '../../../src/ai/providers/credential-helper.js';

// ─── classification table ───

describe('classifyProviderError', () => {
  const cases: Array<[string, unknown, ProviderErrorCategory]> = [
    ['HTTP 401', { status: 401, message: 'invalid x-api-key' }, 'auth'],
    ['HTTP 403', { status: 403 }, 'auth'],
    ['HTTP 402', { status: 402 }, 'billing'],
    ['HTTP 429', { status: 429, message: 'Too many requests' }, 'rate_limit'],
    ['HTTP 408', { status: 408 }, 'timeout'],
    ['HTTP 500', { status: 500 }, 'server'],
    ['HTTP 503', { statusCode: 503 }, 'server'],
    ['HTTP 529 overloaded', { status: 529, error: { type: 'overloaded_error' } }, 'server'],
    [
      'Anthropic nested authentication_error',
      { status: 401, error: { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } } },
      'auth',
    ],
    ['Anthropic rate_limit_error type', { error: { type: 'rate_limit_error' } }, 'rate_limit'],
    ['OpenAI SDK AuthenticationError name', { name: 'AuthenticationError', message: 'Incorrect API key' }, 'auth'],
    ['OpenAI SDK RateLimitError name', { name: 'RateLimitError' }, 'rate_limit'],
    ['OpenAI SDK APIConnectionTimeoutError', { name: 'APIConnectionTimeoutError', message: 'Request timed out.' }, 'timeout'],
    ['node ETIMEDOUT', { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, 'timeout'],
    ['node ECONNREFUSED', { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' }, 'server'],
    ['fetch TypeError with ECONNREFUSED cause', { name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }, 'server'],
    // Caller-initiated cancellation (Ctrl+C → AbortController) is NOT a
    // timeout: 'aborted' is never failover-eligible.
    ['AbortError (user cancellation)', { name: 'AbortError', message: 'This operation was aborted' }, 'aborted'],
    ['DOMException-style ABORT_ERR code', { name: 'AbortError', code: 'ABORT_ERR', message: 'The operation was aborted' }, 'aborted'],
    // A deadline-driven abort (AbortSignal.timeout) IS a timeout though.
    ['AbortSignal.timeout → TimeoutError', { name: 'TimeoutError', message: 'The operation was aborted due to timeout' }, 'timeout'],
    ['abort with timed-out text stays timeout', { name: 'AbortError', message: 'Request timed out' }, 'timeout'],
    [
      'OpenAI insufficient_quota arrives as 429 but is BILLING',
      { status: 429, error: { type: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } },
      'billing',
    ],
    ['Anthropic credit balance message', { status: 400, message: 'Your credit balance is too low to access the API' }, 'billing'],
    [
      'context overflow arrives as 400 but is OVERFLOW',
      { status: 400, message: 'prompt is too long: 214321 tokens > 200000 maximum context length' },
      'overflow',
    ],
    [
      'OpenAI context_length message',
      { status: 400, message: "This model's maximum context length is 8192 tokens." },
      'overflow',
    ],
    ['refusal', { message: 'The model refused to complete the request' }, 'refusal'],
    ['empty object', {}, 'unknown'],
    ['plain string error', 'something odd happened', 'unknown'],
    ['null', null, 'unknown'],
  ];

  it.each(cases)('%s → %s', (_label, err, expected) => {
    void _label;
    expect(classifyProviderError(err)).toBe(expected);
  });
});

// MNE-001-447 (#644 P7): a link with no credential here is `unconfigured`,
// whatever raised it, and the walk moves past it. The errors are built the
// way the code raises them; the keys and commands are invented.
describe('classifyProviderError — unconfigured', () => {
  const helper = new CredentialHelperError('gcloud-link', { kind: 'exit', code: 1 });
  const cases: Array<[string, unknown]> = [
    ['MissingProviderCredentialError', new MissingProviderCredentialError('Provider "grok" requires the environment variable XAI_API_KEY')],
    ['CredentialHelperError, alone', helper],
    ['CredentialHelperError of a deadline, not a timeout', new CredentialHelperError('gcloud-link', { kind: 'deadline', ms: 10_000 })],
    ['CredentialHelperError as the cause of the openai SDK wrapper', new OpenAI.OpenAIError('Failed to get the API key', { cause: helper })],
    [
      "the Anthropic SDK's own no-credential error, as client.js raises it",
      new Error(
        'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for the "Authorization" header to be explicitly omitted'
      ),
    ],
    ['ProjectFileRefusalError, an unapproved project helper', new ProjectFileRefusalError('helper_unapproved', 'Provider "shared" runs an api_key_cmd you have not approved')],
    ['ProjectFileRefusalError, an unapproved pair', new ProjectFileRefusalError('pair_unapproved', 'Provider "shared" would send OPENAI_API_KEY to https://other.example.test')],
  ];

  it.each(cases)('%s → unconfigured', (_label, err) => {
    void _label;
    expect(classifyProviderError(err)).toBe('unconfigured');
  });

  it('an installation secret named as api_key_env stays loud: not a missing credential', () => {
    expect(classifyProviderError(new NotAProviderCredentialError('Provider "x" names DATABASE_URL in api_key_env'))).toBe('unknown');
  });

  it('a 404 or a 410 still fails loudly', () => {
    expect(classifyProviderError({ status: 404, message: 'model: not-a-model' })).toBe('unknown');
    expect(classifyProviderError({ status: 410, message: 'this model was retired' })).toBe('unknown');
  });
});

describe('isFailoverEligible', () => {
  it('allows failover only for auth/rate_limit/server/timeout/billing/unconfigured', () => {
    for (const c of ['auth', 'rate_limit', 'server', 'timeout', 'billing', 'unconfigured'] as const) {
      expect(isFailoverEligible(c)).toBe(true);
    }
  });

  it('NEVER fails over on overflow (compaction), refusal, aborted or unknown', () => {
    expect(isFailoverEligible('overflow')).toBe(false);
    expect(isFailoverEligible('refusal')).toBe(false);
    expect(isFailoverEligible('aborted')).toBe(false);
    expect(isFailoverEligible('unknown')).toBe(false);
  });
});

// ─── cooldown schedule ───

describe('CooldownRegistry', () => {
  it('starts at 30s and doubles each trip up to the 5m cap', () => {
    const t = 0;
    const reg = new CooldownRegistry(() => t);
    expect(reg.trip('hermes')).toBe(30_000);
    expect(reg.trip('hermes')).toBe(60_000);
    expect(reg.trip('hermes')).toBe(120_000);
    expect(reg.trip('hermes')).toBe(240_000);
    expect(reg.trip('hermes')).toBe(300_000);
    expect(reg.trip('hermes')).toBe(300_000); // capped, never above 5m
    expect(COOLDOWN_INITIAL_MS).toBe(30_000);
    expect(COOLDOWN_CAP_MS).toBe(300_000);
  });

  it('cools exactly for the tripped duration and per provider', () => {
    let t = 1_000;
    const reg = new CooldownRegistry(() => t);
    reg.trip('a');
    expect(reg.isCooling('a')).toBe(true);
    expect(reg.isCooling('b')).toBe(false);
    expect(reg.remainingMs('a')).toBe(30_000);
    t = 30_999;
    expect(reg.isCooling('a')).toBe(true);
    t = 31_000;
    expect(reg.isCooling('a')).toBe(false);
  });

  it('a success (clear) fully resets the doubling', () => {
    const t = 0;
    const reg = new CooldownRegistry(() => t);
    reg.trip('a');
    reg.trip('a');
    reg.clear('a');
    expect(reg.isCooling('a')).toBe(false);
    expect(reg.trip('a')).toBe(30_000); // back to the initial trip
  });
});

// ─── runWithFailover ───

const profile = (name: string): NamedProfile => ({
  name,
  type: 'openai-compatible',
  model: `${name}-model`,
});

function harness() {
  let t = 0;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const cooldowns = new CooldownRegistry(now);
  return { now, advance, cooldowns };
}

describe('runWithFailover', () => {
  it('returns the primary result and the ACTUAL profile used', async () => {
    const { cooldowns, now } = harness();
    const attempt = vi.fn().mockResolvedValue('answer');
    const r = await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now });
    expect(r.result).toBe('answer');
    expect(r.profile.name).toBe('a');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('fails over on an eligible error, trips the cooldown and reports via onFailover', async () => {
    const { cooldowns, now } = harness();
    const onFailover = vi.fn();
    const attempt = vi.fn(async (p: NamedProfile) => {
      if (p.name === 'a') throw { status: 429, message: 'rate limited' };
      return `by-${p.name}`;
    });
    const r = await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now, onFailover });
    expect(r.result).toBe('by-b');
    expect(r.profile.name).toBe('b'); // caller attributes the fallback model
    expect(onFailover).toHaveBeenCalledWith({ provider: 'a', errorType: 'rate_limit', nextProvider: 'b' });
    expect(cooldowns.isCooling('a')).toBe(true);
  });

  it('NEVER fails over on overflow: rethrows immediately after one attempt', async () => {
    const { cooldowns, now } = harness();
    const onFailover = vi.fn();
    const overflow = { status: 400, message: 'prompt is too long: 300000 tokens > 200000 maximum context length' };
    const attempt = vi.fn().mockRejectedValue(overflow);
    await expect(
      runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now, onFailover })
    ).rejects.toBe(overflow);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onFailover).not.toHaveBeenCalled();
    expect(cooldowns.isCooling('a')).toBe(false);
  });

  it('NEVER fails over on a refusal', async () => {
    const { cooldowns, now } = harness();
    const refusal = new Error('The model refused to produce this entry');
    const attempt = vi.fn().mockRejectedValue(refusal);
    await expect(runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now })).rejects.toBe(refusal);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('NEVER fails over on a user abort: rethrows immediately, no cooldown trip', async () => {
    const { cooldowns, now } = harness();
    const onFailover = vi.fn();
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const attempt = vi.fn().mockRejectedValue(abortErr);
    await expect(
      runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now, onFailover })
    ).rejects.toBe(abortErr);
    expect(attempt).toHaveBeenCalledTimes(1); // never shopped to provider b
    expect(onFailover).not.toHaveBeenCalled();
    expect(cooldowns.isCooling('a')).toBe(false); // the provider did not fail
  });

  it('when the caller signal is aborted, ANY attempt error rethrows without failover', async () => {
    const { cooldowns, now } = harness();
    const controller = new AbortController();
    controller.abort();
    // SDKs wrap cancellation in arbitrary shapes — even one that LOOKS
    // failover-eligible (a 500) must not fail over once the human cancelled.
    const wrapped = Object.assign(new Error('stream destroyed'), { status: 500 });
    const attempt = vi.fn().mockRejectedValue(wrapped);
    await expect(
      runWithFailover([profile('a'), profile('b')], attempt, {
        cooldowns,
        now,
        signal: controller.signal,
      })
    ).rejects.toBe(wrapped);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(cooldowns.isCooling('a')).toBe(false);
  });

  it('skips a cooling primary, then RE-PROBES it first once its cooldown expires', async () => {
    const { cooldowns, now, advance } = harness();
    let primaryHealthy = false;
    const attempted: string[] = [];
    const attempt = vi.fn(async (p: NamedProfile) => {
      attempted.push(p.name);
      if (p.name === 'a' && !primaryHealthy) throw { status: 503 };
      return `by-${p.name}`;
    });
    const chain = [profile('a'), profile('b')];

    // Call 1: a fails (server), b answers.
    expect((await runWithFailover(chain, attempt, { cooldowns, now })).profile.name).toBe('b');
    // Call 2, within the 30s cooldown: a is SKIPPED, b goes first.
    advance(10_000);
    await runWithFailover(chain, attempt, { cooldowns, now });
    // Call 3, after expiry: the primary is re-probed FIRST and wins again.
    advance(30_000);
    primaryHealthy = true;
    expect((await runWithFailover(chain, attempt, { cooldowns, now })).profile.name).toBe('a');
    expect(attempted).toEqual(['a', 'b', 'b', 'a']);
  });

  it('when EVERY provider is cooling, walks the chain anyway (availability wins)', async () => {
    const { cooldowns, now } = harness();
    cooldowns.trip('a');
    cooldowns.trip('b');
    const attempt = vi.fn().mockResolvedValue('ok');
    const r = await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now });
    expect(r.profile.name).toBe('a');
  });

  it('moves past a link with no credential without cooling it down', async () => {
    const { cooldowns, now } = harness();
    const onFailover = vi.fn();
    const attempt = vi.fn(async (p: NamedProfile) => {
      if (p.name === 'a') throw new MissingProviderCredentialError('Provider "a" requires the environment variable A_KEY');
      return `by-${p.name}`;
    });
    const r = await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now, onFailover });
    expect(r.profile.name).toBe('b');
    expect(onFailover).toHaveBeenCalledWith({ provider: 'a', errorType: 'unconfigured', nextProvider: 'b' });
    expect(cooldowns.isCooling('a')).toBe(false);
    // The next call asks the head again, because nothing failed upstream.
    await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now });
    expect(attempt.mock.calls.map(([p]) => p.name)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('throws AllProvidersFailedError with per-provider categories when the chain is exhausted', async () => {
    const { cooldowns, now } = harness();
    const attempt = vi.fn(async (p: NamedProfile) => {
      if (p.name === 'a') throw { status: 401 };
      throw { code: 'ECONNREFUSED' };
    });
    const err = await runWithFailover([profile('a'), profile('b')], attempt, { cooldowns, now }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).failures.map((f) => `${f.provider}:${f.category}`)).toEqual([
      'a:auth',
      'b:server',
    ]);
    expect((err as Error).message).toMatch(/a \(auth\), b \(server\)/);
  });
});
