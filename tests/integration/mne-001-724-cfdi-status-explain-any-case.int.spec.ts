import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import { SATValidationService } from '../../src/services/xml-ingestion/sat-validation.js';
import { registerCfdiCommand } from '../../src/cli/cfdi-command.js';

// ============================================================
// MNE-001-724 (#853) · `cfdi status show` AND `cfdi explain` FIND A CFDI BY ITS
// UUID IN ANY LETTER CASE.
//
// MNE-001-680 taught `getCfdiByUuid` to compare without case. Two leaves of the
// same family never called it: `cfdi status show` read the mirror with its own
// exact comparison, and `cfdi explain` read the classifier's trail exactly. Both
// answered «not found» for a stored CFDI typed as SAT's portal prints it. They
// now use the predicate of 680, inside the entity, and refuse two rows that
// differ only by case instead of picking one.
// Synthetic rows, inserted by hand: the generic RFCs and made-up UUIDs.
// ============================================================

const STORED = 'C3D4E5F6-A7B8-4C9D-8E0F-A1B2C3D4E5F6';
const LOWER = STORED.toLowerCase();
const MIXED = 'c3D4e5F6-a7B8-4c9D-8e0F-a1B2c3D4e5F6';
/** Stored only in the sibling entity. */
const SIBLING_ONLY = 'D4E5F6A7-B8C9-4D0E-9F1A-B2C3D4E5F6A7';

const CASES = [['lower', LOWER], ['upper', STORED], ['mixed', MIXED]] as const;

let f: Fixture;
let sibling: Fixture;
let twice: Fixture;
let ownId: string;

