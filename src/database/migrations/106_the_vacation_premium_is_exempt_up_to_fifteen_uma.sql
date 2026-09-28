-- ============================================================
-- 106 · THE VACATION PREMIUM IS EXEMPT UP TO 15 UMA (#297, MNE-001-063)
--
-- Migration 094 gave every earning an exempt and a taxable part and seeded
-- the aguinaldo cap. The vacation premium (earning_type `prima_vacacional`,
-- see 008) was still taxed whole. LISR art. 93 fr. XIV exempts it too, with
-- its own cap: 15 daily UMA per calendar year, "por cada uno de los conceptos
-- señalados", so it does not share the 30 UMA of the aguinaldo.
--
-- Only the law goes here: the columns already exist since 094.
--
-- THE VALUE IS IN UMA, NOT IN PESOS, for the reason 094 gives: the peso
-- figure is computed at the payment date from the UMA in force that day.
--
-- THE DATE is the one 094 uses and for the same reason: the fraction speaks
-- of "15 días de salario mínimo", and the desindexation decree (DOF
-- 27-01-2016, in force the next day) turned that unit into the UMA.
--
-- Additive: one row, idempotent through the unique key of 080.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.exempt_cap.vacation_premium_uma', '2016-01-28', '15.0000', 'UMA',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 93 fr. XIV: the vacation premium (prima vacacional) is exempt up to 15 daily UMA per calendar year, a cap of its own; the excess is taxed. In UMA since the desindexation decree (DOF 27-01-2016, third transitory article).')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
