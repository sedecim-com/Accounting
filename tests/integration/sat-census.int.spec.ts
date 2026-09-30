import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  emptyReading, loadCensus, type CensusFile, type CensusReading, type CensusRow,
} from '../../src/services/sat-census/census.js';
import { NotFoundError } from '../../src/utils/errors.js';

// MNE-001-096 (#312): the census of the period lands in sat_cfdi_census and
// each file loaded leaves its row in sat_census_loads (migration 163). A
// reload refreshes and does not duplicate, an XML never erases the status a
// metadata file stated, a cancellation is never undone by an older file, the
// same UUID can be in the census of two entities, and an entity of another
// tenant is a 404 that writes nothing.

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
const FILE: CensusFile = { source: 'metadata', fileName: 'agosto.txt', sha256: 'a'.repeat(64), loadedBy: null };
const of = (...rows: CensusRow[]): CensusReading => ({ ...emptyReading(), rows });
const scopeOf = (f: Fixture) => entityScope(f.tenantId, f.entityId);

async function census(entityId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT cfdi_uuid::text AS uuid, direction, sat_status, cancelled_at::text AS cancelled_at, source,
            issued_at::text AS issued_at, amount::text AS amount, last_load_id::text AS last_load_id
       FROM sat_cfdi_census WHERE entity_id = $1 ORDER BY cfdi_uuid`,
    [entityId]
  );
  return rows;
}

describe('loadCensus', () => {
  it('inserts once, refreshes on reload, and keeps what a later source cannot contradict', async () => {
    const other = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-000000000002', cfdiType: 'P' as const };
    expect(await loadCensus(scopeOf(a), FILE, of(base, other))).toMatchObject({ inserted: 2, refreshed: 0 });
    expect(await loadCensus(scopeOf(a), FILE, of(base))).toMatchObject({ inserted: 0, refreshed: 1 });

    // The ZIP of XML says nothing about status: it does not erase «current».
    await loadCensus(scopeOf(a), { ...FILE, source: 'xml' }, of({ ...base, satStatus: null, source: 'xml' }));
    expect((await census(a.entityId))[0]).toMatchObject({ sat_status: 'current', source: 'metadata' });

    // A newer metadata file cancels; an older one loaded afterwards does not revive it.
    await loadCensus(scopeOf(a), FILE, of({ ...base, satStatus: 'cancelled', cancelledAt: '2026-08-20 09:00:00' }));
    const last = await loadCensus(scopeOf(a), FILE, of(base));
    const rows = await census(a.entityId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      uuid: UUID, direction: 'received', sat_status: 'cancelled', cancelled_at: '2026-08-20 09:00:00',
      issued_at: '2026-08-15 10:00:00', amount: '1160.000000', last_load_id: last.loadId,
    });
  });

  it('fills the cancellation date a first cancelled load could not read', async () => {
    const u = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-000000000003' };
    await loadCensus(scopeOf(a), FILE, of({ ...u, satStatus: 'cancelled', cancelledAt: null }));
    await loadCensus(scopeOf(a), FILE, of({ ...u, satStatus: 'cancelled', cancelledAt: '2026-08-20 09:00:00' }));
    const row = (await census(a.entityId)).find((r) => r.uuid === u.uuid);
    expect(row).toMatchObject({ sat_status: 'cancelled', cancelled_at: '2026-08-20 09:00:00' });
  });

  it('lets the SAT metadata refresh what a ZIP of XML wrote first, and not the other way round', async () => {
    const u = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-000000000004', source: 'xml' as const, satStatus: null };
    await loadCensus(scopeOf(a), { ...FILE, source: 'xml' }, of({ ...u, amount: '999.00' }));
    await loadCensus(scopeOf(a), FILE, of({ ...u, source: 'metadata', satStatus: 'current', amount: '1160.00' }));
    await loadCensus(scopeOf(a), { ...FILE, source: 'xml' }, of({ ...u, amount: '5.00' }));
    const row = (await census(a.entityId)).find((r) => r.uuid === u.uuid);
    expect(row).toMatchObject({ amount: '1160.000000', sat_status: 'current', source: 'xml' });
  });

  it('records what each file covered, so «not loaded» is not «nothing exists»', async () => {
    const issued = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-000000000005', direction: 'issued' as const,
      issuerRfc: 'XAXX010101000', receiverRfc: 'SIN060101AB1', issuedAt: '2026-08-31 23:00:00' };
    const reading = { ...of(base, issued), foreign: 2 };
    reading.invalid.push({ where: 'agosto.txt:9', key: 'ingest.census.invalid.field', params: { field: 'RFC' } });
    const { loadId } = await loadCensus(scopeOf(a), { ...FILE, loadedBy: a.userId }, reading);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT entity_id::text AS entity_id, source, file_name, file_sha256, issued_count, received_count,
              first_issued_at::text AS first_at, last_issued_at::text AS last_at, foreign_count, invalid_count,
              loaded_by::text AS loaded_by
         FROM sat_census_loads WHERE id = $1`,
      [loadId]
    );
    expect(rows).toEqual([{
      entity_id: a.entityId, source: 'metadata', file_name: 'agosto.txt', file_sha256: 'a'.repeat(64),
      issued_count: 1, received_count: 1, first_at: '2026-08-15 10:00:00', last_at: '2026-08-31 23:00:00',
      foreign_count: 2, invalid_count: 1, loaded_by: a.userId,
    }]);

    // An empty file is still a load: it happened and saw nothing.
    const empty = await loadCensus(scopeOf(a), FILE, emptyReading());
    const e = await query('SELECT issued_count, first_issued_at FROM sat_census_loads WHERE id = $1', [empty.loadId]);
    expect(e.rows).toEqual([{ issued_count: 0, first_issued_at: null }]);
  });

  it('takes the same UUID twice in one file once, and keeps the other entity apart', async () => {
    const cancelled = { ...base, satStatus: 'cancelled' as const, cancelledAt: '2026-08-21 09:00:00' };
    expect(await loadCensus(scopeOf(b), FILE, of(cancelled, { ...base, direction: 'issued' })))
      .toMatchObject({ inserted: 1, refreshed: 0 });
    const rows = await census(b.entityId);
    expect(rows).toEqual([expect.objectContaining({ uuid: UUID, sat_status: 'cancelled' })]);
  });

  it('refuses an entity of another tenant with a 404 and writes nothing', async () => {
    const intruder = { ...base, uuid: 'aaaaaaaa-0960-4000-8000-0000000000ff' };
    const before = await census(a.entityId);
    const loads = async (): Promise<unknown> =>
      (await query('SELECT count(*)::int AS n FROM sat_census_loads WHERE entity_id = $1', [a.entityId])).rows[0];
    const loadsBefore = await loads();
    await expect(loadCensus(entityScope(b.tenantId, a.entityId), FILE, of(intruder))).rejects.toBeInstanceOf(NotFoundError);
    expect(await census(a.entityId)).toEqual(before);
    expect(await loads()).toEqual(loadsBefore);
  });
});
