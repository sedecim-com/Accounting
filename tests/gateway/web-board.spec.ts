import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPermissions, authenticate } from '../../src/api/rest/middleware/auth.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import { config } from '../../src/config/index.js';
import { createBoard, failureOf, type Board, type FailedRead } from '../../src/gateway/app/board.js';
import { errorCodeOf, namesMissingPermissions, type ApiOperation, type ApiResult, type GetRequestOptions } from '../../src/gateway/app/contract.js';
import { text } from '../../src/gateway/app/messages.js';
import { renderScreen, type ElementSpec, type EntityScreen, type PortfolioScreen, type Screen } from '../../src/gateway/app/view.js';
import { ForbiddenError } from '../../src/utils/errors.js';

// ============================================================
// W1 · the board's state, driven with reads the spec answers by hand.
//
// main.ts only wires the page to board.ts, so what happens between a click and
// an answer is decided here, without a document: the spec holds every read
// open, answers it when the scenario says so, and reads the screen the board
// would draw. The two 403 bodies are the ones the real authenticate,
// assertPermissions and errorHandler write, read with the browser's reader.
// ============================================================

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 8, 15, 18, 30);

interface OpenRead {
  operation: ApiOperation;
  options?: GetRequestOptions;
  answer(result: ApiResult): void;
}

function portfolioBody(pendingDraftsOfB: number): unknown {
  const row = (entityId: string, name: string, pendingDrafts: number) => ({
    entity_id: entityId,
    name,
    is_active: true,
    current_period: null,
    ended_open_periods: 0,
    pending_drafts: pendingDrafts,
    pending_questions: 0,
  });
  return {
    data: [row(A, 'Abarrotes La Esperanza', 3), row(B, 'Birria Don Chuy', pendingDraftsOfB)],
    meta: { as_of_date: '2026-09-15', omitted: { unresolved: 0 }, not_evaluated: ['close_readiness'] },
  };
}

const EMPTY_LIST: ApiResult = { kind: 'ok', body: { data: [] } };

function boardUnderTest(): { board: Board; open: OpenRead[]; drawn: Screen[] } {
  const open: OpenRead[] = [];
  const drawn: Screen[] = [];
  const board = createBoard({
    read: (operation, options) =>
      new Promise<ApiResult>((resolve) => {
        open.push({ operation, options, answer: resolve });
      }),
    signOut: () => Promise.resolve(undefined),
    leave: () => undefined,
    origin: 'https://board.example',
    now: () => NOW,
    render: (screen) => {
      drawn.push(screen);
    },
  });
  return { board, open, drawn };
}

/** Answers the one open read of `operation` and removes it from the list. */
function answer(open: OpenRead[], operation: ApiOperation, result: ApiResult): void {
  const index = open.findIndex((read) => read.operation === operation);
  expect(index, `no open ${operation} read`).toBeGreaterThanOrEqual(0);
  const [read] = open.splice(index, 1);
  read.answer(result);
}

function textsOf(screen: Screen): string[] {
  const all = (specs: readonly ElementSpec[]): ElementSpec[] =>
    specs.flatMap((spec) => [spec, ...(Array.isArray(spec.children) ? all(spec.children as ElementSpec[]) : [])]);
  return all(renderScreen(screen, 'es', NOW)).flatMap((spec) => (typeof spec.children === 'string' ? [spec.children] : []));
}

function asPortfolio(screen: Screen): PortfolioScreen {
  expect(screen.kind).toBe('portfolio');
  return screen as PortfolioScreen;
}

/** A board showing a read portfolio, then a refresh still open, sorted by drafts, then an entity opened and read. */
async function sortedDuringRefreshThenEntity(): Promise<{ board: Board; open: OpenRead[]; drawn: Screen[]; refresh: Promise<void> }> {
  const { board, open, drawn } = boardUnderTest();
  const first = board.show({ kind: 'portfolio' }, false);
  answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
  await first;

  const refresh = board.act({ kind: 'refresh' });
  expect(asPortfolio(board.current()).loading).toBe(true);
  await board.act({ kind: 'sort', column: 'pendingDrafts' });

  const entity = board.show({ kind: 'entity', entityId: A });
  answer(open, 'drafts', EMPTY_LIST);
  answer(open, 'questions', EMPTY_LIST);
  answer(open, 'periods', EMPTY_LIST);
  await entity;
  expect(board.current()).toMatchObject({ kind: 'entity', entityId: A, loading: false });
  return { board, open, drawn, refresh };
}

