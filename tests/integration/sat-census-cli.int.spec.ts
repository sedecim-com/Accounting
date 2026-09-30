import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { makeZip } from '../sat-census/make-zip.js';

// MNE-001-096 (#312): `mnemosine ingest --kind zip|metadata`, driven as the
// accountant types it (the CLI in a child process). What only the wiring of
// the `ingest` leaf proves: the metadata loads the census and stops; the ZIP
// loads the census AND its XML go through the one ingestion (xml_documents),
// deduplicated by UUID on a second run; a broken metadata line is exit 1; and
// a wrong --kind is a usage error raised before anything is read.

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
const ENTITY_RFC = 'XAXX010101000';
const HEADER =
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const XML = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8');
const xmlOf = (uuid: string, type: string): string =>
  XML.replace('D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E', uuid.toUpperCase())
    .replace('TipoDeComprobante="I"', `TipoDeComprobante="${type}"`);

let f: Fixture;
let email: string;
let work: string;

interface Run { status: number | null; out: string }

function mnemosine(args: string[]): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: work, NO_COLOR: '1', MNEMOSINE_LOCALE: 'en-US', MNEMOSINE_TENANT: f.tenantId };
  // No model credential: the ingestion runs its deterministic layer only.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.MNEMOSINE_PROVIDER;
  const r = spawnSync('npx', ['tsx', CLI, 'ingest', ...args, '-e', f.entityId, '-u', email, '-y'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 240_000, env,
  });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const censusOf = async (): Promise<{ uuid: string; cfdi_type: string; source: string }[]> =>
  (await query<{ uuid: string; cfdi_type: string; source: string }>(
    'SELECT cfdi_uuid::text AS uuid, cfdi_type, source FROM sat_cfdi_census WHERE entity_id = $1 ORDER BY cfdi_type',
    [f.entityId]
  )).rows;

const documentsOf = async (uuids: string[]): Promise<number> =>
  (await query<{ n: number }>(
    'SELECT count(*)::int AS n FROM xml_documents WHERE entity_id = $1 AND lower(cfdi_uuid::text) = ANY($2)',
    [f.entityId, uuids]
  )).rows[0].n;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-096 census from the terminal');
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-census-cli-'));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('mnemosine ingest --kind metadata|zip', () => {
  it('loads the metadata as the census and stops, with exit 1 when a line does not read', async () => {
    const [u1, u2] = [randomUUID(), randomUUID()];
    const file = path.join(work, 'agosto-recibidos.txt');
    fs.writeFileSync(file, [
      HEADER,
      `${u1}~SIN060101AB1~Emisor SA~${ENTITY_RFC}~Receptor~SAT970701NN3~2026-08-15 10:00:00~2026-08-15 10:05:00~1160.00~I~1~`,
      `${u2}~${ENTITY_RFC}~Receptor~SIN060101AB1~Emisor SA~SAT970701NN3~2026-08-16 10:00:00~2026-08-16 10:05:00~500.00~N~1~`,
      `${randomUUID()}~short`,
    ].join('\r\n'));
    const r = mnemosine([file, '--kind', 'metadata']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('Census loaded from agosto-recibidos.txt: 2 new, 0 already known.');
    expect((await censusOf()).map((x) => [x.uuid, x.cfdi_type])).toEqual([[u1, 'I'], [u2, 'N']]);
    const loads = await query('SELECT invalid_count, loaded_by::text AS by FROM sat_census_loads WHERE entity_id = $1', [f.entityId]);
    expect(loads.rows).toEqual([{ invalid_count: 1, by: f.userId }]);
  }, 300_000);

  it('loads the census from a ZIP and ingests its XML once, then reports them as duplicates', async () => {
    const [invoice, payroll] = [randomUUID(), randomUUID()];
    const zip = path.join(work, 'agosto-emitidos.zip');
    fs.writeFileSync(zip, makeZip([
      { name: 'A.xml', data: xmlOf(invoice, 'I') }, { name: 'N.xml', data: xmlOf(payroll, 'N') },
      { name: 'broken.xml', data: '<nope/>' },
    ]));

    // The dry run hands the package's XML to the preview, and loads nothing.
    const dry = mnemosine([zip, '--kind', 'zip', '--dry-run']);
    expect(dry.status, dry.out).toBe(1);
    expect(dry.out).toMatch(/1-A\.xml\s+would_process/);
    expect(await documentsOf([invoice])).toBe(0);

    // A broken entry is exit 1, and the rest still loads and ingests.
    const first = mnemosine([zip, '--kind', 'zip']);
    expect(first.status, first.out).toBe(1);
    expect(first.out).toContain('Census loaded from agosto-emitidos.zip: 2 new, 0 already known.');
    expect(first.out).toContain('1 file(s)');
    // Only the invoice goes on to the ingestion: payroll is not the AP inbox's.
    expect(await documentsOf([invoice])).toBe(1);
    expect(await documentsOf([payroll])).toBe(0);
    expect((await censusOf()).filter((x) => x.source === 'xml').map((x) => x.uuid).sort()).toEqual([invoice, payroll].sort());

    const second = mnemosine([zip, '--kind', 'zip']);
    expect(second.status, second.out).toBe(1);
    expect(second.out).toContain('0 new, 2 already known');
    expect(second.out).toMatch(/duplicate/i);
    expect(await documentsOf([invoice])).toBe(1);
  }, 600_000);

  it('refuses a wrong --kind, and ingestion flags with --kind metadata, as usage errors', () => {
    const file = path.join(work, 'agosto-recibidos.txt');
    const kind = mnemosine([file, '--kind', 'csv']);
    expect(kind.status, kind.out).toBe(2);
    const flags = mnemosine([file, '--kind', 'metadata', '--auto-post']);
    expect(flags.status, flags.out).toBe(2);
    expect(flags.out).toContain('--auto-post');
  }, 600_000);
});
