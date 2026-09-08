-- ============================================================
-- 075 · LA LEY TIENE FECHA DE ENTRADA (J0.2)
--
-- Hoy la ley vive en dos sitios y ninguno sabe desde cuándo rige: quemada en
-- el código (16 % de IVA, 2 000 MXN de efectivo, 8.5 % de restaurantes) o en
-- `tax_parameters`, que la guarda POR AÑO —`UNIQUE(jurisdiction, tax_year)`,
-- 008— aunque la UMA cambie el 1 de febrero. Un parámetro por año no puede
-- contestar «¿cuánto valía el 15 de enero?», y ésa es justo la pregunta que
-- hace un recálculo, una reexpedición o una auditoría.
--
-- ── POR QUÉ UNA LÍNEA DE TIEMPO Y NO UN RANGO CON `EXCLUDE` ─────────────
--
-- La tarjeta de J0.2 propone `EXCLUDE` por rango de vigencia. Se descarta por
-- dos razones, y la primera es medida:
--
--   1. NO CORRERÍA EN LAS MÁQUINAS DE DESARROLLO. Un `EXCLUDE` con igualdad
--      escalar (jurisdicción y clave) más solape de rango necesita la
--      extensión `btree_gist`. Está disponible y es `trusted`, pero el rol que
--      migra —`mnemosine_owner`— NO puede crearla: le falta CREATE sobre la
--      base («permission denied to create extension»). La CI sí puede, porque
--      migra como `postgres`. Una migración que sólo funciona en CI pasa en
--      verde y rompe el `npm run migrate` de cada desarrollador; este
--      repositorio tiene nombre para eso.
--
--   2. Y LA BUENA: EL SOLAPE DEJA DE SER REPRESENTABLE. La vigencia de una ley
--      no es un conjunto de rangos que hay que impedir que choquen: es una
--      LÍNEA DE TIEMPO. Un valor entra en vigor una fecha y rige hasta que
--      otro lo sustituye. Guardando sólo `effective_from`, y definiendo el
--      valor vigente como «la fila con el mayor `effective_from <= fecha del
--      hecho»», no hay dos filas que puedan solaparse ni hueco que pueda
--      abrirse entre dos vigencias. Un `EXCLUDE` PROHÍBE estados malos; esto
--      hace que no existan.
--
-- El fin de vigencia no se pierde: es la fila siguiente. Y una ley DEROGADA
-- —que sí termina sin sustituta— se representa con una fila de valor nulo y
-- su fuente, que es exactamente lo que pasó: alguien la derogó en una fecha.
-- ============================================================

CREATE TABLE IF NOT EXISTS legal_parameters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- QUÉ AUTORIDAD LO FIJA. No es el inquilino: la UMA vale lo mismo para
    -- todos los despachos de México. Por eso esta tabla NO lleva tenant_id ni
    -- va bajo RLS — es dato de referencia, como exchange_rates o tax_tables.
    jurisdiction    CHAR(2) NOT NULL,

    -- QUÉ COSA ES. Nombre estable y en inglés: es identidad de máquina, y
    -- traducirla la daría de baja (la lección de I0).
    key             VARCHAR(80) NOT NULL,

    -- DESDE CUÁNDO RIGE. La línea de tiempo entera está en esta columna.
    effective_from  DATE NOT NULL,

    -- CUÁNTO VALE. Numérico como TEXTO: el dinero y las tasas de este sistema
    -- son cadena + decimal.js a 4 decimales, y un `numeric` de Postgres que
    -- viaja por el driver vuelve como string igualmente. NULL significa
    -- DEROGADO: la ley terminó y no hay sustituta.
    value           TEXT,

    -- EN QUÉ UNIDAD, para que nadie tenga que adivinar si 16 es por ciento o
    -- pesos. Sin esto, `value` es un número sin significado.
    unit            VARCHAR(24) NOT NULL,

    -- DE DÓNDE SALE, Y ES OBLIGATORIO. Un parámetro legal sin fuente oficial
    -- es una cifra inventada con mejor presentación. El día que alguien
    -- pregunte «¿de dónde sacaste que la UMA vale esto?», la respuesta está en
    -- la fila y no en la memoria de quien la escribió.
    source_url      TEXT NOT NULL CHECK (source_url <> ''),
    source_note     TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID,

    -- UNA SOLA VERDAD POR FECHA. Dos filas con la misma jurisdicción, clave y
    -- fecha de entrada serían dos leyes distintas rigiendo el mismo día, y la
    -- lectura tendría que elegir una: es el defecto que esta tabla viene a
    -- cerrar, así que se impide en el esquema y no en el lector.
    CONSTRAINT legal_parameters_una_verdad_por_fecha
        UNIQUE (jurisdiction, key, effective_from)
);

COMMENT ON TABLE legal_parameters IS
  'Lo que fija la LEY, con la fecha en que empezó a regir y su fuente oficial (J0.2). No lleva tenant_id: la UMA vale igual para todo despacho mexicano. El valor vigente en una fecha es la fila con el mayor effective_from <= esa fecha; por eso no hay effective_to y el solape es irrepresentable. value NULL = derogado.';

CREATE INDEX IF NOT EXISTS idx_legal_parameters_vigencia
    ON legal_parameters (jurisdiction, key, effective_from DESC);

-- ── 2. EL PANEL APRENDE DE QUÉ JURISDICCIÓN ES CADA RESPUESTA ───────────
--
-- `policy_decisions` no tenía dónde decirlo, así que un despacho con una
-- sociedad mexicana y otra de Delaware respondía UNA vez a
-- «¿dos pasos hasta la asamblea?» y esa respuesta gobernaba a las dos. La
-- pregunta no es la misma: una tiene asamblea que esperar (LGSM 19-20) y la
-- otra no.
--
-- NULL significa UNIVERSAL —la respuesta vale para toda jurisdicción—, y es el
-- valor que tienen todas las filas que ya existen: nadie contestó pensando en
-- un país, así que promoverlas a «mexicanas» sería inventarles una intención.
ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS jurisdiction CHAR(2);

COMMENT ON COLUMN policy_decisions.jurisdiction IS
  'Jurisdicción a la que aplica esta respuesta del panel (J0.2). NULL = universal, y es lo que son todas las filas anteriores a esta migración: se contestaron sin pensar en un país y no se les inventa uno.';

-- LA UNICIDAD, CON `COALESCE` PORQUE NULL NO SE COMPARA CONSIGO MISMO.
--
-- Un índice único sobre columnas anulables deja pasar duplicados: en SQL
-- `NULL = NULL` es NULL, así que dos filas universales de la misma clave no
-- chocarían y el panel tendría dos respuestas para la misma pregunta sin que
-- nada lo impidiera. Los centinelas hacen comparable lo que no lo es.
--
-- Y no había NINGUNA restricción de unicidad antes de esto: `policy_decisions`
-- sólo tenía su clave primaria por `id`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_decisions_una_respuesta
    ON policy_decisions (
        tenant_id,
        COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
        key,
        COALESCE(jurisdiction, '--')
    );

-- ── 3. LO QUE `tax_parameters` GUARDABA POR AÑO, FECHADO ────────────────
--
-- `UNIQUE(jurisdiction, tax_year)` da un valor por ejercicio, y la UMA cambia
-- el 1 de febrero. Se le añade la fecha de entrada y se rellena con el 1 de
-- enero del ejercicio que ya declaraba: es lo que esa fila SIGNIFICABA, no una
-- suposición. El día que J0.4 traiga la UMA de febrero, la fila nueva entra
-- con su fecha y la vieja deja de regir sola.
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS effective_from DATE;

UPDATE tax_parameters
   SET effective_from = make_date(tax_year, 1, 1)
 WHERE effective_from IS NULL;

ALTER TABLE tax_parameters ALTER COLUMN effective_from SET NOT NULL;

COMMENT ON COLUMN tax_parameters.effective_from IS
  'Fecha desde la que rige esta fila (J0.2). Rellenada con el 1 de enero de su tax_year, que es lo que la fila significaba cuando sólo había año. No hay effective_to: rige hasta que otra fila con fecha posterior la sustituye.';
