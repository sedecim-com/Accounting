import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { storeCredential, CredentialAccessDenied } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';
import { clearSatTokenCache } from '../../src/services/sat-download/authentication.js';
import {
  requestDownload,
  verifyDownload,
  downloadPackage,
  SatDownloadError,
  type DownloadRequestInput,
} from '../../src/services/sat-download/descarga-masiva.js';
import { startSatSimulator, defaultScript, type SatSimulator } from '../sat-download/sat-simulator.js';

// ============================================================
// EFIRMA-2 1/2 (#440, MNE-001-142), against a real database and the local
// SAT simulator (invariant 7). The simulator answers only when the body is
// signed with the fixture e.firma and carries the token of EFIRMA-1.
// ============================================================

const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'certs');
const RFC = 'AAA010101AAA';

let f: Fixture;
let sim: SatSimulator;
const vaultBlobs = new Map<string, Buffer>();

const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId, actor: 'owner@efirma-2.test', unattended: false });
const deps = () => ({ url: sim.url, requestUrl: `${sim.base}/Solicita`, verifyUrl: `${sim.base}/Verifica`, downloadUrl: `${sim.base}/Descarga` });
let period = 0;
/** A fresh period per test, so the lifetime counter of one does not leak into another. */
const xml = (direction: 'issued' | 'received' = 'issued'): DownloadRequestInput => {
  period += 1;
  const day = String(period).padStart(2, '0');
  return { direction, requestType: 'CFDI', start: `2026-01-${day}T00:00:00`, end: `2026-01-${day}T23:59:59` };
};

async function quota(input: DownloadRequestInput): Promise<number | undefined> {
  const r = await query<{ requests_made: number }>(
    `SELECT requests_made FROM sat_download_quota WHERE tenant_id = $1 AND entity_id = $2 AND direction = $3
        AND period_start = $4 AND period_end = $5`,
    [f.tenantId, f.entityId, input.direction, input.start, input.end]
  );
  return r.rows[0]?.requests_made;
}

