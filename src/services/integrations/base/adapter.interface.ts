// ============================================================
// INTEGRATION ADAPTER INTERFACE
// Every external integration (PAC, Stripe, Plaid, etc.)
// implements IIntegrationAdapter<C, R> with a common contract.
// ============================================================

export interface AdapterContext {
  tenantId: string;
  userId?: string;
  requestId?: string;
}

export interface AdapterHealthCheck {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface IIntegrationAdapter<TConfig = unknown> {
  /** Unique provider identifier (e.g. 'finkok', 'stripe', 'plaid') */
  readonly providerId: string;

  /** Human-readable name */
  readonly displayName: string;

  /** Geographic region(s) */
  readonly regions: ReadonlyArray<'MX' | 'USA' | 'LATAM' | 'EU' | 'GLOBAL'>;

  /** Integration category */
  readonly category: 'pac' | 'payment' | 'banking' | 'email' | 'storage' |
    'erp' | 'crm' | 'ecommerce' | 'payroll' | 'tax' | 'logistics' |
    'treasury' | 'identity' | 'ocr' | 'ipaas' | 'analytics' | 'other';

  /** Validate and store credentials */
  configure(config: TConfig, ctx: AdapterContext): Promise<void>;

  /** Ping the external service to verify connectivity */
  healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck>;

  /** Return minimal sanitized config (no secrets) for UI display */
  getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>>;
}

// ============================================================
// CATEGORY-SPECIFIC EXTENSIONS
// ============================================================

export interface IPacAdapter extends IIntegrationAdapter {
  readonly category: 'pac';
  readonly regions: readonly ['MX'];

  /**
   * true cuando el adaptador FABRICA el timbre en vez de pedirlo a un PAC.
   * Lo consume el cerrojo de src/services/integrations/mexico/pac/simulacion.ts,
   * que impide guardar un folio inventado como si lo hubiera emitido el SAT.
   * Un adaptador real lo pone en false y solo entonces puede timbrar.
   */
  readonly simulado: boolean;

  /** Stamp a CFDI XML and return the stamped version with UUID */
  stamp(xml: string, ctx: AdapterContext): Promise<{
    uuid: string;
    xml_timbrado: string;
    cadena_original: string;
    fecha_timbrado: Date;
    no_certificado_sat: string;
    sello_sat: string;
  }>;

  /** Cancel a stamped CFDI */
  cancel(params: {
    uuid: string;
    rfcEmisor: string;
    reason: '01' | '02' | '03' | '04';
    replacementUuid?: string;
  }, ctx: AdapterContext): Promise<{
    status: string;
    acuse_xml: string;
  }>;

  /** Get remaining stamps in current plan */
  getRemainingStamps(ctx: AdapterContext): Promise<number>;
}

export interface IPaymentAdapter extends IIntegrationAdapter {
  readonly category: 'payment';

  createCharge(params: {
    amount: string;
    currency: string;
    source: string;               // payment method identifier
    customerId?: string;
    description?: string;
    metadata?: Record<string, string>;
    invoiceId?: string;
  }, ctx: AdapterContext): Promise<{
    externalId: string;
    status: 'pending' | 'succeeded' | 'failed';
    chargedAmount: string;
    fee: string;
    netAmount: string;
    rawResponse: Record<string, unknown>;
  }>;

  refund(params: {
    chargeId: string;
    amount?: string;
    reason?: string;
  }, ctx: AdapterContext): Promise<{
    externalId: string;
    status: string;
    refundedAmount: string;
  }>;

  verifyWebhookSignature(payload: string, signature: string): boolean;
}

export interface IBankingAdapter extends IIntegrationAdapter {
  readonly category: 'banking';

  linkAccount(publicToken: string, ctx: AdapterContext): Promise<{
    accessToken: string;
    itemId: string;
    accounts: Array<{
      externalId: string;
      name: string;
      mask: string;
      type: string;
      subtype: string;
      currency: string;
    }>;
  }>;

  syncTransactions(params: {
    accountId: string;
    startDate: Date;
    endDate: Date;
    cursor?: string;
  }, ctx: AdapterContext): Promise<{
    transactions: Array<{
      externalId: string;
      date: Date;
      amount: string;
      description: string;
      merchantName?: string;
      category?: string;
      rawData: Record<string, unknown>;
    }>;
    nextCursor?: string;
    hasMore: boolean;
  }>;
}

export interface IEmailAdapter extends IIntegrationAdapter {
  readonly category: 'email';

  send(params: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    from?: string;
    subject: string;
    html?: string;
    text?: string;
    attachments?: Array<{
      filename: string;
      content: Buffer | string;
      contentType: string;
    }>;
    replyTo?: string;
    templateId?: string;
    templateVars?: Record<string, unknown>;
  }, ctx: AdapterContext): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
  }>;
}

export interface IStorageAdapter extends IIntegrationAdapter {
  readonly category: 'storage';

  upload(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
    metadata?: Record<string, string>;
    public?: boolean;
  }, ctx: AdapterContext): Promise<{
    url: string;
    key: string;
    etag?: string;
  }>;

  getSignedUrl(key: string, expiresInSeconds: number, ctx: AdapterContext): Promise<string>;
  delete(key: string, ctx: AdapterContext): Promise<void>;
  download(key: string, ctx: AdapterContext): Promise<Buffer>;
}
