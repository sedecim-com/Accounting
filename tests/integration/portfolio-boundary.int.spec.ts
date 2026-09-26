import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { query, closeDatabase } from '../../src/database/connection.js';
import { config } from '../../src/config/index.js';
import { authenticate } from '../../src/api/rest/middleware/auth.js';
import { preAuthRateLimiter } from '../../src/api/rest/middleware/rate-limiter.js';
import { tenantContext } from '../../src/api/rest/middleware/tenant-context.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import portfolioRouter from '../../src/api/rest/routes/portfolio.js';
import { getPendingBoard } from '../../src/ai/pending-service.js';
import type { AgentContext } from '../../src/ai/context.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// W1 · THE PORTFOLIO BOUNDARY, AGAINST POSTGRES, THROUGH THE REAL AUTHENTICATE.
//
// The helper in ./helpers/servidor.ts replaces `authenticate` with a double,
// and that is exactly the piece this spec cannot replace: whether a header can
// widen or narrow the portfolio is decided between `authenticate` (which
// resolves x-entity-id against the token) and the route (which must ignore
// it). So the app here is the server's own chain for /v1 — authenticate,
// tenantContext, the router, errorHandler — spoken to over a socket with HS256
// tokens signed with the configured secret.
//
// It runs as SUPERUSER, with RLS inert on purpose, like
// frontera-entidad.int.spec.ts: the tenant arm is what RLS would cover, and a
// boundary that only holds while RLS is on is not proven by a test that has it
// on. What is proven here is the predicate inside the statement.
//
// The cast:
//   · A, the firm's first entity, and C, a second entity of the same tenant,
//     both granted;
//   · S, a sibling in the same tenant that the token does NOT grant;
//   · T, an entity of another tenant, which a token may still name because
//     accessible_entities has no foreign key.
// ============================================================

let a: Fixture;
let c: Fixture;
let sibling: Fixture;
let foreign: Fixture;
let siblingCurrentPeriodId: string;
let server: Server;
let baseUrl: string;

async function seedDrafts(f: Fixture, status: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await query(
      `INSERT INTO ai_drafts (id, tenant_id, entity_id, draft_type, status, payload,
         ai_confidence, ai_reasoning, ai_model)
       VALUES ($1, $2, $3, 'journal_entry', $4, '{"lines":[]}'::jsonb, 0.90, 'W1 portfolio seed', 'test-model')`,
      [randomUUID(), f.tenantId, f.entityId, status]
    );
  }
}

async function seedQuestions(f: Fixture, status: 'pending' | 'dismissed', count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await query(
      `INSERT INTO ai_questions (id, tenant_id, entity_id, status, question)
       VALUES ($1, $2, $3, $4, 'W1 portfolio seed question')`,
      [randomUUID(), f.tenantId, f.entityId, status]
    );
  }
}

