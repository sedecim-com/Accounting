import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query } from '../../../database/connection.js';
import { decrypt } from '../../../utils/encryption.js';
import { NotFoundError } from '../../../utils/errors.js';
import type { EntityScope } from '../../../database/scope.js';
import { corridaEnEntidad } from '../common/alcance-nomina.js';

// ============================================================
// NACHA ACH Direct Deposit File Generator (PPD format)
// 94-char fixed-width records. Mandatory for bank submission.
// Reference: NACHA Operating Rules.
// ============================================================

interface NachaCompanyInfo {
  immediate_destination: string;   // Receiving DFI routing (9 digits, left-padded with space)
  immediate_origin: string;         // Originator tax ID or DFI routing (10 digits)
  company_name: string;             // 16 chars
  company_identification: string;   // 10 chars (usually FEIN prefixed with 1)
  odfi_routing: string;             // Originating DFI routing (first 8 digits)
  effective_entry_date: string;     // YYMMDD
  company_descriptive_date?: string;
}

function pad(value: string | number, len: number, left = false, fill = ' '): string {
  const s = String(value);
  if (s.length > len) return s.slice(0, len);
  return left ? fill.repeat(len - s.length) + s : s + fill.repeat(len - s.length);
}

function padN(n: number, len: number): string {
  return pad(Math.round(n).toString(), len, true, '0');
}

function yymmdd(dateStr: string): string {
  const d = new Date(dateStr);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return yy + mm + dd;
}

function hhmm(): string {
  const d = new Date();
  return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
}

/**
 * The ACH file the bank executes, and its response carries every employee's
 * routing and account number DECRYPTED.
 *
 * TEN-11 (#235), measured against Postgres: a session granted only company A
 * asked for company B's pay run and got B's employees' account numbers in the
 * response, plus a batch written over B's run. The run was read with
 * `WHERE pr.id = $1` and nothing else — and a run that did not exist threw a
 * plain Error (500) while a foreign one answered 200, so the status code told
 * the caller which ids exist.
 *
 * The scope is an ENTITY scope by type, not any `Scope`: a tenant scope would
 * compile and reopen exactly the axis this closes. And the entity is reached
 * by path (run → period → schedule), because `pay_runs` has no `entity_id`
 * column — the generic helper would fall back to `tenant_id` and return the
 * sibling's row (measured in T9c). Two traps kept out on purpose:
 * `alcanceDeCorrida` emits an unqualified `tenant_id`, ambiguous with two
 * tables in the FROM; and the path column is `pr.pay_period_id`, never
 * `pp.id` — inside `corridaEnEntidad` the alias `pp` shadows the outer one and
 * the EXISTS would be true for every row.
 */
