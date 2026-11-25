import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { getClient, query } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { createPayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { entityScope } from '../../src/database/scope.js';
import { PAY_RUN_TYPES } from '../../src/database/enums.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';

// ============================================================
// A PAY PERIOD HOLDS ONE REGULAR RUN (MNE-001-659 · #601)
//
// Against a migrated Postgres, through the service both doors call and
// through the route. Each case gets a period of its own. The runs a case
// needs in a status the service cannot reach from a draft with no employee
// are put there with an UPDATE of that status alone: the rule reads the
// status, not how the run got to it.
// ============================================================

type RunType = (typeof PAY_RUN_TYPES)[number];
const REFUSAL = 'payrun.create.regular_run_exists';

describe('a pay period holds one regular run', () => {
  let f: Fixture;
  let sibling: Fixture;
  let srv: Servidor;
  let scheduleId: string;
  let siblingSchedule: string;
  let periods = 0;

  const scope = () => entityScope(f.tenantId, f.entityId);

  async function schedule(fx: Fixture): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Monthly', 'monthly', 'MX', '2026-01-01', true)`,
      [id, fx.tenantId, fx.entityId]
    );
    return id;
  }

  /** A month nobody else uses, on the schedule given. */
  async function newPeriod(fx: Fixture = f, onSchedule: string = scheduleId): Promise<string> {
    const year = 2026 + Math.floor(periods / 12);
    const month = String((periods % 12) + 1).padStart(2, '0');
    periods += 1;
    const id = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'draft')`,
      [id, fx.tenantId, onSchedule, `${year}-${month}-01`, `${year}-${month}-28`, year]
    );
    return id;
  }

  const create = (periodId: string, runType?: RunType) =>
    createPayRun(
      { tenant_id: f.tenantId, pay_period_id: periodId, run_type: runType, employee_inputs: [], created_by: f.userId },
      scope()
    );

  const runsOf = async (periodId: string) =>
    (await query<{ id: string; run_type: string; status: string }>(
      `SELECT id, run_type, status FROM pay_runs WHERE pay_period_id = $1 AND tenant_id = $2`,
      [periodId, f.tenantId]
    )).rows;

  const setStatus = (runId: string, status: string) =>
    query(`UPDATE pay_runs SET status = $1 WHERE id = $2 AND tenant_id = $3`, [status, runId, f.tenantId]);

  const refusal = (period: string, run: string, status: string) => ({
    statusCode: 409,
    messageKey: { key: REFUSAL, params: { period, run, status } },
  });

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-659 · one regular run per period');
    sibling = await crearEntidadHermana(f, 'MNE-001-659 · sibling');
    scheduleId = await schedule(f);
    siblingSchedule = await schedule(sibling);
    // As src/index.ts mounts it: the language is negotiated before the routes.
    const payroll = Router();
    payroll.use(negotiateLocale, payrollRouter);
    srv = await levantar([['/v1/payroll', payroll]], {
      ...sesionDe(f),
      permissions: ['payroll:read', 'payroll:create'],
    });
  }, 180_000);

  afterAll(async () => {
    await srv?.cerrar();
  });

  it('a second regular run of the period is refused, naming the first, and no run is written', async () => {
    const period = await newPeriod();
    // No type given is the regular one: both spellings meet the same rule.
    const first = await create(period);

    await expect(create(period, 'regular')).rejects.toMatchObject(refusal(period, first, 'draft'));
    await expect(create(period)).rejects.toMatchObject(refusal(period, first, 'draft'));
    expect(await runsOf(period)).toEqual([{ id: first, run_type: 'regular', status: 'draft' }]);
  });

  it.each(['calculating', 'calculated', 'approved', 'paid'])(
    'it is refused while the first run is %s',
    async (status) => {
      const period = await newPeriod();
      const first = await create(period);
      await setStatus(first, status);

      await expect(create(period)).rejects.toMatchObject(refusal(period, first, status));
      expect(await runsOf(period)).toHaveLength(1);
    }
  );

  it('a voided regular run does not stand in the way, and the run created after it does', async () => {
    const period = await newPeriod();
    const voided = await create(period);
    await setStatus(voided, 'voided');

    const second = await create(period);
    expect(second).not.toBe(voided);
    await expect(create(period)).rejects.toMatchObject(refusal(period, second, 'draft'));
    expect(await runsOf(period)).toHaveLength(2);
  });

  it('a bonus, final, off-cycle or correction run of the same period is still created', async () => {
    const period = await newPeriod();
    const regular = await create(period);
    const apart: RunType[] = ['bonus', 'final', 'off_cycle', 'correction', 'bonus'];
    for (const runType of apart) await create(period, runType);

    const runs = await runsOf(period);
    expect(runs.filter((r) => r.run_type === 'regular').map((r) => r.id)).toEqual([regular]);
    expect(runs.map((r) => r.run_type).sort()).toEqual([...apart, 'regular'].sort());
  });

  it('the regular run is created in a period that so far holds only a bonus run', async () => {
    const period = await newPeriod();
    await create(period, 'bonus');
    const regular = await create(period, 'regular');
    await expect(create(period)).rejects.toMatchObject(refusal(period, regular, 'draft'));
  });

  it('the rule is per period: the next period gets its own regular run', async () => {
    const [one, two] = [await newPeriod(), await newPeriod()];
    const first = await create(one);
    const second = await create(two);
    expect(await runsOf(one)).toEqual([{ id: first, run_type: 'regular', status: 'draft' }]);
    expect(await runsOf(two)).toEqual([{ id: second, run_type: 'regular', status: 'draft' }]);
  });

  it('four regular runs created at once over one period wait for each other: one is written, three are refused naming it', async () => {
    const period = await newPeriod();
    // The race is held open on purpose, so the case does not lean on timing:
    // this session takes the period's row, the four creations start, and they
    // are let go only once all four are seen waiting for it.
    const holder = await getClient();
    let results: PromiseSettledResult<string>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM pay_periods WHERE id = $1 FOR NO KEY UPDATE', [period]);
      const racing = Promise.allSettled(Array.from({ length: 4 }, () => create(period)));

      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        waiting = (await query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.datname = current_database()
              AND a.query LIKE $1`,
          ['%FROM pay_periods%FOR NO KEY UPDATE%']
        )).rows[0].n;
      }
      expect(waiting, 'creations waiting for the period before any of them writes').toBe(4);
      await holder.query('COMMIT');
      results = await racing;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const created = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(created, 'runs created at once over one period').toHaveLength(1);
    expect(await runsOf(period)).toEqual([{ id: created[0], run_type: 'regular', status: 'draft' }]);
    expect(refused).toHaveLength(3);
    for (const reason of refused) expect(reason).toMatchObject(refusal(period, created[0], 'draft'));
  });

  it('a period that already held two regular runs gets no third, and the older one is named', async () => {
    // Written before the rule existed: nothing corrects them, and nothing adds to them.
    const period = await newPeriod();
    const [older, newer] = [uuidv4(), uuidv4()];
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by, created_at)
       VALUES ($1, $3, $4, 'regular', 'approved', 2026, $5, '2026-01-10T12:00:00Z'),
              ($2, $3, $4, 'regular', 'calculated', 2026, $5, '2026-01-11T12:00:00Z')`,
      [older, newer, f.tenantId, period, f.userId]
    );

    await expect(create(period)).rejects.toMatchObject(refusal(period, older, 'approved'));
    expect(await runsOf(period)).toHaveLength(2);
  });

  it('a period of the sibling company answers not found, with or without a regular run on it', async () => {
    const theirs = await newPeriod(sibling, siblingSchedule);
    await expect(create(theirs)).rejects.toMatchObject({ statusCode: 404 });

    await createPayRun(
      { tenant_id: sibling.tenantId, pay_period_id: theirs, employee_inputs: [], created_by: sibling.userId },
      entityScope(sibling.tenantId, sibling.entityId)
    );
    // Still 404, and not the refusal: it would say the period exists and name its run.
    await expect(create(theirs)).rejects.toMatchObject({ statusCode: 404 });
    await expect(create(theirs, 'bonus')).rejects.toMatchObject({ statusCode: 404 });
    expect(await runsOf(theirs)).toHaveLength(1);
  });

  it('the route answers 201 once and then 409 with the message of the key, in English and in Spanish', async () => {
    const period = await newPeriod();
    const made = await pedir(srv, 'POST', '/v1/payroll/pay-runs', { pay_period_id: period });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const first = (made.body as { data: { id: string } }).data.id;

    const en = await pedir(srv, 'POST', '/v1/payroll/pay-runs', { pay_period_id: period }, { 'accept-language': 'en' });
    expect(en.status, JSON.stringify(en.body)).toBe(409);
    expect(JSON.stringify(en.body)).toContain(
      `Pay period ${period} already has a regular run, ${first}, in status draft`
    );
    const es = await pedir(srv, 'POST', '/v1/payroll/pay-runs', { pay_period_id: period, run_type: 'regular' },
      { 'accept-language': 'es' });
    expect(es.status).toBe(409);
    expect(JSON.stringify(es.body)).toContain(
      `El periodo de pago ${period} ya tiene una corrida ordinaria, ${first}, en estado draft`
    );

    const bonus = await pedir(srv, 'POST', '/v1/payroll/pay-runs', { pay_period_id: period, run_type: 'bonus' });
    expect(bonus.status, JSON.stringify(bonus.body)).toBe(201);
    expect((await runsOf(period)).map((r) => r.run_type).sort()).toEqual(['bonus', 'regular']);
  });
});
