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
-- THE TWO CAPTURED FIGURES live in their own table, one row per fact and per
-- fiscal year, each with the annual return it was read from (owner decision
-- MNE-001-114, 2026-09-30: a table by fiscal year, not the policy panel; the
-- panel holds choices between treatments, and these are facts).
--
--   · APPEND-ONLY HISTORY, NOT OVERWRITE. A correction is a new row; the
--     figure in force for (entity, year, kind) is the latest recorded one.
--     A provisional payment already filed with the old coefficient must stay
--     explainable after someone corrects it.
--   · recorded_at defaults to clock_timestamp(), not now(): two captures in
--     one transaction must still have an order.
--   · THE WINDOW OF THE SOURCE is the law's, not a convention: the source
--     return is always of an EARLIER year, and a coefficient may come from a
--     return at most five years older than the year it is applied to
--     (LISR art. 14 fr. I, second paragraph).
--   · A coefficient is a fraction of income, so it lies in [0, 1].
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
    entity_id UUID NOT NULL REFERENCES legal_entities(id),
    fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('profit_coefficient', 'pending_tax_losses')),
    value DECIMAL(19,4) NOT NULL CHECK (value >= 0),
    source_fiscal_year INTEGER NOT NULL,
    source_document TEXT NOT NULL CHECK (btrim(source_document) <> ''),
    recorded_by UUID REFERENCES users(id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT income_tax_input_source_is_an_earlier_return
        CHECK (source_fiscal_year < fiscal_year),
    CONSTRAINT income_tax_input_coefficient_within_law
        CHECK (kind <> 'profit_coefficient'
               OR (value <= 1 AND source_fiscal_year >= fiscal_year - 5))
);

CREATE INDEX idx_income_tax_annual_inputs_in_force
    ON income_tax_annual_inputs (entity_id, fiscal_year, kind, recorded_at DESC);

COMMENT ON TABLE income_tax_annual_inputs IS
  'Figures of the provisional ISR of a legal entity read off an earlier annual return (profit coefficient, tax losses pending amortization), one row per capture. Append-only: the figure in force for (entity_id, fiscal_year, kind) is the latest recorded_at.';
COMMENT ON COLUMN income_tax_annual_inputs.fiscal_year IS
  'The fiscal year whose provisional payments use the figure, not the year of the return it came from.';
COMMENT ON COLUMN income_tax_annual_inputs.source_fiscal_year IS
  'The fiscal year of the annual return the figure was read from. Earlier than fiscal_year; for a coefficient, at most five years earlier (LISR art. 14 fr. I).';
COMMENT ON COLUMN income_tax_annual_inputs.source_document IS
  'The annual return as the accountant identifies it (operation number, filing date). Required: a coefficient without its return cannot be audited.';

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.corporate_rate', '2014-01-01', '0.3000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 9, first paragraph: legal entities pay 30 % on their taxable income; the provisional payments of art. 14 fr. II apply the same rate. Current LISR, DOF 11-12-2013, in force since 2014-01-01.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
