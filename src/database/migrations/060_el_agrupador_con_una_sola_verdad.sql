-- ============================================================
-- 060 · EL AGRUPADOR CON UNA SOLA VERDAD (F07a)
--
-- El código agrupador del SAT es la pieza sobre la que se construye TODO el
-- Anexo 24: sin él no hay catálogo de cuentas que entregar. Y hoy hay TRES
-- versiones de dónde vive:
--
--   1. `accounts.mx_nif_code` (001) es la que se escribe: `setAccountMapping`
--      manda ahí el esquema 'sat-agrupador'.
--   2. `accounts.codigo_agrupador_sat` (037) es la que la 037 creó PARA ESTO,
--      con un COMMENT que promete «el checklist de F07 exigirá que ninguna
--      cuenta con movimientos lo tenga vacío». Cero lectores, cero escritores.
--   3. La tarjeta del catálogo de comandos afirma que no hay columna ninguna.
--
-- La consolidación no es elegir la que tiene datos: es notar que las dos NO
-- SON LA MISMA COSA. `mx_nif_code` nació hermana de `us_gaap_code` y de
-- `ifrs_code` (001), o sea una familia de códigos de NORMA CONTABLE — cómo se
-- PRESENTA una cuenta bajo NIF, US-GAAP o IFRS. El agrupador del SAT es
-- FISCAL: cómo la AGRUPA la autoridad para leer la contabilidad del
-- contribuyente. Meter el agrupador en la casilla de la norma contable
-- funcionaba mientras nadie usara la otra; el día que una entidad necesite
-- las dos, una pisa a la otra en silencio.
-- ============================================================

-- ── 1. LOS DATOS SE MUDAN A LA COLUMNA QUE LES CORRESPONDE ──────────────
--
-- POR INQUILINO, y declarándolo. `accounts` está bajo FORCE ROW LEVEL
-- SECURITY, y migrate.ts corre con row_security=off precisamente para que un
-- DML sin contexto de inquilino NO afecte cero filas en silencio, sino que
-- reviente con 42501 — la lección que la 048 tuvo que reparar. Este bucle sí
-- maneja RLS a propósito, así que lo declara; el SET LOCAL muere con la
-- transacción de esta migración.
--
-- Sólo donde el destino está vacío: si alguien ya escribió el agrupador en su
-- sitio, esa es la verdad más reciente y no se pisa.
SET LOCAL row_security = on;
DO $mudanza$
DECLARE
    t record;
    movidas bigint := 0;
    parcial bigint;
BEGIN
    FOR t IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.current_tenant', t.id::text, true);

        UPDATE accounts
           SET codigo_agrupador_sat = mx_nif_code
         WHERE mx_nif_code IS NOT NULL
           AND codigo_agrupador_sat IS NULL;

        GET DIAGNOSTICS parcial = ROW_COUNT;
        movidas := movidas + parcial;
    END LOOP;

    RAISE NOTICE 'Agrupadores mudados a su columna: %', movidas;
END
$mudanza$;

-- ── 2. CADA COLUMNA DICE LO QUE ES ──────────────────────────────────────
COMMENT ON COLUMN accounts.codigo_agrupador_sat IS
  'El código agrupador del SAT (catálogo c_CodAgrup del Anexo 24). Es FISCAL: cómo agrupa la autoridad esta cuenta para leer la contabilidad. Única verdad desde la 060; antes se escribía en mx_nif_code, que es otra cosa.';

COMMENT ON COLUMN accounts.mx_nif_code IS
  'Código de PRESENTACIÓN bajo NIF mexicanas, hermano de us_gaap_code e ifrs_code. NO es el agrupador del SAT: hasta la 060 se usaba para eso y el día que una entidad necesitara ambos, uno pisaba al otro.';

-- ── 3. EL CATÁLOGO OFICIAL, VERSIONADO POR AÑO ──────────────────────────
--
-- El c_CodAgrup no es una lista estable: el SAT la publica y la revisa. Un
-- agrupador válido en 2022 puede no serlo en 2026, y una balanza se entrega
-- contra el catálogo VIGENTE en su ejercicio. Por eso la vigencia es parte de
-- la llave y no un comentario en el código.
--
-- Es una tabla GLOBAL, como exchange_rates: el catálogo del SAT es un hecho
-- del mundo, no del inquilino. Lo que se acota es la escritura.
CREATE TABLE IF NOT EXISTS sat_codigos_agrupadores (
    codigo VARCHAR(10) NOT NULL,
    nombre VARCHAR(255) NOT NULL,
    -- El nivel del agrupador (100 es rubro, 100.01 es cuenta): lo deriva el
    -- propio código, pero se guarda para poder validar la jerarquía sin
    -- parsear en cada consulta.
    nivel SMALLINT NOT NULL CHECK (nivel IN (1, 2)),
    codigo_padre VARCHAR(10),
    -- La naturaleza que el SAT espera para ese agrupador. Permite cazar la
    -- incoherencia más cara del Anexo 24: una cuenta deudora mapeada a un
    -- agrupador acreedor pasa el XSD y la rechaza la validación de fondo.
    naturaleza CHAR(1) CHECK (naturaleza IN ('D', 'A')),
    vigente_desde DATE NOT NULL,
    vigente_hasta DATE,
    PRIMARY KEY (codigo, vigente_desde)
);

CREATE INDEX IF NOT EXISTS idx_sat_agrupadores_vigencia
    ON sat_codigos_agrupadores(vigente_desde, vigente_hasta);

COMMENT ON TABLE sat_codigos_agrupadores IS
  'El catálogo c_CodAgrup del Anexo 24, versionado por vigencia. Global por diseño: es un hecho publicado por la autoridad, no un dato del inquilino. Sin él, validar un agrupador es comparar contra nada.';
