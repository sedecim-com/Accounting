-- ============================================================
-- 046: REPARAR LO QUE RLS FILTRÓ EN SILENCIO
--
-- Tres migraciones de datos corrieron como mnemosine_owner bajo FORCE ROW
-- LEVEL SECURITY sin GUC de inquilino: sus SELECT leyeron cero filas y
-- «terminaron bien» sin hacer nada. Se detectó el 2026-08-31 por una
-- colisión de folio (la siembra muda de la 043) y la auditoría sobre la
-- base de desarrollo midió el resto del hueco:
--
--   · 037 — el relleno de bills.cfdi_uuid dejó 3 gastos sin su UUID y una
--     contraparte intercompañía sin marca.
--   · 040 — la purga del range proof NO purgó: 15 range_proof y 15
--     zkverify_proof seguían llevando `_test_value` (el importe y el
--     blinding factor que el compromiso promete no revelar).
--   · 043 — la siembra de contadores anuales sembró nada; la primera póliza
--     post-R3 chocó con journal_entries_entry_number_entity_id_key.
--
-- Esta migración re-corre las tres con el patrón que la 026 consagró:
-- iterar tenants (excluida de RLS) fijando app.current_tenant por vuelta.
-- Cada paso es idempotente (ON CONFLICT/GREATEST, guardas IS NULL, guardas
-- por contenido), así que re-ejecutarla sobre una base sana no mueve nada:
-- en particular, sobre la base de desarrollo donde la 043 ya se re-corrió a
-- mano como superusuario, el GREATEST conserva los valores buenos.
--
-- La reincidencia (025, luego 043) es la razón de que migrate.ts ahora corra
-- con row_security=off: el CUARTO olvido no callará — errará con 42501
-- nombrando la tabla. Detalle y patrón en docs/migraciones.md.
-- ============================================================

-- El opt-in: migrate.ts corre la sesión con row_security=off, que convierte
-- el filtrado silencioso en error 42501. Este bucle SÍ maneja RLS a
-- propósito (GUC por inquilino), así que lo declara; SET LOCAL muere con la
-- transacción de esta migración.
SET LOCAL row_security = on;
DO $repara$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    -- ── 037 · bills.cfdi_uuid desde el puente pre_registrations→xml_documents ──
    UPDATE bills b
       SET cfdi_uuid = x.cfdi_uuid
      FROM pre_registrations p
      JOIN xml_documents x ON x.id = p.xml_document_id
     WHERE p.bill_id = b.id
       AND b.cfdi_uuid IS NULL;

    -- ── 037 · la contraparte intercompañía, por RFC dentro del inquilino ──
    UPDATE vendors v
       SET related_entity_id = le.id
      FROM legal_entities le, legal_entities propia
     WHERE propia.id = v.entity_id
       AND le.tenant_id = propia.tenant_id
       AND le.id <> v.entity_id
       AND le.tax_id = v.tax_id
       AND v.related_entity_id IS NULL;

    UPDATE customers c
       SET related_entity_id = le.id
      FROM legal_entities le, legal_entities propia
     WHERE propia.id = c.entity_id
       AND le.tenant_id = propia.tenant_id
       AND le.id <> c.entity_id
       AND le.tax_id = c.tax_id
       AND c.related_entity_id IS NULL;

    -- ── 040 · la purga del secreto que el compromiso revelaba ──
    UPDATE blockchain_attestations
       SET range_proof = NULL
     WHERE range_proof IS NOT NULL
       AND position('\x5f746573745f76616c7565'::bytea in range_proof) > 0; -- '_test_value'

    UPDATE blockchain_attestations
       SET zkverify_proof = NULL
     WHERE zkverify_proof IS NOT NULL
       AND position('\x5f746573745f76616c7565'::bytea in zkverify_proof) > 0;

    -- ── 043 · la siembra de contadores anuales, desde los folios reales ──
    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'journal_entry_' || substring(entry_number from 4 for 4),
           max(split_part(entry_number, '-', 3)::bigint)
      FROM journal_entries
     WHERE entry_number ~ '^JE-\d{4}-\d+$'
     GROUP BY entity_id, substring(entry_number from 4 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'invoice_' || substring(invoice_number from 5 for 4),
           max(split_part(invoice_number, '-', 3)::bigint)
      FROM invoices
     WHERE invoice_number ~ '^INV-\d{4}-\d+$'
     GROUP BY entity_id, substring(invoice_number from 5 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'bill_' || substring(bill_number from 6 for 4),
           max(split_part(bill_number, '-', 3)::bigint)
      FROM bills
     WHERE bill_number ~ '^BILL-\d{4}-\d+$'
     GROUP BY entity_id, substring(bill_number from 6 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'vendor_payment_' || substring(payment_number from 6 for 4),
           max(split_part(payment_number, '-', 3)::bigint)
      FROM vendor_payments
     WHERE payment_number ~ '^VPMT-\d{4}-\d+$'
     GROUP BY entity_id, substring(payment_number from 6 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id,
           'customer_payment_' || substring(payment_number from 5 for 4),
           max(split_part(payment_number, '-', 3)::bigint)
      FROM customer_payments
     WHERE payment_number ~ '^PMT-\d{4}-\d+$'
     GROUP BY entity_id, substring(payment_number from 5 for 4)
    ON CONFLICT (entity_id, name)
    DO UPDATE SET value = GREATEST(entity_sequences.value, EXCLUDED.value);
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$repara$;
