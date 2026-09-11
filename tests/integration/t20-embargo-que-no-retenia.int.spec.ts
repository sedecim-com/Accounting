import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/database/connection.js';
import {
  calculateGarnishments,
  desiredAmount,
} from '../../src/services/payroll/usa/garnishments/garnishment-engine.js';

/**
 * UNA ORDEN DE EMBARGO GUARDADA COMO MANDA LA COLUMNA NO RETENÍA NADA.
 *
 * T20 punto 2 (#127). `garnishments` tiene dos columnas de vocabulario y
 * ninguna tenía CHECK, así que la tabla admitía cualquier cadena — y el motor
 * leía un vocabulario DISTINTO del que la propia columna documenta:
 *
 *   · `amount_type`: el esquema comenta «fixed, percent_disposable,
 *     percent_gross»; el motor preguntaba por `'percentage'`.
 *   · `garnishment_type`: el esquema comenta «… tax_levy_federal,
 *     tax_levy_state, … pension_alimenticia»; el motor ramificaba sobre
 *     `'tax_levy'` y `'bankruptcy'`.
 *
 * Medido antes del arreglo, sobre una orden del 25 % con 2 000 de ingreso
 * disponible: `pension_alimenticia` retenía **0** y `child_support` 500;
 * `tax_levy_federal` retenía **0** y `tax_levy` 1 800.
 *
 * Y no es un defecto de laboratorio: `garnishments` NO TIENE UN SOLO ESCRITOR
 * en `src/`, así que quien da de alta una orden lo hace por SQL siguiendo el
 * comentario de la columna — que era justo el camino que devolvía cero. Una
 * pensión alimenticia no retenida es dinero que un juez adjudicó y que no
 * llega.
 */

const TENANT = randomUUID();
const ORG = randomUUID();
const ENTIDAD = randomUUID();
const EMPLEADO = randomUUID();

/** 25 % de 2 000 disponibles = 500, si el motor entiende la orden. */
const ENTRADA = {
  employee_id: EMPLEADO,
  disposable_earnings: 2000,
  gross_wages: 2500,
  pay_frequency: 'biweekly' as const,
};

async function conOrden(tipo: string, amountType: string, valor = 25): Promise<number> {
  await query('DELETE FROM garnishments WHERE employee_id = $1', [EMPLEADO]);
  await query(
    `INSERT INTO garnishments
       (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
     VALUES ($1, $2, 1, $3, $4, '2020-01-01', true, '{"exempt_amount":"200"}'::jsonb)`,
    [EMPLEADO, tipo, amountType, valor]
  );
  const r = await calculateGarnishments(ENTRADA);
  return r.total_withheld;
}

beforeAll(async () => {
  await query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'T20','t20','t_t20')`, [TENANT]);
  await query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'G','holding')`, [ORG, TENANT]);
  await query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,'Acme','corporation','AA010101AAA','ein','US')`,
    [ENTIDAD, ORG, TENANT]
  );
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name, hire_date, country_code, ssn_encrypted)
     VALUES ($1,$2,$3,'E-T20','Ada','Lovelace','2020-01-01','US','x')`,
    [EMPLEADO, TENANT, ENTIDAD]
  );
}, 120_000);

afterAll(async () => {
  await query('DELETE FROM garnishments WHERE employee_id = $1', [EMPLEADO]);
  await query('DELETE FROM employees WHERE id = $1', [EMPLEADO]);
  await query('DELETE FROM legal_entities WHERE id = $1', [ENTIDAD]);
  await query('DELETE FROM organizations WHERE id = $1', [ORG]);
  await query('DELETE FROM tenants WHERE id = $1', [TENANT]);
});

describe('el vocabulario que la columna documenta es el que retiene', () => {
  it('la pensión alimenticia mexicana retiene lo mismo que el child support', async () => {
    // Antes: 500 contra 0. Son el mismo hecho con dos nombres, y sólo uno
    // llegaba al cálculo.
    expect(await conOrden('pension_alimenticia', 'percent_disposable')).toBe(500);
    expect(await conOrden('child_support', 'percent_disposable')).toBe(500);
  });

  it('el embargo fiscal federal retiene, en vez de no existir', async () => {
    // Pub 1494: se retiene lo disponible menos la exención. 2 000 − 200.
    expect(await conOrden('tax_levy_federal', 'percent_disposable')).toBe(1800);
    expect(await conOrden('tax_levy_state', 'percent_disposable')).toBe(1800);
  });

  it('y `percent_gross` existe de verdad, no sólo en el comentario', async () => {
    // 25 % de 2 500 brutos son 625, que la CCPA topa en 500 para un acreedor.
    // Lo que importa aquí es que la base sea el BRUTO y no el disponible.
    expect(desiredAmount('percent_gross', 25, 2000, 2500)).toBe(625);
    expect(desiredAmount('percent_disposable', 25, 2000, 2500)).toBe(500);
    expect(desiredAmount('fixed', 25, 2000, 2500)).toBe(25);
  });

  it('un `amount_type` que el motor no sabe tratar LANZA, no retiene cero', () => {
    // Es el principio de todo T20: fallar cerrado. Un cero silencioso en una
    // pensión alimenticia es indistinguible de «no se debía nada».
    expect(() => desiredAmount('percentage', 25, 2000, 2500)).toThrow(/Unknown garnishment amount_type/);
  });
});

describe('la restricción que impide que vuelva a pasar', () => {
  it('la base ya no admite el vocabulario viejo', async () => {
    await expect(
      query(
        `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active)
         VALUES ($1,'child_support',1,'percentage',25,'2020-01-01',true)`,
        [EMPLEADO]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ni un tipo de embargo inventado', async () => {
    await expect(
      query(
        `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active)
         VALUES ($1,'lo_que_sea',1,'fixed',25,'2020-01-01',true)`,
        [EMPLEADO]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('la prelación que la cabecera promete', () => {
  it('el embargo fiscal federal se cobra antes que el acreedor, aunque el acreedor tenga mejor prioridad', async () => {
    // ANTES era `ORDER BY priority ASC, start_date ASC` a secas, así que un
    // acreedor con priority = 1 se cobraba antes que una pensión alimenticia
    // con priority = 100 — al revés de lo que la cabecera del módulo promete.
    await query('DELETE FROM garnishments WHERE employee_id = $1', [EMPLEADO]);
    await query(
      `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
       VALUES ($1,'creditor',1,'percent_disposable',25,'2020-01-01',true,'{}'::jsonb),
              ($1,'tax_levy_federal',100,'percent_disposable',25,'2020-01-01',true,'{"exempt_amount":"200"}'::jsonb)`,
      [EMPLEADO]
    );
    const r = await calculateGarnishments(ENTRADA);
    expect(r.per_order[0].type, 'el fiscal federal primero, pese a su priority 100').toBe('tax_levy');
    expect(r.per_order[1].type).toBe('creditor');
  });
});
