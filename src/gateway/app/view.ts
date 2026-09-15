import { isCanonicalUuid, SIGN_IN_PATH } from './contract.js';
import type { DraftItem, PeriodItem, QuestionItem } from './entity-model.js';
import { text } from './messages.js';
import type { WebLanguage, WebMessageKey } from './messages.js';
import { ageInMinutes, sortRows, SORT_COLUMNS, type Portfolio, type PortfolioRow, type SortColumn, type SortOrder } from './portfolio-model.js';
import { toneOfCount, toneOfPeriodStatus, type Tone } from './tone.js';

// ============================================================
// THE SCREENS, AS A TREE OF PLAIN DATA (W1 · issue #117)
//
// Everything the board shows is decided here and returned as ElementSpec
// values: a tag, a few attributes, text or children, and a named action for a
// button. Nothing here touches a document. dom.ts turns the tree into nodes
// with createElement and textContent, so a third-party string (an entity
// name, a draft description, a question) can only ever become a text node.
//
// That split is also what makes accessibility testable without a browser:
// tests/gateway/web-view.spec.ts reads this tree for the caption, the header
// scopes, aria-sort, the row-header links, tabindex and the live-region roles.
// A keyboard and screen-reader pass in real browsers is recorded separately.
//
// DOM-free: the unit specs import it.
// ============================================================

export type ViewTag =
  | 'a'
  | 'button'
  | 'caption'
  | 'code'
  | 'div'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'header'
  | 'li'
  | 'nav'
  | 'p'
  | 'section'
  | 'span'
  | 'table'
  | 'tbody'
  | 'td'
  | 'th'
  | 'thead'
  | 'tr'
  | 'ul';

export type ViewAction = { kind: 'sort'; column: SortColumn } | { kind: 'refresh' } | { kind: 'sign-out' };

export interface ElementSpec {
  tag: ViewTag;
  attributes?: Readonly<Record<string, string>>;
  /** Text, which always becomes a text node, or child elements. Never both. */
  children?: string | readonly ElementSpec[];
  /** What a click on this element asks for. Only buttons carry one. */
  action?: ViewAction;
}

/** Why a read did not produce data, reduced to what the screen says about it. */
export type Failure = 'signed-out' | 'session-expired' | 'no-access' | 'unavailable' | 'unexpected';

export interface PortfolioScreen {
  kind: 'portfolio';
  /** The last good read. A failed refresh keeps it, marked stale. */
  loaded?: { portfolio: Portfolio; fetchedAt: number };
  loading: boolean;
  /** The last failure, and when it happened. Cleared by a good read. */
  failure?: { reason: Failure; at: number };
  sort: SortOrder;
}

export interface EntityScreen {
  kind: 'entity';
  entityId: string;
  /** The entity's name when the portfolio has already been read. */
  entityName?: string;
  loaded?: { drafts: DraftItem[]; questions: QuestionItem[]; periods: PeriodItem[] };
  loading: boolean;
  failure?: Failure;
}

export interface NoticeScreen {
  kind: 'signin-failed' | 'not-found';
}

export type Screen = PortfolioScreen | EntityScreen | NoticeScreen;

export type Route = { kind: 'portfolio' } | { kind: 'entity'; entityId: string } | { kind: 'signin-failed' } | { kind: 'not-found' };

/**
 * The route a location hash names. Undefined for a hash that is not a route
 * (the skip link's '#app'), which leaves the current screen as it is.
 */
export function parseRoute(hash: string): Route | undefined {
  if (hash === '' || hash === '#' || hash === '#/') return { kind: 'portfolio' };
  if (!hash.startsWith('#/')) return undefined;
  const entity = /^#\/entity\/([^/]+)$/.exec(hash);
  if (entity) return isCanonicalUuid(entity[1]) ? { kind: 'entity', entityId: entity[1] } : { kind: 'not-found' };
  if (hash === '#/signin-failed') return { kind: 'signin-failed' };
  return { kind: 'not-found' };
}

export function entityHref(entityId: string): string {
  return `#/entity/${entityId}`;
}

/**
 * The CLI commands that list, for one entity, the same drafts, questions and
 * periods the entity view shows. Each was checked by reading its action to
 * read and never write, and tests/gateway/verify-commands.spec.ts parses each
 * through the real program and requires its risk to be lectura. They are
 * printed as commands, never translated, with the entity id filled in.
 */
export const VERIFY_COMMANDS: readonly string[] = [
  'mnemosine drafts -e {entity} --status pending_review',
  'mnemosine question list -e {entity}',
  'mnemosine period list -e {entity}',
];

