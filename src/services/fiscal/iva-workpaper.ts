import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';
import { CUSTOMER_CHECK_CASHING_SOURCE, ORIGEN_COBRO_DE_CHEQUE } from '../banking/treasury-posting.js';
import {
  entityUsesCashBasisIva, ivaReclassificationsFor, reclassRoles, resolveInvoiceMetodoPago,
} from '../accounting/iva-cash-basis.js';
import { saleSources, type SaleSource } from './sale-sources.js';
import { issuedCreditNotesOfRange, type NoteGapCause } from './issued-credit-notes.js';
import { bankFeesOfRange } from './bank-fee-iva.js';
import { backAsAdvance, storedAdvanceTreatment } from '../payments/customer-advance.js';
import {
  acumuladoDelDocumento,
  desglosarDocumento,
  desgloseCero,
  hechosDelMes,
  ivaDelDesglose,
  porcionDelDocumento,
  rangoDelMes,
  sumarDesgloses,
  type Desglose,
  type Hallazgo,
  type HechoPagado,
  type PoliticaBaseExenta,
  type PorcionPagada,
  type RangoDelMes,
} from '../sat/diot/index.js';

// ============================================================
// THE MONTHLY IVA WORKPAPER, PART 1/3: DEFINITIVE IVA BY RATE (#308, MNE-001-058)
//
// Mexican IVA is caused when the money moves (LIVA arts. 1-B, 5 fr. III), so
// the month's figures are the two cash events the ledger already records:
//
//   · charged    — IVA trasladado COLLECTED: a PUE invoice posted in the
//                  month, whole; a PPD invoice, the IVA its customer payments
//                  released in the month (payment_allocations.iva_reclass_amount,
//                  the very amount posted from 2125 to 2120), dated the day the
//                  cash was applied (`applied_on`, migration 332; a row written
//                  before it takes its receipt's date), or a cheque's cashing
//                  (MNE-001-507, below); a customer advance (MNE-001-423,
//                  below); and, subtracted, each issued credit note in the
//                  month its own entry moved 2120 (LIVA art. 7; MNE-001-565,
//                  `issued-credit-notes.ts`): an `anticipo` one too, which
//                  cancels an advance already caused.
//
// A CUSTOMER ADVANCE causes its IVA the day it is collected (LIVA art. 1-B,
// first paragraph): the month of its receipt counts its base and IVA in the
// box of the treatment it was recorded with (customer_payments.advance_*), a
// not-subject one in the no-objeto base. Applied to its sale, the advance's
// IVA is cancelled instead of caused twice (MNE-001-422, MNE-001-461), so the
// month of the application takes out what the allocation stored
// (advance_base_amount, advance_iva_amount, migration 333). Unapplied, the cash
// is back on account as the advance it was, its IVA caused again (the owner's
// «no re-park», #623), so the month of the unapply adds it back and takes out
// the PPD share the allocation had released, which went back to 2125. On a
// receipt with a treatment all the cash an unapply puts back is that advance
// (MNE-001-462, `backAsAdvance`), so rule 1 below leaves the receipt to it and
// counts its cash back once. Each event counts in the month whose 2120 it
// moved, and a month already shown does not move when a later one undoes it.
// Each line traces the receipt's own entries of the month: its collection,
// application and unapplication entries.
//
// EVERY OTHER UNDO FOLLOWS WHAT HAPPENED TO THE MONEY (MNE-001-518, #666,
// comment 6948200519; no panel key: the facts of each receipt decide):
//   1. An unapply moves no money, so no IVA: the collection month keeps its
//      share, and the unapply's month lists the ended share and the same cash
//      back on account already taxed, netting 0 (LIVA art. 1-B); an
//      application of that cash nets it out again (`cashOnAccountOfMonth`).
//      The ledger still re-parks a plain receipt's share (the owner's open
//      question, #623 comment 7005284036), so that month's tie-out names it.
//   2. A reversal whose money never became the firm's counts in no month
//      (art. 1-B): the cause `not_collected` (MNE-001-509), which a cheque
//      takes by default because it is paid when cashed (second paragraph).
//      Each month it would have counted in names the reversal and the amended
//      return (CFF art. 32). MNE-001-510: the stated cause decides, not the
//      method (`REVERSAL_CAUSE`).
//   3. A reversal whose money arrived and was taken back (`taken_back`) takes
//      no IVA out: it leaves only by an art. 7 restitution with its document,
//      an issued credit note, which the paper counts in its own month
//      (MNE-001-565). One with no cause stated, on any method
//      but a cheque, is read the same way until `receipt cause record` states
//      one (MNE-001-511): the conservative side, it never lowers a month.
//      Either way the invoice it collected can be collected again, and that
//      collection causes its own IVA (the reset events of `SHARE_EVENTS`).
//   4. A later event that moves a month is named there, with its amount: the
//      tie-out lists each receipt whose entries moved 2120 otherwise than the
//      paper counted it (`gapCauses`), and is silent where they agree; a cause
//      stated after the reversal is named in each month it moved.
//
// A CUSTOMER CHEQUE COUNTS IN THE MONTH THE BANK CASHED IT (MNE-001-507, #700;
// LIVA art. 1-B, second paragraph; no panel key, the law sets the day). Since
// MNE-001-556 the ledger holds its IVA in 2125 (an advance's in 2150, from
// MNE-001-558; #623 comment 6961035083) until `bank check reconcile --receipt`
// records the credit that cashed it, and the paper follows the ledger
// (`countedOn`): every event of a held cheque, its applications, unapplies,
// reversal and advance, counts on its own day or the cashing's, whichever is
// later, and in no month while no cashing is recorded. A cheque whose own
// entries caused its IVA before its cashing (one recorded before MNE-001-556,
// or in another currency) keeps its days, as its entries did. And no month
// settles while a held cheque possibly cashed in it has no cashing recorded
// (`checkFindings`): the month its account's statement covers with no open
// credit warns and settles; any other blocks.
//   · creditable — IVA acreditable PAID: the DIOT's facts (`hechosDelMes`), the
//                  one definition of "IVA paid" in this project. A third query
//                  for it would be the fourth definition. Plus the bank fees
//                  (MNE-001-566, `bank-fee-iva.ts`), which no bill carries: the
//                  charge is their payment (MNE-001-041), so their IVA counts
//                  in the month its entry moved 1130.
//
// The ledger holds ONE IVA line per document, so the split by rate comes from
// the document lines, through the DIOT's `desglosarDocumento`: the total is
// what the ledger moved and the rates only say how it is composed. Each side
// is then tied to the month's movement of its role account, read through
// report-service; a difference is a finding, never silently absorbed.
//
// A SALE BORN FROM ITS CFDI is split by the CFDI, not by its invoice_lines:
// the approval of an issued CFDI writes the lines without tax and keeps the
// IVA on the header, so the rates, the exempt base and the "no objeto" base
// (subtotal minus the bases the CFDI taxes) come from the CFDI's own summary.
//
// A PURCHASE can be split by its CFDI too (MNE-001-563): a bill approved from
// a draft under `lineas_factura_desde = poliza` has lines with no VAT, and
// `hechosDelMes` hands over the CFDI's lines for it (sat/diot/cfdi-split.ts).
//
// THE IVA WITHHELD BY CUSTOMERS follows the charged side on cash basis: the
// customer withholds when it pays (LIVA art. 1-A), so a PUE sale counts it in
// full and a PPD sale by the share collected in the month. The amount per
// document is what its own entry debited to iva_retenido_a_favor; the month's
// ledger debits are only a tie-out.
//
// A BLOCKING FINDING means a figure is missing: the workpaper then carries no
// settlement at all, so a number is never presented as declarable.
//
// ROUNDING TO PESOS is the panel's `declaracion_redondeo_a_pesos` (decided by
// the owner in MNE-001-004): every figure is first rounded to the cent from
// the ledger's four decimals, then to pesos by CFF art. 20 — 1 to 50 cents
// go down, 51 to 99 go up. That is the law, not "half up": 10.50 is 10.
//
// MIXED ACTIVITIES (MNE-001-385): when the reference period collected exempt
// or "no objeto" acts next to taxed ones, the IVA paid is credited only in the
// proportion the taxed acts bear to all of them. The panel's
// `iva_creditable_proration` picks the period: the month itself (LIVA art. 5
// fr. V inc. c, and inc. d num. 3 for investments; the default) or the prior
// calendar year (art. 5-B, text in force since its last reform, DOF
// 12-11-2021, re-read 2026-09-30). Either way the proportion multiplies ALL
// the IVA paid: the ledger does not say which expense serves only taxed acts
// (inc. a, credited whole) or only exempt ones (inc. b, not creditable), so
// the month's option overstates the credit for an exempt-only expense and
// understates it for a taxed-only one; the warning says so. The acts are the
// charged side's bases, read by the same `chargedOfMonth`, so the proportion
// and the IVA charged never disagree about what was collected. The prior year
// must be in the ledger whole: a ledger that starts after January of that year
// blocks instead of passing a few months off as the year's proportion.
//
// Nothing is filed: this computes a workpaper a person reviews and declares.
// ============================================================

/** The panel key. Its values are persisted: never rename them. */
export const FILING_ROUNDING_POLICY = 'declaracion_redondeo_a_pesos';

export type FilingRounding = 'cada_renglon' | 'solo_el_pago';

const KNOWN_ROUNDINGS: readonly FilingRounding[] = ['cada_renglon', 'solo_el_pago'];

/**
 * Reads the rounding of the entity. CLOSED ON DECLARING: a value this reader
 * does not know is named instead of falling back to the first option.
 */
