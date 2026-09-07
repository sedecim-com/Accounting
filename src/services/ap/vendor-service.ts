import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { findByIdInScope, requireByIdInScope, type Scope } from '../../database/scope.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { encrypt } from '../../utils/encryption.js';
import { generateEntryNumber } from '../../utils/sequence.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import type { Vendor } from '../../types/index.js';

// ============================================================
// VENDOR MASTER — domain service
//
// Extracted from src/api/rest/routes/vendors.ts so the REST API,
// the CLI and the agent share ONE definition of what a vendor is.
// The SQL below is the route's SQL, verbatim in shape and in
// parameter order; what is new here is the part the route could
// only express as a raw constraint failure or not at all:
//
//   - UNIQUE(vendor_number, entity_id) becomes a named conflict.
//     It is reachable: vendor_number is drawn from COUNT(*)
//     (generateEntryNumber, deprecated for exactly this reason),
//     so two concurrent creates draw the same number.
//   - THE TAX ID IS VALIDATED BY COUNTRY. An RFC and an EIN are
//     not interchangeable strings: the RFC is what matches a
//     received CFDI to this vendor and what the DIOT is filed
//     with, and the EIN is what a 1099 is filed with. A typo is
//     not caught downstream — it produces a vendor no CFDI will
//     ever match and a return that cannot be filed.
//   - THE BANK COLUMNS ARE SECRETS. `SELECT *` handed the
//     encrypted blobs to every reader; every function here
//     redacts them by default and a caller must ask for them.
//
// Changing a vendor's bank details is one of the three gates a
// human never delegates (catalog: "Cuentas por pagar"), and the
// pending/second-approval machinery that gate needs does not
// exist yet. So nothing here EDITS bank data: createVendor still
// accepts it because the REST contract already did, and the CLI
// deliberately offers no flag to set it.
// ============================================================

export const TAX_ID_TYPES = ['rfc', 'ein', 'vat'] as const;
export type TaxIdType = (typeof TAX_ID_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persona moral: 3 letters. Persona física: 4. Then YYMMDD and a 3-char homoclave. */
const RFC_RE = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/;
/** IRS EIN: nine digits, conventionally written NN-NNNNNNN. */
const EIN_RE = /^(\d{2})-?(\d{7})$/;
/** VAT: ISO-3166 country prefix and the national number. */
const VAT_RE = /^[A-Z]{2}[A-Z0-9]{2,13}$/;

export interface TaxIdCheck {
  /** Normalized: upper-cased, and an EIN re-hyphenated as NN-NNNNNNN. */
  taxId: string;
  taxIdType: TaxIdType;
  /** Which country's rule was applied — printed, never guessed at silently. */
  rule: string;
}

/** The tax id a country issues, for defaulting --tax-id-type from the entity. */
export function taxIdTypeForCountry(country?: string | null): TaxIdType | undefined {
  const c = (country ?? '').trim().toUpperCase();
  if (c === 'MX' || c === 'MEX' || c === 'MEXICO') return 'rfc';
  if (c === 'US' || c === 'USA') return 'ein';
  return undefined;
}

/**
 * Validates the SHAPE of a tax id under one country's rule and normalizes it.
 * It does not verify the RFC check digit and does not ask the SAT or the IRS
 * whether the taxpayer exists — `vendor screening run` is the command for
 * that, and it has no backend yet. Shape alone still catches the typo that
 * makes a vendor unmatchable.
 */
export function normalizeTaxId(raw: string, type: TaxIdType): TaxIdCheck {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!value) throw new ValidationError('The tax id is empty.', 'tax_id');

  if (type === 'rfc') {
    const rule = 'Mexico (SAT) RFC: 12 characters for a persona moral, 13 for a persona física — 3 or 4 letters, YYMMDD, then a 3-character homoclave';
    const m = RFC_RE.exec(value);
    if (!m) {
      throw new ValidationError(
        `"${raw}" is not a valid RFC. Rule applied — ${rule}.`,
        'tax_id'
      );
    }
    const month = Number(m[3]);
    const day = Number(m[4]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new ValidationError(
        `"${raw}" carries an impossible date (${m[2]}-${m[3]}-${m[4]}) in positions 4-9. Rule applied — ${rule}.`,
        'tax_id'
      );
    }
    return { taxId: value, taxIdType: 'rfc', rule };
  }

  if (type === 'ein') {
    const rule = 'United States (IRS) EIN: nine digits, written NN-NNNNNNN';
    const m = EIN_RE.exec(value);
    if (!m) {
      throw new ValidationError(`"${raw}" is not a valid EIN. Rule applied — ${rule}.`, 'tax_id');
    }
    return { taxId: `${m[1]}-${m[2]}`, taxIdType: 'ein', rule };
  }

  const rule = 'VAT number: an ISO-3166 two-letter country prefix followed by 2 to 13 alphanumerics';
  if (!VAT_RE.test(value)) {
    throw new ValidationError(`"${raw}" is not a valid VAT number. Rule applied — ${rule}.`, 'tax_id');
  }
  return { taxId: value, taxIdType: 'vat', rule };
}

