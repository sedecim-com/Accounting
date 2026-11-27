import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import type { DepreciationMethod } from '../../types/index.js';
import {
  accountsOfThisEntity,
  exigirFecha,
  inicioDeDepreciacion,
  montosDelAlta,
  refuseUnitsOfProduction,
  startNotBeforeAcquisition,
  vidaUtilCoherente,
} from './asset-service.js';
import { LIVE_ROW } from './depreciation.js';

// ============================================================
// MNE-001-880 (#1069) · `asset edit`: A MISTAKE IN THE REGISTER IS CORRECTED,
// NOT CARRIED (NIF B-1).
//
// ONLY WHILE NO LIVE ROW EXISTS. Every posted month was computed from the
// values this changes. With one live row (`LIVE_ROW`: the ledger still backs
// it) the edit is refused and names the way out: reverse those entries (a
// reversed month is owed again, MNE-001-646, and the next run posts it from
// the corrected values) or dispose of the asset. It posts nothing and never
// touches a row of the schedule.
//
// ONE VALIDATOR, TWO DOORS. Every value passes the function registration
// uses (`asset-service.ts`), on the values the asset would be left with.
//
// THE LOCK. The asset is locked in its entity's scope BEFORE the live-row
// check, and the run takes the same lock before it writes a row
// (`runMonthlyDepreciation`): the two cannot cross.
// ============================================================

/** What `asset edit` may change. Absent means «leave it as it is». */
export interface AssetChanges {
  acquisition_cost?: string;
  salvage_value?: string;
  useful_life_years?: number;
  useful_life_months?: number;
  book_depreciation_method?: DepreciationMethod;
  tax_depreciation_method?: DepreciationMethod;
  acquisition_date?: string;
  depreciation_start_date?: string;
  asset_account_id?: string;
  accumulated_depreciation_account_id?: string;
  depreciation_expense_account_id?: string;
}

const EDITABLE = [
  'acquisition_cost', 'salvage_value', 'useful_life_years', 'useful_life_months',
  'depreciation_method', 'book_depreciation_method', 'tax_depreciation_method',
  'acquisition_date', 'depreciation_start_date',
  'asset_account_id', 'accumulated_depreciation_account_id', 'depreciation_expense_account_id',
] as const;
type Column = (typeof EDITABLE)[number];
const ACCOUNTS = ['asset_account_id', 'accumulated_depreciation_account_id', 'depreciation_expense_account_id'] as const;

type AssetRow = Record<Column, string | number | null> & {
  id: string;
  asset_number: string;
  asset_name: string;
  status: string;
};

