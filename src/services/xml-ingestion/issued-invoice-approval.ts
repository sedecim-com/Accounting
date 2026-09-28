import Decimal from 'decimal.js';
import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getPolicy } from '../policy/policy-service.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { AccountingError, ValidationError } from '../../utils/errors.js';
import type { CFDIParsed } from './cfdi-parser.js';
import { money, sumTax, type ApprovedLine } from './pre-registration-service.js';

/** What approveDraftInternal needs back: the document the entry posts as, and how to close it. */
export interface ApprovedDraftInvoice {
  invoiceId: string;
  invoiceNumber: string;
  close(journalEntryId: string): Promise<void>;
}

const AR_ROLES = [
  'cxc', 'banco', 'iva_trasladado', 'iva_trasladado_no_cobrado', 'isr_retenido_a_favor', 'iva_retenido_a_favor',
];

/** `customer create` as printed in the refusal, runnable: both values come from the XML. */
export function customerCreateCommand(name: string, rfc: string): string {
  const q = (raw: string) => `'${raw.replace(/'/g, "'\\''")}'`;
  return `mnemosine customer create --name ${q(name)} --tax-id ${q(rfc)}`;
}

/**
 * THE CUSTOMER INVOICE BORN FROM AN APPROVED AI DRAFT (ING-3 · #320, S3).
 *
 * The receivables mirror of registrarFacturaDeBorradorAprobado: called inside
 * the approval's transaction, before the approved entry posts with
 * `sourceType: 'invoice'`, so any throw rolls the whole approval back and the
 * draft stays pending. It guarantees:
 *   - the pre-registration is an open 'invoice' whose CFDI the entity itself
 *     issued, locked and entity-scoped; a second draft of it finds nothing;
 *   - the receiver is already in the customer catalog (never created here);
 *   - the entry matches the CFDI figure by figure within
 *     `cfdi_tolerancia_cuadre`. The VAT must sit in the role the MetodoPago
 *     selects: a PPD parks it in iva_trasladado_no_cobrado, which is the
 *     balance the issued REP releases through the payments gate
 *     (rep-linkage.ts resolves the invoice by its cfdi_uuid).
 */
