-- ============================================================
-- 120 · THE ENTITY KNOWS ITS TAX REGIME (#321 · MNE-001-017)
--
-- legal_entities carried the RFC and nothing else of its fiscal identity,
-- while customers have had c_RegimenFiscal and the fiscal postal code since
-- 049. The company keeping the books is the one whose regime decides
-- withholdings (#309), the provisional ISR (#308) and the payroll CFDI's
-- RegimenFiscal/LugarExpedicion (#92), so the data has to exist first.
--
-- Same shape as 049 on customers, and for the same reason: no hard CHECK.
-- The codes live in sat-catalogs.ts and the service validates against them;
-- a CHECK here would need a migration every time the SAT publishes a code.
--
-- Both nullable: every existing entity lacks them, and `entity create`
-- warns about a Mexican entity without a regime instead of refusing it.
-- Pure DDL: no rows are read or written, so RLS has nothing to hide here.
-- ============================================================

ALTER TABLE legal_entities
    ADD COLUMN tax_regime VARCHAR(3),
    ADD COLUMN tax_postal_code VARCHAR(5);

COMMENT ON COLUMN legal_entities.tax_regime IS
  'c_RegimenFiscal of the entity (601, 612, 626...). Validated against sat-catalogs.ts by the service, not by a CHECK. NULL = not declared yet.';
COMMENT ON COLUMN legal_entities.tax_postal_code IS
  'Postal code of the entity''s fiscal address (5 digits), the CFDI LugarExpedicion. NULL = not declared yet.';
