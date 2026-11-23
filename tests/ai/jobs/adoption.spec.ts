import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptionPath, readAdoptions, adoptedJobIds, adoptJob, unadoptJob,
} from '../../../src/ai/jobs/adoption.js';

// MNE-001-453 (#646): the jobs an operator adopted live under THEIR home
// directory, one file per operator. Two temporary homes play two operators;
// the ids are invented.

const JOB_A = '00000000-0000-4000-8000-00000000000a';
const JOB_B = '00000000-0000-4000-8000-00000000000b';
const ENTITY = 'entity-1';
const OTHER_ENTITY = 'entity-2';

let alice: string;
let bruno: string;

beforeEach(() => {
  alice = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-alice-'));
  bruno = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-bruno-'));
});
afterEach(() => {
  fs.rmSync(alice, { recursive: true, force: true });
  fs.rmSync(bruno, { recursive: true, force: true });
});

describe('the adoption file', () => {
  it('lives at ~/.mnemosine/adopted-jobs.json', () => {
    expect(adoptionPath(alice)).toBe(path.join(alice, '.mnemosine', 'adopted-jobs.json'));
  });

  it('no file means nothing adopted', () => {
    expect(readAdoptions(alice)).toEqual([]);
    expect(adoptedJobIds(ENTITY, alice).size).toBe(0);
  });

  it('adopt, read back, adopt again, unadopt', () => {
    const now = new Date('2026-11-23T10:00:00Z');
    expect(adoptJob({ id: JOB_A, entityId: ENTITY }, alice, now)).toEqual({ file: adoptionPath(alice), already: false });
    expect(readAdoptions(alice)).toEqual([{ jobId: JOB_A, entityId: ENTITY, adoptedAt: '2026-11-23T10:00:00.000Z' }]);
    expect(adoptJob({ id: JOB_A, entityId: ENTITY }, alice).already).toBe(true);
    expect(unadoptJob(JOB_A, alice)).toEqual({ file: adoptionPath(alice), removed: true });
    expect(unadoptJob(JOB_A, alice).removed).toBe(false);
    expect(readAdoptions(alice)).toEqual([]);
  });

  it('is the operator\'s own: mode 0600 in a 0700 directory, and nobody else\'s home changes', () => {
    adoptJob({ id: JOB_A, entityId: ENTITY }, alice);
    expect(fs.statSync(adoptionPath(alice)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(adoptionPath(alice))).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(adoptionPath(bruno))).toBe(false);
    expect(adoptedJobIds(ENTITY, bruno).has(JOB_A)).toBe(false);
  });

  it('adoptedJobIds answers for one entity', () => {
    adoptJob({ id: JOB_A, entityId: ENTITY }, alice);
    adoptJob({ id: JOB_B, entityId: OTHER_ENTITY }, alice);
    expect([...adoptedJobIds(ENTITY, alice)]).toEqual([JOB_A]);
    expect([...adoptedJobIds(OTHER_ENTITY, alice)]).toEqual([JOB_B]);
  });

  it('holds ids and dates only, never a credential', () => {
    adoptJob({ id: JOB_A, entityId: ENTITY }, alice, new Date('2026-11-23T10:00:00Z'));
    const stored = JSON.parse(fs.readFileSync(adoptionPath(alice), 'utf-8')) as unknown;
    expect(stored).toEqual({ adopted: { [JOB_A]: { entity_id: ENTITY, adopted_at: '2026-11-23T10:00:00.000Z' } } });
  });

  it('a file that does not parse is refused by its path and never overwritten', () => {
    fs.mkdirSync(path.dirname(adoptionPath(alice)), { recursive: true });
    fs.writeFileSync(adoptionPath(alice), '{ not json');
    expect(() => readAdoptions(alice)).toThrow(adoptionPath(alice));
    expect(() => adoptJob({ id: JOB_A, entityId: ENTITY }, alice)).toThrow(adoptionPath(alice));
    expect(fs.readFileSync(adoptionPath(alice), 'utf-8')).toBe('{ not json');
  });

  it('a file of another shape is refused too', () => {
    fs.mkdirSync(path.dirname(adoptionPath(alice)), { recursive: true });
    fs.writeFileSync(adoptionPath(alice), JSON.stringify({ adopted: { [JOB_A]: { entity_id: 7 } } }));
    expect(() => readAdoptions(alice)).toThrow(adoptionPath(alice));
  });
});
