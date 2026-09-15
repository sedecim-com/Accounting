import type { ApiOperation, ApiResult, GetRequestOptions } from './contract.js';
import { parseDraftList, parsePeriodList, parseQuestionList } from './entity-model.js';
import { parsePortfolioResponse, type SortColumn } from './portfolio-model.js';
import {
  signOutDestination,
  type EntityScreen,
  type Failure,
  type NoticeScreen,
  type PageState,
  type PortfolioScreen,
  type Route,
  type Screen,
  type ViewAction,
} from './view.js';

// ============================================================
// THE BOARD'S STATE (W1 · issue #117)
//
// What the page holds between a click and an answer: the portfolio as last
// read and sorted, the screen the user is on, and which reads are still worth
// applying. main.ts wires this to the document; everything here is DOM-free,
// and tests/gateway/web-board.spec.ts drives it with reads it answers by hand.
//
//   · The portfolio is one piece of state, kept while an entity or a notice is
//     on screen. A portfolio read that answers while the user is away still
//     lands in it, so Back shows the answer (new rows, or the stale banner of a
//     failed refresh) and never a loading state no read will ever end. It used
//     to be a copy cached at sort time, loading flag included, while the
//     navigation discarded the read that would have cleared it.
//   · A portfolio read is superseded only by a newer portfolio read; an entity
//     read, by any navigation.
//   · A failed refresh keeps the previous rows and marks them stale; it never
//     blanks figures someone is reading.
//   · A sign-out the gateway did not confirm stays on the page and says so.
// ============================================================

export type FailedRead = Exclude<ApiResult, { kind: 'ok' }>;

export interface BoardDeps {
  read(operation: ApiOperation, options?: GetRequestOptions): Promise<ApiResult>;
  /** Ends the session at the gateway; the destination it confirmed, or undefined. */
  signOut(): Promise<string | undefined>;
  /** Leaves the page for a confirmed sign-out destination. */
  leave(destination: string): void;
  origin: string;
  now(): number;
  /** Draws `screen`. moveFocus is true for a navigation, so focus goes to the main element. */
  render(screen: Screen, page: PageState, moveFocus: boolean): void;
}

export interface Board {
  /** Shows `route`. Resolves when the reads it started have been applied or discarded. */
  show(route: Route, moveFocus?: boolean): Promise<void>;
  act(action: ViewAction): Promise<void>;
  current(): Screen;
}

/**
 * What the screen says about a read that produced no data.
 *
 * The API refuses with 403 FORBIDDEN in two places. authenticate refuses an
 * x-entity-id the token does not grant, before any permission is checked, and
 * says nothing more; requirePermission lists what is missing in
 * details.missing. The portfolio sends no x-entity-id, so its 403 is always
 * about permissions. On an entity read, a 403 that names no missing permission
 * is the entity, not the account.
 */
export function failureOf(result: FailedRead, read: 'portfolio' | 'entity'): Failure {
  switch (result.kind) {
    case 'signed-out':
      return 'signed-out';
    case 'session-expired':
      return 'session-expired';
    case 'forbidden':
      return read === 'entity' && !result.missingPermissions ? 'entity-not-granted' : 'no-access';
    case 'unavailable':
      return 'unavailable';
    case 'failed':
      return 'unexpected';
  }
}

