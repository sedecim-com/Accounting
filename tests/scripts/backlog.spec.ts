/**
 * scripts/backlog.ts decides two things people act on: whether a task is
 * atomic enough to enter, and in which sprint it can start. Each rule has a
 * case that breaks it, so a relaxed rule shows up here as a red test.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type Backlog,
  type Task,
  chainLengths,
  releaseSprints,
  render,
  requirementIds,
  schedule,
  validate,
} from '../../scripts/backlog';

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

/** Without `perSprint`, the schedule declares no cap per sprint, as the real backlog does since 2026-09-29. */
function backlog(tasks: Task[], capacity: { perSprint?: number; perLane: number } = { perSprint: 10, perLane: 10 }): Backlog {
  return {
    prd: 'docs/prd/PRD-001-mvp.md',
    schedule: {
      start: '2026-09-28',
      sprint_days: 14,
      ...(capacity.perSprint === undefined ? {} : { capacity_per_sprint: capacity.perSprint }),
      capacity_per_lane: capacity.perLane,
      stages: {
        '0': { name: 'Cero', release: 'R0 · cero' },
        '1': { name: 'Uno', release: 'R1 · uno' },
        '2': { name: 'Dos', release: 'R2 · dos' },
        '3': { name: 'Tres', release: 'v1.0 · tres' },
      },
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

  it.each(['sprint_days', 'capacity_per_lane'])('rejects a missing, zero, negative or fractional %s', (field) => {
    for (const bad of [undefined, 0, -1, 1.5]) {
      expect(withSchedule({ [field]: bad }).join()).toMatch(new RegExp(`schedule.${field}`));
    }
  });

  it('accepts no capacity_per_sprint (no cap), but rejects a declared one that is zero, negative or fractional', () => {
    expect(validate(backlog([task('001')], { perLane: 2 }), REQS, '001')).toEqual([]);
    for (const bad of [0, -1, 1.5]) {
      expect(withSchedule({ capacity_per_sprint: bad }).join()).toMatch(/schedule.capacity_per_sprint/);
    }
  });
});

describe('dependencies and requirements', () => {
  it('rejects a dependency that does not exist', () => {
    expect(errorsOf([task('001', { depends_on: ['MNE-001-999'] })]).join()).toMatch(/does not exist/);
  });

  it('rejects a cycle', () => {
    const tasks = [task('001', { depends_on: ['MNE-001-002'] }), task('002', { depends_on: ['MNE-001-001'] })];
    expect(errorsOf(tasks).join()).toMatch(/dependency cycle/);
  });

  it('rejects a task that depends on one of a later wave: its release would wait on a later one', () => {
    const tasks = [task('001', { wave: 2 }), task('002', { wave: 1, depends_on: ['MNE-001-001'] })];
    expect(errorsOf(tasks).join()).toMatch(/MNE-001-002: wave 1 cannot depend on MNE-001-001, of the later wave 2/);
    expect(errorsOf([task('001', { wave: 1 }), task('002', { wave: 2, depends_on: ['MNE-001-001'] })])).toEqual([]);
  });

  it('rejects a wave with tasks and no stage', () => {
    const b = backlog([task('001', { wave: 2 })]);
    const { '2': _dropped, ...rest } = b.schedule.stages!;
    const errors = validate({ ...b, schedule: { ...b.schedule, stages: rest } }, REQS, '001');
    expect(errors.join()).toMatch(/wave 2 has tasks but no stage/);
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
  it('shows where each wave’s tasks fall and when its release ships, and marks each task’s release in its sprint', () => {
    const tasks = [task('001'), task('002', { depends_on: ['MNE-001-001'] }), task('003', { wave: 2, lane: 'B' })];
    const b = backlog(tasks);
    const view = render(b, schedule(b));
    expect(view).toContain('## Por etapa');
    // Wave 2's only task sits in S1, yet R2 ships with R1 in S2: it needs wave 1 done too.
    expect(view).toContain('| 1 · Uno | 2 | 2 | 0 | S1–S2, 2026-09-28 → 2026-10-25 | R1 · uno | S2, el 2026-10-25 |');
    expect(view).toContain('| 2 · Dos | 1 | 1 | 0 | S1, 2026-09-28 → 2026-10-11 | R2 · dos | S2, el 2026-10-25 |');
    expect(view).toContain('- **R2 · dos** sale al cerrar S2, el 2026-10-25: espera 3 tareas abiertas de las olas ≤ 2.');
    expect(view).toContain('| S1 | 1, 2 | 2026-09-28 | 2 | 2 | 0 | 0 | — |');
    expect(view).toContain('| S2 | 1 | 2026-10-12 | 1 | 1 | 0 | 0 | R1, R2 |');
    expect(view).toMatch(/### S1 · desde el 2026-09-28\n\nDel 2026-09-28 al 2026-10-11: 2 tareas\.\n/);
    expect(view).toMatch(/\| MNE-001-003 \| task 003 \| [^\n]* \| RF-01 \| 2 → R2 \| Must \|/);
    expect(view).toContain('Al cerrar sale **R1 · uno** y **R2 · dos**.');
    expect(view).not.toMatch(/## Etapa|La etapa siguiente/);
  });

  it('numbers the sprints from first_open_sprint: done work is the sprint before, open work starts on the start date', () => {
    const tasks = [
      task('001', { status: 'done' }),
      task('002', { type: 'decision', lane: 'DEC', owner: '@o' }),
      task('003', { depends_on: ['MNE-001-001'] }),
    ];
    const b = backlog(tasks);
    b.schedule.first_open_sprint = 2;
    const view = render(b, schedule(b));
    expect(view).toContain('| S1 | entregado | antes del 2026-09-28 | 1 |');
    expect(view).toContain('## Decisiones del dueño: S2');
    expect(view).toContain('### S2 · desde el 2026-09-28');
    expect(view).toContain('## S1 · lo entregado');
    expect(view).not.toMatch(/S0|S3/);
  });

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

  it('with first_open_sprint, done work is delivered in the sprint before and open work starts at it', () => {
    const tasks = [
      task('001', { status: 'done' }),
      task('002', { type: 'decision', lane: 'DEC', owner: '@o' }),
      task('003', { depends_on: ['MNE-001-001'] }),
      task('004', { depends_on: ['MNE-001-002'] }),
    ];
    const b = backlog(tasks);
    b.schedule.first_open_sprint = 2;
    const s = schedule(b);
    expect([s.get('MNE-001-001'), s.get('MNE-001-002'), s.get('MNE-001-003'), s.get('MNE-001-004')]).toEqual([1, 2, 2, 3]);
    expect(validate({ ...b, schedule: { ...b.schedule, first_open_sprint: 0 } }, REQS, '001').join()).toMatch(
      /schedule.first_open_sprint/,
    );
  });

  it('does not gate by wave: a wave-2 task whose dependencies are met shares the first sprint with wave 1', () => {
    const tasks = [
      task('001'),
      task('002', { depends_on: ['MNE-001-001'] }),
      task('003', { wave: 2, lane: 'B' }),
      task('004', { wave: 3, lane: 'B', depends_on: ['MNE-001-001'] }),
    ];
    const s = schedule(backlog(tasks, { perLane: 2 }));
    expect([s.get('MNE-001-001'), s.get('MNE-001-002')]).toEqual([1, 2]);
    expect(s.get('MNE-001-003')).toBe(1);
    expect(s.get('MNE-001-004')).toBe(2);
  });

  it('under lane contention, an earlier wave wins over a later wave of higher priority', () => {
    const tasks = [
      task('001', { wave: 1, priority: 'Could' }),
      task('002', { wave: 2, priority: 'Must' }),
      task('003', { wave: 2, lane: 'B' }),
    ];
    const s = schedule(backlog(tasks, { perLane: 1 }));
    expect(s.get('MNE-001-001')).toBe(1);
    expect(s.get('MNE-001-002')).toBe(2);
    expect(s.get('MNE-001-003')).toBe(1);
  });

  it('ships release N in the last sprint of any open task of waves ≤ N, not of wave N alone', () => {
    const tasks = [
      task('000', { wave: 0, status: 'done' }),
      task('001'),
      task('002', { depends_on: ['MNE-001-001'] }),
      task('003', { depends_on: ['MNE-001-002'] }),
      task('004', { wave: 2, lane: 'B' }),
      task('005', { wave: 3, lane: 'B', depends_on: ['MNE-001-004'] }),
    ];
    const b = backlog(tasks, { perLane: 2 });
    const s = schedule(b);
    expect([s.get('MNE-001-003'), s.get('MNE-001-004'), s.get('MNE-001-005')]).toEqual([3, 1, 2]);
    expect([...releaseSprints(b, s)]).toEqual([
      [0, 0],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('with no capacity_per_sprint, puts in one sprint everything the lanes allow', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task(String(i + 1).padStart(3, '0'), { lane: i % 2 === 0 ? 'A' : 'B' }),
    );
    const b = backlog(tasks, { perLane: 10 });
    expect(validate(b, REQS, '001')).toEqual([]);
    expect(new Set(schedule(b).values())).toEqual(new Set([1]));
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

  it('among equals, starts the head of the longest chain first', () => {
    // 003 → 004 → 005 hang behind 003; nothing waits on 001 or 002. With room
    // for one task, file order would pick 001 and push the chain a sprint.
    const tasks = [
      task('001'),
      task('002'),
      task('003'),
      task('004', { depends_on: ['MNE-001-003'], lane: 'B' }),
      task('005', { depends_on: ['MNE-001-004'], lane: 'B' }),
    ];
    expect(chainLengths(tasks).get('MNE-001-003')).toBe(3);
    expect(chainLengths(tasks).get('MNE-001-001')).toBe(1);
    const s = schedule(backlog(tasks, { perSprint: 10, perLane: 1 }));
    expect(s.get('MNE-001-003')).toBe(1);
    expect(s.get('MNE-001-005')).toBe(3);
    expect([s.get('MNE-001-001'), s.get('MNE-001-002')]).toEqual([2, 3]);
  });

  it('respects the sprint capacity, Must before Could', () => {
    const tasks = [task('001', { priority: 'Could', lane: 'B' }), task('002'), task('003', { lane: 'B' })];
    const s = schedule(backlog(tasks, { perSprint: 2, perLane: 10 }));
    expect(s.get('MNE-001-002')).toBe(1);
    expect(s.get('MNE-001-003')).toBe(1);
    expect(s.get('MNE-001-001')).toBe(2);
  });
});
