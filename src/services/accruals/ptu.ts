import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import type { TranslationKey } from '../../i18n/index.js';
import { JournalEntryType } from '../../types/index.js';
import { NotFoundError, ValidationError, type KeyedText } from '../../utils/errors.js';
import { YEAR_END_PERIOD_NUMBER } from '../accounting/fiscal-calendar-service.js';
import { createJournalEntry } from '../accounting/posting.js';
import { LegalParameterUnavailableError, legalParameterAt } from '../jurisdiction/legal-parameters.js';
import { queryTrialBalanceRows } from '../reporting/report-service.js';

// ============================================================
// THE PTU OF THE YEAR, PROPOSED AT CLOSE — MNE-001-298 (#111, option (b))
//
// LFT art. 120 takes as the workers' profit the taxable income under the ISR
// law, and LISR art. 9's last two paragraphs say how it differs from the ISR
// base: neither the PTU paid in the year nor the pending tax losses are
// subtracted, and the non-deductible part of exempt pay (art. 28 fr. XXX) is
// taken off. The share is the National Commission's percentage (LFT art. 117),
// read from `legal_parameters` at 31 December; without that row this refuses.
//
// The three figures are the accountant's, each with its source, until the
// annual ISR working paper exists (MNE-001-850) and they are read from it
// with the same arithmetic. `ptuBase` takes no PTU paid and no losses, so the
// wrong bases cannot be computed here.
//
// The result is a DRAFT in period 13 against the PTU's expense and provision
// roles (below): the PTU less what the year already credited to the
// provision; a negative one reverses the excess. Nothing posts. The figures,
// their source, the rate row and the provisioned amount travel as
// `calculation_metadata` in the `tags` of the draft's lines, because
// `journal_entries` has no metadata column and option (b) adds no migration.
// One live entry per entity and year: the same figures again find it, other
// figures are refused until it is voided or reversed.
//
// The provision is GROSS of the art. 127 fr. VIII caps: those are per worker
// and only the distribution computes them (out of scope).
// ============================================================

export const PTU_SOURCE_TYPE = 'ptu_provision';
export const PTU_RATE_KEY = 'ptu.rate';
const ROLE_EXPENSE = 'ptu_gasto';
const ROLE_PROVISION = 'provision_ptu';
/** c_RegimenFiscal 601, the general regime of legal entities, whose art. 9 this is. */
const GENERAL_REGIME = '601';

/** The three figures of LISR art. 9, as four-decimal strings, and where they were read. */
export interface PtuFigures {
  accumulableIncome: string;
  authorizedDeductions: string;
  nonDeductibleExemptPay: string;
  source: string;
}

/** Taxable income for PTU: never less the PTU paid or the losses (LISR art. 9). */
export function ptuBase(f: PtuFigures): Decimal {
  return new Decimal(f.accumulableIncome).minus(f.authorizedDeductions).minus(f.nonDeductibleExemptPay);
}