export async function registerInvoiceFromApprovedDraft(
  client: pg.PoolClient,
  opts: {
    tenantId: string;
    entityId: string;
    preRegistrationId: string;
    approvedLines: ApprovedLine[];
    approvedDescription: string;
    accountIdByCode: Map<string, string>;
    userId: string;
  }
): Promise<ApprovedDraftInvoice> {
  const { entityId, preRegistrationId, userId } = opts;
  const locked = await client.query<Record<string, unknown>>(
    `SELECT p.*, x.cfdi_uuid AS x_cfdi_uuid, x.subtotal AS x_subtotal, COALESCE(x.descuento, 0) AS x_descuento,
            x.total AS x_total, x.metodo_pago AS x_metodo_pago, x.receptor_rfc AS x_receptor_rfc,
            x.receptor_nombre AS x_receptor_nombre
       FROM pre_registrations p
       JOIN xml_documents x ON x.id = p.xml_document_id AND x.entity_id = p.entity_id
       JOIN legal_entities le ON le.id = p.entity_id AND UPPER(TRIM(le.tax_id)) = UPPER(TRIM(x.emisor_rfc))
      WHERE p.id = $1 AND p.entity_id = $2 AND p.document_type = 'invoice'
        AND p.status IN ('ready', 'draft', 'error') AND p.result_id IS NULL
      FOR UPDATE OF p`,
    [preRegistrationId, entityId]
  );
  const preReg = locked.rows[0];
  if (!preReg) {
    throw new AccountingError(
      'CFDI_ALREADY_INVOICED',
      `The CFDI behind this draft (pre-registration ${preRegistrationId}) is no longer open: it was already ` +
        'turned into a customer invoice. Nothing was posted; reject this draft.'
    );
  }
  const uuid = String(preReg.x_cfdi_uuid);
  const receiverRfc = String(preReg.x_receptor_rfc);

  const customer = await client.query<{ id: string }>(
    `SELECT id FROM customers WHERE entity_id = $1 AND UPPER(TRIM(tax_id)) = UPPER(TRIM($2))
      ORDER BY is_active DESC, created_at LIMIT 1`,
    [entityId, receiverRfc]
  );
  if (customer.rows.length === 0) {
    const name = String(preReg.x_receptor_nombre ?? '');
    throw new ValidationError(
      `CFDI ${uuid} is issued to "${name}" (RFC ${receiverRfc}), who is not in this entity's customer catalog. ` +
        `Register it with \`${customerCreateCommand(name, receiverRfc)}\` and approve again; the draft stays ` +
        'pending and nothing was posted.',
      'customer_id'
    );
  }

  const answered = new Decimal(
    (await getPolicy({ tenantId: opts.tenantId, entityId }, 'cfdi_tolerancia_cuadre', client)).value || '0.01'
  );
  const tolerance = answered.isNegative() ? new Decimal('0.01') : answered;

  const roles = await client.query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND role = ANY($2::text[])`,
    [entityId, AR_ROLES]
  );
  const accountsOf = (...names: string[]) =>
    new Set(roles.rows.filter((r) => names.includes(r.role)).map((r) => r.account_id));
  const withRole = accountsOf(...AR_ROLES);
  // No MetodoPago is treated as PPD, as the prompt tells the agent: it never overstates the VAT due.
  const pue = preReg.x_metodo_pago === 'PUE';
  const lines = opts.approvedLines.map((l) => ({
    accountId: opts.accountIdByCode.get(l.account_code) as string,
    description: l.description,
    dr: money(l.debit),
    cr: money(l.credit),
  }));
  const net = (accounts: Set<string>, side: 'debit' | 'credit'): Decimal =>
    lines
      .filter((l) => accounts.has(l.accountId))
      .reduce((s, l) => s.plus(side === 'debit' ? l.dr.minus(l.cr) : l.cr.minus(l.dr)), new Decimal(0));
  const revenue = lines.filter((l) => !withRole.has(l.accountId) && l.cr.gt(0));

  const summary = (preReg.tax_breakdown ?? {}) as Partial<CFDIParsed['impuestos']>;
  const toAr = net(accountsOf('cxc'), 'debit');
  const paid = toAr.isZero() && pue && net(accountsOf('banco'), 'debit').gt(0);
  const vat = sumTax(summary.traslados, '002');
  const figures = [
    {
      figure: paid ? 'total (debit to bank, collected PUE)' : 'total (debit to accounts receivable)',
      entry: paid ? net(accountsOf('banco'), 'debit') : toAr,
      cfdi: money(preReg.x_total),
    },
    {
      figure: `transferred VAT (${pue ? 'iva_trasladado' : 'iva_trasladado_no_cobrado, parked until the REP'})`,
      entry: net(accountsOf(pue ? 'iva_trasladado' : 'iva_trasladado_no_cobrado'), 'credit'),
      cfdi: vat,
    },
    {
      figure: 'withholdings by the customer (ISR + VAT)',
      entry: net(accountsOf('isr_retenido_a_favor', 'iva_retenido_a_favor'), 'debit'),
      cfdi: sumTax(summary.retenciones, '001').plus(sumTax(summary.retenciones, '002')),
    },
    {
      figure: 'subtotal minus discount (non-tax credits)',
      entry: revenue.reduce((s, l) => s.plus(l.cr), new Decimal(0)),
      cfdi: money(preReg.x_subtotal).minus(money(preReg.x_descuento)),
    },
  ];
  const mismatches = figures.filter((c) => c.entry.minus(c.cfdi).abs().gt(tolerance));
  if (mismatches.length > 0) {
    throw new AccountingError(
      'CFDI_RECONCILIATION_FAILED',
      `The approved entry does not match CFDI ${uuid}: ` +
        mismatches.map((c) => `${c.figure} is ${c.entry.toFixed(2)} in the entry and ${c.cfdi.toFixed(2)} in the CFDI`).join('; ') +
        `. Tolerance per figure: ${tolerance.toFixed(2)} (cfdi_tolerancia_cuadre). Nothing was posted; correct the draft and approve again.`,
      { cfdi_uuid: uuid, figures: mismatches.map((c) => c.figure) }
    );
  }

  const invoiceId = uuidv4();
  const invoiceNumber = await nextEntityNumber(client, entityId, 'invoice', 'INV', preReg.document_date as Date);
  const total = money(preReg.x_total);
  await client.query(
    `INSERT INTO invoices (
       id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, exchange_rate, invoice_date, due_date,
       status, cfdi_uuid, cfdi_status, description, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'stamped',$16,$17)`,
    [
      invoiceId, entityId, invoiceNumber, customer.rows[0].id,
      money(preReg.x_subtotal).toFixed(2), vat.toFixed(2), total.toFixed(2),
      paid ? '0.00' : total.toFixed(2), paid ? total.toFixed(2) : '0.00',
      preReg.currency_code ?? 'MXN', preReg.exchange_rate ?? 1,
      preReg.document_date, preReg.due_date ?? preReg.document_date,
      paid ? 'paid' : 'sent', uuid, opts.approvedDescription, userId,
    ]
  );
  for (const [i, l] of revenue.entries()) {
    await client.query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
         revenue_account_id, line_amount, total_amount)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $5, $5)`,
      [uuidv4(), invoiceId, i + 1, l.description ?? opts.approvedDescription, l.cr.toFixed(2), l.accountId]
    );
  }

  return {
    invoiceId,
    invoiceNumber,
    async close(journalEntryId: string): Promise<void> {
      const linked = await client.query(
        `UPDATE invoices SET journal_entry_id = $1, updated_at = NOW()
          WHERE id = $2 AND entity_id = $3 AND journal_entry_id IS NULL`,
        [journalEntryId, invoiceId, entityId]
      );
      const closed = await client.query(
        `UPDATE pre_registrations SET
           status = 'completed', result_type = 'invoice', result_id = $1, journal_entry_id = $2,
           processed_at = NOW(), processed_by = $3, error_message = NULL,
           approval_status = CASE WHEN requires_approval THEN 'approved' ELSE approval_status END,
           approved_by = CASE WHEN requires_approval THEN $3::uuid ELSE approved_by END,
           approved_at = CASE WHEN requires_approval THEN NOW() ELSE approved_at END
          WHERE id = $4 AND entity_id = $5 AND status IN ('ready', 'draft', 'error') AND result_id IS NULL`,
        [invoiceId, journalEntryId, userId, preRegistrationId, entityId]
      );
      const processed = await client.query(
        `UPDATE xml_documents SET processing_status = 'completed'
          WHERE id = $1 AND entity_id = $2 AND processing_status IS DISTINCT FROM 'completed'`,
        [preReg.xml_document_id, entityId]
      );
      if (linked.rowCount !== 1 || closed.rowCount !== 1 || processed.rowCount !== 1) {
        throw new AccountingError(
          'CFDI_ALREADY_INVOICED',
          `CFDI ${uuid} changed while the draft was being approved; everything was rolled back.`
        );
      }
    },
  };
}
