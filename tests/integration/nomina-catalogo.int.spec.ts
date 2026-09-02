import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// EL SUELDO BRUTO NO SE CARGA A «DEVOLUCIONES SOBRE COMPRAS»
//
// Cuatro semillas escriben en el catálogo de la MISMA entidad y las que corren
// después se guardan de pisar a la anterior comparando CÓDIGOS. El catálogo de
// nómina pedía seis números que otra semilla ya había declarado con otro
// significado; la guarda hacía lo suyo —no crear la cuenta— y a continuación
// el bucket se mapeaba a la cuenta ajena que ocupaba ese número.
//
// No había excepción, ni fila de más, ni siquiera un índice que pudiera
// acusarlo: UNIQUE(code, entity_id) veía exactamente lo que exige, UNA cuenta
// con ese código. Por eso esta prueba no mira códigos, mira NOMBRES: el código
// era justamente lo que coincidía cuando el sistema estaba mal.
//
// Corre contra Postgres de verdad y sobre el alta completa —el mismo
// ensureEntityAccounting que usan el asistente init y entity-service— porque
// el fallo estaba en el ORDEN en que las tres semillas corren dentro de esa
// transacción, y ninguna de ellas por separado lo reproduce.
// ============================================================

/** bucket → nombre de la cuenta a la que apunta hoy. */
async function mapeoDeNomina(entityId: string): Promise<Record<string, string>> {
  const { rows } = await query<{ bucket: string; name: string }>(
    `SELECT m.bucket, a.name
       FROM payroll_account_mapping m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.entity_id = $1`,
    [entityId]
  );
  return Object.fromEntries(rows.map((r) => [r.bucket, r.name]));
}

describe('el catálogo de nómina de una entidad mexicana recién creada', () => {
  let f: Fixture;
  let mapeo: Record<string, string>;

  beforeAll(async () => {
    f = await crearInquilino('Nómina · colisión de catálogos');
    mapeo = await mapeoDeNomina(f.entityId);
  });

  it('manda el sueldo bruto a una cuenta de sueldos, no a una de devoluciones', () => {
    expect(mapeo.wages_expense).toBe('Sueldos y Salarios');
    expect(mapeo.wages_expense).not.toMatch(/[Dd]evolucion/);
  });

  it('carga el sueldo a una cuenta de gasto de naturaleza deudora', async () => {
    // El síntoma más caro de la colisión no era el nombre sino la NATURALEZA:
    // 5200 es un contra-costo de saldo acreedor, así que cargarle el sueldo
    // bruto restaba del costo en vez de sumar al gasto.
    const { rows } = await query<{ account_type: string; normal_balance: string; fs_category: string }>(
      `SELECT a.account_type, a.normal_balance, a.fs_category
         FROM payroll_account_mapping m
         JOIN accounts a ON a.id = m.account_id
        WHERE m.entity_id = $1 AND m.bucket = 'wages_expense'`,
      [f.entityId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_type: 'expense',
      normal_balance: 'debit',
      fs_category: 'operating_expenses',
    });
  });

  it('usa la MISMA cuenta que el rol sueldos_gasto del CFDI', async () => {
    // La nómina llega por dos caminos —la corrida de nómina y el CFDI de
    // nómina que se ingesta— y cada uno resuelve su cuenta por su lado:
    // payroll_account_mapping uno, account_roles el otro. Si no coinciden, el
    // gasto del ejercicio queda partido en dos cuentas y ningún estado de
    // resultados lo muestra completo.
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM payroll_account_mapping m
         JOIN account_roles r
           ON r.entity_id = m.entity_id AND r.account_id = m.account_id
        WHERE m.entity_id = $1 AND m.bucket = 'wages_expense'
          AND r.role = 'sueldos_gasto' AND r.qualifier IS NULL`,
      [f.entityId]
    );
    expect(rows[0].n).toBe('1');
  });

  it('no revuelve ningún pasivo de nómina con el de otra semilla', () => {
    // Los cuatro que la colisión repartía entre anticipos de clientes,
    // sueldos por pagar e IEPS.
    expect(mapeo.imss_payable).toBe('IMSS por Pagar');
    expect(mapeo.infonavit_payable).toBe('INFONAVIT por Pagar');
    expect(mapeo.garnishment_payable).toBe('Otras Retenciones de Nómina');
    expect(mapeo.benefits_payable).toBe('Prestaciones por Pagar');
  });

  it('deja cada bucket en una cuenta distinta', () => {
    // La forma de la colisión era que dos buckets acabaran compartiendo cuenta
    // con un rol ajeno; comprobar que ningún par de buckets se solapa la
    // detecta aunque los nombres cambien.
    const nombres = Object.values(mapeo);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it('no deja ningún bucket sin mapear en una entidad nacida aquí', async () => {
    const { rows } = await query<{ bucket: string }>(
      `SELECT bucket FROM payroll_account_mapping WHERE entity_id = $1`,
      [f.entityId]
    );
    const buckets = rows.map((r) => r.bucket).sort();
    expect(buckets).toEqual(
      [
        'benefits_payable', 'cash_payroll', 'garnishment_payable', 'imss_payable',
        'infonavit_payable', 'isr_payable', 'payroll_tax_expense', 'wages_expense',
      ]
    );
  });
});
