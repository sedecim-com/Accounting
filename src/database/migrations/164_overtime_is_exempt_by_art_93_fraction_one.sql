-- ============================================================
-- 164 · OVERTIME IS EXEMPT BY LISR ART. 93 FR. I (#297, MNE-001-110)
--
-- Migrations 094 and 106 seeded the fr. XIV caps. Overtime (earning_type
-- `overtime`, see 008) was still taxed whole. Fraction I, as read on
-- 2026-09-30 in the text published by the Chamber of Deputies (last reform
-- DOF 01-04-2024; the fraction is unchanged since the law of 2014), says:
--
--   "Tratándose de los demás trabajadores, el 50% de las remuneraciones por
--    concepto de tiempo extraordinario [...] que no exceda el límite previsto
--    en la legislación laboral y sin que esta exención exceda del equivalente
--    de cinco veces el salario mínimo general del área geográfica del
--    trabajador por cada semana de servicios."
--
-- Three numbers, each with its own source and date:
--   · the exempt share, 50 %: LISR in force since 2014-01-01;
--   · the cap, 5 UMA per week: in UMA since the desindexation decree (DOF
--     27-01-2016, third transitory article, in force the next day), the
--     same date 094 and 106 use;
--   · the labour limit, in hours a week, which is DATED: LFT art. 66 set 9
--     ("tres horas diarias ni de tres veces en una semana") from 1970. The
--     reform of DOF 01-05-2026 (the shorter working week) rewrote art. 66
--     to 12 hours a week and, by its fourth transitory article, reaches it
--     gradually from 1 January of each year: 9 in 2026 and 2027, 10 in 2028,
--     11 in 2029, 12 from 2030. Hours beyond the limit are paid triple (LFT
--     art. 68) and are not exempt.
--
-- Whether a firm applies the exemption at all is the panel's key
-- `overtime_isr_exemption`; these rows are only the law.
--
-- Additive: six rows, idempotent through the unique key of 080.
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'income_tax.exempt_share.overtime', '2014-01-01', '0.5000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 93 fr. I, second sentence: for workers above the minimum wage, 50 % of overtime pay within the labour-law limit is exempt; the rest is taxed (fr. II).'),
  ('MX', 'income_tax.exempt_cap.overtime_uma_per_week', '2016-01-28', '5.0000', 'UMA',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'LISR art. 93 fr. I: the overtime exemption may not exceed 5 times the daily minimum wage per week of services. In UMA since the desindexation decree (DOF 27-01-2016, third transitory article).'),
  ('MX', 'labor.overtime.double_hours_per_week', '1970-05-01', '9.0000', 'hours',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 66 (1970): overtime may not exceed three hours a day nor three times a week, paid double; hours beyond it are paid triple (art. 68) and fall outside the LISR art. 93 fr. I exemption. Kept at 9 for 2026 and 2027 by the fourth transitory article of the reform of DOF 01-05-2026.'),
  ('MX', 'labor.overtime.double_hours_per_week', '2028-01-01', '10.0000', 'hours',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 66 as reformed by DOF 01-05-2026, fourth transitory article: the weekly overtime limit is 10 hours in 2028.'),
  ('MX', 'labor.overtime.double_hours_per_week', '2029-01-01', '11.0000', 'hours',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 66 as reformed by DOF 01-05-2026, fourth transitory article: the weekly overtime limit is 11 hours in 2029.'),
  ('MX', 'labor.overtime.double_hours_per_week', '2030-01-01', '12.0000', 'hours',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf',
   'LFT art. 66 as reformed by DOF 01-05-2026 (twelve hours a week, up to four a day on at most four days), reached in 2030 by its fourth transitory article.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
