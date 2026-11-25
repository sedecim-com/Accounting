import type { PoolClient } from 'pg';
import { findLegalParameterAt } from '../../jurisdiction/legal-parameters.js';
import { taxParameterValuesSince } from '../tax-engine/tax-tables.js';
import { MINIMUM_WAGE_PARAMETER_OF } from './minimum-wage-zone.js';
import { EMPLOYMENT_SUBSIDY_LAW } from './isr-calculator.js';

// ============================================================
// THE PARAMETERS THAT TAKE A NEW VALUE ON A KNOWN DAY (MNE-001-636 · #953)
//
// A dated lookup answers with the last row in force, so a value nobody loaded
// lets the previous one rule in silence (docs/RUNBOOK.md, the semester
// renewal of the normative corpus, step 4). For the parameters below the day
// their new value is due is known, and a run paid after it, with no row from
// that day, says which value it uses and since when. It changes no amount and
// stops nothing: whether the old value is wrong is the publication's to say.
//
// WHERE EACH DAY COMES FROM, and only from what the repository holds:
//   · The minimum wages, 1 January: the CONASAMI resolution of each year is
//     «in force since 1 January» (legal-parameters-seed.ts, DOF 09-12-2025),
//     and the Mexican payroll study of 6 September 2026 says so in its M17.
//     The corpus does not hold the LFT article that fixes the day
//     (art. 570). A mid-year extraordinary decree, as in 2016, has no due day
//     and is not caught here.
//   · The UMA, 1 February: art. 5 of the law that sets the value of the UMA
//     (LDVUMA), cited with its URL in the 2026 UMA row of
//     legal-parameters-seed.ts.
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
}

// The warning's words are painted at the edge (pay-run-command.ts), by key:
// no service imports the language (src/plan/criteria/e4-2.ts).
export const MX_ANNUAL_PARAMETERS: readonly AnnualParameter[] = [
  { table: 'tax_parameters', key: MINIMUM_WAGE_PARAMETER_OF.general, dueEachYear: '01-01' },
  { table: 'tax_parameters', key: MINIMUM_WAGE_PARAMETER_OF.northern_border, dueEachYear: '01-01' },
  { table: 'tax_parameters', key: 'uma_daily', dueEachYear: '02-01' },
  { table: 'legal_parameters', key: EMPLOYMENT_SUBSIDY_LAW.umaMonthly, dueEachYear: '02-01' },
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
