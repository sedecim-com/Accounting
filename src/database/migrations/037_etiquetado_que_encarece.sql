-- ============================================================
-- 037: EL ETIQUETADO CUYO COSTE CRECE CON CADA MES POSTEADO
--
-- Tres etiquetas sobre tablas ya pobladas. Son la única clase de migración
-- que ENCARECE con el tiempo: etiquetar cien filas es trivial y cien mil es
-- un proyecto, así que cada mes que se captura sin ellas sube el precio.
-- Las tres llegan con su relleno derivado de los datos que ya existen —
-- ese relleno es exactamente lo que dentro de un año ya no sería derivable
-- a este precio.
--
-- LO QUE ESTA MIGRACIÓN NO AÑADE, A PROPÓSITO. «Naturaleza del gasto»
-- (deducibilidad) estaba en la lista original y se difiere a F02: su
-- vocabulario es una decisión de criterio contable y la regla de la casa la
-- manda al panel de políticas con su lector — una columna sin vocabulario ni
-- consumidor sería la capacidad muerta que S0.4 acaba de purgar. Las
-- dimensiones (centro de costo / proyecto) ya viven en journal_entry_lines
-- desde la 001; lo que les falta es el MAESTRO, y eso es la familia
-- `dimension` del catálogo, no una etiqueta.
-- ============================================================

-- ── 1. El código agrupador del SAT, por cuenta ──
--
-- El Anexo 24 exige que cada cuenta del catálogo declare su código
-- agrupador para la contabilidad electrónica (F07). Es asignable por cuenta
-- y en retrospectiva —su coste no crece con las filas— pero sin la columna
-- nadie puede ni empezar a capturarlo, y F07 entero lo consume.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS codigo_agrupador_sat VARCHAR(10);

COMMENT ON COLUMN accounts.codigo_agrupador_sat IS
  'Código agrupador del SAT (Anexo 24) para la contabilidad electrónica. NULL mientras el despacho no lo asigne; el checklist de F07 exigirá que ninguna cuenta con movimientos lo tenga vacío.';

-- ── 2. El UUID fiscal en los gastos, con su relleno ──
--
-- `invoices` lo tiene desde la 002; `bills` nunca lo tuvo, y la única forma
-- de ir del gasto a su CFDI es el rodeo pre_registrations → xml_documents.
-- Ese rodeo funciona (la ligadura del REP vive de él) pero muere con el
-- pre-registro: un gasto cuyo pre-registro se purgue pierde su ancla fiscal.
-- La columna directa hace baratos el DIOT, el amarre y la ligadura — y el
-- relleno de hoy es un UPDATE con JOIN; el de dentro de un año, un proyecto
-- de conciliación.
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS cfdi_uuid VARCHAR(50);

COMMENT ON COLUMN bills.cfdi_uuid IS
  'UUID del CFDI que originó el gasto, cuando nació de una ingesta. Rellenado por la 037 desde el puente pre_registrations→xml_documents y escrito por createBillFromPreReg de ahí en adelante. NULL en gastos capturados a mano sin comprobante.';

UPDATE bills b
   SET cfdi_uuid = x.cfdi_uuid
  FROM pre_registrations p
  JOIN xml_documents x ON x.id = p.xml_document_id
 WHERE p.bill_id = b.id
   AND b.cfdi_uuid IS NULL;

-- No único: el mismo CFDI global puede aparecer en dos entidades del mismo
-- despacho (emisora y receptora), igual que en invoices, cuyo índice tampoco
-- es único. La unicidad fiscal la custodia xml_documents.
CREATE INDEX IF NOT EXISTS idx_bills_cfdi ON bills(cfdi_uuid) WHERE cfdi_uuid IS NOT NULL;

-- ── 3. La contraparte intercompañía, con su relleno por RFC ──
--
-- El amarre intercompañía (tie-out, eliminaciones de consolidación) necesita
-- saber que «Proveedor Operadora SA» ES la otra entidad del mismo despacho.
-- Hoy no hay marca, y reconstruirla después exige cotejar RFC contra RFC
-- sobre un padrón que crece. El relleno casa por RFC dentro del mismo
-- inquilino — exacto, no heurístico: el RFC es identidad fiscal.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS related_entity_id UUID REFERENCES legal_entities(id);
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS related_entity_id UUID REFERENCES legal_entities(id);

COMMENT ON COLUMN vendors.related_entity_id IS
  'La entidad del MISMO inquilino que es este proveedor, cuando el proveedor es intercompañía. Rellenado por RFC en la 037 y mantenido por el alta. NULL para terceros de verdad.';
COMMENT ON COLUMN customers.related_entity_id IS
  'La entidad del MISMO inquilino que es este cliente, cuando el cliente es intercompañía. NULL para terceros de verdad.';

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
