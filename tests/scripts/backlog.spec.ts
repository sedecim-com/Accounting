/**
 * scripts/backlog.ts decides two things people act on: whether a task is
 * atomic enough to enter, and in which sprint it can start. Each rule has a
 * case that breaks it, so a relaxed rule shows up here as a red test.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Backlog, type Task, render, requirementIds, schedule, validate } from '../../scripts/backlog';

const ROOT = path.resolve(__dirname, '..', '..');

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id: `MNE-001-${id}`,
    title: `task ${id}`,
    issue: 1,
    requirement: 'RF-01',
    priority: 'Must',
    difficulty: 'D2',
    autonomy: 'A2',
    lane: 'A',
    wave: 1,
    size: 100,
    depends_on: [],
    status: 'open',
    acceptance: 'x',
    ...extra,
  };
}

function backlog(tasks: Task[], capacity = { perSprint: 10, perLane: 10 }): Backlog {
  return {
    prd: 'docs/prd/PRD-001-mvp.md',
    schedule: {
      start: '2026-09-28',
      sprint_days: 14,
      capacity_per_sprint: capacity.perSprint,
      capacity_per_lane: capacity.perLane,
    },
    lanes: { A: 'a', B: 'b', DEC: 'decisions' },
    tasks,
  };
}

const REQS = new Set(['RF-01']);
const errorsOf = (tasks: Task[]): string[] => validate(backlog(tasks), REQS, '001');

describe('the published backlog', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/backlog/PRD-001.json'), 'utf8')) as Backlog;
  const prd = fs.readFileSync(path.join(ROOT, real.prd), 'utf8');

  it('is valid against its PRD', () => {
    expect(validate(real, requirementIds(prd), '001')).toEqual([]);
  });

  it('has its Markdown view up to date', () => {
    const published = fs.readFileSync(path.join(ROOT, 'docs/backlog/PRD-001.md'), 'utf8');
    expect(published).toBe(render(real, schedule(real)));
  });
});

describe('what makes a task atomic', () => {
  it('accepts a well-formed task', () => {
    expect(errorsOf([task('001')])).toEqual([]);
  });

  it('rejects a D4: it has to be split before it enters', () => {
    expect(errorsOf([task('001', { difficulty: 'D4' })]).join()).toMatch(/only D1–D3/);
  });

  it('rejects a task over the line budget unless its lines are mechanical', () => {
    expect(errorsOf([task('001', { size: 401 })]).join()).toMatch(/over 400/);
    expect(errorsOf([task('001', { size: 5000, mechanical: true })])).toEqual([]);
  });

  it('rejects a decision without an owner', () => {
    expect(errorsOf([task('001', { type: 'decision', lane: 'DEC' })]).join()).toMatch(/needs an owner/);
  });

  it('rejects a malformed id', () => {
    expect(errorsOf([task('1')]).join()).toMatch(/must look like MNE-001-nnn/);
  });
});

describe('the schedule block', () => {
  const withSchedule = (patch: Record<string, unknown>): string[] => {
    const b = backlog([task('001')]);
    return validate({ ...b, schedule: { ...b.schedule, ...patch } as Backlog['schedule'] }, REQS, '001');
  };

  it('rejects a start that is not a real date', () => {
    expect(withSchedule({ start: '28/09/2026' }).join()).toMatch(/schedule.start/);
    expect(withSchedule({ start: '2026-02-30' }).join()).toMatch(/schedule.start/);
  });

  it.each(['sprint_days', 'capacity_per_sprint', 'capacity_per_lane'])(
    'rejects a missing, zero, negative or fractional %s',
    (field) => {
      for (const bad of [undefined, 0, -1, 1.5]) {
        expect(withSchedule({ [field]: bad }).join()).toMatch(new RegExp(`schedule.${field}`));
      }
    },
  );
});

describe('dependencies and requirements', () => {
  it('rejects a dependency that does not exist', () => {
    expect(errorsOf([task('001', { depends_on: ['MNE-001-999'] })]).join()).toMatch(/does not exist/);
  });

  it('rejects a cycle', () => {
    const tasks = [task('001', { depends_on: ['MNE-001-002'] }), task('002', { depends_on: ['MNE-001-001'] })];
    expect(errorsOf(tasks).join()).toMatch(/dependency cycle/);
  });

  it('rejects a Must task that waits on a Could one', () => {
    const tasks = [task('001', { priority: 'Could' }), task('002', { depends_on: ['MNE-001-001'] })];
    expect(errorsOf(tasks).join()).toMatch(/cannot wait on MNE-001-001/);
  });

  it('rejects a requirement the PRD does not have, and a PRD requirement no task delivers', () => {
    expect(errorsOf([task('001', { requirement: 'RF-99' })]).join()).toMatch(/RF-99 is not a requirement/);
    expect(validate(backlog([task('001')]), new Set(['RF-01', 'RF-02']), '001').join()).toMatch(
      /RF-02: a requirement of the PRD with no task/,
    );
  });

  it('reads requirement ids from the PRD tables', () => {
    expect([...requirementIds('| RF-01 | a |\n| RNF-02 | b |\ntext RF-03\n')]).toEqual(['RF-01', 'RNF-02']);
  });
});

describe('the rendered view', () => {
  it('escapes backslashes and pipes so a title cannot break the table', () => {
    const b = backlog([task('001', { title: 'a|b \\' })]);
    expect(render(b, schedule(b))).toContain('| a\\|b \\\\ |');
  });
});

describe('the suggested sprint', () => {
  it('starts a task in the sprint after everything it depends on', () => {
    const s = schedule(backlog([task('001'), task('002', { depends_on: ['MNE-001-001'] })]));
    expect(s.get('MNE-001-001')).toBe(1);
    expect(s.get('MNE-001-002')).toBe(2);
  });

  it('never puts a task that waits on a decision in sprint 1', () => {
    const tasks = [
      task('001', { type: 'decision', lane: 'DEC', owner: '@o' }),
      task('002', { depends_on: ['MNE-001-001'] }),
    ];
    const s = schedule(backlog(tasks));
    expect(s.get('MNE-001-001')).toBe(1);
    expect(s.get('MNE-001-002')).toBe(2);
  });

  it('keeps done work out of the plan', () => {
    const s = schedule(backlog([task('001', { status: 'done' }), task('002', { depends_on: ['MNE-001-001'] })]));
    expect(s.get('MNE-001-001')).toBe(0);
    expect(s.get('MNE-001-002')).toBe(1);
  });

  it('respects the lane capacity', () => {
    const s = schedule(backlog([task('001'), task('002'), task('003')], { perSprint: 10, perLane: 2 }));
    expect([s.get('MNE-001-001'), s.get('MNE-001-002'), s.get('MNE-001-003')]).toEqual([1, 1, 2]);
  });

  it('orders by wave before priority: Ola 0 first, as docs/MVP.md §3 asks', () => {
    const tasks = [task('001', { wave: 1 }), task('002', { priority: 'Should', wave: 0, lane: 'B' })];
    const s = schedule(backlog(tasks, { perSprint: 1, perLane: 10 }));
    expect(s.get('MNE-001-002')).toBe(1);
    expect(s.get('MNE-001-001')).toBe(2);
  });

  it('respects the sprint capacity, Must before Could', () => {
    const tasks = [task('001', { priority: 'Could', lane: 'B' }), task('002'), task('003', { lane: 'B' })];
    const s = schedule(backlog(tasks, { perSprint: 2, perLane: 10 }));
    expect(s.get('MNE-001-002')).toBe(1);
    expect(s.get('MNE-001-003')).toBe(1);
    expect(s.get('MNE-001-001')).toBe(2);
  });
});
