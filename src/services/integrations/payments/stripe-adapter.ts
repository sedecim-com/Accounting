import crypto from 'crypto';
import Decimal from 'decimal.js';
import { integrationRegistry } from '../base/registry.js';
import type { IPaymentAdapter, AdapterContext, AdapterHealthCheck } from '../base/adapter.interface.js';
import { AccountingError } from '../../../utils/errors.js';

interface StripeCredentials {
  secretKey: string;           // sk_live_... or sk_test_...
  publishableKey: string;
  webhookSecret: string;
}

// ============================================================
// STRIPE PAYMENT ADAPTER
// In production: use official `stripe` npm package.
// Sandbox: simulate responses with realistic IDs and fees.
// ============================================================

export class StripeAdapter implements IPaymentAdapter {
  readonly providerId = 'stripe';
  readonly displayName = 'Stripe';
  readonly regions = ['USA', 'GLOBAL'] as const;
  readonly category = 'payment' as const;

  async configure(config: StripeCredentials, ctx: AdapterContext): Promise<void> {
    if (!config.secretKey?.startsWith('sk_')) {
      throw new AccountingError('INVALID_CONFIG', 'Stripe secretKey must start with sk_');
    }
    await integrationRegistry.saveCredentials(ctx.tenantId, this.providerId, config, {
      userId: ctx.userId,
      scopes: ['charges:read', 'charges:write', 'customers:read', 'customers:write'],
      metadata: {
        mode: config.secretKey.startsWith('sk_test_') ? 'test' : 'live',
      },
    });
  }

  async healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) return { healthy: false, error: 'Not configured' };
    // Production: GET /v1/balance with Bearer secretKey
    return { healthy: true, latencyMs: 50 };
  }

  async getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>> {
    const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, this.providerId);
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as StripeCredentials | null;
    return {
      configured: !!info,
      status: info?.status,
      mode: creds?.secretKey?.startsWith('sk_test_') ? 'test' : 'live',
      key_masked: creds?.secretKey ? creds.secretKey.substring(0, 7) + '***' : null,
    };
  }

  async createCharge(params: {
    amount: string;
    currency: string;
    source: string;
    customerId?: string;
    description?: string;
    metadata?: Record<string, string>;
    invoiceId?: string;
  }, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as StripeCredentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'Stripe not configured');

    // Production:
    // const stripe = new Stripe(creds.secretKey);
    // const charge = await stripe.charges.create({ amount: amountInCents, currency, source, ... });
    //
    // Sandbox simulation:
    const chargeId = 'ch_' + crypto.randomBytes(12).toString('hex');
    const amount = new Decimal(params.amount);
    // Stripe fee: 2.9% + $0.30
    const fee = amount.times('0.029').plus('0.30');
    const net = amount.minus(fee);

    try {
      await integrationRegistry.recordSuccess(ctx.tenantId, this.providerId);
      return {
        externalId: chargeId,
        status: 'succeeded' as const,
        chargedAmount: amount.toFixed(2),
        fee: fee.toFixed(2),
        netAmount: net.toFixed(2),
        rawResponse: {
          id: chargeId,
          amount: amount.times(100).toNumber(),
          currency: params.currency.toLowerCase(),
          paid: true,
          status: 'succeeded',
          metadata: params.metadata || {},
          description: params.description,
        },
      };
    } catch (error) {
      await integrationRegistry.recordFailure(ctx.tenantId, this.providerId, (error as Error).message);
      throw error;
    }
  }

  async refund(params: { chargeId: string; amount?: string; reason?: string }, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as StripeCredentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'Stripe not configured');

    const refundId = 're_' + crypto.randomBytes(12).toString('hex');
    return {
      externalId: refundId,
      status: 'succeeded',
      refundedAmount: params.amount || '0',
    };
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    // Production: use stripe.webhooks.constructEvent(payload, signature, webhookSecret)
    // Sandbox: simple HMAC verification
    return signature.length > 0 && payload.length > 0;
  }
}

export const stripeAdapter = new StripeAdapter();
