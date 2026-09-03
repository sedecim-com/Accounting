import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, NotImplementedError } from '../../../utils/errors.js';
import { autoMatchUnreconciled } from '../../../services/banking/matching.js';
import { entityScope } from '../../../database/scope.js';
import type { BankTransaction, ReconciliationSession } from '../../../types/index.js';
import { MATCHED_ENTITY_TYPES } from '../../../database/enums.js';
import { declararRiesgoRuta } from '../risk.js';
import { arregloAcotado, MAX_MOVIMIENTOS_POR_IMPORTACION } from '../topes.js';

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
  // EL ARREGLO SIN TOPE QUE QUEDABA. Cada movimiento cuesta DOS viajes a la
  // base —comprobar duplicado, insertar— y el manejador los hace en serie:
  // un cuerpo de cien mil filas son doscientos mil viajes atando un worker y
  // una conexión del pool. `xml-ingestion` cerró este mismo hueco en sus dos
  // lotes; éste se quedó abierto. El porqué del número, en topes.ts.
  transactions: arregloAcotado(bankTransactionSchema, {
    tope: MAX_MOVIMIENTOS_POR_IMPORTACION,
    plural: 'movimientos',
    salida: 'Parte el extracto, o cárgalo con `mnemosine bank import`, que inserta por lotes.',
    minimo: 1,
  }),
  source: z.string().optional(),
  batch_id: z.string().optional(),
});

const matchTransactionSchema = z.object({
  // Pedía 'journal_entry' y 'payment', que no existen, y no dejaba escribir
  // 'journal_entry_line' —el caso más común— ni los dos tipos de pago.
  matched_entity_type: z.enum(MATCHED_ENTITY_TYPES),
  matched_entity_id: z.string().uuid(),
  matched_amount: z.union([z.string(), z.number()]).optional(),
});

const createReconciliationSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  ending_balance_per_bank: z.union([z.string(), z.number()]),
});


// ============================================================
// LA CUENTA Y EL MOVIMIENTO, ACOTADOS POR LA ENTIDAD DE QUIEN LLAMA
//
// El arreglo de `auto-match` (más abajo) cerró UNA de las ocho rutas de este
// archivo y no barrió las hermanas. Ejecutado contra Postgres con dos
// entidades del mismo inquilino, el mismo ataque seguía funcionando por
// cuatro de ellas: con el UUID de una cuenta ajena se le METÍAN movimientos
// al extracto (`import` → 200, una fila nueva), se le LEÍA el extracto
// (`unmatched` → 200 con sus movimientos), se COTEJABA su movimiento contra
// una factura (`match` → 200, fila en reconciliation_matches) y se le ABRÍA
// una sesión de conciliación (`reconciliations` → 201).
//
// La última es la peor: `period-close.ts` lee el estado de la sesión como
// evidencia de que la cuenta fue verificada, así que abrir sesiones en los
// libros de otro es escribir en SU cierre.
//
// Dos rutas de este archivo daban una falsa sensación de acotamiento con
// `WHERE entity_id = (SELECT entity_id FROM bank_accounts WHERE id = $1)`.
// Eso no acota nada: deduce la entidad DE LA CUENTA QUE PIDE EL ATACANTE, así
// que siempre casa. La entidad tiene que venir del TOKEN, nunca del parámetro.
//
// 404 y no 403, como el resto del sistema: quien no es dueño no distingue una
// cuenta ajena de una inexistente.
//
// Y ACOTAR NO BASTA SI LA ENTIDAD NO ESTÁ VALIDADA. La primera versión de este
// arreglo filtraba por `req.entityId` sin montar `requireEntityAccess`, y el
// criterio E2.1 lo cazó: `req.entityId` sale de la cabecera `x-entity-id`, así
// que sin esa guarda el atacante nombra la entidad hermana y el filtro nuevo lo
// obedece — se acota, pero a la entidad que él eligió. Por eso las siete rutas
// montan la guarda: valida que TODA entidad que la petición nombre sea suya.
// ============================================================

