/**
 * Validates a PRD backlog, computes each task's suggested sprint, and renders
 * the view people read (agentic framework §12.5).
 *
 *   npx tsx scripts/backlog.ts           write docs/backlog/PRD-001.md
 *   npx tsx scripts/backlog.ts --check   exit 1 if the backlog is invalid or the view is stale
 *
 * THE SPRINT IS COMPUTED, NOT WRITTEN. A hand-assigned sprint goes wrong the
 * first time a dependency moves, and nobody notices until a task starts before
 * the one it needs. Here the sprint falls out of four things that live in the
 * data: dependencies (a task starts the sprint AFTER everything it depends on),
 * the wave (docs/MVP.md §3: what the owner wants done first, so Ola 0 before
 * Ola 1), priority (Must before Should before Could), the critical path (among
 * equals, the task with the longest chain of open work waiting on it goes
 * first; file order breaks the remaining ties) and capacity (per sprint and per
 * lane — lanes are split by the files they touch, docs/MVP.md §3). Owner decisions are scheduled in sprint 1 and do not use
 * capacity: a task waiting on one can never land in sprint 1.
 *
 * WHAT MAKES A TASK ATOMIC is checked, not assumed: D1–D3 only (a D4 is split
 * before it enters), and at most MAX_TASK_LINES unless the task is marked
 * `mechanical` (moved or generated lines, which AGENTS.md does not count).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'docs', 'backlog', 'PRD-001.json');
const OUT = path.join(ROOT, 'docs', 'backlog', 'PRD-001.md');

/** AGENTS.md, «Ciclo de trabajo»: one PR per task, under ~400 lines. */
export const MAX_TASK_LINES = 400;

export type Priority = 'Must' | 'Should' | 'Could';
const PRIORITY_RANK: Record<Priority, number> = { Must: 0, Should: 1, Could: 2 };

export interface Task {
  id: string;
  type?: 'task' | 'decision';
  title: string;
  issue: number;
  part?: string;
  requirement: string;
  priority: Priority;
  difficulty?: string;
  autonomy?: string;
  lane: string;
  /** docs/MVP.md §3, Ola 0–3. Orders the queue before priority does. */
  wave?: number;
  owner?: string;
  size?: number;
  mechanical?: boolean;
  depends_on: string[];
  status: 'open' | 'done';
  acceptance: string;
}

export interface Backlog {
  prd: string;
  schedule: {
    start: string;
    sprint_days: number;
    capacity_per_sprint: number;
    capacity_per_lane: number;
  };
  lanes: Record<string, string>;
  tasks: Task[];
}

const isDecision = (t: Task): boolean => t.type === 'decision';

/** The RF-nn / RNF-nn ids declared in the PRD's requirement tables. */
export function requirementIds(prdMarkdown: string): Set<string> {
  return new Set([...prdMarkdown.matchAll(/^\| (RN?F-\d{2}) \|/gm)].map((m) => m[1]));
}

