-- ============================================================
-- 166 · THE PROVISIONAL INCOME TAX KNOWS ITS INPUTS (#308 · MNE-001-115)
--
-- The monthly provisional ISR of a legal entity (LISR art. 14) multiplies the
-- year-to-date nominal income by the PROFIT COEFFICIENT of an earlier annual
-- return, subtracts the PTU paid and the TAX LOSSES pending amortization, and
-- applies the corporate rate of LISR art. 9. Two of those inputs are not in
-- the ledger: they are read off an annual return the firm already filed. The
-- third is law.
--
-- THE TWO CAPTURED FIGURES live in their own table by fiscal year, each with
-- the annual return it was read from (owner decision MNE-001-114, 2026-09-30:
-- a table by fiscal year, not the policy panel; the panel holds choices
-- between treatments, and these are facts).
--
--   · ONE ROW PER FIGURE OF A RETURN, KEYED BY THE RETURN'S FISCAL YEAR, not
--     by the year that applies it. LISR art. 14 fr. I takes the coefficient
--     of the last 12-month return that "se hubiera o debió haberse
--     presentado" when the payment is due: the January and February 2026
--     payments (due 17 Feb and 17 Mar) still use the 2024 return unless the
--     2025 one was already filed, because the 2025 return is due on 31 March
--     (LISR art. 76 fr. V); March onwards uses 2025. One fiscal year of
--     payments therefore reads two returns, and the reader chooses by the
--     payment's due date and source_filed_on. The five-year window of art. 14
--     fr. I depends on the payment's year, so it lives in the reader too.
--   · A COEFFICIENT HAS NO UPPER BOUND. It is (utilidad fiscal + PTU) /
--     ingresos nominales, and the nominal income excludes the accumulable
--     inflation adjustment that the utilidad fiscal includes: an entity with
--     little income and net monetary debt files a coefficient above 1.
--   · PENDING LOSSES SAY HOW FAR THEY ARE UPDATED. LISR art. 57 updates them
--     through the last month of the first half of the year that applies them;
--     updated_through is the INPC month the captured amount already reflects,
--     so the calculation (MNE-001-059) can finish the update and prove it.
--   · APPEND-ONLY, ENFORCED. A correction (an amended return) is a new row;
--     the figure in force for a return is the one with the highest seq, and
--     the triggers below refuse UPDATE, DELETE and TRUNCATE for everyone, as 033, 035
--     and 041 do. seq is an identity, not recorded_at: two captures in the
--     same microsecond still have one order.
--
-- Only entity_id, like fiscal_years: rls-policies.sql derives the tenant
-- through legal_entities for every table that has the column, and scope.ts
-- bounds it by entity.
--
-- THE CORPORATE RATE goes to legal_parameters with its date of entry: 30 %
-- since the current LISR (DOF 11-12-2013) came into force on 2014-01-01, the
-- date 088, 129 and the seeder use for their LISR rows.
-- ============================================================

CREATE TABLE income_tax_annual_inputs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('profit_coefficient', 'pending_tax_losses')),
    value DECIMAL(19,4) NOT NULL CHECK (value >= 0),
    source_fiscal_year INTEGER NOT NULL CHECK (source_fiscal_year BETWEEN 2000 AND 2200),
    source_filed_on DATE NOT NULL,
    source_document TEXT NOT NULL CHECK (btrim(source_document) <> ''),
    updated_through DATE,
    recorded_by UUID REFERENCES users(id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT income_tax_input_return_filed_after_its_year
        CHECK (source_filed_on > make_date(source_fiscal_year, 12, 31)),
    CONSTRAINT income_tax_input_losses_state_their_update
        CHECK ((kind = 'pending_tax_losses') = (updated_through IS NOT NULL)
               AND (updated_through IS NULL OR extract(day FROM updated_through) = 1))
);

CREATE INDEX idx_income_tax_annual_inputs_in_force
    ON income_tax_annual_inputs (entity_id, kind, source_fiscal_year DESC, seq DESC);

CREATE OR REPLACE FUNCTION public.income_tax_annual_inputs_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'income_tax_annual_inputs es de sólo escritura: % rechazado. Una corrección es un renglón nuevo; el pago provisional ya presentado tiene que seguir explicándose.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

CREATE TRIGGER income_tax_annual_inputs_append_only
  BEFORE UPDATE OR DELETE ON public.income_tax_annual_inputs
  FOR EACH ROW
  EXECUTE FUNCTION public.income_tax_annual_inputs_append_only();

-- A TRUNCATE fires no row trigger, so it gets its own statement-level one,
-- as 033 and 083 do: otherwise one statement would empty the history.
CREATE TRIGGER income_tax_annual_inputs_no_truncate
  BEFORE TRUNCATE ON public.income_tax_annual_inputs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.income_tax_annual_inputs_append_only();

COMMENT ON TABLE income_tax_annual_inputs IS
  'Figures of the provisional ISR of a legal entity read off an annual return (profit coefficient, tax losses pending amortization), one row per capture, keyed by the return. Append-only (trigger): the figure in force for (entity_id, kind, source_fiscal_year) is the highest seq; which return a payment uses is chosen by its due date (LISR art. 14 fr. I).';
COMMENT ON COLUMN income_tax_annual_inputs.source_fiscal_year IS
  'The fiscal year of the annual return the figure was read from.';
COMMENT ON COLUMN income_tax_annual_inputs.source_filed_on IS
  'When that return was filed. A payment due before 31 March of source_fiscal_year + 1 uses it only if it was already filed (LISR art. 14 fr. I).';
COMMENT ON COLUMN income_tax_annual_inputs.source_document IS
  'The annual return as the accountant identifies it (operation number). Required: a coefficient without its return cannot be audited.';
COMMENT ON COLUMN income_tax_annual_inputs.updated_through IS
  'Pending tax losses only: the first day of the INPC month the captured amount is already updated through (LISR art. 57). NULL for a coefficient.';

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.corporate_rate', '2014-01-01', '0.3000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 9, first paragraph: legal entities pay 30 % on their taxable income; the provisional payments of art. 14 fr. II apply the same rate. Current LISR, DOF 11-12-2013, in force since 2014-01-01.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
