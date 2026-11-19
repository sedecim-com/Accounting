import Decimal from 'decimal.js';
import type pg from 'pg';
import { getPolicy } from '../../policy/policy-service.js';
import { AccountingError } from '../../../utils/errors.js';

// ============================================================
// MX · THE SBC BAND OF THE EMPLOYER OLD-AGE QUOTA (#661, MNE-001-513)
//
// LSS art. 168 fr. II a) charges the employer quota for cesantía en edad
// avanzada y vejez by the band the worker's SBC falls in. The rates are law
// and live in `legal_parameters`, one key per band and one row per year
// (migration 330). This module holds the band edges, which no year changes,
// and the one thing the table leaves open: it writes its edges to two
// decimals («3.00 UMA», then «3.01 UMA») with no rounding rule, so an SBC of
// 3.0006 UMA is in neither. That is not chosen here: it is the policy
// `imss_old_age_band_edge` (AGENTS.md invariant 6).
//
//   · above_upper_edge (default): an SBC above a band's upper edge, by any
//     amount, pays the next band. Compared in pesos, never on a rounded ratio.
//   · truncated_to_hundredths: SBC ÷ minimum wage and SBC ÷ UMA are cut to
//     two decimals and then placed, which reads «3.01» literally.
//
// «SM» is the general minimum wage (ZSMG) for every entity until #196 stores
// the employer's zone: a border registration is not told apart yet.
// ============================================================

/** The policy that decides the band edge. Its values are persisted: never rename them. */
export const OLD_AGE_BAND_EDGE_POLICY = 'imss_old_age_band_edge';

export type OldAgeBandEdge = 'above_upper_edge' | 'truncated_to_hundredths';

const KNOWN_EDGES: readonly OldAgeBandEdge[] = ['above_upper_edge', 'truncated_to_hundredths'];

/** The prefix of the eight `legal_parameters` keys migration 330 loaded. */
export const OLD_AGE_EMPLOYER_RATE_PREFIX = 'imss.old_age.employer_rate.';

export interface OldAgeBand {
  /** Key suffix under `OLD_AGE_EMPLOYER_RATE_PREFIX`, named by the band's upper edge. */
  suffix: string;
  /** The band as the law writes it, for the calculation notes. */
  asPrinted: string;
}

const MINIMUM_WAGE_BAND: OldAgeBand = { suffix: 'sm_1_00', asPrinted: '1.00 SM' };
const TOP_BAND: OldAgeBand = { suffix: 'uma_above_4_00', asPrinted: '4.01 UMA en adelante' };
/** The six bands with an upper edge in UMA, lowest first. */
const UMA_BANDS: readonly (OldAgeBand & { upper: string })[] = [
  { upper: '1.50', suffix: 'uma_1_50', asPrinted: '1.01 SM a 1.50 UMA' },
  { upper: '2.00', suffix: 'uma_2_00', asPrinted: '1.51 a 2.00 UMA' },
  { upper: '2.50', suffix: 'uma_2_50', asPrinted: '2.01 a 2.50 UMA' },
  { upper: '3.00', suffix: 'uma_3_00', asPrinted: '2.51 a 3.00 UMA' },
  { upper: '3.50', suffix: 'uma_3_50', asPrinted: '3.01 a 3.50 UMA' },
  { upper: '4.00', suffix: 'uma_4_00', asPrinted: '3.51 a 4.00 UMA' },
];

/**
 * The band of one contribution day.
 *
 * @param sbc the daily SBC already capped at 25 UMA.
 * @param uma, minimumWage the daily figures in force that day.
 */
export function placeOldAgeBand(args: {
  sbc: Decimal.Value;
  uma: Decimal.Value;
  minimumWage: Decimal.Value;
  edge: OldAgeBandEdge;
}): OldAgeBand {
  const sbc = new Decimal(args.sbc);
  const truncated = args.edge === 'truncated_to_hundredths';
  // Is the SBC at most `times` units (minimum wages or UMA)?
  const within = (unit: Decimal.Value, times: string): boolean =>
    truncated
      ? sbc.dividedBy(unit).toDecimalPlaces(2, Decimal.ROUND_DOWN).lte(times)
      : sbc.lte(new Decimal(unit).times(times));
  if (within(args.minimumWage, '1.00')) return MINIMUM_WAGE_BAND;
  return UMA_BANDS.find((band) => within(args.uma, band.upper)) ?? TOP_BAND;
}

/** Reads the edge rule of the entity. Closed on declaring, like `readEmploymentSubsidyRounding`. */
export async function readOldAgeBandEdge(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<OldAgeBandEdge> {
  const policy = await getPolicy(ctx, OLD_AGE_BAND_EDGE_POLICY, client);
  const value = KNOWN_EDGES.find((edge) => edge === policy.value);
  if (!value) {
    throw new AccountingError(
      'IMSS_OLD_AGE_BAND_EDGE_UNKNOWN',
      `The policy ${OLD_AGE_BAND_EDGE_POLICY} is "${policy.value}" and this reader only knows ` +
        `${KNOWN_EDGES.join(', ')}. Correct it in mnemosine pending.`
    );
  }
  return value;
}
