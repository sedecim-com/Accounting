import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import type { LineWithSuggestion } from './pre-registration-service.js';

// ============================================================
// ING-2 · #319 (MNE-001-030) — CODING A CFDI BY HAND.
//
// Without a model, or after it failed, a pre-registration sits in the inbox
// with lines nobody assigned an account to, and `bill inbox run` refuses it
// with «Line N: no account assigned». Until now the only way to code it was
// the REST PATCH. This is the terminal's way: it writes the account (and the
// cost center) on the pre-registration and nothing else. The ledger is still
// reached through one door only, `bill inbox run` → processToAccounting.
// ============================================================

/** The states a pre-registration can be coded in: before it is posted, never while it posts. */
export const CODABLE_STATUSES = ['draft', 'ready', 'error'] as const;

export const PRE_REGISTRATION_NOT_CODABLE = 'PRE_REGISTRATION_NOT_CODABLE';

export interface PreRegistrationCoding {
  /** The account every line without its own falls back to. */
  defaultAccountId?: string;
  /** One line's own coding. */
  line?: { lineNumber: number; accountId?: string; costCenterId?: string };
}

// The guard, shared by the read and the write: no bill, no entry, and no AI
// draft of the same CFDI waiting for review or already approved — coding it
// here too would put the same expense in the ledger twice.
const CODABLE = `
  pr.id = $1 AND pr.entity_id = $2
  AND pr.status = ANY($3::text[])
  AND pr.bill_id IS NULL AND pr.journal_entry_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM ai_drafts d
     WHERE d.pre_registration_id = pr.id AND d.entity_id = pr.entity_id
       AND d.status IN ('pending_review', 'approved'))`;

export async function codePreRegistration(
  entityId: string,
  preRegistrationId: string,
  coding: PreRegistrationCoding
): Promise<Record<string, unknown>> {
  const { defaultAccountId, line } = coding;
  if (!defaultAccountId && !line?.accountId && !line?.costCenterId) {
    throw new ValidationError('Nothing to code: pass an account, or a line with an account or a cost center.');
  }

  return withTransaction(async (client) => {
    const current = await client.query<Record<string, unknown>>(
      `SELECT pr.* FROM pre_registrations pr WHERE pr.id = $1 AND pr.entity_id = $2 FOR UPDATE`,
      [preRegistrationId, entityId]
    );
    if (current.rows.length === 0) throw new NotFoundError('Pre-registration', preRegistrationId);
    const pre = current.rows[0];

    // An account of another entity, a header or an inactive one would only
    // fail later, at posting time, with the pre-registration already in error.
    const accountIds = [defaultAccountId, line?.accountId].filter((a): a is string => !!a);
    if (accountIds.length > 0) {
      const postable = await client.query<{ id: string }>(
        `SELECT id FROM accounts
          WHERE id = ANY($1::uuid[]) AND entity_id = $2 AND is_header = false AND is_active = true`,
        [accountIds, entityId]
      );
      const found = new Set(postable.rows.map((r) => r.id));
      const bad = accountIds.find((a) => !found.has(a));
      if (bad) throw new ValidationError(`Account ${bad} is not a postable account of this entity (header or inactive).`, 'account');
    }

    const lines = (pre.lines ?? []) as LineWithSuggestion[];
    if (line) {
      const target = lines.find((l) => Number(l.line_number) === line.lineNumber);
      if (!target) {
        throw new NotFoundError('Pre-registration line', `${preRegistrationId} line ${line.lineNumber}`);
      }
      if (line.accountId) target.account_id = line.accountId;
      if (line.costCenterId) target.cost_center_id = line.costCenterId;
    }

    // `account_mapping_method = 'manual'` is the trace of who decided: a
    // person at the terminal, not a rule and not the model.
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE pre_registrations pr
          SET lines = $4::jsonb,
              default_account_id = COALESCE($5::uuid, pr.default_account_id),
              account_mapping_method = 'manual',
              updated_at = NOW()
        WHERE ${CODABLE}
        RETURNING pr.*`,
      [preRegistrationId, entityId, [...CODABLE_STATUSES], JSON.stringify(lines), defaultAccountId ?? null]
    );
    if (updated.rowCount !== 1) {
      throw new AccountingError(
        PRE_REGISTRATION_NOT_CODABLE,
        `Pre-registration ${preRegistrationId} is "${String(pre.status)}"` +
          (pre.bill_id ? ', already a bill' : '') +
          ': only one in draft, ready or error, with no bill, no entry and no AI draft in review ' +
          'or approved, can be coded.'
      );
    }
    return updated.rows[0];
  });
}
