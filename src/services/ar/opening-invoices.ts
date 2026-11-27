import Decimal from 'decimal.js';
import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ConflictError } from '../../utils/errors.js';
import { generateEntryNumber } from '../../utils/sequence.js';
import type { MessageParams, TranslationKey } from '../../i18n/index.js';
import { reclassRoles } from '../accounting/iva-cash-basis.js';
import { keepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { RFC_GENERICO_EXTRANJERO, RFC_GENERICO_NACIONAL } from '../sat/diot/rfc.js';
import type {
  OpeningDocument,
  OpeningFinding,
  OpeningPlan,
  SubledgerKind,
} from '../accounting/opening-balance.js';

// ============================================================
// OPEN RECEIVABLES OF A MIGRATION (MNE-001-022 · #310, layer 3 of O1)
//
// The opening entry already writes each open customer document as its own
// line on the receivable control account. What it did not write was the
// SUBLEDGER: without an `invoices` row behind those lines, `ar reconcile`
// kept the whole opening balance as a delta forever, and the first
// collection had nothing to apply to.
//
// Here every document of a `cxc` control account becomes a collectable
// invoice, IN THE SAME TRANSACTION as the opening entry, so the ledger and
// the subledger are born together or not at all. No new money is posted: the
// invoice points at the opening entry (`journal_entry_id`), which already
// carries its amount, so the balance is never counted twice.
//
// It ties by construction unless something outside the file breaks it, so
// the load refuses, naming the account, whenever the subledger it would write
// could not match the account `ar reconcile` and the collections read:
//   - the default `cxc` role points at ANOTHER account: a collection would
//     credit that account while the balance sits here;
//   - a document runs against the account (a credit balance): it is not an
//     invoice, and leaving it out is exactly the delta this layer closes;
//   - a document in a currency other than the functional one: the opening
//     line is in pesos and `ar reconcile` adds `amount_due` as it comes;
//   - a folio that already names an invoice of this entity.
// No adjusting entry is ever posted to make it tie.
//
// THE IVA INSIDE THE OPEN BALANCE (MNE-001-946 · #1078). Under cash-basis
// IVA the tax of a credit sale is caused when it is collected (LIVA art.
// 1-B), so it waits on the account of IVA not yet collected until then. Each
// document may carry its rate (`ivaRate`, as the payable ones do): the invoice
// then gets its base, its IVA and one line with that rate, which is what the
// IVA workpaper splits a collection by. A document without the rate is
// governed by the panel key `opening_receivable_iva`. The IVA the documents
// carry must be in the opening's pending-IVA account, or a collection would
// release IVA the ledger never parked: the load blocks. An entity off Mexican
// books has no such regime: its documents enter with no tax and no line.
// The load writes on the invoice whether that IVA is pending
// (`invoices.opening_iva_pending`, migration 348): a collection then releases
// it as a native PPD invoice's (iva-cash-basis.ts). A document whose IVA the
// previous system had already caused says `ivaPending: false`: it keeps its
// true rate, needs nothing parked and releases nothing.
//
// Because the invoice shares the opening entry, `voidInvoice` refuses it (a
// credit note cancels it), and a reload after voiding the opening takes over
// the untouched invoices of the reversed one instead of colliding on their
// folios.
// ============================================================

/**
 * The answer of the panel key `opening_receivable_iva`, for a receivable
 * document that does not say its IVA rate. Read by `importOpeningBalance`
 * (`OPENING_RECEIVABLE_IVA_POLICY_KEY`), applied here: `require_rate` unless
 * the key says exactly `assume_zero_rate`. The twin of `opening_payable_iva`.
 */
export type OpeningReceivableIvaPolicy = 'require_rate' | 'assume_zero_rate';

export function openingReceivableIvaPolicy(value: string | null | undefined): OpeningReceivableIvaPolicy {
  return value === 'assume_zero_rate' ? 'assume_zero_rate' : 'require_rate';
}

export type ParsedIvaRate =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'exempt' }
  | { kind: 'rate'; rate: Decimal };

