import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { entityScope } from '../../database/scope.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { queryEntryMovementsOnAccount, queryTrialBalanceRows } from '../reporting/report-service.js';
import { CUSTOMER_CHECK_CASHING_SOURCE, ORIGEN_COBRO_DE_CHEQUE } from '../banking/treasury-posting.js';
import {
  entityUsesCashBasisIva, ivaReclassificationsFor, reclassRoles, resolveInvoiceMetodoPago,
} from '../accounting/iva-cash-basis.js';
import { saleSources, type SaleSource } from './sale-sources.js';
import { issuedCreditNotesOfRange, type NoteGapCause } from './issued-credit-notes.js';
import { receivedCreditNotesOfRange } from './received-credit-notes.js';
import { bankFeesOfRange } from './bank-fee-iva.js';
import { balancesInFavorBefore } from './filed-returns.js';
import { overrideFindings, proposePriorCredit, type PriorBalance } from './prior-balance.js';
import { backAsAdvance, HELD_RESTITUTION_TAG, keptCashOf, KEPT_RESTITUTION_TAG, restitutedCash, storedAdvanceTreatment } from '../payments/customer-advance.js';
import {
  acumuladoDelDocumento,
  APPLIED_ON,
  UNDONE_ON,
  desglosarDocumento,
  desgloseCero,
  hechosDelMes,
  ivaDelDesglose,
  porcionDelDocumento,
  rangoDelMes,
  readVendorUndoIvaMonth,
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
//      Since MNE-001-574 the ledger keeps the share caused too (the owner's
//      «Mantener causado», #623 comment 7013109077) and nets it on the next
//      application; only a row unapplied before migration 338, or one under
//      `plain_receipt_unapply_iva = repark_same_month` (MNE-001-585, which the
//      paper does not follow), re-parked, and that month's tie-out names it.
//   2. A reversal whose money never became the firm's counts in no month
//      (art. 1-B): the cause `not_collected` (MNE-001-509), which a cheque
//      takes by default because it is paid when cashed (second paragraph).
//      Each month it would have counted in names the reversal and the amended
//      return (CFF art. 32). MNE-001-510: the stated cause decides, not the
//      method (`REVERSAL_CAUSE`). MNE-001-583: what a credit note restituted
//      from it was never caused either (art. 7), so the note's month leaves
//      it out and names its amended return too (`uncausedRestitutions`).
//      MNE-001-606: an undo after a note posted under the rule before 581,
//      which re-parked what the note had restituted, and a note reversed by
//      hand after an unapply it capped, are named in their month, figures
//      unchanged (`undoesAfterNotes`).
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
//                  for it would be the fourth definition. Cash on account
//                  counts the day it was applied to its bill (MNE-001-679,
//                  `APPLICATION_CREDIT_DATE`), and leaves in the month it
//                  was unapplied or its payment reversed, never in the one it
//                  counted in (MNE-001-682, `UNDONE_ON`). Plus the bank fees
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
  /** Balance in favor from earlier periods applied this month: the record's, capped (MNE-001-386), or a person's. */
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
 * What each of `entryIds` left on the accounts of one role, debit positive,
 * through report-service on the caller's client (MNE-001-437, #101). The
 * role's accounts are read as a set, so an account mapped twice counts once;
 * an entry with no line on them has no key.
 */
async function netOnRole(
  client: pg.PoolClient,
  entityId: string,
  role: string,
  entryIds: readonly string[]
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  if (entryIds.length === 0) return out;
  const { rows: accounts } = await client.query<{ account_id: string }>(
    `SELECT DISTINCT account_id::text AS account_id FROM account_roles WHERE entity_id = $1 AND role = $2`,
    [entityId, role]
  );
  for (const { account_id } of accounts) {
    for (const m of await queryEntryMovementsOnAccount(entityId, account_id, { entryIds: [...entryIds], client })) {
      out.set(m.journal_entry_id, (out.get(m.journal_entry_id) ?? new Decimal(0)).plus(m.amount));
    }
  }
  return out;
}

/**
 * The IVA each sale's own entry debited to iva_retenido_a_favor: what the
 * customer withholds on that document, in functional currency. A sale whose
 * entry has no line on the role has no key; two sales on one entry each get
 * its net.
 */
export async function withheldPerSale(
  client: pg.PoolClient,
  entityId: string,
  sales: ReadonlyArray<Pick<InvoiceRow, 'id' | 'journal_entry_id'>>
): Promise<Map<string, string>> {
  const entryIds = [...new Set(sales.flatMap((s) => (s.journal_entry_id ? [s.journal_entry_id] : [])))];
  const byEntry = await netOnRole(client, entityId, 'iva_retenido_a_favor', entryIds);
  const out = new Map<string, string>();
  for (const s of sales) {
    const net = s.journal_entry_id ? byEntry.get(s.journal_entry_id) : undefined;
    if (net !== undefined) out.set(s.id, q4(net));
  }
  return out;
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
/**
 * MNE-001-574 with MNE-001-581 (#792, decision (A)) · The IVA an unapply ended
 * on the invoice: the share its row released, unless a credit note capped
 * what went back to 2125. Then the row kept less than its plain cash's share
 * of the release (`capKept`), and what it ended is what it kept plus the
 * advance's IVA it took, the same figure its cash carries back on account.
 *
 * MNE-001-592 (#814) · Less the advance's IVA the note restituted, which the
 * unapply did not restore (migration 342): what it ended is what went back to
 * 2125, and the advance it returns to carries no more than that.
 */
const ENDED_SHARE_IVA = `(CASE
         WHEN pa.unapply_kept_iva_amount IS NOT NULL AND pa.unapply_kept_iva_amount < CASE
                WHEN pa.advance_base_amount + pa.advance_iva_amount = 0 THEN pa.iva_reclass_amount
                ELSE ROUND(pa.iva_reclass_amount * (pa.amount_applied - pa.advance_base_amount - pa.advance_iva_amount)
                           / pa.amount_applied, 4) END
           THEN pa.unapply_kept_iva_amount + pa.advance_iva_amount
         ELSE COALESCE(pa.iva_reclass_amount, 0) END - COALESCE(pa.unapply_restituted_iva_amount, 0))`;

const SHARE_EVENTS = `
       SELECT se.* FROM (
       SELECT pa.invoice_id, cp.id AS payment_id, pa.amount_applied AS amount,
              COALESCE(pa.iva_reclass_amount, 0) AS vat, ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')} AS on_day,
              'apply'::text AS kind, pa.created_at AS ts
         FROM payment_allocations pa
         JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL AND ${RECEIPT_COUNTS}
       UNION ALL
       SELECT pa.invoice_id, cp.id, -pa.amount_applied, -(${ENDED_SHARE_IVA}),
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
  // MNE-001-581: a reversal's correction, the IVA a credit note already restituted that stays out of 2125.
  'receipt_reversal_iva',
  // MNE-001-612: the pair a held note's reversal posts after the cashing that netted it.
  'held_restitution_reversal',
] as const;

/** Every box of a split times `factor`: an undo gives back what its event put in. */
function scaled(d: Desglose, factor: Decimal.Value): Desglose {
  const box = (c: { base: string; iva: string }) => ({ base: q4(new Decimal(c.base).times(factor)), iva: q4(new Decimal(c.iva).times(factor)) });
  return {
    tasa16: box(d.tasa16), tasa8: box(d.tasa8), tasa0: box(d.tasa0), exento: box(d.exento),
    otras: d.otras.map((o) => ({ etiqueta: o.etiqueta, ...box(o) })),
  };
}

/** MNE-001-591 · The bases scaled by `factor` and the IVA left as it is: the cash that carries the kept IVA. */
function scaledBase(d: Desglose, factor: Decimal.Value): Desglose {
  const box = (c: { base: string; iva: string }) => ({ base: q4(new Decimal(c.base).times(factor)), iva: c.iva });
  return {
    tasa16: box(d.tasa16), tasa8: box(d.tasa8), tasa0: box(d.tasa0), exento: box(d.exento),
    otras: d.otras.map((o) => ({ etiqueta: o.etiqueta, ...box(o) })),
  };
}

/** MNE-001-592 · The IVA scaled by `factor` and the bases left as they are. */
function scaledIva(d: Desglose, factor: Decimal.Value): Desglose {
  const box = (c: { base: string; iva: string }) => ({ base: c.base, iva: q4(new Decimal(c.iva).times(factor)) });
  return {
    tasa16: box(d.tasa16), tasa8: box(d.tasa8), tasa0: box(d.tasa0), exento: box(d.exento),
    otras: d.otras.map((o) => ({ etiqueta: o.etiqueta, ...box(o) })),
  };
}

/**
 * MNE-001-592 (#814, decision (A)) · What an unapply puts back of the taxed
 * cash its row took, after a credit note restituted part of that IVA
 * (`restituted`, migration 342): the month's contribution keeps its base and
 * drops that IVA, as the ledger does; the pool carried forward loses the IVA
 * and the cash it covers (`restitutedCash`, the invoice's total over its tax),
 * which is owed back and carries none. With nothing restituted, all of it.
 */
function restitutedOut(
  took: { cash: Decimal; breakdown: Desglose; notSubject: Decimal },
  restituted: string | null,
  invoice: Pick<InvoiceRow, 'total_amount' | 'tax_amount'> | undefined
): [Desglose, Decimal, boolean, { cash: Decimal; split: Desglose; notSubject: Decimal } | undefined] {
  const iva = new Decimal(ivaDelDesglose(took.breakdown));
  const out = Decimal.min(new Decimal(restituted ?? '0'), iva);
  if (!out.greaterThan(0)) return [took.breakdown, took.notSubject, false, undefined];
  const split = scaledIva(took.breakdown, iva.minus(out).dividedBy(iva));
  const covered = invoice
    ? new Decimal(restitutedCash(out.toFixed(4), invoice.total_amount, invoice.tax_amount))
    : took.cash.times(out).dividedBy(iva);
  const cash = Decimal.max(took.cash.minus(covered), 0);
  const part = cash.dividedBy(took.cash);
  return [split, took.notSubject, false, { cash, split: scaledBase(split, part), notSubject: new Decimal(q4(took.notSubject.times(part))) }];
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
 *
 * MNE-001-573 · Except what its allocations to a PUE invoice take and give
 * back: the ledger cancels that IVA in the invoice's month on the day of the
 * application (and restores it on the unapply's), against the IVA the
 * invoice caused when issued, so the paper counts them on their own day too.
 *
 * MNE-001-592 (#814) · An unapply's put-back drops the IVA a credit note
 * restituted (migration 342) and keeps its base, so the month nets as the
 * ledger does: that IVA is not caused again (LIVA art. 7).
 */
async function advancesOfMonth(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<AdvanceOfMonth[]> {
  const pue = await pueInvoicesOfCheckAdvances(client, entityId);
  const { rows } = await client.query<AdvanceOfMonth>(
    `WITH events AS (
       SELECT cp.id, cp.advance_base_amount AS base, cp.advance_iva_amount AS iva, ${countedOn('cp', 'cp.payment_date')} AS on_day
         FROM customer_payments cp
        -- MNE-001-499: a transfer row collected nothing; its source's day counted the advance.
        WHERE cp.entity_id = $1 AND cp.payment_method <> 'balance_transfer'
       UNION ALL
       SELECT cp.id, -pa.advance_base_amount, -pa.advance_iva_amount,
              CASE WHEN pa.invoice_id = ANY($4::uuid[]) THEN COALESCE(pa.applied_on, cp.payment_date)
                   ELSE ${countedOn('cp', 'COALESCE(pa.applied_on, cp.payment_date)')} END
         FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id
        WHERE cp.entity_id = $1 AND ${CARRIED_AN_ADVANCE}
       UNION ALL
       SELECT cp.id, pa.advance_base_amount, pa.advance_iva_amount - COALESCE(pa.unapply_restituted_iva_amount, 0),
              CASE WHEN pa.invoice_id = ANY($4::uuid[]) THEN pa.unapplied_at::date
                   ELSE ${countedOn('cp', 'pa.unapplied_at::date')} END
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
    [entityId, range.desde, range.hasta, pue]
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

/**
 * MNE-001-573 · The PUE invoices that a cheque's advance was applied to: only
 * a cheque's events count on another day than their own. Both ends scoped.
 */
async function pueInvoicesOfCheckAdvances(client: pg.PoolClient, entityId: string): Promise<string[]> {
  const { rows } = await client.query<InvoiceRow>(
    `SELECT DISTINCT ${INVOICE_COLUMNS}
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1
      WHERE cp.payment_method = 'check' AND ${RETURNS_AS_ADVANCE} AND ${CARRIED_AN_ADVANCE}`,
    [entityId]
  );
  const pue: string[] = [];
  for (const row of rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo !== 'PPD') pue.push(row.id);
  }
  return pue;
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
  allocation_id: string;
  payment_id: string;
  payment_amount: string;
  invoice_id: string;
  amount: string;
  vat: string;
  advance_taken: string;
  /** MNE-001-574 · The IVA the row's unapply kept caused for its plain cash (migration 338); null otherwise. */
  kept: string | null;
  /** MNE-001-592 · The advance's IVA its unapply did not restore because a credit note restituted it (342). */
  restituted: string | null;
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
 * MNE-001-574 · An application that took that cash in the ledger stored what
 * it took (`advance_*`, from `keptOnAccount`), and takes exactly that here;
 * its undo puts it back, with its plain part's share of what it released.
 * Where an unapply stored what it kept caused (338), that is the IVA its cash
 * carries back.
 *
 * MNE-001-507 · A held cheque's events count on its cashing at the earliest
 * (`countedOn`), in the order they were dated. A share it ended before the
 * cashing released nothing, so the cash back on account carries the IVA the
 * share would have caused: the cashing is when that cash was collected, and
 * cash held on account is taxed the day it is collected (LIVA art. 1-B).
 *
 * MNE-001-593 · A credit note that restituted IVA from that taxed cash
 * (`kept_restitution`) is a pool event on the note's day: the cash it covers
 * (`restitutedCash`) is owed back and carries no IVA, so the pool drops by it
 * and its breakdown by the same share. The note's own month counts its IVA
 * from its entry (`issued-credit-notes.ts`); this event adds nothing to it.
 *
 * MNE-001-607 · One issued while the cheque was held (`held_restitution`)
 * took its IVA from 2125 alone, so its month counts none of it, and the
 * cashing causes the marker less it: the event counts on the cashing, after
 * the unapplies it follows, and takes its cash out of the month too.
 *
 * MNE-001-612 · When that note is reversed after the cashing, the pair its
 * reversal posted gives the cut back on the pair's day, into the pool and
 * that month, by default (`keptRestitutionsUpTo`).
 */
async function cashOnAccountOfMonth(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<CashOnAccountOfMonth[]> {
  const { rows } = await client.query<AllocationEventRow>(
    `WITH events AS (${SHARE_EVENTS}
     )
     SELECT pa.id::text AS allocation_id, pa.payment_id::text, cp.payment_amount::text,
            pa.invoice_id::text, pa.amount_applied::text AS amount, COALESCE(pa.iva_reclass_amount, 0)::text AS vat,
            (pa.advance_base_amount + pa.advance_iva_amount)::text AS advance_taken,
            pa.unapply_kept_iva_amount::text AS kept, pa.unapply_restituted_iva_amount::text AS restituted,
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
  const cuts = await keptRestitutionsUpTo(client, entityId, [...new Set(rows.map((r) => r.payment_id))], range.hasta);

  const byReceipt = new Map<string, AllocationEventRow[]>();
  for (const r of rows) byReceipt.set(r.payment_id, [...(byReceipt.get(r.payment_id) ?? []), r]);
  const out: CashOnAccountOfMonth[] = [];
  for (const [paymentId, allocations] of byReceipt) {
    let onAccount = new Decimal(allocations[0].payment_amount);
    let pool = { cash: new Decimal(0), breakdown: desgloseCero(), notSubject: new Decimal(0) };
    // MNE-001-574 · What each application took from that cash, which its undo puts back.
    const tookBy = new Map<string, { cash: Decimal; breakdown: Desglose; notSubject: Decimal }>();
    const month: CashOnAccountOfMonth = {
      paymentId, breakdown: desgloseCero(), notSubject: new Decimal(0), back: new Decimal(0), taken: new Decimal(0),
      neverReleased: new Decimal(0),
    };
    let touched = false;
    // MNE-001-591: `carried` is what the pool holds when it is less than the month's contribution.
    const putBack = (
      inMonth: boolean, cash: Decimal, split: Desglose, notSubject: Decimal, unreleased: boolean,
      carried = { cash, split, notSubject }
    ): void => {
      pool = {
        cash: pool.cash.plus(carried.cash), breakdown: sumarDesgloses(pool.breakdown, carried.split),
        notSubject: pool.notSubject.plus(carried.notSubject),
      };
      if (!inMonth) return;
      touched = true;
      month.breakdown = sumarDesgloses(month.breakdown, split);
      month.notSubject = month.notSubject.plus(notSubject);
      month.back = month.back.plus(ivaDelDesglose(split));
      if (unreleased) month.neverReleased = month.neverReleased.plus(ivaDelDesglose(split));
    };
    const order = (x: string, y: string): number => (x === y ? 0 : x < y ? -1 : 1);
    // On one day an unapply goes first (0), then a note's restitution from what it put back (1), then the pair
    // that gives a held one back (2, MNE-001-612), then an application (3).
    const rank = (e: { undo: boolean; cut: Decimal | null; restores: boolean }): number =>
      (e.undo ? 0 : e.cut ? (e.restores ? 2 : 1) : 3);
    const none = { cut: null, held: false, note: '', restores: false };
    const events = [
      ...allocations.flatMap((a) => [
        { day: a.applied_day, dated: a.dated_applied, undo: false, a, ...none },
        ...(a.undone_day ? [{ day: a.undone_day, dated: a.dated_undone ?? a.undone_day, undo: true, a, ...none }] : []),
      ]),
      ...(cuts.get(paymentId) ?? []).map((c) => ({
        day: c.day, dated: c.day, undo: false, a: allocations[0], cut: c.cash, held: c.held, note: c.note, restores: c.restores,
      })),
    ]
      .filter((e) => e.day <= range.hasta)
      .sort((x, y) => order(x.day, y.day) || order(x.dated, y.dated) || rank(x) - rank(y));
    // MNE-001-612: what each held note's cut took, which the pair of its reversal gives back.
    const heldCuts = new Map<string, { cash: Decimal; breakdown: Desglose; notSubject: Decimal }>();
    for (const { day, undo, a, cut, held, note, restores } of events) {
      if (cut && restores) {
        const took = heldCuts.get(note);
        if (!took) continue;
        heldCuts.delete(note);
        putBack(day >= range.desde, took.cash, took.breakdown, took.notSubject, false);
        continue;
      }
      if (cut) {
        // MNE-001-593: the cash a note's restitution covers leaves the pool, untaxed and owed back.
        const off = Decimal.min(cut, pool.cash);
        if (!off.greaterThan(0)) continue;
        const ratio = off.dividedBy(pool.cash);
        const out = scaled(pool.breakdown, ratio);
        const outNotSubject = new Decimal(q4(pool.notSubject.times(ratio)));
        pool = {
          cash: pool.cash.minus(off),
          breakdown: sumarDesgloses(pool.breakdown, scaled(out, -1)),
          notSubject: pool.notSubject.minus(outNotSubject),
        };
        if (held) heldCuts.set(note, { cash: off, breakdown: out, notSubject: outNotSubject });
        // MNE-001-607: a held cheque's was never caused, so the cashing's month does not count it either.
        if (held && day >= range.desde) {
          touched = true;
          month.breakdown = sumarDesgloses(month.breakdown, scaled(out, -1));
          month.notSubject = month.notSubject.minus(outNotSubject);
          month.back = month.back.minus(ivaDelDesglose(out));
        }
        continue;
      }
      const inMonth = day >= range.desde;
      const amount = new Decimal(a.amount);
      const advanceTaken = new Decimal(a.advance_taken);
      if (undo) {
        onAccount = onAccount.plus(amount);
        // MNE-001-574: the taxed cash this row took goes back with the IVA it carried.
        const took = tookBy.get(a.allocation_id);
        const sale = sales.get(a.invoice_id);
        // MNE-001-592: less what a credit note restituted, which the pool also loses with the cash it covers.
        if (took) putBack(inMonth, took.cash, ...restitutedOut(took, a.restituted, sale?.row));
        const plainCash = amount.minus(advanceTaken);
        if (!sale || !plainCash.greaterThan(0)) continue;
        // The ended share, read the way the invoice's own telescope reads it.
        const share = {
          aplicadoPrevio: q4(new Decimal(a.applied_before_undo ?? '0').minus(amount)),
          aplicadoAhora: q4(amount),
          totalDocumento: sale.row.total_amount,
          tasaCambio: sale.row.exchange_rate,
        };
        // A held cheque's share ended before its cashing stored 0: the IVA it
        // carries is the share's own, the invoice's telescope read here.
        // MNE-001-574: what the unapply kept caused, where it stored it, is the
        // figure the ledger and the pool read.
        // MNE-001-586: since then the unapply stores that figure too, and the cashing causes it in the ledger:
        // only a row closed before it, with no marker, never released.
        const unreleased = a.held && new Decimal(a.vat).isZero() && a.kept === null;
        // A row that also took taxed cash stored the kept IVA of its plain part
        // alone, which the scaling below brings back to that part.
        const vat = a.kept !== null
          ? new Decimal(a.kept).times(amount).dividedBy(plainCash)
          : unreleased
            ? new Decimal(acumuladoDelDocumento(sale.row.tax_amount, new Decimal(share.aplicadoPrevio).plus(amount).toFixed(4), sale.row.total_amount, sale.row.exchange_rate))
                .minus(acumuladoDelDocumento(sale.row.tax_amount, share.aplicadoPrevio, sale.row.total_amount, sale.row.exchange_rate))
            : new Decimal(a.vat);
        const split = desglosarDocumento({
          documentId: sale.row.id, documentNumber: sale.row.invoice_number, renglones: sale.source.lines,
          ivaCabecera: sale.row.tax_amount, ivaPagado: q4(vat), porcion: share, politicaBaseExenta: 'exigir_base', documentKind: 'invoice',
        }).desglose;
        const notSubject = new Decimal(porcionDelDocumento(sale.source.notSubject, share));
        // A row that took taxed cash puts back, for its plain part, that part's share of what it released.
        const ratio = plainCash.dividedBy(amount);
        const back = ratio.equals(1) ? split : scaled(split, ratio);
        const backNotSubject = ratio.equals(1) ? notSubject : new Decimal(q4(notSubject.times(ratio)));
        // MNE-001-591 (decision (A) on #792): where a note capped what the row kept, the month counts it as
        // today, but the pool carries forward only the cash that carries the kept IVA (`keptCashOf`), at that
        // cash's share of the base; the rest is owed back to the customer and stays untaxed.
        const carrying = a.kept === null
          ? plainCash
          : new Decimal(keptCashOf({ amount: a.amount, plain: plainCash.toFixed(4), released: a.vat, kept: a.kept }));
        const part = carrying.dividedBy(plainCash);
        putBack(
          inMonth, plainCash, back, backNotSubject, unreleased,
          carrying.equals(plainCash)
            ? undefined
            : { cash: carrying, split: scaledBase(back, part), notSubject: new Decimal(q4(backNotSubject.times(part))) }
        );
        continue;
      }
      // An application takes the cash on account that carries no IVA first, then that taxed cash; one that
      // took from it in the ledger (MNE-001-574, `keptOnAccount`) takes exactly what it stored.
      const untaxed = Decimal.max(onAccount.minus(pool.cash), 0);
      const take = advanceTaken.greaterThan(0)
        ? Decimal.min(advanceTaken, pool.cash)
        : Decimal.min(Decimal.max(amount.minus(untaxed), 0), pool.cash);
      onAccount = onAccount.minus(amount);
      if (!take.greaterThan(0)) continue;
      const whole = take.equals(pool.cash);
      const ratio = whole ? new Decimal(1) : take.dividedBy(pool.cash);
      const part = whole ? pool.breakdown : scaled(pool.breakdown, ratio);
      const partNotSubject = whole ? pool.notSubject : new Decimal(q4(pool.notSubject.times(ratio)));
      tookBy.set(a.allocation_id, { cash: take, breakdown: part, notSubject: partNotSubject });
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

/** MNE-001-612 · The panel key `keptRestitutionsUpTo` and `reversedAfterCashing` read (pending-catalog.ts). */
const NOTE_REVERSAL_KEY = 'note_reversal_after_cashing_iva';

interface KeptCut {
  day: string;
  cash: Decimal;
  held: boolean;
  /** The note's entry: a held cut and the pair that gives it back share it. */
  note: string;
  /** MNE-001-612 · The pair's event, which gives back what the note's cut took. */
  restores: boolean;
}

/**
 * MNE-001-593 · The restitutions credit notes dated up to `until` made from
 * these receipts' cash kept on account, by receipt: the note's day and the
 * cash each covers. Posted, unreversed note entries; entity-scoped.
 *
 * MNE-001-607 · and those made while the cheque was held (`held_restitution`,
 * read as their 2125 debit), counted on the cashing (`countedOn`), never
 * before it is recorded.
 *
 * MNE-001-612 · A held one whose note was reversed after the cashing left a
 * pair (`held_restitution_reversal`, `followNoteReversal` in
 * ar-ap-posting.ts). Under `note_reversal_after_cashing_iva = reversal_month`
 * (the default) its cut still stands on the cashing, and the pair is an event
 * of its own day (`restores`) that gives the cut back, so no month before it
 * moves. Under `cashing_month` the note counts in no month, as every
 * cancelled note (MNE-001-565). The key is read only when such a pair exists.
 */
async function keptRestitutionsUpTo(
  client: pg.PoolClient,
  entityId: string,
  paymentIds: readonly string[],
  until: string
): Promise<Map<string, KeptCut[]>> {
  // The pairs' own lines; their source and tag are ar-ap-posting.ts's HELD_RESTITUTION_REVERSAL_SOURCE and _UNDONE_TAG.
  const pairs = await client.query<{ payment_id: string; note: string; day: string; iva: string; total: string; tax: string }>(
    `SELECT l.tags -> 'held_restitution_undone' ->> 'payment_id' AS payment_id,
            l.tags -> 'held_restitution_undone' ->> 'note_entry_id' AS note, je.entry_date::text AS day,
            (COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS iva,
            i.total_amount::text AS total, i.tax_amount::text AS tax
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1 AND je.source_type = 'held_restitution_reversal'
                              AND je.status = 'posted' AND je.is_reversal = false
       JOIN invoices i ON i.id::text = l.tags -> 'held_restitution_undone' ->> 'invoice_id' AND i.entity_id = $1
      WHERE l.tags -> 'held_restitution_undone' ->> 'payment_id' = ANY($2::text[])
      ORDER BY je.entry_date, je.entry_number`,
    [entityId, [...paymentIds]]
  );
  const tenant = pairs.rows.length === 0
    ? null
    : (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM legal_entities WHERE id = $1', [entityId])).rows[0]?.tenant_id;
  const restore = typeof tenant === 'string' &&
    (await getPolicy({ tenantId: tenant, entityId }, NOTE_REVERSAL_KEY, client)).value !== 'cashing_month';
  const { rows } = await client.query<{ payment_id: string; day: string; iva: string; total: string; tax: string; held: boolean; note: string }>(
    `SELECT * FROM (
       SELECT t.tag ->> 'payment_id' AS payment_id, t.held, je.id::text AS note,
              (CASE WHEN t.held THEN ${countedOn('cp', 'je.entry_date')} ELSE je.entry_date END)::text AS day,
              (CASE WHEN t.held THEN COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)
                    ELSE COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0) END)::text AS iva,
              i.total_amount::text AS total, i.tax_amount::text AS tax, je.entry_number
         FROM journal_entry_lines l
         JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1 AND je.source_type = 'credit_note'
                                AND je.status = 'posted' AND je.is_reversal = false
        CROSS JOIN LATERAL (SELECT l.tags ? '${HELD_RESTITUTION_TAG}' AS held,
                                   COALESCE(l.tags -> '${KEPT_RESTITUTION_TAG}', l.tags -> '${HELD_RESTITUTION_TAG}') AS tag) t
         JOIN invoices i ON i.id::text = t.tag ->> 'invoice_id' AND i.entity_id = $1
         JOIN customer_payments cp ON cp.id::text = t.tag ->> 'payment_id' AND cp.entity_id = $1
        WHERE t.tag ->> 'payment_id' = ANY($2::text[])
          AND (je.reversed_by_entry_id IS NULL OR (t.held AND je.id::text = ANY($4::text[])))
     ) x
     WHERE x.day IS NOT NULL AND x.day::date <= $3::date
     ORDER BY x.day, x.entry_number`,
    [entityId, [...paymentIds], until, restore ? pairs.rows.map((p) => p.note) : []]
  );
  const out = new Map<string, KeptCut[]>();
  const add = (paymentId: string, cut: KeptCut): void => {
    out.set(paymentId, [...(out.get(paymentId) ?? []), cut]);
  };
  for (const r of rows) {
    add(r.payment_id, { day: r.day, cash: new Decimal(restitutedCash(r.iva, r.total, r.tax)), held: r.held, note: r.note, restores: false });
  }
  for (const p of restore ? pairs.rows.filter((x) => x.day <= until) : []) {
    add(p.payment_id, { day: p.day, cash: new Decimal(restitutedCash(p.iva, p.total, p.tax)), held: true, note: p.note, restores: true });
  }
  return out;
}

/**
 * MNE-001-612 · Under `note_reversal_after_cashing_iva = cashing_month`, the
 * receipts with a pair of a held note reversed after their cashing, which the
 * tie-out names with the amended return. Empty under the default, which
 * counts that IVA where the ledger does. The key is read only when a pair
 * exists. Entity-scoped.
 */
async function reversedAfterCashing(client: pg.PoolClient, ctx: { tenantId: string; entityId: string }): Promise<Set<string>> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT source_id::text AS id FROM journal_entries
      WHERE entity_id = $1 AND source_type = 'held_restitution_reversal' AND status = 'posted' AND is_reversal = false`,
    [ctx.entityId]
  );
  if (rows.length === 0 || (await getPolicy(ctx, NOTE_REVERSAL_KEY, client)).value !== 'cashing_month') return new Set();
  return new Set(rows.map((r) => r.id));
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
export interface ReceiptLedgerRow {
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
 * included, each with what it moved in 2120 (credit positive). The entries are
 * listed here; what each moved comes from report-service (MNE-001-437), and an
 * entry with no 2120 line reads 0.
 */
export async function receiptLedgerOfMonth(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<ReceiptLedgerRow[]> {
  const { rows } = await client.query<Omit<ReceiptLedgerRow, 'iva'> & { entry_id: string }>(
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
            je.entry_date::text AS entry_date, je.source_type, t.mirror, je.id::text AS entry_id
       FROM touched t
       JOIN journal_entries je ON je.id = t.id AND je.entity_id = $1 AND je.status = 'posted'
       JOIN customer_payments cp ON cp.id = t.payment_id AND cp.entity_id = $1
      WHERE je.entry_date >= $2::date AND je.entry_date <= $3::date
        AND EXISTS (SELECT 1 FROM journal_entry_lines jel WHERE jel.journal_entry_id = je.id)
      GROUP BY t.payment_id, cp.payment_number, cp.status, cp.payment_method, cp.reversal_cause, je.id, je.entry_number, je.entry_date, je.source_type, t.mirror
      ORDER BY cp.payment_number, je.entry_date, je.entry_number`,
    [entityId, range.desde, range.hasta, RECEIPT_LEDGER_SOURCES]
  );
  const moved = await netOnRole(client, entityId, 'iva_trasladado', [...new Set(rows.map((r) => r.entry_id))]);
  return rows.map(({ entry_id, ...r }) => ({ ...r, iva: q4(new Decimal(0).minus(moved.get(entry_id) ?? 0)) }));
}

const ENTRY_KIND: Record<string, string> = {
  customer_payment: 'cobro',
  receipt_application: 'aplicación',
  receipt_unapplication: 'desaplicación',
  [CUSTOMER_CHECK_CASHING_SOURCE]: 'cobro del cheque',
  receipt_reversal_iva: 'IVA restituido que se queda',
  held_restitution_reversal: 'corrección por la nota reversada después del cobro',
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
function gapCauses(
  charged: ChargedOfMonth, ledger: readonly ReceiptLedgerRow[], undone: ReadonlySet<string> = new Set()
): GapCause[] {
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
    // Since MNE-001-574 only a row unapplied before migration 338, or under repark_same_month (MNE-001-585), re-parked in the ledger.
    // MNE-001-581: after a credit note an unapply re-parks less than the share
    // it ended, so the clause names what its entries took out of 2120.
    const outOf2120 = entries
      .filter((e) => e.source_type === 'receipt_unapplication' && !e.mirror)
      .reduce((s, e) => s.minus(e.iva), new Decimal(0));
    const reparked = cash ? Decimal.min(cash.back.minus(cash.neverReleased), Decimal.max(outOf2120, 0)) : new Decimal(0);
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
    if (undone.has(paymentId)) {
      why.push(
        `una nota de crédito emitida mientras el cheque esperaba se reversó después del cobro, y ${NOTE_REVERSAL_KEY} = ` +
          'cashing_month la lee como nunca emitida (CFF art. 29-A): el papel causa ese IVA el día del cobro y la ' +
          'corrección del mayor, el día de la reversa; si la declaración del mes del cobro ya se presentó, se corrige ' +
          'con una complementaria (CFF art. 32)'
      );
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

/** MNE-001-583 · What one issued credit note restituted from a receipt's cash that never became the firm's. */
export interface UncausedRestitution {
  noteId: string;
  noteNumber: string;
  entryNumber: string;
  noteDate: string;
  paymentId: string;
  paymentNumber: string;
  reversedOn: string;
  amount: Decimal;
}

/**
 * MNE-001-583 (#814; LIVA arts. 1-B and 7) · By note id, the IVA each issued
 * credit note restituted from a receipt later reversed as `not_collected`:
 * IVA that receipt never caused, so the note restituted nothing of it. What a
 * receipt's notes restituted is read from the ledger: the mirrors cancel its
 * other entries, so its life-net 2120 is the 2120 credit of its reversal's
 * corrections (`receipt_reversal_iva`, MNE-001-581 and 593). It goes to the
 * standing notes on the invoices it released IVA on, written before the
 * reversal (the correction read those), in date and number order, each up to
 * what its entry debited to 2120. The split by invoice is not stored, so a
 * receipt over two invoices with notes in two months splits in that order.
 */
async function uncausedRestitutions(client: pg.PoolClient, entityId: string): Promise<Map<string, UncausedRestitution[]>> {
  const out = new Map<string, UncausedRestitution[]>();
  const receipts = await client.query<{ id: string; payment_number: string; reversed_on: string; entry_ids: string[] }>(
    `SELECT cp.id::text, cp.payment_number, ${REVERSED_ON}::text AS reversed_on, array_agg(c.id::text) AS entry_ids
       FROM customer_payments cp ${MIRROR_OF_RECEIPT}
       JOIN journal_entries c ON c.entity_id = $1 AND c.source_type = 'receipt_reversal_iva' AND c.source_id = cp.id
                             AND c.status = 'posted' AND c.reversed_by_entry_id IS NULL
      WHERE cp.entity_id = $1 AND cp.status = 'reversed' AND cp.journal_entry_id IS NOT NULL AND ${REVERSAL_CAUSE} = 'not_collected'
      GROUP BY cp.id, cp.payment_number, cp.reversed_at, m.entry_date
      ORDER BY cp.reversed_at, cp.payment_number`,
    [entityId]
  );
  if (receipts.rows.length === 0) return out;
  const notes = await client.query<{ id: string; credit_note_number: string; entry_id: string; entry_number: string; entry_date: string; payment_id: string }>(
    `SELECT DISTINCT cn.id::text, cn.credit_note_number, je.id::text AS entry_id, je.entry_number,
            je.entry_date::text AS entry_date, pa.payment_id::text
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
       JOIN credit_notes cn ON cn.invoice_id = pa.invoice_id AND cn.entity_id = $1 AND cn.status NOT IN ('draft', 'void')
       JOIN journal_entries je ON je.id = cn.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
                              AND je.source_type = 'credit_note' AND je.reversed_by_entry_id IS NULL
      WHERE pa.payment_id = ANY($2::uuid[]) AND COALESCE(pa.iva_reclass_amount, 0) > 0 AND je.created_at <= cp.reversed_at
      ORDER BY entry_date, cn.credit_note_number`,
    [entityId, receipts.rows.map((r) => r.id)]
  );
  const restituted = await netOnRole(client, entityId, 'iva_trasladado', [...new Set(notes.rows.map((n) => n.entry_id))]);
  const left = new Map(notes.rows.map((n) => [n.id, restituted.get(n.entry_id) ?? new Decimal(0)]));
  const kept = await netOnRole(client, entityId, 'iva_trasladado', receipts.rows.flatMap((r) => r.entry_ids));
  for (const r of receipts.rows) {
    let rest = r.entry_ids.reduce((s, id) => s.minus(kept.get(id) ?? 0), new Decimal(0));
    for (const n of notes.rows.filter((x) => x.payment_id === r.id)) {
      const take = Decimal.min(rest, left.get(n.id) ?? 0);
      if (!take.greaterThan(0)) continue;
      left.set(n.id, (left.get(n.id) as Decimal).minus(take));
      rest = rest.minus(take);
      out.set(n.id, [...(out.get(n.id) ?? []), {
        noteId: n.id, noteNumber: n.credit_note_number, entryNumber: n.entry_number, noteDate: n.entry_date,
        paymentId: r.id, paymentNumber: r.payment_number, reversedOn: r.reversed_on, amount: take,
      }]);
    }
  }
  return out;
}

/** How a finding names a receipt's cause, with the identifier the CLI takes. */
const CAUSE_LABEL: Record<ReversalReading, string> = {
  not_collected: 'con la causa not_collected (no cobrado)',
  taken_back: 'con la causa taken_back (retirado)',
  not_stated: 'sin causa declarada',
};

/** When a row was written, at a fixed width, so the text orders as the instants do. */
const written = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

const NOTE_UNDO_TAIL = 'Las pólizas posteadas se quedan (NIF B-1); si hace falta una corrección, la decide una persona.';

/**
 * MNE-001-606 (#814, part 2/2 of MNE-001-583; 581 risks 5 and 6) · The undoes
 * of the month that a credit note's restitution should have capped and did
 * not, and the notes reversed by hand in the month after an unapply they
 * capped. Read from the entries, since no row stores what 581 kept: a note
 * restituted from 2120 what its entry debited there (575), and each later
 * unapply or reversal on its invoice should have left in 2120 the part of its
 * release that restitution still covers (LIVA art. 7), which uses it up:
 * `due = min(release, what is left)`, the notes taken in the order they were
 * written, only those standing at the undo and still standing. What it kept
 * is its release less what its entry credited to 2125 (an unapply's, matched
 * by the description `postReceiptUnapplicationEntry` writes), or what its
 * `receipt_reversal_iva` debited to 2125 (a reversal's). Kept less than due:
 * it was posted under the rule before 581. Kept more, and a note it counted
 * was reversed by hand since: that IVA is owed again and nothing re-parked it.
 * It only names: nothing posted changes (NIF B-1). Scoped by `entity_id`.
 */
async function undoesAfterNotes(client: pg.PoolClient, entityId: string, month: string): Promise<Hallazgo[]> {
  const notes = await client.query<{
    id: string; credit_note_number: string; invoice_id: string; invoice_number: string; entry_id: string; entry_number: string;
    entry_date: string; written: string; mirror_number: string | null; mirror_date: string | null; mirror_written: string | null;
  }>(
    `SELECT cn.id::text, cn.credit_note_number, cn.invoice_id::text, i.invoice_number, je.id::text AS entry_id, je.entry_number,
            je.entry_date::text AS entry_date, ${written('je.created_at')} AS written, m.entry_number AS mirror_number,
            m.entry_date::text AS mirror_date, ${written('m.created_at')} AS mirror_written
       FROM credit_notes cn
       JOIN invoices i ON i.id = cn.invoice_id AND i.entity_id = $1
       JOIN journal_entries je ON je.id = cn.journal_entry_id AND je.entity_id = $1 AND je.status = 'posted'
                              AND je.source_type = 'credit_note'
       LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id AND m.entity_id = $1
      WHERE cn.entity_id = $1 AND cn.status NOT IN ('draft', 'void')
        AND EXISTS (SELECT 1 FROM payment_allocations pa JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
                     WHERE pa.invoice_id = cn.invoice_id AND pa.unapplied_at IS NOT NULL)
      ORDER BY written, cn.credit_note_number`,
    [entityId]
  );
  if (notes.rows.length === 0) return [];
  const debit = await netOnRole(client, entityId, 'iva_trasladado', notes.rows.map((n) => n.entry_id));
  const restituting = notes.rows
    .map((n) => ({ ...n, debit: debit.get(n.entry_id) ?? new Decimal(0) }))
    .filter((n) => n.debit.greaterThan('0.005'));
  if (restituting.length === 0) return [];
  const undoes = await client.query<{
    invoice_id: string; payment_id: string; payment_number: string; by_reversal: boolean; day: string;
    cause: ReversalReading; reversed_written: string | null; released: string;
  }>(
    `SELECT e.invoice_id, e.payment_id, e.payment_number, e.by_reversal, e.day, e.cause, e.reversed_written,
            SUM(e.released)::text AS released
       FROM (SELECT pa.invoice_id::text AS invoice_id, cp.id::text AS payment_id, cp.payment_number,
                    ${CLOSED_BY_REVERSAL} AS by_reversal,
                    (CASE WHEN ${CLOSED_BY_REVERSAL} THEN ${REVERSED_ON} ELSE pa.unapplied_at::date END)::text AS day,
                    ${REVERSAL_CAUSE} AS cause, ${written('cp.reversed_at')} AS reversed_written,
                    COALESCE(pa.iva_reclass_amount, 0) AS released
               FROM payment_allocations pa
               JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1 ${MIRROR_OF_RECEIPT}
              WHERE pa.invoice_id = ANY($2::uuid[]) AND pa.unapplied_at IS NOT NULL) e
      GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    [entityId, [...new Set(restituting.map((n) => n.invoice_id))]]
  );
  const entries = await client.query<{
    id: string; payment_id: string; source_type: string; entry_number: string; entry_date: string; description: string; written: string;
  }>(
    `SELECT je.id::text, je.source_id::text AS payment_id, je.source_type, je.entry_number, je.entry_date::text AS entry_date,
            je.description, ${written('je.created_at')} AS written
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_id = ANY($2::uuid[])
        AND (je.source_type = 'receipt_unapplication'
             OR (je.source_type = 'receipt_reversal_iva' AND je.reversed_by_entry_id IS NULL))
      ORDER BY written`,
    [entityId, [...new Set(undoes.rows.map((u) => u.payment_id))]]
  );
  // Debit positive: an unapply credits 2125 what it re-parked, a reversal's correction debits it.
  const on2125 = await netOnRole(client, entityId, reclassRoles('issued').from, entries.rows.map((e) => e.id));
  const moved = (ids: readonly string[]) => ids.reduce((s, id) => s.plus(on2125.get(id) ?? 0), new Decimal(0));
  const unapplications = new Map<string, typeof entries.rows>();
  const corrections = new Map<string, string[]>();
  for (const e of entries.rows) {
    if (e.source_type === 'receipt_reversal_iva') corrections.set(e.payment_id, [...(corrections.get(e.payment_id) ?? []), e.id]);
    else {
      const key = `${e.payment_id}|${e.entry_date}|${e.description}`;
      unapplications.set(key, [...(unapplications.get(key) ?? []), e]);
    }
  }
  const notesText = (taken: ReadonlyArray<{ n: (typeof restituting)[number] }>) =>
    taken.map(({ n }) => `${n.credit_note_number} (póliza ${n.entry_number}, ${n.entry_date})`).join(', ');

  const findings: Hallazgo[] = [];
  const reversals = new Map<string, {
    paymentNumber: string; day: string; cause: ReversalReading; invoices: string[]; due: Decimal;
    taken: Array<{ n: (typeof restituting)[number]; amount: Decimal }>;
  }>();
  for (const invoiceId of new Set(restituting.map((n) => n.invoice_id))) {
    const mine = restituting.filter((n) => n.invoice_id === invoiceId).map((n) => ({ n, left: n.debit }));
    const invoiceNumber = mine[0].n.invoice_number;
    const events = undoes.rows.filter((u) => u.invoice_id === invoiceId).flatMap((u) => {
      if (u.by_reversal) return u.reversed_written ? [{ u, at: u.reversed_written, own: [] as typeof entries.rows }] : [];
      const own = unapplications.get(`${u.payment_id}|${u.day}|Unapplication of ${u.payment_number} from ${invoiceNumber}`) ?? [];
      return own.length ? [{ u, at: own[0].written, own }] : [];
    }).sort((a, b) => a.at.localeCompare(b.at));
    for (const { u, at, own } of events) {
      const released = new Decimal(u.released);
      let due = new Decimal(0);
      const taken: Array<{ n: (typeof restituting)[number]; amount: Decimal }> = [];
      for (const x of mine.filter((m) => m.n.written < at && m.n.mirror_written === null)) {
        const take = Decimal.min(x.left, released.minus(due));
        if (!take.greaterThan(0)) continue;
        x.left = x.left.minus(take);
        due = due.plus(take);
        taken.push({ n: x.n, amount: take });
      }
      if (u.by_reversal) {
        const r = reversals.get(u.payment_id) ??
          { paymentNumber: u.payment_number, day: u.day, cause: u.cause, invoices: [], due: new Decimal(0), taken: [] };
        if (due.greaterThan(0)) r.invoices.push(invoiceNumber);
        reversals.set(u.payment_id, { ...r, due: r.due.plus(due), taken: [...r.taken, ...taken] });
        continue;
      }
      const reparked = moved(own.map((e) => e.id)).negated();
      const kept = Decimal.max(released.minus(reparked), 0);
      const entry = own.map((e) => e.entry_number).join(', ');
      if (due.minus(kept).greaterThan('0.01') && u.day.startsWith(month)) {
        findings.push({
          codigo: 'IVA-WP-UNDO-AFTER-NOTE-OLD-RULE', severidad: 'aviso', documentId: u.payment_id, documentNumber: u.payment_number,
          mensaje: `La desaplicación ${entry} del ${u.day} del cobro ${u.payment_number} sobre la factura ${invoiceNumber} se ` +
            `posteó con la regla anterior a MNE-001-581: re-aparcó en iva_trasladado_no_cobrado ${q4(reparked)} de IVA, y ` +
            `${q4(due.minus(kept))} debieron quedarse en iva_trasladado, porque la nota de crédito ${notesText(taken)} ya los ` +
            `restituyó (LIVA art. 7): iva_trasladado_no_cobrado guarda ese IVA y ningún cobro lo va a liberar. ${NOTE_UNDO_TAIL}`,
        });
      }
      // 581 risk 6: what it kept beyond what is due now was kept for a note reversed by hand since.
      let excess = kept.minus(due);
      for (const x of mine.filter((m) => m.n.written < at && m.n.mirror_written !== null && m.n.mirror_written > at)) {
        const amount = Decimal.min(excess, x.n.debit);
        if (!amount.greaterThan('0.01')) break;
        excess = excess.minus(amount);
        if (!(x.n.mirror_date ?? '').startsWith(month)) continue;
        findings.push({
          codigo: 'IVA-WP-NOTE-REVERSED-AFTER-CAP', severidad: 'aviso', documentId: x.n.id, documentNumber: x.n.credit_note_number,
          mensaje: `La póliza ${x.n.entry_number} de la nota de crédito ${x.n.credit_note_number} se reversó a mano con la póliza ` +
            `${x.n.mirror_number} del ${x.n.mirror_date}, después de la desaplicación ${entry} del cobro ${u.payment_number} del ` +
            `${u.day}, que dejó ${q4(amount)} en iva_trasladado porque esa nota los había restituido (MNE-001-581). Sin la nota, ` +
            `la factura ${invoiceNumber} vuelve a deber ese IVA y nada lo re-aparcó en iva_trasladado_no_cobrado (LIVA art. 1-B). ` +
            NOTE_UNDO_TAIL,
        });
      }
    }
  }
  for (const [paymentId, r] of reversals) {
    const corrected = moved(corrections.get(paymentId) ?? []);
    const gap = r.due.minus(corrected);
    const noteMonths = r.cause === 'not_collected' ? r.taken.map((t) => t.n.entry_date.slice(0, 7)) : [];
    if (!gap.greaterThan('0.01') || !(r.day.startsWith(month) || noteMonths.includes(month))) continue;
    findings.push({
      codigo: 'IVA-WP-UNDO-AFTER-NOTE-OLD-RULE', severidad: 'aviso', documentId: paymentId, documentNumber: r.paymentNumber,
      mensaje: `La reversa del cobro ${r.paymentNumber} del ${r.day} (${CAUSE_LABEL[r.cause]}) se posteó con la regla anterior a ` +
        `MNE-001-581: sus espejos re-aparcaron en iva_trasladado_no_cobrado todo lo que el cobro liberó de la factura ` +
        `${r.invoices.join(', ')} sin la corrección receipt_reversal_iva, y ${q4(gap)} debieron quedarse en iva_trasladado, ` +
        `porque la nota de crédito ${notesText(r.taken)} ya los restituyó (LIVA art. 7).` +
        (noteMonths.length
          ? ` Como el dinero nunca llegó, ese IVA nunca se causó (LIVA art. 1-B): ` +
            r.taken.map((t) => `el mes de la nota ${t.n.credit_note_number}, ${t.n.entry_date.slice(0, 7)}, restó ${q4(t.amount)} ` +
              'de IVA que nunca se causó').join('; ') +
            ', y si esa declaración ya se presentó se corrige con una complementaria (CFF art. 32).'
          : '') +
        ` ${NOTE_UNDO_TAIL}`,
    });
  }
  return findings;
}

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
 * MNE-001-583 (#814) · What a credit note restituted from a receipt reversed
 * as not_collected was never caused (`uncausedRestitutions`), so the note's
 * month no longer subtracts it: that month names the note and its amended
 * return, and every other month the finding is in names the note's month.
 *
 * The figures named are the ones the paper counts for the receipt: a PPD
 * share's base is its cash, withholding included, less its IVA.
 */
async function reversalFindings(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes,
  ledger: readonly ReceiptLedgerRow[],
  uncaused: ReadonlyMap<string, readonly UncausedRestitution[]>
): Promise<Hallazgo[]> {
  const month = range.desde.slice(0, 7);
  const restituted = [...uncaused.values()].flat();
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
        -- MNE-001-499: a transfer's reversal moved no money; its applications count on their own days.
        AND cp.payment_method <> 'balance_transfer'
        AND (${REVERSED_ON} >= $2::date OR cp.id = ANY($3::uuid[]))
      ORDER BY cp.payment_number`,
    [entityId, range.desde, [...new Set([
      ...again.rows.map((r) => r.reversed_id), ...restituted.filter((u) => u.noteDate.startsWith(month)).map((u) => u.paymentId),
    ])]]
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
    const mine = restituted.filter((u) => u.paymentId === r.id);
    const notesHere = mine.filter((u) => u.noteDate.startsWith(month));
    if (!countsHere && mirrored.isZero() && collectedAgain.length === 0 && notesHere.length === 0) continue;
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
    for (const u of notesHere) {
      parts.push(
        `La nota de crédito ${u.noteNumber} del ${u.noteDate} (póliza ${u.entryNumber}) restituyó ${q4(u.amount)} de IVA que el ` +
          `cobro ${r.payment_number} nunca causó: se reversó el ${r.reversed_on} ${CAUSE_LABEL[r.cause]} (LIVA art. 1-B), y lo ` +
          `que no se causó no se restituye (LIVA art. 7), así que este mes no lo resta. Si la declaración de ${month} ya se ` +
          `presentó restándolo, se corrige con una complementaria (CFF art. 32).`
      );
    }
    for (const u of mine.filter((x) => !x.noteDate.startsWith(month))) {
      parts.push(
        `La nota ${u.noteNumber}, en ${u.noteDate.slice(0, 7)}, restituyó ${q4(u.amount)} que este cobro no causó: esa ` +
          `declaración también se corrige con una complementaria.`
      );
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
  advance_iva: string;
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
            (pa.advance_base_amount + pa.advance_iva_amount)::text AS advance_taken, pa.advance_iva_amount::text AS advance_iva,
            (pa.unapplied_at IS NULL) AS live
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
    // MNE-001-573: a live PPD row's advance IVA was deferred, and its share above causes it instead.
    if (r.live && new Decimal(r.advance_iva).greaterThan(0)
        && (await resolveInvoiceMetodoPago(client, { ...r, entity_id: entityId })).metodo === 'PPD') {
      iva = iva.minus(r.advance_iva);
    }
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
   * 'credit_note': a credit note, subtracted: issued on the charged side (MNE-001-565),
   * received on the creditable side (MNE-001-760; the id is its CFDI's row).
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
  /** MNE-001-583 · what each note restituted from a receipt reversed as never collected, any month. */
  uncaused: Map<string, UncausedRestitution[]>;
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
  const withheldOf = await withheldPerSale(client, entityId, [...picked.map((p) => p.row), ...issuedInMonth.rows]);
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
  // MNE-001-583: less what it restituted that a receipt reversed as never collected did not cause.
  const uncaused = await uncausedRestitutions(client, entityId);
  const notes = await issuedCreditNotesOfRange(client, entityId, range, uncaused);
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
    uncaused,
  };
}

/**
 * The journal entries of each bill's cash event, for the bills the DIOT's facts
 * picked: the bill's own entry (a `bill` fact) or, for a `payment` fact, the
 * entries dated in the month of the payments applied to it in the month: their
 * own, their applications' (`vendor_application`, MNE-001-679) and the cashing
 * entries of the cheques cashed in it, and the entries that took the VAT out
 * of an application the month undid (MNE-001-682). Both the selection of bills
 * and which event each one has stay `hechosDelMes`'s (MNE-001-491: where the
 * VAT sits, not the method); this only looks the entries up.
 */
async function billEntryIds(
  client: pg.PoolClient,
  entityId: string,
  facts: ReadonlyArray<Pick<HechoPagado, 'billId' | 'event' | 'undoneInMonth'>>,
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
          AND ${APPLIED_ON} >= $3::date AND ${APPLIED_ON} <= $4::date
        GROUP BY pa.bill_id`,
      [entityId, byPayment, range.desde, range.hasta]
    );
    for (const r of rows) out.set(r.id, r.entries);
    // A cheque cashed in the month (MNE-001-559): its cashing entry is the one
    // that credited the IVA, so the bill traces to it. One whose own entry
    // credited the IVA has no cashing entry, and its payment entry is above.
    // The cashing entry is found by its own day: since MNE-001-778 it is the
    // later day its applications were applied on when that follows the bank's.
    // Cash on account applied in the month (MNE-001-679): the application's
    // entry credited the IVA, dated the day its row stores. A row with no
    // stored day names no entry and keeps its payment's, above.
    const later = await client.query<{ id: string; entry: string }>(
      `SELECT DISTINCT pa.bill_id AS id, je.id::text AS entry
         FROM payment_applications pa
         JOIN vendor_payments vp ON vp.id = pa.payment_id
         JOIN bills b ON b.id = pa.bill_id
         JOIN journal_entries je ON je.source_id = vp.id AND je.entity_id = vp.entity_id AND je.status = 'posted'
                                AND je.source_type IN ('${ORIGEN_COBRO_DE_CHEQUE}', 'vendor_application')
        WHERE b.entity_id = $1 AND vp.entity_id = $1 AND pa.bill_id = ANY($2::uuid[])
          AND vp.status <> 'void'
          AND ((je.source_type = '${ORIGEN_COBRO_DE_CHEQUE}'
                AND je.entry_date >= $3::date AND je.entry_date <= $4::date)
            OR (je.source_type = 'vendor_application' AND je.entry_date = pa.applied_on
                AND pa.applied_on >= $3::date AND pa.applied_on <= $4::date))
        ORDER BY 1, 2`,
      [entityId, byPayment, range.desde, range.hasta]
    );
    for (const r of later.rows) out.set(r.id, [...(out.get(r.id) ?? []), r.entry]);
    // An application the month undid (MNE-001-682): the unapplication's entry,
    // dated the day its row was closed, and the mirrors a reversal posted that
    // day. Asked only when a fact of the month says it undid something.
    // NOTE: neither entry names its bill, so two bills one payment was undone
    // from on the same day each trace both.
    const undone = facts.filter((h) => h.event === 'payment' && !new Decimal(h.undoneInMonth).isZero()).map((h) => h.billId);
    if (undone.length > 0) {
      const undoes = await client.query<{ id: string; entry: string }>(
        `SELECT DISTINCT pa.bill_id AS id, e.id::text AS entry
           FROM payment_applications pa
           JOIN vendor_payments vp ON vp.id = pa.payment_id
           JOIN bills b ON b.id = pa.bill_id
           JOIN journal_entries je ON je.source_id = vp.id AND je.entity_id = vp.entity_id AND je.status = 'posted'
                                  AND je.source_type IN ('vendor_payment', 'vendor_application', 'vendor_unapplication',
                                                         '${ORIGEN_COBRO_DE_CHEQUE}')
           LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id AND m.entity_id = je.entity_id
          CROSS JOIN LATERAL (VALUES (je.id, je.source_type = 'vendor_unapplication' AND je.entry_date = ${UNDONE_ON}),
                                     (m.id, m.entry_date = ${UNDONE_ON})) e(id, hit)
          WHERE b.entity_id = $1 AND vp.entity_id = $1 AND pa.bill_id = ANY($2::uuid[])
            AND vp.status <> 'void'
            AND ${UNDONE_ON} >= $3::date AND ${UNDONE_ON} <= $4::date AND e.hit
          ORDER BY 1, 2`,
        [entityId, undone, range.desde, range.hasta]
      );
      for (const r of undoes.rows) out.set(r.id, [...(out.get(r.id) ?? []), r.entry]);
    }
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
  /**
   * Where `figures.priorBalanceInFavor` comes from (MNE-001-386): the returns
   * filed, oldest first and capped at the month's tax (LIVA art. 6), or a
   * person's figure with its reason. Amounts in two decimals.
   */
  priorBalance: {
    origin: 'filed_returns' | 'override';
    reason: string | null;
    cap: string;
    available: string;
    /** What the record would credit. */
    proposed: string;
    credited: string;
    balances: PriorBalance[];
  };
  /** The month's net movement of each IVA role account, debit positive. */
  ledger: Record<IvaRole, string>;
  findings: Hallazgo[];
}

export interface IvaWorkpaperOptions {
  tenantId: string;
  entityId: string;
  year: number;
  month: number;
  /**
   * A person's figure instead of the one the returns filed give, and why:
   * both or neither. Without them the record of filed returns decides.
   */
  priorBalanceInFavor?: string;
  priorBalanceReason?: string;
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
  const reason = opts.priorBalanceReason?.trim() || undefined;
  if ((opts.priorBalanceInFavor === undefined) !== (reason === undefined)) {
    throw new ValidationError({ key: 'filing.workpaper.prior_balance_override_incomplete', params: {} }, 'priorBalanceReason');
  }
  const override = opts.priorBalanceInFavor === undefined ? null : priorBalanceOf(opts.priorBalanceInFavor);
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

    // MNE-001-754: read once a month; under payment_month the facts name what they count apart from the ledger.
    const undoMonth = await readVendorUndoIvaMonth(ctx, client);
    const { hechos: facts, hallazgos: factFindings, apartFromLedger } = await hechosDelMes(client, entityId, year, month, undoMonth.value);
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
    // MNE-001-760 · a received credit note, less what its own entry took out of 1130 (never what left 1135).
    const receivedNotes = await receivedCreditNotesOfRange(client, entityId, range, exemptBase);
    creditable = sumarDesgloses(creditable, receivedNotes.breakdown);
    creditableContributions.push(...receivedNotes.contributions);
    findings.push(...receivedNotes.findings);

    const ledger = await roleMovements(client, tenantId, entityId, range);
    const net = (r: IvaRole): Decimal => ledger[r].debit.minus(ledger[r].credit);
    const receiptLedger = await receiptLedgerOfMonth(client, entityId, range);
    findings.push(...(await reversalFindings(client, entityId, range, receiptLedger, charged.uncaused)));
    // MNE-001-606: undoes after a note posted under the rule before 581, and notes reversed by hand after a capped unapply.
    findings.push(...(await undoesAfterNotes(client, entityId, range.desde.slice(0, 7))));
    findings.push(...(await checkFindings(client, entityId, range)));
    tieOut(
      findings, 'IVA-WP-CHARGED-VS-LEDGER', 'IVA trasladado cobrado por tasa', 'iva_trasladado',
      ivaDelDesglose(charged.breakdown), net('iva_trasladado').negated(),
      [...gapCauses(charged, receiptLedger, await reversedAfterCashing(client, ctx)), ...charged.noteCauses]
    );
    tieOut(
      findings, 'IVA-WP-CREDITABLE-VS-LEDGER', 'IVA acreditable pagado por tasa', 'iva_acreditable', ivaDelDesglose(creditable), net('iva_acreditable'),
      [...fees.causes, ...receivedNotes.causes, ...apartFromLedger.map((a) => ({ amount: new Decimal(a.iva), text: a.text }))]
    );
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

    const noPrior: IvaWorkpaperFigures = {
      charged: charged.breakdown,
      chargedNotSubject: charged.notSubject,
      creditable,
      withheldByCustomers: charged.withheld,
      // Credits only, for the same reason: what was withheld in the month.
      withheldToRemit: q4(ledger.iva_retenido_por_pagar.credit),
      priorBalanceInFavor: q4(0),
      proration,
    };
    // MNE-001-386: the cap is the result with no prior balance, in the column it is declared in.
    const before = settleIva(noPrior, rounding);
    const sources = await balancesInFavorBefore(
      entityScope(tenantId, entityId), 'iva_monthly', `${year}-${String(month).padStart(2, '0')}`, client
    );
    const proposal = proposePriorCredit(sources, rounding === 'cada_renglon' ? before.resultWhole : before.resultCents, rounding);
    findings.push(...(override === null ? proposal.findings : overrideFindings(override, reason ?? '', proposal, rounding)));
    const figures: IvaWorkpaperFigures = { ...noPrior, priorBalanceInFavor: override ?? q4(proposal.credited) };
    const blockedBy = [...new Set(findings.filter((h) => h.severidad === 'bloqueante').map((h) => h.codigo))];
    return {
      period: { year, month, ...range },
      rounding: { key: FILING_ROUNDING_POLICY, value: rounding, defined: roundingPolicy.defined },
      proration: { key: CREDITABLE_PRORATION_POLICY, value: method, defined: prorationPolicy.defined },
      figures,
      contributions: { charged: charged.contributions, creditable: creditableContributions },
      settlement: blockedBy.length > 0 ? null : settleIva(figures, rounding),
      blockedBy,
      priorBalance: {
        origin: override === null ? 'filed_returns' : 'override',
        reason: reason ?? null,
        cap: proposal.cap,
        available: proposal.available,
        proposed: proposal.credited,
        credited: new Decimal(figures.priorBalanceInFavor).toFixed(2),
        balances: override === null
          ? proposal.balances
          : proposal.balances.map((x) => ({ ...x, creditedHere: '0.00', remnant: x.available })),
      },
      ledger: Object.fromEntries(ROLES.map((r) => [r, q4(net(r))])) as Record<IvaRole, string>,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
