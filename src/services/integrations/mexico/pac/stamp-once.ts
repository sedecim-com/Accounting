import { CFDI_STATUSES } from '../../../../database/enums.js';

export type CfdiStatus = (typeof CFDI_STATUSES)[number];

/**
 * CONTRACT: a document that holds a CFDI is not stamped again. One rule for
 * both doors that stamp: the payroll CFDI (MNE-001-736, #601) and the income
 * CFDI of an invoice (MNE-001-763, #696). A second stamp is a second CFDI
 * before the SAT for the same payment or sale, and it took the first UUID off
 * the row, the only place that remembered it.
 *
 * `stamped` holds one. The other three do not: no status and `pending` are
 * «not yet»; `failed` is how the UUID a simulated adapter made up is stored
 * (simulacion.ts), and the SAT never saw it; a `cancelled` CFDI is replaced by
 * a new one.
 *
 * A record with every status on purpose: one added to CFDI_STATUSES does not
 * compile until someone decides it here. A value this code does not know is
 * refused: it is not known to be free (`paychecks.cfdi_status` has no CHECK).
 */
const HOLDS_A_CFDI: Record<CfdiStatus, boolean> = {
  pending: false,
  stamped: true,
  cancelled: false,
  failed: false,
};

/** The statuses a stamp may write over, for the state predicate of its UPDATE. */
export const FREE_TO_STAMP: readonly CfdiStatus[] = CFDI_STATUSES.filter((status) => !HOLDS_A_CFDI[status]);

export function cfdiIsFreeToStamp(status: string | null): boolean {
  return status === null || (FREE_TO_STAMP as readonly string[]).includes(status);
}