// ---------------------------------------------------------------
// PAYMENT TERMS
//
// `vendors.payment_terms` is free text (VARCHAR(100)) and the only
// reader in the repo was an inline regex in the bills route that
// understood `n/m` and nothing else — so "Net 30" set a due date
// nobody computed and "2/10 net 30" lost the net part. Parsing
// lives here now, and both surfaces read the same answer.
// ---------------------------------------------------------------

export interface PaymentTerms {
  raw: string;
  /** Days from bill date to due date. Null when the text says nothing about it. */
  netDays: number | null;
  /** Early-payment discount: pct off if paid within discountDays. */
  discountPct: number | null;
  discountDays: number | null;
  /** Canonical spelling, for storing back. */
  normalized: string;
  /** True when the text was understood at all. */
  recognized: boolean;
}

const ON_RECEIPT_RE = /^(due\s+on\s+receipt|on\s+receipt|immediate|contado|de\s+contado|inmediato|pue)$/i;

export function parsePaymentTerms(raw: string): PaymentTerms {
  const text = (raw ?? '').trim();
  const base: PaymentTerms = {
    raw: text, netDays: null, discountPct: null, discountDays: null,
    normalized: text, recognized: false,
  };
  if (!text) return base;

  if (ON_RECEIPT_RE.test(text)) {
    return { ...base, netDays: 0, normalized: 'Due on receipt', recognized: true };
  }

  // "2/10" — the discount half. Same regex the bills route used, so a term
  // it already honoured keeps meaning exactly what it meant.
  const discount = /(\d+)\/(\d+)/.exec(text);

  // "Net 30", "net30", "30 días", or a bare "30".
  const netMatch = /net\s*(\d+)/i.exec(text) ?? /(\d+)\s*d[ií]as/i.exec(text);
  let netDays: number | null = null;
  if (netMatch) netDays = Number(netMatch[1]);
  else if (/^\d+$/.test(text)) netDays = Number(text);

  if (!discount && netDays === null) return base;

  const discountPct = discount ? Number(discount[1]) : null;
  const discountDays = discount ? Number(discount[2]) : null;

  const normalized = [
    discount ? `${discountPct}/${discountDays}` : null,
    netDays === null ? null : `Net ${netDays}`,
  ].filter(Boolean).join(' ');

  return { raw: text, netDays, discountPct, discountDays, normalized, recognized: true };
}

