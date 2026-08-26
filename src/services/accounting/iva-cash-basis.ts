import Decimal from 'decimal.js';
import type pg from 'pg';
import { AccountingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { matchCase, type AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';
import type { CfdiFacts } from '../xml-ingestion/cfdi-facts.js';

// ============================================================
// IVA ON CASH BASIS (LIVA art. 1-B and art. 5 frac. III)
//
// Mexico causes and credits IVA when the money MOVES, not when the
// invoice is issued. The CFDI MetodoPago is the fact that decides:
//
//   PUE (pago en una sola exhibición) — collected/paid at issuance:
//        the IVA is due (issued) or creditable (received) right away.
//   PPD (pago en parcialidades o diferido) — at issuance the IVA is
//        NOT yet due nor creditable. It parks in 2125 "IVA Trasladado
//        No Cobrado" / 1135 "IVA Pendiente de Acreditar" and MOVES to
//        2120 / 1130 when the payment (the complemento de pago) lands.
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
 * - received → PPD: the input IVA waits in 1135. Crediting it now would
 *              bring the credit forward on an invoice that may never be
 *              paid, which is the audit finding the SAT actually writes up.
 *
 * Both choices self-correct: the payment reclassification moves the amount
 * as soon as cash moves, so a PUE bill misread as PPD is only credited
 * later, never lost.
 */
export const CONSERVATIVE_METODO: Readonly<Record<DocumentSide, MetodoPago>> = Object.freeze({
  issued: 'PUE',
  received: 'PPD',
});

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
 * Both are word-bounded, and the first one is the expensive direction: it
 * would credit a bill's IVA on receipt with no warning and no note in the
 * entry, which is exactly the over-crediting this module exists to stop.
 * So a code glued to `.`, `-`, `/` or a digit does not count. Rejecting
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
    decision.metodo === 'PPD'
      ? side === 'issued'
        ? 'IVA not yet due — moves to IVA trasladado on collection'
        : 'IVA not yet creditable — moves to IVA acreditable on payment'
      : side === 'issued'
        ? 'IVA due on issuance'
        : 'IVA creditable on issuance';
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
      `La taxonomía CFDI no define una línea de IVA para (${side}, ${metodo}). ` +
        `Revisa CASES en src/services/xml-ingestion/cfdi-taxonomy.ts.`
    );
  }
  roleCache.set(key, line.role);
  return line.role;
}

/** The pair a payment reclassifies: out of the pending role, into the due one. */
export function reclassRoles(side: DocumentSide): { from: AccountRole; to: AccountRole } {
  return { from: ivaRoleFor(side, 'PPD'), to: ivaRoleFor(side, 'PUE') };
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

// ============================================================
// DATABASE LOOKUPS
// ============================================================

/**
 * True when the entity is Mexican. The cash-basis rule is LIVA, not GAAP:
 * a US entity's tax on a bill is not creditable IVA and must keep posting
 * exactly as it did before.
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
  if (!row) return false;
  return row.incorporation_country === 'MX' || row.accounting_standard === 'mx_nif';
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
  /** IVA to move out of the pending role and into the due one. 4 dp string. */
  amount: string;
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
    `SELECT pa.invoice_id                       AS document_id,
            i.invoice_number                    AS document_number,
            i.tax_amount::text                  AS tax_amount,
            i.total_amount::text                AS total_amount,
            SUM(pa.amount_applied)::text        AS applied_now,
            (SELECT COALESCE(SUM(pa2.amount_applied), 0)
               FROM payment_allocations pa2
              WHERE pa2.invoice_id = pa.invoice_id)::text AS applied_total,
            i.terms, i.memo, i.cfdi_uuid
       FROM payment_allocations pa
       JOIN invoices i ON i.id = pa.invoice_id
      WHERE pa.payment_id = $1 AND i.entity_id = $2
      GROUP BY pa.invoice_id, i.invoice_number, i.tax_amount, i.total_amount,
               i.terms, i.memo, i.cfdi_uuid`,
    [paymentId, entityId]
  );
  return rows;
}

/** Bills this vendor payment was applied to. Mirror of invoicesAppliedBy. */
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
              WHERE pa2.bill_id = pa.bill_id)::text AS applied_total,
            b.terms, b.memo
       FROM payment_applications pa
       JOIN bills b ON b.id = pa.bill_id
      WHERE pa.payment_id = $1 AND b.entity_id = $2
      GROUP BY pa.bill_id, b.bill_number, b.tax_amount, b.total_amount, b.terms, b.memo`,
    [paymentId, entityId]
  );
  return rows;
}

/**
 * What a payment releases from the pending-IVA account, per document.
 *
 * Only PPD documents appear: a PUE document's IVA was already in the due
 * account, so its payment moves nothing. Documents whose share rounds to
 * zero are dropped so the entry stays readable.
 */
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
 * Prior releases net themselves out, so a partial payment can be followed by
 * another without double-releasing.
 */
export async function ivaStillParked(
  client: pg.PoolClient,
  side: DocumentSide,
  entityId: string,
  documentId: string
): Promise<string> {
  const { from } = reclassRoles(side);
  const sourceTypes = side === 'issued'
    ? ['invoice', 'customer_payment', 'iva_reclass']
    : ['bill', 'vendor_payment', 'iva_reclass'];

  const { rows } = await client.query<{ parked: string }>(
    `SELECT COALESCE(SUM(
              CASE WHEN a.normal_balance = 'debit'
                   THEN COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)
                   ELSE COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)
              END), 0)::text AS parked
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       JOIN account_roles ar ON ar.account_id = a.id
                            AND ar.entity_id = $1 AND ar.qualifier IS NULL
      WHERE je.entity_id = $1
        AND je.status = 'posted'
        AND ar.role = $2
        AND je.source_type = ANY($4::text[])
        AND (je.source_id = $3 OR je.id IN (
              SELECT journal_entry_id FROM journal_entry_lines l2
               JOIN journal_entries j2 ON j2.id = l2.journal_entry_id
              WHERE j2.source_id = $3 AND j2.entity_id = $1))`,
    [entityId, from, documentId, sourceTypes]
  );
  const parked = new Decimal(rows[0]?.parked ?? '0');
  return Decimal.max(parked, new Decimal(0)).toFixed(SCALE);
}

export async function ivaReclassificationsFor(
  client: pg.PoolClient,
  side: DocumentSide,
  entityId: string,
  paymentId: string
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

    if (metodo.metodo !== 'PPD') continue;

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

    // Never release more than this document actually parked. A bill posted
    // before cash-basis IVA existed parked nothing, so its cap is zero and
    // the payment correctly moves no IVA at all.
    const parked = await ivaStillParked(client, side, entityId, row.document_id);
    const releasable = Decimal.min(new Decimal(amount), new Decimal(parked));
    if (releasable.lessThanOrEqualTo(0)) continue;

    items.push({
      documentId: row.document_id,
      documentNumber: row.document_number,
      metodo,
      amount: releasable.toFixed(SCALE),
    });
  }
  return items;
}
