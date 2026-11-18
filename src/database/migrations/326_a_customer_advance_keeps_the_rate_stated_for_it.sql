-- ============================================================
-- 326 · A CUSTOMER ADVANCE KEEPS THE RATE STATED FOR IT (#623, MNE-001-458)
--
-- An advance collected before its sale is invoiced causes its IVA the day
-- the money arrives (LIVA art. 1-B, first paragraph; NIF D-1): the receipt's
-- entry credits the base to anticipo_clientes (2150) and the IVA to
-- iva_trasladado (2120). The rate of a sale that has not happened is a fact
-- the accountant states, so the receipt keeps it with the base and the IVA
-- it was split into: applying the advance later cancels exactly that IVA.
--
-- advance_factor_type tells a 0 % rate from an exemption, as
-- bill_lines.tipo_factor does (066); 'no_objeto' is an act outside the
-- object of the tax. NULL in all four means no advance treatment: every row
-- written before, an entity that does not keep Mexican books, and cash on
-- account nobody stated a rate for. The INSERT that creates the receipt
-- writes them; no UPDATE does.
--
-- Additive: four nullable columns and one CHECK that every existing row
-- satisfies with its four NULLs. No data moves, so there is no
-- row-level-security opt-in, and the table's policy is untouched.
-- ============================================================

ALTER TABLE customer_payments
    ADD COLUMN IF NOT EXISTS advance_factor_type VARCHAR(10),
    ADD COLUMN IF NOT EXISTS advance_tax_rate DECIMAL(5,2),
    ADD COLUMN IF NOT EXISTS advance_base_amount DECIMAL(19,4),
    ADD COLUMN IF NOT EXISTS advance_iva_amount DECIMAL(19,4);

-- All four NULL, or a coherent set: a rate only with 'tasa', no IVA without
-- a rate above zero, and no negative amount.
ALTER TABLE customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_advance_treatment_coherent,
    ADD CONSTRAINT customer_payments_advance_treatment_coherent
        CHECK (
            (advance_factor_type IS NULL AND advance_tax_rate IS NULL
             AND advance_base_amount IS NULL AND advance_iva_amount IS NULL)
            OR (
                advance_factor_type IS NOT NULL
                AND advance_factor_type IN ('tasa', 'exento', 'no_objeto')
                AND advance_base_amount IS NOT NULL AND advance_base_amount >= 0
                AND advance_iva_amount IS NOT NULL AND advance_iva_amount >= 0
                AND (
                    (advance_factor_type = 'tasa' AND advance_tax_rate IS NOT NULL
                     AND advance_tax_rate >= 0 AND (advance_tax_rate > 0 OR advance_iva_amount = 0))
                    OR (advance_factor_type <> 'tasa' AND advance_tax_rate IS NULL
                        AND advance_iva_amount = 0)
                )
            )
        );

COMMENT ON COLUMN customer_payments.advance_factor_type IS
    'tasa | exento | no_objeto: the IVA treatment stated for a customer advance (MNE-001-458). NULL: no advance treatment.';
COMMENT ON COLUMN customer_payments.advance_tax_rate IS
    'The IVA rate stated for the advance, as a percent (16.00, 8.00, 0.00). NULL unless advance_factor_type is tasa.';
COMMENT ON COLUMN customer_payments.advance_base_amount IS
    'The base of the advance, credited to anticipo_clientes: the cash over 1 + rate, rounded half up to the cent.';
COMMENT ON COLUMN customer_payments.advance_iva_amount IS
    'The IVA the advance caused when collected, credited to iva_trasladado: the cash minus advance_base_amount.';