describe('a refresh outlives a visit to an entity', () => {
  it('answered while the entity is open, it is what Back shows: not loading, sorted as left, stale when it failed', async () => {
    const { board, open, refresh } = await sortedDuringRefreshThenEntity();
    answer(open, 'portfolio', { kind: 'unavailable' });
    await refresh;

    await board.show({ kind: 'portfolio' });
    const back = asPortfolio(board.current());
    expect(back.loading).toBe(false);
    expect(back.sort).toEqual({ column: 'pendingDrafts', direction: 'ascending' });
    expect(back.failure?.reason).toBe('unavailable');
    expect(back.loaded?.portfolio.rows).toHaveLength(2);
    const texts = textsOf(back);
    expect(texts).not.toContain(text('es', 'web.portfolio.loading'));
    expect(texts.some((t) => t.startsWith('La actualización de las'))).toBe(true);
    // Back reads nothing again: the refresh already answered.
    expect(open).toEqual([]);
  });

  it('answered with new rows while the entity is open, Back shows them', async () => {
    const { board, open, refresh } = await sortedDuringRefreshThenEntity();
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(7) });
    await refresh;

    await board.show({ kind: 'portfolio' });
    const back = asPortfolio(board.current());
    expect(back.loading).toBe(false);
    expect(back.failure).toBeUndefined();
    expect(back.loaded?.portfolio.rows.map((row) => row.pendingDrafts)).toEqual([3, 7]);
    expect(back.sort.column).toBe('pendingDrafts');
  });

  it('still open when Back is pressed, it shows loading over the old rows and then draws its answer', async () => {
    const { board, open, drawn, refresh } = await sortedDuringRefreshThenEntity();
    await board.show({ kind: 'portfolio' });
    expect(asPortfolio(board.current()).loading).toBe(true);
    expect(open.map((read) => read.operation)).toEqual(['portfolio']);

    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(7) });
    await refresh;
    const settled = asPortfolio(board.current());
    expect(settled.loading).toBe(false);
    expect(settled.sort.column).toBe('pendingDrafts');
    expect(settled.loaded?.portfolio.rows.map((row) => row.pendingDrafts)).toEqual([3, 7]);
    expect(drawn.at(-1)).toBe(settled);
  });

  it('an answer that lands while away draws nothing until Back', async () => {
    const { board, open, drawn, refresh } = await sortedDuringRefreshThenEntity();
    const before = drawn.length;
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(7) });
    await refresh;
    expect(drawn.length).toBe(before);
    expect(board.current().kind).toBe('entity');
  });

  it('an entity opened first reads the portfolio on the way back, once', async () => {
    const { board, open } = boardUnderTest();
    const entity = board.show({ kind: 'entity', entityId: A }, false);
    for (const operation of ['drafts', 'questions', 'periods'] as const) answer(open, operation, EMPTY_LIST);
    await entity;
    const back = board.show({ kind: 'portfolio' });
    expect(open.map((read) => read.operation)).toEqual(['portfolio']);
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
    await back;
    expect(asPortfolio(board.current())).toMatchObject({ loading: false, failure: undefined });
  });

  it('a first read still open when Back is pressed is not issued twice, and its answer draws', async () => {
    const { board, open } = boardUnderTest();
    const first = board.show({ kind: 'portfolio' }, false);
    const entity = board.show({ kind: 'entity', entityId: A });
    for (const operation of ['drafts', 'questions', 'periods'] as const) answer(open, operation, EMPTY_LIST);
    await entity;
    await board.show({ kind: 'portfolio' });
    expect(open.map((read) => read.operation)).toEqual(['portfolio']);
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
    await first;
    expect(asPortfolio(board.current())).toMatchObject({ loading: false, failure: undefined });
  });

  it('a first read that failed, then an entity, then Back: the new read says it is reading, not the old failure', async () => {
    const { board, open } = boardUnderTest();
    const first = board.show({ kind: 'portfolio' }, false);
    answer(open, 'portfolio', { kind: 'unavailable' });
    await first;
    expect(textsOf(board.current())).toContain(text('es', 'web.error.upstream_unavailable'));

    const entity = board.show({ kind: 'entity', entityId: A });
    for (const operation of ['drafts', 'questions', 'periods'] as const) answer(open, operation, EMPTY_LIST);
    await entity;

    const back = board.show({ kind: 'portfolio' });
    expect(open.map((read) => read.operation)).toEqual(['portfolio']);
    const reading = asPortfolio(board.current());
    expect(reading).toMatchObject({ loading: true, failure: undefined });
    expect(textsOf(reading)).toContain(text('es', 'web.portfolio.loading'));
    expect(textsOf(reading)).not.toContain(text('es', 'web.error.upstream_unavailable'));

    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
    await back;
    expect(asPortfolio(board.current())).toMatchObject({ loading: false, failure: undefined });
  });

  it('Refresh after a first read that failed says it is reading, not the old failure', async () => {
    const { board, open } = boardUnderTest();
    const first = board.show({ kind: 'portfolio' }, false);
    answer(open, 'portfolio', { kind: 'failed' });
    await first;

    const retry = board.act({ kind: 'refresh' });
    const reading = asPortfolio(board.current());
    expect(reading).toMatchObject({ loading: true, failure: undefined });
    expect(textsOf(reading)).toContain(text('es', 'web.portfolio.loading'));
    answer(open, 'portfolio', { kind: 'unavailable' });
    await retry;
    expect(asPortfolio(board.current()).failure?.reason).toBe('unavailable');
  });

  it('a refresh over rows that went stale keeps the stale banner while it reads', async () => {
    const { board, open } = boardUnderTest();
    const first = board.show({ kind: 'portfolio' }, false);
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
    await first;
    const failed = board.act({ kind: 'refresh' });
    answer(open, 'portfolio', { kind: 'unavailable' });
    await failed;

    const again = board.act({ kind: 'refresh' });
    const reading = asPortfolio(board.current());
    // The rows on screen are still the stale ones until this read answers.
    expect(reading.loading).toBe(true);
    expect(reading.failure?.reason).toBe('unavailable');
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(4) });
    await again;
    expect(asPortfolio(board.current()).failure).toBeUndefined();
  });

  it('a newer refresh wins over an older one that answers later', async () => {
    const { board, open } = boardUnderTest();
    const first = board.show({ kind: 'portfolio' }, false);
    answer(open, 'portfolio', { kind: 'ok', body: portfolioBody(1) });
    await first;
    const older = board.act({ kind: 'refresh' });
    const newer = board.act({ kind: 'refresh' });
    const [olderRead, newerRead] = open.splice(0, 2);
    newerRead.answer({ kind: 'ok', body: portfolioBody(9) });
    await newer;
    olderRead.answer({ kind: 'unavailable' });
    await older;
    const screen = asPortfolio(board.current());
    expect(screen.failure).toBeUndefined();
    expect(screen.loaded?.portfolio.rows.map((row) => row.pendingDrafts)).toEqual([3, 9]);
  });
});