/** The share at `rate`, to the cent half up; a loss of the year owes none. */
export function ptuForYear(base: Decimal.Value, rate: Decimal.Value): Decimal {
  const b = new Decimal(base);
  return b.isNegative() ? new Decimal(0) : b.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** What the close books: the PTU less what the year already provisioned. */
export function ptuAdjustment(ptu: Decimal.Value, provisioned: Decimal.Value): Decimal {
  return new Decimal(ptu).minus(provisioned).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export interface PtuCalculation {
  year: number;
  figures: { accumulable_income: string; authorized_deductions: string; non_deductible_exempt_pay: string; source: string };
  base: string;
  rate: { key: string; value: string; effective_from: string; source_url: string };
  ptu: string;
  provisioned: string;
  adjustment: string;
  provision_cap: 'gross';
}

export interface PtuProposal {
  outcome: 'proposed' | 'exists' | 'nothing_to_propose' | 'dry_run';
  calculation: PtuCalculation;
  entry: { id: string; number: string; status: string } | null;
  findings: Array<{ code: string; text: KeyedText }>;
}

const refuse = (key: TranslationKey, params?: Record<string, string | number>): ValidationError =>
  new ValidationError({ key, params });

const sameFigures = (a: PtuCalculation['figures'], b: PtuCalculation['figures']): boolean =>
  a.accumulable_income === b.accumulable_income &&
  a.authorized_deductions === b.authorized_deductions &&
  a.non_deductible_exempt_pay === b.non_deductible_exempt_pay;

/**
 * Proposes the year's PTU as a draft. Reads, all bounded by the entity: a
 * lock per entity and year, the entity with its period 13, the two roles, the
 * live entry of the year, then (only when none exists) the rate and the year's
 * trial balance through report-service. None per row.
 */
export async function proposePtuAtClose(
  scope: EntityScope,
  input: { year: number; figures: PtuFigures; userId: string; dryRun?: boolean }
): Promise<PtuProposal> {
  const { tenantId, entityId } = scope;
  const { year, figures } = input;
  const yearEnd = `${year}-12-31`;
  const captured: PtuCalculation['figures'] = {
    accumulable_income: figures.accumulableIncome,
    authorized_deductions: figures.authorizedDeductions,
    non_deductible_exempt_pay: figures.nonDeductibleExemptPay,
    source: figures.source,
  };

  return withTransaction(async (client: pg.PoolClient) => {
    // Two runs of the same year wait for each other instead of both drafting.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${PTU_SOURCE_TYPE}:${entityId}:${year}`]);
    const { rows: [entity] } = await client.query<{ tax_regime: string | null; period_id: string | null; earlier: boolean }>(
      `SELECT le.tax_regime,
              (SELECT fp.id FROM fiscal_periods fp
                WHERE fp.entity_id = le.id AND fp.period_number = $3 AND fp.end_date = $4::date
                  AND fp.status NOT IN ('hard_close', 'locked')) AS period_id,
              EXISTS (SELECT 1 FROM fiscal_periods fp WHERE fp.entity_id = le.id AND fp.end_date < $5::date) AS earlier
         FROM legal_entities le WHERE le.id = $1 AND le.tenant_id = $2`,
      [entityId, tenantId, YEAR_END_PERIOD_NUMBER, yearEnd, `${year}-01-01`]
    );
    if (!entity) throw new NotFoundError('Legal entity', entityId);
    if (entity.tax_regime !== null && entity.tax_regime !== GENERAL_REGIME) throw refuse('error.VALIDATION_ERROR.ptu.regime', { regime: entity.tax_regime });
    if (!entity.period_id) throw refuse('error.VALIDATION_ERROR.ptu.no_adjustment_period', { year });
    const periodId = entity.period_id;
    const findings: PtuProposal['findings'] = [];
    if (entity.tax_regime === null) findings.push({ code: 'PTU-REGIME-UNDECLARED', text: { key: 'ptu.finding.regime_undeclared' } });
    if (!entity.earlier) findings.push({ code: 'PTU-FIRST-YEAR', text: { key: 'ptu.finding.first_year', params: { year } } });

    const { rows: roleRows } = await client.query<{ role: string; account_id: string }>(
      `SELECT role, account_id FROM account_roles
        WHERE entity_id = $1 AND tenant_id = $2 AND role = ANY($3) AND qualifier IS NULL`,
      [entityId, tenantId, [ROLE_EXPENSE, ROLE_PROVISION]]
    );
    const roles = new Map(roleRows.map((r) => [r.role, r.account_id]));
    const missing = [ROLE_EXPENSE, ROLE_PROVISION].filter((r) => !roles.has(r));
    if (missing.length > 0) throw refuse('error.VALIDATION_ERROR.ptu.roles_missing', { roles: missing.join(', ') });
    const expenseId = roles.get(ROLE_EXPENSE) as string;
    const provisionId = roles.get(ROLE_PROVISION) as string;

    const { rows: [live] } = await client.query<{ id: string; entry_number: string; status: string; metadata: PtuCalculation | null }>(
      `SELECT je.id, je.entry_number, je.status,
              (SELECT jel.tags->'calculation_metadata' FROM journal_entry_lines jel
                WHERE jel.journal_entry_id = je.id ORDER BY jel.line_number LIMIT 1) AS metadata
         FROM journal_entries je
        WHERE je.entity_id = $1 AND je.source_type = $2 AND je.source_id = $3
          AND je.status <> 'void' AND je.reversed_by_entry_id IS NULL AND NOT je.is_reversal
        ORDER BY je.created_at DESC LIMIT 1`,
      [entityId, PTU_SOURCE_TYPE, periodId]
    );
    if (live) {
      if (!live.metadata || !sameFigures(live.metadata.figures, captured)) {
        throw refuse(live.status === 'posted' ? 'error.VALIDATION_ERROR.ptu.other_figures_posted' : 'error.VALIDATION_ERROR.ptu.other_figures_draft', { entry: live.entry_number, year });
      }
      return { outcome: 'exists', calculation: live.metadata, entry: { id: live.id, number: live.entry_number, status: live.status }, findings };
    }

    let rate;
    try {
      rate = await legalParameterAt('MX', PTU_RATE_KEY, yearEnd, client);
    } catch (e) {
      if (e instanceof LegalParameterUnavailableError) throw refuse('error.VALIDATION_ERROR.ptu.rate_unavailable', { key: PTU_RATE_KEY, date: yearEnd, gap: e.gap });
      throw e;
    }

    const balance = await queryTrialBalanceRows(
      entityId, { sinceDate: `${year}-01-01`, untilDate: yearEnd, excludeClosingEntries: true }, client);
    const provisioned = new Decimal(balance.find((b) => b.account_id === provisionId)?.credit_total ?? 0);
    const base = ptuBase(figures);
    const ptu = ptuForYear(base, rate.value);
    const adjustment = ptuAdjustment(ptu, provisioned);
    const calculation: PtuCalculation = {
      year, figures: captured, base: base.toFixed(4),
      rate: { key: PTU_RATE_KEY, value: rate.value, effective_from: rate.effectiveFrom, source_url: rate.sourceUrl },
      ptu: ptu.toFixed(2), provisioned: provisioned.toFixed(4), adjustment: adjustment.toFixed(2), provision_cap: 'gross',
    };
    if (adjustment.isZero()) return { outcome: 'nothing_to_propose', calculation, entry: null, findings };
    if (input.dryRun) return { outcome: 'dry_run', calculation, entry: null, findings };

    const amount = adjustment.abs().toFixed(4);
    const [debitId, creditId] = adjustment.isPositive() ? [expenseId, provisionId] : [provisionId, expenseId];
    const tags = { calculation_metadata: calculation };
    const je = await createJournalEntry(
      entityId, yearEnd, JournalEntryType.ADJUSTING,
      `PTU of ${year} (LFT art. 120, LISR art. 9)`,
      [
        { account_id: debitId, debit_amount: amount, credit_amount: null, description: `PTU ${year}`, tags },
        { account_id: creditId, debit_amount: null, credit_amount: amount, description: `PTU ${year}`, tags },
      ],
      input.userId,
      { sourceType: PTU_SOURCE_TYPE, sourceId: periodId, fiscalPeriodId: periodId, reference: `PTU ${year}`, client }
    );
    return { outcome: 'proposed', calculation, entry: { id: je.id, number: je.entry_number, status: je.status }, findings };
  });
}