/** Every rule a backlog must satisfy. An empty list means valid. */
export function validate(backlog: Backlog, requirements: Set<string>, prdNumber: string): string[] {
  const errors: string[] = [];
  const byId = new Map<string, Task>();
  const idPattern = new RegExp(`^MNE-${prdNumber}-\\d{3}$`);

  // A missing or zero capacity would not fail later: it would silently turn a
  // limit off or stall the scheduler. So the schedule block is checked first.
  const { start, sprint_days, capacity_per_sprint, capacity_per_lane } = backlog.schedule ?? {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(start)) ? new Date(`${start}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== start) {
    errors.push(`schedule.start: «${String(start)}» is not a date (YYYY-MM-DD)`);
  }
  for (const [field, value] of Object.entries({ sprint_days, capacity_per_sprint, capacity_per_lane })) {
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`schedule.${field}: «${String(value)}» must be a positive integer`);
    }
  }

  for (const t of backlog.tasks) {
    if (!idPattern.test(t.id)) errors.push(`${t.id}: the id must look like MNE-${prdNumber}-nnn`);
    if (byId.has(t.id)) errors.push(`${t.id}: duplicated id`);
    byId.set(t.id, t);
  }

  for (const t of backlog.tasks) {
    if (!requirements.has(t.requirement)) errors.push(`${t.id}: ${t.requirement} is not a requirement of the PRD`);
    if (!(t.priority in PRIORITY_RANK)) errors.push(`${t.id}: priority must be Must, Should or Could`);
    if (!(t.lane in backlog.lanes)) errors.push(`${t.id}: lane «${t.lane}» is not declared`);
    if (t.status !== 'open' && t.status !== 'done') errors.push(`${t.id}: status must be open or done`);

    if (isDecision(t)) {
      if (!t.owner) errors.push(`${t.id}: a decision needs an owner`);
    } else {
      if (!/^D[1-3]$/.test(t.difficulty ?? '')) {
        errors.push(`${t.id}: difficulty ${t.difficulty ?? '(none)'} — only D1–D3 are atomic; split a D4 first`);
      }
      if (!/^A[1-3]$/.test(t.autonomy ?? '')) errors.push(`${t.id}: autonomy must be A1–A3`);
      if (![0, 1, 2, 3].includes(t.wave ?? -1)) errors.push(`${t.id}: wave must be 0–3 (docs/MVP.md §3)`);
      if (typeof t.size !== 'number') errors.push(`${t.id}: size (estimated lines) is missing`);
      else if (t.size > MAX_TASK_LINES && !t.mechanical) {
        errors.push(`${t.id}: ${t.size} lines is over ${MAX_TASK_LINES} — split it, or mark it mechanical`);
      }
    }

    for (const dep of t.depends_on) {
      const target = byId.get(dep);
      if (!target) {
        errors.push(`${t.id}: depends on ${dep}, which does not exist`);
        continue;
      }
      if (dep === t.id) errors.push(`${t.id}: depends on itself`);
      if (PRIORITY_RANK[target.priority] > PRIORITY_RANK[t.priority]) {
        errors.push(`${t.id}: a ${t.priority} task cannot wait on ${dep}, which is only ${target.priority}`);
      }
      if (t.status === 'done' && target.status === 'open') {
        errors.push(`${t.id}: marked done but depends on ${dep}, still open`);
      }
    }
  }

  const covered = new Set(backlog.tasks.map((t) => t.requirement));
  for (const r of requirements) {
    if (!covered.has(r)) errors.push(`${r}: a requirement of the PRD with no task — nothing would deliver it`);
  }

  const cycle = findCycle(backlog.tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`);
  return errors;
}

function findCycle(tasks: Task[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done' || !deps.has(id)) return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const t of tasks) {
    const found = visit(t.id);
    if (found) return found;
  }
  return null;
}

/**
 * Suggested sprint per task: 0 for done work, 1 for open decisions, and for
 * everything else the earliest sprint after all its dependencies that still
 * has room in the sprint and in the task's lane. Assumes a validated backlog.
 */
export function schedule(backlog: Backlog): Map<string, number> {
  const sprint = new Map<string, number>();
  const order = new Map(backlog.tasks.map((t, i) => [t.id, i]));
  const chain = chainLengths(backlog.tasks);
  let pending: Task[] = [];

  for (const t of backlog.tasks) {
    if (t.status === 'done') sprint.set(t.id, 0);
    else if (isDecision(t)) sprint.set(t.id, 1);
    else pending.push(t);
  }

  const { capacity_per_sprint: perSprint, capacity_per_lane: perLane } = backlog.schedule;
  for (let s = 1; pending.length > 0; s++) {
    if (s > 500) throw new Error('scheduling did not converge: check the capacities');
    const ready = pending
      .filter((t) => t.depends_on.every((d) => (sprint.get(d) ?? Infinity) < s))
      .sort(
        (a, b) =>
          (a.wave ?? 9) - (b.wave ?? 9) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          chain.get(b.id)! - chain.get(a.id)! ||
          order.get(a.id)! - order.get(b.id)!,
      );
    const laneLoad = new Map<string, number>();
    let taken = 0;
    for (const t of ready) {
      if (taken >= perSprint) break;
      if ((laneLoad.get(t.lane) ?? 0) >= perLane) continue;
      sprint.set(t.id, s);
      laneLoad.set(t.lane, (laneLoad.get(t.lane) ?? 0) + 1);
      taken++;
    }
    pending = pending.filter((t) => !sprint.has(t.id));
  }
  return sprint;
}