/** `ivaRate` as the CFDI writes a rate ('0.16', '0.080000'), or its word for an exempt act. One reader for both sides. */
export function parseIvaRate(raw: string | undefined): ParsedIvaRate {
  if (raw === undefined || raw.trim() === '') return { kind: 'missing' };
  const v = raw.trim().toLowerCase();
  if (v === 'exento' || v === 'exempt') return { kind: 'exempt' };
  if (!/^\d+(\.\d+)?$/.test(v)) return { kind: 'invalid' };
  const rate = new Decimal(v);
  return rate.greaterThanOrEqualTo(1) ? { kind: 'invalid' } : { kind: 'rate', rate };
}

/** The base and the IVA inside an open balance at its rate, as a document line stores them. */
export interface OpenBalanceIva {
  /** The open balance without its IVA: the base. */
  subtotal: string;
  /** The IVA inside the open balance, pending until the money moves. */
  tax: string;
  /** The line's `tax_rate`, as a percent ('16.00'); null when exempt. */
  taxRatePct: string | null;
  factorType: 'tasa' | 'exento';
}

/** Pure: the base is the balance over (1 + rate), to the cent; the IVA is the rest. */
export function ivaInsideOpenBalance(
  amount: Decimal,
  rate: Exclude<ParsedIvaRate, { kind: 'missing' } | { kind: 'invalid' }>
): OpenBalanceIva {
  const subtotal = rate.kind === 'rate' ? amount.dividedBy(rate.rate.plus(1)).toDecimalPlaces(2) : amount;
  return {
    subtotal: subtotal.toFixed(4),
    tax: amount.minus(subtotal).toFixed(4),
    taxRatePct: rate.kind === 'rate' ? rate.rate.times(100).toFixed(2) : null,
    factorType: rate.kind === 'rate' ? 'tasa' : 'exento',
  };
}

/** An invoice the opening will create, one per open customer document. */
export interface OpeningInvoiceDraft {
  accountCode: string;
  /** The control account: the account of the invoice's single line. */
  accountId: string;
  number: string;
  customerName: string;
  customerRfc: string | null;
  date: string;
  dueDate: string;
  /** The open balance: what is still owed, IVA included. */
  amount: string;
  /** Base, IVA and rate of the single line; null off Mexican books, where no line is written. */
  iva: OpenBalanceIva | null;
  /** false when the document says its IVA was caused before the opening (`ivaPending: false`). */
  ivaPending: boolean;
  currency: string;
  cfdiUuid: string | null;
  /** The invoice of a REVERSED opening that this load takes over (087 reload). */
  replacesId: string | null;
}

/** An invoice of the entity whose number a document wants to use. */
export interface ExistingInvoice {
  id: string;
  invoice_number: string;
  status: string;
  amount_paid: string;
  /** true when it hangs from an opening entry that was already reversed. */
  from_reversed_opening: boolean;
}

export interface OpeningInvoicesContext {
  /** Code of the account the default `cxc` role points at, or null. */
  receivableRoleCode: string | null;
  /** Code of the account the pending-IVA role of the issued side points at (`reclassRoles`), or null. */
  pendingIvaCode: string | null;
  /** false off Mexican books (`keepsMexicanBooks`): no rate is asked for or read. */
  cashBasisIva: boolean;
  ivaPolicy: OpeningReceivableIvaPolicy;
  functionalCurrency: string;
  existing: readonly ExistingInvoice[];
}

export interface OpeningInvoicesPlan {
  drafts: OpeningInvoiceDraft[];
  findings: OpeningFinding[];
}

/**
 * The documents of the control accounts of one kind, with the account they
 * hang from. Shared with the payables mirror (`ap/opening-bills.ts`).
 */
export function controlDocuments(
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  kind: SubledgerKind
): { code: string; accountId: string; doc: OpeningDocument }[] {
  const codes = new Set(plan.control.filter((c) => c.kind === kind).map((c) => c.code));
  return plan.lines.flatMap((l) =>
    l.documento !== undefined && codes.has(l.code)
      ? [{ code: l.code, accountId: l.accountId, doc: l.documento }]
      : []
  );
}

/**
 * The RFC that IDENTIFIES a counterparty, or null. The generic RFCs
 * (XAXX010101000, XEXX010101000) are shared by every anonymous or foreign
 * counterparty, so they identify nobody: those are matched by exact name, and
 * the generic RFC is still stored on the customer or vendor for the SAT.
 */
export function identityRfc(rfc: string | null): string | null {
  return rfc === null || rfc === RFC_GENERICO_NACIONAL || rfc === RFC_GENERICO_EXTRANJERO ? null : rfc;
}

