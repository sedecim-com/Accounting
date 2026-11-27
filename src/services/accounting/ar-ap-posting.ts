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
  issuedVatStillParked,
  receivedReleaseAtSettlement,
  receivedVatStillParked,
  discountVatShare,
  reclassRoles,
  describeMetodo,
  ivaTreatmentNote,
  type MetodoPagoDecision,
} from './iva-cash-basis.js';
import { iepsCausedBy, iepsCausedByReceipt, iepsMoveLines, type IepsMove } from './ieps-cash-basis.js';
import { splitNoteVat } from '../xml-ingestion/received-credit-note.js';
import { capKept, HELD_RESTITUTION_TAG, issuedVatKeptOnAccount, KEPT_RESTITUTION_TAG } from '../payments/customer-advance.js';
import {
  convertirAFuncional,
  desgloseCambiarioDelPago,
  functionalCurrencyOf,
  resolverTipoCambio,
  type AplicacionCambiaria,
  type ContextoCambiario,
  type DiferenciaCambiaria,
  type TipoCambioResuelto as FxRate,
} from './moneda-origen.js';
import { tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import { queryHeldNoteIvaByCashedReceipt, queryInvoiceEntryNetOnAccount } from '../reporting/report-service.js';

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
// document always wins over the generic role. A document in the
// functional currency posts its amounts as stored; one in another
// currency converts at birth (NIF B-15) and keeps its original
// amount in the FX columns — a bill at its own rate, an invoice at
// the rate of the firm's `fuente_tipo_cambio` source.
//
// IVA IS ON A CASH BASIS FOR MEXICAN ENTITIES. Which IVA role a
// document's tax lands in is read off the taxonomy (see
// iva-cash-basis.ts). An invoice's follows its CFDI MetodoPago: PUE
// posts to iva_trasladado, PPD parks in iva_trasladado_no_cobrado
// (2125). A bill's parks in iva_pendiente_acreditar (1135), PUE or
// PPD (MNE-001-492). What is parked is released by the payment that
// applies the document.
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
  /**
   * R4 · B-15: las cuatro columnas FX viajan juntas (CHECK de la 001). Una
   * línea nacida de un documento en otra moneda lleva su importe original y
   * el tipo con el que se convirtió a funcional; una línea funcional no
   * lleva ninguna. Strings, como todo el dinero de este sistema.
   */
  currency_code?: string;
  foreign_debit?: string;
  foreign_credit?: string;
  exchange_rate?: string;
  /** Only the IEPS move writes one (ieps-cash-basis.ts). */
  tags?: Record<string, unknown>;
}

function requireRole(map: Map<string, string>, role: string): string {
  const id = map.get(role);
  if (!id) {
    throw new AccountingError(
      'MISSING_ROLE_ACCOUNT',
      { key: 'error.MISSING_ROLE_ACCOUNT.unmapped', params: { role } }
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

/** fx_conversion_cent_difference: where the cent of a converted document goes. */
const CENT_DIFFERENCE_POLICY = 'fx_conversion_cent_difference';
const CENT_DIFFERENCE_VALUES = ['exchange_difference_line', 'largest_line'];

/**
 * MNE-001-862 · The cent between a foreign document's converted lines and its
 * converted total. `lines` is the entry: the control account first, then the
 * `documentLines` lines of the document, then its tax. Each is `foreign ×
 * rate` at the minor unit, which the engine verifies exactly, so when they do
 * not add up the difference is one more line, with no origin: on the exchange
 * difference accounts (the default: no line and no tax changes) or on the
 * account of the largest document line, as the panel key says. The key is
 * read only when there is a cent. A document that does not foot in its own
 * currency gets no line: the entry stays unbalanced and the engine refuses it.
 */
async function conversionCentLine(
  client: pg.PoolClient,
  entityId: string,
  lines: JeLine[],
  documentLines: number,
  label: string
): Promise<JeLine | null> {
  const net = (debit: 'debit_amount' | 'foreign_debit', credit: 'credit_amount' | 'foreign_credit'): Decimal =>
    lines.reduce((s, l) => s.plus(l[debit] ?? '0').minus(l[credit] ?? '0'), new Decimal(0));
  const cent = net('debit_amount', 'credit_amount');
  if (cent.isZero() || !net('foreign_debit', 'foreign_credit').isZero()) return null;

  const policy = await getPolicy({ tenantId: await tenantDe(client, entityId), entityId }, CENT_DIFFERENCE_POLICY, client);
  let account: string;
  if (policy.value === 'exchange_difference_line') {
    const role = cent.greaterThan(0) ? 'utilidad_cambiaria' : 'perdida_cambiaria';
    account = requireRole(await roleAccounts(client, entityId, [role]), role);
  } else if (policy.value === 'largest_line') {
    const amount = (l: JeLine): Decimal => new Decimal(l.debit_amount ?? l.credit_amount ?? '0');
    account = lines.slice(1, 1 + documentLines).reduce((a, b) => (amount(b).greaterThan(amount(a)) ? b : a)).account_id;
  } else {
    throw new AccountingError('FX_POLITICA_DESCONOCIDA', {
      key: 'error.FX_POLITICA_DESCONOCIDA.policy',
      params: { policy: CENT_DIFFERENCE_POLICY, value: policy.value, known: CENT_DIFFERENCE_VALUES.join(', ') },
    });
  }
  const amount = cent.abs().toFixed(4);
  return {
    account_id: account,
    debit_amount: cent.isNegative() ? amount : null,
    credit_amount: cent.isNegative() ? null : amount,
    description: `Conversion rounding ${label}`,
  };
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

  // ── R4 · B-15 on the AR side: A FOREIGN-CURRENCY INVOICE CONVERTS AT BIRTH ──
  //
  // Until MNE-001-081 this refused with FX_AR_NOT_WIRED, because posting USD
  // 1 000 as MXN 1 000 was the only alternative. Now it converts like the
  // bill does, with one difference the plan fixes (#305): the rate is not
  // whatever sits in invoices.exchange_rate (`invoice create` never writes
  // that column, so it is almost always the 1.0 default) but the one the
  // firm's `fuente_tipo_cambio` source published for the invoice date, read
  // inside this transaction and failing closed when it is missing. The rate
  // used is written back to the invoice: it is the historical rate the
  // collection will measure its realised difference against.
  const functional = await functionalCurrencyOf(client, invoice.entity_id);
  let rate: FxRate | null = null;
  if (invoice.currency_code && invoice.currency_code !== functional) {
    rate = await resolverTipoCambio(
      client,
      { tenantId: await tenantDe(client, invoice.entity_id), entityId: invoice.entity_id },
      { de: invoice.currency_code, a: functional, fecha: invoice.invoice_date }
    );
    // A rate already on the invoice that is not the capture default and
    // disagrees with the firm's source is two answers to one question: which
    // one the revenue is worth is not this function's call.
    const stored = new Decimal(invoice.exchange_rate || '0');
    if (stored.greaterThan(0) && !stored.equals(1) && !stored.equals(rate.tasa)) {
      throw new AccountingError(
        'FX_RATE_CONFLICT',
        {
          key: 'error.FX_RATE_CONFLICT',
          params: {
            invoice: invoice.invoice_number,
            rate: String(invoice.exchange_rate),
            source: rate.fuente,
            published: String(rate.tasa),
            date: String(rate.fecha),
          },
        }
      );
    }
  }
  const fx = rate;
  const toFunctional = (amount: string): string =>
    fx ? convertirAFuncional(amount, fx.tasa, functional) : amount;
  const fxCredit = (
    amount: string
  ): Pick<JeLine, 'currency_code' | 'foreign_credit' | 'exchange_rate'> =>
    fx ? { currency_code: invoice.currency_code, foreign_credit: amount, exchange_rate: fx.tasa } : {};

  const credits: JeLine[] = lines.map((line) => ({
    account_id: line.revenue_account_id || requireRole(roles, 'ingreso'),
    debit_amount: null,
    credit_amount: toFunctional(line.line_amount),
    description: line.description || `Invoice ${invoice.invoice_number} - line ${line.line_number}`,
    cost_center_id: line.cost_center_id || undefined,
    project_id: line.project_id || undefined,
    ...fxCredit(line.line_amount),
  }));
  if (new Decimal(invoice.tax_amount || '0').greaterThan(0)) {
    credits.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: null,
      credit_amount: toFunctional(invoice.tax_amount),
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Invoice ${invoice.invoice_number} · ${ivaTreatmentNote('issued', metodo)}`
        : `Tax - Invoice ${invoice.invoice_number}`,
      ...fxCredit(invoice.tax_amount),
    });
  }

  // The cxc debit is the document (MNE-001-862): its total, converted to the
  // minor unit, always with its origin, so the revaluation reads every
  // foreign receivable. The cent the converted lines may leave is its own line.
  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxc'),
      debit_amount: toFunctional(invoice.total_amount),
      credit_amount: null,
      description: `Invoice ${invoice.invoice_number}`,
      ...(fx ? { currency_code: invoice.currency_code, foreign_debit: invoice.total_amount, exchange_rate: fx.tasa } : {}),
    },
    ...credits,
  ];
  if (fx) {
    const cent = await conversionCentLine(client, invoice.entity_id, jeLines, lines.length, `Invoice ${invoice.invoice_number}`);
    if (cent) jeLines.push(cent);
  }

  const entry = await createJournalEntry(
    invoice.entity_id,
    invoice.invoice_date,
    JournalEntryType.AUTO_INVOICE,
    withAssumptionNote(
      fx
        ? `Invoice ${invoice.invoice_number} · ${invoice.currency_code} ${invoice.total_amount} @ ${fx.tasa} (${fx.fuente} ${fx.fecha})`
        : `Invoice ${invoice.invoice_number}`,
      metodo
    ),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'invoice', sourceId: invoice.id, reference: invoice.invoice_number }
  );

  if (fx) {
    const linked = await client.query(
      `UPDATE invoices SET journal_entry_id = $1, exchange_rate = $2
        WHERE id = $3 AND entity_id = $4 AND journal_entry_id IS NULL`,
      [entry.id, fx.tasa, invoice.id, invoice.entity_id]
    );
    if (linked.rowCount !== 1) {
      throw new AccountingError(
        'INVOICE_ALREADY_POSTED',
        { key: 'error.INVOICE_ALREADY_POSTED', params: { invoice: invoice.invoice_number } }
      );
    }
  } else {
    await client.query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2', [entry.id, invoice.id]);
  }
  return entry;
}

/**
 * CR cxp (total) · DR expense per line · DR the IVA role the taxonomy
 * gives a received document: iva_pendiente_acreditar, PUE or PPD, until
 * the vendor payment releases it (MNE-001-492).
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

  // ── R4 · B-15: EL GASTO EN MONEDA EXTRANJERA SE CONVIERTE AL NACER ────
  //
  // El mayor se lleva en la moneda funcional; lo que el documento dice en
  // la suya viaja en las cuatro columnas FX de cada línea. La tasa es la
  // DEL DOCUMENTO: el pasivo vale lo que valía el día que nació, y lo que
  // pase después es diferencia cambiaria del pago (realizada, abajo) o del
  // cierre (fase 2), nunca un re-valor retroactivo de este asiento.
  const funcional = await functionalCurrencyOf(client, bill.entity_id);
  const enExtranjera = Boolean(bill.currency_code) && bill.currency_code !== funcional;
  if (enExtranjera) {
    const tasa = new Decimal(bill.exchange_rate || '0');
    // El 1.0 exacto es el DEFAULT de la columna, no una tasa capturada:
    // convertir con él asentaría dólares como si fueran pesos — la pérdida
    // de origen de siempre, ahora con columnas FX jurando lo contrario.
    if (!tasa.greaterThan(0) || tasa.equals(1)) {
      throw new AccountingError(
        'FX_RATE_MISSING',
        {
          key: 'error.FX_RATE_MISSING.document',
          params: {
            bill: bill.bill_number,
            currency: String(bill.currency_code),
            functional: funcional,
            rate: String(bill.exchange_rate ?? 'none'),
          },
        }
      );
    }
  }
  const conv = (importe: string): string =>
    enExtranjera ? convertirAFuncional(importe, bill.exchange_rate, funcional) : importe;
  const fxCargo = (
    importe: string
  ): Pick<JeLine, 'currency_code' | 'foreign_debit' | 'exchange_rate'> =>
    enExtranjera
      ? {
          currency_code: bill.currency_code,
          foreign_debit: importe,
          exchange_rate: bill.exchange_rate,
        }
      : {};

  const cargos: JeLine[] = lines.map((line) => ({
    account_id: line.account_id || requireRole(roles, 'gasto'),
    debit_amount: conv(line.line_amount),
    credit_amount: null,
    description: line.description || `Bill ${bill.bill_number} - line ${line.line_number}`,
    cost_center_id: line.cost_center_id || undefined,
    project_id: line.project_id || undefined,
    ...fxCargo(line.line_amount),
  }));
  if (new Decimal(bill.tax_amount || '0').greaterThan(0)) {
    cargos.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: conv(bill.tax_amount),
      credit_amount: null,
      description: metodo
        ? `IVA ${describeMetodo(metodo)} - Bill ${bill.bill_number} · ${ivaTreatmentNote('received', metodo)}`
        : `Creditable IVA - Bill ${bill.bill_number}`,
      ...fxCargo(bill.tax_amount),
    });
  }

  // The cxp credit is the document (MNE-001-862): its total, converted to the
  // minor unit, always with its origin, whether or not the rounded debits add
  // up to it. The cent they may leave is its own line.
  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxp'),
      debit_amount: null,
      credit_amount: conv(bill.total_amount),
      description: `Bill ${bill.bill_number}`,
      ...(enExtranjera
        ? { currency_code: bill.currency_code, foreign_credit: bill.total_amount, exchange_rate: bill.exchange_rate }
        : {}),
    },
    ...cargos,
  ];
  if (enExtranjera) {
    const cent = await conversionCentLine(client, bill.entity_id, jeLines, lines.length, `Bill ${bill.bill_number}`);
    if (cent) jeLines.push(cent);
  }

  const entry = await createJournalEntry(
    bill.entity_id,
    bill.bill_date,
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
  /** One of CREDIT_NOTE_TYPES: it states which fact the note records. */
  type: string;
  invoice_id: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  credit_date: Date | string;
  journal_entry_id: string | null;
}

/**
 * DR the base role (subtotal) · DR the IVA role · CR cxc (total).
 *
 * The base role follows the note's type (MNE-001-515). An `anticipo` note
 * applies a customer advance, which is a liability until the sale exists:
 * it debits anticipo_clientes and leaves revenue whole (TipoRelacion 07 is
 * an application, not a return). Every other type debits devolucion_ventas.
 *
 * The IVA side follows where the linked invoice's IVA sits. A PUE invoice
 * put it in iva_trasladado, so the note takes it back out of there. A PPD
 * invoice parked it in iva_trasladado_no_cobrado, and the note unwinds there
 * only what the invoice still has parked (`issuedVatStillParked`): that share
 * lowers a price never collected, whose IVA was never caused (LIVA art. 1-B).
 * The rest lowers a price already collected, so its IVA leaves iva_trasladado,
 * restituted (LIVA art. 7) — the received side's rule since #692, MNE-001-575.
 * A note with no linked invoice assumes PUE and says so in the entry:
 * reversing tax that was already caused is the conservative direction for a
 * credit against collected sales.
 *
 * MNE-001-593 (#814, decision (A)): part of what is parked may be the IVA of
 * a price whose cash the firm still holds on account, kept caused after an
 * unapply (`issuedVatKeptOnAccount`). That price was collected, so the note
 * treats it as collected (`splitNoteVatOnKept`): its IVA is restituted from
 * iva_trasladado, and the same IVA of the kept cash leaves 2125 for 2150 with
 * the balance it no longer carries, owed back to the customer. One 2150 line
 * per receipt, tagged with it and the invoice. The two orders of an unapply
 * and a note then end with the same 2120, 2125 and 2150.
 * CONTRACT: the ledger: a note's entry can carry DR 2125 / CR 2150 lines
 * tagged `kept_restitution`, which the pool and a reversal read back.
 *
 * MNE-001-607 (#792, decision (A), risk 2 of #891): part of that kept cash
 * may be a held cheque's, whose IVA the cashing will cause and is not in
 * iva_trasladado yet (`issuedVatKeptOnAccount` with `held`). The note's share
 * of it is restituted all the same, but from 2125 alone, one line per cheque
 * tagged `held_restitution`; the cashing then causes the marker less it, so
 * the two orders of a note and a cashing end with the same 2120, 2125, 2150.
 * CONTRACT: the ledger: a note's 2125 debit can carry `held_restitution`.
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
  const isAdvance = note.type === 'anticipo';
  const tax = new Decimal(note.tax_amount || '0');
  // MNE-001-575: on a PPD invoice, 2125 only up to what it still has parked.
  const parked = ivaRole === 'iva_trasladado_no_cobrado' && note.invoice_id && tax.greaterThan(0)
    ? await issuedVatStillParked(client, note.entity_id, note.invoice_id)
    : null;
  const cashedHolds = parked ? await issuedVatKeptOnAccount(client, note.entity_id, note.invoice_id as string) : [];
  const heldHolds = parked ? await issuedVatKeptOnAccount(client, note.entity_id, note.invoice_id as string, { held: true }) : [];
  const split = parked
    ? splitNoteVatOnKept(tax, parked.parked, [...cashedHolds, ...heldHolds].reduce((sum, h) => sum.plus(h.iva), new Decimal(0)))
    : { fromPending: tax.toFixed(4), fromCreditable: '0.0000', fromKept: '0.0000' };
  // MNE-001-607 · the restitution from kept cash, shared across receipts; a held cheque's share leaves 2125 only.
  const keptShares = capKept([...cashedHolds, ...heldHolds].map((h) => h.iva), split.fromKept);
  const holds = cashedHolds.map((h, i) => ({ ...h, share: keptShares[i] }));
  const heldShares = heldHolds.map((h, i) => ({ ...h, share: keptShares[cashedHolds.length + i] }))
    .filter((h) => new Decimal(h.share).greaterThan(0));
  const fromHeld = heldShares.reduce((sum, h) => sum.plus(h.share), new Decimal(0));
  const fromKeptCashed = new Decimal(split.fromKept).minus(fromHeld);
  const fromKept = fromKeptCashed.greaterThan(0);
  const roles = await roleAccounts(client, note.entity_id, [
    'cxc', ivaRole, 'iva_trasladado', isAdvance ? 'anticipo_clientes' : 'devolucion_ventas',
    ...(fromKept && !isAdvance ? ['anticipo_clientes'] : []),
  ]);

  const jeLines: JeLine[] = [
    {
      // Each role is asked for by name: the plan's criteria read these calls.
      account_id: isAdvance ? requireRole(roles, 'anticipo_clientes') : requireRole(roles, 'devolucion_ventas'),
      debit_amount: note.subtotal,
      credit_amount: null,
      description: `Credit note ${note.credit_note_number}`,
    },
  ];
  if (new Decimal(split.fromPending).greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: parked ? split.fromPending : note.tax_amount,
      credit_amount: null,
      description: metodo
        ? `IVA reversed ${describeMetodo(metodo)}${parked ? ' while still parked' : ''} - Credit note ${note.credit_note_number}`
        : `IVA reversed - Credit note ${note.credit_note_number} · no linked invoice: PUE assumed`,
    });
  }
  for (const h of heldShares) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: h.share,
      credit_amount: null,
      description: `IVA reversed - Credit note ${note.credit_note_number}, restituted from the cash held cheque ` +
        `${h.paymentNumber} keeps on account: its cashing will not cause it (LIVA arts. 1-B, 7, decision (A))`,
      tags: { [HELD_RESTITUTION_TAG]: { payment_id: h.paymentId, invoice_id: note.invoice_id } },
    });
  }
  const fromCreditable = new Decimal(split.fromCreditable).minus(fromHeld);
  if (fromCreditable.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'iva_trasladado'),
      debit_amount: fromCreditable.toFixed(4),
      credit_amount: null,
      description: `IVA restituted (LIVA art. 7), already caused on collection - Credit note ${note.credit_note_number}` +
        (parked?.estimated ? ' · the invoice\'s release of an allocation that stored none is estimated pro rata' : ''),
    });
  }
  if (fromKept) {
    jeLines.push({
      account_id: requireRole(roles, ivaRole),
      debit_amount: fromKeptCashed.toFixed(4),
      credit_amount: null,
      description: `IVA of the cash kept on account that credit note ${note.credit_note_number} restituted leaves ${ivaRole}`,
    });
    holds.forEach((h) => {
      if (!new Decimal(h.share).greaterThan(0)) return;
      jeLines.push({
        account_id: requireRole(roles, 'anticipo_clientes'),
        debit_amount: null,
        credit_amount: h.share,
        description: `IVA of credit note ${note.credit_note_number}'s reduction restituted from cash kept on account by ` +
          `${h.paymentNumber}: now owed back (LIVA art. 7, decision (A))`,
        tags: { [KEPT_RESTITUTION_TAG]: { payment_id: h.paymentId, invoice_id: note.invoice_id } },
      });
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
    note.credit_date,
    JournalEntryType.AUTO_INVOICE,
    withAssumptionNote(`Credit note ${note.credit_note_number}`, metodo),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'credit_note', sourceId: note.id, reference: note.credit_note_number }
  );

  const linked = await client.query(
    `UPDATE credit_notes SET journal_entry_id = $1
      WHERE id = $2 AND entity_id = $3 AND journal_entry_id IS NULL`,
    [entry.id, note.id, note.entity_id]
  );
  if (linked.rowCount !== 1) {
    throw new AccountingError(
      'CREDIT_NOTE_ALREADY_POSTED',
      { key: 'error.CREDIT_NOTE_ALREADY_POSTED', params: { note: note.credit_note_number } }
    );
  }
  return entry;
}

