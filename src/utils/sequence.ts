import type pg from 'pg';
import { query } from '../database/connection.js';

/**
 * Atomic per-entity document numbering backed by entity_sequences.
 * The UPSERT takes a row lock until the caller's transaction commits, so
 * two concurrent callers can never draw the same number (the COUNT(*)
 * approach this replaces collided under concurrency). Must run on the
 * caller's transaction client: the number is only consumed if the
 * surrounding transaction commits.
 *
 * R3: LA SERIE LA FIJA LA FECHA DEL DOCUMENTO, NO EL RELOJ. El formato
 * `JE-2026-00042` insinuaba serie anual y no lo era: el año salía de
 * `new Date()` y el contador jamás se reiniciaba — un asiento capturado en
 * enero 2027 con fecha de diciembre 2026 salía «JE-2027-…» continuando la
 * cuenta de 2026. Ahora la fecha del documento es parámetro OBLIGATORIO
 * (un llamador sin fecha no compila), el contador vive por
 * (entidad, `${name}_${año}`) y el año impreso es el del documento. La
 * migración 043 sembró los contadores anuales desde los folios reales ya
 * emitidos, para que la serie continúe sin colisiones.
 */
export async function nextEntityNumber(
  client: pg.PoolClient,
  entityId: string,
  name: string,
  prefix: string,
  fecha: Date | string
): Promise<string> {
  const año = añoDeDocumento(fecha);
  const result = await client.query<{ value: string }>(
    `INSERT INTO entity_sequences (entity_id, name, value)
     VALUES ($1, $2, 1)
     ON CONFLICT (entity_id, name)
     DO UPDATE SET value = entity_sequences.value + 1, updated_at = NOW()
     RETURNING value`,
    [entityId, `${name}_${año}`]
  );
  return formatDocumentNumber(prefix, año, parseInt(result.rows[0].value, 10));
}

/**
 * El año DEL DOCUMENTO. Para cadenas `YYYY-MM-DD` se lee del texto (sin
 * pasar por Date: un `new Date('2026-12-31')` es medianoche UTC y al oeste
 * de Greenwich retrocede un día — la lección de createDraftEntry); para
 * Date, el año local, que es como se capturó.
 */
export function añoDeDocumento(fecha: Date | string): number {
  if (fecha instanceof Date) return fecha.getFullYear();
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(fecha).trim());
  if (!m) {
    throw new Error(
      `Fecha de documento ilegible para la serie del folio: "${fecha}". Se espera Date o "YYYY-MM-DD".`
    );
  }
  return Number(m[1]);
}

export function formatDocumentNumber(prefix: string, año: number, n: number): string {
  return `${prefix}-${año}-${n.toString().padStart(5, '0')}`;
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
 * every financial document now goes through nextEntityNumber. Conserva el
 * año del reloj a propósito: no es una serie contable.
 */
export function generateEntryNumber(prefix: string, count: number): string {
  return formatDocumentNumber(prefix, new Date().getFullYear(), count + 1);
}
