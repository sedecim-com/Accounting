-- ============================================================
-- 049: EL CORREDOR QUE NO RELLENABA
--
-- EL DEFECTO. Las migraciones corren como `mnemosine_owner`, que es
-- NOSUPERUSER y NOBYPASSRLS a propósito (scripts/provision-roles.sql:60: «es
-- la línea que hace que las políticas signifiquen algo»), y toda tabla con
-- tenant_id/entity_id lleva FORCE ROW LEVEL SECURITY — que es justo lo que le
-- quita al DUEÑO su exención implícita (014_rls_tenant_isolation.sql:9-14, y
-- lo hace a propósito). El migrador nunca fija `app.current_tenant`, así que
-- `app_current_tenant()` devuelve NULL, el predicado `tenant_id = NULL` no
-- casa con nada, y TODO DML de migración sobre una tabla acotada afecta CERO
-- FILAS. Sin error. Sin aviso. La migración se registra como aplicada.
--
-- Reproducido con el mismo SQL y el mismo rol: sin contexto `UPDATE 0`; con
-- contexto `UPDATE 1`.
--
-- POR QUÉ NADIE LO VIO. En una base VIRGEN las migraciones corren ANTES del
-- endurecimiento (migrate.ts aplica rls-policies.sql en su `finally`), así
-- que rellenan bien; y CI migra como superusuario sobre base fresca. El fallo
-- sólo muerde donde importa: una instalación YA desplegada y endurecida que
-- recibe migraciones nuevas. Por eso apareció en un despliegue y no en la
-- suite.
--
-- LAS TRES VÍCTIMAS. La 037 (etiquetado retroactivo de bills/vendors/
-- customers), la 040 (PURGA DE SEGURIDAD: el importe y el factor de apertura
-- que el range proof no debía llevar dentro) y la 043 (siembra de los
-- contadores de folio por ejercicio, cuya ausencia ya provocó una colisión de
-- folios real). Las tres se registraron como aplicadas habiendo tocado cero
-- filas.
--
-- La 026 YA había escrito el patrón correcto —un bucle por inquilino fijando
-- el contexto— y la 043 lo repitió sin él dieciocho migraciones después. Eso
-- demuestra que documentarlo no basta: hace falta un helper que sea más fácil
-- de usar que de evitar, y una guarda en el migrador que se niegue a correr
-- DML acotado sin él (src/database/migrate.ts, mismo commit).
--
-- 017 y 018 comparten la clase y NO se reparan aquí: su DELETE también borra
-- cero, pero va seguido de un CREATE UNIQUE INDEX que NO respeta RLS y
-- revienta, abortando la migración entera. Es el modo de fallo bueno —
-- bloquea la actualización en vez de mentir— y no deja datos que reparar.
-- ============================================================

-- ── El helper: el bucle de la 026, con nombre y con cuenta ──
--
-- Devuelve el TOTAL de filas afectadas, para que quien lo llame pueda dejar
-- constancia en vez de suponer. `tenants` está excluida de RLS a propósito
-- (rls-policies.sql), así que el bucle puede enumerarla.
--
-- Una sola sentencia por llamada: GET DIAGNOSTICS lee el ROW_COUNT de la
-- ÚLTIMA sentencia ejecutada, así que pasar varias devolvería sólo la cuenta
-- de la final — y una cuenta que miente es peor que ninguna.
CREATE OR REPLACE FUNCTION public.por_cada_inquilino(sentencia text)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  t record;
  n bigint := 0;
  total bigint := 0;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    EXECUTE sentencia;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
  RETURN total;
END
$fn$;

COMMENT ON FUNCTION public.por_cada_inquilino(text) IS
  'Ejecuta UNA sentencia DML una vez por inquilino, con app.current_tenant '
  'fijado, y devuelve el total de filas afectadas. Toda migración con DML '
  'sobre una tabla con tenant_id/entity_id debe usarlo: sin él, el dueño del '
  'esquema queda bajo FORCE RLS sin contexto y el DML afecta cero filas en '
  'silencio (la clase que la 049 repara). migrate.ts se niega a correr una '
  'migración con DML acotado que no lo use.';

-- ── La reparación, idempotente y con constancia ──
DO $reparacion$
DECLARE
  n bigint;
