import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { exigirPar, fijarTipo, tipoParaConversion } from '../../src/services/fx/rate-service.js';
import { ConflictError } from '../../src/utils/errors.js';

/**
 * R4 · LA MONEDA EXTRANJERA, CONVERTIDA EN EL ORIGEN (NIF B-15).
 *
 * La aritmética vive en tests/services/fx/conversion.spec.ts sin base de
 * datos; ESTA suite prueba lo que solo Postgres puede atestiguar: que el
 * asiento en dólares NACE con sus cuatro columnas escritas (durante un año el
 * INSERT las tiró), que la regla dura corta ANTES del CHECK con un error
 * legible, que la 057 deja convivir DOF y FIX del mismo día, y que
 * `tipoParaConversion` falla cerrado en vez de tomar «el que haya».
 */

let f: Fixture;

// 100.55 USD × 18.2345 = 1833.478975 → 1833.4790 half-up a 4 decimales.
const FUNCIONAL = '1833.4790';
const linea = (over: Record<string, unknown>) => ({
  debit_amount: null,
  credit_amount: null,
  description: 'línea FX',
  ...over,
});

const asientoUsd = (lineas: Array<Record<string, unknown>>) =>
  createJournalEntry(
    f.entityId,
    fechaEnPeriodo(),
    JournalEntryType.STANDARD,
    'Asiento en USD',
    lineas as never,
    f.userId
  );

beforeAll(async () => {
  f = await crearInquilino('R4 moneda en el origen');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('el asiento en moneda extranjera nace con su origen', () => {
  it('createJournalEntry escribe las cuatro columnas FX y el mayor las devuelve', async () => {
    const e = await asientoUsd([
      linea({
        account_id: f.roles.banco,
        debit_amount: FUNCIONAL,
        currency_code: 'USD',
        foreign_debit: '100.55',
        exchange_rate: '18.2345',
      }),
      linea({
        account_id: f.roles.cxc,
        credit_amount: FUNCIONAL,
        currency_code: 'USD',
        foreign_credit: '100.55',
        exchange_rate: '18.2345',
      }),
    ]);

    const { rows } = await query<{
      currency_code: string;
      foreign_debit: string | null;
      foreign_credit: string | null;
      exchange_rate: string;
    }>(
      `SELECT currency_code, foreign_debit::text, foreign_credit::text, exchange_rate::text
       FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [e.id]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].currency_code).toBe('USD');
    expect(new Decimal(rows[0].foreign_debit as string).equals('100.55')).toBe(true);
    expect(rows[0].foreign_credit).toBeNull();
    // DECIMAL(19,10): las diez cifras sobreviven al viaje.
    expect(new Decimal(rows[0].exchange_rate).equals('18.2345')).toBe(true);
    expect(new Decimal(rows[1].foreign_credit as string).equals('100.55')).toBe(true);
  });

  it('la línea sin campos FX sigue naciendo con las cuatro columnas en NULL', async () => {
    const e = await asientoUsd([
      linea({ account_id: f.roles.banco, debit_amount: '250.0000' }),
      linea({ account_id: f.roles.cxc, credit_amount: '250.0000' }),
    ]);
    const { rows } = await query<{ currency_code: string | null; exchange_rate: string | null }>(
      `SELECT currency_code, exchange_rate::text FROM journal_entry_lines WHERE journal_entry_id = $1`,
      [e.id]
    );
    expect(rows.every((r) => r.currency_code === null && r.exchange_rate === null)).toBe(true);
  });

  it('REGLA DURA: moneda declarada sin origen se rechaza con error legible, no con el CHECK crudo', async () => {
    await expect(
      asientoUsd([
        linea({ account_id: f.roles.banco, debit_amount: FUNCIONAL, currency_code: 'USD' }),
        linea({ account_id: f.roles.cxc, credit_amount: FUNCIONAL, currency_code: 'USD' }),
      ])
    ).rejects.toThrow(/exchange_rate.*foreign_debit o foreign_credit|perdería su origen/);
  });

  it('la conversión que no casa se rechaza con los tres números', async () => {
    await expect(
      asientoUsd([
        linea({
          account_id: f.roles.banco,
          debit_amount: '1833.4789', // half-up dice 1833.4790
          currency_code: 'USD',
          foreign_debit: '100.55',
          exchange_rate: '18.2345',
        }),
        linea({
          account_id: f.roles.cxc,
          credit_amount: '1833.4789',
          currency_code: 'USD',
          foreign_credit: '100.55',
          exchange_rate: '18.2345',
        }),
      ])
    ).rejects.toThrow(/100\.55.*18\.2345.*1833\.4790/);
  });
});

describe('los defectos de siembra, reparados', () => {
  it('utilidad y pérdida cambiaria tienen cuenta PROPIA (4320/6320) y su rol apunta a ella', () => {
    // Antes: utilidad fundida con otros_ingresos en la 4300 (B-15 exige
    // identificar la fluctuación) y perdida apuntando a una 6300 que la
    // siembra no creaba (requireRole reventaba sobre catálogo importado).
    expect(f.cuentas['4320']).toBeDefined();
    expect(f.cuentas['6320']).toBeDefined();
    expect(f.roles.utilidad_cambiaria).toBe(f.cuentas['4320']);
    expect(f.roles.perdida_cambiaria).toBe(f.cuentas['6320']);
    expect(f.roles.otros_ingresos).toBe(f.cuentas['4300']);
  });
});

describe('las fuentes conviven y la política falla cerrado (057)', () => {
  const par = exigirPar('CHF/MXN');
  const fecha = '2026-08-15';

  it('DOF y FIX del mismo día y par conviven como filas distintas', async () => {
    await fijarTipo({ par, fecha, tasa: '20.1111', fuente: 'banco_mexico', creadoPor: f.userId });
    await fijarTipo({ par, fecha, tasa: '20.2222', fuente: 'dof', creadoPor: f.userId });
    const { rows } = await query<{ source: string; rate: string }>(
      `SELECT source, rate::text FROM exchange_rates
       WHERE from_currency = 'CHF' AND to_currency = 'MXN' AND effective_date = $1
       ORDER BY source`,
      [fecha]
    );
    expect(rows.map((r) => r.source)).toEqual(['banco_mexico', 'dof']);
  });

  it('repetir la MISMA fuente el mismo día se rechaza con conflicto legible', async () => {
    await expect(
      fijarTipo({ par, fecha, tasa: '20.9999', fuente: 'dof', creadoPor: f.userId })
    ).rejects.toThrow(ConflictError);
  });

  it('tipoParaConversion devuelve el de la fuente de la política (dof por omisión)', async () => {
    const t = await tipoParaConversion(f.tenantId, f.entityId, fecha, par);
    expect(t.fuente).toBe('dof');
    expect(new Decimal(t.tasa).equals('20.2222')).toBe(true);
  });

  it('FALLA CERRADO nombrando fuente y fecha cuando la fuente elegida no publicó ese día', async () => {
    // El FIX del 16 existe; el DOF no. «El que haya» sería elegir criterio
    // fiscal por el usuario, así que la conversión debe pararse y decirlo.
    await fijarTipo({ par, fecha: '2026-08-16', tasa: '20.3333', fuente: 'banco_mexico', creadoPor: f.userId });
    await expect(
      tipoParaConversion(f.tenantId, f.entityId, '2026-08-16', par)
    ).rejects.toThrow(/dof.*2026-08-16|2026-08-16.*dof/);
  });
});
