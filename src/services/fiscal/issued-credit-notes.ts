import Decimal from 'decimal.js';
import type pg from 'pg';
import { resolveInvoiceMetodoPago } from '../accounting/iva-cash-basis.js';
import { saleSources } from './sale-sources.js';
import {
  desglosarDocumento,
  desgloseCero,
  porcionDelDocumento,
  sumarDesgloses,
  type Desglose,
  type Hallazgo,
  type PorcionPagada,
  type RangoDelMes,
  type RenglonDeGasto,
} from '../sat/diot/index.js';
import type { DocumentContribution } from './iva-workpaper.js';

// ============================================================
// THE ISSUED CREDIT NOTES OF THE IVA WORKPAPER (MNE-001-565, #799)
//
// LIVA art. 7: whoever grants a return, discount or bonus deducts it from the
// value of its acts «en la siguiente o siguientes declaraciones de pago del mes
// de calendario que corresponda», once the document states that the IVA was
// restituted (second paragraph; RLIVA art. 24): the issued credit note. So the
// charged side takes each note out of the month its own entry
// (`source_type = 'credit_note'`) moved 2120, read from that entry, never
// recomputed:
//
//   · Its IVA is what the entry debited to `iva_trasladado`. A note on a PPD
//     invoice debits 2125 instead (`postCreditNoteEntry`): that IVA was never
//     caused (LIVA art. 1-B), so the note restitutes nothing and only lowers
//     what the later collection releases. The share counted is the part whose
//     IVA left 2120: the whole note on PUE or with no invoice, that debit over
//     the note's IVA on PPD (0 today), and nothing for a PPD note with no IVA,
//     whose base the collections already leave out.
//   · Its split by rate is its invoice's, as a portion of it, the way a partial
//     collection is split, then negated. A note with no invoice is one line of
//     its own subtotal and IVA, at the rate they state. When its IVA is off its invoice's proportion the
//     base is an assumption, and IVA-WP-CREDIT-NOTE-SPLIT-ASSUMED says so.
//   · An `anticipo` note is no return: it is the TipoRelacion 07 egreso of
//     Apéndice 6, procedure A. Its IVA leaves the month all the same, because
//     the advance caused it when collected and the final invoice counts whole,
//     exactly as `receipt apply` cancels a receipt's advance (MNE-001-423).
//   · A cancelled note (status `void`, or its entry reversed) counts in no
//     month, as a reversal of money that never arrived (MNE-001-518, rule 2):
//     each month its entry or its mirror moved 2120 names it in the tie-out,
//     and its own month names the amended return (CFF art. 32).
// ============================================================

/** One cancelled note's share of the charged side's gap with the ledger. */
export interface NoteGapCause {
  amount: Decimal;
  text: string;
}

export interface IssuedCreditNotesOfRange {
  contributions: DocumentContribution[];
  breakdown: Desglose;
  notSubject: Decimal;
  /** Base at 0 % taken out of manual sales, for IVA-WP-ZERO-RATE-UNVERIFIED. Negative. */
  manualZeroRate: Decimal;
  findings: Hallazgo[];
  causes: NoteGapCause[];
}

interface NoteRow {
  id: string;
  credit_note_number: string;
  status: string;
  invoice_id: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  mirror_number: string | null;
  mirror_date: string | null;
  /** What the note's entry debited to iva_trasladado, net. */
  iva: string;
  invoice_number: string | null;
  invoice_total: string | null;
  invoice_tax: string | null;
  invoice_rate: string | null;
  terms: string | null;
  memo: string | null;
  cfdi_uuid: string | null;
}

const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);
const CENT = new Decimal('0.01');

function negated(d: Desglose): Desglose {
  const box = (c: { base: string; iva: string }) => ({ base: q4(new Decimal(c.base).negated()), iva: q4(new Decimal(c.iva).negated()) });
  return {
    tasa16: box(d.tasa16), tasa8: box(d.tasa8), tasa0: box(d.tasa0), exento: box(d.exento),
    otras: d.otras.map((o) => ({ etiqueta: o.etiqueta, ...box(o) })),
  };
}

