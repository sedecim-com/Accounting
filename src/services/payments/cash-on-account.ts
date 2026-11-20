/**
 * MNE-001-498 · A receipt's cash on account, as SQL over the row aliased
 * `alias` of customer_payments: its amount, less its live allocations, less
 * the live transfers out of it (`receipt transfer record`). One fragment for
 * every reader, so a credit given to another customer is neither applied nor
 * transferred again, nor shown as still on account. Both subqueries are
 * scoped through the receipt's own row and entity.
 */
export function cashOnAccountSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Not an SQL alias: ${alias}`);
  return `(${alias}.payment_amount
    - COALESCE((SELECT SUM(coa_pa.amount_applied) FROM payment_allocations coa_pa
                 WHERE coa_pa.payment_id = ${alias}.id AND coa_pa.unapplied_at IS NULL), 0)
    - COALESCE((SELECT SUM(coa_t.payment_amount) FROM customer_payments coa_t
                 WHERE coa_t.transferred_from_payment_id = ${alias}.id AND coa_t.entity_id = ${alias}.entity_id
                   AND coa_t.status = 'completed'), 0))`;
}

/** The `source_type` of the entry a transfer of customer credit posts. */
export const CUSTOMER_CREDIT_TRANSFER_SOURCE = 'customer_credit_transfer';

/** The method of the row a transfer gives the receiving customer (migration 339). */
export const BALANCE_TRANSFER_METHOD = 'balance_transfer';
