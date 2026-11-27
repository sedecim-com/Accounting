import Decimal from 'decimal.js';
import type pg from 'pg';
import { ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import {
  desglosarDocumento, desgloseCero, hechosDelMes, ivaDelDesglose, sumarDesgloses,
  type Desglose, type Hallazgo, type HechoPagado, type PoliticaBaseExenta, type VendorUndoIvaMonth,
} from '../sat/diot/index.js';

// ============================================================
// THE IVA WITHHELD TO A VENDOR IS CREDITED AFTER ITS REMITTANCE (#1075, MNE-001-909, part 1 of 2)
//
// LIVA art. 5o. fr. IV, as src/ai/docs/payables.md carries it from the official
// text: the IVA withheld under art. 1o.-A and remitted may be credited in the
// monthly return following the one in which the withholding was remitted. The
// withholding is made when the price is paid, on what is paid (art. 1o.-A), so
// the DIOT's facts already carry it by month (`HechoPagado.ivaRetenido`).
//
// Under `withheld_vat_credit_month = after_remittance` (the default) the paper
// of a month credits what was paid to the vendor and leaves the withheld part
// of each fact out.
//
// THAT PART BELONGS TO ONE PAPER, AND THE LAW SAYS WHICH. What is withheld in
// month M is remitted with the return of M (art. 1o.-A) and credited in the
// monthly return that follows it (art. 5o. fr. IV): M+1's. So the paper of a
// month credits the IVA withheld in the month before, and only that month,
// when a person states on it that it was remitted, with the acknowledgement
// of the return that remitted it; the amount is read from that month's facts,
// never typed. Stated twice, it is one statement and one credit; any other
// month is refused, naming the paper it belongs on. Without the statement the
// paper names what the month before withheld as not credited: remitted late,
// it is credited by generating this same paper again, for a complementary
// return. So the credit is never lost and never moves to a later paper, and
// the paper, which runs read-only and keeps no record, needs none.
//
// The acknowledgement is the person's statement and is printed as typed: the
// system checks neither it nor the amount remitted. Part 2 reads the
// remittance from the record of filed returns and caps the credit by what it
// says was paid, and parks the withheld IVA in the ledger.
//
// Under `payment_month` nothing here runs and the paper is the one before this
// key. An undo (a negative fact) is never held back: it leaves in its own month
// with the rest of the bill's IVA, so the paper never credits more than the ledger.
// ============================================================

/** The panel key. Its values are persisted: never rename them. */
export const WITHHELD_VAT_CREDIT_MONTH_KEY = 'withheld_vat_credit_month';

export type WithheldVatCreditMonth = 'after_remittance' | 'payment_month';

/** The reader of `withheld_vat_credit_month`: any value but `payment_month` reads as the default. */
export async function readWithheldVatCreditMonth(
  ctx: PolicyContext,
  client: pg.PoolClient
): Promise<{ key: string; value: WithheldVatCreditMonth; defined: boolean }> {
  const p = await getPolicy(ctx, WITHHELD_VAT_CREDIT_MONTH_KEY, client);
  return { key: p.key, value: p.value === 'payment_month' ? 'payment_month' : 'after_remittance', defined: p.defined };
}

/** A remittance a person states: the month the IVA was withheld in (YYYY-MM) and the acknowledgement of the return that remitted it. */
export interface WithheldVatRemittance {
  period: string;
  acknowledgement: string;
}

/** What the paper did with the IVA withheld to vendors. Amounts in four decimals. */
export interface WithheldVatCredit {
  key: string;
  value: WithheldVatCreditMonth;
  defined: boolean;
  /** Withheld on what this month paid and left out of its creditable IVA. */
  awaitingRemittance: string;
  /** The month before, credited in this paper: the acknowledgement as a person typed it and the amount the books give. */
  credited: Array<WithheldVatRemittance & { amount: string }>;
  /** The month before, when it withheld IVA and no remittance was stated for it. */
  notCredited: Array<{ period: string; amount: string }>;
}

const FIELD = 'withheldVatRemittances';
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);
const month = (year: number, m: number): string => `${year}-${String(m).padStart(2, '0')}`;

