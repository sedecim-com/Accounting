import Decimal from 'decimal.js';
import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ConflictError } from '../../utils/errors.js';
import { generateEntryNumber, nextEntityNumber } from '../../utils/sequence.js';
import type { OpeningFinding, OpeningPlan } from '../accounting/opening-balance.js';
import { reclassRoles } from '../accounting/iva-cash-basis.js';
import { controlDocuments, identityRfc } from '../ar/opening-invoices.js';

// ============================================================
// OPEN PAYABLES OF A MIGRATION (MNE-001-023 · #310, layer 3 of O1)
//
// The mirror of `ar/opening-invoices.ts`. The opening entry already writes
// each open vendor document as its own line on the payable control account;
// here every document of a `cxp` control account becomes a payable bill IN
// THE SAME TRANSACTION, pointing at the opening entry (`journal_entry_id`),
// which already carries its amount. No money is posted twice, and
// `ap reconcile` sees the subledger behind the control balance.
//
// Only the documents of the account the default `cxp` role points at become
// bills: payments debit that account and `ap reconcile` reads only that one.
// Documents on OTHER payable accounts (205 Acreedores diversos next to 201
// Proveedores, 201.01 next to 201.02) stay lines of the opening, as before
// this layer, and the load says so (APE-CXP-FUERA-DEL-ROL). Whether a
// creditor is a vendor is the firm's declaration, made by where it points
// the role, never a guess by rubro.
//
// The load refuses, naming the account, whenever the subledger it would
// write could not match what `ap reconcile` and the vendor payments read:
//   - a document runs against the account (a debit balance, e.g. an advance
//     to the vendor): it is not a bill, and leaving it out is the delta;
//   - a document in a currency other than the functional one;
//   - the same vendor folio, or the same CFDI UUID, is already a bill of this
//     entity: the liability would be counted twice.
// No adjusting entry is ever posted to make it tie.
//
// What differs from receivables, on purpose:
//   - The vendor's folio is NOT unique across vendors, so it goes to
//     `vendor_invoice_number` and the bill takes the next internal folio of
//     the BILL series; a duplicate is the same folio FOR THE SAME VENDOR.
//     A generic RFC (XAXX/XEXX) identifies nobody, so those vendors are
//     told apart by name (`identityRfc`).
//   - The bill is born `approved`: approving is what posts a bill, and its
//     liability is already in the ledger through the opening entry.
//
// THE IVA INSIDE THE OPEN BALANCE. Under cash-basis IVA (LIVA art. 1-B and
// art. 5 fr. III) the IVA of an unpaid purchase is creditable when it is
// paid, so it sits in `iva_pendiente_acreditar` until then. Each document
// may carry its rate (`ivaRate`): the bill then gets one line with that rate,
// its base and its IVA, so that paying it releases the IVA to creditable and
// the DIOT breaks it down by rate like a native bill. A document without the
// rate is governed by the panel key `opening_payable_iva`. The IVA the
// documents carry must be in the opening's pending-IVA account, or a payment
// would release IVA the ledger never parked (APE-CXP-IVA-SIN-SALDO).
//
// RELOAD (087). A reload after voiding the opening takes over the untouched
// bills of the reversed one that it brings again (same folio, same vendor)
// and voids, in the same transaction, the untouched ones it no longer brings
// (a corrected vendor name, a dropped document): otherwise they would stay
// payable against a liability that was reversed.
// ============================================================

/**
 * The answer of the panel key `opening_payable_iva`, for a payable document
 * that does not say its IVA rate. Read by `importOpeningBalance`
 * (`OPENING_PAYABLE_IVA_POLICY_KEY`), applied here: `require_rate` unless the
 * key says exactly `assume_zero_rate`.
 */
export type OpeningPayableIvaPolicy = 'require_rate' | 'assume_zero_rate';

export function openingPayableIvaPolicy(value: string | null | undefined): OpeningPayableIvaPolicy {
  return value === 'assume_zero_rate' ? 'assume_zero_rate' : 'require_rate';
}

/** A bill the opening will create, one per open vendor document. */
export interface OpeningBillDraft {
  accountCode: string;
  /** The control account: the account of the bill's single line. */
  accountId: string;
  /** The vendor's own folio, kept in `vendor_invoice_number`. */
  vendorInvoiceNumber: string;
  vendorName: string;
  vendorRfc: string | null;
  date: string;
  dueDate: string;
  /** The open balance: what is still owed, IVA included. */
  amount: string;
  /** The open balance without its IVA: the base (`valor_actos`). */
  subtotal: string;
  /** The IVA inside the open balance, pending until paid. */
  tax: string;
  /** `bill_lines.tax_rate`, as a percent ('16.00'); null when exempt. */
  taxRatePct: string | null;
  factorType: 'tasa' | 'exento';
  currency: string;
  cfdiUuid: string | null;
  /** The bill of a REVERSED opening that this load takes over (087 reload). */
  replacesId: string | null;
}

