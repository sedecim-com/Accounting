import Decimal from 'decimal.js';
import type pg from 'pg';
import { createJournalEntry } from './posting.js';
import { AccountingError } from '../../utils/errors.js';
import { JournalEntryType } from '../../types/index.js';
import type { JournalEntry, Invoice, InvoiceLine, Bill, BillLine } from '../../types/index.js';
import {
  entityUsesCashBasisIva,
  resolveInvoiceMetodoPago,
  resolveBillMetodoPago,
  ivaReclassificationsFor,
  ivaRoleFor,
  ivaToReclassify,
  ivaStillParked,
  reclassRoles,
  describeMetodo,
  ivaTreatmentNote,
  type MetodoPagoDecision,
} from './iva-cash-basis.js';

// ============================================================
// AR/AP → GL POSTING
// Document-driven journal entries: invoices, vendor bills and
// their payments. Every function runs on the CALLER's transaction
// client so the document update and the entry commit together,
// and each is idempotent behind the document's journal_entry_id
// (plus the uq_je_document_source partial unique index as backstop).
// The caller must fire attestEntryAsync AFTER commit.
//
// Accounts resolve through account_roles (seeded per entity):
// cxc, cxp, banco and the IVA roles. A per-line account on the
// document always wins over the generic role. Amounts post as
// stored on the document (functional currency); multicurrency
// nuances still belong to the CFDI ingestion path.
//
// IVA IS ON A CASH BASIS FOR MEXICAN ENTITIES. Which IVA role a
// document's tax lands in is decided by the CFDI MetodoPago and
// read off the taxonomy (see iva-cash-basis.ts): PUE posts to
// iva_trasladado / iva_acreditable, PPD parks in
// iva_trasladado_no_cobrado (2125) / iva_pendiente_acreditar
// (1135) and is released by the payment that applies the document.
// A non-Mexican entity is untouched by any of this and keeps
// posting its tax exactly where it always did.
// ============================================================

async function roleAccounts(
  client: pg.PoolClient,
  entityId: string,
  roles: string[]
): Promise<Map<string, string>> {
  const result = await client.query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
     WHERE entity_id = $1 AND role = ANY($2) AND qualifier IS NULL`,
    [entityId, roles]
  );
  return new Map(result.rows.map((r) => [r.role, r.account_id]));
}

interface JeLine {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  cost_center_id?: string;
  project_id?: string;
}

function requireRole(map: Map<string, string>, role: string): string {
  const id = map.get(role);
  if (!id) {
    throw new AccountingError(
      'MISSING_ROLE_ACCOUNT',
      `No hay cuenta mapeada al rol "${role}" en esta entidad. ` +
        `Siembra la contabilidad con: mnemosine init --section identity ` +
        `(o revisa qué falta con: mnemosine doctor)`
    );
  }
  return id;
}

/**
 * Appends " · MetodoPago missing: X assumed" so the assumption is legible in
 * the ledger itself, not only in a log line nobody reads at close.
 */
function withAssumptionNote(base: string, decision: MetodoPagoDecision | null): string {
  return decision?.assumed ? `${base} · MetodoPago missing: ${decision.metodo} assumed` : base;
}

/**
 * DR cxc (total) · CR revenue per line · CR the IVA role the MetodoPago
 * selects: iva_trasladado for PUE, iva_trasladado_no_cobrado for PPD.
 */
export async function postInvoiceEntry(
  client: pg.PoolClient,
  invoice: Invoice,
  lines: InvoiceLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (invoice.journal_entry_id) return null; // already posted (idempotent)
  if (!new Decimal(invoice.total_amount).greaterThan(0)) return null;

  const cashBasis = await entityUsesCashBasisIva(client, invoice.entity_id);
  const metodo = cashBasis ? await resolveInvoiceMetodoPago(client, invoice) : null;
  const ivaRole = metodo ? ivaRoleFor('issued', metodo.metodo) : 'iva_trasladado';

  const roles = await roleAccounts(client, invoice.entity_id, ['cxc', ivaRole, 'ingreso']);

  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxc'),
      debit_amount: invoice.total_amount,
      credit_amount: null,
      description: `Invoice ${invoice.invoice_number}`,
    },
    ...lines.map((line) => ({
      account_id: line.revenue_account_id || requireRole(roles, 'ingreso'),
      debit_amount: null,
      credit_amount: line.line_amount,
      description: line.description || `Invoice ${invoice.invoice_number} - line ${line.line_number}`,
      cost_center_id: line.cost_center_id || undefined,
      project_id: line.project_id || undefined,
    })),
  ];
  if (new Decimal(invoice.tax_amount || '0').greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: null,
      credit_amount: invoice.tax_amount,
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Invoice ${invoice.invoice_number} · ${ivaTreatmentNote('issued', metodo)}`
        : `Tax - Invoice ${invoice.invoice_number}`,
    });
  }

  const entry = await createJournalEntry(
    invoice.entity_id,
    new Date(invoice.invoice_date),
    JournalEntryType.AUTO_INVOICE,
    withAssumptionNote(`Invoice ${invoice.invoice_number}`, metodo),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'invoice', sourceId: invoice.id, reference: invoice.invoice_number }
  );

  await client.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [entry.id, invoice.id]);
  return entry;
}

