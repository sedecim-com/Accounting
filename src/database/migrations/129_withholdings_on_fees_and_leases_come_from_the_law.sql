-- ============================================================
-- 129 · WITHHOLDINGS ON FEES AND LEASES COME FROM THE LAW (#309, MNE-001-056)
--
-- A legal entity that pays an individual for professional services or for the
-- use of real estate withholds 10 % of ISR and two thirds of the VAT
-- transferred to it. The system only booked whatever the CFDI declared; these
-- rows give the classifier the law to compute it with
-- (src/services/xml-ingestion/withholding-law.ts).
--
-- THE TWO THIRDS ARE STORED AS THIRDS, not as 0.6667: a rounded fraction is a
-- cent off on every large invoice, and the regulation speaks in thirds.
--
-- THE DATES: the current LISR (DOF 11-12-2013) is in force since 2014-01-01,
-- the date 088 and the seeder use for their LISR rows; the current RLIVA
-- (DOF 04-12-2006) since the day after its publication. The regulation URL is
-- the one the audited report verified (fiscal-mx.md, source 5).
--
-- Additive: three rows, idempotent through the unique key of 080.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.withholding.professional_fees_rate', '2014-01-01', '0.1000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 106, last paragraph: a legal entity paying an individual for professional services withholds 10 % of the payment, without any deduction, as a provisional payment.'),
  ('MX', 'income_tax.withholding.lease_rate', '2014-01-01', '0.1000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 116, third paragraph: a legal entity paying an individual for the use of real estate withholds 10 % of the payment, without any deduction, as a provisional payment.'),
  ('MX', 'vat.withholding.individual_thirds', '2006-12-05', '2.0000', 'thirds',
   'https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LIVA_250914.pdf',
   'LIVA art. 1-A fr. II a) and RLIVA art. 3 fr. I: a legal entity receiving independent personal services or the use of goods from an individual withholds two thirds of the VAT transferred to it.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