export function createBoard(deps: BoardDeps): Board {
  let portfolio: PortfolioScreen = { kind: 'portfolio', loading: false, sort: { column: 'name', direction: 'ascending' } };
  /** The screen shown instead of the portfolio, if any. */
  let away: EntityScreen | NoticeScreen | undefined;
  /** Discards a portfolio answer once a newer portfolio read has started. */
  let portfolioRead = 0;
  /** Discards an entity answer once the user has navigated again. */
  let navigation = 0;
  /** Cleared by the next sign-out attempt or navigation. */
  let page: PageState = {};

  const current = (): Screen => away ?? portfolio;
  const render = (moveFocus = false): void => deps.render(current(), page, moveFocus);

  async function loadPortfolio(): Promise<void> {
    const mine = ++portfolioRead;
    portfolio = { ...portfolio, loading: true };
    if (away === undefined) render();
    const result = await deps.read('portfolio');
    if (mine !== portfolioRead) return;
    const read = result.kind === 'ok' ? parsePortfolioResponse(result.body) : undefined;
    if (read) {
      portfolio = { ...portfolio, loading: false, loaded: { portfolio: read, fetchedAt: deps.now() }, failure: undefined };
    } else {
      const reason = result.kind === 'ok' ? 'unexpected' : failureOf(result, 'portfolio');
      portfolio = { ...portfolio, loading: false, failure: { reason, at: deps.now() } };
    }
    // Applied whether or not the portfolio is on screen; drawn only if it is.
    if (away === undefined) render();
  }

  async function loadEntity(entityId: string): Promise<void> {
    const mine = navigation;
    const [drafts, questions, periods] = await Promise.all([
      deps.read('drafts', { entityId, status: 'pending_review' }),
      deps.read('questions', { entityId, status: 'pending' }),
      deps.read('periods', { entityId }),
    ]);
    if (mine !== navigation || away?.kind !== 'entity' || away.entityId !== entityId) return;
    const failed = [drafts, questions, periods].find((r): r is FailedRead => r.kind !== 'ok');
    if (failed) {
      away = { ...away, loading: false, failure: failureOf(failed, 'entity') };
    } else {
      const loaded = {
        drafts: drafts.kind === 'ok' ? parseDraftList(drafts.body) : undefined,
        questions: questions.kind === 'ok' ? parseQuestionList(questions.body) : undefined,
        periods: periods.kind === 'ok' ? parsePeriodList(periods.body) : undefined,
      };
      away =
        loaded.drafts && loaded.questions && loaded.periods
          ? { ...away, loading: false, loaded: { drafts: loaded.drafts, questions: loaded.questions, periods: loaded.periods } }
          : { ...away, loading: false, failure: 'unexpected' };
    }
    render();
  }

  function entityNameFor(entityId: string): string | undefined {
    return portfolio.loaded?.portfolio.rows.find((row) => row.entityId === entityId)?.name;
  }

  function show(route: Route, moveFocus = true): Promise<void> {
    page = {};
    navigation += 1;
    if (route.kind === 'portfolio') {
      away = undefined;
      render(moveFocus);
      // Nothing read yet, or only a failure: read. A read still open answers on its own.
      return portfolio.loaded || portfolio.loading ? Promise.resolve() : loadPortfolio();
    }
    if (route.kind === 'entity') {
      away = { kind: 'entity', entityId: route.entityId, entityName: entityNameFor(route.entityId), loading: true };
      render(moveFocus);
      return loadEntity(route.entityId);
    }
    away = { kind: route.kind };
    render(moveFocus);
    return Promise.resolve();
  }

  function sortBy(column: SortColumn): void {
    if (away !== undefined) return;
    const direction = portfolio.sort.column === column && portfolio.sort.direction === 'ascending' ? 'descending' : 'ascending';
    portfolio = { ...portfolio, sort: { column, direction } };
    render();
  }

  async function endSession(): Promise<void> {
    if (page.signOutFailed) {
      page = {};
      render();
    }
    const target = signOutDestination(await deps.signOut(), deps.origin);
    if (target === undefined) {
      page = { signOutFailed: true };
      render();
      return;
    }
    deps.leave(target);
  }

  function act(action: ViewAction): Promise<void> {
    switch (action.kind) {
      case 'sort':
        sortBy(action.column);
        return Promise.resolve();
      case 'refresh':
        return away === undefined ? loadPortfolio() : Promise.resolve();
      case 'sign-out':
        return endSession();
    }
  }

  return { show, act, current };
}
