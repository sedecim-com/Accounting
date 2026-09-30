import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { storeCredential } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';
import { clearSatTokenCache } from '../../src/services/sat-download/authentication.js';
import { requestDownload, verifyDownload, type DownloadRequestInput } from '../../src/services/sat-download/descarga-masiva.js';
import {
  archivePackage, archivedPackage, ensurePackage, getRequest, listRequests, quotaRows,
} from '../../src/services/sat-download/packages.js';
import { importPackage } from '../../src/cli/sat-download-commands.js';
import { startSatSimulator, defaultScript, type SatSimulator } from '../sat-download/sat-simulator.js';
import { makeZip } from '../sat-census/make-zip.js';

// ============================================================
// EFIRMA-2 2/2 (#440, MNE-001-143). The packages are archived by bytes with
// their hash and enter through the ingestion of MNE-001-096 marked
// `sat_download`; the read commands answer from the local mirror without the
// SAT. Real database, local SAT simulator (invariant 7).
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const CERT_DIR = path.join(ROOT, 'tests', 'fixtures', 'certs');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
const RFC = 'AAA010101AAA';
const HEADER =
  'Uuid~RfcEmisor~NombreEmisor~RfcReceptor~NombreReceptor~RfcPac~FechaEmision~FechaCertificacionSat~Monto~EfectoComprobante~Estatus~FechaCancelacion';
const XML = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cfdi', 'factura-limpieza-1001.xml'), 'utf8')
  .replace('XAXX010101000', RFC);
const xmlOf = (uuid: string): string => XML.replace('D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E', uuid.toUpperCase());

let f: Fixture;
let other: Fixture;
let sim: SatSimulator;
let email: string;
const vaultBlobs = new Map<string, Buffer>();

const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId, actor: 'owner@efirma-2.test', unattended: false });
const scope = () => entityScope(f.tenantId, f.entityId);
const deps = () => ({ url: sim.url, requestUrl: `${sim.base}/Solicita`, verifyUrl: `${sim.base}/Verifica`, downloadUrl: `${sim.base}/Descarga` });
let day = 0;
const period = (requestType: 'CFDI' | 'Metadata'): DownloadRequestInput => {
  day += 1;
  const d = String(day).padStart(2, '0');
  return { direction: 'received', requestType, start: `2026-02-${d}T00:00:00`, end: `2026-02-${d}T23:59:59` };
};

/** A request the SAT reports finished with one package, as `sat download check` leaves it. */
async function finished(requestType: 'CFDI' | 'Metadata', packageId: string, zip: Buffer) {
  const req = await requestDownload(ctx(), period(requestType), deps());
  sim.script.verify = { code: '5000', state: '3', requestCode: '5000', count: 1, packages: [packageId] };
  sim.script.download = { code: '5000', zip };
  await verifyDownload(ctx(), req.id, deps());
  return (await getRequest(scope(), req.id))!;
}

beforeAll(async () => {
  f = await crearInquilino('EFIRMA-2 commands');
  other = await crearInquilino('EFIRMA-2 commands, another firm');
  email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [f.userId])).rows[0].email;
  await seedPolicies({ tenantId: f.tenantId });
  await resolvePolicy({ tenantId: f.tenantId }, 'efirma_max_accesos_diarios', '96', f.userId);
  await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [RFC, f.entityId, f.tenantId]);
  setVaultForTesting({
    backend: 'test',
    put: async (_c: unknown, blob: Buffer) => {
      vaultBlobs.set('test://efirma-2-cmd', Buffer.from(blob));
      return { backend: 'test', ref: 'test://efirma-2-cmd' };
    },
    get: async (_c: unknown, ref: { ref: string }) => Buffer.from(vaultBlobs.get(ref.ref)!),
    destroy: async () => undefined,
    healthCheck: async () => ({ ok: true }),
  } as unknown as SecretVault);
  await storeCredential({
    tenantId: f.tenantId,
    entityId: f.entityId,
    material: {
      cer: fs.readFileSync(path.join(CERT_DIR, 'fiel.cer')),
      key: fs.readFileSync(path.join(CERT_DIR, 'fiel.key')),
      password: 'test1234',
    },
    consentBy: 'owner@efirma-2.test',
    maxDailyAccess: 1000,
  });
  sim = await startSatSimulator();
});

