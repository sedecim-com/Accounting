import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { ivaStillParked } from '../../src/services/accounting/iva-cash-basis.js';
import { checkReopenedPeriods } from '../../src/ai/doctor-service.js';
import {
  reopenClosedPeriod,
  restorePeriodStatus,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * LOS SILENCIOS QUE LA AUDITORÍA ENCONTRÓ.
 *
 * No son errores: son respuestas plausibles que significan otra cosa. Un
 * tope de cero que en realidad quiere decir «falta sembrar la entidad», y un
 * periodo abierto que en realidad quiere decir «alguien lo reabrió y el
 * proceso murió antes de devolverlo». Los dos pasan inadvertidos hasta que
 * el daño ya está en los libros.
 */

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Silencios');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('un tope de cero no puede significar dos cosas', () => {
  it('una entidad sin capa semántica lo dice, en vez de liberar cero', async () => {
    // El backfill del histórico acepta la cuenta por su CÓDIGO heredado,
    // pero ivaStillParked la resuelve por ROL. En una entidad sin roles el
    // IVA se aparcaba y no se liberaba nunca — y el pago no se quejaba,
    // simplemente no movía nada.
    const org = await query<{ id: string }>(
      `SELECT id FROM organizations WHERE tenant_id = $1 LIMIT 1`, [f.tenantId]
    );
    const desnuda = uuidv4();
    await query(
      `INSERT INTO legal_entities (
         id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type,
         incorporation_country, functional_currency, accounting_standard, is_active
       ) VALUES ($1,$2,$3,'Sin roles','sapi','SIN010101SS1','rfc','MX','MXN','mx_nif',true)`,
      [desnuda, org.rows[0].id, f.tenantId]
    );

    await expect(
      withTransaction((client) => ivaStillParked(client, 'received', desnuda, uuidv4()))
    ).rejects.toThrow(/no tiene sembrada la capa semántica/);
  });

  it('una entidad sembrada devuelve cero sin quejarse: ahí sí no hay nada aparcado', async () => {
    const parked = await withTransaction((client) =>
      ivaStillParked(client, 'received', f.entityId, uuidv4())
    );
    expect(parked).toBe('0.0000');
  });
});

describe('un periodo reabierto que nadie devolvió', () => {
  it('doctor lo ve, porque la bitácora guarda la reapertura', async () => {
    const periodo = f.periodos[6];
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [periodo]);

    // Se reabre y el proceso "muere": nadie llama a restorePeriodStatus.
    await reopenClosedPeriod(f.entityId, periodo, f.userId, 'prueba de reapertura huérfana');

    const check = await checkReopenedPeriods();
    expect(check.level).toBe('warn');
    expect(check.detail).toMatch(/reopened and never closed again/);
    expect(check.fix).toMatch(/period close/);
  });

  it('en cuanto se devuelve a su cierre, deja de aparecer', async () => {
    const periodo = f.periodos[6];
    await restorePeriodStatus(f.entityId, periodo, 'soft_close', f.userId, 'restaurado');

    const check = await checkReopenedPeriods();
    expect(check.level).toBe('ok');
    expect(check.detail).toMatch(/none left open/);
  });
});
