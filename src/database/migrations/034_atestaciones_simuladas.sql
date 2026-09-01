-- ============================================================
-- 034: UNA ATESTACIÓN SIMULADA SE DECLARA COMO TAL
--
-- Los adaptadores de cadena no anclan nada. `simulateBlockNumber()`,
-- `simulateGasCost()` y un `confirmations: 12` fijo fabrican la prueba
-- entera: no hay transacción en ninguna red, no hay hash que nadie pueda
-- comprobar. Y esas filas se sirven SIN AUTENTICACIÓN por /public/v1, cuyo
-- propósito es precisamente que un tercero se las crea.
--
-- Es la misma clase de superficie que se retiró en CLI-5 —reportar el éxito
-- de un acto que no se ejecuta— y la peor variante: un timbre inventado
-- engaña a quien lo emitió; una atestación inventada engaña a su auditor.
--
-- EL DEFECTO ES true, Y ES DELIBERADO. Todo lo escrito hasta hoy es
-- simulado, así que un DEFAULT false relabelaría como real un histórico
-- entero de datos fabricados. Cuando exista un adaptador que ancle de
-- verdad, será él quien escriba false, fila por fila y por haberlo hecho.
-- ============================================================

ALTER TABLE blockchain_attestations
  ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE period_commitments
  ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE published_aggregates
  ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN blockchain_attestations.is_simulated IS
  'true cuando el hash NO se ancló en ninguna cadena. /public/v1 se niega a servirlas: una prueba fabricada es peor que ninguna.';
COMMENT ON COLUMN period_commitments.is_simulated IS
  'true cuando el compromiso no se ancló. Ver blockchain_attestations.is_simulated.';
COMMENT ON COLUMN published_aggregates.is_simulated IS
  'true cuando los agregados se publicaron contra una atestación simulada.';

-- Los índices que /public/v1 usa para filtrarlas.
CREATE INDEX IF NOT EXISTS idx_attestations_reales
  ON blockchain_attestations (entry_hash) WHERE is_simulated = false;
CREATE INDEX IF NOT EXISTS idx_commitments_reales
  ON period_commitments (entity_id, period_id) WHERE is_simulated = false;
