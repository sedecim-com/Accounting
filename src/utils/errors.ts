export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public field?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field?: string, details?: Record<string, unknown>) {
    super(422, 'VALIDATION_ERROR', message, field, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(404, 'RESOURCE_NOT_FOUND', `${resource}${id ? ` with id ${id}` : ''} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'RESOURCE_ALREADY_EXISTS', message);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super(403, 'FORBIDDEN', message, undefined, details);
    this.name = 'ForbiddenError';
  }
}

/**
 * 501 — the act this endpoint names is one mnemosine does NOT perform.
 *
 * Reserved for a capability that was REMOVED rather than left half-built.
 * The distinction matters: a 404 says "wrong URL", a 422 says "fix your
 * request and retry", and both invite the caller to keep trying. A 501
 * says the act will never happen here, and the message must therefore
 * name the channel where it DOES happen — the IRS portal, the SSA BSO
 * upload, the bank's own payment run.
 *
 * Never use this for work that is merely pending. An endpoint that
 * answers 501 is a promise the system has publicly withdrawn.
 */
export class NotImplementedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(501, 'NOT_IMPLEMENTED', message, undefined, details);
    this.name = 'NotImplementedError';
  }
}

/**
 * 502 — a service we call on the client's behalf did NOT answer usefully:
 * the network never reached it, it timed out, it answered 5xx, it rate
 * limited us, or it replied 200 with something that is not the JSON it
 * promised. The act may still succeed on a later attempt, so the CLI
 * exits 8 (EXTERNAL_FAILED) and a job runner may retry it unchanged.
 *
 * `provider` is not decoration: a bare `SyntaxError: Unexpected token '<'`
 * from a proxy's HTML error page named nobody, and the operator could not
 * tell which of the client's integrations was down.
 */
export class ExternalServiceError extends AppError {
  constructor(
    public readonly provider: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(502, 'EXTERNAL_SERVICE_FAILED', `${provider}: ${message}`, undefined, {
      provider,
      ...details,
    });
    this.name = 'ExternalServiceError';
  }
}

/**
 * 424 (Failed Dependency, RFC 4918) — the service WAS reached, understood
 * the request and REFUSED it: a bad credential, an unauthorized RFC, a
 * payload it will never accept, or its own rejection envelope. Sending the
 * same bytes again gets the same answer, so the CLI exits 9
 * (EXTERNAL_REJECTED) and a job runner must NEVER blind-retry.
 *
 * The whole point of the pair is that 8 and 9 are the same failure to a
 * human reading the message and OPPOSITE instructions to a cron.
 */
export class ExternalRejectedError extends AppError {
  constructor(
    public readonly provider: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(424, 'EXTERNAL_SERVICE_REJECTED', `${provider}: ${message}`, undefined, {
      provider,
      ...details,
    });
    this.name = 'ExternalRejectedError';
  }
}

export class AccountingError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(422, code, message, undefined, details);
    this.name = 'AccountingError';
  }
}

// Error codes for accounting-specific errors
export const ErrorCodes = {
  DEBITS_CREDITS_MISMATCH: 'DEBITS_CREDITS_MISMATCH',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  DUPLICATE_ENTRY_NUMBER: 'DUPLICATE_ENTRY_NUMBER',
  INVOICE_ALREADY_PAID: 'INVOICE_ALREADY_PAID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  BANK_API_ERROR: 'BANK_API_ERROR',
  PAC_TIMBRADO_ERROR: 'PAC_TIMBRADO_ERROR',
  INSUFFICIENT_INVENTORY: 'INSUFFICIENT_INVENTORY',
} as const;
