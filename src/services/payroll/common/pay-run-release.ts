import type { PAY_RUN_STATUSES } from '../../../database/enums.js';

export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

/**
 * CONTRACT: a paycheck leaves the system (as a payroll CFDI, or inside a
 * deposit file) only when its run is approved or paid (MNE-001-720, #601).
 *
 * Approval is the act that seals a run: from then on it is not calculated
 * again, so the figures of its paychecks stop moving. Before it a paycheck is
 * a figure the next calculation replaces, and neither a stamp nor a bank
 * instruction is taken back from here.
 *
 * The caller reads the status in the statement that already reads the run and
 * needs no lock: a run leaves `approved` only for `paid`, and `paid` for
 * nothing. Whoever writes a way back (a void) has to revisit that.
 *
 * A switch with no default on purpose: a status added to PAY_RUN_STATUSES does
 * not compile until someone decides it here. A value this code does not know
 * (a row written by a later schema) is refused.
 */
export function runIsReleased(status: PayRunStatus): boolean {
  switch (status) {
    case 'approved':
    case 'paid':
      return true;
    case 'draft':
    case 'calculating':
    case 'calculated':
    case 'voided':
      return false;
  }
  const unknown: never = status;
  void unknown;
  return false;
}
