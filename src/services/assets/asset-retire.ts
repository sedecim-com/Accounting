import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { todayFor } from '../policy/today.js';
import { assetKey } from './asset-edit.js';
import { exigirFecha } from './asset-service.js';
import { LIVE_ROW } from './depreciation.js';

// ============================================================
// MNE-001-880 (#1069), part 2 · `asset retire`: AN ASSET THAT MUST NOT
// DEPRECIATE ANY MORE IS STOPPED, AND `--undo` BRINGS IT BACK.
//
// THE STATUS IS WHAT THE RUN READS. Retiring leaves the asset `inactive`: the
// monthly run, its plan and the close box take `active` assets only. Nothing
// is posted and no posted month is touched, by either act.
//
// THE EFFECTIVE DATE LIVES IN THE AUDIT ROW: no column holds it. So a date
// after today is refused (the asset would stop at once, before that day), and
// the months already posted on or after it stand: the result names them, and
// reversing one is a person's act.
//
// THE UNDO READS THE TRAIL, NOT A TEXT. A retirement is the audit action
// `close` on the asset and its undo is `reopen`; only an asset whose last of
// the two is a `close` comes back. The months it skipped are not posted: the
// result names the ones left without a row.
//
// Same lock as `asset edit` and the run: the asset, in its entity's scope,
// before its state is read.
// ============================================================

export interface AssetRetirement {
  id: string;
  asset_number: string;
  asset_name: string;
  from: 'active' | 'inactive';
  to: 'active' | 'inactive';
  /** The day the retirement took effect: the one given, or the one being undone. */
  effective: string;
  /**
   * Retiring: the months already posted on or after the effective date, with
   * their entry, which stand. Undoing: the months from that date to today
   * left without a row, which nobody posts for the accountant.
   */
  months: string[];
}

interface Options {
  /** The caller's transaction: `--dry-run` runs the real path and rolls it back. */
  client?: pg.PoolClient;
  /** The instant «today» is read from; exists for tests. */
  now?: Date;
}

interface Locked {
  id: string;
  asset_number: string;
  asset_name: string;
  status: string;
  depreciation_start_date: string;
}

/** Locks the asset in its entity's scope. Zero rows: it does not exist, or it is not yours. */
async function lockAsset(client: pg.PoolClient, entityId: string, asset: string): Promise<Locked> {
  const ref = asset.trim();
  const locked = await client.query<Locked>(
    `SELECT id, asset_number, asset_name, status, depreciation_start_date::text
       FROM fixed_assets
      WHERE entity_id = $1 AND ${assetKey(ref)} = $2
        FOR UPDATE`,
    [entityId, ref]
  );
  if (!locked.rows[0]) throw new NotFoundError('Asset', ref);
  return locked.rows[0];
}

/** The guarded change of state, with its audit row. */
async function changeState(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string,
  asset: Locked,
  to: 'active' | 'inactive',
  effective: string,
  reason: string,
  userId: string
): Promise<void> {
  const updated = await client.query(
    `UPDATE fixed_assets SET status = $4, updated_at = NOW()
      WHERE id = $1 AND entity_id = $2 AND status = $3`,
    [asset.id, entityId, asset.status, to]
  );
  if (updated.rowCount !== 1) throw new NotFoundError('Asset', asset.asset_number);
  const retired = { status: 'inactive', effective_date: effective };
  await registrarAuditoria(client, {
    tenantId,
    legalEntityId: entityId,
    userId,
    action: to === 'inactive' ? 'close' : 'reopen',
    entityType: 'fixed_assets',
    entityId: asset.id,
    oldValues: to === 'inactive' ? { status: asset.status } : retired,
    newValues: to === 'inactive' ? retired : { status: to },
    reason: reason.trim(),
  });
}

const needsReason = (reason: string): void => {
  if (reason.trim() === '') throw new ValidationError('The state of an asset is not changed without a reason.', 'reason');
};