/** Due date implied by the terms, as YYYY-MM-DD. Null when they imply none. */
export function dueDateFrom(billDate: Date | string, terms: string | null | undefined): string | null {
  const parsed = parsePaymentTerms(terms ?? '');
  if (parsed.netDays === null) return null;
  const base = new Date(`${String(billDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + parsed.netDays);
  return base.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// BANK SECRETS
// ---------------------------------------------------------------

const BANK_SECRET_COLUMNS = [
  'bank_account_number_encrypted',
  'bank_routing_number_encrypted',
  'clabe_encrypted',
] as const;

/**
 * Drops the encrypted blobs and replaces them with the only fact a reader
 * legitimately needs: whether there is anything on file. Reading the actual
 * numbers is `vendor bank show --reveal`, which needs the audited decrypt
 * path that does not exist yet.
 */
export function redactBankSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const onFile = BANK_SECRET_COLUMNS.some((c) => out[c] !== null && out[c] !== undefined);
  for (const c of BANK_SECRET_COLUMNS) delete out[c];
  out.bank_details_on_file = onFile;
  return out;
}

export interface VendorReadOptions {
  /**
   * Return the encrypted bank blobs as stored. Only the REST surface passes
   * this, and only because it already did before the extraction.
   */
  includeBankSecrets?: boolean;
}

// ---------------------------------------------------------------
// QUERIES
// ---------------------------------------------------------------

export interface VendorFilters extends VendorReadOptions {
  isActive?: boolean;
  /** Matches company_name or vendor_number, case-insensitively. */
  search?: string;
  /** Only vendors flagged for a 1099 (US information return). */
  is1099?: boolean;
  /** Only vendors with no tax id on file — the DIOT/1099 blocker list. */
  missingTaxId?: boolean;
  limit?: number;
  offset?: number;
}

export interface VendorListPage {
  rows: Record<string, unknown>[];
  /** Total matching rows before limit/offset, so truncation is never silent. */
  total: number;
}

export async function listVendors(
  entityId: string,
  filters: VendorFilters = {}
): Promise<VendorListPage> {
  const where: string[] = ['entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.isActive !== undefined) {
    where.push(`is_active = $${i++}`);
    params.push(filters.isActive);
  }
  if (filters.search) {
    where.push(`(company_name ILIKE $${i} OR vendor_number ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i++;
  }
  if (filters.is1099 !== undefined) {
    where.push(`is_1099_vendor = $${i++}`);
    params.push(filters.is1099);
  }
  if (filters.missingTaxId) {
    where.push(`(tax_id IS NULL OR tax_id = '')`);
  }
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const counted = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM vendors ${whereClause}`,
    params
  );
  const total = parseInt(counted.rows[0].count, 10);

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  const result = await query<Vendor>(
    `SELECT * FROM vendors ${whereClause} ORDER BY company_name LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );

  const rows = result.rows as unknown as Record<string, unknown>[];
  return {
    rows: filters.includeBankSecrets ? rows : rows.map(redactBankSecrets),
    total,
  };
}

export interface GetVendorOptions extends VendorReadOptions {
  /** Bills and payments summary: what this vendor actually costs us. */
  includeActivity?: boolean;
}

export async function getVendorById(
  id: string,
  scope: Scope,
  opts: GetVendorOptions = {}
): Promise<Record<string, unknown> | null> {
  // R2: la frontera dentro del SQL (scope.ts), con el alcance obligatorio en
  // la firma — un llamador sin alcance no compila (patrón TEN-1).
  const fila = await findByIdInScope<Vendor>('vendors', id, scope);
  if (!fila) return null;

  const raw = fila as unknown as Record<string, unknown>;
  const vendor = opts.includeBankSecrets ? { ...raw } : redactBankSecrets(raw);

  if (opts.includeActivity) {
    // Money stays a string all the way out: a float round-trip is how an
    // open balance stops matching the control account by a cent.
    const bills = await query<{
      bill_count: string; open_count: string; billed: string; open_balance: string; last_bill_date: string | null;
    }>(
      `SELECT COUNT(*)::text AS bill_count,
              COUNT(*) FILTER (WHERE status NOT IN ('paid', 'void', 'cancelled'))::text AS open_count,
              COALESCE(SUM(total_amount), 0)::text AS billed,
              COALESCE(SUM(amount_due) FILTER (WHERE status NOT IN ('paid', 'void', 'cancelled')), 0)::text AS open_balance,
              MAX(bill_date)::text AS last_bill_date
       FROM bills WHERE vendor_id = $1`,
      [id]
    );
    const payments = await query<{ payment_count: string; paid: string; last_payment_date: string | null }>(
      `SELECT COUNT(*)::text AS payment_count,
              COALESCE(SUM(payment_amount), 0)::text AS paid,
              MAX(payment_date)::text AS last_payment_date
       FROM vendor_payments WHERE vendor_id = $1`,
      [id]
    );
    vendor.activity = { ...bills.rows[0], ...payments.rows[0] };
  }

  return vendor;
}