/**
 * For each open task, how many sprints of open work hang behind it at least:
 * 1 for a task nothing waits on, and one more than its longest dependent chain
 * otherwise. Without it, a lane at capacity picks by file order and can leave
 * the head of a long chain for later, which pushes the MVP a sprint per link.
 */
export function chainLengths(tasks: Task[]): Map<string, number> {
  const open = tasks.filter((t) => t.status === 'open' && !isDecision(t));
  const dependents = new Map<string, Task[]>(open.map((t) => [t.id, []]));
  for (const t of open) for (const d of t.depends_on) dependents.get(d)?.push(t);
  const length = new Map<string, number>();
  const visit = (t: Task): number => {
    const known = length.get(t.id);
    if (known !== undefined) return known;
    const n = 1 + Math.max(0, ...dependents.get(t.id)!.map(visit));
    length.set(t.id, n);
    return n;
  };
  for (const t of open) visit(t);
  return length;
}

function sprintStart(start: string, days: number, n: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1) * days);
  return d.toISOString().slice(0, 10);
}

const issueLink = (n: number): string => `[#${n}](https://github.com/sedecim-com/Accounting/issues/${n})`;
/** A Markdown table cell: the backslash first, or a trailing `\` would escape the separator after it. */
const cell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** The Markdown view of the backlog. Deterministic: same data, same bytes. */
export function render(backlog: Backlog, sprints: Map<string, number>): string {
  const { start, sprint_days: days } = backlog.schedule;
  const open = backlog.tasks.filter((t) => t.status === 'open');
  const work = open.filter((t) => !isDecision(t));
  const decisions = open.filter(isDecision);
  const last = Math.max(0, ...work.map((t) => sprints.get(t.id)!));
  const doneCount = backlog.tasks.filter((t) => t.status === 'done').length;
  const lastOf = (ts: Task[]): string => {
    const pending = ts.filter((t) => t.status === 'open' && !isDecision(t));
    return pending.length === 0 ? 'hecho' : `S${Math.max(...pending.map((t) => sprints.get(t.id)!))}`;
  };
  const mvp = lastOf(work.filter((t) => t.priority === 'Must'));
  const byId = new Map(backlog.tasks.map((t) => [t.id, t]));

  const lines: string[] = [
    '# Backlog — PRD-001, el MVP',
    '',
    '<!-- GENERADO por `npx tsx scripts/backlog.ts` desde docs/backlog/PRD-001.json. No se edita a mano: se edita el JSON y se regenera; `--check` falla si esta vista quedó vieja. -->',
    '',
    `Cada requisito de [PRD-001](../prd/PRD-001-mvp.md) se traduce en tareas atómicas: un solo resultado verificable, un solo repo, D1–D3 y menos de ${MAX_TASK_LINES} líneas por PR. El **sprint es sugerido y calculado**: una tarea entra en el sprint siguiente al de todo lo que necesita, por ola (docs/MVP.md §3) y, dentro de cada ola, Must antes que Should y Could, con un tope de ${backlog.schedule.capacity_per_sprint} tareas por sprint y ${backlog.schedule.capacity_per_lane} por carril. Sprints de ${days} días desde el ${start}.`,
    '',
    `**Resumen:** ${work.length} tareas abiertas y ${decisions.length} ${decisions.length === 1 ? 'decisión' : 'decisiones'} del dueño; ${doneCount} ${doneCount === 1 ? 'ya hecha' : 'ya hechas'}. Con la capacidad declarada, **lo Must termina en ${mvp}** y la última tarea cae en S${last}, del ${sprintStart(start, days, last)}. **Antes de fiarse de esa fecha:** la capacidad es un tope inicial; se recalibra con la velocidad medida al cerrar S1.`,
    '',
    '## Por sprint',
    '',
    '| Sprint | Empieza | Tareas | Must | Should | Could |',
    '|---|---|---|---|---|---|',
  ];
  for (let s = 1; s <= last; s++) {
    const inS = work.filter((t) => sprints.get(t.id) === s);
    const count = (p: Priority): number => inS.filter((t) => t.priority === p).length;
    lines.push(`| S${s} | ${sprintStart(start, days, s)} | ${inS.length} | ${count('Must')} | ${count('Should')} | ${count('Could')} |`);
  }

  lines.push(
    '',
    '## Decisiones del dueño: S1',
    '',
    'Ninguna tarea que espera una decisión puede caer en S1. Cada día que una decisión se retrasa, se retrasan sus tareas.',
    '',
    '| ID | Decisión | Issue | Bloquea |',
    '|---|---|---|---|',
  );
  for (const d of decisions) {
    const blocks = open.filter((t) => t.depends_on.includes(d.id)).map((t) => t.id);
    lines.push(`| ${d.id} | ${cell(d.title)} | ${issueLink(d.issue)} | ${blocks.join(', ') || '—'} |`);
  }

  for (let s = 1; s <= last; s++) {
    const inS = work.filter((t) => sprints.get(t.id) === s);
    lines.push(
      '',
      `## S${s} · desde el ${sprintStart(start, days, s)}`,
      '',
      '| ID | Tarea | Issue | Req. | Prioridad | D · A | Carril | Depende de | Líneas |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const t of inS) {
      const deps = t.depends_on.filter((d) => byId.get(d)?.status === 'open');
      const depText = deps.length > 6 ? `${deps.length} tareas (ver el JSON)` : deps.join(', ') || '—';
      const size = `${t.size}${t.mechanical ? ' (mecánicas)' : ''}`;
      lines.push(
        `| ${t.id} | ${cell(t.title)} | ${issueLink(t.issue)} | ${t.requirement} | ${t.priority} | ${t.difficulty} · ${t.autonomy} | ${t.lane} | ${depText} | ${size} |`,
      );
    }
  }

  lines.push(
    '',
    '## Trazabilidad: de cada requisito a sus tareas',
    '',
    '| Req. | Tareas | Must listo en | Todo listo en |',
    '|---|---|---|---|',
  );
  const reqs = [...new Set(backlog.tasks.map((t) => t.requirement))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  for (const r of reqs) {
    const ts = backlog.tasks.filter((t) => t.requirement === r);
    const must = ts.filter((t) => t.priority === 'Must');
    lines.push(`| ${r} | ${ts.map((t) => t.id.slice(-3)).join(', ')} | ${must.length ? lastOf(must) : '—'} | ${lastOf(ts)} |`);
  }

  lines.push(
    '',
    '## Carriles',
    '',
    ...Object.entries(backlog.lanes).map(([k, v]) => `- **${k}** · ${v}`),
    '',
  );
  return lines.join('\n');
}

function main(): void {
  const backlog = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as Backlog;
  const prdPath = path.join(ROOT, backlog.prd);
  const prdNumber = /PRD-(\d{3})/.exec(backlog.prd)?.[1] ?? '';
  const errors = validate(backlog, requirementIds(fs.readFileSync(prdPath, 'utf8')), prdNumber);
  if (errors.length > 0) {
    console.error(`The backlog is not valid (${errors.length}):\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  const view = render(backlog, schedule(backlog));

  if (process.argv.includes('--check')) {
    const published = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (published !== view) {
      console.error('docs/backlog/PRD-001.md is stale: run `npx tsx scripts/backlog.ts` and commit it.');
      process.exit(1);
    }
    console.log('El backlog es válido y su vista está al día.');
    return;
  }
  fs.writeFileSync(OUT, view);
  console.log(`Escrito ${path.relative(ROOT, OUT)}.`);
}

if (require.main === module) main();
