// Register all adapters on import
import { integrationRegistry } from './base/registry.js';
import { stripeAdapter } from './payments/stripe-adapter.js';
import { conektaAdapter } from './payments/conekta-adapter.js';
import { sendGridAdapter } from './email/sendgrid-adapter.js';
import { s3Adapter } from './storage/s3-adapter.js';

// PAC adapters are registered by pac-router.ts
import './mexico/pac/pac-router.js';

// Register remaining adapters
integrationRegistry.register(stripeAdapter);
integrationRegistry.register(conektaAdapter);
integrationRegistry.register(sendGridAdapter);
integrationRegistry.register(s3Adapter);

export { integrationRegistry };
export { pacRouter } from './mexico/pac/pac-router.js';
export { circuitBreaker, CircuitBreakerOpenError } from './base/circuit-breaker.js';
export { withRetry, isRetryableHttpError } from './base/retry.js';