describe('two 403s on the entity screen', () => {
  it('a 403 naming no missing permission is the entity the token does not grant; one that names them is the account', () => {
    expect(failureOf({ kind: 'forbidden', missingPermissions: false }, 'entity')).toBe('entity-not-granted');
    expect(failureOf({ kind: 'forbidden', missingPermissions: true }, 'entity')).toBe('no-access');
    // The portfolio sends no x-entity-id, so its 403 is always about permissions.
    expect(failureOf({ kind: 'forbidden', missingPermissions: false }, 'portfolio')).toBe('no-access');
    expect(failureOf({ kind: 'forbidden', missingPermissions: true }, 'portfolio')).toBe('no-access');
  });

  it('an entity the token does not grant says so, not that permissions are missing', async () => {
    const { board, open } = boardUnderTest();
    const entity = board.show({ kind: 'entity', entityId: A }, false);
    answer(open, 'drafts', { kind: 'forbidden', missingPermissions: false });
    answer(open, 'questions', { kind: 'forbidden', missingPermissions: false });
    answer(open, 'periods', { kind: 'forbidden', missingPermissions: false });
    await entity;
    const screen = board.current() as EntityScreen;
    expect(screen.failure).toBe('entity-not-granted');
    expect(textsOf(screen)).toContain(text('es', 'web.entity.not_granted'));
    expect(textsOf(screen)).not.toContain(text('es', 'web.session.no_access'));
  });

  it('a granted entity the account lacks a permission for keeps the permissions notice', async () => {
    const { board, open } = boardUnderTest();
    const entity = board.show({ kind: 'entity', entityId: A }, false);
    answer(open, 'drafts', { kind: 'forbidden', missingPermissions: true });
    answer(open, 'questions', EMPTY_LIST);
    answer(open, 'periods', EMPTY_LIST);
    await entity;
    expect((board.current() as EntityScreen).failure).toBe('no-access');
  });
});

