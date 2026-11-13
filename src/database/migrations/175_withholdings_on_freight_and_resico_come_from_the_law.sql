-- ============================================================
-- 175 · WITHHOLDINGS ON FREIGHT AND RESICO COME FROM THE LAW (#309, MNE-001-057)
--
-- Two more rates for the classifier (src/services/xml-ingestion/withholding-law.ts),
-- next to the three of migration 129:
--
-- - A legal entity that receives land freight of goods withholds 4 % of the
--   consideration as VAT, whoever the carrier is. The current RLIVA
--   (DOF 04-12-2006) is in force since the day after its publication, the
--   date 129 uses for the two thirds.
-- - A legal entity that pays an individual in the simplified regime (RESICO)
--   withholds 1.25 % of the amount paid, without VAT. LISR 113-J was added by
--   the reform published in the DOF on 12-11-2021, in force since 2022-01-01.
--
-- Additive: two rows, idempotent through the unique key of 080.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'vat.withholding.freight_rate', '2006-12-05', '0.0400', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LIVA_250914.pdf',
   'LIVA art. 1-A fr. II c) and RLIVA art. 3 fr. II: a legal entity receiving land freight of goods withholds 4 % of the consideration as VAT.'),
  ('MX', 'income_tax.withholding.resico_rate', '2022-01-01', '0.0125', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 113-J, fifth paragraph: a legal entity paying an individual taxed under the simplified regime (RESICO) withholds 1.25 % of the amount paid, without VAT.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