/**
 * Resolves what a person types — a vendor number, a name, or a uuid — inside
 * one entity. An ambiguous name is a conflict, never a silent first match:
 * paying the wrong "Servicios Integrales" is not a recoverable mistake.
 */
export async function resolveVendor(entityId: string, ref: string): Promise<Vendor> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('No vendor was given.', 'vendor');

  if (UUID_RE.test(trimmed)) {
    const byId = await query<Vendor>('SELECT * FROM vendors WHERE id = $1 AND entity_id = $2', [trimmed, entityId]);
    if (byId.rows.length === 0) throw new NotFoundError('Vendor', trimmed);
    return byId.rows[0];
  }

  const exact = await query<Vendor>(
    `SELECT * FROM vendors
     WHERE entity_id = $1 AND (vendor_number = $2 OR upper(company_name) = upper($2) OR upper(tax_id) = upper($2))
     ORDER BY company_name`,
    [entityId, trimmed]
  );
  if (exact.rows.length === 1) return exact.rows[0];
  if (exact.rows.length > 1) throw ambiguous(trimmed, exact.rows);

  const fuzzy = await query<Vendor>(
    `SELECT * FROM vendors WHERE entity_id = $1 AND company_name ILIKE $2 ORDER BY company_name`,
    [entityId, `%${trimmed}%`]
  );
  if (fuzzy.rows.length === 1) return fuzzy.rows[0];
  if (fuzzy.rows.length === 0) throw new NotFoundError('Vendor', trimmed);
  throw ambiguous(trimmed, fuzzy.rows);
}

function ambiguous(ref: string, rows: Vendor[]): ConflictError {
  const list = rows.slice(0, 10).map((v) => `  - ${v.vendor_number}  ${v.company_name}`).join('\n');
  return new ConflictError(
    `"${ref}" matches ${rows.length} vendors. Name one of them exactly, or use its vendor number:\n${list}`
  );
}

// ---------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------

export interface CreateVendorInput {
  entity_id: string;
  company_name: string;
  created_by: string;
  /**
   * G3: por qué se dio de alta. Opcional —el alta de un proveedor no es un
   * acto que exija justificarse, a diferencia de `--force`— pero cuando el
   * llamador lo trae va al rastro, que es donde alguien lo va a buscar.
   */
  reason?: string | null;
  contact_name?: string | null;
  tax_id?: string | null;
  tax_id_type?: string | null;
  email?: string | null;
  phone?: string | null;
  payment_terms?: string | null;
  default_expense_account_id?: string | null;
  currency_code?: string | null;
  /**
   * Bank details at creation. The REST contract has always accepted these
   * unverified, so they stay reachable; the CLI never sends them, because a
   * bank detail that nobody verified out of band is how an invoice gets paid
   * to somebody else's account.
   */
  bank_account_number?: string | null;
  bank_routing_number?: string | null;
  clabe?: string | null;
  bank_name?: string | null;
  is_1099_vendor?: boolean;
}

/**
 * G3 · LAS COLUMNAS DEL ALTA QUE SÍ VAN AL RASTRO.
 *
 * Enumeradas, no un `{...row}` menos tres: el rastro de un alta se lee años
 * después, y un `SELECT *` que mañana traiga una columna nueva la publicaría
 * en la bitácora sin que nadie lo decidiera. Aquí falta a propósito todo lo
 * bancario —incluidos los blobs YA CIFRADOS—: `audit_log` es de sólo agregar
 * (033) y una CLABE que entra ahí no vuelve a salir jamás, ni rotando la
 * llave. Lo que el rastro guarda de la parte bancaria es el HECHO de si el
 * alta traía datos, que es lo que un investigador necesita saber.
 */
const VENDOR_AUDIT_FIELDS = [
  'vendor_number', 'company_name', 'contact_name', 'tax_id', 'tax_id_type',
  'is_1099_vendor', 'email', 'phone', 'payment_terms',
  'default_expense_account_id', 'currency_code', 'bank_name',
] as const;

