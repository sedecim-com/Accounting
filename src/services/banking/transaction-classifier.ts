import type Decimal from 'decimal.js';
import { normalizarEncabezado } from './parsers/texto.js';

// ============================================================
// WHAT KIND OF LINE A BANK LINE IS (MNE-001-040, #95)
//
// `bank fee post` reads `transaction_type = 'fee'` and `bank interest post`
// reads `transaction_type = 'interest'`. Until this module, no native bank
// format could produce either value: the importer fell back to the sign, so
// «COMISION MANEJO DE CUENTA -348.00» landed as 'debit' and both posting
// engines ran over zero rows and exited 0.
//
// ONE CLASSIFIER FOR EVERY FORMAT. CSV, MT940 and camt.053 all end up here
// through `tipoDeMovimiento`, so the rule is written once and the three
// formats cannot drift apart.
//
// THE SIGN IS A GUARD, NOT A HINT. A fee takes money out; an interest line
// puts money in. The posting engines already skip the opposite sign
// (treasury-posting.ts, «signo-contrario»), and the classifier refuses it up
// front for the same reasons: «DEVOLUCION COMISION +348.00» is a refund, not an
// expense, and «RETENCION ISR INTERESES -12.00» is a withholding, not income.
// Both keep their sign-derived type and a person can still move them with
// `bank transaction reclassify`.
//
// A VAT LINE IS NOT A FEE. Mexican banks often post the VAT of a fee on its own
// line («IVA COMISION MANEJO DE CUENTA -55.68»). Classifying it as 'fee' would
// make `bank fee post` split VAT out of VAT. It stays 'debit' until the release
// of the fee's VAT (MNE-001-041) decides how that line is treated.
// ============================================================

export type BankLineKind = 'fee' | 'interest';

/**
 * Bank type codes that name a fee or an interest line.
 *
 * MT940 `:61:` carries a type identification code of one letter (N, F or S)
 * plus three characters; the three characters are the SWIFT code (CHG =
 * charges, COM = commission, INT = interest). camt.053 carries the ISO 20022
 * bank transaction code as `Domain/Family/SubFamily`; the sub-family is what
 * names the charge (CHRG, COMM, FEES) or the interest (INTR).
 */
const FEE_CODES = new Set(['CHG', 'COM', 'CHRG', 'COMM', 'FEES']);
const INTEREST_CODES = new Set(['INT', 'INTR']);

/** Words, already normalized by `normalizarEncabezado` (lower case, no accents). */
const FEE_WORDS = /\bcomision(es)?\b/;
const INTEREST_WORDS = /\binteres(es)?\b/;
/** «IVA» and «I.V.A.», which normalizes to «i v a». */
const VAT_WORDS = /\b(iva|i v a)\b/;

function kindFromCode(code: string | undefined): BankLineKind | null {
  if (!code) return null;
  const raw = code.trim().toUpperCase();
  // MT940: N/F/S + three characters.
  const mt940 = /^[NFS]([A-Z0-9]{3})$/.exec(raw);
  const parts = mt940 ? [mt940[1]] : raw.split('/');
  // camt.053: the most specific part is the last one (the sub-family).
  const last = parts[parts.length - 1];
  if (FEE_CODES.has(last)) return 'fee';
  if (INTEREST_CODES.has(last)) return 'interest';
  return null;
}

function kindFromDescription(description: string | undefined): BankLineKind | null {
  if (!description) return null;
  const text = normalizarEncabezado(description);
  if (VAT_WORDS.test(text)) return null;
  if (FEE_WORDS.test(text)) return 'fee';
  if (INTEREST_WORDS.test(text)) return 'interest';
  return null;
}

/**
 * 'fee' or 'interest' when the bank code or the description says so AND the
 * sign agrees; `null` otherwise, so the caller falls back to the sign.
 *
 * The bank code wins over the description: it is the bank's own statement of
 * what the line is, while the description is free text.
 */
export function classifyBankLine(
  amount: Decimal,
  bankCode?: string,
  description?: string
): BankLineKind | null {
  const kind = kindFromCode(bankCode) ?? kindFromDescription(description);
  if (kind === 'fee' && amount.isNegative()) return 'fee';
  if (kind === 'interest' && amount.isPositive() && !amount.isZero()) return 'interest';
  return null;
}