beforeEach(() => {
  clearSatTokenCache();
  sim.requests.length = 0;
  sim.actions.length = 0;
  sim.failing = false;
  sim.script = defaultScript();
});

afterAll(async () => {
  await sim.close();
  setVaultForTesting(null);
  await drainAttestations(2000);
  await closeDatabase();
});

describe('EFIRMA-2 2/2 · the ZIP is archived by bytes', () => {
  it('keeps the ZIP exactly as the SAT sent it with its SHA-256, and a second run reads the archive without calling the SAT', async () => {
    const zip = makeZip([{ name: 'a.xml', data: xmlOf(randomUUID()) }]);
    const req = await finished('CFDI', 'ARCH_01', zip);

    const first = await ensurePackage(ctx(), scope(), req, 'ARCH_01', deps());
    expect(first.from).toBe('sat');
    const kept = await query<{ zip_content: Buffer; zip_sha256: string; size_bytes: number; archived_by: string }>(
      'SELECT zip_content, zip_sha256, size_bytes, archived_by FROM sat_download_packages WHERE entity_id = $1 AND package_id = $2',
      [f.entityId, 'ARCH_01']
    );
    expect(kept.rows[0].zip_content.equals(zip)).toBe(true);
    expect(kept.rows[0].zip_sha256).toBe(createHash('sha256').update(zip).digest('hex'));
    expect(kept.rows[0]).toMatchObject({ size_bytes: zip.length, archived_by: 'owner@efirma-2.test' });

    const calls = sim.actions.length;
    const second = await ensurePackage(ctx(), scope(), req, 'ARCH_01', deps());
    expect(second.from).toBe('archive');
    expect(second.bytes.equals(zip)).toBe(true);
    expect(sim.actions).toHaveLength(calls);
  });

  it('never replaces archived bytes: the first copy stays the evidence', async () => {
    const zip = makeZip([{ name: 'a.xml', data: xmlOf(randomUUID()) }]);
    const req = await finished('CFDI', 'ARCH_02', zip);
    await ensurePackage(ctx(), scope(), req, 'ARCH_02', deps());

    const again = await archivePackage(
      scope(), req.id, { packageId: 'ARCH_02', bytes: Buffer.from('PK\x03\x04other'), sha256: 'f'.repeat(64) }, 'someone'
    );
    expect(again.archived).toBe(false);
    expect((await archivedPackage(scope(), 'ARCH_02'))!.bytes.equals(zip)).toBe(true);
  });
});

