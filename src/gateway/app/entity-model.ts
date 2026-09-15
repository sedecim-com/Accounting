// ============================================================
// ONE ENTITY'S LISTS, AS THE BROWSER RECEIVES THEM (W1 · issue #117)
//
// The entity view reads three routes that already exist, each gated per
// entity by the API: GET /v1/ai/drafts?status=pending_review,
// GET /v1/ai/questions?status=pending and GET /v1/fiscal-periods. Each answer
// is narrowed here to the fields the view renders, as strings, and a body of
// another shape is refused whole.
//
// DATES. The API serialises the date columns through node-postgres, which
// turns a DATE into a JavaScript Date and then an ISO instant. The view shows
// the calendar part of that string as it arrives and converts nothing, so what
// the page prints is what the API sent.
//
// DOM-free: the unit specs import it.
// ============================================================

export interface DraftItem {
  id: string;
  entryDate: string;
  description: string;
  confidence: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  topic: string;
  createdAt: string;
}

export interface PeriodItem {
  id: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The YYYY-MM-DD at the head of a date or an ISO instant, or the value as it came. */
export function calendarPart(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : value;
}

/** A scalar the API may send as a number or a numeric string, as text. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function listOf<T>(body: unknown, parseItem: (item: unknown) => T | undefined): T[] | undefined {
  if (!isFields(body) || !Array.isArray(body.data)) return undefined;
  const items: T[] = [];
  for (const raw of body.data) {
    const item = parseItem(raw);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

export function parseDraftList(body: unknown): DraftItem[] | undefined {
  return listOf(body, (raw) => {
    if (!isFields(raw) || typeof raw.id !== 'string' || !isFields(raw.payload)) return undefined;
    const { entry_date: entryDate, description } = raw.payload;
    const confidence = scalarText(raw.ai_confidence);
    if (typeof entryDate !== 'string' || typeof description !== 'string' || confidence === undefined) return undefined;
    return { id: raw.id, entryDate: calendarPart(entryDate), description, confidence };
  });
}

export function parseQuestionList(body: unknown): QuestionItem[] | undefined {
  return listOf(body, (raw) => {
    if (!isFields(raw) || typeof raw.id !== 'string' || typeof raw.question !== 'string') return undefined;
    const topic = raw.topic === null || raw.topic === undefined ? '' : raw.topic;
    if (typeof topic !== 'string' || typeof raw.created_at !== 'string') return undefined;
    return { id: raw.id, question: raw.question, topic, createdAt: calendarPart(raw.created_at) };
  });
}

export function parsePeriodList(body: unknown): PeriodItem[] | undefined {
  return listOf(body, (raw) => {
    if (!isFields(raw) || typeof raw.id !== 'string' || typeof raw.period_name !== 'string') return undefined;
    const { status, start_date: startDate, end_date: endDate } = raw;
    if (typeof status !== 'string' || typeof startDate !== 'string' || typeof endDate !== 'string') return undefined;
    return { id: raw.id, name: raw.period_name, status, startDate: calendarPart(startDate), endDate: calendarPart(endDate) };
  });
}
