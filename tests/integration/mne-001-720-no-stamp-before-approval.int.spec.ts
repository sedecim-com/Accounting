import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { calculatePayRun, createPayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import { generateAndStampCfdiNomina } from '../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { generateNachaFile } from '../../src/services/payroll/usa/nacha-generator.js';
import { entityScope } from '../../src/database/scope.js';
import { encrypt } from '../../src/utils/encryption.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';

// ============================================================
// NOTHING LEAVES THE SYSTEM FOR A PAY RUN NOBODY APPROVED (MNE-001-720 · #601)
//
// Against a migrated Postgres, through the two functions every door calls and
// through their two routes. The PAC is the suite's double: `pacRouter.stamp`
// is replaced and answers a simulated stamp, so no PAC is reached and what
// each case counts is whether the double was called at all.
//
// Each run gets a period of its own: a fortnight for the Mexican schedule, a
// month for the US one.
// ============================================================

describe('a paycheck leaves the system only when its run is approved', () => {
  let f: Fixture;
  let srv: Servidor;
  let mxSchedule: string;
  let usSchedule: string;
  let worker: string;
  let usWorker: string;
  const months = { MX: 0, US: 0 };

  const scope = () => entityScope(f.tenantId, f.entityId);
  const COMPANY = {
    immediate_destination: '021000021',
    immediate_origin: '1234567890',
    company_name: 'MNE720 CO',
    company_identification: '1234567890',
    odfi_routing: '02100002',
    effective_entry_date: '',
  };

  /** A draft run over a period nobody else uses: `MX` a fortnight, `US` a month. */
  async function newRun(country: 'MX' | 'US'): Promise<string> {
    months[country] += 1;
    const mm = String(months[country]).padStart(2, '0');
    const periodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, $4, $5, $5, 2026, 'draft')`,
      [
        periodId, f.tenantId, country === 'MX' ? mxSchedule : usSchedule,
        `2026-${mm}-01`, country === 'MX' ? `2026-${mm}-15` : `2026-${mm}-28`,
      ]
    );
    return createPayRun(
      { tenant_id: f.tenantId, pay_period_id: periodId, employee_inputs: [], created_by: f.userId },
      scope()
    );
  }

  const calculate = (runId: string, employeeId: string, amount: number) =>
    calculatePayRun(
      runId,
      {
        tenant_id: f.tenantId, pay_period_id: '', created_by: f.userId,
        employee_inputs: [{ employee_id: employeeId, earnings: [{ earning_type: 'salary', amount, cfdi_clave_sat: '001' }] }],
      },
      scope()
    );

  /** A run with its one paycheck, left in `status`. */
  async function runIn(country: 'MX' | 'US', status: string): Promise<{ runId: string; paycheckId: string }> {
    const runId = await newRun(country);
    await calculate(runId, country === 'MX' ? worker : usWorker, country === 'MX' ? 6000 : 5000);
    if (status !== 'calculated') {
      await query('UPDATE pay_runs SET status = $2 WHERE id = $1 AND tenant_id = $3', [runId, status, f.tenantId]);
    }
    return { runId, paycheckId: (await paycheckOf(runId)).id };
  }

  const paycheckOf = async (runId: string) =>
    (await query<{
      id: string; gross: string; net: string; cfdi_uuid: string | null; cfdi_status: string | null;
      batch: string | null;
    }>(
      `SELECT id, gross_earnings::text AS gross, net_pay::text AS net, cfdi_uuid, cfdi_status,
              direct_deposit_batch_id AS batch
         FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    )).rows[0];

  const batchesOf = async (runId: string) =>
    (await query<{ total: string; entries: number }>(
      `SELECT total_amount::text AS total, entry_count AS entries
         FROM direct_deposit_batches WHERE pay_run_id = $1 AND tenant_id = $2`,
      [runId, f.tenantId]
    )).rows;

  const runStatus = async (runId: string) =>
    (await query<{ status: string }>('SELECT status FROM pay_runs WHERE id = $1', [runId])).rows[0].status;

  /** The suite's PAC: a simulated stamp, and the count of the calls it got. */
  const simulatedPac = () =>
    vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'test', simulado: true,
    });

  const stamp = (paycheckId: string) =>
    generateAndStampCfdiNomina(paycheckId, { tenantId: f.tenantId, userId: f.userId }, scope());
  const depositFile = (runId: string) => generateNachaFile(scope(), runId, COMPANY);

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-720 · nothing leaves unapproved');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    mxSchedule = uuidv4();
    usSchedule = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true),
              ($4, $2, $3, 'Monthly', 'monthly', 'US', '2026-01-01', true)`,
      [mxSchedule, f.tenantId, f.entityId, usSchedule]
    );
    worker = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
         work_state, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'N-001', 'Trabajador', 'De Prueba', '2024-01-01', 'active', 'MX',
         'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', '400.0000', '01', '02', 'JA', $4,
         'salary', 'MXN')`,
      [worker, f.tenantId, f.entityId, mxSchedule]
    );
    usWorker = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, ssn_encrypted, pay_schedule_id, salary_type,
         currency_code, w4_data, bank_account_encrypted)
       VALUES ($1, $2, $3, 'U-001', 'Worker', 'Sample', '2024-01-01', 'active', 'US', 'x', $4,
         'salary', 'USD', $5::jsonb, $6)`,
      [
        usWorker, f.tenantId, f.entityId, usSchedule, JSON.stringify({ filing_status: 'single' }),
        encrypt(JSON.stringify({ routing: '011000015', account: '111122223333', account_type: 'checking' })),
      ]
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

  describe('the payroll CFDI', () => {
    it('is refused for a calculated run before the PAC is called, and the paycheck is not written', async () => {
      const { runId, paycheckId } = await runIn('MX', 'calculated');
      const pac = simulatedPac();

      await expect(stamp(paycheckId)).rejects.toMatchObject({
        statusCode: 409,
        messageKey: { key: 'payrun.cfdi.run_not_approved', params: { id: paycheckId, run: runId, status: 'calculated' } },
      });
      expect(pac).not.toHaveBeenCalled();
      const after = await paycheckOf(runId);
      expect(after.cfdi_uuid).toBeNull();
      expect(after.cfdi_status).toBeNull();
    });

    it('and the run is calculated again after the refusal', async () => {
      const { runId, paycheckId } = await runIn('MX', 'calculated');
      simulatedPac();
      await expect(stamp(paycheckId)).rejects.toMatchObject({ statusCode: 409 });

      await calculate(runId, worker, 6500);
      const rebuilt = await paycheckOf(runId);
      expect(rebuilt.id).not.toBe(paycheckId);
      // By hand: the one salary of the second inputs.
      expect(rebuilt.gross).toBe('6500.00');
      expect(await runStatus(runId)).toBe('calculated');
    });

    it.each(['draft', 'calculating', 'voided'])('is refused for a run that is %s', async (status) => {
      const { runId, paycheckId } = await runIn('MX', status);
      const pac = simulatedPac();
      await expect(stamp(paycheckId)).rejects.toMatchObject({
        messageKey: { key: 'payrun.cfdi.run_not_approved', params: { status } },
      });
      expect(pac).not.toHaveBeenCalled();
      expect((await paycheckOf(runId)).cfdi_uuid).toBeNull();
    });

    it.each(['approved', 'paid'])('is stamped for a run that is %s, as before', async (status) => {
      const { runId, paycheckId } = await runIn('MX', status);
      const pac = simulatedPac();
      const result = await stamp(paycheckId);
      expect(pac).toHaveBeenCalledTimes(1);
      expect(result.xml).toContain('TipoDeComprobante="N"');
      const after = await paycheckOf(runId);
      expect(after.cfdi_uuid).toBe(result.cfdi_uuid);
      // A simulated stamp is never stored as stamped (pac/simulacion.ts).
      expect(after.cfdi_status).toBe('failed');
    });

    it('the route answers 409 with the message of the key, in English and in Spanish', async () => {
      const { runId, paycheckId } = await runIn('MX', 'calculated');
      const pac = simulatedPac();
      const path = `/v1/payroll/paychecks/${paycheckId}/cfdi-nomina`;

      const en = await pedir(srv, 'POST', path, {}, { 'accept-language': 'en' });
      expect(en.status, JSON.stringify(en.body)).toBe(409);
      expect(JSON.stringify(en.body)).toContain(
        `Paycheck ${paycheckId} was not stamped: its run ${runId} is calculated`
      );
      const es = await pedir(srv, 'POST', path, {}, { 'accept-language': 'es' });
      expect(es.status).toBe(409);
      expect(JSON.stringify(es.body)).toContain(
        `El recibo ${paycheckId} no se timbró: su corrida ${runId} está en estado calculated`
      );
      expect(pac).not.toHaveBeenCalled();
      expect((await paycheckOf(runId)).cfdi_uuid).toBeNull();
    });
  });

  describe('the deposit file (NACHA)', () => {
    it('is refused for a calculated run: no batch is written and no paycheck is linked', async () => {
      const { runId } = await runIn('US', 'calculated');

      await expect(depositFile(runId)).rejects.toMatchObject({
        statusCode: 409,
        messageKey: { key: 'payrun.deposit_file.run_not_approved', params: { id: runId, status: 'calculated' } },
      });
      expect(await batchesOf(runId)).toEqual([]);
      expect((await paycheckOf(runId)).batch).toBeNull();
    });

    it('and the run is calculated again after the refusal', async () => {
      const { runId, paycheckId } = await runIn('US', 'calculated');
      await expect(depositFile(runId)).rejects.toMatchObject({ statusCode: 409 });

      await calculate(runId, usWorker, 5200);
      const rebuilt = await paycheckOf(runId);
      expect(rebuilt.id).not.toBe(paycheckId);
      // By hand: the one salary of the second inputs.
      expect(rebuilt.gross).toBe('5200.00');
      expect(await runStatus(runId)).toBe('calculated');
    });

    it.each(['draft', 'calculating', 'voided'])('is refused for a run that is %s', async (status) => {
      const { runId } = await runIn('US', status);
      await expect(depositFile(runId)).rejects.toMatchObject({
        messageKey: { key: 'payrun.deposit_file.run_not_approved', params: { status } },
      });
      expect(await batchesOf(runId)).toEqual([]);
      expect((await paycheckOf(runId)).batch).toBeNull();
    });

    it.each(['approved', 'paid'])('is built for a run that is %s, as before', async (status) => {
      const { runId } = await runIn('US', status);
      const paycheck = await paycheckOf(runId);
      const file = await depositFile(runId);
      expect(file.entry_count).toBe(1);
      // The one entry is the paycheck's net pay, and the batch row says the same.
      expect(file.total_amount.toFixed(2)).toBe(paycheck.net);
      expect(await batchesOf(runId)).toEqual([{ total: paycheck.net, entries: 1 }]);
      expect((await paycheckOf(runId)).batch).toBe(file.batch_id);
    });

    it('the route answers 409 with the message of the key, in English and in Spanish', async () => {
      const { runId } = await runIn('US', 'calculated');
      const body = { pay_run_id: runId, company_info: COMPANY };

      const en = await pedir(srv, 'POST', '/v1/payroll/nacha', body, { 'accept-language': 'en' });
      expect(en.status, JSON.stringify(en.body)).toBe(409);
      expect(JSON.stringify(en.body)).toContain(`No deposit file was built for run ${runId}: it is calculated`);
      // The response of a refusal carries no account number.
      expect(JSON.stringify(en.body)).not.toContain('111122223333');
      const es = await pedir(srv, 'POST', '/v1/payroll/nacha', body, { 'accept-language': 'es' });
      expect(es.status).toBe(409);
      expect(JSON.stringify(es.body)).toContain(
        `No se generó el archivo de depósito de la corrida ${runId}: está en estado calculated`
      );
      expect(await batchesOf(runId)).toEqual([]);
    });
  });
});
