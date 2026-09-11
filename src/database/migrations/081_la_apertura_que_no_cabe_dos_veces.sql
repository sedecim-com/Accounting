-- ============================================================
-- 081 · LA APERTURA QUE NO CABE DOS VECES (O1 · WIT-01 de #217)
--
-- `importOpeningBalance` ya se negaba a cargar una apertura dos veces, pero lo
-- hacía con un `SELECT … LIMIT 1` FUERA de la transacción que postea el
-- asiento. Entre esa consulta y el INSERT cabe otra corrida entera: las dos ven
-- cero filas, las dos postean, y los saldos de apertura quedan DUPLICADOS de
-- una sola vez. Es el accidente más caro que esta superficie puede tener —una
-- apertura mueve el balance entero— y no puede depender de una ventana TOCTOU.
--
-- El importador del catálogo no tiene este problema porque se apoya en el
-- `UNIQUE(code, entity_id)` que ya existe; la apertura no tenía nada detrás.
-- La 001 sólo indexa `(source_type, source_id)` SIN unicidad, y la unicidad de
-- documento de la 025 excluye expresamente este `source_type`.
--
-- ── POR QUÉ ENTIDAD + FECHA, Y NO SÓLO ENTIDAD ─────────────────────────
--
-- La apertura se ancla al primer día de un ejercicio, y una entidad puede tener
-- más de uno (una migración que traiga dos años, un ejercicio irregular). La
-- llave es la misma que la comprobación previa ya usaba, para que el índice y
-- el mensaje no puedan divergir.
--
-- ── POR QUÉ `status <> 'void'` ──────────────────────────────────────────
--
-- Una apertura ANULADA tiene que poder rehacerse: anular es una corrección, no
-- una condena, y el propio mensaje de `APE-YA-CARGADA` le dice al operador que
-- anule y vuelva a correr. Si el índice contara las anuladas, ese consejo sería
-- imposible de seguir.
--
-- El `SELECT` previo se queda, y baja de rango: ya no es la garantía sino el
-- diagnóstico —es quien puede decir CUÁL asiento estorba y qué hacer—. La
-- garantía es esta línea.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_je_apertura_por_entidad_y_fecha
    ON journal_entries (entity_id, entry_date)
    WHERE source_type = 'opening_balance' AND status <> 'void';
