import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { calculateGarnishments } from '../../src/services/payroll/usa/garnishments/garnishment-engine.js';
import {
  archiveGarnishment,
  listGarnishments,
  recordGarnishment,
} from '../../src/services/payroll/common/garnishment-service.js';

/**
 * LA ORDEN QUE NADIE PODÍA REGISTRAR (F08 · #113).
 *
 * `garnishments` era la última tabla de la salida de nómina sin un solo
 * escritor en `src/`: el recibo la lee, las líneas de deducción la leen y la
 * cascada entera de la CCPA sale de ella, y ningún camino podía poner una
 * fila. Quien daba de alta una orden lo hacía por SQL siguiendo el comentario
 * de la columna, que hasta la 075 era justo el camino que retenía cero.
 *
 * LA AFIRMACIÓN QUE IMPORTA ES LA PRIMERA, y es una cifra: lo que un humano
 * DIO DE ALTA y lo que la cascada RETIENE son el mismo número. Es la primera
 * vez en este repositorio que esas dos cosas se pueden comparar, y es la
 * aserción que muere el día que el escritor y el motor vuelvan a hablar dos
 * vocabularios — que es el defecto de la 075, exactamente. `toBe(500)` y no
 * `toBeGreaterThan(0)`: sin una cifra afirmada, «acota» y «no acota» dan la
 * misma prueba verde.
 *
 * ── POR QUÉ EL ATAQUE DE FRONTERA VA DENTRO DE UN SOLO INQUILINO ────────
 *
 * Las dos sociedades de abajo comparten `tenant_id` a propósito. Ninguna
 * política de la base las distingue —RLS acota por INQUILINO, y scope.ts:28-31
 * dice por escrito que dentro de un inquilino con varias entidades legales no
 * acota nada—, así que lo que conteste 404 en esos casos es el predicado que
 * el código escribe dentro del SQL y no puede ser otra cosa. Es la forma de
 * probar la frontera sin depender de con qué rol corra el banco: da igual si
 * RLS está inerte, porque en este eje RLS no defendía nada de todos modos.
 */

const TENANT = randomUUID();
const ORG = randomUUID();
const ENTITY = randomUUID();
const SISTER = randomUUID();
const EMPLOYEE = randomUUID();
const SISTER_EMPLOYEE = randomUUID();
const MEXICAN_EMPLOYEE = randomUUID();

/** 2 000 disponibles: el mismo escenario que la 075 midió. */
const CASCADE_INPUT = {
  employee_id: EMPLOYEE,
  disposable_earnings: 2000,
  gross_wages: 2500,
  pay_frequency: 'biweekly' as const,
};

const SCOPE = entityScope(TENANT, ENTITY);
const SISTER_SCOPE = entityScope(TENANT, SISTER);

const SUPPORT_ORDER = {
  employee_id: EMPLOYEE,
  type: 'child_support',
  percent_disposable: '25',
  supports_second_family: 'yes',
  arrears_over_12_weeks: 'no',
  issuing_authority: 'Travis County District Court',
  start_date: '2020-01-01',
};

async function seedEntity(id: string, name: string, taxId: string): Promise<void> {
  await query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country)
     VALUES ($1,$2,$3,$4,'corporation',$5,'ein','US')`,
    [id, ORG, TENANT, name, taxId]
  );
}

async function seedEmployee(id: string, entityId: string, number: string, country: string): Promise<void> {
  // El CHECK de la 008 exige RFC a un mexicano y SSN a un estadounidense: un
  // empleado sin la identificación de su país no es una ficha incompleta, es
  // una ficha que no se puede declarar.
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name, hire_date, country_code, ssn_encrypted, rfc)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2020-01-01',$5,$6,$7)`,
    [id, TENANT, entityId, number, country, country === 'US' ? 'x' : null, country === 'MX' ? 'LOAA800101AAA' : null]
  );
}

async function clearOrders(): Promise<void> {
  await query('DELETE FROM garnishments WHERE employee_id = ANY($1::uuid[])', [
    [EMPLOYEE, SISTER_EMPLOYEE, MEXICAN_EMPLOYEE],
  ]);
}

