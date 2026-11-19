import Decimal from 'decimal.js';
import type pg from 'pg';
import { FEE_VAT_RELEASE_SOURCE, ORIGEN_COMISION } from '../banking/treasury-posting.js';
import { desgloseCero, sumarDesgloses, type Desglose, type Hallazgo, type RangoDelMes } from '../sat/diot/index.js';
import type { NoteGapCause } from './issued-credit-notes.js';
import type { DocumentContribution } from './iva-workpaper.js';

// ============================================================
// THE BANK FEES OF THE IVA WORKPAPER'S CREDITABLE SIDE (MNE-001-566, #799)
//
// A bank fee is charged and paid in the same act: the charge IS the payment, so
// its IVA is creditable in the month of the charge (LIVA arts. 1-B and 5 fr.
// III), backed by the bank's CFDI (art. 5 fr. II). That is MNE-001-041's rule
// (`treasury-posting.ts`), and the ledger already follows it by two paths that
// end in 1130: `bank fee post` releases the fee's IVA from 1135 in a
// `bank_fee_vat_release` entry, and a captured `iva-comision` adjustment posts
// it there directly (`ROL_DE_AJUSTE`). The DIOT's bills never see either, so
// the paper reads them here, from what each entry moved to `iva_acreditable`:
//
//   · Its base is the fee's: the 6310 line of the movement's `bank_fee` entry,
//     in the proportion of the IVA released. An adjustment keeps no base, so
//     its base is its IVA at 16 %, and the notice says so. A released fee at
//     8 % (within a cent) goes to that box; every other one to 16 %.
//   · A fee entry whose mirror is posted counts in no month, as a cancelled
//     credit note (MNE-001-565): reversed in its own month the two cancel in
//     1130, and otherwise each month its entry or its mirror moved 1130 names
//     it in the tie-out, and its own month names the amended return (CFF art.
//     32). A reconciliation reopened and posted again leaves one entry standing.
// ============================================================

export interface BankFeesOfRange {
  contributions: DocumentContribution[];
  breakdown: Desglose;
  findings: Hallazgo[];
  causes: NoteGapCause[];
}

interface FeeRow {
  fee_id: string;
  kind: 'release' | 'adjustment';
  entry_id: string;
  entry_number: string;
  entry_date: string;
  mirror_number: string | null;
  mirror_date: string | null;
  /** What the entry moved on iva_acreditable, debit positive. */
  iva: string;
  /** The movement's standing `bank_fee` entry: its 6310 debit and the IVA it parked in 1135. */
  fee_base: string | null;
  fee_parked: string | null;
}

const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);
const CENT = new Decimal('0.01');
const inRange = (d: string | null, range: RangoDelMes): boolean => d !== null && d >= range.desde && d <= range.hasta;
const roleAccounts = (role: string): string =>
  `(SELECT account_id FROM account_roles WHERE entity_id = $1 AND role = '${role}')`;