export async function readFilingRounding(ctx: PolicyContext, client?: pg.PoolClient): Promise<FilingRounding> {
  const policy = await getPolicy(ctx, FILING_ROUNDING_POLICY, client);
  const value = KNOWN_ROUNDINGS.find((r) => r === policy.value);
  if (!value) {
    throw new AccountingError(
      'FILING_ROUNDING_UNKNOWN',
      `La política ${FILING_ROUNDING_POLICY} vale "${policy.value}" y este lector sólo ` +
        `entiende ${KNOWN_ROUNDINGS.join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return value;
}

/** The panel key of the proration. Its values are persisted: never rename them. */
export const CREDITABLE_PRORATION_POLICY = 'iva_creditable_proration';

export type CreditableProration = 'monthly' | 'annual';

const KNOWN_PRORATIONS: readonly CreditableProration[] = ['monthly', 'annual'];

/** Reads the proration of the entity, closed on declaring like the rounding. */
export async function readCreditableProration(
  ctx: PolicyContext,
  client?: pg.PoolClient
): Promise<CreditableProration> {
  const policy = await getPolicy(ctx, CREDITABLE_PRORATION_POLICY, client);
  const value = KNOWN_PRORATIONS.find((r) => r === policy.value);
  if (!value) {
    throw new AccountingError(
      'CREDITABLE_PRORATION_UNKNOWN',
      `La política ${CREDITABLE_PRORATION_POLICY} vale "${policy.value}" y este lector sólo ` +
        `entiende ${KNOWN_PRORATIONS.join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return value;
}

/** The ledger's four decimals to the cent, half up. */
export function toCents(amount: Decimal.Value): Decimal {
  return new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * CFF art. 20: amounts are adjusted to the nearest peso, 1–50 cents down and
 * 51–99 up. The cent comes first, so 10.5049 is 10.50 and goes DOWN to 10.
 * A negative amount is adjusted on its magnitude.
 */
export function roundToWhole(amount: Decimal.Value): Decimal {
  const cents = toCents(amount);
  const units = cents.abs().floor();
  const whole = cents.abs().minus(units).greaterThan('0.50') ? units.plus(1) : units;
  return cents.isNegative() ? whole.negated() : whole;
}

// ------------------------------------------------------------
// SETTLEMENT: the pure arithmetic, with both columns
// ------------------------------------------------------------

export interface IvaWorkpaperFigures {
  /** IVA trasladado collected in the month, by rate. Four decimals. */
  charged: Desglose;
  /** Base of the sales "no objeto" of IVA collected in the month (CFDI ObjetoImp 01). */
  chargedNotSubject: string;
  /** IVA acreditable paid in the month, by rate. Four decimals. */
  creditable: Desglose;
  /** IVA withheld BY customers (role iva_retenido_a_favor): subtracts. */
  withheldByCustomers: string;
  /** IVA the entity withheld and remits (role iva_retenido_por_pagar). Shown, not netted (#309). */
  withheldToRemit: string;
  /** Balance in favor from earlier periods applied this month. */
  priorBalanceInFavor: string;
  /** LIVA art. 5 fr. V. Null when the reference period collected no exempt or no objeto act. */
  proration: Proration | null;
}

export interface Proration {
  method: CreditableProration;
  /** The month (art. 5 fr. V inc. c) or the prior calendar year (art. 5-B) whose acts give the proportion. */
  reference: RangoDelMes;
  /** Bases collected at 16 %, 8 %, 0 % and any other rate. Four decimals. */
  taxedActs: string;
  /** Taxed acts plus the exempt and no objeto bases collected. Four decimals. */
  totalActs: string;
  /**
   * taxedActs / totalActs, shown to six decimals; the arithmetic uses the exact
   * quotient. How many decimals the Declaraciones y Pagos form captures is an
   * unverified premise, like the rounding's (see the key's rationale).
   */
  factor: string;
  /** IVA acreditable paid in the month, every rate. Four decimals. */
  paid: string;
  /** paid × taxedActs / totalActs: what is credited. Four decimals. */
  creditable: string;
}

/** Appended to the code of a finding raised by the reference year, not the month. */
export const REFERENCE_SUFFIX = '@REFERENCE';

/**
 * Findings of the prior year's documents, read for the art. 5-B proportion.
 * They keep their severity (a document without its split leaves the proportion
 * unknown) under a code of their own, so a consumer keyed on `codigo` tells
 * the reference year from the month being settled.
 */
export function referenceFindings(findings: readonly Hallazgo[], referenceYear: number): Hallazgo[] {
  return findings.map((h) => ({
    ...h,
    codigo: `${h.codigo}${REFERENCE_SUFFIX}`,
    mensaje: `Proporción del año ${referenceYear}: ${h.mensaje}`,
  }));
}

/**
 * Whether the ledger covers the whole reference year: its first posted entry
 * (the opening balance, when one was loaded) falls in January of that year or
 * earlier. The proportion is built from months, so a ledger that begins on
 * January 15 still has the year; one that begins in November has two months.
 */
export function coversReferenceYear(ledgerStart: string | null, referenceYear: number): boolean {
  return ledgerStart !== null && ledgerStart <= `${referenceYear}-01-31`;
}

/** The value of the acts collected: taxed at any rate, and exempt or no objeto. */
export function actsOf(charged: Desglose, notSubject: string): { taxed: Decimal; notTaxed: Decimal } {
  const taxed = [charged.tasa16, charged.tasa8, charged.tasa0, ...charged.otras]
    .reduce((acc, box) => acc.plus(box.base), new Decimal(0));
  return { taxed, notTaxed: new Decimal(charged.exento.base).plus(notSubject) };
}

/**
 * The proportion of LIVA art. 5 fr. V over the acts collected in `reference`.
 * No exempt or no objeto act there means nothing to prorate: null, and the
 * IVA paid is credited whole. The quotient is not rounded before it
 * multiplies: the law states a proportion, not a number of decimals.
 */
export function prorate(
  method: CreditableProration,
  reference: RangoDelMes,
  acts: { taxed: Decimal; notTaxed: Decimal },
  paid: string
): Proration | null {
  if (!acts.notTaxed.greaterThan(0)) return null;
  const total = acts.taxed.plus(acts.notTaxed);
  return {
    method,
    reference,
    taxedActs: q4(acts.taxed),
    totalActs: q4(total),
    factor: acts.taxed.dividedBy(total).toFixed(6),
    paid: q4(paid),
    creditable: q4(new Decimal(paid).times(acts.taxed).dividedBy(total)),
  };
}

export interface WorkpaperLine {
  /** Stable id: `charged.tasa16.iva`, `withheld_by_customers`, … */
  key: string;
  /** Traceable to the ledger: the four decimals rounded to the cent. */
  cents: string;
  /** What is captured: CFF art. 20. */
  whole: string;
  /** +1 adds to the tax payable, -1 subtracts, 0 is shown only. */
  sign: 1 | -1 | 0;
}

export interface IvaSettlement {
  lines: WorkpaperLine[];
  /** Positive: IVA payable. Negative: balance in favor. */
  resultCents: string;
  resultWhole: string;
}

function rateLines(side: 'charged' | 'creditable', d: Desglose, sign: 1 | -1 | 0): Array<[string, string, 1 | -1 | 0]> {
  const boxes: Array<[string, { base: string; iva: string }]> = [
    ['tasa16', d.tasa16], ['tasa8', d.tasa8], ['tasa0', d.tasa0], ['exento', d.exento],
    ...d.otras.map((o): [string, { base: string; iva: string }] => [`otras:${o.etiqueta}`, o]),
  ];
  return boxes.flatMap(([rate, box]): Array<[string, string, 1 | -1 | 0]> => [
    [`${side}.${rate}.base`, box.base, 0],
    [`${side}.${rate}.iva`, box.iva, sign],
  ]);
}

export function settleIva(f: IvaWorkpaperFigures, rounding: FilingRounding): IvaSettlement {
  const raw: Array<[string, string, 1 | -1 | 0]> = [
    ...rateLines('charged', f.charged, 1),
    ['charged.no_objeto.base', f.chargedNotSubject, 0],
    // Prorated, the IVA paid by rate is shown and only the credited share subtracts.
    ...rateLines('creditable', f.creditable, f.proration ? 0 : -1),
    ...(f.proration ? [['creditable.prorated', f.proration.creditable, -1] as [string, string, -1]] : []),
    ['withheld_by_customers', f.withheldByCustomers, -1],
    ['prior_balance_in_favor', f.priorBalanceInFavor, -1],
    ['withheld_to_remit', f.withheldToRemit, 0],
  ];
  const lines = raw.map(([key, amount, sign]) => ({
    key,
    cents: toCents(amount).toFixed(2),
    whole: roundToWhole(amount).toFixed(0),
    sign,
  }));
  const sum = (col: 'cents' | 'whole'): Decimal =>
    lines.reduce((acc, l) => acc.plus(new Decimal(l[col]).times(l.sign)), new Decimal(0));
  const resultCents = sum('cents');
  // cada_renglon: every captured line is already in pesos and the arithmetic
  // continues in whole numbers, as the portal does. solo_el_pago: the
  // arithmetic runs in cents and only the result is adjusted.
  const resultWhole = rounding === 'cada_renglon' ? sum('whole') : roundToWhole(resultCents);
  return { lines, resultCents: resultCents.toFixed(2), resultWhole: resultWhole.toFixed(0) };
}

// ------------------------------------------------------------
// THE CHARGED SIDE: invoices collected in the month
// ------------------------------------------------------------

interface InvoiceRow {
  id: string;
  invoice_number: string;
  tax_amount: string;
  total_amount: string;
  exchange_rate: string;
  terms: string | null;
  memo: string | null;
  cfdi_uuid: string | null;
  /** The invoice's own entry. */
  journal_entry_id: string | null;
  /** The customer payments whose allocations moved in the month (PPD). */
  payment_ids?: string[];
  applied_before?: string;
  applied_now?: string;
  vat_released?: string;
}

const INVOICE_COLUMNS = `i.id, i.invoice_number, i.tax_amount::text, i.total_amount::text,
  i.exchange_rate::text, i.terms, i.memo, i.cfdi_uuid, i.journal_entry_id::text AS journal_entry_id`;

/**
 * The IVA each sale's own entry debited to iva_retenido_a_favor: what the
 * customer withholds on that document, in functional currency. The role's
 * accounts are read as a set, so an account mapped twice counts once.
 */
async function withheldPerSale(
  client: pg.PoolClient,
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<{ id: string; withheld: string }>(
    `SELECT i.id, SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))::text AS withheld
       FROM invoices i
       JOIN journal_entry_lines jel ON jel.journal_entry_id = i.journal_entry_id
      WHERE i.entity_id = $1 AND i.id = ANY($2::uuid[])
        AND jel.account_id IN (SELECT account_id FROM account_roles
                                WHERE entity_id = $1 AND role = 'iva_retenido_a_favor')
      GROUP BY i.id`,
    [entityId, [...ids]]
  );
  return new Map(rows.map((r) => [r.id, r.withheld]));
}

/** An allocation that took cash from an advance (migration 333). */
const CARRIED_AN_ADVANCE = '(pa.advance_base_amount + pa.advance_iva_amount) > 0';
/**
 * MNE-001-462 · A receipt with a treatment: an unapply puts all its cash
 * back as that receipt's advance, its IVA still caused (the owner's «no
 * re-park»; `backAsAdvance`), so `advancesOfMonth` counts it in the unapply's
 * month and `cashOnAccountOfMonth` leaves the receipt out. The share it ends
 * is a share event like any other (`SHARE_EVENTS`). Every allocation that
 * carried an advance is one of these.
 */
const RETURNS_AS_ADVANCE = 'cp.advance_factor_type IS NOT NULL';

/**
 * MNE-001-507 · True for a cheque receipt `cp` whose own entries (its record
 * or an application) credited charged IVA before its cashing, or with none
 * recorded: one posted before MNE-001-556, or in another currency than the
 * functional one. The ledger caused that cheque's IVA on those days.
 */
const releasedBeforeCashing = (cp: string): string => `EXISTS (
         SELECT 1
           FROM journal_entries rje
           JOIN journal_entry_lines rjl ON rjl.journal_entry_id = rje.id
           JOIN account_roles rar ON rar.account_id = rjl.account_id AND rar.entity_id = rje.entity_id
                                 AND rar.qualifier IS NULL AND rar.role = '${reclassRoles('issued').to}'
          WHERE rje.entity_id = ${cp}.entity_id AND rje.source_id = ${cp}.id AND rje.status = 'posted'
            AND rje.source_type IN ('customer_payment', 'receipt_application')
            AND rjl.credit_amount > 0
            AND (${cp}.check_cashed_date IS NULL OR rje.entry_date < ${cp}.check_cashed_date))`;

/** A cheque whose IVA waits for its cashing (MNE-001-556): the ledger holds it until then. */
const heldUntilCashed = (cp: string): string => `(${cp}.payment_method = 'check' AND NOT ${releasedBeforeCashing(cp)})`;

/**
 * CONTRACT: the day on which the IVA workpaper (a SAT deliverable's source)
 * counts an event `day` of receipt `cp`. Its own day, except for a held
 * cheque: the later of it and the cashing's, as the cashing entry posts what
 * the earlier events held (LIVA art. 1-B, second paragraph), and NULL while no
 * cashing is recorded, so the event enters no month.
 */
const countedOn = (cp: string, day: string): string => `(CASE
         WHEN ${cp}.payment_method <> 'check' THEN ${day}
         WHEN ${releasedBeforeCashing(cp)} THEN ${day}
         WHEN ${cp}.check_cashed_date IS NULL THEN NULL
         ELSE GREATEST(${day}, ${cp}.check_cashed_date) END)`;

/**
 * MNE-001-510 (#701) · What a reversed receipt says happened to its money:
 * `not_collected`, `taken_back`, or `not_stated`. The stated cause decides
 * (MNE-001-509 at the reversal, MNE-001-511 later). A cheque with none, one
 * reversed before migration 327, reads `not_collected`, the default the
 * reversal gives a cheque: it is paid when it is cashed (LIVA art. 1-B,
 * second paragraph). Any other method with none is `not_stated`.
 */
const reversalCause = (alias: string): string =>
  `COALESCE(${alias}.reversal_cause, CASE WHEN ${alias}.payment_method = 'check' THEN 'not_collected' ELSE 'not_stated' END)`;
const REVERSAL_CAUSE = reversalCause('cp');

type ReversalReading = 'not_collected' | 'taken_back' | 'not_stated';

/**
 * A receipt counts unless it is void or reversed as never collected (#666,
 * rule 2): what was never received caused no IVA (LIVA art. 1-B). A receipt
 * taken back, or with no cause stated, keeps its IVA where it was collected
 * (rule 3).
 */
const RECEIPT_COUNTS = `cp.status <> 'void' AND NOT (cp.status = 'reversed' AND ${REVERSAL_CAUSE} = 'not_collected')`;

/**
 * An allocation its receipt's reversal closed: the reversal closes them and
 * marks the receipt in one transaction, so with the same NOW(). It is no undo
 * of its own: the reversal is, and rule 3 takes nothing out for it.
 */
const CLOSED_BY_REVERSAL = `(cp.status = 'reversed' AND pa.unapplied_at = cp.reversed_at)`;

/**
 * The reversal's day: its mirror's, as the ledger dates it, or `reversed_at`
 * where the receipt had no entry to mirror. Needs `MIRROR_OF_RECEIPT`.
 */
const REVERSED_ON = 'COALESCE(m.entry_date, cp.reversed_at::date)';
const MIRROR_OF_RECEIPT = `
         LEFT JOIN journal_entries o ON o.id = cp.journal_entry_id AND o.entity_id = $1
         LEFT JOIN journal_entries m ON m.id = o.reversed_by_entry_id AND m.entity_id = $1`;

/**
 * Every PPD share event of the receipts that count: an application on the
 * day its cash was applied, and an unapply, negative, on its own day. Both
 * ends of payment_allocations are scoped.
 *
 * MNE-001-510 · A reversal that keeps its IVA (rule 3) closes its allocations
 * with a `reset` on the reversal's day: it takes no share out, but the
 * invoice's cumulative goes back down by that cash, so a later collection of
 * the same invoice causes its own IVA (LIVA art. 1-B) instead of reading as
 * an overpayment. `ts` orders events of one day: the instant each was written.
 *
 * MNE-001-507 · Each event counts on `countedOn`: a held cheque's on its
 * cashing at the earliest, and none of its events while it has no cashing.
 */
const SHARE_EVENTS = `
       SELECT se.* FROM (
       SELECT pa.invoice_id, cp.id AS payment_id, pa.amount_applied AS amount,
              COALESCE(pa.iva_reclass_amount, 0) AS vat, ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')} AS on_day,
              'apply'::text AS kind, pa.created_at AS ts
         FROM payment_allocations pa
         JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
       UNION ALL
       SELECT pa.invoice_id, cp.id, -pa.amount_applied, -COALESCE(pa.iva_reclass_amount, 0),
              ${countedOn('cp', 'pa.unapplied_at::date')}, 'undo', pa.unapplied_at
         FROM payment_allocations pa
         JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
          AND pa.unapplied_at IS NOT NULL AND NOT ${CLOSED_BY_REVERSAL}
       UNION ALL
       SELECT pa.invoice_id, cp.id, -pa.amount_applied, 0, ${countedOn('cp', REVERSED_ON)}, 'reset', cp.reversed_at
         FROM payment_allocations pa
         JOIN customer_payments cp ON cp.id = pa.payment_id ${MIRROR_OF_RECEIPT}
        WHERE cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS} AND ${CLOSED_BY_REVERSAL}
       ) se WHERE se.on_day IS NOT NULL`;

/**
 * The receipt-side entries the charged side traces (`ar-ap-posting.ts`): a
 * receipt's own entry, its application and unapplication entries, and a
 * cheque's cashing entry (MNE-001-556), which moves what a held cheque's
 * events left in 2125 (MNE-001-507).
 */
const RECEIPT_SOURCES = [
  'customer_payment', 'receipt_application', 'receipt_unapplication', CUSTOMER_CHECK_CASHING_SOURCE,
] as const;

/** Every box of a split times `factor`: an undo gives back what its event put in. */
function scaled(d: Desglose, factor: Decimal.Value): Desglose {
  const box = (c: { base: string; iva: string }) => ({ base: q4(new Decimal(c.base).times(factor)), iva: q4(new Decimal(c.iva).times(factor)) });
  return {
    tasa16: box(d.tasa16), tasa8: box(d.tasa8), tasa0: box(d.tasa0), exento: box(d.exento),
    otras: d.otras.map((o) => ({ etiqueta: o.etiqueta, ...box(o) })),
  };
}

/** One advance's net in the month: collected (+), applied (−) and unapplied (+), as the allocations stored them. */
interface AdvanceOfMonth {
  id: string;
  payment_number: string;
  /** customer_payments.advance_factor_type: 'tasa', 'exento' or 'no_objeto'. */
  factor_type: string;
  tax_rate: string | null;
  base: string;
  iva: string;
}

/**
 * MNE-001-423 · The customer advances that moved 2120 in the month, each by
 * the events of its receipt there. Both ends of payment_allocations are
 * scoped; a void receipt or one reversed as never collected counts in no
 * month, and any other reversal leaves every month as it was (MNE-001-518,
 * MNE-001-510: the advance follows its receipt's cause). An advance by cheque
 * counts on its cashing (`countedOn`; MNE-001-558 records one).
 */
async function advancesOfMonth(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<AdvanceOfMonth[]> {
  const { rows } = await client.query<AdvanceOfMonth>(
    `WITH events AS (
       SELECT cp.id, cp.advance_base_amount AS base, cp.advance_iva_amount AS iva, ${countedOn('cp', 'cp.payment_date')} AS on_day
         FROM customer_payments cp
        WHERE cp.entity_id = $1
       UNION ALL
       SELECT cp.id, -pa.advance_base_amount, -pa.advance_iva_amount, ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')}
         FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND ${CARRIED_AN_ADVANCE}
       UNION ALL
       SELECT cp.id, pa.advance_base_amount, pa.advance_iva_amount, ${countedOn('cp', 'pa.unapplied_at::date')}
         FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND pa.unapplied_at IS NOT NULL AND ${RETURNS_AS_ADVANCE} AND NOT ${CLOSED_BY_REVERSAL}
     )
     SELECT cp.id, cp.payment_number, cp.advance_factor_type AS factor_type, cp.advance_tax_rate::text AS tax_rate,
            SUM(e.base)::text AS base, SUM(e.iva)::text AS iva
       FROM customer_payments cp
       JOIN events e ON e.id = cp.id
      WHERE cp.entity_id = $1 AND cp.advance_factor_type IS NOT NULL
        AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
        AND e.on_day >= $2::date AND e.on_day <= $3::date
      GROUP BY cp.id
      ORDER BY cp.payment_number`,
    [entityId, range.desde, range.hasta]
  );
  // MNE-001-462: the cash an unapply of the month put back that took no
  // advance comes back as one, split by the function unapply posted it with.
  // MNE-001-572: on its counted day, so a held cheque's counts on its cashing,
  // which is when the ledger causes it.
  const back = await client.query<{ id: string; plain: string }>(
    `SELECT cp.id, (pa.amount_applied - pa.advance_base_amount - pa.advance_iva_amount)::text AS plain
       FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE cp.entity_id = $1 AND ${RETURNS_AS_ADVANCE} AND ${RECEIPT_COUNTS}
        AND pa.unapplied_at IS NOT NULL AND NOT ${CLOSED_BY_REVERSAL}
        AND ${countedOn('cp', 'pa.unapplied_at::date')} BETWEEN $2::date AND $3::date
        AND pa.amount_applied > pa.advance_base_amount + pa.advance_iva_amount`,
    [entityId, range.desde, range.hasta]
  );
  return rows.flatMap((row) => {
    const treatment = storedAdvanceTreatment(row.factor_type, row.tax_rate);
    const plain = back.rows.filter((b) => b.id === row.id).map((b) => b.plain);
    const more = treatment && plain.length > 0 ? backAsAdvance(plain, treatment) : { base: '0', iva: '0' };
    const base = new Decimal(row.base).plus(more.base);
    const iva = new Decimal(row.iva).plus(more.iva);
    return base.isZero() && iva.isZero() ? [] : [{ ...row, base: base.toFixed(4), iva: iva.toFixed(4) }];
  });
}

/** An advance's net in the box of the treatment it was recorded with; a not-subject one is no-objeto base. */
function advanceBreakdown(a: Pick<AdvanceOfMonth, 'factor_type' | 'tax_rate' | 'base' | 'iva'>): { breakdown: Desglose; notSubject: Decimal } {
  const breakdown = desgloseCero();
  const box = { base: q4(a.base), iva: q4(a.iva) };
  if (a.factor_type === 'no_objeto') return { breakdown, notSubject: new Decimal(a.base) };
  if (a.factor_type === 'exento') {
    breakdown.exento = box;
  } else {
    const rate = new Decimal(a.tax_rate ?? '0');
    if (rate.equals(16)) breakdown.tasa16 = box;
    else if (rate.equals(8)) breakdown.tasa8 = box;
    else if (rate.isZero()) breakdown.tasa0 = box;
    else breakdown.otras = [{ etiqueta: rate.toFixed(2), ...box }];
  }
  return { breakdown, notSubject: new Decimal(0) };
}

/** Each receipt's own, application, unapplication and cheque cashing entries posted in the month, by receipt. */
async function receiptEntriesOfMonth(
  client: pg.PoolClient,
  entityId: string,
  paymentIds: readonly string[],
  range: RangoDelMes
): Promise<Map<string, string[]>> {
  if (paymentIds.length === 0) return new Map();
  const { rows } = await client.query<{ payment_id: string; entries: string[] }>(
    `SELECT je.source_id::text AS payment_id, array_agg(je.id::text ORDER BY je.entry_date, je.entry_number) AS entries
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.source_id = ANY($2::uuid[]) AND je.source_type = ANY($3::text[])
        AND je.status = 'posted' AND je.entry_date >= $4::date AND je.entry_date <= $5::date
      GROUP BY je.source_id`,
    [entityId, [...paymentIds], [...RECEIPT_SOURCES], range.desde, range.hasta]
  );
  return new Map(rows.map((r) => [r.payment_id, r.entries]));
}

/** What a PPD invoice's split needs, cached per invoice: its row, whether it is PPD, and its lines. */
async function ppdSalesOf(
  client: pg.PoolClient,
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, { row: InvoiceRow; source: SaleSource }>> {
  const out = new Map<string, { row: InvoiceRow; source: SaleSource }>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices i WHERE i.entity_id = $1 AND i.id = ANY($2::uuid[])`,
    [entityId, [...ids]]
  );
  const ppd: InvoiceRow[] = [];
  for (const row of rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo === 'PPD') ppd.push(row);
  }
  const sources = await saleSources(client, entityId, ppd.map((r) => r.id));
  for (const row of ppd) out.set(row.id, { row, source: sources.get(row.id) ?? { lines: [], notSubject: q4(0), fromCfdi: false } });
  return out;
}

/** One receipt's cash on account in the month (MNE-001-518): back from an unapply (+), taken by an application (−). */
interface CashOnAccountOfMonth {
  paymentId: string;
  breakdown: Desglose;
  notSubject: Decimal;
  /** The IVA the month's unapplies put back on account, and the IVA its applications took from there. */
  back: Decimal;
  taken: Decimal;
  /** MNE-001-507 · the part of `back` a held cheque's share ended before its cashing never released in the ledger. */
  neverReleased: Decimal;
}

interface AllocationEventRow {
  payment_id: string;
  payment_amount: string;
  advance_total: string;
  invoice_id: string;
  amount: string;
  vat: string;
  advance_taken: string;
  /** The days the paper counts each event on (`countedOn`), and the days they were dated. */
  applied_day: string;
  undone_day: string | null;
  dated_applied: string;
  dated_undone: string | null;
  /** A cheque whose IVA waited for its cashing (MNE-001-556). */
  held: boolean;
  /** What the invoice had applied just before the unapply, its own application included. */
  applied_before_undo: string | null;
}

/**
 * MNE-001-518 (#666, rule 1) · An unapply moves no money: the cash stays with
 * the firm, so its IVA stays caused (LIVA art. 1-B). The unapply's month takes
 * out the PPD share and lists the same cash back on account, already taxed,
 * netting 0; a later application of that cash nets it out again, the way an
 * advance is netted (MNE-001-423). A receipt with a treatment is left whole
 * to `advancesOfMonth` (MNE-001-462, «no re-park»): an unapply puts all its
 * cash back as that receipt's advance, and a later application takes it from
 * the advance, so counting it here too would count the cash back twice.
 *
 * Each receipt is replayed in the order of its events, unapplies first on a
 * day, because an application cannot take cash an unapply has not returned.
 * An application takes first the cash on account that carries no IVA, then
 * that taxed cash, as `takeFromAdvance` takes plain cash before an advance.
 *
 * MNE-001-507 · A held cheque's events count on its cashing at the earliest
 * (`countedOn`), in the order they were dated. A share it ended before the
 * cashing released nothing, so the cash back on account carries the IVA the
 * share would have caused: the cashing is when that cash was collected, and
 * cash held on account is taxed the day it is collected (LIVA art. 1-B).
 */
async function cashOnAccountOfMonth(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<CashOnAccountOfMonth[]> {
  const { rows } = await client.query<AllocationEventRow>(
    `WITH events AS (${SHARE_EVENTS}
     )
     SELECT pa.payment_id::text, cp.payment_amount::text,
            (COALESCE(cp.advance_base_amount, 0) + COALESCE(cp.advance_iva_amount, 0))::text AS advance_total,
            pa.invoice_id::text, pa.amount_applied::text AS amount, COALESCE(pa.iva_reclass_amount, 0)::text AS vat,
            (pa.advance_base_amount + pa.advance_iva_amount)::text AS advance_taken,
            d.applied::text AS applied_day, d.undone::text AS undone_day,
            COALESCE(pa.applied_on, cp.payment_date)::text AS dated_applied,
            CASE WHEN d.undone IS NULL THEN NULL ELSE pa.unapplied_at::date::text END AS dated_undone,
            ${heldUntilCashed('cp')} AS held,
            CASE WHEN d.undone IS NULL THEN NULL ELSE (
              SELECT COALESCE(SUM(e.amount), 0) FROM events e
               WHERE e.invoice_id = pa.invoice_id
                 AND (e.on_day < d.undone OR (e.on_day = d.undone AND e.amount > 0))
            )::text END AS applied_before_undo
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1
      CROSS JOIN LATERAL (
        SELECT ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')} AS applied,
               CASE WHEN pa.unapplied_at IS NULL OR ${CLOSED_BY_REVERSAL} THEN NULL
                    ELSE ${countedOn('cp', 'pa.unapplied_at::date')} END AS undone
      ) d
      WHERE cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
        AND NOT ${RETURNS_AS_ADVANCE}
        AND d.applied <= $2::date
        AND EXISTS (SELECT 1 FROM payment_allocations u
                     WHERE u.payment_id = cp.id AND u.unapplied_at IS NOT NULL
                       AND ${countedOn('cp', 'u.unapplied_at::date')} <= $2::date
                       AND (u.advance_base_amount + u.advance_iva_amount) = 0
                       AND NOT (cp.status = 'reversed' AND u.unapplied_at = cp.reversed_at))
      ORDER BY pa.payment_id, applied_day, pa.created_at`,
    [entityId, range.hasta]
  );
  if (rows.length === 0) return [];
  const sales = await ppdSalesOf(client, entityId, [...new Set(rows.filter((r) => r.undone_day).map((r) => r.invoice_id))]);

  const byReceipt = new Map<string, AllocationEventRow[]>();
  for (const r of rows) byReceipt.set(r.payment_id, [...(byReceipt.get(r.payment_id) ?? []), r]);
  const out: CashOnAccountOfMonth[] = [];
  for (const [paymentId, allocations] of byReceipt) {
    let onAccount = new Decimal(allocations[0].payment_amount);
    let advanceLeft = new Decimal(allocations[0].advance_total);
    let pool = { cash: new Decimal(0), breakdown: desgloseCero(), notSubject: new Decimal(0) };
    const month: CashOnAccountOfMonth = {
      paymentId, breakdown: desgloseCero(), notSubject: new Decimal(0), back: new Decimal(0), taken: new Decimal(0),
      neverReleased: new Decimal(0),
    };
    const order = (x: string, y: string): number => (x === y ? 0 : x < y ? -1 : 1);
    const events = allocations
      .flatMap((a) => [
        { day: a.applied_day, dated: a.dated_applied, undo: false, a },
        ...(a.undone_day ? [{ day: a.undone_day, dated: a.dated_undone ?? a.undone_day, undo: true, a }] : []),
      ])
      .filter((e) => e.day <= range.hasta)
      .sort((x, y) => order(x.day, y.day) || order(x.dated, y.dated) || Number(!x.undo) - Number(!y.undo));
    let touched = false;
    for (const { day, undo, a } of events) {
      const inMonth = day >= range.desde;
      const amount = new Decimal(a.amount);
      const advanceTaken = new Decimal(a.advance_taken);
      if (undo) {
        onAccount = onAccount.plus(amount);
        advanceLeft = advanceLeft.plus(advanceTaken);
        const sale = sales.get(a.invoice_id);
        if (advanceTaken.greaterThan(0) || !sale) continue;
        // The ended share, read the way the invoice's own telescope reads it.
        const share = {
          aplicadoPrevio: q4(new Decimal(a.applied_before_undo ?? '0').minus(amount)),
          aplicadoAhora: q4(amount),
          totalDocumento: sale.row.total_amount,
          tasaCambio: sale.row.exchange_rate,
        };
        // A held cheque's share ended before its cashing stored 0: the IVA it
        // carries is the share's own, the invoice's telescope read here.
        const unreleased = a.held && new Decimal(a.vat).isZero();
        const vat = unreleased
          ? new Decimal(acumuladoDelDocumento(sale.row.tax_amount, new Decimal(share.aplicadoPrevio).plus(amount).toFixed(4), sale.row.total_amount, sale.row.exchange_rate))
              .minus(acumuladoDelDocumento(sale.row.tax_amount, share.aplicadoPrevio, sale.row.total_amount, sale.row.exchange_rate))
          : new Decimal(a.vat);
        const split = desglosarDocumento({
          documentId: sale.row.id, documentNumber: sale.row.invoice_number, renglones: sale.source.lines,
          ivaCabecera: sale.row.tax_amount, ivaPagado: q4(vat), porcion: share, politicaBaseExenta: 'exigir_base', documentKind: 'invoice',
        }).desglose;
        const notSubject = new Decimal(porcionDelDocumento(sale.source.notSubject, share));
        pool = { cash: pool.cash.plus(amount), breakdown: sumarDesgloses(pool.breakdown, split), notSubject: pool.notSubject.plus(notSubject) };
        if (inMonth) {
          touched = true;
          month.breakdown = sumarDesgloses(month.breakdown, split);
          month.notSubject = month.notSubject.plus(notSubject);
          month.back = month.back.plus(ivaDelDesglose(split));
          if (unreleased) month.neverReleased = month.neverReleased.plus(ivaDelDesglose(split));
        }
        continue;
      }
      const untaxed = Decimal.max(onAccount.minus(advanceLeft).minus(pool.cash), 0);
      const take = advanceTaken.greaterThan(0) ? new Decimal(0) : Decimal.min(Decimal.max(amount.minus(untaxed), 0), pool.cash);
      onAccount = onAccount.minus(amount);
      advanceLeft = advanceLeft.minus(advanceTaken);
      if (!take.greaterThan(0)) continue;
      const whole = take.equals(pool.cash);
      const ratio = whole ? new Decimal(1) : take.dividedBy(pool.cash);
      const part = whole ? pool.breakdown : scaled(pool.breakdown, ratio);
      const partNotSubject = whole ? pool.notSubject : new Decimal(q4(pool.notSubject.times(ratio)));
      pool = {
        cash: pool.cash.minus(take),
        breakdown: sumarDesgloses(pool.breakdown, scaled(part, -1)),
        notSubject: pool.notSubject.minus(partNotSubject),
      };
      if (inMonth) {
        touched = true;
        month.breakdown = sumarDesgloses(month.breakdown, scaled(part, -1));
        month.notSubject = month.notSubject.minus(partNotSubject);
        month.taken = month.taken.plus(ivaDelDesglose(part));
      }
    }
    if (touched) out.push(month);
  }
  return out;
}

/**
 * What every receipt put into the month's charged IVA, as the paper counted
 * it: its PPD shares, its advance and its taxed cash on account. The tie-out
 * compares it, receipt by receipt, with what the receipt's entries moved.
 */
async function sharesIvaByReceipt(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<Map<string, Decimal>> {
  const { rows } = await client.query<{ payment_id: string; vat: string }>(
    `WITH events AS (${SHARE_EVENTS}
     )
     SELECT e.payment_id::text, SUM(e.vat)::text AS vat
       FROM events e JOIN invoices i ON i.id = e.invoice_id AND i.entity_id = $1
      WHERE e.on_day >= $2::date AND e.on_day <= $3::date AND i.status NOT IN ('void', 'cancelled')
      GROUP BY e.payment_id`,
    [entityId, range.desde, range.hasta]
  );
  return new Map(rows.map((r) => [r.payment_id, new Decimal(r.vat)]));
}

/** One entry of a receipt in the month, with what it moved in iva_trasladado (credit positive). */
interface ReceiptLedgerRow {
  payment_id: string;
  payment_number: string;
  status: string;
  payment_method: string;
  /** MNE-001-510 · `REVERSAL_CAUSE`, read on a reversed receipt only. */
  cause: ReversalReading;
  entry_number: string;
  entry_date: string;
  source_type: string;
  mirror: boolean;
  iva: string;
}

/** The receipt sources the ledger side reads: the charged side's, a cheque's cashing included. */
const RECEIPT_LEDGER_SOURCES = [...RECEIPT_SOURCES];

/**
 * Every customer receipt's entries posted in the month, its reversal's mirrors
 * included, each with what it moved in 2120. NOTE: a movement per entry, not a
 * balance per account, so report-service's trial balance cannot give it; it is
 * one more copy that criterion `single-report-query-layer` (E4.2) counts.
 */
async function receiptLedgerOfMonth(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<ReceiptLedgerRow[]> {
  const { rows } = await client.query<ReceiptLedgerRow>(
    `WITH own AS (
       SELECT je.id, je.source_id AS payment_id, je.reversed_by_entry_id
         FROM journal_entries je
        WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_type = ANY($4::text[])
          AND ((je.entry_date >= $2::date AND je.entry_date <= $3::date) OR je.reversed_by_entry_id IS NOT NULL)
     ), touched AS (
       SELECT payment_id, id, false AS mirror FROM own
       UNION ALL
       SELECT payment_id, reversed_by_entry_id, true FROM own WHERE reversed_by_entry_id IS NOT NULL
     )
     SELECT t.payment_id::text, cp.payment_number, cp.status, cp.payment_method, ${REVERSAL_CAUSE} AS cause, je.entry_number,
            je.entry_date::text AS entry_date, je.source_type, t.mirror,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0))
                     FILTER (WHERE jel.account_id IN (SELECT account_id FROM account_roles
                                                    WHERE entity_id = $1 AND role = 'iva_trasladado')), 0)::text AS iva
       FROM touched t
       JOIN journal_entries je ON je.id = t.id AND je.entity_id = $1 AND je.status = 'posted'
       JOIN customer_payments cp ON cp.id = t.payment_id AND cp.entity_id = $1
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
      GROUP BY t.payment_id, cp.payment_number, cp.status, cp.payment_method, cp.reversal_cause, je.id, je.entry_number, je.entry_date, je.source_type, t.mirror
      ORDER BY cp.payment_number, je.entry_date, je.entry_number`,
    [entityId, range.desde, range.hasta, RECEIPT_LEDGER_SOURCES]
  );
  return rows;
}

const ENTRY_KIND: Record<string, string> = {
  customer_payment: 'cobro',
  receipt_application: 'aplicación',
  receipt_unapplication: 'desaplicación',
  [CUSTOMER_CHECK_CASHING_SOURCE]: 'cobro del cheque',
};

/** One receipt's (or a cancelled credit note's) share of the charged side's gap with the ledger, and why. */
interface GapCause {
  amount: Decimal;
  text: string;
}

/**
 * MNE-001-518 (#666, rule 4) · Each receipt whose IVA in the paper differs from
 * what its own entries moved in 2120 that month, named with those entries and
 * the rule that tells them apart. Silent where the two agree.
 */
function gapCauses(charged: ChargedOfMonth, ledger: readonly ReceiptLedgerRow[]): GapCause[] {
  const byReceipt = new Map<string, ReceiptLedgerRow[]>();
  for (const r of ledger) byReceipt.set(r.payment_id, [...(byReceipt.get(r.payment_id) ?? []), r]);
  const causes: GapCause[] = [];
  for (const [paymentId, entries] of byReceipt) {
    const paper = charged.ivaByReceipt.get(paymentId) ?? new Decimal(0);
    const moved = entries.reduce((s, e) => s.plus(e.iva), new Decimal(0));
    const amount = paper.minus(moved);
    if (amount.abs().lessThanOrEqualTo('0.01')) continue;
    const head = entries[0];
    const named = entries.filter((e) => !new Decimal(e.iva).isZero());
    const list = (named.length ? named : entries)
      .map((e) => `${e.mirror ? 'espejo de reversa' : ENTRY_KIND[e.source_type] ?? e.source_type} ${e.entry_number} del ${e.entry_date}`)
      .join(', ');
    const why: string[] = [];
    if (head.status === 'reversed' && head.cause === 'not_collected') {
      why.push(
        head.payment_method === 'check'
          ? 'es un cheque reversado, que no cuenta en ningún mes (LIVA art. 1-B, segundo párrafo; ver IVA-WP-RECEIPT-REVERSED)'
          : 'se reversó como no cobrado, y no cuenta en ningún mes (LIVA art. 1-B; ver IVA-WP-RECEIPT-REVERSED)'
      );
    } else if (head.status === 'reversed' && entries.some((e) => e.mirror)) {
      why.push(
        head.cause === 'taken_back'
          ? 'se reversó como retirado, y su IVA sólo sale con una restitución del art. 7 LIVA, una nota de crédito emitida, que el papel resta en el mes de su póliza (ver IVA-WP-RECEIPT-REVERSED)'
          : 'su reversa no tiene causa declarada, y el papel deja su IVA donde se cobró hasta que se declare (ver IVA-WP-RECEIPT-REVERSED)'
      );
    }
    const cash = charged.cashOnAccount.get(paymentId);
    const reparked = cash ? cash.back.minus(cash.neverReleased) : new Decimal(0);
    if (reparked.greaterThan(0)) {
      why.push(
        `desaplicar no devuelve el dinero: el IVA de ${q4(reparked)} sigue causado mientras el efectivo siga a cuenta ` +
          `(LIVA art. 1-B), y el mayor lo re-aparcó en iva_trasladado_no_cobrado`
      );
    }
    if (cash && cash.neverReleased.greaterThan(0)) {
      why.push(
        `el cheque se desaplicó antes de cobrarse y el efectivo sigue a cuenta: el papel causa su IVA de ` +
          `${q4(cash.neverReleased)} el día del cobro (LIVA art. 1-B, segundo párrafo), y el cobro del cheque no lo ` +
          `movió en el mayor porque no tenía una factura que liberar`
      );
    }
    if (cash && cash.taken.greaterThan(0)) {
      why.push(`la aplicación toma efectivo a cuenta cuyo IVA de ${q4(cash.taken)} ya se causó, y el mayor lo vuelve a causar`);
    }
    causes.push({
      amount,
      text: `${head.payment_number} (el papel cuenta ${q4(paper)} y sus pólizas mueven ${q4(moved)}: ${list})` +
        (why.length ? `: ${why.join('; ')}` : ''),
    });
  }
  return causes;
}

interface ReversedReceiptRow {
  id: string;
  payment_number: string;
  payment_method: string;
  payment_date: string;
  /** The day its advance counts on (`countedOn`): null for a held cheque with no cashing. */
  collected_on: string | null;
  advance_base: string;
  advance_iva: string;
  mirror_number: string | null;
  reversed_on: string;
  cause: ReversalReading;
  /** The day a cause was stated after the reversal (MNE-001-511); null when it came with it, or none was. */
  stated_on: string | null;
}

interface ReversedAllocationRow extends InvoiceRow {
  payment_id: string;
  gross: string;
  vat: string;
  advance_base: string;
  advance_iva: string;
  /** `countedOn`: null for a held cheque with no cashing. */
  applied_day: string | null;
  undone_day: string | null;
}

/** An invoice a reversal that kept its IVA reopened, collected again in the month by another receipt. */
interface CollectedAgainRow {
  reversed_id: string;
  invoice_number: string;
  payment_number: string;
}

/** How a finding names a receipt's cause, with the identifier the CLI takes. */
const CAUSE_LABEL: Record<ReversalReading, string> = {
  not_collected: 'con la causa not_collected (no cobrado)',
  taken_back: 'con la causa taken_back (retirado)',
  not_stated: 'sin causa declarada',
};

/**
 * MNE-001-518 (#666, rules 2 to 4) and MNE-001-510 (#701) · A reversed
 * receipt, named in each month it counted in (or would have), in the month
 * its mirrors moved 2120, and in a month that collects again an invoice it
 * reopened. Its cause decides (`REVERSAL_CAUSE`):
 *   - not_collected: the money never became the firm's, so it caused no IVA
 *     (LIVA art. 1-B; a cheque, at its cashing, second paragraph). It counts
 *     in no month, and a filed return is corrected by an amended one (CFF
 *     art. 32).
 *   - taken_back: the money arrived, so its IVA was caused and stays; it
 *     leaves only by a restitution with the document of art. 7's second
 *     paragraph (RLIVA art. 24): an issued credit note, which the paper
 *     counts in the month its entry moves 2120 (MNE-001-565).
 *   - not_stated: kept where it was collected until `receipt cause record`
 *     states a cause; both findings name the command.
 * A cause stated after the reversal is a later event (rule 4): each month it
 * moved names it, with what it took out.
 *
 * The figures named are the ones the paper counts for the receipt: a PPD
 * share's base is its cash, withholding included, less its IVA.
 */
async function reversalFindings(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes,
  ledger: readonly ReceiptLedgerRow[]
): Promise<Hallazgo[]> {
  // Both ends of each payment_allocations bridge are scoped.
  const again = await client.query<CollectedAgainRow>(
    `SELECT DISTINCT r.id::text AS reversed_id, i.invoice_number, cp.payment_number
       FROM customer_payments r
       JOIN payment_allocations ra ON ra.payment_id = r.id AND ra.unapplied_at = r.reversed_at
       JOIN invoices i ON i.id = ra.invoice_id AND i.entity_id = $1
       JOIN payment_allocations pa ON pa.invoice_id = ra.invoice_id AND pa.created_at > r.reversed_at
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
      WHERE r.entity_id = $1 AND r.status = 'reversed' AND r.journal_entry_id IS NOT NULL
        AND ${reversalCause('r')} <> 'not_collected'
        AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
        AND ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')} BETWEEN $2::date AND $3::date
      ORDER BY i.invoice_number, cp.payment_number`,
    [entityId, range.desde, range.hasta]
  );
  const reversed = await client.query<ReversedReceiptRow>(
    `SELECT cp.id::text, cp.payment_number, cp.payment_method, cp.payment_date::text AS payment_date,
            ${countedOn('cp', 'cp.payment_date')}::text AS collected_on,
            COALESCE(cp.advance_base_amount, 0)::text AS advance_base, COALESCE(cp.advance_iva_amount, 0)::text AS advance_iva,
            m.entry_number AS mirror_number, ${REVERSED_ON}::text AS reversed_on, ${REVERSAL_CAUSE} AS cause,
            CASE WHEN cp.reversal_cause_stated_at > cp.reversed_at THEN cp.reversal_cause_stated_at::date::text END AS stated_on
       FROM customer_payments cp ${MIRROR_OF_RECEIPT}
      WHERE cp.entity_id = $1 AND cp.status = 'reversed' AND cp.journal_entry_id IS NOT NULL
        AND (${REVERSED_ON} >= $2::date OR cp.id = ANY($3::uuid[]))
      ORDER BY cp.payment_number`,
    [entityId, range.desde, [...new Set(again.rows.map((r) => r.reversed_id))]]
  );
  if (reversed.rows.length === 0) return [];
  const allocations = await client.query<ReversedAllocationRow>(
    `SELECT ${INVOICE_COLUMNS}, pa.payment_id::text,
            (pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)::text AS gross,
            COALESCE(pa.iva_reclass_amount, 0)::text AS vat,
            pa.advance_base_amount::text AS advance_base, pa.advance_iva_amount::text AS advance_iva,
            ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')}::text AS applied_day,
            CASE WHEN pa.unapplied_at IS NULL OR ${CLOSED_BY_REVERSAL} THEN NULL
                 ELSE ${countedOn('cp', 'pa.unapplied_at::date')}::text END AS undone_day
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1
      WHERE pa.payment_id = ANY($2::uuid[])`,
    [entityId, reversed.rows.map((r) => r.id)]
  );
  const ppd = new Map<string, boolean>();
  // By month (YYYY-MM): the base and IVA the receipt counts there, or would, had it been collected.
  const counted = new Map<string, Map<string, { base: Decimal; iva: Decimal }>>();
  // A held cheque's event with no cashing recorded (`countedOn` NULL) counts in no month (MNE-001-507).
  const add = (id: string, day: string | null, base: Decimal.Value, iva: Decimal.Value, sign: 1 | -1) => {
    if (day === null) return;
    const months = counted.get(id) ?? new Map<string, { base: Decimal; iva: Decimal }>();
    const m = months.get(day.slice(0, 7)) ?? { base: new Decimal(0), iva: new Decimal(0) };
    months.set(day.slice(0, 7), { base: m.base.plus(new Decimal(base).times(sign)), iva: m.iva.plus(new Decimal(iva).times(sign)) });
    counted.set(id, months);
  };
  for (const r of reversed.rows) {
    if (!new Decimal(r.advance_base).plus(r.advance_iva).isZero()) add(r.id, r.collected_on, r.advance_base, r.advance_iva, 1);
  }
  for (const a of allocations.rows) {
    if (!ppd.has(a.id)) ppd.set(a.id, (await resolveInvoiceMetodoPago(client, { ...a, entity_id: entityId })).metodo === 'PPD');
    const events: Array<[string | null, 1 | -1]> = [[a.applied_day, 1], ...(a.undone_day ? [[a.undone_day, -1] as [string, 1 | -1]] : [])];
    for (const [day, sign] of events) {
      if (ppd.get(a.id)) add(a.payment_id, day, new Decimal(a.gross).minus(a.vat), a.vat, sign);
      add(a.payment_id, day, a.advance_base, a.advance_iva, sign === 1 ? -1 : 1);
    }
  }

  const month = range.desde.slice(0, 7);
  const findings: Hallazgo[] = [];
  for (const r of reversed.rows) {
    const months = counted.get(r.id) ?? new Map<string, { base: Decimal; iva: Decimal }>();
    const live = [...months].filter(([, v]) => !v.base.isZero() || !v.iva.isZero()).map(([m]) => m).sort();
    const here = months.get(month);
    const mirrored = ledger
      .filter((e) => e.payment_id === r.id && e.mirror)
      .reduce((s, e) => s.plus(e.iva), new Decimal(0));
    const countsHere = here !== undefined && (!here.base.isZero() || !here.iva.isZero());
    const collectedAgain = again.rows.filter((g) => g.reversed_id === r.id);
    if (!countsHere && mirrored.isZero() && collectedAgain.length === 0) continue;
    const byCheck = r.payment_method === 'check';
    const entry = r.mirror_number ? `póliza ${r.mirror_number}` : 'sin póliza espejo';
    const before = live.filter((m) => m !== month);
    const kept = before.join(', ') || live.join(', ') || r.payment_date.slice(0, 7);
    const parts: string[] = [];
    if (countsHere && r.cause === 'not_collected') {
      parts.push(
        byCheck
          ? `El cobro ${r.payment_number}, con cheque, se reversó el ${r.reversed_on} (${entry}): este mes ya no cuenta su base ` +
              `${q4(here.base)} ni su IVA ${q4(here.iva)}, porque un cheque devuelto no se cobró (LIVA art. 1-B, segundo párrafo). ` +
              `Si la declaración de ${month} ya se presentó, se corrige con una declaración complementaria (CFF art. 32); si ya no ` +
              `puede corregirse, o si el cheque se transmitió a un tercero (salvo en procuración), lo decide una persona.`
          : `El cobro ${r.payment_number} (${r.payment_method}) se reversó el ${r.reversed_on} (${entry}) ${CAUSE_LABEL[r.cause]}: ` +
              `este mes ya no cuenta su base ${q4(here.base)} ni su IVA ${q4(here.iva)}, porque el dinero nunca llegó y lo que no ` +
              `se cobra no causa IVA (LIVA art. 1-B). Si la declaración de ${month} ya se presentó, se corrige con una ` +
              `declaración complementaria (CFF art. 32).` +
              (['credit_card', 'debit_card'].includes(r.payment_method)
                ? ' Una tarjeta se paga cuando se acepta (LIVA art. 1-B, último párrafo): confirma que el cargo nunca se aceptó.'
                : '')
      );
    } else if (countsHere && r.cause === 'taken_back') {
      parts.push(
        `El cobro ${r.payment_number} (${r.payment_method}) se reversó el ${r.reversed_on} (${entry}) ${CAUSE_LABEL[r.cause]}: ` +
          `el dinero llegó y se retiró después, así que este mes conserva su base ${q4(here.base)} y su IVA ${q4(here.iva)} ` +
          `(LIVA art. 1-B). Ese IVA sólo sale con una restitución del art. 7 LIVA, en el mes en que se restituya: una nota ` +
          `de crédito emitida, que el papel resta en ese mes.`
      );
    } else if (countsHere) {
      parts.push(
        `El cobro ${r.payment_number} (${r.payment_method}) se reversó el ${r.reversed_on} (${entry}) ${CAUSE_LABEL[r.cause]}: ` +
          `este mes conserva su base ${q4(here.base)} y su IVA ${q4(here.iva)} hasta que se declare. Si el dinero nunca llegó, ` +
          `la declaración de ${month} se corrige con una complementaria (CFF art. 32); si llegó y se retiró, el IVA sólo sale ` +
          `con una restitución del art. 7 LIVA.`
      );
    }
    if (!mirrored.isZero()) {
      if (r.cause === 'not_collected') {
        const how = byCheck ? ', con cheque' : ` (${r.payment_method}, ${CAUSE_LABEL[r.cause]})`;
        parts.push(
          `El espejo de la reversa del cobro ${r.payment_number}${how} (${entry}, ${r.reversed_on}) mueve ` +
            `${q4(mirrored)} de IVA trasladado este mes y el papel no lo cuenta: el cobro no cuenta en ningún mes.` +
            (before.length ? ` Contaba en ${before.join(', ')}: si esa declaración ya se presentó, se corrige con una complementaria.` : '')
        );
      } else if (r.cause === 'taken_back') {
        parts.push(
          `La reversa del cobro ${r.payment_number} (${r.payment_method}, ${CAUSE_LABEL[r.cause]}, ${entry}, ${r.reversed_on}) no ` +
            `saca IVA este mes, aunque su espejo mueve ${q4(mirrored)} de IVA trasladado: el dinero llegó y el IVA sigue en ` +
            `${before.join(', ') || month}. Sólo sale con una restitución del art. 7 LIVA, el documento de su segundo párrafo que ` +
            `hace constar que el impuesto se restituyó, con los datos del comprobante de la operación original (RLIVA art. 24): ` +
            `una nota de crédito emitida, que el papel resta en el mes de su póliza; mientras no se emita, el papel no cuenta ` +
            `ninguna restitución.`
        );
      } else {
        parts.push(
          `La reversa del cobro ${r.payment_number} (${r.payment_method}, ${CAUSE_LABEL[r.cause]}, ${entry}, ${r.reversed_on}) no ` +
            `saca IVA este mes, aunque su espejo mueve ${q4(mirrored)} de IVA trasladado: el IVA sigue en ` +
            `${before.join(', ') || month} hasta que se declare la causa.`
        );
      }
    }
    if (collectedAgain.length > 0) {
      const invoices = [...new Set(collectedAgain.map((g) => g.invoice_number))].join(', ');
      const receipts = [...new Set(collectedAgain.map((g) => g.payment_number))].join(', ');
      parts.push(
        `La factura ${invoices}, que el cobro ${r.payment_number} había cobrado y que su reversa del ${r.reversed_on} ` +
          `${CAUSE_LABEL[r.cause]} reabrió, se cobra otra vez este mes con ${receipts}: este mes cuenta ese cobro completo, ` +
          `porque el anterior dejó su IVA en ${kept}` +
          (r.cause === 'taken_back'
            ? ', y mientras no se emita una nota de crédito, la restitución del art. 7 LIVA, el papel no cuenta ninguna por él.'
            : ' hasta que se declare su causa: con not_collected sale de ahí (complementaria); con taken_back, sólo con una ' +
              'restitución del art. 7 LIVA.')
      );
    }
    if (r.stated_on && (countsHere || !mirrored.isZero())) {
      // Rule 4: the statement is a later event of each month it moved.
      parts.push(
        `La causa se declaró el ${r.stated_on}, después de la reversa: ` +
          (r.cause === 'not_collected' && countsHere
            ? `desde entonces este mes deja de contar la base ${q4(here.base)} y el IVA ${q4(here.iva)} que contaba.`
            : r.cause === 'not_collected'
              ? 'desde entonces el cobro sale de los meses en que contaba.'
              : 'no mueve ninguna cifra de este mes.')
      );
    }
    if (r.cause === 'not_stated') {
      parts.push(
        `Para que el papel aplique la causa, declárala con \`receipt cause record ${r.payment_number} --cause ` +
          `not_collected|taken_back --reason "…"\` (cobro causa registrar): not_collected si el dinero nunca llegó, ` +
          `taken_back si llegó y se retiró.`
      );
    }
    findings.push({
      codigo: 'IVA-WP-RECEIPT-REVERSED',
      severidad: 'aviso',
      documentId: r.id,
      documentNumber: r.payment_number,
      mensaje: parts.join(' '),
    });
  }
  return findings;
}

