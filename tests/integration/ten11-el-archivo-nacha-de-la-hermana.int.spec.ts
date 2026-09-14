import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { encrypt } from '../../src/utils/encryption.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

// ============================================================
// TEN-11 · EL ARCHIVO DE DISPERSIÓN (NACHA) DE LA SOCIEDAD HERMANA
//
// `POST /v1/payroll/nacha` produce la instrucción de pago que el banco ejecuta,
// y su respuesta trae el archivo: cada renglón de detalle lleva la ruta y la
// cuenta bancaria del empleado DESCIFRADAS. La ruta no montaba
// `requireEntityAccess` y el servicio leía la corrida con `WHERE pr.id = $1`
// a secas. Una divulgación no se deshace.
//
// Además escribe: un lote en `direct_deposit_batches` y el vínculo de cada
// recibo con ese lote, sin historial.
// ============================================================

let a: Fixture;
let b: Fixture;
let srv: Servidor;

const CUENTA_DE_B = '998877665544';
const RUTA_DE_B = '021000021';

interface Cadena {
  corrida: string;
  recibo: string;
}

/** Calendario, periodo, corrida aprobada y un empleado US con cuenta cifrada. */
async function cadenaUS(fx: Fixture, cuenta: string, ruta: string): Promise<Cadena> {
  const empleado = randomUUID();
  const horario = randomUUID();
  const periodo = randomUUID();
  const corrida = randomUUID();
  const recibo = randomUUID();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, ssn_encrypted, annual_salary, status, bank_account_encrypted)
     VALUES ($1,$2,$3,$4,'Grace','Hopper','2020-01-01','US',$5, 120000, 'active', $6)`,
    [
      empleado, fx.tenantId, fx.entityId, `E-${empleado.slice(0, 8)}`,
      encrypt('123-45-6789'),
      encrypt(JSON.stringify({ routing: ruta, account: cuenta, account_type: 'checking' })),
    ]
  );
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Biweekly','biweekly','US','2026-01-01')`,
    [horario, fx.tenantId, fx.entityId]
  );
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,'2026-03-01','2026-03-14','2026-03-20',2026)`,
    [periodo, fx.tenantId, horario]
  );
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, status, tax_year_used,
       total_gross, total_pre_tax_deductions, total_net_pay, total_employee_taxes,
       total_employer_taxes, total_post_tax_deductions)
     VALUES ($1,$2,$3,'approved',2026, 5000, 0, 3800, 1200, 0, 0)`,
    [corrida, fx.tenantId, periodo]
  );
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay)
     VALUES ($1,$2,$3,$4, 5000, 3800)`,
    [recibo, fx.tenantId, corrida, empleado]
  );
  return { corrida, recibo };
}

let deB: Cadena;
let deA: Cadena;
const LOTE_LEGITIMO_DE_B = randomUUID();

const COMPANIA = {
  immediate_destination: '021000021',
  immediate_origin: '1234567890',
  company_name: 'TEN11 CO',
  company_id: '1234567890',
  odfi_routing: '02100002',
};

beforeAll(async () => {
  a = await crearInquilino('TEN-11 nacha A');
  b = await crearEntidadHermana(a, 'TEN-11 nacha B');
  deB = await cadenaUS(b, CUENTA_DE_B, RUTA_DE_B);
  deA = await cadenaUS(a, '111122223333', '011000015');

  // El recibo de B ya viaja en un lote legítimo de B: el ataque no puede moverlo.
  await query(
    `INSERT INTO direct_deposit_batches (id, tenant_id, pay_run_id, rail, total_amount, entry_count,
       effective_date, status, file_sha256)
     VALUES ($1,$2,$3,'ach_nacha', 3800, 1, '2026-03-20', 'draft', 'legitimo')`,
    [LOTE_LEGITIMO_DE_B, b.tenantId, deB.corrida]
  );
  await query(`UPDATE paychecks SET direct_deposit_batch_id = $1 WHERE id = $2`, [LOTE_LEGITIMO_DE_B, deB.recibo]);

  srv = await levantar([['/v1/payroll', payrollRouter]], {
    ...sesionDe(a),
    permissions: ['payroll:read', 'payroll:create', 'payroll:approve'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

const lotesDe = async (corrida: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM direct_deposit_batches WHERE pay_run_id = $1',
    [corrida]
  );
  return Number(rows[0].n);
};

describe('el archivo NACHA de la hermana', () => {
  it('contesta 404, y la respuesta no trae su cuenta bancaria', async () => {
    const r = await pedir(srv, 'POST', '/v1/payroll/nacha', { pay_run_id: deB.corrida, company_info: COMPANIA });
    expect(JSON.stringify(r.body), 'la cuenta descifrada de la hermana salió en la respuesta').not.toContain(CUENTA_DE_B);
    expect(r.status, `contestó ${r.status}`).toBe(404);
  });

  it('y no escribe: ni lote nuevo, ni mueve el recibo de su lote legítimo', async () => {
    const antes = await lotesDe(deB.corrida);
    await pedir(srv, 'POST', '/v1/payroll/nacha', { pay_run_id: deB.corrida, company_info: COMPANIA });
    expect(await lotesDe(deB.corrida), 'se escribió un lote sobre la corrida ajena').toBe(antes);
    const { rows } = await query<{ direct_deposit_batch_id: string }>(
      'SELECT direct_deposit_batch_id FROM paychecks WHERE id = $1',
      [deB.recibo]
    );
    expect(rows[0].direct_deposit_batch_id, 'el recibo ajeno cambió de lote').toBe(LOTE_LEGITIMO_DE_B);
  });

  it('el 404 es idéntico al de una corrida que no existe', async () => {
    const ajena = await pedir(srv, 'POST', '/v1/payroll/nacha', { pay_run_id: deB.corrida, company_info: COMPANIA });
    const fantasmaId = randomUUID();
    const fantasma = await pedir(srv, 'POST', '/v1/payroll/nacha', { pay_run_id: fantasmaId, company_info: COMPANIA });
    expect(fantasma.status).toBe(404);
    const normalizar = (body: unknown, id: string): string =>
      JSON.stringify((body as { errors?: unknown }).errors).split(id).join('<id>');
    expect(normalizar(ajena.body, deB.corrida)).toBe(normalizar(fantasma.body, fantasmaId));
  });

  it('EL CONTRAPESO: el archivo de la corrida propia sí sale', async () => {
    const r = await pedir(srv, 'POST', '/v1/payroll/nacha', { pay_run_id: deA.corrida, company_info: COMPANIA });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { data: { entry_count: number } }).data.entry_count).toBe(1);
  });
});