const receivableDocuments = (plan: Pick<OpeningPlan, 'lines' | 'control'>) => controlDocuments(plan, 'cxc');

const block = (rule: string, account: string, message: string): OpeningFinding => ({
  regla: rule,
  severidad: 'bloquea',
  numCta: account,
  mensaje: message,
});

/** A finding written by key (as `opening-balance.ts` writes its own): the surface renders it. */
const keyed = (
  rule: string,
  severity: OpeningFinding['severidad'],
  account: string,
  key: TranslationKey,
  params: MessageParams
): OpeningFinding => ({
  regla: rule,
  severidad: severity,
  numCta: account,
  mensaje: `${key} ${JSON.stringify(params)}`,
  messageKey: { key, params },
});

/** Pure: which invoices the opening would create, and what stops them. */
export function planOpeningInvoices(
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  ctx: OpeningInvoicesContext
): OpeningInvoicesPlan {
  const docs = receivableDocuments(plan);
  const findings: OpeningFinding[] = [];
  const drafts: OpeningInvoiceDraft[] = [];
  if (docs.length === 0) return { drafts, findings };

  const withDocs = [...new Set(docs.map((l) => l.code))];
  if (ctx.receivableRoleCode === null) {
    findings.push({
      regla: 'APE-CXC-SIN-ROL',
      severidad: 'aviso',
      numCta: withDocs[0],
      mensaje:
        `Las facturas de clientes entran al auxiliar, pero ninguna cuenta tiene el rol "cxc": ` +
        `'ar reconcile' no tiene contra qué compararlas y un cobro no sabe qué cuenta abonar. ` +
        `Fíjalo con: mnemosine account role set cxc ${withDocs[0]}`,
    });
  }
  for (const code of withDocs) {
    if (ctx.receivableRoleCode !== null && ctx.receivableRoleCode !== code) {
      findings.push(
        block(
          'APE-CXC-OTRA-CUENTA',
          code,
          `Los documentos de "${code}" entrarían como facturas, pero el rol "cxc" apunta a ` +
            `"${ctx.receivableRoleCode}": cada cobro abonaría "${ctx.receivableRoleCode}" mientras el saldo vive en ` +
            `"${code}", y 'ar reconcile' compararía el auxiliar contra la cuenta equivocada. Apunta el ` +
            `rol a la cuenta de control migrada (mnemosine account role set cxc ${code}) y vuelve a ` +
            `correr la carga.`
        )
      );
    }
  }

  const byNumber = new Map(ctx.existing.map((e) => [e.invoice_number, e]));
  const seen = new Set<string>();
  const assumedZero: string[] = [];
  for (const line of docs) {
    const d = line.doc;
    const amount = new Decimal(d.importe);
    if (amount.isNegative()) {
      findings.push(
        block(
          'APE-CXC-SALDO-A-FAVOR',
          line.code,
          `"${d.documento}" de ${d.contraparte} trae ${d.importe}: un saldo a favor del cliente no es ` +
            `una factura por cobrar, y dejarlo fuera del auxiliar descuadra 'ar reconcile' por ese ` +
            `importe. Nétalo contra las facturas abiertas del mismo cliente en el origen.`
        )
      );
      continue;
    }
    const currency = (d.currency ?? ctx.functionalCurrency).trim().toUpperCase();
    if (currency !== ctx.functionalCurrency) {
      findings.push(
        block(
          'APE-CXC-MONEDA',
          line.code,
          `"${d.documento}" está en ${currency} y la entidad lleva sus libros en ` +
            `${ctx.functionalCurrency}. La apertura lo posa en ${ctx.functionalCurrency} y 'ar reconcile' ` +
            `suma el saldo de la factura tal como viene: no se convierte en silencio. Trae su saldo en ` +
            `${ctx.functionalCurrency}.`
        )
      );
      continue;
    }
    let rate = ctx.cashBasisIva ? parseIvaRate(d.ivaRate) : null;
    if (rate?.kind === 'invalid') {
      findings.push(
        keyed('APE-CXC-TASA-INVALIDA', 'bloquea', line.code, 'migration.opening.receivable_rate_invalid', {
          document: d.documento,
          rate: d.ivaRate ?? '',
        })
      );
      continue;
    }
    if (rate?.kind === 'missing') {
      if (ctx.ivaPolicy === 'require_rate') {
        findings.push(
          keyed('APE-CXC-SIN-TASA', 'bloquea', line.code, 'migration.opening.receivable_rate_missing', {
            document: d.documento,
            counterparty: d.contraparte,
          })
        );
        continue;
      }
      assumedZero.push(d.documento);
      rate = { kind: 'rate', rate: new Decimal(0) };
    }
    const taken = byNumber.get(d.documento);
    const reusable =
      taken !== undefined &&
      taken.from_reversed_opening &&
      taken.status === 'sent' &&
      new Decimal(taken.amount_paid).isZero();
    if (seen.has(d.documento) || (taken !== undefined && !reusable)) {
      findings.push(
        block(
          'APE-CXC-FOLIO-TOMADO',
          line.code,
          `El folio "${d.documento}" ya nombra otra factura de esta entidad: dos facturas con el ` +
            `mismo número no se pueden cobrar por separado. Corrige el folio en el auxiliar.`
        )
      );
      continue;
    }
    seen.add(d.documento);
    drafts.push({
      accountCode: line.code,
      accountId: line.accountId,
      number: d.documento,
      customerName: d.contraparte.trim(),
      customerRfc: d.rfc === undefined || d.rfc.trim() === '' ? null : d.rfc.trim().toUpperCase(),
      date: d.fecha,
      // NOTE: `due_date` is NOT NULL. Without a due date the document date is
      // the honest fallback: the opening already warned (APE-SIN-VENCIMIENTO).
      dueDate: d.vencimiento === undefined || d.vencimiento === '' ? d.fecha : d.vencimiento,
      amount: amount.toFixed(4),
      iva: rate === null ? null : ivaInsideOpenBalance(amount, rate),
      ivaPending: d.ivaPending !== false,
      currency,
      cfdiUuid: d.uuid === undefined || d.uuid === '' ? null : d.uuid,
      replacesId: reusable ? taken.id : null,
    });
  }

  if (assumedZero.length > 0) {
    findings.push(
      keyed('APE-CXC-TASA-SUPUESTA', 'aviso', docs[0].code, 'migration.opening.receivable_rate_assumed', {
        count: assumedZero.length,
        documents: assumedZero.join(', '),
      })
    );
  }

  // What the file states as caused before the opening is named: no collection will cause it.
  const settled = drafts.filter((x) => !x.ivaPending && x.iva !== null);
  if (settled.length > 0) {
    findings.push(
      keyed('APE-CXC-IVA-YA-CAUSADO', 'aviso', docs[0].code, 'migration.opening.receivable_iva_settled', {
        count: settled.length,
        tax: settled.reduce((acc, x) => acc.plus(x.iva?.tax ?? 0), new Decimal(0)).toFixed(2),
        documents: settled.map((x) => x.number).join(', '),
      })
    );
  }

  // The IVA the invoices release when collected has to be parked in the
  // opening: otherwise each collection debits the pending-IVA account below zero.
  const role = reclassRoles('issued').from;
  const tax = drafts.reduce((acc, x) => acc.plus(x.ivaPending ? (x.iva?.tax ?? 0) : 0), new Decimal(0));
  const parked = plan.lines
    .filter((l) => l.code === ctx.pendingIvaCode)
    .reduce((acc, l) => acc.plus(l.credit ?? 0).minus(l.debit ?? 0), new Decimal(0));
  if (tax.greaterThan(0) && tax.greaterThan(parked)) {
    findings.push(
      ctx.pendingIvaCode === null
        ? keyed('APE-CXC-IVA-SIN-SALDO', 'bloquea', docs[0].code, 'migration.opening.receivable_iva_no_role', {
            tax: tax.toFixed(2),
            role,
          })
        : keyed('APE-CXC-IVA-SIN-SALDO', 'bloquea', ctx.pendingIvaCode, 'migration.opening.receivable_iva_not_parked', {
            tax: tax.toFixed(2),
            parked: parked.toFixed(2),
            account: ctx.pendingIvaCode,
            role,
          })
    );
  }
  return { drafts, findings };
}