export async function generateNachaFile(
  scope: EntityScope,
  payRunId: string,
  companyInfo: NachaCompanyInfo
): Promise<{ content: string; batch_id: string; total_amount: number; entry_count: number }> {
  const payRun = await query<{ tenant_id: string; pay_date: string }>(
    `SELECT pr.tenant_id, pp.pay_date FROM pay_runs pr
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     WHERE pr.id = $1 AND pr.tenant_id = $2 AND ${corridaEnEntidad('pr.pay_period_id', 3)}`,
    [payRunId, scope.tenantId, scope.entityId]
  );
  // 404, identical to a run that does not exist. It used to be a plain Error:
  // a 500 here and a 200 on a foreign run is an oracle.
  if (payRun.rows.length === 0) throw new NotFoundError('Pay run', payRunId);

  const paychecks = await query<{
    id: string;
    net_pay: string;
    first_name: string;
    last_name: string;
    employee_number: string;
    bank_account_encrypted: string | null;
  }>(
    `SELECT p.id, p.net_pay, e.first_name, e.last_name, e.employee_number, e.bank_account_encrypted
     FROM paychecks p
     JOIN employees e ON e.id = p.employee_id
     WHERE p.pay_run_id = $1 AND e.country_code = 'US' AND e.bank_account_encrypted IS NOT NULL
       AND p.net_pay > 0 AND e.entity_id = $2`,
    // The employee's entity too, not only the run's. A paycheck belongs to its
    // EMPLOYEE (alcance-nomina.ts), and while a foreign employee can still be
    // hung on an own run through `/calculate` (TEN-12), this file must not
    // decrypt that employee's account.
    [payRunId, scope.entityId]
  );

  const effectiveDate = yymmdd(payRun.rows[0].pay_date);
  const fileCreationDate = yymmdd(new Date().toISOString());
  const fileIdModifier = 'A';
  const batchNumber = 1;

  // File Header (Type 1)
  const fileHeader =
    '1' +
    '01' +
    pad(companyInfo.immediate_destination, 10, true) +
    pad(companyInfo.immediate_origin, 10, true) +
    fileCreationDate +
    hhmm() +
    fileIdModifier +
    '094' +
    '10' +
    '1' +
    pad('BANK', 23) +
    pad(companyInfo.company_name, 23) +
    pad('', 8);

  // Batch Header (Type 5)
  const batchHeader =
    '5' +
    '200' +
    pad(companyInfo.company_name, 16) +
    pad('', 20) +
    pad(companyInfo.company_identification, 10) +
    'PPD' +
    pad('PAYROLL', 10) +
    pad(companyInfo.company_descriptive_date || '', 6) +
    effectiveDate +
    pad('', 3) +
    '1' +
    pad(companyInfo.odfi_routing.slice(0, 8), 8) +
    padN(batchNumber, 7);

  // Entry Detail records (Type 6)
  const entries: string[] = [];
  let hashTotal = 0;
  const debitTotal = 0;
  let creditTotal = 0;
  let entryCount = 0;
  /** The paychecks that actually went into the file — and only those get linked. */
  const includedPaycheckIds: string[] = [];

  for (let i = 0; i < paychecks.rows.length; i++) {
    const p = paychecks.rows[i];
    if (!p.bank_account_encrypted) continue;
    let bank: { routing?: string; account?: string; account_type?: string };
    try {
      bank = JSON.parse(decrypt(p.bank_account_encrypted));
    } catch { continue; }
    if (!bank.routing || !bank.account) continue;
    includedPaycheckIds.push(p.id);

    const routing = bank.routing.replace(/\D/g, '').padStart(9, '0').slice(0, 9);
    const transactionCode = bank.account_type === 'savings' ? '32' : '22';
    const cents = Math.round(parseFloat(p.net_pay) * 100);
    const indName = `${p.first_name} ${p.last_name}`.toUpperCase();

    const entry =
      '6' +
      transactionCode +
      routing.slice(0, 8) +
      routing.slice(8, 9) +
      pad(bank.account, 17) +
      padN(cents, 10) +
      pad(p.employee_number, 15) +
      pad(indName, 22) +
      '  ' +
      '0' +
      pad(companyInfo.odfi_routing.slice(0, 8), 8) +
      padN(i + 1, 7);

    entries.push(entry);
    hashTotal += parseInt(routing.slice(0, 8), 10);
    creditTotal += cents;
    entryCount++;
  }

  // Batch Control (Type 8)
  const hashStr = String(hashTotal).slice(-10).padStart(10, '0');
  const batchControl =
    '8' +
    '200' +
    padN(entryCount, 6) +
    hashStr +
    padN(debitTotal, 12) +
    padN(creditTotal, 12) +
    pad(companyInfo.company_identification, 10) +
    pad('', 19) +
    pad('', 6) +
    pad(companyInfo.odfi_routing.slice(0, 8), 8) +
    padN(batchNumber, 7);

  // File Control (Type 9)
  const totalRecords = 2 + entries.length + 2; // header + batch + entries + batchctrl + filectrl
  const blockCount = Math.ceil(totalRecords / 10);
  const fileControl =
    '9' +
    padN(1, 6) +         // batch count
    padN(blockCount, 6) +
    padN(entryCount, 8) +
    hashStr +
    padN(debitTotal, 12) +
    padN(creditTotal, 12) +
    pad('', 39);

  let content = [fileHeader, batchHeader, ...entries, batchControl, fileControl].join('\r\n') + '\r\n';

  // Pad to full blocks of 10 with filler records (94 chars of '9')
  const currentRecords = totalRecords;
  const paddingRecords = (10 - (currentRecords % 10)) % 10;
  for (let i = 0; i < paddingRecords; i++) {
    content += '9'.repeat(94) + '\r\n';
  }

  // Persist batch
  const batchId = uuidv4();
  const sha256 = createHash('sha256').update(content).digest('hex');
  await query(
    `INSERT INTO direct_deposit_batches (
      id, tenant_id, pay_run_id, rail, total_amount, entry_count, effective_date, status, file_sha256
    ) VALUES ($1, $2, $3, 'ach_nacha', $4, $5, $6, 'draft', $7)`,
    [batchId, payRun.rows[0].tenant_id, payRunId, (creditTotal / 100).toFixed(2), entryCount, payRun.rows[0].pay_date, sha256]
  );

  // The ids that went into the file, not "any `entryCount` paychecks of the
  // run": that `LIMIT` had no ORDER BY, so which rows got linked to this batch
  // was up to the planner — including paychecks that were skipped for having
  // no bank data, and ones already travelling in another batch.
  await query(
    `UPDATE paychecks SET direct_deposit_batch_id = $1
     WHERE pay_run_id = $2 AND id = ANY($3::uuid[])`,
    [batchId, payRunId, includedPaycheckIds]
  );

  return { content, batch_id: batchId, total_amount: creditTotal / 100, entry_count: entryCount };
}
