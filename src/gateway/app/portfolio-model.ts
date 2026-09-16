// ============================================================
// THE PORTFOLIO, AS THE BROWSER RECEIVES IT (W1 · issue #117)
//
// GET /v1/portfolio answers {data, meta}. The response is narrowed here at run
// time, field by field, because it crosses a process boundary: a payload of
// another shape is refused whole rather than rendered in part. The types are
// the browser's own copy; the program may not import the service that builds
// them (criterion web-gateway-never-reaches-the-engine).
//
// DOM-free: the unit specs import it.
// ============================================================

export interface PortfolioPeriod {
  id: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
}

export interface PortfolioRow {
  entityId: string;
  name: string;
  isActive: boolean;
  currentPeriod: PortfolioPeriod | null;
  endedOpenPeriods: number;
  pendingDrafts: number;
  pendingQuestions: number;
}

export interface PortfolioMeta {
  /** The database's CURRENT_DATE, YYYY-MM-DD. */
  asOfDate: string;
  /** Token entity ids that produced no row. */
  unresolved: number;
  /** What the API says it did not evaluate, e.g. close_readiness. */
  notEvaluated: string[];
}

export interface Portfolio {
  rows: PortfolioRow[];
  meta: PortfolioMeta;
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(value: unknown): PortfolioPeriod | null | undefined {
  if (value === null) return null;
  if (!isFields(value)) return undefined;
  const { id, name, status, start_date: startDate, end_date: endDate } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof status !== 'string') return undefined;
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return undefined;
  return { id, name, status, startDate, endDate };
}

function parseRow(value: unknown): PortfolioRow | undefined {
  if (!isFields(value)) return undefined;
  const currentPeriod = parsePeriod(value.current_period);
  const {
    entity_id: entityId,
    name,
    is_active: isActive,
    ended_open_periods: endedOpenPeriods,
    pending_drafts: pendingDrafts,
    pending_questions: pendingQuestions,
  } = value;
  if (typeof entityId !== 'string' || typeof name !== 'string' || typeof isActive !== 'boolean') return undefined;
  if (currentPeriod === undefined) return undefined;
  if (!isCount(endedOpenPeriods) || !isCount(pendingDrafts) || !isCount(pendingQuestions)) return undefined;
  return { entityId, name, isActive, currentPeriod, endedOpenPeriods, pendingDrafts, pendingQuestions };
}

/** The portfolio in a response body, or undefined when the body is not one. */
export function parsePortfolioResponse(body: unknown): Portfolio | undefined {
  if (!isFields(body) || !Array.isArray(body.data) || !isFields(body.meta)) return undefined;
  const { as_of_date: asOfDate, omitted, not_evaluated: notEvaluated } = body.meta;
  if (typeof asOfDate !== 'string' || !ISO_DATE.test(asOfDate)) return undefined;
  if (!isFields(omitted) || !isCount(omitted.unresolved)) return undefined;
  if (!Array.isArray(notEvaluated)) return undefined;
  const notes: string[] = [];
  for (const item of notEvaluated) {
    if (typeof item !== 'string') return undefined;
    notes.push(item);
  }

  const rows: PortfolioRow[] = [];
  for (const item of body.data) {
    const row = parseRow(item);
    if (!row) return undefined;
    rows.push(row);
  }
  return { rows, meta: { asOfDate, unresolved: omitted.unresolved, notEvaluated: notes } };
}

export type SortColumn = 'name' | 'currentPeriod' | 'endedOpenPeriods' | 'pendingDrafts' | 'pendingQuestions';

export type SortDirection = 'ascending' | 'descending';

export interface SortOrder {
  column: SortColumn;
  direction: SortDirection;
}

export const SORT_COLUMNS: readonly SortColumn[] = ['name', 'currentPeriod', 'endedOpenPeriods', 'pendingDrafts', 'pendingQuestions'];

function compareRows(a: PortfolioRow, b: PortfolioRow, column: SortColumn): number {
  switch (column) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'currentPeriod':
      // By start date; an entity with no period sorts first.
      return (a.currentPeriod?.startDate ?? '').localeCompare(b.currentPeriod?.startDate ?? '');
    case 'endedOpenPeriods':
      return a.endedOpenPeriods - b.endedOpenPeriods;
    case 'pendingDrafts':
      return a.pendingDrafts - b.pendingDrafts;
    case 'pendingQuestions':
      return a.pendingQuestions - b.pendingQuestions;
  }
}

/**
 * A sorted copy. Stable in both directions: rows that compare equal keep the
 * order the API gave them (name, then entity id), descending included, so a
 * re-sort never shuffles ties.
 */
export function sortRows(rows: readonly PortfolioRow[], order: SortOrder): PortfolioRow[] {
  const sign = order.direction === 'ascending' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * compareRows(a.row, b.row, order.column) || a.index - b.index)
    .map(({ row }) => row);
}

/** Whole minutes between a read and now, never negative. */
export function ageInMinutes(fetchedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - fetchedAt) / 60_000));
}