/** The month after `period` (YYYY-MM), or before it. */
function shifted(period: string, by: 1 | -1): string {
  const at = Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1 + by;
  return month(Math.floor(at / 12), (at % 12) + 1);
}

/**
 * What a person stated on a paper, or the refusal that names what is at fault:
 * the remittance of the month before the paper's, or nothing. The same
 * statement repeated is one; a month that is not the one before is refused,
 * naming the paper it belongs on; two acknowledgements for the month are not
 * one statement.
 */
export function checkedRemittance(
  raw: readonly WithheldVatRemittance[] | undefined,
  paper: { year: number; month: number },
  answer: WithheldVatCreditMonth
): WithheldVatRemittance | null {
  const list = (raw ?? []).map((r) => ({ period: r.period.trim(), acknowledgement: r.acknowledgement.trim() }));
  if (list.length === 0) return null;
  if (answer === 'payment_month') {
    throw new ValidationError({ key: 'filing.workpaper.withheld_vat.remittance_not_asked' }, FIELD);
  }
  const own = month(paper.year, paper.month);
  for (const r of list) {
    const invalid = new ValidationError(
      { key: 'filing.workpaper.withheld_vat.remittance_invalid', params: { value: `${r.period}:${r.acknowledgement}` } }, FIELD
    );
    if (!ISO_MONTH.test(r.period) || r.acknowledgement === '') throw invalid;
    if (r.period !== shifted(own, -1)) {
      throw new ValidationError(
        {
          key: 'filing.workpaper.withheld_vat.remittance_other_month',
          params: { period: r.period, belongs: shifted(r.period, 1), month: own, before: shifted(own, -1) },
        },
        FIELD
      );
    }
    if (r.acknowledgement !== list[0].acknowledgement) throw invalid;
  }
  return list[0];
}

/**
 * A fact's split by rate in two: what was paid to the vendor and what was
 * withheld, by rate in the proportion of each box's IVA. The bases stay with
 * the payment: the act was paid in its month, and only the IVA waits. The
 * withheld part is never more than the IVA the fact counted, and an undo has
 * none.
 */
export function splitWithheld(
  h: Pick<HechoPagado, 'ivaPagado' | 'ivaRetenido'>,
  breakdown: Desglose
): { paid: Desglose; withheld: Desglose } {
  const iva = new Decimal(ivaDelDesglose(breakdown));
  const part = Decimal.min(h.ivaRetenido, h.ivaPagado, iva);
  if (!part.greaterThan(0)) return { paid: breakdown, withheld: desgloseCero() };
  const paid = desgloseCero();
  const withheld = desgloseCero();
  const split = (c: { base: string; iva: string }): [{ base: string; iva: string }, { base: string; iva: string }] => {
    const held = q4(new Decimal(c.iva).times(part).dividedBy(iva));
    return [{ base: c.base, iva: q4(new Decimal(c.iva).minus(held)) }, { base: q4(0), iva: held }];
  };
  for (const k of ['tasa16', 'tasa8', 'tasa0', 'exento'] as const) [paid[k], withheld[k]] = split(breakdown[k]);
  for (const o of breakdown.otras) {
    const [p, w] = split(o);
    paid.otras.push({ etiqueta: o.etiqueta, ...p });
    withheld.otras.push({ etiqueta: o.etiqueta, ...w });
  }
  return { paid, withheld };
}

/** One bill's withheld IVA in a paper: held back in its own month, or credited in a later one. */
export interface WithheldOfBill {
  documentId: string;
  documentNumber: string;
  breakdown: Desglose;
}

