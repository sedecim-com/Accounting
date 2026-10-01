-- ============================================================
-- 250 · THE 1099-NEC THRESHOLD AND THE BACKUP RATE COME FROM THE LAW (#124, MNE-001-332)
--
-- Two US federal figures the 1099-NEC engine reads on the last day of the
-- tax year, and one column it needs:
--
-- - The reporting threshold for nonemployee compensation: USD 600 a year
--   (IRC 6041A(a), Form 1099-NEC instructions) until the law raised it to
--   USD 2 000 for payments made after 2025-12-31 (Pub. L. 119-21 sec. 70433).
-- - The backup withholding rate: 24 % of the payment when the payee gave no
--   TIN (IRC 3406(a)(1): the fourth-lowest rate of IRC 1(c);
--   24 % since the 2018 rates).
-- - tax_form_filings.vendor_id: a 1099 is filed per payee, and the table had
--   only employee_id (008). The partial unique index makes regeneration an
--   idempotent upsert: one row per entity, form, year and vendor.
--
-- Additive: two rows of law for the threshold and one for the backup rate
-- through the unique key of 080, one nullable column, one CHECK and one partial
-- index. Nothing is rewritten.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('US', 'form_1099_nec.threshold', '2020-01-01', '600.0000', 'USD',
   'https://www.irs.gov/instructions/i1099nec',
   'IRC 6041A(a) and the Form 1099-NEC instructions: a payer reports nonemployee compensation of USD 600 or more paid to a payee in the year.'),
  ('US', 'form_1099_nec.threshold', '2026-01-01', '2000.0000', 'USD',
   'https://www.congress.gov/bill/119th-congress/house-bill/1/text',
   'Pub. L. 119-21 sec. 70433 raises the IRC 6041A threshold to USD 2 000 for payments made after 2025-12-31.'),
  ('US', 'backup_withholding.rate', '2018-01-01', '0.2400', 'rate',
   'https://www.irs.gov/taxtopics/tc307',
   'IRC 3406(a)(1): a payer withholds backup withholding at the fourth-lowest rate of IRC 1(c), 24 %, when the payee furnishes no TIN.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;

ALTER TABLE tax_form_filings
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_filings_vendor_year
  ON tax_form_filings (entity_id, form_type, tax_year, vendor_id)
  WHERE vendor_id IS NOT NULL;

-- The payee of a w2 or 1099_nec row is exactly one of employee_id or vendor_id;
-- employer-level forms (941, 940, SUA) carry neither, so a reader of those must
-- filter on form_type, not only on employee_id IS NULL.
ALTER TABLE tax_form_filings
  ADD CONSTRAINT chk_tax_filings_one_payee
  CHECK (NOT (employee_id IS NOT NULL AND vendor_id IS NOT NULL));

COMMENT ON COLUMN tax_form_filings.employee_id IS
  'Payee of a w2 row (an employee). NULL for employer-level forms and for 1099_nec, whose payee is vendor_id. Never set together with vendor_id.';
COMMENT ON COLUMN tax_form_filings.vendor_id IS
  'Payee of a 1099_nec row (a vendor). NULL for employer-level forms and for w2, whose payee is employee_id. Never set together with employee_id.';