const PERIOD_STATUS_KEYS: Readonly<Record<string, WebMessageKey>> = {
  future: 'web.period_status.future',
  open: 'web.period_status.open',
  soft_close: 'web.period_status.soft_close',
  hard_close: 'web.period_status.hard_close',
  locked: 'web.period_status.locked',
};

const COLUMN_KEYS: Readonly<Record<SortColumn, WebMessageKey>> = {
  name: 'web.portfolio.column.entity',
  currentPeriod: 'web.portfolio.column.current_period',
  endedOpenPeriods: 'web.portfolio.column.ended_open_periods',
  pendingDrafts: 'web.portfolio.column.pending_drafts',
  pendingQuestions: 'web.portfolio.column.pending_questions',
};

const FAILURE_KEYS: Readonly<Record<Failure, WebMessageKey>> = {
  'signed-out': 'web.session.signed_out',
  'session-expired': 'web.error.session_expired',
  'no-access': 'web.session.no_access',
  unavailable: 'web.error.upstream_unavailable',
  unexpected: 'web.error.unexpected',
};

/** The id of the element that shows how old the read is, updated in place by a ticker. */
export const AGE_ELEMENT_ID = 'portfolio-age';

/** The API's draft list is capped at this many, newest first. */
export const DRAFT_LIST_LIMIT = 100;

function el(tag: ViewTag, attributes: Record<string, string>, children?: string | readonly ElementSpec[]): ElementSpec {
  return children === undefined ? { tag, attributes } : { tag, attributes, children };
}

/** HH:MM in the viewer's clock. */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export function periodStatusText(language: WebLanguage, status: string): string {
  const key = PERIOD_STATUS_KEYS[status];
  // A status this table does not know is shown as the API wrote it.
  return key === undefined ? status : text(language, key);
}

function signInNotice(language: WebLanguage, key: WebMessageKey, role: 'status' | 'alert'): ElementSpec {
  return el('div', { class: 'notice', role }, [
    el('p', {}, text(language, key)),
    el('p', {}, [el('a', { href: SIGN_IN_PATH }, text(language, 'web.session.sign_in'))]),
  ]);
}

/** The notice for a failure that leaves nothing to show. */
function failureNotice(language: WebLanguage, reason: Failure): ElementSpec {
  switch (reason) {
    case 'signed-out':
      return signInNotice(language, FAILURE_KEYS[reason], 'status');
    case 'session-expired':
      return signInNotice(language, FAILURE_KEYS[reason], 'alert');
    case 'no-access':
      return el('p', { class: 'notice', role: 'status' }, text(language, FAILURE_KEYS[reason]));
    default:
      return el('p', { class: 'notice notice-error', role: 'alert' }, text(language, FAILURE_KEYS[reason]));
  }
}

/** A failure that ends what the page may show: the session is gone or the account cannot read. */
function endsTheSession(reason: Failure): boolean {
  return reason === 'signed-out' || reason === 'session-expired' || reason === 'no-access';
}

function header(language: WebLanguage, screen: Screen, now: number): ElementSpec {
  const children: ElementSpec[] = [el('h1', {}, text(language, 'web.app.title'))];
  const details: ElementSpec[] = [];
  if (screen.kind === 'portfolio' && screen.loaded) {
    const { portfolio, fetchedAt } = screen.loaded;
    details.push(el('p', {}, text(language, 'web.portfolio.as_of', { date: portfolio.meta.asOfDate })));
    details.push(el('p', { id: AGE_ELEMENT_ID }, ageText(language, fetchedAt, now)));
  }
  if (details.length > 0) children.push(el('div', { class: 'board-meta' }, details));

  const failure = screen.kind === 'portfolio' ? screen.failure?.reason : screen.kind === 'entity' ? screen.failure : undefined;
  const signedIn = failure !== 'signed-out' && failure !== 'session-expired' && screen.kind !== 'signin-failed';
  const buttons: ElementSpec[] = [];
  if (screen.kind === 'portfolio' && signedIn) {
    buttons.push({
      tag: 'button',
      attributes: { type: 'button', id: 'refresh', class: 'button' },
      children: text(language, 'web.portfolio.refresh'),
      action: { kind: 'refresh' },
    });
  }
  if (signedIn) {
    buttons.push({
      tag: 'button',
      attributes: { type: 'button', id: 'sign-out', class: 'button button-quiet' },
      children: text(language, 'web.session.sign_out'),
      action: { kind: 'sign-out' },
    });
  }
  if (buttons.length > 0) children.push(el('div', { class: 'board-actions' }, buttons));
  return el('header', { class: 'board-header' }, children);
}

function toneClass(tone: Tone): string {
  return `tone tone-${tone}`;
}