/** Every issued note whose entry, or whose entry's mirror, is dated in the range. Scoped by entity throughout. */
async function notesOfRange(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<NoteRow[]> {
  const { rows } = await client.query<NoteRow>(
    `SELECT cn.id::text, cn.credit_note_number, cn.status, cn.invoice_id::text,
            cn.subtotal::text, cn.tax_amount::text, cn.total_amount::text,
            je.id::text AS entry_id, je.entry_number, je.entry_date::text AS entry_date,
            m.entry_number AS mirror_number, m.entry_date::text AS mirror_date,
            (SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)
               FROM journal_entry_lines l
              WHERE l.journal_entry_id = je.id
                AND l.account_id IN (SELECT account_id FROM account_roles
                                      WHERE entity_id = $1 AND role = 'iva_trasladado'))::text AS iva,
            i.invoice_number, i.total_amount::text AS invoice_total, i.tax_amount::text AS invoice_tax,
            i.exchange_rate::text AS invoice_rate, i.terms, i.memo, i.cfdi_uuid
       FROM credit_notes cn
       JOIN journal_entries je ON je.id = cn.journal_entry_id AND je.entity_id = $1
                              AND je.status = 'posted' AND je.source_type = 'credit_note'
       LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id AND m.entity_id = $1 AND m.status = 'posted'
       LEFT JOIN invoices i ON i.id = cn.invoice_id AND i.entity_id = $1
      WHERE cn.entity_id = $1 AND cn.status <> 'draft'
        AND ((je.entry_date >= $2::date AND je.entry_date <= $3::date)
          OR (m.entry_date >= $2::date AND m.entry_date <= $3::date))
      ORDER BY cn.credit_note_number`,
    [entityId, range.desde, range.hasta]
  );
  return rows;
}

/**
 * The rate of a note with no invoice, when its own figures state it: 0 with no
 * IVA, 16 or 8 within a cent. Otherwise null, and `desglose.ts` measures it.
 */
function rateOf(subtotal: string, tax: string): string | null {
  const t = new Decimal(tax);
  if (t.isZero()) return '0';
  return ['16', '8'].find((r) => new Decimal(subtotal).times(r).dividedBy(100).minus(t).abs().lessThanOrEqualTo(CENT)) ?? null;
}

const inRange = (d: string | null, range: RangoDelMes): boolean => d !== null && d >= range.desde && d <= range.hasta;

/** A cancelled note, named in each month its entries moved 2120 (amount: what the paper misses against the ledger). */
function cancelledCause(n: NoteRow, range: RangoDelMes): NoteGapCause | null {
  const ownHere = inRange(n.entry_date, range);
  const mirrorHere = inRange(n.mirror_date, range);
  const iva = new Decimal(n.iva);
  const amount = (ownHere ? iva : new Decimal(0)).minus(mirrorHere ? iva : 0);
  if (amount.abs().lessThan(CENT)) return null;
  const entries = [
    ...(ownHere ? [`su póliza ${n.entry_number} del ${n.entry_date}`] : []),
    ...(mirrorHere ? [`el espejo ${n.mirror_number} del ${n.mirror_date}`] : []),
  ].join(' y ');
  const how = n.mirror_number ? `reversada el ${n.mirror_date}` : 'anulada';
  return {
    amount,
    text:
      `la nota de crédito ${n.credit_note_number}, ${how}, no cuenta en ningún mes: ${entries} mueve el IVA trasladado` +
      (ownHere && !mirrorHere
        ? '; si la declaración de este mes ya se presentó restándola, se corrige con una complementaria (CFF art. 32)'
        : ''),
  };
}

export async function issuedCreditNotesOfRange(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<IssuedCreditNotesOfRange> {
  const out: IssuedCreditNotesOfRange = {
    contributions: [], breakdown: desgloseCero(), notSubject: new Decimal(0), manualZeroRate: new Decimal(0), findings: [], causes: [],
  };
  const rows = await notesOfRange(client, entityId, range);
  const sources = await saleSources(client, entityId, [...new Set(rows.flatMap((n) => (n.invoice_id ? [n.invoice_id] : [])))]);
  for (const n of rows) {
    if (n.status === 'void' || n.mirror_number !== null) {
      const cause = cancelledCause(n, range);
      if (cause) out.causes.push(cause);
      continue;
    }
    if (!inRange(n.entry_date, range)) continue;
    const iva = new Decimal(n.iva);
    const method = n.invoice_id
      ? (await resolveInvoiceMetodoPago(client, {
          id: n.invoice_id, invoice_number: n.invoice_number ?? undefined, cfdi_uuid: n.cfdi_uuid, terms: n.terms, memo: n.memo, entity_id: entityId,
        })).metodo
      : 'PUE';
    const tax = new Decimal(n.tax_amount);
    const share = method === 'PUE' ? new Decimal(1) : tax.greaterThan(0) ? iva.dividedBy(tax) : new Decimal(0);
    if (!share.greaterThan(0)) continue;

    const source = n.invoice_id ? sources.get(n.invoice_id) : undefined;
    const lines: RenglonDeGasto[] = source?.lines ??
      [{ tipoFactor: 'tasa', tasa: rateOf(n.subtotal, n.tax_amount), valorActos: n.subtotal, importe: n.subtotal, iva: n.tax_amount }];
    const portion: PorcionPagada = {
      aplicadoPrevio: '0',
      aplicadoAhora: q4(new Decimal(n.total_amount).times(share)),
      totalDocumento: n.invoice_id ? (n.invoice_total as string) : n.total_amount,
      tasaCambio: n.invoice_id ? (n.invoice_rate ?? '1') : '1',
    };
    const r = desglosarDocumento({
      documentId: n.id,
      documentNumber: n.invoice_number ? `${n.invoice_number} (nota de crédito ${n.credit_note_number})` : n.credit_note_number,
      renglones: lines,
      ivaCabecera: n.invoice_id ? (n.invoice_tax as string) : n.tax_amount,
      ivaPagado: q4(iva),
      porcion: portion,
      politicaBaseExenta: 'exigir_base',
      documentKind: 'invoice',
    });
    out.findings.push(...r.hallazgos);
    const split = negated(r.desglose);
    const notSubject = new Decimal(porcionDelDocumento(source?.notSubject ?? '0', portion)).negated();
    out.breakdown = sumarDesgloses(out.breakdown, split);
    out.notSubject = out.notSubject.plus(notSubject);
    if (!source?.fromCfdi) out.manualZeroRate = out.manualZeroRate.plus(split.tasa0.base);
    if (n.invoice_id) {
      const expected = new Decimal(n.invoice_tax as string).times(portion.aplicadoAhora).dividedBy(n.invoice_total as string);
      if (expected.minus(iva).abs().greaterThan(CENT)) {
        out.findings.push({
          codigo: 'IVA-WP-CREDIT-NOTE-SPLIT-ASSUMED',
          severidad: 'aviso',
          documentId: n.id,
          documentNumber: n.credit_note_number,
          mensaje:
            `La nota de crédito ${n.credit_note_number} restituye ${q4(iva)} de IVA y su factura ${n.invoice_number} ` +
            `daría ${q4(expected)} en la misma proporción: la nota no guarda las tasas de sus conceptos, así que su base ` +
            `se repartió en las proporciones de la factura. Revisa las casillas antes de declarar.`,
        });
      }
    }
    out.contributions.push({
      documentId: n.id,
      documentNumber: n.credit_note_number,
      documentKind: 'credit_note',
      entryIds: [n.entry_id],
      breakdown: split,
      notSubject: q4(notSubject),
      withheld: { amount: q4(0), entryId: null },
    });
  }
  return out;
}
