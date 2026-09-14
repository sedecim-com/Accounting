import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculateFiniquito } from '../../src/services/payroll/mx/finiquito-calculator.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import payrollRouter from '../../src/api/rest/routes/payroll.js';

/**
 * T6 (#93) · EL PANEL ACEPTA CUALQUIER NÚMERO, Y DE AHÍ SALE DINERO.
 *
 * El panel es donde el despacho declara su criterio contable, y de varias de
 * sus claves sale dinero que se paga a una persona. `resolvePolicy` no valida
 * contra su propio catálogo: anota «[value outside the catalog]» y guarda.
 *
 * Un contador que teclea `prima_vacacional_pct 25` queriendo decir «25 %»
 * escribe 2.500 %. Y la de al lado, `dias_aguinaldo 5`, paga por debajo del
 * mínimo del art. 87 LFT — que no es un criterio del despacho, es la ley.
 *
 * Hay además una SEGUNDA puerta que ni siquiera pasa por el panel: la ruta
 * REST pasa `req.body` entero y el finiquito prefiere el campo del cuerpo
 * sobre la política.
 */

let f: Fixture;
let srv: Servidor;
const EMPLEADO = randomUUID();

const BAJA = {
  termination_date: '2026-12-31',
  last_paid_through: '2026-12-31',
  termination_reason: 'renuncia' as const,
};

beforeAll(async () => {
  f = await crearInquilino('T6 panel');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, sbc, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2019-01-01','MX','AAAA010101AAA', 528.77, 182500, 'active')`,
    [EMPLEADO, f.tenantId, f.entityId, `E-${EMPLEADO.slice(0, 8)}`]
  );
  srv = await levantar([['/payroll', payrollRouter]], {
    ...sesionDe(f),
    permissions: ['payroll:read', 'payroll:create', 'payroll:approve'],
  });
}, 180_000);

afterAll(async () => {
  await srv?.cerrar();
  await closeDatabase();
});

const ctx = (): { tenantId: string; entityId: string } => ({
  tenantId: f.tenantId,
  entityId: f.entityId,
});

/**
 * ORDEN DELIBERADO. `resolvePolicy` sólo resuelve una fila PENDIENTE, así que
 * una clave se contesta UNA vez por alcance: la del cuerpo va primero, con el
 * panel todavía en su valor por omisión, o no habría contra qué comparar.
 */