describe('EFIRMA-2 2/2 · the packages enter by ingest', () => {
  it('loads the census and ingests the XML as sat_download, deduplicated by UUID on a second import', async () => {
    const [invoice, payroll] = [randomUUID(), randomUUID()];
    const zip = makeZip([
      { name: 'I.xml', data: xmlOf(invoice) },
      { name: 'N.xml', data: xmlOf(payroll).replace('TipoDeComprobante="I"', 'TipoDeComprobante="N"') },
    ]);
    const req = await finished('CFDI', 'IMP_01', zip);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'efirma2-')), 'IMP_01.zip');
    fs.writeFileSync(file, (await ensurePackage(ctx(), scope(), req, 'IMP_01', deps())).bytes);
    const reviewer = { userId: f.userId, email, name: 'Owner' } as Parameters<typeof importPackage>[1];
    const entity = {
      entityId: f.entityId, entityName: 'Fixture', tenantId: f.tenantId, currency: 'MXN', country: 'MX',
      accountingStandard: 'NIF', taxId: RFC,
    };

    await importPackage(entity, reviewer, scope(), req, file);
    const docs = () => query<{ import_source: string }>(
      'SELECT import_source FROM xml_documents WHERE entity_id = $1 AND lower(cfdi_uuid::text) = ANY($2)',
      [f.entityId, [invoice, payroll]]
    );
    expect((await docs()).rows).toEqual([{ import_source: 'sat_download' }]);
    const census = await query<{ n: number }>('SELECT count(*)::int AS n FROM sat_cfdi_census WHERE entity_id = $1 AND cfdi_uuid = ANY($2)', [f.entityId, [invoice, payroll]]);
    expect(census.rows[0].n).toBe(2);
    const loads = await query<{ file_sha256: string }>('SELECT file_sha256 FROM sat_census_loads WHERE entity_id = $1 AND file_name = $2', [f.entityId, 'IMP_01.zip']);
    expect(loads.rows[0].file_sha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));

    await importPackage(entity, reviewer, scope(), req, file);
    expect((await docs()).rows).toHaveLength(1);
  }, 120_000);

  it('feeds a metadata package to the census and ingests no XML', async () => {
    const uuid = randomUUID();
    const zip = makeZip([{
      name: 'meta.txt',
      data: [HEADER, `${uuid}~SIN060101AB1~Emisor SA~${RFC}~Receptor~SAT970701NN3~2026-02-15 10:00:00~2026-02-15 10:05:00~1160.00~I~1~`].join('\r\n'),
    }]);
    const req = await finished('Metadata', 'META_01', zip);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'efirma2-')), 'META_01.zip');
    fs.writeFileSync(file, zip);
    const reviewer = { userId: f.userId, email, name: 'Owner' } as Parameters<typeof importPackage>[1];
    const entity = {
      entityId: f.entityId, entityName: 'Fixture', tenantId: f.tenantId, currency: 'MXN', country: 'MX',
      accountingStandard: 'NIF', taxId: RFC,
    };

    await importPackage(entity, reviewer, scope(), req, file);
    const rows = await query('SELECT direction, cfdi_type, source FROM sat_cfdi_census WHERE entity_id = $1 AND cfdi_uuid = $2', [f.entityId, uuid]);
    expect(rows.rows).toEqual([{ direction: 'received', cfdi_type: 'I', source: 'metadata' }]);
    const docs = await query('SELECT 1 FROM xml_documents WHERE entity_id = $1 AND lower(cfdi_uuid::text) = $2', [f.entityId, uuid]);
    expect(docs.rows).toHaveLength(0);
  }, 120_000);
});

describe('EFIRMA-2 2/2 · the mirror answers without the SAT', () => {
  it('finds a request by its local id or the SAT id, lists by state, and never shows another firm its rows', async () => {
    const req = await finished('CFDI', 'MIR_01', makeZip([{ name: 'a.xml', data: xmlOf(randomUUID()) }]));
    const calls = sim.actions.length;

    expect(await getRequest(scope(), req.id)).toMatchObject({ status: 'finished', packageIds: ['MIR_01'], archivedPackageIds: [] });
    expect((await getRequest(scope(), req.satRequestId!))!.id).toBe(req.id);
    expect((await listRequests(scope(), { status: 'finished', limit: 50 })).map((r) => r.id)).toContain(req.id);
    expect(await listRequests(scope(), { status: 'expired', limit: 50 })).toEqual([]);
    expect(await getRequest(entityScope(other.tenantId, other.entityId), req.id)).toBeNull();
    expect(await listRequests(entityScope(other.tenantId, other.entityId), { limit: 50 })).toEqual([]);
    expect(sim.actions).toHaveLength(calls);
  });

  it('shows the lifetime counter: one left after a request, none after two, metadata never counted', async () => {
    const xml = period('CFDI');
    await requestDownload(ctx(), xml, deps());
    const find = async () => (await quotaRows(scope(), {})).find((q) => q.periodStart === xml.start);
    expect(await find()).toMatchObject({ requestsMade: 1, remaining: 1, direction: 'received' });
    await requestDownload(ctx(), xml, deps());
    expect(await find()).toMatchObject({ requestsMade: 2, remaining: 0 });
    expect(await quotaRows(scope(), { since: '2099-01-01T00:00:00' })).toEqual([]);

    const meta = period('Metadata');
    await requestDownload(ctx(), meta, deps());
    expect((await quotaRows(scope(), {})).find((q) => q.periodStart === meta.start)).toBeUndefined();
  });
});