/**
 * MNE-001-593 (#814, decision (A)) · A PPD note's IVA when `kept` of what the
 * invoice has parked is the IVA of cash the firm holds on account, kept
 * caused: that part of the price was collected, so the note takes from 2125
 * only up to the rest (`splitNoteVat`), restitutes the remainder from 2120
 * (LIVA art. 7), and `fromKept`, the part of that restitution the kept cash
 * covers, moves the kept cash's IVA out of 2125. `fromPending + fromKept`
 * never exceeds what is parked.
 */
export function splitNoteVatOnKept(
  tax: Decimal.Value, parked: Decimal.Value, kept: Decimal.Value
): { fromPending: string; fromCreditable: string; fromKept: string } {
  const held = Decimal.min(Decimal.max(new Decimal(kept), 0), Decimal.max(new Decimal(parked), 0));
  const split = splitNoteVat(tax, Decimal.max(new Decimal(parked).minus(held), 0));
  return { ...split, fromKept: Decimal.min(split.fromCreditable, held).toFixed(4) };
}

/**
 * The bank's GL account (the linked bank account's gl_account_id, else the
 * banco role) and, when the payment names a bank account, the currency that
 * account is kept in (null when none is named: the banco role records none).
 * MNE-001-569 · `payment trace record --bank` reads the same rule to decide
 * which ledger account a bank account linked afterwards would have moved.
 */
export async function bankAccountOf(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string | null
): Promise<{ glAccountId: string; currency: string | null }> {
  let currency: string | null = null;
  if (bankAccountId) {
    const result = await client.query<{ gl_account_id: string | null; currency_code: string | null }>(
      'SELECT gl_account_id, currency_code FROM bank_accounts WHERE id = $1 AND entity_id = $2',
      [bankAccountId, entityId]
    );
    currency = result.rows[0]?.currency_code?.trim() || null;
    if (result.rows[0]?.gl_account_id) return { glAccountId: result.rows[0].gl_account_id, currency };
  }
  const roles = await roleAccounts(client, entityId, ['banco']);
  return { glAccountId: requireRole(roles, 'banco'), currency };
}

/**
 * The bank line of a foreign-currency payment carries the payment's dollars
 * in its FX columns, which is only true when the money sits in an account
 * kept in that currency. Dollars deposited into (or paid from) a peso
 * account were converted by the bank at the rate it actually bought or sold
 * them at (art. 20 CFF, 3rd para.), not the DOF, and tagging that account
 * with a foreign balance would make the closing revaluation revalue a peso
 * account. Until a panel key decides how that conversion is booked, the
 * payment is refused and the mismatch named.
 */
export function assertBankCurrency(
  bank: { currency: string | null },
  paymentCurrency: string,
  paymentNumber: string
): void {
  if (bank.currency && bank.currency !== paymentCurrency) {
    throw new AccountingError(
      'FX_BANK_CURRENCY_MISMATCH',
      {
        key: 'error.FX_BANK_CURRENCY_MISMATCH',
        params: { payment: paymentNumber, currency: paymentCurrency, bankCurrency: bank.currency },
      }
    );
  }
}

/**
 * The realised exchange difference of a foreign-currency payment, as the
 * line that makes its entry foot. Every other line is already at its own
 * rate (cash at today's, each document at the one it was born with, the
 * caused IVA at today's and the parked IVA at the document's), so whatever
 * separates debits from credits is the realised result (NIF B-15). It
 * carries no FX columns: in the document's currency it nets to zero.
 */