/** A bill of the entity that carries a folio or a UUID a document wants to use. */
export interface ExistingBill {
  id: string;
  vendor_invoice_number: string;
  vendor_name: string;
  vendor_rfc: string | null;
  cfdi_uuid: string | null;
  status: string;
  amount_paid: string;
  /** true when it hangs from an opening entry that was already reversed. */
  from_reversed_opening: boolean;
}

/** An untouched bill of a reversed opening: taken over, or voided by the reload. */
export type StaleBill = Pick<ExistingBill, 'id' | 'vendor_invoice_number' | 'vendor_name'>;

export interface OpeningBillsContext {
  /** Code of the account the default `cxp` role points at, or null. */
  payableRoleCode: string | null;
  /** Code of the account the `iva_pendiente_acreditar` role points at, or null. */
  pendingIvaCode: string | null;
  functionalCurrency: string;
  ivaPolicy: OpeningPayableIvaPolicy;
  existing: readonly ExistingBill[];
  stale: readonly StaleBill[];
}

export interface OpeningBillsPlan {
  drafts: OpeningBillDraft[];
  findings: OpeningFinding[];
  /** Untouched bills of a reversed opening that this reload does not bring again. */
  voids: string[];
}

const block = (rule: string, account: string, message: string): OpeningFinding => ({
  regla: rule,
  severidad: 'bloquea',
  numCta: account,
  mensaje: message,
});

interface VendorKey {
  /** The RFC that identifies the vendor (`identityRfc`), or null. */
  rfc: string | null;
  name: string;
}

/**
 * Same vendor, as `writeOpeningBills` will resolve it: by RFC when both sides
 * carry one that identifies, else by exact name.
 */
function sameVendor(a: VendorKey, b: VendorKey): boolean {
  if (a.rfc !== null && b.rfc !== null) return a.rfc === b.rfc;
  return a.name.toLowerCase() === b.name.toLowerCase();
}

const vendorOf = (e: ExistingBill): VendorKey => ({
  rfc: identityRfc(e.vendor_rfc === null || e.vendor_rfc.trim() === '' ? null : e.vendor_rfc.trim().toUpperCase()),
  name: e.vendor_name.trim(),
});

/** The untouched bill of a reversed opening, which a reload may take over. */
const isStale = (e: ExistingBill): boolean =>
  e.from_reversed_opening && e.status === 'approved' && new Decimal(e.amount_paid).isZero();

type ParsedRate = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'exempt' } | { kind: 'rate'; rate: Decimal };

/** `ivaRate` is the CFDI's TasaOCuota ('0.16', '0.080000') or 'exento'. */
function parseIvaRate(raw: string | undefined): ParsedRate {
  if (raw === undefined || raw.trim() === '') return { kind: 'missing' };
  const v = raw.trim().toLowerCase();
  if (v === 'exento' || v === 'exempt') return { kind: 'exempt' };
  if (!/^\d+(\.\d+)?$/.test(v)) return { kind: 'invalid' };
  const rate = new Decimal(v);
  return rate.greaterThanOrEqualTo(1) ? { kind: 'invalid' } : { kind: 'rate', rate };
}

