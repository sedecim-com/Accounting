import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { nextEntityNumber } from '../../src/utils/sequence.js';
import {
  createJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import {
  refreshReportingViews,
  getReportingViewStatus,
} from '../../src/services/reporting/materialized-view-service.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * R3: LA SERIE POR EJERCICIO Y EL REFRESCO FUERA DEL POSTEO.
 *
 * (1) El folio lo fija la fecha del documento: años distintos son contadores
 * distintos, y la siembra de la 043 hace que la serie continúe desde los
 * folios ya emitidos en vez de arrancar en 1 y colisionar. (2) El posteo ya
 * no refresca las vistas globales: el contrato nuevo es «la vista puede
 * estar caduca y DECIRLO» (detector de deriva) + refresco callable.
 */

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Serie y refresco R3');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('la serie del folio por ejercicio', () => {
  it('años distintos son contadores distintos, y el año es el del documento', async () => {
    const nums = await withTransaction(async (client) => {
      const a = await nextEntityNumber(client, f.entityId, 'invoice', 'INV', '2026-12-31');
      const b = await nextEntityNumber(client, f.entityId, 'invoice', 'INV', '2027-01-02');
      const c = await nextEntityNumber(client, f.entityId, 'invoice', 'INV', '2026-01-15');
      return [a, b, c];
    });
    expect(nums[0]).toBe('INV-2026-00001');
    expect(nums[1]).toBe('INV-2027-00001');
    expect(nums[2]).toBe('INV-2026-00002'); // la serie 2026 continúa, no la 2027
  });

  it('la siembra de la 043 continúa la serie desde los folios reales emitidos', async () => {
    // Un folio del esquema viejo, emitido antes del cambio:
    const e = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'previo',
      [
        { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.00', description: 'a' },
      ],
      f.userId
    );
    expect(e.entry_number).toMatch(/^JE-2026-\d{5}$/);
    const emitido = Number(e.entry_number.split('-')[2]);

    // Re-ejecutar la siembra (es idempotente por GREATEST): el contador anual
    // debe quedar en el máximo observado, nunca por debajo.
    const siembra = fs.readFileSync(
      path.resolve('src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql'),
      'utf-8'
    );
    await query(siembra);
    const contador = await query<{ value: string }>(
      `SELECT value FROM entity_sequences WHERE entity_id = $1 AND name = 'journal_entry_2026'`,
      [f.entityId]
    );
    expect(Number(contador.rows[0].value)).toBeGreaterThanOrEqual(emitido);

    // Y el siguiente folio del mismo ejercicio no colisiona con lo emitido.
    const siguiente = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'siguiente',
      [
        { account_id: f.roles.banco, debit_amount: '5.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '5.00', description: 'a' },
      ],
      f.userId
    );
    expect(Number(siguiente.entry_number.split('-')[2])).toBeGreaterThan(emitido);
  });
});

describe('el refresco fuera del posteo', () => {
  it('postear NO refresca las vistas: la deriva se detecta y el callable la cierra', async () => {
    await refreshReportingViews({ concurrently: false });
    const antes = await getReportingViewStatus(f.entityId);
    expect(antes.every((v) => !v.is_stale)).toBe(true);

    await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'mueve la balanza',
      [
        { account_id: f.roles.banco, debit_amount: '77.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '77.00', description: 'a' },
      ],
      f.userId, { autoPost: true }
    );

    // Sin el trigger de la 004, la vista queda caduca — y lo DICE.
    const caduca = await getReportingViewStatus(f.entityId);
    expect(caduca.some((v) => v.is_stale)).toBe(true);

    await refreshReportingViews({ concurrently: false });
    const despues = await getReportingViewStatus(f.entityId);
    expect(despues.every((v) => !v.is_stale)).toBe(true);
  });
});
