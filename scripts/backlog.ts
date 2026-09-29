/**
 * Validates a PRD backlog, computes each task's suggested sprint, and renders
 * the view people read (agentic framework §12.5).
 *
 *   npx tsx scripts/backlog.ts           write docs/backlog/PRD-001.md
 *   npx tsx scripts/backlog.ts --check   exit 1 if the backlog is invalid or the view is stale
 *
 * THE SPRINT IS COMPUTED, NOT WRITTEN. A hand-assigned sprint goes wrong the
 * first time a dependency moves, and nobody notices until a task starts before
 * the one it needs. Here the sprint falls out of what lives in the data:
 *
 * - dependencies: a task starts in the earliest sprint AFTER everything it
 *   depends on, with room in its lane. There is one queue for all the open
 *   work, whatever its wave: the owner decided on 2026-09-29 to run in
 *   parallel as much as possible, which replaced the rule of 2026-09-28 that
 *   no wave N+1 task entered a sprint until every open task of waves ≤ N had
 *   an earlier one (docs/MVP.md §3);
 * - the wave is a RELEASE label (`schedule.stages`): release N ships when
 *   every task of waves ≤ N is done, in the last sprint holding one of them.
 *   It still orders the queue first, so when a lane is full an earlier
 *   release wins; then priority (Must before Should before Could), the
 *   critical path (the task with the longest chain of open work waiting on it
 *   goes first) and file order for the remaining ties;
 * - capacity per lane (lanes are split by the files they touch, so two PRs of
 *   different lanes do not collide, docs/MVP.md §3) and, only if the schedule
 *   declares `capacity_per_sprint`, per sprint.
 *
 * Sprints are numbered as the owner calls them: done work counts as delivered
 * in the sprint before `schedule.first_open_sprint`, and open work starts at
 * that sprint, which begins on `schedule.start`. Owner decisions go in the
 * first open sprint and do not use capacity: a task waiting on one can never
 * land in it.
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

/** A wave seen as a development stage: what it is called and the release it ends in. */
export interface Stage {
  name: string;
  release: string;
}

