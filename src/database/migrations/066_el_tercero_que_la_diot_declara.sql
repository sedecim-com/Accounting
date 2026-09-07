-- ============================================================
-- 066 · EL TERCERO QUE LA DIOT DECLARA (F07c)
--
-- Nació como 063 y se renumeró al fusionar: main traía su propia 060, la
-- consolidación del agrupador se corrió a 063, y dos migraciones no pueden
-- compartir número. El guardia de numeración lo cazó en la fusión, que es
-- exactamente para lo que está.
--
-- La DIOT informa mensualmente, proveedor por proveedor, el IVA de las
-- operaciones con terceros. Es una obligación distinta del Anexo 24 y con
-- otro formato, y el sistema no puede armarla porque le faltan datos que
-- nadie ha tenido nunca dónde guardar. Tres huecos, verificados:
--
--   1. EL TERCERO NO TIENE TIPO. `vendors` guarda `tax_id` y un
--      `tax_id_type` de tres valores ('rfc','ein','vat') y nada más de
--      identidad fiscal. La DIOT empieza pidiendo el TIPO DE TERCERO —04
--      nacional, 05 extranjero, 15 global— y el TIPO DE OPERACIÓN —03
--      servicios profesionales, 06 arrendamiento, 85 otros—, más, para el
--      extranjero, su número de identificación fiscal, su país y su
--      nacionalidad. Ninguno tiene columna. Son los primeros campos del
--      formato y ninguno tiene domicilio.
--
--   2. LA TASA SE PIERDE DEL LADO QUE LA DIOT LEE. `invoice_lines` tiene
--      `tax_rate DECIMAL(5,2)` desde la 002 (:257); `bill_lines` NO
--      (002:90-113): sólo `tax_amount`. La asimetría cae justo del lado de
--      las COMPRAS, que es de lo que la DIOT informa. Sin tasa por renglón,
--      el IVA de un gasto no se puede repartir entre 16 %, 0 % y exento —
--      que es exactamente el desglose que el formato exige.
--
--   3. LO EXENTO NO SE GUARDA, Y «EL VALOR DE LOS ACTOS» TAMPOCO. Un nodo
--      Exento del CFDI 4.0 lleva TipoFactor="Exento" y NO lleva Importe, así
--      que el parser lo descarta en silencio al exigir `importe`. Y la DIOT
--      no declara sólo el impuesto: declara la BASE, el valor de los actos o
--      actividades, que hoy no vive en ninguna columna.
--
-- Esta migración no construye la DIOT: le da dónde apoyarse. El formato, su
-- generador y su validación son del tramo.
-- ============================================================

-- ── 1. LA IDENTIDAD FISCAL DEL TERCERO ──────────────────────────────────
--
-- Los valores son los del catálogo de la propia DIOT, y por eso el CHECK los
-- fija: un tipo de tercero inventado no lo rechaza el sistema, lo rechaza la
-- autoridad al recibir el archivo, cuando el plazo ya corrió.
ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS tipo_tercero VARCHAR(2)
        CHECK (tipo_tercero IN ('04', '05', '15')),
    ADD COLUMN IF NOT EXISTS tipo_operacion VARCHAR(2)
        CHECK (tipo_operacion IN ('03', '06', '85')),
    -- Sólo para el tercero extranjero (tipo 05). El formato pide los tres.
    ADD COLUMN IF NOT EXISTS id_fiscal_extranjero VARCHAR(40),
    ADD COLUMN IF NOT EXISTS pais_residencia CHAR(3),
    ADD COLUMN IF NOT EXISTS nacionalidad VARCHAR(100);

COMMENT ON COLUMN vendors.tipo_tercero IS
  'Catálogo de la DIOT: 04 proveedor nacional, 05 proveedor extranjero, 15 proveedor global (operaciones con el público en general). Sin él la fila del proveedor no se puede declarar.';
COMMENT ON COLUMN vendors.tipo_operacion IS
  'Catálogo de la DIOT: 03 prestación de servicios profesionales, 06 arrendamiento de inmuebles, 85 otros. El 85 es el cajón por omisión y por eso la política del panel decide cuándo usarlo.';
COMMENT ON COLUMN vendors.pais_residencia IS
  'Clave de país de tres letras para el tercero extranjero. La DIOT la exige junto con la nacionalidad y el número de identificación fiscal: los tres o ninguno.';

-- El extranjero se declara con sus tres datos o no se declara: un tipo 05 sin
-- identificación fiscal es una fila que la autoridad rechaza. Se comprueba
-- aquí, en la tabla, y no en el generador, porque el dato se captura mucho
-- antes de que alguien pida la DIOT — y descubrirlo el día 17 del mes es
-- descubrirlo tarde.
ALTER TABLE vendors
    DROP CONSTRAINT IF EXISTS tercero_extranjero_identificado,
    ADD CONSTRAINT tercero_extranjero_identificado
        CHECK (
            tipo_tercero IS DISTINCT FROM '05'
            OR (id_fiscal_extranjero IS NOT NULL AND pais_residencia IS NOT NULL)
        );

-- ── 2. LA TASA, DEL LADO DE LAS COMPRAS ─────────────────────────────────
--
-- Simetría con `invoice_lines.tax_rate` (002:257). Y el TIPO DE FACTOR, que
-- es lo que distingue una tasa del 0 % de una operación EXENTA: las dos
-- llevan importe cero de impuesto y la DIOT las declara en renglones
-- distintos, así que sin esta columna son indistinguibles.
ALTER TABLE bill_lines
    ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2),
    ADD COLUMN IF NOT EXISTS tipo_factor VARCHAR(10) NOT NULL DEFAULT 'tasa'
        CHECK (tipo_factor IN ('tasa', 'cuota', 'exento'));

COMMENT ON COLUMN bill_lines.tax_rate IS
  'La tasa del traslado de este renglón. Su hermana del lado de ventas existe desde la 002; en compras faltaba, que es justo el lado del que informa la DIOT.';
COMMENT ON COLUMN bill_lines.tipo_factor IS
  'tasa | cuota | exento, como el CFDI 4.0. Una operación al 0 % y una EXENTA llevan las dos cero de impuesto y se declaran por separado: sin esta columna son el mismo renglón.';

-- ── 3. EL VALOR DE LOS ACTOS ────────────────────────────────────────────
--
-- La DIOT no declara sólo el impuesto: declara la BASE sobre la que se causó.
-- Hoy se puede derivar del renglón, pero sólo cuando la tasa es conocida y no
-- hay redondeo de por medio; para lo exento no hay tasa de la que derivarla.
-- Se guarda al ingerir, que es cuando el CFDI la dice.
ALTER TABLE bill_lines
    ADD COLUMN IF NOT EXISTS valor_actos DECIMAL(19,4);

COMMENT ON COLUMN bill_lines.valor_actos IS
  'La base del traslado —el «valor de los actos o actividades» de la DIOT— tal como la declara el CFDI. No se deriva del importe: en lo exento no hay tasa de la que derivarla, y en lo demás el redondeo la separa del cociente.';
