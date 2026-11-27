-- ============================================================
-- 348 · AN INVOICE OF THE OPENING SAYS WHETHER ITS IVA IS PENDING (#1078, MNE-001-946)
--
-- A customer invoice that came open with a migration (`opening-balance import
-- --subledger`) carries its base, its IVA and its rate, and hangs from the
-- opening entry, which holds the IVA not yet collected of ALL of them as one
-- line. Nothing on the invoice said whether its own IVA is in that line: the
-- readers took it for a PUE sale by default, so collecting it caused no IVA
-- and a credit note took its IVA out of the account of IVA due (LIVA arts.
-- 1-B and 7).
--
-- opening_iva_pending is that fact, written by the load:
--   true   the invoice came open with its IVA still to be caused: a
--          collection releases its share from the pending account, as a PPD
--          invoice's does, whatever its CFDI's MetodoPago says;
--   false  the previous system had already caused it (`"ivaPending": false`
--          on the document): it keeps its true rate, and no collection
--          causes it again;
--   NULL   every other invoice: not of an opening, or loaded before the load
--          wrote the column.
--
-- A fiscal treatment hangs from this column and from nothing a person edits:
-- `terms` stays the invoice's payment terms.
--
-- NULLABLE, AND NOT BACKFILLED. No existing row is touched (history before
-- overwrite, ADR-0006, Decision 2). An invoice an opening loaded before this
-- column existed keeps NULL; the readers take one that hangs from a standing
-- opening and carries IVA as pending, the default the file has, and one that
-- carries none (every invoice loaded before MNE-001-946) as they always did.
--
-- NO INDEX. Both readers reach the invoice by its primary key
-- (`resolveInvoiceMetodoPago`, `ivaStillParked` in iva-cash-basis.ts).
--
-- CONTRACT: schema, compatible. Additive: one nullable column, no default, no
-- CHECK. No row is read or written, so there is no row-level-security opt-in,
-- and the table's policy and rls-policies.sql are untouched.
--
-- IDEMPOTENT. IF NOT EXISTS: a second run adds nothing.
-- ============================================================

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS opening_iva_pending BOOLEAN;

COMMENT ON COLUMN invoices.opening_iva_pending IS
    'Written by the opening load (MNE-001-946) on the invoices it creates on Mexican books: true = came open from the migration with its IVA still to be caused (collects as PPD), false = the previous system had already caused it ("ivaPending": false; reads as PUE), NULL = every other invoice.';
