-- ============================================================
-- 333 · A CUSTOMER ALLOCATION KEEPS WHAT IT TOOK FROM AN ADVANCE (#623, MNE-001-422)
--
-- An advance recorded with its treatment caused its IVA the day it was
-- collected (LIVA art. 1-B, first paragraph; 326): its receipt credited the
-- base to anticipo_clientes (2150) and the IVA to iva_trasladado (2120).
-- Applying it to the invoice of its sale must not cause that IVA a second
-- time: the application debits 2150 for the base it takes and 2120 for the
-- IVA that cash carried (the effect of the TipoRelacion 07 egreso that
-- cancels the advance, Anexo 20 Apendice 6, procedure A).
--
-- advance_base_amount and advance_iva_amount are those two figures for one
-- allocation. The IVA is a share of the advance's own, a cumulative target
-- minus what the receipt's live allocations already cancelled, so the parts
-- add up to it with no cent left; `receipt unapply` credits back exactly
-- what the row stored, and never derives it again.
--
-- NOT NULL DEFAULT 0. Zero is true of every row written before: until this
-- migration an advance that carried a treatment could not be applied
-- (ADVANCE_APPLICATION_NOT_WIRED), and cash on account with no treatment
-- takes nothing from an advance. 165 did the same for the withholding. The
-- INSERT that creates the allocation writes them; no UPDATE does.
--
-- CONTRACT: schema, compatible. Additive: two columns with a constant
-- default (no table rewrite) and one CHECK every existing row satisfies with
-- its zeros. No data moves, so there is no row-level-security opt-in, and
-- the table's policy is untouched.
-- ============================================================

ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS advance_base_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS advance_iva_amount DECIMAL(19,4) NOT NULL DEFAULT 0;

-- What an allocation takes from an advance is cash it applies: never
-- negative, and never more than the cash itself.
ALTER TABLE payment_allocations
    DROP CONSTRAINT IF EXISTS payment_allocations_advance_taken_coherent,
    ADD CONSTRAINT payment_allocations_advance_taken_coherent
        CHECK (
            advance_base_amount >= 0 AND advance_iva_amount >= 0
            AND advance_base_amount + advance_iva_amount <= amount_applied
        );

COMMENT ON COLUMN payment_allocations.advance_base_amount IS
    'The base this allocation took from its receipt''s advance, debited to anticipo_clientes (MNE-001-422). 0 when it took none.';
COMMENT ON COLUMN payment_allocations.advance_iva_amount IS
    'The advance''s IVA this allocation cancelled, debited to iva_trasladado instead of causing it again (MNE-001-422). 0 when it took none.';
