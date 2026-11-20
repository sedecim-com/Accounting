import { traceOfOnePayment } from './polizas-service.js';
import { polizaConDineroSinRastro } from './polizas-invariantes.js';

// ============================================================
// MNE-001-571 (#612) · THE FINDING ONE PAYMENT'S VOUCHER WILL CARRY.
//
// What `payment create`, `receipt record` and the `trace record` leaves warn
// after writing is the `poliza-con-dinero-sin-rastro` finding of that
// voucher, in the invariant's own words (motive and remedy). Built from the
// generator's `rastroDePago` and the invariant itself, never from a list of
// its own, so the warning and the file cannot disagree about what is missing
// or how to complete it.
// ============================================================

/** The finding, or null when the payment's node goes out (or the entity files no Anexo 24). */
export async function untracedPaymentFinding(
  entityId: string,
  side: 'vendor' | 'customer',
  paymentId: string
): Promise<{ voucher: string; paymentNumber: string; detail: string } | null> {
  const trace = await traceOfOnePayment(entityId, side, paymentId);
  if (trace === null || trace.traced) return null;
  const [finding] = polizaConDineroSinRastro([{ numUnIdenPol: trace.voucher, motivo: trace.motive, ...trace.causes }]);
  return finding === undefined ? null : { voucher: trace.voucher, paymentNumber: trace.paymentNumber, detail: finding.detalle };
}
