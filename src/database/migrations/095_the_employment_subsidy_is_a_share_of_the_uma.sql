-- ============================================================
-- 095 · THE EMPLOYMENT SUBSIDY IS A SHARE OF THE UMA (#298, MNE-001-064)
--
-- Migration 009 seeded the employment subsidy as the bracket table repealed
-- on 1 May 2024 (407.02 … 217.61, with the 2025 cap of 10 171.00), and the
-- calculator kept reading it. Migration 073 left it out on purpose — «queda su
-- issue» — because the decree gives a percentage and no rounding. The rounding
-- is now a policy (`subsidio_al_empleo_redondeo`, MNE-001-004), so the law
-- can be loaded as what it is: three dated figures.
--
--   · employment_subsidy.uma_monthly_rate — 15.59 % in January 2026, applied
--     to the 2025 UMA (the 2026 UMA only takes effect on February 1st), and
--     15.02 % from February 1st (DOF 31-12-2025; the January rate is its
--     Segundo transitorio).
--   · employment_subsidy.monthly_income_cap — 11 492.66 from 1 January 2026.
--   · uma.monthly — the MONTHLY UMA as INEGI publishes it (3 439.46 from
--     1 Feb 2025, 3 566.22 from 1 Feb 2026). The published figure and not
--     `uma.daily × 30.4`: the decree names the monthly value, and rounding it
--     here would be a second, unsourced rounding under the one the policy
--     declares.
--
-- WHY A MIGRATION AND NOT ONLY THE SEEDER: same reason as 082. The table is
-- born empty, `seedLegalParameters` only runs from the demo seeder, and the
-- payroll engine now reads these rows on every Mexican paycheck: without them
-- a migrated, unseeded install could not compute a pay run.
--
-- The 009 rows are NOT deleted: they are history and nothing reads them any
-- more. Idempotent by the 080 unique key (jurisdiction, key, effective_from).
-- ============================================================

INSERT INTO legal_parameters (jurisdiction, key, effective_from, value, unit, source_url, source_note)
VALUES
  ('MX', 'uma.monthly', '2025-02-01', '3439.4600', 'MXN',
   'https://dof.gob.mx/nota_detalle.php?codigo=5746930&fecha=10/01/2025',
   'UMA 2025 published by INEGI in the DOF on 10-01-2025: daily 113.14, monthly 3,439.46, annual 41,273.52, in force from 1 February 2025 (LDVUMA art. 5). It governs January 2026, which is why the January 2026 subsidy rate is applied to it.'),
  ('MX', 'uma.monthly', '2026-02-01', '3566.2200', 'MXN',
   'https://dof.gob.mx/nota_detalle.php?codigo=5778072&fecha=09/01/2026',
   'UMA 2026 published by INEGI in the DOF on 09-01-2026: daily 117.31, monthly 3,566.22, annual 42,794.64, in force from 1 February 2026 (LDVUMA art. 5).'),
  ('MX', 'employment_subsidy.uma_monthly_rate', '2026-01-01', '0.1559', 'rate',
   'https://dof.gob.mx/nota_detalle.php?codigo=5777649&fecha=31/12/2025',
   'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025, Segundo transitorio: in January 2026 the monthly subsidy is 15.59 % of the monthly UMA in force, which is still the 2025 UMA (= 536.21 rounded once to the cent).'),
  ('MX', 'employment_subsidy.uma_monthly_rate', '2026-02-01', '0.1502', 'rate',
   'https://dof.gob.mx/nota_detalle.php?codigo=5777649&fecha=31/12/2025',
   'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025: the monthly subsidy is 15.02 % of the monthly UMA (= 535.65 with the 2026 UMA); for periods shorter than a month it is divided by 30.4 and multiplied by the days. How to round is the policy subsidio_al_empleo_redondeo.'),
  ('MX', 'employment_subsidy.monthly_income_cap', '2026-01-01', '11492.6600', 'MXN',
   'https://dof.gob.mx/nota_detalle.php?codigo=5777649&fecha=31/12/2025',
   'Decreto que modifica el subsidio para el empleo, DOF 31-12-2025: only workers whose monthly income does not exceed 11,492.66 receive the subsidy. Replaces the 10,171.00 of the DOF 31-12-2024 decree.')
ON CONFLICT (jurisdiction, key, effective_from) DO NOTHING;