BEGIN
  -- 040 · PRIMERO, porque es la única cuyo contenido es un SECRETO: el
  -- importe y el factor de apertura del compromiso, dentro de una prueba
  -- cuya garantía vendida es «prueba el rango SIN revelar el importe». Y a
  -- diferencia de las otras dos, su daño no se corrige solo con el tiempo.
  n := public.por_cada_inquilino($sql$
    UPDATE blockchain_attestations
       SET range_proof = NULL
     WHERE range_proof IS NOT NULL
       AND position('\x5f746573745f76616c7565'::bytea in range_proof) > 0
  $sql$);
  RAISE NOTICE '049 · purga 040 (range_proof): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    UPDATE blockchain_attestations
       SET zkverify_proof = NULL
     WHERE zkverify_proof IS NOT NULL
       AND position('\x5f746573745f76616c7565'::bytea in zkverify_proof) > 0
  $sql$);
  RAISE NOTICE '049 · purga 040 (zkverify_proof): % fila(s)', n;

  -- 043 · los contadores de folio por ejercicio. Su ausencia hace que la
  -- serie del año en curso arranque en 1 y choque con folios ya emitidos:
  -- es la víctima real que este defecto ya cobró.
  n := public.por_cada_inquilino($sql$
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'journal_entry_' || EXTRACT(YEAR FROM entry_date)::int,
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(entry_number from '([0-9]+)$'), '')::bigint), 0))
      FROM journal_entries
     GROUP BY entity_id, EXTRACT(YEAR FROM entry_date)::int
    ON CONFLICT (entity_id, name) DO UPDATE
      SET value = GREATEST(entity_sequences.value, EXCLUDED.value)
  $sql$);
  RAISE NOTICE '049 · siembra 043 (journal_entry): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'invoice_' || EXTRACT(YEAR FROM invoice_date)::int,
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(invoice_number from '([0-9]+)$'), '')::bigint), 0))
      FROM invoices
     GROUP BY entity_id, EXTRACT(YEAR FROM invoice_date)::int
    ON CONFLICT (entity_id, name) DO UPDATE
      SET value = GREATEST(entity_sequences.value, EXCLUDED.value)
  $sql$);
  RAISE NOTICE '049 · siembra 043 (invoice): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'bill_' || EXTRACT(YEAR FROM bill_date)::int,
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(bill_number from '([0-9]+)$'), '')::bigint), 0))
      FROM bills
     GROUP BY entity_id, EXTRACT(YEAR FROM bill_date)::int
    ON CONFLICT (entity_id, name) DO UPDATE
      SET value = GREATEST(entity_sequences.value, EXCLUDED.value)
  $sql$);
  RAISE NOTICE '049 · siembra 043 (bill): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'customer_payment_' || EXTRACT(YEAR FROM payment_date)::int,
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(payment_number from '([0-9]+)$'), '')::bigint), 0))
      FROM customer_payments
     GROUP BY entity_id, EXTRACT(YEAR FROM payment_date)::int
    ON CONFLICT (entity_id, name) DO UPDATE
      SET value = GREATEST(entity_sequences.value, EXCLUDED.value)
  $sql$);
  RAISE NOTICE '049 · siembra 043 (customer_payment): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'vendor_payment_' || EXTRACT(YEAR FROM payment_date)::int,
           GREATEST(COUNT(*), COALESCE(MAX(NULLIF(substring(payment_number from '([0-9]+)$'), '')::bigint), 0))
      FROM vendor_payments
     GROUP BY entity_id, EXTRACT(YEAR FROM payment_date)::int
    ON CONFLICT (entity_id, name) DO UPDATE
      SET value = GREATEST(entity_sequences.value, EXCLUDED.value)
  $sql$);
  RAISE NOTICE '049 · siembra 043 (vendor_payment): % fila(s)', n;

  -- 037 · el etiquetado retroactivo. Se rellena EXACTO (por la ligadura
  -- pre_registrations → xml_documents), nunca por heurística, y encarece con
  -- el tiempo: cuanto más tarde, menos filas quedan con su origen a la vista.
  -- SQL IDÉNTICO AL ORIGINAL, sólo envuelto en el bucle. Una reparación que
  -- «mejora» de paso deja de ser una reparación: sería una migración nueva
  -- disfrazada, y nadie podría comparar lo que quedó contra lo que se quiso.
  n := public.por_cada_inquilino($sql$
    UPDATE bills b
       SET cfdi_uuid = x.cfdi_uuid
      FROM pre_registrations p
      JOIN xml_documents x ON x.id = p.xml_document_id
     WHERE p.bill_id = b.id
       AND b.cfdi_uuid IS NULL
  $sql$);
  RAISE NOTICE '049 · etiquetado 037 (bills.cfdi_uuid): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    UPDATE vendors v
       SET related_entity_id = le.id
      FROM legal_entities le, legal_entities propia
     WHERE propia.id = v.entity_id
       AND le.tenant_id = propia.tenant_id
       AND le.id <> v.entity_id
       AND le.tax_id = v.tax_id
       AND v.related_entity_id IS NULL
  $sql$);
  RAISE NOTICE '049 · etiquetado 037 (vendors.related_entity_id): % fila(s)', n;

  n := public.por_cada_inquilino($sql$
    UPDATE customers c
       SET related_entity_id = le.id
      FROM legal_entities le, legal_entities propia
     WHERE propia.id = c.entity_id
       AND le.tenant_id = propia.tenant_id
       AND le.id <> c.entity_id
       AND le.tax_id = c.tax_id
       AND c.related_entity_id IS NULL
  $sql$);
  RAISE NOTICE '049 · etiquetado 037 (customers.related_entity_id): % fila(s)', n;
END
$reparacion$;
