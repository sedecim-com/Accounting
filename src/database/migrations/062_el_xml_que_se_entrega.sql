-- ============================================================
-- 062 · EL XML QUE SE ENTREGA (F07b)
--
-- La fila del catálogo de comandos que pide `catalog generate` escribe la
-- razón de esta tabla y conviene copiarla entera, porque es la justificación:
-- «persiste el artefacto porque `diff` y `file` dependen de saber qué se
-- generó».
--
-- Sin esto, las tres filas se caen unas sobre otras:
--   · `catalog diff` compararía el catálogo de hoy contra NADA, y su promesa
--     —«las cuentas nuevas o modificadas desde el último catálogo PRESENTADO»—
--     no tendría a qué referirse.
--   · `catalog file` firmaría con la e.firma un archivo RECONSTRUIDO en el
--     momento de firmar. Si entre la revisión y la firma alguien dio de alta
--     una cuenta, se firmaría un archivo distinto del que el contador leyó, y
--     el sello diría que sí lo leyó.
--
-- LA LLAVE DE IDEMPOTENCIA ES EL HASH, y esa es la decisión de diseño.
-- `generate` está obligado a producir BYTES IDÉNTICOS PARA ENTRADAS
-- IDÉNTICAS. Si lo cumple, regenerar sin haber cambiado nada NO debe crear una
-- fila: un historial de versiones indistinguibles convierte el `diff` en
-- ruido. Con `UNIQUE (entity_id, tipo, anio, mes, tipo_envio, hash_sha256)`, la
-- segunda corrida choca y devuelve la fila que ya estaba — y ese choque es, de
-- paso, la comprobación más barata que existe de que el generador es
-- determinista de verdad.
--
-- AISLAMIENTO: lleva `tenant_id` NOT NULL y `entity_id`, así que el primer
-- bucle de `rls-policies.sql` —que migrate.ts reaplica DESPUÉS de cada
-- migración— le genera `tenant_isolation` con FORCE ROW LEVEL SECURITY sin que
-- haya que apuntarla en ninguna lista. No hay lista paralela que mantener.
-- ============================================================

CREATE TABLE IF NOT EXISTS sat_anexo24_artefactos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    entity_id UUID NOT NULL REFERENCES legal_entities(id),

    tipo VARCHAR(20) NOT NULL
        CHECK (tipo IN ('catalogo', 'balanza', 'poliza', 'auxiliar_folios', 'auxiliar_cuentas')),
    version VARCHAR(10) NOT NULL,

    -- El RFC con el que se generó, guardado y no derivado. La entidad puede
    -- corregir su RFC mañana; lo que se entregó se entregó con éste, y un
    -- acuse se cotea contra el RFC del archivo, no contra el de hoy.
    rfc VARCHAR(13) NOT NULL,

    anio SMALLINT NOT NULL CHECK (anio BETWEEN 2015 AND 2099),
    -- 13 existe: es la balanza de cierre del ejercicio. El catálogo de cuentas
    -- NO lo admite y eso lo comprueba el generador, que sabe de qué tipo habla.
    mes SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 13),
    -- 'N' normal, 'C' complementaria. El catálogo no distingue y viaja como
    -- 'N': NOT NULL en vez de nullable porque forma parte de la llave única, y
    -- en Postgres dos NULL no chocan — una llave con un NULL dentro deja de
    -- ser una llave justo donde hace falta que lo sea.
    tipo_envio CHAR(1) NOT NULL DEFAULT 'N' CHECK (tipo_envio IN ('N', 'C')),

    xml TEXT NOT NULL,
    hash_sha256 CHAR(64) NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes > 0),

    -- SELLADO: un HECHO REGISTRADO, no una suposición de quien lee la tabla.
    -- En F07b se escribe siempre false y no hay ningún camino que lo ponga en
    -- true: la regla de la casa es que la e.firma no entra en este proceso
    -- salvo que el despacho lo declare, y sellar vive en `catalog file`, que
    -- no está construido. La columna existe desde ya para que el día que
    -- exista, «este archivo está sellado» se pueda CONSULTAR.
    sellado BOOLEAN NOT NULL DEFAULT false,
    -- Qué contestaba el panel en el momento de generar. Un despacho que cambie
    -- de criterio no debe reescribir la historia de lo que ya salió.
    politica_sellado VARCHAR(50) NOT NULL,

    -- Los hallazgos del validador de reglas, tal como se le enseñaron a quien
    -- generó. Se guardan con el archivo porque un aviso que sólo vivió en la
    -- pantalla no existe cuando llega el requerimiento seis meses después.
    hallazgos JSONB NOT NULL DEFAULT '[]',

    generado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generado_por UUID NOT NULL,

    UNIQUE (entity_id, tipo, anio, mes, tipo_envio, hash_sha256)
);

-- El acceso real es «el último de este tipo para esta entidad», que es lo que
-- `diff` pregunta: el índice se hace para esa pregunta y no para la tabla.
CREATE INDEX IF NOT EXISTS idx_anexo24_artefactos_ultimo
    ON sat_anexo24_artefactos(entity_id, tipo, anio DESC, mes DESC, generado_en DESC);

COMMENT ON TABLE sat_anexo24_artefactos IS
  'Los XML del Anexo 24 tal como se generaron, con su hash. Existe porque catalog diff y catalog file dependen de saber qué se generó: sin esto, diff compara contra nada y file firma un archivo reconstruido en vez del que se revisó.';

COMMENT ON COLUMN sat_anexo24_artefactos.hash_sha256 IS
  'SHA-256 de los bytes UTF-8 exactos. Es parte de la llave única: regenerar con las mismas entradas no crea fila nueva, y ese choque comprueba que el generador es determinista.';

COMMENT ON COLUMN sat_anexo24_artefactos.sellado IS
  'false en todo F07b y sin camino que lo cambie. Construir el archivo y firmarlo son actos distintos y de manos distintas; el sellado con e.firma vive en catalog file.';