/** Pure: which bills the opening would create, and what stops them. */
export function planOpeningBills(
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  ctx: OpeningBillsContext
): OpeningBillsPlan {
  const all = controlDocuments(plan, 'cxp');
  const findings: OpeningFinding[] = [];
  const drafts: OpeningBillDraft[] = [];
  if (all.length === 0) return { drafts, findings, voids: [] };

  const withDocs = [...new Set(all.map((l) => l.code))];
  if (ctx.payableRoleCode === null) {
    findings.push({
      regla: 'APE-CXP-SIN-ROL',
      severidad: 'aviso',
      numCta: withDocs[0],
      mensaje:
        `Las facturas de proveedores entran al auxiliar, pero ninguna cuenta tiene el rol "cxp": ` +
        `'ap reconcile' no tiene contra qué compararlas y un pago no sabe qué cuenta cargar. ` +
        `Fíjalo con: mnemosine account role set cxp ${withDocs[0]}`,
    });
  }
  for (const code of withDocs) {
    if (ctx.payableRoleCode !== null && ctx.payableRoleCode !== code) {
      findings.push({
        regla: 'APE-CXP-FUERA-DEL-ROL',
        severidad: 'aviso',
        numCta: code,
        mensaje:
          `Los documentos de "${code}" entran como renglones de la apertura, NO como facturas de ` +
          `proveedor: el rol "cxp" apunta a "${ctx.payableRoleCode}", la única cuenta que los pagos ` +
          `cargan y que 'ap reconcile' concilia. Si "${code}" es la cuenta de proveedores, apunta el ` +
          `rol ahí (mnemosine account role set cxp ${code}) antes de cargar.`,
      });
    }
  }
  const docs = ctx.payableRoleCode === null ? all : all.filter((l) => l.code === ctx.payableRoleCode);

  const seen: (VendorKey & { invoiceNumber: string })[] = [];
  const seenUuids = new Set<string>();
  const assumedZero: string[] = [];
  for (const line of docs) {
    const d = line.doc;
    const amount = new Decimal(d.importe);
    if (amount.isNegative()) {
      findings.push(
        block(
          'APE-CXP-SALDO-DEUDOR',
          line.code,
          `"${d.documento}" de ${d.contraparte} trae ${d.importe}: un saldo a favor frente al ` +
            `proveedor (un anticipo, una nota de crédito) no es una factura por pagar, y dejarlo fuera ` +
            `del auxiliar descuadra 'ap reconcile' por ese importe. Nétalo contra las facturas abiertas ` +
            `del mismo proveedor en el origen.`
        )
      );
      continue;
    }
    const currency = (d.currency ?? ctx.functionalCurrency).trim().toUpperCase();
    if (currency !== ctx.functionalCurrency) {
      findings.push(
        block(
          'APE-CXP-MONEDA',
          line.code,
          `"${d.documento}" está en ${currency} y la entidad lleva sus libros en ` +
            `${ctx.functionalCurrency}. La apertura lo posa en ${ctx.functionalCurrency} y 'ap reconcile' ` +
            `suma el saldo de la factura tal como viene: no se convierte en silencio. Trae su saldo en ` +
            `${ctx.functionalCurrency}.`
        )
      );
      continue;
    }

    let rate = parseIvaRate(d.ivaRate);
    if (rate.kind === 'invalid') {
      findings.push(
        block(
          'APE-CXP-TASA-INVALIDA',
          line.code,
          `"${d.documento}" trae ivaRate "${d.ivaRate}". Se espera la TasaOCuota del CFDI ` +
            `(0.16, 0.08, 0) o "exento".`
        )
      );
      continue;
    }
    if (rate.kind === 'missing') {
      if (ctx.ivaPolicy === 'require_rate') {
        findings.push(
          block(
            'APE-CXP-SIN-TASA',
            line.code,
            `"${d.documento}" de ${d.contraparte} no dice su tasa de IVA (ivaRate). El IVA de una ` +
              `compra no pagada se acredita al pagarla (LIVA art. 5 fr. III) y la DIOT lo declara por ` +
              `tasa: sin ella, el pago no libera el IVA pendiente y la DIOT del mes se detiene. ` +
              `Agrega ivaRate (0.16, 0.08, 0 o "exento"), o decide otra cosa en la política ` +
              `opening_payable_iva.`
          )
        );
        continue;
      }
      assumedZero.push(d.documento);
      rate = { kind: 'rate', rate: new Decimal(0) };
    }

    const vendorName = d.contraparte.trim();
    const vendorRfc = d.rfc === undefined || d.rfc.trim() === '' ? null : d.rfc.trim().toUpperCase();
    const vendor: VendorKey = { rfc: identityRfc(vendorRfc), name: vendorName };
    const uuid = d.uuid === undefined || d.uuid.trim() === '' ? null : d.uuid.trim();
    const taken = ctx.existing.find(
      (e) => e.vendor_invoice_number === d.documento && sameVendor(vendor, vendorOf(e))
    );
    const reusable = taken !== undefined && isStale(taken);
    const uuidTaken =
      uuid !== null &&
      (seenUuids.has(uuid.toUpperCase()) ||
        ctx.existing.some(
          (e) => e.cfdi_uuid !== null && e.cfdi_uuid.toUpperCase() === uuid.toUpperCase() && !isStale(e)
        ));
    const repeated = seen.some((x) => x.invoiceNumber === d.documento && sameVendor(vendor, x));
    if (repeated || uuidTaken || (taken !== undefined && !reusable)) {
      findings.push(
        block(
          'APE-CXP-FOLIO-TOMADO',
          line.code,
          `La factura "${d.documento}" de ${vendorName}${uuidTaken ? ` (UUID ${uuid})` : ''} ya está ` +
            `registrada en esta entidad: cargarla otra vez contaría dos veces el mismo pasivo. Quítala ` +
            `del auxiliar o corrige el folio.`
        )
      );
      continue;
    }
    seen.push({ ...vendor, invoiceNumber: d.documento });
    if (uuid !== null) seenUuids.add(uuid.toUpperCase());

    const subtotal = rate.kind === 'rate' ? amount.dividedBy(rate.rate.plus(1)).toDecimalPlaces(2) : amount;
    drafts.push({
      accountCode: line.code,
      accountId: line.accountId,
      vendorInvoiceNumber: d.documento,
      vendorName,
      vendorRfc,
      date: d.fecha,
      // `due_date` is NOT NULL; the opening already warned (APE-SIN-VENCIMIENTO).
      dueDate: d.vencimiento === undefined || d.vencimiento === '' ? d.fecha : d.vencimiento,
      amount: amount.toFixed(4),
      subtotal: subtotal.toFixed(4),
      tax: amount.minus(subtotal).toFixed(4),
      taxRatePct: rate.kind === 'rate' ? rate.rate.times(100).toFixed(2) : null,
      factorType: rate.kind === 'rate' ? 'tasa' : 'exento',
      currency,
      cfdiUuid: uuid,
      replacesId: reusable ? taken.id : null,
    });
  }

  if (assumedZero.length > 0) {
    findings.push({
      regla: 'APE-CXP-TASA-SUPUESTA',
      severidad: 'aviso',
      numCta: docs[0].code,
      mensaje:
        `${assumedZero.length} documento(s) de proveedores sin ivaRate entran a tasa 0 % ` +
        `(opening_payable_iva = assume_zero_rate): su pago no libera IVA pendiente y ` +
        `la DIOT los declara al 0 %: ${assumedZero.join(', ')}.`,
    });
  }

  // The IVA the bills release when paid has to be parked in the opening:
  // otherwise each payment credits the pending-IVA account below zero.
  const tax = drafts.reduce((acc, x) => acc.plus(x.tax), new Decimal(0));
  const parked = plan.lines
    .filter((l) => l.code === ctx.pendingIvaCode)
    .reduce((acc, l) => acc.plus(l.debit ?? 0).minus(l.credit ?? 0), new Decimal(0));
  if (tax.greaterThan(0) && tax.greaterThan(parked)) {
    findings.push(
      block(
        'APE-CXP-IVA-SIN-SALDO',
        ctx.pendingIvaCode ?? docs[0].code,
        `Las facturas de proveedores traen ${tax.toFixed(2)} de IVA pendiente de acreditar y ` +
          (ctx.pendingIvaCode === null
            ? `ninguna cuenta tiene el rol "iva_pendiente_acreditar". `
            : `la apertura sólo pone ${parked.toFixed(2)} en "${ctx.pendingIvaCode}", la cuenta con el ` +
              `rol "iva_pendiente_acreditar". `) +
          `Cada pago liberaría IVA que el mayor nunca aparcó. Apunta el rol a la cuenta de IVA ` +
          `pendiente de la balanza (mnemosine account role set iva_pendiente_acreditar <cuenta>) o ` +
          `corrige la tasa de los documentos.`
      )
    );
  }

  const takenOver = new Set(drafts.map((x) => x.replacesId));
  const orphans = ctx.stale.filter((e) => !takenOver.has(e.id));
  if (orphans.length > 0) {
    findings.push({
      regla: 'APE-CXP-ANULA-HUERFANAS',
      severidad: 'aviso',
      numCta: withDocs[0],
      mensaje:
        `La apertura reversada dejó ${orphans.length} factura(s) de proveedores sin pagar que esta ` +
        `carga no trae otra vez; se anulan en el mismo acto para que nadie pague un pasivo reversado: ` +
        `${orphans.map((e) => `${e.vendor_invoice_number} de ${e.vendor_name}`).join(', ')}.`,
    });
  }
  return { drafts, findings, voids: orphans.map((e) => e.id) };
}

