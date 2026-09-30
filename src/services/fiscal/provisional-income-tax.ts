import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { entityScope } from '../../database/scope.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';
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
//   − tax losses pending amortization, updated by INPC (art. 57), never
//     more than what is left of the profit
//   = taxable base
//   × corporate rate (legal_parameters, in force at the end of the month)
//   − provisional payments already made this year
//   − ISR withheld to the entity (role isr_retenido_a_favor, debits)
//   = the payment, never negative: an excess is not refunded by a
//     provisional payment, it waits for the annual return.
//
// NOMINAL INCOME is the revenue accounts' credits minus debits, closing
// entries excluded whatever the panel says (a tax figure, not a
// presentation). The inflation adjustment is not in the ledger, so nothing
// has to be taken out of it.
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
  const whole = chain(f, roundToWhole);
  const lines = cents.map(([key, c], i) => ({ key, cents: c.toFixed(2), whole: whole[i][1].toFixed(0) }));
  const payableCents = cents[cents.length - 1][1];
  const resultWhole = rounding === 'cada_renglon' ? whole[whole.length - 1][1] : roundToWhole(payableCents);
  return { lines, resultCents: payableCents.toFixed(2), resultWhole: resultWhole.toFixed(0) };
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
  withholdingAccounts: Array<{ code: string; amount: string }>;
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

    const lossInput = await incomeTaxInputForPayment(scope, 'pending_tax_losses', payment, {}, client);
    let losses: ProvisionalIncomeTaxWorkpaper['losses'] = null;
    if (lossInput) {
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
    const incomeAccounts = balance
      .filter((b) => b.account_type === 'revenue')
      .map((b) => ({ code: b.account_code, name: b.account_name, amount: new Decimal(b.credit_total).minus(b.debit_total) }))
      .filter((b) => !b.amount.isZero());
    const nominalIncome = incomeAccounts.reduce((acc, b) => acc.plus(b.amount), new Decimal(0));

    const { rows: withholdingRoles } = await client.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM account_roles
        WHERE tenant_id = $1 AND entity_id = $2 AND role = 'isr_retenido_a_favor'`,
      [tenantId, entityId]
    );
    const roleIds = new Set(withholdingRoles.map((r) => r.account_id));
    // Debits only: the entry that credits the withholding against a payment
    // would otherwise cancel what was withheld.
    const withholdingAccounts = balance
      .filter((b) => roleIds.has(b.account_id) && !new Decimal(b.debit_total).isZero())
      .map((b) => ({ code: b.account_code, amount: new Decimal(b.debit_total) }));
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
      incomeAccounts: incomeAccounts.map((b) => ({ ...b, amount: b.amount.toFixed(4) })),
      withholdingAccounts: withholdingAccounts.map((b) => ({ ...b, amount: b.amount.toFixed(4) })),
      figures,
      settlement: blockedBy.length > 0 ? null : settleProvisionalIncomeTax(figures, rounding),
      blockedBy,
      findings,
    };
  };
  return opts.client ? run(opts.client) : withTransaction(run);
}