/**
 * CR cxp (total) · DR expense per line · DR the IVA role the MetodoPago
 * selects: iva_acreditable for PUE, iva_pendiente_acreditar for PPD.
 */
export async function postBillEntry(
  client: pg.PoolClient,
  bill: Bill,
  lines: BillLine[],
  userId: string
): Promise<JournalEntry | null> {
  if (bill.journal_entry_id) return null;
  if (!new Decimal(bill.total_amount).greaterThan(0)) return null;

  const cashBasis = await entityUsesCashBasisIva(client, bill.entity_id);
  const metodo = cashBasis ? await resolveBillMetodoPago(client, bill) : null;
  const ivaRole = metodo ? ivaRoleFor('received', metodo.metodo) : 'iva_acreditable';

  const roles = await roleAccounts(client, bill.entity_id, ['cxp', ivaRole, 'gasto']);

  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxp'),
      debit_amount: null,
      credit_amount: bill.total_amount,
      description: `Bill ${bill.bill_number}`,
    },
    ...lines.map((line) => ({
      account_id: line.account_id || requireRole(roles, 'gasto'),
      debit_amount: line.line_amount,
      credit_amount: null,
      description: line.description || `Bill ${bill.bill_number} - line ${line.line_number}`,
      cost_center_id: line.cost_center_id || undefined,
      project_id: line.project_id || undefined,
    })),
  ];
  if (new Decimal(bill.tax_amount || '0').greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: bill.tax_amount,
      credit_amount: null,
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Bill ${bill.bill_number} · ${ivaTreatmentNote('received', metodo)}`
        : `Creditable IVA - Bill ${bill.bill_number}`,
    });
  }

  const entry = await createJournalEntry(
    bill.entity_id,
    new Date(bill.bill_date),
    JournalEntryType.AUTO_BILL,
    withAssumptionNote(`Bill ${bill.bill_number}`, metodo),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'bill', sourceId: bill.id, reference: bill.bill_number }
  );

  await client.query('UPDATE bills SET journal_entry_id = $1 WHERE id = $2', [entry.id, bill.id]);
  return entry;
}

interface CreditNoteRow {
  id: string;
  entity_id: string;
  credit_note_number: string;
  invoice_id: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  credit_date: Date | string;
  journal_entry_id: string | null;
}

/**
 * DR devolucion_ventas (subtotal) · DR the IVA role · CR cxc (total).
 *
 * The IVA side mirrors the linked invoice's MetodoPago: a PUE invoice put
 * its IVA in iva_trasladado, so the note takes it back out of there; a PPD
 * invoice parked it in iva_trasladado_no_cobrado and — while uncollected —
 * that is where the note unwinds it. A note with no linked invoice assumes
 * PUE and says so in the entry: reversing tax that was already caused is
 * the conservative direction for a credit against collected sales.
 */
export async function postCreditNoteEntry(
  client: pg.PoolClient,
  note: CreditNoteRow,
  userId: string
): Promise<JournalEntry | null> {
  if (note.journal_entry_id) return null; // already posted (idempotent)
  if (!new Decimal(note.total_amount).greaterThan(0)) return null;

  const cashBasis = await entityUsesCashBasisIva(client, note.entity_id);
  let metodo: MetodoPagoDecision | null = null;
  if (cashBasis && note.invoice_id) {
    const inv = await client.query<{
      id: string; invoice_number: string; cfdi_uuid: string | null;
      terms: string | null; memo: string | null;
    }>(
      `SELECT id, invoice_number, cfdi_uuid, terms, memo
         FROM invoices WHERE id = $1 AND entity_id = $2`,
      [note.invoice_id, note.entity_id]
    );
    if (inv.rows[0]) {
      metodo = await resolveInvoiceMetodoPago(client, {
        ...inv.rows[0],
        entity_id: note.entity_id,
      });
    }
  }
  const ivaRole = metodo ? ivaRoleFor('issued', metodo.metodo) : 'iva_trasladado';
  const roles = await roleAccounts(client, note.entity_id, ['cxc', ivaRole, 'devolucion_ventas']);

  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'devolucion_ventas'),
      debit_amount: note.subtotal,
      credit_amount: null,
      description: `Credit note ${note.credit_note_number}`,
    },
  ];
  if (new Decimal(note.tax_amount || '0').greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: note.tax_amount,
      credit_amount: null,
      description: metodo
        ? `IVA reversed ${describeMetodo(metodo)} - Credit note ${note.credit_note_number}`
        : `IVA reversed - Credit note ${note.credit_note_number} · no linked invoice: PUE assumed`,
    });
  }
  jeLines.push({
    account_id: requireRole(roles, 'cxc'),
    debit_amount: null,
    credit_amount: note.total_amount,
    description: `AR credit ${note.credit_note_number}`,
  });

  const entry = await createJournalEntry(
    note.entity_id,
    new Date(note.credit_date),
    JournalEntryType.AUTO_INVOICE,
    withAssumptionNote(`Credit note ${note.credit_note_number}`, metodo),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'credit_note', sourceId: note.id, reference: note.credit_note_number }
  );

  await client.query('UPDATE credit_notes SET journal_entry_id = $1 WHERE id = $2', [entry.id, note.id]);
  return entry;
}

/** The bank's GL account: the linked bank account's gl_account_id, else the banco role. */
async function bankGlAccount(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string | null
): Promise<string> {
  if (bankAccountId) {
    const result = await client.query<{ gl_account_id: string | null }>(
      'SELECT gl_account_id FROM bank_accounts WHERE id = $1 AND entity_id = $2',
      [bankAccountId, entityId]
    );
    if (result.rows[0]?.gl_account_id) return result.rows[0].gl_account_id;
  }
  const roles = await roleAccounts(client, entityId, ['banco']);
  return requireRole(roles, 'banco');
}

interface PaymentRow {
  id: string;
  entity_id: string;
  payment_number: string;
  payment_amount: string;
  payment_date: Date | string;
  bank_account_id: string | null;
  journal_entry_id: string | null;
}

/**
 * The IVA a payment releases, as lines appended to the payment's OWN entry.
 *
 * A separate "reclassification entry" was the obvious alternative and is the
 * wrong one: the cash movement and the tax it triggers are one event, and
 * only one entry per payment survives a reversal intact — voiding the payment
 * would otherwise unwind the cash and leave the IVA moved. The pair is
 * self-balancing, so the payment entry still foots.
 *
 * Returns an empty array when the entity is not Mexican, when nothing was
 * applied to a PPD document, or when the payment carries no allocations yet.
 */
async function ivaReclassLines(
  client: pg.PoolClient,
  side: 'issued' | 'received',
  payment: PaymentRow
): Promise<{ lines: JeLine[]; documents: string[]; items: { documentId: string; amount: string }[] }> {
  if (!(await entityUsesCashBasisIva(client, payment.entity_id))) {
    return { lines: [], documents: [], items: [] };
  }

  const items = await ivaReclassificationsFor(client, side, payment.entity_id, payment.id);
  if (items.length === 0) return { lines: [], documents: [], items: [] };

  const { from, to } = reclassRoles(side);
  const roles = await roleAccounts(client, payment.entity_id, [from, to]);
  const label = side === 'issued' ? 'Invoice' : 'Bill';
  const event = side === 'issued' ? 'collection' : 'payment';

  // The two pending accounts sit on OPPOSITE sides of the balance sheet, so
  // draining them takes opposite entries: 2125 "IVA Trasladado No Cobrado" is
  // a liability, emptied by a DEBIT; 1135 "IVA Pendiente de Acreditar" is an
  // asset, emptied by a CREDIT. Getting this backwards balances just as well
  // and inverts both accounts, which is why it is spelled out here.
  const pending = { role: from, id: requireRole(roles, from) };
  const due = { role: to, id: requireRole(roles, to) };
  const debited = side === 'issued' ? pending : due;
  const credited = side === 'issued' ? due : pending;

  const lines: JeLine[] = [];
  for (const item of items) {
    const tail = `${label} ${item.documentNumber}`;
    const note = (r: { role: string }): string =>
      r === pending
        ? `IVA released from ${r.role} on ${event} - ${tail}`
        : `IVA now in ${r.role} (PPD ${event}) - ${tail}`;
    lines.push({
      account_id: debited.id,
      debit_amount: item.amount,
      credit_amount: null,
      description: note(debited),
    });
    lines.push({
      account_id: credited.id,
      debit_amount: null,
      credit_amount: item.amount,
      description: note(credited),
    });
  }
  return {
    lines,
    documents: items.map((i) => i.documentNumber),
    items: items.map((i) => ({ documentId: i.documentId, amount: i.amount })),
  };
}

/**
 * DR bank · CR cxc, plus — for every PPD invoice this collection applies to —
 * DR iva_trasladado_no_cobrado · CR iva_trasladado for the collected share.
 * The IVA on a PPD sale is caused when the money arrives, and this is where
 * it arrives.
 */
export async function postCustomerPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const iva = await ivaReclassLines(client, 'issued', payment);

  // El CR se reparte entre lo APLICADO (cxc) y lo que queda A CUENTA
  // (anticipo_clientes). Con aplicación exacta —el caso de siempre— el
  // remanente es cero y el asiento es idéntico al histórico. Acreditar el
  // total a cxc con aplicación parcial era exactamente el agujero que la
  // validación de suma exacta tapaba: el control bajaba sin auxiliar.
  const alloc = await client.query<{ aplicado: string }>(
    `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
       FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`,
    [payment.id]
  );
  const aplicado = new Decimal(alloc.rows[0]?.aplicado ?? '0');
  const remanente = new Decimal(payment.payment_amount).minus(aplicado);
  const rolesPedidos = ['cxc', ...(remanente.greaterThan(0) ? ['anticipo_clientes'] : [])];
  const roles = await roleAccounts(client, payment.entity_id, rolesPedidos);

  const jeLines: JeLine[] = [
    { account_id: bankId, debit_amount: payment.payment_amount, credit_amount: null, description: `Payment received ${payment.payment_number}` },
  ];
  if (aplicado.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'cxc'),
      debit_amount: null,
      credit_amount: aplicado.toFixed(4),
      description: `AR settlement ${payment.payment_number}`,
    });
  }
  if (remanente.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'anticipo_clientes'),
      debit_amount: null,
      credit_amount: remanente.toFixed(4),
      description: `On-account (unapplied) ${payment.payment_number}`,
    });
  }
  jeLines.push(...iva.lines);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    iva.documents.length
      ? `Customer payment ${payment.payment_number} · IVA caused on collection: ${iva.documents.join(', ')}`
      : `Customer payment ${payment.payment_number}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'customer_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  // El IVA que ESTA aplicación liberó se guarda en su fila: desaplicarla
  // re-aparca ese importe exacto, sin re-derivar bajo otro contexto.
  for (const item of iva.items) {
    await client.query(
      `UPDATE payment_allocations SET iva_reclass_amount = $1
        WHERE payment_id = $2 AND invoice_id = $3 AND unapplied_at IS NULL`,
      [item.amount, payment.id, item.documentId]
    );
  }

  await client.query('UPDATE customer_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}

export interface AplicacionPosterior {
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  /** Lo aplicado (vivo) a la factura por CUALQUIER pago, ANTES de este evento. */
  priorApplied: string;
  taxAmount: string;
  totalAmount: string;
  cfdiUuid: string | null;
  terms: string | null;
  memo: string | null;
}

/**
 * Aplicar saldo a cuenta a facturas, como evento posterior al cobro:
 * DR anticipo_clientes · CR cxc por lo aplicado, más la liberación de IVA
 * de cada factura PPD por la parte que ESTE evento aplica. El efectivo no
 * se mueve — ya entró con el cobro; lo que se mueve es el crédito, del
 * pasivo de anticipos al auxiliar.
 *
 * Devuelve el IVA liberado por factura para que el llamador lo persista en
 * las filas de aplicación recién insertadas.
 */
export async function postReceiptApplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  aplicaciones: AplicacionPosterior[],
  userId: string
): Promise<{ entry: JournalEntry; ivaPorFactura: Map<string, string> }> {
  const total = aplicaciones.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  const cashBasis = await entityUsesCashBasisIva(client, payment.entity_id);
  const ivaPorFactura = new Map<string, string>();
  const ivaLines: JeLine[] = [];
  const documentos: string[] = [];

  if (cashBasis) {
    const { from, to } = reclassRoles('issued');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    for (const app of aplicaciones) {
      const metodo = await resolveInvoiceMetodoPago(client, {
        id: app.invoiceId,
        entity_id: payment.entity_id,
        invoice_number: app.invoiceNumber,
        cfdi_uuid: app.cfdiUuid,
        terms: app.terms,
        memo: app.memo,
      });
      if (metodo.metodo !== 'PPD') continue;
      const bruto = ivaToReclassify({
        ivaTotal: app.taxAmount,
        documentTotal: app.totalAmount,
        priorApplied: app.priorApplied,
        appliedNow: app.amount,
      });
      const parked = await ivaStillParked(client, 'issued', payment.entity_id, app.invoiceId);
      const liberable = Decimal.min(new Decimal(bruto), new Decimal(parked));
      if (liberable.lessThanOrEqualTo(0)) continue;
      const monto = liberable.toFixed(4);
      ivaPorFactura.set(app.invoiceId, monto);
      documentos.push(app.invoiceNumber);
      ivaLines.push({
        account_id: requireRole(ivaRoles, from),
        debit_amount: monto,
        credit_amount: null,
        description: `IVA released from ${from} on collection - Invoice ${app.invoiceNumber}`,
      });
      ivaLines.push({
        account_id: requireRole(ivaRoles, to),
        debit_amount: null,
        credit_amount: monto,
        description: `IVA now in ${to} (PPD collection) - Invoice ${app.invoiceNumber}`,
      });
    }
  }

  const roles = await roleAccounts(client, payment.entity_id, ['cxc', 'anticipo_clientes']);
  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(),
    JournalEntryType.AUTO_PAYMENT,
    documentos.length
      ? `Application of ${payment.payment_number} · IVA caused on collection: ${documentos.join(', ')}`
      : `Application of ${payment.payment_number}`,
    [
      {
        account_id: requireRole(roles, 'anticipo_clientes'),
        debit_amount: total.toFixed(4),
        credit_amount: null,
        description: `On-account applied ${payment.payment_number}`,
      },
      {
        account_id: requireRole(roles, 'cxc'),
        debit_amount: null,
        credit_amount: total.toFixed(4),
        description: `AR settlement ${payment.payment_number}`,
      },
      ...ivaLines,
    ],
    userId,
    // Fuera del índice parcial uq_je_document_source a propósito: un cobro
    // puede tener VARIOS eventos de aplicación, cada uno con su asiento.
    { autoPost: true, client, sourceType: 'receipt_application', sourceId: payment.id, reference: payment.payment_number }
  );
  return { entry, ivaPorFactura };
}

