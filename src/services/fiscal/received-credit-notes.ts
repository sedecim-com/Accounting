import Decimal from 'decimal.js';
import type pg from 'pg';
import { reclassRoles } from '../accounting/iva-cash-basis.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../xml-ingestion/received-credit-note.js';
import {
  desglosarDocumento,
  desgloseCero,
  sumarDesgloses,
  vatLinesOfCfdi,
  type CfdiTaxSummary,
  type Desglose,
  type Hallazgo,
  type PoliticaBaseExenta,
  type RangoDelMes,
  type RenglonDeGasto,
} from '../sat/diot/index.js';
import { negated, type NoteGapCause } from './issued-credit-notes.js';
import type { DocumentContribution } from './iva-workpaper.js';

// ============================================================
// THE RECEIVED CREDIT NOTES OF THE IVA WORKPAPER'S CREDITABLE SIDE (MNE-001-760, #692)
//
// A received note takes its VAT out of 1135 up to what its bill still has
// parked, and the rest out of 1130, because that share was already credited
// (MNE-001-555; src/ai/docs/mexico-cfdi.md, LIVA arts. 5-III and 7). The
// creditable side takes off, in the month of the note's own entry
// (`source_type = 'vendor_credit_note'`), what that entry took out of the
// creditable role, read from the entry and never recomputed. What it took out
// of 1135 was never credited, so nothing of it is subtracted.
//
//   · Its split by rate is the note's own CFDI's (`pre_registrations.tax_breakdown`),
//     as a portion of the note: the share that left 1130 over its VAT. A note
//     with no stored summary is one line with no stated rate, which the
//     DIOT's split measures and names.
//   · A note whose entry is reversed counts in no month, as a cancelled issued
//     note (MNE-001-565) and a reversed bank fee (MNE-001-566): reversed in its
//     own month the two entries cancel in 1130; otherwise each month its entry
//     or its mirror moved 1130 names it in the tie-out, and its own month names
//     the amended return (CFF art. 32).
//   · The DIOT does not change: a note is not a payment, and the batch file
//     leaves the §3.2 returns fields unfilled (sat-batch.ts).
// ============================================================

export interface ReceivedCreditNotesOfRange {
  contributions: DocumentContribution[];
  breakdown: Desglose;
  findings: Hallazgo[];
  causes: NoteGapCause[];
}

interface NoteRow {
  note_id: string | null;
  uuid: string;
  bill_number: string | null;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  mirror_number: string | null;
  mirror_date: string | null;
  /** What the entry moved on the creditable role, debit positive: negative for a note. */
  moved: string;
  /** The note's VAT: what the entry credited to the creditable and the pending roles. */
  vat: string;
  /** The note's total: the entry's debit to accounts payable. */
  total: string;
  tax_breakdown: CfdiTaxSummary;
}

const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);
const CENT = new Decimal('0.01');
const inRange = (d: string | null, range: RangoDelMes): boolean => d !== null && d >= range.desde && d <= range.hasta;
const net = (roles: string): string =>
  `(SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0) FROM journal_entry_lines l
     WHERE l.journal_entry_id = je.id
       AND l.account_id IN (SELECT account_id FROM account_roles WHERE entity_id = $1 AND role = ANY(${roles})))`;

