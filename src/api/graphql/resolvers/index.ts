import { query } from '../../../database/connection.js';
import { assertEntityAccess } from '../../rest/middleware/auth.js';
import { findByIdInScope, requireByIdInScope, entityScope } from '../../../database/scope.js';
import { ForbiddenError } from '../../../utils/errors.js';
import {
  createJournalEntry,
  postJournalEntry,
  voidJournalEntry,
  softClosePeriod,
  hardClosePeriod,
} from '../../../services/accounting/index.js';
import type { Account, JournalEntry, JournalEntryLine, Invoice, FiscalPeriod } from '../../../types/index.js';
import { JournalEntryType } from '../../../types/index.js';

/** GraphQL context user: the full JWT payload (see src/index.ts context). */
interface CtxUser {
  user_id: string;
  entities: string[];
  permissions: string[];
}

/**
 * El contexto que arma src/index.ts. tenantId y entityId salen de
 * `authenticate`, que ya contrasta la cabecera x-entity-id contra las
 * entidades del token: por eso se pueden usar como alcance sin volver a
 * comprobarlos.
 */
interface Ctx {
  user: CtxUser;
  tenantId?: string;
  entityId?: string;
}

/**
 * EL ALCANCE DE UNA PETICIÓN DE GRAPHQL.
 *
 * GraphQL es la segunda puerta al mismo motor, y era la peor guardada. Su
 * único control de pertenencia sobre `postJournalEntry` y `voidJournalEntry`
 * era leer `SELECT entity_id FROM journal_entries WHERE id = $1` sin acotar y
 * comparar después. Ese patrón falla de las tres maneras que documenta
 * database/scope.ts: deja ventana entre la comprobación y la escritura,
 * depende de que cada resolutor se acuerde, y ramifica —404 si no existe, 403
 * si es de otro—, con lo que la respuesta delata la existencia de asientos
 * ajenos aunque no deje tocarlos.
 *
 * Un token sin inquilino o sin entidad no puede acotarse; no se sigue.
 */
function alcanceDe(ctx: Ctx) {
  if (!ctx.tenantId || !ctx.entityId) {
    throw new ForbiddenError(
      'La petición no identifica inquilino y entidad: no puede acotarse y se rechaza.'
    );
  }
  return entityScope(ctx.tenantId, ctx.entityId);
}