function countCell(count: number): ElementSpec {
  // The number is the cell's text: the tone only restates it.
  return el('td', { class: `count ${toneClass(toneOfCount(count))}` }, String(count));
}

function periodCell(language: WebLanguage, row: PortfolioRow): ElementSpec {
  const period = row.currentPeriod;
  if (period === null) {
    return el('td', { class: toneClass('neutral') }, text(language, 'web.portfolio.no_calendar'));
  }
  return el(
    'td',
    { class: toneClass(toneOfPeriodStatus(period.status)) },
    `${period.name} · ${periodStatusText(language, period.status)}`
  );
}

function entityHeaderCell(language: WebLanguage, row: PortfolioRow): ElementSpec {
  const children: ElementSpec[] = [el('a', { href: entityHref(row.entityId) }, row.name)];
  if (!row.isActive) children.push(el('span', { class: 'tag' }, text(language, 'web.portfolio.inactive')));
  return el('th', { scope: 'row' }, children);
}

function sortHeader(language: WebLanguage, column: SortColumn, sort: SortOrder): ElementSpec {
  const attributes: Record<string, string> = { scope: 'col' };
  if (sort.column === column) attributes['aria-sort'] = sort.direction;
  if (column !== 'name' && column !== 'currentPeriod') attributes.class = 'count';
  return el('th', attributes, [
    {
      tag: 'button',
      attributes: { type: 'button', id: `sort-${column}`, class: 'sort' },
      children: text(language, COLUMN_KEYS[column]),
      action: { kind: 'sort', column },
    },
  ]);
}

