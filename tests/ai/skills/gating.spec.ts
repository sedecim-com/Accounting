import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  binOnPath,
  configPathPresent,
  evaluateGates,
  applyAllowlist,
  resolveProfileAllowlist,
  type SkillRequires,
} from '../../../src/ai/skills/gating.js';

const NO_REQUIRES: SkillRequires = { bins: [], env: [], config: [] };

function tmpDirWithBin(bin: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-gating-'));
  fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\n');
  return dir;
}

describe('binOnPath', () => {
  it('finds an existing executable on PATH and misses an absent one', () => {
    const dir = tmpDirWithBin('fakebin');
    expect(binOnPath('fakebin', dir)).toBe(true);
    expect(binOnPath('missingbin', dir)).toBe(false);
  });

  it('fails closed on path separators, .., empty names, and empty PATH', () => {
    const dir = tmpDirWithBin('fakebin');
    // A "bin" with separators is a filesystem probe, not a tool requirement.
    expect(binOnPath('sub/fakebin', dir)).toBe(false);
    expect(binOnPath('..', dir)).toBe(false);
    expect(binOnPath('', dir)).toBe(false);
    expect(binOnPath('fakebin', undefined)).toBe(false);
    expect(binOnPath('fakebin', '')).toBe(false);
  });
});

describe('configPathPresent', () => {
  const config = {
    ingest: { auto_post: false, auto_post_min_confidence: 0.95 },
    providers: { anthropic: { model: 'x' } },
    empty: '',
    nil: null,
    list: ['a'],
  };

  it('resolves nested dot-paths', () => {
    expect(configPathPresent(config, 'ingest.auto_post')).toBe(true); // false is still SET
    expect(configPathPresent(config, 'providers.anthropic.model')).toBe(true);
    expect(configPathPresent(config, 'ingest')).toBe(true);
  });

  it('treats missing, empty-string, and null values as absent', () => {
    expect(configPathPresent(config, 'ingest.nope')).toBe(false);
    expect(configPathPresent(config, 'empty')).toBe(false);
    expect(configPathPresent(config, 'nil')).toBe(false);
    expect(configPathPresent(config, '')).toBe(false);
    expect(configPathPresent(undefined, 'ingest')).toBe(false);
  });

  it('does not traverse through arrays or scalars', () => {
    expect(configPathPresent(config, 'list.0')).toBe(false);
    expect(configPathPresent(config, 'ingest.auto_post.deeper')).toBe(false);
  });
});

describe('evaluateGates — truth table', () => {
  it('no requirements = open gate', () => {
    expect(evaluateGates(NO_REQUIRES, { env: {}, config: {} })).toEqual({ gated: false, reasons: [] });
  });

  it('bins: present passes, absent gates with a reason', () => {
    const dir = tmpDirWithBin('fakebin');
    const env = { PATH: dir };
    expect(evaluateGates({ ...NO_REQUIRES, bins: ['fakebin'] }, { env, config: {} }).gated).toBe(false);
    const gated = evaluateGates({ ...NO_REQUIRES, bins: ['missingbin'] }, { env, config: {} });
    expect(gated.gated).toBe(true);
    expect(gated.reasons[0]).toContain('missingbin');
  });

  it('env: non-empty passes; unset and whitespace-only gate', () => {
    const requires = { ...NO_REQUIRES, env: ['SAT_EFIRMA'] };
    expect(evaluateGates(requires, { env: { SAT_EFIRMA: 'x' }, config: {} }).gated).toBe(false);
    expect(evaluateGates(requires, { env: {}, config: {} }).gated).toBe(true);
    expect(evaluateGates(requires, { env: { SAT_EFIRMA: '  ' }, config: {} }).gated).toBe(true);
  });

  it('config: present passes, absent gates, and NO loaded config fails closed', () => {
    const requires = { ...NO_REQUIRES, config: ['ingest.auto_post'] };
    expect(evaluateGates(requires, { env: {}, config: { ingest: { auto_post: true } } }).gated).toBe(false);
    expect(evaluateGates(requires, { env: {}, config: {} }).gated).toBe(true);
    const noConfig = evaluateGates(requires, { env: {} });
    expect(noConfig.gated).toBe(true);
    expect(noConfig.reasons[0]).toContain('unavailable');
  });

  it('accumulates one reason per failed requirement', () => {
    const result = evaluateGates(
      { bins: ['missingbin'], env: ['NOPE'], config: ['absent.key'] },
      { env: { PATH: os.tmpdir() }, config: {} }
    );
    expect(result.gated).toBe(true);
    expect(result.reasons).toHaveLength(3);
  });
});

describe('applyAllowlist — the FINAL set', () => {
  const skills = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

  it('absent allowlist keeps everything', () => {
    expect(applyAllowlist(skills, undefined)).toEqual(skills);
  });

  it('present allowlist is final: only named skills survive', () => {
    expect(applyAllowlist(skills, ['b', 'zz-not-a-skill'])).toEqual([{ name: 'b' }]);
  });

  it('empty allowlist means no skills at all', () => {
    expect(applyAllowlist(skills, [])).toEqual([]);
  });
});

describe('resolveProfileAllowlist', () => {
  it('reads skills?: string[] structurally', () => {
    expect(resolveProfileAllowlist({ skills: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(resolveProfileAllowlist({ model: 'x' })).toBeUndefined();
    expect(resolveProfileAllowlist(undefined)).toBeUndefined();
  });

  it('malformed values fail closed as an EMPTY allowlist', () => {
    expect(resolveProfileAllowlist({ skills: 'a' })).toEqual([]);
    expect(resolveProfileAllowlist({ skills: ['a', 42] })).toEqual([]);
    expect(resolveProfileAllowlist({ skills: [''] })).toEqual([]);
  });
});
