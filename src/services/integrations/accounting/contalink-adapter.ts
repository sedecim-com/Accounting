import type {
  ExternalTrialBalanceRow,
  FiscalDocumentsQuery,
  IExternalAccountingAdapter,
  ManualPolicyInput,
} from './accounting-adapter.interface.js';

// ============================================================
// CONTALINK ADAPTER (apidocs.contalink.com, OpenAPI 1.0.4)
// - Auth: RAW API key in the Authorization header (not Bearer).
// - Response convention: { status: 1 } = success, { status: 0 }
//   = error (inverted from the intuitive — careful).
// - Trial balance amounts arrive as STRINGS ("debe", "haber",
//   "final_saldo") and the fields come in Spanish.
// ============================================================

const DEFAULT_BASE_URL = 'https://794lol2h95.execute-api.us-east-1.amazonaws.com/prod';

interface ContalinkEnvelope {
  status: number;
  message?: string;
  [key: string]: unknown;
}

export class ContalinkAdapter implements IExternalAccountingAdapter {
  readonly name = 'contalink';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async request<T extends ContalinkEnvelope>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.apiKey,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Contalink HTTP ${response.status} at ${path}`);
    }
    const data = (await response.json()) as T;
    // Contalink: status 1 = success, 0 = error.
    if (data.status !== 1) {
      throw new Error(`Contalink rejected the operation at ${path}: ${data.message || 'no message'}`);
    }
    return data;
  }

  async getTrialBalance(startDate: string, endDate: string): Promise<ExternalTrialBalanceRow[]> {
    const qs = new URLSearchParams({ start_date: startDate, end_date: endDate, period: 'O' });
    const data = await this.request<ContalinkEnvelope & {
      trial_balance?: { items?: Array<Record<string, unknown>> };
    }>('GET', `/accounting/trial-balance/?${qs}`);

    const items = data.trial_balance?.items ?? [];
    return items.map((item) => ({
      account_code: String(item.cuenta_numero ?? ''),
      account_name: String(item.cuenta ?? ''),
      period_debits: toNumber(item.debe),
      period_credits: toNumber(item.haber),
      ending_balance: toNumber(item.final_saldo),
    }));
  }

  async getAccountBalance(accountNumber: string, date: string): Promise<number> {
    const qs = new URLSearchParams({ date, period: 'O' });
    const data = await this.request<ContalinkEnvelope & { balance?: { amount?: unknown } }>(
      'GET',
      `/accounting/get-account-balance/${encodeURIComponent(accountNumber)}/?${qs}`
    );
    return toNumber(data.balance?.amount);
  }

  async listFiscalDocuments(query: FiscalDocumentsQuery): Promise<unknown> {
    const qs = new URLSearchParams({
      transaction_type: query.transaction_type,
      document_type: query.document_type,
      rfc: query.rfc,
      start_date: query.start_date,
      end_date: query.end_date,
      page: String(query.page ?? 0),
    });
    const data = await this.request<ContalinkEnvelope & { list?: unknown }>(
      'GET',
      `/invoices/list/?${qs}`
    );
    return data.list ?? [];
  }

  async createManualPolicy(input: ManualPolicyInput): Promise<Record<string, unknown>> {
    return this.request('POST', '/accounting/manual-accounting-policy/', {
      record_date: input.record_date,
      description: input.description,
      accounting_records: input.records,
    });
  }

  async updateManualPolicy(policyId: number, input: ManualPolicyInput): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/accounting/manual-accounting-policy/${policyId}/`, {
      record_date: input.record_date,
      description: input.description,
      accounting_records: input.records,
    });
  }

  async uploadXml(xmlBase64: string, name?: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/invoices/upload/', { xml: xmlBase64, ...(name ? { name } : {}) });
  }

  async createBankTransaction(input: {
    bank: string; date: string; deposit: number; withdrawal: number;
    reference: string; description?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/treasury/bank-transactions/', {
      bank: input.bank, date: input.date, deposit: input.deposit,
      withdrawal: input.withdrawal, reference: input.reference,
      description: input.description ?? '',
    });
  }

  async reconcileInvoice(input: {
    invoice_id: string; amount: number; bank_account: string;
    payment_date: string; payment_form: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/conciliation/create/', input);
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = parseFloat(String(value ?? '0').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