function portfolioTable(language: WebLanguage, portfolio: Portfolio, sort: SortOrder): ElementSpec {
  const captionId = 'portfolio-caption';
  const rows = sortRows(portfolio.rows, sort).map((row) =>
    el('tr', {}, [
      entityHeaderCell(language, row),
      periodCell(language, row),
      countCell(row.endedOpenPeriods),
      countCell(row.pendingDrafts),
      countCell(row.pendingQuestions),
    ])
  );
  return el('div', { class: 'table-region', role: 'region', 'aria-labelledby': captionId, tabindex: '0' }, [
    el('table', { class: 'board-table' }, [
      el('caption', { id: captionId }, text(language, 'web.portfolio.caption')),
      el('thead', {}, [el('tr', {}, SORT_COLUMNS.map((column) => sortHeader(language, column, sort)))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

function legend(language: WebLanguage): ElementSpec {
  const entries: Array<[Tone, WebMessageKey]> = [
    ['info', 'web.portfolio.legend.info'],
    ['balanced', 'web.portfolio.legend.balanced'],
    ['pending', 'web.portfolio.legend.pending'],
    ['neutral', 'web.portfolio.legend.neutral'],
  ];
  return el('section', { class: 'legend', 'aria-labelledby': 'legend-heading' }, [
    el('h3', { id: 'legend-heading' }, text(language, 'web.portfolio.legend.title')),
    el(
      'ul',
      {},
      entries.map(([tone, key]) =>
        el('li', {}, [el('span', { class: `swatch ${toneClass(tone)}`, 'aria-hidden': 'true' }), el('span', {}, text(language, key))])
      )
    ),
  ]);
}

function portfolioContent(language: WebLanguage, screen: PortfolioScreen): ElementSpec[] {
  const content: ElementSpec[] = [el('h2', { id: 'portfolio-heading' }, text(language, 'web.portfolio.title'))];
  const { loaded, failure } = screen;

  if (failure && endsTheSession(failure.reason)) {
    content.push(failureNotice(language, failure.reason));
    return content;
  }
  if (!loaded) {
    content.push(
      failure
        ? failureNotice(language, failure.reason)
        : el('p', { class: 'notice', role: 'status' }, text(language, 'web.portfolio.loading'))
    );
    return content;
  }

  if (failure) {
    // A failed refresh keeps the last good rows and says they are stale.
    content.push(
      el('div', { class: 'notice notice-stale', role: 'alert' }, [
        el('p', {}, text(language, 'web.portfolio.stale', { time: clockTime(failure.at) })),
        el('p', {}, text(language, FAILURE_KEYS[failure.reason])),
      ])
    );
  } else if (screen.loading) {
    content.push(el('p', { class: 'notice', role: 'status' }, text(language, 'web.portfolio.loading')));
  }

  const { portfolio } = loaded;
  if (portfolio.meta.unresolved > 0) {
    content.push(el('p', { class: 'notice' }, text(language, 'web.portfolio.omitted', { count: portfolio.meta.unresolved })));
  }
  if (portfolio.rows.length === 0) {
    content.push(el('p', { class: 'notice', role: 'alert' }, text(language, 'web.portfolio.empty')));
  } else {
    content.push(portfolioTable(language, portfolio, screen.sort));
  }
  if (portfolio.meta.notEvaluated.includes('close_readiness')) {
    content.push(el('p', { class: 'not-evaluated' }, text(language, 'web.portfolio.not_evaluated')));
  }
  content.push(legend(language));
  return content;
}

function listTable(
  language: WebLanguage,
  id: string,
  captionKey: WebMessageKey,
  columns: readonly WebMessageKey[],
  rows: ReadonlyArray<readonly string[]>
): ElementSpec {
  const captionId = `${id}-caption`;
  if (rows.length === 0) {
    return el('section', { 'aria-labelledby': captionId }, [
      el('h3', { id: captionId }, text(language, captionKey)),
      el('p', {}, text(language, 'web.entity.none')),
    ]);
  }
  return el('div', { class: 'table-region', role: 'region', 'aria-labelledby': captionId, tabindex: '0' }, [
    el('table', { class: 'board-table', id }, [
      el('caption', { id: captionId }, text(language, captionKey)),
      el('thead', {}, [el('tr', {}, columns.map((key) => el('th', { scope: 'col' }, text(language, key))))]),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((cell) => el('td', {}, cell))))),
    ]),
  ]);
}

function entityContent(language: WebLanguage, screen: EntityScreen): ElementSpec[] {
  const content: ElementSpec[] = [
    el('nav', {}, [el('a', { href: '#/' }, text(language, 'web.entity.back'))]),
    el('h2', { id: 'entity-heading' }, screen.entityName ?? screen.entityId),
  ];
  if (screen.failure) {
    content.push(failureNotice(language, screen.failure));
    if (endsTheSession(screen.failure) || !screen.loaded) return content;
  }
  if (!screen.loaded) {
    content.push(el('p', { class: 'notice', role: 'status' }, text(language, 'web.entity.loading')));
    return content;
  }

  const { drafts, questions, periods } = screen.loaded;
  content.push(
    listTable(
      language,
      'entity-drafts',
      'web.entity.drafts',
      ['web.entity.column.date', 'web.entity.column.description', 'web.entity.column.confidence'],
      drafts.map((d) => [d.entryDate, d.description, d.confidence])
    )
  );
  if (drafts.length >= DRAFT_LIST_LIMIT) {
    content.push(el('p', { class: 'notice' }, text(language, 'web.entity.drafts_limit')));
  }
  content.push(
    listTable(
      language,
      'entity-questions',
      'web.entity.questions',
      ['web.entity.column.date', 'web.entity.column.question', 'web.entity.column.topic'],
      questions.map((q) => [q.createdAt, q.question, q.topic])
    ),
    listTable(
      language,
      'entity-periods',
      'web.entity.periods',
      ['web.entity.column.period', 'web.entity.column.status', 'web.entity.column.start', 'web.entity.column.end'],
      periods.map((p) => [p.name, periodStatusText(language, p.status), p.startDate, p.endDate])
    ),
    el('p', { class: 'not-evaluated' }, text(language, 'web.portfolio.not_evaluated')),
    el('section', { class: 'verify', 'aria-labelledby': 'verify-heading' }, [
      el('h3', { id: 'verify-heading' }, text(language, 'web.entity.verify')),
      el(
        'ul',
        {},
        VERIFY_COMMANDS.map((command) => el('li', {}, [el('code', {}, command.replace('{entity}', screen.entityId))]))
      ),
    ])
  );
  return content;
}

function noticeContent(language: WebLanguage, screen: NoticeScreen): ElementSpec[] {
  if (screen.kind === 'signin-failed') {
    return [signInNotice(language, 'web.session.signin_failed', 'alert')];
  }
  return [
    el('p', { class: 'notice notice-error', role: 'alert' }, text(language, 'web.app.not_found')),
    el('nav', {}, [el('a', { href: '#/' }, text(language, 'web.entity.back'))]),
  ];
}

/** The children of the page's main element for `screen`, in `language`, at `now`. */
export function renderScreen(screen: Screen, language: WebLanguage, now: number): ElementSpec[] {
  const content =
    screen.kind === 'portfolio'
      ? portfolioContent(language, screen)
      : screen.kind === 'entity'
        ? entityContent(language, screen)
        : noticeContent(language, screen);
  return [header(language, screen, now), el('div', { class: 'board-content' }, content)];
}

/** The text of the age line for a read at `fetchedAt`, as the ticker rewrites it. */
export function ageText(language: WebLanguage, fetchedAt: number, now: number): string {
  return text(language, 'web.portfolio.fetched', { time: clockTime(fetchedAt), minutes: ageInMinutes(fetchedAt, now) });
}
