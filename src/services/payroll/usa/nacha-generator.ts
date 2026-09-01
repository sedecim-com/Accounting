import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query } from '../../../database/connection.js';
import { decrypt } from '../../../utils/encryption.js';

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

export async function generateNachaFile(
  payRunId: string,
  companyInfo: NachaCompanyInfo
): Promise<{ content: string; batch_id: string; total_amount: number; entry_count: number }> {
  const payRun = await query<{ tenant_id: string; pay_date: string }>(
    `SELECT pr.tenant_id, pp.pay_date FROM pay_runs pr
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     WHERE pr.id = $1`,
    [payRunId]
  );
  if (payRun.rows.length === 0) throw new Error('Pay run not found');

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
       AND p.net_pay > 0`,
    [payRunId]
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

  for (let i = 0; i < paychecks.rows.length; i++) {
    const p = paychecks.rows[i];
    if (!p.bank_account_encrypted) continue;
    let bank: { routing?: string; account?: string; account_type?: string };
    try {
      bank = JSON.parse(decrypt(p.bank_account_encrypted));
    } catch { continue; }
    if (!bank.routing || !bank.account) continue;

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

  await query(
    `UPDATE paychecks SET direct_deposit_batch_id = $1
     WHERE pay_run_id = $2 AND id IN (SELECT id FROM paychecks WHERE pay_run_id = $2 LIMIT $3)`,
    [batchId, payRunId, entryCount]
  );

  return { content, batch_id: batchId, total_amount: creditTotal / 100, entry_count: entryCount };
}