interface UncashedCheckRow {
  id: string;
  payment_number: string;
  check_number: string | null;
  payment_date: string;
  payment_amount: string;
  currency: string;
  bank_account_id: string | null;
  advance_total: string;
  advance_iva: string;
}

interface CheckAllocationRow extends InvoiceRow {
  amount: string;
  advance_taken: string;
  live: boolean;
}

/**
 * The IVA a held cheque's cashing would cause: what its live PPD allocations
 * hold in 2125 (the release the cashing would post, `ivaReclassificationsFor`),
 * an advance's IVA, and the share of a PPD allocation it ended whose cash is
 * still on account, taxed the day the cash is collected (LIVA art. 1-B).
 */
async function heldIvaOf(client: pg.PoolClient, entityId: string, c: UncashedCheckRow): Promise<Decimal> {
  const shares = await ivaReclassificationsFor(client, 'issued', entityId, c.id);
  let iva = shares.reduce((s, x) => s.plus(x.amount), new Decimal(c.advance_iva));
  // Both ends of the bridge are scoped.
  const { rows } = await client.query<CheckAllocationRow>(
    `SELECT ${INVOICE_COLUMNS}, pa.amount_applied::text AS amount,
            (pa.advance_base_amount + pa.advance_iva_amount)::text AS advance_taken, (pa.unapplied_at IS NULL) AS live
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1
      WHERE pa.payment_id = $2 AND i.status NOT IN ('void', 'cancelled')`,
    [entityId, c.id]
  );
  const live = rows.filter((r) => r.live);
  const advanceLeft = Decimal.max(new Decimal(c.advance_total).minus(live.reduce((s, r) => s.plus(r.advance_taken), new Decimal(0))), 0);
  const plain = Decimal.max(
    new Decimal(c.payment_amount).minus(live.reduce((s, r) => s.plus(r.amount), new Decimal(0))).minus(advanceLeft), 0
  );
  let endedCash = new Decimal(0);
  let endedIva = new Decimal(0);
  for (const r of rows) {
    if (r.live || !new Decimal(r.advance_taken).isZero()) continue;
    if ((await resolveInvoiceMetodoPago(client, { ...r, entity_id: entityId })).metodo !== 'PPD') continue;
    endedCash = endedCash.plus(r.amount);
    endedIva = endedIva.plus(acumuladoDelDocumento(r.tax_amount, r.amount, r.total_amount, r.exchange_rate));
  }
  if (endedCash.greaterThan(0)) iva = iva.plus(endedIva.times(Decimal.min(plain.dividedBy(endedCash), 1)));
  return iva;
}

