import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { loadCensus, type CensusRow } from '../../src/services/sat-census/census.js';

// MNE-001-096 (#312): the census of the period lands in sat_cfdi_census
// (migration 163). A reload refreshes and does not duplicate, an XML never
// erases the status a metadata file stated, a cancellation is never undone by
// an older file, and the same UUID can be in the census of two entities.

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-096 census A');
  b = await crearInquilino('MNE-001-096 census B');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

const UUID = 'aaaaaaaa-0960-4000-8000-000000000001';
const base: CensusRow = {
  uuid: UUID, direction: 'received', cfdiType: 'I', issuerRfc: 'SIN060101AB1', receiverRfc: 'XAXX010101000',
  issuedAt: '2026-08-15 10:00:00', amount: '1160.00', satStatus: 'current', cancelledAt: null, source: 'metadata',
};

async function census(entityId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT cfdi_uuid::text AS uuid, direction, sat_status, cancelled_at::text AS cancelled_at, source,
            issued_at::text AS issued_at, amount::text AS amount
       FROM sat_cfdi_census WHERE entity_id = $1 ORDER BY cfdi_uuid`,
    [entityId]
  );
  return rows;
}

describe('loadCensus', () => {
  it('inserts once, refreshes on reload, and keeps what a later source cannot contradict', async () => {
    const other = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-000000000002', cfdiType: 'P' as const };
    expect(await loadCensus(a.entityId, [base, other])).toEqual({ inserted: 2, refreshed: 0 });
    expect(await loadCensus(a.entityId, [base])).toEqual({ inserted: 0, refreshed: 1 });

    // The ZIP of XML says nothing about status: it does not erase «current».
    await loadCensus(a.entityId, [{ ...base, satStatus: null, source: 'xml' }]);
    expect((await census(a.entityId))[0]).toMatchObject({ sat_status: 'current', source: 'metadata' });

    // A newer metadata file cancels; an older one loaded afterwards does not revive it.
    await loadCensus(a.entityId, [{ ...base, satStatus: 'cancelled', cancelledAt: '2026-08-20 09:00:00' }]);
    await loadCensus(a.entityId, [base]);
    const rows = await census(a.entityId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      uuid: UUID, direction: 'received', sat_status: 'cancelled', cancelled_at: '2026-08-20 09:00:00',
      issued_at: '2026-08-15 10:00:00', amount: '1160.000000',
    });
  });

  it('takes the same UUID twice in one file once, and keeps the other entity apart', async () => {
    const cancelled = { ...base, satStatus: 'cancelled' as const, cancelledAt: '2026-08-21 09:00:00' };
    expect(await loadCensus(b.entityId, [cancelled, { ...base, direction: 'issued' }])).toEqual({ inserted: 1, refreshed: 0 });
    const rows = await census(b.entityId);
    expect(rows).toEqual([expect.objectContaining({ uuid: UUID, sat_status: 'cancelled' })]);
    expect(await census(a.entityId)).toHaveLength(2);
  });
});