/** Every fee entry that moves 1130, or whose mirror does, dated in the range. Scoped by entity throughout. */
async function feesOfRange(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<FeeRow[]> {
  const { rows } = await client.query<FeeRow>(
    `WITH fee AS (
       SELECT je.id, 'release'::text AS kind, je.source_id::text AS fee_id
         FROM journal_entries je
        WHERE je.entity_id = $1 AND je.status = 'posted' AND je.source_type = $4
       UNION
       SELECT je.id, 'adjustment'::text, ra.id::text
         FROM reconciliation_adjustments ra
         JOIN journal_entries je ON je.entity_id = $1 AND je.status = 'posted'
          AND (je.id = ra.journal_entry_id OR (je.source_type = 'bank_reconciliation' AND je.source_id = ra.id))
        WHERE ra.entity_id = $1 AND ra.tipo = 'iva-comision')
     SELECT f.fee_id, f.kind, je.id::text AS entry_id, je.entry_number, je.entry_date::text AS entry_date,
            m.entry_number AS mirror_number, m.entry_date::text AS mirror_date,
            (SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)
               FROM journal_entry_lines l
              WHERE l.journal_entry_id = je.id AND l.account_id IN ${roleAccounts('iva_acreditable')})::text AS iva,
            b.base::text AS fee_base, b.parked::text AS fee_parked
       FROM fee f
       JOIN journal_entries je ON je.id = f.id
       LEFT JOIN journal_entries m ON m.id = je.reversed_by_entry_id AND m.entity_id = $1 AND m.status = 'posted'
       LEFT JOIN LATERAL (
         SELECT SUM(l.debit_amount) FILTER (WHERE l.account_id IN ${roleAccounts('comision_bancaria')}) AS base,
                SUM(l.debit_amount) FILTER (WHERE l.account_id IN ${roleAccounts('iva_pendiente_acreditar')}) AS parked
           FROM journal_entries fe
           JOIN journal_entry_lines l ON l.journal_entry_id = fe.id
          WHERE f.kind = 'release' AND fe.entity_id = $1 AND fe.status = 'posted' AND fe.source_type = $5
            AND fe.source_id = je.source_id AND fe.reversed_by_entry_id IS NULL
       ) b ON true
      WHERE (je.entry_date >= $2::date AND je.entry_date <= $3::date)
         OR (m.entry_date >= $2::date AND m.entry_date <= $3::date)
      ORDER BY je.entry_date, je.entry_number`,
    [entityId, range.desde, range.hasta, FEE_VAT_RELEASE_SOURCE, ORIGEN_COMISION]
  );
  return rows;
}

/** A reversed fee entry, named in each month it or its mirror moved 1130 (amount: what the paper's IVA lacks against the ledger's). */
function reversedCause(r: FeeRow, range: RangoDelMes): NoteGapCause | null {
  const ownHere = inRange(r.entry_date, range);
  const mirrorHere = inRange(r.mirror_date, range);
  const iva = new Decimal(r.iva);
  const amount = (mirrorHere ? iva : new Decimal(0)).minus(ownHere ? iva : 0);
  if (amount.abs().lessThan(CENT)) return null;
  const entries = [
    ...(ownHere ? [`su póliza ${r.entry_number} del ${r.entry_date}`] : []),
    ...(mirrorHere ? [`el espejo ${r.mirror_number} del ${r.mirror_date}`] : []),
  ].join(' y ');
  return {
    amount,
    text:
      `la comisión bancaria de la póliza ${r.entry_number}, reversada el ${r.mirror_date}, no se acredita en ningún mes: ` +
      `${entries} mueve el IVA acreditable` +
      (ownHere && !mirrorHere
        ? '; si la declaración de este mes ya se presentó acreditándola, se corrige con una complementaria (CFF art. 32)'
        : ''),
  };
}

export async function bankFeesOfRange(client: pg.PoolClient, entityId: string, range: RangoDelMes): Promise<BankFeesOfRange> {
  const out: BankFeesOfRange = { contributions: [], breakdown: desgloseCero(), findings: [], causes: [] };
  const listed: string[] = [];
  const derived: string[] = [];
  for (const r of await feesOfRange(client, entityId, range)) {
    if (r.mirror_number !== null) {
      const cause = reversedCause(r, range);
      if (cause) out.causes.push(cause);
      continue;
    }
    const iva = new Decimal(r.iva);
    if (!inRange(r.entry_date, range) || iva.abs().lessThan(CENT)) continue;
    const parked = new Decimal(r.fee_parked ?? 0);
    const fromFee = r.fee_base !== null && parked.greaterThan(0);
    const base = fromFee ? iva.times(r.fee_base as string).dividedBy(parked) : iva.dividedBy('0.16');
    const box = fromFee && base.times('0.08').minus(iva).abs().lessThanOrEqualTo(CENT) ? 'tasa8' : 'tasa16';
    const breakdown = desgloseCero();
    breakdown[box] = { base: q4(base), iva: q4(iva) };
    const documentNumber = `comisión bancaria del ${r.entry_date} (póliza ${r.entry_number})`;
    out.breakdown = sumarDesgloses(out.breakdown, breakdown);
    out.contributions.push({
      documentId: r.fee_id, documentNumber, documentKind: 'bank_fee', entryIds: [r.entry_id],
      breakdown, notSubject: q4(0), withheld: { amount: q4(0), entryId: null },
    });
    listed.push(`${documentNumber}, ${q4(iva)} de IVA`);
    if (!fromFee) derived.push(documentNumber);
  }
  if (listed.length > 0) {
    out.findings.push({
      codigo: 'IVA-WP-BANK-FEE-CFDI',
      severidad: 'aviso',
      mensaje:
        `El IVA de las comisiones bancarias del mes se acredita en el mes del cargo, porque el cargo es el pago ` +
        `(LIVA arts. 1-B y 5 fr. III): ${listed.join('; ')}. Antes de declarar, ten en mano el CFDI del banco ` +
        `de cada una: sin él ese IVA no es acreditable (art. 5 fr. II).` +
        (derived.length > 0
          ? ` La base de ${derived.join('; ')} es su IVA al 16 %, porque el ajuste de conciliación no la guarda: ` +
            `si el CFDI del banco dice otra tasa, corrige las casillas.`
          : ''),
    });
  }
  return out;
}