async function realisedDifferenceLine(
  client: pg.PoolClient,
  entityId: string,
  lines: JeLine[],
  paymentNumber: string,
  fx: ContextoCambiario
): Promise<{ line: JeLine | null; difference: DiferenciaCambiaria }> {
  const net = lines.reduce(
    (s, l) => s.plus(l.debit_amount ?? '0').minus(l.credit_amount ?? '0'),
    new Decimal(0)
  );
  const amount = net.abs().toFixed(4);
  if (net.isZero()) return { line: null, difference: { tipo: 'ninguna', montoFuncional: amount } };
  const gain = net.greaterThan(0);
  const role = gain ? 'utilidad_cambiaria' : 'perdida_cambiaria';
  const roles = await roleAccounts(client, entityId, [role]);
  return {
    line: {
      account_id: requireRole(roles, role),
      debit_amount: gain ? null : amount,
      credit_amount: gain ? amount : null,
      description: `Realized FX ${gain ? 'gain' : 'loss'} ${paymentNumber} (${fx.moneda} @ ${fx.tasaPago})`,
    },
    difference: { tipo: gain ? 'utilidad' : 'perdida', montoFuncional: amount },
  };
}

/** The exchange context the IVA release reads (see `fx` on ivaReclassLines). */
type IvaFx = Pick<ContextoCambiario, 'moneda'> & { tasasPorDocumento: Map<string, string>; paymentRate: string };