/** Every note entry whose own date or whose mirror's is in the range: one statement, scoped by entity throughout. */
async function notesOfRange(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<NoteRow[]> {
  const { from: pending, to: creditable } = reclassRoles('received');
  const { rows } = await client.query<NoteRow>(
    `SELECT x.id::text AS note_id, je.reference AS uuid, b.bill_number,
            je.id::text AS entry_id, je.entry_number, je.entry_date::text AS entry_date,
            m.entry_number AS mirror_number, m.entry_date::text AS mirror_date,
            ${net('$5::text[]')}::text AS moved,
            (-${net('$6::text[]')})::text AS vat,
            (SELECT COALESCE(SUM(l.debit_amount), 0) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id)::text AS total,
            p.tax_breakdown
       FROM journal_entries je
       LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id AND m.entity_id = $1 AND m.status = 'posted'
       LEFT JOIN bills b ON b.id = je.source_id AND b.entity_id = $1
       LEFT JOIN xml_documents x ON x.entity_id = $1 AND lower(x.cfdi_uuid) = lower(je.reference)
       LEFT JOIN LATERAL (
         SELECT pr.tax_breakdown FROM pre_registrations pr
          WHERE pr.entity_id = $1 AND pr.xml_document_id = x.id AND pr.document_type = 'credit_note'
          ORDER BY pr.created_at DESC LIMIT 1
       ) p ON true
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_type = $4
        AND ((je.entry_date >= $2::date AND je.entry_date <= $3::date)
          OR (m.entry_date >= $2::date AND m.entry_date <= $3::date))
      ORDER BY je.entry_date, je.entry_number COLLATE "C"`,
    [entityId, range.desde, range.hasta, VENDOR_CREDIT_NOTE_SOURCE, [creditable], [creditable, pending]]
  );
  return rows;
}

const nameOf = (n: NoteRow): string => `${n.bill_number ?? 'bill'} (received credit note ${n.uuid})`;

/** A reversed note, named in each month its entry or its mirror moved 1130 (amount: what the paper lacks against the ledger). */
function reversedCause(n: NoteRow, range: RangoDelMes): NoteGapCause | null {
  const ownHere = inRange(n.entry_date, range);
  const mirrorHere = inRange(n.mirror_date, range);
  const moved = new Decimal(n.moved);
  const amount = (mirrorHere ? moved : new Decimal(0)).minus(ownHere ? moved : 0);
  if (amount.abs().lessThan(CENT)) return null;
  const entries = [
    ...(ownHere ? [`its entry ${n.entry_number} of ${n.entry_date}`] : []),
    ...(mirrorHere ? [`the mirror ${n.mirror_number} of ${n.mirror_date}`] : []),
  ].join(' and ');
  return {
    amount,
    text:
      `${nameOf(n)}, reversed on ${n.mirror_date}, counts in no month: ${entries} moved creditable VAT` +
      (ownHere && !mirrorHere
        ? '; if this month\'s return was already filed with it subtracted, an amended return corrects it (CFF art. 32)'
        : ''),
  };
}

export async function receivedCreditNotesOfRange(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes,
  exemptBase: PoliticaBaseExenta
): Promise<ReceivedCreditNotesOfRange> {
  const out: ReceivedCreditNotesOfRange = { contributions: [], breakdown: desgloseCero(), findings: [], causes: [] };
  for (const n of await notesOfRange(client, entityId, range)) {
    if (n.mirror_number !== null) {
      const cause = reversedCause(n, range);
      if (cause) out.causes.push(cause);
      continue;
    }
    const credited = new Decimal(n.moved).negated();
    if (!inRange(n.entry_date, range) || credited.lessThan(CENT)) continue;
    const vat = new Decimal(n.vat);
    const fromCfdi = vatLinesOfCfdi(n.tax_breakdown);
    const subtotal = new Decimal(n.total).minus(vat);
    const lines: RenglonDeGasto[] = fromCfdi.length > 0
      ? fromCfdi
      : [{ tipoFactor: 'tasa', tasa: null, valorActos: q4(subtotal), importe: q4(subtotal), iva: q4(vat) }];
    const r = desglosarDocumento({
      documentId: n.note_id ?? n.entry_id,
      documentNumber: nameOf(n),
      renglones: lines,
      ivaCabecera: q4(vat),
      ivaPagado: q4(credited),
      porcion: { aplicadoPrevio: '0', aplicadoAhora: q4(new Decimal(n.total).times(credited).dividedBy(vat)), totalDocumento: n.total },
      politicaBaseExenta: exemptBase,
    });
    out.findings.push(...r.hallazgos);
    const split = negated(r.desglose);
    out.breakdown = sumarDesgloses(out.breakdown, split);
    out.contributions.push({
      documentId: n.note_id ?? n.entry_id,
      documentNumber: nameOf(n),
      documentKind: 'credit_note',
      entryIds: [n.entry_id],
      breakdown: split,
      notSubject: q4(0),
      withheld: { amount: q4(0), entryId: null },
    });
  }
  return out;
}
