import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';

// ============================================================
// IEPS ON CASH BASIS · the roles and the tag (MNE-001-618, #101)
//
// A leaf: the two roles a PPD sale's IEPS moves between and the tag that
// ties each move to its invoice and receipt, with no import beyond a type.
// ieps-cash-basis.ts re-exports them, so every importer keeps reading them
// from there, and report-service.ts reads them from here, so the report
// layer's IEPS reads name the same strings without an import cycle.
// ============================================================

/**
 * The role a PPD sale's IEPS waits in (2181): the taxonomy credits it on a PPD
 * sale, the seed maps it on Mexican books, and the backfill gives it to an
 * entity seeded before (MNE-001-505).
 */
export const IEPS_UNCOLLECTED_ROLE: AccountRole = 'ieps_trasladado_no_cobrado';
/** Where caused IEPS is owed (2180). */
export const IEPS_DUE_ROLE: AccountRole = 'ieps_por_pagar';
/** The key under `journal_entry_lines.tags` that ties an IEPS move to its invoice and receipt. */
export const IEPS_MOVE_TAG = 'ieps_release';