interface PaymentRow {
  id: string;
  entity_id: string;
  payment_number: string;
  payment_amount: string;
  payment_date: Date | string;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  /** MNE-001-458 · the base and IVA an advance's cash on account splits into; absent: credited whole. */
  advance_base_amount?: string | null;
  advance_iva_amount?: string | null;
  /**
   * MNE-001-462 · said in the receipt's entry when the excess it leaves on
   * account took its treatment from the invoices it collects, as a missing
   * MetodoPago is said (`withAssumptionNote`).
   */
  advance_note?: string | null;
  /**
   * A cheque in the functional currency the bank has not cashed yet: a price
   * paid by cheque, and its IVA, is paid the day it is cashed (LIVA art. 1-B,
   * second paragraph), so the payment's entries and its applications release
   * nothing and the recorded cashing does; a customer advance by cheque
   * credits 2150 whole (MNE-001-558). Customer side, MNE-001-556
   * (`recordCustomerCheckCashing`); vendor side, MNE-001-508 (`conciliarCheque`).
   */
  holdsIvaUntilCashed?: boolean;
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
  payment: PaymentRow,
  /**
   * Both sides: the HISTORICAL rate of each foreign-currency document
   * (bills.exchange_rate on a vendor payment, invoices.exchange_rate written
   * back by MNE-001-081 on a collection), so the parked IVA is released
   * valued as it was parked; and the payment day's rate, at which the IVA
   * that becomes due (iva_trasladado / iva_acreditable) is converted, because
   * the tax is caused when the money moves (LIVA arts. 1-B, 5-III and 11) and
   * art. 20 CFF converts it at that day's rate. The gap between the two is
   * part of the realised exchange difference the caller books.
   */
  fx?: IvaFx
): Promise<{ lines: JeLine[]; documents: string[]; items: { documentId: string; amount: string }[] }> {
  if (!(await entityUsesCashBasisIva(client, payment.entity_id))) {
    return { lines: [], documents: [], items: [] };
  }

  const items = await ivaReclassificationsFor(
    client,
    side,
    payment.entity_id,
    payment.id,
    fx?.tasasPorDocumento
  );
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
    // In the functional currency the pair is self-balancing. In a foreign
    // one the two sides sit at different rates (see `dueAt` below).
    const conFx = fx && item.tasa && item.importeOriginal
      ? { currency_code: fx.moneda, exchange_rate: item.tasa }
      : null;
    // The pending side leaves at the rate it was parked at; the due side is
    // the tax figure, converted at the payment day's rate. When the parked
    // cap trimmed the release there is no honest document amount to convert,
    // and the due side mirrors the pending one.
    const dueAt = fx && item.documentAmount
      ? { amount: convertirAFuncional(item.documentAmount, fx.paymentRate), foreign: item.documentAmount }
      : null;
    const amountOf = (r: { role: string }): string => (r === due && dueAt ? dueAt.amount : item.amount);
    const originOf = (r: { role: string }, side: 'foreign_debit' | 'foreign_credit'): Partial<JeLine> =>
      fx && r === due && dueAt
        ? { currency_code: fx.moneda, exchange_rate: fx.paymentRate, [side]: dueAt.foreign }
        : conFx && item.importeOriginal
          ? { ...conFx, [side]: item.importeOriginal }
          : {};
    lines.push({
      account_id: debited.id,
      debit_amount: amountOf(debited),
      credit_amount: null,
      description: note(debited),
      ...originOf(debited, 'foreign_debit'),
    });
    lines.push({
      account_id: credited.id,
      debit_amount: null,
      credit_amount: amountOf(credited),
      description: note(credited),
      ...originOf(credited, 'foreign_credit'),
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
 *
 * With `fx` (MNE-001-082, the collection is in another currency than the
 * functional one): each receivable is extinguished at the rate its invoice
 * was born with, the cash comes in at today's rate, and the gap is the
 * REALISED exchange difference, credited to utilidad_cambiaria or debited
 * to perdida_cambiaria (NIF B-15). The PPD IVA leaves 2125 at the invoice's
 * rate, the one it was parked at, and lands in 2120 at the collection day's
 * rate, the one the tax is caused at (LIVA arts. 1-B and 11, art. 20 CFF);
 * that gap is realised too. The result carries the difference it booked, so
 * the caller's audit trail repeats the ledger instead of recomputing it.
 */
export async function postCustomerPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string,
  fx?: ContextoCambiario
): Promise<PaymentPosting | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bank = await bankAccountOf(client, payment.entity_id, payment.bank_account_id);
  // A held cheque releases nothing here; its allocations store 0 below, as any
  // allocation that released nothing does.
  const vat = payment.holdsIvaUntilCashed
    ? { lines: [], documents: [], items: [] }
    : await ivaReclassLines(client, 'issued', payment, fx ? ivaFxOf(fx) : undefined);
  // #699 · The IEPS a PPD sale parked is caused by the same collection (LIEPS
  // art. 10, with LIVA's tests of collection by art. 5o.-C), so it moves on
  // this entry with the VAT, and a held cheque moves it on its cashing.
  const ieps = payment.holdsIvaUntilCashed || !(await entityUsesCashBasisIva(client, payment.entity_id))
    ? []
    : await iepsCausedByReceipt(client, payment.entity_id, payment.id);
  const iva = {
    ...vat,
    lines: [...vat.lines, ...(await iepsMoveLines(client, payment.entity_id, payment.id, ieps, 'release', 'collection'))],
  };
  const taxNote = [
    ...(vat.documents.length ? [`IVA caused on collection: ${vat.documents.join(', ')}`] : []),
    ...(ieps.length ? [`IEPS caused on collection: ${ieps.map((m) => m.invoiceNumber).join(', ')}`] : []),
  ];
  // A held advance goes whole to 2150; its cashing moves its IVA to 2120
  // (MNE-001-558, #623 comment 6961035083). The receipt keeps the split.
  const credited = payment.holdsIvaUntilCashed
    ? { ...payment, advance_base_amount: null, advance_iva_amount: null }
    : payment;
  const { jeLines, memo, difference } = fx
    ? await foreignReceiptLines(client, payment, fx, bank, iva)
    : { ...(await functionalReceiptLines(client, credited, bank.glAccountId, iva)), difference: undefined };

  const entry = await createJournalEntry(
    payment.entity_id,
    // The payment's own day, unparsed (#211): `new Date('YYYY-MM-DD')` was UTC
    // midnight, and west of Greenwich the entry landed a day before its payment.
    payment.payment_date,
    JournalEntryType.AUTO_PAYMENT,
    taxNote.length
      ? `Customer payment ${payment.payment_number} · ${taxNote.join(' · ')}${memo}${payment.advance_note ?? ''}`
      : `Customer payment ${payment.payment_number}${memo}${payment.advance_note ?? ''}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'customer_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  // The IVA THIS application released is stored on its row, 0 included, so
  // unapplying it re-parks that exact amount instead of re-deriving it under
  // another context. Invariant 3: scoped through the payment's entity, only a
  // live allocation that has not recorded a release yet, and a missed row is
  // loud.
  for (const item of iva.items) {
    const stored = await client.query(
      `UPDATE payment_allocations pa SET iva_reclass_amount = $1
         FROM customer_payments cp
        WHERE cp.id = pa.payment_id AND cp.entity_id = $4
          AND pa.payment_id = $2 AND pa.invoice_id = $3
          AND pa.unapplied_at IS NULL AND pa.iva_reclass_amount IS NULL`,
      [item.amount, payment.id, item.documentId, payment.entity_id]
    );
    if (!stored.rowCount) {
      throw new AccountingError(
        'PAYMENT_ALLOCATION_NOT_FOUND',
        {
          key: 'error.PAYMENT_ALLOCATION_NOT_FOUND.no_live_allocation',
          params: { payment: payment.payment_number, invoice: item.documentId },
        }
      );
    }
  }
  // Whatever is still waiting released nothing: a PUE invoice, a PPD release
  // capped to 0, or an entity off cash-basis books. NULL is left to the rows
  // written before this store, the only ones an unapply still estimates.
  const unreleased = await client.query<{ id: string }>(
    `SELECT pa.id FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $2 AND pa.payment_id = $1
        AND pa.unapplied_at IS NULL AND pa.iva_reclass_amount IS NULL
        FOR UPDATE OF pa`,
    [payment.id, payment.entity_id]
  );
  if (unreleased.rows.length > 0) {
    const zeroed = await client.query(
      `UPDATE payment_allocations pa SET iva_reclass_amount = 0
         FROM customer_payments cp
        WHERE cp.id = pa.payment_id AND cp.entity_id = $2
          AND pa.id = ANY($1::uuid[])
          AND pa.unapplied_at IS NULL AND pa.iva_reclass_amount IS NULL`,
      [unreleased.rows.map((r) => r.id), payment.entity_id]
    );
    if (zeroed.rowCount !== unreleased.rows.length) {
      throw new AccountingError(
        'PAYMENT_ALLOCATION_NOT_FOUND',
        {
          key: 'error.PAYMENT_ALLOCATION_NOT_FOUND.release_not_recorded',
          params: { payment: payment.payment_number, unreleased: unreleased.rows.length, recorded: zeroed.rowCount ?? 0 },
        }
      );
    }
  }

  const linked = await client.query(
    `UPDATE customer_payments SET journal_entry_id = $1
      WHERE id = $2 AND entity_id = $3 AND journal_entry_id IS NULL`,
    [entry.id, payment.id, payment.entity_id]
  );
  if (linked.rowCount !== 1) {
    throw new AccountingError(
      'PAYMENT_ALREADY_POSTED',
      { key: 'error.PAYMENT_ALREADY_POSTED.payment', params: { payment: payment.payment_number } }
    );
  }
  return difference ? { ...entry, realisedFx: difference } : entry;
}

/** A posted payment entry, with the realised exchange difference it booked when it was in another currency. */
export type PaymentPosting = JournalEntry & { realisedFx?: DiferenciaCambiaria };

/** What the IVA release needs from an exchange context: each document's birth rate and the payment day's rate. */
function ivaFxOf(fx: ContextoCambiario): IvaFx {
  return {
    moneda: fx.moneda,
    tasasPorDocumento: new Map(fx.aplicaciones.map((a) => [a.billId, a.tasaHistorica])),
    paymentRate: fx.tasaPago,
  };
}

type ReclassLines = Awaited<ReturnType<typeof ivaReclassLines>>;

/** A collection in the functional currency: DR bank · CR cxc and, for any remainder, anticipo_clientes. */
async function functionalReceiptLines(
  client: pg.PoolClient,
  payment: PaymentRow,
  bankId: string,
  iva: ReclassLines
): Promise<{ jeLines: JeLine[]; memo: string }> {
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
  // MNE-001-458 · An advance recorded with its treatment causes its IVA the
  // day it is collected (LIVA art. 1-B): the base stays in anticipo_clientes
  // and the IVA goes to iva_trasladado. The split has to be the whole
  // remainder, or the entry would not foot.
  const advanceIva = new Decimal(payment.advance_iva_amount ?? '0');
  const advanceBase = payment.advance_base_amount == null ? remanente : new Decimal(payment.advance_base_amount);
  if (!advanceBase.plus(advanceIva).equals(remanente)) {
    throw new AccountingError(
      'ADVANCE_SPLIT_MISMATCH',
      {
        key: 'error.ADVANCE_SPLIT_MISMATCH',
        params: {
          payment: payment.payment_number,
          base: advanceBase.toFixed(2),
          iva: advanceIva.toFixed(2),
          remaining: remanente.toFixed(2),
        },
      }
    );
  }
  const rolesPedidos = ['cxc', ...(remanente.greaterThan(0) ? ['anticipo_clientes'] : []),
    ...(advanceIva.greaterThan(0) ? ['iva_trasladado'] : [])];
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
      credit_amount: advanceBase.toFixed(4),
      description: `On-account (unapplied) ${payment.payment_number}`,
    });
  }
  if (advanceIva.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'iva_trasladado'),
      debit_amount: null,
      credit_amount: advanceIva.toFixed(4),
      description: `IVA caused on collection of advance ${payment.payment_number}`,
    });
  }
  jeLines.push(...iva.lines);
  return { jeLines, memo: '' };
}

/**
 * A collection in another currency: DR bank at the collection rate, CR cxc
 * per invoice at its own rate, and the realised difference that separates
 * them. Cash left on account is refused upstream (FX_AR_ON_ACCOUNT_NOT_WIRED)
 * and again here, because the later events that would move it do not convert.
 */
async function foreignReceiptLines(
  client: pg.PoolClient,
  payment: PaymentRow,
  fx: ContextoCambiario,
  bank: { glAccountId: string; currency: string | null },
  iva: ReclassLines
): Promise<{ jeLines: JeLine[]; memo: string; difference: DiferenciaCambiaria }> {
  const applied = fx.aplicaciones.reduce((s, a) => s.plus(a.aplicado), new Decimal(0));
  const onAccount = new Decimal(payment.payment_amount).minus(applied);
  if (onAccount.greaterThan(0)) {
    throw new AccountingError(
      'FX_AR_ON_ACCOUNT_NOT_WIRED',
      {
        key: 'error.FX_AR_ON_ACCOUNT_NOT_WIRED',
        params: { payment: payment.payment_number, amount: onAccount.toFixed(4), currency: fx.moneda },
      }
    );
  }
  assertBankCurrency(bank, fx.moneda, payment.payment_number);
  const roles = await roleAccounts(client, payment.entity_id, ['cxc']);
  const arAccount = requireRole(roles, 'cxc');

  const jeLines: JeLine[] = [
    {
      account_id: bank.glAccountId,
      debit_amount: convertirAFuncional(payment.payment_amount, fx.tasaPago, fx.monedaFuncional),
      credit_amount: null,
      description: `Payment received ${payment.payment_number}`,
      currency_code: fx.moneda,
      foreign_debit: new Decimal(payment.payment_amount).toFixed(4),
      exchange_rate: fx.tasaPago,
    },
  ];
  // Per invoice, not aggregated: each was born with its own rate.
  for (const app of fx.aplicaciones) {
    if (!new Decimal(app.aplicado).greaterThan(0)) continue;
    const foreign = new Decimal(app.aplicado).toFixed(4);
    const atBirthRate = convertirAFuncional(foreign, app.tasaHistorica, fx.monedaFuncional);
    jeLines.push({
      account_id: arAccount,
      debit_amount: null,
      credit_amount: atBirthRate,
      description: `AR settlement ${payment.payment_number} - Invoice ${app.numero}`,
      currency_code: fx.moneda,
      foreign_credit: foreign,
      exchange_rate: app.tasaHistorica,
    });
    // The truthful line above is q4(applied × rate). What the invoice's
    // receivable actually still holds can differ by rounding: it was born as
    // the sum of its rounded lines, and each earlier tranche was rounded on
    // its own. The remainder is a functional-only line on the same account,
    // so the receivable of a fully collected invoice ends at exactly zero.
    const remainder = new Decimal(await receivableCredit(client, payment.entity_id, arAccount, app, fx.monedaFuncional)).minus(atBirthRate);
    if (!remainder.isZero()) {
      jeLines.push({
        account_id: arAccount,
        debit_amount: remainder.isNegative() ? remainder.abs().toFixed(4) : null,
        credit_amount: remainder.isNegative() ? null : remainder.toFixed(4),
        description: `AR rounding at ${app.tasaHistorica} ${payment.payment_number} - Invoice ${app.numero}`,
      });
    }
  }
  jeLines.push(...iva.lines);
  const { line, difference } = await realisedDifferenceLine(
    client,
    payment.entity_id,
    jeLines,
    payment.payment_number,
    fx
  );
  if (line) jeLines.push(line);
  const memo =
    difference.tipo === 'ninguna'
      ? ''
      : ` · realized FX ${difference.tipo === 'utilidad' ? 'gain' : 'loss'} ${difference.montoFuncional} ${fx.monedaFuncional}`;
  return { jeLines, memo, difference };
}

/**
 * The functional amount one tranche takes off an invoice's receivable,
 * telescoped like the IVA release (iva-cash-basis.ts): q4(cumulative
 * collected with this tranche × rate) − q4(cumulative before it × rate), so
 * the tranches add up to the whole whatever the split. On the tranche that
 * collects the invoice in full, it is instead what the receivable still
 * holds: the debit it was born with (the sum of its rounded lines,
 * MNE-001-081) minus the telescoped earlier tranches.
 */
async function receivableCredit(
  client: pg.PoolClient,
  entityId: string,
  arAccount: string,
  app: AplicacionCambiaria,
  functional: string
): Promise<string> {
  const prior = new Decimal(app.priorApplied ?? '0');
  const cumulative = prior.plus(app.aplicado);
  const atRate = (x: Decimal): Decimal => new Decimal(convertirAFuncional(x.toFixed(4), app.tasaHistorica, functional));
  if (app.documentTotal !== undefined && cumulative.equals(app.documentTotal)) {
    const bornDebit = await queryInvoiceEntryNetOnAccount(entityId, app.billId, arAccount, client);
    if (bornDebit) return new Decimal(bornDebit).minus(atRate(prior)).toFixed(4);
  }
  return atRate(cumulative).minus(atRate(prior)).toFixed(4);
}

export interface AplicacionPosterior {
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  /** F04 · sólo lado proveedor: el descuento por pronto pago de esta aplicación. */
  discount?: string;
  /** MNE-001-597 · vendor side only: whether this event leaves the bill owing nothing. */
  closes?: boolean;
  /**
   * F04 · sólo lado proveedor: el saldo que DEJA DE DEBERSE al cerrar el gasto
   * pagando de menos (`payment apply --mode residual`). No es un descuento
   * pactado de antemano sino un remanente que se renuncia a pagar, y por eso
   * va a la cuenta que dicte la política `pago_corto_residual` y no siempre a
   * la misma que el descuento.
   */
  writeOff?: string;
  /**
   * MNE-001-113 · customer side only: the ISR and VAT the customer withheld on
   * this application. They close the receivable with `amount` and are
   * debited to the two customer-withholding roles.
   */
  withholdingIsr?: string;
  withholdingIva?: string;
  /**
   * MNE-001-422 · customer side only: the IVA an advance caused when it was
   * collected that this cash carries, cancelled on its sale's invoice (DR
   * 2120; on a PPD invoice netted against the share it releases, MNE-001-461)
   * instead of caused again, and the month whose 2120 also carried it, when a
   * PUE invoice was issued on or before the advance.
   */
  advanceIva?: string;
  advanceIvaTwiceIn?: string | null;
  /**
   * MNE-001-573 · a held cheque's advance IVA this cash takes and the entry
   * cancels nothing for (`defer_to_cashing`): the cashing nets it against the
   * share the PPD invoice releases. Named in the description only.
   */
  advanceIvaDeferred?: string;
  /** MNE-001-573 · the cashing day of a cheque whose PUE invoice of an earlier month caused that IVA. */
  advanceIvaCashedOn?: string | null;
  /**
   * MNE-001-590 · customer side only: the IEPS that this cash carries, caused
   * when it was collected and kept by an unapply (`iepsTakeOf`). It nets
   * against the IEPS share the invoice releases: CR 2180 r − e, DR when
   * negative, no line at zero. Only the rest of the cash leaves 2150.
   */
  advanceIeps?: string;
  /** MNE-001-604 · customer side only: the allocation row, tagged on its IEPS lines so its unapply reads its take back. */
  allocationId?: string;
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
 *
 * MNE-001-460: dated `date`, the day of the application, never the process
 * clock: the IVA it causes belongs to that day's month.
 *
 * MNE-001-422: the advance's IVA the cash carries (`advanceIva`) is debited
 * to 2120, and only the rest of the cash to anticipo_clientes.
 *
 * MNE-001-461: on a PPD invoice that debit meets the share released from
 * 2125 in one 2120 line per invoice, CR g − c (DR when negative, none at
 * zero). The release returned is g, what left 2125.
 *
 * MNE-001-590: the IEPS that the cash carries (`advanceIeps`, e) nets the
 * same way against the invoice's IEPS share (r): CR 2180 r − e, DR when
 * negative, none at zero, and 2150 gives up only the rest.
 */
// MNE-001-113: what the customer withheld also closes the receivable, as a
// debit to the two customer-withholding roles. The VAT the customer
// withholds counts as collected (LIVA art. 1-B: the creditor's interest is
// satisfied when the customer withholds it and remits it for us), so the PPD
// release is on the cash plus the withholding; the withheld VAT is then
// credited in the monthly computation (LIVA art. 5-D), from 1146.
export async function postReceiptApplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  aplicaciones: AplicacionPosterior[],
  userId: string,
  date: string
): Promise<{ entry: JournalEntry; ivaPorFactura: Map<string, string> }> {
  const total = aplicaciones.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  const withheldIsr = aplicaciones.reduce((s, a) => s.plus(a.withholdingIsr ?? '0'), new Decimal(0));
  const withheldIva = aplicaciones.reduce((s, a) => s.plus(a.withholdingIva ?? '0'), new Decimal(0));
  const cashBasis = await entityUsesCashBasisIva(client, payment.entity_id);
  const ivaPorFactura = new Map<string, string>();
  const documentos: string[] = [];
  const iepsDocs: string[] = [];
  const iepsLines: JeLine[] = [];
  let iepsTaken = new Decimal(0);

  // A cheque not cashed yet releases nothing: the caller stores 0 and the cashing releases it.
  if (cashBasis && !payment.holdsIvaUntilCashed) {
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
        appliedNow: new Decimal(app.amount).plus(app.withholdingIsr ?? '0').plus(app.withholdingIva ?? '0').toFixed(4),
      });
      const parked = await ivaStillParked(client, 'issued', payment.entity_id, app.invoiceId);
      const liberable = Decimal.min(new Decimal(bruto), new Decimal(parked));
      if (liberable.lessThanOrEqualTo(0)) continue;
      ivaPorFactura.set(app.invoiceId, liberable.toFixed(4));
    }

    // #699 · The IEPS share of the same tranche, whatever the VAT did: what
    // the invoice parked decides, and an invoice that parked none moves none.
    const ieps: IepsMove[] = [];
    for (const app of aplicaciones) {
      const amount = await iepsCausedBy(client, payment.entity_id, {
        invoiceId: app.invoiceId,
        totalAmount: app.totalAmount,
        priorApplied: app.priorApplied,
        appliedNow: new Decimal(app.amount).plus(app.withholdingIsr ?? '0').plus(app.withholdingIva ?? '0').toFixed(4),
      });
      // MNE-001-590: the IEPS this cash already carries nets against the share (`take`).
      const take = new Decimal(app.advanceIeps ?? '0');
      if (new Decimal(amount).greaterThan(0) || take.greaterThan(0)) {
        ieps.push({
          invoiceId: app.invoiceId, invoiceNumber: app.invoiceNumber, amount,
          ...(take.greaterThan(0) ? { take: take.toFixed(4) } : {}),
          ...(app.allocationId ? { allocationId: app.allocationId } : {}),
        });
        iepsTaken = iepsTaken.plus(take);
      }
    }
    iepsLines.push(...(await iepsMoveLines(client, payment.entity_id, payment.id, ieps, 'release', 'collection')));
    iepsDocs.push(...ieps.filter((m) => new Decimal(m.amount).greaterThan(m.take ?? '0')).map((m) => m.invoiceNumber));
  }

  // MNE-001-422 / MNE-001-461: an advance's IVA, caused when it was collected
  // (`c`), is cancelled on its sale's invoice instead of caused again, as the
  // TipoRelacion 07 egreso does (`egreso_emitido_aplicacion_anticipo`,
  // cfdi-taxonomy.ts); its base alone leaves 2150. On a PPD invoice the share
  // the cash settles still leaves 2125 (`g`, the release above), and the two
  // meet in one 2120 line, CR g − c (DR when negative, none at zero), so the
  // IVA of that cash is caused once (LIVA art. 1-B).
  const advanceIva = aplicaciones.reduce((s, a) => s.plus(a.advanceIva ?? '0'), new Decimal(0));
  const twice = [...new Set(aplicaciones.flatMap((a) => (a.advanceIvaTwiceIn && !a.advanceIvaCashedOn ? [a.advanceIvaTwiceIn] : [])))];
  const beforeCashing = [...new Set(aplicaciones.flatMap((a) =>
    (a.advanceIvaTwiceIn && a.advanceIvaCashedOn ? [`${a.advanceIvaTwiceIn} caused the advance IVA its cheque's cashing of ${a.advanceIvaCashedOn} causes`] : [])))];
  const deferred = aplicaciones.reduce((s, a) => s.plus(a.advanceIvaDeferred ?? '0'), new Decimal(0));
  const ivaLines: JeLine[] = [];
  if (ivaPorFactura.size > 0 || advanceIva.greaterThan(0)) {
    const { from, to } = reclassRoles('issued');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    for (const app of aplicaciones) {
      const released = new Decimal(ivaPorFactura.get(app.invoiceId) ?? '0');
      const cancelled = new Decimal(app.advanceIva ?? '0');
      if (released.greaterThan(0)) {
        ivaLines.push({
          account_id: requireRole(ivaRoles, from),
          debit_amount: released.toFixed(4),
          credit_amount: null,
          description: `IVA released from ${from} on collection - Invoice ${app.invoiceNumber}`,
        });
      }
      const net = released.minus(cancelled);
      if (net.greaterThan(0)) {
        documentos.push(app.invoiceNumber);
        ivaLines.push({
          account_id: requireRole(ivaRoles, to),
          debit_amount: null,
          credit_amount: net.toFixed(4),
          description: `IVA now in ${to} (PPD collection) - Invoice ${app.invoiceNumber}` +
            (cancelled.greaterThan(0) ? `, net of advance ${payment.payment_number}'s ${cancelled.toFixed(4)} caused when collected` : ''),
        });
      } else if (net.lessThan(0)) {
        ivaLines.push({
          account_id: requireRole(ivaRoles, to),
          debit_amount: net.negated().toFixed(4),
          credit_amount: null,
          description: `IVA of advance ${payment.payment_number} cancelled on ${app.invoiceNumber}, caused when collected` +
            (released.greaterThan(0) ? `, net of ${released.toFixed(4)} released` : '') +
            (app.advanceIvaTwiceIn ? ` · ${app.advanceIvaTwiceIn} also caused it on the invoice` : ''),
        });
      }
    }
  }

  const roles = await roleAccounts(client, payment.entity_id, ['cxc', 'anticipo_clientes']);
  const entry = await createJournalEntry(
    payment.entity_id,
    date,
    JournalEntryType.AUTO_PAYMENT,
    [
      `Application of ${payment.payment_number}`,
      ...(documentos.length ? [`IVA caused on collection: ${documentos.join(', ')}`] : []),
      ...(iepsDocs.length ? [`IEPS caused on collection: ${iepsDocs.join(', ')}`] : []),
      ...(twice.length ? [`advance IVA caused twice in ${twice.join(', ')}`] : []),
      ...beforeCashing,
      ...(deferred.greaterThan(0) ? [`advance IVA ${deferred.toFixed(4)} deferred to the cheque's cashing`] : []),
    ].join(' · '),
    [
      {
        account_id: requireRole(roles, 'anticipo_clientes'),
        debit_amount: total.minus(advanceIva).minus(iepsTaken).toFixed(4),
        credit_amount: null,
        description: `On-account applied ${payment.payment_number}`,
      },
      ...(await withholdingLines(client, payment, withheldIsr, withheldIva, 'debit')),
      {
        account_id: requireRole(roles, 'cxc'),
        debit_amount: null,
        credit_amount: total.plus(withheldIsr).plus(withheldIva).toFixed(4),
        description: `AR settlement ${payment.payment_number}`,
      },
      ...ivaLines,
      ...iepsLines,
    ],
    userId,
    // Fuera del índice parcial uq_je_document_source a propósito: un cobro
    // puede tener VARIOS eventos de aplicación, cada uno con su asiento.
    { autoPost: true, client, sourceType: 'receipt_application', sourceId: payment.id, reference: payment.payment_number }
  );
  return { entry, ivaPorFactura };
}

/**
 * The customer's withholding on its role accounts (MNE-001-113): debit when
 * an application books it, credit when an unapplication takes it back. The
 * roles are only read when there is something to book, so a collection
 * without withholding never needs them.
 */
async function withholdingLines(
  client: pg.PoolClient,
  payment: PaymentRow,
  isr: Decimal,
  iva: Decimal,
  side: 'debit' | 'credit'
): Promise<JeLine[]> {
  const parts = [
    { role: 'isr_retenido_a_favor', amount: isr, label: 'ISR' },
    { role: 'iva_retenido_a_favor', amount: iva, label: 'VAT' },
  ].filter((p) => p.amount.greaterThan(0));
  if (parts.length === 0) return [];
  const roles = await roleAccounts(client, payment.entity_id, parts.map((p) => p.role));
  return parts.map((p) => ({
    account_id: requireRole(roles, p.role),
    debit_amount: side === 'debit' ? p.amount.toFixed(4) : null,
    credit_amount: side === 'credit' ? p.amount.toFixed(4) : null,
    description: `${p.label} withheld by the customer ${payment.payment_number}${side === 'credit' ? ' (unapply)' : ''}`,
  }));
}

/**
 * Aplicar el anticipo a proveedor a facturas, como evento posterior al pago
 * (F04): DR cxp · CR anticipo_proveedores por lo aplicado, más la
 * acreditación del IVA que cada gasto tenga aparcado en 1135 —sea PUE o PPD
 * (MNE-001-491)—, por la parte que ESTE evento paga.
 * El efectivo no se mueve — ya salió con el pago; lo que se mueve es el
 * derecho, del activo por anticipos al pasivo que extingue.
 *
 * Espejo del lado cliente, con los roles invertidos y una diferencia real:
 * aquí el descuento por pronto pago SÍ puede aparecer, porque una aplicación
 * tardía dentro de la ventana sigue dando derecho a él.
 *
 * MNE-001-678: dated `date`, the day of the application, never the process
 * clock: the IVA it credits belongs to that day's month.
 */
export async function postVendorApplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  aplicaciones: AplicacionPosterior[],
  userId: string,
  date: string,
  /**
   * Cuenta destino del pago corto. Llega como PARÁMETRO y no se decide aquí:
   * cuál es depende de la política `pago_corto_residual` del despacho, y esta
   * capa no consulta políticas — postea lo que se le dice y cuadra. Si no
   * viene, es que ninguna aplicación trae writeOff.
   */
  writeOffRole?: 'devolucion_compras' | 'otros_ingresos'
): Promise<{
  entry: JournalEntry;
  ivaPorGasto: Map<string, string>;
  /** IVA que salió de 1135 SIN acreditarse, por gasto condonado. */
  ivaNoAcreditablePorGasto: Map<string, string>;
  /** MNE-001-597 · the VAT of each bill's early-payment discount that left 1135, 0 included. */
  discountVatByBill: Map<string, string>;
}> {
  const total = aplicaciones.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  const descuento = aplicaciones.reduce((s, a) => s.plus(a.discount ?? '0'), new Decimal(0));
  const condonado = aplicaciones.reduce((s, a) => s.plus(a.writeOff ?? '0'), new Decimal(0));
  if (condonado.greaterThan(0) && !writeOffRole) {
    throw new AccountingError(
      'WRITE_OFF_ACCOUNT_UNRESOLVED',
      { key: 'error.WRITE_OFF_ACCOUNT_UNRESOLVED' }
    );
  }
  const cashBasis = await entityUsesCashBasisIva(client, payment.entity_id);
  const ivaPorGasto = new Map<string, string>();
  /** IVA que salió de 1135 SIN acreditarse, por haberse condonado su gasto. */
  const ivaNoAcreditablePorGasto = new Map<string, string>();
  const discountVatByBill = new Map<string, string>();
  const ivaLines: JeLine[] = [];
  const documentos: string[] = [];

  if (cashBasis) {
    const { from, to } = reclassRoles('received');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    for (const app of aplicaciones) {
      // MNE-001-491: no method test. What the bill still has parked decides:
      // a bill whose IVA went to the creditable account has a cap of zero.
      const bruto = await receivedReleaseAtSettlement(client, payment.entity_id, app.invoiceId, ivaToReclassify({
        ivaTotal: app.taxAmount,
        documentTotal: app.totalAmount,
        priorApplied: app.priorApplied,
        appliedNow: app.amount,
      }));
      const parked = await ivaStillParked(client, 'received', payment.entity_id, app.invoiceId);
      // A held cheque credits nothing here; the written-off share below still
      // leaves 1135, because it was never going to be paid.
      const liberable = payment.holdsIvaUntilCashed
        ? new Decimal(0)
        : Decimal.min(new Decimal(bruto), new Decimal(parked));

      // ── EL IVA DEL SALDO CONDONADO ──────────────────────────────────
      //
      // Un pago corto cierra el gasto sin pagarlo entero, y el IVA de la
      // parte que no se pagó NUNCA va a ser acreditable: bajo flujo de
      // efectivo se acredita lo pagado, y eso ya no se va a pagar. Si sólo
      // se liberara la parte pagada, en 1135 quedaría un resto vivo de un
      // gasto CERRADO — un residuo que ningún informe sabe explicar y que
      // nadie puede vaciar después, porque el documento que lo justificaba
      // ya no tiene saldo. Es exactamente el residuo permanente que la
      // migración 050 advierte.
      //
      // Así que sale de 1135 en el mismo asiento, y NO hacia 1130 (no se
      // acredita: no se pagó) sino hacia la cuenta del pago corto, junto
      // con la parte de costo que se condona. El reparto es proporcional
      // al peso del IVA en el total del gasto, y se topa con lo que de
      // verdad quede aparcado tras la liberación: nunca se puede sacar de
      // 1135 más de lo que hay.
      const condonadoAqui = new Decimal(app.writeOff ?? '0');
      let ivaCondonado = new Decimal(0);
      if (condonadoAqui.greaterThan(0) && new Decimal(app.totalAmount).greaterThan(0)) {
        const proporcional = condonadoAqui
          .times(app.taxAmount)
          .dividedBy(app.totalAmount);
        const restaAparcado = new Decimal(parked).minus(liberable);
        ivaCondonado = Decimal.max(
          0,
          Decimal.min(proporcional, restaAparcado)
        );
      }
      if (ivaCondonado.greaterThan(0)) {
        ivaNoAcreditablePorGasto.set(app.invoiceId, ivaCondonado.toFixed(4));
        ivaLines.push({
          account_id: requireRole(ivaRoles, from),
          debit_amount: null,
          credit_amount: ivaCondonado.toFixed(4),
          description:
            `IVA on the written-off balance leaves ${from} without becoming creditable - ` +
            `Bill ${app.invoiceNumber}`,
        });
      }

      // MNE-001-597 · THE VAT OF THE DISCOUNT. A discount lowers the price and
      // with it the VAT (LIVA art. 7); on cash basis that share is never paid,
      // so it is never creditable (art. 5 fr. III). It leaves 1135 against the
      // discount, from what the bill still has parked net of its earlier
      // payments and of this event's release and write-off.
      if (new Decimal(app.discount ?? '0').greaterThan(0)) {
        const remainder = new Decimal(await receivedVatStillParked(client, payment.entity_id, app.invoiceId))
          .minus(liberable)
          .minus(ivaCondonado);
        const vatOfDiscount = discountVatShare({
          discount: app.discount ?? '0', taxAmount: app.taxAmount, totalAmount: app.totalAmount,
          remainder, closes: app.closes === true,
        });
        discountVatByBill.set(app.invoiceId, vatOfDiscount);
        if (new Decimal(vatOfDiscount).greaterThan(0)) ivaLines.push(discountVatLine(requireRole(ivaRoles, from), from, vatOfDiscount, app.invoiceNumber));
      }

      if (liberable.lessThanOrEqualTo(0)) continue;
      const monto = liberable.toFixed(4);
      ivaPorGasto.set(app.invoiceId, monto);
      documentos.push(app.invoiceNumber);
      // Recibido: el IVA sale del PENDIENTE (1135, activo: se vacía con
      // crédito) y entra al ACREDITABLE (1130, activo: se llena con débito).
      ivaLines.push({
        account_id: requireRole(ivaRoles, to),
        debit_amount: monto,
        credit_amount: null,
        description: `IVA now in ${to} (on payment) - Bill ${app.invoiceNumber}`,
      });
      ivaLines.push({
        account_id: requireRole(ivaRoles, from),
        debit_amount: null,
        credit_amount: monto,
        description: `IVA released from ${from} on payment - Bill ${app.invoiceNumber}`,
      });
    }
  }

  const rolesPedidos = [
    'cxp',
    'anticipo_proveedores',
    ...(descuento.greaterThan(0) ? ['devolucion_compras'] : []),
    ...(condonado.greaterThan(0) && writeOffRole ? [writeOffRole] : []),
  ];
  const roles = await roleAccounts(client, payment.entity_id, rolesPedidos);
  const jeLines: JeLine[] = [
    {
      // El pasivo se extingue por TODO lo que el proveedor deja de tener
      // derecho a cobrar: el efectivo aplicado, el descuento pactado y el
      // remanente condonado. Los tres salen del 2110; lo que cambia es la
      // contrapartida de cada uno.
      account_id: requireRole(roles, 'cxp'),
      debit_amount: total.plus(descuento).plus(condonado).toFixed(4),
      credit_amount: null,
      description: `AP settlement ${payment.payment_number}`,
    },
  ];
  // La línea del anticipo va CONDICIONADA, igual que las cuatro de
  // `postVendorPaymentEntry`. Sin la guarda, un evento que no aplica nada y
  // condona todo —un saldo residual que era íntegramente IVA— emitía un abono
  // de 0.0000 contra 1150, y `journal_entry_lines` lo rechaza:
  // `CHECK (credit_amount IS NULL OR credit_amount > 0)` (001_core_schema.sql:289).
  // El asiento entero se caía en el INSERT, no aquí, así que el error salía
  // lejos de su causa. Cuadra igual: si `total` es cero no hay nada que abonar.
  if (total.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'anticipo_proveedores'),
      debit_amount: null,
      credit_amount: total.toFixed(4),
      description: `On-account advance applied ${payment.payment_number}`,
    });
  }
  // MNE-001-597: only the cost part of the discount; its VAT left 1135 above.
  const discountVatTaken = sumOf(discountVatByBill);
  if (descuento.greaterThan(discountVatTaken)) {
    jeLines.push({
      account_id: requireRole(roles, 'devolucion_compras'),
      debit_amount: null,
      credit_amount: descuento.minus(discountVatTaken).toFixed(4),
      description: `Early-payment discount taken ${payment.payment_number}`,
    });
  }
  if (condonado.greaterThan(0) && writeOffRole) {
    // Sólo la parte de COSTO del saldo condonado. Su parte de IVA ya salió
    // arriba, contra 1135; abonarla aquí también la contaría dos veces y
    // dejaría el asiento descuadrado por el importe del impuesto.
    const ivaYaSalido = [...ivaNoAcreditablePorGasto.values()].reduce(
      (s2, v) => s2.plus(v),
      new Decimal(0)
    );
    const costoCondonado = condonado.minus(ivaYaSalido);
    if (costoCondonado.greaterThan(0)) {
      jeLines.push({
        account_id: requireRole(roles, writeOffRole),
        debit_amount: null,
        credit_amount: costoCondonado.toFixed(4),
        description: `Short-pay write-off ${payment.payment_number}`,
      });
    }
  }
  jeLines.push(...ivaLines);

  const entry = await createJournalEntry(
    payment.entity_id,
    date,
    JournalEntryType.AUTO_PAYMENT,
    documentos.length
      ? `Application of ${payment.payment_number} · IVA creditable on payment: ${documentos.join(', ')}`
      : `Application of ${payment.payment_number}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'vendor_application', sourceId: payment.id, reference: payment.payment_number }
  );
  return { entry, ivaPorGasto, ivaNoAcreditablePorGasto, discountVatByBill };
}

/** The sum of a per-bill map of amounts. */
function sumOf(byBill: ReadonlyMap<string, string>): Decimal {
  return [...byBill.values()].reduce((s, v) => s.plus(v), new Decimal(0));
}

/** MNE-001-597 · CR 1135 for the VAT of a bill's early-payment discount. */
function discountVatLine(accountId: string, role: string, amount: string, billNumber: string): JeLine {
  return {
    account_id: accountId,
    debit_amount: null,
    credit_amount: amount,
    description: `IVA on the early-payment discount leaves ${role} without becoming creditable - Bill ${billNumber}`,
  };
}

/**
 * Desaplicar, como evento nuevo: DR cxc · CR anticipo_clientes (el crédito
 * vuelve a estar a cuenta — desaplicar NO es devolver dinero) y el IVA que
 * aquella aplicación liberó se RE-APARCA (DR iva_trasladado · CR
 * iva_trasladado_no_cobrado). El importe sale de la fila de la aplicación.
 *
 * MNE-001-517: a row that stored none is estimated pro-rata, and the lines
 * say so, only for a PPD invoice on cash-basis IVA books; the caller passes
 * zero for any other, and then no IVA line is written and no IVA role read.
 *
 * MNE-001-460: dated `app.date`, the day of the unapply, as
 * `postVendorUnapplicationEntry` is.
 *
 * MNE-001-422: the advance's IVA the rows cancelled (`advanceIva`) is
 * credited back to 2120, and only the rest of the cash to anticipo_clientes.
 *
 * MNE-001-461: when the rows carried an advance's IVA, nothing caused is
 * re-parked (the owner's «no re-park», #623): the share they released goes
 * back to 2125 (CR g) against the advance's IVA, and 2120 moves by c − g in
 * one line, none when they are equal.
 *
 * MNE-001-581: after a credit note, `ivaReclass`/`ivaEstimado` is only what
 * brings the invoice's 2125 to the IVA of the balance it is owed again, which
 * can be less than the rows released; `ivaKept` is the rest, which stays in
 * 2120 because the note already restituted it (LIVA art. 7). It moves no
 * amount: the first IVA line, or the AR line when there is none, names it.
 * MNE-001-592: the caller passes `advanceIva` net of the advance IVA the note
 * restituted, which is not caused again; `ivaKept.restituted` names it there.
 *
 * #699 · `ieps` is what this receipt has moved out of the uncollected IEPS
 * role for the invoice, read back from the ledger by the caller: it goes
 * back exactly (DR ieps_por_pagar · CR the uncollected role).
 *
 * MNE-001-590 · `iepsKept` is that same figure when it stays caused: it goes
 * back to the uncollected role (CR) with no 2180 line, and the cash back on
 * account carries it, so 2150 is credited only for the rest.
 *
 * MNE-001-604 · `iepsKept.back` is what the rows took from the cash on
 * account, net of the share released on it: it goes back to 2180 with the
 * cash, and 2150 is credited for neither.
 */
export async function postReceiptUnapplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  app: {
    invoiceNumber: string; amount: string; ivaReclass: string | null; ivaEstimado: string; date: string;
    /** MNE-001-113: what the customer withheld on the rows being closed. */
    withholdingIsr?: string; withholdingIva?: string;
    /** MNE-001-422: the advance's IVA the rows cancelled, which goes back to 2120 as they stored it. */
    advanceIva?: string;
    /** MNE-001-574: the IVA the rows' plain cash keeps caused, back on account with it. */
    keptIva?: string;
    ieps?: IepsMove;
    /** MNE-001-590: the IEPS this receipt moved for the invoice that stays caused, back on account with the cash. */
    iepsKept?: IepsMove;
    /**
     * MNE-001-581: the release that stays in 2120, the notes that restituted it and what the open balance carries.
     * MNE-001-592: `restituted`, the advance's IVA those notes restituted, already out of `advanceIva`.
     */
    ivaKept?: { amount: string; notes: string; carries: string; restituted?: string };
  },
  userId: string
): Promise<JournalEntry> {
  const roles = await roleAccounts(client, payment.entity_id, ['cxc', 'anticipo_clientes']);
  const isr = new Decimal(app.withholdingIsr ?? '0');
  const vat = new Decimal(app.withholdingIva ?? '0');
  const kept = new Decimal(app.keptIva ?? '0');
  const advanceIva = new Decimal(app.advanceIva ?? '0').plus(kept);
  const iepsKept = new Decimal(app.iepsKept?.amount ?? '0').plus(app.iepsKept?.back ?? '0');
  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxc'),
      debit_amount: new Decimal(app.amount).plus(isr).plus(vat).toFixed(4),
      credit_amount: null,
      description: `AR reopened ${app.invoiceNumber} (unapply ${payment.payment_number})`,
    },
    {
      account_id: requireRole(roles, 'anticipo_clientes'),
      debit_amount: null,
      credit_amount: new Decimal(app.amount).minus(advanceIva).minus(iepsKept).toFixed(4),
      description: `Back on account ${payment.payment_number}`,
    },
    ...(await withholdingLines(client, payment, isr, vat, 'credit')),
  ];

  const iva = new Decimal(app.ivaReclass ?? app.ivaEstimado);
  const estimado = app.ivaReclass === null && iva.greaterThan(0);
  const lineCountBeforeIva = jeLines.length;
  if (advanceIva.greaterThan(0)) {
    // MNE-001-461: the cash goes back on account as the advance it was, its
    // IVA caused when collected (LIVA art. 1-B), so nothing caused is
    // re-parked: the invoice's share goes back to 2125 because the invoice is
    // owed again, and 2120 moves only by c − g, none when they are equal
    // (the owner's «no re-park» of 17 Nov 2026, #623). MNE-001-574: a plain
    // receipt's cash keeps the share it caused the same way («Mantener
    // causado», 19 Nov 2026, #623), so only a pre-049 estimate leaves 2120.
    const { from, to } = reclassRoles('issued');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    const against = kept.greaterThan(0)
      ? `kept caused (LIVA art. 1-B), back on account ${payment.payment_number}`
      : `against advance ${payment.payment_number}'s`;
    const nota = estimado ? ' · pre-049: pro-rata estimate' : '';
    if (iva.greaterThan(0)) {
      jeLines.push({
        account_id: requireRole(ivaRoles, from),
        debit_amount: null,
        credit_amount: iva.toFixed(4),
        description: `IVA back in ${from} (unapply), ${against} - Invoice ${app.invoiceNumber}${nota}`,
      });
    }
    const net = advanceIva.minus(iva);
    if (!net.isZero()) {
      jeLines.push({
        account_id: requireRole(ivaRoles, to),
        debit_amount: net.isNegative() ? net.negated().toFixed(4) : null,
        credit_amount: net.isNegative() ? null : net.toFixed(4),
        description: (net.isNegative() && kept.greaterThan(0)
          ? `IVA re-parked out of ${to} (unapply) - Invoice ${app.invoiceNumber}`
          : `IVA of advance ${payment.payment_number} restored (unapply) - Invoice ${app.invoiceNumber}`) +
          (iva.greaterThan(0) ? `, net of ${iva.toFixed(4)} back in ${from}` : '') + nota,
      });
    }
  } else if (iva.greaterThan(0)) {
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
  if (app.ivaKept && new Decimal(app.ivaKept.amount).greaterThan(0)) {
    const at = jeLines.length > lineCountBeforeIva ? jeLines[lineCountBeforeIva] : jeLines[0];
    at.description += ` · kept in iva_trasladado: ${new Decimal(app.ivaKept.amount).toFixed(4)} restituted by credit note ` +
      `${app.ivaKept.notes} (LIVA art. 7); the reopened balance carries ${new Decimal(app.ivaKept.carries).toFixed(4)}`;
    const restituted = new Decimal(app.ivaKept.restituted ?? '0');
    if (restituted.greaterThan(0)) {
      at.description += `; advance IVA restituted by credit note ${app.ivaKept.notes} stays out (LIVA art. 7): ${restituted.toFixed(4)}`;
    }
  }
  if (app.ieps) {
    jeLines.push(...(await iepsMoveLines(client, payment.entity_id, payment.id, [app.ieps], 'repark', 'unapply')));
  }
  if (app.iepsKept) {
    jeLines.push(...(await iepsMoveLines(client, payment.entity_id, payment.id, [app.iepsKept], 'keep', 'unapply')));
  }

  return createJournalEntry(
    payment.entity_id,
    app.date,
    JournalEntryType.AUTO_PAYMENT,
    `Unapplication of ${payment.payment_number} from ${app.invoiceNumber}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'receipt_unapplication', sourceId: payment.id, reference: payment.payment_number }
  );
}

/** MNE-001-581 · The source of a reversal's IVA correction (`postReceiptReversalVatEntry`). */
export const RECEIPT_REVERSAL_IVA_SOURCE = 'receipt_reversal_iva';

/**
 * MNE-001-581 · A reversal mirrors every entry of the receipt (NIF B-1), so it
 * puts back into 2125 all the receipt released. After a credit note that took
 * its IVA from 2120, part of that release is no longer owed by any balance:
 * this entry takes it out again (DR iva_trasladado_no_cobrado · CR
 * iva_trasladado), dated with the mirrors, so 2125 ends at the IVA of the
 * balances the reversal reopened (LIVA arts. 1-B and 7).
 */
export async function postReceiptReversalVatEntry(
  client: pg.PoolClient,
  payment: { id: string; entity_id: string; payment_number: string },
  amount: string,
  notes: string,
  userId: string
): Promise<JournalEntry> {
  const { from, to } = reclassRoles('issued');
  const roles = await roleAccounts(client, payment.entity_id, [from, to]);
  const text = `IVA restituted by credit note ${notes} stays out of ${from}: the reversal of ${payment.payment_number} ` +
    're-parks only what the reopened balance carries (LIVA arts. 1-B, 7)';
  return createJournalEntry(
    payment.entity_id,
    new Date(),
    JournalEntryType.AUTO_PAYMENT,
    `Reversal of ${payment.payment_number} · IVA kept in ${to}`,
    [
      { account_id: requireRole(roles, from), debit_amount: amount, credit_amount: null, description: text },
      { account_id: requireRole(roles, to), debit_amount: null, credit_amount: amount, description: text },
    ],
    userId,
    { autoPost: true, client, sourceType: RECEIPT_REVERSAL_IVA_SOURCE, sourceId: payment.id, reference: payment.payment_number }
  );
}

/**
 * MNE-001-593 (#814, decision (A)) · After a credit note restituted IVA from
 * the cash a receipt kept on account (`postCreditNoteEntry`), the receipt's
 * mirrors leave that IVA credited in anticipo_clientes and debited in
 * iva_trasladado, which no balance carries: the cash is gone with the
 * reversal. One pair per note takes it out (DR anticipo_clientes · CR
 * iva_trasladado), with the source of the reversal's IVA correction and
 * dated with the mirrors, so the reversal ends as one before the note would.
 */
export async function postReceiptReversalRestitutionEntry(
  client: pg.PoolClient,
  payment: { id: string; entity_id: string; payment_number: string },
  restitutions: readonly { noteNumber: string; iva: string }[],
  userId: string
): Promise<JournalEntry> {
  const { to } = reclassRoles('issued');
  const roles = await roleAccounts(client, payment.entity_id, ['anticipo_clientes', to]);
  const lines = restitutions.flatMap((x): JeLine[] => {
    const text = `IVA restituted by credit note ${x.noteNumber} from the cash ${payment.payment_number} kept on account ` +
      'leaves with the reversal: no balance owes it back (LIVA art. 7, decision (A))';
    return [
      { account_id: requireRole(roles, 'anticipo_clientes'), debit_amount: x.iva, credit_amount: null, description: text },
      { account_id: requireRole(roles, to), debit_amount: null, credit_amount: x.iva, description: text },
    ];
  });
  return createJournalEntry(
    payment.entity_id,
    new Date(),
    JournalEntryType.AUTO_PAYMENT,
    `Reversal of ${payment.payment_number} · restitution from kept cash out of anticipo_clientes`,
    lines,
    userId,
    { autoPost: true, client, sourceType: RECEIPT_REVERSAL_IVA_SOURCE, sourceId: payment.id, reference: payment.payment_number }
  );
}

/** MNE-001-612 · The source of the pair a note's reversal posts after the cashing that netted it. */
export const HELD_RESTITUTION_REVERSAL_SOURCE = 'held_restitution_reversal';

/** MNE-001-612 · The tag on that pair's 2150 line: `{ payment_id, invoice_id, note_entry_id }`. */
export const HELD_RESTITUTION_UNDONE_TAG = 'held_restitution_undone';

/**
 * MNE-001-612 (#792, risk 1 of #905) · A credit note issued while a cheque
 * was held took its IVA from 2125 alone (`held_restitution`), and the
 * cashing caused the marker less it (MNE-001-607). Its mirror gives 2125
 * back, but not what the cashing did not cause. So once the note's entry is
 * reversed, each cheque the bank has since cashed gets its own correction,
 * DR anticipo_clientes / CR iva_trasladado for what the note tagged. The
 * entry is dated with the mirror, or with the cashing when the mirror is
 * dated before it, which is the day that cash was collected. Nothing posted
 * is rewritten (NIF B-1). With the note cancelled the cash is owed back to
 * no one: it is consideration held on account again (LIVA art. 1-B,
 * decision (A)). A reversal before the cashing, or of a receipt already
 * reversed, posts nothing: the cashing causes the whole marker, or its
 * mirror took out what it caused. Entity-scoped in the SQL.
 * CONTRACT: the ledger: `entry reverse` and `entry void` of such a note also
 * post this entry (`source_type` held_restitution_reversal).
 */
export async function followNoteReversal(
  client: pg.PoolClient,
  note: { id: string; entity_id: string; entry_number: string },
  mirror: { id: string },
  userId: string
): Promise<JournalEntry[]> {
  const held = await queryHeldNoteIvaByCashedReceipt(note.entity_id, { noteEntryId: note.id, mirrorEntryId: mirror.id }, client);
  const due = held.filter((x) => new Decimal(x.iva).greaterThan('0.00005'));
  if (due.length === 0) return [];
  const { to } = reclassRoles('issued');
  const roles = await roleAccounts(client, note.entity_id, ['anticipo_clientes', to]);
  const out: JournalEntry[] = [];
  for (const x of due) {
    const iva = new Decimal(x.iva).toFixed(4);
    const text = `IVA credit note ${note.entry_number} restituted from the cash held cheque ${x.payment_number} kept on account: ` +
      'the note is reversed after the cashing, so that cash is consideration again (LIVA arts. 1-B, 7, decision (A))';
    out.push(await createJournalEntry(
      note.entity_id,
      x.day,
      JournalEntryType.AUTO_PAYMENT,
      `Reversal of ${note.entry_number} after the cashing of ${x.payment_number} · IVA back to ${to}`,
      [
        {
          account_id: requireRole(roles, 'anticipo_clientes'), debit_amount: iva, credit_amount: null, description: text,
          tags: { [HELD_RESTITUTION_UNDONE_TAG]: { payment_id: x.payment_id, invoice_id: x.invoice_id, note_entry_id: note.id } },
        },
        { account_id: requireRole(roles, to), debit_amount: null, credit_amount: iva, description: text },
      ],
      userId,
      { autoPost: true, client, sourceType: HELD_RESTITUTION_REVERSAL_SOURCE, sourceId: x.payment_id, reference: note.entry_number }
    ));
  }
  return out;
}

/**
 * MNE-001-498 · A customer's credit assigned to another customer (CCF art.
 * 2029), as its own entry dated on the agreed day: DR anticipo_clientes for
 * A's credit, CR anticipo_clientes for B's. The same account on both sides:
 * the party lives in the two receipts the entry is tied to, since journal
 * lines have none. No bank, revenue or IVA line: nothing is collected,
 * returned or caused (LIVA art. 1o.-B causes B's IVA when the credit settles
 * B's invoice, part 2). Its own `source_type` keeps it out of
 * `uq_je_document_source` and of every reader keyed on `customer_payment`;
 * the entry is linked to B's row with a guarded UPDATE (invariant 3).
 */
export async function postCustomerCreditTransferEntry(
  client: pg.PoolClient,
  transfer: {
    id: string; entity_id: string; transfer_number: string; source_number: string;
    from_customer: string; to_customer: string; amount: string; date: string;
  },
  userId: string
): Promise<JournalEntry> {
  const roles = await roleAccounts(client, transfer.entity_id, ['anticipo_clientes']);
  const advances = requireRole(roles, 'anticipo_clientes');
  const amount = new Decimal(transfer.amount).toFixed(4);
  const entry = await createJournalEntry(
    transfer.entity_id,
    transfer.date,
    JournalEntryType.AUTO_PAYMENT,
    `Customer credit transfer ${transfer.transfer_number}: ${transfer.source_number} of ${transfer.from_customer} to ${transfer.to_customer}`,
    [
      {
        account_id: advances, debit_amount: amount, credit_amount: null,
        description: `${transfer.from_customer}'s credit on ${transfer.source_number} assigned to ${transfer.to_customer} (${transfer.transfer_number})`,
      },
      {
        account_id: advances, debit_amount: null, credit_amount: amount,
        description: `${transfer.to_customer}'s credit from ${transfer.from_customer} on ${transfer.source_number} (${transfer.transfer_number})`,
      },
    ],
    userId,
    { autoPost: true, client, sourceType: 'customer_credit_transfer', sourceId: transfer.id, reference: transfer.transfer_number }
  );
  const linked = await client.query(
    `UPDATE customer_payments SET journal_entry_id = $1
      WHERE id = $2 AND entity_id = $3 AND journal_entry_id IS NULL AND payment_method = 'balance_transfer'`,
    [entry.id, transfer.id, transfer.entity_id]
  );
  if (linked.rowCount !== 1) {
    throw new AccountingError(
      'PAYMENT_ALREADY_POSTED',
      { key: 'error.PAYMENT_ALREADY_POSTED.transfer', params: { transfer: transfer.transfer_number } }
    );
  }
  return entry;
}