beforeAll(async () => {
  a = await crearInquilino('W1 portfolio A');
  c = await crearEntidadHermana(a, 'W1 portfolio C');
  sibling = await crearEntidadHermana(a, 'W1 portfolio sibling');
  foreign = await crearInquilino('W1 portfolio foreign tenant');

  await seedDrafts(a, 'pending_review', 1);
  await seedDrafts(a, 'rejected', 2);
  await seedQuestions(a, 'pending', 1);
  await seedQuestions(a, 'dismissed', 1);
  await seedDrafts(c, 'pending_review', 2);
  await seedDrafts(sibling, 'pending_review', 3);
  await seedQuestions(sibling, 'pending', 2);
  await seedDrafts(foreign, 'pending_review', 4);
  await seedQuestions(foreign, 'pending', 2);

  // An overdue period that is soft_close, not open: the board does not count
  // it and neither may the portfolio.
  const oldYear = randomUUID();
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, 2020, '2020-01-01', '2020-12-31', true, 'open')`,
    [oldYear, a.entityId]
  );
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
       start_date, end_date, status)
     VALUES ($1, $2, $3, 1, 'Periodo 1/2020', '2020-01-01', '2020-01-31', 'soft_close')`,
    [randomUUID(), oldYear, a.entityId]
  );

  // A regular period of the sibling that starts today, the latest start a
  // started period can have: a current-period lookup that stops correlating
  // on the entity hands it to every row.
  siblingCurrentPeriodId = randomUUID();
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
       start_date, end_date, status)
     VALUES ($1, $2, $3, 13, 'W1 sibling current period', CURRENT_DATE, CURRENT_DATE, 'open')`,
    [siblingCurrentPeriodId, sibling.fiscalYearId, sibling.entityId]
  );

  // An open, regular period of A that starts tomorrow and ends in thirty days,
  // dated against the database clock. The fixture's periods sit in a fixed
  // year: once it is over all of them have started and ended, and a portfolio
  // that dropped its end_date or start_date check would still match the board
  // and the current-period query. This one is counted as ended, or shown as
  // current, only by such a portfolio, on any date.
  await query(
    `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
       start_date, end_date, status)
     VALUES ($1, $2, $3, 13, 'W1 portfolio A next period', CURRENT_DATE + 1, CURRENT_DATE + 30, 'open')`,
    [randomUUID(), a.fiscalYearId, a.entityId]
  );

  const app = express();
  // Before authenticate, as src/index.ts mounts it.
  app.use(preAuthRateLimiter);
  app.use(authenticate);
  app.use(tenantContext);
  app.use('/v1/portfolio', portfolioRouter);
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await closeDatabase();
});

function tokenFor(
  tenantId: string,
  entities: string[],
  permissions: string[] = ['accounts:read', 'journal_entries:read']
): string {
  return jwt.sign(
    {
      user_id: a.userId,
      tenant_id: tenantId,
      email: 'reader@example.test',
      roles: ['viewer'],
      permissions,
      entities,
      session_id: randomUUID(),
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

interface Row {
  entity_id: string;
  name: string;
  current_period: { id: string; status: string } | null;
  ended_open_periods: number;
  pending_drafts: number;
  pending_questions: number;
}

async function portfolio(
  token: string,
  headers: Record<string, string> = {},
  search = ''
): Promise<{ status: number; rows: Row[]; meta: Record<string, unknown>; raw: string }> {
  const r = await fetch(`${baseUrl}/v1/portfolio${search}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  const raw = await r.text();
  const body = raw ? (JSON.parse(raw) as { data?: Row[]; meta?: Record<string, unknown> }) : {};
  return { status: r.status, rows: body.data ?? [], meta: body.meta ?? {}, raw };
}

const countOf = async (table: string): Promise<number> => {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
};

describe('the portfolio is the token entities within the token tenant', () => {
  it('a sibling of the same tenant never appears and does not change the granted counts', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]));
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id).sort()).toEqual([a.entityId, c.entityId].sort());
    expect(r.raw).not.toContain(sibling.entityId);
    expect(r.raw).not.toContain('W1 portfolio sibling');

    const rowA = r.rows.find((x) => x.entity_id === a.entityId);
    const rowC = r.rows.find((x) => x.entity_id === c.entityId);
    expect(rowA?.pending_drafts).toBe(1);
    expect(rowA?.pending_questions).toBe(1);
    expect(rowC?.pending_drafts).toBe(2);
    expect(rowC?.pending_questions).toBe(0);
    expect(r.meta.omitted).toEqual({ unresolved: 0 });
    expect(r.meta.not_evaluated).toEqual(['close_readiness']);
    expect(r.meta.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an entity of another tenant named in the token is absent, and counted as unresolved', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, foreign.entityId]));
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id)).toEqual([a.entityId]);
    expect(r.raw).not.toContain(foreign.entityId);
    expect(r.raw).not.toContain('W1 portfolio foreign tenant');
    expect(r.meta.omitted).toEqual({ unresolved: 1 });
  });

  it('an unknown id is indistinguishable from a foreign one', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, randomUUID()]));
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id)).toEqual([a.entityId]);
    expect(r.meta.omitted).toEqual({ unresolved: 1 });
  });

  it('a granted x-entity-id neither narrows nor widens the set', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]), { 'x-entity-id': a.entityId });
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id).sort()).toEqual([a.entityId, c.entityId].sort());
  });

  it('an x-entity-id the token does not grant is a 403', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]), { 'x-entity-id': sibling.entityId });
    expect(r.status, r.raw).toBe(403);
    expect(r.raw).not.toContain('W1 portfolio sibling');
  });

  it('a query-string selector is a 422, even naming a granted entity', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]), {}, `?entity_id=${c.entityId}`);
    expect(r.status, r.raw).toBe(422);
  });

  it("the '*' permission does not widen the set", async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId], ['*']));
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id)).toEqual([a.entityId]);
  });

  it('a token of the other tenant naming our entities gets none of them', async () => {
    const r = await portfolio(tokenFor(foreign.tenantId, [foreign.entityId, a.entityId, sibling.entityId]));
    expect(r.status, r.raw).toBe(200);
    expect(r.rows.map((x) => x.entity_id)).toEqual([foreign.entityId]);
    expect(r.rows[0]?.pending_drafts).toBe(4);
    expect(r.meta.omitted).toEqual({ unresolved: 2 });
  });
});

