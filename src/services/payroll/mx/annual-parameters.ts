import type { PoolClient } from 'pg';
import { findLegalParameterAt } from '../../jurisdiction/legal-parameters.js';
import { taxParameterValuesSince } from '../tax-engine/tax-tables.js';
import { MINIMUM_WAGE_PARAMETER_OF } from './minimum-wage-zone.js';
import { EMPLOYMENT_SUBSIDY_LAW } from './isr-calculator.js';
import { t, type TranslationKey } from '../../../i18n/index.js';

// ============================================================
// THE PARAMETERS THAT TAKE A NEW VALUE ON A KNOWN DAY (MNE-001-636 · #953)
//
// A dated lookup answers with the last row in force, so a value nobody loaded
// lets the previous one rule in silence (docs/RUNBOOK.md, «Renovación
// semestral del corpus normativo», step 4). For the parameters below the day
// their new value is due is known, and a run paid after it, with no row from
// that day, says which value it uses and since when. It changes no amount and
// stops nothing: whether the old value is wrong is the publication's to say.
//
// WHERE EACH DAY COMES FROM, and only from what the repository holds:
//   · The minimum wages, 1 January: the CONASAMI resolution of each year is
//     «in force since 1 January» (legal-parameters-seed.ts, DOF 09-12-2025),
//     and docs/investigacion/2026-09-06-normas-y-motores/motores/nomina-mx.md
//     M17 says so. The corpus does not hold the LFT article that fixes the day
//     (art. 570). A mid-year extraordinary decree, as in 2016, has no due day
//     and is not caught here.
//   · The UMA, 1 February: art. 5 of the Ley para Determinar el Valor de la
//     UMA, cited with its URL in the 2026 UMA row of legal-parameters-seed.ts.
//
// Left out on purpose: the employment subsidy rate and cap (by decree, on no
// fixed day), the ISR tariff (looked up by its year label, and it already
// fails closed), the old-age table (loaded through 2030), and the art. 93 caps
// and LFT minimums (statutory, not yearly).
// ============================================================

/** One parameter with a yearly due day, in the table the payroll reads it from. */
export interface AnnualParameter {
  table: 'tax_parameters' | 'legal_parameters';
  /** Its key in that table: a `params` member, or a `legal_parameters.key`. */
  key: string;
  /** 'MM-DD': the day each year its new value is due. */
  dueEachYear: string;
  /** The catalogue key of its name. */
  labelKey: TranslationKey;
}

export const MX_ANNUAL_PARAMETERS: readonly AnnualParameter[] = [
  { table: 'tax_parameters', key: MINIMUM_WAGE_PARAMETER_OF.general, dueEachYear: '01-01',
    labelKey: 'payroll.parameter.minimum_wage_general' },
  { table: 'tax_parameters', key: MINIMUM_WAGE_PARAMETER_OF.northern_border, dueEachYear: '01-01',
    labelKey: 'payroll.parameter.minimum_wage_border' },
  { table: 'tax_parameters', key: 'uma_daily', dueEachYear: '02-01', labelKey: 'payroll.parameter.uma_daily' },
  { table: 'legal_parameters', key: EMPLOYMENT_SUBSIDY_LAW.umaMonthly, dueEachYear: '02-01',
    labelKey: 'payroll.parameter.uma_monthly' },
];

/** A parameter whose value in force on the pay date predates the day its new one was due. */
export interface StaleAnnualParameter {
  table: AnnualParameter['table'];
  key: string;
  /** The value in force on the pay date, as stored. */
  value: string;
  /** 'YYYY-MM-DD': since when that value rules. */
  since: string;
  /** 'YYYY-MM-DD': the due day it has not met. */
  dueFrom: string;
  payDate: string;
}

/** The last `MM-DD` on or before `onDate` ('YYYY-MM-DD'). */
export function lastDueOnOrBefore(dueEachYear: string, onDate: string): string {
  const year = Number(onDate.slice(0, 4));
  return onDate.slice(5) >= dueEachYear ? `${year}-${dueEachYear}` : `${year - 1}-${dueEachYear}`;
}

/**
 * The parameters of `MX_ANNUAL_PARAMETERS` that, on the pay date, still hold a
 * value in force since before their last due day: their new row is not loaded.
 *
 * Two statements whatever the number of paychecks: one over `tax_parameters`
 * for its keys, one `findLegalParameterAt` for the monthly UMA. A parameter
 * with no row in force is not reported here: the paycheck that needs it
 * already failed closed.
 */
export async function staleAnnualParameters(payDate: string, client?: PoolClient): Promise<StaleAnnualParameter[]> {
  const fromTaxParameters = MX_ANNUAL_PARAMETERS.filter((p) => p.table === 'tax_parameters');
  const inForce = new Map(
    (await taxParameterValuesSince('MX', fromTaxParameters.map((p) => p.key), payDate, client)).map((r) => [r.key, r])
  );
  const stale: StaleAnnualParameter[] = [];
  for (const p of MX_ANNUAL_PARAMETERS) {
    let found: { value: string; since: string } | undefined;
    if (p.table === 'tax_parameters') {
      found = inForce.get(p.key);
    } else {
      const row = await findLegalParameterAt('MX', p.key, payDate, client);
      found = row?.value == null ? undefined : { value: row.value, since: row.effectiveFrom };
    }
    if (!found) continue;
    const dueFrom = lastDueOnOrBefore(p.dueEachYear, payDate);
    if (found.since < dueFrom) {
      stale.push({ table: p.table, key: p.key, value: found.value, since: found.since, dueFrom, payDate });
    }
  }
  return stale;
}

/** The warning, by catalogue key, in the language of the caller. */
export function staleParameterText(s: StaleAnnualParameter): string {
  const p = MX_ANNUAL_PARAMETERS.find((x) => x.table === s.table && x.key === s.key);
  return t('payrun.calculate.stale_parameter', {
    parameter: p ? t(p.labelKey) : s.key,
    value: s.value,
    since: s.since,
    due: s.dueFrom,
    pay_date: s.payDate,
  });
}
