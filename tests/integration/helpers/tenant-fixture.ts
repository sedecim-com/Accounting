import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, enterTenant } from '../../../src/database/connection.js';
import { ensureEntityAccounting } from '../../../src/services/accounting/entity-accounting.js';

/**
 * Inquilino desechable por archivo de prueba: tenant, organización, entidad,
 * usuario, ejercicio con doce periodos y la contabilidad sembrada (catálogo
 * base + account_roles).
 *
 * Sustituye a los UUID hardcodeados de scripts/e2e-*.ts: cada archivo trabaja
 * sobre su propio inquilino, así que las pruebas no se pisan ni dependen de
 * que alguien haya corrido `npm run seed` antes.
 */
export interface Fixture {
  tenantId: string;
  entityId: string;
  userId: string;
  fiscalYearId: string;
  /** Periodos por número de mes (1..12). */
  periodos: Record<number, string>;
  /** id de cuenta por código, ya sembrado. */
  cuentas: Record<string, string>;
  /** id de cuenta por rol semántico (cxc, cxp, banco…). */
  roles: Record<string, string>;
}

export async function crearInquilino(nombre = 'Prueba de integración'): Promise<Fixture> {
  const tenantId = uuidv4();
  const entityId = uuidv4();
  const userId = uuidv4();
  const fiscalYearId = uuidv4();
  const anio = 2026;

  // El alta corre ANTES de fijar el contexto: crea el propio inquilino.
  const sufijo = tenantId.replace(/-/g, '').slice(0, 12);
  await query(
    `INSERT INTO tenants (id, name, subdomain, schema_name, plan, is_active)
     VALUES ($1, $2, $3, $4, 'enterprise', true)`,
    [tenantId, nombre, `it-${sufijo}`, `it_${sufijo}`]
  );
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Prueba', 'Integración',
      '["owner"]'::jsonb, '["*"]'::jsonb, $4::jsonb, true)`,
    [userId, tenantId, `it-${userId.slice(0, 8)}@example.test`, JSON.stringify([entityId])]
  );

  const orgId = uuidv4();
  await query(
    `INSERT INTO organizations (id, tenant_id, name, type)
     VALUES ($1, $2, $3, 'holding')`,
    [orgId, tenantId, nombre]
  );
  await query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
      incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
     VALUES ($1, $2, $3, $4, 'corporation', $5, 'rfc', 'MX', 'MXN', 'mx_nif', 1, true)`,
    [entityId, tenantId, orgId, nombre, 'XAXX010101000']
  );

  enterTenant(tenantId);

  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, $3, $4, $5, true, 'open')`,
    [fiscalYearId, entityId, anio, `${anio}-01-01`, `${anio}-12-31`]
  );

  const periodos: Record<number, string> = {};
  for (let m = 1; m <= 12; m++) {
    const id = uuidv4();
    const fin = new Date(Date.UTC(anio, m, 0)).toISOString().slice(0, 10);
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
        start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [id, fiscalYearId, entityId, m, `Periodo ${m}/${anio}`,
       `${anio}-${String(m).padStart(2, '0')}-01`, fin]
    );
    periodos[m] = id;
  }

  await withTransaction((client) =>
    ensureEntityAccounting(entityId, tenantId, userId, { client })
  );

  const cuentas = Object.fromEntries(
    (await query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1', [entityId]
    )).rows.map((r) => [r.code, r.id])
  );
  const roles = Object.fromEntries(
    (await query<{ role: string; account_id: string }>(
      'SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL',
      [entityId]
    )).rows.map((r) => [r.role, r.account_id])
  );

  return { tenantId, entityId, userId, fiscalYearId, periodos, cuentas, roles };
}

/**
 * UNA SEGUNDA ENTIDAD LEGAL DENTRO DEL MISMO INQUILINO.
 *
 * `crearInquilino` crea un inquilino nuevo cada vez, así que dos fixtures son
 * dos inquilinos: cruzar de uno a otro cruza la frontera que RLS SÍ defiende,
 * y una prueba escrita así puede pasar por el motivo equivocado.
 *
 * El eje que defiende TEN-1 es el otro: dos entidades legales del MISMO
 * inquilino —una holding con varias sociedades, que es el caso normal en
 * México—. Ahí RLS no acota nada, porque su predicado es el inquilino. Una
 * prueba de frontera de entidad tiene que correr sobre este par o no demuestra
 * lo que dice demostrar.
 */
export async function crearEntidadHermana(
  padre: Fixture,
  nombre = 'Entidad hermana'
): Promise<Fixture> {
  const entityId = uuidv4();
  const userId = uuidv4();
  const fiscalYearId = uuidv4();
  const anio = 2026;

  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Prueba', 'Hermana',
      '["owner"]'::jsonb, '["*"]'::jsonb, $4::jsonb, true)`,
    [userId, padre.tenantId, `it-${userId.slice(0, 8)}@example.test`, JSON.stringify([entityId])]
  );

  const orgId = uuidv4();
  await query(
    `INSERT INTO organizations (id, tenant_id, name, type)
     VALUES ($1, $2, $3, 'holding')`,
    [orgId, padre.tenantId, nombre]
  );
  await query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
      incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
     VALUES ($1, $2, $3, $4, 'corporation', $5, 'rfc', 'MX', 'MXN', 'mx_nif', 1, true)`,
    [entityId, padre.tenantId, orgId, nombre, 'XAXX010101000']
  );

  enterTenant(padre.tenantId);

  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, $3, $4, $5, true, 'open')`,
    [fiscalYearId, entityId, anio, `${anio}-01-01`, `${anio}-12-31`]
  );

  const periodos: Record<number, string> = {};
  for (let m = 1; m <= 12; m++) {
    const id = uuidv4();
    const fin = new Date(Date.UTC(anio, m, 0)).toISOString().slice(0, 10);
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
        start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [id, fiscalYearId, entityId, m, `Periodo ${m}/${anio}`,
       `${anio}-${String(m).padStart(2, '0')}-01`, fin]
    );
    periodos[m] = id;
  }

  await withTransaction((client) =>
    ensureEntityAccounting(entityId, padre.tenantId, userId, { client })
  );

  const cuentas = Object.fromEntries(
    (await query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1', [entityId]
    )).rows.map((r) => [r.code, r.id])
  );
  const roles = Object.fromEntries(
    (await query<{ role: string; account_id: string }>(
      'SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL',
      [entityId]
    )).rows.map((r) => [r.role, r.account_id])
  );

  return { tenantId: padre.tenantId, entityId, userId, fiscalYearId, periodos, cuentas, roles };
}

/** Fecha dentro de un periodo abierto del ejercicio del fixture. */
export function fechaEnPeriodo(mes = 8, dia = 15): Date {
  return new Date(Date.UTC(2026, mes - 1, dia));
}

/** Saldo acumulado de una cuenta en un periodo (debe − haber). */
export async function saldoDe(cuentaId: string, periodoId: string): Promise<number> {
  const { rows } = await query<{ s: string }>(
    `SELECT COALESCE(debit_total - credit_total, 0)::text AS s
     FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
    [cuentaId, periodoId]
  );
  return Number(rows[0]?.s ?? 0);
}