/** `IVA-WP-WITHHELD-VAT-AWAITS-REMITTANCE`: what this month's payments withheld, and how it is credited later. */
export function awaitingFinding(paper: { year: number; month: number }, bills: readonly WithheldOfBill[]): Hallazgo {
  const amount = bills.reduce((s, b) => s.plus(ivaDelDesglose(b.breakdown)), new Decimal(0));
  return {
    codigo: 'IVA-WP-WITHHELD-VAT-AWAITS-REMITTANCE',
    severidad: 'aviso',
    politica: WITHHELD_VAT_CREDIT_MONTH_KEY,
    mensaje: {
      key: 'filing.workpaper.withheld_vat.finding_awaiting',
      params: {
        amount: q4(amount), bills: bills.map((b) => b.documentNumber).join(', '),
        period: month(paper.year, paper.month), next: shifted(month(paper.year, paper.month), 1),
      },
    },
  };
}

export interface WithheldBefore {
  /** What the month before withheld, by rate, when its remittance was stated: added to the paper's creditable IVA. */
  breakdown: Desglose;
  contributions: WithheldOfBill[];
  credited: WithheldVatCredit['credited'];
  notCredited: WithheldVatCredit['notCredited'];
  findings: Hallazgo[];
}

/**
 * The IVA withheld in the month before the paper's, read from the same facts
 * that held it back there (`hechosDelMes`, narrowed to the bills whose CFDI
 * withheld IVA): credited when its remittance is stated, named otherwise. One
 * reading a paper, bounded by entity and month; none per bill here.
 */
export async function withheldOfMonthBefore(
  client: pg.PoolClient,
  entityId: string,
  paper: { year: number; month: number },
  stated: WithheldVatRemittance | null,
  undoMonth: VendorUndoIvaMonth,
  exemptBase: PoliticaBaseExenta
): Promise<WithheldBefore> {
  const out: WithheldBefore = { breakdown: desgloseCero(), contributions: [], credited: [], notCredited: [], findings: [] };
  const period = shifted(month(paper.year, paper.month), -1);
  const { hechos: facts } = await hechosDelMes(client, entityId, Number(period.slice(0, 4)), Number(period.slice(5)), undoMonth, 'withheld');
  const bills: WithheldOfBill[] = [];
  const splitFindings: Hallazgo[] = [];
  for (const h of facts) {
    const r = desglosarDocumento({
      documentId: h.billId, documentNumber: h.billNumber, renglones: h.renglones, ivaCabecera: h.ivaCabecera,
      ivaPagado: h.ivaPagado, porcion: h.porcion, politicaBaseExenta: exemptBase,
    });
    const { withheld } = splitWithheld(h, r.desglose);
    if (new Decimal(ivaDelDesglose(withheld)).isZero()) continue;
    bills.push({ documentId: h.billId, documentNumber: h.billNumber, breakdown: withheld });
    splitFindings.push(...r.hallazgos);
  }
  const amount = q4(bills.reduce((s, b) => s.plus(ivaDelDesglose(b.breakdown)), new Decimal(0)));
  const finding = (suffix: string, key: 'finding_credited' | 'finding_nothing_withheld' | 'finding_not_credited'): Hallazgo => ({
    codigo: `IVA-WP-WITHHELD-VAT-${suffix}`,
    severidad: 'aviso',
    politica: WITHHELD_VAT_CREDIT_MONTH_KEY,
    mensaje: {
      key: `filing.workpaper.withheld_vat.${key}`,
      params: {
        amount, bills: bills.map((b) => b.documentNumber).join(', '), period,
        month: month(paper.year, paper.month), acknowledgement: stated?.acknowledgement ?? '',
      },
    },
  });
  if (stated && bills.length > 0) {
    out.credited.push({ ...stated, amount });
    out.contributions.push(...bills);
    for (const b of bills) out.breakdown = sumarDesgloses(out.breakdown, b.breakdown);
    // The split of a credited bill is this paper's figure: what its lines could not say blocks here too.
    out.findings.push(...splitFindings, finding('CREDITED', 'finding_credited'));
  } else if (stated) {
    out.findings.push(finding('NOTHING-WITHHELD', 'finding_nothing_withheld'));
  } else if (bills.length > 0) {
    out.notCredited.push({ period, amount });
    out.findings.push(finding('NOT-CREDITED', 'finding_not_credited'));
  }
  return out;
}
