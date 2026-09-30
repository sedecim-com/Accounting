import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';
import { entityUsesCashBasisIva, resolveInvoiceMetodoPago } from '../accounting/iva-cash-basis.js';
import { vatColumnsOf } from '../xml-ingestion/pre-registration-service.js';
import type { CFDIParsed } from '../xml-ingestion/cfdi-parser.js';
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
  type PoliticaBaseExenta,
  type PorcionPagada,
  type RangoDelMes,
  type RenglonDeGasto,
} from '../sat/diot/index.js';

// ============================================================
// THE MONTHLY IVA WORKPAPER, PART 1/3: DEFINITIVE IVA BY RATE (#308, MNE-001-058)
//
// Mexican IVA is caused when the money moves (LIVA arts. 1-B, 5 fr. III), so
// the month's figures are the two cash events the ledger already records:
//
//   · charged    — IVA trasladado COLLECTED: a PUE invoice posted in the
//                  month, whole; a PPD invoice, the IVA its customer payments
//                  of the month released (payment_allocations.iva_reclass_amount,
//                  the very amount posted from 2125 to 2120).
//   · creditable — IVA acreditable PAID: the DIOT's facts (`hechosDelMes`), the
//                  one definition of "IVA paid" in this project. A third query
//                  for it would be the fourth definition.
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

function rateLines(side: 'charged' | 'creditable', d: Desglose, sign: 1 | -1): Array<[string, string, 1 | -1 | 0]> {
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
    ...rateLines('creditable', f.creditable, -1),
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
  applied_before?: string;
  applied_now?: string;
  vat_released?: string;
}

const INVOICE_COLUMNS = `i.id, i.invoice_number, i.tax_amount::text, i.total_amount::text,
  i.exchange_rate::text, i.terms, i.memo, i.cfdi_uuid`;

/** What a sale is split by: its CFDI when it was born from one, its lines otherwise. */
interface SaleSource {
  lines: RenglonDeGasto[];
  /** Base "no objeto" of the whole document, in its currency. Only a CFDI says it. */
  notSubject: string;
  /** True when the lines came from the CFDI, false when from invoice_lines. */
  fromCfdi: boolean;
}

/**
 * The CFDI's own split. `tax_breakdown` is the Comprobante/Impuestos summary
 * stored at ingestion: one Traslado per tax, factor and rate, with its Base.
 * Each becomes one line through `vatColumnsOf`, the reading the bills get.
 * What the subtotal carries beyond the bases the CFDI taxes or exempts is
 * "no objeto" (ObjetoImp 01): such a concept appears in no Traslado at all.
 */
export function saleFromCfdi(
  taxes: Partial<CFDIParsed['impuestos']>,
  subtotal: string,
  discount: string
): SaleSource {
  const vat = (taxes.traslados ?? []).filter((t) => String(t.impuesto ?? '').padStart(3, '0') === '002');
  const lines = vat.map((t): RenglonDeGasto => {
    const c = vatColumnsOf([t]);
    return {
      tipoFactor: c.factor_type,
      tasa: c.tax_rate,
      valorActos: c.acts_value,
      importe: c.acts_value ?? '0',
      iva: q4(c.tax),
    };
  });
  // A Traslado without its Base leaves the rest unknown, and an unknown rest
  // is not "no objeto": the exempt line without a base already blocks.
  const known = vat.every((t) => t.base != null);
  const bases = vat.reduce((acc, t) => acc.plus(t.base ?? 0), new Decimal(0));
  const rest = known ? new Decimal(subtotal).minus(discount).minus(bases) : new Decimal(0);
  return { lines, notSubject: q4(rest.greaterThan('0.01') ? rest : 0), fromCfdi: true };
}