/**
 * Unapply a vendor payment from a bill, as a new event dated `app.date`:
 * DR anticipo_proveedores (the cash is back on account; unapplying is not a
 * refund) and DR devolucion_compras for the discount the application took,
 * against CR cxp for both, since the bill is owed again. The IVA the
 * application released goes back to pending: DR iva_pendiente_acreditar ·
 * CR iva_acreditable, for the amount its rows stored.
 *
 * MNE-001-597: the VAT of the discount that left 1135 (`discountIva`, stored
 * on the rows) goes back to it, DR iva_pendiente_acreditar, and 5200 takes
 * back only the cost part. A row written before 341 stored none: its VAT never
 * left, and nothing is given back for it.
 */
export async function postVendorUnapplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  app: { billNumber: string; amount: string; discount: string; discountIva?: string; iva: string; date: string },
  userId: string
): Promise<JournalEntry> {
  const discountIva = new Decimal(app.discountIva ?? '0');
  const discount = new Decimal(app.discount).minus(discountIva);
  const iva = new Decimal(app.iva);
  const { from, to } = reclassRoles('received');
  const roles = await roleAccounts(client, payment.entity_id, [
    'cxp', 'anticipo_proveedores',
    ...(discount.greaterThan(0) ? ['devolucion_compras'] : []),
    ...(iva.greaterThan(0) ? [from, to] : discountIva.greaterThan(0) ? [from] : []),
  ]);
  const tail = `${app.billNumber} (unapply ${payment.payment_number})`;
  const lines: JeLine[] = [
    { account_id: requireRole(roles, 'anticipo_proveedores'), debit_amount: app.amount, credit_amount: null,
      description: `Back on account ${payment.payment_number}` },
    { account_id: requireRole(roles, 'cxp'), debit_amount: null,
      credit_amount: new Decimal(app.amount).plus(app.discount).toFixed(4), description: `AP reopened ${tail}` },
  ];
  if (discount.greaterThan(0)) {
    lines.push({ account_id: requireRole(roles, 'devolucion_compras'), debit_amount: discount.toFixed(4),
      credit_amount: null, description: `Early-payment discount given back ${tail}` });
  }
  if (discountIva.greaterThan(0)) {
    lines.push({ account_id: requireRole(roles, from), debit_amount: discountIva.toFixed(4), credit_amount: null,
      description: `IVA on the early-payment discount back in ${from} - Bill ${tail}` });
  }
  if (iva.greaterThan(0)) {
    lines.push({ account_id: requireRole(roles, from), debit_amount: iva.toFixed(4), credit_amount: null,
      description: `IVA back in ${from} - Bill ${tail}` });
    lines.push({ account_id: requireRole(roles, to), debit_amount: null, credit_amount: iva.toFixed(4),
      description: `IVA re-parked out of ${to} - Bill ${tail}` });
  }
  return createJournalEntry(
    payment.entity_id,
    app.date,
    JournalEntryType.AUTO_PAYMENT,
    `Unapplication of ${payment.payment_number} from ${app.billNumber}`,
    lines,
    userId,
    { autoPost: true, client, sourceType: 'vendor_unapplication', sourceId: payment.id, reference: payment.payment_number }
  );
}

