import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { findByIdInScope, requireByIdInScope, type Scope } from '../../database/scope.js';
import type { BankTransaction } from '../../types/index.js';

// ============================================================
// MATCHING ALGORITHM (4-Tier Rule System from Spec)
// ============================================================

interface Matchable {
  id: string;
  type: 'invoice' | 'bill' | 'customer_payment' | 'vendor_payment' | 'journal_entry_line';
  amount: string;
  date: Date;
  description: string;
  customer_name?: string;
  vendor_name?: string;
}

interface MatchResult {
  match_id: string;
  match_type: string;
  confidence: number;
  matched_amount: string;
}

interface MatchRule {
  priority: number;
  name: string;
  match: (tx: BankTransaction, candidates: Matchable[]) => MatchResult | null;
}

// ============================================================
// STRING SIMILARITY UTILITIES
// ============================================================

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function normalizeDescription(desc: string): string {
  return (desc || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
}

function extractKeywords(desc: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'payment', 'transfer', 'deposit', 'debit', 'credit', 'ref', 'no',
  ]);

  const normalized = normalizeDescription(desc);
  const words = normalized.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function descriptionSimilarity(desc1: string, desc2: string): number {
  const norm1 = normalizeDescription(desc1);
  const norm2 = normalizeDescription(desc2);

  if (norm1 === norm2) return 1.0;
  if (!norm1 || !norm2) return 0;

  // Levenshtein-based similarity
  const maxLen = Math.max(norm1.length, norm2.length);
  const levSimilarity = 1 - levenshteinDistance(norm1, norm2) / maxLen;

  // Jaccard keyword similarity
  const keywords1 = extractKeywords(desc1);
  const keywords2 = extractKeywords(desc2);
  const jaccard = jaccardSimilarity(keywords1, keywords2);

  // Weighted combination
  return levSimilarity * 0.4 + jaccard * 0.6;
}

// ============================================================
// MATCHING RULES
// ============================================================

// Rule 1: Exact Amount + Exact Date (Confidence: 1.0)
const exactAmountDateRule: MatchRule = {
  priority: 1,
  name: 'exact_amount_date',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).toISOString().split('T')[0];

    const matches = candidates.filter((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).toISOString().split('T')[0];
      return cAmount.equals(txAmount) && cDate === txDate;
    });

    if (matches.length === 1) {
      return {
        match_id: matches[0].id,
        match_type: matches[0].type,
        confidence: 1.0,
        matched_amount: txAmount.toFixed(4),
      };
    }
    return null;
  },
};

// Rule 2: Exact Amount + Near Date (±3 days, Confidence: 0.90)
const exactAmountNearDateRule: MatchRule = {
  priority: 2,
  name: 'exact_amount_near_date',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).getTime();
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    const matches = candidates.filter((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).getTime();
      return cAmount.equals(txAmount) && Math.abs(txDate - cDate) <= threeDays;
    });

    if (matches.length === 1) {
      return {
        match_id: matches[0].id,
        match_type: matches[0].type,
        confidence: 0.90,
        matched_amount: txAmount.toFixed(4),
      };
    }
    return null; // Ambiguous if multiple
  },
};

// Rule 3: Fuzzy Description Matching (Confidence: variable, >0.70)
const fuzzyDescriptionRule: MatchRule = {
  priority: 3,
  name: 'fuzzy_description',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const amountTolerance = txAmount.times(0.05); // 5% tolerance

    const scored = candidates
      .filter((c) => {
        const cAmount = new Decimal(c.amount).abs();
        return cAmount.minus(txAmount).abs().lessThanOrEqualTo(amountTolerance);
      })
      .map((c) => {
        let similarity = 0;

        // Description similarity
        if (tx.description && c.description) {
          similarity = descriptionSimilarity(tx.description, c.description);
        }

        // Merchant name vs customer/vendor name boost
        if (tx.merchant_name) {
          if (c.customer_name) {
            const nameSim = descriptionSimilarity(tx.merchant_name, c.customer_name);
            similarity = Math.max(similarity, nameSim);
          }
          if (c.vendor_name) {
            const nameSim = descriptionSimilarity(tx.merchant_name, c.vendor_name);
            similarity = Math.max(similarity, nameSim);
          }
        }

        return { candidate: c, similarity };
      })
      .filter((s) => s.similarity > 0.70)
      .sort((a, b) => b.similarity - a.similarity);

    if (scored.length === 1 && scored[0].similarity > 0.85) {
      return {
        match_id: scored[0].candidate.id,
        match_type: scored[0].candidate.type,
        confidence: Math.round(scored[0].similarity * 100) / 100,
        matched_amount: txAmount.toFixed(4),
      };
    }
    return null;
  },
};