export const resolvers = {
  Query: {
    async account(_: unknown, { id }: { id: string }, ctx: Ctx) {
      // Cerrar la mutación y dejar la lectura suelta sería cerrar media puerta.
      return findByIdInScope<Account>('accounts', id, alcanceDe(ctx));
    },

    async accounts(_: unknown, args: { entityId: string; accountType?: string; isActive?: boolean; search?: string; first?: number }) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [args.entityId];
      let idx = 2;

      if (args.accountType) { where += ` AND account_type = $${idx++}`; params.push(args.accountType.toLowerCase()); }
      if (args.isActive !== undefined) { where += ` AND is_active = $${idx++}`; params.push(args.isActive); }
      if (args.search) { where += ` AND (code ILIKE $${idx} OR name ILIKE $${idx})`; params.push(`%${args.search}%`); idx++; }

      const countResult = await query<{ count: string }>(`SELECT COUNT(*) as count FROM accounts ${where}`, params);
      const result = await query<Account>(
        `SELECT * FROM accounts ${where} ORDER BY code LIMIT $${idx}`,
        [...params, args.first || 50]
      );

      return {
        edges: result.rows.map((node) => ({ node, cursor: node.id })),
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: parseInt(countResult.rows[0].count, 10),
      };
    },

    async journalEntry(_: unknown, { id }: { id: string }, ctx: Ctx) {
      return findByIdInScope<JournalEntry>('journal_entries', id, alcanceDe(ctx));
    },

    async journalEntries(_: unknown, args: Record<string, unknown>) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [args.entityId];
      let idx = 2;

      if (args.fiscalPeriodId) { where += ` AND fiscal_period_id = $${idx++}`; params.push(args.fiscalPeriodId); }
      if (args.status) { where += ` AND status = $${idx++}`; params.push((args.status as string).toLowerCase()); }
      if (args.startDate) { where += ` AND entry_date >= $${idx++}`; params.push(args.startDate); }
      if (args.endDate) { where += ` AND entry_date <= $${idx++}`; params.push(args.endDate); }

      const result = await query<JournalEntry>(
        `SELECT * FROM journal_entries ${where} ORDER BY entry_date DESC LIMIT $${idx}`,
        [...params, args.first || 50]
      );
      return result.rows;
    },

    async invoice(_: unknown, { id }: { id: string }) {
      const result = await query<Invoice>('SELECT * FROM invoices WHERE id = $1', [id]);
      return result.rows[0] || null;
    },

    async invoices(_: unknown, args: Record<string, unknown>) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [args.entityId];
      let idx = 2;

      if (args.customerId) { where += ` AND customer_id = $${idx++}`; params.push(args.customerId); }
      if (args.status) { where += ` AND status = $${idx++}`; params.push((args.status as string).toLowerCase()); }

      const result = await query<Invoice>(
        `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC LIMIT $${idx}`,
        [...params, args.first || 50]
      );
      return result.rows;
    },

    async trialBalance(_: unknown, args: Record<string, unknown>) {
      // Delegate to report service logic
      const result = await query(
        `SELECT a.id as account_id, a.code as account_code, a.name as account_name, a.account_type,
          COALESCE(SUM(jel.debit_amount), 0) as debit_total,
          COALESCE(SUM(jel.credit_amount), 0) as credit_total,
          COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0) as ending_balance
         FROM accounts a
         LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
         LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
         WHERE a.entity_id = $1 AND a.is_active = true
         GROUP BY a.id, a.code, a.name, a.account_type ORDER BY a.code`,
        [args.entityId]
      );

      return {
        entityId: args.entityId,
        accounts: result.rows,
        totals: {
          totalDebits: result.rows.reduce((s: number, r: Record<string, unknown>) => s + parseFloat(r.debit_total as string), 0),
          totalCredits: result.rows.reduce((s: number, r: Record<string, unknown>) => s + parseFloat(r.credit_total as string), 0),
          isBalanced: true,
        },
      };
    },

    async fiscalPeriods(_: unknown, args: { entityId: string; status?: string }) {
      let where = 'WHERE entity_id = $1';
      const params: unknown[] = [args.entityId];
      if (args.status) { where += ' AND status = $2'; params.push(args.status.toLowerCase()); }

      const result = await query<FiscalPeriod>(
        `SELECT * FROM fiscal_periods ${where} ORDER BY start_date`,
        params
      );
      return result.rows;
    },
  },

  Mutation: {
    async createJournalEntry(_: unknown, { input }: { input: Record<string, unknown> }, ctx: Ctx) {
      assertEntityAccess(ctx.user, input.entityId as string);
      const lines = (input.lines as Array<Record<string, unknown>>).map((l) => ({
        account_id: l.accountId as string,
        debit_amount: l.debitAmount ? String(l.debitAmount) : null,
        credit_amount: l.creditAmount ? String(l.creditAmount) : null,
        description: (l.description as string) || '',
        cost_center_id: l.costCenterId as string,
        project_id: l.projectId as string,
      }));

      return createJournalEntry(
        input.entityId as string,
        new Date(input.entryDate as string),
        ((input.entryType as string) || 'standard').toLowerCase() as JournalEntryType,
        input.description as string || '',
        lines,
        ctx.user.user_id,
        { autoPost: input.autoPost as boolean }
      );
    },

    async postJournalEntry(_: unknown, { id }: { id: string }, ctx: Ctx) {
      // El filtro va dentro del SQL: cero filas significa a la vez «no existe»
      // y «no es de tu entidad», y las dos salen por NotFoundError.
      await requireByIdInScope('journal_entries', id, alcanceDe(ctx), { columns: 'id' });
      return postJournalEntry(id, ctx.user.user_id);
    },

    async voidJournalEntry(_: unknown, { id, reason }: { id: string; reason: string }, ctx: Ctx) {
      await requireByIdInScope('journal_entries', id, alcanceDe(ctx), { columns: 'id' });
      return voidJournalEntry(id, ctx.user.user_id, reason);
    },

    async softClosePeriod(_: unknown, args: { periodId: string; entityId: string }, ctx: Ctx) {
      assertEntityAccess(ctx.user, args.entityId);
      return softClosePeriod(args.periodId, args.entityId, ctx.user.user_id);
    },

    async hardClosePeriod(_: unknown, args: { periodId: string; entityId: string }, ctx: Ctx) {
      assertEntityAccess(ctx.user, args.entityId);
      return hardClosePeriod(args.periodId, args.entityId, ctx.user.user_id);
    },
  },

  // Field resolvers
  Account: {
    async parent(account: Account) {
      if (!account.parent_id) return null;
      const result = await query<Account>('SELECT * FROM accounts WHERE id = $1', [account.parent_id]);
      return result.rows[0] || null;
    },
    async children(account: Account) {
      const result = await query<Account>('SELECT * FROM accounts WHERE parent_id = $1 ORDER BY code', [account.id]);
      return result.rows;
    },
    level: (account: Account) => account.account_level,
    fullCode: (account: Account) => account.full_code,
    accountType: (account: Account) => account.account_type?.toUpperCase(),
    normalBalance: (account: Account) => account.normal_balance?.toUpperCase(),
    fsCategory: (account: Account) => account.fs_category?.toUpperCase(),
    isHeader: (account: Account) => account.is_header,
    allowManualEntries: (account: Account) => account.allow_manual_entries,
    currencyCode: (account: Account) => account.currency_code,
  },

  JournalEntry: {
    async lines(entry: JournalEntry) {
      const result = await query<JournalEntryLine>(
        'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
        [entry.id]
      );
      return result.rows;
    },
    entryNumber: (e: JournalEntry) => e.entry_number,
    entryType: (e: JournalEntry) => e.entry_type?.toUpperCase(),
    entryDate: (e: JournalEntry) => e.entry_date,
    postedDate: (e: JournalEntry) => e.posted_date,
    totalDebits: (e: JournalEntry) => e.total_debits,
    totalCredits: (e: JournalEntry) => e.total_credits,
    isReversal: (e: JournalEntry) => e.is_reversal,
    sourceType: (e: JournalEntry) => e.source_type,
    sourceId: (e: JournalEntry) => e.source_id,
  },

  JournalEntryLine: {
    async account(line: JournalEntryLine) {
      const result = await query<Account>('SELECT * FROM accounts WHERE id = $1', [line.account_id]);
      return result.rows[0];
    },
    lineNumber: (l: JournalEntryLine) => l.line_number,
    debitAmount: (l: JournalEntryLine) => l.debit_amount,
    creditAmount: (l: JournalEntryLine) => l.credit_amount,
    currencyCode: (l: JournalEntryLine) => l.currency_code,
    foreignDebit: (l: JournalEntryLine) => l.foreign_debit,
    foreignCredit: (l: JournalEntryLine) => l.foreign_credit,
    exchangeRate: (l: JournalEntryLine) => l.exchange_rate,
    isReconciled: (l: JournalEntryLine) => l.is_reconciled,
  },

  Invoice: {
    async lines(invoice: Invoice) {
      const result = await query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number', [invoice.id]);
      return result.rows;
    },
    async customer(invoice: Invoice) {
      const result = await query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
      return result.rows[0];
    },
    async payments(invoice: Invoice) {
      const result = await query(
        `SELECT cp.* FROM customer_payments cp
         JOIN payment_allocations pa ON pa.payment_id = cp.id
         WHERE pa.invoice_id = $1 ORDER BY cp.payment_date`,
        [invoice.id]
      );
      return result.rows;
    },
    async journalEntry(invoice: Invoice) {
      if (!invoice.journal_entry_id) return null;
      const result = await query('SELECT * FROM journal_entries WHERE id = $1', [invoice.journal_entry_id]);
      return result.rows[0] || null;
    },
    invoiceNumber: (i: Invoice) => i.invoice_number,
    totalAmount: (i: Invoice) => i.total_amount,
    taxAmount: (i: Invoice) => i.tax_amount,
    amountPaid: (i: Invoice) => i.amount_paid,
    amountDue: (i: Invoice) => i.amount_due,
    currencyCode: (i: Invoice) => i.currency_code,
    invoiceDate: (i: Invoice) => i.invoice_date,
    dueDate: (i: Invoice) => i.due_date,
    deliveryDate: (i: Invoice) => i.delivery_date,
    cfdiUuid: (i: Invoice) => i.cfdi_uuid,
    cfdiStatus: (i: Invoice) => i.cfdi_status?.toUpperCase(),
    cfdiXmlUrl: (i: Invoice) => i.cfdi_xml_url,
    poNumber: (i: Invoice) => i.po_number,
    sentAt: (i: Invoice) => i.sent_at,
    sentTo: (i: Invoice) => i.sent_to,
    pdfUrl: (i: Invoice) => i.pdf_url,
  },

  Bill: {
    async vendor(bill: Record<string, unknown>) {
      const result = await query('SELECT * FROM vendors WHERE id = $1', [bill.vendor_id as string]);
      return result.rows[0];
    },
    async lines(bill: Record<string, unknown>) {
      const result = await query('SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number', [bill.id as string]);
      return result.rows;
    },
    billNumber: (b: Record<string, unknown>) => b.bill_number,
    totalAmount: (b: Record<string, unknown>) => b.total_amount,
    taxAmount: (b: Record<string, unknown>) => b.tax_amount,
    amountPaid: (b: Record<string, unknown>) => b.amount_paid,
    amountDue: (b: Record<string, unknown>) => b.amount_due,
    billDate: (b: Record<string, unknown>) => b.bill_date,
    dueDate: (b: Record<string, unknown>) => b.due_date,
  },

  Customer: {
    customerNumber: (c: Record<string, unknown>) => c.customer_number,
    companyName: (c: Record<string, unknown>) => c.company_name,
    firstName: (c: Record<string, unknown>) => c.first_name,
    lastName: (c: Record<string, unknown>) => c.last_name,
    taxId: (c: Record<string, unknown>) => c.tax_id,
    isActive: (c: Record<string, unknown>) => c.is_active,
    creditStatus: (c: Record<string, unknown>) => c.credit_status,
    async invoices(customer: Record<string, unknown>, args: { status?: string; limit?: number }) {
      let where = 'WHERE customer_id = $1';
      const params: unknown[] = [customer.id];
      if (args.status) { where += ' AND status = $2'; params.push(args.status.toLowerCase()); }
      const result = await query(
        `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC LIMIT $${params.length + 1}`,
        [...params, args.limit || 20]
      );
      return result.rows;
    },
  },

  Vendor: {
    vendorNumber: (v: Record<string, unknown>) => v.vendor_number,
    companyName: (v: Record<string, unknown>) => v.company_name,
    taxId: (v: Record<string, unknown>) => v.tax_id,
    isActive: (v: Record<string, unknown>) => v.is_active,
    async bills(vendor: Record<string, unknown>, args: { status?: string; limit?: number }) {
      let where = 'WHERE vendor_id = $1';
      const params: unknown[] = [vendor.id];
      if (args.status) { where += ' AND status = $2'; params.push(args.status); }
      const result = await query(
        `SELECT * FROM bills ${where} ORDER BY bill_date DESC LIMIT $${params.length + 1}`,
        [...params, args.limit || 20]
      );
      return result.rows;
    },
  },

  CustomerPayment: {
    paymentNumber: (p: Record<string, unknown>) => p.payment_number,
    paymentAmount: (p: Record<string, unknown>) => p.payment_amount,
    paymentMethod: (p: Record<string, unknown>) => p.payment_method,
    paymentDate: (p: Record<string, unknown>) => p.payment_date,
  },

  FiscalPeriod: {
    periodNumber: (p: FiscalPeriod) => p.period_number,
    periodName: (p: FiscalPeriod) => p.period_name,
    startDate: (p: FiscalPeriod) => p.start_date,
    endDate: (p: FiscalPeriod) => p.end_date,
  },

  InvoiceLine: {
    lineNumber: (l: Record<string, unknown>) => l.line_number,
    unitPrice: (l: Record<string, unknown>) => l.unit_price,
    async revenueAccount(line: Record<string, unknown>) {
      const result = await query('SELECT * FROM accounts WHERE id = $1', [line.revenue_account_id as string]);
      return result.rows[0];
    },
    taxCode: (l: Record<string, unknown>) => l.tax_code,
    taxRate: (l: Record<string, unknown>) => l.tax_rate,
    taxAmount: (l: Record<string, unknown>) => l.tax_amount,
    lineAmount: (l: Record<string, unknown>) => l.line_amount,
    totalAmount: (l: Record<string, unknown>) => l.total_amount,
    cfdiProductCode: (l: Record<string, unknown>) => l.cfdi_product_code,
    cfdiUnitCode: (l: Record<string, unknown>) => l.cfdi_unit_code,
    itemId: (l: Record<string, unknown>) => l.item_id,
  },
};
