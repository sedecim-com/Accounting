-- ============================================================
-- 060 · LA CORRIDA QUE SE ABRE ANTES DEL BUCLE
--
-- `ai_ingest_runs` (044) guarda UNA fila por corrida de `mnemosine ingest`, y
-- la escribe DESPUÉS del bucle, con todos los contadores ya finales. Una
-- corrida de 2 000 CFDI que muere en el archivo 1 500 —SIGTERM de un
-- despliegue, el OOM killer, la máquina que se apaga— deja mil quinientos
-- documentos registrados y sus asientos en el mayor, y CERO filas de corrida:
-- a la mañana siguiente el contador ve asientos nuevos y no existe registro
-- que diga qué corrida los produjo, con qué modelo, con qué umbrales ni
-- cuántos quedaron sin procesar.
--
-- La tabla YA admitía abrirse antes de actuar: todos los contadores tienen
-- DEFAULT 0, y duration_ms y estimated_cost_usd son nulables. Lo que le
-- faltaba es poder distinguir «murió a medias» de «corrió y no encontró
-- nada»: una fila abierta que nunca se cierra es indistinguible de una
-- corrida vacía, y eso es PEOR que no tener fila, porque miente con aspecto
-- de dato.
--
-- Se añaden tres columnas y ninguna sobra:
--
--   · status — 'running' | 'completed' | 'failed'. Sin el estado, unos ceros
--     no dicen si nadie encontró nada o si nadie llegó a contar. El patrón
--     correcto ya vivía a tres archivos de distancia: ai_external_ops abre en
--     'executing' ANTES de actuar y cierra después, y su recuperación manual
--     se apoya en que el estado intermedio existe.
--   · closed_at — CUÁNDO se cerró. El estado solo no basta: `duration_ms`
--     sólo se escribe al cerrar, así que una fila que quedó en 'running' no
--     tiene de dónde sacar cuándo dejó de vivir, y una consulta de corridas
--     varadas no puede ordenar por antigüedad de la muerte. Con la fecha,
--     `closed_at IS NULL AND created_at < now() - 6h` es la señal de que
--     alguien murió a media noche.
--   · error — POR QUÉ murió. Un 'failed' sin razón manda al humano a releer
--     terminales, que es exactamente lo que esta tabla existe para evitar.
--
-- El CHECK las ata: en 'running' NO hay fecha de cierre, y fuera de 'running'
-- la hay SIEMPRE. Un cierre a medias —estado nuevo sin fecha, o fecha sin
-- estado— no puede escribirse aunque el código se equivoque.
--
-- OJO CON created_at. Desde esta migración la fila NACE al abrir, así que su
-- created_at es el INICIO de la corrida. En las filas anteriores el INSERT
-- iba después del bucle: su created_at es el instante del CIERRE. Por eso el
-- relleno les pone closed_at = created_at —que es la verdad de esas filas— y
-- NO les inventa un inicio restando duration_ms.
--
-- EL CIERRE ES UN UPDATE, Y AQUÍ NO PISA A NADIE. La 041 protege el mayor con
-- disparadores BEFORE UPDATE OR DELETE, pero sobre journal_entries y
-- journal_entry_lines; ai_ingest_runs no tiene ningún disparador (el censo de
-- CREATE TRIGGER del árbol son 001, 004, 033, 035, 041 y 051, y ninguno la
-- nombra). Tampoco entra en el array `append_only` de rls-policies.sql —que
-- lista exactamente audit_log y fiscal_credential_access_log—, así que
-- mnemosine_app conserva su GRANT de UPDATE sobre ella y el reprovisionado no
-- se lo quita. Esta tabla es una máquina de estados, no una bitácora de sólo
-- agregar, y esa distinción es la que el comentario de rls-policies.sql pide
-- que se haga a mano.
-- ============================================================

ALTER TABLE ai_ingest_runs
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'running',
    ADD COLUMN closed_at TIMESTAMPTZ,
    ADD COLUMN error TEXT;