// Rule 4: ML-Based Prediction (Feature engineering + scoring)
const mlPredictionRule: MatchRule = {
  priority: 4,
  name: 'ml_prediction',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).getTime();

    const scored = candidates.map((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).getTime();

      // Feature engineering
      const amountDiff = cAmount.minus(txAmount).abs().dividedBy(Decimal.max(txAmount, '1')).toNumber();
      const dateDiff = Math.abs(txDate - cDate) / (24 * 60 * 60 * 1000); // days
      const descSim = tx.description && c.description
        ? descriptionSimilarity(tx.description, c.description)
        : 0;

      // Simple logistic-like scoring model (replace with trained model in production)
      const amountScore = Math.max(0, 1 - amountDiff * 10);
      const dateScore = Math.max(0, 1 - dateDiff / 30);
      const descScore = descSim;

      // Weighted combination
      const probability = amountScore * 0.45 + dateScore * 0.25 + descScore * 0.30;

      return { candidate: c, probability };
    })
      .filter((s) => s.probability > 0.75)
      .sort((a, b) => b.probability - a.probability);

    if (scored.length > 0) {
      return {
        match_id: scored[0].candidate.id,
        match_type: scored[0].candidate.type,
        confidence: Math.round(scored[0].probability * 100) / 100,
        matched_amount: txAmount.toFixed(4),
      };
    }
    return null;
  },
};

const MATCH_RULES: MatchRule[] = [
  exactAmountDateRule,
  exactAmountNearDateRule,
  fuzzyDescriptionRule,
  mlPredictionRule,
].sort((a, b) => a.priority - b.priority);

// ============================================================
// CANDIDATE COLLECTION
// ============================================================

