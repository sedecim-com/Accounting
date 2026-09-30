import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';
import { entityUsesCashBasisIva, resolveInvoiceMetodoPago } from '../accounting/iva-cash-basis.js';
import {
  acumuladoDelDocumento,
  desglosarDocumento,
  desgloseCero,
  hechosDelMes,
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

async function invoiceLines(
  client: pg.PoolClient,
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, RenglonDeGasto[]>> {
  const byInvoice = new Map<string, RenglonDeGasto[]>();
  if (ids.length === 0) return byInvoice;
  const { rows } = await client.query<{
    invoice_id: string; tax_rate: string | null; tax_code: string | null; line_amount: string; tax_amount: string;
  }>(
    `SELECT il.invoice_id, il.tax_rate::text, il.tax_code, il.line_amount::text, il.tax_amount::text
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.entity_id = $1 AND il.invoice_id = ANY($2::uuid[])
      ORDER BY il.invoice_id, il.line_number`,
    [entityId, [...ids]]
  );
  for (const r of rows) {
    const list = byInvoice.get(r.invoice_id) ?? [];
    // An invoice line has no tipo_factor column: `tax_code = 'exento'` is the
    // only way it says so. Its base is its own amount, never a derivation.
    const exempt = (r.tax_code ?? '').trim().toLowerCase() === 'exento';
    list.push({
      tipoFactor: exempt ? 'exento' : 'tasa',
      tasa: exempt ? null : r.tax_rate,
      valorActos: r.line_amount,
      importe: r.line_amount,
      iva: r.tax_amount,
    });
    byInvoice.set(r.invoice_id, list);
  }
  return byInvoice;
}

async function chargedOfMonth(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<{ breakdown: Desglose; findings: Hallazgo[] }> {
  const pueCandidates = await client.query<InvoiceRow>(
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
  for (const row of pueCandidates.rows) {
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

  const lines = await invoiceLines(client, entityId, picked.map((p) => p.row.id));
  let breakdown = desgloseCero();
  const findings: Hallazgo[] = [];
  for (const { row, share, vat } of picked) {
    const r = desglosarDocumento({
      documentId: row.id,
      documentNumber: row.invoice_number,
      renglones: lines.get(row.id) ?? [],
      ivaCabecera: row.tax_amount,
      ivaPagado: vat,
      porcion: share,
      politicaBaseExenta: 'exigir_base',
    });
    breakdown = sumarDesgloses(breakdown, r.desglose);
    findings.push(...r.hallazgos);
  }
  return { breakdown, findings };
}

// ------------------------------------------------------------
// THE LEDGER: role accounts, through report-service
// ------------------------------------------------------------

const ROLES = ['iva_trasladado', 'iva_acreditable', 'iva_retenido_a_favor', 'iva_retenido_por_pagar'] as const;
type IvaRole = (typeof ROLES)[number];

/** Net movement of each role in the month, debit positive. */
async function roleMovements(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string,
  range: RangoDelMes
): Promise<Record<IvaRole, Decimal>> {
  const { rows: mapped } = await client.query<{ role: IvaRole; account_id: string }>(
    `SELECT DISTINCT role, account_id FROM account_roles
      WHERE tenant_id = $1 AND entity_id = $2 AND role = ANY($3::text[])`,
    [tenantId, entityId, [...ROLES]]
  );
  const balance = await queryTrialBalanceRows(entityId, { sinceDate: range.desde, untilDate: range.hasta });
  const byAccount = new Map(balance.map((b) => [b.account_id, new Decimal(b.debit_total).minus(b.credit_total)]));
  const out = Object.fromEntries(ROLES.map((r) => [r, new Decimal(0)])) as Record<IvaRole, Decimal>;
  for (const m of mapped) out[m.role] = out[m.role].plus(byAccount.get(m.account_id) ?? 0);
  return out;
}

// ------------------------------------------------------------
// THE WORKPAPER
// ------------------------------------------------------------

export interface IvaWorkpaper {
  period: { year: number; month: number } & RangoDelMes;
  rounding: { key: string; value: FilingRounding; defined: boolean };
  figures: IvaWorkpaperFigures;
  settlement: IvaSettlement;
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

const q4 = (d: Decimal.Value): string => new Decimal(d).toFixed(4);

function tieOut(findings: Hallazgo[], code: string, what: string, role: string, facts: string, ledger: Decimal): void {
  if (new Decimal(facts).minus(ledger).abs().lessThanOrEqualTo('0.01')) return;
  findings.push({
    codigo: code,
    severidad: 'aviso',
    mensaje:
      `El ${what} por tasa suma ${q4(facts)} y el movimiento del mes de la cuenta de rol ${role} ` +
      `es ${q4(ledger)}. Revisa las pólizas del mes antes de declarar: una nota de crédito, un ` +
      `asiento manual o un documento sin renglones explican la diferencia.`,
  });
}

export async function buildIvaWorkpaper(opts: IvaWorkpaperOptions): Promise<IvaWorkpaper> {
  const { tenantId, entityId, year, month } = opts;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError(`El mes ${String(month)} no existe: el IVA definitivo es mensual.`, 'month');
  }
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
    const ivaOf = (d: Desglose): string =>
      q4([d.tasa16, d.tasa8, d.tasa0, d.exento, ...d.otras].reduce((a, c) => a.plus(c.iva), new Decimal(0)));
    tieOut(findings, 'IVA-WP-CHARGED-VS-LEDGER', 'IVA trasladado cobrado', 'iva_trasladado', ivaOf(charged.breakdown), ledger.iva_trasladado.negated());
    tieOut(findings, 'IVA-WP-CREDITABLE-VS-LEDGER', 'IVA acreditable pagado', 'iva_acreditable', ivaOf(creditable), ledger.iva_acreditable);

    const figures: IvaWorkpaperFigures = {
      charged: charged.breakdown,
      creditable,
      withheldByCustomers: q4(ledger.iva_retenido_a_favor),
      withheldToRemit: q4(ledger.iva_retenido_por_pagar.negated()),
      priorBalanceInFavor: q4(opts.priorBalanceInFavor ?? '0'),
    };
    return {
      period: { year, month, ...range },
      rounding: { key: FILING_ROUNDING_POLICY, value: rounding, defined: roundingPolicy.defined },
      figures,
      settlement: settleIva(figures, rounding),
      ledger: Object.fromEntries(ROLES.map((r) => [r, q4(ledger[r])])) as Record<IvaRole, string>,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