/**
 * MNE-001-597 · The VAT of the early-payment discount each live application of
 * a vendor payment takes, per bill, and stores it on the row (0 included) so
 * that an unapply gives back exactly that. Off cash-basis books nothing is
 * parked and every row stores 0. In another currency the share is at the
 * bill's rate, as 1135 holds it. Only rows that have not stored it yet are
 * read: those born with this payment.
 */
async function discountVatOfPayment(
  client: pg.PoolClient,
  payment: PaymentRow,
  foreign: boolean
): Promise<{ billNumber: string; amount: string }[]> {
  const { rows } = await client.query<{
    id: string; bill_id: string; bill_number: string; taken: string;
    tax_amount: string; total_amount: string; amount_due: string; exchange_rate: string | null;
  }>(
    `SELECT pa.id, pa.bill_id, b.bill_number, COALESCE(pa.discount_amount, 0)::text AS taken,
            b.tax_amount::text AS tax_amount, b.total_amount::text AS total_amount,
            b.amount_due::text AS amount_due, b.exchange_rate::text AS exchange_rate
       FROM payment_applications pa
       JOIN bills b ON b.id = pa.bill_id AND b.entity_id = $2
      WHERE pa.payment_id = $1 AND pa.unapplied_at IS NULL AND pa.discount_iva_amount IS NULL
      ORDER BY b.bill_number, pa.id`,
    [payment.id, payment.entity_id]
  );
  if (rows.length === 0) return [];
  const cashBasis = rows.some((r) => new Decimal(r.taken).greaterThan(0))
    && (await entityUsesCashBasisIva(client, payment.entity_id));
  const out: { billNumber: string; amount: string }[] = [];
  for (const r of rows) {
    let amount = new Decimal(0).toFixed(4);
    if (cashBasis && new Decimal(r.taken).greaterThan(0)) {
      amount = discountVatShare({
        discount: r.taken, taxAmount: r.tax_amount, totalAmount: r.total_amount,
        remainder: await receivedVatStillParked(client, payment.entity_id, r.bill_id),
        closes: new Decimal(r.amount_due).lessThanOrEqualTo(0),
        ...(foreign && r.exchange_rate ? { rate: r.exchange_rate } : {}),
      });
    }
    await client.query(`UPDATE payment_applications SET discount_iva_amount = $1 WHERE id = $2`, [amount, r.id]);
    if (new Decimal(amount).greaterThan(0)) out.push({ billNumber: r.bill_number, amount });
  }
  return out;
}

