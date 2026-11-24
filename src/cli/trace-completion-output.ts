import { t } from '../i18n/index.js';
import { render } from './kernel/index.js';
import type { Palette } from './palette.js';
import type { TraceCompletion, TraceField } from '../services/payments/payment-trace-service.js';
import { untracedPaymentFinding } from '../services/sat/anexo24/untraced-payment-finding.js';

// ============================================================
// What `payment trace record` and `receipt trace record` say once the
// service answered (#612). One rendering for both leaves, so the two sides
// of a payment's trace report a completion in the same words.
//
// And what any command that writes a payment's trace says once it wrote
// (MNE-001-571): the finding `voucher generate` will make of its voucher,
// asked of the generator itself, never a list kept here by hand.
// ============================================================

/** The fields as the confirmation and the result list them: an account by its last four digits. */
export function listedTraceFields(fields: TraceField[]): string {
  return fields.map((f) => `${f.flag} ${f.shown}`).join(', ');
}

/** The result on stdout (or `--json`), then the period and archived-file lines on stderr. */
export function writeTraceCompletion(
  result: TraceCompletion,
  opts: { dryRun: boolean; json?: boolean; palette: Palette }
): void {
  const p = opts.palette;
  const fields = (fs: TraceField[]) => listedTraceFields(fs);
  if (opts.json) {
    const byColumn = (fs: TraceField[]) => Object.fromEntries(fs.map((f) => [f.column, f.shown]));
    render([{
      payment_number: result.paymentNumber, status: result.status,
      filled: byColumn(result.filled), unchanged: byColumn(result.unchanged),
      journal_entry: result.journalEntry, period: result.period, period_status: result.periodStatus,
      archived_voucher_files: result.archivedVoucherFiles, dry_run: opts.dryRun,
    }], { json: true });
  } else {
    if (result.filled.length > 0) {
      const line = opts.dryRun
        ? p.bold(t('payment.trace.would_complete', { number: result.paymentNumber, fields: fields(result.filled) }))
        : `${p.green('✔')} ${t('payment.trace.completed', { number: result.paymentNumber, fields: fields(result.filled) })}`;
      process.stdout.write(`${line}\n`);
    }
    if (result.unchanged.length > 0) {
      process.stdout.write(`${t('payment.trace.unchanged', { number: result.paymentNumber, fields: fields(result.unchanged) })}\n`);
    }
  }
  // A closed month is said, not refused: its file is asked for after the close.
  if (result.filled.length > 0 && result.periodStatus !== null && result.periodStatus !== 'open') {
    process.stderr.write(p.yellow(`${t('payment.trace.period_not_open', { period: result.period, status: result.periodStatus })}\n`));
  }
  if (result.filled.length > 0 && result.archivedVoucherFiles > 0) {
    process.stderr.write(p.yellow(`${t('payment.trace.archived_files', { count: result.archivedVoucherFiles, period: result.period })}\n`));
  }
  if (opts.dryRun) process.stderr.write(p.dim('Dry run: nothing was written.\n'));
}

/**
 * SAYS WHAT THE VOUCHER WILL LACK WHILE THE EVIDENCE IS STILL AT HAND.
 *
 * Not a gate: the payment already happened, and refusing to record it over a
 * datum of the vouchers file would leave the ledger without the movement.
 * But silence sends the gap to the close, months later, when nobody recalls
 * where the money went. The text is the generator's finding for that voucher,
 * motive and remedy, word for word. It goes to stderr and says nothing under
 * `--json`, which is a machine contract.
 */
export async function warnUntracedPayment(
  side: 'vendor' | 'customer',
  entityId: string,
  paymentId: string,
  opts: { json?: boolean; palette: Palette }
): Promise<void> {
  if (opts.json) return;
  const finding = await untracedPaymentFinding(entityId, side, paymentId);
  if (finding === null) return;
  process.stderr.write(
    opts.palette.yellow(
      `${t('payment.capture.untraced_voucher', { number: finding.paymentNumber, entry: finding.voucher })}\n${finding.detail}\n`
    )
  );
}