/**
 * MNE-001-507 (#700, task 2) · No month settles while a held cheque possibly
 * cashed in it has no cashing recorded: counting it later would underpay that
 * month (LIVA art. 1-B, second paragraph). For each such cheque, from the month
 * of its receipt: when every account it may have been deposited in (its own,
 * or, for one that names none such as a REP, every account of the entity in
 * its currency) has a statement covering the month from the receipt's day,
 * and none holds an OPEN credit there, the month warns and settles; otherwise
 * a blocking finding names the cheque and why, and the month settles nothing.
 * A credit is open when it is at least the cheque's amount, no receipt holds
 * it as its cashing, and no live match ties it to anything but this receipt
 * or the bank line of its own entry (as `recordCustomerChecksCashing` reads
 * one). A cheque in another currency, or one whose own entries caused its IVA,
 * is counted on its receipt day and is not flagged.
 */
async function checkFindings(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<Hallazgo[]> {
  const { rows } = await client.query<UncashedCheckRow>(
    `SELECT cp.id::text, cp.payment_number, cp.check_number, cp.payment_date::text AS payment_date,
            cp.payment_amount::text AS payment_amount, TRIM(cp.currency_code) AS currency,
            cp.bank_account_id::text AS bank_account_id,
            (COALESCE(cp.advance_base_amount, 0) + COALESCE(cp.advance_iva_amount, 0))::text AS advance_total,
            COALESCE(cp.advance_iva_amount, 0)::text AS advance_iva
       FROM customer_payments cp
       JOIN legal_entities e ON e.id = cp.entity_id
      WHERE cp.entity_id = $1 AND cp.status = 'completed' AND cp.journal_entry_id IS NOT NULL
        AND cp.check_cashed_tx_id IS NULL AND cp.payment_date <= $2::date
        AND TRIM(cp.currency_code) = TRIM(e.functional_currency)
        AND ${heldUntilCashed('cp')}
      ORDER BY cp.payment_date, cp.payment_number`,
    [entityId, range.hasta]
  );
  const findings: Hallazgo[] = [];
  for (const c of rows) {
    const iva = await heldIvaOf(client, entityId, c);
    if (!iva.greaterThan(0)) continue;
    const from = c.payment_date > range.desde ? c.payment_date : range.desde;
    // `bank_transactions` has no entity: the boundary is its account's.
    const accounts = await client.query<{ id: string; account_name: string; covered: boolean }>(
      `SELECT ba.id::text, ba.account_name,
              NOT EXISTS (
                SELECT 1 FROM generate_series($2::date, $3::date, interval '1 day') AS g(d)
                 WHERE NOT EXISTS (SELECT 1 FROM bank_statements s
                                    WHERE s.entity_id = $1 AND s.bank_account_id = ba.id
                                      AND g.d::date BETWEEN s.period_start AND s.period_end)) AS covered
         FROM bank_accounts ba
        WHERE ba.entity_id = $1
          AND (ba.id = $4::uuid OR ($4::uuid IS NULL AND TRIM(ba.currency_code) = $5))
        ORDER BY ba.account_name, ba.id`,
      [entityId, from, range.hasta, c.bank_account_id, c.currency]
    );
    const open = await client.query<{ id: string; date: string; amount: string; account_name: string }>(
      `SELECT bt.id::text, bt.transaction_date::text AS date, bt.amount::text AS amount, ba.account_name
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE ba.entity_id = $1 AND ba.id = ANY($2::uuid[])
          AND bt.transaction_date >= $3::date AND bt.transaction_date <= $4::date
          AND bt.amount >= $5::numeric
          AND NOT EXISTS (SELECT 1 FROM customer_payments held
                           WHERE held.check_cashed_tx_id = bt.id AND held.entity_id = $1)
          AND NOT EXISTS (
                SELECT 1 FROM reconciliation_matches rm
                 WHERE rm.bank_transaction_id = bt.id AND rm.unapplied_at IS NULL
                   AND NOT (rm.matched_entity_type = 'customer_payment' AND rm.matched_entity_id = $6::uuid)
                   AND NOT (rm.matched_entity_type = 'journal_entry_line' AND EXISTS (
                         SELECT 1 FROM journal_entry_lines l
                           JOIN journal_entries je ON je.id = l.journal_entry_id
                          WHERE l.id = rm.matched_entity_id AND je.entity_id = $1
                            AND je.source_type = 'customer_payment' AND je.source_id = $6::uuid
                            AND l.account_id = ba.gl_account_id)))
        ORDER BY bt.transaction_date, bt.id`,
      [entityId, accounts.rows.map((a) => a.id), from, range.hasta, c.payment_amount, c.id]
    );
    const who = `${c.check_number ? `El cheque ${c.check_number} del cobro` : 'El cheque del cobro'} ${c.payment_number}`;
    const names = accounts.rows.map((a) => a.account_name).join(', ');
    const uncovered = accounts.rows.filter((a) => !a.covered);
    if (accounts.rows.length > 0 && uncovered.length === 0 && open.rows.length === 0) {
      findings.push({
        codigo: 'IVA-WP-CHEQUE-NOT-CASHED',
        severidad: 'aviso',
        documentId: c.id,
        documentNumber: c.payment_number,
        mensaje:
          `${who}, recibido el ${c.payment_date}, no tiene cobro registrado: su IVA (${q4(iva)}) espera ese cobro y ` +
          `ningún mes lo cuenta hasta que se registre (LIVA art. 1-B, segundo párrafo). El estado de cuenta de ` +
          `${names} cubre del ${from} al ${range.hasta} sin un abono abierto que pueda ser su cobro, así que este mes ` +
          `se liquida sin él. Cuando el banco lo cobre, regístralo con \`bank check reconcile --receipt ${c.payment_number}\`.`,
      });
      continue;
    }
    const reasons: string[] = [];
    if (accounts.rows.length === 0) {
      reasons.push(`la entidad no tiene una cuenta bancaria en ${c.currency} con un estado de cuenta que diga si lo cobró`);
    } else if (uncovered.length > 0) {
      reasons.push(
        `el estado de cuenta de ${uncovered.map((a) => a.account_name).join(', ')} no cubre del ${from} al ${range.hasta}`
      );
    }
    if (open.rows.length > 0) {
      reasons.push(
        `hay abonos abiertos de por lo menos su importe (${q4(c.payment_amount)}), sin registrar como cobro ni ` +
          `cotejados con otra cosa: ${open.rows.map((t) => `${t.id} del ${t.date} por ${q4(t.amount)} en ${t.account_name}`).join(', ')}`
      );
    }
    findings.push({
      codigo: 'IVA-WP-CHEQUE-CASHING-UNRECORDED',
      severidad: 'bloqueante',
      documentId: c.id,
      documentNumber: c.payment_number,
      mensaje:
        `${who}, recibido el ${c.payment_date}, no tiene cobro registrado y pudo cobrarse este mes: ${reasons.join('; ')}. ` +
        `Si el banco lo cobró aquí, su IVA (${q4(iva)}) se causó este mes (LIVA art. 1-B, segundo párrafo), así que el ` +
        `mes no se liquida hasta saberlo. Registra el cobro con \`bank check reconcile --receipt ${c.payment_number} ` +
        `--transaction <id>\`; si el abono pagó otra cosa, cotéjalo con ella (\`bank match create\`); si falta el ` +
        `estado de cuenta, impórtalo (\`bank statement import\`).`,
    });
  }
  return findings;
}

/**
 * What ONE document put into the month's figures: its own split by rate and the
 * journal entries of the cash event that caused it. The paper's lines are sums
 * of these, so a line can name the documents (and entries) that make it up.
 */
export interface DocumentContribution {
  documentId: string;
  documentNumber: string;
  /**
   * 'receipt': a customer advance, collected, applied or unapplied in the month (MNE-001-423).
   * 'credit_note': an issued credit note, subtracted (MNE-001-565).
   * 'bank_fee': a bank fee's IVA, creditable at its charge (MNE-001-566); the id is its movement or its adjustment.
   */
  documentKind: 'invoice' | 'bill' | 'receipt' | 'credit_note' | 'bank_fee';
  /** The invoice's own entry for a PUE; the customer or vendor payments' entries of the month for a PPD or an advance. */
  entryIds: string[];
  breakdown: Desglose;
  /** Charged side only: the base "no objeto" collected on the document. Four decimals. */
  notSubject: string;
  /** Charged side only: the IVA the customer withheld on the document, and the entry that debited it. */
  withheld: { amount: string; entryId: string | null };
}

interface ChargedOfMonth {
  contributions: DocumentContribution[];
  breakdown: Desglose;
  notSubject: string;
  /** IVA withheld by customers, on the same cash basis as the charged side. */
  withheld: string;
  /** What the month's sales entries debited to iva_retenido_a_favor when issued. */
  withheldPostedAtIssuance: string;
  findings: Hallazgo[];
  /** MNE-001-518 · the charged IVA each receipt put into the month, and what its taxed cash on account moved. */
  ivaByReceipt: Map<string, Decimal>;
  cashOnAccount: Map<string, { back: Decimal; taken: Decimal; neverReleased: Decimal }>;
  /** MNE-001-565 · the cancelled credit notes whose entries moved 2120 in the month. */
  noteCauses: NoteGapCause[];
}

async function chargedOfMonth(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<ChargedOfMonth> {
  const issuedInMonth = await client.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices i
      WHERE i.entity_id = $1 AND i.invoice_date >= $2::date AND i.invoice_date <= $3::date
        AND i.journal_entry_id IS NOT NULL AND i.status NOT IN ('draft', 'void', 'cancelled')
      ORDER BY i.invoice_number`,
    [entityId, range.desde, range.hasta]
  );
  // The payment_allocations bridge has no entity_id: both ends are scoped.
  // Each allocation is an event on the day its cash was applied, and one that
  // was unapplied is a second event, negative, on the day of the unapply (see
  // the header); the cumulative sums then telescope.
  // MNE-001-510: a reset (a reversal that kept its IVA) starts a new stretch
  // of the invoice's events. Each stretch telescopes from the cumulative where
  // its first event of the month found it, so the month of a reset, or of a
  // collection after one, counts what each stretch caused.
  const ppdCandidates = await client.query<InvoiceRow>(
    `WITH events AS (${SHARE_EVENTS}
     ), ordered AS (
       SELECT e.*, SUM(e.amount) OVER w - e.amount AS cum_before,
              COUNT(*) FILTER (WHERE e.kind = 'reset') OVER w AS stretch
         FROM events e
       WINDOW w AS (PARTITION BY e.invoice_id ORDER BY e.on_day, e.ts, e.kind ROWS UNBOUNDED PRECEDING)
     )
     SELECT ${INVOICE_COLUMNS},
            ((array_agg(o.cum_before ORDER BY o.on_day, o.ts, o.kind)
               FILTER (WHERE o.on_day >= $2::date AND o.kind <> 'reset'))[1])::text AS applied_before,
            COALESCE(SUM(o.amount) FILTER (WHERE o.on_day >= $2::date AND o.kind <> 'reset'), 0)::text AS applied_now,
            COALESCE(SUM(o.vat) FILTER (WHERE o.on_day >= $2::date), 0)::text AS vat_released,
            COALESCE(array_agg(DISTINCT o.payment_id::text)
                       FILTER (WHERE o.on_day >= $2::date AND o.kind <> 'reset'), '{}') AS payment_ids
       FROM invoices i
       JOIN ordered o ON o.invoice_id = i.id
      WHERE i.entity_id = $1 AND o.on_day <= $3::date AND i.status NOT IN ('void', 'cancelled')
      GROUP BY i.id, o.stretch
     HAVING COALESCE(SUM(o.amount) FILTER (WHERE o.on_day >= $2::date AND o.kind <> 'reset'), 0) <> 0
         OR COALESCE(SUM(o.vat) FILTER (WHERE o.on_day >= $2::date), 0) <> 0
      ORDER BY i.invoice_number, o.stretch`,
    [entityId, range.desde, range.hasta]
  );
  const advances = await advancesOfMonth(client, entityId, range);
  const cashOnAccount = await cashOnAccountOfMonth(client, entityId, range);
  const receiptEntries = await receiptEntriesOfMonth(client, entityId, [
    ...new Set([
      ...ppdCandidates.rows.flatMap((r) => r.payment_ids ?? []), ...advances.map((a) => a.id), ...cashOnAccount.map((c) => c.paymentId),
    ]),
  ], range);

  const picked: Array<{ row: InvoiceRow; share: PorcionPagada; vat: string; entryIds: string[]; sign: 1 | -1 }> = [];
  for (const row of issuedInMonth.rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo !== 'PUE') continue;
    const share = { aplicadoPrevio: '0', aplicadoAhora: row.total_amount, totalDocumento: row.total_amount, tasaCambio: row.exchange_rate };
    picked.push({
      row, share, entryIds: row.journal_entry_id ? [row.journal_entry_id] : [], sign: 1,
      vat: acumuladoDelDocumento(row.tax_amount, row.total_amount, row.total_amount, row.exchange_rate),
    });
  }
  for (const row of ppdCandidates.rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo !== 'PPD') continue;
    const before = new Decimal(row.applied_before ?? '0');
    const now = new Decimal(row.applied_now ?? '0');
    const vat = new Decimal(row.vat_released ?? '0');
    // A month whose undoes outweigh its applications gives back a share: the
    // same telescope read from the lower cumulative, and its sign turned.
    const sign: 1 | -1 = now.isNegative() || (now.isZero() && vat.isNegative()) ? -1 : 1;
    const share = {
      aplicadoPrevio: q4(sign === 1 ? before : before.plus(now)),
      aplicadoAhora: q4(now.abs()),
      totalDocumento: row.total_amount,
      tasaCambio: row.exchange_rate,
    };
    const entryIds = [...new Set((row.payment_ids ?? []).flatMap((id) => receiptEntries.get(id) ?? []))];
    picked.push({ row, share, vat: q4(vat.times(sign)), entryIds, sign });
  }

  const sources = await saleSources(client, entityId, picked.map((p) => p.row.id));
  const withheldOf = await withheldPerSale(client, entityId, [
    ...new Set([...picked.map((p) => p.row.id), ...issuedInMonth.rows.map((r) => r.id)]),
  ]);
  let breakdown = desgloseCero();
  let notSubject = new Decimal(0);
  let withheld = new Decimal(0);
  let manualZeroRate = new Decimal(0);
  const findings: Hallazgo[] = [];
  const contributions: DocumentContribution[] = [];
  for (const { row, share, vat, entryIds, sign } of picked) {
    const source = sources.get(row.id) ?? { lines: [], notSubject: q4(0), fromCfdi: false };
    const r = desglosarDocumento({
      documentId: row.id,
      documentNumber: row.invoice_number,
      renglones: source.lines,
      ivaCabecera: row.tax_amount,
      ivaPagado: vat,
      porcion: share,
      politicaBaseExenta: 'exigir_base',
      documentKind: 'invoice',
    });
    const split = sign === 1 ? r.desglose : scaled(r.desglose, -1);
    breakdown = sumarDesgloses(breakdown, split);
    findings.push(...r.hallazgos);
    const notSubjectHere = new Decimal(porcionDelDocumento(source.notSubject, share)).times(sign);
    notSubject = notSubject.plus(notSubjectHere);
    if (!source.fromCfdi) manualZeroRate = manualZeroRate.plus(split.tasa0.base);
    // The entry's amount is already in functional currency: only the ratio applies.
    const withheldHere = new Decimal(porcionDelDocumento(withheldOf.get(row.id) ?? '0', { ...share, tasaCambio: '1' })).times(sign);
    withheld = withheld.plus(withheldHere);
    // MNE-001-510: a second stretch of the same invoice (a collection after a reversal that kept its IVA) joins its line.
    const same = contributions.find((c) => c.documentKind === 'invoice' && c.documentId === row.id);
    if (same) {
      same.breakdown = sumarDesgloses(same.breakdown, split);
      same.notSubject = q4(new Decimal(same.notSubject).plus(notSubjectHere));
      same.withheld.amount = q4(new Decimal(same.withheld.amount).plus(withheldHere));
      same.entryIds = [...new Set([...same.entryIds, ...entryIds])];
      continue;
    }
    contributions.push({
      documentId: row.id,
      documentNumber: row.invoice_number,
      documentKind: 'invoice',
      entryIds,
      breakdown: split,
      notSubject: q4(notSubjectHere),
      // The withholding sits in the invoice's own entry, whatever the cash event.
      withheld: { amount: q4(withheldHere), entryId: row.journal_entry_id },
    });
  }
  for (const a of advances) {
    const { breakdown: split, notSubject: notSubjectHere } = advanceBreakdown(a);
    breakdown = sumarDesgloses(breakdown, split);
    notSubject = notSubject.plus(notSubjectHere);
    contributions.push({
      documentId: a.id,
      documentNumber: a.payment_number,
      documentKind: 'receipt',
      entryIds: receiptEntries.get(a.id) ?? [],
      breakdown: split,
      notSubject: q4(notSubjectHere),
      withheld: { amount: q4(0), entryId: null },
    });
  }
  // The taxed cash on account of a receipt sits in its receipt line, next to its advance if it has one.
  const numbers = cashOnAccount.length
    ? new Map((await client.query<{ id: string; payment_number: string }>(
        'SELECT id::text, payment_number FROM customer_payments WHERE entity_id = $1 AND id = ANY($2::uuid[])',
        [entityId, cashOnAccount.map((c) => c.paymentId)]
      )).rows.map((r) => [r.id, r.payment_number]))
    : new Map<string, string>();
  for (const c of cashOnAccount) {
    breakdown = sumarDesgloses(breakdown, c.breakdown);
    notSubject = notSubject.plus(c.notSubject);
    const line = contributions.find((x) => x.documentKind === 'receipt' && x.documentId === c.paymentId);
    if (line) {
      line.breakdown = sumarDesgloses(line.breakdown, c.breakdown);
      line.notSubject = q4(new Decimal(line.notSubject).plus(c.notSubject));
      continue;
    }
    contributions.push({
      documentId: c.paymentId,
      documentNumber: numbers.get(c.paymentId) ?? '',
      documentKind: 'receipt',
      entryIds: receiptEntries.get(c.paymentId) ?? [],
      breakdown: c.breakdown,
      notSubject: q4(c.notSubject),
      withheld: { amount: q4(0), entryId: null },
    });
  }
  // MNE-001-565 · each issued credit note, subtracted in the month its entry moved 2120.
  const notes = await issuedCreditNotesOfRange(client, entityId, range);
  breakdown = sumarDesgloses(breakdown, notes.breakdown);
  notSubject = notSubject.plus(notes.notSubject);
  manualZeroRate = manualZeroRate.plus(notes.manualZeroRate);
  findings.push(...notes.findings);
  contributions.push(...notes.contributions);
  const ivaByReceipt = await sharesIvaByReceipt(client, entityId, range);
  const addIva = (id: string, iva: Decimal.Value) => ivaByReceipt.set(id, (ivaByReceipt.get(id) ?? new Decimal(0)).plus(iva));
  for (const a of advances) addIva(a.id, a.iva);
  for (const c of cashOnAccount) addIva(c.paymentId, ivaDelDesglose(c.breakdown));
  if (manualZeroRate.greaterThan(0)) {
    findings.push({
      codigo: 'IVA-WP-ZERO-RATE-UNVERIFIED',
      severidad: 'aviso',
      mensaje:
        `${q4(manualZeroRate)} de base cobrada al 0 % viene de facturas capturadas a mano, cuyos renglones ` +
        `no dicen si son tasa 0 %, exentos o no objeto del impuesto (sólo tax_code = 'exento' marca un ` +
        `exento). Confírmalo antes de declarar: una venta exenta o no objeto declarada al 0 % cambia la ` +
        `proporción del art. 5 fr. V LIVA.`,
    });
  }
  const postedAtIssuance = issuedInMonth.rows.reduce((acc, r) => acc.plus(withheldOf.get(r.id) ?? 0), new Decimal(0));
  return {
    contributions,
    breakdown,
    notSubject: q4(notSubject),
    withheld: q4(withheld),
    withheldPostedAtIssuance: q4(postedAtIssuance),
    findings,
    ivaByReceipt,
    cashOnAccount: new Map(cashOnAccount.map((c) => [c.paymentId, { back: c.back, taken: c.taken, neverReleased: c.neverReleased }])),
    noteCauses: notes.causes,
  };
}

/**
 * The journal entries of each bill's cash event, for the bills the DIOT's facts
 * picked: the bill's own entry (a `bill` fact) or the vendor payments of the
 * month and the cashing entries of the cheques cashed in it (a `payment` fact). Both the selection of bills and which event each
 * one has stay `hechosDelMes`'s (MNE-001-491: where the VAT sits, not the
 * method); this only looks the entries up.
 */
async function billEntryIds(
  client: pg.PoolClient,
  entityId: string,
  facts: ReadonlyArray<Pick<HechoPagado, 'billId' | 'event'>>,
  range: RangoDelMes
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const byBill = facts.filter((h) => h.event === 'bill').map((h) => h.billId);
  const byPayment = facts.filter((h) => h.event === 'payment').map((h) => h.billId);
  if (byBill.length > 0) {
    const { rows } = await client.query<{ id: string; entry: string | null }>(
      `SELECT id, journal_entry_id::text AS entry FROM bills WHERE entity_id = $1 AND id = ANY($2::uuid[])`,
      [entityId, byBill]
    );
    for (const r of rows) out.set(r.id, r.entry ? [r.entry] : []);
  }
  if (byPayment.length > 0) {
    // The bridge has no entity_id: both ends are scoped, as in the DIOT's reading.
    const { rows } = await client.query<{ id: string; entries: string[] }>(
      `SELECT pa.bill_id AS id, array_agg(DISTINCT vp.journal_entry_id::text) AS entries
         FROM payment_applications pa
         JOIN vendor_payments vp ON vp.id = pa.payment_id
         JOIN bills b ON b.id = pa.bill_id
        WHERE b.entity_id = $1 AND vp.entity_id = $1 AND pa.bill_id = ANY($2::uuid[])
          AND vp.journal_entry_id IS NOT NULL AND vp.status <> 'void'
          AND vp.payment_date >= $3::date AND vp.payment_date <= $4::date
        GROUP BY pa.bill_id`,
      [entityId, byPayment, range.desde, range.hasta]
    );
    for (const r of rows) out.set(r.id, r.entries);
    // A cheque cashed in the month (MNE-001-559): its cashing entry is the one
    // that credited the IVA, so the bill traces to it. One whose own entry
    // credited the IVA has no cashing entry, and its payment entry is above.
    const cashed = await client.query<{ id: string; entry: string }>(
      `SELECT DISTINCT pa.bill_id AS id, je.id::text AS entry
         FROM payment_applications pa
         JOIN vendor_payments vp ON vp.id = pa.payment_id
         JOIN bills b ON b.id = pa.bill_id
         JOIN journal_entries je ON je.source_id = vp.id AND je.entity_id = vp.entity_id
                                AND je.source_type = '${ORIGEN_COBRO_DE_CHEQUE}' AND je.status = 'posted'
        WHERE b.entity_id = $1 AND vp.entity_id = $1 AND pa.bill_id = ANY($2::uuid[])
          AND vp.status <> 'void'
          AND vp.check_cleared_date >= $3::date AND vp.check_cleared_date <= $4::date
        ORDER BY 1, 2`,
      [entityId, byPayment, range.desde, range.hasta]
    );
    for (const r of cashed.rows) out.set(r.id, [...(out.get(r.id) ?? []), r.entry]);
  }
  return out;
}

// ------------------------------------------------------------
// THE LEDGER: role accounts, through report-service
// ------------------------------------------------------------

const ROLES = ['iva_trasladado', 'iva_acreditable', 'iva_retenido_a_favor', 'iva_retenido_por_pagar'] as const;
type IvaRole = (typeof ROLES)[number];

interface RoleMovement {
  debit: Decimal;
  credit: Decimal;
}

/** The month's debits and credits of each role, read on the caller's client. */
async function roleMovements(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string,
  range: RangoDelMes
): Promise<Record<IvaRole, RoleMovement>> {
  const { rows: mapped } = await client.query<{ role: IvaRole; account_id: string }>(
    `SELECT DISTINCT role, account_id FROM account_roles
      WHERE tenant_id = $1 AND entity_id = $2 AND role = ANY($3::text[])`,
    [tenantId, entityId, [...ROLES]]
  );
  const balance = await queryTrialBalanceRows(entityId, { sinceDate: range.desde, untilDate: range.hasta }, client);
  const byAccount = new Map(balance.map((b) => [b.account_id, b]));
  const out = Object.fromEntries(
    ROLES.map((r) => [r, { debit: new Decimal(0), credit: new Decimal(0) }])
  ) as Record<IvaRole, RoleMovement>;
  for (const m of mapped) {
    const b = byAccount.get(m.account_id);
    if (!b) continue;
    out[m.role] = { debit: out[m.role].debit.plus(b.debit_total), credit: out[m.role].credit.plus(b.credit_total) };
  }
  return out;
}

// ------------------------------------------------------------
// THE WORKPAPER
// ------------------------------------------------------------

export interface IvaWorkpaper {
  period: { year: number; month: number } & RangoDelMes;
  rounding: { key: string; value: FilingRounding; defined: boolean };
  /**
   * The proration method in force and whether the panel was answered. Always
   * present, unlike `figures.proration`, which is null when nothing was prorated.
   */
  proration: { key: string; value: CreditableProration; defined: boolean };
  figures: IvaWorkpaperFigures;
  /**
   * What each document put into `figures`, with the entries of its cash event:
   * the per-line trace of the filing workpaper (MNE-001-060) is a sum over these.
   */
  contributions: { charged: DocumentContribution[]; creditable: DocumentContribution[] };
  /**
   * Null while a blocking finding stands: some figure is missing, and a
   * settlement computed without it would look declarable and not be.
   */
  settlement: IvaSettlement | null;
  /** The codes of the blocking findings that withheld the settlement. */
  blockedBy: string[];
  /** The month's net movement of each IVA role account, debit positive. */
  ledger: Record<IvaRole, string>;
  findings: Hallazgo[];
}

export interface IvaWorkpaperOptions {
  tenantId: string;
  entityId: string;
  year: number;
  month: number;
  /** Balance in favor from earlier periods to apply. Captured by a person. */
  priorBalanceInFavor?: string;
  client?: pg.PoolClient;
}

function q4(d: Decimal.Value): string {
  return new Decimal(d).toFixed(4);
}

function tieOut(
  findings: Hallazgo[], code: string, what: string, role: string, facts: string, ledger: Decimal, causes: readonly GapCause[] = []
): void {
  const gap = new Decimal(facts).minus(ledger);
  if (gap.abs().lessThanOrEqualTo('0.01')) return;
  // MNE-001-518: a later event that moved the month is named there, with its amount (#666, rule 4).
  const named = causes.reduce((s, c) => s.plus(c.amount), new Decimal(0));
  findings.push({
    codigo: code,
    severidad: 'aviso',
    mensaje:
      `El ${what} suma ${q4(facts)} y el movimiento del mes de la cuenta de rol ${role} ` +
      `es ${q4(ledger)}. Revisa las pólizas del mes antes de declarar: una nota de crédito, un ` +
      `asiento manual o un documento sin renglones explican la diferencia.` +
      (causes.length
        ? ` De la diferencia de ${q4(gap)}, estos documentos explican ${q4(named)}: ${causes.map((c) => `${c.text} (${q4(c.amount)})`).join('; ')}.`
        : ''),
  });
}

/** A person captures it: an amount of zero or more, or a ValidationError naming it. */
export function priorBalanceOf(raw: string | undefined): string {
  let value: Decimal | null;
  try {
    value = new Decimal(raw ?? '0');
  } catch {
    value = null;
  }
  if (value === null || !value.isFinite() || value.isNegative()) {
    throw new ValidationError(
      `El saldo a favor de periodos anteriores vale "${String(raw)}": debe ser un importe de cero o más.`,
      'priorBalanceInFavor'
    );
  }
  return q4(value);
}

export async function buildIvaWorkpaper(opts: IvaWorkpaperOptions): Promise<IvaWorkpaper> {
  const { tenantId, entityId, year, month } = opts;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError(`El mes ${String(month)} no existe: el IVA definitivo es mensual.`, 'month');
  }
  const priorBalanceInFavor = priorBalanceOf(opts.priorBalanceInFavor);
  const run = async (client: pg.PoolClient): Promise<IvaWorkpaper> => {
    const { rowCount } = await client.query('SELECT 1 FROM legal_entities WHERE id = $1 AND tenant_id = $2', [
      entityId,
      tenantId,
    ]);
    if (!rowCount) throw new NotFoundError('Entidad legal', entityId);
    if (!(await entityUsesCashBasisIva(client, entityId))) {
      throw new ValidationError('La entidad no causa IVA mexicano: no hay IVA definitivo que calcular.', 'entity_id');
    }
    const ctx = { tenantId, entityId };
    const range = rangoDelMes(year, month);
    const roundingPolicy = await getPolicy(ctx, FILING_ROUNDING_POLICY, client);
    const rounding = await readFilingRounding(ctx, client);
    const exemptBase = (await getPolicy(ctx, 'diot_iva_exento_y_base', client)).value as PoliticaBaseExenta;

    const charged = await chargedOfMonth(client, entityId, range);
    const findings: Hallazgo[] = [...charged.findings];

    const { hechos: facts, hallazgos: factFindings } = await hechosDelMes(client, entityId, year, month);
    findings.push(...factFindings);
    let creditable = desgloseCero();
    const billEntries = await billEntryIds(client, entityId, facts, range);
    const creditableContributions: DocumentContribution[] = [];
    for (const h of facts) {
      const r = desglosarDocumento({
        documentId: h.billId,
        documentNumber: h.billNumber,
        renglones: h.renglones,
        ivaCabecera: h.ivaCabecera,
        ivaPagado: h.ivaPagado,
        porcion: h.porcion,
        politicaBaseExenta: exemptBase,
      });
      creditable = sumarDesgloses(creditable, r.desglose);
      findings.push(...r.hallazgos);
      creditableContributions.push({
        documentId: h.billId,
        documentNumber: h.billNumber,
        documentKind: 'bill',
        entryIds: billEntries.get(h.billId) ?? [],
        breakdown: r.desglose,
        notSubject: q4(0),
        withheld: { amount: q4(0), entryId: null },
      });
    }
    const fees = await bankFeesOfRange(client, entityId, range);
    creditable = sumarDesgloses(creditable, fees.breakdown);
    creditableContributions.push(...fees.contributions);
    findings.push(...fees.findings);

    const ledger = await roleMovements(client, tenantId, entityId, range);
    const net = (r: IvaRole): Decimal => ledger[r].debit.minus(ledger[r].credit);
    const receiptLedger = await receiptLedgerOfMonth(client, entityId, range);
    findings.push(...(await reversalFindings(client, entityId, range, receiptLedger)));
    findings.push(...(await checkFindings(client, entityId, range)));
    tieOut(
      findings, 'IVA-WP-CHARGED-VS-LEDGER', 'IVA trasladado cobrado por tasa', 'iva_trasladado',
      ivaDelDesglose(charged.breakdown), net('iva_trasladado').negated(), [...gapCauses(charged, receiptLedger), ...charged.noteCauses]
    );
    tieOut(findings, 'IVA-WP-CREDITABLE-VS-LEDGER', 'IVA acreditable pagado por tasa', 'iva_acreditable', ivaDelDesglose(creditable), net('iva_acreditable'), fees.causes);
    // Debits only: the month's settlement or offset entry credits the account,
    // and a net movement would read as zero once it is posted.
    tieOut(findings, 'IVA-WP-WITHHELD-VS-LEDGER', 'IVA retenido que las ventas del mes registraron al emitirse', 'iva_retenido_a_favor (cargos)', charged.withheldPostedAtIssuance, ledger.iva_retenido_a_favor.debit);

    const prorationPolicy = await getPolicy(ctx, CREDITABLE_PRORATION_POLICY, client);
    const method = await readCreditableProration(ctx, client);
    const reference = method === 'monthly' ? range : { desde: `${year - 1}-01-01`, hasta: `${year - 1}-12-31` };
    const referenceSales = method === 'monthly' ? charged : await chargedOfMonth(client, entityId, reference);
    const acts = actsOf(referenceSales.breakdown, referenceSales.notSubject);
    if (method === 'annual') {
      findings.push(...referenceFindings(referenceSales.findings, year - 1));
      if (acts.taxed.plus(acts.notTaxed).isZero()) {
        findings.push({
          codigo: 'IVA-WP-PRORATION-NO-REFERENCE',
          severidad: 'bloqueante',
          politica: CREDITABLE_PRORATION_POLICY,
          mensaje:
            `La política ${CREDITABLE_PRORATION_POLICY} pide la proporción del año ${year - 1} (art. 5-B LIVA) ` +
            `y ese año no cobró ningún acto: no hay proporción con la cual acreditar. Elige la del mes ` +
            `(art. 5 fr. V inc. c) o captura los cobros de ese año antes de declarar.`,
        });
      } else {
        const { rows } = await client.query<{ first: string | null }>(
          `SELECT to_char(MIN(entry_date), 'YYYY-MM-DD') AS first FROM journal_entries
            WHERE entity_id = $1 AND status = 'posted'`,
          [entityId]
        );
        const ledgerStart = rows[0]?.first ?? null;
        if (!coversReferenceYear(ledgerStart, year - 1)) {
          // Checked whether or not the partial year has exempt acts: with none,
          // `prorate` returns null and the IVA would be credited whole in silence.
          findings.push({
            codigo: 'IVA-WP-PRORATION-PARTIAL-REFERENCE',
            severidad: 'bloqueante',
            politica: CREDITABLE_PRORATION_POLICY,
            mensaje:
              `La política ${CREDITABLE_PRORATION_POLICY} pide la proporción del año ${year - 1} (art. 5-B LIVA) ` +
              `y el mayor sólo tiene ese año del ${ledgerStart ?? '(sin pólizas)'} al ${year - 1}-12-31: unos meses ` +
              `no son la proporción del año. Captura los cobros que faltan, o elige la del mes (art. 5 fr. V ` +
              `inc. c). Si la entidad inició actividades ese año, el art. 5-B párrafo segundo pide la proporción ` +
              `desde el mes de inicio hasta el mes que se calcula, que este papel de trabajo no calcula todavía.`,
          });
        }
      }
    }
    const proration = prorate(method, reference, acts, ivaDelDesglose(creditable));
    if (proration) {
      findings.push({
        codigo: 'IVA-WP-PRORATION-OVER-ALL-PAID',
        severidad: 'aviso',
        politica: CREDITABLE_PRORATION_POLICY,
        mensaje:
          `El IVA pagado del mes (${proration.paid}) se acredita en la proporción ${proration.factor} ` +
          `(${proration.taxedActs} de actos gravados de ${proration.totalActs}, del ${reference.desde} ` +
          `al ${reference.hasta}): ${proration.creditable}. Se aplica a todo el IVA pagado porque el ` +
          `mayor no distingue los gastos exclusivos de actos gravados (acreditables completos, art. 5 ` +
          `fr. V inc. a) ni de exentos (no acreditables, inc. b): el acreditable queda sobrestimado por ` +
          `un gasto sólo de actos exentos y subestimado por uno sólo de gravados. Tampoco quita los ` +
          `valores que excluye el art. 5-C. Revísalo antes de declarar; la parte no acreditable sigue ` +
          `en iva_acreditable.`,
      });
      // NOTE: two follow-ups proposed in PR #537 (open points 6 and 7), with no
      // issue yet: a close entry that moves the non-creditable share out of
      // iva_acreditable, and the DIOT's `diot_creditable_iva_proportion` reading
      // this proportion (today it offers only taxed_only/block, and refuses
      // taxed_only when the ledger shows exempt revenue).
    }

    const figures: IvaWorkpaperFigures = {
      charged: charged.breakdown,
      chargedNotSubject: charged.notSubject,
      creditable,
      withheldByCustomers: charged.withheld,
      // Credits only, for the same reason: what was withheld in the month.
      withheldToRemit: q4(ledger.iva_retenido_por_pagar.credit),
      priorBalanceInFavor,
      proration,
    };
    const blockedBy = [...new Set(findings.filter((h) => h.severidad === 'bloqueante').map((h) => h.codigo))];
    return {
      period: { year, month, ...range },
      rounding: { key: FILING_ROUNDING_POLICY, value: rounding, defined: roundingPolicy.defined },
      proration: { key: CREDITABLE_PRORATION_POLICY, value: method, defined: prorationPolicy.defined },
      figures,
      contributions: { charged: charged.contributions, creditable: creditableContributions },
      settlement: blockedBy.length > 0 ? null : settleIva(figures, rounding),
      blockedBy,
      ledger: Object.fromEntries(ROLES.map((r) => [r, q4(net(r))])) as Record<IvaRole, string>,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