describe('the figures are the CLI board figures', () => {
  it('each count equals getPendingBoard for the same entity, soft_close excluded from both', async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]));
    expect(r.status, r.raw).toBe(200);
    for (const f of [a, c]) {
      const row = r.rows.find((x) => x.entity_id === f.entityId);
      const ctx: AgentContext = {
        entityId: f.entityId,
        entityName: '',
        tenantId: f.tenantId,
        currency: 'MXN',
        country: 'MX',
        accountingStandard: 'mx_nif',
        taxId: 'XAXX010101000',
      };
      const board = await getPendingBoard(ctx);
      const item = (kind: string): number => board.items.find((i) => i.kind === kind)?.count ?? 0;
      expect(row?.pending_drafts, `drafts of ${f.entityId}`).toBe(item('draft'));
      expect(row?.pending_questions, `questions of ${f.entityId}`).toBe(item('question'));
      expect(row?.ended_open_periods, `ended open periods of ${f.entityId}`).toBe(item('period_close'));
    }

    // The soft_close period is overdue; if either side counted it, A would be
    // one above the open periods an independent query finds.
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fiscal_periods
        WHERE entity_id = $1 AND status = 'open' AND end_date < CURRENT_DATE`,
      [a.entityId]
    );
    expect(r.rows.find((x) => x.entity_id === a.entityId)?.ended_open_periods).toBe(rows[0].n);
  });

  it("the current period is the latest regular period that has started, and belongs to the row's entity", async () => {
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId]));
    expect(r.status, r.raw).toBe(200);
    // The sibling's period starts today, later than any period of A or C
    // except on the first of a month. On that day A, C and the sibling all tie,
    // and an uncorrelated lookup still gives both rows the same period, which
    // cannot belong to A and to C at once.
    expect(r.raw).not.toContain(siblingCurrentPeriodId);
    for (const f of [a, c]) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM fiscal_periods
          WHERE entity_id = $1 AND period_type = 'regular' AND start_date <= CURRENT_DATE
          ORDER BY start_date DESC LIMIT 1`,
        [f.entityId]
      );
      const shown = r.rows.find((x) => x.entity_id === f.entityId)?.current_period?.id ?? null;
      expect(shown, `current period of ${f.entityId}`).toBe(rows[0]?.id ?? null);
      expect(Object.values(f.periodos), `current period of ${f.entityId} is its own`).toContain(shown);
    }
  });

  it('reading the portfolio writes nothing', async () => {
    const tables = ['policy_decisions', 'ai_drafts', 'ai_questions', 'fiscal_periods'];
    const before = await Promise.all(tables.map(countOf));
    const r = await portfolio(tokenFor(a.tenantId, [a.entityId, c.entityId, foreign.entityId]));
    expect(r.status, r.raw).toBe(200);
    expect(await Promise.all(tables.map(countOf))).toEqual(before);
  });
});
