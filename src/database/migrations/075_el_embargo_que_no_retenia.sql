-- ============================================================
-- 075 · EL EMBARGO QUE NO RETENÍA (T20 punto 2 · #127)
--
-- `garnishments` tiene dos columnas de vocabulario y NINGUNA tiene CHECK, así
-- que la tabla admite cualquier cadena. Y el motor lee otro vocabulario que el
-- que la propia columna documenta:
--
--   · `amount_type` — el esquema comenta «fixed, percent_disposable,
--     percent_gross» (008_payroll.sql:429) y el motor pregunta por
--     `amount_type = 'percentage'`.
--   · `garnishment_type` — el esquema comenta «child_support,
--     tax_levy_federal, tax_levy_state, creditor, student_loan,
--     pension_alimenticia» (008:427) y el motor ramifica sobre
--     `'tax_levy'` y `'bankruptcy'`.
--
-- MEDIDO sobre una orden del 25 % con 2 000 de ingreso disponible:
--
--   amount_type = 'percentage'          → retiene 500
--   amount_type = 'percent_disposable'  → retiene   0   ← el documentado
--
--   garnishment_type = 'child_support'       → retiene   500
--   garnishment_type = 'pension_alimenticia' → retiene     0   ← el documentado
--   garnishment_type = 'tax_levy'            → retiene 1 800
--   garnishment_type = 'tax_levy_federal'    → retiene     0   ← el documentado
--
-- Es decir: una orden de PENSIÓN ALIMENTICIA o un EMBARGO FISCAL FEDERAL
-- guardados como manda la columna no retienen nada, en silencio. Y como
-- `garnishments` no tiene un solo escritor en `src/` —comprobado—, quien dé de
-- alta una orden lo hará por SQL siguiendo el comentario de la columna, que es
-- justo el camino que devuelve cero.
--
-- ── QUÉ VOCABULARIO GANA ────────────────────────────────────────────────
--
-- El de la COLUMNA, porque es el contrato persistido y el más rico: distingue
-- el embargo fiscal federal del estatal, y nombra la pensión alimenticia
-- mexicana. El motor se adapta a él (mismo commit). `bankruptcy` se conserva
-- porque el motor ya lo trata y el comentario del esquema simplemente no lo
-- listaba: quitarlo sería perder una conducta que existe.
--
-- ── Y AHORA CON CHECK, QUE ES LO QUE IMPIDE QUE VUELVA A PASAR ──────────
--
-- Un vocabulario sin restricción no es un vocabulario: es una sugerencia. Con
-- el CHECK, una orden con un valor que el motor no sabe tratar NO SE PUEDE
-- GUARDAR, en vez de guardarse y retener cero.
-- ============================================================

-- ── 1 · LO QUE YA ESTÉ GUARDADO, AL VOCABULARIO BUENO ───────────────────
--
-- `percentage` era lo único que el motor entendía, y lo trataba como
-- porcentaje del ingreso DISPONIBLE: se traduce a lo que significaba.
UPDATE garnishments SET amount_type = 'percent_disposable' WHERE amount_type = 'percentage';
-- Y los dos tipos que el motor entendía y la columna no documentaba.
UPDATE garnishments SET garnishment_type = 'tax_levy_federal' WHERE garnishment_type = 'tax_levy';

-- ── 2 · LAS RESTRICCIONES ───────────────────────────────────────────────
DO $vocabulario$
DECLARE
  huerfanos text;
BEGIN
  -- No se añade un CHECK sobre datos que no lo cumplen: se para y se nombra.
  SELECT string_agg(DISTINCT amount_type, ', ') INTO huerfanos
    FROM garnishments
   WHERE amount_type NOT IN ('fixed', 'percent_disposable', 'percent_gross');
  IF huerfanos IS NOT NULL THEN
    RAISE EXCEPTION '075: hay ordenes de embargo con amount_type fuera del vocabulario (%): revisese antes de restringir la columna', huerfanos;
  END IF;

  SELECT string_agg(DISTINCT garnishment_type, ', ') INTO huerfanos
    FROM garnishments
   WHERE garnishment_type NOT IN ('child_support', 'pension_alimenticia', 'tax_levy_federal',
                                  'tax_levy_state', 'bankruptcy', 'creditor', 'student_loan');
  IF huerfanos IS NOT NULL THEN
    RAISE EXCEPTION '075: hay ordenes de embargo con garnishment_type fuera del vocabulario (%): revisese antes de restringir la columna', huerfanos;
  END IF;
END
$vocabulario$;

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_amount_type
  CHECK (amount_type IN ('fixed', 'percent_disposable', 'percent_gross'));

ALTER TABLE garnishments
  ADD CONSTRAINT ck_garnishments_type
  CHECK (garnishment_type IN ('child_support', 'pension_alimenticia', 'tax_levy_federal',
                              'tax_levy_state', 'bankruptcy', 'creditor', 'student_loan'));

COMMENT ON COLUMN garnishments.amount_type IS
  'fixed | percent_disposable | percent_gross. Con CHECK desde la 075: antes era un comentario que el motor no leía, y una orden guardada con el vocabulario documentado retenía CERO.';
COMMENT ON COLUMN garnishments.garnishment_type IS
  'child_support | pension_alimenticia | tax_levy_federal | tax_levy_state | bankruptcy | creditor | student_loan. Con CHECK desde la 075, por la misma razón: pension_alimenticia y tax_levy_federal retenían cero.';