describe("the API's two 403 bodies read apart", () => {
  /** The body the real errorHandler writes for `error`. */
  function bodyFor(error: unknown): unknown {
    let written: unknown;
    const res = {
      status: () => res,
      json: (body: unknown) => {
        written = body;
      },
    };
    errorHandler(error as Error, { headers: {} } as Request, res as unknown as Response, () => undefined);
    return written;
  }

  function tokenFor(entities: string[], permissions: string[]): string {
    return jwt.sign(
      { user_id: 'u-1', tenant_id: 't-1', email: 'x@example.test', roles: ['accountant'], permissions, entities, session_id: 's-1' },
      config.jwt.secret,
      { expiresIn: '5m' }
    );
  }

  /** What the API answers when x-entity-id names an entity the token does not grant. */
  async function entityRefusalBody(): Promise<unknown> {
    const req = { headers: { authorization: `Bearer ${tokenFor([A], ['accounts:read'])}`, 'x-entity-id': B } } as unknown as Request;
    const error = await new Promise<unknown>((resolve) => authenticate(req, {} as Response, (err?: unknown) => resolve(err)));
    expect(error).toBeInstanceOf(ForbiddenError);
    return bodyFor(error);
  }

  /** What the API answers when the account lacks a permission the route requires. */
  function permissionRefusalBody(): unknown {
    let error: unknown;
    try {
      assertPermissions({ permissions: ['accounts:read'] }, ['journal_entries:read']);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
    return bodyFor(error);
  }

  it("authenticate's refusal of an x-entity-id the token does not grant names no missing permission", async () => {
    const body = await entityRefusalBody();
    expect(errorCodeOf(body)).toBe('FORBIDDEN');
    expect(namesMissingPermissions(body)).toBe(false);
  });

  it("requirePermission's refusal of the account names what is missing", () => {
    const body = permissionRefusalBody();
    expect(errorCodeOf(body)).toBe('FORBIDDEN');
    expect(namesMissingPermissions(body)).toBe(true);
  });

  it('a body that is not the envelope, or an empty list, names no missing permission', () => {
    expect(namesMissingPermissions(undefined)).toBe(false);
    expect(namesMissingPermissions('nope')).toBe(false);
    expect(namesMissingPermissions({ errors: [{ code: 'CSRF_REJECTED' }] })).toBe(false);
    expect(namesMissingPermissions({ errors: [{ code: 'FORBIDDEN', details: { missing: [] } }] })).toBe(false);
    expect(namesMissingPermissions({ errors: [{ code: 'FORBIDDEN', details: { missing: 'journal_entries:read' } }] })).toBe(false);
  });

  describe('through the network client, as the board receives them', () => {
    // api.ts is loaded by a path the type checker does not follow. It belongs
    // to the DOM program (tsconfig.web.json); tsconfig.test.json has no DOM
    // lib, so a literal import would check its fetch init against Node's types
    // and fail on `cache`. What runs is the same module the browser loads.
    const CLIENT_MODULE = '../../src/gateway/app/api.js';
    type Client = { apiGet(operation: ApiOperation, options?: GetRequestOptions): Promise<ApiResult> };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Reads an entity's drafts through api.ts, with the gateway answering `status` and `body`. */
    async function entityReadAnswered(status: number, body: string): Promise<ApiResult> {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new globalThis.Response(body, { status, headers: { 'content-type': 'application/json' } }))
      );
      const { apiGet } = (await import(CLIENT_MODULE)) as Client;
      return apiGet('drafts', { entityId: B, status: 'pending_review' });
    }

    it('an entity the token does not grant reaches the board as that, not as missing permissions', async () => {
      const result = await entityReadAnswered(403, JSON.stringify(await entityRefusalBody()));
      expect(result).toEqual({ kind: 'forbidden', missingPermissions: false });
      expect(failureOf(result as FailedRead, 'entity')).toBe('entity-not-granted');
    });

    it('a permission the account lacks reaches the board as missing permissions', async () => {
      const result = await entityReadAnswered(403, JSON.stringify(permissionRefusalBody()));
      expect(result).toEqual({ kind: 'forbidden', missingPermissions: true });
      expect(failureOf(result as FailedRead, 'entity')).toBe('no-access');
    });

    it('a 403 whose body is not JSON names no missing permission', async () => {
      expect(await entityReadAnswered(403, '<html>Forbidden</html>')).toEqual({ kind: 'forbidden', missingPermissions: false });
    });
  });
});
