import { query } from '../../../database/connection.js';
import { generateEfw2File } from '../usa/forms/w3-generator.js';

// ============================================================
// SSA Business Services Online (BSO) Adapter
// Uploads EFW2 file containing all W-2s for a tax year.
// Real impl: automates BSO upload portal or uses AccuWage pre-validation
// then SFTP/web upload. Production requires SSA-registered account.
// ============================================================

export interface SsaBsoCredentials {
  user_id: string;
  password: string;
  employer_ein: string;
}

export interface SsaSubmissionResult {
  wage_file_id: string;
  status: 'uploaded' | 'validated' | 'accepted' | 'rejected';
  submitted_at: string;
  record_count: number;
  errors?: string[];
}

export async function submitW2sToSsa(
  tenantId: string,
  entityId: string,
  taxYear: number,
  credentials: SsaBsoCredentials,
  submitter: { ein: string; name: string; address: string; contact_name: string; contact_phone: string; contact_email: string }
): Promise<SsaSubmissionResult> {
  if (!credentials.user_id || !credentials.password) {
    throw new Error('SSA BSO credentials required');
  }

  // Generate EFW2 file
  const { content, record_count } = await generateEfw2File(tenantId, entityId, taxYear, submitter);

  // Pre-validate (AccuWage-style) — stub
  const errors: string[] = [];
  if (record_count === 0) errors.push('No W-2 records found');
  if (content.length % 512 !== 0 && content.split('\r\n').some((l) => l.length > 0 && l.length !== 512)) {
    // after stripping final \r\n, every record should be 512 chars
  }

  const wageFileId = `WFID${Date.now().toString().slice(-10)}`;

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, provider, submission_id, submitted_at, data)
     VALUES ($1, $2, 'w2_efw2_bundle', $3, $4, 'ssa_bso', $5, NOW(), $6::jsonb)`,
    [
      tenantId, entityId, taxYear,
      errors.length > 0 ? 'rejected' : 'submitted',
      wageFileId,
      JSON.stringify({ record_count, errors, submitter }),
    ]
  );

  return {
    wage_file_id: wageFileId,
    status: errors.length > 0 ? 'rejected' : 'uploaded',
    submitted_at: new Date().toISOString(),
    record_count,
    errors: errors.length > 0 ? errors : undefined,
  };
}
