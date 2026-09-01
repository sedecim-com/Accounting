import { query } from '../../../database/connection.js';

// ============================================================
// CIRCUIT BREAKER
// Tracks provider health per tenant and prevents calls to
// failing providers until they recover.
//
// States:
//   closed     → normal operation, calls pass through
//   open       → all calls fail fast (after N consecutive failures)
//   half_open  → trial calls allowed after timeout; success closes, failure reopens
// ============================================================

export interface CircuitBreakerConfig {
  failureThreshold: number;     // consecutive failures before opening
  successThreshold: number;     // consecutive successes to close from half-open
  timeoutMs: number;            // time to wait before half-open
  halfOpenRequests: number;     // max concurrent trial requests
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 60_000,
  halfOpenRequests: 1,
};

export class CircuitBreakerOpenError extends Error {
  constructor(provider: string) {
    super(`Circuit breaker is open for provider: ${provider}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  constructor(private config: CircuitBreakerConfig = DEFAULT_CONFIG) {}

  /**
   * Check if a call is allowed for (tenant, provider)
   */
  async canAttempt(tenantId: string, provider: string): Promise<boolean> {
    const state = await this.getState(tenantId, provider);

    if (state.circuit_state === 'closed') return true;

    if (state.circuit_state === 'open') {
      // Check if timeout has elapsed
      if (state.circuit_will_retry_at && new Date() >= new Date(state.circuit_will_retry_at)) {
        await this.transitionToHalfOpen(tenantId, provider);
        return true;
      }
      return false;
    }

    // half_open: allow limited trial
    return true;
  }

  /**
   * Record a successful call
   */
  async recordSuccess(tenantId: string, provider: string, latencyMs?: number): Promise<void> {
    const state = await this.getState(tenantId, provider);
    const newSuccesses = state.consecutive_successes + 1;

    let newCircuitState = state.circuit_state;
    if (state.circuit_state === 'half_open' && newSuccesses >= this.config.successThreshold) {
      newCircuitState = 'closed';
    }

    await query(
      `INSERT INTO provider_health (
        tenant_id, provider, circuit_state,
        consecutive_failures, consecutive_successes, total_requests,
        avg_latency_ms, last_success_at, updated_at
      ) VALUES ($1, $2, $3, 0, $4, 1, $5, NOW(), NOW())
      ON CONFLICT (tenant_id, provider) DO UPDATE SET
        circuit_state = $3,
        consecutive_failures = 0,
        consecutive_successes = $4,
        total_requests = provider_health.total_requests + 1,
        avg_latency_ms = COALESCE($5, provider_health.avg_latency_ms),
        last_success_at = NOW(),
        circuit_opened_at = CASE WHEN $3 = 'closed' THEN NULL ELSE provider_health.circuit_opened_at END,
        circuit_will_retry_at = CASE WHEN $3 = 'closed' THEN NULL ELSE provider_health.circuit_will_retry_at END,
        updated_at = NOW()`,
      [tenantId, provider, newCircuitState, newSuccesses, latencyMs || null]
    );
  }

  /**
   * Record a failed call
   */
  async recordFailure(tenantId: string, provider: string, _error?: Error): Promise<void> {
    const state = await this.getState(tenantId, provider);
    const newFailures = state.consecutive_failures + 1;

    let newCircuitState = state.circuit_state;
    let circuitOpenedAt: Date | null = null;
    let circuitWillRetryAt: Date | null = null;

    if (state.circuit_state === 'closed' && newFailures >= this.config.failureThreshold) {
      newCircuitState = 'open';
      circuitOpenedAt = new Date();
      circuitWillRetryAt = new Date(Date.now() + this.config.timeoutMs);
    } else if (state.circuit_state === 'half_open') {
      // Half-open failure reopens the circuit
      newCircuitState = 'open';
      circuitOpenedAt = new Date();
      circuitWillRetryAt = new Date(Date.now() + this.config.timeoutMs);
    }

    await query(
      `INSERT INTO provider_health (
        tenant_id, provider, circuit_state,
        consecutive_failures, consecutive_successes, total_requests, total_failures,
        last_failure_at, circuit_opened_at, circuit_will_retry_at, updated_at
      ) VALUES ($1, $2, $3, $4, 0, 1, 1, NOW(), $5, $6, NOW())
      ON CONFLICT (tenant_id, provider) DO UPDATE SET
        circuit_state = $3,
        consecutive_failures = $4,
        consecutive_successes = 0,
        total_requests = provider_health.total_requests + 1,
        total_failures = provider_health.total_failures + 1,
        last_failure_at = NOW(),
        circuit_opened_at = COALESCE($5, provider_health.circuit_opened_at),
        circuit_will_retry_at = COALESCE($6, provider_health.circuit_will_retry_at),
        updated_at = NOW()`,
      [tenantId, provider, newCircuitState, newFailures, circuitOpenedAt, circuitWillRetryAt]
    );
  }

  private async transitionToHalfOpen(tenantId: string, provider: string): Promise<void> {
    await query(
      `UPDATE provider_health SET circuit_state = 'half_open', updated_at = NOW()
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider]
    );
  }

  private async getState(tenantId: string, provider: string): Promise<{
    circuit_state: 'closed' | 'open' | 'half_open';
    consecutive_failures: number;
    consecutive_successes: number;
    circuit_will_retry_at: Date | null;
  }> {
    const result = await query<{
      circuit_state: 'closed' | 'open' | 'half_open';
      consecutive_failures: number;
      consecutive_successes: number;
      circuit_will_retry_at: Date | null;
    }>(
      `SELECT circuit_state, consecutive_failures, consecutive_successes, circuit_will_retry_at
       FROM provider_health WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider]
    );

    if (result.rows.length === 0) {
      return { circuit_state: 'closed', consecutive_failures: 0, consecutive_successes: 0, circuit_will_retry_at: null };
    }

    return result.rows[0];
  }

  /**
   * Wrap an operation with circuit breaker protection
   */
  async execute<T>(
    tenantId: string,
    provider: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const canAttempt = await this.canAttempt(tenantId, provider);
    if (!canAttempt) {
      throw new CircuitBreakerOpenError(provider);
    }

    const start = Date.now();
    try {
      const result = await operation();
      await this.recordSuccess(tenantId, provider, Date.now() - start);
      return result;
    } catch (error) {
      await this.recordFailure(tenantId, provider, error as Error);
      throw error;
    }
  }
}

export const circuitBreaker = new CircuitBreaker();
