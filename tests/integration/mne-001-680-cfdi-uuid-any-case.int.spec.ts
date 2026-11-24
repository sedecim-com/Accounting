import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { getCfdiByUuid } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import { registerCfdiCommand } from '../../src/cli/cfdi-command.js';

// ============================================================
// MNE-001-680 (#853) · A CFDI IS FOUND BY ITS UUID IN ANY LETTER CASE.
//
// The ingestion stores the UUID as the XML carries it, and SAT's portal prints
// it in the other case. The lookup compared exactly, so a stored CFDI answered
// «not found». It now compares without case inside the entity, and when one
// entity holds two rows that differ only by case it names both and picks none.
// Synthetic rows, inserted by hand: the generic RFCs and made-up UUIDs.
// ============================================================

const STORED = 'A1B2C3D4-E5F6-4A7B-8C9D-E0F1A2B3C4D5';
const LOWER = STORED.toLowerCase();
const MIXED = 'a1B2c3D4-e5F6-4a7B-8c9D-e0F1a2B3c4D5';
/** Stored only in the sibling entity. */
const SIBLING_ONLY = 'B2C3D4E5-F6A7-4B8C-9D0E-F1A2B3C4D5E6';

let f: Fixture;
let sibling: Fixture;
let twice: Fixture;

/** A synthetic CFDI of 100.00 + 16.00 with one line, stored under `uuid` exactly as given. */
async function store(fx: Fixture, uuid: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, xml_content, xml_hash, import_source)
     VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', '2026-03-10', 'AAA010101AAA', 'XAXX010101000',
       100, 116, '<cfdi:Comprobante/>', $4, 'manual_upload')`,
    [id, fx.entityId, uuid, randomUUID().replace(/-/g, '')]
  );
  await query(
    `INSERT INTO xml_document_lines (xml_document_id, line_number, clave_prod_serv, clave_unidad,
       descripcion, cantidad, valor_unitario, importe)
     VALUES ($1, 1, '01010101', 'H87', 'synthetic line', 1, 100, 100)`,
    [id]
  );
  return id;
}

/** One `cfdi` command line in process; `said` is everything it printed or reported. */
async function cli(fx: Fixture, ...argv: string[]): Promise<{ exitCode?: number; said: string }> {
  const program = new Command('mnemosine').exitOverride();
  let exitCode: number | undefined;
  let said = '';
  const plain = (text: string) => text;
  const say = (chunk: unknown) => { said += String((chunk as Error)?.message ?? chunk); return true; };
  registerCfdiCommand(program, {
    palette: { dim: plain, bold: plain, cyan: plain, red: plain, green: plain, yellow: plain } as never,
    shutdown: (c: number) => { exitCode = c; }, reportError: say,
  });
  const streams = [vi.spyOn(process.stdout, 'write').mockImplementation(say), vi.spyOn(process.stderr, 'write').mockImplementation(say)];
  await program.parseAsync(['node', 'mnemosine', 'cfdi', ...argv, '--entity', fx.entityId, '--tenant', fx.tenantId])
    .finally(() => streams.forEach((stream) => stream.mockRestore()));
  return { exitCode, said };
}

let ownId: string;
let siblingId: string;

beforeAll(async () => {
  f = await crearInquilino('680 uuid any case');
  sibling = await crearEntidadHermana(f, '680 the sibling');
  twice = await crearEntidadHermana(f, '680 the same uuid twice');
  ownId = await store(f, STORED);
  // The other side of the operation keeps the same folio, written in lower case.
  siblingId = await store(sibling, LOWER);
  await store(sibling, SIBLING_ONLY);
  await store(twice, STORED);
  await store(twice, LOWER);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-680 · getCfdiByUuid compares the UUID without case, inside the entity', () => {
  it.each([['lower', LOWER], ['upper', STORED], ['mixed', MIXED]])(
    'finds the CFDI stored in upper case when the UUID is typed in %s case',
    async (_case, typed) => {
      const doc = await getCfdiByUuid(f.entityId, typed);
      expect([doc.id, doc.cfdi_uuid, doc.total]).toEqual([ownId, STORED, '116.0000']);
      expect(doc.lineas.map((l) => [l.line_number, l.importe])).toEqual([[1, '100.0000']]);
    }
  );

  it('stays inside the entity: the sibling holding the same folio is not a twin, and its other CFDI is not found', async () => {
    // Each entity reads its own row, whatever the case typed.
    expect((await getCfdiByUuid(sibling.entityId, STORED)).id).toBe(siblingId);
    expect((await getCfdiByUuid(f.entityId, LOWER)).id).toBe(ownId);
    for (const typed of [SIBLING_ONLY, SIBLING_ONLY.toLowerCase()]) {
      await expect(getCfdiByUuid(f.entityId, typed)).rejects.toMatchObject({ statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
    }
  });

  it.each([['upper', STORED], ['lower', LOWER], ['mixed', MIXED]])(
    'refuses by key, naming both, when two rows of the entity differ only by case (typed in %s case)',
    async (_case, typed) => {
      const refused = await getCfdiByUuid(twice.entityId, typed).then(
        (doc) => ({ picked: doc.cfdi_uuid }),
        (e: unknown) => e
      );
      expect(refused).toMatchObject({
        statusCode: 409,
        messageKey: { key: 'cfdi.lookup.same_uuid_twice', params: { uuid: typed, count: 2, stored: `${STORED}, ${LOWER}` } },
      });
      expect((refused as Error).message).toContain(`${STORED}, ${LOWER}`);
    }
  );
});

describe('MNE-001-680 · the two readers of the CLI', () => {
  it('cfdi show prints the CFDI stored in upper case for a UUID typed in lower case', async () => {
    const shown = await cli(f, 'show', LOWER, '--json');
    expect(shown.exitCode, shown.said).toBe(0);
    const { rows } = JSON.parse(shown.said) as { rows: Array<Record<string, unknown>> };
    expect(rows.map((r) => [r['cfdi_uuid'], r['total']])).toEqual([[STORED, '116.0000']]);
  });

  it('cfdi post reads it too: it gets as far as asking, naming the stored UUID and the total, and posts nothing', async () => {
    // The tenant has three users (one per entity), so the reviewer is named.
    const { email } = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0];
    const asked = await cli(f, 'post', LOWER, '--user', email);
    // 10: no terminal to confirm on. Before, the reader answered not found (3).
    expect(asked.exitCode, asked.said).toBe(10);
    expect(asked.said).toContain(`Post CFDI ${STORED} (XAXX010101000, 116.0000 MXN`);
    const invoices = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoices WHERE entity_id = $1`, [f.entityId]);
    expect(invoices.rows[0].n).toBe('0');
  });

  it('cfdi show exits 6 and names both rows when the entity holds the UUID twice', async () => {
    const refused = await cli(twice, 'show', LOWER);
    expect(refused.exitCode, refused.said).toBe(6);
    expect(refused.said).toContain(`${STORED}, ${LOWER}`);
  });
});