function vendorParaRastro(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of VENDOR_AUDIT_FIELDS) out[f] = row[f] ?? null;
  out.bank_details_on_file = BANK_SECRET_COLUMNS.some(
    (c) => row[c] !== null && row[c] !== undefined
  );
  return out;
}

export async function createVendor(
  input: CreateVendorInput,
  opts: VendorReadOptions = {}
): Promise<Record<string, unknown>> {
  // G3: el alta y su rastro en UNA transacción. `query()` saca una conexión
  // por sentencia, así que el conteo, el INSERT y la auditoría se confirmaban
  // por separado: si el INSERT moría, quedaba un renglón de auditoría de un
  // proveedor que no existe; si moría la auditoría, quedaba el proveedor sin
  // autor. Un proveedor es a DÓNDE va el dinero —la cuenta de gasto por
  // omisión y, con `vendor bank set`, la cuenta bancaria de destino—: darlo
  // de alta sin dejar quién lo hizo es el hueco que el argumento de venta de
  // mnemosine no puede permitirse.
  const row = await withTransaction(async (client) => {
    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM vendors WHERE entity_id = $1',
      [input.entity_id]
    );
    const vendorNumber = generateEntryNumber('V', parseInt(countResult.rows[0].count, 10));

    let result;
    try {
      result = await client.query<Vendor>(
        `INSERT INTO vendors (
          id, entity_id, vendor_number, company_name, contact_name, tax_id, tax_id_type,
          is_1099_vendor, email, phone, payment_terms, default_expense_account_id,
          currency_code, bank_account_number_encrypted, bank_routing_number_encrypted,
          clabe_encrypted, bank_name, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [
          uuidv4(), input.entity_id, vendorNumber, input.company_name, input.contact_name || null,
          input.tax_id || null, input.tax_id_type || null, input.is_1099_vendor || false,
          input.email || null, input.phone || null, input.payment_terms || 'Net 30',
          input.default_expense_account_id || null, input.currency_code || 'USD',
          input.bank_account_number ? encrypt(input.bank_account_number) : null,
          input.bank_routing_number ? encrypt(input.bank_routing_number) : null,
          input.clabe ? encrypt(input.clabe) : null, input.bank_name || null,
          input.created_by,
        ]
      );
    } catch (err) {
      // vendor_number comes from COUNT(*), so UNIQUE(vendor_number, entity_id)
      // is reachable by two concurrent creates. Name it instead of letting a
      // 23505 surface as an unexplained failure.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(
          `Vendor number "${vendorNumber}" already exists in this entity. Two vendors were created at the same time; run the command again.`
        );
      }
      throw err;
    }

    const creado = result.rows[0] as unknown as Record<string, unknown>;
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, input.entity_id),
      userId: input.created_by,
      action: 'create',
      // 'vendor' en singular, como el que ya escribe `updateVendor`: dos
      // grafías para el mismo objeto parten su historial en dos.
      entityType: 'vendor',
      entityId: creado.id as string,
      oldValues: null,
      newValues: vendorParaRastro(creado),
      reason: input.reason ?? null,
    });
    return creado;
  });

  return opts.includeBankSecrets ? row : redactBankSecrets(row);
}

/**
 * The only columns a caller may change here. Bank columns are absent on
 * purpose: changing them is `vendor bank set`, a two-person irreversible
 * flow whose table does not exist yet.
 */
export const VENDOR_UPDATABLE_FIELDS = [
  'company_name', 'contact_name', 'email', 'phone', 'payment_terms', 'is_active', 'notes',
] as const;
export type VendorUpdatableField = (typeof VENDOR_UPDATABLE_FIELDS)[number];
export type VendorPatch = Partial<Record<VendorUpdatableField, unknown>>;

export interface VendorUpdateContext {
  userId: string;
  /**
   * Present ⇒ the change is written to audit_log (which is tenant-scoped).
   * The catalog's gap for `vendor edit` was exactly this: seven columns
   * changed with no trail of who or why.
   */
  tenantId?: string;
  reason?: string;
}

export async function updateVendor(
  id: string,
  scope: Scope,
  patch: VendorPatch,
  ctx: VendorUpdateContext,
  opts: VendorReadOptions = {}
): Promise<Record<string, unknown>> {
  const fields = VENDOR_UPDATABLE_FIELDS.filter((f) => patch[f] !== undefined);
  if (fields.length === 0) {
    throw new ValidationError(
      `No updatable field given. One of: ${VENDOR_UPDATABLE_FIELDS.join(', ')}.`
    );
  }

  const row = await withTransaction(async (client) => {
    // R2: pertenencia y candado en la MISMA sentencia (scope.ts); el UPDATE
    // por id que sigue es seguro: la fila ya está probada y bloqueada.
    const beforeRow = await requireByIdInScope<Vendor>('vendors', id, scope, {
      forUpdate: true,
      client,
    });

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const field of fields) {
      sets.push(`${field} = $${i++}`);
      params.push(patch[field]);
    }
    sets.push('updated_at = NOW()');
    params.push(id);

    const updated = await client.query<Vendor>(
      `UPDATE vendors SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );

    if (ctx.tenantId) {
      const previous = beforeRow as unknown as Record<string, unknown>;
      await client.query(
        `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, old_values, new_values, reason)
         VALUES ($1, $2, $3, 'update', 'vendor', $4, $5, $6, $7)`,
        [
          uuidv4(), ctx.userId, ctx.tenantId, id,
          JSON.stringify(Object.fromEntries(fields.map((f) => [f, previous[f] ?? null]))),
          JSON.stringify(Object.fromEntries(fields.map((f) => [f, patch[f] ?? null]))),
          ctx.reason ?? null,
        ]
      );
    }
    return updated.rows[0] as unknown as Record<string, unknown>;
  });

  return opts.includeBankSecrets ? row : redactBankSecrets(row);
}