/** Under `apertura_modo_de_carga = borrador` no bill is written; the load says so. */
export function payablesSkippedUnderDraftMode(plan: Pick<OpeningPlan, 'lines' | 'control'>): OpeningBillsPlan {
  const docs = controlDocuments(plan, 'cxp');
  if (docs.length === 0) return { drafts: [], findings: [], voids: [] };
  return {
    drafts: [],
    voids: [],
    findings: [
      {
        regla: 'APE-CXP-BORRADOR',
        severidad: 'aviso',
        numCta: docs[0].code,
        mensaje:
          `La apertura queda en BORRADOR (apertura_modo_de_carga = borrador), así que sus ${docs.length} ` +
          `documento(s) de proveedores NO entran como facturas: una factura colgada de un asiento sin ` +
          `postear se podría pagar antes de que su pasivo esté en el mayor. Al postearla, 'ap reconcile' ` +
          `acusará ese saldo como diferencia. Para traer las facturas, carga la apertura con ` +
          `apertura_modo_de_carga = contabilizar.`,
      },
    ],
  };
}

const ROLE_CODE_SQL = `SELECT a.code
       FROM account_roles r
       JOIN accounts a ON a.id = r.account_id AND a.entity_id = r.entity_id
      WHERE r.entity_id = $1 AND r.role = $2 AND r.qualifier IS NULL`;

