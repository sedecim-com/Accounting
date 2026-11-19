-- ============================================================
-- 329 · THE EMPLOYMENT SUBSIDY IN EXCESS OF THE ISR FOLLOWS THE LAW OF THE
-- PAYMENT DATE (#600, MNE-001-440, part 1 of 3)
--
-- When the subsidy of a paycheck is larger than its ISR, what happens to the
-- difference is law with a date, not a policy of the firm:
--
--   · from 1 January 2014 the employer hands it to the worker in cash and
--     credits it against ISR (Decreto DOF 11-12-2013, Artículo Décimo);
--   · from 1 May 2024 nothing is handed over and the difference is not
--     carried forward (Decreto DOF 01-05-2024, Artículo Segundo).
--
-- employment_subsidy.excess_over_isr_paid_share is the share of that excess
-- the employer pays to the worker: 1 or 0. A numeric share because the table
-- holds figures only; its reader accepts exactly 0 or 1.
--
-- WHY A MIGRATION AND NOT ONLY THE SEEDER: the reason of 082 and 095. The
-- payroll engine will read this row on every Mexican paycheck (part 2 of 3),
-- and `seedLegalParameters` only runs from the demo seeder. Nothing reads the
-- rows yet, so no paycheck changes with this migration.
--
-- Data only: no table, column, constraint or policy. Idempotent by the 080
-- unique key (jurisdiction, key, effective_from).
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'employment_subsidy.excess_over_isr_paid_share', '2014-01-01', '1.0000', 'rate',
   'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf',
   'Decreto DOF 11-12-2013 (the one that issues the LISR), Artículo Décimo, fracción I, in force 1 January 2014 (its Transitorio Primero): when the ISR of art. 96 is smaller than the employment subsidy, «el retenedor deberá entregar al contribuyente la diferencia que se obtenga», and may credit what it hands over against its own ISR or the ISR withheld from others. 1 = the whole excess over the ISR is paid to the worker in cash.'),
  ('MX', 'employment_subsidy.excess_over_isr_paid_share', '2024-05-01', '0.0000', 'rate',
   'https://dof.gob.mx/nota_detalle.php?codigo=5725287&fecha=01/05/2024',
   'Decreto que otorga el subsidio para el empleo, DOF 01-05-2024, Artículo Segundo, in force 1 May 2024 (its Transitorio Primero): when the ISR is smaller than the subsidy, «la diferencia no podrá aplicarse contra el impuesto que resulte a su cargo posteriormente, ni se entregará cantidad alguna por concepto del subsidio para el empleo». 0 = nothing of the excess over the ISR is paid; it replaces the Artículo Décimo of the DOF 11-12-2013 decree.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