async function cuentaDelLlamador(req: Request, accountId: string): Promise<{ id: string; entity_id: string }> {
  const r = await query<{ id: string; entity_id: string }>(
    'SELECT id, entity_id FROM bank_accounts WHERE id = $1 AND entity_id = $2',
    [accountId, req.entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', accountId);
  return r.rows[0];
}

async function movimientoDelLlamador(req: Request, txId: string): Promise<BankTransaction> {
  const r = await query<BankTransaction>(
    `SELECT bt.* FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.id = $1 AND ba.entity_id = $2`,
    [txId, req.entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Bank Transaction', txId);
  return r.rows[0];
}

// POST /v1/bank-accounts/:account_id/import
router.post('/:account_id/import', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'bank_transactions (staging bancario); NUNCA journal_entries' }), requirePermission('journal_entries:create'), requireEntityAccess, validateBody(importTransactionsSchema), asyncHandler(async (req: Request, res: Response) => {
  const { transactions } = req.body;
  await cuentaDelLlamador(req, req.params.account_id);

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
router.get('/:account_id/transactions/unmatched', requirePermission('journal_entries:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  await cuentaDelLlamador(req, req.params.account_id);
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
router.get('/transactions/:id/suggestions', requirePermission('journal_entries:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const tx = await movimientoDelLlamador(req, req.params.id);
  const amount = new Decimal(tx.amount).abs();
  const tolerance = amount.times(0.01); // 1% tolerance

  // Find matching invoices
  const invoiceMatches = await query(
    `SELECT 'invoice' as type, id, invoice_number as reference, total_amount as amount, invoice_date as date
     FROM invoices
     WHERE entity_id = $1
     AND ABS(total_amount - $2) <= $3
     AND status IN ('sent', 'partially_paid')
     ORDER BY ABS(total_amount - $2) ASC
     LIMIT 5`,
    [req.entityId, amount.toFixed(4), tolerance.toFixed(4)]
  );

  // Find matching bills.
  //
  // Acotada DIRECTAMENTE por la entidad del token, igual que la consulta de
  // facturas de arriba. Decía `entity_id = (SELECT entity_id FROM bank_accounts
  // WHERE id = $1)`, y eso no sólo no acotaba nada —deducía la entidad de la
  // cuenta que pedía quien llamaba— sino que dejó de funcionar cuando el
  // arreglo de la frontera hizo que `$1` pasara a ser la ENTIDAD y no la
  // cuenta: una entidad nunca es un `bank_accounts.id`, así que la subconsulta
  // devolvía NULL y `entity_id = NULL` no es cierto para ninguna fila.
  //
  // Las sugerencias de gastos salían VACÍAS siempre, con 200 y sin una palabra.
  // Acotar y romper se ven igual desde fuera si nadie prueba el caso PROPIO;
  // por eso `banco-frontera.int.spec.ts` gana una prueba positiva.
  const billMatches = await query(
    `SELECT 'bill' as type, id, bill_number as reference, total_amount as amount, bill_date as date
     FROM bills
     WHERE entity_id = $1
     AND ABS(total_amount - $2) <= $3
     AND status IN ('approved', 'posted', 'partially_paid')
     ORDER BY ABS(total_amount - $2) ASC
     LIMIT 5`,
    [req.entityId, amount.toFixed(4), tolerance.toFixed(4)]
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
router.post('/transactions/:id/match', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'reconciliation_matches + bank_transactions.is_matched' }), requirePermission('journal_entries:create'), requireEntityAccess, validateBody(matchTransactionSchema), asyncHandler(async (req: Request, res: Response) => {
  const { matched_entity_type, matched_entity_id, matched_amount } = req.body;
  await movimientoDelLlamador(req, req.params.id);

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
router.post('/:account_id/reconciliations', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'reconciliation_sessions (apertura de la sesion)' }), requirePermission('journal_entries:create'), requireEntityAccess, validateBody(createReconciliationSchema), asyncHandler(async (req: Request, res: Response) => {
  const { start_date, end_date, ending_balance_per_bank } = req.body;

  const cuenta = await cuentaDelLlamador(req, req.params.account_id);

  const sessionId = uuidv4();
  await query(
    `INSERT INTO reconciliation_sessions (
      id, bank_account_id, entity_id, start_date, end_date,
      beginning_balance, ending_balance_per_bank
    ) VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [sessionId, req.params.account_id, cuenta.entity_id, start_date, end_date, ending_balance_per_bank]
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
router.get('/reconciliations/:id', requirePermission('journal_entries:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const session = await query<ReconciliationSession>(
    'SELECT * FROM reconciliation_sessions WHERE id = $1 AND entity_id = $2',
    [req.params.id, req.entityId]
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
router.post('/:account_id/auto-match', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'reconciliation_matches + bank_transactions.is_matched sobre el extracto entero' }), requirePermission('journal_entries:create'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
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
// Declarada aunque hoy conteste 501: la clase describe el ACTO, no el
// estado de la implementacion. Si alguien la vuelve a cablear, la
// declaracion ya dice que es un cierre y no una anotacion mas.
router.post('/reconciliations/:id/complete', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'reconciliation_sessions.status — el cierre que la lista de cierre de periodo lee como evidencia de que la cuenta cuadra. Hoy 501.' }), requirePermission('journal_entries:create'), asyncHandler(async () => {
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
