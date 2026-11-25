import Decimal from 'decimal.js';
import type pg from 'pg';
import { AccountingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { matchCase, type AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';
import type { CfdiFacts } from '../xml-ingestion/cfdi-facts.js';
import { keepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../xml-ingestion/received-credit-note.js';

// ============================================================
// IVA ON CASH BASIS (LIVA art. 1-B and art. 5 frac. III)
//
// Mexico causes and credits IVA when the money MOVES, not when the
// invoice is issued. On the issued side the CFDI MetodoPago decides:
//
//   PUE (pago en una sola exhibición) — collected at issuance: the IVA
//        is due right away (the conservative side, decided on #668).
//   PPD (pago en parcialidades o diferido) — at issuance the IVA is NOT
//        yet due. It parks in 2125 "IVA Trasladado No Cobrado" and MOVES
//        to 2120 when the collection (the complemento de pago) lands.
//
// A RECEIVED document parks its IVA in 1135 "IVA Pendiente de Acreditar"
// whatever its MetodoPago, and the vendor payment moves it to 1130
// (MNE-001-492, #693): it is creditable once paid (LIVA art. 5-III), and
// PUE is the issuer's label, not proof of payment (RMF rule 2.7.1.39).
//
// WHICH ROLE the IVA lands in is NOT decided here: it is read off
// cfdi-taxonomy.ts, which already models the four cases and is the
// single source of truth for CFDI accounting treatment. This module
// only asks it the question and does the cash-basis arithmetic.
// ============================================================

export type MetodoPago = 'PUE' | 'PPD';

/** Which side of the ledger the document sits on. */
export type DocumentSide = 'issued' | 'received';

/** Where the MetodoPago came from, most authoritative first. */
export type MetodoPagoOrigin =
  /** A MetodoPago carried by the document row itself. */
  | 'document'
  /** The stamped CFDI behind the document (xml_documents.metodo_pago). */
  | 'cfdi'
  /** An explicit PUE/PPD token written into the free-text terms or memo. */
  | 'terms'
  /** Nothing on the document said: the conservative rule decided. */
  | 'default';

export interface MetodoPagoDecision {
  metodo: MetodoPago;
  origin: MetodoPagoOrigin;
  /** True when no fact decided and the conservative default was applied. */
  assumed: boolean;
}

/**
 * What to do when the document carries NO MetodoPago. Never a guess at the
 * commercial reality — the treatment that cannot understate the tax:
 *
 * - issued   → PUE: the output IVA is recognized NOW. Recognizing it late
 *              would defer the remittance, which is the expensive mistake.
 *              The basis (decided on #668): IVA is caused when the
 *              consideration is collected (LIVA arts. 1o.-B and 11), and
 *              MetodoPago is where the CFDI states that fact (CFF art. 29-A
 *              fr. VII). A stamped CFDI 4.0 of type I always carries it
 *              (Anexo 20, I.F), so its absence is a defect of the XML, not a
 *              statement of deferred payment. With nothing stated, PUE never
 *              recognizes the IVA later than PPD would, and late IVA bears
 *              updating and surcharges (CFF art. 21).
 * - received → PPD: the input IVA waits in 1135, as every received
 *              document's does since MNE-001-492, so the default only names
 *              the method the entry and the DIOT print.
 *
 * Both choices self-correct: the payment reclassification moves the amount
 * as soon as cash moves.
 */
export const CONSERVATIVE_METODO: Readonly<Record<DocumentSide, MetodoPago>> = Object.freeze({
  issued: 'PUE',
  received: 'PPD',
});

/**
 * MNE-001-562 · The entry that puts back in 1135 the VAT a bill's payments
 * released above its CFDI's VAT (accounting/vat-overcredit.ts). Its
 * `source_id` is the bill.
 */
export const VAT_OVERCREDIT_CORRECTION_SOURCE = 'vat_overcredit_correction';

/**
 * MNE-001-599 · The entry that takes out of 1135, against the discount, the
 * VAT of an early-payment discount posted before migration 341
 * (accounting/discount-vat-correction.ts). Its `source_id` is the PAYMENT, so
 * `payment reverse` mirrors it with the payment's own entries. It is not one
 * of `ivaStillParked`'s sources: the application row stores the same figure
 * (`discount_iva_amount`), and `receivedVatStillParked` nets it from there.
 */
export const DISCOUNT_VAT_CORRECTION_SOURCE = 'discount_vat_correction';

const ISSUED_IVA_ROLES: readonly AccountRole[] = ['iva_trasladado', 'iva_trasladado_no_cobrado'];
const RECEIVED_IVA_ROLES: readonly AccountRole[] = ['iva_acreditable', 'iva_pendiente_acreditar'];

// ============================================================
// READING THE METODO DE PAGO
// ============================================================

/** 'PUE' / 'ppd' / ' PPD ' → the code. Anything else → null. Never guesses. */
export function parseMetodoPago(raw: unknown): MetodoPago | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return v === 'PUE' || v === 'PPD' ? v : null;
}

/**
 * A code is only read as a MetodoPago DECLARATION when it stands on its own.
 * A plain `\b` boundary is not enough, because two very ordinary strings sit
 * inside it and would be read as fiscal facts:
 *
 *   "Entrega en Cholula, Pue."  → `Pue.` is the state of Puebla, not PUE.
 *   "Ref PPD-2026-04"           → a folio, not a payment method.
 *
 * Both are word-bounded, and the first one was the expensive direction:
 * until MNE-001-492 it credited a bill's IVA on receipt with no warning and
 * no note in the entry. It still misstates the method an invoice, an entry
 * and the DIOT carry. So a code glued to `.`, `-`, `/` or a digit does not count. Rejecting
 * falls through to the conservative default, which is logged and written
 * into the entry — the honest outcome for a signal this weak.
 */
const METODO_TOKEN = /(?<![\w./-])(PUE|PPD)(?![\w./-])/g;

/**
 * An explicit PUE/PPD token inside free text (a document's `terms` or
 * `memo`). Delimited as above so "Net 30", a folio or a place name never
 * matches by accident, and DELIBERATELY null when the text names both: two
 * answers is not an answer, and the conservative default is the honest
 * outcome.
 */
export function metodoPagoFromText(text: string | null | undefined): MetodoPago | null {
  if (!text) return null;
  const found = new Set<MetodoPago>();
  for (const m of text.toUpperCase().matchAll(METODO_TOKEN)) {
    found.add(m[1] as MetodoPago);
  }
  return found.size === 1 ? [...found][0] : null;
}

export interface MetodoPagoSignals {
  /**
   * A MetodoPago on the document row. Reserved for the `cfdi_metodo_pago`
   * column the schema lane still owns — see the migration spec in the
   * lane report. Read defensively so the day the column lands the value
   * is used with no further change here.
   */
  documentMetodoPago?: unknown;
  /** metodo_pago of the stamped CFDI behind the document, when there is one. */
  cfdiMetodoPago?: unknown;
  terms?: string | null;
  memo?: string | null;
}

/** Resolves the MetodoPago from the strongest signal available. Pure. */
export function decideMetodoPago(
  side: DocumentSide,
  signals: MetodoPagoSignals
): MetodoPagoDecision {
  const fromDocument = parseMetodoPago(signals.documentMetodoPago);
  if (fromDocument) return { metodo: fromDocument, origin: 'document', assumed: false };

  const fromCfdi = parseMetodoPago(signals.cfdiMetodoPago);
  if (fromCfdi) return { metodo: fromCfdi, origin: 'cfdi', assumed: false };

  const fromText = metodoPagoFromText(signals.terms) ?? metodoPagoFromText(signals.memo);
  if (fromText) return { metodo: fromText, origin: 'terms', assumed: false };

  return { metodo: CONSERVATIVE_METODO[side], origin: 'default', assumed: true };
}

/** Short, human tag for a journal entry line: `PPD` or `PUE (assumed)`. */
export function describeMetodo(decision: MetodoPagoDecision): string {
  return decision.assumed ? `${decision.metodo} (assumed)` : decision.metodo;
}

/**
 * The sentence that goes into the entry so the choice is visible to whoever
 * reads the ledger, not just to whoever reads this file.
 */
export function ivaTreatmentNote(side: DocumentSide, decision: MetodoPagoDecision): string {
  const base =
    side === 'received'
      ? 'IVA not yet creditable — moves to IVA acreditable on payment'
      : decision.metodo === 'PPD'
        ? 'IVA not yet due — moves to IVA trasladado on collection'
        : 'IVA due on issuance';
  return decision.assumed
    ? `${base}; no CFDI MetodoPago on the document, conservative ${decision.metodo} assumed`
    : base;
}

// ============================================================
// WHICH ACCOUNT ROLE — ASKED OF THE TAXONOMY
// ============================================================

/**
 * Synthetic facts whose only purpose is to select a taxonomy case. Every
 * amount is zero except one peso of IVA, which is what makes the IVA line
 * of the matched case identifiable. Not a document and never persisted.
 */
function probeFacts(side: DocumentSide, metodo: MetodoPago): CfdiFacts {
  return {
    uuid: 'probe',
    tipo: 'I',
    direction: side === 'issued' ? 'emitido' : 'recibido',
    emisorRfc: '',
    receptorRfc: '',
    emisorNombre: '',
    fecha: new Date(0),
    metodoPago: metodo,
    pagadoEnEfectivo: false,
    moneda: 'MXN',
    tipoCambio: 1,
    esMonedaExtranjera: false,
    subtotal: 0,
    descuento: 0,
    total: 0,
    ivaTrasladado16: 1,
    ivaTrasladado8: 0,
    ivaTasaCero: 0,
    importeExento: 0,
    iepsTrasladado: 0,
    isrRetenido: 0,
    ivaRetenido: 0,
    impuestosLocalesTrasladados: 0,
    impuestosLocalesRetenidos: 0,
    complementos: [],
    docsRelacionados: [],
    uuidsRelacionados: [],
    esAnticipo: false,
    clavesProdServ: [],
    conceptosDescripcion: '',
  };
}

const roleCache = new Map<string, AccountRole>();

/**
 * The account role the IVA of an ordinary (non-advance) AR/AP document
 * lands in. The answer comes from cfdi-taxonomy.ts: this walks the matched
 * case's posting and returns its IVA line's role, so the taxonomy stays the
 * one place where the four cases are written down.
 */
export function ivaRoleFor(side: DocumentSide, metodo: MetodoPago): AccountRole {
  const key = `${side}:${metodo}`;
  const cached = roleCache.get(key);
  if (cached) return cached;

  const kase = matchCase(probeFacts(side, metodo));
  const candidates = side === 'issued' ? ISSUED_IVA_ROLES : RECEIVED_IVA_ROLES;
  const line = kase?.posting?.find((l) => candidates.includes(l.role));
  if (!line) {
    throw new AccountingError(
      'IVA_ROLE_UNRESOLVED',
      { key: 'error.IVA_ROLE_UNRESOLVED.no_line', params: { side, method: metodo } }
    );
  }
  roleCache.set(key, line.role);
  return line.role;
}

/**
 * The pair a payment reclassifies: out of the pending role, into the due one.
 *
 * NOTE: received, the target is the creditable role itself and not what the
 * taxonomy says of a PUE. A received PUE parks its VAT too (MNE-001-492), so
 * that probe answers the pending role, and a release would move 1135 to 1135.
 */
export function reclassRoles(side: DocumentSide): { from: AccountRole; to: AccountRole } {
  const from = ivaRoleFor(side, 'PPD');
  if (side === 'issued') return { from, to: ivaRoleFor(side, 'PUE') };
  const to: AccountRole = 'iva_acreditable';
  if (from === to) {
    throw new AccountingError(
      'IVA_ROLE_UNRESOLVED',
      { key: 'error.IVA_ROLE_UNRESOLVED.same_role', params: { role: to } }
    );
  }
  return { from, to };
}

// ============================================================
// HOW MUCH IVA A PAYMENT RELEASES
// ============================================================

export interface ReclassInput {
  /** IVA parked on the document when it was issued. Decimal string. */
  ivaTotal: string;
  /** The document total: the denominator of the pro rata. Decimal string. */
  documentTotal: string;
  /** Amount applied to the document by EARLIER payments. Decimal string. */
  priorApplied: string;
  /** Amount applied to the document by THIS payment. Decimal string. */
  appliedNow: string;
}

/** Money on this path is 19,4 in the database; keep every string at 4 dp. */
const SCALE = 4;

/**
 * IVA released by one payment, as the difference between two cumulative
 * targets rather than a per-payment rounding. Two consequences that matter:
 * partial payments never drift, and the last one always releases the exact
 * remainder — when the document is fully applied the ratio is exactly 1, so
 * the target is ivaTotal itself and nothing is left stranded in 2125/1135.
 */
export function ivaToReclassify(input: ReclassInput): string {
  const iva = new Decimal(input.ivaTotal || '0');
  const total = new Decimal(input.documentTotal || '0');
  const prior = new Decimal(input.priorApplied || '0');
  const now = new Decimal(input.appliedNow || '0');

  if (iva.lessThanOrEqualTo(0) || total.lessThanOrEqualTo(0) || now.lessThanOrEqualTo(0)) {
    return new Decimal(0).toFixed(SCALE);
  }

  const target = (applied: Decimal): Decimal => {
    if (applied.lessThanOrEqualTo(0)) return new Decimal(0);
    if (applied.greaterThanOrEqualTo(total)) return iva;
    return iva.times(applied).dividedBy(total).toDecimalPlaces(SCALE);
  };

  const released = target(prior.plus(now)).minus(target(prior));
  return (released.lessThan(0) ? new Decimal(0) : released).toFixed(SCALE);
}

export interface DiscountVatInput {
  /** The early-payment discount this application takes, in the bill's currency. */
  discount: Decimal.Value;
  /** The bill's VAT and total, in its currency: the proportion of the discount that is VAT. */
  taxAmount: Decimal.Value;
  totalAmount: Decimal.Value;
  /** What the bill still has in 1135 after this event's release, in the functional currency. */
  remainder: Decimal.Value;
  /** Whether this event leaves the bill owing nothing. */
  closes: boolean;
  /** The bill's historical rate, for a bill in another currency. */
  rate?: Decimal.Value;
}

/** A gap at closing up to this is the rounding of the cumulative release, not something else parked. */
const ROUNDING_AT_CLOSE = new Decimal('0.01');

/**
 * MNE-001-597 · The VAT of an early-payment discount, which leaves 1135
 * without becoming creditable. A discount lowers the price and so the VAT
 * (LIVA art. 7), and on cash basis only the VAT of what was paid is
 * creditable (art. 5 fr. III), so the discount's share never will be.
 *
 * The share is the discount times the bill's VAT over its total, at four
 * decimals (at the bill's rate when it has one), capped by what is still
 * parked. When the event closes the bill and what is left differs from the
 * share by a cent or less, it takes what is left: that gap is the rounding of
 * the cumulative release. A larger gap means something else is still parked,
 * such as a held cheque's cash share, and then only the share leaves.
 */
export function discountVatShare(input: DiscountVatInput): string {
  const discount = new Decimal(input.discount);
  const total = new Decimal(input.totalAmount);
  const remainder = Decimal.max(new Decimal(input.remainder), 0);
  if (discount.lessThanOrEqualTo(0) || total.lessThanOrEqualTo(0)) return new Decimal(0).toFixed(SCALE);
  let share = discount.times(input.taxAmount).dividedBy(total).toDecimalPlaces(SCALE);
  if (input.rate !== undefined) share = share.times(input.rate).toDecimalPlaces(SCALE);
  if (input.closes && remainder.minus(share).abs().lessThanOrEqualTo(ROUNDING_AT_CLOSE)) {
    return remainder.toFixed(SCALE);
  }
  return Decimal.max(Decimal.min(share, remainder), 0).toFixed(SCALE);
}

// ============================================================
// DATABASE LOOKUPS
// ============================================================

/**
 * True when the entity is Mexican. The cash-basis rule is LIVA, not GAAP:
 * a US entity's tax on a bill is not creditable IVA and must keep posting
 * exactly as it did before.
 *
 * EL PREDICADO YA NO SE ESCRIBE AQUÍ (J0.1, docs/jurisdicciones.md §3.1).
 * Comparaba las dos columnas contra sus literales —el país contra MX, o la
 * norma contra mx_nif—, que es el mismo criterio del conmutador salvo en el
 * borde: comparaba la
 * columna en crudo, y `incorporation_country` es `CHAR(2)` sin CHECK ni
 * normalización, así que una entidad guardada como 'mx' o como los dos
 * espacios en blanco con que bpchar almacena la cadena vacía contestaba
 * `false` AQUÍ y `true` en la semilla del catálogo, que usa el conmutador.
 *
 * QUÉ SE MOVIÓ, ENTONCES: esas entidades pasan a acreditar IVA sobre flujo,
 * que es lo que la LIVA les exige y lo que su propio catálogo ya suponía. El
 * cambio es un ENSANCHAMIENTO ESTRICTO —todo lo que antes daba `true` lo
 * sigue dando— y no puede terminar en MISSING_ROLE_ACCOUNT: la entidad que
 * ahora entra es exactamente la que el sembrador consideró mexicana, así que
 * tiene las cuatro cuentas de IVA. Antes, las dos mitades del sistema
 * contestaban distinto sobre la misma fila.
 */
export async function entityUsesCashBasisIva(
  client: pg.PoolClient,
  entityId: string
): Promise<boolean> {
  const { rows } = await client.query<{ incorporation_country: string; accounting_standard: string }>(
    'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const row = rows[0];
  // LA FILA AUSENTE NO ES UNA ENTIDAD DUDOSA, Y POR ESO NO PASA POR EL
  // CONMUTADOR. «Ante la duda, mexicana» resuelve qué régimen tiene una
  // entidad que existe y no declaró su país; aquí no hay entidad. La
  // consulta filtra sólo por `id` y se apoya en RLS, de modo que un id de
  // otro inquilino —o inexistente— devuelve cero filas: enrutarlo por
  // `jurisdictionOf({})` le regalaría régimen fiscal mexicano a algo que ni
  // siquiera está en los libros del despacho.
  if (!row) return false;
  return keepsMexicanBooks(row.incorporation_country, row.accounting_standard);
}

/**
 * metodo_pago of the stamped CFDI behind an issued invoice, if it is ingested.
 *
 * Scoped to the entity on purpose: one CFDI can be ingested twice inside the
 * same tenant when both parties are entities of the group (the emisor files
 * it as 'emitido', the receptor as 'recibido'), and an unqualified LIMIT 1
 * would read whichever row the planner reached first — another entity's.
 */
async function cfdiMetodoPagoByUuid(
  client: pg.PoolClient,
  entityId: string,
  cfdiUuid: string | null | undefined
): Promise<string | null> {
  if (!cfdiUuid) return null;
  const { rows } = await client.query<{ metodo_pago: string | null }>(
    'SELECT metodo_pago FROM xml_documents WHERE cfdi_uuid = $1 AND entity_id = $2 LIMIT 1',
    [cfdiUuid, entityId]
  );
  return rows[0]?.metodo_pago ?? null;
}

/**
 * metodo_pago of the CFDI a bill came from. A bill has no cfdi_uuid column,
 * so the link runs through the pre-registration that produced it.
 */
async function cfdiMetodoPagoByBill(
  client: pg.PoolClient,
  entityId: string,
  billId: string
): Promise<string | null> {
  const { rows } = await client.query<{ metodo_pago: string | null }>(
    `SELECT x.metodo_pago
       FROM pre_registrations p
       JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.bill_id = $1 AND p.entity_id = $2
      ORDER BY p.created_at DESC
      LIMIT 1`,
    [billId, entityId]
  );
  return rows[0]?.metodo_pago ?? null;
}

export interface InvoiceMetodoSource {
  id: string;
  /** Every lookup below is scoped to it; a document never reads another entity's CFDI. */
  entity_id: string;
  invoice_number?: string;
  cfdi_uuid?: string | null;
  terms?: string | null;
  memo?: string | null;
}

export interface BillMetodoSource {
  id: string;
  entity_id: string;
  bill_number?: string;
  terms?: string | null;
  memo?: string | null;
}

function warnIfAssumed(kind: string, ref: string, decision: MetodoPagoDecision): void {
  if (!decision.assumed) return;
  logger.warn('CFDI MetodoPago missing: conservative IVA treatment applied', {
    document: kind,
    reference: ref,
    metodo_pago_assumed: decision.metodo,
  });
}

export async function resolveInvoiceMetodoPago(
  client: pg.PoolClient,
  invoice: InvoiceMetodoSource
): Promise<MetodoPagoDecision> {
  const decision = decideMetodoPago('issued', {
    documentMetodoPago: (invoice as { cfdi_metodo_pago?: unknown }).cfdi_metodo_pago,
    cfdiMetodoPago: await cfdiMetodoPagoByUuid(client, invoice.entity_id, invoice.cfdi_uuid),
    terms: invoice.terms,
    memo: invoice.memo,
  });
  warnIfAssumed('invoice', invoice.invoice_number ?? invoice.id, decision);
  return decision;
}

export async function resolveBillMetodoPago(
  client: pg.PoolClient,
  bill: BillMetodoSource
): Promise<MetodoPagoDecision> {
  const decision = decideMetodoPago('received', {
    documentMetodoPago: (bill as { cfdi_metodo_pago?: unknown }).cfdi_metodo_pago,
    cfdiMetodoPago: await cfdiMetodoPagoByBill(client, bill.entity_id, bill.id),
    terms: bill.terms,
    memo: bill.memo,
  });
  warnIfAssumed('bill', bill.bill_number ?? bill.id, decision);
  return decision;
}

// ============================================================
// THE RECLASSIFICATION A PAYMENT TRIGGERS
// ============================================================

/** One document's share of a payment, already resolved and priced. */
export interface ReclassItem {
  documentId: string;
  documentNumber: string;
  metodo: MetodoPagoDecision;
  /**
   * IVA to move out of the pending role and into the due one. 4 dp string.
   * R4: si el documento está en moneda extranjera y el llamador dio su tasa,
   * este importe YA viene en moneda funcional (convertido a la tasa del
   * documento — la misma con la que se aparcó).
   */
  amount: string;
  /** R4 · el importe original en la moneda del documento, cuando aplica. */
  importeOriginal?: string;
  /** R4 · la tasa histórica con la que `amount` se convirtió, cuando aplica. */
  tasa?: string;
  /**
   * The IVA of this tranche in the document's currency (the pro-rata before
   * conversion), present when a rate was given and the parked cap did not
   * trim the release. The caller converts it at the PAYMENT day's rate for
   * the side that becomes due: the tax is caused when the money moves (LIVA
   * arts. 1-B, 5-III and 11) and art. 20 CFF converts it at that day's rate.
   */
  documentAmount?: string;
}

interface AppliedDocumentRow {
  document_id: string;
  document_number: string;
  tax_amount: string;
  total_amount: string;
  applied_now: string;
  applied_total: string;
  terms: string | null;
  memo: string | null;
  cfdi_uuid?: string | null;
}

/**
 * Invoices this customer payment was applied to, with what it applied now
 * and what every payment has applied in total. Allocations are written
 * before the entry is posted, so "in total" already includes this payment;
 * `applied_total - applied_now` is therefore what came before it.
 */
async function invoicesAppliedBy(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<AppliedDocumentRow[]> {
  const { rows } = await client.query<AppliedDocumentRow>(
    // Sólo aplicaciones VIVAS (049): una desaplicada es historia, y contarla
    // aquí re-liberaría el IVA que su desaplicación ya re-aparcó.
    `SELECT pa.invoice_id                       AS document_id,
            i.invoice_number                    AS document_number,
            i.tax_amount::text                  AS tax_amount,
            i.total_amount::text                AS total_amount,
            -- The customer's withholding settles the invoice too (MNE-001-113): withheld
            -- VAT is effectively collected (LIVA art. 1-B) and credited monthly (art. 5-D).
            SUM(pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)::text AS applied_now,
            (SELECT COALESCE(SUM(pa2.amount_applied + pa2.withholding_isr_amount + pa2.withholding_iva_amount), 0)
               FROM payment_allocations pa2
              WHERE pa2.invoice_id = pa.invoice_id
                AND pa2.unapplied_at IS NULL)::text AS applied_total,
            i.terms, i.memo, i.cfdi_uuid
       FROM payment_allocations pa
       JOIN invoices i ON i.id = pa.invoice_id
      WHERE pa.payment_id = $1 AND i.entity_id = $2
        AND pa.unapplied_at IS NULL
      GROUP BY pa.invoice_id, i.invoice_number, i.tax_amount, i.total_amount,
               i.terms, i.memo, i.cfdi_uuid`,
    [paymentId, entityId]
  );
  return rows;
}

/** Bills this vendor payment was applied to, live rows only (105). Mirror of invoicesAppliedBy. */
async function billsAppliedBy(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<AppliedDocumentRow[]> {
  const { rows } = await client.query<AppliedDocumentRow>(
    `SELECT pa.bill_id                          AS document_id,
            b.bill_number                       AS document_number,
            b.tax_amount::text                  AS tax_amount,
            b.total_amount::text                AS total_amount,
            SUM(pa.amount_applied)::text        AS applied_now,
            (SELECT COALESCE(SUM(pa2.amount_applied), 0)
               FROM payment_applications pa2
              WHERE pa2.bill_id = pa.bill_id
                AND pa2.unapplied_at IS NULL)::text AS applied_total,
            b.terms, b.memo
       FROM payment_applications pa
       JOIN bills b ON b.id = pa.bill_id
      WHERE pa.payment_id = $1 AND b.entity_id = $2
        AND pa.unapplied_at IS NULL
      GROUP BY pa.bill_id, b.bill_number, b.tax_amount, b.total_amount, b.terms, b.memo`,
    [paymentId, entityId]
  );
  return rows;
}

/**
 * How much IVA is STILL PARKED in the pending account for one document.
 *
 * This is the cap on what a payment may release, and it exists because the
 * release must compose with history. Every bill posted before cash-basis IVA
 * existed sent its IVA straight to the due account (1130 / 2120) and parked
 * nothing. Releasing against such a bill would credit the due account a second
 * time for tax that was never deferred, and drive the pending account
 * negative — the tell that a monthly return is about to be wrong.
 *
 * Reading the ledger rather than a flag also makes the two mechanisms agree:
 * a document moved into the pending account by the backfill has a debit there
 * and can be released, and a document that never was simply has a zero cap.
 * A payment's release is NOT netted here: its entry carries the payment as
 * source, not the document, so this reads a half-paid document as fully
 * parked. A partial payment does not release twice because each release is the
 * difference of two cumulative targets (`ivaToReclassify`); a caller that
 * needs what is left after them nets the stored releases
 * (`receivedVatStillParked`, `issuedVatStillParked`).
 *
 * `beforeCreditNotes` leaves a received credit note's entry out: what the bill
 * parked, whatever a note took back since. It answers whether the bill ever
 * parked VAT, which is not a cap (MNE-001-492).
 *
 * MNE-001-562: the correction of the VAT a payment released above the CFDI's
 * puts that VAT back in 1135 for the bill, so it counts here, and only while it
 * stands: a reversal's mirror carries no source, so a reversed correction is
 * left out instead of netted.
 */
export async function ivaStillParked(
  client: pg.PoolClient,
  side: DocumentSide,
  entityId: string,
  documentId: string,
  options: { beforeCreditNotes?: boolean } = {}
): Promise<string> {
  const { from } = reclassRoles(side);
  const sourceTypes = side === 'issued'
    ? ['invoice', 'customer_payment', 'iva_reclass']
    : ['bill', 'vendor_payment', 'iva_reclass', VAT_OVERCREDIT_CORRECTION_SOURCE,
       ...(options.beforeCreditNotes ? [] : [VENDOR_CREDIT_NOTE_SOURCE])];

  // MNE-001-023: a bill migrated with the opening parked its IVA inside the
  // opening entry, which carries the pending-IVA balance as ONE line for all
  // documents; `bills.tax_amount` is its share. Only while that opening stands.
  const fromOpening =
    side === 'received'
      ? ` + COALESCE((SELECT SUM(b.tax_amount) FROM bills b
                        JOIN journal_entries jo ON jo.id = b.journal_entry_id AND jo.entity_id = b.entity_id
                       WHERE b.id = $3 AND b.entity_id = $1 AND jo.source_type = 'opening_balance'
                         AND jo.status = 'posted' AND jo.reversed_by_entry_id IS NULL), 0)`
      : '';
  const { rows } = await client.query<{ parked: string }>(
    `SELECT (COALESCE(SUM(
              CASE WHEN a.normal_balance = 'debit'
                   THEN COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)
                   ELSE COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)
              END), 0)${fromOpening})::text AS parked
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       JOIN account_roles ar ON ar.account_id = a.id
                            AND ar.entity_id = $1 AND ar.qualifier IS NULL
      WHERE je.entity_id = $1
        AND je.status = 'posted'
        AND ar.role = $2
        AND je.source_type = ANY($4::text[])
        AND (je.source_type <> $5 OR je.reversed_by_entry_id IS NULL)
        -- Dos saltos, y hacen falta los dos. El asiento del documento apunta
        -- al documento; el de RECLASIFICACIÓN que escribe el backfill apunta
        -- al ASIENTO, no al documento (iva-ppd-reclass.ts: sourceId = entry_id),
        -- así que sólo se alcanza saltando una vez más.
        --
        -- La versión anterior buscaba el segundo salto por journal_entry_lines
        -- y era un NO-OP: je.id IN (SELECT journal_entry_id ... WHERE
        -- j2.source_id = $3) equivale a je.source_id = $3, el término que ya
        -- la precede. Con ella, un gasto corregido por el backfill daba tope
        -- cero y su pago no acreditaba nada: el IVA quedaba varado en 1135.
        AND (je.source_id = $3 OR je.source_id IN (
              SELECT j2.id FROM journal_entries j2
               WHERE j2.source_id = $3 AND j2.entity_id = $1))`,
    [entityId, from, documentId, sourceTypes, VAT_OVERCREDIT_CORRECTION_SOURCE]
  );
  const parked = new Decimal(rows[0]?.parked ?? '0');

  // Un tope de cero puede significar dos cosas MUY distintas: que el
  // documento no aparcó nada —correcto, y frecuente— o que la entidad no
  // tiene sembrada la capa semántica y esta consulta, que resuelve la cuenta
  // POR ROL, no encuentra ninguna. El backfill del histórico sí acepta el
  // código heredado, así que en una entidad sin roles el IVA se APARCA y no
  // se LIBERA nunca, en silencio. Se distinguen los dos casos.
  if (parked.isZero()) {
    const { rows: r } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM account_roles WHERE entity_id = $1`,
      [entityId]
    );
    if (r[0]?.n === '0') {
      throw new AccountingError(
        'MISSING_ROLE_ACCOUNT',
        { key: 'error.MISSING_ROLE_ACCOUNT.no_semantic_layer', params: { entity: entityId } }
      );
    }
  }
  return Decimal.max(parked, new Decimal(0)).toFixed(SCALE);
}

/**
 * What a bill still has in the pending account, net of its payments.
 *
 * `ivaStillParked` does not reach a vendor payment's entry, whose source is
 * the payment and not the bill, so on its own it reads a half-paid bill as
 * fully parked. Each release is stored on its application, and an application
 * undone or reversed stops being live, which puts its VAT back. A received
 * credit note takes its pending-VAT share up to this figure (MNE-001-489).
 *
 * MNE-001-597: the VAT of an early-payment discount leaves 1135 in the same
 * entry and is stored on its application too, so it is netted the same way.
 * A row written before 341 stores NULL: its discount's VAT is still there.
 */
export async function receivedVatStillParked(
  client: pg.PoolClient,
  entityId: string,
  billId: string
): Promise<string> {
  const cap = new Decimal(await ivaStillParked(client, 'received', entityId, billId));
  const { rows } = await client.query<{ released: string }>(
    `SELECT (COALESCE(SUM(pa.iva_reclass_amount), 0)
             + COALESCE(SUM(pa.discount_iva_amount), 0))::text AS released
       FROM payment_applications pa
       JOIN bills b ON b.id = pa.bill_id
      WHERE b.entity_id = $1 AND pa.bill_id = $2
        AND pa.unapplied_at IS NULL`,
    [entityId, billId]
  );
  return Decimal.max(cap.minus(rows[0]?.released ?? '0'), new Decimal(0)).toFixed(SCALE);
}

/**
 * MNE-001-575 · What an issued invoice still has in 2125: what it parked,
 * less what its live collections released and what its earlier credit notes
 * already took back. The twin of `receivedVatStillParked`, and for the same
 * reason: `ivaStillParked` sees only the entries whose source is the invoice,
 * and a receipt's entry or a note's has its own document as source.
 *
 * A live allocation that stored no release (NULL, written before MNE-001-459)
 * counts at its pro-rata share, the estimate an unapply makes too: counting it
 * as zero would read a collected invoice as parked. `estimated` says so.
 */
export async function issuedVatStillParked(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string
): Promise<{ parked: string; estimated: boolean }> {
  const parked = new Decimal(await ivaStillParked(client, 'issued', entityId, invoiceId));
  const { from } = reclassRoles('issued');
  const { rows: [taken] } = await client.query<{
    released: string; unknown: string; notes: string; tax: string; total: string;
  }>(
    `SELECT COALESCE((SELECT SUM(pa.iva_reclass_amount) FROM payment_allocations pa
                        JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                       WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NULL), 0)::text AS released,
            COALESCE((SELECT SUM(pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)
                        FROM payment_allocations pa
                        JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                       WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NULL
                         AND pa.iva_reclass_amount IS NULL), 0)::text AS unknown,
            COALESCE((SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                        FROM credit_notes cn
                        JOIN journal_entries je ON je.entity_id = $1 AND je.source_type = 'credit_note'
                                               AND je.source_id = cn.id AND je.status = 'posted'
                                               AND je.reversed_by_entry_id IS NULL
                        JOIN journal_entry_lines l ON l.journal_entry_id = je.id
                        JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = $1
                                             AND ar.role = $3 AND ar.qualifier IS NULL
                       WHERE cn.entity_id = $1 AND cn.invoice_id = i.id), 0)::text AS notes,
            i.tax_amount::text AS tax, i.total_amount::text AS total
       FROM invoices i
      WHERE i.id = $2 AND i.entity_id = $1`,
    [entityId, invoiceId, from]
  );
  if (!taken) return { parked: new Decimal(0).toFixed(SCALE), estimated: false };
  const estimate = new Decimal(ivaToReclassify({
    ivaTotal: taken.tax, documentTotal: taken.total, priorApplied: '0', appliedNow: taken.unknown,
  }));
  const left = Decimal.max(parked.minus(taken.released).minus(estimate).minus(taken.notes), 0);
  // MNE-001-581: after a note, an unapply or a reversal may keep part of an
  // ended allocation's release in 2120, which the sum above reads as parked
  // again. Only then is the open balance's IVA the cap; anywhere else the sum
  // is exact and stays as it was.
  const open = await issuedVatOfOpenBalance(client, entityId, invoiceId);
  const capped = open.hasNote && open.hasEnded ? Decimal.min(left, open.target) : left;
  return { parked: capped.toFixed(SCALE), estimated: estimate.greaterThan(0) };
}

/**
 * MNE-001-581 · The IVA an issued invoice's open balance carries: what 2125
 * must hold for it once a collection is unapplied or reversed (LIVA arts. 1-B
 * and 7). The balance is the total, less the cash and withholdings still
 * applied (`C`), less the credit notes linked to it; its IVA is the same
 * cumulative target the collections release by, so the collections still to
 * come release exactly it. `ending` names the allocations the caller is about
 * to end, which no longer count in `C`. A cheque that still holds its IVA
 * (MNE-001-556) is not collected yet: its cash stays in the balance.
 *
 * `hasNote` says whether a posted, unreversed note is linked to the invoice
 * (`noteNumbers` names them), and `hasEnded` whether any of its allocations
 * was ever unapplied or reversed.
 */
export async function issuedVatOfOpenBalance(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string,
  options: { ending?: readonly string[] } = {}
): Promise<{ target: string; hasNote: boolean; hasEnded: boolean; noteNumbers: string }> {
  const { rows: [doc] } = await client.query<{
    collected: string; notes: string; note_count: number; note_numbers: string | null; ended: boolean; tax: string; total: string;
  }>(
    `SELECT COALESCE((SELECT SUM(pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)
                        FROM payment_allocations pa
                        JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                        JOIN legal_entities le ON le.id = cp.entity_id
                       WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NULL
                         AND NOT (pa.id = ANY($3::uuid[]))
                         AND NOT (cp.payment_method = 'check' AND cp.check_cashed_tx_id IS NULL
                                  AND TRIM(cp.currency_code) = TRIM(le.functional_currency))), 0)::text AS collected,
            COALESCE(SUM(cn.total_amount), 0)::text AS notes,
            COUNT(cn.id)::int AS note_count,
            string_agg(cn.credit_note_number, ', ' ORDER BY cn.credit_note_number) AS note_numbers,
            EXISTS (SELECT 1 FROM payment_allocations pa
                      JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                     WHERE pa.invoice_id = i.id AND pa.unapplied_at IS NOT NULL) AS ended,
            i.tax_amount::text AS tax, i.total_amount::text AS total
       FROM invoices i
       LEFT JOIN credit_notes cn ON cn.invoice_id = i.id AND cn.entity_id = $1
            AND EXISTS (SELECT 1 FROM journal_entries je
                         WHERE je.entity_id = $1 AND je.source_type = 'credit_note' AND je.source_id = cn.id
                           AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL)
      WHERE i.id = $2 AND i.entity_id = $1
      GROUP BY i.id, i.tax_amount, i.total_amount`,
    [entityId, invoiceId, [...(options.ending ?? [])]]
  );
  if (!doc) return { target: new Decimal(0).toFixed(SCALE), hasNote: false, hasEnded: false, noteNumbers: '' };
  const open = Decimal.max(new Decimal(doc.total).minus(doc.notes).minus(doc.collected), 0);
  const target = ivaToReclassify({
    ivaTotal: doc.tax, documentTotal: doc.total, priorApplied: doc.collected, appliedNow: open.toFixed(SCALE),
  });
  return { target, hasNote: doc.note_count > 0, hasEnded: doc.ended, noteNumbers: doc.note_numbers ?? '' };
}

/**
 * What the payment that settles a bill lowered by a credit note releases.
 *
 * The pro rata reads the bill's total, and such a bill is settled below it, so
 * its last payment would leave a rounding remainder parked on a paid bill.
 * Settled by cash and notes alone, it releases all it still has parked. NOTE:
 * any other bill keeps `proRata`, and so does one closed with a discount or a
 * write-off, whose VAT is not all creditable (MNE-001-555): the share of each
 * leaves 1135 in its own entry without becoming creditable, the write-off's in
 * `postVendorApplicationEntry` and the discount's by `discountVatShare`
 * (MNE-001-597), so the pro rata of the cash is all the payment credits.
 */
export async function receivedReleaseAtSettlement(
  client: pg.PoolClient, entityId: string, billId: string, proRata: string
): Promise<string> {
  const { rows } = await client.query(
    `SELECT 1 FROM bills b
      WHERE b.id = $2 AND b.entity_id = $1 AND b.amount_due <= 0
        AND b.total_amount - b.amount_paid = (
              SELECT SUM(jel.debit_amount)
                FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
               WHERE je.entity_id = $1 AND je.source_type = $3 AND je.source_id = b.id AND je.status = 'posted')`,
    [entityId, billId, VENDOR_CREDIT_NOTE_SOURCE]
  );
  return rows.length > 0 ? receivedVatStillParked(client, entityId, billId) : proRata;
}

/**
 * What a payment releases from the pending-IVA account, per document.
 *
 * Received: where the IVA sits decides, not the method (MNE-001-491). A bill
 * that parked IVA in the pending account releases it in proportion, capped by
 * `ivaStillParked`; one whose IVA went to the creditable account has a cap of
 * zero and moves nothing, whether it says PUE or PPD. Issued: only PPD
 * invoices appear. Documents whose share rounds to zero are dropped so the
 * entry stays readable.
 */
export async function ivaReclassificationsFor(
  client: pg.PoolClient,
  side: DocumentSide,
  entityId: string,
  paymentId: string,
  /**
   * The historical rate per document id for foreign-currency documents:
   * bills.exchange_rate on a vendor payment, invoices.exchange_rate (written
   * back by MNE-001-081) on a customer collection. The pro-rata comes out in
   * the document's currency and the parked balance lives in the functional
   * one: without converting BEFORE the cap, the comparison would mix
   * currencies and the cap would lie.
   */
  tasasPorDocumento?: Map<string, string>
): Promise<ReclassItem[]> {
  const rows =
    side === 'issued'
      ? await invoicesAppliedBy(client, entityId, paymentId)
      : await billsAppliedBy(client, entityId, paymentId);

  const items: ReclassItem[] = [];
  for (const row of rows) {
    const metodo =
      side === 'issued'
        ? await resolveInvoiceMetodoPago(client, {
            id: row.document_id,
            entity_id: entityId,
            invoice_number: row.document_number,
            cfdi_uuid: row.cfdi_uuid,
            terms: row.terms,
            memo: row.memo,
          })
        : await resolveBillMetodoPago(client, {
            id: row.document_id,
            entity_id: entityId,
            bill_number: row.document_number,
            terms: row.terms,
            memo: row.memo,
          });

    // NOTE: the method test stays on the issued side only. An invoice read as
    // PUE with its IVA in 2125 (#668) would start releasing on collection, and
    // the issued PUE is outside MNE-001-491; a bill is decided by the cap below.
    if (side === 'issued' && metodo.metodo !== 'PPD') continue;

    const appliedNow = new Decimal(row.applied_now || '0');
    const priorApplied = Decimal.max(
      new Decimal(row.applied_total || '0').minus(appliedNow),
      new Decimal(0)
    );
    const amount = ivaToReclassify({
      ivaTotal: row.tax_amount,
      documentTotal: row.total_amount,
      priorApplied: priorApplied.toFixed(SCALE),
      appliedNow: appliedNow.toFixed(SCALE),
    });
    if (new Decimal(amount).lessThanOrEqualTo(0)) continue;

    // R4: el pro-rata está en la moneda del documento; si hay tasa, pasa a
    // funcional AQUÍ, antes del tope, porque el saldo aparcado (que se lee
    // del mayor) ya vive en funcional desde que postBillEntry convierte.
    //
    // Y SE CONVIERTEN LOS ACUMULADOS, NO EL TRAMO: la liberación funcional
    // del tramo es q4(acumulado_con_este × tasa) − q4(acumulado_previo ×
    // tasa), que TELESCOPA — la suma de todos los tramos reproduce exacto
    // lo aparcado q4(iva × tasa). Convertir el pro-rata del tramo y
    // redondearlo por separado sumaba medio diezmilésimo de más por pago y
    // dejaba la 1135 del documento en NEGATIVO, porque el tope de abajo no
    // ve las liberaciones de pagos anteriores (su consulta no alcanza los
    // asientos de vendor_payment — ver el informe R4).
    const tasa = tasasPorDocumento?.get(row.document_id);
    let enFuncional: Decimal;
    if (tasa) {
      const acumulado = (aplicado: Decimal): Decimal =>
        new Decimal(
          ivaToReclassify({
            ivaTotal: row.tax_amount,
            documentTotal: row.total_amount,
            priorApplied: '0',
            appliedNow: aplicado.toFixed(SCALE),
          })
        )
          .times(tasa)
          .toDecimalPlaces(SCALE);
      enFuncional = acumulado(priorApplied.plus(appliedNow)).minus(acumulado(priorApplied));
    } else {
      enFuncional = new Decimal(
        side === 'received' ? await receivedReleaseAtSettlement(client, entityId, row.document_id, amount) : amount
      );
    }
    if (enFuncional.lessThanOrEqualTo(0)) continue;

    // Never release more than this document actually parked. A bill posted
    // before cash-basis IVA existed parked nothing, so its cap is zero and
    // the payment correctly moves no IVA at all.
    const parked = await ivaStillParked(client, side, entityId, row.document_id);
    const releasable = Decimal.min(enFuncional, new Decimal(parked));
    if (releasable.lessThanOrEqualTo(0)) continue;

    items.push({
      documentId: row.document_id,
      documentNumber: row.document_number,
      metodo,
      amount: releasable.toFixed(SCALE),
      // Las columnas FX sólo cuando dicen la verdad: si lo liberado ES el
      // pro-rata del tramo × tasa (half-up, 4 decimales), el origen viaja
      // completo. Cuando el telescopio o el tope lo movieron un
      // diezmilésimo, NINGÚN importe original honesto reproduce la cifra
      // (re-derivarlo dividiendo y redondeando daba un «origen» cuyo
      // producto no casaba, y el motor —con razón— tumbaba el pago entero
      // con FX_CONVERSION_NO_CASA). Esa línea va sin columnas FX: funcional
      // por declaración, y cuadra.
      ...(tasa && releasable.equals(new Decimal(amount).times(tasa).toDecimalPlaces(SCALE))
        ? { importeOriginal: amount, tasa }
        : {}),
      ...(tasa && releasable.equals(enFuncional) ? { documentAmount: amount } : {}),
    });
  }
  return items;
}
