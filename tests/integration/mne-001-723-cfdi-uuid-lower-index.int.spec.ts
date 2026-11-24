import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every statement the product sends is kept, so the plan asked of Postgres
// below is the plan of the reader's own SQL and not of a copy written here.
const sent = vi.hoisted(() => ({ statements: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/connection.js')>();
  const query = ((sql: string, params?: unknown[]) => {
    sent.statements.push({ sql, params: params ?? [] });
    return real.query(sql, params);
  }) as typeof real.query;
  return { ...real, query };
});

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { getCfdiByUuid, getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';

// ============================================================
// MNE-001-723 (#853) · THE LOOKUP OF A CFDI BY ITS UUID IS AN INDEX PROBE.
//
// A lookup that compares lower(cfdi_uuid) cannot use the unique index on
// (entity_id, cfdi_uuid) past entity_id: Postgres read every row of the
// entity and kept one. Migration 345 gives the mirror (xml_documents) and the
// classifier's trail (cfdi_classifications) an index on (entity_id,
// lower(cfdi_uuid)). The spec asks Postgres how it runs each lookup and
// counts the rows it read from the table.
//
// In each table two entities of one tenant hold 20,001 rows each, enough for
// the planner to choose by cost; enable_seqscan is left as it is. Synthetic
// rows: the generic RFCs and made-up UUIDs.
// ============================================================

const MIRROR_INDEX = 'idx_xml_documents_entity_cfdi_lower';
const TRAIL_INDEX = 'idx_cfdi_classifications_entity_cfdi_lower';
const MIGRATION = path.join(
  __dirname, '..', '..', 'src', 'database', 'migrations', '345_a_cfdi_lookup_in_any_case_probes_an_index.sql'
);
const FILLERS = 20_000;
const STORED = 'C3D4E5F6-A7B8-4C9D-8E0F-A1B2C3D4E5F6';
const LOWER = STORED.toLowerCase();
/** Stored twice, once in each case, in the third entity. */
const TWIN = 'D4E5F6A7-B8C9-4D0E-9F1A-B2C3D4E5F6A7';

let f: Fixture;
let sibling: Fixture;
let twice: Fixture;

const MIRROR_COLUMNS = `entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, xml_content, xml_hash, import_source`;
const A_CFDI = `'4.0', '2026-03-10', 'AAA010101AAA', 'XAXX010101000', 100, 116, '<cfdi:Comprobante/>'`;
const TRAIL_COLUMNS = `tenant_id, entity_id, cfdi_uuid, tipo_comprobante, direction, case_id, facts, status`;
const A_TRAIL = `'I', 'recibido', 'synthetic_case', '{}'::jsonb, 'ready'`;

/** One synthetic CFDI of 100.00 + 16.00, stored under `uuid` exactly as given; its id. */
async function store(fx: Fixture, uuid: string): Promise<string> {
  const row = await query<{ id: string }>(
    `INSERT INTO xml_documents (${MIRROR_COLUMNS})
     VALUES ($1::uuid, 'cfdi_ingreso', $2::text, ${A_CFDI}, md5($1::uuid::text || $2::text), 'manual_upload') RETURNING id`,
    [fx.entityId, uuid]
  );
  return row.rows[0].id;
}

/** `FILLERS` more rows of the entity in each table, one statement per table, each under its own upper-case UUID. */
async function fill(fx: Fixture): Promise<void> {
  await query(
    `INSERT INTO xml_documents (${MIRROR_COLUMNS})
     SELECT $1::uuid, 'cfdi_ingreso', upper(md5($1::uuid::text || n::text)::uuid::text), ${A_CFDI},
            md5('filler' || $1::uuid::text || n::text), 'manual_upload'
       FROM generate_series(1, $2::int) AS n`,
    [fx.entityId, FILLERS]
  );
  await query(
    `INSERT INTO cfdi_classifications (${TRAIL_COLUMNS})
     SELECT $3::uuid, $1::uuid, upper(md5($1::uuid::text || n::text)::uuid::text), ${A_TRAIL}
       FROM generate_series(1, $2::int) AS n`,
    [fx.entityId, FILLERS, fx.tenantId]
  );
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}
interface Explained {
  nodes: PlanNode[];
  /** The whole plan, shown when an assertion on it fails. */
  text: string;
}

const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

/** How Postgres ran one statement. */
async function explain(sql: string, params: unknown[]): Promise<Explained> {
  const explained = await query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    params
  );
  const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
  return { nodes: flatten(plan), text: JSON.stringify(plan, null, 1) };
}

/** How Postgres ran the statement a reader sent on `table`: the reader runs first, and its own SQL is explained. */
async function explainReader(read: () => Promise<unknown>, table: string): Promise<Explained> {
  sent.statements.length = 0;
  await read().catch(() => undefined);
  const lookup = sent.statements.find((s) => s.sql.includes(`FROM ${table}`));
  if (!lookup) throw new Error(`the reader sent no statement on ${table}`);
  return explain(lookup.sql, lookup.params);
}

/** Rows of `table` the plan fetched, kept or thrown away. */
const rowsRead = (nodes: PlanNode[], table: string): number =>
  nodes
    .filter((n) => n['Relation Name'] === table)
    .reduce(
      (sum, n) =>
        sum +
        ((n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) *
          (n['Actual Loops'] ?? 1),
      0
    );

/** One probe of `index` with both columns in its condition, no sequential scan of `table`, and one row read. */
function expectOneProbe({ nodes, text }: Explained, table: string, index: string): void {
  const probes = nodes.filter((n) => n['Index Name'] === index);
  expect(probes, text).toHaveLength(1);
  // Both columns are in the condition of the probe, so neither is a filter over fetched rows.
  expect(probes[0]['Index Cond'], text).toMatch(/entity_id = .*lower\(\(cfdi_uuid\)::text\) = /);
  expect(nodes.filter((n) => n['Relation Name'] === table && n['Node Type'] === 'Seq Scan'), text).toEqual([]);
  // Before 345: 20,001, the 20,000 fillers thrown away and the one kept.
  expect(rowsRead(nodes, table), text).toBe(1);
}

let ownId: string;
let siblingId: string;

beforeAll(async () => {
  f = await crearInquilino('723 uuid lower index');
  sibling = await crearEntidadHermana(f, '723 the sibling');
  twice = await crearEntidadHermana(f, '723 the same uuid twice');
  await fill(f);
  await fill(sibling);
  ownId = await store(f, STORED);
  // The other side of the operation keeps the same folio, written in lower case.
  siblingId = await store(sibling, LOWER);
  await store(twice, TWIN);
  await store(twice, TWIN.toLowerCase());
  await query(
    `INSERT INTO cfdi_classifications (${TRAIL_COLUMNS}) VALUES ($1::uuid, $2::uuid, $3::text, ${A_TRAIL})`,
    [f.tenantId, f.entityId, STORED]
  );
  // The planner chooses by statistics; without this it would plan on those of
  // empty tables until autovacuum came by.
  await query('ANALYZE xml_documents');
  await query('ANALYZE cfdi_classifications');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-723 · migration 345 gives the mirror and the trail an index on (entity_id, lower(cfdi_uuid))', () => {
  it.each([['xml_documents', MIRROR_INDEX], ['cfdi_classifications', TRAIL_INDEX]])(
    'the index of %s exists, is valid, covers both columns in that order and is not unique',
    async (table, index) => {
      const found = await query<{ definition: string; indisunique: boolean; indisvalid: boolean }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisunique, i.indisvalid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = $1::regclass AND c.relname = $2`,
        [table, index]
      );
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0].definition).toMatch(/USING btree \(entity_id, lower\(\(cfdi_uuid\)::text\)\)$/);
      expect([found.rows[0].indisunique, found.rows[0].indisvalid]).toEqual([false, true]);
    }
  );

  it('the file is idempotent: run again over the migrated database, it builds nothing and fails nothing', async () => {
    await query(fs.readFileSync(MIGRATION, 'utf-8'));
    const lowered = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename IN ('xml_documents', 'cfdi_classifications') AND indexdef LIKE '%lower((cfdi_uuid)::text)%'`
    );
    expect(lowered.rows.map((r) => r.indexname).sort()).toEqual([TRAIL_INDEX, MIRROR_INDEX]);
  });
});

describe('MNE-001-723 · the mirror: getCfdiByUuid probes the index', () => {
  it(`of the entity's ${FILLERS + 1} CFDIs it reads one`, async () => {
    expect((await getCfdiByUuid(f.entityId, LOWER)).id).toBe(ownId);
    expectOneProbe(await explainReader(() => getCfdiByUuid(f.entityId, LOWER), 'xml_documents'), 'xml_documents', MIRROR_INDEX);
  });

  it('the entity bounds the probe: the sibling that holds the same folio in the other case reads its own row', async () => {
    expect((await getCfdiByUuid(sibling.entityId, STORED)).id).toBe(siblingId);
    expectOneProbe(await explainReader(() => getCfdiByUuid(sibling.entityId, STORED), 'xml_documents'), 'xml_documents', MIRROR_INDEX);
  });

  it('not unique: two rows that differ only by case are still stored, and the reader still refuses them by name', async () => {
    await expect(getCfdiByUuid(twice.entityId, TWIN)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: { key: 'cfdi.lookup.same_uuid_twice', params: { count: 2 } },
    });
  });
});