-- Las filas de la era 044 se escribían al TERMINAR: todas son corridas
-- cerradas y completas. Sin este relleno nacerían en 'running' y la primera
-- consulta de «corridas varadas» las delataría todas como muertas — un
-- histórico entero convertido en falsa alarma por una migración.
-- POR INQUILINO, Y DECLARÁNDOLO (#88). `ai_ingest_runs` declara tenant_id NOT
-- NULL, así que rls-policies.sql le pone ENABLE + FORCE ROW LEVEL SECURITY con
-- su política tenant_isolation, y el dueño del esquema —NOSUPERUSER
-- NOBYPASSRLS por scripts/provision-roles.sql:59-60— queda SUJETO a ella.
--
-- Sin este bucle el UPDATE no rellenaba cero filas en silencio: REVENTABA con
-- 42501 y revertía el archivo entero —columnas, CHECKs, índice y comentarios—
-- en cualquier despacho ya instalado, porque migrate.ts corre la sesión con
-- row_security=off y eso convierte el filtrado silencioso en error. Es el
-- mismo patrón sancionado de la 025, 026, 043, 048, 051 y 053; ésta se quedó
-- fuera, y por eso `npm run migrate` moría aquí.
SET LOCAL row_security = on;
DO $cierre$
DECLARE
    t        record;
    cerradas bigint := 0;
    parcial  bigint;
BEGIN
    FOR t IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.current_tenant', t.id::text, true);

        UPDATE ai_ingest_runs
           SET status = 'completed',
               closed_at = created_at;

        GET DIAGNOSTICS parcial = ROW_COUNT;
        cerradas := cerradas + parcial;
    END LOOP;
    -- Se devuelve el contexto a vacío, como hacen las seis hermanas: dejar el
    -- último inquilino puesto para el resto de la transacción es un residuo
    -- que no muerde hoy —lo que sigue es DDL— y muerde el día que alguien
    -- añada una sentencia de datos debajo.
    PERFORM set_config('app.current_tenant', '', true);

    RAISE NOTICE 'Corridas históricas cerradas: %', cerradas;
END
$cierre$;

ALTER TABLE ai_ingest_runs
    ADD CONSTRAINT ai_ingest_runs_status_check
        CHECK (status IN ('running', 'completed', 'failed')),
    -- La equivalencia, no dos CHECK sueltos: 'running' ⟺ sin fecha de cierre.
    ADD CONSTRAINT ai_ingest_runs_cierre_check
        CHECK ((status = 'running') = (closed_at IS NULL));

-- Parcial y estrecho: la pregunta operativa no es «dame todas las corridas»
-- sino «¿hay alguna abierta que no debería estarlo?», y esa lista es corta.
CREATE INDEX idx_ai_ingest_runs_abiertas
    ON ai_ingest_runs(tenant_id, created_at)
    WHERE status = 'running';

COMMENT ON COLUMN ai_ingest_runs.status IS
  'running = la fila se abrió antes del bucle y nadie la cerró (corriendo AHORA, o muerta a medias); completed = el bucle terminó y los contadores son finales; failed = reventó y el cierre alcanzó a escribir la razón en error. Los ceros de una fila que no está en completed son «no se llegó a contar», jamás «no había nada».';

COMMENT ON COLUMN ai_ingest_runs.closed_at IS
  'Instante del cierre. NULL exactamente mientras status = running (lo obliga ai_ingest_runs_cierre_check). Una fila con closed_at NULL y created_at de hace horas es una corrida que murió sin cerrar.';

COMMENT ON COLUMN ai_ingest_runs.error IS
  'Por qué murió la corrida (sólo en failed). Truncado por el escritor: un stack de megabytes no cabe en una fila de bitácora ni le sirve a nadie.';

COMMENT ON COLUMN ai_ingest_runs.created_at IS
  'Desde la 058, el INICIO de la corrida: la fila se abre ANTES del primer archivo. En las filas anteriores a la 058 es el instante del CIERRE (el INSERT iba después del bucle), y por eso su closed_at es igual a su created_at.';
