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
import {
  convertirAFuncional,
  desgloseCambiarioDelPago,
  monedaFuncionalDe,
  type ContextoCambiario,
} from './moneda-origen.js';

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

  // ── R4 · la guarda espejo del lado AR ─────────────────────────────────
  //
  // El cableado FX de cobros es fase 2, pero la REGLA de R4 no espera:
  // ninguna línea pierde su origen en silencio. Antes, una factura de
  // USD 1000 se posteaba como MXN 1000 sin guarda ni columnas — el pecado
  // original vivo en el lado que factura. Hasta que el cobro convierta como
  // ya convierte el gasto, la factura en moneda extranjera SE NIEGA a
  // postearse: un ingreso subvaluado 18× con veredicto limpio es peor que
  // un posteo detenido que dice por qué.
  const funcionalAr = await monedaFuncionalDe(client, invoice.entity_id);
  if (invoice.currency_code && invoice.currency_code !== funcionalAr) {
    throw new AccountingError(
      'FX_AR_NOT_WIRED',
      `${invoice.invoice_number} está en ${invoice.currency_code} y los libros en ${funcionalAr}. ` +
        `El posteo de ingresos aún no convierte moneda extranjera (es fase 2 de R4): postearla hoy ` +
        `asentaría ${invoice.currency_code} como si fueran ${funcionalAr}, sin rastro del importe ` +
        `original. El gasto ya convierte; el ingreso se detiene hasta tener el mismo motor.`
    );
  }

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

  // ── R4 · B-15: EL GASTO EN MONEDA EXTRANJERA SE CONVIERTE AL NACER ────
  //
  // El mayor se lleva en la moneda funcional; lo que el documento dice en
  // la suya viaja en las cuatro columnas FX de cada línea. La tasa es la
  // DEL DOCUMENTO: el pasivo vale lo que valía el día que nació, y lo que
  // pase después es diferencia cambiaria del pago (realizada, abajo) o del
  // cierre (fase 2), nunca un re-valor retroactivo de este asiento.
  const funcional = await monedaFuncionalDe(client, bill.entity_id);
  const enExtranjera = Boolean(bill.currency_code) && bill.currency_code !== funcional;
  if (enExtranjera) {
    const tasa = new Decimal(bill.exchange_rate || '0');
    // El 1.0 exacto es el DEFAULT de la columna, no una tasa capturada:
    // convertir con él asentaría dólares como si fueran pesos — la pérdida
    // de origen de siempre, ahora con columnas FX jurando lo contrario.
    if (!tasa.greaterThan(0) || tasa.equals(1)) {
      throw new AccountingError(
        'FX_RATE_MISSING',
        `${bill.bill_number} está en ${bill.currency_code} y los libros en ${funcional}, ` +
          `pero su exchange_rate es ${bill.exchange_rate ?? 'nulo'} (el default de captura). ` +
          `Registra el tipo de cambio del documento antes de aprobarlo: sin él el pasivo se ` +
          `asentaría sin convertir y perdería su origen (NIF B-15).`
      );
    }
  }
  const conv = (importe: string): string =>
    enExtranjera ? convertirAFuncional(importe, bill.exchange_rate) : importe;
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

  // El abono a cxp: en funcional es el total del documento, como siempre.
  // En extranjera es la SUMA de los cargos YA convertidos, no total × tasa:
  // cada cargo se redondeó a 4 decimales por separado y el asiento cuadra
  // contra lo que de verdad se asentó, no contra la multiplicación teórica.
  const abonoCxp = enExtranjera
    ? cargos.reduce((s, l) => s.plus(l.debit_amount ?? '0'), new Decimal(0)).toFixed(4)
    : bill.total_amount;
  // Las columnas FX del abono, sólo cuando dicen la verdad: si la suma de
  // los cargos redondeados coincide con total × tasa (el caso normal), el
  // pasivo lleva su origen completo. Cuando difieren por el redondeo por
  // línea —construible: dos líneas cuyos productos redondean hacia arriba—
  // NINGÚN par (importe, tasa) honesto reproduce la suma, y declarar
  // total × tasa hacía que verificarOrigenFx tumbara el asiento ENTERO:
  // el gasto legítimo no se podía postear. El origen del documento queda en
  // bills (currency_code, exchange_rate), que es de donde lee el pago.
  const fxAbonoCxp =
    enExtranjera &&
    new Decimal(abonoCxp).equals(convertirAFuncional(bill.total_amount, bill.exchange_rate))
      ? {
          currency_code: bill.currency_code,
          foreign_credit: bill.total_amount,
          exchange_rate: bill.exchange_rate,
        }
      : {};
  const jeLines: JeLine[] = [
    {
      account_id: requireRole(roles, 'cxp'),
      debit_amount: null,
      credit_amount: abonoCxp,
      description: `Bill ${bill.bill_number}`,
      ...fxAbonoCxp,
    },
    ...cargos,
  ];

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
  payment: PaymentRow,
  /**
   * R4 · sólo lado proveedor por ahora: la tasa HISTÓRICA de cada gasto en
   * moneda extranjera, para que el IVA aparcado se libere valuado igual que
   * se aparcó (a la tasa del documento). Sin esto, el pro-rata en moneda del
   * documento se compararía crudo contra un saldo aparcado en funcional.
   */
  fx?: { moneda: string; tasasPorDocumento: Map<string, string> }
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
    // La pareja es autocuadrante también en extranjera: mismo importe
    // funcional en las dos líneas, y las columnas FX dicen de qué importe
    // original y a qué tasa salió.
    const conFx = fx && item.tasa && item.importeOriginal
      ? { currency_code: fx.moneda, exchange_rate: item.tasa }
      : null;
    lines.push({
      account_id: debited.id,
      debit_amount: item.amount,
      credit_amount: null,
      description: note(debited),
      ...(conFx && item.importeOriginal ? { ...conFx, foreign_debit: item.importeOriginal } : {}),
    });
    lines.push({
      account_id: credited.id,
      debit_amount: null,
      credit_amount: item.amount,
      description: note(credited),
      ...(conFx && item.importeOriginal ? { ...conFx, foreign_credit: item.importeOriginal } : {}),
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
  /** F04 · sólo lado proveedor: el descuento por pronto pago de esta aplicación. */
  discount?: string;
  /**
   * F04 · sólo lado proveedor: el saldo que DEJA DE DEBERSE al cerrar el gasto
   * pagando de menos (`payment apply --mode residual`). No es un descuento
   * pactado de antemano sino un remanente que se renuncia a pagar, y por eso
   * va a la cuenta que dicte la política `pago_corto_residual` y no siempre a
   * la misma que el descuento.
   */
  writeOff?: string;
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
 * Aplicar el anticipo a proveedor a facturas, como evento posterior al pago
 * (F04): DR cxp · CR anticipo_proveedores por lo aplicado, más la
 * acreditación del IVA de cada gasto PPD por la parte que ESTE evento paga.
 * El efectivo no se mueve — ya salió con el pago; lo que se mueve es el
 * derecho, del activo por anticipos al pasivo que extingue.
 *
 * Espejo del lado cliente, con los roles invertidos y una diferencia real:
 * aquí el descuento por pronto pago SÍ puede aparecer, porque una aplicación
 * tardía dentro de la ventana sigue dando derecho a él.
 */
export async function postVendorApplicationEntry(
  client: pg.PoolClient,
  payment: PaymentRow,
  aplicaciones: AplicacionPosterior[],
  userId: string,
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
}> {
  const total = aplicaciones.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  const descuento = aplicaciones.reduce((s, a) => s.plus(a.discount ?? '0'), new Decimal(0));
  const condonado = aplicaciones.reduce((s, a) => s.plus(a.writeOff ?? '0'), new Decimal(0));
  if (condonado.greaterThan(0) && !writeOffRole) {
    throw new AccountingError(
      'WRITE_OFF_ACCOUNT_UNRESOLVED',
      'Hay un pago corto que condona saldo y nadie dijo a qué cuenta va. La decide la ' +
        'política `pago_corto_residual`; postear sin ella dejaría el asiento descuadrado.'
    );
  }
  const cashBasis = await entityUsesCashBasisIva(client, payment.entity_id);
  const ivaPorGasto = new Map<string, string>();
  /** IVA que salió de 1135 SIN acreditarse, por haberse condonado su gasto. */
  const ivaNoAcreditablePorGasto = new Map<string, string>();
  const ivaLines: JeLine[] = [];
  const documentos: string[] = [];

  if (cashBasis) {
    const { from, to } = reclassRoles('received');
    const ivaRoles = await roleAccounts(client, payment.entity_id, [from, to]);
    for (const app of aplicaciones) {
      const metodo = await resolveBillMetodoPago(client, {
        id: app.invoiceId,
        entity_id: payment.entity_id,
        bill_number: app.invoiceNumber,
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
      const parked = await ivaStillParked(client, 'received', payment.entity_id, app.invoiceId);
      const liberable = Decimal.min(new Decimal(bruto), new Decimal(parked));

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
        description: `IVA now in ${to} (PPD payment) - Bill ${app.invoiceNumber}`,
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
  if (descuento.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'devolucion_compras'),
      debit_amount: null,
      credit_amount: descuento.toFixed(4),
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
    new Date(),
    JournalEntryType.AUTO_PAYMENT,
    documentos.length
      ? `Application of ${payment.payment_number} · IVA creditable on payment: ${documentos.join(', ')}`
      : `Application of ${payment.payment_number}`,
    jeLines,
    userId,
    { autoPost: true, client, sourceType: 'vendor_application', sourceId: payment.id, reference: payment.payment_number }
  );
  return { entry, ivaPorGasto, ivaNoAcreditablePorGasto };
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
): Promise<JournalEntry | null> {
  if (payment.journal_entry_id) return null;
  if (!new Decimal(payment.payment_amount).greaterThan(0)) return null;

  const bankId = await bankGlAccount(client, payment.entity_id, payment.bank_account_id);
  const iva = await ivaReclassLines(
    client,
    'received',
    payment,
    fx
      ? {
          moneda: fx.moneda,
          tasasPorDocumento: new Map(fx.aplicaciones.map((a) => [a.billId, a.tasaHistorica])),
        }
      : undefined
  );

  if (fx) {
    const desglose = desgloseCambiarioDelPago(payment.payment_amount, fx);
    const dif = desglose.diferencia;
    const hayAnticipo = new Decimal(desglose.anticipoFuncional).greaterThan(0);
    const rolesPedidos = [
      'cxp',
      ...(desglose.descuentos.length > 0 ? ['devolucion_compras'] : []),
      ...(hayAnticipo ? ['anticipo_proveedores'] : []),
      // Los dos roles que llevaban años sembrados sin un solo consumidor:
      // éste es su primer escritor. Sólo se piden si la diferencia existe.
      ...(dif.tipo === 'perdida' ? ['perdida_cambiaria'] : []),
      ...(dif.tipo === 'utilidad' ? ['utilidad_cambiaria'] : []),
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
    // La diferencia realizada NO lleva columnas FX: es un resultado que
    // sólo existe en funcional — su neto en la moneda del documento es
    // cero, porque se pagaron exactamente los mismos dólares que se debían.
    if (dif.tipo === 'perdida') {
      jeLines.push({
        account_id: requireRole(roles, 'perdida_cambiaria'),
        debit_amount: dif.montoFuncional,
        credit_amount: null,
        description: `Realized FX loss ${payment.payment_number} (${fx.moneda} @ ${fx.tasaPago})`,
      });
    } else if (dif.tipo === 'utilidad') {
      jeLines.push({
        account_id: requireRole(roles, 'utilidad_cambiaria'),
        debit_amount: null,
        credit_amount: dif.montoFuncional,
        description: `Realized FX gain ${payment.payment_number} (${fx.moneda} @ ${fx.tasaPago})`,
      });
    }
    jeLines.push(...iva.lines);

    const descuentoTotal = desglose.descuentos.reduce(
      (s2, d) => s2.plus(d.montoFuncional),
      new Decimal(0)
    );
    const entry = await createJournalEntry(
      payment.entity_id,
      new Date(payment.payment_date),
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
    return entry;
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
       FROM payment_applications WHERE payment_id = $1`,
    [payment.id]
  );
  const aplicado = new Decimal(aplic.rows[0]?.aplicado ?? '0');
  const descuento = new Decimal(aplic.rows[0]?.descuento ?? '0');
  const efectivo = new Decimal(payment.payment_amount);
  // El pasivo que se extingue es lo aplicado MÁS el descuento: el proveedor
  // deja de tener derecho a las dos cosas.
  const pasivo = aplicado.plus(descuento);
  const anticipo = efectivo.minus(aplicado);

  const rolesPedidos = [
    'cxp',
    ...(descuento.greaterThan(0) ? ['devolucion_compras'] : []),
    ...(anticipo.greaterThan(0) ? ['anticipo_proveedores'] : []),
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
  if (descuento.greaterThan(0)) {
    jeLines.push({
      account_id: requireRole(roles, 'devolucion_compras'),
      debit_amount: null,
      credit_amount: descuento.toFixed(4),
      description: `Early-payment discount taken ${payment.payment_number}`,
    });
  }
  jeLines.push(...iva.lines);

  const entry = await createJournalEntry(
    payment.entity_id,
    new Date(payment.payment_date),
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
