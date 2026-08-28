import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  censarEntidadesSinRoles,
  rellenarRoles,
  actoresPorInquilino,
} from '../../src/services/accounting/account-roles-backfill.js';
import { postBillEntry } from '../../src/services/accounting/ar-ap-posting.js';
import { withTransaction } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * EL RELLENO QUE HACE FALTA PARA QUE UNA BASE DESPLEGADA SIGA FUNCIONANDO.
 *
 * `ensureEntityAccounting` siembra roles sólo para las entidades que crea él.
 * Toda entidad anterior —o dada de alta por SQL, o por el asistente, que aún
 * tiene su propio camino— no tiene una fila en `account_roles`. Mientras el
 * sistema resolvía por código literal daba igual; ahora la ingesta, el
 * posteo de AR/AP y los pagos resuelven POR ROL, y esas entidades mueren con
 * MISSING_ROLE_ACCOUNT en la primera factura.
 *
 * Lo que se demuestra aquí no es que el guion corra, sino que una entidad
 * que ANTES no podía contabilizar, DESPUÉS puede.
 */

let f: Fixture;
let entidadDesnuda: string;

beforeAll(async () => {
  f = await crearInquilino('Relleno de roles');

  // Una entidad como las de una base vieja: existe, tiene su organización,
  // y nadie le sembró nada.
  entidadDesnuda = uuidv4();
  const org = await query<{ id: string }>(
    `SELECT id FROM organizations WHERE tenant_id = $1 LIMIT 1`, [f.tenantId]
  );
  await query(
    `INSERT INTO legal_entities (
       id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type,
       incorporation_country, functional_currency, accounting_standard, is_active
     ) VALUES ($1,$2,$3,'Entidad heredada','sapi','HER010101HH1','rfc','MX','MXN','mx_nif',true)`,
    [entidadDesnuda, org.rows[0].id, f.tenantId]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('censo', () => {
  it('encuentra la entidad sin roles y no la que sí los tiene', async () => {
    const censo = await censarEntidadesSinRoles(f.tenantId);
    const ids = censo.map((e) => e.entity_id);
    expect(ids).toContain(entidadDesnuda);
    expect(ids, 'la entidad del fixture ya pasó por ensureEntityAccounting').not.toContain(f.entityId);
  });

  it('el censo no escribe nada', async () => {
    const antes = await query<{ n: string }>(`SELECT count(*) AS n FROM account_roles`);
    await censarEntidadesSinRoles(f.tenantId);
    const despues = await query<{ n: string }>(`SELECT count(*) AS n FROM account_roles`);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});

describe('lo que el relleno arregla', () => {
  it('antes del relleno, la entidad heredada NO puede contabilizar un gasto', async () => {
    await expect(
      withTransaction((client) =>
        postBillEntry(
          client,
          {
            id: uuidv4(), entity_id: entidadDesnuda, bill_number: 'BILL-X',
            vendor_id: uuidv4(), bill_date: fechaEnPeriodo(),
            subtotal: '100.00', tax_amount: '16.00', total_amount: '116.00',
            currency_code: 'MXN',
          } as never,
          [],
          f.userId
        )
      )
    ).rejects.toThrow();
  });

  it('el relleno le siembra cuentas y roles', async () => {
    const censo = (await censarEntidadesSinRoles(f.tenantId))
      .filter((e) => e.entity_id === entidadDesnuda);
    const actores = await actoresPorInquilino([f.tenantId]);
    const r = await rellenarRoles(censo, actores);

    expect(r.fallos).toEqual([]);
    expect(r.sembradas).toBe(1);
    expect(r.cuentasCreadas, 'la entidad no tenía ni catálogo').toBeGreaterThan(0);
    expect(r.rolesMapeados).toBeGreaterThan(10);

    const roles = await query<{ n: string }>(
      `SELECT count(*) AS n FROM account_roles WHERE entity_id = $1`, [entidadDesnuda]
    );
    expect(Number(roles.rows[0].n)).toBeGreaterThan(10);
  });

  it('después del relleno, la misma entidad ya no sale en el censo', async () => {
    const censo = await censarEntidadesSinRoles(f.tenantId);
    expect(censo.map((e) => e.entity_id)).not.toContain(entidadDesnuda);
  });

  it('correrlo dos veces no duplica cuentas ni roles', async () => {
    const antesCuentas = await query<{ n: string }>(
      `SELECT count(*) AS n FROM accounts WHERE entity_id = $1`, [entidadDesnuda]
    );
    const antesRoles = await query<{ n: string }>(
      `SELECT count(*) AS n FROM account_roles WHERE entity_id = $1`, [entidadDesnuda]
    );

    // Se fuerza una segunda pasada sobre la MISMA entidad, saltándose el
    // censo: es el escenario de alguien que corre el guion dos veces.
    const actores = await actoresPorInquilino([f.tenantId]);
    const r = await rellenarRoles(
      [{
        entity_id: entidadDesnuda, entity_name: 'Entidad heredada',
        tenant_id: f.tenantId, roles_actuales: 0, cuentas_actuales: 0,
      }],
      actores
    );
    expect(r.fallos).toEqual([]);
    expect(r.cuentasCreadas, 'la segunda pasada no crea nada').toBe(0);

    const despuesCuentas = await query<{ n: string }>(
      `SELECT count(*) AS n FROM accounts WHERE entity_id = $1`, [entidadDesnuda]
    );
    const despuesRoles = await query<{ n: string }>(
      `SELECT count(*) AS n FROM account_roles WHERE entity_id = $1`, [entidadDesnuda]
    );
    expect(despuesCuentas.rows[0].n).toBe(antesCuentas.rows[0].n);
    expect(despuesRoles.rows[0].n).toBe(antesRoles.rows[0].n);
  });
});

describe('un inquilino sin usuarios activos', () => {
  it('se reporta en vez de inventar un autor para las cuentas', async () => {
    // accounts.created_by es NOT NULL y tiene que ser un usuario real.
    const r = await rellenarRoles(
      [{
        entity_id: uuidv4(), entity_name: 'Huérfana',
        tenant_id: uuidv4(), roles_actuales: 0, cuentas_actuales: 0,
      }],
      new Map()
    );
    expect(r.sembradas).toBe(0);
    expect(r.fallos[0]).toMatch(/no tiene ningún usuario activo/);
  });
});
