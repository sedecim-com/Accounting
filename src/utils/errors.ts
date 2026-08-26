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
