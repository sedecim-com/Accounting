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

-- ── 0 · EL OPT-IN, SIN EL CUAL ESTO NO CORRE EN UN DESPACHO REAL ────────
--
-- `garnishments` está en `rls-policies.sql` (:177, acotada por `employee_id`
-- contra `employees`), y `migrate.ts` abre la sesión con `SET row_security =
-- off` (:90). Esa combinación NO desactiva RLS: PostgreSQL LANZA 42501 en
-- cuanto la consulta sería afectada por una política. Los dos UPDATE de abajo
-- abortaban el archivo entero antes de normalizar nada y antes de instalar los
-- CHECK.
--
-- MEDIDO, y no deducido: sobre una base al día en la 074, con el corredor como
-- rol NOBYPASSRLS y DUEÑO de las tablas y `rls-policies.sql` ya aplicado —que
-- es el estado en que `migrate.ts` deja toda instalación—, la 075 moría con
-- «query would be affected by row-level security policy for table
-- "garnishments"». La prueba que lo fija es
-- tests/integration/migracion-075-embargo-bajo-rls.int.spec.ts, y comprueba
-- ANTES su propio banco: que el rol no sea superusuario, que la tabla esté
-- FORCE, y que una lectura suya lance. Sin esas tres, la prueba pasaría
-- siempre.
--
-- El patrón es el de la 025, 026, 043, 048, 051 y 053: declarar el opt-in y
-- recorrer los inquilinos fijando el contexto. `SET LOCAL` muere con la
-- transacción que `migrate.ts` abre alrededor de este archivo.
SET LOCAL row_security = on;

-- ── 1 · LO QUE YA ESTÉ GUARDADO, AL VOCABULARIO BUENO ───────────────────
--
-- `percentage` era lo único que el motor entendía, y lo trataba como
-- porcentaje del ingreso DISPONIBLE: se traduce a lo que significaba. Y los
-- dos tipos que el motor entendía y la columna no documentaba.
--
-- Por inquilino, que es lo que da contexto a la política. `tenants` queda
-- fuera de RLS a propósito, así que el bucle sí se puede leer.
DO $normaliza$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    UPDATE garnishments SET amount_type = 'percent_disposable' WHERE amount_type = 'percentage';
    UPDATE garnishments SET garnishment_type = 'tax_levy_federal' WHERE garnishment_type = 'tax_levy';
  END LOOP;
END
$normaliza$;

-- ── 2 · LAS RESTRICCIONES ───────────────────────────────────────────────
DO $vocabulario$
DECLARE
  t         record;
  sueltos   text;
  importes  text := '';
  tipos     text := '';
BEGIN
  -- No se añade un CHECK sobre datos que no lo cumplen: se para y se nombra.
  -- El censo también va por inquilino — con RLS puesta, una consulta sin
  -- contexto no vería las filas de nadie y absolvería a ciegas, que es la
  -- misma trampa por la que existía este arreglo.
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    SELECT string_agg(DISTINCT amount_type, ', ') INTO sueltos
      FROM garnishments
     WHERE amount_type NOT IN ('fixed', 'percent_disposable', 'percent_gross');
    IF sueltos IS NOT NULL THEN importes := importes || sueltos || ' '; END IF;

    SELECT string_agg(DISTINCT garnishment_type, ', ') INTO sueltos
      FROM garnishments
     WHERE garnishment_type NOT IN ('child_support', 'pension_alimenticia', 'tax_levy_federal',
                                    'tax_levy_state', 'bankruptcy', 'creditor', 'student_loan');
    IF sueltos IS NOT NULL THEN tipos := tipos || sueltos || ' '; END IF;
  END LOOP;

  IF importes <> '' THEN
    RAISE EXCEPTION '075: hay ordenes de embargo con amount_type fuera del vocabulario (%): revisese antes de restringir la columna', importes;
  END IF;
  IF tipos <> '' THEN
    RAISE EXCEPTION '075: hay ordenes de embargo con garnishment_type fuera del vocabulario (%): revisese antes de restringir la columna', tipos;
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