export interface Backlog {
  prd: string;
  schedule: {
    /** The date the first open sprint starts. */
    start: string;
    sprint_days: number;
    /** Optional: absent means no cap per sprint, only per lane (the owner's decision of 2026-09-29). */
    capacity_per_sprint?: number;
    capacity_per_lane: number;
    /** The number of the first sprint with open work; done work counts as the one before. Default 1. */
    first_open_sprint?: number;
    /** Keyed by wave (docs/MVP.md §3). Every wave a task uses needs one. */
    stages?: Record<string, Stage>;
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
  // capacity_per_sprint may be absent (no cap), but a declared one must be usable.
  const capacities = { sprint_days, capacity_per_lane, ...(capacity_per_sprint === undefined ? {} : { capacity_per_sprint }) };
  for (const [field, value] of Object.entries(capacities)) {
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`schedule.${field}: «${String(value)}» must be a positive integer`);
    }
  }
  const firstOpen = backlog.schedule?.first_open_sprint;
  if (firstOpen !== undefined && (!Number.isInteger(firstOpen) || firstOpen < 1)) {
    errors.push(`schedule.first_open_sprint: «${String(firstOpen)}» must be a positive integer`);
  }
  const stages = backlog.schedule?.stages ?? {};
  for (const [wave, stage] of Object.entries(stages)) {
    if (!stage?.name || !stage?.release) errors.push(`schedule.stages.${wave}: a stage needs a name and a release`);
  }
  const waves = new Set(backlog.tasks.filter((t) => !isDecision(t) && t.wave !== undefined).map((t) => t.wave!));
  for (const w of [...waves].sort()) {
    if (!(String(w) in stages)) errors.push(`schedule.stages: wave ${w} has tasks but no stage (name and release)`);
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
      // Waves are releases: release N ships when waves ≤ N are done, so a task
      // that waits on a later wave would hold its release hostage to a later
      // one. Decisions have no wave.
      if (!isDecision(t) && !isDecision(target) && (target.wave ?? 0) > (t.wave ?? 0)) {
        errors.push(`${t.id}: wave ${t.wave} cannot depend on ${dep}, of the later wave ${target.wave}`);
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
 * Suggested sprint per task: `first_open_sprint - 1` for done work (delivered),
 * `first_open_sprint` for open decisions, and for everything else the earliest
 * sprint after all its dependencies that still has room in the task's lane
 * (and in the sprint, when `capacity_per_sprint` is declared). One queue for
 * every wave: the wave only orders who goes first under contention. Assumes a
 * validated backlog.
 */
export function schedule(backlog: Backlog): Map<string, number> {
  const first = backlog.schedule.first_open_sprint ?? 1;
  const sprint = new Map<string, number>();
  const order = new Map(backlog.tasks.map((t, i) => [t.id, i]));
  const chain = chainLengths(backlog.tasks);
  const pending: Task[] = [];

  for (const t of backlog.tasks) {
    if (t.status === 'done') sprint.set(t.id, first - 1);
    else if (isDecision(t)) sprint.set(t.id, first);
    else pending.push(t);
  }

  const perSprint = backlog.schedule.capacity_per_sprint ?? Infinity;
  const perLane = backlog.schedule.capacity_per_lane;
  let queue = pending;
  for (let s = first; queue.length > 0; s++) {
    if (s > first + 500) throw new Error('scheduling did not converge: check the capacities');
    const ready = queue
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
    queue = queue.filter((t) => !sprint.has(t.id));
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

/** The first day of sprint n, counting from `start`, the first day of the first open sprint. */
function sprintStart(start: string, days: number, n: number, first: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - first) * days);
  return d.toISOString().slice(0, 10);
}

/** The last day of sprint n: the day before the next one starts. */
function sprintEnd(start: string, days: number, n: number, first: number): string {
  const d = new Date(`${sprintStart(start, days, n + 1, first)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const issueLink = (n: number): string => `[#${n}](https://github.com/sedecim-com/Accounting/issues/${n})`;
/** A Markdown table cell: the backslash first, or a trailing `\` would escape the separator after it. */
const cell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const range = (from: number, to: number): string => (from === to ? `S${from}` : `S${from}–S${to}`);

/**
 * The sprint each wave's release ships in: the last sprint holding an open
 * task of that wave or an earlier one, since release N needs every task of
 * waves ≤ N done. `first_open_sprint - 1` when all of it is already delivered.
 */
export function releaseSprints(backlog: Backlog, sprints: Map<string, number>): Map<number, number> {
  const delivered = (backlog.schedule.first_open_sprint ?? 1) - 1;
  const work = backlog.tasks.filter((t) => !isDecision(t));
  const waves = [...new Set(work.map((t) => t.wave ?? 9))].sort((a, b) => a - b);
  const open = work.filter((t) => t.status === 'open');
  return new Map(
    waves.map((w) => [
      w,
      Math.max(delivered, ...open.filter((t) => (t.wave ?? 9) <= w).map((t) => sprints.get(t.id)!)),
    ]),
  );
}

/** The Markdown view of the backlog. Deterministic: same data, same bytes. */
export function render(backlog: Backlog, sprints: Map<string, number>): string {
  const { start, sprint_days: days, capacity_per_sprint: perSprint, capacity_per_lane: perLane } = backlog.schedule;
  const first = backlog.schedule.first_open_sprint ?? 1;
  const delivered = first - 1;
  const stages = backlog.schedule.stages ?? {};
  const begins = (n: number): string => sprintStart(start, days, n, first);
  const ends = (n: number): string => sprintEnd(start, days, n, first);
  const stageName = (w: number): string => stages[String(w)]?.name ?? `Ola ${w}`;
  const stageRelease = (w: number): string => stages[String(w)]?.release ?? '—';
  /** «R1» out of «R1 · MVP α: …», to mark a task's release in a table without repeating its name. */
  const releaseCode = (w: number): string => stageRelease(w).split(' · ')[0];

  const open = backlog.tasks.filter((t) => t.status === 'open');
  const work = open.filter((t) => !isDecision(t));
  const decisions = open.filter(isDecision);
  const done = backlog.tasks.filter((t) => t.status === 'done');
  const last = Math.max(first - 1, ...work.map((t) => sprints.get(t.id)!));
  const lastOf = (ts: Task[]): string => {
    const pending = ts.filter((t) => t.status === 'open' && !isDecision(t));
    return pending.length === 0 ? 'hecho' : `S${Math.max(...pending.map((t) => sprints.get(t.id)!))}`;
  };
  const mvp = lastOf(work.filter((t) => t.priority === 'Must'));
  const byId = new Map(backlog.tasks.map((t) => [t.id, t]));
  const waves = [...new Set(backlog.tasks.filter((t) => !isDecision(t)).map((t) => t.wave ?? 9))].sort((a, b) => a - b);
  const sprintsOf = (w: number): number[] => work.filter((t) => (t.wave ?? 9) === w).map((t) => sprints.get(t.id)!);
  const release = releaseSprints(backlog, sprints);
  const shipsIn = (s: number): number[] => waves.filter((w) => release.get(w) === s);
  const ships = (w: number): string =>
    release.get(w) === delivered ? `S${delivered} (entregada)` : `S${release.get(w)!}, el ${ends(release.get(w)!)}`;
  const cap =
    perSprint === undefined
      ? `con un tope de ${perLane} tareas por carril y ninguno por sprint`
      : `con un tope de ${perLane} tareas por carril y ${perSprint} por sprint`;

  const lines: string[] = [
    '# Backlog — PRD-001, el MVP',
    '',
    '<!-- GENERADO por `npx tsx scripts/backlog.ts` desde docs/backlog/PRD-001.json. No se edita a mano: se edita el JSON y se regenera; `--check` falla si esta vista quedó vieja. -->',
    '',
    `Cada requisito de [PRD-001](../prd/PRD-001-mvp.md) se traduce en tareas atómicas: un solo resultado verificable, un solo repo, D1–D3 y menos de ${MAX_TASK_LINES} líneas por PR. El **sprint es sugerido y calculado**, y el plan corre **en paralelo todo lo que puede**: una tarea entra en el primer sprint después del de todo lo que necesita, ${cap}, sea de la ola que sea. Lo decidió el dueño el 2026-09-29, y reemplaza la regla del 2026-09-28 de no abrir una ola hasta tener en el calendario toda la anterior. **Cada ola de docs/MVP.md §3 marca una entrega**: la entrega N sale cuando está hecho todo lo de las olas ≤ N. Si un carril se llena, entra primero la ola más temprana; después, Must antes que Should y Could. Lo hecho cuenta como entregado en S${delivered}; el trabajo abierto empieza en S${first}, el ${start}, con sprints de ${days} días.`,
    '',
    `**Resumen:** ${work.length} tareas abiertas y ${decisions.length} ${decisions.length === 1 ? 'decisión' : 'decisiones'} del dueño; ${done.length} ${done.length === 1 ? 'ya hecha' : 'ya hechas'}, entregadas en S${delivered}. Con la capacidad declarada, **lo Must termina en ${mvp}** y la última tarea cae en S${last}, que termina el ${ends(last)}. **Antes de fiarse de esa fecha:** la capacidad es un tope inicial; se recalibra con la velocidad medida al cerrar S${first}.`,
    '',
    '## Por etapa',
    '',
    'Las tareas de una etapa no ocupan un tramo de sprints propio: caen donde caben, junto a las de otras olas. Su entrega sale al cerrar el último sprint con una tarea abierta de esa ola o de una anterior.',
    '',
    '| Ola · etapa | Abiertas | Must | Hechas | Sus tareas caen en | Entrega | Sale en |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const w of waves) {
    const inW = work.filter((t) => (t.wave ?? 9) === w);
    const doneW = done.filter((t) => !isDecision(t) && (t.wave ?? 9) === w).length;
    const ss = sprintsOf(w);
    const when =
      ss.length === 0
        ? `S${delivered} (entregada)`
        : `${range(Math.min(...ss), Math.max(...ss))}, ${begins(Math.min(...ss))} → ${ends(Math.max(...ss))}`;
    const must = inW.filter((t) => t.priority === 'Must').length;
    lines.push(
      `| ${w} · ${cell(stageName(w))} | ${inW.length} | ${must} | ${doneW} | ${when} | ${cell(stageRelease(w))} | ${ships(w)} |`,
    );
  }

  lines.push('', '## Entregas', '');
  for (const w of waves) {
    const pending = work.filter((t) => (t.wave ?? 9) <= w).length;
    lines.push(
      release.get(w) === delivered
        ? `- **${cell(stageRelease(w))}** ya salió: lo de las olas ≤ ${w} quedó entregado en S${delivered}.`
        : `- **${cell(stageRelease(w))}** sale al cerrar S${release.get(w)!}, el ${ends(release.get(w)!)}: espera ${pending} ${pending === 1 ? 'tarea abierta' : 'tareas abiertas'} de las olas ≤ ${w}.`,
    );
  }

  lines.push(
    '',
    '## Por sprint',
    '',
    '| Sprint | Olas | Empieza | Tareas | Must | Should | Could | Al cerrar sale |',
    '|---|---|---|---|---|---|---|---|',
    `| S${delivered} | entregado | antes del ${start} | ${done.length} | — | — | — | ${shipsIn(delivered).map(releaseCode).join(', ') || '—'} |`,
  );
  for (let s = first; s <= last; s++) {
    const inS = work.filter((t) => sprints.get(t.id) === s);
    const count = (p: Priority): number => inS.filter((t) => t.priority === p).length;
    const ws = [...new Set(inS.map((t) => t.wave ?? 9))].sort((a, b) => a - b);
    lines.push(
      `| S${s} | ${ws.join(', ') || '—'} | ${begins(s)} | ${inS.length} | ${count('Must')} | ${count('Should')} | ${count('Could')} | ${shipsIn(s).map(releaseCode).join(', ') || '—'} |`,
    );
  }

  lines.push(
    '',
    `## Decisiones del dueño: S${first}`,
    '',
    `Ninguna tarea que espera una decisión puede caer en S${first}. Cada día que una decisión se retrasa, se retrasan sus tareas.`,
    '',
    '| ID | Decisión | Issue | Bloquea |',
    '|---|---|---|---|',
  );
  for (const d of decisions) {
    const blocks = open.filter((t) => t.depends_on.includes(d.id)).map((t) => t.id);
    lines.push(`| ${d.id} | ${cell(d.title)} | ${issueLink(d.issue)} | ${blocks.join(', ') || '—'} |`);
  }

  lines.push(
    '',
    '## Sprint por sprint',
    '',
    'Cada tarea lleva su ola y la entrega a la que pertenece, en la columna «Ola → entrega».',
  );
  for (let s = first; s <= last; s++) {
    const inS = work.filter((t) => sprints.get(t.id) === s);
    if (inS.length === 0) continue;
    const shipping = shipsIn(s).map((w) => `**${cell(stageRelease(w))}**`);
    lines.push(
      '',
      `### S${s} · desde el ${begins(s)}`,
      '',
      `Del ${begins(s)} al ${ends(s)}: ${inS.length} ${inS.length === 1 ? 'tarea' : 'tareas'}.${shipping.length ? ` Al cerrar sale ${shipping.join(' y ')}.` : ''}`,
      '',
      '| ID | Tarea | Issue | Req. | Ola → entrega | Prioridad | D · A | Carril | Depende de | Líneas |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const t of inS) {
      const deps = t.depends_on.filter((d) => byId.get(d)?.status === 'open');
      const depText = deps.length > 6 ? `${deps.length} tareas (ver el JSON)` : deps.join(', ') || '—';
      const size = `${t.size}${t.mechanical ? ' (mecánicas)' : ''}`;
      const w = t.wave ?? 9;
      lines.push(
        `| ${t.id} | ${cell(t.title)} | ${issueLink(t.issue)} | ${t.requirement} | ${w} → ${cell(releaseCode(w))} | ${t.priority} | ${t.difficulty} · ${t.autonomy} | ${t.lane} | ${depText} | ${size} |`,
      );
    }
  }

  lines.push(
    '',
    `## S${delivered} · lo entregado`,
    '',
    '| ID | Tarea | Issue | Ola |',
    '|---|---|---|---|',
    ...done.map(
      (t) => `| ${t.id} | ${cell(t.title)} | ${issueLink(t.issue)} | ${isDecision(t) ? 'decisión' : String(t.wave)} |`,
    ),
  );

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
