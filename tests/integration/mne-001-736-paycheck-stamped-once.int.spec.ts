import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { getClient, query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePayRun, createPayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import { generateAndStampCfdiNomina } from '../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { entityScope } from '../../src/database/scope.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';

// ============================================================
// A PAYCHECK THAT HAS ITS STAMPED PAYROLL CFDI IS NOT STAMPED AGAIN
// (MNE-001-736 · #601)
//
// Against a migrated Postgres, through the function every door calls and
// through its route. The PAC is the suite's double: `pacRouter.stamp` is
// replaced, so no PAC is reached and no credential is read. The double answers
// either as a real PAC would (`simulado: false`, which the generator stores as
// `stamped`) or as the simulated adapters do (`simulado: true`, stored as
// `failed`), and each case counts the calls it got.
//
// Each run gets a fortnight of its own.
// ============================================================

describe('a paycheck with a stamped payroll CFDI is not stamped again', () => {
  let f: Fixture;
  let srv: Servidor;
  let schedule: string;
  let worker: string;
  let fortnights = 0;

  const scope = () => entityScope(f.tenantId, f.entityId);

  /** An approved run with its one paycheck, over a fortnight nobody else uses. */
  async function approvedPaycheck(): Promise<string> {
    fortnights += 1;
    const mm = String(fortnights).padStart(2, '0');
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [periodId, f.tenantId, schedule, `2026-${mm}-01`, `2026-${mm}-15`]
    );
    const runId = await createPayRun(
      { tenant_id: f.tenantId, pay_period_id: periodId, employee_inputs: [], created_by: f.userId },
      scope()
    );
    await calculatePayRun(
      runId,
      {
        tenant_id: f.tenantId, pay_period_id: '', created_by: f.userId,
        employee_inputs: [{ employee_id: worker, earnings: [{ earning_type: 'salary', amount: 6000, cfdi_clave_sat: '001' }] }],
      },
      scope()
    );
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [runId, f.tenantId]);
    return (await query<{ id: string }>(
      'SELECT id FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2',
      [runId, f.tenantId]
    )).rows[0].id;
  }

  interface Stored { uuid: string | null; status: string | null; provider: string | null; at: Date | null }
  const stored = async (paycheckId: string): Promise<Stored> =>
    (await query<Stored>(
      `SELECT cfdi_uuid AS uuid, cfdi_status AS status, cfdi_provider AS provider, cfdi_stamped_at AS at
         FROM paychecks WHERE id = $1 AND tenant_id = $2`,
      [paycheckId, f.tenantId]
    )).rows[0];

  /** What a PAC answers: a new folio on each call. */
  const answer = (simulated: boolean) => ({
    uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
    fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
    provider_used: 'test', simulado: simulated,
  });
  /** The double as a real PAC: its folio is stored as `stamped`. */
  const realPac = () => vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => answer(false));
  /** The double as the simulated adapters: its folio is stored as `failed`. */
  const simulatedPac = () => vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => answer(true));

  const stamp = (paycheckId: string, within = scope()) =>
    generateAndStampCfdiNomina(paycheckId, { tenantId: f.tenantId, userId: f.userId }, within);

  type Refusal = { statusCode?: number; messageKey?: { key: string; params: Record<string, unknown> } };
  const outcome = <T>(p: Promise<T>): Promise<{ value?: T; refusal?: Refusal }> =>
    p.then((value) => ({ value }), (refusal: Refusal) => ({ refusal }));

  const until = async (seen: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await seen()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  /** A statement of this database is waiting for a lock, right now. */
  const someoneWaits = async (): Promise<boolean> =>
    Number((await query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    )).rows[0].n) > 0;

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-736 · a paycheck is stamped once');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    schedule = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [schedule, f.tenantId, f.entityId]
    );
    worker = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
         work_state, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'N-736', 'Trabajador', 'De Prueba', '2024-01-01', 'active', 'MX',
         'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '400.0000', '01', '02', 'JA', $4,
         'salary', 'MXN')`,
      [worker, f.tenantId, f.entityId, schedule]
    );
    // As src/index.ts mounts it: the language is negotiated before the routes.
    const payroll = Router();
    payroll.use(negotiateLocale, payrollRouter);
    srv = await levantar([['/v1/payroll', payroll]], {
      ...sesionDe(f),
      permissions: ['payroll:read', 'payroll:create', 'payroll:approve'],
    });
  }, 180_000);

  afterAll(async () => {
    await srv?.cerrar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the second stamp is refused before the PAC is called, names the first folio and writes nothing', async () => {
    const paycheckId = await approvedPaycheck();
    const pac = realPac();

    const first = await stamp(paycheckId);
    const before = await stored(paycheckId);
    expect(before).toMatchObject({ uuid: first.cfdi_uuid, status: 'stamped', provider: 'test' });
    expect(before.at).toBeInstanceOf(Date);

    await expect(stamp(paycheckId)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: {
        key: 'payrun.cfdi.already_stamped',
        params: { id: paycheckId, uuid: first.cfdi_uuid, status: 'stamped', stamped_at: before.at!.toISOString() },
      },
    });
    // One call: the one that stamped it. The folio of the first is still the paycheck's.
    expect(pac).toHaveBeenCalledTimes(1);
    expect(await stored(paycheckId)).toEqual(before);
  });

  it('a folio made by a simulated adapter is kept as failed, and the paycheck is stamped after it', async () => {
    const paycheckId = await approvedPaycheck();
    simulatedPac();
    const simulated = await stamp(paycheckId);
    expect(await stored(paycheckId)).toMatchObject({ uuid: simulated.cfdi_uuid, status: 'failed' });
    vi.restoreAllMocks();

    const pac = realPac();
    const real = await stamp(paycheckId);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(real.cfdi_uuid).not.toBe(simulated.cfdi_uuid);
    expect(await stored(paycheckId)).toMatchObject({ uuid: real.cfdi_uuid, status: 'stamped' });
  });

  // No door of the system cancels a payroll CFDI yet, and none writes `pending`
  // (a reader shows a paycheck with no status as pending): both are put by SQL.
  it.each(['cancelled', 'pending'])('a paycheck whose payroll CFDI is %s is stamped', async (status) => {
    const paycheckId = await approvedPaycheck();
    const old = status === 'cancelled' ? uuidv4() : null;
    await query(
      `UPDATE paychecks SET cfdi_status = $2, cfdi_uuid = $3 WHERE id = $1 AND tenant_id = $4`,
      [paycheckId, status, old, f.tenantId]
    );
    const pac = realPac();
    const result = await stamp(paycheckId);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(await stored(paycheckId)).toMatchObject({ uuid: result.cfdi_uuid, status: 'stamped' });
  });

  it('a status this code does not know is refused: it is not known to be free', async () => {
    const paycheckId = await approvedPaycheck();
    const held = uuidv4();
    await query(
      `UPDATE paychecks SET cfdi_status = 'stamping', cfdi_uuid = $2 WHERE id = $1 AND tenant_id = $3`,
      [paycheckId, held, f.tenantId]
    );
    const pac = realPac();
    await expect(stamp(paycheckId)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: { key: 'payrun.cfdi.already_stamped', params: { uuid: held, status: 'stamping' } },
    });
    expect(pac).not.toHaveBeenCalled();
    expect(await stored(paycheckId)).toMatchObject({ uuid: held, status: 'stamping' });
  });

  it('two stamps at once reach the PAC once: the one that waited is refused with the folio of the other', async () => {
    const paycheckId = await approvedPaycheck();
    let letThePacAnswer!: () => void;
    const held = new Promise<void>((resolve) => { letThePacAnswer = resolve; });
    const pac = vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => {
      await held;
      return answer(false);
    });

    const a = outcome(stamp(paycheckId));
    expect(await until(() => pac.mock.calls.length === 1), 'the first stamp reaches the PAC').toBe(true);
    const b = outcome(stamp(paycheckId));
    // The second waits for the paycheck's row while the PAC has not answered
    // the first. Without the lock it never waits: it goes straight to the PAC.
    const waited = await until(async () => pac.mock.calls.length > 1 || (await someoneWaits()));
    const callsWhileHeld = pac.mock.calls.length;
    letThePacAnswer();
    const [first, second] = await Promise.all([a, b]);

    expect(waited && callsWhileHeld, 'the second stamp waits instead of calling the PAC').toBe(1);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(first.value?.cfdi_uuid).toBeTruthy();
    expect(second.refusal).toMatchObject({
      statusCode: 409,
      messageKey: { key: 'payrun.cfdi.already_stamped', params: { id: paycheckId, uuid: first.value!.cfdi_uuid } },
    });
    expect(await stored(paycheckId)).toMatchObject({ uuid: first.value!.cfdi_uuid, status: 'stamped' });
  });

  it('an attempt that cannot have the paycheck within the lock timeout gives up by key, before the PAC', async () => {
    const paycheckId = await approvedPaycheck();
    const pac = realPac();
    const other = await getClient();
    try {
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM paychecks WHERE id = $1 FOR UPDATE', [paycheckId]);
      await expect(stamp(paycheckId)).rejects.toMatchObject({
        statusCode: 409,
        messageKey: { key: 'payrun.cfdi.stamp_in_progress', params: { id: paycheckId } },
      });
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect(pac).not.toHaveBeenCalled();
    expect(await stored(paycheckId)).toEqual({ uuid: null, status: null, provider: null, at: null });
  }, 25_000);

  it('when the transaction is lost while the PAC answers, the error names the folio the PAC issued', async () => {
    const paycheckId = await approvedPaycheck();
    const issued = answer(false);
    let ended = 0;
    const pac = vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => {
      // The stamp's own session is the one open and idle while the PAC works.
      const r = await query<{ ended: boolean }>(
        `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`
      );
      ended = r.rows.filter((row) => row.ended).length;
      return issued;
    });

    const lost = await outcome(stamp(paycheckId));
    expect(ended, 'the stamp holds one open transaction while the PAC works').toBe(1);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(lost.refusal).toMatchObject({
      statusCode: 500,
      code: 'PAYROLL_CFDI_NOT_RECORDED',
      messageKey: {
        key: 'payrun.cfdi.stamped_not_recorded',
        params: { id: paycheckId, uuid: issued.uuid, provider: 'test' },
      },
    });
    expect(await stored(paycheckId)).toEqual({ uuid: null, status: null, provider: null, at: null });
  });

  it('outside the scope a stamped paycheck is still a 404, and no folio is named', async () => {
    const paycheckId = await approvedPaycheck();
    const pac = realPac();
    const first = await stamp(paycheckId);
    pac.mockClear();
    const elsewhere = await outcome(stamp(paycheckId, entityScope(f.tenantId, uuidv4())));
    expect(elsewhere.refusal).toMatchObject({ statusCode: 404 });
    expect(JSON.stringify(elsewhere.refusal)).not.toContain(first.cfdi_uuid);
    expect(pac).not.toHaveBeenCalled();
  });

  it('the route answers the second call 409 with the message of the key, in English and in Spanish', async () => {
    const paycheckId = await approvedPaycheck();
    const pac = realPac();
    const path = `/v1/payroll/paychecks/${paycheckId}/cfdi-nomina`;

    const first = await pedir(srv, 'POST', path, {}, { 'accept-language': 'en' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const before = await stored(paycheckId);
    expect(before.status).toBe('stamped');
    const at = before.at!.toISOString();

    const en = await pedir(srv, 'POST', path, {}, { 'accept-language': 'en' });
    expect(en.status, JSON.stringify(en.body)).toBe(409);
    expect(JSON.stringify(en.body)).toContain(
      `Paycheck ${paycheckId} was not stamped again: it already has a payroll CFDI, folio ${before.uuid} (stamped), stamped at ${at}`
    );
    const es = await pedir(srv, 'POST', path, {}, { 'accept-language': 'es' });
    expect(es.status).toBe(409);
    expect(JSON.stringify(es.body)).toContain(
      `El recibo ${paycheckId} no se timbró otra vez: ya tiene un CFDI de nómina, folio ${before.uuid} (stamped), timbrado el ${at}`
    );
    expect(pac).toHaveBeenCalledTimes(1);
    expect(await stored(paycheckId)).toEqual(before);
  });
});