beforeAll(async () => {
  await query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1,'F08','f08','t_f08')`, [TENANT]);
  await query(`INSERT INTO organizations (id, tenant_id, name, type) VALUES ($1,$2,'G','holding')`, [ORG, TENANT]);
  await seedEntity(ENTITY, 'Acme', 'AA010101AAA');
  await seedEntity(SISTER, 'Acme Sister', 'BB010101BBB');
  await seedEmployee(EMPLOYEE, ENTITY, 'E-F08', 'US');
  await seedEmployee(SISTER_EMPLOYEE, SISTER, 'E-F08-S', 'US');
  await seedEmployee(MEXICAN_EMPLOYEE, ENTITY, 'E-F08-MX', 'MX');
}, 120_000);

afterAll(async () => {
  await clearOrders();
  await query('DELETE FROM employees WHERE tenant_id = $1', [TENANT]);
  await query('DELETE FROM legal_entities WHERE tenant_id = $1', [TENANT]);
  await query('DELETE FROM organizations WHERE id = $1', [ORG]);
  await query('DELETE FROM tenants WHERE id = $1', [TENANT]);
});

describe('lo que se da de alta y lo que se retiene son el mismo número', () => {
  it('una orden del 25 % del disponible retiene 500 sobre 2 000', async () => {
    await clearOrders();
    const filed = await recordGarnishment(SUPPORT_ORDER, SCOPE);
    expect(filed.id).toBeTruthy();

    const r = await calculateGarnishments(CASCADE_INPUT);
    expect(r.total_withheld, 'lo filado y lo retenido tienen que ser la misma cifra').toBe(500);
    expect(r.per_order[0].order_id).toBe(filed.id);
  });

  it('y el tope que se capturó es el que la cascada aplica, no el que deduciría de la ausencia', async () => {
    await clearOrders();
    // 2 000 × 50 % = 1 000, porque la segunda familia se declaró. Sin declarar
    // sería 60 % = 1 200: diez puntos de diferencia sobre la misma orden.
    await recordGarnishment({ ...SUPPORT_ORDER, percent_disposable: '80' }, SCOPE);
    const r = await calculateGarnishments(CASCADE_INPUT);
    expect(r.total_withheld).toBe(1000);
    expect(r.per_order[0].cap_applied).toBe('CCPA 50%');
  });

  it('el ensayo de `--dry-run` recorre el camino REAL y no deja nada', async () => {
    await clearOrders();
    // El ensayo no describe a mano lo que pasaría: llama al mismo escritor
    // dentro de una transacción y la aborta, así que lo que imprime sale del
    // código que escribiría —con sus negativas, su frontera y su unicidad—.
    // Lo que se comprueba aquí es la segunda mitad: que no quede la fila.
    const rehearsal = await withTransaction(async (client) => {
      const r = await recordGarnishment(SUPPORT_ORDER, SCOPE, { client });
      throw Object.assign(new Error('rehearsed'), { filed: r.id });
    }).catch((err: Error & { filed?: string }) => err.filed);

    expect(rehearsal, 'el ensayo tuvo que llegar hasta el INSERT').toBeTruthy();
    expect((await calculateGarnishments(CASCADE_INPUT)).total_withheld).toBe(0);
    expect(await listGarnishments(SCOPE, { employee_id: EMPLOYEE })).toEqual([]);
  });
});

describe('archivar detiene la retención de verdad', () => {
  it('retiene, se archiva, y deja de retener', async () => {
    await clearOrders();
    const filed = await recordGarnishment(SUPPORT_ORDER, SCOPE);
    expect((await calculateGarnishments(CASCADE_INPUT)).total_withheld).toBe(500);

    const stopped = await archiveGarnishment(filed.id, SCOPE, { asOf: '2026-09-12' });
    expect(stopped.id).toBe(filed.id);
    expect(stopped.end_date).not.toBeNull();

    expect(
      (await calculateGarnishments(CASCADE_INPUT)).total_withheld,
      'si esto no es CERO, la fila del catálogo miente cuando dice que archivar detiene la retención'
    ).toBe(0);
  });

  it('archivar lo ya archivado no contesta éxito por una detención que no ocurrió', async () => {
    await clearOrders();
    const filed = await recordGarnishment(SUPPORT_ORDER, SCOPE);
    await archiveGarnishment(filed.id, SCOPE);
    await expect(archiveGarnishment(filed.id, SCOPE)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('la lista sale en el orden en que el dinero se cobra, no en el de la prioridad', async () => {
    await clearOrders();
    // Un acreedor con la MEJOR prioridad y un embargo fiscal con la peor: la
    // prelación legal manda, y la prioridad sólo desempata dentro de ella.
    await recordGarnishment(
      { ...SUPPORT_ORDER, type: 'creditor', priority: 1, supports_second_family: undefined, arrears_over_12_weeks: undefined },
      SCOPE
    );
    await recordGarnishment(
      {
        employee_id: EMPLOYEE,
        type: 'tax_levy_federal',
        priority: 100,
        exempt_amount: '200',
        issuing_authority: 'IRS ACS',
        start_date: '2020-01-01',
      },
      SCOPE
    );
    const rows = await listGarnishments(SCOPE, { employee_id: EMPLOYEE });
    expect(rows.map((r) => r.garnishment_type)).toEqual(['tax_levy_federal', 'creditor']);
    expect(Number(rows[0].rank)).toBeLessThan(Number(rows[1].rank));
  });
});

describe('la frontera es la entidad del empleado, y las dos sociedades comparten inquilino', () => {
  it('las dos entidades son del MISMO inquilino: ninguna política puede distinguirlas', async () => {
    const { rows } = await query<{ n: string }>(
      `SELECT count(DISTINCT tenant_id)::text AS n FROM legal_entities WHERE id = ANY($1::uuid[])`,
      [[ENTITY, SISTER]]
    );
    expect(rows[0].n, 'si fueran de dos inquilinos, RLS podría estar haciendo el trabajo del código').toBe('1');
  });

  it('dar de alta contra el empleado de la sociedad hermana contesta 404, nunca 403', async () => {
    await expect(
      recordGarnishment({ ...SUPPORT_ORDER, employee_id: SISTER_EMPLOYEE }, SCOPE)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('la orden de la hermana no se enumera ni se archiva: es indistinguible de inexistente', async () => {
    await clearOrders();
    const sisterOrder = await recordGarnishment(
      { ...SUPPORT_ORDER, employee_id: SISTER_EMPLOYEE },
      SISTER_SCOPE
    );
    const rows = await listGarnishments(SCOPE, {});
    expect(rows.map((r) => r.id)).not.toContain(sisterOrder.id);
    await expect(archiveGarnishment(sisterOrder.id, SCOPE)).rejects.toMatchObject({ statusCode: 404 });
    // Y su dueña sí la alcanza, que es lo que distingue una frontera de un muro.
    await expect(archiveGarnishment(sisterOrder.id, SISTER_SCOPE)).resolves.toMatchObject({ id: sisterOrder.id });
  });
});

describe('la orden que hoy no retendría nada no se da de alta', () => {
  it('contra un empleado mexicano se niega nombrando la compuerta de país', async () => {
    await expect(
      recordGarnishment({ ...SUPPORT_ORDER, employee_id: MEXICAN_EMPLOYEE }, SCOPE)
    ).rejects.toThrow(/runs only for US employees/);
  });

  it('y `pension_alimenticia` se niega aunque el empleado sea estadounidense', async () => {
    await expect(
      recordGarnishment({ ...SUPPORT_ORDER, type: 'pension_alimenticia' }, SCOPE)
    ).rejects.toThrow(/CCPA Title III caps/);
  });
});

describe('la 084 impide por SQL lo que el servicio impide por frase', () => {
  const byHandSql = (type: string, metadata: string | null) =>
    query(
      `INSERT INTO garnishments (employee_id, garnishment_type, priority, amount_type, amount_value, start_date, is_active, metadata)
       VALUES ($1,$2,1,'fixed',0,'2020-01-01',true,$3::jsonb)`,
      [EMPLOYEE, type, metadata]
    );

  it('un embargo fiscal sin exención no se puede guardar ni a mano', async () => {
    await expect(byHandSql('tax_levy_federal', '{}')).rejects.toMatchObject({ code: '23514' });
  });

  it('NI CON LA LLAVE PUESTA Y EL VALOR NULO, que es lo que una prueba de existencia dejaría pasar', async () => {
    // `'{"exempt_amount": null}'::jsonb ? 'exempt_amount'` es CIERTO, y el
    // motor leería SQL NULL de ahí y retendría el disponible entero. Éste es
    // el caso por el que la restricción mira el TIPO del valor.
    await expect(byHandSql('tax_levy_federal', '{"exempt_amount": null}')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('ni con `metadata` en NULL, que es lo que un CHECK sin NOT NULL admitiría', async () => {
    // Un CHECK se CUMPLE cuando su expresión evalúa NULL. Sin el NOT NULL de
    // la 084 este INSERT pasaría y la orden retendría el cheque entero.
    await expect(byHandSql('tax_levy_federal', null)).rejects.toMatchObject({ code: '23502' });
  });

  it('una manutención sin sus dos respuestas tampoco', async () => {
    await expect(byHandSql('child_support', '{"supports_second_family": true}')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('y un «yes» donde el motor espera un booleano se rechaza al guardar, no dentro de una corrida', async () => {
    // `(metadata ->> 'supports_second_family')::boolean` revienta con 22P02
    // sobre un valor así, y reventaría EN MITAD del cálculo de una nómina.
    await expect(
      byHandSql('child_support', '{"supports_second_family": "yes", "arrears_over_12_weeks": false}')
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('la exención admite número y cadena, porque el árbol ya persiste las dos', async () => {
    await clearOrders();
    await expect(byHandSql('tax_levy_federal', '{"exempt_amount": "200"}')).resolves.toBeTruthy();
    await expect(byHandSql('tax_levy_federal', '{"exempt_amount": 200}')).resolves.toBeTruthy();
    await clearOrders();
  });
});

describe('la misma orden judicial no se archiva dos veces en la tabla', () => {
  it('dar de alta dos veces el mismo expediente choca en vez de doblar la retención', async () => {
    await clearOrders();
    const withCaseNumber = { ...SUPPORT_ORDER, case_number: '2026-DF-004417' };
    await recordGarnishment(withCaseNumber, SCOPE);
    await expect(recordGarnishment(withCaseNumber, SCOPE)).rejects.toMatchObject({ code: '23505' });
    await clearOrders();
  });
});
