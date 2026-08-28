import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, NotImplementedError } from '../../../utils/errors.js';
import { autoMatchUnreconciled } from '../../../services/banking/matching.js';
import { entityScope } from '../../../database/scope.js';
import type { BankTransaction, ReconciliationSession } from '../../../types/index.js';

const router = Router();

// ─── Schemas ───
const bankTransactionSchema = z.object({
  bank_transaction_id: z.string().min(1),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  posted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  amount: z.union([z.string(), z.number()]),
  transaction_type: z.enum(['debit', 'credit']).optional(),
  description: z.string(),
  merchant_name: z.string().optional(),
  category: z.string().optional(),
  raw_data: z.record(z.unknown()).optional(),
}).passthrough();

const importTransactionsSchema = z.object({
  transactions: z.array(bankTransactionSchema).min(1),
  source: z.string().optional(),
  batch_id: z.string().optional(),
});

const matchTransactionSchema = z.object({
  matched_entity_type: z.enum(['invoice', 'bill', 'journal_entry', 'payment']),
  matched_entity_id: z.string().uuid(),
  matched_amount: z.union([z.string(), z.number()]).optional(),
});

const createReconciliationSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  ending_balance_per_bank: z.union([z.string(), z.number()]),
});

// POST /v1/bank-accounts/:account_id/import
router.post('/:account_id/import', requirePermission('journal_entries:create'), validateBody(importTransactionsSchema), asyncHandler(async (req: Request, res: Response) => {
  const { transactions } = req.body;

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const tx of transactions) {
    try {
      const existing = await query(
        `SELECT id FROM bank_transactions WHERE bank_account_id = $1 AND bank_transaction_id = $2`,
        [req.params.account_id, tx.bank_transaction_id]
      );

      if (existing.rows.length > 0) { skipped++; continue; }

      await query(
        `INSERT INTO bank_transactions (
          id, bank_account_id, bank_transaction_id, transaction_date, posted_date,
          amount, transaction_type, description, merchant_name, category, raw_data, import_batch_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          uuidv4(), req.params.account_id, tx.bank_transaction_id,
          tx.transaction_date, tx.posted_date || null,
          tx.amount, tx.transaction_type || 'debit',
          tx.description, tx.merchant_name || null, tx.category || null,
          tx.raw_data ? JSON.stringify(tx.raw_data) : null,
          req.body.batch_id || uuidv4(),
        ]
      );
      imported++;
    } catch (err) {
      errors.push(`Transaction ${tx.bank_transaction_id}: ${(err as Error).message}`);
    }
  }

  res.json({
    data: { imported, skipped, errors, batch_id: req.body.batch_id },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/bank-accounts/:account_id/transactions/unmatched
router.get('/:account_id/transactions/unmatched', requirePermission('journal_entries:read'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query<BankTransaction>(
    `SELECT * FROM bank_transactions
     WHERE bank_account_id = $1 AND is_matched = false
     ORDER BY transaction_date DESC`,
    [req.params.account_id]
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/bank-transactions/:id/match-suggestions
router.get('/transactions/:id/suggestions', requirePermission('journal_entries:read'), asyncHandler(async (req: Request, res: Response) => {
  const txResult = await query<BankTransaction>(
    'SELECT * FROM bank_transactions WHERE id = $1',
    [req.params.id]
  );

  if (txResult.rows.length === 0) throw new NotFoundError('Bank Transaction', req.params.id);

  const tx = txResult.rows[0];
  const amount = new Decimal(tx.amount).abs();
  const tolerance = amount.times(0.01); // 1% tolerance

  // Find matching invoices
  const invoiceMatches = await query(
    `SELECT 'invoice' as type, id, invoice_number as reference, total_amount as amount, invoice_date as date
     FROM invoices
     WHERE entity_id = (SELECT entity_id FROM bank_accounts WHERE id = $1)
     AND ABS(total_amount - $2) <= $3
     AND status IN ('sent', 'partially_paid')
     ORDER BY ABS(total_amount - $2) ASC
     LIMIT 5`,
    [tx.bank_account_id, amount.toFixed(4), tolerance.toFixed(4)]
  );

  // Find matching bills
  const billMatches = await query(
    `SELECT 'bill' as type, id, bill_number as reference, total_amount as amount, bill_date as date
     FROM bills
     WHERE entity_id = (SELECT entity_id FROM bank_accounts WHERE id = $1)
     AND ABS(total_amount - $2) <= $3
     AND status IN ('approved', 'posted', 'partially_paid')
     ORDER BY ABS(total_amount - $2) ASC
     LIMIT 5`,
    [tx.bank_account_id, amount.toFixed(4), tolerance.toFixed(4)]
  );

  const suggestions = [...invoiceMatches.rows, ...billMatches.rows].map((match) => {
    const matchAmt = new Decimal(match.amount as string);
    const diff = matchAmt.minus(amount).abs();
    const confidence = diff.isZero() ? 1.0 : Math.max(0, 1 - diff.dividedBy(amount).toNumber());

    return { ...match, confidence: Math.round(confidence * 100) / 100 };
  });

  suggestions.sort((a, b) => b.confidence - a.confidence);

  res.json({
    data: suggestions,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/bank-transactions/:id/match
router.post('/transactions/:id/match', requirePermission('journal_entries:create'), validateBody(matchTransactionSchema), asyncHandler(async (req: Request, res: Response) => {
  const { matched_entity_type, matched_entity_id, matched_amount } = req.body;

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO reconciliation_matches (
        id, bank_transaction_id, match_type, matched_entity_type,
        matched_entity_id, matched_amount, matched_by
      ) VALUES ($1, $2, 'manual', $3, $4, $5, $6)`,
      [uuidv4(), req.params.id, matched_entity_type, matched_entity_id, matched_amount || 0, req.user!.user_id]
    );

    await client.query(
      `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), matched_by = $1 WHERE id = $2`,
      [req.user!.user_id, req.params.id]
    );
  });

  res.json({
    data: { matched: true },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/bank-accounts/:account_id/reconciliations
router.post('/:account_id/reconciliations', requirePermission('journal_entries:create'), validateBody(createReconciliationSchema), asyncHandler(async (req: Request, res: Response) => {
  const { start_date, end_date, ending_balance_per_bank } = req.body;

  const bankAccount = await query<{ entity_id: string }>(
    'SELECT entity_id FROM bank_accounts WHERE id = $1',
    [req.params.account_id]
  );
  if (bankAccount.rows.length === 0) throw new NotFoundError('Bank Account', req.params.account_id);

  const sessionId = uuidv4();
  await query(
    `INSERT INTO reconciliation_sessions (
      id, bank_account_id, entity_id, start_date, end_date,
      beginning_balance, ending_balance_per_bank
    ) VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [sessionId, req.params.account_id, bankAccount.rows[0].entity_id, start_date, end_date, ending_balance_per_bank]
  );

  const session = await query<ReconciliationSession>(
    'SELECT * FROM reconciliation_sessions WHERE id = $1',
    [sessionId]
  );

  res.status(201).json({
    data: session.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/reconciliations/:id
router.get('/reconciliations/:id', requirePermission('journal_entries:read'), asyncHandler(async (req: Request, res: Response) => {
  const session = await query<ReconciliationSession>(
    'SELECT * FROM reconciliation_sessions WHERE id = $1',
    [req.params.id]
  );
  if (session.rows.length === 0) throw new NotFoundError('Reconciliation Session', req.params.id);

  const matches = await query(
    `SELECT rm.*, bt.amount as bank_amount, bt.description as bank_description, bt.transaction_date
     FROM reconciliation_matches rm
     JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
     WHERE rm.reconciliation_session_id = $1
     ORDER BY bt.transaction_date`,
    [req.params.id]
  );

  const unmatchedCount = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM bank_transactions
     WHERE bank_account_id = $1 AND is_matched = false
     AND transaction_date BETWEEN $2 AND $3`,
    [session.rows[0].bank_account_id, session.rows[0].start_date, session.rows[0].end_date]
  );

  // CAUTION for whoever renders this: `variance`, `ending_balance_per_books`,
  // `outstanding_checks` and `deposits_in_transit` come straight off the row
  // and are still their DEFAULT 0 — nothing in mnemosine computes them. A
  // zero here means "not calculated", not "agrees with the bank". The honest
  // numbers on this response are matched_count and unmatched_count.
  res.json({
    data: {
      ...session.rows[0],
      matches: matches.rows,
      matched_count: matches.rows.length,
      unmatched_count: parseInt(unmatchedCount.rows[0].count, 10),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/bank-accounts/:account_id/auto-match (ML matching)
//
// El account_id llegaba crudo al motor, y esta ruta no lleva
// requireEntityAccess. Con el UUID de una cuenta ajena se conciliaba su
// extracto entero: is_matched = true sobre SUS movimientos y filas nuevas en
// reconciliation_matches. Y el efecto no se queda en el banco —period-close.ts
// lee el estado de conciliación como evidencia de cierre—, así que era una
// escritura contable en los libros de otro.
router.post('/:account_id/auto-match', requirePermission('journal_entries:create'), asyncHandler(async (req: Request, res: Response) => {
  const result = await autoMatchUnreconciled(req.params.account_id, {
    scope: entityScope(req.tenantId!, req.entityId!),
  });

  res.json({
    data: result,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/reconciliations/:id/complete — WITHDRAWN
//
// This was the most dangerous endpoint in the file, and the danger was
// entirely in who read its output.
//
// The whole implementation was one UPDATE setting status = 'balanced'.
// It never computed ending_balance_per_books, never compared it to
// ending_balance_per_bank, never looked at whether a single transaction
// in the period was still unmatched, and never posted the entries a
// reconciliation exists to find — bank fees, interest earned, NSF
// returns, the FX difference on a foreign-currency account. Those
// columns (ending_balance_per_books, variance, outstanding_checks,
// deposits_in_transit, bank_charges, bank_interest) kept their DEFAULT
// 0 and the session reported variance 0 — a zero that means "nobody
// subtracted anything", displayed as "the account agrees".
//
// Then period-close.ts:44-61 reads status IN ('balanced','approved',
// 'posted') as the evidence that the account is reconciled, and ticks
// "Bank reconciliations complete" on the close checklist. So one
// unconditional UPDATE turned into a signed statement that the cash
// balance had been verified against the bank. That is the difference
// between an unfinished feature and a false attestation.
//
// Everything else in this file is real and stays: importing statements,
// suggesting matches, matching, auto-matching. What does not exist is
// the arithmetic that turns a pile of matches into a reconciliation,
// and the posting of the adjustments it uncovers. Until that exists, a
// session cannot reach 'balanced' from here — and the close checklist
// will keep saying the account is not reconciled, which is true.
router.post('/reconciliations/:id/complete', requirePermission('journal_entries:create'), asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine cannot complete a bank reconciliation: it does not compute the book balance, the ' +
      'variance, outstanding checks or deposits in transit, and it does not post the bank fees, ' +
      'interest and returns a reconciliation uncovers. Marking the session "balanced" would have ' +
      'told the period-close checklist that this account was verified against the bank when nothing ' +
      'had been verified. Reconcile the account outside mnemosine, post the adjustments you find as ' +
      'journal entries, and leave the period-close warning standing until you have.'
  );
}));

export default router;