const REVERSED_OPENING_SQL =
  `(je.source_type = 'opening_balance' AND je.reversed_by_entry_id IS NOT NULL) IS TRUE`;

/** Reads what the pure plan needs. Queries nothing when there is no AP document. */
export async function prepareOpeningBills(
  entityId: string,
  plan: Pick<OpeningPlan, 'lines' | 'control'>,
  ivaPolicy: OpeningPayableIvaPolicy = 'require_rate'
): Promise<OpeningBillsPlan> {
  const docs = controlDocuments(plan, 'cxp');
  if (docs.length === 0) return { drafts: [], findings: [], voids: [] };
  const folios = docs.map((l) => l.doc.documento);
  const uuids = docs.flatMap((l) => (l.doc.uuid?.trim() ? [l.doc.uuid.trim().toUpperCase()] : []));

  const role = await query<{ code: string }>(ROLE_CODE_SQL, [entityId, 'cxp']);
  const pendingIva = await query<{ code: string }>(ROLE_CODE_SQL, [entityId, reclassRoles('received').from]);
  const entity = await query<{ functional_currency: string }>(
    `SELECT functional_currency FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const existing = await query<ExistingBill>(
    `SELECT b.id, b.vendor_invoice_number, v.company_name AS vendor_name, v.tax_id AS vendor_rfc,
            b.cfdi_uuid, b.status, b.amount_paid::text AS amount_paid,
            ${REVERSED_OPENING_SQL} AS from_reversed_opening
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
       LEFT JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = b.entity_id
      WHERE b.entity_id = $1
        AND (b.vendor_invoice_number = ANY($2::text[]) OR UPPER(b.cfdi_uuid) = ANY($3::text[]))`,
    [entityId, folios, uuids]
  );
  const stale = await query<StaleBill>(
    `SELECT b.id, b.vendor_invoice_number, v.company_name AS vendor_name
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
       JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = b.entity_id
      WHERE b.entity_id = $1 AND ${REVERSED_OPENING_SQL}
        AND b.status = 'approved' AND b.amount_paid = 0
      ORDER BY b.vendor_invoice_number`,
    [entityId]
  );
  return planOpeningBills(plan, {
    payableRoleCode: role.rows[0]?.code ?? null,
    pendingIvaCode: pendingIva.rows[0]?.code ?? null,
    functionalCurrency: entity.rows[0]?.functional_currency ?? 'MXN',
    ivaPolicy,
    existing: existing.rows,
    stale: stale.rows,
  });
}

/**
 * Writes the plan inside the opening's transaction. The vendor is found by
 * RFC, else by exact name (always by name for a generic RFC), and created
 * only when neither exists. Each bill gets one line with its rate, base and
 * IVA. Then the untouched bills of a reversed opening that this load does
 * not bring again are voided.
 */
export async function writeOpeningBills(
  client: pg.PoolClient,
  entityId: string,
  userId: string,
  openingEntryId: string,
  bills: Pick<OpeningBillsPlan, 'drafts' | 'voids'>
): Promise<number> {
  const vendors = new Map<string, string>();
  for (const d of bills.drafts) {
    const identity = identityRfc(d.vendorRfc);
    const key = identity ?? `name:${d.vendorName.toLowerCase()}`;
    let vendorId = vendors.get(key);
    if (vendorId === undefined) {
      const found = await client.query<{ id: string }>(
        identity !== null
          ? `SELECT id FROM vendors WHERE entity_id = $1 AND UPPER(tax_id) = $2 ORDER BY created_at LIMIT 1`
          : `SELECT id FROM vendors WHERE entity_id = $1 AND LOWER(company_name) = LOWER($2) ORDER BY created_at LIMIT 1`,
        [entityId, identity ?? d.vendorName]
      );
      vendorId = found.rows[0]?.id;
      if (vendorId === undefined) {
        const count = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM vendors WHERE entity_id = $1`,
          [entityId]
        );
        const created = await client.query<{ id: string }>(
          `INSERT INTO vendors (entity_id, vendor_number, company_name, tax_id, tax_id_type,
                                currency_code, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'Migrated with the opening balance', $7)
           RETURNING id`,
          [entityId, generateEntryNumber('V', Number(count.rows[0].n)), d.vendorName,
           d.vendorRfc, d.vendorRfc === null ? null : 'rfc', d.currency, userId]
        );
        vendorId = created.rows[0].id;
      }
      vendors.set(key, vendorId);
    }

    const values = [vendorId, d.amount, d.currency, d.date, d.dueDate, d.cfdiUuid, openingEntryId, entityId,
      d.subtotal, d.tax];
    let billId: string;
    if (d.replacesId !== null) {
      // Guarded: only the untouched bill of a reversed opening is taken over.
      const r = await client.query(
        `UPDATE bills
            SET vendor_id = $1, subtotal = $9, tax_amount = $10, total_amount = $2, amount_due = $2,
                currency_code = $3, bill_date = $4, due_date = $5, cfdi_uuid = $6,
                journal_entry_id = $7, updated_at = NOW()
          WHERE id = $11 AND entity_id = $8 AND status = 'approved' AND amount_paid = 0`,
        [...values, d.replacesId]
      );
      if (r.rowCount !== 1) {
        throw new ConflictError(
          `La factura ${d.vendorInvoiceNumber} de ${d.vendorName} cambió mientras se cargaba la apertura; no se escribió nada.`
        );
      }
      await client.query(`DELETE FROM bill_lines WHERE bill_id = $1`, [d.replacesId]);
      billId = d.replacesId;
    } else {
      const billNumber = await nextEntityNumber(client, entityId, 'bill', 'BILL', d.date);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bills (vendor_id, subtotal, tax_amount, total_amount, amount_due, currency_code, bill_date,
                            due_date, cfdi_uuid, journal_entry_id, entity_id, bill_number,
                            vendor_invoice_number, status, approved_by, approved_at, description, created_by)
         VALUES ($1, $9, $10, $2, $2, $3, $4, $5, $6, $7, $8, $11, $12, 'approved', $13, NOW(), $14, $13)
         RETURNING id`,
        [...values, billNumber, d.vendorInvoiceNumber, userId, `Open at the opening balance · ${d.accountCode}`]
      );
      billId = inserted.rows[0].id;
    }
    // One line: the DIOT breaks the paid IVA down by the rate of the lines.
    await client.query(
      `INSERT INTO bill_lines (bill_id, line_number, account_id, description, quantity, unit_price,
                               line_amount, tax_amount, total_amount, tax_rate, tipo_factor, valor_actos)
       VALUES ($1, 1, $2, $3, 1, $4, $4, $5, $6, $7, $8, $4)`,
      [billId, d.accountId, `Open at the opening balance · ${d.vendorInvoiceNumber}`, d.subtotal, d.tax,
       d.amount, d.taxRatePct, d.factorType]
    );
  }

  if (bills.voids.length > 0) {
    // Guarded: still untouched and still hanging from a reversed opening.
    const r = await client.query(
      `UPDATE bills b
          SET status = 'void', amount_due = 0, updated_at = NOW()
         FROM journal_entries je
        WHERE b.id = ANY($2::uuid[]) AND b.entity_id = $1
          AND je.id = b.journal_entry_id AND je.entity_id = b.entity_id
          AND ${REVERSED_OPENING_SQL}
          AND b.status = 'approved' AND b.amount_paid = 0`,
      [entityId, bills.voids]
    );
    if (r.rowCount !== bills.voids.length) {
      throw new ConflictError(
        'Una factura de la apertura reversada cambió mientras se cargaba la apertura; no se escribió nada.'
      );
    }
  }
  return bills.drafts.length;
}