describe('MNE-001-723 · the trail: a lookup by lower(cfdi_uuid) probes the index', () => {
  // The predicate MNE-001-724 gives getClassificationTrail, written here
  // because on a tree without it the reader still compares the UUID exactly.
  const ANY_CASE = `SELECT cc.cfdi_uuid, cc.status FROM cfdi_classifications cc
      WHERE cc.entity_id = $1 AND lower(cc.cfdi_uuid) = lower($2)
      ORDER BY cc.cfdi_uuid COLLATE "C"`;

  it(`of the entity's ${FILLERS + 1} trails, the any-case predicate reads one`, async () => {
    const found = await query<{ cfdi_uuid: string }>(ANY_CASE, [f.entityId, LOWER]);
    expect(found.rows.map((r) => r.cfdi_uuid)).toEqual([STORED]);
    expectOneProbe(await explain(ANY_CASE, [f.entityId, LOWER]), 'cfdi_classifications', TRAIL_INDEX);
  });

  it('the entity bounds the probe: the sibling, which has no trail for that folio, reads none', async () => {
    const { nodes, text } = await explain(ANY_CASE, [sibling.entityId, LOWER]);
    expect(nodes.filter((n) => n['Index Name'] === TRAIL_INDEX), text).toHaveLength(1);
    expect(rowsRead(nodes, 'cfdi_classifications'), text).toBe(0);
  });

  it("getClassificationTrail's own statement reads one row, whichever of the two comparisons it sends", async () => {
    expect((await getClassificationTrail(f.entityId, STORED)).cfdi_uuid).toBe(STORED);
    const { nodes, text } = await explainReader(() => getClassificationTrail(f.entityId, STORED), 'cfdi_classifications');
    expect(rowsRead(nodes, 'cfdi_classifications'), text).toBe(1);
  });
});
