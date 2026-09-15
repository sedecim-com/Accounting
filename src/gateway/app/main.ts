import { apiGet, signOut, type ApiResult } from './api.js';
import { mount, skipWithoutNavigating } from './dom.js';
import { parseDraftList, parsePeriodList, parseQuestionList } from './entity-model.js';
import { pickLanguage, text } from './messages.js';
import { parsePortfolioResponse, type SortColumn } from './portfolio-model.js';
import {
  AGE_ELEMENT_ID,
  ageText,
  parseRoute,
  renderScreen,
  signOutDestination,
  type Failure,
  type PageState,
  type Route,
  type Screen,
  type ViewAction,
} from './view.js';

// ============================================================
// THE BOARD'S BOOT (W1 · issue #117)
//
// Picks the language, runs the hash router, reads through api.ts and hands
// every screen to view.ts and dom.ts. It holds the page's state and nothing
// else decides anything here:
//
//   · Refresh is manual. A 30-second ticker only rewrites the "read N min
//     ago" line in place, so focus and the screen reader's position survive.
//   · A failed refresh keeps the previous rows and marks them stale; it never
//     blanks figures someone is reading.
//   · After a re-render, focus goes back to the control that had it (a sort
//     button keeps focus after sorting), and a route change moves focus to the
//     main element, so a screen reader starts at the new screen.
//   · The skip link focuses the main element without touching the URL, and a
//     sign-out the gateway did not confirm stays on the page and says so.
// ============================================================

const language = pickLanguage(navigator.languages.length > 0 ? navigator.languages : [navigator.language]);
document.documentElement.lang = language;
document.title = text(language, 'web.app.title');

const skipLink = document.getElementById('skip-link');
if (skipLink) skipLink.textContent = text(language, 'web.app.skip_to_content');

const root = document.getElementById('app');
if (skipLink && root) skipWithoutNavigating(skipLink, root);

let screen: Screen = { kind: 'portfolio', loading: true, sort: { column: 'name', direction: 'ascending' } };
/** The portfolio screen as last left, so returning from an entity does not re-read it. */
let lastPortfolio: Screen | undefined;
/** Discards answers to reads the user has already navigated away from. */
let generation = 0;
/** Cleared by the next sign-out attempt or navigation. */
let page: PageState = {};

function failureOf(result: Exclude<ApiResult, { kind: 'ok' }>): Failure {
  switch (result.kind) {
    case 'signed-out':
      return 'signed-out';
    case 'session-expired':
      return 'session-expired';
    case 'forbidden':
      return 'no-access';
    case 'unavailable':
      return 'unavailable';
    case 'failed':
      return 'unexpected';
  }
}

function render(moveFocus = false): void {
  if (!root) return;
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  mount(renderScreen(screen, language, Date.now(), page), root, document, onAction);
  if (moveFocus) {
    root.focus();
    return;
  }
  if (focusedId !== '') document.getElementById(focusedId)?.focus();
}

async function loadPortfolio(): Promise<void> {
  if (screen.kind !== 'portfolio') return;
  const mine = ++generation;
  screen = { ...screen, loading: true };
  render();
  const result = await apiGet('portfolio');
  if (mine !== generation || screen.kind !== 'portfolio') return;
  const portfolio = result.kind === 'ok' ? parsePortfolioResponse(result.body) : undefined;
  if (portfolio) {
    screen = { ...screen, loading: false, loaded: { portfolio, fetchedAt: Date.now() }, failure: undefined };
  } else {
    const reason = result.kind === 'ok' ? 'unexpected' : failureOf(result);
    screen = { ...screen, loading: false, failure: { reason, at: Date.now() } };
  }
  lastPortfolio = screen;
  render();
}

async function loadEntity(entityId: string): Promise<void> {
  const mine = ++generation;
  const [drafts, questions, periods] = await Promise.all([
    apiGet('drafts', { entityId, status: 'pending_review' }),
    apiGet('questions', { entityId, status: 'pending' }),
    apiGet('periods', { entityId }),
  ]);
  if (mine !== generation || screen.kind !== 'entity' || screen.entityId !== entityId) return;
  const failed = [drafts, questions, periods].find((r): r is Exclude<ApiResult, { kind: 'ok' }> => r.kind !== 'ok');
  if (failed) {
    screen = { ...screen, loading: false, failure: failureOf(failed) };
  } else {
    const loaded = {
      drafts: drafts.kind === 'ok' ? parseDraftList(drafts.body) : undefined,
      questions: questions.kind === 'ok' ? parseQuestionList(questions.body) : undefined,
      periods: periods.kind === 'ok' ? parsePeriodList(periods.body) : undefined,
    };
    screen =
      loaded.drafts && loaded.questions && loaded.periods
        ? { ...screen, loading: false, loaded: { drafts: loaded.drafts, questions: loaded.questions, periods: loaded.periods } }
        : { ...screen, loading: false, failure: 'unexpected' };
  }
  render();
}

function entityNameFor(entityId: string): string | undefined {
  if (lastPortfolio?.kind !== 'portfolio') return undefined;
  return lastPortfolio.loaded?.portfolio.rows.find((row) => row.entityId === entityId)?.name;
}

/** Shows `route`. A navigation moves focus to the main element; the first screen of a page load does not. */
function show(route: Route, moveFocus = true): void {
  page = {};
  if (route.kind === 'portfolio') {
    if (lastPortfolio?.kind === 'portfolio' && lastPortfolio.loaded) {
      screen = lastPortfolio;
      render(moveFocus);
      return;
    }
    screen = { kind: 'portfolio', loading: true, sort: { column: 'name', direction: 'ascending' } };
    render(moveFocus);
    void loadPortfolio();
    return;
  }
  generation += 1;
  if (route.kind === 'entity') {
    screen = { kind: 'entity', entityId: route.entityId, entityName: entityNameFor(route.entityId), loading: true };
    render(moveFocus);
    void loadEntity(route.entityId);
    return;
  }
  screen = { kind: route.kind };
  render(moveFocus);
}

function sortBy(column: SortColumn): void {
  if (screen.kind !== 'portfolio') return;
  const direction = screen.sort.column === column && screen.sort.direction === 'ascending' ? 'descending' : 'ascending';
  screen = { ...screen, sort: { column, direction } };
  lastPortfolio = screen;
  render();
}

async function endSession(): Promise<void> {
  if (page.signOutFailed) {
    page = {};
    render();
  }
  const target = signOutDestination(await signOut(), window.location.origin);
  if (target === undefined) {
    page = { signOutFailed: true };
    render();
    return;
  }
  window.location.assign(target);
}

function onAction(action: ViewAction): void {
  switch (action.kind) {
    case 'sort':
      sortBy(action.column);
      return;
    case 'refresh':
      void loadPortfolio();
      return;
    case 'sign-out':
      void endSession();
      return;
  }
}

window.addEventListener('hashchange', () => {
  const route = parseRoute(window.location.hash);
  if (route) show(route);
});

setInterval(() => {
  if (screen.kind !== 'portfolio' || !screen.loaded) return;
  const age = document.getElementById(AGE_ELEMENT_ID);
  if (age) age.textContent = ageText(language, screen.loaded.fetchedAt, Date.now());
}, 30_000);

show(parseRoute(window.location.hash) ?? { kind: 'portfolio' }, false);