async function getCandidates(
  bankAccountId: string,
  tx: BankTransaction,
  scope: Scope
): Promise<Matchable[]> {
  const txAmount = new Decimal(tx.amount).abs();
  const amountLow = txAmount.times(0.90).toFixed(4);
  const amountHigh = txAmount.times(1.10).toFixed(4);

  // LA CUENTA BANCARIA ES LA FRONTERA de todo este archivo.
  //
  // Ni bank_transactions ni reconciliation_matches tienen entity_id: cuelgan
  // de bank_account_id (migración 003). Así que el único punto donde se puede
  // acotar es aquí, y de aquí sale el entityId con el que se buscan los
  // candidatos. Antes esta lectura era `WHERE id = $1` a secas, de modo que
  // con el UUID de una cuenta ajena la función devolvía candidatos de la
  // víctima: SUS facturas, SUS gastos y SUS líneas de asiento.
  //
  // Cero filas significa a la vez «no existe» y «no es tuya», y las dos
  // devuelven la misma lista vacía.
  const cuenta = await findByIdInScope<{ entity_id: string }>(
    'bank_accounts',
    bankAccountId,
    scope,
    { columns: 'entity_id' }
  );
  if (!cuenta) return [];
  const entityId = cuenta.entity_id;

  const candidates: Matchable[] = [];

  // Unmatched invoices
  const invoices = await query<Matchable>(
    `SELECT id, 'invoice' as type, total_amount as amount, invoice_date as date,
            COALESCE(description, invoice_number) as description
     FROM invoices
     WHERE entity_id = $1 AND status IN ('sent', 'partially_paid', 'overdue')
       AND ABS(amount_due) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh]
  );
  candidates.push(...invoices.rows);

  // Unmatched bills
  const bills = await query<Matchable>(
    `SELECT id, 'bill' as type, total_amount as amount, bill_date as date,
            COALESCE(description, bill_number) as description
     FROM bills
     WHERE entity_id = $1 AND status IN ('approved', 'posted', 'partially_paid')
       AND ABS(amount_due) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh]
  );
  candidates.push(...bills.rows);

  // Unreconciled journal entry lines
  const jelEntries = await query<Matchable>(
    `SELECT jel.id, 'journal_entry_line' as type,
            COALESCE(jel.debit_amount, jel.credit_amount) as amount,
            je.entry_date as date,
            COALESCE(jel.description, je.description) as description
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.is_reconciled = false
       AND ABS(COALESCE(jel.debit_amount, jel.credit_amount)) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh]
  );
  candidates.push(...jelEntries.rows);

  return candidates;
}

// ============================================================
// MASTER MATCHING ENGINE
// ============================================================

export async function findBestMatch(
  bankAccountId: string,
  transaction: BankTransaction,
  scope: Scope
): Promise<MatchResult | null> {
  const candidates = await getCandidates(bankAccountId, transaction, scope);
  if (candidates.length === 0) return null;

  for (const rule of MATCH_RULES) {
    const result = rule.match(transaction, candidates);
    if (result) return result;
  }

  return null;
}

export interface AutoMatchOptions {
  /**
   * El alcance del llamador. OBLIGATORIO, y por eso está en el tipo: el único
   * llamador —POST /v1/bank-accounts/:account_id/auto-match— pasaba
   * `req.params.account_id` crudo y su ruta no lleva `requireEntityAccess`.
   * Con el campo en el tipo, un llamador sin alcance no compila.
   */
  scope: Scope;
}

export async function autoMatchUnreconciled(
  bankAccountId: string,
  opts: AutoMatchOptions
): Promise<{ matched: number; unmatched: number; results: Array<{ transaction_id: string; match: MatchResult | null }> }> {
  // Se exige la cuenta ANTES de tocar nada. getCandidates ya no cruzaría la
  // frontera —devolvería lista vacía—, pero eso daría un 200 con «0 conciliadas»
  // sobre una cuenta ajena, que sigue siendo un oráculo: distingue «no existe»
  // de «existe y está toda conciliada». Aquí las dos dan 404.
  await requireByIdInScope('bank_accounts', bankAccountId, opts.scope, { columns: 'id' });

  const unmatched = await query<BankTransaction>(
    `SELECT * FROM bank_transactions WHERE bank_account_id = $1 AND is_matched = false ORDER BY transaction_date`,
    [bankAccountId]
  );

  let matched = 0;
  const results: Array<{ transaction_id: string; match: MatchResult | null }> = [];

  for (const tx of unmatched.rows) {
    const result = await findBestMatch(bankAccountId, tx, opts.scope);
    results.push({ transaction_id: tx.id, match: result });

    if (result && result.confidence >= 0.85) {
      // Auto-match high confidence. El UPDATE lleva bank_account_id además del
      // id de la fila: la pertenencia de la cuenta ya está probada, así que
      // atarlo a ella deja la escritura acotada por construcción y no por que
      // el SELECT de arriba haya filtrado bien.
      await query(
        `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), confidence_score = $1
          WHERE id = $2 AND bank_account_id = $3`,
        [result.confidence, tx.id, bankAccountId]
      );

      await query(
        `INSERT INTO reconciliation_matches (
          id, bank_transaction_id, match_type, matched_entity_type,
          matched_entity_id, matched_amount, confidence_score
        ) VALUES (uuid_generate_v4(), $1, 'automatic', $2, $3, $4, $5)`,
        [tx.id, result.match_type, result.match_id, result.matched_amount, result.confidence]
      );

      matched++;
    }
  }

  return { matched, unmatched: unmatched.rows.length - matched, results };
}

export { descriptionSimilarity, jaccardSimilarity, extractKeywords, levenshteinDistance };
