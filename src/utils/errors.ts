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