describe('EFIRMA-2 2/2 · the commands, as typed', () => {
  function sat(args: string[]): { status: number | null; out: string } {
    const env: NodeJS.ProcessEnv = {
      ...process.env, NO_COLOR: '1', MNEMOSINE_LOCALE: 'en-US', MNEMOSINE_TENANT: f.tenantId,
      // Anything that tried the SAT would fail here: these commands must not.
      SAT_DESCARGA_AUTH_URL: 'http://127.0.0.1:9/', SAT_DESCARGA_SOLICITA_URL: 'http://127.0.0.1:9/',
      SAT_DESCARGA_VERIFICA_URL: 'http://127.0.0.1:9/', SAT_DESCARGA_DESCARGA_URL: 'http://127.0.0.1:9/',
    };
    const r = spawnSync('npx', ['tsx', CLI, 'sat', ...args, '-e', f.entityId], { cwd: ROOT, encoding: 'utf-8', timeout: 240_000, env });
    return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  }

  it('status, list and quota show read the mirror; a request that is not the entity\'s is not found', async () => {
    const req = await finished('CFDI', 'CLI_01', makeZip([{ name: 'a.xml', data: xmlOf(randomUUID()) }]));
    const status = sat(['download', 'status', req.id]);
    expect(status.status, status.out).toBe(0);
    expect(status.out).toContain(`${req.id} · received xml`);
    expect(status.out).toContain('finished');
    const json = JSON.parse(sat(['download', 'status', req.id, '--json']).out.trim().split('\n')[0]) as { packageIds: string[] };
    expect(json.packageIds).toEqual(['CLI_01']);

    const list = sat(['download', 'list', '-s', 'finished']);
    expect(list.status, list.out).toBe(0);
    expect(list.out).toContain(req.id);

    const quota = sat(['quota', 'show']);
    expect(quota.status, quota.out).toBe(0);
    expect(quota.out).toMatch(/1 left · received 2026-02-\d\d\.\.2026-02-\d\d · 1\/2 used/);

    expect(sat(['download', 'status', randomUUID()]).status).toBe(3);
  }, 600_000);

  it('create and package download without --live, and with --dry-run, say what they would do and call nobody', async () => {
    const req = await finished('CFDI', 'CLI_02', makeZip([{ name: 'a.xml', data: xmlOf(randomUUID()) }]));

    const dry = sat(['download', 'create', '--since', '2026-03-01', '--until', '2026-03-31', '--direction', 'issued', '--kind', 'xml', '--dry-run']);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain('Would ask the SAT for issued xml');
    expect(dry.out).toContain('lifetime XML requests left for this period: 2');

    const notLive = sat(['download', 'create', '--since', '2026-03-01', '--until', '2026-03-31', '--direction', 'issued', '-y']);
    expect(notLive.status, notLive.out).toBe(0);
    expect(notLive.out).toContain('re-run with --live');

    const pkg = sat(['package', 'download', req.id, '--import', '--dry-run']);
    expect(pkg.status, pkg.out).toBe(0);
    expect(pkg.out).toContain('Would download 1 of 1 package(s)');
    const pkgNotLive = sat(['package', 'download', req.id]);
    expect(pkgNotLive.out).toContain('re-run with --live');

    const bad = sat(['download', 'create', '--since', '2026-3-1', '--until', '2026-03-31', '--direction', 'issued']);
    expect(bad.status, bad.out).toBe(2);
    expect(await query('SELECT 1 FROM sat_download_requests WHERE entity_id = $1 AND period_start = $2', [f.entityId, '2026-03-01T00:00:00'])).toMatchObject({ rowCount: 0 });
  }, 600_000);

  it('the help no longer says the bulk download is not built, and the agent cannot run the commands that use the e.firma', () => {
    const help = spawnSync('npx', ['tsx', CLI, 'sat', '--help'], { cwd: ROOT, encoding: 'utf-8', timeout: 240_000, env: { ...process.env, NO_COLOR: '1' } });
    expect(help.stdout).toContain('bulk download');
    expect(help.stdout).not.toContain('not built');
    expect(help.stdout).toMatch(/download\|descarga/);
    expect(help.stdout).toMatch(/quota\|cuota/);
  }, 300_000);
});