/**
 * Desaplicar, como evento nuevo: DR cxc · CR anticipo_clientes (el crédito
 * vuelve a estar a cuenta — desaplicar NO es devolver dinero) y el IVA que
 * aquella aplicación liberó se RE-APARCA (DR iva_trasladado · CR
 * iva_trasladado_no_cobrado). El importe sale de la fila de la aplicación;
 * una fila anterior a la 049 no lo guardó y se estima pro-rata, diciéndolo.
 */
export async function postReceiptUnapplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  app: { invoiceNumber: string; amount: string; ivaReclass: string | null; ivaEstimado: string },
  userId: string
): Promise<JournalEntry> {
  const roles = await roleAccounts(client, payment.entity_id, ['cxc', 'anticipo_clientes']);
  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxc'),
      debit_amount: app.amount,
      credit_amount: null,
      description: `AR reopened ${app.invoiceNumber} (unapply ${payment.payment_number})`,
    },
    {
      account_id: requireRole(roles, 'anticipo_clientes'),
      debit_amount: null,
      credit_amount: app.amount,
      description: `Back on account ${payment.payment_number}`,
    },
  ];

  const iva = new Decimal(app.ivaReclass ?? app.ivaEstimado);
  const estimado = app.ivaReclass === null && iva.greaterThan(0);
  if (iva.greaterThan(0)) {
    const { from, to } = reclassRoles('issued');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    const nota = estimado ? ' · pre-049: pro-rata estimate' : '';
    jeLines.push({
      account_id: requireRole(ivaRoles, to),
      debit_amount: iva.toFixed(4),
      credit_amount: null,
      description: `IVA re-parked out of ${to} (unapply) - Invoice ${app.invoiceNumber}${nota}`,
    });
    jeLines.push({
      account_id: requireRole(ivaRoles, from),
      debit_amount: null,
      credit_amount: iva.toFixed(4),
      description: `IVA back in ${from} (unapply) - Invoice ${app.invoiceNumber}${nota}`,
    });
  }

  return createJournalEntry(
    payment.entity_id,
    new Date(),
    JournalEntryType.AUTO_PAYMENT,
    `Unapplication of ${payment.payment_number} from ${app.invoiceNumber}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'receipt_unapplication', sourceId: payment.id, reference: payment.payment_number }
  );
}

/**
 * DR cxp · CR bank, plus — for every PPD bill this payment applies to —
 * DR iva_acreditable · CR iva_pendiente_acreditar for the paid share. Under
 * LIVA art. 5 the input IVA becomes creditable here, not when the bill
 * arrived.
 */
export async function postVendorPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const roles = await roleAccounts(client, payment.entity_id, ['cxp']);
  const iva = await ivaReclassLines(client, 'received', payment);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
    JournalEntryType.AUTO_PAYMENT,
    iva.documents.length
      ? `Vendor payment ${payment.payment_number} · IVA creditable on payment: ${iva.documents.join(', ')}`
      : `Vendor payment ${payment.payment_number}`,
    [
      { account_id: requireRole(roles, 'cxp'), debit_amount: payment.payment_amount, credit_amount: null, description: `AP settlement ${payment.payment_number}` },
      { account_id: bankId, debit_amount: null, credit_amount: payment.payment_amount, description: `Payment made ${payment.payment_number}` },
      ...iva.lines,
    ],
    userId,
    { autoPost: true, client, sourceType: 'vendor_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE vendor_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}