/** Retires an asset in use: it is left `inactive` and the run stops taking it. */
export async function retireAsset(
  entityId: string,
  asset: string,
  effective: string,
  reason: string,
  userId: string,
  opts: Options = {}
): Promise<AssetRetirement> {
  needsReason(reason);
  const day = exigirFecha(effective, 'effective');
  const run = async (client: pg.PoolClient): Promise<AssetRetirement> => {
    const current = await lockAsset(client, entityId, asset);
    if (current.status !== 'active') {
      throw new ValidationError(
        { key: 'error.VALIDATION_ERROR.asset.retire_not_active', params: { asset: current.asset_number, status: current.status } },
        'asset'
      );
    }
    const tenantId = await tenantDe(client, entityId);
    const today = await todayFor({ tenantId, entityId }, { client, now: opts.now });
    if (day > today) {
      throw new ValidationError(
        { key: 'error.VALIDATION_ERROR.asset.retire_effective_future', params: { effective: day, today } },
        'effective'
      );
    }
    if (day < current.depreciation_start_date) {
      throw new ValidationError(
        {
          key: 'error.VALIDATION_ERROR.asset.retire_effective_before_service',
          params: { asset: current.asset_number, effective: day, start: current.depreciation_start_date },
        },
        'effective'
      );
    }

    const standing = await client.query<{ period_name: string; entry_number: string }>(
      `SELECT fp.period_name, je.entry_number
         FROM depreciation_schedules ds
         JOIN fixed_assets fa ON fa.id = ds.asset_id
         JOIN fiscal_periods fp ON fp.id = ds.fiscal_period_id
         JOIN journal_entries je ON je.id = ds.journal_entry_id
        WHERE ds.asset_id = $1 AND fa.entity_id = $2 AND ${LIVE_ROW}
          AND fp.end_date >= $3::date
        ORDER BY fp.start_date`,
      [current.id, entityId, day]
    );

    await changeState(client, tenantId, entityId, current, 'inactive', day, reason, userId);
    return {
      id: current.id,
      asset_number: current.asset_number,
      asset_name: current.asset_name,
      from: 'active',
      to: 'inactive',
      effective: day,
      months: standing.rows.map((r) => `${r.period_name} (${r.entry_number})`),
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}

/** Brings back an asset that `retireAsset` retired, and only that one. */
export async function undoAssetRetirement(
  entityId: string,
  asset: string,
  reason: string,
  userId: string,
  opts: Options = {}
): Promise<AssetRetirement> {
  needsReason(reason);
  const run = async (client: pg.PoolClient): Promise<AssetRetirement> => {
    const current = await lockAsset(client, entityId, asset);
    // The last change of state this command wrote for the asset, by action.
    const last = await client.query<{ action: string; effective: string | null }>(
      `SELECT action, new_values->>'effective_date' AS effective
         FROM audit_log
        WHERE entity_type = 'fixed_assets' AND entity_id = $1 AND legal_entity_id = $2
          AND action IN ('close', 'reopen')
        ORDER BY timestamp DESC
        LIMIT 1`,
      [current.id, entityId]
    );
    const effective = last.rows[0]?.action === 'close' ? last.rows[0].effective : null;
    if (current.status !== 'inactive' || effective === null) {
      throw new ValidationError(
        { key: 'error.VALIDATION_ERROR.asset.retire_undo_not_retired', params: { asset: current.asset_number, status: current.status } },
        'asset'
      );
    }

    // The months of its life from the retirement to today with no live row.
    const tenantId = await tenantDe(client, entityId);
    const today = await todayFor({ tenantId, entityId }, { client, now: opts.now });
    const unposted = await client.query<{ period_name: string }>(
      `SELECT fp.period_name
         FROM fiscal_periods fp
         JOIN fixed_assets fa ON fa.id = $1 AND fa.entity_id = fp.entity_id
        WHERE fp.entity_id = $2 AND fp.period_type = 'regular'
          AND fp.end_date >= GREATEST($3::date, fa.depreciation_start_date)
          AND fp.start_date <= $4::date
          AND fp.start_date < fa.depreciation_start_date + make_interval(months => fa.useful_life_months)
          AND NOT EXISTS (
            SELECT 1 FROM depreciation_schedules ds
             WHERE ds.asset_id = fa.id AND ds.fiscal_period_id = fp.id AND ${LIVE_ROW})
        ORDER BY fp.start_date`,
      [current.id, entityId, effective, today]
    );

    await changeState(client, tenantId, entityId, current, 'active', effective, reason, userId);
    return {
      id: current.id,
      asset_number: current.asset_number,
      asset_name: current.asset_name,
      from: 'inactive',
      to: 'active',
      effective,
      months: unposted.rows.map((r) => r.period_name),
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