/**
 * Under `apertura_modo_de_carga = borrador` the opening is a draft, so no
 * invoice is written: it would be collectable before its balance is posted.
 * The load says so instead of leaving the gap silent.
 */
export function skippedUnderDraftMode(plan: Pick<OpeningPlan, 'lines' | 'control'>): OpeningInvoicesPlan {
  const docs = receivableDocuments(plan);
  if (docs.length === 0) return { drafts: [], findings: [] };
  return {
    drafts: [],
    findings: [
      {
        regla: 'APE-CXC-BORRADOR',
        severidad: 'aviso',
        numCta: docs[0].code,
        mensaje:
          `La apertura queda en BORRADOR (apertura_modo_de_carga = borrador), así que sus ${docs.length} ` +
          `documento(s) de clientes NO entran como facturas: una factura colgada de un asiento sin ` +
          `postear se podría cobrar antes de que su saldo esté en el mayor. Al postearla, 'ar reconcile' ` +
          `acusará ese saldo como diferencia. Para traer las facturas, carga la apertura con ` +
          `apertura_modo_de_carga = contabilizar.`,
      },
    ],
  };
}

/** Reads what the pure plan needs. Queries nothing when there is no AR document. */
export async function prepareOpeningInvoices(
  entityId: string,
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  ivaPolicy: OpeningReceivableIvaPolicy = 'require_rate'
): Promise<OpeningInvoicesPlan> {
  const numbers = receivableDocuments(plan).map((l) => l.doc.documento);
  if (numbers.length === 0) return { drafts: [], findings: [] };

  // Both role accounts in one read: the control account and where the uncollected IVA is parked.
  const pendingIvaRole = reclassRoles('issued').from;
  const roles = await query<{ role: string; code: string }>(
    `SELECT r.role, a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = ANY($2::text[]) AND r.qualifier IS NULL`,
    [entityId, ['cxc', pendingIvaRole]]
  );
  const roleCode = (role: string): string | null => roles.rows.find((r) => r.role === role)?.code ?? null;
  const entity = await query<{
    functional_currency: string; incorporation_country: string | null; accounting_standard: string | null;
  }>(
    `SELECT functional_currency, incorporation_country, accounting_standard FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const existing = await query<ExistingInvoice>(
    `SELECT i.id, i.invoice_number, i.status, i.amount_paid::text AS amount_paid,
            (je.source_type = 'opening_balance' AND je.reversed_by_entry_id IS NOT NULL)
              IS TRUE AS from_reversed_opening
       FROM invoices i
       LEFT JOIN journal_entries je ON je.id = i.journal_entry_id AND je.entity_id = i.entity_id
      WHERE i.entity_id = $1 AND i.invoice_number = ANY($2::text[])`,
    [entityId, numbers]
  );
  return planOpeningInvoices(plan, {
    receivableRoleCode: roleCode('cxc'),
    pendingIvaCode: roleCode(pendingIvaRole),
    cashBasisIva: keepsMexicanBooks(entity.rows[0]?.incorporation_country, entity.rows[0]?.accounting_standard),
    ivaPolicy,
    functionalCurrency: entity.rows[0]?.functional_currency ?? 'MXN',
    existing: existing.rows,
  });
}

/**
 * Writes the drafts inside the opening's transaction. The customer is found
 * by RFC, else by exact name (always by name for a generic RFC, see
 * `identityRfc`), and created only when neither exists. Each invoice gets one
 * line with its rate, base and IVA; a takeover replaces the line it had.
 */
export async function writeOpeningInvoices(
  client: pg.PoolClient,
  entityId: string,
  userId: string,
  openingEntryId: string,
  drafts: readonly OpeningInvoiceDraft[]
): Promise<number> {
  const customers = new Map<string, string>();
  const lines: { invoiceId: string; draft: OpeningInvoiceDraft; iva: OpenBalanceIva }[] = [];
  for (const d of drafts) {
    const identity = identityRfc(d.customerRfc);
    const key = identity ?? `name:${d.customerName.toLowerCase()}`;
    let customerId = customers.get(key);
    if (customerId === undefined) {
      const found = await client.query<{ id: string }>(
        identity !== null
          ? `SELECT id FROM customers WHERE entity_id = $1 AND UPPER(tax_id) = $2 ORDER BY created_at LIMIT 1`
          : `SELECT id FROM customers WHERE entity_id = $1 AND LOWER(company_name) = LOWER($2) ORDER BY created_at LIMIT 1`,
        [entityId, identity ?? d.customerName]
      );
      customerId = found.rows[0]?.id;
      if (customerId === undefined) {
        const count = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM customers WHERE entity_id = $1`,
          [entityId]
        );
        const created = await client.query<{ id: string }>(
          `INSERT INTO customers (entity_id, customer_number, company_name, tax_id, tax_id_type,
                                  currency_code, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'Migrated with the opening balance', $7)
           RETURNING id`,
          [entityId, generateEntryNumber('C', Number(count.rows[0].n)), d.customerName,
           d.customerRfc, d.customerRfc === null ? null : 'rfc', d.currency, userId]
        );
        customerId = created.rows[0].id;
      }
      customers.set(key, customerId);
    }

    const values = [customerId, d.amount, d.currency, d.date, d.dueDate, d.cfdiUuid,
      openingEntryId, entityId, d.iva?.subtotal ?? d.amount, d.iva?.tax ?? '0.0000',
      // Whether its IVA is pending: what a collection, a credit note and the IVA paper read.
      d.iva === null ? null : d.ivaPending];
    let invoiceId: string;
    if (d.replacesId !== null) {
      // Guarded: only the untouched invoice of a reversed opening is taken over.
      const r = await client.query(
        `UPDATE invoices
            SET customer_id = $1, subtotal = $9, tax_amount = $10, total_amount = $2, amount_due = $2,
                currency_code = $3, invoice_date = $4, due_date = $5, cfdi_uuid = $6,
                journal_entry_id = $7, opening_iva_pending = $11, updated_at = NOW()
          WHERE id = $12 AND entity_id = $8 AND status = 'sent' AND amount_paid = 0`,
        [...values, d.replacesId]
      );
      if (r.rowCount !== 1) {
        throw new ConflictError(
          `La factura ${d.number} cambió mientras se cargaba la apertura; no se escribió nada.`
        );
      }
      invoiceId = d.replacesId;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invoices (customer_id, subtotal, tax_amount, total_amount, amount_due, currency_code,
                               invoice_date, due_date, cfdi_uuid, journal_entry_id, entity_id,
                               opening_iva_pending, invoice_number, status, description, created_by)
         VALUES ($1, $9, $10, $2, $2, $3, $4, $5, $6, $7, $8, $11, $12, 'sent', $13, $14)
         RETURNING id`,
        [...values, d.number, `Open at the opening balance · ${d.accountCode}`, userId]
      );
      invoiceId = inserted.rows[0].id;
    }
    if (d.iva !== null) lines.push({ invoiceId, draft: d, iva: d.iva });
  }

  // The lines go in one statement each way, whatever the number of documents.
  const replaced = drafts.flatMap((d) => (d.replacesId === null ? [] : [d.replacesId]));
  if (replaced.length > 0) {
    await client.query(
      `DELETE FROM invoice_lines il USING invoices i
        WHERE i.id = il.invoice_id AND i.entity_id = $1 AND il.invoice_id = ANY($2::uuid[])`,
      [entityId, replaced]
    );
  }
  if (lines.length > 0) {
    // One line per invoice: the IVA workpaper splits a collection by the rate of the lines.
    await client.query(
      `INSERT INTO invoice_lines (invoice_id, line_number, description, quantity, unit_price, revenue_account_id,
                                  tax_code, tax_rate, tax_amount, line_amount, total_amount)
       SELECT i.id, 1, t.description, 1, t.subtotal, t.account_id, t.tax_code, t.tax_rate, t.tax, t.subtotal, t.total
         FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[],
                     $9::numeric[])
              AS t(invoice_id, description, account_id, tax_code, tax_rate, subtotal, tax, total)
         JOIN invoices i ON i.id = t.invoice_id AND i.entity_id = $1`,
      [
        entityId,
        lines.map((l) => l.invoiceId),
        lines.map((l) => `Open at the opening balance · ${l.draft.number}`),
        lines.map((l) => l.draft.accountId),
        lines.map((l) => (l.iva.factorType === 'exento' ? 'exento' : null)),
        lines.map((l) => l.iva.taxRatePct),
        lines.map((l) => l.iva.subtotal),
        lines.map((l) => l.iva.tax),
        lines.map((l) => l.draft.amount),
      ]
    );
  }
  return drafts.length;
}
