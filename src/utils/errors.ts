import { t, type Language, type MessageParams, type TranslationKey } from '../i18n/index.js';

/**
 * A message written by catalog key instead of by prose (I9 · issue #151).
 *
 * The `code` of an error is wire contract and never changes with the reader's
 * language; the `message` is for a human and does. An error built from a key
 * carries both, and each surface renders the message in its own language: the
 * REST error handler by `Accept-Language`, the CLI by the active locale.
 */
export interface ErrorMessageKey {
  readonly key: TranslationKey;
  readonly params?: MessageParams;
}

/**
 * A keyed message some of whose parameters are lists of keyed items
 * (MNE-001-726, the refusals of the DIOT batch file): each item renders in the
 * language of its frame, and the items join with `join`. A param is a flat
 * string, so a list that must follow the reader's language cannot be one.
 */
export interface KeyedText extends ErrorMessageKey {
  readonly lists?: Readonly<Record<string, { readonly join: string; readonly items: readonly KeyedText[] }>>;
}

/** The params of `text` with each of its lists rendered in `language`. */
function paramsIn(text: KeyedText, language: Language | undefined): MessageParams {
  if (text.lists === undefined) return text.params ?? {};
  const params: Record<string, string | number> = { ...text.params };
  for (const [name, list] of Object.entries(text.lists)) {
    params[name] = list.items.map((item) => t(item.key, paramsIn(item, language), language)).join(list.join);
  }
  return params;
}

export class AppError extends Error {
  /** The key the message was written with, when it was. Absent for prose errors. */
  public readonly messageKey?: KeyedText;

  constructor(
    public statusCode: number,
    public code: string,
    message: string | KeyedText,
    public field?: string,
    public details?: Record<string, unknown>
  ) {
    // `message` is fixed in ENGLISH at construction, the same contract as
    // `CliError` (src/cli/kernel/cli-error.ts): it is what ends up in a stack
    // trace and in a log, and a log whose language depends on who made the
    // request cannot be searched. The reader's language is applied only when
    // the message is rendered — see `localized`.
    super(typeof message === 'string' ? message : t(message.key, paramsIn(message, 'en'), 'en'));
    this.name = 'AppError';
    if (typeof message !== 'string') {
      // With lists, `params` also carries them in English, so a reader of
      // `messageKey` (the CLI's JSON envelope) still has every placeholder.
      this.messageKey = message.lists ? { ...message, params: paramsIn(message, 'en') } : message;
    }
  }

  /**
   * The message in `language` (default: the active one). An error that was
   * born from prose returns that prose unchanged: until a site is migrated to a
   * key, its text is whatever it was written in.
   */
  localized(language?: Language): string {
    return this.messageKey
      ? t(this.messageKey.key, paramsIn(this.messageKey, language), language)
      : this.message;
  }
}

export class ValidationError extends AppError {
  constructor(message: string | ErrorMessageKey, field?: string, details?: Record<string, unknown>) {
    super(422, 'VALIDATION_ERROR', message, field, details);
    this.name = 'ValidationError';
  }
}

/** Where a 422 of the REST middleware was found: the body, or one query parameter. */
export type RequestPart = { readonly kind: 'body' } | { readonly kind: 'query'; readonly name: string };

/**
 * One issue of that 422: the dotted field path ('' at the root), the message
 * in English, and the catalog key it was rendered from when it was. A message
 * a schema wrote as prose has no key and reads the same in every language.
 */
export interface RequestIssue {
  readonly path: string;
  readonly message: string;
  readonly key?: ErrorMessageKey;
}

/**
 * The issue list of the 422 in `language`: `<path>: <message>` for a body
 * (`<root>` at the root), the message alone for a query parameter, joined with
 * '; '. The path and the separators are the same in every language. Each
 * distinct key is rendered once: a body can carry millions of issues.
 */
function issueList(where: RequestPart, issues: readonly RequestIssue[], language: Language | undefined): string {
  const rendered = new Map<ErrorMessageKey, string>();
  const textOf = (issue: RequestIssue): string => {
    if (issue.key === undefined || language === 'en') return issue.message;
    let text = rendered.get(issue.key);
    if (text === undefined) {
      text = t(issue.key.key, issue.key.params ?? {}, language);
      rendered.set(issue.key, text);
    }
    return text;
  };
  const line = where.kind === 'body' ? (i: RequestIssue) => `${i.path || '<root>'}: ${textOf(i)}` : textOf;
  return issues.map(line).join('; ');
}

/**
 * The 422 of `validateBody` and `validateQuery` (MNE-001-152, #151): a
 * `ValidationError` written by catalog key, whose issues are keys too.
 *
 * `message` is the zod 3 English of every 422 so far, byte for byte, as every
 * `AppError` keeps its message in English. `localized(language)` renders the
 * frame AND each keyed issue in `language`. `messageKey.params.issues` holds
 * the ENGLISH list, because a param is a flat string: render this error
 * through `localized()`, never by copying `messageKey` elsewhere. It is born
 * only in the REST middleware, so the CLI readers of `messageKey`
 * (entry-command.ts, cfdi-command.ts) never receive it.
 */
export class RequestValidationError extends ValidationError {
  constructor(
    public readonly where: RequestPart,
    public readonly issues: readonly RequestIssue[]
  ) {
    const english = issueList(where, issues, 'en');
    super(
      where.kind === 'body'
        ? { key: 'error.VALIDATION_ERROR.body', params: { issues: english } }
        : { key: 'error.VALIDATION_ERROR.query', params: { name: where.name, issues: english } },
      where.kind === 'query' ? where.name : undefined
    );
  }

  override localized(language?: Language): string {
    if (language === 'en' || this.messageKey === undefined) return this.message;
    const issues = issueList(this.where, this.issues, language);
    return t(this.messageKey.key, { ...this.messageKey.params, issues }, language);
  }
}

export class NotFoundError extends AppError {
  /** `resource` and `id` build an English message; a key alone is the whole message, by catalogue. */
  constructor(resource: string | ErrorMessageKey, id?: string) {
    super(404, 'RESOURCE_NOT_FOUND', typeof resource === 'string' ? `${resource}${id ? ` with id ${id}` : ''} not found` : resource);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string | ErrorMessageKey) {
    super(409, 'RESOURCE_ALREADY_EXISTS', message);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string | ErrorMessageKey = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string | ErrorMessageKey = 'Forbidden', details?: Record<string, unknown>) {
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
  constructor(message: string | ErrorMessageKey, details?: Record<string, unknown>) {
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
  constructor(code: string, message: string | ErrorMessageKey, details?: Record<string, unknown>) {
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
