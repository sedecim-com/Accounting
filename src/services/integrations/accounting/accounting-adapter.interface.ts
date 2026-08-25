// ============================================================
// EXTERNAL ACCOUNTING SYSTEMS
// Normalized contract for talking to other accounting systems
// (Contalink, and later CONTPAQi, Aspel, QuickBooks…). READS
// are direct; WRITES to the external system are staged in
// ai_external_ops and executed by a human
// (`mnemosine outbox`) — never by the AI directly.
// ============================================================

export interface ExternalTrialBalanceRow {
  account_code: string;
  account_name: string;
  period_debits: number;
  period_credits: number;
  ending_balance: number;
}

export interface ManualPolicyInput {
  record_date: string; // YYYY-MM-DD
  description: string;
  records: Array<{ account_code: string; debit: number; credit: number }>;
}

export interface FiscalDocumentsQuery {
  transaction_type: 'E' | 'R'; // issued (emitidos) | received (recibidos)
  document_type: 'Nomina' | 'Ingreso' | 'Egreso' | 'Pago';
  rfc: string;
  start_date: string;
  end_date: string;
  page?: number;
}

export interface IExternalAccountingAdapter {
  readonly name: string;
  /** Remote trial balance, normalized. */
  getTrialBalance(startDate: string, endDate: string): Promise<ExternalTrialBalanceRow[]>;
  /** Balance of an account as of a date. */
  getAccountBalance(accountNumber: string, date: string): Promise<number>;
  /** List of fiscal documents (CFDIs) recorded in the external system. */
  listFiscalDocuments(query: FiscalDocumentsQuery): Promise<unknown>;
  // ─── Writes (only via outbox) ───
  createManualPolicy(input: ManualPolicyInput): Promise<Record<string, unknown>>;
  updateManualPolicy(policyId: number, input: ManualPolicyInput): Promise<Record<string, unknown>>;
  uploadXml(xmlBase64: string, name?: string): Promise<Record<string, unknown>>;
  createBankTransaction(input: {
    bank: string; date: string; deposit: number; withdrawal: number;
    reference: string; description?: string;
  }): Promise<Record<string, unknown>>;
  reconcileInvoice(input: {
    invoice_id: string; amount: number; bank_account: string;
    payment_date: string; payment_form: string;
  }): Promise<Record<string, unknown>>;
}
