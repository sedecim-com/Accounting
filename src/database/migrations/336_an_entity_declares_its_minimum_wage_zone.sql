-- ============================================================
-- 336 · AN ENTITY DECLARES ITS MINIMUM-WAGE ZONE (#196 · MNE-001-377)
--
-- LFT art. 486 caps the base of the seniority premium at twice the minimum
-- wage «del área geográfica de aplicación a que corresponda el lugar de
-- prestación del trabajo», and LFT arts. 90-92 tie each general minimum to
-- its area. In 2026 the CONASAMI resolution (DOF 09-12-2025) fixes 315.04 for
-- the general area and 440.87 for the Zona Libre de la Frontera Norte. The
-- schema had nowhere to keep the zone, so `salario_minimo_frontera_diario`
-- (seeded in 009, corrected in 074) had no reader and every finiquito was
-- capped with the general minimum.
--
-- WHAT IT ADDS
--   legal_entities.minimum_wage_zone           NOT NULL, default 'general'
--   legal_entities.minimum_wage_zone_declared_at  NULL until someone declares it
--   employees.minimum_wage_zone                NULL = the entity's zone
--
-- WHY TWO COLUMNS ON THE ENTITY. The zone is never NULL, so every reader has
-- one; but decision MNE-001-376 (#196, 18 Nov 2026) says that with no zone
-- declared the calculation uses the general minimum AND SAYS SO. A default
-- alone cannot tell «declared general» from «nobody said»: the date can.
-- `mnemosine entity create|edit --minimum-wage-zone` sets both.
--
-- WHAT IT DOES NOT TOUCH. No row is written: every existing entity reads
-- 'general', undeclared, which is the figure it was already computed with, so
-- nothing changes on deploy. Adding a column with a constant default is a
-- catalog change and runs no UPDATE under RLS.
-- ============================================================

ALTER TABLE legal_entities
    ADD COLUMN minimum_wage_zone TEXT NOT NULL DEFAULT 'general'
        CONSTRAINT legal_entities_minimum_wage_zone_check
        CHECK (minimum_wage_zone IN ('general', 'northern_border')),
    ADD COLUMN minimum_wage_zone_declared_at TIMESTAMPTZ;

ALTER TABLE employees
    ADD COLUMN minimum_wage_zone TEXT
        CONSTRAINT employees_minimum_wage_zone_check
        CHECK (minimum_wage_zone IN ('general', 'northern_border'));

COMMENT ON COLUMN legal_entities.minimum_wage_zone IS
  'Minimum-wage area of the entity''s workplace and IMSS employer registration: general or northern_border (Zona Libre de la Frontera Norte). Caps the seniority premium (LFT art. 486).';
COMMENT ON COLUMN legal_entities.minimum_wage_zone_declared_at IS
  'When someone declared minimum_wage_zone. NULL = still the migration default; calculations say so.';
COMMENT ON COLUMN employees.minimum_wage_zone IS
  'Override of the entity''s minimum-wage area for a worker who works in another zone. NULL = the entity''s.';
