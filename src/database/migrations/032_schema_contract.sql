-- ============================================================
-- 032 · Contrato código ↔ esquema (paquete E0.2)
--
-- El test tests/integration/schema-contract.int.spec.ts destapó consultas
-- contra tablas y columnas que no existen. La mayoría se arregla en el
-- código; estas tres piezas faltaban de verdad en el esquema:
--
-- 1. Dirección fiscal y registro patronal de la entidad. Los generadores de
--    W-2 y W-3 los piden porque el formato los exige, y el CFDI de nómina
--    necesita el registro patronal. No existían en ninguna tabla: solo
--    `employees` tenía columnas de dirección.
-- 2. tax_form_filings.provider: el canal por el que se presentó la
--    declaración (ssa_bso, un despacho, etc.). Sin columna propia quedaría
--    enterrado en el jsonb `data` y no se podría consultar.
-- 3. La restricción única que employee_benefit_elections necesita para su
--    ON CONFLICT (employee_id, benefit_plan_id): el código ya la usaba y
--    habría fallado en tiempo de ejecución.
-- ============================================================

ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS city VARCHAR(120),
  ADD COLUMN IF NOT EXISTS state_province VARCHAR(120),
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20),
  -- Registro patronal ante el IMSS: obligatorio en el complemento de nómina
  -- del CFDI cuando la entidad tiene trabajadores.
  ADD COLUMN IF NOT EXISTS imss_registro_patronal VARCHAR(20);

ALTER TABLE tax_form_filings
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50);

-- Una elección vigente por trabajador y plan. Sin este índice el ON CONFLICT
-- del servicio de prestaciones no tiene destino y la consulta revienta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_benefit_election_employee_plan
  ON employee_benefit_elections (employee_id, benefit_plan_id);