/** A synthetic CFDI of 100.00 + 16.00 in the mirror, under `uuid` exactly as given, with what the SAT last said. */
async function store(fx: Fixture, uuid: string, satAnswer: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO xml_documents (id, entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, xml_content, xml_hash, import_source,
       sat_validation_status, sat_estado, sat_validated_at)
     VALUES ($1, $2, 'cfdi_ingreso', $3, '4.0', '2026-03-10', 'AAA010101AAA', 'XAXX010101000',
       100, 116, '<cfdi:Comprobante/>', $4, 'manual_upload', $5, $6, '2026-03-11T12:00:00Z')`,
    [id, fx.entityId, uuid, randomUUID().replace(/-/g, ''), satAnswer === 'Vigente' ? 'valid' : 'cancelled', satAnswer]
  );
  return id;
}

/** The classifier's trail of that CFDI, under `uuid` exactly as given, with no decision pending. */
async function trail(fx: Fixture, uuid: string, caseId: string): Promise<void> {
  await query(
    `INSERT INTO cfdi_classifications (tenant_id, entity_id, cfdi_uuid, tipo_comprobante, direction,
       case_id, facts, decisions, status)
     VALUES ($1, $2, $3, 'I', 'recibido', $4, '{}'::jsonb, '[]'::jsonb, 'ready')`,
    [fx.tenantId, fx.entityId, uuid, caseId]
  );
}

interface Said { exitCode?: number; out: string; err: string }
interface Envelope { rows: Array<Record<string, unknown>> }

/** One `cfdi` command line in process: what it wrote to each stream, and what it reported, apart. */
async function cli(fx: Fixture, ...argv: string[]): Promise<Said> {
  const program = new Command('mnemosine').exitOverride();
  const said: Said = { out: '', err: '' };
  const plain = (text: string) => text;
  const to = (stream: 'out' | 'err') => (chunk: unknown) => {
    said[stream] += String((chunk as Error)?.message ?? chunk);
    return true;
  };
  registerCfdiCommand(program, {
    palette: { dim: plain, bold: plain, cyan: plain, red: plain, green: plain, yellow: plain } as never,
    shutdown: (c: number) => { said.exitCode = c; }, reportError: to('err'),
  });
  const streams = [
    vi.spyOn(process.stdout, 'write').mockImplementation(to('out')),
    vi.spyOn(process.stderr, 'write').mockImplementation(to('err')),
  ];
  await program.parseAsync(['node', 'mnemosine', 'cfdi', ...argv, '--entity', fx.entityId, '--tenant', fx.tenantId])
    .finally(() => streams.forEach((stream) => stream.mockRestore()));
  return said;
}

const rowsOf = (said: Said): Envelope['rows'] => (JSON.parse(said.out) as Envelope).rows;

beforeAll(async () => {
  f = await crearInquilino('724 uuid any case');
  sibling = await crearEntidadHermana(f, '724 the sibling');
  twice = await crearEntidadHermana(f, '724 the same uuid twice');
  ownId = await store(f, STORED, 'Vigente');
  await trail(f, STORED, 'own-case');
  // The other side of the operation keeps the same folio, written in lower case, and its own answers.
  await store(sibling, LOWER, 'Cancelado');
  await trail(sibling, LOWER, 'sibling-case');
  await store(sibling, SIBLING_ONLY, 'Vigente');
  await trail(sibling, SIBLING_ONLY, 'sibling-case');
  for (const uuid of [LOWER, STORED]) {
    await store(twice, uuid, 'Vigente');
    await trail(twice, uuid, 'twin-case');
  }
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-724 · cfdi status show reads the mirror by UUID without case, inside the entity', () => {
  it.each(CASES)('prints the status of the CFDI stored in upper case when the UUID is typed in %s case', async (_case, typed) => {
    const shown = await cli(f, 'status', 'show', typed, '--json');
    expect(shown.exitCode, shown.err).toBe(0);
    expect(rowsOf(shown).map((r) => [r['cfdi_uuid'], r['sat_estado']])).toEqual([[STORED, 'Vigente']]);
  });

  it('--refresh asks the SAT about the stored row, whatever the case typed', async () => {
    const asked = vi.spyOn(SATValidationService.prototype, 'validateAndUpdate').mockResolvedValue(null);
    const shown = await cli(f, 'status', 'show', LOWER, '--refresh', '--json');
    expect(shown.exitCode, shown.err).toBe(0);
    expect(asked.mock.calls).toEqual([[ownId]]);
    expect(rowsOf(shown).map((r) => r['cfdi_uuid'])).toEqual([STORED]);
  });

  it('stays inside the entity: the sibling reads its own row, and its other CFDI is not in this mirror', async () => {
    const own = await cli(sibling, 'status', 'show', STORED, '--json');
    expect(rowsOf(own).map((r) => [r['cfdi_uuid'], r['sat_estado']])).toEqual([[LOWER, 'Cancelado']]);
    for (const typed of [SIBLING_ONLY, SIBLING_ONLY.toLowerCase()]) {
      const missing = await cli(f, 'status', 'show', typed);
      expect([missing.exitCode, missing.out]).toEqual([3, '']);
      expect(missing.err).toContain(`CFDI ${typed} is not in the mirror of this entity.`);
    }
  });

  it.each(CASES)('exits 6 naming both rows, and asks the SAT nothing, when the entity holds the UUID twice (typed in %s case)', async (_case, typed) => {
    const asked = vi.spyOn(SATValidationService.prototype, 'validateAndUpdate').mockResolvedValue(null);
    const refused = await cli(twice, 'status', 'show', typed, '--refresh');
    expect([refused.exitCode, refused.out], refused.err).toEqual([6, '']);
    expect(refused.err).toContain(`CFDI ${typed} is stored 2 times in this entity`);
    expect(refused.err).toContain(`${STORED}, ${LOWER}`);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('MNE-001-724 · cfdi explain reads the trail by UUID without case, inside the entity', () => {
  it.each(CASES)('getClassificationTrail finds the trail stored in upper case when the UUID is typed in %s case', async (_case, typed) => {
    const found = await getClassificationTrail(f.entityId, typed);
    expect([found.cfdi_uuid, found.case_id, found.status]).toEqual([STORED, 'own-case', 'ready']);
  });

  it('cfdi explain prints the trail with the UUID as stored for a UUID typed in lower case', async () => {
    const explained = await cli(f, 'explain', LOWER, '--json');
    expect(explained.exitCode, explained.err).toBe(0);
    expect(explained.err).toContain(`${STORED} · type I · recibido · case own-case · ready\n`);
    expect(rowsOf(explained).map((r) => [r['cfdi_uuid'], r['case_id']])).toEqual([[STORED, 'own-case']]);
  });

  it('stays inside the entity: the sibling reads its own trail, and its other trail is not found from here', async () => {
    expect((await getClassificationTrail(sibling.entityId, STORED)).case_id).toBe('sibling-case');
    expect((await getClassificationTrail(f.entityId, LOWER)).case_id).toBe('own-case');
    for (const typed of [SIBLING_ONLY, SIBLING_ONLY.toLowerCase()]) {
      await expect(getClassificationTrail(f.entityId, typed)).rejects.toMatchObject({ statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
      expect((await cli(f, 'explain', typed)).exitCode).toBe(3);
    }
  });

  it.each(CASES)('refuses by key, naming both, when two trails of the entity differ only by case (typed in %s case)', async (_case, typed) => {
    const refused = await getClassificationTrail(twice.entityId, typed).then(
      (picked) => ({ picked: picked.cfdi_uuid }),
      (e: unknown) => e
    );
    expect(refused).toMatchObject({
      statusCode: 409,
      messageKey: { key: 'cfdi.lookup.same_uuid_twice', params: { uuid: typed, count: 2, stored: `${STORED}, ${LOWER}` } },
    });
    const told = await cli(twice, 'explain', typed);
    expect([told.exitCode, told.out], told.err).toEqual([6, '']);
    expect(told.err).toContain(`${STORED}, ${LOWER}`);
  });
});
