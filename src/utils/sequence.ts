import type pg from 'pg';
import { query } from '../database/connection.js';

/**
 * Atomic per-entity document numbering backed by entity_sequences.
 * The UPSERT takes a row lock until the caller's transaction commits, so
 * two concurrent callers can never draw the same number (the COUNT(*)
 * approach this replaces collided under concurrency). Must run on the
 * caller's transaction client: the number is only consumed if the
 * surrounding transaction commits.
 */
export async function nextEntityNumber(
  client: pg.PoolClient,
  entityId: string,
  name: string,
  prefix: string
): Promise<string> {
  const result = await client.query<{ value: string }>(
    `INSERT INTO entity_sequences (entity_id, name, value)
     VALUES ($1, $2, 1)
     ON CONFLICT (entity_id, name)
     DO UPDATE SET value = entity_sequences.value + 1, updated_at = NOW()
     RETURNING value`,
    [entityId, name]
  );
  return formatDocumentNumber(prefix, parseInt(result.rows[0].value, 10));
}

export function formatDocumentNumber(prefix: string, n: number): string {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${n.toString().padStart(5, '0')}`;
}

/** @deprecated Race-prone (COUNT-based). Use nextEntityNumber for documents. */
export async function generateSequenceNumber(
  entityId: string,
  prefix: string,
  tableName: string
): Promise<string> {
  const year = new Date().getFullYear();
  const sequenceKey = `${prefix}-${year}`;

  // Use a sequence table or count-based approach
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${tableName}
     WHERE entity_id = $1
     AND entry_number LIKE $2 || '%'`,
    [entityId, sequenceKey]
  );

  const nextNumber = parseInt(result.rows[0].count, 10) + 1;
  return `${sequenceKey}-${nextNumber.toString().padStart(5, '0')}`;
}

/**
 * @deprecated Race-prone when fed a COUNT(*): two concurrent callers format
 * the same number. Kept for non-financial identifiers (customers, vendors);
 * every financial document now goes through nextEntityNumber.
 */
export function generateEntryNumber(prefix: string, count: number): string {
  return formatDocumentNumber(prefix, count + 1);
}
