-- ============================================================
-- 094 · THE AGUINALDO IS EXEMPT UP TO 30 UMA (#297, MNE-001-062)
--
-- Every earning was all or nothing for ISR (`is_taxable_isr`), so a December
-- aguinaldo was taxed whole. LISR art. 93 fr. XIV exempts it up to 30 daily
-- UMA per calendar year. Two things are needed for that, and both go here.
-- ============================================================

-- ── 1. EACH EARNING CARRIES ITS EXEMPT AND ITS TAXABLE PART ─────────────
--
-- Stored, not recomputed: the cap is per CALENDAR YEAR, so the second payment
-- of an aguinaldo has to know what the first one exempted, and the payroll
-- CFDI (MNE-001-063) states both figures per perception.
--
-- NULLABLE ON PURPOSE. Rows written before this migration were taxed whole
-- and nobody recorded a split for them; inventing one now would be a figure
-- the ISR withheld never used. NULL reads as "no exemption was applied".
--
-- The CHECK is the whole contract: the two parts are a split of the amount,
-- never more and never less. A NULL part makes the CHECK pass, which is the
-- legacy case above.
ALTER TABLE paycheck_earnings
    ADD COLUMN IF NOT EXISTS isr_exempt_amount  NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS isr_taxable_amount NUMERIC(14,2);

ALTER TABLE paycheck_earnings DROP CONSTRAINT IF EXISTS paycheck_earnings_isr_parts_add_up;
ALTER TABLE paycheck_earnings
    ADD CONSTRAINT paycheck_earnings_isr_parts_add_up
    CHECK (isr_exempt_amount + isr_taxable_amount = amount);

COMMENT ON COLUMN paycheck_earnings.isr_exempt_amount IS
  'Part of the earning exempt from ISR (LISR art. 93), as computed when the paycheck was calculated. NULL on rows written before migration 094: those were taxed whole.';
COMMENT ON COLUMN paycheck_earnings.isr_taxable_amount IS
  'Part of the earning that entered the ISR base. isr_exempt_amount + isr_taxable_amount = amount.';

-- ── 2. THE CAP IS LAW, WITH ITS DATE ────────────────────────────────────
--
-- A migration and not only the demo seeder, for the reason 082 gives: the
-- integration suite and every migrated-but-unseeded install would otherwise
-- fail `never_loaded` on the first aguinaldo.
--
-- THE VALUE IS IN UMA, NOT IN PESOS. The law fixes "30 days"; the peso figure
-- moves every February with the UMA, and it is computed at the payment date
-- from the UMA in force that day. Storing 3 519.30 here would be right for
-- one year only.
--
-- THE DATE. The fraction reads "el salario mínimo general del área
-- geográfica del trabajador elevado a 30 días" since the current LISR (in
-- force 2014-01-01). The desindexation decree (DOF 27-01-2016, in force the
-- next day) turned every legal reference to the minimum wage as a unit of
-- measure into the UMA. "30 UMA" is therefore true from 2016-01-28; before
-- that the unit was another one, and asking for an earlier date fails closed.
--
-- Additive: one row, idempotent through the unique key of 080.
INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.exempt_cap.aguinaldo_uma', '2016-01-28', '30.0000', 'UMA',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 93 fr. XIV: the year-end bonus (aguinaldo) is exempt up to 30 daily UMA per calendar year; the excess is taxed. In UMA since the desindexation decree (DOF 27-01-2016, third transitory article).')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
