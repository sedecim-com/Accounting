import { ExternalRejectedError, ExternalServiceError } from '../../../utils/errors.js';
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
    // Four ways out, and the caller must be able to tell them apart: the
    // three transient ones are worth retrying and the refusal never is.
    // Every one of them used to be a bare `Error` and therefore the
    // generic exit 1.
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // Never arrived: DNS, TLS, connection refused, socket timeout. The
      // request did not reach Contalink, so nothing landed there either.
      throw new ExternalServiceError(this.name, `unreachable at ${path}: ${mensajeDe(err)}`, {
        path,
        stage: 'connect',
      });
    }

    if (!response.ok) {
      const detalle = { path, http_status: response.status };
      if (esTransitorio(response.status)) {
        throw new ExternalServiceError(this.name, `HTTP ${response.status} at ${path}`, detalle);
      }
      // A 4xx is Contalink refusing THESE bytes with THIS credential.
      // Re-sending them changes nothing, so this must not read as retryable.
      throw new ExternalRejectedError(this.name, `HTTP ${response.status} at ${path}`, detalle);
    }

    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (err) {
      // A proxy, a CDN or a captive portal answered 200 with something that
      // is not JSON. This line lived OUTSIDE any guard: the operator got a
      // bare `Unexpected token '<'` that did not even name the provider.
      throw new ExternalServiceError(
        this.name,
        `answered ${response.status} at ${path} with a body that is not JSON: ${mensajeDe(err)}`,
        { path, http_status: response.status, stage: 'decode' }
      );
    }

    // Contalink: status 1 = success, 0 = error.
    if (data.status !== 1) {
      throw new ExternalRejectedError(
        this.name,
        `rejected the operation at ${path}: ${data.message || 'no message'}`,
        { path, envelope_status: data.status }
      );
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

/**
 * Transient by HTTP status. 408 (request timeout) and 429 (rate limited)
 * are the server explicitly saying "come back later"; every 5xx is the
 * server's own failure, not ours. Everything else in the 4xx range is the
 * server saying no to what we sent, and sending it again gets the same no.
 */
function esTransitorio(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function mensajeDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = parseFloat(String(value ?? '0').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
