import Decimal from 'decimal.js';
import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ConflictError } from '../../utils/errors.js';
import { generateEntryNumber } from '../../utils/sequence.js';
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
// NOTE: the open balance goes in as subtotal with no tax: the source gives
// the balance, not its IVA split, so a collection releases no IVA from
// `iva_trasladado_no_cobrado` for a migrated invoice. Because the invoice
// shares the opening entry, `voidInvoice` refuses it (a credit note cancels
// it), and a reload after voiding the opening takes over the untouched
// invoices of the reversed one instead of colliding on their folios.
// ============================================================

/** An invoice the opening will create, one per open customer document. */
export interface OpeningInvoiceDraft {
  accountCode: string;
  number: string;
  customerName: string;
  customerRfc: string | null;
  date: string;
  dueDate: string;
  amount: string;
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
      number: d.documento,
      customerName: d.contraparte.trim(),
      customerRfc: d.rfc === undefined || d.rfc.trim() === '' ? null : d.rfc.trim().toUpperCase(),
      date: d.fecha,
      // NOTE: `due_date` is NOT NULL. Without a due date the document date is
      // the honest fallback: the opening already warned (APE-SIN-VENCIMIENTO).
      dueDate: d.vencimiento === undefined || d.vencimiento === '' ? d.fecha : d.vencimiento,
      amount: amount.toFixed(4),
      currency,
      cfdiUuid: d.uuid === undefined || d.uuid === '' ? null : d.uuid,
      replacesId: reusable ? taken.id : null,
    });
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
  plan: Pick<OpeningPlan, 'lines' | 'control'>
): Promise<OpeningInvoicesPlan> {
  const numbers = receivableDocuments(plan).map((l) => l.doc.documento);
  if (numbers.length === 0) return { drafts: [], findings: [] };

  const role = await query<{ code: string }>(
    `SELECT a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = 'cxc' AND r.qualifier IS NULL`,
    [entityId]
  );
  const entity = await query<{ functional_currency: string }>(
    `SELECT functional_currency FROM legal_entities WHERE id = $1`,
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
    receivableRoleCode: role.rows[0]?.code ?? null,
    functionalCurrency: entity.rows[0]?.functional_currency ?? 'MXN',
    existing: existing.rows,
  });
}

/**
 * Writes the drafts inside the opening's transaction. The customer is found
 * by RFC, else by exact name (always by name for a generic RFC, see
 * `identityRfc`), and created only when neither exists.
 */
export async function writeOpeningInvoices(
  client: pg.PoolClient,
  entityId: string,
  userId: string,
  openingEntryId: string,
  drafts: readonly OpeningInvoiceDraft[]
): Promise<number> {
  const customers = new Map<string, string>();
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
      openingEntryId, entityId];
    if (d.replacesId !== null) {
      // Guarded: only the untouched invoice of a reversed opening is taken over.
      const r = await client.query(
        `UPDATE invoices
            SET customer_id = $1, subtotal = $2, tax_amount = 0, total_amount = $2, amount_due = $2,
                currency_code = $3, invoice_date = $4, due_date = $5, cfdi_uuid = $6,
                journal_entry_id = $7, updated_at = NOW()
          WHERE id = $9 AND entity_id = $8 AND status = 'sent' AND amount_paid = 0`,
        [...values, d.replacesId]
      );
      if (r.rowCount !== 1) {
        throw new ConflictError(
          `La factura ${d.number} cambió mientras se cargaba la apertura; no se escribió nada.`
        );
      }
      continue;
    }
    await client.query(
      `INSERT INTO invoices (customer_id, subtotal, total_amount, amount_due, currency_code,
                             invoice_date, due_date, cfdi_uuid, journal_entry_id, entity_id,
                             invoice_number, status, description, created_by)
       VALUES ($1, $2, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'sent', $10, $11)`,
      [...values, d.number, `Open at the opening balance · ${d.accountCode}`, userId]
    );
  }
  return drafts.length;
}
