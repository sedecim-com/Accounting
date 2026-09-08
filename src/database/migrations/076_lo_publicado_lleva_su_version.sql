-- ============================================================
-- 076 · LO PUBLICADO LLEVA SU VERSIÓN, SU MONEDA Y SU CAMBIO (X0)
--
-- `published_aggregates` guarda cifras que salen del sistema hacia un tercero,
-- y hasta hoy no podía decir TRES cosas que un tercero necesita para creerlas:
--
--   1. CUÁL DE TODAS ES. El INSERT lleva `ON CONFLICT … DO UPDATE`, así que
--      republicar un periodo SOBRESCRIBE la cifra anterior y la vieja
--      desaparece. En un publicador público eso no es una actualización: es
--      reescribir lo que alguien ya pudo haber citado. La versión convierte
--      cada publicación en una fila propia y deja el historial intacto.
--
--   2. EN QUÉ MONEDA ESTÁ. `public_amount` es un número sin unidad. Dos
--      entidades del mismo despacho pueden publicar en MXN y en USD, y quien
--      las compare sumaría peras con manzanas sin saberlo.
--
--   3. CON QUÉ TIPO DE CAMBIO SE CONVIRTIÓ, cuando hubo conversión. Sin él la
--      cifra no se puede rehacer, y una cifra que no se puede rehacer no se
--      puede auditar — que es justo lo que un agregado publicado promete.
-- ============================================================

ALTER TABLE published_aggregates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE published_aggregates ADD COLUMN IF NOT EXISTS currency_code CHAR(3);
ALTER TABLE published_aggregates ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,8);
ALTER TABLE published_aggregates ADD COLUMN IF NOT EXISTS exchange_rate_date DATE;

COMMENT ON COLUMN published_aggregates.version IS
  'Publicación número N de esta dimensión y periodo (X0). Empieza en 1 y sube: republicar AÑADE una fila, no pisa la anterior. Lo que se publicó una vez se puede haber citado, y borrarlo es reescribir lo que un tercero leyó.';
COMMENT ON COLUMN published_aggregates.currency_code IS
  'Moneda en la que se expresa public_amount (X0). Sin ella el número no significa nada fuera de su entidad.';
COMMENT ON COLUMN published_aggregates.exchange_rate IS
  'Tipo de cambio aplicado, si hubo conversión (X0). NULL = no se convirtió. Sin él la cifra no se puede rehacer, y una cifra que no se puede rehacer no se puede auditar.';

-- LA UNICIDAD SE MUEVE: DE «UNA POR PERIODO» A «UNA POR VERSIÓN».
--
-- La restricción vieja es lo que OBLIGABA a sobrescribir: con ella, la única
-- forma de volver a publicar era pisar la fila. Al entrar la versión en la
-- llave, cada publicación cabe junto a las anteriores y el `DO UPDATE`
-- desaparece del código por innecesario.
-- SE BUSCA EN EL CATÁLOGO, NO SE NOMBRA. Postgres trunca los nombres
-- automáticos a 63 caracteres, así que escribirlo a mano es adivinar dónde
-- cae el corte — y `IF EXISTS` convierte la errata en SILENCIO: la
-- restricción sobrevive, el INSERT sigue chocando, y la migración dice que
-- todo fue bien. Preguntarle al catálogo por sus COLUMNAS no se equivoca.
DO $vieja$
DECLARE
  c text;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'published_aggregates'::regclass
     AND con.contype = 'u'
     AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM unnest(con.conkey) k
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k)
         = ARRAY['dimension_type','dimension_value','entity_id','period_id','tenant_id'];
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE published_aggregates DROP CONSTRAINT %I', c);
    RAISE NOTICE 'retirada la unicidad sin versión: %', c;
  END IF;
END
$vieja$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_published_aggregates_version
    ON published_aggregates (tenant_id, entity_id, period_id, dimension_type, dimension_value, version);

-- Y para leer la vigente sin recorrer el historial entero.
CREATE INDEX IF NOT EXISTS idx_published_aggregates_ultima
    ON published_aggregates (tenant_id, entity_id, period_id, dimension_type, dimension_value, version DESC);
