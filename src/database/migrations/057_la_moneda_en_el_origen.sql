-- ============================================================
-- 057 · LA MONEDA EN EL ORIGEN (R4)
--
-- `journal_entry_lines` tiene las cuatro columnas de moneda extranjera desde
-- la 001 —currency_code, foreign_debit, foreign_credit, exchange_rate— con un
-- CHECK que las obliga a viajar juntas. Nadie las escribe: el INSERT de
-- createJournalEntry las ignora y todo asiento en dolares pierde su origen al
-- nacer. Esa parte no necesita migracion: las columnas ya estan bien.
--
-- Lo que si esta mal es la tabla de tipos de cambio, en dos sitios:
--
--   1. El CHECK de `source` no admite 'dof'. En Mexico el tipo FISCAL es el
--      publicado en el Diario Oficial de la Federacion (art. 20 CFF, el del
--      dia anterior a la operacion), y el FIX de Banxico es OTRO numero del
--      mismo dia. Un catalogo de fuentes que conoce a la Fed y a la BCE pero
--      no al DOF no puede sostener contabilidad mexicana.
--
--   2. El UNIQUE no incluye `source`: DOF y FIX del mismo dia y el mismo par
--      COLISIONAN, asi que la tabla solo puede recordar uno de los dos. La
--      eleccion de cual usar es un criterio fiscal del despacho (politica
--      `fuente_tipo_cambio`), y una politica no puede elegir entre fuentes
--      que el esquema no deja convivir.
-- ============================================================

-- ── 1. EL DOF ENTRA AL CATALOGO DE FUENTES ──────────────────────────────
ALTER TABLE exchange_rates
    DROP CONSTRAINT exchange_rates_source_check;
ALTER TABLE exchange_rates
    ADD CONSTRAINT exchange_rates_source_check
        CHECK (source IN ('manual', 'dof', 'banco_mexico', 'ecb', 'fed', 'xe', 'openexchangerates'));

COMMENT ON COLUMN exchange_rates.source IS
  'Quien publico el tipo. dof = Diario Oficial (el fiscal, art. 20 CFF); banco_mexico = FIX. Son numeros DISTINTOS del mismo dia y conviven: la politica fuente_tipo_cambio decide cual se usa para convertir.';

-- ── 2. LAS FUENTES CONVIVEN POR FECHA ───────────────────────────────────
--
-- El nombre del UNIQUE de la 001 lo autogenero Postgres (y lo trunco a 63
-- caracteres), asi que se localiza por sus columnas y no por su nombre.
DO $$
DECLARE
    viejo text;
BEGIN
    SELECT conname INTO viejo
    FROM pg_constraint
    WHERE conrelid = 'exchange_rates'::regclass
      AND contype = 'u';
    IF viejo IS NOT NULL THEN
        EXECUTE format('ALTER TABLE exchange_rates DROP CONSTRAINT %I', viejo);
    END IF;
END $$;

ALTER TABLE exchange_rates
    ADD CONSTRAINT uq_exchange_rates_par_fecha_fuente
        UNIQUE (from_currency, to_currency, effective_date, rate_type, source);