async function saleSources(
  client: pg.PoolClient,
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, SaleSource>> {
  const bySale = new Map<string, SaleSource>();
  if (ids.length === 0) return bySale;
  const cfdi = await client.query<{
    invoice_id: string; tax_breakdown: Partial<CFDIParsed['impuestos']>; subtotal: string; discount: string;
  }>(
    `SELECT p.result_id AS invoice_id, p.tax_breakdown, x.subtotal::text, COALESCE(x.descuento, 0)::text AS discount
       FROM pre_registrations p
       JOIN xml_documents x ON x.id = p.xml_document_id AND x.entity_id = p.entity_id
      WHERE p.entity_id = $1 AND p.result_type = 'invoice' AND p.result_id = ANY($2::uuid[])
        AND p.tax_breakdown IS NOT NULL`,
    [entityId, [...ids]]
  );
  for (const r of cfdi.rows) bySale.set(r.invoice_id, saleFromCfdi(r.tax_breakdown, r.subtotal, r.discount));

  const manual = ids.filter((id) => !bySale.has(id));
  if (manual.length === 0) return bySale;
  const { rows } = await client.query<{
    invoice_id: string; tax_rate: string | null; tax_code: string | null; line_amount: string; tax_amount: string;
  }>(
    `SELECT il.invoice_id, il.tax_rate::text, il.tax_code, il.line_amount::text, il.tax_amount::text
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.entity_id = $1 AND il.invoice_id = ANY($2::uuid[])
      ORDER BY il.invoice_id, il.line_number`,
    [entityId, manual]
  );
  for (const r of rows) {
    const sale = bySale.get(r.invoice_id) ?? { lines: [], notSubject: q4(0), fromCfdi: false };
    // A manual invoice line has no tipo_factor column: `tax_code = 'exento'`
    // is the only way it says so. Its base is its own amount.
    const exempt = (r.tax_code ?? '').trim().toLowerCase() === 'exento';
    sale.lines.push({
      tipoFactor: exempt ? 'exento' : 'tasa',
      tasa: exempt ? null : r.tax_rate,
      valorActos: r.line_amount,
      importe: r.line_amount,
      iva: r.tax_amount,
    });
    bySale.set(r.invoice_id, sale);
  }
  return bySale;
}

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

interface ChargedOfMonth {
  breakdown: Desglose;
  notSubject: string;
  /** IVA withheld by customers, on the same cash basis as the charged side. */
  withheld: string;
  /** What the month's sales entries debited to iva_retenido_a_favor when issued. */
  withheldPostedAtIssuance: string;
  findings: Hallazgo[];
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
  const ppdCandidates = await client.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS},
            COALESCE(SUM(pa.amount_applied) FILTER (WHERE cp.payment_date < $2::date), 0)::text AS applied_before,
            COALESCE(SUM(pa.amount_applied) FILTER (WHERE cp.payment_date >= $2::date), 0)::text AS applied_now,
            COALESCE(SUM(pa.iva_reclass_amount) FILTER (WHERE cp.payment_date >= $2::date), 0)::text AS vat_released
       FROM invoices i
       JOIN payment_allocations pa ON pa.invoice_id = i.id AND pa.unapplied_at IS NULL
       JOIN customer_payments cp ON cp.id = pa.payment_id
      WHERE i.entity_id = $1 AND cp.entity_id = $1 AND cp.journal_entry_id IS NOT NULL
        AND cp.status NOT IN ('void', 'reversed') AND cp.payment_date <= $3::date
        AND i.status NOT IN ('void', 'cancelled')
      GROUP BY i.id
     HAVING COALESCE(SUM(pa.amount_applied) FILTER (WHERE cp.payment_date >= $2::date), 0) > 0
      ORDER BY i.invoice_number`,
    [entityId, range.desde, range.hasta]
  );

  const picked: Array<{ row: InvoiceRow; share: PorcionPagada; vat: string }> = [];
  for (const row of issuedInMonth.rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo !== 'PUE') continue;
    const share = { aplicadoPrevio: '0', aplicadoAhora: row.total_amount, totalDocumento: row.total_amount, tasaCambio: row.exchange_rate };
    picked.push({ row, share, vat: acumuladoDelDocumento(row.tax_amount, row.total_amount, row.total_amount, row.exchange_rate) });
  }
  for (const row of ppdCandidates.rows) {
    if ((await resolveInvoiceMetodoPago(client, { ...row, entity_id: entityId })).metodo !== 'PPD') continue;
    const share = {
      aplicadoPrevio: row.applied_before ?? '0',
      aplicadoAhora: row.applied_now ?? '0',
      totalDocumento: row.total_amount,
      tasaCambio: row.exchange_rate,
    };
    picked.push({ row, share, vat: row.vat_released ?? '0' });
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
  for (const { row, share, vat } of picked) {
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
    breakdown = sumarDesgloses(breakdown, r.desglose);
    findings.push(...r.hallazgos);
    notSubject = notSubject.plus(porcionDelDocumento(source.notSubject, share));
    if (!source.fromCfdi) manualZeroRate = manualZeroRate.plus(r.desglose.tasa0.base);
    // The entry's amount is already in functional currency: only the ratio applies.
    withheld = withheld.plus(porcionDelDocumento(withheldOf.get(row.id) ?? '0', { ...share, tasaCambio: '1' }));
  }
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
    breakdown,
    notSubject: q4(notSubject),
    withheld: q4(withheld),
    withheldPostedAtIssuance: q4(postedAtIssuance),
    findings,
  };
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
  figures: IvaWorkpaperFigures;
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

function tieOut(findings: Hallazgo[], code: string, what: string, role: string, facts: string, ledger: Decimal): void {
  if (new Decimal(facts).minus(ledger).abs().lessThanOrEqualTo('0.01')) return;
  findings.push({
    codigo: code,
    severidad: 'aviso',
    mensaje:
      `El ${what} suma ${q4(facts)} y el movimiento del mes de la cuenta de rol ${role} ` +
      `es ${q4(ledger)}. Revisa las pólizas del mes antes de declarar: una nota de crédito, un ` +
      `asiento manual o un documento sin renglones explican la diferencia.`,
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
    }

    const ledger = await roleMovements(client, tenantId, entityId, range);
    const net = (r: IvaRole): Decimal => ledger[r].debit.minus(ledger[r].credit);
    tieOut(findings, 'IVA-WP-CHARGED-VS-LEDGER', 'IVA trasladado cobrado por tasa', 'iva_trasladado', ivaDelDesglose(charged.breakdown), net('iva_trasladado').negated());
    tieOut(findings, 'IVA-WP-CREDITABLE-VS-LEDGER', 'IVA acreditable pagado por tasa', 'iva_acreditable', ivaDelDesglose(creditable), net('iva_acreditable'));
    // Debits only: the month's settlement or offset entry credits the account,
    // and a net movement would read as zero once it is posted.
    tieOut(findings, 'IVA-WP-WITHHELD-VS-LEDGER', 'IVA retenido que las ventas del mes registraron al emitirse', 'iva_retenido_a_favor (cargos)', charged.withheldPostedAtIssuance, ledger.iva_retenido_a_favor.debit);

    const notTaxed = new Decimal(charged.breakdown.exento.base).plus(charged.notSubject);
    if (notTaxed.greaterThan(0)) {
      findings.push({
        codigo: 'IVA-WP-PRORATION-NOT-APPLIED',
        severidad: 'aviso',
        mensaje:
          `El mes cobró ${q4(notTaxed)} de actos exentos o no objeto del IVA y el IVA acreditable se ` +
          `muestra completo: el prorrateo del art. 5 fr. V LIVA no se aplica todavía. Si el IVA pagado ` +
          `sirve también a esos actos, el acreditable está sobrestimado; calcula la proporción antes ` +
          `de declarar.`,
      });
    }

    const figures: IvaWorkpaperFigures = {
      charged: charged.breakdown,
      chargedNotSubject: charged.notSubject,
      creditable,
      withheldByCustomers: charged.withheld,
      // Credits only, for the same reason: what was withheld in the month.
      withheldToRemit: q4(ledger.iva_retenido_por_pagar.credit),
      priorBalanceInFavor,
    };
    const blockedBy = [...new Set(findings.filter((h) => h.severidad === 'bloqueante').map((h) => h.codigo))];
    return {
      period: { year, month, ...range },
      rounding: { key: FILING_ROUNDING_POLICY, value: rounding, defined: roundingPolicy.defined },
      figures,
      settlement: blockedBy.length > 0 ? null : settleIva(figures, rounding),
      blockedBy,
      ledger: Object.fromEntries(ROLES.map((r) => [r, q4(net(r))])) as Record<IvaRole, string>,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