/**
 * Sets payment terms through the parser, so what lands in the column is a
 * term something can compute a due date from. `updateVendor` still accepts
 * free text: that is the REST contract, and it is not this function.
 */
export async function setVendorTerms(
  id: string,
  scope: Scope,
  input: { terms?: string; currencyCode?: string },
  ctx: VendorUpdateContext
): Promise<{ vendor: Record<string, unknown>; terms: PaymentTerms | null }> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  let parsed: PaymentTerms | null = null;

  if (input.terms !== undefined) {
    parsed = parsePaymentTerms(input.terms);
    if (!parsed.recognized) {
      throw new ValidationError(
        `Payment terms "${input.terms}" were not understood, so no due date could ever be computed from them. ` +
          'Use "Net 30", "2/10 Net 30", or "Due on receipt".',
        'payment_terms'
      );
    }
    sets.push(`payment_terms = $${i++}`);
    params.push(parsed.normalized);
  }
  if (input.currencyCode !== undefined) {
    const code = input.currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new ValidationError(`"${input.currencyCode}" is not a 3-letter ISO currency code.`, 'currency_code');
    }
    sets.push(`currency_code = $${i++}`);
    params.push(code);
  }
  if (sets.length === 0) {
    throw new ValidationError('Nothing to set: pass terms, a currency, or both.');
  }

  const vendor = await withTransaction(async (client) => {
    // R2: pertenencia y candado en la MISMA sentencia (scope.ts); el UPDATE
    // por id que sigue es seguro: la fila ya está probada y bloqueada.
    const beforeRow = await requireByIdInScope<Vendor>('vendors', id, scope, {
      forUpdate: true,
      client,
    });

    sets.push('updated_at = NOW()');
    params.push(id);
    const updated = await client.query<Vendor>(
      `UPDATE vendors SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );

    if (ctx.tenantId) {
      const previous = beforeRow;
      await client.query(
        `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, old_values, new_values, reason)
         VALUES ($1, $2, $3, 'update', 'vendor', $4, $5, $6, $7)`,
        [
          uuidv4(), ctx.userId, ctx.tenantId, id,
          JSON.stringify({ payment_terms: previous.payment_terms, currency_code: previous.currency_code }),
          JSON.stringify({ payment_terms: updated.rows[0].payment_terms, currency_code: updated.rows[0].currency_code }),
          ctx.reason ?? null,
        ]
      );
    }
    return updated.rows[0] as unknown as Record<string, unknown>;
  });

  return { vendor: redactBankSecrets(vendor), terms: parsed };
}