describe('el panel: lo que se escribe es lo que se paga', () => {
  /** 22 días de vacaciones del art. 76 × 500,00 diarios × 25 % legal. */
  const PRIMA_LEGAL = '2750.0000';

  it('el cuerpo de la petición no puede imponer un criterio, y se le dice', async () => {
    const legal = await calculateFiniquito({ employee_id: EMPLEADO, ...BAJA }, ctx());
    expect(legal.prima_vacacional_amount, 'el valor por omisión del panel').toBe(PRIMA_LEGAL);

    // Va por HTTP y no por la función: el tipo de TypeScript ya rechaza el
    // campo, pero un cliente HTTP no se compila. Lo que se afirma es lo que
    // ve ese cliente — y es un 422 que NOMBRA el campo, no un descarte mudo
    // que empiece a pagar otra cantidad sin que nadie se entere.
    const r = await pedir(srv, 'POST', '/payroll/finiquito', {
      employee_id: EMPLEADO,
      ...BAJA,
      prima_vacacional_pct: 25,
    });
    expect(r.status, `contestó ${r.status}`).toBe(422);
    expect(JSON.stringify(r.body), 'el 422 no nombra el campo').toMatch(/prima_vacacional_pct/);
  }, 120_000);

  it('y el calculador tampoco lo lee, aunque alguien se lo ponga en la mano', async () => {
    // DOS CAPAS, DOS MEDIDAS. La prueba de arriba mide el esquema de la ruta;
    // ésta mide el calculador. Se comprobó mutando: restaurar la preferencia
    // por el campo del cuerpo NO pone roja aquella —el 422 se dispara antes—,
    // así que sin esto la segunda puerta podría volver a abrirse en la capa de
    // abajo y ninguna conducta se enteraría.
    const conCampo = { employee_id: EMPLEADO, ...BAJA, prima_vacacional_pct: 25 };
    const r = await calculateFiniquito(conCampo as Parameters<typeof calculateFiniquito>[0], ctx());
    expect(r.prima_vacacional_amount, 'el calculador leyó el campo del cuerpo').toBe(PRIMA_LEGAL);
  }, 120_000);

  it('y el mismo cuerpo sin el campo sí calcula, al criterio del panel', async () => {
    const r = await pedir(srv, 'POST', '/payroll/finiquito', { employee_id: EMPLEADO, ...BAJA });
    expect(r.status, `contestó ${r.status}`).toBe(200);
    expect((r.body.data as { prima_vacacional_amount: string }).prima_vacacional_amount).toBe(PRIMA_LEGAL);
  }, 120_000);

  it('«25» por 25 % se rechaza EN EL TECLADO, y el mensaje dice por qué', async () => {
    // El contador teclea «25» leyendo la etiqueta «25 % — the legal minimum».
    // Antes se guardaba y pagaba 275.000,00 donde tocaban 2.750,00.
    await expect(resolvePolicy(ctx(), 'prima_vacacional_pct', '25', f.userId)).rejects.toThrow(
      /no puede pasar de 1/
    );
    // Y el mensaje explica que el techo es NUESTRO, no de la ley: un despacho
    // que de verdad pague más tiene que ensancharlo, no pelearse a ciegas.
    await expect(resolvePolicy(ctx(), 'prima_vacacional_pct', '25', f.userId)).rejects.toThrow(
      /art\. 80 LFT fija el mínimo y ningún máximo/
    );
    // La fila sigue pendiente: un rechazo no decide nada.
    const { rows } = await query<{ status: string }>(
      `SELECT status FROM policy_decisions WHERE tenant_id = $1 AND key = 'prima_vacacional_pct'`,
      [f.tenantId]
    );
    expect(rows[0].status).toBe('pending');
  }, 120_000);

  it('y una fila YA escrita fuera de dominio no llega a ser un importe', async () => {
    // La guarda de escritura sólo ve respuestas nuevas. Ésta entra por SQL
    // crudo, como entran las filas anteriores a la guarda y los `default_value`
    // sembrados desde un catálogo viejo.
    await query(
      `UPDATE policy_decisions SET status = 'resolved', resolved_value = '25'
        WHERE tenant_id = $1 AND key = 'prima_vacacional_pct'`,
      [f.tenantId]
    );
    await expect(calculateFiniquito({ employee_id: EMPLEADO, ...BAJA }, ctx())).rejects.toThrow(
      /no puede pasar de 1/
    );
    await query(
      `UPDATE policy_decisions SET status = 'pending', resolved_value = NULL
        WHERE tenant_id = $1 AND key = 'prima_vacacional_pct'`,
      [f.tenantId]
    );
  }, 120_000);

  it('«5» días de aguinaldo se rechaza contra el mínimo del art. 87, no contra una constante', async () => {
    // El mínimo legal son 15 días y NO es criterio del despacho: es la ley.
    // El panel lo acepta —es un número bien formado y positivo— y quien se
    // niega es el piso, que vive en `legal_parameters` con su fecha y su
    // fuente. Antes el finiquito pagaba con cinco días.
    await resolvePolicy(ctx(), 'dias_aguinaldo', '5', f.userId);
    await expect(calculateFiniquito({ employee_id: EMPLEADO, ...BAJA }, ctx())).rejects.toThrow(
      /la ley fija un mínimo de 15\.0000\b/
    );
  }, 120_000);

  it('el piso se mide a la fecha de la BAJA, y la ley cita su artículo', async () => {
    // El mensaje trae el fundamento porque quien lo lee tiene que poder
    // comprobarlo: es la diferencia entre «el sistema no me deja» y «el art.
    // 87 no te deja».
    await expect(calculateFiniquito({ employee_id: EMPLEADO, ...BAJA }, ctx())).rejects.toThrow(
      /LFT art\. 87/
    );
    // Y la fecha que manda es la del hecho, no la de hoy: la fila de la ley
    // rige desde 1970, así que una baja de cualquier año la encuentra.
    await expect(
      calculateFiniquito(
        { employee_id: EMPLEADO, termination_date: '2019-06-30', last_paid_through: '2019-06-30', termination_reason: 'renuncia' },
        ctx()
      )
    // El valor sale de la tabla TAL CUAL se guardó —'15.0000', el formato
    // uniforme de la casa—, y el ancla lo cierra por la derecha para que no
    // empareje con un 150 o un 15.5 futuros.
    ).rejects.toThrow(/mínimo de 15\.0000 a la fecha 2019-06-30\./);
  }, 120_000);
});
