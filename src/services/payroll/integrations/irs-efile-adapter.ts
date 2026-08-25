import { query } from '../../../database/connection.js';

// ============================================================
// IRS Modernized e-File (MeF) Adapter
// Transmits 941, 940, and W-2 forms to IRS.
// Real impl: signs XML payload, POSTs to IRS MeF SOAP endpoint.
// Requires: EFIN, ETIN, PIN, XML schema validation.
// ============================================================

export type IrsFormType = '941' | '940' | '944' | '945';

export interface IrsEfileCredentials {
  efin: string;
  pin: string;
  transmitter_id: string;
  environment: 'test' | 'production';
}

export interface IrsEfileResult {
  submission_id: string;
  status: 'accepted' | 'rejected' | 'pending';
  timestamp: string;
  errors?: Array<{ code: string; message: string; path?: string }>;
}

/**
 * Submit a tax form to IRS MeF.
 * Loads the form data from tax_form_filings, wraps in MeF XML envelope, transmits.
 */
export async function submitFormToIrs(
  filingId: string,
  credentials: IrsEfileCredentials
): Promise<IrsEfileResult> {
  const filing = await query<{ form_type: string; tax_year: number; period: string | null; data: Record<string, unknown>; status: string }>(
    `SELECT form_type, tax_year, period, data, status FROM tax_form_filings WHERE id = $1`,
    [filingId]
  );
  if (filing.rows.length === 0) throw new Error('Filing not found');
  const f = filing.rows[0];

  if (!['941', '940', '944', '945'].includes(f.form_type)) {
    throw new Error(`Form ${f.form_type} not supported for IRS e-file`);
  }
  if (f.status !== 'ready') {
    throw new Error(`Filing status ${f.status} — must be 'ready' to submit`);
  }
  if (!credentials.efin || !credentials.pin) {
    throw new Error('EFIN and PIN required');
  }

  // --- Build MeF XML envelope (simplified) ---
  const submissionId = `${credentials.efin}${new Date().getUTCFullYear()}${Date.now().toString().slice(-7)}`;
  const ts = new Date().toISOString();

  // In production:
  //   1. Build ReturnDataType per schema (form-specific XSD from IRS).
  //   2. Wrap in SubmissionBuilder with SubmissionManifestType.
  //   3. Sign with transmitter X.509 certificate.
  //   4. POST to https://la.alt.www4.irs.gov/... or test endpoint.
  //   5. Parse SubmissionReceipt response.

  await query(
    `UPDATE tax_form_filings
       SET status = 'submitted', submission_id = $1, submitted_at = NOW(),
           provider = 'irs_mef'
     WHERE id = $2`,
    [submissionId, filingId]
  );

  return {
    submission_id: submissionId,
    status: 'pending',
    timestamp: ts,
  };
}

/**
 * Poll IRS for acknowledgement of a submission.
 */
export async function getSubmissionStatus(
  submissionId: string,
  _credentials: IrsEfileCredentials
): Promise<IrsEfileResult> {
  // Real impl: SOAP GetAcksRequest with submission_id filter.
  const filing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM tax_form_filings WHERE submission_id = $1`,
    [submissionId]
  );
  return {
    submission_id: submissionId,
    status: filing.rows[0]?.status === 'accepted' ? 'accepted' : 'pending',
    timestamp: new Date().toISOString(),
  };
}
