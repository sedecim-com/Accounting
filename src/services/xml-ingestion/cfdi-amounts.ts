import Decimal from 'decimal.js';
import type { CFDIImpuesto } from './cfdi-parser.js';

// The amount helpers both doors of a CFDI share. They live apart from the
// pre-registration service so the receivables core (issued-invoice-approval.ts)
// can be imported by that service without closing a runtime cycle.

/** SAT tax keys arrive as numbers from the parser ("002" -> 2): normalize the width. */
export const satKey = (v: unknown): string => String(v ?? '').padStart(3, '0');

export const money = (v: unknown): Decimal => new Decimal((v as string | number | null) ?? 0).toDecimalPlaces(2);

export const sumTax = (list: CFDIImpuesto[] | undefined, key: string): Decimal =>
  (list ?? []).filter((t) => satKey(t.impuesto) === key).reduce((s, t) => s.plus(money(t.importe)), new Decimal(0));