beforeAll(async () => {
  f = await crearInquilino('EFIRMA-2 Descarga Masiva');
  await seedPolicies({ tenantId: f.tenantId });
  await resolvePolicy({ tenantId: f.tenantId }, 'efirma_max_accesos_diarios', '96', f.userId);
  await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [RFC, f.entityId, f.tenantId]);
  setVaultForTesting({
    backend: 'test',
    put: async (_ctx: unknown, blob: Buffer) => {
      vaultBlobs.set('test://efirma-2', Buffer.from(blob));
      return { backend: 'test', ref: 'test://efirma-2' };
    },
    get: async (_ctx: unknown, ref: { ref: string }) => Buffer.from(vaultBlobs.get(ref.ref)!),
    destroy: async () => undefined,
    healthCheck: async () => ({ ok: true }),
  } as unknown as SecretVault);
  const stored = await storeCredential({
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
  expect(stored.rfc).toBe(RFC);
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

describe('EFIRMA-2 · SolicitaDescarga', () => {
  it('sends a signed SolicitaDescargaEmitidos and stores the request id with its parameters', async () => {
    const input = xml();
    const state = await requestDownload(ctx(), input, deps());

    expect(state).toMatchObject({ status: 'accepted', satRequestId: sim.lastRequestId, satCode: '5000', errorKey: null });
    expect(sim.actions.at(-1)).toBe('http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaEmitidos');
    expect(sim.requests.at(-1)).toContain(
      `<des:solicitud EstadoComprobante="Todos" FechaFinal="${input.end}" FechaInicial="${input.start}" RfcEmisor="${RFC}" RfcSolicitante="${RFC}" TipoSolicitud="CFDI">`
    );
    const row = await query(
      `SELECT rfc, direction, request_type, status, sat_request_id FROM sat_download_requests WHERE id = $1 AND tenant_id = $2`,
      [state.id, f.tenantId]
    );
    expect(row.rows[0]).toEqual({ rfc: RFC, direction: 'issued', request_type: 'CFDI', status: 'accepted', sat_request_id: sim.lastRequestId });
    expect(await quota(input)).toBe(1);
  });

  it('asks for received metadata through SolicitaDescargaRecibidos, outside the XML counter', async () => {
    const input = { ...xml('received'), requestType: 'Metadata' as const };
    await requestDownload(ctx(), input, deps());
    await requestDownload(ctx(), input, deps());
    await requestDownload(ctx(), input, deps());

    expect(sim.actions.at(-1)).toMatch(/\/SolicitaDescargaRecibidos$/);
    expect(sim.requests.at(-1)).toContain(`RfcReceptor="${RFC}" RfcSolicitante="${RFC}" TipoSolicitud="Metadata"`);
    expect(await quota(input)).toBeUndefined();
  });

  it('refuses the third identical XML request from the database, before any call', async () => {
    const input = xml();
    await requestDownload(ctx(), input, deps());
    await requestDownload(ctx(), input, deps());
    const sent = sim.requests.length;

    const refused = await requestDownload(ctx(), input, deps()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SatDownloadError);
    expect(refused).toMatchObject({ key: 'sat_download.lifetime_requests_exhausted', retry: 'permanent_quota' });
    expect(sim.requests).toHaveLength(sent);
    expect(await quota(input)).toBe(2);
  });

  it('a 5002 from the SAT fills the counter, so the next one is refused locally', async () => {
    const input = xml();
    sim.script.request = { code: '5002' };
    expect(await requestDownload(ctx(), input, deps())).toMatchObject({ status: 'rejected', errorKey: 'sat_download.lifetime_requests_exhausted' });
    expect(await quota(input)).toBe(2);
    await expect(requestDownload(ctx(), input, deps())).rejects.toMatchObject({ key: 'sat_download.lifetime_requests_exhausted' });
  });

  it('a refusal at the door (305) gives the slot back', async () => {
    const input = xml();
    sim.script.request = { code: '305' };
    expect(await requestDownload(ctx(), input, deps())).toMatchObject({ status: 'rejected', errorKey: 'sat_download.certificate_invalid' });
    expect(await quota(input)).toBe(0);
  });

  it('a request the SAT answers with a fault is failed and keeps its slot', async () => {
    const input = xml();
    await requestDownload(ctx(), xml(), deps()); // warm the token: only the request fails
    sim.failing = true;
    await expect(requestDownload(ctx(), input, deps())).rejects.toMatchObject({ key: 'sat_download.transport_failed', retry: 'ambiguous' });
    expect(await quota(input)).toBe(1);
    const last = await query(`SELECT status FROM sat_download_requests WHERE tenant_id = $1 ORDER BY requested_at DESC LIMIT 1`, [f.tenantId]);
    expect(last.rows[0].status).toBe('failed');
  });
});

describe('EFIRMA-2 · VerificaSolicitudDescarga and Descargar', () => {
  it('records the finished state and its packages, then downloads a package as the SAT sent it', async () => {
    const req = await requestDownload(ctx(), xml(), deps());
    const verified = await verifyDownload(ctx(), req.id, deps());
    expect(verified).toMatchObject({ status: 'finished', cfdiCount: 2, packageIds: ['B1C2D3E4_01'] });
    expect(sim.actions.at(-1)).toMatch(/\/IVerificaSolicitudDescargaService\/VerificaSolicitudDescarga$/);

    const pkg = await downloadPackage(ctx(), req.id, 'B1C2D3E4_01', deps());
    expect(sim.actions.at(-1)).toMatch(/\/IDescargaMasivaTercerosService\/Descargar$/);
    expect(pkg.bytes.equals(sim.script.download.zip)).toBe(true);
    expect(pkg.sha256).toBe(createHash('sha256').update(sim.script.download.zip).digest('hex'));
  });

  it('5004 is success with zero rows: no_data, no packages, no error', async () => {
    const req = await requestDownload(ctx(), xml(), deps());
    sim.script.verify = { code: '5000', state: '3', requestCode: '5004', count: 0, packages: [] };
    expect(await verifyDownload(ctx(), req.id, deps())).toMatchObject({ status: 'no_data', cfdiCount: 0, packageIds: [], errorKey: null });
  });

  it('keeps an in-process request open with no packages yet', async () => {
    const req = await requestDownload(ctx(), xml(), deps());
    sim.script.verify = { code: '5000', state: '2', requestCode: '5000', count: 0, packages: [] };
    expect(await verifyDownload(ctx(), req.id, deps())).toMatchObject({ status: 'in_process', packageIds: [] });
    sim.script = defaultScript();
    expect(await verifyDownload(ctx(), req.id, deps())).toMatchObject({ status: 'finished' });
  });

  it('refuses to download a package the request does not list, and a body that is not a ZIP', async () => {
    const req = await requestDownload(ctx(), xml(), deps());
    await verifyDownload(ctx(), req.id, deps());
    await expect(downloadPackage(ctx(), req.id, 'OTHER_01', deps())).rejects.toMatchObject({ key: 'sat_download.package_not_in_request' });
    sim.script.download = { code: '5000', zip: Buffer.from('not a zip') };
    await expect(downloadPackage(ctx(), req.id, 'B1C2D3E4_01', deps())).rejects.toMatchObject({ key: 'sat_download.package_not_zip' });
    sim.script.download = { code: '5008', zip: Buffer.alloc(0) };
    await expect(downloadPackage(ctx(), req.id, 'B1C2D3E4_01', deps())).rejects.toMatchObject({ key: 'sat_download.package_download_limit', retry: 'permanent_quota' });
  });

  it('every signed call leaves a sat_auth row in the access log', async () => {
    const before = await query<{ n: string }>(`SELECT count(*)::text n FROM fiscal_credential_access_log WHERE tenant_id = $1 AND purpose = 'sat_auth' AND outcome = 'success'`, [f.tenantId]);
    const req = await requestDownload(ctx(), xml(), deps()); // Autentica + SolicitaDescarga
    await verifyDownload(ctx(), req.id, deps()); // token cached: VerificaSolicitudDescarga only
    const after = await query<{ n: string }>(`SELECT count(*)::text n FROM fiscal_credential_access_log WHERE tenant_id = $1 AND purpose = 'sat_auth' AND outcome = 'success'`, [f.tenantId]);
    expect(Number(after.rows[0].n) - Number(before.rows[0].n)).toBe(3);
  });

  // Last: it spends the daily cap of the credential.
  it('a request the credential policy denies never leaves, and gives its slot back', async () => {
    await resolvePolicy({ tenantId: f.tenantId }, 'efirma_accion_anomalia', 'bloquear', f.userId);
    await query(`UPDATE fiscal_credentials SET max_daily_access = 1 WHERE tenant_id = $1 AND entity_id = $2`, [f.tenantId, f.entityId]);
    const input = xml();
    await expect(requestDownload(ctx(), input, deps())).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(0);
    expect(await quota(input)).toBe(0);
  });
});
