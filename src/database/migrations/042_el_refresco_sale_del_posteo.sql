-- ============================================================
-- 042: EL REFRESCO DE LAS VISTAS SALE DE LA TRANSACCIÓN DE POSTEO
--
-- Desde la 004, CADA posteo disparaba dos REFRESH MATERIALIZED VIEW
-- CONCURRENTLY dentro de su propia transacción — sobre vistas GLOBALES que
-- cruzan TODOS los inquilinos. Tres costos a la vez: cada posteo pagaba un
-- refresco proporcional a la instalación entera y no a su asiento; los
-- posteos concurrentes de inquilinos DISTINTOS se serializaban entre sí
-- esperando el refresco del otro; y la latencia del acto contable quedaba
-- atada al tamaño de las vistas de reporte. El plan de cierre lo decidió
-- (E4.2: «DROP del trigger, refresco al worker o al comando»); esta
-- migración lo ejecuta.
--
-- El camino de reemplazo YA EXISTE y es más honesto:
--   · refresh_reporting_views() (031) — el refresco CALLABLE con lista
--     blanca de vistas, SECURITY DEFINER y search_path fijado;
--   · `mnemosine report view sync` — el comando que lo invoca;
--   · getReportingViewStatus — el detector de deriva que compara la vista
--     contra el mayor vivo y DICE si está caduca, en vez de prometer
--     frescura que costaba carísimo sostener.
-- Una vista de reporte puede estar segundos desactualizada y decirlo; un
-- posteo no puede pagar el reporte de todos los demás.
-- ============================================================

DROP TRIGGER IF EXISTS trg_refresh_materialized_views ON journal_entries;
DROP FUNCTION IF EXISTS refresh_materialized_views();
