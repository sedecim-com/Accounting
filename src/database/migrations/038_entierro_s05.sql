-- ============================================================
-- 038: EL ENTIERRO DE S0.5 — SEIS TABLAS QUE NADIE TOCÓ JAMÁS
--
-- Censo verificado tabla por tabla: cero escritores, cero lectores, cero
-- menciones en src, y cero claves foráneas entrantes. No es limpieza
-- estética: capacidad muerta que sobrevive es la que un día alguien cablea
-- sin contexto — así estuvo a un import de duplicar ingresos
-- `recordInventorySale` (S0.4). Una tabla que no existe no se puede cablear
-- por accidente.
--
--   · transactions            (001) — un mayor genérico paralelo que el
--     diseño real sustituyó por journal_entries desde el primer día.
--   · custom_reports          — los reportes viven en report-service; un
--     almacén de definiciones a medida es aspiración de fase 3, y su fila
--     acaba de salir del objetivo por el corte mecánico de S0.5.
--   · blockchain_jobs         — el drenado de atestaciones usa su propia
--     cola en memoria y los trabajos programados usan scheduled_jobs.
--   · integration_events      \
--   · integration_mappings     > un diseño paralelo de sincronización que
--   · integration_sync_jobs   / nunca se cableó: la integración real corre
--     por ai_external_ops (la bandeja de salida) y el registro de
--     adaptadores. Las filas fase 1 de la familia `integration` se
--     construyen sobre ESO, no sobre estas tres.
--
-- Lo que NO se entierra, y por qué, queda RECLAMADO con nombre en el
-- criterio de plan (src/plan/criterios.ts, «tabla muerta enterrada o
-- reclamada»): asset_categories, fixed_assets y depreciation_schedules son
-- de F06/DEP-2 (fixed_assets.category_id las ata por FK); inventory_items,
-- inventory_layers e inventory_layer_consumption son de la familia de
-- inventario, cuyo motor S0.4 declaró neto nuevo pero cuyo esquema sí es el
-- diseñado. Reclamar es una promesa con dueño; enterrar es la respuesta
-- para lo que no lo tiene.
--
-- DROP IF EXISTS: idempotente, y una base donde alguien ya las borró a mano
-- no debe romper la corrida.
-- ============================================================

DROP TABLE IF EXISTS integration_sync_jobs;
DROP TABLE IF EXISTS integration_mappings;
DROP TABLE IF EXISTS integration_events;
DROP TABLE IF EXISTS blockchain_jobs;
DROP TABLE IF EXISTS custom_reports;
DROP TABLE IF EXISTS transactions;