/**
 * DR cxp · CR bank, plus — for every bill this payment applies to that parked IVA —
 * DR iva_acreditable · CR iva_pendiente_acreditar for the paid share. Under
 * LIVA art. 5 the input IVA becomes creditable here, not when the bill
 * arrived.
 *
 * R4 · Con `fx` (el pago está en otra moneda que la funcional): cada pasivo
 * se extingue al tipo al que NACIÓ y el efectivo sale al tipo de HOY; la
 * brecha es la diferencia cambiaria REALIZADA y va a perdida_cambiaria /
 * utilidad_cambiaria — la mitad realizada de NIF B-15. La NO realizada
 * (revaluar saldos vivos al cierre) es fase 2 y no pasa por aquí.
 */
export async function postVendorPaymentEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  userId: string,
  fx?: ContextoCambiario
): Promise<PaymentPosting | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bank = await bankAccountOf(client, payment.entity_id, payment.bank_account_id);
  const bankId = bank.glAccountId;
  const iva = payment.holdsIvaUntilCashed
    ? { lines: [], documents: [], items: [] }
    : await ivaReclassLines(client, 'received', payment, fx ? ivaFxOf(fx) : undefined);
  // The IVA each application born with this payment released, 0 included,
  // stored on its row (105) so `payment unapply` re-parks it exactly instead
  // of re-deriving it under another context.
  const released = new Map(iva.items.map((i) => [i.documentId, i.amount]));
  const born = await client.query<{ id: string; bill_id: string }>(
    `SELECT id, bill_id FROM payment_applications
      WHERE payment_id = $1 AND unapplied_at IS NULL AND iva_reclass_amount IS NULL`,
    [payment.id]
  );
  for (const row of born.rows) {
    await client.query(
      `UPDATE payment_applications SET iva_reclass_amount = $1 WHERE id = $2`,
      [released.get(row.bill_id) ?? '0', row.id]
    );
  }
  // MNE-001-597: read after the rows above store their release, so what each
  // bill still has parked already nets this payment's.
  const discountVat = await discountVatOfPayment(client, payment, fx !== undefined);
  const pendingRole = reclassRoles('received').from;

  if (fx) {
    assertBankCurrency(bank, fx.moneda, payment.payment_number);
    const desglose = desgloseCambiarioDelPago(payment.payment_amount, fx);
    const hayAnticipo = new Decimal(desglose.anticipoFuncional).greaterThan(0);
    const rolesPedidos = [
      'cxp',
      ...(desglose.descuentos.length > 0 ? ['devolucion_compras'] : []),
      ...(hayAnticipo ? ['anticipo_proveedores'] : []),
      ...(discountVat.length > 0 ? [pendingRole] : []),
    ];
    const roles = await roleAccounts(client, payment.entity_id, rolesPedidos);

    const jeLines: JeLine[] = [];
    // El pasivo, POR DOCUMENTO y no agregado: cada gasto nació con su tasa
    // y se extingue con ella; agregarlos borraría el origen que la línea
    // FX existe para conservar.
    for (const pas of desglose.pasivos) {
      jeLines.push({
        account_id: requireRole(roles, 'cxp'),
        debit_amount: pas.montoFuncional,
        credit_amount: null,
        description: `AP settlement ${payment.payment_number} - Bill ${pas.numero}`,
        currency_code: fx.moneda,
        foreign_debit: pas.extranjero,
        exchange_rate: pas.tasa,
      });
      // MNE-001-862: the cent the telescoped settlement takes besides the
      // truthful line above, so a bill paid in parts leaves nothing on cxp.
      const rounding = new Decimal(pas.rounding ?? '0');
      if (!rounding.isZero()) {
        jeLines.push({
          account_id: requireRole(roles, 'cxp'),
          debit_amount: rounding.isNegative() ? null : rounding.toFixed(4),
          credit_amount: rounding.isNegative() ? rounding.abs().toFixed(4) : null,
          description: `AP rounding at ${pas.tasa} ${payment.payment_number} - Bill ${pas.numero}`,
        });
      }
    }
    if (hayAnticipo) {
      // El anticipo es efectivo que salió HOY: va a la tasa del pago.
      jeLines.push({
        account_id: requireRole(roles, 'anticipo_proveedores'),
        debit_amount: desglose.anticipoFuncional,
        credit_amount: null,
        description: `On-account advance ${payment.payment_number}`,
        currency_code: fx.moneda,
        foreign_debit: desglose.anticipoExtranjero,
        exchange_rate: fx.tasaPago,
      });
    }
    jeLines.push({
      account_id: bankId,
      debit_amount: null,
      credit_amount: desglose.bancoFuncional,
      description: `Payment made ${payment.payment_number}`,
      currency_code: fx.moneda,
      foreign_credit: new Decimal(payment.payment_amount).toFixed(4),
      exchange_rate: fx.tasaPago,
    });
    for (const desc of desglose.descuentos) {
      jeLines.push({
        account_id: requireRole(roles, 'devolucion_compras'),
        debit_amount: null,
        credit_amount: desc.montoFuncional,
        description: `Early-payment discount taken ${payment.payment_number} - Bill ${desc.numero}`,
        currency_code: fx.moneda,
        foreign_credit: desc.extranjero,
        exchange_rate: desc.tasa,
      });
    }
    // MNE-001-597 · the discount's VAT, as a balanced pair in the functional
    // currency by declaration: the discount line above keeps its FX columns
    // whole, and the pair takes the VAT part off it and out of 1135, at the
    // bill's rate, as 1135 holds it. Balanced, it moves no realised difference.
    const discountAccount = discountVat.length > 0 ? requireRole(roles, 'devolucion_compras') : '';
    for (const d of discountVat) {
      jeLines.push({
        account_id: discountAccount,
        debit_amount: d.amount,
        credit_amount: null,
        description: `VAT part of the early-payment discount ${payment.payment_number} - Bill ${d.billNumber}`,
      });
      jeLines.push(discountVatLine(requireRole(roles, pendingRole), pendingRole, d.amount, d.billNumber));
    }
    // The realised difference is whatever separates the lines above and the
    // IVA pair (1135 leaves at the bill's rate, 1130 enters at today's: the
    // creditable amount is the one actually paid, LIVA art. 5-III, converted
    // at the payment day's rate, art. 20 CFF). The two FX roles are asked
    // for only when a difference exists.
    jeLines.push(...iva.lines);
    const { line: difLine, difference: dif } = await realisedDifferenceLine(
      client,
      payment.entity_id,
      jeLines,
      payment.payment_number,
      fx
    );
    if (difLine) jeLines.push(difLine);

    const descuentoTotal = desglose.descuentos.reduce(
      (s2, d) => s2.plus(d.montoFuncional),
      new Decimal(0)
    );
    const entry = await createJournalEntry(
      payment.entity_id,
      payment.payment_date,
      JournalEntryType.AUTO_PAYMENT,
      (iva.documents.length
        ? `Vendor payment ${payment.payment_number} · IVA creditable on payment: ${iva.documents.join(', ')}`
        : `Vendor payment ${payment.payment_number}`) +
        (descuentoTotal.greaterThan(0) ? ` · early-payment discount ${descuentoTotal.toFixed(2)}` : '') +
        (dif.tipo !== 'ninguna'
          ? ` · realized FX ${dif.tipo === 'perdida' ? 'loss' : 'gain'} ${dif.montoFuncional} ${fx.monedaFuncional}`
          : ''),
      jeLines,
      userId,
      { autoPost: true, client, sourceType: 'vendor_payment', sourceId: payment.id, reference: payment.payment_number }
    );

    await client.query('UPDATE vendor_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
    return { ...entry, realisedFx: dif };
  }

  // F04 · EL DESGLOSE DEL PAGO, en tres partes que no siempre coinciden.
  //
  // Lo APLICADO baja el pasivo (DR cxp). Lo que sale del banco es el efectivo
  // REAL, que puede ser menor si hubo descuento por pronto pago. Y lo pagado
  // de más queda como ANTICIPO al proveedor (1150, un activo: el proveedor
  // nos debe mercancía o servicio), nunca colgado de la cuenta de control.
  //
  // El descuento se abona a `devolucion_compras` (5200, contra-costo), que es
  // el espejo exacto de lo que la nota de crédito hace del lado cliente con
  // 4400. Antes se rechazaba en voz alta «necesita una cuenta de ingreso por
  // descuentos en la capa de roles»: la cuenta existía desde la siembra, y
  // nadie la había atado.
  const aplic = await client.query<{ aplicado: string; descuento: string }>(
    `SELECT COALESCE(SUM(amount_applied), 0)::text  AS aplicado,
            COALESCE(SUM(discount_amount), 0)::text AS descuento
       FROM payment_applications WHERE payment_id = $1 AND unapplied_at IS NULL`,
    [payment.id]
  );
  const aplicado = new Decimal(aplic.rows[0]?.aplicado ?? '0');
  const descuento = new Decimal(aplic.rows[0]?.descuento ?? '0');
  const efectivo = new Decimal(payment.payment_amount);
  // El pasivo que se extingue es lo aplicado MÁS el descuento: el proveedor
  // deja de tener derecho a las dos cosas.
  const pasivo = aplicado.plus(descuento);
  const anticipo = efectivo.minus(aplicado);

  const discountVatTotal = discountVat.reduce((s, d) => s.plus(d.amount), new Decimal(0));
  const rolesPedidos = [
    'cxp',
    ...(descuento.greaterThan(discountVatTotal) ? ['devolucion_compras'] : []),
    ...(anticipo.greaterThan(0) ? ['anticipo_proveedores'] : []),
    ...(discountVat.length > 0 ? [pendingRole] : []),
  ];
  const roles = await roleAccounts(client, payment.entity_id, rolesPedidos);

  const jeLines: JeLine[] = [];
  if (pasivo.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'cxp'),
      debit_amount: pasivo.toFixed(4),
      credit_amount: null,
      description: `AP settlement ${payment.payment_number}`,
    });
  }
  if (anticipo.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'anticipo_proveedores'),
      debit_amount: anticipo.toFixed(4),
      credit_amount: null,
      description: `On-account advance ${payment.payment_number}`,
    });
  }
  jeLines.push({
    account_id: bankId,
    debit_amount: null,
    credit_amount: efectivo.toFixed(4),
    description: `Payment made ${payment.payment_number}`,
  });
  // MNE-001-597: only the cost part of the discount; its VAT leaves 1135 below.
  if (descuento.greaterThan(discountVatTotal)) {
    jeLines.push({
      account_id: requireRole(roles, 'devolucion_compras'),
      debit_amount: null,
      credit_amount: descuento.minus(discountVatTotal).toFixed(4),
      description: `Early-payment discount taken ${payment.payment_number}`,
    });
  }
  for (const d of discountVat) {
    jeLines.push(discountVatLine(requireRole(roles, pendingRole), pendingRole, d.amount, d.billNumber));
  }
  jeLines.push(...iva.lines);

  const entry = await createJournalEntry(
    payment.entity_id,
    payment.payment_date,
    JournalEntryType.AUTO_PAYMENT,
    (iva.documents.length
      ? `Vendor payment ${payment.payment_number} · IVA creditable on payment: ${iva.documents.join(', ')}`
      : `Vendor payment ${payment.payment_number}`) +
      (descuento.greaterThan(0) ? ` · early-payment discount ${descuento.toFixed(2)}` : ''),
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'vendor_payment', sourceId: payment.id, reference: payment.payment_number }
  );

  await client.query('UPDATE vendor_payments SET journal_entry_id = $1 WHERE id = $2', [entry.id, payment.id]);
  return entry;
}
