import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { entityScope } from '../../database/scope.js';
import { AccountingError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';
import { predicadoSinCierre } from '../reporting/criterio-cierre.js';
import { entityUsesCashBasisIva } from '../accounting/iva-cash-basis.js';
import { factorEntrePeriodos } from './inpc/inpc-service.js';
import type { Periodo } from './inpc/periodo.js';
import { rangoDelMes, type Hallazgo } from '../sat/diot/index.js';
import { FILING_ROUNDING_POLICY, readFilingRounding, roundToWhole, toCents, type FilingRounding } from './iva-workpaper.js';
import {
  corporateIncomeTaxRateAt,
  incomeTaxInputForPayment,
  type IncomeTaxInput,
} from './provisional-income-tax-inputs.js';

// ============================================================
// THE MONTHLY WORKPAPER, PART 2/3: PROVISIONAL ISR OF A LEGAL ENTITY
// (#308, MNE-001-059)
//
// LISR art. 14, cumulative from January to the month of the payment:
//
//   nominal income (the ledger's revenue accounts, year to date)
//   × profit coefficient (the annual return the law picks, MNE-001-115)
//   = estimated profit
//   − PTU paid in the year, in equal eighths from May to December (fr. II)
//   − tax losses pending amortization, from the PREVIOUS year's return
//     only, updated by INPC (art. 57), never more than what is left of the
//     profit
//   = taxable base
//   × corporate rate (legal_parameters, in force at the end of the month)
//   − provisional payments already made this year
//   − ISR withheld to the entity in the year (role isr_retenido_a_favor)
//   = the payment, never negative: an excess is not refunded by a
//     provisional payment, it waits for the annual return.
//
// NOMINAL INCOME is the revenue accounts' credits minus debits, closing
// entries excluded whatever the panel says (a tax figure, not a
// presentation). The inflation adjustment is not in the ledger, so nothing
// has to be taken out of it. The accounts with the sales-returns role are
// the panel's `provisional_isr_sales_returns`: by default a deduction of the
// annual return (LISR art. 25 fr. I), out of the nominal income, which is
// how the coefficient's denominator is built. Two things the ledger cannot
// say, the paper warns about instead of guessing: customer advances, which
// LISR art. 17 fr. I accumulates when collected (anticipo_clientes mixes
// advance CFDIs at their subtotal with on-account remainders that carry
// their IVA), and non-accumulable revenue such as dividends from Mexican
// entities (art. 16), which has no role of its own yet.
//
// WITHHELD ISR is read per entry: an entry whose lines on the role accounts
// net to a debit withheld that amount. The opening balance is last year's
// withholding, already credited in last year's return, and never counts. A
// reversal mirror dated by the end of the month takes its original back, and
// so does an unapplied collection. Any other credit to the account applies
// the withholding against a tax, and does not undo that it was withheld.
//
// ROUNDING is the panel's `declaracion_redondeo_a_pesos`, as for the IVA:
// cada_renglon (default) adjusts every captured line to pesos by CFF art. 20
// and the chain continues with whole numbers, as the portal does;
// solo_el_pago runs the chain in cents and adjusts only the payment. Every
// line keeps both columns.
//
// Two figures a person captures, as the IVA's prior balance in favor: the
// PTU paid in the year and the provisional payments already made, because
// `filing record` keeps no amounts yet.
//
// Nothing is filed: a person reviews this workpaper and declares.
// ============================================================

export interface ProvisionalIncomeTaxFigures {
  /** Year-to-date nominal income, four decimals. */
  nominalIncome: string;
  profitCoefficient: string;
  /** The PTU the month may deduct: the year's PTU × (month − 4) / 8 from May. */
  ptuDeductible: string;
  /** Pending losses already updated to the month of application. */
  pendingLosses: string;
  rate: string;
  priorProvisionalPayments: string;
  withheldIncomeTax: string;
}

export interface IncomeTaxLine {
  key: string;
  cents: string;
  whole: string;
}

export interface ProvisionalIncomeTaxSettlement {
  lines: IncomeTaxLine[];
  resultCents: string;
  resultWhole: string;
}

const max0 = (d: Decimal): Decimal => Decimal.max(d, 0);

function chain(f: ProvisionalIncomeTaxFigures, adjust: (d: Decimal.Value) => Decimal): Array<[string, Decimal]> {
  const income = adjust(f.nominalIncome);
  const profit = adjust(income.times(f.profitCoefficient));
  const ptu = adjust(f.ptuDeductible);
  const afterPtu = max0(profit.minus(ptu));
  const losses = Decimal.min(adjust(f.pendingLosses), afterPtu);
  const base = afterPtu.minus(losses);
  const tax = adjust(base.times(f.rate));
  const prior = adjust(f.priorProvisionalPayments);
  const withheld = adjust(f.withheldIncomeTax);
  return [
    ['nominal_income', income],
    ['estimated_profit', profit],
    ['ptu_deducted', ptu],
    ['pending_losses_applied', losses],
    ['taxable_base', base],
    ['tax_caused', tax],
    ['prior_provisional_payments', prior],
    ['withheld_income_tax', withheld],
    ['payable', max0(tax.minus(prior).minus(withheld))],
  ];
}

export function settleProvisionalIncomeTax(
  f: ProvisionalIncomeTaxFigures,
  rounding: FilingRounding
): ProvisionalIncomeTaxSettlement {
  const cents = chain(f, toCents);
  // Each line's pesos come from the chain the rounding runs: with
  // solo_el_pago that is the chain in cents, so the paper shows one payment.
  const whole = rounding === 'cada_renglon'
    ? chain(f, roundToWhole)
    : cents.map(([key, c]): [string, Decimal] => [key, roundToWhole(c)]);
  const lines = cents.map(([key, c], i) => ({ key, cents: c.toFixed(2), whole: whole[i][1].toFixed(0) }));
  return {
    lines,
    resultCents: cents[cents.length - 1][1].toFixed(2),
    resultWhole: whole[whole.length - 1][1].toFixed(0),
  };
}

export const SALES_RETURNS_POLICY = 'provisional_isr_sales_returns';

export type SalesReturnsTreatment = 'deduction' | 'net_of_income';

const KNOWN_TREATMENTS: readonly SalesReturnsTreatment[] = ['deduction', 'net_of_income'];

/** Closed on declaring, as the rounding: a value this reader does not know is named. */
export async function readSalesReturnsTreatment(
  ctx: PolicyContext,
  client?: pg.PoolClient
): Promise<SalesReturnsTreatment> {
  const policy = await getPolicy(ctx, SALES_RETURNS_POLICY, client);
  const value = KNOWN_TREATMENTS.find((t) => t === policy.value);
  if (!value) {
    throw new AccountingError(
      'SALES_RETURNS_TREATMENT_UNKNOWN',
      `La política ${SALES_RETURNS_POLICY} vale "${policy.value}" y este lector sólo ` +
        `entiende ${KNOWN_TREATMENTS.join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return value;
}

/** LISR art. 14 fr. II: the year's PTU, in equal eighths from May, cumulatively. */
export function ptuDeductibleIn(month: number, ptuPaidInYear: Decimal.Value): Decimal {
  return month < 5 ? new Decimal(0) : new Decimal(ptuPaidInYear).times(month - 4).dividedBy(8);
}

/**
 * The INPC month pending losses are updated to. LISR art. 57: the last month
 * of the first half of the year that applies them (June). June's index is
 * not published when the January to June payments are due, so those use
 * December of the previous year, the latest the law lets them know.
 */
export function lossesUpdateTarget(year: number, month: number): Periodo {
  return month >= 7 ? { anio: year, mes: 6 } : { anio: year - 1, mes: 12 };
}

/** CFF art. 17-A: a factor below 1 is taken as 1. */
export function applyUpdateFactor(amount: Decimal.Value, factor: Decimal.Value): Decimal {
  return new Decimal(amount).times(Decimal.max(factor, 1));
}

export interface ProvisionalIncomeTaxOptions {
  tenantId: string;
  entityId: string;
  year: number;
  month: number;
  /** PTU paid in the year (LFT art. 122). Captured by a person. */
  ptuPaidInYear?: string;
  /** Provisional ISR already paid for earlier months of the year. Captured by a person. */
  priorProvisionalPayments?: string;
  client?: pg.PoolClient;
}

export interface ProvisionalIncomeTaxWorkpaper {
  period: { year: number; month: number; from: string; through: string };
  rounding: { key: string; value: FilingRounding; defined: boolean };
  /** The captured inputs as read, with their source return. */
  coefficient: IncomeTaxInput | null;
  losses: (IncomeTaxInput & { updatedTo: string; factor: string }) | null;
  rate: { value: string; effectiveFrom: string; sourceUrl: string } | null;
  /** Revenue accounts that moved in the year, credit positive: nominal income traces to them. */
  incomeAccounts: Array<{ code: string; name: string; amount: string }>;
  /** The sales-returns accounts, debit negative; they enter the nominal income only when netted. */
  salesReturns: { treatment: SalesReturnsTreatment; accounts: Array<{ code: string; name: string; amount: string }> };
  /** Customer advances collected in the year (anticipo_clientes credits), which the paper does not add. */
  advancesCollected: Array<{ code: string; amount: string }>;
  withholdingAccounts: Array<{ code: string; amount: string }>;
  /** The entries `withheldInRange` COUNTED in the withheld figure: the line's trace, not every movement. */
  withholdingEntryIds: string[];
  /**
   * Every revenue account that enters the nominal income, BEFORE the zero-net
   * filter: a sale and its full reversal net to zero in the year but both
   * entries moved the account, and a trace over `incomeAccounts` would lose them.
   */
  incomeTraceAccounts: Array<{ id: string; code: string }>;
  figures: ProvisionalIncomeTaxFigures;
  settlement: ProvisionalIncomeTaxSettlement | null;
  blockedBy: string[];
  findings: Hallazgo[];
}

function amountOf(raw: string | undefined, field: string): string {
  let value: Decimal | null;
  try {
    value = new Decimal(raw ?? '0');
  } catch {
    value = null;
  }
  if (value === null || !value.isFinite() || value.isNegative()) {
    throw new ValidationError(`${field} vale "${String(raw)}": debe ser un importe de cero o más.`, field);
  }
  return value.toFixed(4);
}

/** c_RegimenFiscal 601, General de Ley Personas Morales. */
const GENERAL_REGIME = '601';

const pad = (n: number): string => String(n).padStart(2, '0');

export async function buildProvisionalIncomeTaxWorkpaper(
  opts: ProvisionalIncomeTaxOptions
): Promise<ProvisionalIncomeTaxWorkpaper> {
  const { tenantId, entityId, year, month } = opts;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError(`El mes ${String(month)} no existe: el pago provisional es mensual.`, 'month');
  }
  const ptuPaid = amountOf(opts.ptuPaidInYear, 'ptuPaidInYear');
  const prior = amountOf(opts.priorProvisionalPayments, 'priorProvisionalPayments');

  const run = async (client: pg.PoolClient): Promise<ProvisionalIncomeTaxWorkpaper> => {
    const { rows: entity } = await client.query<{ tax_regime: string | null }>(
      'SELECT tax_regime FROM legal_entities WHERE id = $1 AND tenant_id = $2',
      [entityId, tenantId]
    );
    if (entity.length === 0) throw new NotFoundError('Entidad legal', entityId);
    if (!(await entityUsesCashBasisIva(client, entityId))) {
      throw new ValidationError('La entidad no lleva libros mexicanos: no hay ISR provisional que calcular.', 'entity_id');
    }
    const ctx = { tenantId, entityId };
    const scope = entityScope(tenantId, entityId);
    const through = rangoDelMes(year, month).hasta;
    const from = `${year}-01-01`;
    const findings: Hallazgo[] = [];
    const block = (code: string, message: string): void => {
      findings.push({ codigo: code, severidad: 'bloqueante', mensaje: message });
    };

    // Art. 14 is the general regime of Title II (c_RegimenFiscal 601). RESICO
    // (626) and the other regimes pay on a different base: fail closed.
    const regime = entity[0].tax_regime;
    if (regime === null) {
      findings.push({ codigo: 'ISR-WP-REGIME-UNDECLARED', severidad: 'aviso',
        mensaje: 'La entidad no declara su régimen fiscal: el papel asume el régimen general (601, LISR art. 14).' });
    } else if (regime !== GENERAL_REGIME) {
      block('ISR-WP-REGIME',
        `La entidad tributa en el régimen ${regime}: el pago provisional del art. 14 LISR es del régimen general (601).`);
    }

    const roundingPolicy = await getPolicy(ctx, FILING_ROUNDING_POLICY, client);
    const rounding = await readFilingRounding(ctx, client);
    const payment = { fiscalYear: year, month };

    const coefficient = await incomeTaxInputForPayment(scope, 'profit_coefficient', payment, {}, client);
    if (!coefficient) {
      block('ISR-WP-NO-COEFFICIENT',
        `No hay coeficiente de utilidad capturado de una declaración anual presentada o exigible al ` +
          `vencer el pago de ${year}-${pad(month)} (LISR art. 14 fr. I). Captúralo con su declaración; ` +
          `en el primer ejercicio de operaciones no hay pagos provisionales.`);
    }

    // Pending losses come from the previous year's return, not from the one
    // art. 14 fr. I picks for the coefficient: an older return's losses still
    // hold what the year after it amortized. December's due date admits
    // every return of the previous year, so it finds that one if captured.
    const lossInput = await incomeTaxInputForPayment(
      scope, 'pending_tax_losses', { fiscalYear: year, month: 12 }, {}, client);
    let losses: ProvisionalIncomeTaxWorkpaper['losses'] = null;
    if (lossInput && lossInput.sourceFiscalYear < year - 1) {
      block('ISR-WP-LOSSES-STALE',
        `Las pérdidas pendientes capturadas son de la declaración de ${lossInput.sourceFiscalYear}; ` +
          `el pago de ${year} aplica las que quedaron al cierre de ${year - 1} (LISR art. 57). ` +
          `Captura las de la declaración de ${year - 1}, aunque sean cero.`);
    } else if (lossInput) {
      const target = lossesUpdateTarget(year, month);
      const [y, m] = (lossInput.updatedThrough as string).split('-').map(Number);
      const updatedTo = `${target.anio}-${pad(target.mes)}`;
      try {
        const factor = updatedTo <= (lossInput.updatedThrough as string)
          ? '1.0000'
          : (await factorEntrePeriodos({ anio: y, mes: m }, target)).factor;
        losses = { ...lossInput, updatedTo, factor };
      } catch (e) {
        block('ISR-WP-LOSSES-NOT-UPDATED',
          `Las pérdidas pendientes están actualizadas a ${lossInput.updatedThrough} y deben llegar a ` +
            `${updatedTo} (LISR art. 57): ${(e as Error).message}`);
      }
    }

    let rate: ProvisionalIncomeTaxWorkpaper['rate'] = null;
    try {
      const r = await corporateIncomeTaxRateAt(through, client);
      if (r.value === null) throw new Error(`La tasa del ISR de personas morales está derogada al ${through}.`);
      rate = { value: r.value, effectiveFrom: r.effectiveFrom, sourceUrl: r.sourceUrl };
    } catch (e) {
      block('ISR-WP-NO-RATE', (e as Error).message);
    }

    const balance = await queryTrialBalanceRows(
      entityId, { sinceDate: from, untilDate: through, excludeClosingEntries: true }, client);
    const { rows: roleRows } = await client.query<{ account_id: string; role: string }>(
      `SELECT DISTINCT account_id, role FROM account_roles
        WHERE tenant_id = $1 AND entity_id = $2
          AND role IN ('isr_retenido_a_favor', 'devolucion_ventas', 'anticipo_clientes')`,
      [tenantId, entityId]
    );
    const withRole = (role: string) => new Set(roleRows.filter((r) => r.role === role).map((r) => r.account_id));
    const returnIds = withRole('devolucion_ventas');
    const advanceIds = withRole('anticipo_clientes');

    const treatment = await readSalesReturnsTreatment(ctx, client);
    const revenueMoved = balance
      .filter((b) => b.account_type === 'revenue')
      .map((b) => ({
        id: b.account_id, code: b.account_code, name: b.account_name,
        amount: new Decimal(b.credit_total).minus(b.debit_total),
        moved: !new Decimal(b.credit_total).isZero() || !new Decimal(b.debit_total).isZero(),
      }));
    const revenue = revenueMoved.filter((b) => !b.amount.isZero());
    const incomeTraceAccounts = revenueMoved
      .filter((b) => b.moved && (treatment === 'net_of_income' || !returnIds.has(b.id)))
      .map((b) => ({ id: b.id, code: b.code }));
    const returns = revenue.filter((b) => returnIds.has(b.id));
    const incomeAccounts = revenue.filter((b) => treatment === 'net_of_income' || !returnIds.has(b.id));
    const nominalIncome = incomeAccounts.reduce((acc, b) => acc.plus(b.amount), new Decimal(0));

    const advancesCollected = balance
      .filter((b) => advanceIds.has(b.account_id) && !new Decimal(b.credit_total).isZero())
      .map((b) => ({ code: b.account_code, amount: new Decimal(b.credit_total).toFixed(4) }));
    if (advancesCollected.length > 0) {
      findings.push({ codigo: 'ISR-WP-ADVANCES', severidad: 'aviso',
        mensaje: `Anticipos de clientes cobrados en el ejercicio (` +
          `${advancesCollected.map((a) => `${a.code}: ${a.amount}`).join(', ')}) no están en los ingresos ` +
          `nominales, y LISR art. 17 fr. I los acumula al cobrarse. Súmalos sin IVA al declarar, menos los ya facturados.` });
    }

    const { accounts: withholdingAccounts, entryIds: withholdingEntryIds } = await withheldInRange(
      client, entityId, [...withRole('isr_retenido_a_favor')], from, through);
    const withheld = withholdingAccounts.reduce((acc, b) => acc.plus(b.amount), new Decimal(0));

    const figures: ProvisionalIncomeTaxFigures = {
      nominalIncome: nominalIncome.toFixed(4),
      profitCoefficient: coefficient?.value ?? '0',
      ptuDeductible: ptuDeductibleIn(month, ptuPaid).toFixed(4),
      pendingLosses: losses ? applyUpdateFactor(losses.value, losses.factor).toFixed(4) : '0.0000',
      rate: rate?.value ?? '0',
      priorProvisionalPayments: prior,
      withheldIncomeTax: withheld.toFixed(4),
    };
    const blockedBy = [...new Set(findings.filter((h) => h.severidad === 'bloqueante').map((h) => h.codigo))];
    return {
      period: { year, month, from, through },
      rounding: { key: FILING_ROUNDING_POLICY, value: rounding, defined: roundingPolicy.defined },
      coefficient,
      losses,
      rate,
      incomeAccounts: incomeAccounts.map((b) => ({ code: b.code, name: b.name, amount: b.amount.toFixed(4) })),
      salesReturns: {
        treatment,
        accounts: returns.map((b) => ({ code: b.code, name: b.name, amount: b.amount.toFixed(4) })),
      },
      advancesCollected,
      withholdingAccounts: withholdingAccounts.map((b) => ({ ...b, amount: b.amount.toFixed(4) })),
      withholdingEntryIds,
      incomeTraceAccounts,
      figures,
      settlement: blockedBy.length > 0 ? null : settleProvisionalIncomeTax(figures, rounding),
      blockedBy,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}

/**
 * The ISR withheld to the entity between two dates, per account. Read per
 * entry (see the header): what an entry nets to on the role accounts counts
 * when it is a withholding, is taken back by its reversal mirror or by an
 * unapplied collection, and is ignored when it is the opening balance or
 * applies the withholding against a tax.
 */
async function withheldInRange(
  client: pg.PoolClient,
  entityId: string,
  accountIds: string[],
  from: string,
  through: string
): Promise<{ accounts: Array<{ code: string; amount: Decimal }>; entryIds: string[] }> {
  if (accountIds.length === 0) return { accounts: [], entryIds: [] };
  const { rows } = await client.query<{
    entry_id: string; source_type: string | null; reverses_entry_id: string | null; code: string; net: string;
  }>(
    `SELECT je.id AS entry_id, je.source_type, je.reverses_entry_id, a.code,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS net
       FROM journal_entries je
       JOIN journal_entry_lines l ON l.journal_entry_id = je.id
       JOIN accounts a ON a.id = l.account_id
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND je.entry_date >= $2::date AND je.entry_date <= $3::date
        AND l.account_id = ANY($4::uuid[])
        ${predicadoSinCierre()}
      GROUP BY je.id, je.source_type, je.reverses_entry_id, a.code
      ORDER BY a.code`,
    [entityId, from, through, accountIds]
  );
  const entryNet = new Map<string, Decimal>();
  const entry = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    entryNet.set(r.entry_id, (entryNet.get(r.entry_id) ?? new Decimal(0)).plus(r.net));
    entry.set(r.entry_id, r);
  }
  const withholds = (e: (typeof rows)[number] | undefined): boolean =>
    e !== undefined && e.source_type !== 'opening_balance' && e.reverses_entry_id === null &&
    (entryNet.get(e.entry_id) as Decimal).greaterThan(0);
  const byAccount = new Map<string, Decimal>();
  const counted = new Set<string>();
  for (const r of rows) {
    const counts = withholds(r) || r.source_type === 'receipt_unapplication' ||
      (r.reverses_entry_id !== null && withholds(entry.get(r.reverses_entry_id)));
    if (counts) {
      byAccount.set(r.code, (byAccount.get(r.code) ?? new Decimal(0)).plus(r.net));
      counted.add(r.entry_id);
    }
  }
  return {
    accounts: [...byAccount].filter(([, amount]) => !amount.isZero()).map(([code, amount]) => ({ code, amount })),
    entryIds: [...counted],
  };
}
