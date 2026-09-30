import { query } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import type { SatAuthContext } from './authentication.js';
import { downloadPackage, type BulkDownloadDeps, type DownloadedPackage } from './descarga-masiva.js';

// ============================================================
// EFIRMA-2 2/2 (#440, MNE-001-143) · THE LOCAL MIRROR OF THE DOWNLOADS
//
// What `sat download status|list`, `sat quota show` and the import step of
// `sat package download` read. Nothing here calls the SAT and nothing here
// needs the e.firma: these are the halves of the commands an agent may run.
// Every query carries tenant and entity (invariant 4).
// ============================================================

export interface MirrorRequest {
  id: string;
  direction: string;
  requestType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  satRequestId: string | null;
  satCode: string | null;
  satMessage: string | null;
  errorKey: string | null;
  cfdiCount: number | null;
  packageIds: string[];
  requestedAt: Date;
  verifiedAt: Date | null;
  actor: string;
  /** Package ids of this request whose bytes are archived. */
  archivedPackageIds: string[];
}

interface MirrorRow {
  id: string; direction: string; request_type: string; start: string; end: string; status: string;
  sat_request_id: string | null; sat_code: string | null; sat_message: string | null; error_key: string | null;
  cfdi_count: number | null; package_ids: string[]; requested_at: Date; verified_at: Date | null; actor: string;
  archived: string[];
}

const SELECT = `
  SELECT r.id, r.direction, r.request_type,
         to_char(r.period_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS start,
         to_char(r.period_end, 'YYYY-MM-DD"T"HH24:MI:SS') AS "end",
         r.status, r.sat_request_id, r.sat_code, r.sat_message, r.error_key, r.cfdi_count, r.package_ids,
         r.requested_at, r.verified_at, r.actor,
         COALESCE((SELECT array_agg(p.package_id ORDER BY p.package_id) FROM sat_download_packages p
                    WHERE p.request_id = r.id AND p.tenant_id = r.tenant_id AND p.entity_id = r.entity_id), '{}') AS archived
    FROM sat_download_requests r`;

const toRequest = (r: MirrorRow): MirrorRequest => ({
  id: r.id, direction: r.direction, requestType: r.request_type, periodStart: r.start, periodEnd: r.end,
  status: r.status, satRequestId: r.sat_request_id, satCode: r.sat_code, satMessage: r.sat_message,
  errorKey: r.error_key, cfdiCount: r.cfdi_count, packageIds: r.package_ids, requestedAt: r.requested_at,
  verifiedAt: r.verified_at, actor: r.actor, archivedPackageIds: r.archived,
});

/** One request of the entity, by the local id or by the SAT's id; null when it is not the entity's. */
export async function getRequest(scope: EntityScope, id: string): Promise<MirrorRequest | null> {
  const r = await query<MirrorRow>(
    `${SELECT} WHERE r.tenant_id = $1 AND r.entity_id = $2 AND (r.id::text = $3 OR r.sat_request_id = $3)`,
    [scope.tenantId, scope.entityId, id]
  );
  return r.rows[0] ? toRequest(r.rows[0]) : null;
}

export async function listRequests(
  scope: EntityScope, filter: { status?: string; since?: string; limit: number }
): Promise<MirrorRequest[]> {
  const r = await query<MirrorRow>(
    `${SELECT} WHERE r.tenant_id = $1 AND r.entity_id = $2
        AND ($3::text IS NULL OR r.status = $3) AND ($4::timestamp IS NULL OR r.period_end >= $4)
      ORDER BY r.requested_at DESC LIMIT $5`,
    [scope.tenantId, scope.entityId, filter.status ?? null, filter.since ?? null, filter.limit]
  );
  return r.rows.map(toRequest);
}

export interface QuotaRow {
  rfc: string; direction: string; periodStart: string; periodEnd: string;
  requestsMade: number; remaining: number; lastAt: Date;
}

/** The lifetime counters, most used first. `remaining` 0 is unrecoverable: the SAT answers 5002 for life. */
export async function quotaRows(scope: EntityScope, range: { since?: string; until?: string }): Promise<QuotaRow[]> {
  const r = await query<{
    rfc: string; direction: string; start: string; end: string; requests_made: number; last_at: Date;
  }>(
    `SELECT rfc, direction, to_char(period_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS start,
            to_char(period_end, 'YYYY-MM-DD"T"HH24:MI:SS') AS "end", requests_made, last_at
       FROM sat_download_quota
      WHERE tenant_id = $1 AND entity_id = $2
        AND ($3::timestamp IS NULL OR period_end >= $3) AND ($4::timestamp IS NULL OR period_start <= $4)
      ORDER BY requests_made DESC, period_start DESC`,
    [scope.tenantId, scope.entityId, range.since ?? null, range.until ?? null]
  );
  return r.rows.map((x) => ({
    rfc: x.rfc, direction: x.direction, periodStart: x.start, periodEnd: x.end,
    requestsMade: x.requests_made, remaining: 2 - x.requests_made, lastAt: x.last_at,
  }));
}

/** Keeps the ZIP as the SAT sent it. A package already kept is left alone: the first bytes stay the evidence. */
export async function archivePackage(
  scope: EntityScope, requestId: string, pkg: DownloadedPackage, actor: string
): Promise<{ archived: boolean }> {
  const r = await query(
    `INSERT INTO sat_download_packages
       (tenant_id, entity_id, request_id, package_id, zip_content, zip_sha256, size_bytes, archived_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ON CONSTRAINT uq_sat_download_packages DO NOTHING`,
    [scope.tenantId, scope.entityId, requestId, pkg.packageId, pkg.bytes, pkg.sha256, pkg.bytes.length, actor]
  );
  return { archived: r.rowCount === 1 };
}

/** The archived bytes of a package of this entity, or null. */
export async function archivedPackage(scope: EntityScope, packageId: string): Promise<DownloadedPackage | null> {
  const r = await query<{ zip_content: Buffer; zip_sha256: string }>(
    `SELECT zip_content, zip_sha256 FROM sat_download_packages
      WHERE tenant_id = $1 AND entity_id = $2 AND package_id = $3`,
    [scope.tenantId, scope.entityId, packageId]
  );
  return r.rows[0] ? { packageId, bytes: r.rows[0].zip_content, sha256: r.rows[0].zip_sha256.trim() } : null;
}

export interface EnsuredPackage extends DownloadedPackage {
  /** 'archive': the bytes were already kept and the SAT was not called. */
  from: 'archive' | 'sat';
}

/**
 * The bytes of one package of a finished request: from the archive when they
 * are already kept (no e.firma use, no call), otherwise downloaded and kept
 * BEFORE the caller reads anything out of them.
 */
export async function ensurePackage(
  ctx: SatAuthContext, scope: EntityScope, request: MirrorRequest, packageId: string, deps: BulkDownloadDeps = {}
): Promise<EnsuredPackage> {
  const kept = await archivedPackage(scope, packageId);
  if (kept) return { ...kept, from: 'archive' };
  const pkg = await downloadPackage(ctx, request.id, packageId, deps);
  await archivePackage(scope, request.id, pkg, ctx.actor);
  // Read back what is kept: if a concurrent run archived first, its bytes are the evidence.
  return { ...((await archivedPackage(scope, packageId)) ?? pkg), from: 'sat' };
}
