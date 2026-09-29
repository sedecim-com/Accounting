-- ============================================================
-- 138 · THE VENDOR HOLDS THE 2025 DIOT OPERATION TYPES (MNE-001-055, #307)
--
-- Migration 066 fixed vendors.tipo_operacion to the catalogue it knew:
-- 03 professional services, 06 leasing, 85 other. The SAT batch layout for
-- fiscal years 2025 onward (Instructivo para el armado del archivo de carga
-- masiva DIOT, Enero 2025, §3.1) uses a wider catalogue:
--
--   02 transfer of goods · 03 professional services · 06 temporary use or
--   enjoyment of goods · 07 import of goods or services · 08 import by
--   virtual transfer · 85 other · (87 global operations, implied by type 15)
--
-- and a foreign supplier (type 05) accepts only 02, 03 and 07. With the old
-- CHECK every foreign supplier had to be declared as 03 or refused, and a
-- national supplier of goods could not be declared as 02 at all.
--
-- Which operation type fits which third-party type is checked when the DIOT
-- is built (tercero.ts, OPERATIONS_BY_PARTY_TYPE), not here: the column holds
-- the catalogue, and the build names the vendor whose pair is not accepted.
-- 87 is not stored: it follows from third-party type 15.
--
-- Widening only: every value the old CHECK accepted is still accepted.
-- ============================================================

ALTER TABLE vendors
    DROP CONSTRAINT IF EXISTS vendors_tipo_operacion_check,
    ADD CONSTRAINT vendors_tipo_operacion_check
        CHECK (tipo_operacion IN ('02', '03', '06', '07', '08', '85'));

COMMENT ON COLUMN vendors.tipo_operacion IS
  'DIOT operation type, 2025 catalogue (SAT instructivo de carga masiva, Enero 2025, §3.1): 02 transfer of goods, 03 professional services, 06 temporary use of goods, 07 import of goods or services, 08 import by virtual transfer, 85 other. A foreign supplier (05) accepts 02, 03 and 07; the DIOT build refuses any other pair and names the vendor. When empty, the panel keys diot_tipo_operacion_por_omision (national) and diot_default_operation_type_foreign decide.';