export interface AssetEdit {
  id: string;
  asset_number: string;
  asset_name: string;
  /** One line per column that changed, in the order of the register. */
  changes: Array<{ field: Column; before: string; after: string }>;
  /** The start moved because the acquisition date did and no start was typed. */
  startRederived: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The column an asset is named by: its id, or its number in the register. */
export const assetKey = (ref: string): 'id' | 'asset_number' => (UUID_RE.test(ref) ? 'id' : 'asset_number');
/** How many entries the refusal names before it counts the rest. */
const NAMED_ENTRIES = 6;

/**
 * Corrects an asset of this entity, named by its number or its id. Leaves one
 * audit row with the previous values, the new ones and the reason.
 */
export async function editAsset(
  entityId: string,
  asset: string,
  changes: AssetChanges,
  reason: string,
  userId: string,
  /** The caller's transaction: `--dry-run` runs this real path and rolls it back. */
  opts?: { client?: pg.PoolClient }
): Promise<AssetEdit> {
  if (reason.trim() === '') throw new ValidationError('An asset is not edited without a reason.', 'reason');

  const run = async (client: pg.PoolClient): Promise<AssetEdit> => {
    const tenantId = await tenantDe(client, entityId);
    const ref = asset.trim();
    // Zero rows means «does not exist» and «is not yours» at once: the scope
    // is in the WHERE, by the primary key or by UNIQUE(asset_number, entity_id).
    const locked = await client.query<AssetRow>(
      `SELECT id, asset_number, asset_name, status,
              acquisition_cost, salvage_value, useful_life_years, useful_life_months,
              depreciation_method, book_depreciation_method, tax_depreciation_method,
              acquisition_date::text, depreciation_start_date::text,
              asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id
         FROM fixed_assets
        WHERE entity_id = $1 AND ${assetKey(ref)} = $2
          FOR UPDATE`,
      [entityId, ref]
    );
    const current = locked.rows[0];
    if (!current) throw new NotFoundError('Asset', ref);
    if (current.status !== 'active' && current.status !== 'inactive') {
      throw new ValidationError(
        { key: 'error.VALIDATION_ERROR.asset.edit_not_in_register', params: { asset: current.asset_number, status: current.status } },
        'asset'
      );
    }

    const live = await client.query<{ entry_number: string }>(
      `SELECT je.entry_number
         FROM depreciation_schedules ds
         JOIN fixed_assets fa ON fa.id = ds.asset_id
         JOIN journal_entries je ON je.id = ds.journal_entry_id
        WHERE ds.asset_id = $1 AND fa.entity_id = $2 AND ${LIVE_ROW}
        ORDER BY ds.depreciation_date`,
      [current.id, entityId]
    );
    if (live.rows.length > 0) {
      const named = live.rows.slice(0, NAMED_ENTRIES).map((r) => r.entry_number);
      throw new ValidationError(
        {
          key: 'error.VALIDATION_ERROR.asset.edit_has_posted_months',
          params: {
            asset: current.asset_number,
            months: live.rows.length,
            entries: named.join(', '),
            more: live.rows.length - named.length,
          },
        },
        'asset'
      );
    }

    // ── The values the asset would be left with, by registration's rules ──
    const c = changes;
    const { costo: cost, salvamento: salvage } = montosDelAlta(
      c.acquisition_cost ?? String(current.acquisition_cost),
      c.salvage_value ?? String(current.salvage_value)
    );
    const life =
      c.useful_life_years === undefined && c.useful_life_months === undefined
        ? { anios: current.useful_life_years, meses: current.useful_life_months }
        : vidaUtilCoherente(c.useful_life_years, c.useful_life_months, null);

    // Units of production is refused where it is TYPED: an asset registered
    // with it before MNE-001-881 leaves it through this command.
    refuseUnitsOfProduction(c.book_depreciation_method, c.tax_depreciation_method);
    const book = c.book_depreciation_method ?? current.book_depreciation_method;
    const tax = c.tax_depreciation_method ?? current.tax_depreciation_method;
    let governing = current.depreciation_method;
    if (c.book_depreciation_method !== undefined || c.tax_depreciation_method !== undefined) {
      const base = await getPolicy({ tenantId, entityId }, 'base_depreciacion', client);
      governing = (base.value === 'tasa_lisr' ? tax : book) ?? governing;
    }

    // THE START FOLLOWS THE ACQUISITION UNLESS IT IS TYPED, as at
    // registration: a corrected month of purchase that left the start behind
    // would skip months in silence. The result says when it moved.
    const acquired =
      c.acquisition_date === undefined
        ? String(current.acquisition_date)
        : exigirFecha(c.acquisition_date, 'acquisition_date');
    let start = String(current.depreciation_start_date);
    if (c.depreciation_start_date !== undefined) {
      start = exigirFecha(c.depreciation_start_date, 'depreciation_start_date');
      startNotBeforeAcquisition(start, acquired);
    } else if (c.acquisition_date !== undefined) {
      const convention = await getPolicy({ tenantId, entityId }, 'convencion_primer_mes', client);
      start = inicioDeDepreciacion(acquired, convention.value);
    }

    const typedAccounts = Object.fromEntries(
      ACCOUNTS.flatMap((field) => (c[field] === undefined ? [] : [[field, c[field]]]))
    ) as Record<string, string>;
    if (Object.keys(typedAccounts).length > 0) await accountsOfThisEntity(client, entityId, typedAccounts);

    const next: Record<Column, string | number | null> = {
      acquisition_cost: cost,
      salvage_value: salvage,
      useful_life_years: life.anios,
      useful_life_months: life.meses,
      depreciation_method: governing,
      book_depreciation_method: book,
      tax_depreciation_method: tax,
      acquisition_date: acquired,
      depreciation_start_date: start,
      asset_account_id: c.asset_account_id ?? current.asset_account_id,
      accumulated_depreciation_account_id:
        c.accumulated_depreciation_account_id ?? current.accumulated_depreciation_account_id,
      depreciation_expense_account_id: c.depreciation_expense_account_id ?? current.depreciation_expense_account_id,
    };
    const changed = EDITABLE.filter((column) => String(next[column]) !== String(current[column]));
    if (changed.length === 0) {
      throw new ValidationError(
        { key: 'error.VALIDATION_ERROR.asset.edit_no_change', params: { asset: current.asset_number } },
        'asset'
      );
    }

    // Guarded by entity and by the state read; the column names come from the
    // closed list above. The book value follows the cost: with no live row
    // the accumulated depreciation on the card is zero.
    const updated = await client.query(
      `UPDATE fixed_assets
          SET ${changed.map((column, i) => `${column} = $${i + 5}`).join(', ')},
              current_book_value = $4::numeric - accumulated_depreciation,
              updated_at = NOW()
        WHERE id = $1 AND entity_id = $2 AND status = $3`,
      [current.id, entityId, current.status, cost, ...changed.map((column) => next[column])]
    );
    if (updated.rowCount !== 1) throw new NotFoundError('Asset', ref);

    const pick = (row: Record<Column, string | number | null>): Record<string, unknown> =>
      Object.fromEntries(changed.map((column) => [column, row[column]]));
    await registrarAuditoria(client, {
      tenantId,
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'fixed_assets',
      entityId: current.id,
      oldValues: pick(current),
      newValues: pick(next),
      reason: reason.trim(),
    });

    return {
      id: current.id,
      asset_number: current.asset_number,
      asset_name: current.asset_name,
      changes: changed.map((field) => ({ field, before: String(current[field]), after: String(next[field]) })),
      startRederived: c.depreciation_start_date === undefined && changed.includes('depreciation_start_date'),
    };
  };

  return opts?.client ? run(opts.client) : withTransaction(run);
}
