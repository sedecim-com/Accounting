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
    const e = await postEntry(f, '10.00', 'previo');
    expect(e.entry_number).toMatch(/^JE-2026-\d{5}$/);
    const emitido = Number(e.entry_number.split('-')[2]);

    // A second tenant with a folio of its own: the seeding below is scoped to
    // `f`, so it must not reach this one.
    const other = await crearInquilino('Serie y refresco R3, otro');
    const otherEntry = await postEntry(other, '3.00', 'otro');
    expect(otherEntry.entry_number).toBe('JE-2026-00001'); // its first folio of the year

    // Both annual counters are dropped, as on a base that never ran the 043
    // seeding: posting the folio above already moved the counter, so without
    // this the check below would hold whether the seeding ran or not.
    await query(
      `DELETE FROM entity_sequences WHERE entity_id = ANY($1::uuid[]) AND name = 'journal_entry_2026'`,
      [[f.entityId, other.entityId]]
    );

    await query(seed043For(f));
    expect(await je2026Counter(f)).toBe(emitido);
    expect(await je2026Counter(other)).toBeNull();

    // Y el siguiente folio del mismo ejercicio no colisiona con lo emitido.
    const siguiente = await postEntry(f, '5.00', 'siguiente');
    expect(Number(siguiente.entry_number.split('-')[2])).toBe(emitido + 1);

    // The other tenant gets its counter back from its own seeding, which leaves
    // it as the run's other specs may find it.
    await query(seed043For(other));
    expect(await je2026Counter(other)).toBe(1);
  });
});

const MIGRATION_043 = path.resolve('src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOP_HEADER = 'FOR t IN SELECT id FROM tenants LOOP';
const NUMBER_FILTER = /^( {5}WHERE \w+_number ~ '[^']+')$/gm;

/**
 * Migration 043's seeding block, read from the migration file and scoped to
 * one fixture. As shipped it walks every tenant of the database, and the
 * integration suite runs as a role that bypasses RLS, so each of its five
 * INSERT ... SELECT also read every tenant's folios: the work grew with the
 * whole suite, and under CI's load it outgrew the pool's 60 s statement
 * timeout (#846, #848). Two textual edits bound it to this fixture: the loop
 * visits only its tenant, and each INSERT's WHERE adds its entity (an indexed
 * column in all five tables). Everything else runs as the migration wrote it;
 * if the migration's text stops matching, the counts below fail loudly
 * instead of seeding the whole database again.
 */
function seed043For(fx: Fixture): string {
  expect(fx.tenantId).toMatch(UUID);
  expect(fx.entityId).toMatch(UUID);
  const sql = fs.readFileSync(MIGRATION_043, 'utf-8');
  expect(sql.split(LOOP_HEADER)).toHaveLength(2);
  expect(sql.match(NUMBER_FILTER)).toHaveLength(5);
  return sql
    .replace(LOOP_HEADER, `FOR t IN SELECT id FROM tenants WHERE id = '${fx.tenantId}' LOOP`)
    .replace(NUMBER_FILTER, `$1 AND entity_id = '${fx.entityId}'`);
}

async function je2026Counter(fx: Fixture): Promise<number | null> {
  const r = await query<{ value: string }>(
    `SELECT value FROM entity_sequences WHERE entity_id = $1 AND name = 'journal_entry_2026'`,
    [fx.entityId]
  );
  return r.rows.length ? Number(r.rows[0].value) : null;
}

function postEntry(fx: Fixture, amount: string, description: string) {
  return createJournalEntry(
    fx.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, description,
    [
      { account_id: fx.roles.banco, debit_amount: amount, credit_amount: null, description: 'c' },
      { account_id: fx.roles.cxc, debit_amount: null, credit_amount: amount, description: 'a' },
    ],
    fx.userId
  );
}

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
