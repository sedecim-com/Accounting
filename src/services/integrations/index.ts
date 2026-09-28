// Register all adapters on import
import { integrationRegistry } from './base/registry.js';
import { stripeAdapter } from './payments/stripe-adapter.js';
import { conektaAdapter } from './payments/conekta-adapter.js';

// PAC adapters are registered by pac-router.ts
import './mexico/pac/pac-router.js';

// Register remaining adapters
//
// NOTE: there is no storage adapter, on purpose (#370). The S3 one was a stub:
// it kept each tenant's AWS access keys, reported healthy without calling AWS
// and uploaded nothing. Migration 102 deleted the keys it had stored. A real
// one comes back with @aws-sdk/client-s3 and an IAM role, never with static
// keys per tenant; behind the gateway, the platform's file-manager-api is the
// other road (#333).
integrationRegistry.register(stripeAdapter);
integrationRegistry.register(conektaAdapter);

export { integrationRegistry };
export { pacRouter } from './mexico/pac/pac-router.js';
export { circuitBreaker, CircuitBreakerOpenError } from './base/circuit-breaker.js';
export { withRetry } from './base/retry.js';
