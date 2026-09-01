-- ============================================================
-- 043: LA SERIE DEL FOLIO LA FIJA LA FECHA DEL DOCUMENTO
--
-- «JE-2026-00042» insinuaba serie anual y no lo era: el año lo ponía el
-- RELOJ (new Date() en formatDocumentNumber) y el contador de
-- entity_sequences jamás se reiniciaba. Dos mentiras juntas: un asiento
-- capturado en enero 2027 con fecha de diciembre 2026 salía «JE-2027-…», y
-- «JE-2027-00043» continuaba la cuenta de 2026. La auditoría integral lo
-- señaló y R3 lo decide ANTES del primer cruce de ejercicio con datos
-- reales — después, cada folio emitido lo encarece.
--
-- Desde este commit el contador vive por (entidad, `tipo_AAAA`) y el año lo
-- da la fecha del documento (utils/sequence.ts). Esta migración SIEMBRA los
-- contadores anuales desde los FOLIOS REALES ya emitidos — no desde el
-- contador viejo, que mezclaba años: para cada (entidad, tipo, año presente
-- en las tablas) el contador arranca en el máximo observado, así la serie
-- continúa sin colisionar con nada emitido. GREATEST en el conflicto por si
-- una corrida parcial anterior dejó un valor.
--
-- Las llaves viejas sin año (journal_entry, invoice, …) se quedan como
-- registro del esquema anterior: nadie las incrementa ya, y borrarlas
-- destruiría la única constancia de cuántos folios repartió el modelo
-- viejo. listEntitySequences las muestra tal cual.
-- ============================================================

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
